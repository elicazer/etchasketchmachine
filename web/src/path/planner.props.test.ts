import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PathPlanner, totalStepCount } from './planner';
import type { PlannedPath, PlannedSegment, Point, SegmentKind } from '../types';

/**
 * Property-based test for the headline drawing-time estimate.
 *
 * Implements **Property 26: Estimated drawing time formula** (Design §7).
 *
 * **Validates: Requirements 8.2, 8.3, 14.4, 14.5**
 *
 * Design §7, Property 26:
 *   For any `PlannedPath` `prog` and constant `feed_sps ∈ [100, 1000]`, the
 *   estimated drawing time equals `Σ_segments(segment_length_steps) / feed_sps`
 *   (the displayed total path length includes connector segments). The
 *   per-move step count is the Bresenham step count `max(|dx|, |dy|)` summed
 *   over every inter-vertex move of every segment — strokes and connectors
 *   alike, since connector travel is real motion.
 *
 * `PathPlanner.estimateMillis` returns `totalStepCount(path) / feed_sps * 1000`
 * milliseconds, and `totalStepCount` is the connector-inclusive step total used
 * for the "total path length in steps" readout (Req 8.3, 14.5). This file pins
 * the universal laws of that formula:
 *
 *   1. FORMULA          — estimate == totalStepCount / feed * 1000.
 *   2. SCALING          — scaling the feed by k scales the time by 1/k.
 *   3. ADDITIVITY        — the path total is the sum of per-segment Bresenham
 *                         step counts, and the whole-path estimate is the sum
 *                         of the per-segment estimates at the same feed.
 *   4. ZERO / EMPTY     — an empty path (and a path of only zero-length moves)
 *                         estimates to 0 ms.
 *   5. MONOTONICITY     — appending a segment never decreases the estimate;
 *                         a higher feed never increases the time.
 *   6. DOMAIN           — a non-positive (or non-finite) feed throws RangeError.
 *
 * The deterministic worked examples (max(|dx|,|dy|) per move, the empty path,
 * the non-positive-feed throw) live in `planner.test.ts`; this file covers the
 * universal laws across the whole input space.
 *
 * @see web/src/path/planner.ts
 * @see Design §3.1.4 (planner), §7 (Property 26)
 */

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const planner = new PathPlanner();

/**
 * Independent reference for the Bresenham step count of one segment:
 * `Σ max(|dx|, |dy|)` over its consecutive inter-vertex moves. Zero-length
 * moves contribute 0, matching `totalStepCount`'s treatment of them.
 */
function segmentStepCount(seg: PlannedSegment): number {
    let total = 0;
    const pts = seg.pointsSteps;
    for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k]!;
        const b = pts[k + 1]!;
        total += Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    return total;
}

/** Wrap a single segment in a standalone PlannedPath for additivity checks. */
function singleSegmentPath(path: PlannedPath, seg: PlannedSegment): PlannedPath {
    return { drawableSteps: path.drawableSteps, segments: [seg] };
}

/**
 * Relative-or-absolute float closeness. The formula reorders a multiply and a
 * divide between branches (e.g. `(n*1000)/f` vs `(n*1000/f)/k`), so the two
 * sides agree only up to floating-point rounding, not bit-for-bit.
 */
function approxEqual(a: number, b: number, relTol = 1e-9, absTol = 1e-6): boolean {
    return Math.abs(a - b) <= Math.max(absTol, relTol * Math.max(Math.abs(a), Math.abs(b)));
}

// -----------------------------------------------------------------------------
// Generators — arbitrary PlannedPaths in integer-step space.
// -----------------------------------------------------------------------------

/** Integer motor-step coordinate over a bounded range. */
const arbCoord: fc.Arbitrary<number> = fc.integer({ min: 0, max: 1000 });

const arbPoint: fc.Arbitrary<Point> = fc.record({ x: arbCoord, y: arbCoord });

const arbKind: fc.Arbitrary<SegmentKind> = fc.constantFrom('stroke', 'connector');

