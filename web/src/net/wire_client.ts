/**
 * `WireClient` — browser-side WebSocket binary transport to the controller.
 *
 * This is the SPA half of the reliable wire protocol described in Design
 * §3.1.5 / §4.5. It frames `Drawing_Command`s and `Control` messages onto a
 * single binary WebSocket (`/ws`), owns the per-session sequence counter,
 * attaches the inner CRC (via the command codec), drives credit-based flow
 * control, performs bounded retransmission, and supervises a 60-second
 * reconnect window. Inbound telemetry frames are decoded and surfaced as typed
 * events.
 *
 * The class deliberately reuses the existing codecs rather than re-deriving any
 * byte layout:
 *   - `encodeCommand`  (`../codec/drawing_command`) — 16-byte CMD payload + CRC
 *   - `encodeControl`  (`../codec/control`)         — CTL payload
 *   - frame envelope + fixed control payloads (`../codec/frame`)
 *
 * Both the WebSocket and the timer/clock are injectable so the whole state
 * machine is unit-testable with a fake socket and a fake clock — no real
 * network or wall-clock dependency.
 *
 * @see Design §3.1.5 (WireClient interface), §4.5–§4.8 (frame layouts)
 * @see Requirements 7.1, 7.3, 7.5, 7.6, 7.7, 10.11
 */

import {
    MAX_RETRANSMISSIONS,
    RECONNECT_WINDOW_MS,
} from '../constants';
import { encodeControl, type ControlMessage } from '../codec/control';
import { encodeCommand } from '../codec/drawing_command';
import {
    FrameType,
    decodeAckPayload,
    decodeCreditPayload,
    decodeErrorPayload,
    decodeFrame,
    decodeNackPayload,
    decodeRetxRequestPayload,
    decodeStatePayload,
    encodeFrame,
} from '../codec/frame';
import type { DrawingCommand } from '../types';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Connection-level lifecycle state reported by {@link WireClient.state}. */
export type ConnectionState =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting';

/** Resolution value of a successful `sendCommand` / `sendControl`. */
export interface Ack {
    /**
     * The acknowledged command sequence number. Control messages have no
     * sequence number on the wire (Design §4.6), so they resolve with
     * {@link CONTROL_ACK_SEQ}.
     */
    seq: number;
}

/** Sentinel `seq` used in the {@link Ack} returned for control messages. */
export const CONTROL_ACK_SEQ = -1;

/** ERROR-frame kinds that map to a fault, plus client-detected conditions. */
export type FaultKind =
    | 'fault'
    | 'unrecoverableTx'
    | 'connTimeout'
    | 'homeRequired'
    | 'envelopeRequired';

/** Payload of the `fault` event. Unused numeric fields default to a sentinel. */
export interface FaultEvent {
    kind: FaultKind;
    message: string;
    /** Axis (0 = X, 1 = Y); 0 when not applicable. */
    axis: number;
    /** Driver-specific detail code; 0 when not applicable. */
    detail: number;
    /** Related command seq, or -1 when not applicable. */
    seq: number;
}

/** Payload of the `stall` event (Design §4.5 ERROR kind STALL, Req 12.3). */
export interface StallEvent {
    axis: number;
    detail: number;
}

/** Payload of the `rssi` event (Design §4.7 STATUS, Req 12.2). */
export interface RssiEvent {
    rssiDbm: number;
}

/** Payload of the `progress` event (Design §4.5 PROGRESS, Req 7.4). */
export interface ProgressEvent {
    doneSteps: number;
    totalSteps: number;
    /** Convenience percentage in [0, 100]; 0 when totalSteps is 0. */
    pct: number;
}

/** Payload of the `flow` event, emitted on every credit change. */
export interface FlowEvent {
    /** Credits currently held by the client. */
    credits: number;
    /** Signed change that produced this event (+n on CREDIT, -1 on send). */
    delta: number;
}

/** Payload of the `home` event (Design §4.8 HELLO, Req 10.x calibration). */
export interface HomeEvent {
    calibrated: boolean;
    unclean: boolean;
    position: { x: number; y: number };
    firmwareVersion: number;
    /** Measured step envelope (Design §4.8, Req 8.1, 8.3). */
    envelope: { x: number; y: number };
    /** Whether a valid envelope is calibrated (HELLO flags bit2, Req 8.3). */
    envelopeCalibrated: boolean;
}

