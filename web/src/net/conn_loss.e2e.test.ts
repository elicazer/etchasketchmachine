import { describe, it, expect } from 'vitest';
import {
    WireClient,
    WireError,
    type WireSocket,
    type TimerApi,
    type FaultEvent,
} from './wire_client';
import {
    FrameType,
    encodeFrame,
    decodeFrame,
    encodeAckPayload,
    encodeCreditPayload,
} from '../codec/frame';
import { createController } from '../app/controller';
import { createStores } from '../app/stores';
import { RECONNECT_WINDOW_MS } from '../constants';
import type { DrawingCommand } from '../types';

/**
 * Connection loss & recovery flow, end to end (task 32.2, Design §5.6,
 * Requirements 7.5, 7.6).
 *
 * PlatformIO is not installed and there is no real device, so this drives the
 * REAL {@link WireClient} (and, for the store-mapping checks, the real
 * {@link createController}/{@link createStores}) against an in-memory
 * {@link FakeSocket} and an injectable {@link FakeClock}. The 60-second
 * reconnect window is therefore exercised deterministically: the fake clock
 * captures every scheduled callback so the window deadline can be fired by hand
 * instead of waiting on wall-clock time.
 *
 * The WireClient is the SPA half of the §5.6 sequence diagram. When the single
 * binary WebSocket drops unexpectedly mid-session it:
 *
 *   1. moves to `reconnecting` and opens the 60 s reconnect window (Req 7.5);
 *   2. retains pending commands (they are NOT rejected by the drop) and, on a
 *      reconnect inside the window, returns to `connected` with no
 *      CONN_TIMEOUT fault, letting those commands complete (Req 7.5);
 *   3. when the window deadline elapses with no reconnect, moves to
 *      `disconnected`, emits a `fault` of kind `connTimeout`, and rejects every
 *      pending command with a {@link WireError} of kind `connTimeout` (Req 7.6).
 *
 * The firmware half of this same flow (the §5.6 pause-retain → resume vs
 * abort-after-timeout state machine, `app::ConnectionMonitor`) is verified on
 * the firmware side in `firmware/tests/test_conn_loss/test_conn_loss.cpp`.
 *
 * The fake socket / fake clock doubles mirror the ones in `wire_client.test.ts`
 * (kept here, in this task's own file, so editing that suite is unnecessary).
 *
 * @see Requirements 7.5 (WS loss mid-drawing: pause + retain, resume ≤ 60 s),
 *      7.6 (60 s exceeded: abort, report CONN_TIMEOUT)
 * @see Design §5.6 (connection-loss sequence), §6.2 (WiFi-loss recovery table)
 */

// -----------------------------------------------------------------------------
// Test doubles (mirrors wire_client.test.ts)
// -----------------------------------------------------------------------------

const WS_OPEN = 1;
const WS_CLOSED = 3;

const URL = 'ws://device.local/ws';

/** Fake WebSocket capturing sent frames and exposing event triggers. */
class FakeSocket implements WireSocket {
    binaryType: 'blob' | 'arraybuffer' = 'blob';
    readyState = 0; // CONNECTING
    sent: Uint8Array[] = [];
    closed = false;

    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;

    send(data: ArrayBufferView | ArrayBufferLike): void {
        if (data instanceof Uint8Array) {
            this.sent.push(new Uint8Array(data));
        } else if (ArrayBuffer.isView(data)) {
            this.sent.push(new Uint8Array(data.buffer.slice(0) as ArrayBuffer));
        } else {
            this.sent.push(new Uint8Array(data as ArrayBuffer));
        }
    }

    close(): void {
        this.closed = true;
        this.readyState = WS_CLOSED;
    }

    // ---- test triggers -----------------------------------------------------
    fireOpen(): void {
        this.readyState = WS_OPEN;
        this.onopen?.({});
    }

    fireMessage(bytes: Uint8Array): void {
        this.onmessage?.({ data: bytes });
    }

    fireClose(): void {
        this.readyState = WS_CLOSED;
        this.onclose?.({});
    }
}

