/**
 * Property-based tests for `Image_Processor.traceContours` — the pure core
 * that turns a binary edge bitmap into ordered polylines.
 *
 * Implements **Property 20: Polyline pixel-adjacency** (Design §7):
 *
 *   *For any* polyline emitted by the `Image_Processor`, every pair of
 *   consecutive points `(p_i, p_{i+1})` satisfies
 *   `max(|p_{i+1}.x - p_i.x|, |p_{i+1}.y - p_i.y|) ≤ 1`. Every emitted
 *   polyline has at least 2 points; no empty polyline is emitted.
 *
 * The adjacency (Chebyshev ≤ 1) invariant is the heart of Requirement 4.6
 * ("connected pixel coordinates with no gap greater than 1 pixel between
 * consecutive points"). Alongside it we assert the supporting structural
 * invariants that make the contour set well-formed: minimum length,
 * exact coverage of the input edge set, in-bounds integer coordinates,
 * and the empty/non-empty boundary cases.
 *
 * **Validates: Requirements 4.6**
 *
 * @see web/src/image/image_processor.ts
 * @see Design §3.1.1, §7 (Property 20)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { traceContours } from './image_processor';

// -----------------------------------------------------------------------------
// Generators
//
// Keep dimensions small (≤ 16×16) so the coverage-set comparison is cheap and
// shrunk counterexamples stay human-readable. Because the bitmap length must
// match the chosen dimensions exactly, we pick w and h first, then generate
// exactly w*h booleans via fc.chain.
// -----------------------------------------------------------------------------

const MAX_DIM = 16;

interface BitmapCase {
    width: number;
    height: number;
    /** Row-major edge flags, length === width * height. */
    cells: boolean[];
}

const arbDim: fc.Arbitrary<number> = fc.integer({ min: 1, max: MAX_DIM });

/**
 * An arbitrary binary edge bitmap of dimensions in `[1, 16] × [1, 16]`.
 * Each cell is independently an edge with ~50% probability; this mixes
 * empty regions, isolated pixels, thin runs, branches, and dense blocks so
 * the trace logic is exercised across its full behaviour space.
 */
const arbBitmapCase: fc.Arbitrary<BitmapCase> = fc
    .tuple(arbDim, arbDim)
    .chain(([width, height]) =>
        fc
            .array(fc.boolean(), {
                minLength: width * height,
                maxLength: width * height,
            })
            .map((cells) => ({ width, height, cells })),
    );

/** Materialise the boolean cells into the Uint8Array (0/255) the API expects. */
function toBitmap(c: BitmapCase): Uint8Array {
    const out = new Uint8Array(c.width * c.height);
    for (let i = 0; i < out.length; i++) out[i] = c.cells[i] ? 255 : 0;
    return out;
}

/** Independently-computed set of edge-pixel keys ("x,y") from the bitmap. */
function expectedEdgeKeys(c: BitmapCase): Set<string> {
    const set = new Set<string>();
    for (let i = 0; i < c.cells.length; i++) {
        if (!c.cells[i]) continue;
        const x = i % c.width;
        const y = (i - x) / c.width;
        set.add(`${x},${y}`);
    }
    return set;
}

// -----------------------------------------------------------------------------
// Property 20 — Polyline pixel-adjacency (and supporting structural invariants)
// -----------------------------------------------------------------------------

describe('Image_Processor.traceContours — Property 20 (polyline pixel-adjacency)', () => {
    /**
     * **Validates: Requirements 4.6**
     *
     * THE adjacency property: for every emitted polyline and every
     * consecutive point pair, the Chebyshev distance `max(|dx|, |dy|)` is
     * ≤ 1 — i.e. each step lands on an immediate 8-neighbour, so there is
     * "no gap greater than 1 pixel between consecutive points".
     *
     * Bundled with it (so a single counterexample localises the failure)
     * are the structural invariants from the Property 20 statement and the
     * traceContours contract:
     *   2. MIN LENGTH — every polyline has ≥ 2 points (isolated pixels are
     *      emitted as a degenerate `[p, p]`, which is adjacent at distance 0).
     *   3. COVERAGE — the union of all polyline points equals exactly the set
     *      of edge pixels (every edge covered, no non-edge point emitted).
     *   4. IN-BOUNDS — every point has integer `x ∈ [0, width)`,
     *      `y ∈ [0, height)`.
     */
    it('emits ≥2-point polylines whose consecutive points are Chebyshev-adjacent and exactly cover the edge set', () => {
        fc.assert(
            fc.property(arbBitmapCase, (c) => {
                const bitmap = toBitmap(c);
                const polys = traceContours(bitmap, c.width, c.height);

                const expected = expectedEdgeKeys(c);
                const covered = new Set<string>();

                for (const poly of polys) {
                    // (2) MIN LENGTH: no empty/single-point polylines.
                    expect(poly.length).toBeGreaterThanOrEqual(2);

                    for (let i = 0; i < poly.length; i++) {
                        const p = poly[i];

                        // (4) IN-BOUNDS + integer coordinates.
                        expect(Number.isInteger(p.x)).toBe(true);
                        expect(Number.isInteger(p.y)).toBe(true);
                        expect(p.x).toBeGreaterThanOrEqual(0);
                        expect(p.x).toBeLessThan(c.width);
                        expect(p.y).toBeGreaterThanOrEqual(0);
                        expect(p.y).toBeLessThan(c.height);

                        // (3) COVERAGE: every emitted point is an edge pixel.
                        const key = `${p.x},${p.y}`;
                        expect(expected.has(key)).toBe(true);
                        covered.add(key);

                        // (1) ADJACENCY: consecutive points differ by
                        // Chebyshev distance ≤ 1 (Req 4.6).
                        if (i > 0) {
                            const prev = poly[i - 1];
                            const cheb = Math.max(
                                Math.abs(p.x - prev.x),
                                Math.abs(p.y - prev.y),
                            );
                            expect(cheb).toBeLessThanOrEqual(1);
                        }
                    }
                }

                // (3) COVERAGE (other direction): every edge pixel is covered
                // by some polyline, so the covered set equals the edge set.
                expect(covered.size).toBe(expected.size);
                for (const key of expected) {
                    expect(covered.has(key)).toBe(true);
                }
            }),
            { numRuns: 300 },
        );
    });

    /**
     * **Validates: Requirements 4.6**
     *
     * EMPTY / NON-EMPTY boundary: an all-zero bitmap yields no polylines,
     * while any bitmap containing at least one edge pixel yields a
     * non-empty result. This pins the "no empty polyline is emitted" half
     * of Property 20 at the bitmap-level boundary.
     */
    it('returns [] for an all-zero bitmap and a non-empty result whenever an edge exists', () => {
        fc.assert(
            fc.property(arbBitmapCase, (c) => {
                const hasEdge = c.cells.some((v) => v);

                const allZero = new Uint8Array(c.width * c.height);
                expect(traceContours(allZero, c.width, c.height)).toEqual([]);

                const polys = traceContours(toBitmap(c), c.width, c.height);
                if (hasEdge) {
                    expect(polys.length).toBeGreaterThan(0);
                } else {
                    expect(polys).toEqual([]);
                }
            }),
            { numRuns: 300 },
        );
    });
});
