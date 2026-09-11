import { describe, it, expect, beforeEach } from 'vitest';
import {
    createController,
    mapControllerState,
    mapConnection,
    CONTROLLER_STATE,
    type Controller,
} from './controller';
import { createStores, type AppStores } from './stores';
import { WireClient, type WireSocket, type TimerApi } from '../net/wire_client';
import {
    FrameType,
    encodeFrame,
    encodeAckPayload,
    encodeCreditPayload,
    encodeErrorPayload,
    decodeFrame,
} from '../codec/frame';
import { CtlKind } from '../codec/control';
import type { Polyline } from '../types';

/**
 * Unit tests for the SPA integration controller (task 29.1).
 *
 * Drives the controller against an in-memory fake WebSocket (mirroring the
 * WireClient test harness) so the inbound event→store mapping and the outbound
 * UI-callback→control-frame mapping are exercised deterministically.
 */

const WS_OPEN = 1;
const WS_CLOSED = 3;

/** Fake WebSocket capturing sent frames and exposing event triggers. */
class FakeSocket implements WireSocket {
    binaryType: 'blob' | 'arraybuffer' = 'blob';
    readyState = 0;
    sent: Uint8Array[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;

    send(data: ArrayBufferView | ArrayBufferLike): void {
        if (data instanceof Uint8Array) this.sent.push(new Uint8Array(data));
        else if (ArrayBuffer.isView(data))
            this.sent.push(new Uint8Array(data.buffer.slice(0) as ArrayBuffer));
        else this.sent.push(new Uint8Array(data as ArrayBuffer));
    }
    close(): void {
        this.readyState = WS_CLOSED;
    }
    fireOpen(): void {
        this.readyState = WS_OPEN;
        this.onopen?.({});
    }
    fireMessage(bytes: Uint8Array): void {
        this.onmessage?.({ data: bytes });
    }
}

const noopTimers: TimerApi = {
    setTimeout: () => 0,
    clearTimeout: () => { },
};

interface Harness {
    controller: Controller;
    stores: AppStores;
    sockets: FakeSocket[];
}

function makeHarness(): Harness {
    const sockets: FakeSocket[] = [];
    const client = new WireClient({
        socketFactory: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
        timers: noopTimers,
    });
    const stores = createStores();
    const controller = createController({
        url: 'ws://device.local/ws',
        stores,
        client,
    });
    return { controller, stores, sockets };
}

async function connectOpen(h: Harness): Promise<void> {
    const p = h.controller.connect();
    h.sockets[0].fireOpen();
    await p;
}

/** Decode every CTL frame the socket has sent into its ctl_kind discriminator. */
function sentCtlKinds(socket: FakeSocket): number[] {
    const kinds: number[] = [];
    for (const f of socket.sent) {
        let decoded;
        try {
            decoded = decodeFrame(f);
        } catch {
            continue;
        }
        if (decoded.type === FrameType.CTL) kinds.push(decoded.payload[0]!);
    }
    return kinds;
}

/**
 * Build a §4.8 HELLO payload (40 bytes). The envelope fields live at offsets
 * 32/36 and the flags byte (offset 28) carries bit2 = envelope-calibrated, so a
 * conformant HELLO is now 40 bytes (Design §4.8, Req 8.1, 8.3).
 */
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
    v.setUint16(4, 1000, true);
    v.setInt32(20, opts.x, true);
    v.setInt32(24, opts.y, true);
    v.setUint8(28, opts.flags);
    v.setUint16(30, 40, true);
    v.setUint32(32, opts.envelopeX ?? 0, true);
    v.setUint32(36, opts.envelopeY ?? 0, true);
    return buf;
}

/** Build a §4.7 STATUS payload (16 bytes). */
function statusPayload(opts: {
    x: number;
    y: number;
    pct: number;
    rssi: number;
    stateCode: number;
    flags: number;
}): Uint8Array {
    const buf = new Uint8Array(16);
    const v = new DataView(buf.buffer);
    v.setInt32(0, opts.x, true);
    v.setInt32(4, opts.y, true);
    v.setUint8(8, opts.pct);
    v.setInt8(9, opts.rssi);
    v.setUint16(10, 400, true);
    v.setUint8(12, opts.stateCode);
    v.setUint8(13, opts.flags);
    return buf;
}

const square: Polyline = [
    { x: 10, y: 10 },
    { x: 40, y: 10 },
    { x: 40, y: 40 },
    { x: 10, y: 40 },
    { x: 10, y: 10 },
];

