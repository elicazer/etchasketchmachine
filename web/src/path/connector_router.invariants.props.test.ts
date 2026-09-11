/**
 * Property-based tests for the `Connector_Router`'s emitted-connector
 * **structural invariants** — the per-connector guarantees that hold for every
 * emitted segment regardless of the ink, endpoints, or envelope.
 *
 * This file groups the router's invariant properties so each can be appended
 * independently:
 *
 *   - Property 5  — point-count bound and segment kind   (this file, task 10.4)
 *   - Property 6  — no zero-length sub-segments          (task 10.5)
 *   - Property 7  — consecutive-duplicate collapse       (task 10.6)
 *
 * Library: fast-check (already used across `web/src`). Minimum 100 iterations
 * per property, per the design's Testing Strategy.
 *
 * @see web/src/path/connector_router.ts
 * @see Design: Hidden Connector Routing (Correctness Properties 5–7)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DrawnInkIndex, routeConnector } from './connector_router';
import type { RouterOptions, StepEnvelope } from './connector_router';
import type { Point, PlannedSegment } from '../types';

// -----------------------------------------------------------------------------
// Shared helpers & generators (used by Properties 5–7)
// -----------------------------------------------------------------------------

const NUM_RUNS = 200;

/** Collapse runs of identical consecutive points (well-formed ink input). */
function dedupeConsecutive(poly: Point[]): Point[] {
    const out: Point[] = [];
    for (const p of poly) {
        const prev = out[out.length - 1];
        if (prev === undefined || prev.x !== p.x || prev.y !== p.y) {
            out.push({ x: p.x, y: p.y });
        }
    }
    return out;
}

/** Build a stroke `PlannedSegment` from an ordered list of integer-step points. */
function stroke(points: Point[]): PlannedSegment {
    return { kind: 'stroke', pointsSteps: points.map((p) => ({ x: p.x, y: p.y })) };
}

/**
 * A single routing scenario: an envelope, the set of already-drawn ink
 * polylines (all in-envelope, integer steps), the connector endpoints, and
 * optional router tuning. Generated together so points always lie inside the
 * envelope the index is built for.
 */
interface Scenario {
    env: StepEnvelope;
    ink: Point[][];
    exit: Point;
    entry: Point;
    // The generator always emits the `opts` key (via `fc.option(..., { nil: undefined })`),
    // so under `exactOptionalPropertyTypes` the present-but-undefined value must be
    // part of the declared type. `routeConnector`'s optional `opts?` param accepts it.
    opts?: RouterOptions | undefined;
}

/**
 * Scenario generator. The envelope is chosen first, then every point (ink and
 * endpoints) is drawn inside `[0,env.x] × [0,env.y]`. Some ink is generated to
 * deliberately straddle the exit→entry corridor so the routed multi-point path
 * (not just the straight fallback) is exercised; degenerate cases (empty ink,
 * corner endpoints) arise naturally from the ranges. Coincident endpoints
 * (`exit === entry`) are filtered out — see the `.filter` below.
 */
const arbScenario: fc.Arbitrary<Scenario> = fc
    .record({
        envX: fc.integer({ min: 4, max: 80 }),
        envY: fc.integer({ min: 4, max: 80 }),
    })
    .chain(({ envX, envY }) => {
        const coord = fc.record({
            x: fc.integer({ min: 0, max: envX }),
            y: fc.integer({ min: 0, max: envY }),
        });
        const polyline = fc
            .array(coord, { minLength: 1, maxLength: 6 })
            .map(dedupeConsecutive);
        return fc
            .record({
                env: fc.constant<StepEnvelope>({ x: envX, y: envY }),
                ink: fc.array(polyline, { minLength: 0, maxLength: 8 }),
                exit: coord,
                entry: coord,
                opts: fc.option(
                    fc.record({
                        maxCandidates: fc.integer({ min: 1, max: 64 }),
                    }),
                    { nil: undefined },
                ),
            })
            // A connector by definition bridges a NON-ZERO gap: the stitcher
            // (`stitchPolylines` in ../stitch.ts) only emits a connector when
            // `segStart != current`, so `routeConnector` is never called with
            // coincident endpoints in the real pipeline. Coincident endpoints
            // are thus outside the valid input domain — and necessarily so:
            // Req 2.2 (every connector has ≥ 2 points) and Req 2.3 (no
            // zero-length sub-segments) are jointly satisfiable ONLY when the
            // endpoints are distinct. Filtering `exit === entry` keeps the
            // generator inside that valid domain.
            .filter(({ exit, entry }) => exit.x !== entry.x || exit.y !== entry.y);
    });

/** Build a populated `DrawnInkIndex` for a scenario (cellSize 1 for fidelity). */
function buildInk(scenario: Scenario): DrawnInkIndex {
    const idx = new DrawnInkIndex(scenario.env, 1);
    for (const poly of scenario.ink) {
        if (poly.length >= 2) idx.add(stroke(poly));
    }
    return idx;
}

// -----------------------------------------------------------------------------
// Feature: hidden-connector-routing, Property 5: Point-count bound and segment kind
// -----------------------------------------------------------------------------

/**
 * **Property 5: Point-count bound and segment kind**
 *
 * *For all* emitted connectors, the segment has `kind: 'connector'` and its
 * `pointsSteps` length is at least 2 and at most 1000.
 *
 * **Validates: Requirements 2.2, 2.7**
 */
