/**
 * Property-based tests for `Connector_Router` determinism and reorder
 * invariance (Design §"Correctness Properties").
 *
 * This file hosts the two purity/determinism properties of the router:
 *
 *   - **Property 8: Determinism** (this file, task 10.7) — equal-value inputs
 *     always yield identical point sequences, and equal-Exposed / equal-total
 *     ties resolve to the lexicographically smallest route (x before y).
 *   - **Property 9: Drawn_Ink reorder invariance** (task 10.8, appended later) —
 *     shuffling the same ink value set produces identical point sequences.
 *
 * The router is a pure function of its arguments (the connector endpoints, the
 * `Drawn_Ink` set, and the `Step_Envelope`): no randomness, no wall-clock, no
 * external mutable state. So the same values must always produce the same
 * route, and the documented three-key selection order (minimise Exposed_Travel,
 * then total Chebyshev length, then lexicographically smallest point sequence)
 * must leave no tie unresolved.
 *
 * @see web/src/path/connector_router.ts
 * @see Design §"Routing Algorithm" (selection & tie-break), §"Property 8"
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    routeConnector,
    classifyRoute,
    DrawnInkIndex,
    type StepEnvelope,
} from './connector_router';
import type { Point, Polyline } from '../types';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Chebyshev distance `max(|dx|, |dy|)` — the machine's per-move step count. */
const chebyshev = (a: Point, b: Point): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * Collapse runs of identical consecutive points, mirroring the well-formed
 * (post-RDP) input space the planner feeds the index. A polyline that shrinks
 * below 2 points is simply not added as a stroke.
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
 * Build a fresh `DrawnInkIndex` over `env`, adding each ≥2-point polyline as a
 * `stroke` segment. Two indices built from equal-value inputs are equal in
 * value but distinct objects, which is exactly what the determinism property
 * needs (the router must not depend on object identity).
 */
function buildIndex(env: StepEnvelope, ink: Polyline[]): DrawnInkIndex {
    const idx = new DrawnInkIndex(env);
    for (const poly of ink) {
        if (poly.length >= 2) {
            idx.add({ kind: 'stroke', pointsSteps: poly.map((p) => ({ x: p.x, y: p.y })) });
        }
    }
    return idx;
}

// -----------------------------------------------------------------------------
// Generators — random integer-step ink/endpoints inside a random envelope.
// -----------------------------------------------------------------------------

/**
 * A full routing scenario: an envelope, a set of integer-step ink polylines
 * fully inside it, and connector endpoints inside it. Endpoints and ink share
 * the same coordinate range so the ink can plausibly cover the gap.
 */
const arbScenario = fc
    .record({
        w: fc.integer({ min: 10, max: 200 }),
        h: fc.integer({ min: 10, max: 200 }),
    })
    .chain(({ w, h }) => {
        const env: StepEnvelope = { x: w, y: h };
        const arbPt: fc.Arbitrary<Point> = fc.record({
            x: fc.integer({ min: 0, max: w }),
            y: fc.integer({ min: 0, max: h }),
        });
        const arbPoly: fc.Arbitrary<Polyline> = fc
            .array(arbPt, { minLength: 0, maxLength: 6 })
            .map(dedupeConsecutive);
        return fc.record({
            env: fc.constant(env),
            ink: fc.array(arbPoly, { minLength: 0, maxLength: 6 }),
            exit: arbPt,
            entry: arbPt,
        });
    })
    // A connector by definition bridges a NON-ZERO gap: the stitcher only emits
    // a connector when `segStart != current`, so `routeConnector` is never
    // called with coincident endpoints in the real pipeline. `exit === entry`
    // is outside the valid input domain (Req 2.2's ≥2 points and Req 2.3's no
    // zero-length sub-segments are only jointly satisfiable for distinct
    // endpoints), so we filter it out.
    .filter(({ exit, entry }) => exit.x !== entry.x || exit.y !== entry.y);

