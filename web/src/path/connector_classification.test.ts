import { describe, it, expect } from 'vitest';
import { DrawnInkIndex, classifyRoute } from './connector_router';
import type { StepEnvelope } from './connector_router';
import type { Point, PlannedSegment } from '../types';

/**
 * Unit tests for overlap classification and Chebyshev conservation
 * (`classifyRoute`) — spec task 3.2, design §"Route, classification, and
 * Chebyshev accounting".
 *
 * These cover, on hand-built routes:
 *   - a leg lying on Drawn_Ink is fully Hidden_Travel (Req 10.1);
 *   - a gap leg with no covering ink is fully Exposed_Travel (Req 10.3);
 *   - a partly-covered leg splits exactly at the coverage boundary (Req 10.3);
 *   - a leg hugging an envelope perimeter edge is fully Hidden_Travel (Req 1.4);
 *   - `hiddenTravel + exposedTravel == totalTravel` exactly, with each step
 *     counted once (Req 10.4).
 *
 * Property-based coverage of these invariants over random inputs lives in
 * `connector_router.geometry.props.test.ts` (spec task 10.10).
 */

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Build a stroke `PlannedSegment` from an ordered list of integer-step points. */
function stroke(points: Point[]): PlannedSegment {
    return { kind: 'stroke', pointsSteps: points.map((p) => ({ x: p.x, y: p.y })) };
}

/** Chebyshev distance `max(|dx|, |dy|)` between two integer-step points. */
function cheby(a: Point, b: Point): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Total Chebyshev length of a hand-built route (sum over adjacent legs). */
function routeLength(points: Point[]): number {
    let total = 0;
    for (let i = 0; i + 1 < points.length; i++) total += cheby(points[i], points[i + 1]);
    return total;
}

// cellSize 1 ⇒ each integer step maps to its own grid cell, so per-step
// coverage probes always read the step's own cell (mirrors drawn_ink_index.test).
const ENV: StepEnvelope = { x: 100, y: 100 };

// -----------------------------------------------------------------------------
// A leg lying on ink is fully Hidden
// -----------------------------------------------------------------------------

describe('classifyRoute: a leg lying on Drawn_Ink is Hidden', () => {
    it('charges a horizontal leg that retraces ink entirely as Hidden_Travel', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 10, y: 40 };
        const b: Point = { x: 30, y: 40 };
        idx.add(stroke([a, b]));

        const result = classifyRoute([a, b], idx);

        expect(result.totalTravel).toBe(20);
        expect(result.hiddenTravel).toBe(20);
        expect(result.exposedTravel).toBe(0);
    });

    it('charges a diagonal leg that retraces diagonal ink entirely as Hidden_Travel', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 10, y: 10 };
        const b: Point = { x: 28, y: 28 };
        idx.add(stroke([a, b]));

        const result = classifyRoute([a, b], idx);

        expect(result.totalTravel).toBe(18);
        expect(result.hiddenTravel).toBe(18);
        expect(result.exposedTravel).toBe(0);
    });
});

// -----------------------------------------------------------------------------
// A gap leg with no covering ink is fully Exposed
// -----------------------------------------------------------------------------

describe('classifyRoute: a gap leg is Exposed', () => {
    it('charges an interior leg with no covering ink entirely as Exposed_Travel', () => {
        // No strokes added; the leg sits in the interior, away from any
        // perimeter edge, so nothing covers it.
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 40, y: 40 };
        const b: Point = { x: 60, y: 40 };

        const result = classifyRoute([a, b], idx);

        expect(result.totalTravel).toBe(20);
        expect(result.hiddenTravel).toBe(0);
        expect(result.exposedTravel).toBe(20);
    });

    it('charges a leg far from collinear ink (offset beyond tolerance) as Exposed_Travel', () => {
        // Horizontal ink at y=40; a parallel leg offset by 3 steps is collinear
        // but more than 1 step away, so coverage never applies and it stays
        // fully Exposed.
        const idx = new DrawnInkIndex(ENV, 1);
        idx.add(stroke([{ x: 10, y: 40 }, { x: 70, y: 40 }]));

        const a: Point = { x: 20, y: 43 };
        const b: Point = { x: 60, y: 43 };
        const result = classifyRoute([a, b], idx);

        expect(result.totalTravel).toBe(40);
        expect(result.exposedTravel).toBe(40);
        expect(result.hiddenTravel).toBe(0);
    });
});

// -----------------------------------------------------------------------------
// A partly-covered leg splits at the coverage boundary
// -----------------------------------------------------------------------------