describe('routeConnector — Property 5 (point-count bound and segment kind)', () => {
    it("every emitted connector has kind 'connector' and 2 ≤ pointsSteps.length ≤ 1000", () => {
        fc.assert(
            fc.property(arbScenario, (scenario) => {
                const ink = buildInk(scenario);
                const result = routeConnector(
                    scenario.exit,
                    scenario.entry,
                    ink,
                    scenario.env,
                    scenario.opts,
                );

                expect(result.segment.kind).toBe('connector');
                expect(result.segment.pointsSteps.length).toBeGreaterThanOrEqual(2);
                expect(result.segment.pointsSteps.length).toBeLessThanOrEqual(1000);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Feature: hidden-connector-routing, Property 6: No zero-length sub-segments
// -----------------------------------------------------------------------------

/**
 * **Property 6: No zero-length sub-segments**
 *
 * *For all* emitted connectors, every adjacent point pair differs in at least
 * one integer step coordinate (x or y) — preserving the no-zero-length
 * sub-segment invariant after consecutive-duplicate collapse.
 *
 * **Validates: Requirements 2.3**
 */
describe('routeConnector — Property 6 (no zero-length sub-segments)', () => {
    it('every adjacent point pair in an emitted connector differs in ≥ 1 integer coordinate', () => {
        fc.assert(
            fc.property(arbScenario, (scenario) => {
                const ink = buildInk(scenario);
                const result = routeConnector(
                    scenario.exit,
                    scenario.entry,
                    ink,
                    scenario.env,
                    scenario.opts,
                );

                const pts = result.segment.pointsSteps;
                for (let i = 1; i < pts.length; i++) {
                    const prev = pts[i - 1];
                    const cur = pts[i];
                    // At least one of x or y must differ → non-zero-length leg.
                    expect(prev.x !== cur.x || prev.y !== cur.y).toBe(true);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Feature: hidden-connector-routing, Property 7: Consecutive-duplicate collapse
// -----------------------------------------------------------------------------

/**
 * Reference implementation of the consecutive-duplicate collapse operation
 * described in the design (Routing Algorithm → "Guards before emit"): collapse
 * each run of consecutive identical points to a single occurrence while
 * preserving the route's first and last points unchanged. The router applies
 * this collapse internally before emitting a connector; `connector_router.ts`
 * does not export the helper, so we mirror it here and property-test ITS
 * invariants (no consecutive duplicates, first/last preserved, idempotent),
 * then confirm the router's emitted connectors already satisfy the
 * no-consecutive-duplicates invariant the collapse guarantees.
 */
function collapse(points: Point[]): Point[] {
    if (points.length === 0) return [];
    const out: Point[] = [{ x: points[0].x, y: points[0].y }];
    for (let i = 1; i < points.length; i++) {
        const prev = out[out.length - 1];
        const cur = points[i];
        if (prev.x !== cur.x || prev.y !== cur.y) {
            out.push({ x: cur.x, y: cur.y });
        }
    }
    return out;
}

const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

/**
 * Generator of arbitrary integer-step point routes that deliberately contain
 * consecutive duplicates: pick a base sequence of points, then repeat each
 * point a random number of times so runs of identical consecutive points are
 * common. This exercises the collapse invariants on the inputs they are meant
 * to normalize.
 */
const arbRouteWithDuplicates: fc.Arbitrary<Point[]> = fc
    .array(
        fc.record({
            x: fc.integer({ min: -50, max: 50 }),
            y: fc.integer({ min: -50, max: 50 }),
        }),
        { minLength: 1, maxLength: 12 },
    )
    .chain((base) =>
        fc
            .array(fc.integer({ min: 1, max: 4 }), {
                minLength: base.length,
                maxLength: base.length,
            })
            .map((repeats) => {
                const out: Point[] = [];
                base.forEach((p, i) => {
                    for (let r = 0; r < repeats[i]; r++) out.push({ x: p.x, y: p.y });
                });
                return out;
            }),
    );

/**
 * **Property 7: Consecutive-duplicate collapse**
 *
 * *For all* routes, collapsing consecutive identical points yields a sequence
 * with no consecutive duplicates, preserves the first and last points
 * unchanged, and is idempotent (collapsing again is a no-op).
 *
 * Also asserts the router's own emitted connectors already satisfy the
 * no-consecutive-duplicates invariant (the router applies collapse internally).
 *
 * **Validates: Requirements 2.4**
 */
describe('routeConnector — Property 7 (consecutive-duplicate collapse)', () => {
    it('collapse yields no consecutive duplicates, preserves first/last, and is idempotent', () => {
        fc.assert(
            fc.property(arbRouteWithDuplicates, (route) => {
                const collapsed = collapse(route);

                // No consecutive duplicates remain.
                for (let i = 1; i < collapsed.length; i++) {
                    expect(samePoint(collapsed[i - 1], collapsed[i])).toBe(false);
                }

                // First and last points preserved exactly.
                expect(collapsed[0]).toEqual(route[0]);
                expect(collapsed[collapsed.length - 1]).toEqual(route[route.length - 1]);

                // Idempotent: collapsing again is a no-op.
                expect(collapse(collapsed)).toEqual(collapsed);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('every emitted connector already has no consecutive duplicate points', () => {
        fc.assert(
            fc.property(arbScenario, (scenario) => {
                const ink = buildInk(scenario);
                const result = routeConnector(
                    scenario.exit,
                    scenario.entry,
                    ink,
                    scenario.env,
                    scenario.opts,
                );

                const pts = result.segment.pointsSteps;
                for (let i = 1; i < pts.length; i++) {
                    expect(samePoint(pts[i - 1], pts[i])).toBe(false);
                }
                // Collapse is a no-op on an already-collapsed emitted connector.
                expect(collapse(pts)).toEqual(pts);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
