/**
 * Property-based tests for the Drawing_Command binary codec.
 *
 * Implements **Property 1: Drawing_Command serialization round-trip**
 * (Design §7) in three parts:
 *   1. encode→decode round-trip preserves every wire-legal field.
 *   2. CRC integrity: any single-byte corruption of the 16-byte payload
 *      is rejected by the decoder.
 *   3. splitMotion round-trip at the command-list level: large logical
 *      motions split into wire-legal chunks whose concatenation
 *      reproduces the original delta exactly, with correct sequencing,
 *      flag placement, and per-chunk codec round-trip.
 *
 * **Validates: Requirements 7.2, 7.8**
 *
 * @see web/src/codec/drawing_command.ts
 * @see Design §4.3, §7
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    DrawingCommandError,
    decodeCommand,
    encodeCommand,
    splitMotion,
} from './drawing_command';
import {
    DRAWING_COMMAND_BYTES,
    DRAWING_COMMAND_DELTA_MAX,
    DRAWING_COMMAND_FLAGS,
    FEED_SPS_MAX,
    FEED_SPS_MIN,
} from '../constants';
import type { DrawingCommand } from '../types';

// -----------------------------------------------------------------------------
// Generators
//
// Smart generators that constrain inputs to the documented field domains so
// each property has a total truth value across its quantified domain.
// -----------------------------------------------------------------------------

/** The four legal flag combinations: {0, CONNECTOR, LAST_OF_BATCH, both}. */
const arbFlags: fc.Arbitrary<number> = fc.constantFrom(
    0,
    DRAWING_COMMAND_FLAGS.CONNECTOR,
    DRAWING_COMMAND_FLAGS.LAST_OF_BATCH,
    DRAWING_COMMAND_FLAGS.CONNECTOR | DRAWING_COMMAND_FLAGS.LAST_OF_BATCH,
);

/** Feed rate constrained to the wire-legal inclusive range [100, 1000]. */
const arbFeedSps: fc.Arbitrary<number> = fc.integer({
    min: FEED_SPS_MIN,
    max: FEED_SPS_MAX,
});

/**
 * Any DrawingCommand whose fields lie in their wire-legal ranges:
 *   - seq      : u32          [0, 0xffffffff]
 *   - dx,dy    : i16          [-32768, 32767]
 *   - feedSps  : [100, 1000]
 *   - flags    : {0, CONNECTOR, LAST_OF_BATCH, CONNECTOR|LAST_OF_BATCH}
 *
 * The optional `crc16` field is intentionally omitted on the input side;
 * the codec computes it during encoding and surfaces it on decode.
 */
const arbCommand: fc.Arbitrary<DrawingCommand> = fc.record({
    seq: fc.integer({ min: 0, max: 0xffffffff }),
    dxSteps: fc.integer({ min: -32768, max: 32767 }),
    dySteps: fc.integer({ min: -32768, max: 32767 }),
    feedSps: arbFeedSps,
    flags: arbFlags,
});

// -----------------------------------------------------------------------------
// Property 1 — serialization round-trip and CRC integrity
// -----------------------------------------------------------------------------

describe('Drawing_Command codec — Property 1 (serialization round-trip)', () => {
    /**
     * **Validates: Requirements 7.2, 7.8**
     *
     * For ALL wire-legal DrawingCommand values, decoding the encoded
     * 16-byte payload reproduces seq, dxSteps, dySteps, feedSps, and
     * flags exactly (Req 7.8 round-trip). The decoded crc16 surfaced by
     * the codec is a valid u16.
     */
    it('round-trip: decodeCommand(encodeCommand(cmd)) reproduces every field', () => {
        fc.assert(
            fc.property(arbCommand, (cmd) => {
                const decoded = decodeCommand(encodeCommand(cmd));
                expect(decoded.seq).toBe(cmd.seq);
                expect(decoded.dxSteps).toBe(cmd.dxSteps);
                expect(decoded.dySteps).toBe(cmd.dySteps);
                expect(decoded.feedSps).toBe(cmd.feedSps);
                expect(decoded.flags).toBe(cmd.flags);
                // The codec computes the CRC on encode and re-validates it
                // on decode, so the surfaced crc16 must be a valid u16.
                expect(Number.isInteger(decoded.crc16)).toBe(true);
                expect(decoded.crc16).toBeGreaterThanOrEqual(0);
                expect(decoded.crc16).toBeLessThanOrEqual(0xffff);
            }),
            { numRuns: 1000 },
        );
    });

    /**
     * **Validates: Requirements 7.2**
     *
     * CRC integrity. Corrupting any single byte of the encoded 16-byte
     * buffer (XOR with a non-zero mask at a fast-check-chosen offset in
     * [0, 16)) must cause `decodeCommand` to throw `DrawingCommandError`.
     *
     * Reasoning over the two regions of the buffer:
     *   - A change in the covered payload bytes [0, 14) alters the
     *     recomputed CRC; a single-byte XOR is a burst error of ≤ 8 bits,
     *     and CRC-16/CCITT detects all burst errors no longer than 16
     *     bits, so the mismatch is guaranteed.
     *   - A change in the CRC bytes [14, 16) leaves the recomputed CRC
     *     over [0, 14) unchanged while the stored CRC differs, so the
     *     comparison still fails.
     *
     * In every case the buffer length is unchanged (16), so the decoder
     * passes the length check and fails the CRC check with kind `'crc'`.
     */
    it('CRC integrity: any single-byte corruption in [0, 16) is rejected as kind="crc"', () => {
        fc.assert(
            fc.property(
                arbCommand,
                // Byte offset to corrupt within the 16-byte buffer.
                fc.integer({ min: 0, max: DRAWING_COMMAND_BYTES - 1 }),
                // Non-zero mask in [1, 255] guarantees the byte actually changes.
                fc.integer({ min: 1, max: 0xff }),
                (cmd, offset, mask) => {
                    const buf = encodeCommand(cmd);
                    expect(buf.length).toBe(DRAWING_COMMAND_BYTES);

                    const before = buf[offset];
                    buf[offset] ^= mask;
                    // A non-zero mask must flip at least one bit of the byte.
                    expect(buf[offset]).not.toBe(before);

                    let thrown: unknown;
                    try {
                        decodeCommand(buf);
                    } catch (err) {
                        thrown = err;
                    }
                    expect(thrown).toBeInstanceOf(DrawingCommandError);
                    expect((thrown as DrawingCommandError).kind).toBe('crc');
                },
            ),
            { numRuns: 1000 },
        );
    });
});