/**
 * A segment of 2..6 integer-step points of either kind. Consecutive points are
 * NOT de-duplicated: `totalStepCount` treats a zero-length move as 0 steps, so
 * leaving them in exercises that path rather than hiding it.
 */
const arbSegment: fc.Arbitrary<PlannedSegment> = fc.record({
    kind: arbKind,
    pointsSteps: fc.array(arbPoint, { minLength: 2, maxLength: 6 }),
});

/** Drawable rectangle — irrelevant to the estimate, but required on the type. */
const arbDrawableSteps = fc.record({
    w: fc.integer({ min: 1, max: 4096 }),
    h: fc.integer({ min: 1, max: 4096 }),
});

/** 0..8 segments — the empty path is a valid, in-range input. */
const arbPath: fc.Arbitrary<PlannedPath> = fc.record({
    drawableSteps: arbDrawableSteps,
    segments: fc.array(arbSegment, { minLength: 0, maxLength: 8 }),
});

/** In-range feed rate in steps-per-second (Req 14.5: feed_sps ∈ [100, 1000]). */
const arbFeed: fc.Arbitrary<number> = fc.double({
    min: 100,
    max: 1000,
    noNaN: true,
    noDefaultInfinity: true,
});

/** Positive scale factor for the feed used in the scaling-invariance law. */
const arbScale: fc.Arbitrary<number> = fc.double({
    min: 0.1,
    max: 10,
    noNaN: true,
    noDefaultInfinity: true,
});

/** Non-positive feed rate — the documented RangeError domain. */
const arbBadFeed: fc.Arbitrary<number> = fc.double({
    min: -1000,
    max: 0,
    noNaN: true,
    noDefaultInfinity: true,
});

const NUM_RUNS = 300;

// -----------------------------------------------------------------------------
// Property 26 — Estimated drawing time formula
// -----------------------------------------------------------------------------

