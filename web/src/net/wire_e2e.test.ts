import { describe, it, expect } from 'vitest';
import {
    WireClient,
    type WireSocket,
    type TimerApi,
    type HomeEvent,
} from './wire_client';
import {
    FrameType,
    encodeFrame,
    decodeFrame,
    encodeAckPayload,
    encodeNackPayload,
    encodeRetxRequestPayload,
    encodeCreditPayload,
    encodeStatePayload,
    encodeErrorPayload,
} from '../codec/frame';
import { crc16ccitt } from '../codec/crc16';
import { CtlKind } from '../codec/control';
import { createController } from '../app/controller';
import { createStores } from '../app/stores';
import type { DrawingCommand } from '../types';

/**
 * End-to-end wiring test: the real {@link WireClient} driven against a
 * `FakeController` that plays the firmware role (task 31.1, Design §5.2).
 *
 * PlatformIO is not installed and there is no real device, so "end-to-end" is
 * realised as a SHARED-CONTRACT harness. The `FakeController` decodes inbound
 * CMD / CTL frames with the EXACT byte layouts the firmware uses and replies
 * with the correct ACK / NACK / RETX_REQUEST / CREDIT / STATUS / HELLO / STATE
 * frames, mirroring what `firmware/etchasketch.ino`'s `handleCmdFrame` /
 * `handleCtlFrame` do. Specifically it mirrors, line for line:
 *
 *   - `firmware/src/protocol/command_parser.cpp` (decode + CRC-16/CCITT over
 *     bytes [0..14) + range checks)  → ParseResult
 *   - `firmware/src/protocol/sequence_tracker.cpp` (bounded retransmission +
 *     idempotent duplicate ACK)
 *   - `firmware/src/protocol/flow_control.cpp` (credit model + high/low water)
 *   - `firmware/src/protocol/control_parser.cpp` (§4.6 CTL decode)
 *   - `firmware/src/app/hello.cpp` (§4.8 HELLO payload)
 *
 * The byte layouts were cross-checked against `frame.h`, `command_parser.h`,
 * `control_parser.h`, `hello.h`, and `types.h`; the web codec and firmware
 * agree byte-for-byte (see the report at the bottom of this task).
 *
 * The transport is a loopback `LoopbackSocket`: the WireClient's `send()` is
 * decoded by the controller synchronously, and the controller's responses are
 * delivered back on a microtask. Deferring delivery is essential — it lets the
 * WireClient finish `transmit()` (which records the pending ACK *after*
 * `send()` returns) before any ACK/RETX is dispatched, exactly as a real async
 * socket behaves.
 *
 * @see Requirements 7.1 (WebSocket binary messaging), 7.4 (STATUS telemetry)
 * @see Design §5.2 (normal drawing flow), §4.5–§4.8, §6.4 (flow control)
 */

// -----------------------------------------------------------------------------
// Wire-stable mirrors of firmware codes (cross-checked against the firmware).
// -----------------------------------------------------------------------------

// NACK reason codes (Design §4.5; firmware protocol::NackReason).
const NACK_PARSE = 0x01;
const NACK_RANGE = 0x03;
const NACK_BUFFER_FULL = 0x04;
const NACK_NOT_READY = 0x05;

// ERROR kinds (Design §4.5).
const ERROR_UNRECOVERABLE_TX = 0x03;
const ERROR_AXIS_NONE = 0xff;

// Controller state codes (Design §4.7; firmware diag::StatusState).
const ST_IDLE = 0;
const ST_DRAWING = 1;
const ST_PAUSED = 2;
const ST_ABORTED = 5;

// Buffer / flow-control limits (firmware types.h).
const COMMAND_BUFFER_SIZE = 32;
const COMMAND_BUFFER_HIGH_WATER = 28;
const COMMAND_BUFFER_LOW_WATER = 16;

// Drawing_Command field ranges (Design §4.3).
const FEED_SPS_MIN = 100;
const FEED_SPS_MAX = 1000;
const CMD_FLAGS_MASK = 0b11;

const MAX_RETRANSMISSIONS = 3;

const URL = 'ws://device.local/ws';

// -----------------------------------------------------------------------------
// Loopback socket
// -----------------------------------------------------------------------------

const noopTimers: TimerApi = {
    setTimeout: () => 0,
    clearTimeout: () => { },
};

/** Copy any inbound socket payload into a standalone Uint8Array. */
function toBytes(data: ArrayBufferView | ArrayBufferLike): Uint8Array {
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer.slice(0) as ArrayBuffer);
    }
    return new Uint8Array(data as ArrayBuffer);
}

