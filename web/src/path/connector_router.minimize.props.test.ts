/**
 * Property-based tests for the `Connector_Router` "minimize visible ink"
 * guarantees (Design §"Correctness Properties").
 *
 * The router routes inter-stroke connectors over already-drawn ink and envelope
 * edges so retraced travel is invisible (`Hidden_Travel`) and only the residual
 * gap remains visible (`Exposed_Travel`). The defining safety guarantee is that
 * enabling the feature can never make a drawing worse: the emitted connector's
 * `Exposed_Travel` is bounded by the straight 2-point connector's Chebyshev
 * length, and a strictly-improving routed connector is chosen whenever one
 * exists, otherwise the router degrades to the straight 2-point fallback.
 *
 * This suite holds the three "minimize" properties (each a single fast-check
 * property, ≥100 iterations):
 *   - Property 1: Never increase visible ink            (this file, task 10.1)
 *   - Property 2: Strictly-improving route is chosen     (task 10.2)
 *   - Property 3: Fallback to the straight 2-point conn. (task 10.3)
 *
 * Each property is tagged with a `// Feature: hidden-connector-routing,
 * Property {n}: ...` comment referencing its design property, and is
 * implemented below in its own `describe` block. The shared generators
 * (envelope, in-envelope points, ink) are defined once at the top so each
 * property reuses the same well-formed input space.
 *
 * @see web/src/path/connector_router.ts
 * @see Design: Hidden Connector Routing (Correctness Properties §1–3, Testing Strategy)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { routeConnector } from './connector_router';
import { DrawnInkIndex } from './connector_router';
import type { StepEnvelope } from './connector_router';
import type { Point, PlannedSegment } from '../types';

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

/**
 * Chebyshev distance `max(|dx|, |dy|)` — the machine's real per-move step count
 * and the metric the router charges connector travel in (Req 1.1). The straight
 * 2-point connector's full visible length equals this (Req 5.1).
 */
const chebyshev = (a: Point, b: Point): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Minimum iterations per property mandated by the Testing Strategy. */
const NUM_RUNS = 200;

// -----------------------------------------------------------------------------
// Shared generators — constrained to the router's documented input space.
//
// Every coordinate is an integer motor step. Endpoints and ink are generated
// INSIDE a randomly-sized envelope so the inputs mirror real planner output
// (scaled + step-quantised polylines that already fit the Step_Envelope).
// -----------------------------------------------------------------------------

/**
 * A random envelope, then endpoints and ink generated inside it. Using
 * `fc.integer({min,max}).chain(...)` keeps every derived coordinate within the
 * inclusive `[0,env.x] × [0,env.y]` rectangle the drawing must stay in.
 */
interface RouterCase {
    env: StepEnvelope;
    exit: Point;
    entry: Point;
    /** Already-drawn ink, as stroke segments fed into the DrawnInkIndex. */
    inkSegments: PlannedSegment[];
}

/** A point inside the inclusive envelope `[0,env.x] × [0,env.y]`. */
const arbPointIn = (env: StepEnvelope): fc.Arbitrary<Point> =>
    fc.record({
        x: fc.integer({ min: 0, max: env.x }),
        y: fc.integer({ min: 0, max: env.y }),
    });

/**
 * A single stroke of 2..6 distinct integer points inside the envelope, emitted
 * as a `kind: 'stroke'` `PlannedSegment` so it can be added to the index. A
 * fraction of strokes are deliberately routed to pass NEAR the connector
 * endpoints so the "ink covers the gap" case (relevant for Properties 1–3) is
 * exercised alongside far/irrelevant ink.
 */
const arbStrokeIn = (env: StepEnvelope): fc.Arbitrary<PlannedSegment> =>
    fc
        .array(arbPointIn(env), { minLength: 2, maxLength: 6 })
        .map((pts) => {
            // Collapse consecutive duplicates so each stroke is well-formed
            // (no zero-length sub-segments), matching real pipeline output.
            const out: Point[] = [];
            for (const p of pts) {
                const prev = out[out.length - 1];
                if (prev === undefined || prev.x !== p.x || prev.y !== p.y) {
                    out.push({ x: p.x, y: p.y });
                }
            }
            return out;
        })
        .filter((pts) => pts.length >= 2)
        .map(
            (pointsSteps): PlannedSegment => ({
                kind: 'stroke',
                pointsSteps,
            }),
        );

