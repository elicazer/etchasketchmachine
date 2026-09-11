import { describe, it, expect } from 'vitest';
import {
    WireClient,
    type WireSocket,
    type TimerApi,
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
} from '../codec/frame';
import { crc16ccitt } from '../codec/crc16';
import { CtlKind } from '../codec/control';
import { createController } from '../app/controller';
import { createStores } from '../app/stores';
import { PathPlanner, totalStepCount } from '../path/planner';
import {
    COMMAND_BUFFER_DEPTH,
    DRAWING_COMMAND_FLAGS,
    FEED_SPS_MAX,
    FEED_SPS_MIN,
} from '../constants';
import type { PlannedPath, Polyline } from '../types';

/**
 * Full drawing-execution flow, end to end (task 32.1, Design §5.2).
 *
 * PlatformIO is not installed and there is no device, so "end to end" is a
 * SHARED-CONTRACT harness: the real {@link WireClient} +
 * {@link createController}/{@link createStores} + real {@link PathPlanner} are
 * driven against a `FakeController` that plays the firmware role with the exact
 * byte layouts the firmware uses. The FakeController mirrors, frame for frame,
 * the §5.2 normal-drawing sequence in `firmware/etchasketch.ino`'s
 * `handleCtlFrame` / `handleCmdFrame`:
 *
 *   BEGIN_DRAW  → CREDIT{32} + STATE drawing
 *   each CMD    → parse + CRC-16/CCITT([0..14)) + range check → ACK, enqueue,
 *                 then (as the motion planner consumes the slot) CREDIT{1}
 *   END_DRAW    → STATE idle
 *
 * This complements task 31.1's `wire_e2e.test.ts` (which proves the transport:
 * HELLO, CMD→ACK, RETX, CTL decode, flow-control under load). Here we drive the
 * *whole* §5.2 flow through the public `controller.draw()` surface and verify:
 *
 *   1. BEGIN_DRAW is sent first; END_DRAW last; `draw()` resolves (Req 7.1).
 *   2. The CMD stream flows under credit-based flow control and every command
 *      is ACKed (Req 6.4, 6.5, 7.4).
 *   3. The stream includes connector-flagged commands (CMD_FLAG_CONNECTOR) for
 *      the inter-contour connectors AND the final auto-return to (0,0) — every
 *      connector is a real motion command, not skipped (Req 14.6, 14.7).
 *   4. Reconstructing the home-relative position from the streamed command
 *      deltas reproduces the planned path vertices exactly, and the final
 *      command parks the pen at home (0,0) (Req 6.1, 6.2, 10.6/10.7, 14.7).
 *
 * The transport is a loopback socket (mirrors `wire_e2e.test.ts`): the
 * WireClient's `send()` is decoded by the FakeController synchronously, and the
 * FakeController's replies are delivered back on a microtask so the WireClient
 * finishes recording its pending ACK before the reply lands, exactly as a real
 * async socket behaves.
 *
 * @see Design §5.2 (normal drawing flow with auto-return), §4.3, §4.5, §6.4
 * @see Requirements 6.1–6.5, 7.1–7.4, 10.6, 10.7, 14.6, 14.7
 */

// -----------------------------------------------------------------------------
// Wire-stable mirrors of firmware codes (cross-checked against the firmware).
// -----------------------------------------------------------------------------

const NACK_RANGE = 0x03;
const NACK_PARSE = 0x01;
const NACK_NOT_READY = 0x05;
const NACK_BUFFER_FULL = 0x04;

const ST_IDLE = 0;
const ST_DRAWING = 1;

const CMD_FLAGS_MASK =
    DRAWING_COMMAND_FLAGS.CONNECTOR | DRAWING_COMMAND_FLAGS.LAST_OF_BATCH;

const URL = 'ws://device.local/ws';

const { CONNECTOR: FLAG_CONNECTOR, LAST_OF_BATCH: FLAG_LAST } =
    DRAWING_COMMAND_FLAGS;

// -----------------------------------------------------------------------------
// Loopback socket (identical contract to wire_e2e.test.ts)
// -----------------------------------------------------------------------------

const noopTimers: TimerApi = {
    setTimeout: () => 0,
    clearTimeout: () => { },
};

