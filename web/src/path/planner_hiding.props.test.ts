/**
 * Property-based tests for the `Path_Planner` with connector hiding enabled.
 *
 * This file holds the planner/stitch-level correctness properties of the
 * hidden-connector-routing feature (Design §"Correctness Properties"). It
 * currently implements **Property 4** (continuity & endpoint anchoring) and is
 * deliberately structured with the shared generators at the top so the sibling
 * planner-level properties (**11**, **12**, **13**, **14** — spec tasks
 * 11.2–11.5) can be appended below them without restructuring.
 *
 * Library: fast-check, ≥100 iterations per property, matching the conventions
 * of the sibling `*.props.test.ts` files in this directory.
 *
 * Connector hiding is only meaningful on the envelope-fit branch
 * ({@link PlanOptions.envelopeSteps} set), since the router needs the
 * Step_Envelope to route over perimeter edges and enforce containment. Every
 * scenario below therefore plans with `envelopeSteps` set plus
 * `connectorHiding: true`.
 *
 * @see web/src/path/planner.ts
 * @see web/src/path/connector_router.ts
 * @see Design: Hidden Connector Routing (Property 4)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PathPlanner } from './planner';
import type { PlanOptions, PathInput } from './planner';
import type { PlannedPath, Point } from '../types';

// -----------------------------------------------------------------------------
// Shared fixtures / helpers
// -----------------------------------------------------------------------------

const planner = new PathPlanner();

const NUM_RUNS = 200;

/** Exact integer-coordinate point equality (Req 2.1, 2.5: integer x AND y). */
function samePoint(a: Point, b: Point): boolean {
    return a.x === b.x && a.y === b.y;
}

/** First point of a segment's step polyline. */
function firstPoint(seg: PlannedPath['segments'][number]): Point {
    return seg.pointsSteps[0]!;
}

/** Last point of a segment's step polyline. */
function lastPoint(seg: PlannedPath['segments'][number]): Point {
    return seg.pointsSteps[seg.pointsSteps.length - 1]!;
}

// -----------------------------------------------------------------------------
// Shared generators — constrained to the documented planner input space.
//
// `envelopeSteps` selects the envelope-fit branch (where connector hiding is
// active). Input polylines are generated in an arbitrary integer source space;
// `fitPolylinesToEnvelope` rescales them into the envelope, so the absolute
// source range only needs to be large enough to produce a spread of strokes.
// Several strokes are generated so the stitcher weaves multiple inter-stroke
// connectors for the router to hide, exercising the continuity invariant across
// a real multi-segment PlannedPath.
// -----------------------------------------------------------------------------

/** A measured Step_Envelope in integer motor steps. */
const arbEnv: fc.Arbitrary<{ x: number; y: number }> = fc.record({
    x: fc.integer({ min: 20, max: 300 }),
    y: fc.integer({ min: 20, max: 300 }),
});

/** An integer source-space point (rescaled into the envelope by the planner). */
const arbSourcePoint: fc.Arbitrary<Point> = fc.record({
    x: fc.integer({ min: 0, max: 500 }),
    y: fc.integer({ min: 0, max: 500 }),
});

/** A single source stroke of 2..6 points. */
const arbPolyline: fc.Arbitrary<Point[]> = fc.array(arbSourcePoint, {
    minLength: 2,
    maxLength: 6,
});

/**
 * A `PathInput` of 2..8 strokes — enough to guarantee inter-stroke connectors
 * for the router to act on. (Strokes that collapse below 2 distinct points
 * after fitting are dropped upstream; the property holds regardless.)
 */
const arbInput: fc.Arbitrary<PathInput> = fc
    .array(arbPolyline, { minLength: 2, maxLength: 8 })
    .map((polylines) => ({ polylines }));

/**
 * Extra plan knobs that are orthogonal to connector hiding but vary the shape
 * of the assembled path (return-home style, fill, Y-flip). Hiding-on continuity
 * must hold for every combination.
 */
const arbExtraOpts: fc.Arbitrary<Partial<PlanOptions>> = fc.record({
    returnToHome: fc.boolean(),
    edgeReturn: fc.boolean(),
    flipY: fc.boolean(),
    fillFraction: fc.double({ min: 0.5, max: 1.0, noNaN: true, noDefaultInfinity: true }),
});

/** A full hiding-enabled planner scenario. */
interface Scenario {
    input: PathInput;
    env: { x: number; y: number };
    extra: Partial<PlanOptions>;
}

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
    input: arbInput,
    env: arbEnv,
    extra: arbExtraOpts,
});