describe('PathPlanner.estimateMillis — Property 26 (estimated drawing time formula)', () => {
    /**
     * **Validates: Requirements 8.2, 8.3, 14.5**
     *
     * FORMULA. For every path and in-range feed,
     * `estimateMillis === totalStepCount / feed * 1000`. The estimate is the
     * connector-inclusive step total scaled by the feed.
     */
    it('formula: estimateMillis(path, feed) === totalStepCount(path) / feed * 1000', () => {
        fc.assert(
            fc.property(arbPath, arbFeed, (path, feed) => {
                const actual = planner.estimateMillis(path, feed);
                const expected = (totalStepCount(path) / feed) * 1000;
                expect(approxEqual(actual, expected)).toBe(true);
                // The estimate is a finite, non-negative duration.
                expect(Number.isFinite(actual)).toBe(true);
                expect(actual).toBeGreaterThanOrEqual(0);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 14.5**
     *
     * SCALING. Scaling the feed by k > 0 scales the time by 1/k:
     * `estimateMillis(path, k*feed) === estimateMillis(path, feed) / k`.
     */
    it('scaling: estimateMillis(path, k*feed) === estimateMillis(path, feed) / k', () => {
        fc.assert(
            fc.property(arbPath, arbFeed, arbScale, (path, feed, k) => {
                const scaled = planner.estimateMillis(path, k * feed);
                const expected = planner.estimateMillis(path, feed) / k;
                expect(approxEqual(scaled, expected)).toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 8.3, 14.4, 14.5**
     *
     * ADDITIVITY. `totalStepCount` equals the sum of the per-segment Bresenham
     * step counts (exact, integer arithmetic), and the whole-path estimate
     * equals the sum of the per-segment estimates at the same feed (up to float
     * rounding). Connector segments count exactly like strokes.
     */
    it('additivity: path total and estimate decompose over segments', () => {
        fc.assert(
            fc.property(arbPath, arbFeed, (path, feed) => {
                // Step-count additivity is exact integer arithmetic.
                const summedSteps = path.segments.reduce(
                    (acc, seg) => acc + segmentStepCount(seg),
                    0,
                );
                expect(totalStepCount(path)).toBe(summedSteps);

                // Estimate additivity holds up to float rounding.
                const whole = planner.estimateMillis(path, feed);
                const summedEstimate = path.segments.reduce(
                    (acc, seg) =>
                        acc + planner.estimateMillis(singleSegmentPath(path, seg), feed),
                    0,
                );
                expect(approxEqual(whole, summedEstimate)).toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 14.5**
     *
     * ZERO / EMPTY. A path with no segments estimates to 0 ms, and so does any
     * path whose every move is zero-length (no real motion → no time).
     */
    it('zero/empty: empty path and zero-length-only paths estimate to 0 ms', () => {
        // Empty path.
        fc.assert(
            fc.property(arbDrawableSteps, arbFeed, (drawableSteps, feed) => {
                const empty: PlannedPath = { drawableSteps, segments: [] };
                expect(planner.estimateMillis(empty, feed)).toBe(0);
            }),
            { numRuns: NUM_RUNS },
        );

        // Path whose segments repeat a single point — every move is zero-length.
        fc.assert(
            fc.property(
                arbDrawableSteps,
                fc.array(
                    fc.record({
                        kind: arbKind,
                        point: arbPoint,
                        count: fc.integer({ min: 2, max: 6 }),
                    }),
                    { minLength: 1, maxLength: 8 },
                ),
                arbFeed,
                (drawableSteps, specs, feed) => {
                    const segments: PlannedSegment[] = specs.map((s) => ({
                        kind: s.kind,
                        pointsSteps: Array.from({ length: s.count }, () => ({
                            x: s.point.x,
                            y: s.point.y,
                        })),
                    }));
                    const path: PlannedPath = { drawableSteps, segments };
                    expect(totalStepCount(path)).toBe(0);
                    expect(planner.estimateMillis(path, feed)).toBe(0);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 14.4, 14.5**
     *
     * MONOTONICITY (segments). Appending a segment to a path never decreases
     * the estimate, because step counts are non-negative.
     */
    it('monotonicity: appending a segment never decreases the estimate', () => {
        fc.assert(
            fc.property(arbPath, arbSegment, arbFeed, (path, extra, feed) => {
                const before = planner.estimateMillis(path, feed);
                const grown: PlannedPath = {
                    drawableSteps: path.drawableSteps,
                    segments: [...path.segments, extra],
                };
                const after = planner.estimateMillis(grown, feed);
                expect(after + 1e-6).toBeGreaterThanOrEqual(before);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 14.5**
     *
     * MONOTONICITY (feed). A higher feed rate never increases the drawing time
     * for the same path: `feed_lo ≤ feed_hi ⇒ estimate(feed_hi) ≤ estimate(feed_lo)`.
     */
    it('monotonicity: a higher feed never increases the time', () => {
        fc.assert(
            fc.property(arbPath, arbFeed, arbFeed, (path, f1, f2) => {
                const lo = Math.min(f1, f2);
                const hi = Math.max(f1, f2);
                const timeLo = planner.estimateMillis(path, lo);
                const timeHi = planner.estimateMillis(path, hi);
                expect(timeHi).toBeLessThanOrEqual(timeLo + 1e-6);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 14.5**
     *
     * DOMAIN. `estimateMillis` throws `RangeError` for any non-positive feed,
     * and likewise for a non-finite feed (NaN / ±Infinity).
     */
    it('domain: feedSps <= 0 throws RangeError', () => {
        fc.assert(
            fc.property(arbPath, arbBadFeed, (path, badFeed) => {
                expect(() => planner.estimateMillis(path, badFeed)).toThrow(RangeError);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('domain: a non-finite feedSps throws RangeError', () => {
        fc.assert(
            fc.property(
                arbPath,
                fc.constantFrom(NaN, Infinity, -Infinity),
                (path, badFeed) => {
                    expect(() => planner.estimateMillis(path, badFeed)).toThrow(RangeError);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
