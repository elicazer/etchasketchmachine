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
    encodeStatePayload,
} from '../codec/frame';
import { CtlKind } from '../codec/control';
import { createController } from '../app/controller';
import { createStores } from '../app/stores';
import { validateSpeedPct } from '../validators';
import { SPEED_PCT_MAX, SPEED_PCT_MIN } from '../constants';

/**
 * End-to-end control-flow test (task 32.3, Req 9.1–9.8 at the wire/UI-state
 * level). The real {@link WireClient} + {@link createController}/
 * {@link createStores} are driven against a `FakeController` that plays the
 * firmware role, mirroring the SHARED-CONTRACT harness style of
 * `wire_e2e.test.ts` (task 31.1) but kept to its own file and scoped to the
 * drawing-execution control messages:
 *
 *   - `pause()`       → CTL PAUSE     → firmware STATE paused   → store 'paused'
 *   - `resume()`      → CTL RESUME    → firmware STATE drawing  → store 'drawing'
 *   - `cancel()`      → CTL CANCEL    → firmware STATE aborted  → store 'cancelled'
 *   - `setSpeedPct()` → CTL SPEED_PCT(pct) (validated integer)  → store updates
 *
 * The CTL payloads are decoded with the EXACT §4.6 byte layout the firmware
 * uses (mirroring `firmware/src/protocol/control_parser.cpp`), and the STATE
 * replies use the wire-stable controller-state codes the firmware
 * StatusReporter emits. The motion semantics behind these messages (pause
 * halts pulses, resume finishes the segment, cancel drains the buffer, speed
 * applies at the next segment boundary) are verified separately on the
 * firmware side in `firmware/tests/test_control_flow/test_control_flow.cpp`.
 *
 * @see Requirements 9.1–9.8 (drawing execution control)
 * @see Design §4.6 (CTL decode), §4.7 (STATE codes), §5.2 (drawing flow)
 */

// -----------------------------------------------------------------------------
// Wire-stable controller-state codes (Design §4.7; firmware StatusState).
// -----------------------------------------------------------------------------

const ST_IDLE = 0;
const ST_DRAWING = 1;
const ST_PAUSED = 2;
const ST_ABORTED = 5;

const URL = 'ws://device.local/ws';

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

// -----------------------------------------------------------------------------
// Decoded CTL message (mirrors firmware protocol::ControlMessage, §4.6).
// -----------------------------------------------------------------------------

type DecodedCtl =
    | { kind: 'pause' }
    | { kind: 'resume' }
    | { kind: 'cancel' }
    | { kind: 'stop' }
    | { kind: 'beginDraw'; totalSegments: number; totalSteps: number }
    | { kind: 'speedPct'; pct: number }
    | { kind: 'other'; code: number };

function requireLen(actual: number, expected: number): void {
    if (actual !== expected) {
        throw new Error(`CTL length ${actual}, expected ${expected}`);
    }
}

