/**
 * Property-based tests for the {@link WireClient} calibration send-gate.
 *
 * Implements **Property 17: Send-gate on calibration** (Design §7):
 *
 *   *For any* attempt to send a `BEGIN_DRAW` or `CMD`, the `WireClient`
 *   emits the frame if and only if its session-local `calibrated` flag is
 *   true. Therefore there exists no execution in which a `CMD` (or a
 *   `BEGIN_DRAW` control) is transmitted while `calibrated` is false.
 *
 * **Validates: Requirements 10.11**
 *
 * The test drives the client against an in-memory fake WebSocket and a fake
 * clock (the same harness pattern as `wire_client.test.ts`, copied here so the
 * property file is self-contained) so that the send-gate can be exercised
 * deterministically with no real socket or wall-clock. The fake socket is
 * connected and seeded with credits, so a send-gate regression would surface
 * as an actually-transmitted CMD / BEGIN_DRAW frame rather than being masked
 * by a closed socket or starved credits.
 *
 * @see web/src/net/wire_client.ts
 * @see Design §3.1.5, §7
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    WireClient,
    WireError,
    CONTROL_ACK_SEQ,
    type WireSocket,
    type TimerApi,
} from './wire_client';
import {
    FrameType,
    decodeFrame,
    encodeFrame,
    encodeAckPayload,
    encodeCreditPayload,
} from '../codec/frame';
import { CtlKind, type ControlMessage, type Axis, type JogDir } from '../codec/control';
import { FEED_SPS_MAX, FEED_SPS_MIN, DRAWING_COMMAND_FLAGS } from '../constants';
import type { DrawingCommand } from '../types';

// -----------------------------------------------------------------------------
// Test doubles (copied from wire_client.test.ts to keep this file self-contained)
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
            this.sent.push(new Uint8Array(data.buffer.slice(0) as ArrayBuffer));
        } else {
            this.sent.push(new Uint8Array(data as ArrayBuffer));
        }
    }

    close(): void {
        this.closed = true;
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
}

interface Harness {
    client: WireClient;
    clock: FakeClock;
    sockets: FakeSocket[];
}

function makeHarness(): Harness {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock();
    const client = new WireClient({
        socketFactory: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
        timers: clock,
    });
    return { client, clock, sockets };
}

/** Connect a harness and resolve once the (first) fake socket opens. */
async function connectOpen(h: Harness, url = 'ws://device.local/ws'): Promise<void> {
    const p = h.client.connect(url);
    h.sockets[0].fireOpen();
    await p;
}

// -----------------------------------------------------------------------------
// Frame inspection helpers
// -----------------------------------------------------------------------------

/** Decode every frame the socket has sent, dropping any that fail to decode. */
function decodedSentFrames(
    socket: FakeSocket,
): { type: FrameType; payload: Uint8Array }[] {
    const out: { type: FrameType; payload: Uint8Array }[] = [];
    for (const f of socket.sent) {
        try {
            out.push(decodeFrame(f));
        } catch {
            /* skip undecodable bytes (none expected from the client) */
        }
    }
    return out;
}

/** Count CMD frames transmitted on the socket. */
function countCmdFrames(socket: FakeSocket): number {
    return decodedSentFrames(socket).filter((f) => f.type === FrameType.CMD)
        .length;
}

/** True if any transmitted CTL frame carries the BEGIN_DRAW discriminator. */
function hasBeginDrawFrame(socket: FakeSocket): boolean {
    return decodedSentFrames(socket).some(
        (f) =>
            f.type === FrameType.CTL &&
            f.payload.length >= 1 &&
            f.payload[0] === CtlKind.BEGIN_DRAW,
    );
}

// -----------------------------------------------------------------------------
// Generators — constrained to the documented wire-legal field domains
// -----------------------------------------------------------------------------

/** The four legal flag combinations: {0, CONNECTOR, LAST_OF_BATCH, both}. */
const arbFlags: fc.Arbitrary<number> = fc.constantFrom(
    0,
    DRAWING_COMMAND_FLAGS.CONNECTOR,
    DRAWING_COMMAND_FLAGS.LAST_OF_BATCH,
    DRAWING_COMMAND_FLAGS.CONNECTOR | DRAWING_COMMAND_FLAGS.LAST_OF_BATCH,
);

/** A wire-legal DrawingCommand (seq is overwritten by the client's counter). */
const arbCommand: fc.Arbitrary<DrawingCommand> = fc.record({
    seq: fc.integer({ min: 0, max: 0xffffffff }),
    dxSteps: fc.integer({ min: -32768, max: 32767 }),
    dySteps: fc.integer({ min: -32768, max: 32767 }),
    feedSps: fc.integer({ min: FEED_SPS_MIN, max: FEED_SPS_MAX }),
    flags: arbFlags,
});