// -----------------------------------------------------------------------------
// splitMotion round-trip at the command-list level
//
// Per Design §4.3, large logical motions are split into multiple
// Drawing_Commands whose concatenation reproduces the logical motion
// exactly (Req 7.8 round-trip preserved at the command-list level).
// -----------------------------------------------------------------------------

describe('Drawing_Command codec — Property 1 (splitMotion round-trip)', () => {
    /** dx, dy domain spanning many split factors (up to ~62 chunks). */
    const arbHugeDelta = fc.integer({ min: -2_000_000, max: 2_000_000 });

    /**
     * Normalise IEEE-754 signed zero to +0. `splitMotion` uses
     * `Math.round` on proportional shares, and `Math.round(-0.5) === -0`
     * in JavaScript, so a chunk delta can be `-0`. The 16-bit wire format
     * has a single representation for zero, so encode/decode canonicalises
     * `-0` to `+0`. Requirement 7.8 is about numeric equality of the
     * integer delta, for which `-0` and `+0` are the same value; this
     * helper keeps the assertion at that intended precision rather than
     * `Object.is` precision.
     */
    const normZero = (v: number): number => (v === 0 ? 0 : v);

    /**
     * **Validates: Requirements 7.2, 7.8**
     *
     * For arbitrary dx, dy ∈ [-2_000_000, 2_000_000], feedSps ∈ [100, 1000],
     * and any legal flag combination, `splitMotion(seqStart, …)`:
     *   - sums its per-chunk deltas to exactly (dx, dy);
     *   - keeps every chunk within the i16 wire bound;
     *   - numbers chunks seqStart, seqStart+1, …;
     *   - carries LAST_OF_BATCH only on the final chunk, and only when the
     *     input requested it; propagates CONNECTOR to every chunk;
     *   - emits chunks that each survive an encode/decode round-trip.
     */
    it('splits, sums to the input delta, sequences, flags, and per-chunk round-trips', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 0xffff_0000 }),
                arbHugeDelta,
                arbHugeDelta,
                arbFeedSps,
                arbFlags,
                (seqStart, dx, dy, feedSps, flags) => {
                    const cmds = splitMotion(seqStart, dx, dy, feedSps, flags);
                    expect(cmds.length).toBeGreaterThanOrEqual(1);

                    const inputHadLast =
                        (flags & DRAWING_COMMAND_FLAGS.LAST_OF_BATCH) !== 0;
                    const inputHadConnector =
                        (flags & DRAWING_COMMAND_FLAGS.CONNECTOR) !== 0;

                    let sumDx = 0;
                    let sumDy = 0;

                    cmds.forEach((cmd, i) => {
                        const isLast = i === cmds.length - 1;

                        sumDx += cmd.dxSteps;
                        sumDy += cmd.dySteps;

                        // Each chunk stays within the i16 wire delta bound.
                        expect(Math.abs(cmd.dxSteps)).toBeLessThanOrEqual(
                            DRAWING_COMMAND_DELTA_MAX,
                        );
                        expect(Math.abs(cmd.dySteps)).toBeLessThanOrEqual(
                            DRAWING_COMMAND_DELTA_MAX,
                        );

                        // Sequence numbers are seqStart, seqStart+1, …
                        expect(cmd.seq).toBe(seqStart + i);

                        // feedSps is carried through unchanged.
                        expect(cmd.feedSps).toBe(feedSps);

                        // LAST_OF_BATCH only on the final chunk, and only
                        // when the caller asked for it.
                        const hasLast =
                            (cmd.flags & DRAWING_COMMAND_FLAGS.LAST_OF_BATCH) !==
                            0;
                        expect(hasLast).toBe(isLast && inputHadLast);

                        // CONNECTOR is per-segment and propagates to every
                        // emitted chunk.
                        const hasConnector =
                            (cmd.flags & DRAWING_COMMAND_FLAGS.CONNECTOR) !== 0;
                        expect(hasConnector).toBe(inputHadConnector);

                        // Each emitted chunk survives an encode/decode
                        // round-trip (Req 7.8 at the command level).
                        const decoded = decodeCommand(encodeCommand(cmd));
                        expect(decoded.seq).toBe(cmd.seq);
                        expect(decoded.dxSteps).toBe(normZero(cmd.dxSteps));
                        expect(decoded.dySteps).toBe(normZero(cmd.dySteps));
                        expect(decoded.feedSps).toBe(cmd.feedSps);
                        expect(decoded.flags).toBe(cmd.flags);
                    });

                    // Concatenated chunk deltas reproduce the logical motion
                    // exactly.
                    expect(sumDx).toBe(dx);
                    expect(sumDy).toBe(dy);
                },
            ),
            { numRuns: 300 },
        );
    });
});