/**
 * Decode + validate a CTL payload exactly as `control_parser.cpp` does for the
 * kinds this task exercises: known kind, exact per-kind length, then per-kind
 * range checks. Throws on any violation (the firmware silently ignores
 * malformed CTL frames, so an out-of-range SPEED_PCT would never be applied).
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
            // §4.6 range check: the firmware rejects pct outside [25, 100].
            if (pct < SPEED_PCT_MIN || pct > SPEED_PCT_MAX) {
                throw new Error(`SPEED_PCT pct ${pct} out of range`);
            }
            return { kind: 'speedPct', pct };
        }
        default:
            return { kind: 'other', code: kind };
    }
}

// -----------------------------------------------------------------------------
// Loopback socket
// -----------------------------------------------------------------------------

/**
 * In-memory WebSocket whose client→controller direction is wired straight into
 * a {@link FakeController}. `open()` fires `onopen` and announces the new
 * session to the controller (which replies with HELLO).
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
// FakeController — the firmware role (control-flow subset)
// -----------------------------------------------------------------------------

class FakeController {
    readonly sockets: LoopbackSocket[] = [];

    /** Every decoded CTL message, in arrival order. */
    readonly controlLog: DecodedCtl[] = [];

    private active: LoopbackSocket | null = null;
    private readonly outbox: Uint8Array[] = [];
    private deliveryScheduled = false;
    private calibrated: boolean;

    constructor(opts: { calibrated?: boolean } = {}) {
        this.calibrated = opts.calibrated ?? true;
    }

    /** Socket factory passed to the WireClient under test. */
    readonly socketFactory = (_url: string): WireSocket => {
        const s = new LoopbackSocket(this);
        this.sockets.push(s);
        return s;
    };

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
        if (frame.type === FrameType.CTL) this.handleCtl(frame.payload);
        // This task drives only CTL frames; other types are ignored.
    }

    private handleCtl(payload: Uint8Array): void {
        let msg: DecodedCtl;
        try {
            msg = decodeControlPayload(payload);
        } catch {
            return; // malformed/out-of-range control message: ignore.
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
            case 'beginDraw':
                this.sendState(ST_DRAWING);
                break;
            case 'speedPct':
                // The firmware applies the live scaling to motion with no
                // mandatory frame reply (decoded + logged here).
                break;
            case 'other':
                break;
        }
    }

    /** Count CTL frames of a given kind in the decoded log. */
    countCtl(kind: DecodedCtl['kind']): number {
        return this.controlLog.filter((c) => c.kind === kind).length;
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

    /** Push a bare STATE frame (controller-state code). */
    sendState(stateCode: number): void {
        this.enqueue(FrameType.STATE, encodeStatePayload({ stateCode }));
    }

    /** Build + send the §4.8 HELLO frame (32-byte payload). */
    private sendHello(): void {
        const buf = new Uint8Array(32);
        const v = new DataView(buf.buffer);
        v.setUint32(0, 0x000100, true); // firmware version
        v.setUint16(4, 1000, true); // max_sps
        v.setUint16(6, 0, true); // reserved
        v.setUint16(8, 0, true); // backlash x
        v.setUint16(10, 0, true); // backlash y
        v.setFloat32(12, 100, true); // mm_per_rev x
        v.setFloat32(16, 100, true); // mm_per_rev y
        v.setInt32(20, 0, true); // pos x
        v.setInt32(24, 0, true); // pos y
        v.setUint8(28, this.calibrated ? 0x01 : 0x00); // flags
        v.setUint8(29, 0); // reserved
        v.setUint16(30, 32, true); // buffer_capacity
        this.enqueue(FrameType.HELLO, buf);
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

/**
 * Build a wired controller (real WireClient + stores) connected to a fresh
 * FakeController, with the HELLO handshake settled.
 */
async function connectApp(opts: { calibrated?: boolean } = {}): Promise<{
    fw: FakeController;
    stores: ReturnType<typeof createStores>;
    app: ReturnType<typeof createController>;
}> {
    const fw = new FakeController(opts);
    const stores = createStores();
    const client = makeClient(fw);
    const app = createController({ url: URL, stores, client });

    const p = app.connect();
    fw.sockets[0]!.open();
    await p;
    await settle();
    return { fw, stores, app };
}

/**
 * Mirror `DrawingControls.handleSpeed`: validate the raw slider value through
 * `validateSpeedPct` and only forward accepted values to the controller. This
 * is the layer where out-of-range / non-integer speeds are filtered before any
 * SPEED_PCT frame is produced (Req 9.7).
 */
function uiSetSpeed(
    app: ReturnType<typeof createController>,
    raw: number,
): boolean {
    const v = validateSpeedPct(raw);
    if (v.ok) {
        app.setSpeedPct(v.value);
        return true;
    }
    return false;
}

// =============================================================================
// Tests
// =============================================================================

describe('e2e control flow: pause / resume / cancel map to CTL + STATE (Req 9.1–9.6)', () => {
    it('pause() sends CTL PAUSE and the STATE paused reply sets drawingState "paused"', async () => {
        const { fw, stores, app } = await connectApp();

        // Put the UI into the drawing state, as it would be mid-drawing.
        fw.sendState(ST_DRAWING);
        await settle();
        expect(stores.drawingState.value).toBe('drawing');

        app.pause();
        await settle();

        expect(fw.countCtl('pause')).toBe(1);
        expect(fw.controlLog.at(-1)).toEqual({ kind: 'pause' });
        // Req 9.2: the firmware reports paused; the store reflects it.
        expect(stores.drawingState.value).toBe('paused');
    });

    it('resume() sends CTL RESUME and the STATE drawing reply sets drawingState "drawing"', async () => {
        const { fw, stores, app } = await connectApp();

        fw.sendState(ST_PAUSED);
        await settle();
        expect(stores.drawingState.value).toBe('paused');

        app.resume();
        await settle();

        expect(fw.countCtl('resume')).toBe(1);
        expect(fw.controlLog.at(-1)).toEqual({ kind: 'resume' });
        // Req 9.4: resume continues drawing; the store flips back to 'drawing'.
        expect(stores.drawingState.value).toBe('drawing');
    });

    it('cancel() sends CTL CANCEL, the store reads "cancelled", and the STATE aborted reply does not override it', async () => {
        const { fw, stores, app } = await connectApp();

        fw.sendState(ST_DRAWING);
        await settle();
        expect(stores.drawingState.value).toBe('drawing');

        app.cancel();
        // Req 9.6: the UI returns to a stopped/cancelled state immediately.
        expect(stores.drawingState.value).toBe('cancelled');

        await settle();
        expect(fw.countCtl('cancel')).toBe(1);
        expect(fw.controlLog.at(-1)).toEqual({ kind: 'cancel' });
        // The firmware's STATE aborted (code 5) is not a UI execution state,
        // so it leaves the optimistic 'cancelled' in place (Req 9.5, 9.6).
        expect(stores.drawingState.value).toBe('cancelled');
    });

    it('drives the full pause → resume → cancel sequence with the expected CTL order', async () => {
        const { fw, stores, app } = await connectApp();

        fw.sendState(ST_DRAWING);
        await settle();

        app.pause();
        await settle();
        expect(stores.drawingState.value).toBe('paused');

        app.resume();
        await settle();
        expect(stores.drawingState.value).toBe('drawing');

        app.cancel();
        await settle();
        expect(stores.drawingState.value).toBe('cancelled');

        expect(fw.controlLog.map((c) => c.kind)).toEqual([
            'pause',
            'resume',
            'cancel',
        ]);
    });
});

describe('e2e control flow: speed adjustment maps to CTL SPEED_PCT (Req 9.7, 9.8)', () => {
    it('setSpeedPct(pct) sends SPEED_PCT with the validated integer and updates the speedPct store', async () => {
        const { fw, stores, app } = await connectApp();

        expect(uiSetSpeed(app, 60)).toBe(true);
        await settle();

        expect(stores.speedPct.value).toBe(60);
        expect(fw.countCtl('speedPct')).toBe(1);
        expect(fw.controlLog.at(-1)).toEqual({ kind: 'speedPct', pct: 60 });
    });

    it('accepts the 25% and 100% bounds and forwards each as a SPEED_PCT frame', async () => {
        const { fw, stores, app } = await connectApp();

        expect(uiSetSpeed(app, SPEED_PCT_MIN)).toBe(true);
        await settle();
        expect(stores.speedPct.value).toBe(SPEED_PCT_MIN);

        expect(uiSetSpeed(app, SPEED_PCT_MAX)).toBe(true);
        await settle();
        expect(stores.speedPct.value).toBe(SPEED_PCT_MAX);

        const speedFrames = fw.controlLog.filter((c) => c.kind === 'speedPct');
        expect(speedFrames).toEqual([
            { kind: 'speedPct', pct: SPEED_PCT_MIN },
            { kind: 'speedPct', pct: SPEED_PCT_MAX },
        ]);
    });

    it('does not send SPEED_PCT for out-of-range or non-integer values, and leaves the store unchanged', async () => {
        const { fw, stores, app } = await connectApp();

        const before = stores.speedPct.value;

        // Below the lower bound, above the upper bound, and fractional: each is
        // rejected at the validateSpeedPct layer before any frame is built.
        expect(uiSetSpeed(app, SPEED_PCT_MIN - 1)).toBe(false);
        expect(uiSetSpeed(app, SPEED_PCT_MAX + 1)).toBe(false);
        expect(uiSetSpeed(app, 50.5)).toBe(false);
        expect(uiSetSpeed(app, Number.NaN)).toBe(false);
        await settle();

        expect(fw.countCtl('speedPct')).toBe(0);
        expect(stores.speedPct.value).toBe(before);
    });

    it('forwards only the valid values from a mixed sequence of slider inputs', async () => {
        const { fw, stores, app } = await connectApp();

        const raws = [40, 24, 75, 101, 88, 12.5, 100];
        for (const r of raws) uiSetSpeed(app, r);
        await settle();

        // 40, 75, 88, 100 are valid; 24, 101, 12.5 are filtered out.
        const sent = fw.controlLog
            .filter((c): c is { kind: 'speedPct'; pct: number } => c.kind === 'speedPct')
            .map((c) => c.pct);
        expect(sent).toEqual([40, 75, 88, 100]);
        // The store holds the last accepted value.
        expect(stores.speedPct.value).toBe(100);
    });
});