/**
 * In-memory WebSocket whose client→controller direction is wired straight into
 * a {@link FakeController}. `open()` is the test trigger that fires `onopen`
 * and announces the new session to the controller (which replies with HELLO).
 */
class LoopbackSocket implements WireSocket {
    binaryType: 'blob' | 'arraybuffer' = 'blob';
    readyState = 0;
    sent: Uint8Array[] = [];

    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;

    constructor(private readonly fw: FakeController) { }

    send(data: ArrayBufferView | ArrayBufferLike): void {
        const bytes = toBytes(data);
        this.sent.push(bytes);
        this.fw.receiveFromClient(bytes);
    }

    close(): void {
        this.readyState = 3;
    }

    /** Test trigger: open the socket and start the firmware session. */
    open(): void {
        this.readyState = 1;
        this.onopen?.({});
        this.fw.onClientConnected(this);
    }

    /** Deliver one controller→client frame. */
    deliver(frame: Uint8Array): void {
        this.onmessage?.({ data: frame });
    }
}

// -----------------------------------------------------------------------------
// Decoded CTL message (mirrors firmware protocol::ControlMessage, §4.6).
// -----------------------------------------------------------------------------

type DecodedCtl =
    | { kind: 'pause' }
    | { kind: 'resume' }
    | { kind: 'cancel' }
    | { kind: 'stop' }
    | { kind: 'setHome' }
    | { kind: 'reHome' }
    | { kind: 'endDraw' }
    | { kind: 'motorTest' }
    | { kind: 'faultReset' }
    | { kind: 'jog'; axis: number; dir: number; steps: number }
    | { kind: 'beginDraw'; totalSegments: number; totalSteps: number }
    | { kind: 'speedPct'; pct: number }
    | { kind: 'setBacklash'; x: number; y: number };

function requireLen(actual: number, expected: number): void {
    if (actual !== expected) {
        throw new Error(`CTL length ${actual}, expected ${expected}`);
    }
}

/**
 * Decode + validate a CTL payload exactly as `control_parser.cpp` does:
 * known kind, exact per-kind length, then per-kind range checks. Throws on any
 * violation (the firmware silently ignores malformed CTL frames).
 */
function decodeControlPayload(payload: Uint8Array): DecodedCtl {
    if (payload.length < 1) throw new Error('CTL: empty payload');
    const view = new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
    );
    const kind = view.getUint8(0);

    switch (kind) {
        case CtlKind.PAUSE:
            requireLen(payload.length, 1);
            return { kind: 'pause' };
        case CtlKind.RESUME:
            requireLen(payload.length, 1);
            return { kind: 'resume' };
        case CtlKind.CANCEL:
            requireLen(payload.length, 1);
            return { kind: 'cancel' };
        case CtlKind.STOP:
            requireLen(payload.length, 1);
            return { kind: 'stop' };
        case CtlKind.SET_HOME:
            requireLen(payload.length, 1);
            return { kind: 'setHome' };
        case CtlKind.RE_HOME:
            requireLen(payload.length, 1);
            return { kind: 'reHome' };
        case CtlKind.END_DRAW:
            requireLen(payload.length, 1);
            return { kind: 'endDraw' };
        case CtlKind.MOTOR_TEST:
            requireLen(payload.length, 1);
            return { kind: 'motorTest' };
        case CtlKind.FAULT_RESET:
            requireLen(payload.length, 1);
            return { kind: 'faultReset' };

        case CtlKind.JOG: {
            requireLen(payload.length, 5);
            const axis = view.getUint8(1);
            const dir = view.getInt8(2);
            const steps = view.getUint16(3, true);
            if (axis !== 0 && axis !== 1) throw new Error('JOG axis');
            if (dir !== 1 && dir !== -1) throw new Error('JOG dir');
            if (steps < 1 || steps > 1000) throw new Error('JOG steps');
            return { kind: 'jog', axis, dir, steps };
        }
        case CtlKind.BEGIN_DRAW: {
            requireLen(payload.length, 9);
            return {
                kind: 'beginDraw',
                totalSegments: view.getUint32(1, true),
                totalSteps: view.getUint32(5, true),
            };
        }
        case CtlKind.SPEED_PCT: {
            requireLen(payload.length, 2);
            const pct = view.getUint8(1);
            if (pct < 25 || pct > 100) throw new Error('SPEED_PCT pct');
            return { kind: 'speedPct', pct };
        }
        case CtlKind.SET_BACKLASH: {
            requireLen(payload.length, 5);
            const x = view.getUint16(1, true);
            const y = view.getUint16(3, true);
            if (x > 200 || y > 200) throw new Error('SET_BACKLASH range');
            return { kind: 'setBacklash', x, y };
        }
        default:
            throw new Error(`CTL: unknown kind 0x${kind.toString(16)}`);
    }
}

