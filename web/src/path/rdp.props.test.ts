import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { rdpSimplify } from './rdp';
import type { Point, Polyline } from '../types';

/**
 * Property-based tests for Ramer-Douglas-Peucker line simplification.
 *
 * **Validates: Requirements 5.4**
 *
 * Implements Property 4 from Design §7: RDP simplification distance
 * bound and idempotence. The contract is that for any polyline `P`
 * and tolerance `ε ∈ [0.1, 5.0]`, the simplified polyline `P' =
 * rdpSimplify(P, ε)` satisfies:
 *
 *   1. Endpoints preserved: `P'.first == P.first` and
 *      `P'.last == P.last`.
 *   2. Distance bound: every point in `P` lies within `ε`
 *      point-to-segment distance of `P'` (treated as a
 *      piecewise-linear curve).
 *   3. Idempotence: `rdpSimplify(P', ε) == P'`.
 *   4. Length bound (non-expansion): `|P'| ≤ |P|`.
 *   5. Subsequence: `P'` is a subsequence of `P` — every output point
 *      is an input point, in input order.
 *   6. Epsilon validation: tolerances outside `[0.1, 5.0]` and the
 *      non-finite values `NaN`, `±Infinity` raise `RangeError`.
 *
 * Unit tests for individual examples and edge cases live in
 * `rdp.test.ts`; this file focuses on the universal properties.
 */

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/**
 * Finite floats in a sane numeric range. Avoiding NaN, ±Infinity, and
 * very large magnitudes keeps the perpendicular-distance arithmetic
 * well-conditioned so the bound check is meaningful.
 *
 * `fc.float` requires its `min`/`max` bounds to themselves be 32-bit
 * floats, so we run the literal bounds through `Math.fround`.
 */
const arbCoord = fc.float({
    min: Math.fround(-1000),
    max: Math.fround(1000),
    noNaN: true,
    noDefaultInfinity: true,
});

const arbPoint = fc.record({ x: arbCoord, y: arbCoord });

/**
 * Polyline of 2..50 points. We do not deduplicate consecutive
 * duplicates here because RDP must handle degenerate chords (a == b)
 * gracefully and that path is part of what we want to exercise.
 */
const arbPolyline: fc.Arbitrary<Polyline> = fc.array(arbPoint, {
    minLength: 2,
    maxLength: 50,
});

/** Tolerance values inside the documented `[0.1, 5.0]` range. */
const arbValidEpsilon = fc.float({
    min: Math.fround(0.1),
    max: Math.fround(5.0),
    noNaN: true,
    noDefaultInfinity: true,
});

// -----------------------------------------------------------------------------
// Distance helper
// -----------------------------------------------------------------------------

/**
 * Distance from `p` to the segment `(a, b)`. Handles the degenerate
 * case where the segment collapses to a single point by returning the
 * Euclidean distance to that point.
 */
function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return Math.hypot(p.x - a.x, p.y - a.y);
    }
    // Project p onto AB and clamp to the [0, 1] segment parameter.
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY);
}

/**
 * Minimum distance from `p` to any segment of the polyline `poly`,
 * treated as a piecewise-linear curve. This is the helper the distance-
 * bound property checks against: `min` over the simplified polyline's
 * segments of the point-to-*segment* distance (endpoints handled via the
 * clamped projection parameter in `pointToSegmentDistance`, never the
 * infinite-line distance). For `poly.length === 1` the polyline
 * degenerates to a single point. For `poly.length === 0` the function
 * returns `+Infinity` (no distance is defined).
 */
function distancePointToPolyline(p: Point, poly: Polyline): number {
    if (poly.length === 0) return Number.POSITIVE_INFINITY;
    if (poly.length === 1) {
        const q = poly[0]!;
        return Math.hypot(p.x - q.x, p.y - q.y);
    }
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < poly.length - 1; i++) {
        const d = pointToSegmentDistance(p, poly[i]!, poly[i + 1]!);
        if (d < best) best = d;
    }
    return best;
}

// -----------------------------------------------------------------------------
// Properties
// -----------------------------------------------------------------------------