/**
 * A full router case: a random envelope (≥1 in each axis so there is room to
 * route), two in-envelope endpoints, and 0..8 in-envelope strokes of ink. The
 * empty-ink case (length 0) and far/near ink all arise naturally, covering the
 * fallback and hiding branches with one generator.
 */
const arbRouterCase: fc.Arbitrary<RouterCase> = fc
    .record({
        x: fc.integer({ min: 1, max: 120 }),
        y: fc.integer({ min: 1, max: 120 }),
    })
    .chain((env) =>
        fc.record({
            env: fc.constant(env),
            exit: arbPointIn(env),
            entry: arbPointIn(env),
            inkSegments: fc.array(arbStrokeIn(env), {
                minLength: 0,
                maxLength: 8,
            }),
        }),
    )
    // A connector by definition bridges a NON-ZERO gap: the stitcher only emits
    // a connector when `segStart != current`, so `routeConnector` is never
    // called with coincident endpoints in the real pipeline. `exit === entry`
    // is outside the valid input domain (Req 2.2's ≥2 points and Req 2.3's no
    // zero-length sub-segments are only jointly satisfiable for distinct
    // endpoints), so we filter it out.
    .filter(({ exit, entry }) => exit.x !== entry.x || exit.y !== entry.y);

/** Build a DrawnInkIndex over the case's ink, in generation order. */
const buildInk = (c: RouterCase): DrawnInkIndex => {
    const ink = new DrawnInkIndex(c.env);
    for (const seg of c.inkSegments) ink.add(seg);
    return ink;
};

// -----------------------------------------------------------------------------
// Property 1 — Never increase visible ink
// -----------------------------------------------------------------------------