/** Deterministic clock implementing the {@link TimerApi} seam. */
class FakeClock implements TimerApi {
    private now = 0;
    private nextId = 1;
    private timers: { id: number; fireAt: number; handler: () => void }[] = [];

    setTimeout(handler: () => void, ms: number): number {
        const id = this.nextId++;
        this.timers.push({ id, fireAt: this.now + ms, handler });
        return id;
    }

    clearTimeout(handle: number): void {
        this.timers = this.timers.filter((t) => t.id !== handle);
    }

    /** Advance virtual time, firing due timers in chronological order. */
    advance(ms: number): void {
        const target = this.now + ms;
        for (; ;) {
            const due = this.timers
                .filter((t) => t.fireAt <= target)
                .sort((a, b) => a.fireAt - b.fireAt);
            if (due.length === 0) break;
            const t = due[0];
            this.timers = this.timers.filter((x) => x.id !== t.id);
            this.now = t.fireAt;
            t.handler();
        }
        this.now = target;
    }
}

// -----------------------------------------------------------------------------
// Harnesses
// -----------------------------------------------------------------------------

interface Harness {
    client: WireClient;
    clock: FakeClock;
    sockets: FakeSocket[];
}

function makeHarness(opts: { reconnectWindowMs?: number } = {}): Harness {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock();
    const client = new WireClient({
        socketFactory: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
        timers: clock,
        reconnectWindowMs: opts.reconnectWindowMs ?? RECONNECT_WINDOW_MS,
    });
    return { client, clock, sockets };
}

interface AppHarness extends Harness {
    app: ReturnType<typeof createController>;
    stores: ReturnType<typeof createStores>;
}

/** A harness whose WireClient is wired through the real controller + stores. */
function makeAppHarness(opts: { reconnectWindowMs?: number } = {}): AppHarness {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock();
    const client = new WireClient({
        socketFactory: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
        timers: clock,
        reconnectWindowMs: opts.reconnectWindowMs ?? RECONNECT_WINDOW_MS,
    });
    const stores = createStores();
    const app = createController({ url: URL, stores, client });
    return { client, clock, sockets, app, stores };
}

/** Connect a harness and resolve once the (first) fake socket opens. */
async function connectOpen(h: Harness): Promise<void> {
    const p = h.client.connect(URL);
    h.sockets[0].fireOpen();
    await p;
}

/** Drain pending microtasks so promise `.then`/`.catch` callbacks run. */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function baseCommand(): DrawingCommand {
    return { seq: 0, dxSteps: 10, dySteps: -5, feedSps: 400, flags: 0 };
}

/** Count the CMD frames a fake socket has transmitted. */
function countCmdFrames(socket: FakeSocket): number {
    let n = 0;
    for (const f of socket.sent) {
        try {
            if (decodeFrame(f).type === FrameType.CMD) n++;
        } catch {
            /* ignore */
        }
    }
    return n;
}

/** Track a promise's settle state without awaiting it. */
function trackSettle<T>(p: Promise<T>): { settled: () => boolean; rejected: () => unknown } {
    let done = false;
    let rejection: unknown = null;
    p.then(
        () => {
            done = true;
        },
        (err: unknown) => {
            done = true;
            rejection = err;
        },
    );
    return { settled: () => done, rejected: () => rejection };
}

// =============================================================================
// Req 7.5 — pause/retain on drop, resume within the 60 s reconnect window
// =============================================================================