// -----------------------------------------------------------------------------
// Pure mappers
// -----------------------------------------------------------------------------

describe('mapControllerState', () => {
    it('maps the IDLE/DRAWING/PAUSED codes to UI execution states', () => {
        expect(mapControllerState(CONTROLLER_STATE.IDLE)).toBe('idle');
        expect(mapControllerState(CONTROLLER_STATE.DRAWING)).toBe('drawing');
        expect(mapControllerState(CONTROLLER_STATE.PAUSED)).toBe('paused');
    });
    it('returns null for fault/stall so they do not move execution state', () => {
        expect(mapControllerState(CONTROLLER_STATE.FAULT)).toBeNull();
        expect(mapControllerState(CONTROLLER_STATE.STALL)).toBeNull();
    });
});

describe('mapConnection', () => {
    it('collapses reconnecting onto connecting (Req 12.1)', () => {
        expect(mapConnection('connected')).toBe('connected');
        expect(mapConnection('disconnected')).toBe('disconnected');
        expect(mapConnection('connecting')).toBe('connecting');
        expect(mapConnection('reconnecting')).toBe('connecting');
    });
});

// -----------------------------------------------------------------------------
// Inbound: WireClient events → stores
// -----------------------------------------------------------------------------

describe('controller — inbound event mapping', () => {
    let h: Harness;
    beforeEach(async () => {
        h = makeHarness();
        await connectOpen(h);
    });

    it('reflects connection state changes into the connection store', () => {
        expect(h.stores.connection.value).toBe('connected');
    });

    it('flips the calibration store + position on a HELLO frame', () => {
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.HELLO,
                helloPayload({ firmwareVersion: 1, x: 5, y: 7, flags: 0x01 }),
            ),
        );
        expect(h.stores.calibrated.value).toBe(true);
        expect(h.stores.position.value).toEqual({ x: 5, y: 7 });
        expect(h.stores.uncleanShutdown.value).toBe(false);
        expect(h.stores.lastKnownPosition.value).toBeNull();
    });

    it('records the unclean-shutdown hint from a HELLO frame (Req 10.12)', () => {
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.HELLO,
                // flags 0x02 = unclean, calibrated bit clear.
                helloPayload({ firmwareVersion: 1, x: 12, y: 34, flags: 0x02 }),
            ),
        );
        expect(h.stores.calibrated.value).toBe(false);
        expect(h.stores.uncleanShutdown.value).toBe(true);
        expect(h.stores.lastKnownPosition.value).toEqual({ x: 12, y: 34 });
    });

    it('updates position/progress/drawing-state from a STATUS frame', () => {
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.STATUS,
                statusPayload({
                    x: 100,
                    y: 200,
                    pct: 42,
                    rssi: -55,
                    stateCode: CONTROLLER_STATE.DRAWING,
                    flags: 0x01,
                }),
            ),
        );
        expect(h.stores.position.value).toEqual({ x: 100, y: 200 });
        expect(h.stores.progressPct.value).toBe(42);
        expect(h.stores.drawingState.value).toBe('drawing');
        expect(h.stores.rssiDbm.value).toBe(-55);
        expect(h.stores.calibrated.value).toBe(true);
    });

    it('lights the stall indicator with axis on an ERROR(STALL) frame', () => {
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.ERROR,
                encodeErrorPayload({ kind: 0x01, axis: 1, detail: 4 }),
            ),
        );
        expect(h.stores.stall.value).toEqual({ active: true, axis: 'y' });
    });

    it('lights the fault indicator on an ERROR(FAULT) frame', () => {
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.ERROR,
                encodeErrorPayload({ kind: 0x02, axis: 0, detail: 7 }),
            ),
        );
        expect(h.stores.fault.value).toEqual({ active: true, driver: 'X' });
        expect(h.stores.drawingState.value).toBe('error');
    });
});

// -----------------------------------------------------------------------------
// Outbound: UI callbacks → control frames + stores
// -----------------------------------------------------------------------------

describe('controller — planning into the planned-path store', () => {
    it('plans input polylines into the planned-path store', () => {
        const h = makeHarness();
        expect(h.stores.plannedPath.value).toBeNull();
        h.controller.setPolylines([square]);
        const path = h.stores.plannedPath.value;
        expect(path).not.toBeNull();
        expect(path!.segments.length).toBeGreaterThan(0);
    });

    it('clears the planned path on an empty polyline set', () => {
        const h = makeHarness();
        h.controller.setPolylines([square]);
        expect(h.stores.plannedPath.value).not.toBeNull();
        h.controller.setPolylines([]);
        expect(h.stores.plannedPath.value).toBeNull();
    });
});

