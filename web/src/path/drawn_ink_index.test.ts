import { describe, it, expect } from 'vitest';
import { DrawnInkIndex } from './connector_router';
import type { StepEnvelope, InkSegment } from './connector_router';
import type { Point, PlannedSegment } from '../types';

/**
 * Unit tests for `DrawnInkIndex` — the uniform-grid spatial occupancy structure
 * over `Drawn_Ink` (spec task 2.1, design §"Drawn_Ink representation and the
 * spatial index").
 *
 * These cover, through the public API (`add`, `nearbyEndpoints`,
 * `coveringSegments`):
 *   - `add` registers horizontal, vertical, and diagonal sub-segments in every
 *     grid cell the groove crosses (Req 1.3, 8.1);
 *   - `nearbyEndpoints` / `coveringSegments` return only local results (Req 8.2);
 *   - the four inclusive envelope perimeter edges are routable Hidden_Travel
 *     even before any stroke is added (Req 1.4).
 *
 * Property-based coverage of the routing invariants lives in the
 * `connector_router.*.props.test.ts` suites (spec tasks 10–11).
 */

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Build a stroke `PlannedSegment` from an ordered list of integer-step points. */
function stroke(points: Point[]): PlannedSegment {
    return { kind: 'stroke', pointsSteps: points.map((p) => ({ x: p.x, y: p.y })) };
}

/** True iff `result` contains an ink piece with endpoints equal to `a`/`b`. */
function containsInk(result: InkSegment[], a: Point, b: Point): boolean {
    return result.some(
        (s) =>
            (s.a.x === a.x && s.a.y === a.y && s.b.x === b.x && s.b.y === b.y) ||
            (s.a.x === b.x && s.a.y === b.y && s.b.x === a.x && s.b.y === a.y),
    );
}

/** Integer Chebyshev step positions traversed from `a` to `b` inclusive. */
function stepsAlong(a: Point, b: Point): Point[] {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const n = Math.max(Math.abs(dx), Math.abs(dy));
    const out: Point[] = [];
    if (n === 0) return [{ x: a.x, y: a.y }];
    for (let i = 0; i <= n; i++) {
        out.push({ x: a.x + Math.round((dx * i) / n), y: a.y + Math.round((dy * i) / n) });
    }
    return out;
}

const ENV: StepEnvelope = { x: 100, y: 100 };

// -----------------------------------------------------------------------------
// add() registers sub-segments in every overlapped cell
// -----------------------------------------------------------------------------

describe('DrawnInkIndex.add registers sub-segments in all overlapped cells', () => {
    it('registers a horizontal sub-segment in every cell its groove crosses', () => {
        // cellSize 1 ⇒ each integer step maps to its own grid cell, so a query
        // at any step is guaranteed to read the step's own cell.
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 10, y: 40 };
        const b: Point = { x: 30, y: 40 };
        idx.add(stroke([a, b]));

        for (const step of stepsAlong(a, b)) {
            expect(containsInk(idx.coveringSegments(step), a, b)).toBe(true);
        }
    });

    it('registers a vertical sub-segment in every cell its groove crosses', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 40, y: 10 };
        const b: Point = { x: 40, y: 30 };
        idx.add(stroke([a, b]));

        for (const step of stepsAlong(a, b)) {
            expect(containsInk(idx.coveringSegments(step), a, b)).toBe(true);
        }
    });

    it('registers a diagonal sub-segment in every cell its groove crosses', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 10, y: 10 };
        const b: Point = { x: 28, y: 28 };
        idx.add(stroke([a, b]));

        // A diagonal must register in every crossed cell, not just bbox corners.
        for (const step of stepsAlong(a, b)) {
            expect(containsInk(idx.coveringSegments(step), a, b)).toBe(true);
        }
    });

    it('splits a multi-point stroke into one ink piece per adjacent vertex pair', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const p0: Point = { x: 10, y: 50 };
        const p1: Point = { x: 20, y: 50 };
        const p2: Point = { x: 20, y: 60 };
        idx.add(stroke([p0, p1, p2]));

        // Each leg is independently registered along its own groove.
        for (const step of stepsAlong(p0, p1)) {
            expect(containsInk(idx.coveringSegments(step), p0, p1)).toBe(true);
        }
        for (const step of stepsAlong(p1, p2)) {
            expect(containsInk(idx.coveringSegments(step), p1, p2)).toBe(true);
        }
    });

    it('registers diagonal ink with a larger cell size across multiple cells', () => {
        // With cellSize 5 a long diagonal spans many cells; querying a point at
        // the segment mid-groove still finds the ink locally.
        const idx = new DrawnInkIndex(ENV, 5);
        const a: Point = { x: 5, y: 5 };
        const b: Point = { x: 80, y: 80 };
        idx.add(stroke([a, b]));

        for (const step of stepsAlong(a, b)) {
            expect(containsInk(idx.coveringSegments(step), a, b)).toBe(true);
        }
    });
});