const NUM_RUNS = 200;

// -----------------------------------------------------------------------------
// Property 8 — Determinism
// -----------------------------------------------------------------------------

// Feature: hidden-connector-routing, Property 8: Determinism
//
// For all inputs, invoking the router two or more times on equal-value inputs
// returns routes whose point sequences are identical in length, order, and
// integer coordinates; and when two candidate routes have equal Exposed_Travel
// and equal total Chebyshev length, the chosen route is the lexicographically
// smallest under the fixed point-coordinate ordering (x before y).
//
// Validates: Requirements 1.5, 3.1, 3.2, 3.3
describe('routeConnector — Property 8 (determinism and tie-break)', () => {
    /**
     * **Validates: Requirements 3.1, 3.2**
     *
     * Repeated invocation on the SAME index and a fresh, equal-value index both
     * return byte-identical results — point sequence, the Hidden/Exposed/total
     * accounting, and the fallback/rejected flags. This pins down purity: the
     * route depends only on the values passed in, never on call count or object
     * identity.
     */
    it('repeated and equal-value invocations return identical routes', () => {
        fc.assert(
            fc.property(arbScenario, ({ env, ink, exit, entry }) => {
                const idxA = buildIndex(env, ink);
                const idxB = buildIndex(env, ink);

                const r1 = routeConnector(exit, entry, idxA, env);
                const r2 = routeConnector(exit, entry, idxA, env); // same instance, again
                const r3 = routeConnector(exit, entry, idxB, env); // equal-value instance

                // Point sequences identical in length, order, and integer coords.
                expect(r2.segment.pointsSteps).toEqual(r1.segment.pointsSteps);
                expect(r3.segment.pointsSteps).toEqual(r1.segment.pointsSteps);

                // The full accounting is deterministic too.
                for (const r of [r2, r3]) {
                    expect(r.hiddenTravel).toBe(r1.hiddenTravel);
                    expect(r.exposedTravel).toBe(r1.exposedTravel);
                    expect(r.totalTravel).toBe(r1.totalTravel);
                    expect(r.fellBack).toBe(r1.fellBack);
                    expect(r.rejected).toBe(r1.rejected);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 1.5, 3.3**
     *
     * Tie-break resolves to the lexicographically smallest route. We construct a
     * left/right-symmetric scenario: the exit sits on the bottom edge at the
     * horizontal centre and the entry sits directly above it on the top edge.
     * Hugging the LEFT perimeter and hugging the RIGHT perimeter then give two
     * fully hidden (Exposed_Travel == 0) routes of EQUAL total Chebyshev length
     * — a genuine tie on the first two selection keys. The fixed third key
     * (lexicographically smallest ordered point sequence, x before y) must pick
     * the left-edge route, whose second point `(0, 0)` is the smallest possible.
     */
    it('equal-Exposed / equal-total ties resolve to the lexicographically smallest route', () => {
        const arbTie = fc.record({
            half: fc.integer({ min: 5, max: 100 }),
            h: fc.integer({ min: 10, max: 200 }),
        });

        fc.assert(
            fc.property(arbTie, ({ half, h }) => {
                const w = 2 * half;
                const env: StepEnvelope = { x: w, y: h };
                const exit: Point = { x: half, y: 0 }; // bottom edge, centre
                const entry: Point = { x: half, y: h }; // top edge, centre

                // Irrelevant interior ink so the index is non-empty (the router
                // short-circuits to straight on empty ink). Placed right of
                // centre and away from every edge, so it can never yield a
                // zero-Exposed route that competes with the edge hugs.
                const idx = new DrawnInkIndex(env);
                idx.add({
                    kind: 'stroke',
                    pointsSteps: [
                        { x: w - 3, y: 3 },
                        { x: w - 3, y: 5 },
                    ],
                });

                // The two tied, fully hidden perimeter-hug routes.
                const leftRoute: Point[] = [
                    { x: half, y: 0 },
                    { x: 0, y: 0 },
                    { x: 0, y: h },
                    { x: half, y: h },
                ];
                const rightRoute: Point[] = [
                    { x: half, y: 0 },
                    { x: w, y: 0 },
                    { x: w, y: h },
                    { x: half, y: h },
                ];

                // Sanity: confirm the tie is real before asserting the tie-break.
                const leftCls = classifyRoute(leftRoute, idx);
                const rightCls = classifyRoute(rightRoute, idx);
                expect(leftCls.exposedTravel).toBe(0);
                expect(rightCls.exposedTravel).toBe(0);
                expect(leftCls.totalTravel).toBe(rightCls.totalTravel);
                // Both strictly beat the straight connector (length h).
                expect(leftCls.exposedTravel).toBeLessThan(chebyshev(exit, entry));

                const result = routeConnector(exit, entry, idx, env);

                // The lexicographically smaller (left-edge) route is chosen.
                expect(result.segment.pointsSteps).toEqual(leftRoute);
                expect(result.exposedTravel).toBe(0);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 9 — Drawn_Ink reorder invariance
// -----------------------------------------------------------------------------

// Feature: hidden-connector-routing, Property 9: Drawn_Ink reorder invariance
//
// For all inputs, supplying the Drawn_Ink segments in different iteration
// orders that are otherwise equal in value produces routes whose point
// sequences are identical in length, order, and integer coordinates. The router
// is a pure function of the *value* of the Drawn_Ink set, never of the order in
// which the segments happened to be added to the index, so shuffling the same
// ink polylines before a second invocation must not change the chosen route.
//
// Validates: Requirements 3.4
describe('routeConnector — Property 9 (Drawn_Ink reorder invariance)', () => {
    /**
     * Pair each generated scenario with a set of random sort keys (one per ink
     * polyline) used to derive a permutation of the same ink value set. The keys
     * live alongside the scenario so the permutation is reproducible by
     * fast-check's shrinker.
     */
    const arbScenarioWithOrder = arbScenario.chain((scenario) =>
        fc.record({
            scenario: fc.constant(scenario),
            keys: fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
                minLength: scenario.ink.length,
                maxLength: scenario.ink.length,
            }),
        }),
    );

    /**
     * **Validates: Requirements 3.4**
     *
     * Build one index from the ink in its generated order and a second index
     * from a shuffled copy of the SAME ink value set. The two routes — point
     * sequence and the full Hidden/Exposed/total accounting plus flags — must be
     * identical, proving the route depends only on the value of the ink set and
     * not on its iteration/insertion order.
     */
    it('shuffling the same ink value set yields identical routes', () => {
        fc.assert(
            fc.property(arbScenarioWithOrder, ({ scenario, keys }) => {
                const { env, ink, exit, entry } = scenario;

                // Derive a permutation of the same ink polylines from the keys.
                const shuffled = ink
                    .map((poly, i) => ({ poly, key: keys[i], i }))
                    .sort((a, b) => a.key - b.key || a.i - b.i)
                    .map((e) => e.poly);

                const idxOriginal = buildIndex(env, ink);
                const idxShuffled = buildIndex(env, shuffled);

                const rOriginal = routeConnector(exit, entry, idxOriginal, env);
                const rShuffled = routeConnector(exit, entry, idxShuffled, env);

                // Point sequences identical in length, order, and integer coords.
                expect(rShuffled.segment.pointsSteps).toEqual(
                    rOriginal.segment.pointsSteps,
                );

                // The full accounting and flags are order-invariant too.
                expect(rShuffled.hiddenTravel).toBe(rOriginal.hiddenTravel);
                expect(rShuffled.exposedTravel).toBe(rOriginal.exposedTravel);
                expect(rShuffled.totalTravel).toBe(rOriginal.totalTravel);
                expect(rShuffled.fellBack).toBe(rOriginal.fellBack);
                expect(rShuffled.rejected).toBe(rOriginal.rejected);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
