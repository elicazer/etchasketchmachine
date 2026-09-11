import { describe, it, expect, beforeEach } from 'vitest';
import {
    WireClient,
    WireError,
    CONTROL_ACK_SEQ,
    type WireSocket,
    type TimerApi,
    type FaultEvent,
    type StallEvent,
    type RssiEvent,
    type ProgressEvent,
    type FlowEvent,
    type HomeEvent,
    type StateEvent,
} from './wire_client';
import {
    FrameType,
    encodeFrame,
    encodeAckPayload,
    encodeNackPayload,
    encodeCreditPayload,
    encodeRetxRequestPayload,
    encodeStatePayload,
    encodeErrorPayload,
    decodeFrame,
} from '../codec/frame';
import { decodeCommand } from '../codec/drawing_command';
import type { DrawingCommand } from '../types';

/**
 * Unit tests for {@link WireClient} (Design §3.1.5).
 *
 * Everything runs against an in-memory fake WebSocket and a fake clock so the
 * sequence-counter, CRC attachment, retransmission, credit flow-control,
 * calibration send-gate, reconnect-window, and telemetry-event behaviours are
 * exercised deterministically with no real socket or wall-clock.
 */

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

const WS_OPEN = 1;
const WS_CLOSED = 3;

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
            this.sent.push(
                new Uint8Array(data.buffer.slice(0) as ArrayBuffer),
            );
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

    fireError(): void {
        this.onerror?.({});
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

interface Harness {
    client: WireClient;
    clock: FakeClock;
    sockets: FakeSocket[];
}

function makeHarness(
    opts: { reconnectWindowMs?: number; maxRetransmissions?: number } = {},
): Harness {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock();
    const client = new WireClient({
        socketFactory: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
        timers: clock,
        ...opts,
    });
    return { client, clock, sockets };
}

/** Connect a harness and resolve once the (first) fake socket opens. */
async function connectOpen(h: Harness, url = 'ws://device.local/ws'): Promise<void> {
    const p = h.client.connect(url);
    h.sockets[0].fireOpen();
    await p;
}

function baseCommand(): DrawingCommand {
    return { seq: 0, dxSteps: 10, dySteps: -5, feedSps: 400, flags: 0 };
}

/** Build a §4.7 STATUS payload (16 bytes). */
function statusPayload(opts: {
    x: number;
    y: number;
    pct: number;
    rssi: number;
    activeSps: number;
    stateCode: number;
    flags: number;
}): Uint8Array {
    const buf = new Uint8Array(16);
    const v = new DataView(buf.buffer);
    v.setInt32(0, opts.x, true);
    v.setInt32(4, opts.y, true);
    v.setUint8(8, opts.pct);
    v.setInt8(9, opts.rssi);
    v.setUint16(10, opts.activeSps, true);
    v.setUint8(12, opts.stateCode);
    v.setUint8(13, opts.flags);
    return buf;
}

/** Build a §4.5 PROGRESS payload (8 bytes). */
function progressPayload(done: number, total: number): Uint8Array {
    const buf = new Uint8Array(8);
    const v = new DataView(buf.buffer);
    v.setUint32(0, done, true);
    v.setUint32(4, total, true);
    return buf;
}

/** Build a §4.8 HELLO payload (40 bytes — extended with envelope fields). */
function helloPayload(opts: {
    firmwareVersion: number;
    x: number;
    y: number;
    flags: number;
    envelopeX?: number;
    envelopeY?: number;
}): Uint8Array {
    const buf = new Uint8Array(40);
    const v = new DataView(buf.buffer);
    v.setUint32(0, opts.firmwareVersion, true);
    v.setUint16(4, 1000, true); // max_sps
    v.setInt32(20, opts.x, true);
    v.setInt32(24, opts.y, true);
    v.setUint8(28, opts.flags);
    v.setUint16(30, 32, true); // buffer_capacity
    v.setUint32(32, opts.envelopeX ?? 0, true); // envelope_x_steps
    v.setUint32(36, opts.envelopeY ?? 0, true); // envelope_y_steps
    return buf;
}

/** Decode the i-th CMD frame the client has sent into a DrawingCommand. */
function decodeSentCommand(socket: FakeSocket, index: number): DrawingCommand {
    const cmdFrames = socket.sent.filter((f) => {
        try {
            return decodeFrame(f).type === FrameType.CMD;
        } catch {
            return false;
        }
    });
    const { payload } = decodeFrame(cmdFrames[index]);
    return decodeCommand(payload);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('WireClient connection lifecycle', () => {
    it('sets binaryType to arraybuffer and resolves connect() on open', async () => {
        const h = makeHarness();
        const p = h.client.connect('ws://device.local/ws');
        expect(h.sockets).toHaveLength(1);
        expect(h.sockets[0].binaryType).toBe('arraybuffer');
        expect(h.client.state()).toBe('connecting');
        h.sockets[0].fireOpen();
        await expect(p).resolves.toBeUndefined();
        expect(h.client.state()).toBe('connected');
    });

    it('emits connection state-change events', async () => {
        const h = makeHarness();
        const states: string[] = [];
        h.client.on('state', (e: StateEvent) => {
            if (e.kind === 'connection') states.push(e.connection);
        });
        await connectOpen(h);
        expect(states).toEqual(['connecting', 'connected']);
    });

    it('rejects connect() when the socket closes before opening', async () => {
        const h = makeHarness();
        const p = h.client.connect('ws://device.local/ws');
        h.sockets[0].fireClose();
        await expect(p).rejects.toBeInstanceOf(WireError);
        expect(h.client.state()).toBe('disconnected');
    });
});

describe('sequence numbers and CRC attachment', () => {
    it('assigns a monotonic sequence number per command', async () => {
        const h = makeHarness();
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);
        // Seed plenty of credits so every command transmits immediately.
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 10 })),
        );

        void h.client.sendCommand(baseCommand());
        void h.client.sendCommand(baseCommand());
        void h.client.sendCommand(baseCommand());

        expect(decodeSentCommand(h.sockets[0], 0).seq).toBe(0);
        expect(decodeSentCommand(h.sockets[0], 1).seq).toBe(1);
        expect(decodeSentCommand(h.sockets[0], 2).seq).toBe(2);
    });

    it('attaches a valid CRC that decodeCommand accepts and round-trips fields', async () => {
        const h = makeHarness();
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );

        void h.client.sendCommand({
            seq: 999, // overwritten by the client's own counter
            dxSteps: 123,
            dySteps: -77,
            feedSps: 650,
            flags: 0,
        });

        // decodeCommand throws on a bad CRC, so a successful decode proves the
        // CRC was attached correctly.
        const decoded = decodeSentCommand(h.sockets[0], 0);
        expect(decoded.seq).toBe(0);
        expect(decoded.dxSteps).toBe(123);
        expect(decoded.dySteps).toBe(-77);
        expect(decoded.feedSps).toBe(650);
        expect(typeof decoded.crc16).toBe('number');
    });
});