describe('controller — control-message callbacks', () => {
    let h: Harness;
    beforeEach(async () => {
        h = makeHarness();
        await connectOpen(h);
    });

    it('maps pause/resume/cancel to their CTL frames', () => {
        h.controller.pause();
        h.controller.resume();
        h.controller.cancel();
        const kinds = sentCtlKinds(h.sockets[0]);
        expect(kinds).toContain(CtlKind.PAUSE);
        expect(kinds).toContain(CtlKind.RESUME);
        expect(kinds).toContain(CtlKind.CANCEL);
        expect(h.stores.drawingState.value).toBe('cancelled');
    });

    it('maps speed change to a SPEED_PCT frame and updates the store', () => {
        h.controller.setSpeedPct(50);
        expect(sentCtlKinds(h.sockets[0])).toContain(CtlKind.SPEED_PCT);
        expect(h.stores.speedPct.value).toBe(50);
    });

    it('maps jog/setHome/reHome to their CTL frames and updates calibration', () => {
        h.controller.jog('x', 1);
        h.controller.setHome();
        expect(sentCtlKinds(h.sockets[0])).toEqual(
            expect.arrayContaining([CtlKind.JOG, CtlKind.SET_HOME]),
        );
        expect(h.stores.calibrated.value).toBe(true);

        h.controller.reHome();
        expect(sentCtlKinds(h.sockets[0])).toContain(CtlKind.RE_HOME);
        expect(h.stores.calibrated.value).toBe(false);
    });

    it('maps backlash record/edit to SET_BACKLASH and stores the pair', () => {
        h.controller.recordBacklash(0, 12);
        h.controller.manualEditBacklash(1, 34);
        expect(sentCtlKinds(h.sockets[0])).toContain(CtlKind.SET_BACKLASH);
        expect(h.stores.backlash.value).toEqual({ x: 12, y: 34 });
        expect(h.stores.backlashCalibrationPerformed.value).toBe(true);
    });

    it('maps motor test / fault reset to their CTL frames', () => {
        h.controller.motorTest();
        expect(h.stores.motorTestRunning.value).toBe(true);
        h.controller.faultReset();
        const kinds = sentCtlKinds(h.sockets[0]);
        expect(kinds).toContain(CtlKind.MOTOR_TEST);
        expect(kinds).toContain(CtlKind.FAULT_RESET);
        expect(h.stores.fault.value.active).toBe(false);
    });
});

describe('controller — capture actions (Req 1.2, 1.4, 9.1, 9.4, 10.1)', () => {
    let h: Harness;
    beforeEach(async () => {
        h = makeHarness();
        await connectOpen(h);
    });

    it('captureBottomLeft() sends CAPTURE_BOTTOM_LEFT and applies optimistic state', () => {
        // Seed a prior calibrated envelope so we can observe it being cleared.
        h.stores.envelope.value = { x: 1000, y: 2000 };
        h.stores.envelopeCalibrated.value = true;
        h.stores.position.value = { x: 50, y: 60 };

        h.controller.captureBottomLeft();

        expect(sentCtlKinds(h.sockets[0])).toContain(CtlKind.CAPTURE_BOTTOM_LEFT);
        // Home is declared optimistically; position zeroed.
        expect(h.stores.calibrated.value).toBe(true);
        expect(h.stores.position.value).toEqual({ x: 0, y: 0 });
        expect(h.stores.uncleanShutdown.value).toBe(false);
        expect(h.stores.lastKnownPosition.value).toBeNull();
        // Re-homing invalidates the previous envelope (Req 10.1): gate closes.
        expect(h.stores.envelope.value).toBeNull();
        expect(h.stores.envelopeCalibrated.value).toBe(false);
    });

    it('captureTopRight() sends CAPTURE_TOP_RIGHT with no optimistic envelope', () => {
        // A measured envelope is the controller's authority — no optimism here.
        expect(h.stores.envelope.value).toBeNull();
        expect(h.stores.envelopeCalibrated.value).toBe(false);

        h.controller.captureTopRight();

        expect(sentCtlKinds(h.sockets[0])).toContain(CtlKind.CAPTURE_TOP_RIGHT);
        // Still no optimistic envelope; HELLO/STATUS carries the result.
        expect(h.stores.envelope.value).toBeNull();
        expect(h.stores.envelopeCalibrated.value).toBe(false);
    });
});