/**
 * Payload of the `state` event. A discriminated union so connection-level
 * transitions, bare controller state codes (STATE frame), and full periodic
 * telemetry (STATUS frame) each carry exactly the fields they have.
 */
export type StateEvent =
    | { kind: 'connection'; connection: ConnectionState }
    | { kind: 'controller'; controller: number }
    | {
        kind: 'status';
        controller: number;
        position: { x: number; y: number };
        pctComplete: number;
        calibrated: boolean;
        envelopeCalibrated: boolean;
        bufferFull: boolean;
    };

/** Map from event name to its payload type. */
export interface WireEventMap {
    state: StateEvent;
    progress: ProgressEvent;
    fault: FaultEvent;
    stall: StallEvent;
    rssi: RssiEvent;
    flow: FlowEvent;
    home: HomeEvent;
}

/** Event names accepted by {@link WireClient.on}. */
export type WireEvent = keyof WireEventMap;

/** Discriminated reasons a `sendCommand` / `sendControl` promise rejects. */
export type WireErrorKind =
    | 'notCalibrated'
    | 'unrecoverableTx'
    | 'nack'
    | 'connTimeout'
    | 'disconnected';

/** Typed error rejected from the send path and surfaced as events. */
export class WireError extends Error {
    public readonly kind: WireErrorKind;
    public readonly seq: number;

    constructor(kind: WireErrorKind, message: string, seq = -1) {
        super(message);
        this.name = 'WireError';
        this.kind = kind;
        this.seq = seq;
    }
}

// -----------------------------------------------------------------------------
// Injection seams (socket + timers)
// -----------------------------------------------------------------------------

/**
 * Minimal WebSocket surface the client depends on. The browser `WebSocket`
 * satisfies this structurally; tests pass a fake implementation.
 */
export interface WireSocket {
    binaryType: 'blob' | 'arraybuffer';
    readyState: number;
    send(data: ArrayBufferView | ArrayBufferLike): void;
    /**
     * Optional priority send for URGENT control frames (STOP / PAUSE / CANCEL /
     * RESUME). On transports that serialise writes (BLE acknowledged-write
     * chain), a normal `send` queues BEHIND any in-flight command-chunk writes,
     * so a STOP issued mid-draw would not transmit until the whole command
     * backlog drains — making the stop button feel dead. When present, this
     * sends the frame ahead of that backlog. Transports with no write queue
     * (WebSocket) don't need it and may omit it; callers fall back to `send`.
     */
    sendPriority?(data: ArrayBufferView | ArrayBufferLike): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    onclose: ((ev: unknown) => void) | null;
}

/** Factory producing a {@link WireSocket} for a URL. */
export type SocketFactory = (url: string) => WireSocket;

/** Injectable timer surface so the reconnect window is clock-independent. */
export interface TimerApi {
    setTimeout(handler: () => void, ms: number): number;
    clearTimeout(handle: number): void;
}

/** Construction options; every field has a production-safe default. */
export interface WireClientOptions {
    socketFactory?: SocketFactory;
    timers?: TimerApi;
    maxRetransmissions?: number;
    reconnectWindowMs?: number;
    /** Delay between reconnect socket attempts within the window. */
    reconnectRetryDelayMs?: number;
}

/** `WebSocket.OPEN` readyState constant. */
const WS_OPEN = 1;

const defaultSocketFactory: SocketFactory = (url) =>
    new WebSocket(url) as unknown as WireSocket;