describe('conn loss (Req 7.5): reconnect window opens on an unexpected drop', () => {
    it('moves to "reconnecting" and opens a fresh socket on an unexpected mid-session close', async () => {
        const h = makeHarness();
        await connectOpen(h);
        expect(h.client.state()).toBe('connected');

        // An unexpected close mid-session opens the reconnect window: the
        // client enters 'reconnecting' and immediately tries a new socket.
        h.sockets[0].fireClose();

        expect(h.client.state()).toBe('reconnecting');
        expect(h.sockets).toHaveLength(2);
    });

    it('restores "connected" without a connTimeout fault when a reconnect lands inside the window', async () => {
        const h = makeHarness({ reconnectWindowMs: 60_000 });
        await connectOpen(h);

        const faults: FaultEvent[] = [];
        h.client.on('fault', (e) => faults.push(e));

        h.sockets[0].fireClose();
        expect(h.client.state()).toBe('reconnecting');

        // Reconnect comfortably inside the 60 s window.
        h.clock.advance(10_000);
        h.sockets[1].fireOpen();

        expect(h.client.state()).toBe('connected');
        // No abort fired: the window timer was cleared by the reconnect.
        expect(faults).toHaveLength(0);

        // The deadline can no longer fire — advancing past 60 s is a no-op now.
        h.clock.advance(60_000);
        expect(h.client.state()).toBe('connected');
        expect(faults).toHaveLength(0);
    });

    it('retains a pending command across the drop (not rejected) and completes it on reconnect inside the window', async () => {
        const h = makeHarness({ reconnectWindowMs: 60_000 });
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);

        // Grant a credit and send a command so it is transmitted and now
        // awaiting an ACK (the representative "pending" command).
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );
        const ackP = h.client.sendCommand(baseCommand());
        const track = trackSettle(ackP);
        expect(countCmdFrames(h.sockets[0])).toBe(1);

        // Unexpected mid-session drop while the command is in flight.
        h.sockets[0].fireClose();
        expect(h.client.state()).toBe('reconnecting');

        // Req 7.5: the drop does NOT reject the pending command.
        await flushMicrotasks();
        expect(track.settled()).toBe(false);

        // Reconnect inside the window, then the controller ACKs the still
        // pending command on the new socket — it now completes.
        h.clock.advance(5_000);
        h.sockets[1].fireOpen();
        expect(h.client.state()).toBe('connected');

        h.sockets[1].fireMessage(
            encodeFrame(FrameType.ACK, encodeAckPayload({ seq: 0 })),
        );
        await expect(ackP).resolves.toEqual({ seq: 0 });
    });

    it('retains a credit-queued command across the drop and transmits it after reconnect', async () => {
        const h = makeHarness({ reconnectWindowMs: 60_000 });
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);

        // No credits yet -> the command sits queued, never transmitted.
        const ackP = h.client.sendCommand(baseCommand());
        const track = trackSettle(ackP);
        expect(countCmdFrames(h.sockets[0])).toBe(0);

        // Drop and reconnect within the window; the queued command survives.
        h.sockets[0].fireClose();
        expect(h.client.state()).toBe('reconnecting');
        h.clock.advance(2_000);
        h.sockets[1].fireOpen();
        expect(h.client.state()).toBe('connected');

        await flushMicrotasks();
        expect(track.settled()).toBe(false);

        // A credit on the reconnected socket releases the retained command,
        // which then transmits and is ACKed.
        h.sockets[1].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );
        expect(countCmdFrames(h.sockets[1])).toBe(1);
        h.sockets[1].fireMessage(
            encodeFrame(FrameType.ACK, encodeAckPayload({ seq: 0 })),
        );
        await expect(ackP).resolves.toEqual({ seq: 0 });
    });
});

// =============================================================================
// Req 7.6 — abort + CONN_TIMEOUT when the window elapses
// =============================================================================