describe('controller — HELLO/STATUS folds rehydrate envelope state (Req 8.3, 8.4)', () => {
    let h: Harness;
    beforeEach(async () => {
        h = makeHarness();
        await connectOpen(h);
    });

    it('HELLO fold sets envelope + envelopeCalibrated from the frame', () => {
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.HELLO,
                helloPayload({
                    firmwareVersion: 1,
                    x: 0,
                    y: 0,
                    // flags 0x05 = calibrated (bit0) + envelope-calibrated (bit2).
                    flags: 0x05,
                    envelopeX: 12000,
                    envelopeY: 9000,
                }),
            ),
        );
        expect(h.stores.envelope.value).toEqual({ x: 12000, y: 9000 });
        expect(h.stores.envelopeCalibrated.value).toBe(true);
    });

    it('HELLO fold keeps the effective envelope even when envelopeCalibrated=false', () => {
        // Seed a prior envelope, then a HELLO without the envelope-calibrated bit.
        // HELLO is firmware-authoritative and carries the EFFECTIVE envelope
        // (the bounded DEFAULT_ENVELOPE when uncalibrated, Req 2.5), so the
        // envelope is folded unconditionally while envelopeCalibrated tracks only
        // captured calibration (Req 2.8).
        h.stores.envelope.value = { x: 5000, y: 5000 };
        h.stores.envelopeCalibrated.value = true;

        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.HELLO,
                helloPayload({
                    firmwareVersion: 1,
                    x: 0,
                    y: 0,
                    // flags 0x01 = calibrated only; bit2 (envelope) clear.
                    flags: 0x01,
                    // Effective (default) envelope advertised by the firmware.
                    envelopeX: 2158,
                    envelopeY: 1650,
                }),
            ),
        );
        expect(h.stores.envelope.value).toEqual({ x: 2158, y: 1650 });
        expect(h.stores.envelopeCalibrated.value).toBe(false);
    });

    it('STATUS fold sets envelopeCalibrated from flags bit2', () => {
        expect(h.stores.envelopeCalibrated.value).toBe(false);
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.STATUS,
                statusPayload({
                    x: 0,
                    y: 0,
                    pct: 0,
                    rssi: -50,
                    stateCode: CONTROLLER_STATE.IDLE,
                    // flags 0x05 = calibrated (bit0) + envelope-calibrated (bit2).
                    flags: 0x05,
                }),
            ),
        );
        expect(h.stores.envelopeCalibrated.value).toBe(true);

        // A subsequent STATUS without bit2 clears the gate again.
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.STATUS,
                statusPayload({
                    x: 0,
                    y: 0,
                    pct: 0,
                    rssi: -50,
                    stateCode: CONTROLLER_STATE.IDLE,
                    flags: 0x01,
                }),
            ),
        );
        expect(h.stores.envelopeCalibrated.value).toBe(false);
    });
});