/** A BEGIN_DRAW control message with u32 fields. */
const arbBeginDraw: fc.Arbitrary<ControlMessage> = fc
    .record({
        totalSegments: fc.integer({ min: 0, max: 0xffffffff }),
        totalSteps: fc.integer({ min: 0, max: 0xffffffff }),
    })
    .map(
        ({ totalSegments, totalSteps }): ControlMessage => ({
            kind: 'beginDraw',
            totalSegments,
            totalSteps,
        }),
    );

/** Credit grant value carried by a CREDIT frame (u8). */
const arbCredit: fc.Arbitrary<number> = fc.integer({ min: 0, max: 255 });

/**
 * A `(homeSet, envelopeCaptured)` calibration-state pair (Property 2).
 *
 * The firmware only raises HELLO/STATUS flag bit2 when BOTH home and a valid
 * envelope are captured, so the wire client's single `envelopeCalibrated`
 * gate flag already encodes that AND. The effective gate value is therefore
 * `homeSet && envelopeCaptured`.
 */
const arbCalibState: fc.Arbitrary<{ homeSet: boolean; envelopeCaptured: boolean }> =
    fc.record({
        homeSet: fc.boolean(),
        envelopeCaptured: fc.boolean(),
    });

/**
 * Build a §4.7 STATUS payload (16 bytes) whose flags byte carries the given
 * bit pattern. bit0 = calibrated (home), bit2 = envelope-calibrated; the other
 * bits are caller-supplied noise so a regression that keyed off the wrong bit
 * would be caught.
 */
function statusPayloadWithFlags(flags: number): Uint8Array {
    const buf = new Uint8Array(16);
    const v = new DataView(buf.buffer);
    v.setInt32(0, 0, true); // x
    v.setInt32(4, 0, true); // y
    v.setUint8(8, 0); // pct
    v.setInt8(9, -50); // rssi
    v.setUint16(10, 400, true); // active sps
    v.setUint8(12, 1); // state code
    v.setUint8(13, flags & 0xff);
    return buf;
}

/** STATUS/HELLO flag bits (Design §4.7 / §4.8). */
const FLAG_CALIBRATED = 0x01;
const FLAG_ENVELOPE_CALIBRATED = 0x04;

/** A non-draw control message (pause / resume / jog) — never send-gated. */
const arbNonDrawControl: fc.Arbitrary<ControlMessage> = fc.oneof(
    fc.constant<ControlMessage>({ kind: 'pause' }),
    fc.constant<ControlMessage>({ kind: 'resume' }),
    fc
        .record({
            axis: fc.constantFrom<Axis>(0, 1),
            dir: fc.constantFrom<JogDir>(1, -1),
            steps: fc.integer({ min: 0, max: 0xffff }),
        })
        .map(
            ({ axis, dir, steps }): ControlMessage => ({
                kind: 'jog',
                axis,
                dir,
                steps,
            }),
        ),
);

// -----------------------------------------------------------------------------
// Property 17 — send-gate on calibration (Req 10.11)
// -----------------------------------------------------------------------------