// -----------------------------------------------------------------------------
// Drawing_Command parse (mirrors firmware command_parser.cpp, §4.3).
// -----------------------------------------------------------------------------

type CmdParse =
    | { result: 'ok'; cmd: Required<DrawingCommand> }
    | { result: 'retxCrc'; seq: number }
    | { result: 'nackRange'; seq: number }
    | { result: 'nackParse'; seq: number };

function parseDrawingCommand(payload: Uint8Array): CmdParse {
    // 1. Structural: a CMD payload is always exactly 16 bytes.
    if (payload.length !== 16) return { result: 'nackParse', seq: 0 };

    const view = new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
    );
    const seq = view.getUint32(0, true);
    const dxSteps = view.getInt16(4, true);
    const dySteps = view.getInt16(6, true);
    const feedSps = view.getUint16(8, true);
    const flags = view.getUint16(10, true);
    const reserved = view.getUint16(12, true);
    const crc16 = view.getUint16(14, true);

    // 2. Integrity: recompute CRC-16/CCITT over bytes [0..14) using the shared
    //    crc16.ts utility and compare with the transmitted CRC (Req 7.2/7.3).
    const computed = crc16ccitt(payload.subarray(0, 14));
    if (computed !== crc16) return { result: 'retxCrc', seq };

    // 3. Range checks, only after CRC passes (Req 6.7).
    if (feedSps < FEED_SPS_MIN || feedSps > FEED_SPS_MAX) {
        return { result: 'nackRange', seq };
    }
    if ((flags & ~CMD_FLAGS_MASK) !== 0) return { result: 'nackRange', seq };
    if (reserved !== 0) return { result: 'nackRange', seq };

    return {
        result: 'ok',
        cmd: { seq, dxSteps, dySteps, feedSps, flags, crc16 },
    };
}

// -----------------------------------------------------------------------------
// FakeController — the firmware role
// -----------------------------------------------------------------------------

interface HelloFields {
    firmwareVersion: number;
    x: number;
    y: number;
    calibrated: boolean;
    unclean: boolean;
    backlashX: number;
    backlashY: number;
    mmPerRevX: number;
    mmPerRevY: number;
    envelopeX: number;
    envelopeY: number;
    envelopeCalibrated: boolean;
}

interface StatusOpts {
    x: number;
    y: number;
    pct: number;
    rssi: number;
    activeSps: number;
    stateCode: number;
    flags: number;
}

class FakeController {
    readonly sockets: LoopbackSocket[] = [];

    /** Decoded, accepted (enqueued) CMDs — the firmware's ring-buffer pushes. */
    readonly receivedCmds: Required<DrawingCommand>[] = [];
    /** Every decoded CTL message, in arrival order. */
    readonly controlLog: DecodedCtl[] = [];

    /** Firmware calibration authority (gates CMD enqueue; Req 10.11). */
    calibrated: boolean;

    private active: LoopbackSocket | null = null;
    private readonly outbox: Uint8Array[] = [];
    private deliveryScheduled = false;

    // CMD seqs to corrupt exactly once on first receipt (simulated wire noise).
    private readonly corruptOnce = new Set<number>();

    // Ring-buffer occupancy model (only enqueued, not-yet-consumed commands).
    private buffer = 0;

    // Flow-control state (mirrors flow_control.cpp).
    private occupancy = 0;
    private creditsOutstanding = 0;
    private withholding = false;

    // Sequence tracker state (mirrors sequence_tracker.cpp).
    private seqHasAcked = false;
    private seqLastAcked = 0;
    private seqFailing = false;
    private seqFailingSeq = 0;
    private seqFailingCount = 0;
    private seqUnrecoverable = false;

    private hello: HelloFields = {
        firmwareVersion: 0x000100,
        x: 0,
        y: 0,
        calibrated: true,
        unclean: false,
        backlashX: 0,
        backlashY: 0,
        mmPerRevX: 100,
        mmPerRevY: 100,
        envelopeX: 20000,
        envelopeY: 16000,
        envelopeCalibrated: true,
    };

    constructor(opts: { calibrated?: boolean } = {}) {
        this.calibrated = opts.calibrated ?? true;
    }