describe('controller — draw() gates on the effective envelope (Req 2.8, 3.5)', () => {
    /** Fold a HELLO that captures a valid envelope and engages the gate. */
    function calibrateEnvelope(h: Harness, env: { x: number; y: number }): void {
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.HELLO,
                helloPayload({
                    firmwareVersion: 1,
                    x: 0,
                    y: 0,
                    flags: 0x05, // calibrated + envelope-calibrated
                    envelopeX: env.x,
                    envelopeY: env.y,
                }),
            ),
        );
    }

    /**
     * Fold a HELLO from an UNCALIBRATED machine that nonetheless advertises the
     * firmware-authoritative effective (default) envelope. flags=0x00 means no
     * captured calibration, but the positive envelope opens the effective-
     * envelope draw-gate (Defect 2 fix).
     */
    function foldDefaultEnvelope(
        h: Harness,
        env: { x: number; y: number },
    ): void {
        h.sockets[0].fireMessage(
            encodeFrame(
                FrameType.HELLO,
                helloPayload({
                    firmwareVersion: 1,
                    x: 0,
                    y: 0,
                    flags: 0x00, // not envelope-calibrated, default envelope
                    envelopeX: env.x,
                    envelopeY: env.y,
                }),
            ),
        );
    }

    it('draws with the default envelope even when not envelope-calibrated', async () => {
        const h = makeHarness();
        await connectOpen(h);
        // Uncalibrated machine, but HELLO advertises the bounded DEFAULT_ENVELOPE.
        foldDefaultEnvelope(h, { x: 2158, y: 1650 });
        h.controller.setPolylines([square]);
        expect(h.stores.envelopeCalibrated.value).toBe(false);
        expect(h.stores.envelope.value).toEqual({ x: 2158, y: 1650 });

        // Seed plenty of credits so every command transmits immediately.
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 32 })),
        );

        const drawP = h.controller.draw();
        await Promise.resolve();
        await Promise.resolve();

        // ACK every streamed CMD so draw() can resolve.
        for (const f of h.sockets[0].sent) {
            const d = decodeFrame(f);
            if (d.type === FrameType.CMD) {
                const seq = new DataView(
                    d.payload.buffer,
                    d.payload.byteOffset,
                    d.payload.byteLength,
                ).getUint32(0, true);
                h.sockets[0].fireMessage(
                    encodeFrame(FrameType.ACK, encodeAckPayload({ seq })),
                );
            }
        }
        await drawP;

        // The draw-gate is open against the default envelope: BEGIN_DRAW streams.
        const kinds = sentCtlKinds(h.sockets[0]);
        expect(kinds).toContain(CtlKind.BEGIN_DRAW);
        expect(kinds).toContain(CtlKind.END_DRAW);
        expect(h.stores.drawingState.value).toBe('drawing');
    });

    it('does not stream a draw when no effective envelope is known', async () => {
        const h = makeHarness();
        await connectOpen(h);
        h.controller.setPolylines([square]);
        // No HELLO folded yet, so there is no effective envelope.
        expect(h.stores.envelope.value).toBeNull();

        await h.controller.draw();

        // Without a bounded envelope the controller does not emit BEGIN_DRAW.
        expect(sentCtlKinds(h.sockets[0])).not.toContain(CtlKind.BEGIN_DRAW);
    });

    it('builds the plan with envelopeSteps once calibrated', async () => {
        const h = makeHarness();
        await connectOpen(h);
        const env = { x: 20000, y: 16000 };
        calibrateEnvelope(h, env);
        h.controller.setPolylines([square]);

        const path = h.stores.plannedPath.value;
        expect(path).not.toBeNull();
        // Envelope-fit branch: drawableSteps equals the measured envelope and
        // every emitted coordinate lies within it (no mm gear-math path).
        expect(path!.drawableSteps).toEqual({ w: env.x, h: env.y });
        for (const seg of path!.segments) {
            for (const p of seg.pointsSteps) {
                expect(Number.isInteger(p.x)).toBe(true);
                expect(Number.isInteger(p.y)).toBe(true);
                expect(p.x).toBeGreaterThanOrEqual(0);
                expect(p.x).toBeLessThanOrEqual(env.x);
                expect(p.y).toBeGreaterThanOrEqual(0);
                expect(p.y).toBeLessThanOrEqual(env.y);
            }
        }
    });

    it('streams BEGIN_DRAW → CMDs → END_DRAW once envelope-calibrated', async () => {
        const h = makeHarness();
        await connectOpen(h);
        const env = { x: 20000, y: 16000 };
        calibrateEnvelope(h, env);
        h.controller.setPolylines([square]);

        // Seed plenty of credits so every command transmits immediately.
        h.sockets[0].fireMessage(
            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 32 })),
        );

        const drawP = h.controller.draw();

        // draw() awaits BEGIN_DRAW before streaming CMDs, so let the
        // microtask queue flush before collecting the sent command frames.
        await Promise.resolve();
        await Promise.resolve();

        // ACK every CMD the controller streamed so draw() can resolve.
        const cmdSeqs: number[] = [];
        for (const f of h.sockets[0].sent) {
            const d = decodeFrame(f);
            if (d.type === FrameType.CMD) {
                const seq = new DataView(
                    d.payload.buffer,
                    d.payload.byteOffset,
                    d.payload.byteLength,
                ).getUint32(0, true);
                cmdSeqs.push(seq);
            }
        }
        expect(cmdSeqs.length).toBeGreaterThan(0);
        for (const seq of cmdSeqs) {
            h.sockets[0].fireMessage(
                encodeFrame(FrameType.ACK, encodeAckPayload({ seq })),
            );
        }

        await drawP;

        const kinds = sentCtlKinds(h.sockets[0]);
        expect(kinds).toContain(CtlKind.BEGIN_DRAW);
        expect(kinds).toContain(CtlKind.END_DRAW);
        expect(h.stores.drawingState.value).toBe('drawing');
    });
});
