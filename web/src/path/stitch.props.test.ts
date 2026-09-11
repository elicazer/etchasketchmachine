/**
 * Property-based tests for greedy nearest-neighbor polyline stitching.
 *
 * Implements **Property 11: Continuous-stroke construction** (Design §7).
 *
 * **Validates: Requirements 4.7, 11.7, 14.1, 14.2, 14.3**
 *
 * `stitchPolylines` linearises an arbitrary set of polylines into a single
 * continuous stroke (the Etch-a-Sketch stylus cannot lift), ordering them by
 * nearest endpoint, flipping each into the orientation whose entry endpoint is
 * closest to the pen, and weaving straight-line `connector` segments between
 * them. This file asserts the universal invariants that hold for *every* input:
 *
 *   1. CONTINUITY (Req 14.1)        – adjacent segments share an endpoint, so
 *                                     the whole output is one continuous stroke.
 *   2. NO ZERO-LENGTH SUB-SEGMENTS  – each segment has ≥ 2 points and no two
 *                                     consecutive points are identical.
 *   3. COVERAGE (Req 4.7 / 14.2)    – every input polyline with ≥ 2 points
 *                                     appears exactly once as a `stroke`
 *                                     (forward or reversed); shorter ones drop.
 *   4. CONNECTOR PLACEMENT (Req 14.3)– every `connector` is a non-degenerate
 *                                     2-point hop that joins into the next
 *                                     stroke.
 *   5. STROKE COUNT                 – #strokes === #(inputs with ≥ 2 points).
 *   6. NN-WITH-FLIP ORIENTATION (Req 14.2) – each stroke is entered at whichever
 *                                     of its two ends is nearer the pen at pick
 *                                     time, i.e. flipping never lengthens the
 *                                     entry hop for the chosen polyline.
 *
 * Req 11.7 (freehand "send to machine" treats every on-canvas stroke as one
 * composition) is satisfied structurally by the same continuity invariant: the
 * stitcher is input-source-agnostic. Image contours, text strokes, and freehand
 * strokes all arrive as `Polyline[]` and become a single continuous stroke, so
 * Property 11 covers the freehand composition case without a separate test.
 *
 * The deterministic ordering, flip, and connector-suppression *examples* live
 * in `stitch.test.ts` (tasks 12.1/12.2); this file covers the universal laws.
 *
 * @see web/src/path/stitch.ts
 * @see Design §3.1.4 (path pipeline), §7 (Property 11)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { stitchPolylines } from './stitch';
import type { Point, Polyline, PlannedSegment } from '../types';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

const firstPt = (s: PlannedSegment): Point => s.pointsSteps[0]!;

const lastPt = (s: PlannedSegment): Point =>
    s.pointsSteps[s.pointsSteps.length - 1]!;

const distSq = (a: Point, b: Point): number => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
};

/** True when two polylines are point-for-point equal. */
const polyEqual = (a: Polyline, b: Polyline): boolean =>
    a.length === b.length && a.every((p, i) => samePoint(p, b[i]!));

/**
 * Collapse runs of identical consecutive points. The real pipeline runs
 * scale → step-quantise → RDP-simplify *before* stitching, all of which leave
 * polylines with no zero-length sub-segments. `stitchPolylines` is documented
 * to reorder/flip/connect — not to de-duplicate — so a faithful generator
 * mirrors that well-formed input space. De-duplication may shrink a degenerate
 * `[A, A]` down to `[A]`, which then exercises the <2-point drop path.
 */
function dedupeConsecutive(poly: Polyline): Polyline {
    const out: Point[] = [];
    for (const p of poly) {
        const prev = out[out.length - 1];
        if (prev === undefined || prev.x !== p.x || prev.y !== p.y) {
            out.push({ x: p.x, y: p.y });
        }
    }
    return out;
}

/**
 * The pen position at the moment a stroke's polyline was picked by the greedy
 * search, reconstructed from the emitted output:
 *   - the very first segment: the supplied `start`;
 *   - a stroke preceded by its connector: the connector's *first* point (the
 *     pen had to hop from there to the entry);
 *   - a stroke that directly follows another stroke (connector suppressed): the
 *     previous stroke's last point, which the pen already occupied.
 * A connector is always emitted immediately before the stroke it serves and is
 * never adjacent to another connector, so this is unambiguous.
 */
function penBeforeStroke(
    segs: PlannedSegment[],
    k: number,
    start: Point,
): Point {
    if (k === 0) return start;
    const prev = segs[k - 1]!;
    return prev.kind === 'connector' ? firstPt(prev) : lastPt(prev);
}

// -----------------------------------------------------------------------------
// Generators — constrained to the documented input space.
// -----------------------------------------------------------------------------

const arbCoord: fc.Arbitrary<number> = fc.integer({ min: -500, max: 500 });

const arbPoint: fc.Arbitrary<Point> = fc.record({ x: arbCoord, y: arbCoord });

/**
 * A single polyline of 0..6 integer points. Lengths 0 and 1 occur naturally and
 * exercise the drop path; de-duplication keeps every ≥2-point polyline
 * well-formed (distinct consecutive points).
 */
const arbPolyline: fc.Arbitrary<Polyline> = fc
    .array(arbPoint, { minLength: 0, maxLength: 6 })
    .map(dedupeConsecutive);

/** 0..8 polylines, the input to a single stitch. */
const arbPolylines: fc.Arbitrary<Polyline[]> = fc.array(arbPolyline, {
    minLength: 0,
    maxLength: 8,
});

const arbStart: fc.Arbitrary<Point> = arbPoint;

const NUM_RUNS = 300;

// -----------------------------------------------------------------------------
// Property 11 — Continuous-stroke construction
// -----------------------------------------------------------------------------

