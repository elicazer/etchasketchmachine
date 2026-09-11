/**
 * Property-based tests for the `Connector_Router`'s route *geometry*.
 *
 * This file holds the geometry-facing correctness properties of
 * `routeConnector` (Design §"Correctness Properties"). It currently implements
 * **Property 10** (envelope containment) and is structured so **Property 15**
 * (Hidden/Exposed classification & conservation, spec task 10.10) can be
 * appended below the shared generators without restructuring.
 *
 * Library: fast-check, ≥100 iterations per property, matching the conventions
 * of the sibling `*.props.test.ts` files in this directory.
 *
 * @see web/src/path/connector_router.ts
 * @see Design: Hidden Connector Routing (Properties 10, 15)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { routeConnector, DrawnInkIndex, classifyRoute } from './connector_router';
import type { StepEnvelope } from './connector_router';
import type { Point, PlannedSegment } from '../types';

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

const NUM_RUNS = 200;

/**
 * Walk the integer motor-step positions traversed along the move `a → b`, one
 * Chebyshev step at a time (integer DDA) — mirrors the router's own internal
 * stepping so the test charges the same positions the machine physically
 * visits. Yields `max(|dx|,|dy|) + 1` points starting at `a`, ending at `b`.
 */
function* walkLineSteps(a: Point, b: Point): Generator<Point> {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const n = Math.max(Math.abs(dx), Math.abs(dy));
    if (n === 0) {
        yield { x: a.x, y: a.y };
        return;
    }
    for (let i = 0; i <= n; i++) {
        yield {
            x: a.x + Math.round((dx * i) / n),
            y: a.y + Math.round((dy * i) / n),
        };
    }
}

const isInteger = (v: number): boolean => Number.isInteger(v);

// -----------------------------------------------------------------------------
// Shared generators — constrained to the documented input space.
//
// An envelope is generated first; connector endpoints and all ink points are
// then drawn strictly inside that inclusive `[0,env.x] × [0,env.y]` box (Req
// 4.1), exactly as the planner only ever feeds the router in-envelope geometry.
// Ink is a mix of axis-aligned and diagonal strokes so collinear-within-1-step
// coverage (and therefore genuinely routed, multi-point connectors) is
// exercised alongside the straight fallback.
// -----------------------------------------------------------------------------

const arbEnv: fc.Arbitrary<StepEnvelope> = fc.record({
    x: fc.integer({ min: 1, max: 120 }),
    y: fc.integer({ min: 1, max: 120 }),
});

/** An integer point inside the inclusive envelope. */
function arbPointIn(env: StepEnvelope): fc.Arbitrary<Point> {
    return fc.record({
        x: fc.integer({ min: 0, max: env.x }),
        y: fc.integer({ min: 0, max: env.y }),
    });
}

/** A polyline of 2..6 in-envelope integer points (a single drawn stroke). */
function arbStrokeIn(env: StepEnvelope): fc.Arbitrary<Point[]> {
    return fc.array(arbPointIn(env), { minLength: 2, maxLength: 6 });
}

/**
 * A `DrawnInkIndex` populated with 0..8 in-envelope strokes. Returned alongside
 * the raw stroke list so a later property (15) can re-inspect the ink if needed.
 */
function arbInk(
    env: StepEnvelope,
): fc.Arbitrary<{ ink: DrawnInkIndex; strokes: Point[][] }> {
    return fc.array(arbStrokeIn(env), { minLength: 0, maxLength: 8 }).map((strokes) => {
        const ink = new DrawnInkIndex(env);
        for (const pts of strokes) {
            const seg: PlannedSegment = { kind: 'stroke', pointsSteps: pts };
            ink.add(seg);
        }
        return { ink, strokes };
    });
}

/** A full router scenario: envelope, ink, and the connector's two endpoints. */
interface Scenario {
    env: StepEnvelope;
    ink: DrawnInkIndex;
    strokes: Point[][];
    exit: Point;
    entry: Point;
}