    /** Socket factory passed to the WireClient under test. */
    readonly socketFactory = (_url: string): WireSocket => {
        const s = new LoopbackSocket(this);
        this.sockets.push(s);
        return s;
    };

    configureHello(fields: Partial<HelloFields>): void {
        this.hello = { ...this.hello, ...fields };
    }

    /** Queue a CMD seq to be corrupted once (CRC mismatch → RETX_REQUEST). */
    corruptNextCmd(seq: number): void {
        this.corruptOnce.add(seq);
    }

    // ---- session lifecycle --------------------------------------------------

    onClientConnected(socket: LoopbackSocket): void {
        this.active = socket;
        this.sendHello();
    }

    // ---- inbound: client → controller --------------------------------------

    receiveFromClient(bytes: Uint8Array): void {
        let frame: { type: FrameType; payload: Uint8Array };
        try {
            frame = decodeFrame(bytes);
        } catch {
            return; // malformed envelope: drop, as the firmware would.
        }
        if (frame.type === FrameType.CMD) this.handleCmd(frame.payload);
        else if (frame.type === FrameType.CTL) this.handleCtl(frame.payload);
        // CMD / CTL are the only client→controller frame types.
    }

    private handleCmd(payload: Uint8Array): void {
        // The decoded payload is a view over the client's frame; copy it so
        // corruption injection cannot perturb the client's retained buffer.
        let buf = Uint8Array.from(payload);
        const seq = buf.length >= 4
            ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true)
            : 0;
        if (this.corruptOnce.has(seq)) {
            this.corruptOnce.delete(seq);
            buf = Uint8Array.from(buf);
            buf[4] = buf[4]! ^ 0xff; // flip a dx byte; seq (0..3) stays intact
        }