describe('routeConnector — Property 1 (never increase visible ink)', () => {
    /**
     * **Validates: Requirements 1.1, 5.1, 5.4**
     *
     * For all connector endpoints `(exit, entry)`, any `Drawn_Ink` set, and any
     * envelope, the emitted connector's `Exposed_Travel` (Chebyshev) is less
     * than or equal to the straight 2-point connector's Chebyshev length
     * `max(|exit.x−entry.x|, |exit.y−entry.y|)`. Enabling connector hiding can
     * therefore only ever reduce — never increase — visible ink.
     */
    // Feature: hidden-connector-routing, Property 1: Never increase visible ink
    it('exposedTravel ≤ chebyshev(exit, entry) for any ink/endpoints/envelope', () => {
        fc.assert(
            fc.property(arbRouterCase, (c) => {
                const ink = buildInk(c);
                const result = routeConnector(c.exit, c.entry, ink, c.env);
                const straightLen = chebyshev(c.exit, c.entry);

                expect(result.exposedTravel).toBeLessThanOrEqual(straightLen);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 2 — Strictly-improving route is chosen when one exists
// -----------------------------------------------------------------------------

/**
 * A router case whose `Drawn_Ink` *deliberately covers the gap*: the ink is a
 * single "tent" stroke `[exit, apex, entry]` whose two legs span from the exit
 * endpoint up to an apex and back down to the entry endpoint. Because the apex
 * sits off the straight `exit → entry` corridor, following the ink (the 3-point
 * route `[exit, apex, entry]`) is fully Hidden_Travel (`Exposed_Travel === 0`),
 * while the straight 2-point base is NOT collinear with either leg through its
 * middle, so the straight connector keeps `Exposed_Travel > 0`. A
 * strictly-improving routed connector therefore provably exists, and its
 * minimum achievable Exposed_Travel is exactly 0.
 */
interface CoveringCase {
    env: StepEnvelope;
    exit: Point;
    apex: Point;
    entry: Point;
    /** The single tent stroke `[exit, apex, entry]` (the covering ink). */
    inkStroke: PlannedSegment;
}

/**
 * Generate a covering case with both endpoints strictly interior to the
 * envelope (so no envelope-edge route can reach them with zero Exposed_Travel,
 * making the over-ink tent route the unique strictly-improving option):
 *
 *   exit  = (ox,        oy)
 *   apex  = (ox + d,    oy + h)
 *   entry = (ox + 2d,   oy)
 *
 * with `d ≥ 2`, `h ≥ 2`. Both legs have Chebyshev length `max(d, h) ≥ 2`, the
 * straight base has Chebyshev length `2d ≥ 4`, and the base's midpoint sits a
 * perpendicular distance `d·h / sqrt(d² + h²) ≥ √2 > 1` from each leg, so the
 * base cannot be fully hidden by the tent ink (its middle steps stay Exposed).
 *
 * Both endpoints are kept ≥ 2 steps from every envelope edge (`ox, oy ≥ 2`,
 * top/right padded by 5), so the horizontal base never runs within the 1-step
 * Hidden tolerance of a parallel perimeter edge — otherwise that edge (itself
 * routable Hidden ink, Req 1.4) would hide the straight base and make the
 * 2-point connector a zero-Exposed route. With the endpoints interior, the tent
 * over the ink is the unique fully-Hidden route.
 */
const arbCoveringCase: fc.Arbitrary<CoveringCase> = fc
    .record({
        d: fc.integer({ min: 2, max: 20 }),
        h: fc.integer({ min: 2, max: 20 }),
        ox: fc.integer({ min: 2, max: 30 }),
        oy: fc.integer({ min: 2, max: 30 }),
    })
    .map(({ d, h, ox, oy }) => {
        const exit: Point = { x: ox, y: oy };
        const apex: Point = { x: ox + d, y: oy + h };
        const entry: Point = { x: ox + 2 * d, y: oy };
        const env: StepEnvelope = { x: ox + 2 * d + 5, y: oy + h + 5 };
        const inkStroke: PlannedSegment = {
            kind: 'stroke',
            pointsSteps: [
                { x: exit.x, y: exit.y },
                { x: apex.x, y: apex.y },
                { x: entry.x, y: entry.y },
            ],
        };
        return { env, exit, apex, entry, inkStroke };
    });

describe('routeConnector — Property 2 (strictly-improving route chosen)', () => {
    /**
     * **Validates: Requirements 1.1, 1.2, 5.2, 5.3**
     *
     * For all inputs where at least one evaluated candidate route has
     * `Exposed_Travel` strictly less than the straight Chebyshev length, the
     * emitted connector is a routed (multi-point) connector whose
     * `Exposed_Travel` is strictly less than the straight length and is the
     * minimum among evaluated candidates.
     *
     * The generator builds ink that covers the gap via a single off-corridor
     * apex, so the over-ink route `[exit, apex, entry]` is the unique fully
     * Hidden (`Exposed_Travel === 0`) route — the minimum achievable, since
     * Exposed_Travel is non-negative and the only 2-point route (the straight
     * base) stays Exposed. A generous `maxCandidates` ensures the apex pair is
     * evaluated rather than cut off by the per-connector cap (Property 3 covers
     * the cap-limited fallback). The emitted connector must therefore be the
     * routed multi-point tent, not the straight fallback.
     */
    // Feature: hidden-connector-routing, Property 2: Strictly-improving route is chosen when one exists
    it('emits the routed multi-point connector with the minimum, strictly-lower Exposed', () => {
        fc.assert(
            fc.property(arbCoveringCase, (c) => {
                const ink = new DrawnInkIndex(c.env);
                ink.add(c.inkStroke);

                const straightLen = chebyshev(c.exit, c.entry);
                // Generator guarantees a non-degenerate gap to improve upon.
                expect(straightLen).toBeGreaterThan(0);

                const result = routeConnector(c.exit, c.entry, ink, c.env, {
                    // Evaluate generously so the strictly-improving apex
                    // candidate is reached (cap-limited behaviour → Property 3).
                    maxCandidates: 1024,
                });

                // A routed connector was emitted, not the straight fallback.
                expect(result.fellBack).toBe(false);
                expect(result.rejected).toBe(false);

                // Its Exposed_Travel is the minimum achievable (0) and strictly
                // below the straight 2-point connector's visible length.
                expect(result.exposedTravel).toBe(0);
                expect(result.exposedTravel).toBeLessThan(straightLen);

                // It is a genuine multi-point route following the covering ink,
                // anchored exactly at the connector endpoints (Continuity).
                const pts = result.segment.pointsSteps;
                expect(result.segment.kind).toBe('connector');
                expect(pts.length).toBeGreaterThanOrEqual(3);
                expect(pts[0]).toEqual(c.exit);
                expect(pts[pts.length - 1]).toEqual(c.entry);

                // The unique fully-Hidden route is the tent over the ink.
                expect(pts).toEqual([c.exit, c.apex, c.entry]);

                // Conservation: Hidden + Exposed == total Chebyshev length.
                expect(result.hiddenTravel + result.exposedTravel).toBe(
                    result.totalTravel,
                );
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 3 — Fallback to the straight 2-point connector
// -----------------------------------------------------------------------------

/**
 * A router case in which NO evaluated candidate can achieve `Exposed_Travel`
 * strictly less than the straight 2-point connector's Chebyshev length, so the
 * router must degrade to the straight fallback `[exit, entry]`. Two flavours,
 * both guaranteed to leave the straight baseline unbeatable:
 *
 *   - `empty`      — no Drawn_Ink at all. The router short-circuits the hiding
 *                    search (`DrawnInkIndex.isEmpty()`) and emits straight
 *                    directly (Req 6.3), independent of the envelope edges.
 *   - `irrelevant` — both endpoints sit deep in the envelope interior while the
 *                    only ink is a small blob pinned far away in a corner. Every
 *                    possible snap target (the far ink endpoints AND the nearest
 *                    point on each envelope edge) is so distant that the
 *                    Exposed approach legs alone exceed the direct straight
 *                    length, so no routed candidate's Exposed can dip below it
 *                    (it ties or exceeds the straight baseline — the
 *                    "Exposed-equals-or-exceeds-straight" domain). The router
 *                    therefore falls back rather than emit a non-improving route
 *                    (Req 6.1, 6.2).
 */
interface FallbackCase {
    env: StepEnvelope;
    exit: Point;
    entry: Point;
    /** Ink fed into the index — empty for the `empty` flavour. */
    inkSegments: PlannedSegment[];
}

/**
 * Empty-ink fallback: a random envelope and two distinct in-envelope endpoints,
 * with no ink. `DrawnInkIndex.isEmpty()` is true, so the router never searches
 * and emits the straight 2-point connector (Req 6.3, design Error-Handling
 * "Drawn_Ink empty / i == 0" row).
 */
const arbEmptyInkFallbackCase: fc.Arbitrary<FallbackCase> = fc
    .record({
        x: fc.integer({ min: 1, max: 120 }),
        y: fc.integer({ min: 1, max: 120 }),
    })
    .chain((env) =>
        fc.record({
            env: fc.constant(env),
            exit: arbPointIn(env),
            entry: arbPointIn(env),
            inkSegments: fc.constant<PlannedSegment[]>([]),
        }),
    )
    // A connector bridges a non-zero gap (the stitcher never emits one for
    // coincident endpoints): keep exit !== entry, consistent with the shared
    // generators above.
    .filter(({ exit, entry }) => exit.x !== entry.x || exit.y !== entry.y);

/**
 * Irrelevant-ink fallback: both endpoints live in a central interior band, far
 * from every envelope edge, while the only ink is a tiny stroke pinned in the
 * `[0,20]²` corner. Concretely, with `env.{x,y} ∈ [260,380]`:
 *
 *   - endpoints `∈ [120,170]²` ⇒ `straightLen = chebyshev(exit, entry) ≤ 50`;
 *   - distance from either endpoint to the nearest envelope edge ≥ 90 (low edge
 *     ≥ 120, high edge ≥ 260 − 170 = 90) ⇒ any envelope-edge snap forces an
 *     Exposed approach leg ≥ 90 > 50;
 *   - distance from either endpoint to the corner ink (≤ 20) ≥ 100 ⇒ any
 *     over-ink snap forces an Exposed approach leg ≥ 100 > 50.
 *
 * Since every non-trivial candidate begins with an Exposed approach leg longer
 * than the entire straight connector, the minimum achievable Exposed over all
 * evaluated candidates is the straight baseline itself — never strictly below
 * it. The router must fall back (Req 6.1, 6.2). The ink is non-empty, so unlike
 * the `empty` flavour this exercises the full candidate-generation + selection
 * path returning straight because nothing improves.
 */
const arbIrrelevantInkFallbackCase: fc.Arbitrary<FallbackCase> = fc
    .record({
        ex: fc.integer({ min: 120, max: 170 }),
        ey: fc.integer({ min: 120, max: 170 }),
        nx: fc.integer({ min: 120, max: 170 }),
        ny: fc.integer({ min: 120, max: 170 }),
        envx: fc.integer({ min: 260, max: 380 }),
        envy: fc.integer({ min: 260, max: 380 }),
        // A small 2-point corner stroke; the two points are forced distinct so
        // the stroke is well-formed ink (no zero-length sub-segment).
        ink0x: fc.integer({ min: 0, max: 20 }),
        ink0y: fc.integer({ min: 0, max: 20 }),
        inkDx: fc.integer({ min: 1, max: 20 }),
        inkDy: fc.integer({ min: 0, max: 20 }),
    })
    .map(({ ex, ey, nx, ny, envx, envy, ink0x, ink0y, inkDx, inkDy }) => {
        const env: StepEnvelope = { x: envx, y: envy };
        const exit: Point = { x: ex, y: ey };
        const entry: Point = { x: nx, y: ny };
        const inkStroke: PlannedSegment = {
            kind: 'stroke',
            // `inkDx ≥ 1` guarantees the two points differ in x, so the corner
            // stroke is a genuine non-degenerate ink segment in `[0,40]²`.
            pointsSteps: [
                { x: ink0x, y: ink0y },
                { x: ink0x + inkDx, y: ink0y + inkDy },
            ],
        };
        return { env, exit, entry, inkSegments: [inkStroke] };
    })
    .filter(({ exit, entry }) => exit.x !== entry.x || exit.y !== entry.y);

/** Either fallback flavour, so one property covers empty AND irrelevant ink. */
const arbFallbackCase: fc.Arbitrary<FallbackCase> = fc.oneof(
    arbEmptyInkFallbackCase,
    arbIrrelevantInkFallbackCase,
);

describe('routeConnector — Property 3 (fallback to the straight 2-point connector)', () => {
    /**
     * **Validates: Requirements 1.6, 5.2, 6.1, 6.2, 6.3**
     *
     * For all inputs where no evaluated candidate achieves `Exposed_Travel`
     * strictly less than the straight Chebyshev length — including an empty
     * `Drawn_Ink` set, and candidates whose Exposed merely equals or exceeds the
     * straight length — the emitted connector is exactly the two-point polyline
     * `[exit, entry]`.
     *
     * The generator mixes the empty-ink short-circuit (Req 6.3) with
     * far/irrelevant ink whose every snap target forces an Exposed approach leg
     * longer than the whole straight connector, so the straight baseline is
     * provably unbeatable (Req 6.1, 6.2). In both flavours the router must emit
     * the straight 2-point connector verbatim, with all travel accounted as
     * Exposed (Req 5.1) and none hidden.
     */
    // Feature: hidden-connector-routing, Property 3: Fallback to the straight 2-point connector
    it('emits exactly [exit, entry] when no candidate strictly beats the straight connector', () => {
        fc.assert(
            fc.property(arbFallbackCase, (c) => {
                const ink = new DrawnInkIndex(c.env);
                for (const seg of c.inkSegments) ink.add(seg);

                const straightLen = chebyshev(c.exit, c.entry);
                // The generator guarantees a non-degenerate gap to (fail to)
                // improve upon, so the straight baseline is meaningful.
                expect(straightLen).toBeGreaterThan(0);

                const result = routeConnector(c.exit, c.entry, ink, c.env);

                // The emitted connector is exactly the straight 2-point polyline.
                expect(result.segment.kind).toBe('connector');
                expect(result.segment.pointsSteps).toEqual([
                    { x: c.exit.x, y: c.exit.y },
                    { x: c.entry.x, y: c.entry.y },
                ]);

                // It is the straight fallback, not a guard-rejected route: the
                // baseline simply could not be strictly improved upon.
                expect(result.fellBack).toBe(true);
                expect(result.rejected).toBe(false);

                // Straight-connector accounting: all travel Exposed, none hidden,
                // and the full Chebyshev length is visible (Req 5.1).
                expect(result.hiddenTravel).toBe(0);
                expect(result.exposedTravel).toBe(straightLen);
                expect(result.totalTravel).toBe(straightLen);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
