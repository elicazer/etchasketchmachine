/**
 * Property-based tests for the pure MTU chunking core in {@link ./ble_chunk}.
 *
 * Implements **Property 1: Chunking round-trip byte identity** (Design §7.1):
 *
 *   *For any* `Frame_Envelope` byte sequence `frame` (`4 ≤ frame.length ≤
 *   15 × body`) and *any* chunk body size `body ≥ 1`,
 *   `reassemble(fragment(frame, body))` produces a byte sequence identical to
 *   `frame`. As corollaries, the exact CMD / CTL payload bytes survive
 *   fragmentation/reassembly regardless of the negotiated MTU, and the layout
 *   is identical across the BLE and WiFi builds.
 *
 * **Validates: Requirements 4.2, 5.1, 5.2, 5.3, 10.1, 13.3**
 *
 * The generator constrains the input space so `fragment` is always called
 * inside its representable domain (`body ≥ 1` and `4 ≤ len ≤ 15 × body`), so a
 * failure surfaces a genuine round-trip byte mismatch rather than an expected
 * `FragmentError` (`emptyBody` / `totalTooLarge`).
 *
 * @see web/src/net/ble_chunk.ts
 * @see Design §4.3, §7.1
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fragment, reassemble, MAX_CHUNKS } from './ble_chunk';

// Feature: ble-transport-switch, Property 1: Chunking round-trip byte identity

describe('ble_chunk — Property 1 (chunking round-trip byte identity)', () => {
    /**
     * **Validates: Requirements 4.2, 5.1, 5.2, 5.3, 10.1, 13.3**
     *
     * A smart generator picks `body ≥ 1` first, then a frame length in the
     * representable window `4 ≤ len ≤ 15 × body`, then exactly that many
     * arbitrary bytes. Every generated case is therefore a legal `fragment`
     * input, and the reassembled bytes must equal the original frame exactly.
     */
    it('reassemble(fragment(frame, body)) === frame', () => {
        const arbCase = fc
            .integer({ min: 1, max: 64 })
            .chain((body) =>
                fc
                    .integer({ min: 4, max: MAX_CHUNKS * body })
                    .chain((len) =>
                        fc
                            .uint8Array({ minLength: len, maxLength: len })
                            .map((frame) => ({ frame, body })),
                    ),
            );

        fc.assert(
            fc.property(arbCase, ({ frame, body }) => {
                const chunks = fragment(frame, body);

                // Never exceeds the 4-bit chunk-count ceiling for legal inputs.
                expect(chunks.length).toBeGreaterThanOrEqual(1);
                expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);

                const out = reassemble(chunks);
                expect(out).toEqual(frame);
            }),
            { numRuns: 300 },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 2 — chunk reassembly rejects malformed sequences (Req 5.5)
// -----------------------------------------------------------------------------

import { Reassembler, ChunkError } from './ble_chunk';

/** Build a raw chunk: 1-byte (total,index) header followed by `body`. */
function mkChunk(total: number, index: number, body: Uint8Array): Uint8Array {
    const c = new Uint8Array(1 + body.length);
    c[0] = ((total & 0x0f) << 4) | (index & 0x0f);
    c.set(body, 1);
    return c;
}

/** Small arbitrary chunk body (the body size is irrelevant to the failure). */
const arbBody: fc.Arbitrary<Uint8Array> = fc.uint8Array({ maxLength: 8 });

/**
 * Malformed chunk-sequence generators. Every branch yields a sequence that is
 * guaranteed unrecoverable AND that never contains a complete, valid subset,
 * so a correct reassembler must reject it without ever emitting a frame.
 */
const arbMalformed: fc.Arbitrary<Uint8Array[]> = fc.oneof(
    // (a) total_chunks field is 0 — unrepresentable / total-too-large.
    fc
        .record({ index: fc.integer({ min: 0, max: 15 }), body: arbBody })
        .map(({ index, body }) => [mkChunk(0, index, body)]),

    // (b) chunk_index >= total (out of range). total in 1..14 leaves an
    //     index in [total, 15] that is provably out of range.
    fc
        .integer({ min: 1, max: 14 })
        .chain((total) =>
            fc
                .integer({ min: total, max: 15 })
                .chain((index) =>
                    arbBody.map((body) => [mkChunk(total, index, body)]),
                ),
        ),

    // (c) duplicate index. total >= 2 so the first chunk cannot complete the
    //     frame; the repeated index 0 is then rejected as a duplicate.
    fc
        .integer({ min: 2, max: 15 })
        .chain((total) =>
            fc
                .tuple(arbBody, arbBody)
                .map(([b1, b2]) => [
                    mkChunk(total, 0, b1),
                    mkChunk(total, 0, b2),
                ]),
        ),

    // (d) inconsistent total across one in-flight frame. The first chunk
    //     (total t1 >= 2) opens a frame without completing it; the second
    //     carries a different, in-range total.
    fc
        .integer({ min: 2, max: 15 })
        .chain((t1) =>
            fc
                .integer({ min: 1, max: 15 })
                .filter((t2) => t2 !== t1)
                .chain((t2) =>
                    fc
                        .integer({ min: 0, max: t2 - 1 })
                        .chain((idx2) =>
                            fc
                                .tuple(arbBody, arbBody)
                                .map(([b1, b2]) => [
                                    mkChunk(t1, 0, b1),
                                    mkChunk(t2, idx2, b2),
                                ]),
                        ),
                ),
        ),

    // (e) incomplete set: a genuine fragmentation (>= 2 chunks) with exactly
    //     one chunk dropped, so `received` can never reach `total`.
    fc
        .integer({ min: 1, max: 16 })
        .chain((body) =>
            fc
                .integer({ min: body + 1, max: MAX_CHUNKS * body })
                .chain((len) =>
                    fc
                        .uint8Array({ minLength: len, maxLength: len })
                        .chain((frame) =>
                            fc.nat().map((seed) => {
                                const chunks = fragment(frame, body);
                                const dropIdx = seed % chunks.length;
                                chunks.splice(dropIdx, 1);
                                return chunks;
                            }),
                        ),
                ),
        ),
);

// Feature: ble-transport-switch, Property 2: Chunk reassembly rejects malformed sequences

describe('ble_chunk — Property 2 (reassembly rejects malformed sequences)', () => {
    /**
     * **Validates: Requirements 5.5**
     *
     * For any malformed chunk sequence — invalid total, index ≥ total,
     * duplicate index, inconsistent total, or an incomplete (dropped) set —
     * reassembly fails with a `ChunkError` (the transmit-error signal) and a
     * fresh {@link Reassembler} never emits a frame to the protocol layer for
     * that sequence. Feeding chunks one-by-one confirms no frame leaks out
     * before the error is raised.
     */
    it('throws ChunkError and never emits a frame for malformed sequences', () => {
        fc.assert(
            fc.property(arbMalformed, (chunks) => {
                // The one-shot path surfaces the transmit error for every
                // malformed category (mid-stream throw or end-of-stream
                // incomplete) by throwing rather than returning a frame.
                expect(() => reassemble(chunks)).toThrow(ChunkError);

                // Stream the same chunks through a stateful reassembler and
                // assert that NO frame is ever emitted: push either throws
                // before completing a frame, or only ever returns null.
                const r = new Reassembler();
                const emitted: Uint8Array[] = [];
                let threw: unknown = null;
                try {
                    for (const chunk of chunks) {
                        const frame = r.push(chunk);
                        if (frame !== null) emitted.push(frame);
                    }
                } catch (e) {
                    threw = e;
                }

                // No frame ever reached the protocol layer.
                expect(emitted).toHaveLength(0);
                // Either push threw a ChunkError mid-stream, or the sequence
                // was an incomplete set that push silently buffers (and which
                // the one-shot reassemble above already proved unrecoverable).
                if (threw !== null) {
                    expect(threw).toBeInstanceOf(ChunkError);
                }
            }),
            { numRuns: 300 },
        );
    });
});