        const pr = parseDrawingCommand(buf);
        switch (pr.result) {
            case 'ok': {
                // Send-gate: refuse drawing commands until calibrated (Req 10.11).
                if (!this.calibrated) {
                    this.sendNack(pr.cmd.seq, NACK_NOT_READY);
                    return;
                }
                const act = this.seqOnValid(pr.cmd.seq);
                if (act === 'duplicateAck') {
                    this.sendAck(pr.cmd.seq); // idempotent; do NOT re-enqueue
                    return;
                }
                if (this.buffer >= COMMAND_BUFFER_SIZE) {
                    this.sendNack(pr.cmd.seq, NACK_BUFFER_FULL);
                    return;
                }
                this.buffer++;
                this.receivedCmds.push(pr.cmd);
                this.flowOnCommandEnqueued();
                this.sendAck(pr.cmd.seq);
                return;
            }
            case 'retxCrc': {
                const act = this.seqOnCrcError(pr.seq);
                if (act === 'unrecoverable') {
                    this.sendError(
                        ERROR_UNRECOVERABLE_TX,
                        ERROR_AXIS_NONE,
                        pr.seq & 0xffff,
                    );
                    this.sendState(ST_PAUSED);
                } else {
                    this.sendRetx(pr.seq);
                }
                return;
            }
            case 'nackRange':
                this.sendNack(pr.seq, NACK_RANGE);
                return;
            case 'nackParse':
            default:
                this.sendNack(pr.seq, NACK_PARSE);
                return;
        }
    }

    private handleCtl(payload: Uint8Array): void {
        let msg: DecodedCtl;
        try {
            msg = decodeControlPayload(payload);
        } catch {
            return; // malformed control message: ignore (no seq to NACK)
        }
        this.controlLog.push(msg);

        switch (msg.kind) {
            case 'pause':
                this.sendState(ST_PAUSED);
                break;
            case 'resume':
                this.sendState(ST_DRAWING);
                break;
            case 'cancel':
                this.sendState(ST_ABORTED);
                break;
            case 'stop':
                this.sendState(ST_IDLE);
                break;
            case 'setHome':
                this.calibrated = true;
                this.sendState(ST_IDLE);
                break;
            case 'reHome':
                this.calibrated = false;
                this.sendState(ST_IDLE);
                break;
            case 'beginDraw':
                this.seqReset();
                this.sendCredit(this.flowOnBeginDraw());
                this.sendState(ST_DRAWING);
                break;
            case 'endDraw':
                this.sendState(ST_IDLE);
                break;
            case 'motorTest':
                // Non-fatal motor-test report (kind 0x00), detail bit0=X, bit1=Y.
                this.sendError(0x00, ERROR_AXIS_NONE, 0b11);
                break;
            case 'faultReset':
                this.seqReset();
                this.sendState(ST_IDLE);
                break;
            case 'jog':
            case 'speedPct':
            case 'setBacklash':
                // Decoded and logged; the firmware applies these to motion /
                // backlash state with no mandatory frame reply.
                break;
        }
    }

    // ---- flow control (mirrors flow_control.cpp) ----------------------------

    private flowOnBeginDraw(): number {
        this.occupancy = 0;
        this.withholding = false;
        this.creditsOutstanding = COMMAND_BUFFER_SIZE;
        return this.creditsOutstanding;
    }

    private flowOnCommandEnqueued(): void {
        if (this.occupancy < COMMAND_BUFFER_SIZE) this.occupancy++;
        if (this.creditsOutstanding > 0) this.creditsOutstanding--;
        if (this.occupancy >= COMMAND_BUFFER_HIGH_WATER) this.withholding = true;
    }

    /** Simulate the motion planner consuming `n` slots; emit CREDIT frames. */
    consumeSlots(n: number): void {
        for (let i = 0; i < n; i++) {
            if (this.buffer > 0) this.buffer--;
            this.sendCredit(this.flowOnSlotConsumed());
        }
    }

    private flowOnSlotConsumed(): number {
        if (this.occupancy === 0) return 0;
        const wasWithholding = this.withholding;
        this.occupancy--;
        if (wasWithholding) {
            if (this.occupancy > COMMAND_BUFFER_LOW_WATER) return 0;
            this.withholding = false;
            const window = this.creditsOutstanding + this.occupancy;
            const grant = COMMAND_BUFFER_SIZE - window;
            this.creditsOutstanding += grant;
            return grant;
        }
        if (this.creditsOutstanding + this.occupancy < COMMAND_BUFFER_SIZE) {
            this.creditsOutstanding++;
            return 1;
        }
        return 0;
    }

    // ---- sequence tracker (mirrors sequence_tracker.cpp) --------------------

    private seqOnValid(seq: number): 'ack' | 'duplicateAck' {
        if (this.seqHasAcked && seq <= this.seqLastAcked) return 'duplicateAck';
        this.seqHasAcked = true;
        this.seqLastAcked = seq;
        if (this.seqFailing && this.seqFailingSeq === seq) {
            this.seqFailing = false;
            this.seqFailingCount = 0;
        }
        return 'ack';
    }

    private seqOnCrcError(seq: number): 'retx' | 'unrecoverable' {
        if (this.seqUnrecoverable) return 'unrecoverable';
        if (this.seqFailing && this.seqFailingSeq === seq) {
            this.seqFailingCount++;
        } else {
            this.seqFailing = true;
            this.seqFailingSeq = seq;
            this.seqFailingCount = 1;
        }
        if (this.seqFailingCount <= MAX_RETRANSMISSIONS) return 'retx';
        this.seqUnrecoverable = true;
        return 'unrecoverable';
    }

    private seqReset(): void {
        this.seqHasAcked = false;
        this.seqLastAcked = 0;
        this.seqFailing = false;
        this.seqFailingSeq = 0;
        this.seqFailingCount = 0;
        this.seqUnrecoverable = false;
    }

    // ---- outbound: controller → client --------------------------------------

    private enqueue(type: FrameType, payload: Uint8Array): void {
        this.outbox.push(encodeFrame(type, payload));
        this.scheduleDelivery();
    }

    private scheduleDelivery(): void {
        if (this.deliveryScheduled) return;
        this.deliveryScheduled = true;
        queueMicrotask(() => {
            this.deliveryScheduled = false;
            const socket = this.active;
            if (!socket) return;
            const batch = this.outbox.splice(0, this.outbox.length);
            for (const frame of batch) socket.deliver(frame);
        });
    }

    sendAck(seq: number): void {
        this.enqueue(FrameType.ACK, encodeAckPayload({ seq }));
    }
    sendNack(seq: number, reason: number): void {
        this.enqueue(FrameType.NACK, encodeNackPayload({ seq, reason }));
    }
    sendRetx(seq: number): void {
        this.enqueue(FrameType.RETX_REQUEST, encodeRetxRequestPayload({ seq }));
    }
    sendCredit(n: number): void {
        if (n > 0) this.enqueue(FrameType.CREDIT, encodeCreditPayload({ n }));
    }
    sendState(stateCode: number): void {
        this.enqueue(FrameType.STATE, encodeStatePayload({ stateCode }));
    }
    sendError(kind: number, axis: number, detail: number): void {
        this.enqueue(FrameType.ERROR, encodeErrorPayload({ kind, axis, detail }));
    }

    /** Build + send a §4.7 STATUS frame (16-byte payload). */
    emitStatus(opts: StatusOpts): void {
        const buf = new Uint8Array(16);
        const v = new DataView(buf.buffer);
        v.setInt32(0, opts.x, true);
        v.setInt32(4, opts.y, true);
        v.setUint8(8, opts.pct);
        v.setInt8(9, opts.rssi);
        v.setUint16(10, opts.activeSps, true);
        v.setUint8(12, opts.stateCode);
        v.setUint8(13, opts.flags);
        this.enqueue(FrameType.STATUS, buf);
    }

    /** Build + send the §4.8 HELLO frame (40-byte payload, envelope @32/@36). */
    private sendHello(): void {
        const f = this.hello;
        const buf = new Uint8Array(40);
        const v = new DataView(buf.buffer);
        v.setUint32(0, f.firmwareVersion, true);
        v.setUint16(4, FEED_SPS_MAX, true); // max_sps
        v.setUint16(6, 0, true); // reserved
        v.setUint16(8, f.backlashX, true);
        v.setUint16(10, f.backlashY, true);
        v.setFloat32(12, f.mmPerRevX, true);
        v.setFloat32(16, f.mmPerRevY, true);
        v.setInt32(20, f.x, true);
        v.setInt32(24, f.y, true);
        let flags = 0;
        if (f.calibrated) flags |= 0x01;
        if (f.unclean) flags |= 0x02;
        if (f.envelopeCalibrated) flags |= 0x04; // bit2 envelope-calibrated
        v.setUint8(28, flags);
        v.setUint8(29, 0); // reserved
        v.setUint16(30, COMMAND_BUFFER_SIZE, true); // buffer_capacity
        v.setUint32(32, f.envelopeX, true);
        v.setUint32(36, f.envelopeY, true);
        this.enqueue(FrameType.HELLO, buf);
    }

    /** Count CMD frames the client has transmitted on its active socket. */
    countCmdFrames(): number {
        const socket = this.active;
        if (!socket) return 0;
        let count = 0;
        for (const f of socket.sent) {
            try {
                if (decodeFrame(f).type === FrameType.CMD) count++;
            } catch {
                /* ignore */
            }
        }
        return count;
    }
}