describe('classifyRoute: a partly-covered leg splits at the coverage boundary', () => {
    it('splits a leg at the exact integer step where ink coverage ends', () => {
        // Ink covers [10,40]..[20,40]; the leg continues to [30,40], so the
        // first 10 steps are Hidden and the trailing 10 steps are Exposed.
        const idx = new DrawnInkIndex(ENV, 1);
        idx.add(stroke([{ x: 10, y: 40 }, { x: 20, y: 40 }]));

        const a: Point = { x: 10, y: 40 };
        const b: Point = { x: 30, y: 40 };
        const result = classifyRoute([a, b], idx);

        expect(result.totalTravel).toBe(20);
        expect(result.hiddenTravel).toBe(10);
        expect(result.exposedTravel).toBe(10);
    });

    it('splits a leg covered only in its middle into exposed/hidden/exposed runs', () => {
        // Ink covers the middle [30,40]..[50,40] of a [20,40]..[60,40] leg.
        const idx = new DrawnInkIndex(ENV, 1);
        idx.add(stroke([{ x: 30, y: 40 }, { x: 50, y: 40 }]));

        const a: Point = { x: 20, y: 40 };
        const b: Point = { x: 60, y: 40 };
        const result = classifyRoute([a, b], idx);

        expect(result.totalTravel).toBe(40);
        // 20 covered steps in the middle, 10 exposed on each side.
        expect(result.hiddenTravel).toBe(20);
        expect(result.exposedTravel).toBe(20);
    });
});

// -----------------------------------------------------------------------------
// An envelope-edge leg is fully Hidden
// -----------------------------------------------------------------------------

describe('classifyRoute: an envelope-edge leg is fully Hidden', () => {
    it('charges a leg hugging the left perimeter edge as Hidden_Travel (no strokes)', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 0, y: 10 };
        const b: Point = { x: 0, y: 30 };

        const result = classifyRoute([a, b], idx);

        expect(result.totalTravel).toBe(20);
        expect(result.hiddenTravel).toBe(20);
        expect(result.exposedTravel).toBe(0);
    });

    it('charges a leg hugging the bottom perimeter edge as Hidden_Travel (no strokes)', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const a: Point = { x: 20, y: 0 };
        const b: Point = { x: 70, y: 0 };

        const result = classifyRoute([a, b], idx);

        expect(result.totalTravel).toBe(50);
        expect(result.hiddenTravel).toBe(50);
        expect(result.exposedTravel).toBe(0);
    });
});

// -----------------------------------------------------------------------------
// Conservation: hidden + exposed == total for hand-built routes
// -----------------------------------------------------------------------------

describe('classifyRoute: hidden + exposed == total (conservation)', () => {
    it('conserves on a multi-leg route mixing hidden, exposed, and edge travel', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        idx.add(stroke([{ x: 10, y: 40 }, { x: 30, y: 40 }]));
        idx.add(stroke([{ x: 50, y: 20 }, { x: 50, y: 60 }]));

        // exit on ink → along ink → across a gap → along other ink → off into
        // the interior, with a final leg hugging the bottom edge.
        const route: Point[] = [
            { x: 10, y: 40 }, // start on horizontal ink
            { x: 30, y: 40 }, // hidden along it
            { x: 50, y: 40 }, // exposed gap across to the vertical ink
            { x: 50, y: 60 }, // hidden along the vertical ink
            { x: 80, y: 80 }, // exposed into the interior
        ];

        const result = classifyRoute(route, idx);

        expect(result.totalTravel).toBe(routeLength(route));
        expect(result.hiddenTravel + result.exposedTravel).toBe(result.totalTravel);
        expect(result.hiddenTravel).toBeGreaterThan(0);
        expect(result.exposedTravel).toBeGreaterThan(0);
    });

    it('conserves on an all-exposed interior route', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const route: Point[] = [
            { x: 40, y: 40 },
            { x: 60, y: 45 },
            { x: 55, y: 70 },
        ];

        const result = classifyRoute(route, idx);

        expect(result.totalTravel).toBe(routeLength(route));
        expect(result.hiddenTravel + result.exposedTravel).toBe(result.totalTravel);
        expect(result.hiddenTravel).toBe(0);
        expect(result.exposedTravel).toBe(result.totalTravel);
    });

    it('treats a degenerate (zero-length) leg as contributing no travel', () => {
        const idx = new DrawnInkIndex(ENV, 1);
        const route: Point[] = [
            { x: 40, y: 40 },
            { x: 40, y: 40 }, // duplicate point: zero-length leg
            { x: 50, y: 40 },
        ];

        const result = classifyRoute(route, idx);

        expect(result.totalTravel).toBe(10);
        expect(result.hiddenTravel + result.exposedTravel).toBe(result.totalTravel);
    });
});