const defaultTimers: TimerApi = {
    setTimeout: (handler, ms) =>
        globalThis.setTimeout(handler, ms) as unknown as number,
    clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

// -----------------------------------------------------------------------------
// Internal bookkeeping
// -----------------------------------------------------------------------------

/** One outbound Drawing_Command tracked from enqueue through ACK. */
interface OutboundCommand {
    seq: number;
    /** Encoded 16-byte CMD payload (with CRC), reused for retransmission. */
    payload: Uint8Array;
    resolve: (ack: Ack) => void;
    reject: (err: Error) => void;
    /** Number of retransmissions performed so far (Req 7.3). */
    retxCount: number;
}

/** A control frame queued while the socket is not open. */
interface QueuedControl {
    frame: Uint8Array;
    resolve: (ack: Ack) => void;
    reject: (err: Error) => void;
}

// ERROR-frame kind codes (Design §4.5).
const ERROR_KIND_STALL = 0x01;
const ERROR_KIND_FAULT = 0x02;
const ERROR_KIND_UNRECOVERABLE_TX = 0x03;
const ERROR_KIND_CONN_TIMEOUT = 0x04;
const ERROR_KIND_HOME_REQUIRED = 0x05;
const ERROR_KIND_ENVELOPE_REQUIRED = 0x06;

// NACK reason codes (Design §Data Models — NACK Reason Codes). The envelope
// reasons map to the `envelopeRequired` fault so the wizard re-surfaces the
// outstanding calibration step (mirror of the firmware authority).
const NACK_REASON_ENVELOPE_REQUIRED = 0x06;
const NACK_REASON_ENVELOPE_HOME_NOT_SET = 0x07;
const NACK_REASON_ENVELOPE_INVALID = 0x08;
const NACK_REASON_JOG_TRAVEL_CAP = 0x09;

// STATUS / HELLO flag bits (Design §4.7 / §4.8).
const FLAG_CALIBRATED = 0x01;
const STATUS_FLAG_BUFFER_FULL = 0x02;
const HELLO_FLAG_UNCLEAN = 0x02;
/** Bit2 of the HELLO/STATUS flags byte — envelope-calibrated (Req 8.2–8.4). */
const FLAG_ENVELOPE_CALIBRATED = 0x04;

// -----------------------------------------------------------------------------
// WireClient
// -----------------------------------------------------------------------------

export class WireClient {
    private readonly socketFactory: SocketFactory;
    private readonly timers: TimerApi;
    private readonly maxRetransmissions: number;
    private readonly reconnectWindowMs: number;
    private readonly reconnectRetryDelayMs: number;

    private socket: WireSocket | null = null;
    private url = '';
    private connState: ConnectionState = 'disconnected';

    /** Home-set flag (Req 10.x). Tracked from HELLO/STATUS bit0. */
    private calibrated = false;

    /**
     * Captured-calibration reporting flag (Req 8.2–8.4). Tracks ONLY whether a
     * *captured* Step_Envelope exists (HELLO/STATUS flags bit2). It no longer
     * gates sends — drawing is allowed against the firmware-authoritative
     * effective envelope (Defect 2 fix, Req 2.8). Retained for status reporting
     * and the recalibration prompt.
     */
    private envelopeCalibrated = false;

    /**
     * Send-gate flag (Defect 2 fix, Req 2.5/2.8). A drawing may be sent once an
     * *effective* Step_Envelope is known — the captured envelope when
     * calibrated, else the baked-in DEFAULT_ENVELOPE. The firmware advertises
     * the effective envelope in HELLO (positive dimensions), so this opens as
     * soon as a HELLO is folded. The firmware no longer NACKs `EnvelopeRequired`
     * for an uncalibrated draw; genuine invalid-envelope NACKs/ERRORs still
     * re-close the gate via the fault mirror.
     */
    private envelopeKnown = false;

    /** Monotonic per-session sequence counter; reset on `connect()`. */
    private seqCounter = 0;

    /** Flow-control credits; seeded by CREDIT frames (Design §6.4). */
    private credits = 0;

    /** Commands awaiting credits and/or an open socket (FIFO). */
    private sendQueue: OutboundCommand[] = [];

    /** Commands transmitted and awaiting ACK, keyed by seq. */
    private readonly pendingAcks = new Map<number, OutboundCommand>();

    /** Control frames awaiting an open socket (FIFO). */
    private controlQueue: QueuedControl[] = [];

    private readonly listeners = new Map<WireEvent, Set<(p: unknown) => void>>();

    private connectResolve: (() => void) | null = null;
    private connectReject: ((err: Error) => void) | null = null;
    private deliberateClose = false;
    private reconnectDeadlineTimer: number | null = null;

    constructor(options: WireClientOptions = {}) {
        this.socketFactory = options.socketFactory ?? defaultSocketFactory;
        this.timers = options.timers ?? defaultTimers;
        this.maxRetransmissions =
            options.maxRetransmissions ?? MAX_RETRANSMISSIONS;
        this.reconnectWindowMs =
            options.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
        this.reconnectRetryDelayMs = options.reconnectRetryDelayMs ?? 1000;
    }

    // -------------------------------------------------------------------------
    // Public API (Design §3.1.5)
    // -------------------------------------------------------------------------

    /**
     * Open the binary WebSocket and resolve once it is established. Resets the
     * per-session sequence counter, credits, and pending state (a fresh
     * session). Rejects if the socket closes or errors before opening.
     */
    connect(url: string): Promise<void> {
        this.url = url;
        this.deliberateClose = false;
        this.seqCounter = 0;
        this.credits = 0;
        this.sendQueue = [];
        this.controlQueue = [];
        this.pendingAcks.clear();
        if (this.reconnectDeadlineTimer !== null) {
            this.timers.clearTimeout(this.reconnectDeadlineTimer);
            this.reconnectDeadlineTimer = null;
        }

        this.setConnState('connecting');
        return new Promise<void>((resolve, reject) => {
            this.connectResolve = resolve;
            this.connectReject = reject;
            this.openSocket();
        });
    }

    /**
     * Assign the next sequence number, encode + CRC the command, and send it
     * subject to the calibration send-gate (Req 10.11) and flow-control
     * credits. Resolves with the ACK, or rejects on NACK, unrecoverable
     * retransmission failure (Req 7.7), or connection timeout (Req 7.6).
     */
    sendCommand(cmd: DrawingCommand): Promise<Ack> {
        if (!this.envelopeKnown) {
            return Promise.reject(
                new WireError(
                    'notCalibrated',
                    'sendCommand blocked: no effective envelope known (Req 2.5, 2.8)',
                ),
            );
        }
        if (this.connState === 'disconnected') {
            return Promise.reject(
                new WireError('disconnected', 'sendCommand: not connected'),
            );
        }

        const seq = this.seqCounter++;
        let payload: Uint8Array;
        try {
            payload = encodeCommand({ ...cmd, seq });
        } catch (err) {
            return Promise.reject(
                err instanceof Error ? err : new Error(String(err)),
            );
        }

        return new Promise<Ack>((resolve, reject) => {
            this.sendQueue.push({ seq, payload, resolve, reject, retxCount: 0 });
            this.flushCommands();
        });
    }

    /**
     * Encode and send a control message. `beginDraw` is blocked by the
     * calibration send-gate (Req 10.11). Control frames carry no wire sequence
     * number, so the resolved {@link Ack} uses {@link CONTROL_ACK_SEQ}; the
     * promise resolves once the frame has been written to the socket.
     */
    sendControl(ctl: ControlMessage): Promise<Ack> {
        if (ctl.kind === 'beginDraw' && !this.envelopeKnown) {
            return Promise.reject(
                new WireError(
                    'notCalibrated',
                    'BEGIN_DRAW blocked: no effective envelope known (Req 2.5, 2.8)',
                ),
            );
        }
        if (this.connState === 'disconnected') {
            return Promise.reject(
                new WireError('disconnected', 'sendControl: not connected'),
            );
        }

        let frame: Uint8Array;
        try {
            frame = encodeFrame(FrameType.CTL, encodeControl(ctl));
        } catch (err) {
            return Promise.reject(
                err instanceof Error ? err : new Error(String(err)),
            );
        }

        if (this.isOpen()) {
            // Urgent controls (stop/pause/cancel/resume) must not wait behind a
            // backlog of queued command writes on a serialising transport (BLE):
            // jump the queue via sendPriority when the transport provides it.
            const urgent =
                ctl.kind === 'stop' ||
                ctl.kind === 'pause' ||
                ctl.kind === 'cancel' ||
                ctl.kind === 'resume';
            if (urgent && typeof this.socket!.sendPriority === 'function') {
                this.socket!.sendPriority(frame);
            } else {
                this.socket!.send(frame);
            }
            return Promise.resolve({ seq: CONTROL_ACK_SEQ });
        }
        return new Promise<Ack>((resolve, reject) => {
            this.controlQueue.push({ frame, resolve, reject });
        });
    }

    /** Register an event handler. Multiple handlers per event are supported. */
    on<E extends WireEvent>(
        event: E,
        handler: (payload: WireEventMap[E]) => void,
    ): void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(handler as (p: unknown) => void);
    }

    /** Remove a previously registered handler. */
    off<E extends WireEvent>(
        event: E,
        handler: (payload: WireEventMap[E]) => void,
    ): void {
        this.listeners.get(event)?.delete(handler as (p: unknown) => void);
    }

    /** Current connection-level state. */
    state(): ConnectionState {
        return this.connState;
    }

    /** Set the home-set flag explicitly (Req 10.x). */
    setCalibrated(calibrated: boolean): void {
        this.calibrated = calibrated;
    }

    /** Whether home has been set (HELLO/STATUS bit0). */
    isCalibrated(): boolean {
        return this.calibrated;
    }

    /**
     * Set the captured-calibration flag explicitly (Req 8.2–8.4). For backward
     * compatibility this also opens/closes the effective-envelope send-gate:
     * tests and callers that mark the client envelope-calibrated still expect
     * sends to be allowed. The HELLO/STATUS folds set the gate authoritatively
     * from the advertised effective envelope.
     */
    setEnvelopeCalibrated(envelopeCalibrated: boolean): void {
        this.envelopeCalibrated = envelopeCalibrated;
        if (envelopeCalibrated) this.envelopeKnown = true;
    }

    /** Whether a captured envelope calibration exists (HELLO/STATUS bit2). */
    isEnvelopeCalibrated(): boolean {
        return this.envelopeCalibrated;
    }

    /**
     * Set the effective-envelope send-gate explicitly. The gate opens once an
     * effective envelope (captured or default) is known and the firmware no
     * longer refuses an uncalibrated draw (Defect 2 fix, Req 2.5/2.8).
     */
    setEnvelopeKnown(envelopeKnown: boolean): void {
        this.envelopeKnown = envelopeKnown;
    }

    /** Whether commands may currently be sent (effective-envelope send-gate). */
    isEnvelopeKnown(): boolean {
        return this.envelopeKnown;
    }

    /** Credits currently available for flow-controlled CMD sends. */
    creditCount(): number {
        return this.credits;
    }

    /**
     * Deliberately close the connection. Suppresses the reconnect window so a
     * user-initiated disconnect does not trigger a reconnect attempt.
     */
    close(): void {
        this.deliberateClose = true;
        if (this.reconnectDeadlineTimer !== null) {
            this.timers.clearTimeout(this.reconnectDeadlineTimer);
            this.reconnectDeadlineTimer = null;
        }
        try {
            this.socket?.close();
        } catch {
            /* ignore */
        }
        this.socket = null;
        this.setConnState('disconnected');
    }

    // -------------------------------------------------------------------------
    // Socket lifecycle
    // -------------------------------------------------------------------------

    private openSocket(): void {
        const sock = this.socketFactory(this.url);
        sock.binaryType = 'arraybuffer';
        this.socket = sock;
        sock.onopen = () => {
            if (this.socket === sock) this.handleOpen();
        };
        sock.onmessage = (ev) => {
            if (this.socket === sock) this.handleMessage(ev.data);
        };
        sock.onerror = () => {
            if (this.socket === sock) this.handleError();
        };
        sock.onclose = () => {
            if (this.socket === sock) this.handleClose();
        };
    }

    private handleOpen(): void {
        const resolveConnect = this.connectResolve;
        this.connectResolve = null;
        this.connectReject = null;
        if (this.reconnectDeadlineTimer !== null) {
            this.timers.clearTimeout(this.reconnectDeadlineTimer);
            this.reconnectDeadlineTimer = null;
        }
        this.setConnState('connected');
        resolveConnect?.();
        // Resume any work that was waiting on the connection.
        this.flushControls();
        this.flushCommands();
    }

    private handleError(): void {
        // A failure before the connection was ever established rejects connect().
        if (this.connState === 'connecting' && this.connectReject) {
            const reject = this.connectReject;
            this.connectResolve = null;
            this.connectReject = null;
            this.setConnState('disconnected');
            reject(new WireError('disconnected', 'connection error before open'));
        }
        // Otherwise the subsequent close event drives reconnect handling.
    }

    private handleClose(): void {
        // Initial connect never succeeded -> reject the connect() promise.
        if (this.connState === 'connecting' && this.connectReject) {
            const reject = this.connectReject;
            this.connectResolve = null;
            this.connectReject = null;
            this.setConnState('disconnected');
            reject(
                new WireError('disconnected', 'connection closed before open'),
            );
            return;
        }

        if (this.deliberateClose) {
            this.setConnState('disconnected');
            return;
        }

        if (this.connState === 'reconnecting') {
            // A reconnect attempt's socket closed without opening; retry while
            // still inside the window (the deadline timer is the hard bound).
            this.timers.setTimeout(() => {
                if (this.connState === 'reconnecting') this.openSocket();
            }, this.reconnectRetryDelayMs);
            return;
        }

        // First unexpected close mid-session: open the reconnect window
        // (Req 7.5) and start trying to reconnect immediately.
        this.setConnState('reconnecting');
        this.reconnectDeadlineTimer = this.timers.setTimeout(
            () => this.onReconnectTimeout(),
            this.reconnectWindowMs,
        );
        this.openSocket();
    }

    private onReconnectTimeout(): void {
        this.reconnectDeadlineTimer = null;
        this.setConnState('disconnected');
        const err = new WireError(
            'connTimeout',
            `reconnect window of ${this.reconnectWindowMs} ms elapsed (Req 7.6)`,
        );
        this.emit('fault', {
            kind: 'connTimeout',
            message: err.message,
            axis: 0,
            detail: 0,
            seq: -1,
        });
        this.failAllPending(err);
        try {
            this.socket?.close();
        } catch {
            /* ignore */
        }
        this.socket = null;
    }

    // -------------------------------------------------------------------------
    // Outbound flushing
    // -------------------------------------------------------------------------

    private isOpen(): boolean {
        return this.socket !== null && this.socket.readyState === WS_OPEN;
    }

    private flushControls(): void {
        while (this.controlQueue.length > 0 && this.isOpen()) {
            const item = this.controlQueue.shift()!;
            this.socket!.send(item.frame);
            item.resolve({ seq: CONTROL_ACK_SEQ });
        }
    }

    /** Transmit queued commands while credits and an open socket remain. */
    private flushCommands(): void {
        while (
            this.sendQueue.length > 0 &&
            this.credits > 0 &&
            this.isOpen()
        ) {
            const cmd = this.sendQueue.shift()!;
            this.transmit(cmd);
            this.credits--;
            this.emit('flow', { credits: this.credits, delta: -1 });
        }
    }

    private transmit(cmd: OutboundCommand): void {
        this.socket!.send(encodeFrame(FrameType.CMD, cmd.payload));
        this.pendingAcks.set(cmd.seq, cmd);
    }

    private failAllPending(err: Error): void {
        for (const cmd of this.pendingAcks.values()) cmd.reject(err);
        this.pendingAcks.clear();
        const queued = this.sendQueue;
        this.sendQueue = [];
        for (const cmd of queued) cmd.reject(err);
        const controls = this.controlQueue;
        this.controlQueue = [];
        for (const c of controls) c.reject(err);
    }

    // -------------------------------------------------------------------------
    // Inbound frame dispatch
    // -------------------------------------------------------------------------

    private handleMessage(data: unknown): void {
        const bytes = toUint8Array(data);
        if (bytes === null) return; // ignore non-binary (string/blob) frames
        let decoded: { type: FrameType; payload: Uint8Array };
        try {
            decoded = decodeFrame(bytes);
        } catch {
            return; // malformed envelope -> drop
        }
        this.dispatch(decoded.type, decoded.payload);
    }

    private dispatch(type: FrameType, payload: Uint8Array): void {
        switch (type) {
            case FrameType.ACK:
                this.onAck(decodeAckPayload(payload).seq);
                break;
            case FrameType.NACK: {
                const { seq, reason } = decodeNackPayload(payload);
                this.onNack(seq, reason);
                break;
            }
            case FrameType.RETX_REQUEST:
                this.onRetxRequest(decodeRetxRequestPayload(payload).seq);
                break;
            case FrameType.CREDIT:
                this.onCredit(decodeCreditPayload(payload).n);
                break;
            case FrameType.STATE:
                this.emit('state', {
                    kind: 'controller',
                    controller: decodeStatePayload(payload).stateCode,
                });
                break;
            case FrameType.STATUS:
                this.onStatus(payload);
                break;
            case FrameType.PROGRESS:
                this.onProgress(payload);
                break;
            case FrameType.ERROR:
                this.onError(payload);
                break;
            case FrameType.HELLO:
                this.onHello(payload);
                break;
            // CMD / CTL are client -> controller only; ignore if echoed back.
            default:
                break;
        }
    }

    private onAck(seq: number): void {
        const cmd = this.pendingAcks.get(seq);
        if (!cmd) return; // unknown or already-resolved (idempotent) ACK
        this.pendingAcks.delete(seq);
        cmd.resolve({ seq });
    }

    private onNack(seq: number, reason: number): void {
        // Envelope-family NACK reasons mirror the firmware authority: surface
        // them as an `envelopeRequired` fault so the wizard can re-prompt the
        // outstanding calibration step (mirror of the `homeRequired` handling).
        if (
            reason === NACK_REASON_ENVELOPE_REQUIRED ||
            reason === NACK_REASON_ENVELOPE_HOME_NOT_SET ||
            reason === NACK_REASON_ENVELOPE_INVALID ||
            reason === NACK_REASON_JOG_TRAVEL_CAP
        ) {
            if (
                reason === NACK_REASON_ENVELOPE_REQUIRED ||
                reason === NACK_REASON_ENVELOPE_INVALID
            ) {
                this.envelopeCalibrated = false;
                // Genuine invalid-envelope case: re-close the send-gate so the
                // wizard re-prompts (the fault mirror is retained, Req 2.8).
                this.envelopeKnown = false;
            }
            this.emit('fault', {
                kind: 'envelopeRequired',
                message: `command ${seq} NACKed: envelope calibration required (reason ${reason})`,
                axis: 0,
                detail: reason,
                seq,
            });
        }

        const cmd = this.pendingAcks.get(seq);
        if (!cmd) return;
        this.pendingAcks.delete(seq);
        cmd.reject(
            new WireError('nack', `command ${seq} NACKed (reason ${reason})`, seq),
        );
    }

    private onRetxRequest(seq: number): void {
        const cmd = this.pendingAcks.get(seq);
        if (!cmd) return; // nothing outstanding for this seq

        cmd.retxCount++;
        if (cmd.retxCount > this.maxRetransmissions) {
            // The allowed retransmission attempts have been exhausted: the
            // command failed after MAX_RETRANSMISSIONS resends (Req 7.7).
            this.pendingAcks.delete(seq);
            const err = new WireError(
                'unrecoverableTx',
                `command ${seq} failed after ${this.maxRetransmissions} retransmissions (Req 7.7)`,
                seq,
            );
            cmd.reject(err);
            this.emit('fault', {
                kind: 'unrecoverableTx',
                message: err.message,
                axis: 0,
                detail: 0,
                seq,
            });
            return;
        }

        if (this.isOpen()) {
            this.socket!.send(encodeFrame(FrameType.CMD, cmd.payload));
        }
    }

    private onCredit(n: number): void {
        this.credits += n;
        this.emit('flow', { credits: this.credits, delta: n });
        this.flushCommands();
    }

    private onStatus(payload: Uint8Array): void {
        if (payload.length < 14) return;
        const view = viewOf(payload);
        const x = view.getInt32(0, true);
        const y = view.getInt32(4, true);
        const pctComplete = view.getUint8(8);
        const rssiDbm = view.getInt8(9);
        const stateCode = view.getUint8(12);
        const flags = view.getUint8(13);
        const calibrated = (flags & FLAG_CALIBRATED) !== 0;
        const envelopeCalibrated = (flags & FLAG_ENVELOPE_CALIBRATED) !== 0;
        const bufferFull = (flags & STATUS_FLAG_BUFFER_FULL) !== 0;

        this.calibrated = calibrated;
        this.envelopeCalibrated = envelopeCalibrated;
        // The effective-envelope send-gate opens when an envelope is known.
        // STATUS does not carry envelope dimensions, but a calibrated machine
        // necessarily has one; otherwise rely on HELLO to advertise the
        // effective (default) envelope and open the gate.
        if (envelopeCalibrated) this.envelopeKnown = true;
        this.emit('rssi', { rssiDbm });
        this.emit('state', {
            kind: 'status',
            controller: stateCode,
            position: { x, y },
            pctComplete,
            calibrated,
            envelopeCalibrated,
            bufferFull,
        });
    }

    private onProgress(payload: Uint8Array): void {
        if (payload.length < 8) return;
        const view = viewOf(payload);
        const doneSteps = view.getUint32(0, true);
        const totalSteps = view.getUint32(4, true);
        const pct =
            totalSteps > 0
                ? Math.round((doneSteps / totalSteps) * 100)
                : 0;
        this.emit('progress', { doneSteps, totalSteps, pct });
    }

    private onError(payload: Uint8Array): void {
        const { kind, axis, detail } = decodeErrorPayload(payload);
        switch (kind) {
            case ERROR_KIND_STALL:
                this.emit('stall', { axis, detail });
                break;
            case ERROR_KIND_FAULT:
                this.emit('fault', {
                    kind: 'fault',
                    message: `controller fault on axis ${axis}`,
                    axis,
                    detail,
                    seq: -1,
                });
                break;
            case ERROR_KIND_UNRECOVERABLE_TX: {
                const err = new WireError(
                    'unrecoverableTx',
                    'controller reported unrecoverable transmission error (Req 7.7)',
                );
                this.failAllPending(err);
                this.emit('fault', {
                    kind: 'unrecoverableTx',
                    message: err.message,
                    axis,
                    detail,
                    seq: -1,
                });
                break;
            }
            case ERROR_KIND_CONN_TIMEOUT:
                this.emit('fault', {
                    kind: 'connTimeout',
                    message: 'controller reported connection timeout (Req 7.6)',
                    axis,
                    detail,
                    seq: -1,
                });
                break;
            case ERROR_KIND_HOME_REQUIRED:
                this.calibrated = false;
                this.emit('fault', {
                    kind: 'homeRequired',
                    message: 'controller requires homing before drawing (Req 10.11)',
                    axis,
                    detail,
                    seq: -1,
                });
                break;
            case ERROR_KIND_ENVELOPE_REQUIRED:
                this.envelopeCalibrated = false;
                this.envelopeKnown = false;
                this.emit('fault', {
                    kind: 'envelopeRequired',
                    message:
                        'controller requires envelope calibration before drawing (Req 4.1, 5.1)',
                    axis,
                    detail,
                    seq: -1,
                });
                break;
            default:
                break;
        }
    }

    private onHello(payload: Uint8Array): void {
        // The envelope fields live at offsets 32/36, so a conformant HELLO is
        // now 40 bytes. Stay tolerant of a longer payload (forward-compat).
        if (payload.length < 40) return;
        const view = viewOf(payload);
        const firmwareVersion = view.getUint32(0, true);
        const x = view.getInt32(20, true);
        const y = view.getInt32(24, true);
        const flags = view.getUint8(28);
        const calibrated = (flags & FLAG_CALIBRATED) !== 0;
        const unclean = (flags & HELLO_FLAG_UNCLEAN) !== 0;
        const envelopeCalibrated = (flags & FLAG_ENVELOPE_CALIBRATED) !== 0;
        const envelopeX = view.getUint32(32, true);
        const envelopeY = view.getUint32(36, true);

        this.calibrated = calibrated;
        this.envelopeCalibrated = envelopeCalibrated;
        // HELLO is firmware-authoritative and advertises the EFFECTIVE envelope
        // (captured when calibrated, else the bounded DEFAULT_ENVELOPE). A
        // positive envelope opens the send-gate so an uncalibrated machine can
        // still draw within the default (Defect 2 fix, Req 2.5/2.8).
        this.envelopeKnown = envelopeX > 0 && envelopeY > 0;
        this.emit('home', {
            calibrated,
            unclean,
            position: { x, y },
            firmwareVersion,
            envelope: { x: envelopeX, y: envelopeY },
            envelopeCalibrated,
        });
    }

    // -------------------------------------------------------------------------
    // Event plumbing
    // -------------------------------------------------------------------------

    private setConnState(next: ConnectionState): void {
        if (this.connState === next) return;
        this.connState = next;
        this.emit('state', { kind: 'connection', connection: next });
    }

    private emit<E extends WireEvent>(event: E, payload: WireEventMap[E]): void {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of set) handler(payload);
    }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Build a DataView over a (possibly offset) Uint8Array. */
function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Normalise an inbound WebSocket payload to a Uint8Array, or null. */
function toUint8Array(data: unknown): Uint8Array | null {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
        );
    }
    return null;
}