describe('envelope send-gate (Req 4.1, 5.1)', () => {
    it('rejects sendCommand while not envelope-calibrated, succeeds after setEnvelopeCalibrated(true)', async () => {
        const h = makeHarness();
        await connectOpen(h);

        await expect(h.client.sendCommand(baseCommand())).rejects.toMatchObject(
            { kind: 'notCalibrated' },
        );
        // Nothing was transmitted.
        expect(h.sockets[0].sent).toHaveLength(0);

        h.client.setEnvelopeCalibrated(true);
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );
        const ackP = h.client.sendCommand(baseCommand());
        // Command transmitted; resolve it with an ACK.
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.ACK, encodeAckPayload({ seq: 0 })),
        );
        await expect(ackP).resolves.toEqual({ seq: 0 });
    });

    it('blocks BEGIN_DRAW while not envelope-calibrated but allows other control messages', async () => {
        const h = makeHarness();
        await connectOpen(h);

        await expect(
            h.client.sendControl({
                kind: 'beginDraw',
                totalSegments: 5,
                totalSteps: 100,
            }),
        ).rejects.toMatchObject({ kind: 'notCalibrated' });

        // A non-draw control still goes through.
        await expect(h.client.sendControl({ kind: 'pause' })).resolves.toEqual({
            seq: CONTROL_ACK_SEQ,
        });

        h.client.setEnvelopeCalibrated(true);
        await expect(
            h.client.sendControl({
                kind: 'beginDraw',
                totalSegments: 5,
                totalSteps: 100,
            }),
        ).resolves.toEqual({ seq: CONTROL_ACK_SEQ });
    });
});