describe('rdpSimplify (properties)', () => {
    it('preserves the first and last points (Property 4 endpoints)', () => {
        fc.assert(
            fc.property(arbPolyline, arbValidEpsilon, (poly, eps) => {
                const out = rdpSimplify(poly, eps);
                expect(out[0]).toEqual(poly[0]);
                expect(out[out.length - 1]).toEqual(poly[poly.length - 1]);
            }),
            { numRuns: 500 },
        );
    });

    it('keeps every input point within ε of the simplified polyline (Property 4 distance bound)', () => {
        fc.assert(
            fc.property(arbPolyline, arbValidEpsilon, (poly, eps) => {
                const out = rdpSimplify(poly, eps);
                for (const p of poly) {
                    const d = distancePointToPolyline(p, out);
                    // Tolerance choice (this is the subtle part of Property 4):
                    //
                    // RDP's internal drop test uses *perpendicular* distance to
                    // the chord, while this check measures distance to the
                    // finite *segment* (projection parameter clamped to [0, 1]).
                    // Those agree for interior projections but the cross-product
                    // / dot-product / hypot arithmetic accumulates IEEE-754
                    // round-off that grows with coordinate magnitude. Coordinates
                    // here reach 1000, where a few ULPs are ~1e-10 in absolute
                    // terms, but the squared intermediates (lenSq, dot up to
                    // ~1e6) inflate that drift well past a naive 1e-6.
                    //
                    // So we use a combined relative + absolute slack:
                    //   ε + 1e-6 * (1 + |coord magnitude|)
                    // The relative term scales with the point's own magnitude to
                    // absorb the inflated round-off near the far corner; the
                    // constant 1e-6 covers the small-coordinate floor. Even at
                    // the extreme this slack is ≤ ~1e-3, two orders of magnitude
                    // below the smallest meaningful ε (0.1), so the bound stays
                    // genuinely tight.
                    const mag = Math.max(Math.abs(p.x), Math.abs(p.y));
                    const slack = 1e-6 * (1 + mag);
                    expect(d).toBeLessThanOrEqual(eps + slack);
                }
            }),
            { numRuns: 500 },
        );
    });

    it('is idempotent: simplifying twice with the same ε equals simplifying once (Property 4 idempotence)', () => {
        fc.assert(
            fc.property(arbPolyline, arbValidEpsilon, (poly, eps) => {
                const once = rdpSimplify(poly, eps);
                const twice = rdpSimplify(once, eps);
                expect(twice).toEqual(once);
            }),
            { numRuns: 500 },
        );
    });

    it('never grows the polyline (Property 4 length bound / non-expansion)', () => {
        fc.assert(
            fc.property(arbPolyline, arbValidEpsilon, (poly, eps) => {
                const out = rdpSimplify(poly, eps);
                expect(out.length).toBeLessThanOrEqual(poly.length);
            }),
            { numRuns: 500 },
        );
    });

    it('returns a subsequence of the input in original order (Property 4 subsequence)', () => {
        fc.assert(
            fc.property(arbPolyline, arbValidEpsilon, (poly, eps) => {
                const out = rdpSimplify(poly, eps);
                // Walk a single pointer through the input; every output point
                // must match the input point at a strictly increasing index.
                // Using reference equality is sound because rdpSimplify emits
                // the exact input point objects it retains (never clones or
                // synthesises vertices).
                let j = 0;
                for (const q of out) {
                    while (j < poly.length && poly[j] !== q) j++;
                    expect(j).toBeLessThan(poly.length);
                    j++;
                }
            }),
            { numRuns: 500 },
        );
    });

    it('rejects ε outside [0.1, 5.0] and non-finite ε with RangeError', () => {
        // Out-of-range finite values: below 0.1 or above 5.0.
        const arbBelow = fc.float({
            min: Math.fround(-1e6),
            // Use the largest representable float strictly less than 0.1.
            max: Math.fround(0.1 - 1e-6),
            noNaN: true,
            noDefaultInfinity: true,
        });
        const arbAbove = fc.float({
            min: Math.fround(5.0 + 1e-6),
            max: Math.fround(1e6),
            noNaN: true,
            noDefaultInfinity: true,
        });
        const arbBadEpsilon = fc.oneof(
            arbBelow,
            arbAbove,
            fc.constant(Number.NaN),
            fc.constant(Number.POSITIVE_INFINITY),
            fc.constant(Number.NEGATIVE_INFINITY),
        );

        fc.assert(
            fc.property(arbPolyline, arbBadEpsilon, (poly, eps) => {
                expect(() => rdpSimplify(poly, eps)).toThrow(RangeError);
            }),
            { numRuns: 500 },
        );
    });
});