/** Build the hiding-enabled plan options for a scenario. */
function hidingOptions(s: Scenario): PlanOptions {
    return {
        envelopeSteps: s.env,
        connectorHiding: true,
        ...s.extra,
    };
}

// -----------------------------------------------------------------------------
// Property 4 — Continuity and endpoint anchoring
// -----------------------------------------------------------------------------

describe('PathPlanner (connector hiding) — Property 4 (continuity & endpoint anchoring)', () => {
    /**
     * **Validates: Requirements 2.1, 2.5, 6.5**
     *
     * For every planned path produced with connector hiding enabled:
     *
     *  - **Whole-path continuity (Req 2.5):** for every adjacent segment pair,
     *    the earlier segment's last point equals the next segment's first point
     *    exactly (integer x AND y), so the entire PlannedPath is one contiguous
     *    stroke.
     *  - **Connector endpoint anchoring (Req 2.1, 6.5):** every emitted
     *    `connector` segment begins exactly at its `exit` (the preceding
     *    segment's last point) and ends exactly at its `entry` (the following
     *    segment's first point). This holds for routed multi-point connectors
     *    and the straight 2-point fallback alike, since both are anchored to
     *    the same neighbours.
     */
    // Feature: hidden-connector-routing, Property 4: Continuity and endpoint anchoring
    it('every connector is anchored to its neighbours and the whole path is contiguous', () => {
        fc.assert(
            fc.property(arbScenario, (scenario) => {
                const path = planner.plan(scenario.input, hidingOptions(scenario));
                const segs = path.segments;

                // Whole-path continuity (Req 2.5): seam points match exactly.
                for (let i = 0; i + 1 < segs.length; i++) {
                    const seam = lastPoint(segs[i]!);
                    const next = firstPoint(segs[i + 1]!);
                    expect(seam.x).toBe(next.x);
                    expect(seam.y).toBe(next.y);
                }

                // Connector endpoint anchoring (Req 2.1, 6.5): every connector
                // starts at the exit (preceding segment's last point) and ends
                // at the entry (following segment's first point).
                for (let i = 0; i < segs.length; i++) {
                    const seg = segs[i]!;
                    if (seg.kind !== 'connector') continue;

                    if (i > 0) {
                        const exit = lastPoint(segs[i - 1]!);
                        expect(samePoint(firstPoint(seg), exit)).toBe(true);
                    }
                    if (i + 1 < segs.length) {
                        const entry = firstPoint(segs[i + 1]!);
                        expect(samePoint(lastPoint(seg), entry)).toBe(true);
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 11 — Opt-in identity (off ⇒ byte-for-byte unchanged)
// -----------------------------------------------------------------------------

/**
 * Build plan options for a scenario with `connectorHiding` set to an explicit
 * `false`. Shares the SAME envelope and extra knobs as {@link absentOptions};
 * only the presence/value of `connectorHiding` differs, so any difference in
 * output can be attributed solely to the opt-in flag.
 */
function hidingOffOptions(s: Scenario): PlanOptions {
    return {
        envelopeSteps: s.env,
        connectorHiding: false,
        ...s.extra,
    };
}

/**
 * Build plan options for a scenario with the `connectorHiding` option entirely
 * absent. Identical to {@link hidingOffOptions} except the flag is omitted.
 */
function absentOptions(s: Scenario): PlanOptions {
    return {
        envelopeSteps: s.env,
        ...s.extra,
    };
}

describe('PathPlanner (connector hiding) — Property 11 (opt-in identity)', () => {
    /**
     * **Validates: Requirements 7.1, 7.2**
     *
     * For every input, the `PlannedPath` produced with `connectorHiding` set to
     * `false` is deep-equal (byte-for-byte) to the `PlannedPath` produced with
     * the option absent — including every woven straight connector and stroke.
     * Both plans run on the SAME envelope and the SAME orthogonal knobs
     * (return-home style, fill fraction, Y-flip); only the presence/value of
     * `connectorHiding` differs, so an exact deep equality confirms the opt-in
     * flag is a true no-op when off (the off branch runs the original
     * straight-connector stitch verbatim).
     */
    // Feature: hidden-connector-routing, Property 11: Opt-in identity (off ⇒ byte-for-byte unchanged)
    it('connectorHiding:false is byte-for-byte identical to the option being absent', () => {
        fc.assert(
            fc.property(arbScenario, (scenario) => {
                const offPath = planner.plan(scenario.input, hidingOffOptions(scenario));
                const absentPath = planner.plan(scenario.input, absentOptions(scenario));

                // Byte-for-byte (deep) equality over the whole PlannedPath:
                // drawableSteps, every segment kind, and every integer-step
                // point of every stroke and woven straight connector.
                expect(offPath).toEqual(absentPath);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 12 — Stroke order/orientation invariance
//
// Driven through the stitcher directly rather than `PathPlanner.plan`, because
// `plan` hardcodes `twoOpt: true` on the envelope-fit branch. The design
// guarantees connector hiding runs strictly AFTER the final stroke
// order/orientation are decided (Req 7.5, 7.6), so `stroke` segments must be
// identical whether hiding is on or off — for EITHER value of `twoOpt`. Both
// `stitchPolylines` branches share the SAME `orderPolylinesNearestNeighbor`
// call, so this asserts that contract holds end-to-end.
// -----------------------------------------------------------------------------

import { stitchPolylines } from './stitch';
import type { StepEnvelope } from './connector_router';
import type { Polyline } from '../types';

/**
 * Extract the ordered `stroke` segments as plain integer-coordinate point
 * sequences, dropping all `connector` segments. Two plans agree on
 * stroke order AND per-stroke orientation iff their `strokeSequences` are
 * deep-equal (same number of strokes, same order, same per-stroke point lists).
 */
function strokeSequences(segments: PlannedPath['segments']): Point[][] {
    return segments
        .filter((s) => s.kind === 'stroke')
        .map((s) => s.pointsSteps.map((p) => ({ x: p.x, y: p.y })));
}

/**
 * A stitch-level scenario: an envelope plus polylines whose integer-step points
 * all lie inside that inclusive envelope (so the router can route over edges and
 * the containment guard is satisfied). Several strokes are generated so the
 * stitcher weaves multiple connectors for the router to hide.
 */
interface StitchScenario {
    env: StepEnvelope;
    polys: Polyline[];
}

/** Generate a polyline of 2..6 integer points inside `[0,env.x] × [0,env.y]`. */
function arbPolyInEnv(env: StepEnvelope): fc.Arbitrary<Polyline> {
    const arbPt: fc.Arbitrary<Point> = fc.record({
        x: fc.integer({ min: 0, max: env.x }),
        y: fc.integer({ min: 0, max: env.y }),
    });
    return fc.array(arbPt, { minLength: 2, maxLength: 6 });
}

const arbStitchScenario: fc.Arbitrary<StitchScenario> = arbEnv.chain((env) =>
    fc.record({
        env: fc.constant(env),
        polys: fc.array(arbPolyInEnv(env), { minLength: 2, maxLength: 8 }),
    }),
);

describe('Stitcher (connector hiding) — Property 12 (stroke order/orientation invariance)', () => {
    /**
     * **Validates: Requirements 7.5, 7.6**
     *
     * For every input and for EITHER value of `twoOpt`, the ordered sequence of
     * `stroke` segments — their order and each stroke's per-point sequence — is
     * identical whether connector hiding is on or off. Hiding may only change
     * `connector` segments, never the strokes, confirming the router runs after
     * the final stroke order/orientation are decided.
     *
     * Both stitches share the SAME `start` and (for `twoOpt: true`) the SAME
     * deterministic 2-opt ordering, so any divergence in `strokeSequences`
     * would mean hiding had perturbed stroke order or orientation.
     */
    // Feature: hidden-connector-routing, Property 12: Stroke order/orientation invariance — hiding changes only connector segments, never stroke order/orientation, for either twoOpt value
    it('stroke order and orientation are identical with hiding on vs off, for both twoOpt values', () => {
        fc.assert(
            fc.property(arbStitchScenario, fc.boolean(), (scenario, twoOpt) => {
                const start: Point = { x: 0, y: 0 };

                const offStrokes = strokeSequences(
                    stitchPolylines(scenario.polys, { start, twoOpt }),
                );
                const onStrokes = strokeSequences(
                    stitchPolylines(scenario.polys, {
                        start,
                        twoOpt,
                        connectorHiding: true,
                        env: scenario.env,
                    }),
                );

                // Same stroke order AND per-stroke orientation regardless of
                // whether hiding rerouted the connectors between them.
                expect(onStrokes).toEqual(offStrokes);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 13 — Observability report aggregation
//
// Exercised through `PathPlanner.planWithReport`, which returns the planned path
// plus the aggregated `ConnectorHidingReport`. The report aggregates ONLY the
// woven inter-stroke connectors (the off-/on-mode `ConnectorResult`s are folded
// from the stitched path BEFORE the auto-return-to-home connector is appended).
// To make `connectorCount` directly checkable against the visible `connector`
// segments in the path, these scenarios plan with `returnToHome: false`, so the
// path contains exactly the woven connectors the report counts and no extra
// appended return-to-home connector.
// -----------------------------------------------------------------------------

/** True iff `n` is a non-negative integer (Req 9.1, 9.3 counts/travels). */
function isNonNegativeInteger(n: number): boolean {
    return Number.isInteger(n) && n >= 0;
}

/**
 * Build the hiding-enabled plan options for Property 13, forcing
 * `returnToHome: false` so the report's `connectorCount` equals the number of
 * `connector` segments in the resulting path exactly (no appended
 * return-to-home connector to account for). The orthogonal knobs from the
 * scenario are still applied; `returnToHome` is overridden last.
 */
function reportOptions(s: Scenario): PlanOptions {
    return {
        ...s.extra,
        envelopeSteps: s.env,
        connectorHiding: true,
        returnToHome: false,
    };
}

describe('PathPlanner (connector hiding) — Property 13 (observability report aggregation)', () => {
    /**
     * **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
     *
     * For every hiding-enabled planned path, the surfaced
     * {@link ConnectorHidingReport} is internally consistent:
     *
     *  - **Travel totals (Req 9.1, 9.4):** `totalHiddenTravel` and
     *    `totalExposedTravel` are each non-negative integers in the machine's
     *    Chebyshev step metric (they are sums of per-connector Chebyshev
     *    travel, so they can never be negative or fractional).
     *  - **Classification counts (Req 9.2, 9.3):** each of `fullyHiddenCount`,
     *    `partiallyHiddenCount`, and `notHiddenCount` is a non-negative integer,
     *    and the three counts sum exactly to `connectorCount` — every connector
     *    falls into exactly one class (fully hidden, partially hidden, or not
     *    hidden).
     *  - **Connector total (Req 9.3):** `connectorCount` equals the number of
     *    woven inter-stroke `connector` segments actually present in the planned
     *    path. With `returnToHome: false` there is no appended return-to-home
     *    connector, so the report counts exactly the path's `connector`
     *    segments.
     */
    // Feature: hidden-connector-routing, Property 13: Observability report aggregation — report totals are non-negative integer Chebyshev sums, every connector is classified into exactly one of fully/partially/not hidden, and the three counts sum to the connector total
    it('aggregates per-connector travel and classification consistently with the planned path', () => {
        fc.assert(
            fc.property(arbScenario, (scenario) => {
                const opts = reportOptions(scenario);
                const path = planner.planWithReport(scenario.input, opts);
                const report = path.connectorHiding;

                // Travel totals: non-negative integers in Chebyshev steps
                // (sums of the per-connector Hidden/Exposed travel — Req 9.1, 9.4).
                expect(isNonNegativeInteger(report.totalHiddenTravel)).toBe(true);
                expect(isNonNegativeInteger(report.totalExposedTravel)).toBe(true);

                // Classification counts: each a non-negative integer (Req 9.3).
                expect(isNonNegativeInteger(report.fullyHiddenCount)).toBe(true);
                expect(isNonNegativeInteger(report.partiallyHiddenCount)).toBe(true);
                expect(isNonNegativeInteger(report.notHiddenCount)).toBe(true);
                expect(isNonNegativeInteger(report.connectorCount)).toBe(true);

                // The three classes partition the connectors: every connector
                // is fully hidden, partially hidden, or not hidden exactly once,
                // so the counts sum to the connector total (Req 9.3).
                expect(
                    report.fullyHiddenCount +
                    report.partiallyHiddenCount +
                    report.notHiddenCount,
                ).toBe(report.connectorCount);

                // connectorCount aggregates exactly the woven inter-stroke
                // connectors. With returnToHome:false the path carries no
                // appended return-to-home connector, so the report's count
                // equals the number of `connector` segments in the path (Req 9.3).
                const connectorSegments = path.segments.filter(
                    (s) => s.kind === 'connector',
                ).length;
                expect(report.connectorCount).toBe(connectorSegments);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 14 — Off-mode accounting
//
// Exercised through `PathPlanner.planWithReport` with connector hiding DISABLED
// (`connectorHiding: false`). The off-mode report must charge every connector's
// full Chebyshev length as Exposed_Travel, report a `totalHiddenTravel` of 0,
// and classify every connector as not hidden (Req 9.5). As with Property 13,
// these scenarios plan with `returnToHome: false` so the path carries exactly
// the woven inter-stroke connectors the report aggregates (no appended
// return-to-home connector), making the per-connector Chebyshev accounting
// directly checkable against the `connector` segments in the path.
// -----------------------------------------------------------------------------

/** Chebyshev step distance between two integer points: max(|dx|, |dy|). */
function chebyshev(a: Point, b: Point): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Full Chebyshev length of a connector segment: the sum of the Chebyshev step
 * distances over its adjacent point pairs. For an off-mode straight 2-point
 * connector this is just `chebyshev(exit, entry)`, but summing over adjacent
 * pairs is correct for any point count.
 */
function connectorChebyshevLength(seg: PlannedPath['segments'][number]): number {
    let total = 0;
    for (let i = 0; i + 1 < seg.pointsSteps.length; i++) {
        total += chebyshev(seg.pointsSteps[i]!, seg.pointsSteps[i + 1]!);
    }
    return total;
}

/**
 * Build the plan options for Property 14: connector hiding explicitly OFF, with
 * `returnToHome: false` so the path's `connector` segments are exactly the woven
 * inter-stroke connectors the off-mode report accounts for. The orthogonal knobs
 * from the scenario are applied first; the hiding/return overrides come last.
 */
function offReportOptions(s: Scenario): PlanOptions {
    return {
        ...s.extra,
        envelopeSteps: s.env,
        connectorHiding: false,
        returnToHome: false,
    };
}

describe('PathPlanner (connector hiding) — Property 14 (off-mode accounting)', () => {
    /**
     * **Validates: Requirements 9.5**
     *
     * For every planned path produced with connector hiding DISABLED, the
     * surfaced {@link ConnectorHidingReport} reflects the off-mode accounting:
     *
     *  - **Nothing is hidden (Req 9.5):** `totalHiddenTravel` is exactly 0, and
     *    every connector is classified not hidden — `notHiddenCount` equals the
     *    connector total while `fullyHiddenCount` and `partiallyHiddenCount` are
     *    both 0.
     *  - **Full Chebyshev length is Exposed (Req 9.5):** the reported
     *    `totalExposedTravel` equals the sum of the full Chebyshev lengths of
     *    the woven inter-stroke `connector` segments in the planned path. With
     *    `returnToHome: false` there is no appended return-to-home connector, so
     *    the path's `connector` segments are exactly the ones the report counts,
     *    and `connectorCount` matches that segment count.
     */
    // Feature: hidden-connector-routing, Property 14: Off-mode accounting — with hiding disabled, every connector's full Chebyshev length is its Exposed_Travel, totalHiddenTravel is 0, and every connector is classified not hidden
    it('charges every connector full Chebyshev length as Exposed, hides nothing, classifies all not hidden', () => {
        fc.assert(
            fc.property(arbScenario, (scenario) => {
                const opts = offReportOptions(scenario);
                const path = planner.planWithReport(scenario.input, opts);
                const report = path.connectorHiding;

                // The woven inter-stroke connector segments in the path. With
                // returnToHome:false there is no appended return-to-home
                // connector, so these are exactly the connectors the report
                // aggregates (Req 9.5).
                const connectorSegments = path.segments.filter(
                    (s) => s.kind === 'connector',
                );

                // connectorCount aggregates exactly the path's connectors.
                expect(report.connectorCount).toBe(connectorSegments.length);

                // Nothing is hidden in off mode (Req 9.5).
                expect(report.totalHiddenTravel).toBe(0);

                // Every connector classified not hidden; the other two classes
                // are empty (Req 9.5).
                expect(report.notHiddenCount).toBe(report.connectorCount);
                expect(report.fullyHiddenCount).toBe(0);
                expect(report.partiallyHiddenCount).toBe(0);

                // Each connector's full Chebyshev length is its Exposed_Travel,
                // so the total Exposed equals the summed Chebyshev length of the
                // path's connector segments (Req 9.5).
                const expectedExposed = connectorSegments.reduce(
                    (sum, seg) => sum + connectorChebyshevLength(seg),
                    0,
                );
                expect(report.totalExposedTravel).toBe(expectedExposed);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