describe('credit-based flow control', () => {
    it('defers sends with no credits and releases them on CREDIT frames', async () => {
        const h = makeHarness();
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);

        const flow: FlowEvent[] = [];
        h.client.on('flow', (e: FlowEvent) => flow.push(e));

        // No credits yet -> command is queued, not transmitted.
        void h.client.sendCommand(baseCommand());
        expect(h.sockets[0].sent).toHaveLength(0);

        // CREDIT releases exactly one queued command.
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );
        expect(h.sockets[0].sent).toHaveLength(1);
        expect(h.client.creditCount()).toBe(0);

        // flow events: +1 on credit grant, -1 on consume.
        expect(flow.map((f) => f.delta)).toEqual([1, -1]);
        expect(flow[flow.length - 1].credits).toBe(0);
    });

    it('only transmits as many commands as there are credits', async () => {
        const h = makeHarness();
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);

        void h.client.sendCommand(baseCommand());
        void h.client.sendCommand(baseCommand());
        void h.client.sendCommand(baseCommand());
        expect(h.sockets[0].sent).toHaveLength(0);

        // Grant 2 credits -> exactly 2 of the 3 queued commands transmit.
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 2 })),
        );
        expect(h.sockets[0].sent).toHaveLength(2);
        expect(h.client.creditCount()).toBe(0);

        // One more credit releases the last one.
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );
        expect(h.sockets[0].sent).toHaveLength(3);
    });
});

describe('retransmission (Req 7.3, 7.7)', () => {
    it('resends the command on RETX_REQUEST', async () => {
        const h = makeHarness();
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );

        void h.client.sendCommand(baseCommand());
        expect(h.sockets[0].sent).toHaveLength(1);

        h.sockets[0].fireMessage(
            encodeFrame(FrameType.RETX_REQUEST, encodeRetxRequestPayload({ seq: 0 })),
        );
        // One retransmission of the same command (no extra credit consumed).
        expect(h.sockets[0].sent).toHaveLength(2);
        expect(decodeSentCommand(h.sockets[0], 1).seq).toBe(0);
        expect(h.client.creditCount()).toBe(0);
    });

    it('surfaces an unrecoverable error after retransmissions are exhausted', async () => {
        const h = makeHarness({ maxRetransmissions: 3 });
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );

        const faults: FaultEvent[] = [];
        h.client.on('fault', (e: FaultEvent) => faults.push(e));

        const promise = h.client.sendCommand(baseCommand());
        const caught = promise.catch((e: unknown) => e);

        const retx = encodeFrame(
            FrameType.RETX_REQUEST,
            encodeRetxRequestPayload({ seq: 0 }),
        );
        // 3 RETX requests -> 3 resends (attempts within the limit).
        h.sockets[0].fireMessage(retx);
        h.sockets[0].fireMessage(retx);
        h.sockets[0].fireMessage(retx);
        const cmdFramesAfter3 = h.sockets[0].sent.length;
        // 4th RETX exceeds MAX_RETRANSMISSIONS -> unrecoverable.
        h.sockets[0].fireMessage(retx);

        const err = (await caught) as WireError;
        expect(err).toBeInstanceOf(WireError);
        expect(err.kind).toBe('unrecoverableTx');
        expect(err.seq).toBe(0);

        // No further resend happened on the failing request.
        expect(h.sockets[0].sent).toHaveLength(cmdFramesAfter3);
        // 1 original + 3 retransmissions.
        expect(cmdFramesAfter3).toBe(4);

        expect(faults).toHaveLength(1);
        expect(faults[0].kind).toBe('unrecoverableTx');
        expect(faults[0].seq).toBe(0);
    });

    it('rejects a command on NACK', async () => {
        const h = makeHarness();
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );

        const promise = h.client.sendCommand(baseCommand());
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.NACK, encodeNackPayload({ seq: 0, reason: 0x03 })),
        );
        await expect(promise).rejects.toMatchObject({ kind: 'nack', seq: 0 });
    });

    it('fails pending commands on a controller UNRECOVERABLE_TX error frame', async () => {
        const h = makeHarness();
        await connectOpen(h);
        h.client.setEnvelopeCalibrated(true);
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
        );

        const faults: FaultEvent[] = [];
        h.client.on('fault', (e: FaultEvent) => faults.push(e));

        const caught = h.client.sendCommand(baseCommand()).catch((e: unknown) => e);
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.ERROR,
                encodeErrorPayload({ kind: 0x03, axis: 0, detail: 0 }),
            ),
        );
        const err = (await caught) as WireError;
        expect(err.kind).toBe('unrecoverableTx');
        expect(faults.some((f) => f.kind === 'unrecoverableTx')).toBe(true);
    });
});