describe('conn loss (Req 7.6): window elapsing aborts with a connTimeout fault', () => {
    it('transitions to "disconnected" and emits a connTimeout fault when the deadline fires', async () => {
        const h = makeHarness({ reconnectWindowMs: 60_000 });
        await connectOpen(h);

        const faults: FaultEvent[] = [];
        h.client.on('fault', (e) => faults.push(e));

        h.sockets[0].fireClose();
        expect(h.client.state()).toBe('reconnecting');

        // The replacement socket never opens; fire the window deadline timer.
        h.clock.advance(60_000);

        expect(h.client.state()).toBe('disconnected');
        expect(faults).toHaveLength(1);
        expect(faults[0].kind).toBe('connTimeout');
    });

    it('rejects every pending command with a WireError of kind connTimeout', async () => {
        const h = makeHarness({ reconnectWindowMs: 60_000 });
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);

        // One transmitted-awaiting-ACK command and one credit-queued command:
        // both are "pending" and must be rejected when the window elapses.
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );
        const transmitted = h.client.sendCommand(baseCommand());
        const queued = h.client.sendCommand(baseCommand());
        const caughtTransmitted = transmitted.catch((e: unknown) => e);
        const caughtQueued = queued.catch((e: unknown) => e);

        h.sockets[0].fireClose();
        expect(h.client.state()).toBe('reconnecting');

        // Let the full 60 s window elapse with no reconnect.
        h.clock.advance(60_000);
        expect(h.client.state()).toBe('disconnected');

        const errT = (await caughtTransmitted) as WireError;
        const errQ = (await caughtQueued) as WireError;
        expect(errT).toBeInstanceOf(WireError);
        expect(errT.kind).toBe('connTimeout');
        expect(errQ).toBeInstanceOf(WireError);
        expect(errQ.kind).toBe('connTimeout');
    });

    it('keeps waiting one tick before the deadline and only aborts at the deadline', async () => {
        const h = makeHarness({ reconnectWindowMs: 60_000 });
        await connectOpen(h);

        const faults: FaultEvent[] = [];
        h.client.on('fault', (e) => faults.push(e));

        h.sockets[0].fireClose();

        // Just shy of the deadline: still reconnecting, no fault.
        h.clock.advance(59_999);
        expect(h.client.state()).toBe('reconnecting');
        expect(faults).toHaveLength(0);

        // Crossing the deadline aborts.
        h.clock.advance(1);
        expect(h.client.state()).toBe('disconnected');
        expect(faults).toHaveLength(1);
        expect(faults[0].kind).toBe('connTimeout');
    });
});

// =============================================================================
// Controller-store mapping (createController / createStores)
// =============================================================================

describe('conn loss store mapping: connection + fault stores follow the flow', () => {
    it('connection store reflects connecting → connected → disconnected', async () => {
        const { app, stores, sockets } = makeAppHarness();

        // Fresh stores start disconnected.
        expect(stores.connection.value).toBe('disconnected');

        const p = app.connect();
        // connect() emits 'connecting' synchronously before the socket opens.
        expect(stores.connection.value).toBe('connecting');

        sockets[0].fireOpen();
        await p;
        expect(stores.connection.value).toBe('connected');

        // A deliberate disconnect drives the store back to 'disconnected'.
        app.disconnect();
        expect(stores.connection.value).toBe('disconnected');
    });

    it('an unexpected drop reads as "connecting" while reconnecting', async () => {
        const { app, stores, sockets } = makeAppHarness({ reconnectWindowMs: 60_000 });
        const p = app.connect();
        sockets[0].fireOpen();
        await p;
        expect(stores.connection.value).toBe('connected');

        // 'reconnecting' collapses onto the UI's 'connecting' status (Req 12.1).
        sockets[0].fireClose();
        expect(stores.connection.value).toBe('connecting');
    });

    it('a connTimeout fault lights the fault store and the connection reads disconnected', async () => {
        const { app, stores, clock, sockets } = makeAppHarness({
            reconnectWindowMs: 60_000,
        });
        const p = app.connect();
        sockets[0].fireOpen();
        await p;

        // Sanity: no fault before the timeout.
        expect(stores.fault.value.active).toBe(false);

        sockets[0].fireClose();
        expect(stores.connection.value).toBe('connecting'); // reconnecting

        // Let the window elapse: the WireClient emits a connTimeout fault.
        clock.advance(60_000);

        expect(stores.fault.value.active).toBe(true);
        expect(stores.drawingState.value).toBe('error');
        expect(stores.connection.value).toBe('disconnected');
    });

    it('does not light the fault store when the reconnect succeeds in time', async () => {
        const { app, stores, clock, sockets } = makeAppHarness({
            reconnectWindowMs: 60_000,
        });
        const p = app.connect();
        sockets[0].fireOpen();
        await p;

        sockets[0].fireClose();
        clock.advance(5_000);
        sockets[1].fireOpen();

        expect(stores.connection.value).toBe('connected');
        expect(stores.fault.value.active).toBe(false);
    });
});