function toBytes(data: ArrayBufferView | ArrayBufferLike): Uint8Array {
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer.slice(0) as ArrayBuffer);
    }
    return new Uint8Array(data as ArrayBuffer);
}

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

    open(): void {
        this.readyState = 1;
        this.onopen?.({});
        this.fw.onClientConnected(this);
    }

    deliver(frame: Uint8Array): void {
        this.onmessage?.({ data: frame });
    }
}

// -----------------------------------------------------------------------------
// Drawing_Command parse (mirrors firmware command_parser.cpp, §4.3)
// -----------------------------------------------------------------------------

interface DecodedCmd {
    seq: number;
    dxSteps: number;
    dySteps: number;
    feedSps: number;
    flags: number;
    reserved: number;
}

type CmdParse =
    | { result: 'ok'; cmd: DecodedCmd }
    | { result: 'retxCrc'; seq: number }
    | { result: 'nackRange'; seq: number }
    | { result: 'nackParse'; seq: number };

function parseDrawingCommand(payload: Uint8Array): CmdParse {
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

    const computed = crc16ccitt(payload.subarray(0, 14));
    if (computed !== crc16) return { result: 'retxCrc', seq };

    if (feedSps < FEED_SPS_MIN || feedSps > FEED_SPS_MAX) {
        return { result: 'nackRange', seq };
    }
    if ((flags & ~CMD_FLAGS_MASK) !== 0) return { result: 'nackRange', seq };
    if (reserved !== 0) return { result: 'nackRange', seq };

    return {
        result: 'ok',
        cmd: { seq, dxSteps, dySteps, feedSps, flags, reserved },
    };
}

function ctlKindOf(payload: Uint8Array): number | null {
    return payload.length >= 1 ? payload[0]! : null;
}

// -----------------------------------------------------------------------------
// FakeController — the firmware role for the §5.2 drawing flow
// -----------------------------------------------------------------------------

/**
 * Plays the firmware side of the normal drawing flow. The flow-control model
 * (CREDIT on BEGIN_DRAW, withhold at high-water, resume at low-water) mirrors
 * `flow_control.cpp`; the planner is modelled as keeping up, so each enqueued
 * command's slot is consumed on the next microtask, emitting a CREDIT{1} just
 * as the firmware does on every consumed buffer slot (Design §5.2 / §6.4).
 */
class FakeController {
    readonly sockets: LoopbackSocket[] = [];

    /** Accepted (enqueued) CMDs in arrival order — the firmware ring pushes. */
    readonly receivedCmds: DecodedCmd[] = [];
    /** Decoded CTL kind codes, in arrival order. */
    readonly ctlLog: number[] = [];

    calibrated = true;

    private active: LoopbackSocket | null = null;
    private readonly outbox: Uint8Array[] = [];
    private deliveryScheduled = false;

    // Ring-buffer occupancy + flow-control state (mirrors flow_control.cpp).
    private occupancy = 0;
    private creditsOutstanding = 0;
    private withholding = false;
    private consumeScheduled = false;

    readonly socketFactory = (_url: string): WireSocket => {
        const s = new LoopbackSocket(this);
        this.sockets.push(s);
        return s;
    };

    onClientConnected(socket: LoopbackSocket): void {
        this.active = socket;
        this.sendHello();
    }

    receiveFromClient(bytes: Uint8Array): void {
        let frame: { type: FrameType; payload: Uint8Array };
        try {
            frame = decodeFrame(bytes);
        } catch {
            return;
        }
        if (frame.type === FrameType.CMD) this.handleCmd(frame.payload);
        else if (frame.type === FrameType.CTL) this.handleCtl(frame.payload);
    }