describe('60-second reconnect window (Req 7.5, 7.6)', () => {
    it('resumes when the socket reconnects within the window', async () => {
        const h = makeHarness({ reconnectWindowMs: 60_000 });
        await connectOpen(h);
        expect(h.client.state()).toBe('connected');

        // Unexpected mid-session close -> enter reconnecting and open a new socket.
        h.sockets[0].fireClose();
        expect(h.client.state()).toBe('reconnecting');
        expect(h.sockets).toHaveLength(2);

        // Reconnect well within the 60 s window.
        h.clock.advance(10_000);
        h.sockets[1].fireOpen();
        expect(h.client.state()).toBe('connected');
    });

    it('emits a connection-timeout fault when the window elapses', async () => {
        const h = makeHarness({ reconnectWindowMs: 60_000 });
        await connectOpen(h);

        const faults: FaultEvent[] = [];
        h.client.on('fault', (e: FaultEvent) => faults.push(e));

        h.sockets[0].fireClose();
        expect(h.client.state()).toBe('reconnecting');

        // The replacement socket never opens; let the window elapse.
        h.clock.advance(60_000);

        expect(h.client.state()).toBe('disconnected');
        expect(faults).toHaveLength(1);
        expect(faults[0].kind).toBe('connTimeout');
    });

    it('does not reconnect after a deliberate close()', async () => {
        const h = makeHarness();
        await connectOpen(h);
        h.client.close();
        h.sockets[0].fireClose();
        expect(h.client.state()).toBe('disconnected');
        // No replacement socket was created.
        expect(h.sockets).toHaveLength(1);
    });
});

describe('telemetry events', () => {
    let h: Harness;

    beforeEach(async () => {
        h = makeHarness();
        await connectOpen(h);
    });

    it('emits a controller "state" event on a STATE frame', () => {
        const events: StateEvent[] = [];
        h.client.on('state', (e: StateEvent) => events.push(e));
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.STATE, encodeStatePayload({ stateCode: 1 })),
        );
        expect(
            events.some((e) => e.kind === 'controller' && e.controller === 1),
        ).toBe(true);
    });

    it('emits "rssi" and a status "state" event on a STATUS frame', () => {
        const rssis: RssiEvent[] = [];
        const states: StateEvent[] = [];
        h.client.on('rssi', (e: RssiEvent) => rssis.push(e));
        h.client.on('state', (e: StateEvent) => states.push(e));

        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.STATUS,
                statusPayload({
                    x: 100,
                    y: 200,
                    pct: 42,
                    rssi: -55,
                    activeSps: 400,
                    stateCode: 1,
                    flags: 0x01, // calibrated
                }),
            ),
        );

        expect(rssis).toEqual([{ rssiDbm: -55 }]);
        const status = states.find((e) => e.kind === 'status');
        expect(status).toMatchObject({
            kind: 'status',
            controller: 1,
            position: { x: 100, y: 200 },
            pctComplete: 42,
            calibrated: true,
        });
    });

    it('emits "progress" on a PROGRESS frame', () => {
        const events: ProgressEvent[] = [];
        h.client.on('progress', (e: ProgressEvent) => events.push(e));
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.PROGRESS, progressPayload(25, 100)),
        );
        expect(events).toEqual([{ doneSteps: 25, totalSteps: 100, pct: 25 }]);
    });

    it('emits "stall" on an ERROR(STALL) frame', () => {
        const events: StallEvent[] = [];
        h.client.on('stall', (e: StallEvent) => events.push(e));
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.ERROR,
                encodeErrorPayload({ kind: 0x01, axis: 1, detail: 4 }),
            ),
        );
        expect(events).toEqual([{ axis: 1, detail: 4 }]);
    });

    it('emits "fault" on an ERROR(FAULT) frame', () => {
        const events: FaultEvent[] = [];
        h.client.on('fault', (e: FaultEvent) => events.push(e));
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.ERROR,
                encodeErrorPayload({ kind: 0x02, axis: 0, detail: 7 }),
            ),
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: 'fault', axis: 0, detail: 7 });
    });

    it('emits "home" and updates calibration on a HELLO frame', () => {
        const events: HomeEvent[] = [];
        h.client.on('home', (e: HomeEvent) => events.push(e));
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.HELLO,
                helloPayload({
                    firmwareVersion: 0x010203,
                    x: 0,
                    y: 0,
                    flags: 0x05, // calibrated (bit0) + envelope-calibrated (bit2)
                    envelopeX: 1200,
                    envelopeY: 800,
                }),
            ),
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            calibrated: true,
            unclean: false,
            position: { x: 0, y: 0 },
            firmwareVersion: 0x010203,
            envelope: { x: 1200, y: 800 },
            envelopeCalibrated: true,
        });
        expect(h.client.isCalibrated()).toBe(true);
        expect(h.client.isEnvelopeCalibrated()).toBe(true);
    });
});