describe('stitchPolylines — Property 11 (continuous-stroke construction)', () => {
    /**
     * **Validates: Requirements 14.1, 11.7**
     *
     * Sub-property 1 (CONTINUITY). For every adjacent pair, the last point of
     * `segments[i]` deep-equals the first point of `segments[i+1]`, so the whole
     * result is one continuous stroke regardless of input source.
     */
    it('continuity: adjacent segments share an endpoint (single continuous stroke)', () => {
        fc.assert(
            fc.property(arbPolylines, arbStart, (polys, start) => {
                const segs = stitchPolylines(polys, { start });
                for (let i = 0; i < segs.length - 1; i++) {
                    expect(lastPt(segs[i]!)).toEqual(firstPt(segs[i + 1]!));
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 14.1**
     *
     * Sub-property 2 (NO ZERO-LENGTH SUB-SEGMENTS). Each emitted segment has at
     * least two points and contains no two identical consecutive points, so
     * every motion the planner emits has real length.
     */
    it('no zero-length sub-segments: each segment has ≥ 2 points, all consecutive points distinct', () => {
        fc.assert(
            fc.property(arbPolylines, arbStart, (polys, start) => {
                const segs = stitchPolylines(polys, { start });
                for (const s of segs) {
                    expect(s.pointsSteps.length).toBeGreaterThanOrEqual(2);
                    for (let i = 0; i < s.pointsSteps.length - 1; i++) {
                        expect(
                            samePoint(s.pointsSteps[i]!, s.pointsSteps[i + 1]!),
                        ).toBe(false);
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 4.7, 14.2**
     *
     * Sub-properties 3 (COVERAGE) and 5 (STROKE COUNT). Every input polyline
     * with ≥ 2 points appears exactly once as a `stroke` segment, forward or
     * reversed; polylines with < 2 points never appear; and the number of
     * strokes equals the number of ≥2-point inputs. Matching consumes each
     * input at most once, so the strokes are a bijection onto the kept inputs.
     */
    it('coverage + stroke count: each ≥2-point input appears exactly once (fwd/rev); shorter dropped', () => {
        fc.assert(
            fc.property(arbPolylines, arbStart, (polys, start) => {
                const segs = stitchPolylines(polys, { start });
                const strokes = segs.filter((s) => s.kind === 'stroke');
                const expected = polys.filter((p) => p.length >= 2);

                // Sub-property 5: stroke count equals kept-input count.
                expect(strokes.length).toBe(expected.length);

                // Sub-property 3: bijection by value (forward or reversed),
                // each kept input matched exactly once.
                const matched = new Array<boolean>(expected.length).fill(false);
                for (const stroke of strokes) {
                    const idx = expected.findIndex((p, i) => {
                        if (matched[i]) return false;
                        return (
                            polyEqual(p, stroke.pointsSteps) ||
                            polyEqual(p.slice().reverse(), stroke.pointsSteps)
                        );
                    });
                    expect(idx).toBeGreaterThanOrEqual(0);
                    matched[idx] = true;
                }
                // Every kept input was consumed exactly once.
                expect(matched.every((m) => m)).toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 14.3, 14.1**
     *
     * Sub-property 4 (CONNECTOR PLACEMENT). Every `connector` is a
     * non-degenerate two-point hop, and it is always immediately followed by the
     * `stroke` it feeds (its last point equals that stroke's first point). The
     * complementary "no connector emitted when the pen already sits on the entry"
     * direction is covered by the continuity invariant above: a stroke that
     * directly follows another stroke forces `prev.last === next.first`, i.e. the
     * suppressed connector would have had zero length.
     */
    it('connectors: exactly 2 distinct points and they join into the following stroke', () => {
        fc.assert(
            fc.property(arbPolylines, arbStart, (polys, start) => {
                const segs = stitchPolylines(polys, { start });
                for (let i = 0; i < segs.length; i++) {
                    const s = segs[i]!;
                    if (s.kind !== 'connector') continue;
                    // Exactly two points, and non-zero length.
                    expect(s.pointsSteps.length).toBe(2);
                    expect(samePoint(firstPt(s), lastPt(s))).toBe(false);
                    // A connector always precedes the stroke it serves.
                    const next = segs[i + 1];
                    expect(next).toBeDefined();
                    expect(next!.kind).toBe('stroke');
                    expect(samePoint(lastPt(s), firstPt(next!))).toBe(true);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 14.2**
     *
     * Sub-property 6 (NN-WITH-FLIP ORIENTATION). For each stroke, the entry
     * endpoint chosen by the greedy search is the nearer of the polyline's two
     * ends to the pen at pick time — flipping never increases the entry hop for
     * the chosen polyline. The pen-at-pick-time position is reconstructed from
     * the output (see `penBeforeStroke`), so this is asserted locally per stroke
     * rather than by re-implementing the greedy ordering. (The stronger
     * whole-path "NN total ≤ identity-ordering total" claim is a heuristic bound
     * that does not hold for every input and is exercised by the targeted
     * examples in `stitch.test.ts` instead.)
     */
    it('NN-with-flip: each stroke is entered at its end nearer the pen at pick time', () => {
        fc.assert(
            fc.property(arbPolylines, arbStart, (polys, start) => {
                const segs = stitchPolylines(polys, { start });
                for (let k = 0; k < segs.length; k++) {
                    const s = segs[k]!;
                    if (s.kind !== 'stroke') continue;
                    const pen = penBeforeStroke(segs, k, start);
                    const entry = firstPt(s);
                    const farEnd = lastPt(s);
                    expect(distSq(pen, entry)).toBeLessThanOrEqual(
                        distSq(pen, farEnd),
                    );
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