// -----------------------------------------------------------------------------
// coveringSegments / nearbyEndpoints return local results only
// -----------------------------------------------------------------------------

describe('DrawnInkIndex returns local results only', () => {
    it('coveringSegments does not return ink far from the query point', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 10, y: 10 };
        const b: Point = { x: 20, y: 10 };
        idx.add(stroke([a, b]));

        // A query in the opposite region (and away from any perimeter edge)
        // sees none of the ink.
        const far = idx.coveringSegments({ x: 80, y: 80 });
        expect(containsInk(far, a, b)).toBe(false);
    });

    it('nearbyEndpoints returns an endpoint within the radius and excludes far ones', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 10, y: 10 };
        const b: Point = { x: 90, y: 90 };
        idx.add(stroke([a, b]));

        const near = idx.nearbyEndpoints({ x: 12, y: 11 }, 5);
        expect(near).toContainEqual({ x: 10, y: 10 });
        // The far endpoint b is well outside the radius and excluded.
        expect(near).not.toContainEqual({ x: 90, y: 90 });
    });

    it('nearbyEndpoints returns no endpoints when none are within the radius', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        idx.add(stroke([{ x: 10, y: 10 }, { x: 20, y: 10 }]));

        expect(idx.nearbyEndpoints({ x: 80, y: 80 }, 3)).toEqual([]);
    });

    it('nearbyEndpoints honours the Chebyshev radius boundary exactly', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        idx.add(stroke([{ x: 50, y: 50 }, { x: 55, y: 50 }]));

        // Endpoint (50,50) is exactly 4 Chebyshev steps from (54,54).
        expect(idx.nearbyEndpoints({ x: 54, y: 54 }, 4)).toContainEqual({ x: 50, y: 50 });
        expect(idx.nearbyEndpoints({ x: 54, y: 54 }, 3)).not.toContainEqual({ x: 50, y: 50 });
    });

    it('nearbyEndpoints deduplicates endpoints shared by adjacent legs', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const shared: Point = { x: 40, y: 40 };
        idx.add(stroke([{ x: 30, y: 40 }, shared, { x: 50, y: 40 }]));

        const near = idx.nearbyEndpoints(shared, 0);
        expect(near.filter((p) => p.x === shared.x && p.y === shared.y)).toHaveLength(1);
    });
});

// -----------------------------------------------------------------------------
// Envelope perimeter edges present before any stroke is added
// -----------------------------------------------------------------------------

describe('DrawnInkIndex exposes envelope perimeter edges before any stroke', () => {
    it('returns the left edge for a point on the left perimeter', () => {
        const idx = new DrawnInkIndex(ENV);
        const covering = idx.coveringSegments({ x: 0, y: 50 });
        expect(containsInk(covering, { x: 0, y: 0 }, { x: 0, y: ENV.y })).toBe(true);
    });

    it('returns the right edge for a point on the right perimeter', () => {
        const idx = new DrawnInkIndex(ENV);
        const covering = idx.coveringSegments({ x: ENV.x, y: 50 });
        expect(containsInk(covering, { x: ENV.x, y: 0 }, { x: ENV.x, y: ENV.y })).toBe(true);
    });

    it('returns the bottom edge for a point on the bottom perimeter', () => {
        const idx = new DrawnInkIndex(ENV);
        const covering = idx.coveringSegments({ x: 50, y: 0 });
        expect(containsInk(covering, { x: 0, y: 0 }, { x: ENV.x, y: 0 })).toBe(true);
    });

    it('returns the top edge for a point on the top perimeter', () => {
        const idx = new DrawnInkIndex(ENV);
        const covering = idx.coveringSegments({ x: 50, y: ENV.y });
        expect(containsInk(covering, { x: 0, y: ENV.y }, { x: ENV.x, y: ENV.y })).toBe(true);
    });

    it('does not report a perimeter edge for an interior point far from the border', () => {
        const idx = new DrawnInkIndex(ENV);
        // No strokes added; an interior point sees no ink at all.
        expect(idx.coveringSegments({ x: 50, y: 50 })).toEqual([]);
    });
});