// -----------------------------------------------------------------------------
// Harness helpers
// -----------------------------------------------------------------------------

/** Drain queued microtasks so deferred controller→client delivery completes. */
async function settle(): Promise<void> {
    for (let i = 0; i < 12; i++) await Promise.resolve();
}

function makeClient(fw: FakeController): WireClient {
    return new WireClient({
        socketFactory: fw.socketFactory,
        timers: noopTimers,
    });
}

/** Connect a raw WireClient to a FakeController and settle the HELLO exchange. */
async function connectClient(fw: FakeController, client: WireClient): Promise<void> {
    const p = client.connect(URL);
    fw.sockets[0]!.open();
    await p;
    await settle();
}

function command(over: Partial<DrawingCommand> = {}): DrawingCommand {
    return { seq: 0, dxSteps: 10, dySteps: -5, feedSps: 400, flags: 0, ...over };
}

// =============================================================================
// Tests
// =============================================================================

describe('e2e: HELLO exchange on connect (Design §4.8, §5.1)', () => {
    it('emits "home" with the firmware calibration/position and opens the send-gate', async () => {
        const fw = new FakeController();
        fw.configureHello({
            firmwareVersion: 0x010203,
            x: 5,
            y: 7,
            calibrated: true,
            unclean: false,
        });
        const client = makeClient(fw);

        const homes: HomeEvent[] = [];
        client.on('home', (e) => homes.push(e));

        await connectClient(fw, client);

        expect(homes).toHaveLength(1);
        expect(homes[0]).toMatchObject({
            calibrated: true,
            unclean: false,
            position: { x: 5, y: 7 },
            firmwareVersion: 0x010203,
        });
        // The HELLO calibrated flag opens the calibration send-gate (Req 10.11).
        expect(client.isCalibrated()).toBe(true);
    });

    it('surfaces an unclean-shutdown HELLO with the calibration gate closed', async () => {
        const fw = new FakeController();
        fw.configureHello({
            x: 12,
            y: 34,
            calibrated: false,
            unclean: true,
            envelopeCalibrated: false,
        });
        const client = makeClient(fw);

        const homes: HomeEvent[] = [];
        client.on('home', (e) => homes.push(e));

        await connectClient(fw, client);

        expect(homes[0]).toMatchObject({
            calibrated: false,
            unclean: true,
            position: { x: 12, y: 34 },
        });
        expect(client.isCalibrated()).toBe(false);
        // The send-gate now keys on the envelope flag (bit2), which is clear.
        expect(client.isEnvelopeCalibrated()).toBe(false);
    });
});