describe('WireClient — Property 17 (send-gate on calibration, Req 10.11)', () => {
    /**
     * **Validates: Requirements 10.11**
     *
     * The core gate. With the socket OPEN and credits available — conditions
     * under which a CMD would otherwise transmit immediately — an uncalibrated
     * client that is handed an arbitrary sequence of `sendCommand` /
     * `sendControl(beginDraw)` calls and arbitrary CREDIT grants transmits
     * ZERO CMD frames and ZERO BEGIN_DRAW control frames. Credits are granted
     * both before and after the send attempts so a regression cannot hide
     * behind starved flow-control.
     */
    it('transmits no CMD or BEGIN_DRAW frame while uncalibrated', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(arbCommand, { maxLength: 12 }),
                fc.array(arbBeginDraw, { maxLength: 4 }),
                fc.array(arbCredit, { minLength: 1, maxLength: 6 }),
                async (commands, beginDraws, credits) => {
                    const h = makeHarness();
                    await connectOpen(h);
                    // The client must never have been calibrated.
                    expect(h.client.isEnvelopeCalibrated()).toBe(false);

                    const socket = h.sockets[0];
                    const half = Math.ceil(credits.length / 2);

                    // Throw some credits at it up front.
                    for (const n of credits.slice(0, half)) {
                        socket.fireMessage(
                            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n })),
                        );
                    }

                    // Attempt every gated send; each rejects synchronously.
                    for (const cmd of commands) {
                        void h.client.sendCommand(cmd).catch(() => { });
                    }
                    for (const bd of beginDraws) {
                        void h.client.sendControl(bd).catch(() => { });
                    }

                    // Throw the rest of the credits at it after the attempts.
                    for (const n of credits.slice(half)) {
                        socket.fireMessage(
                            encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n })),
                        );
                    }

                    expect(countCmdFrames(socket)).toBe(0);
                    expect(hasBeginDrawFrame(socket)).toBe(false);
                },
            ),
            { numRuns: 300 },
        );
    });

    /**
     * **Validates: Requirements 10.11**
     *
     * The promise contract of the gate: while uncalibrated, both
     * `sendCommand` and `sendControl(beginDraw)` reject with a
     * `WireError` of kind `'notCalibrated'`.
     */
    it('rejects sendCommand and BEGIN_DRAW with a notCalibrated WireError while uncalibrated', async () => {
        await fc.assert(
            fc.asyncProperty(arbCommand, arbBeginDraw, async (cmd, beginDraw) => {
                const h = makeHarness();
                await connectOpen(h);
                expect(h.client.isEnvelopeCalibrated()).toBe(false);

                const cmdErr = await h.client.sendCommand(cmd).catch((e: unknown) => e);
                expect(cmdErr).toBeInstanceOf(WireError);
                expect((cmdErr as WireError).kind).toBe('notCalibrated');

                const bdErr = await h.client
                    .sendControl(beginDraw)
                    .catch((e: unknown) => e);
                expect(bdErr).toBeInstanceOf(WireError);
                expect((bdErr as WireError).kind).toBe('notCalibrated');

                // And nothing leaked onto the wire.
                expect(countCmdFrames(h.sockets[0])).toBe(0);
                expect(hasBeginDrawFrame(h.sockets[0])).toBe(false);
            }),
            { numRuns: 250 },
        );
    });

    /**
     * **Validates: Requirements 10.11**
     *
     * The "if and only if" other half: once `setCalibrated(true)` and credits
     * are available, an arbitrary command transmits EXACTLY one CMD frame and,
     * when ACKed, the send promise resolves with that command's sequence
     * number (the first per-session seq is 0).
     */
    it('transmits exactly one CMD frame and resolves once calibrated with credits', async () => {
        await fc.assert(
            fc.asyncProperty(arbCommand, async (cmd) => {
                const h = makeHarness();
                await connectOpen(h);
                const socket = h.sockets[0];

                h.client.setEnvelopeCalibrated(true);
                socket.fireMessage(
                    encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
                );

                const ackP = h.client.sendCommand(cmd);
                // Exactly one CMD frame went out.
                expect(countCmdFrames(socket)).toBe(1);

                // ACK the first per-session sequence number.
                socket.fireMessage(
                    encodeFrame(FrameType.ACK, encodeAckPayload({ seq: 0 })),
                );
                await expect(ackP).resolves.toEqual({ seq: 0 });
            }),
            { numRuns: 250 },
        );
    });

    /**
     * **Validates: Requirements 10.11**
     *
     * The gate is scoped to draw-initiating traffic only. A non-draw control
     * message (pause / resume / jog) is NOT gated: it transmits a CTL frame
     * and resolves even while the client is uncalibrated. The transmitted
     * frame is a CTL frame that is not BEGIN_DRAW.
     */
    it('does not gate non-draw control messages while uncalibrated', async () => {
        await fc.assert(
            fc.asyncProperty(arbNonDrawControl, async (ctl) => {
                const h = makeHarness();
                await connectOpen(h);
                const socket = h.sockets[0];
                expect(h.client.isEnvelopeCalibrated()).toBe(false);

                await expect(h.client.sendControl(ctl)).resolves.toEqual({
                    seq: CONTROL_ACK_SEQ,
                });

                const frames = decodedSentFrames(socket);
                expect(frames).toHaveLength(1);
                expect(frames[0].type).toBe(FrameType.CTL);
                expect(hasBeginDrawFrame(socket)).toBe(false);
            }),
            { numRuns: 250 },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 2 — drawing gate blocks unless envelope-calibrated, no fallback
// -----------------------------------------------------------------------------

// Feature: visual-corner-calibration, Property 2
describe('WireClient — Property 2 (send-gate on envelope calibration)', () => {
    /**
     * **Validates: Requirements 4.1, 4.2, 4.3, 5.1, 5.2, 5.3**
     *
     * The "if and only if" over the full `(homeSet, envelopeCaptured)` state
     * space. The wire-client gate is driven by the single `envelopeCalibrated`
     * flag, which the firmware only raises when BOTH home and a valid envelope
     * are captured — so the effective gate is `homeSet && envelopeCaptured`.
     *
     * With the socket OPEN and credits available (so a CMD would transmit
     * immediately), for every state pair:
     *   - gate true  → `beginDraw`/`sendCommand` proceed: a CMD frame and a
     *     BEGIN_DRAW frame are written to the socket;
     *   - gate false → both reject with `WireError('notCalibrated', …)` and NO
     *     CMD / BEGIN_DRAW frame is written.
     */
    it('permits beginDraw/sendCommand iff envelope-calibrated, else rejects with notCalibrated and emits nothing', async () => {
        await fc.assert(
            fc.asyncProperty(
                arbCalibState,
                arbCommand,
                arbBeginDraw,
                async ({ homeSet, envelopeCaptured }, cmd, beginDraw) => {
                    const h = makeHarness();
                    await connectOpen(h);
                    const socket = h.sockets[0];

                    // The firmware AND is encoded in the single gate flag.
                    const gateOpen = homeSet && envelopeCaptured;
                    h.client.setEnvelopeCalibrated(gateOpen);
                    expect(h.client.isEnvelopeCalibrated()).toBe(gateOpen);

                    // Credits available so flow-control never masks the gate.
                    socket.fireMessage(
                        encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 4 })),
                    );

                    if (gateOpen) {
                        // CMD transmits synchronously on flush; the promise stays
                        // pending until an ACK (not sent here), so don't await it.
                        const cmdP = h.client.sendCommand(cmd);
                        cmdP.catch(() => { }); // avoid unhandled rejection on teardown
                        // BEGIN_DRAW control resolves once written to the socket.
                        await expect(h.client.sendControl(beginDraw)).resolves.toEqual({
                            seq: CONTROL_ACK_SEQ,
                        });
                        expect(countCmdFrames(socket)).toBe(1);
                        expect(hasBeginDrawFrame(socket)).toBe(true);
                    } else {
                        // Both reject synchronously with notCalibrated; nothing
                        // reaches the wire.
                        const cmdErr = await h.client
                            .sendCommand(cmd)
                            .catch((e: unknown) => e);
                        const bdErr = await h.client
                            .sendControl(beginDraw)
                            .catch((e: unknown) => e);
                        expect(cmdErr).toBeInstanceOf(WireError);
                        expect((cmdErr as WireError).kind).toBe('notCalibrated');
                        expect(bdErr).toBeInstanceOf(WireError);
                        expect((bdErr as WireError).kind).toBe('notCalibrated');
                        expect(countCmdFrames(socket)).toBe(0);
                        expect(hasBeginDrawFrame(socket)).toBe(false);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });

    /**
     * **Validates: Requirements 4.1, 5.1, 8.2**
     *
     * Bit2 of the STATUS flags byte specifically drives the gate. Driving the
     * gate via an inbound STATUS frame with arbitrary flag bits, the client's
     * gate is open iff bit2 is set — independent of bit0 (home) or any other
     * bit — and the send behaviour follows that gate exactly.
     */
    it('STATUS flags bit2 drives the gate (independent of other bits)', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 0, max: 0xff }),
                arbCommand,
                async (flags, cmd) => {
                    const h = makeHarness();
                    await connectOpen(h);
                    const socket = h.sockets[0];

                    // Drive the gate purely from a STATUS frame.
                    socket.fireMessage(
                        encodeFrame(FrameType.STATUS, statusPayloadWithFlags(flags)),
                    );
                    const expectOpen = (flags & FLAG_ENVELOPE_CALIBRATED) !== 0;
                    expect(h.client.isEnvelopeCalibrated()).toBe(expectOpen);

                    socket.fireMessage(
                        encodeFrame(FrameType.CREDIT, encodeCreditPayload({ n: 1 })),
                    );

                    if (expectOpen) {
                        // Transmits synchronously; promise stays pending sans ACK.
                        const p = h.client.sendCommand(cmd);
                        p.catch(() => { });
                        expect(countCmdFrames(socket)).toBe(1);
                    } else {
                        const result = await h.client
                            .sendCommand(cmd)
                            .catch((e: unknown) => e);
                        expect(result).toBeInstanceOf(WireError);
                        expect((result as WireError).kind).toBe('notCalibrated');
                        expect(countCmdFrames(socket)).toBe(0);
                    }

                    // bit0 (home/calibrated) must never, on its own, open the gate.
                    if ((flags & FLAG_CALIBRATED) !== 0 && !expectOpen) {
                        expect(h.client.isEnvelopeCalibrated()).toBe(false);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});