const arbScenario: fc.Arbitrary<Scenario> = arbEnv.chain((env) =>
    fc.record({
        env: fc.constant(env),
        inkBundle: arbInk(env),
        exit: arbPointIn(env),
        entry: arbPointIn(env),
    }).map(({ inkBundle, exit, entry }) => ({
        env,
        ink: inkBundle.ink,
        strokes: inkBundle.strokes,
        exit,
        entry,
    }))
        // A connector by definition bridges a NON-ZERO gap: the stitcher only emits
        // a connector when `segStart != current`, so `routeConnector` is never
        // called with coincident endpoints in the real pipeline. `exit === entry`
        // is outside the valid input domain (Req 2.2's ≥2 points and Req 2.3's no
        // zero-length sub-segments are only jointly satisfiable for distinct
        // endpoints), so we filter it out.
        .filter(({ exit, entry }) => exit.x !== entry.x || exit.y !== entry.y),
);

// -----------------------------------------------------------------------------
// Property 10 — Envelope containment of every traversed step
// -----------------------------------------------------------------------------

describe('routeConnector — Property 10 (envelope containment)', () => {
    /**
     * **Validates: Requirements 4.1, 4.2, 4.3**
     *
     * For all emitted connectors (routed or the straight fallback), every route
     * point is an integer inside the inclusive envelope `0 ≤ x ≤ env.x`,
     * `0 ≤ y ≤ env.y` (Req 4.1, 4.2), AND every integer motor-step position
     * traversed between adjacent route points also lies within that envelope
     * (Req 4.3). The fallback is included because between two in-envelope
     * endpoints it is always itself in-envelope (the box is Chebyshev-convex),
     * so the invariant must hold for every outcome the router can emit.
     */
    // Feature: hidden-connector-routing, Property 10: Envelope containment of every traversed step
    it('every route point and every traversed integer step lies within the inclusive envelope', () => {
        fc.assert(
            fc.property(arbScenario, ({ env, ink, exit, entry }) => {
                const result = routeConnector(exit, entry, ink, env);
                const pts = result.segment.pointsSteps;

                // Req 4.1 / 4.2: every route point is an integer inside the box.
                for (const p of pts) {
                    expect(isInteger(p.x)).toBe(true);
                    expect(isInteger(p.y)).toBe(true);
                    expect(p.x).toBeGreaterThanOrEqual(0);
                    expect(p.x).toBeLessThanOrEqual(env.x);
                    expect(p.y).toBeGreaterThanOrEqual(0);
                    expect(p.y).toBeLessThanOrEqual(env.y);
                }

                // Req 4.3: every integer step traversed along each leg is in-box.
                for (let i = 0; i + 1 < pts.length; i++) {
                    for (const step of walkLineSteps(pts[i]!, pts[i + 1]!)) {
                        expect(isInteger(step.x)).toBe(true);
                        expect(isInteger(step.y)).toBe(true);
                        expect(step.x).toBeGreaterThanOrEqual(0);
                        expect(step.x).toBeLessThanOrEqual(env.x);
                        expect(step.y).toBeGreaterThanOrEqual(0);
                        expect(step.y).toBeLessThanOrEqual(env.y);
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 15 — Hidden/Exposed classification and conservation
// -----------------------------------------------------------------------------

describe('routeConnector — Property 15 (Hidden/Exposed classification & conservation)', () => {
    /**
     * **Validates: Requirements 1.4, 10.1, 10.3, 10.4**
     *
     * For every emitted connector (routed or the straight fallback):
     *
     *  - **Classification (Req 1.4, 10.1):** every unit Chebyshev step charged
     *    as Hidden_Travel is genuinely collinear-with and contained-within some
     *    `Drawn_Ink` piece or `Step_Envelope` perimeter edge to within 1 integer
     *    step — i.e. `ink.isHidden(prev, step)` is `true` for it.
     *  - **Gap → Exposed (Req 10.3):** every unit step charged as Exposed is a
     *    gap step that is NOT coverable by existing ink — `ink.isHidden` is
     *    `false`. A leg in open space (gap > 1 step) is therefore counted whole
     *    as Exposed_Travel.
     *  - **Conservation (Req 10.4):** `hiddenTravel + exposedTravel ==
     *    totalTravel` exactly, with each traversed step counted in exactly one
     *    category, and `totalTravel` equals the sum of the per-leg Chebyshev
     *    lengths of the emitted route.
     *
     * The exported `classifyRoute` is used to verify the accounting the router
     * itself reports on the emitted route: the `ConnectorResult` travel fields
     * must agree with a fresh classification of `segment.pointsSteps` against
     * the same ink.
     */
    // Feature: hidden-connector-routing, Property 15: Hidden/Exposed classification and conservation
    it('classifies each step as Hidden iff covered, and hiddenTravel + exposedTravel == totalTravel', () => {
        fc.assert(
            fc.property(arbScenario, ({ env, ink, exit, entry }) => {
                const result = routeConnector(exit, entry, ink, env);
                const pts = result.segment.pointsSteps;

                // --- Independent per-step recomputation against the same ink ---
                // Mirror the router's own integer DDA stepping (Req 10.1/10.3):
                // walk each adjacent leg one Chebyshev step at a time, charging
                // each step to exactly one category and verifying the charge.
                let hidden = 0;
                let exposed = 0;
                let total = 0;

                for (let i = 0; i + 1 < pts.length; i++) {
                    const a = pts[i]!;
                    const b = pts[i + 1]!;
                    total += Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));

                    let prev: Point | null = null;
                    for (const step of walkLineSteps(a, b)) {
                        if (prev !== null) {
                            const covered = ink.isHidden(prev, step);
                            if (covered) {
                                // Req 1.4 / 10.1: a Hidden step is collinear-and-
                                // contained within ink/edge to within 1 step.
                                hidden++;
                            } else {
                                // Req 10.3: an uncovered gap step is Exposed.
                                exposed++;
                            }
                            // Every step lands in exactly one category — the
                            // branch above is total and mutually exclusive.
                        }
                        prev = step;
                    }
                }

                // Conservation of the independent recomputation (Req 10.4).
                expect(hidden + exposed).toBe(total);
                expect(isInteger(hidden)).toBe(true);
                expect(isInteger(exposed)).toBe(true);
                expect(hidden).toBeGreaterThanOrEqual(0);
                expect(exposed).toBeGreaterThanOrEqual(0);

                // --- Cross-check via the exported classifyRoute helper ---
                const cls = classifyRoute(pts, ink);
                expect(cls.hiddenTravel).toBe(hidden);
                expect(cls.exposedTravel).toBe(exposed);
                expect(cls.totalTravel).toBe(total);
                // Conservation as reported by classifyRoute (Req 10.4).
                expect(cls.hiddenTravel + cls.exposedTravel).toBe(cls.totalTravel);

                // --- The router's reported accounting must agree (Req 10.4) ---
                // The straight 2-point fallback represents the *un-hidden*
                // connector: by design it reports its full Chebyshev length as
                // Exposed_Travel regardless of any incidental ink it grazes
                // (mirroring off-mode accounting). The classifyRoute cross-check
                // of the router's own travel fields therefore applies to emitted
                // *routed* connectors; for the fallback we assert the all-Exposed
                // accounting and conservation directly.
                if (result.fellBack) {
                    expect(result.hiddenTravel).toBe(0);
                    expect(result.exposedTravel).toBe(result.totalTravel);
                    expect(result.totalTravel).toBe(cls.totalTravel);
                } else {
                    expect(result.hiddenTravel).toBe(cls.hiddenTravel);
                    expect(result.exposedTravel).toBe(cls.exposedTravel);
                    expect(result.totalTravel).toBe(cls.totalTravel);
                }
                expect(result.hiddenTravel + result.exposedTravel).toBe(result.totalTravel);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