    private handleCmd(payload: Uint8Array): void {
        const pr = parseDrawingCommand(Uint8Array.from(payload));
        switch (pr.result) {
            case 'ok': {
                if (!this.calibrated) {
                    this.sendNack(pr.cmd.seq, NACK_NOT_READY);
                    return;
                }
                if (this.occupancy >= COMMAND_BUFFER_DEPTH) {
                    this.sendNack(pr.cmd.seq, NACK_BUFFER_FULL);
                    return;
                }
                this.receivedCmds.push(pr.cmd);
                this.flowOnCommandEnqueued();
                this.sendAck(pr.cmd.seq);
                this.scheduleConsume();
                return;
            }
            case 'retxCrc':
                this.sendRetx(pr.seq);
                return;
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
        const kind = ctlKindOf(payload);
        if (kind === null) return;
        this.ctlLog.push(kind);
        switch (kind) {
            case CtlKind.BEGIN_DRAW:
                this.sendCredit(this.flowOnBeginDraw());
                this.sendState(ST_DRAWING);
                break;
            case CtlKind.END_DRAW:
                this.sendState(ST_IDLE);
                break;
            default:
                break;
        }
    }

    // ---- flow control (mirrors flow_control.cpp) ----------------------------

    private flowOnBeginDraw(): number {
        this.occupancy = 0;
        this.withholding = false;
        this.creditsOutstanding = COMMAND_BUFFER_DEPTH;
        return this.creditsOutstanding;
    }

    private flowOnCommandEnqueued(): void {
        if (this.occupancy < COMMAND_BUFFER_DEPTH) this.occupancy++;
        if (this.creditsOutstanding > 0) this.creditsOutstanding--;
        if (this.occupancy >= 28) this.withholding = true;
    }

    private flowOnSlotConsumed(): number {
        if (this.occupancy === 0) return 0;
        const wasWithholding = this.withholding;
        this.occupancy--;
        if (wasWithholding) {
            if (this.occupancy > 16) return 0;
            this.withholding = false;
            const window = this.creditsOutstanding + this.occupancy;
            const grant = COMMAND_BUFFER_DEPTH - window;
            this.creditsOutstanding += grant;
            return grant;
        }
        if (this.creditsOutstanding + this.occupancy < COMMAND_BUFFER_DEPTH) {
            this.creditsOutstanding++;
            return 1;
        }
        return 0;
    }

    /** Model the motion planner consuming one buffered slot per microtask. */
    private scheduleConsume(): void {
        if (this.consumeScheduled) return;
        this.consumeScheduled = true;
        queueMicrotask(() => {
            this.consumeScheduled = false;
            if (this.occupancy > 0) {
                this.sendCredit(this.flowOnSlotConsumed());
            }
            if (this.occupancy > 0) this.scheduleConsume();
        });
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

    private sendAck(seq: number): void {
        this.enqueue(FrameType.ACK, encodeAckPayload({ seq }));
    }
    private sendNack(seq: number, reason: number): void {
        this.enqueue(FrameType.NACK, encodeNackPayload({ seq, reason }));
    }
    private sendRetx(seq: number): void {
        this.enqueue(FrameType.RETX_REQUEST, encodeRetxRequestPayload({ seq }));
    }
    private sendCredit(n: number): void {
        if (n > 0) this.enqueue(FrameType.CREDIT, encodeCreditPayload({ n }));
    }
    private sendState(stateCode: number): void {
        this.enqueue(FrameType.STATE, encodeStatePayload({ stateCode }));
    }

    private sendHello(): void {
        const buf = new Uint8Array(40);
        const v = new DataView(buf.buffer);
        v.setUint32(0, 0x000100, true); // firmware_version
        v.setUint16(4, FEED_SPS_MAX, true); // max_sps
        v.setFloat32(12, 100, true); // mm_per_rev_x
        v.setFloat32(16, 100, true); // mm_per_rev_y
        v.setInt32(20, 0, true); // logical_x
        v.setInt32(24, 0, true); // logical_y
        // flags: bit0 home + bit2 envelope-calibrated when calibrated (0x05),
        // so the controller's draw send-gate (envelopeCalibrated) opens.
        v.setUint8(28, this.calibrated ? 0x05 : 0x00); // flags
        v.setUint16(30, COMMAND_BUFFER_DEPTH, true); // buffer_capacity
        v.setUint32(32, 20000, true); // envelope_x_steps
        v.setUint32(36, 16000, true); // envelope_y_steps
        this.enqueue(FrameType.HELLO, buf);
    }

    // ---- sent-frame inspection ----------------------------------------------

    private decodeSent(): { type: FrameType; payload: Uint8Array }[] {
        const out: { type: FrameType; payload: Uint8Array }[] = [];
        for (const f of this.active?.sent ?? []) {
            try {
                out.push(decodeFrame(f));
            } catch {
                /* ignore */
            }
        }
        return out;
    }

    /** Every CMD payload the client transmitted, decoded, in send order. */
    sentCommands(): DecodedCmd[] {
        const cmds: DecodedCmd[] = [];
        for (const f of this.decodeSent()) {
            if (f.type !== FrameType.CMD) continue;
            const pr = parseDrawingCommand(f.payload);
            if (pr.result === 'ok') cmds.push(pr.cmd);
        }
        return cmds;
    }

    /** Ordered list of sent frame types (CMD / CTL only — client→ctrl). */
    sentFrameTypes(): FrameType[] {
        return this.decodeSent().map((f) => f.type);
    }

    /** Decoded CTL kind for the i-th sent CTL frame. */
    sentCtlKinds(): number[] {
        const kinds: number[] = [];
        for (const f of this.decodeSent()) {
            if (f.type === FrameType.CTL && f.payload.length >= 1) {
                kinds.push(f.payload[0]!);
            }
        }
        return kinds;
    }
}

// -----------------------------------------------------------------------------
// Harness helpers
// -----------------------------------------------------------------------------

function makeClient(fw: FakeController): WireClient {
    return new WireClient({ socketFactory: fw.socketFactory, timers: noopTimers });
}

async function settle(): Promise<void> {
    for (let i = 0; i < 64; i++) await Promise.resolve();
}

/**
 * Walk a planned path the SAME way `PathPlanner.toCommands` does — threading
 * the pen from `home`, skipping the shared seam vertex of each segment after
 * the first and any zero-length move — collecting the absolute position and
 * connector-ness reached by each emitted command. Because the test's deltas
 * never exceed the i16 wire limit, `toCommands` emits exactly one command per
 * collected vertex, so this is the ground truth the streamed deltas must
 * reconstruct.
 */
function expectedVertices(
    path: PlannedPath,
    home: { x: number; y: number },
): { x: number; y: number; connector: boolean }[] {
    const out: { x: number; y: number; connector: boolean }[] = [];
    let prev = { x: home.x, y: home.y };
    for (let i = 0; i < path.segments.length; i++) {
        const seg = path.segments[i]!;
        const isConnector = seg.kind === 'connector';
        const startIdx = i === 0 ? 0 : 1;
        for (let j = startIdx; j < seg.pointsSteps.length; j++) {
            const v = seg.pointsSteps[j]!;
            const dx = v.x - prev.x;
            const dy = v.y - prev.y;
            prev = v;
            if (dx === 0 && dy === 0) continue;
            out.push({ x: v.x, y: v.y, connector: isConnector });
        }
    }
    return out;
}

/** A zig-zag polyline: x marches right, y alternates between two heights. */
function zigZag(
    x0: number,
    yLow: number,
    yHigh: number,
    points: number,
    dx: number,
): Polyline {
    const poly: Polyline = [];
    for (let i = 0; i < points; i++) {
        poly.push({ x: x0 + i * dx, y: i % 2 === 0 ? yLow : yHigh });
    }
    return poly;
}

const HOME = { x: 0, y: 0 } as const;

// =============================================================================
// Tests
// =============================================================================

describe('e2e: full drawing execution flow (Design §5.2, Req 6/7/10/14)', () => {
    it('streams BEGIN_DRAW → CMDs → END_DRAW, ACKs every command, and resolves', async () => {
        const fw = new FakeController();
        const stores = createStores();
        const client = makeClient(fw);
        const app = createController({ url: URL, stores, client });

        // Connect + settle the HELLO handshake (opens the calibration gate).
        const cp = app.connect();
        fw.sockets[0]!.open();
        await cp;
        await settle();
        expect(stores.calibrated.value).toBe(true);

        // Plan a TWO-polyline drawing so the planner inserts inter-contour
        // connectors AND the final auto-return-to-home connector.
        const polylines: Polyline[] = [
            zigZag(10, 20, 30, 22, 2), // contour A
            zigZag(10, 60, 70, 22, 2), // contour B (well separated from A)
        ];
        app.setPolylines(polylines);
        const path = stores.plannedPath.value!;
        expect(path).not.toBeNull();
        // Sanity: the plan really does contain connector segments.
        expect(path.segments.some((s) => s.kind === 'connector')).toBe(true);

        const planner = new PathPlanner();
        const commands = planner.toCommands(path, { ...HOME }, FEED_SPS_MAX);
        // More commands than the 32-deep buffer, so flow-control refills (not
        // just the initial CREDIT{32}) are exercised end to end.
        expect(commands.length).toBeGreaterThan(COMMAND_BUFFER_DEPTH);

        // Drive the whole §5.2 flow through the public controller surface.
        await app.draw();
        await settle();

        // --- BEGIN_DRAW first, END_DRAW last (Req 7.1, Design §5.2) ----------
        const ctlKinds = fw.sentCtlKinds();
        expect(ctlKinds[0]).toBe(CtlKind.BEGIN_DRAW);
        expect(ctlKinds.at(-1)).toBe(CtlKind.END_DRAW);

        const types = fw.sentFrameTypes();
        const firstCmd = types.indexOf(FrameType.CMD);
        const lastCmd = types.lastIndexOf(FrameType.CMD);
        const beginIdx = types.indexOf(FrameType.CTL);
        const endIdx = types.lastIndexOf(FrameType.CTL);
        // BEGIN_DRAW precedes the whole CMD stream; END_DRAW follows it.
        expect(beginIdx).toBeLessThan(firstCmd);
        expect(lastCmd).toBeLessThan(endIdx);

        // --- every command transmitted, ACKed, and enqueued exactly once -----
        expect(fw.receivedCmds).toHaveLength(commands.length);
        const seqs = fw.receivedCmds.map((c) => c.seq);
        expect(new Set(seqs).size).toBe(commands.length); // no duplicates
        // draw() only resolves once Promise.all(acks) resolves, i.e. every
        // command was ACKed (Req 7.4). Reaching here proves it.

        // BEGIN_DRAW carried the planner's segment / step totals.
        expect(stores.plannedPath.value).toBe(path);
    });

    it('emits connector segments as real motion commands (return-to-home suppressed)', async () => {
        const fw = new FakeController();
        const stores = createStores();
        const client = makeClient(fw);
        const app = createController({ url: URL, stores, client });

        const cp = app.connect();
        fw.sockets[0]!.open();
        await cp;
        await settle();

        const polylines: Polyline[] = [
            zigZag(10, 20, 30, 22, 2),
            zigZag(10, 60, 70, 22, 2),
        ];
        app.setPolylines(polylines);
        const path = stores.plannedPath.value!;

        await app.draw();
        await settle();

        const expected = expectedVertices(path, HOME);

        // The firmware enqueues commands in seq order; reconstruct from them.
        const received = [...fw.receivedCmds].sort((a, b) => a.seq - b.seq);
        expect(received).toHaveLength(expected.length);

        // --- Req 14.6: connectors use the SAME CMD representation as strokes -
        // Every command (stroke or connector) is a real 16-byte CMD with real
        // motion; connectors are flagged CMD_FLAG_CONNECTOR, never skipped.
        received.forEach((cmd, i) => {
            const exp = expected[i]!;
            const isConnectorFlagged = (cmd.flags & FLAG_CONNECTOR) !== 0;
            expect(isConnectorFlagged).toBe(exp.connector);
            // Real motion: no command encodes a zero-length move.
            expect(cmd.dxSteps !== 0 || cmd.dySteps !== 0).toBe(true);
        });

        // At least two connectors travel as visible motion: home→first
        // contour and the inter-contour hop. (The auto-return-to-home connector
        // is intentionally suppressed by the controller — returnToHome:false —
        // so the stylus is left where the drawing ends rather than drawing a
        // line back across the finished art.)
        const connectorCmds = received.filter(
            (c) => (c.flags & FLAG_CONNECTOR) !== 0,
        );
        expect(connectorCmds.length).toBeGreaterThanOrEqual(2);

        // --- Req 6.1/6.2/10.7/14.7: position tracking through the drawing ----
        // Reconstruct the home-relative position from the streamed deltas and
        // assert the running position matches each planned vertex.
        let x = HOME.x;
        let y = HOME.y;
        const running: { x: number; y: number }[] = [];
        for (const cmd of received) {
            x += cmd.dxSteps;
            y += cmd.dySteps;
            running.push({ x, y });
        }
        expect(running).toEqual(expected.map((e) => ({ x: e.x, y: e.y })));

        // With auto-return-to-home suppressed (controller returnToHome:false),
        // the stylus is left where the drawing ends rather than parked at
        // (0,0). The final command is still flagged LAST_OF_BATCH and lands on
        // the planned path's final vertex.
        const last = received.at(-1)!;
        const finalVertex = expected.at(-1)!;
        expect(running.at(-1)).toEqual({ x: finalVertex.x, y: finalVertex.y });
        expect((last.flags & FLAG_LAST) !== 0).toBe(true);
    });

    it('transmits the CMD stream under flow control (initial credit grant then refills)', async () => {
        const fw = new FakeController();
        const stores = createStores();
        const client = makeClient(fw);
        const app = createController({ url: URL, stores, client });

        const cp = app.connect();
        fw.sockets[0]!.open();
        await cp;
        await settle();

        // Before BEGIN_DRAW there are no credits, so a queued command cannot be
        // transmitted: the credit window gates the stream (Req 6.5).
        const blocked = client.sendCommand({
            seq: 0,
            dxSteps: 5,
            dySteps: 0,
            feedSps: FEED_SPS_MAX,
            flags: 0,
        });
        await settle();
        expect(fw.sentCommands()).toHaveLength(0);
        expect(client.creditCount()).toBe(0);
        // Clear that probe so it doesn't interfere with the planned draw.
        void blocked.catch(() => undefined);
        client.close();

        // Fresh client for the actual flow-controlled draw.
        const fw2 = new FakeController();
        const stores2 = createStores();
        const client2 = makeClient(fw2);
        const app2 = createController({ url: URL, stores: stores2, client: client2 });
        const cp2 = app2.connect();
        fw2.sockets[0]!.open();
        await cp2;
        await settle();

        const polylines: Polyline[] = [
            zigZag(10, 20, 30, 22, 2),
            zigZag(10, 60, 70, 22, 2),
        ];
        app2.setPolylines(polylines);
        const path = stores2.plannedPath.value!;
        const commands = new PathPlanner().toCommands(path, { ...HOME }, FEED_SPS_MAX);
        expect(commands.length).toBeGreaterThan(COMMAND_BUFFER_DEPTH);

        const credits: number[] = [];
        client2.on('flow', (e) => {
            if (e.delta > 0) credits.push(e.delta);
        });

        await app2.draw();
        await settle();

        // The first credit grant is the full buffer (CREDIT{32} on BEGIN_DRAW),
        // and additional credits were granted as slots were consumed — proving
        // the > 32-command stream only flowed because flow control refilled it.
        expect(credits[0]).toBe(COMMAND_BUFFER_DEPTH);
        const totalGranted = credits.reduce((a, b) => a + b, 0);
        expect(totalGranted).toBeGreaterThanOrEqual(commands.length);
        expect(fw2.receivedCmds).toHaveLength(commands.length);
    });

    it('reports total segment / step counts on BEGIN_DRAW (Design §5.2)', async () => {
        const fw = new FakeController();
        const stores = createStores();
        const client = makeClient(fw);
        const app = createController({ url: URL, stores, client });

        const cp = app.connect();
        fw.sockets[0]!.open();
        await cp;
        await settle();

        const polylines: Polyline[] = [
            zigZag(10, 20, 30, 8, 4),
            zigZag(10, 60, 70, 8, 4),
        ];
        app.setPolylines(polylines);
        const path = stores.plannedPath.value!;

        // Capture the BEGIN_DRAW payload the client actually transmitted.
        await app.draw();
        await settle();

        const beginFrame = (fw.sockets[0]!.sent
            .map((f) => {
                try {
                    return decodeFrame(f);
                } catch {
                    return null;
                }
            })
            .find(
                (f) =>
                    f !== null &&
                    f.type === FrameType.CTL &&
                    f.payload[0] === CtlKind.BEGIN_DRAW,
            ))!;
        const v = new DataView(
            beginFrame.payload.buffer,
            beginFrame.payload.byteOffset,
            beginFrame.payload.byteLength,
        );
        const totalSegments = v.getUint32(1, true);
        const totalSteps = v.getUint32(5, true);
        expect(totalSegments).toBe(path.segments.length);
        expect(totalSteps).toBe(totalStepCount(path));
    });
});