describe('e2e: CMD → ACK flow with real CRC validation (Design §5.2)', () => {
    it('validates the inner CRC over the real payload and ACKs, resolving sendCommand', async () => {
        const fw = new FakeController();
        fw.configureHello({ calibrated: true });
        const client = makeClient(fw);
        await connectClient(fw, client);

        // BEGIN_DRAW grants the buffer's worth of credits (CREDIT{32}).
        await client.sendControl({ kind: 'beginDraw', totalSegments: 1, totalSteps: 50 });
        await settle();
        expect(client.creditCount()).toBe(COMMAND_BUFFER_SIZE);

        const ack = await client.sendCommand(
            command({ dxSteps: 123, dySteps: -77, feedSps: 650 }),
        );
        expect(ack.seq).toBe(0);

        // The controller decoded the command (CRC verified by the shared
        // crc16ccitt over bytes [0..14)) and enqueued it intact.
        expect(fw.receivedCmds).toHaveLength(1);
        expect(fw.receivedCmds[0]).toMatchObject({
            seq: 0,
            dxSteps: 123,
            dySteps: -77,
            feedSps: 650,
        });
        // A single clean transmission — no retransmission needed.
        expect(fw.countCmdFrames()).toBe(1);
    });

    it('answers a corrupted CMD with RETX_REQUEST, then ACKs the retransmit', async () => {
        const fw = new FakeController();
        fw.configureHello({ calibrated: true });
        const client = makeClient(fw);
        await connectClient(fw, client);

        await client.sendControl({ kind: 'beginDraw', totalSegments: 1, totalSteps: 50 });
        await settle();

        // Corrupt seq 0 once on the wire so its CRC fails on first receipt.
        fw.corruptNextCmd(0);

        const ack = await client.sendCommand(command({ dxSteps: 40, dySteps: 9 }));
        expect(ack.seq).toBe(0);

        // First transmit (corrupted) → RETX_REQUEST → retransmit (clean) → ACK.
        // The client therefore sent the CMD frame exactly twice.
        expect(fw.countCmdFrames()).toBe(2);
        // Only the clean retransmit was enqueued, with the correct fields.
        expect(fw.receivedCmds).toHaveLength(1);
        expect(fw.receivedCmds[0]).toMatchObject({ seq: 0, dxSteps: 40, dySteps: 9 });
    });
});

describe('e2e: CTL messages decode with the correct kind + payload (Design §4.6)', () => {
    it('round-trips JOG / SET_HOME / PAUSE / RESUME / CANCEL / SPEED_PCT', async () => {
        const fw = new FakeController();
        fw.configureHello({ calibrated: true });
        const client = makeClient(fw);
        await connectClient(fw, client);

        await client.sendControl({ kind: 'jog', axis: 0, dir: 1, steps: 1 });
        await client.sendControl({ kind: 'setHome' });
        await client.sendControl({ kind: 'pause' });
        await client.sendControl({ kind: 'resume' });
        await client.sendControl({ kind: 'cancel' });
        await client.sendControl({ kind: 'speedPct', pct: 60 });
        await settle();

        expect(fw.controlLog.map((c) => c.kind)).toEqual([
            'jog',
            'setHome',
            'pause',
            'resume',
            'cancel',
            'speedPct',
        ]);
        expect(fw.controlLog[0]).toEqual({ kind: 'jog', axis: 0, dir: 1, steps: 1 });
        expect(fw.controlLog[5]).toEqual({ kind: 'speedPct', pct: 60 });
    });

    it('decodes a Y-axis reverse jog and a both-axis backlash payload', async () => {
        const fw = new FakeController();
        fw.configureHello({ calibrated: true });
        const client = makeClient(fw);
        await connectClient(fw, client);

        await client.sendControl({ kind: 'jog', axis: 1, dir: -1, steps: 3 });
        await client.sendControl({ kind: 'setBacklash', x: 12, y: 34 });
        await settle();

        expect(fw.controlLog[0]).toEqual({ kind: 'jog', axis: 1, dir: -1, steps: 3 });
        expect(fw.controlLog[1]).toEqual({ kind: 'setBacklash', x: 12, y: 34 });
    });
});

describe('e2e: STATUS frame reception updates UI state (Req 7.4)', () => {
    it('folds a STATUS frame into the controller stores', async () => {
        const fw = new FakeController();
        // Start uncalibrated so the STATUS-driven flip to calibrated is visible.
        fw.configureHello({ calibrated: false, x: 0, y: 0 });
        const stores = createStores();
        const client = makeClient(fw);
        const app = createController({ url: URL, stores, client });

        const cp = app.connect();
        fw.sockets[0]!.open();
        await cp;
        await settle();

        expect(stores.connection.value).toBe('connected');
        expect(stores.calibrated.value).toBe(false);

        fw.emitStatus({
            x: 100,
            y: 200,
            pct: 42,
            rssi: -55,
            activeSps: 400,
            stateCode: ST_DRAWING,
            flags: 0x01, // calibrated
        });
        await settle();

        expect(stores.position.value).toEqual({ x: 100, y: 200 });
        expect(stores.progressPct.value).toBe(42);
        expect(stores.drawingState.value).toBe('drawing');
        expect(stores.rssiDbm.value).toBe(-55);
        expect(stores.calibrated.value).toBe(true);
    });
});

describe('e2e: credit-based flow control under load (Req 7.4, Design §6.4)', () => {
    it('grants the full buffer of credits on BEGIN_DRAW', async () => {
        const fw = new FakeController();
        fw.configureHello({ calibrated: true });
        const client = makeClient(fw);
        await connectClient(fw, client);
        expect(client.creditCount()).toBe(0);

        await client.sendControl({ kind: 'beginDraw', totalSegments: 2, totalSteps: 80 });
        await settle();

        expect(client.creditCount()).toBe(COMMAND_BUFFER_SIZE);
        expect(fw.controlLog.at(-1)).toEqual({
            kind: 'beginDraw',
            totalSegments: 2,
            totalSteps: 80,
        });
    });

    it('transmits only up to the available credits, then releases the rest on CREDIT', async () => {
        const fw = new FakeController();
        fw.configureHello({ calibrated: true });
        const client = makeClient(fw);
        await connectClient(fw, client);

        // Queue five commands before any credits exist: none may transmit.
        const acks = [0, 1, 2, 3, 4].map((i) =>
            client.sendCommand(command({ dxSteps: i + 1, dySteps: 0, feedSps: 300 })),
        );
        await settle();
        expect(fw.countCmdFrames()).toBe(0);

        // Grant 2 credits → exactly two of the five commands flow.
        fw.sendCredit(2);
        await settle();
        expect(fw.countCmdFrames()).toBe(2);

        // Grant the remaining 3 → the rest flow.
        fw.sendCredit(3);
        await settle();
        expect(fw.countCmdFrames()).toBe(5);

        // Every command is ACKed (the controller auto-ACKs valid CMDs),
        // resolving all five promises, and arrives in FIFO order.
        await Promise.all(acks);
        expect(fw.receivedCmds.map((c) => c.dxSteps)).toEqual([1, 2, 3, 4, 5]);
    });

    it('withholds credits at the high-water mark and resumes at the low-water mark', async () => {
        const fw = new FakeController();
        fw.configureHello({ calibrated: true });
        const client = makeClient(fw);
        await connectClient(fw, client);

        // BEGIN_DRAW seeds 32 credits; stream 30 commands so occupancy crosses
        // the high-water mark (28) and the controller latches withholding.
        await client.sendControl({ kind: 'beginDraw', totalSegments: 1, totalSteps: 1 });
        await settle();

        const acks = Array.from({ length: 30 }, (_, i) =>
            client.sendCommand(command({ seq: i, dxSteps: 1, dySteps: 0, feedSps: 200 })),
        );
        await settle();
        await Promise.all(acks);

        expect(fw.receivedCmds).toHaveLength(30);
        // 32 granted − 30 spent = 2 credits left with the client.
        expect(client.creditCount()).toBe(2);

        // Drain to just above low-water (occupancy 30 → 17): still withholding,
        // so no new credits are granted.
        fw.consumeSlots(13);
        await settle();
        expect(client.creditCount()).toBe(2);

        // One more consumed slot reaches the low-water mark (16) and releases a
        // refill burst restoring the credit window back to the buffer capacity.
        fw.consumeSlots(1);
        await settle();
        // window before refill = creditsOutstanding(2) + occupancy(16) = 18,
        // grant = 32 − 18 = 14, so the client now holds 2 + 14 = 16 credits.
        expect(client.creditCount()).toBe(16);
    });
});
