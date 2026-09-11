import { describe, it, expect } from 'vitest';
import { DrawnInkIndex, routeConnector } from './connector_router';
import type { StepEnvelope, ConnectorResult } from './connector_router';
import type { Point, PlannedSegment, PlannedPath, Polyline } from '../types';
import { PathPlanner } from './planner';
import type { PlanOptions } from './planner';
import { stitchPolylinesWithReport } from './stitch';

/**
 * Edge, example, and guard tests for the `Connector_Router` (spec task 12).
 *
 * This suite is organised into per-task `describe` blocks so the later
 * sub-tasks can be appended without restructuring:
 *   - 12.1 Guard edge cases            (this file, below) — Req 2.6, 2.7, 4.4
 *   - 12.2 API shape matrix            (appended later)    — Req 7.3, 7.4
 *   - 12.3 Edge routing example        (appended later)    — Req 1.4
 *   - 12.4 Budget tests                (appended later)    — Req 6.4, 8.2/8.3/8.4
 *
 * The router self-protects: `routeConnector` only ever feeds the guard suite
 * candidates of the form `exit → sExit → sEntry → entry` whose endpoints are
 * already in-envelope and already anchored to `exit`/`entry`. So some guards
 * (continuity / containment) cannot be made to fire from outside; for those we
 * assert the *observable* outcome the guards exist to guarantee (the emitted
 * connector is always anchored, always contained, always ≥ 2 points), exactly
 * as the design's "Non-property criteria" note prescribes.
 */

// -----------------------------------------------------------------------------
// Shared helpers (kept generic so tasks 12.2–12.4 can reuse them)
// -----------------------------------------------------------------------------

/** A 100 × 100 step envelope used by most cases. */
export const ENV: StepEnvelope = { x: 100, y: 100 };

/** Build a `PlannedSegment` of the given kind from integer-step points. */
function segment(kind: 'stroke' | 'connector', points: Point[]): PlannedSegment {
    return { kind, pointsSteps: points.map((p) => ({ x: p.x, y: p.y })) };
}

/** Build a stroke `PlannedSegment` from an ordered list of integer-step points. */
export function stroke(points: Point[]): PlannedSegment {
    return segment('stroke', points);
}

/** Chebyshev distance `max(|dx|, |dy|)` — the machine's per-move step count. */
export function chebyshev(a: Point, b: Point): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Build a `DrawnInkIndex` over `env` pre-loaded with the given strokes. */
export function inkIndexWith(env: StepEnvelope, ...strokes: PlannedSegment[]): DrawnInkIndex {
    const idx = new DrawnInkIndex(env);
    for (const s of strokes) idx.add(s);
    return idx;
}

/** Integer Chebyshev step positions traversed from `a` to `b` inclusive. */
export function stepsAlong(a: Point, b: Point): Point[] {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const n = Math.max(Math.abs(dx), Math.abs(dy));
    if (n === 0) return [{ x: a.x, y: a.y }];
    const out: Point[] = [];
    for (let i = 0; i <= n; i++) {
        out.push({ x: a.x + Math.round((dx * i) / n), y: a.y + Math.round((dy * i) / n) });
    }
    return out;
}

/** True iff `result`'s emitted segment is exactly the straight 2-point `[exit, entry]`. */
export function isStraightConnector(result: ConnectorResult, exit: Point, entry: Point): boolean {
    const pts = result.segment.pointsSteps;
    return (
        pts.length === 2 &&
        pts[0].x === exit.x &&
        pts[0].y === exit.y &&
        pts[1].x === entry.x &&
        pts[1].y === entry.y
    );
}

/** True iff every emitted point is within the inclusive envelope. */
export function pointsContained(result: ConnectorResult, env: StepEnvelope): boolean {
    return result.segment.pointsSteps.every(
        (p) => p.x >= 0 && p.x <= env.x && p.y >= 0 && p.y <= env.y,
    );
}

/** True iff every integer step traversed by the emitted route is within the envelope. */
export function everyStepContained(result: ConnectorResult, env: StepEnvelope): boolean {
    const pts = result.segment.pointsSteps;
    for (let i = 0; i + 1 < pts.length; i++) {
        for (const s of stepsAlong(pts[i], pts[i + 1])) {
            if (s.x < 0 || s.x > env.x || s.y < 0 || s.y > env.y) return false;
        }
    }
    return true;
}

/**
 * A scenario whose endpoints sit on the perimeter, so the router can hug the
 * envelope edges (zero-Exposed Hidden_Travel) for a strictly-improving
 * multi-point route. A tiny far-away ink stroke makes the index non-empty so
 * the hiding search actually runs (an empty index short-circuits to straight).
 */
function edgeHugScenario() {
    const env = ENV;
    const exit: Point = { x: 0, y: 50 }; // on the left edge
    const entry: Point = { x: env.x, y: 50 }; // on the right edge
    const ink = inkIndexWith(env, stroke([{ x: 10, y: 10 }, { x: 11, y: 10 }]));
    return { env, exit, entry, ink, straightLen: chebyshev(exit, entry) };
}

// -----------------------------------------------------------------------------
// 12.1 Guard edge cases (Req 2.6, 2.7, 4.4)
// -----------------------------------------------------------------------------

describe('Connector_Router guard: point-count bound (Req 2.7)', () => {
    it('emits a strictly-improving multi-point route when the point cap is generous', () => {
        // Baseline: with the default maxPoints (1000) the edge-hug route is a
        // legitimate, otherwise-good routed candidate. This is the route the
        // ">maxPoints" guard must reject in the next test.
        const { env, exit, entry, ink, straightLen } = edgeHugScenario();

        const result = routeConnector(exit, entry, ink, env);

        expect(result.segment.kind).toBe('connector');
        expect(result.segment.pointsSteps.length).toBeGreaterThan(2);
        expect(result.exposedTravel).toBe(0);
        expect(result.exposedTravel).toBeLessThan(straightLen);
        expect(result.rejected).toBe(false);
        expect(result.fellBack).toBe(false);
        // Conservation still holds for the emitted route.
        expect(result.hiddenTravel + result.exposedTravel).toBe(result.totalTravel);
    });

    it('rejects an otherwise-good route exceeding maxPoints and falls back to straight', () => {
        // maxPoints = 2 forces the upper-bound guard: the selected edge-hug
        // route has > 2 points after collapse, so it is discarded and the
        // straight 2-point connector is emitted, flagged rejected (Req 2.7).
        const { env, exit, entry, ink, straightLen } = edgeHugScenario();

        const result = routeConnector(exit, entry, ink, env, { maxPoints: 2 });

        expect(isStraightConnector(result, exit, entry)).toBe(true);
        expect(result.rejected).toBe(true);
        expect(result.fellBack).toBe(true);
        // The straight fallback's full Chebyshev length is all Exposed_Travel.
        expect(result.exposedTravel).toBe(straightLen);
        expect(result.hiddenTravel).toBe(0);
        expect(result.totalTravel).toBe(straightLen);
    });

    it('never emits fewer than 2 points (lower-bound guard is structurally guaranteed)', () => {
        // The "< 2 points after collapse" branch cannot be reached through the
        // public API because exit ≠ entry always yields ≥ 2 distinct points;
        // we assert the observable invariant the guard guarantees instead.
        const routed = routeConnector(
            { x: 0, y: 50 },
            { x: 100, y: 50 },
            inkIndexWith(ENV, stroke([{ x: 10, y: 10 }, { x: 11, y: 10 }])),
            ENV,
        );
        const fallback = routeConnector({ x: 5, y: 5 }, { x: 80, y: 80 }, new DrawnInkIndex(ENV), ENV);

        expect(routed.segment.pointsSteps.length).toBeGreaterThanOrEqual(2);
        expect(fallback.segment.pointsSteps.length).toBeGreaterThanOrEqual(2);
    });
});

describe('Connector_Router guard: continuity & endpoint anchoring (Req 2.6)', () => {
    // The router would discard any route that breaks continuity and emit the
    // straight connector, keeping the preceding/following segments unchanged.
    // Since `routeConnector` only ever builds anchored candidates, we assert
    // the observable guarantee: every emitted connector — routed or fallback —
    // begins exactly at `exit` and ends exactly at `entry`.
    const cases: Array<{ name: string; exit: Point; entry: Point; ink: DrawnInkIndex }> = [
        {
            name: 'routed edge-hug connector',
            exit: { x: 0, y: 50 },
            entry: { x: 100, y: 50 },
            ink: inkIndexWith(ENV, stroke([{ x: 10, y: 10 }, { x: 11, y: 10 }])),
        },
        {
            name: 'straight fallback (empty ink)',
            exit: { x: 12, y: 7 },
            entry: { x: 73, y: 64 },
            ink: new DrawnInkIndex(ENV),
        },
        {
            name: 'coincident endpoints',
            exit: { x: 40, y: 40 },
            entry: { x: 40, y: 40 },
            ink: inkIndexWith(ENV, stroke([{ x: 0, y: 0 }, { x: 5, y: 0 }])),
        },
    ];

    for (const c of cases) {
        it(`anchors first==exit and last==entry exactly: ${c.name}`, () => {
            const result = routeConnector(c.exit, c.entry, c.ink, ENV);
            const pts = result.segment.pointsSteps;
            expect(pts[0]).toEqual({ x: c.exit.x, y: c.exit.y });
            expect(pts[pts.length - 1]).toEqual({ x: c.entry.x, y: c.entry.y });
        });
    }

    it('keeps the preceding and following segments connected (neighbors retained)', () => {
        // Weave a tiny path: preceding stroke ends at `exit`, following stroke
        // starts at `entry`. Whatever the router emits, the connector must bridge
        // them so the Continuity_Invariant holds across all three segments.
        const exit: Point = { x: 0, y: 50 };
        const entry: Point = { x: 100, y: 50 };
        const preceding = stroke([{ x: 0, y: 90 }, exit]);
        const following = stroke([entry, { x: 100, y: 10 }]);

        const ink = inkIndexWith(ENV, preceding);
        const connector = routeConnector(exit, entry, ink, ENV).segment;

        const precLast = preceding.pointsSteps[preceding.pointsSteps.length - 1];
        const connFirst = connector.pointsSteps[0];
        const connLast = connector.pointsSteps[connector.pointsSteps.length - 1];
        const follFirst = following.pointsSteps[0];

        expect(connFirst).toEqual(precLast);
        expect(connLast).toEqual(follFirst);
        // The neighbors themselves are untouched by routing.
        expect(preceding.pointsSteps[0]).toEqual({ x: 0, y: 90 });
        expect(following.pointsSteps[1]).toEqual({ x: 100, y: 10 });
    });
});

describe('Connector_Router guard: envelope containment (Req 4.4)', () => {
    // An uncontainable route would be discarded with the containment failure
    // surfaced (rejected) and the straight fallback emitted. The router only
    // generates in-envelope candidates, so we assert the observable guarantee:
    // every emitted connector — and every step it traverses — stays inside the
    // inclusive envelope, and the always-safe straight fallback is contained.
    it('keeps every routed point and traversed step inside the envelope', () => {
        const { env, exit, entry, ink } = edgeHugScenario();
        const result = routeConnector(exit, entry, ink, env);

        expect(result.segment.pointsSteps.length).toBeGreaterThan(2); // actually routed
        expect(pointsContained(result, env)).toBe(true);
        expect(everyStepContained(result, env)).toBe(true);
    });

    it('contains routes whose endpoints sit in opposite envelope corners', () => {
        const env = ENV;
        const exit: Point = { x: 0, y: 0 };
        const entry: Point = { x: env.x, y: env.y };
        // Ink along two edges so an edge-hug improvement is available.
        const ink = inkIndexWith(
            env,
            stroke([{ x: 0, y: 0 }, { x: env.x, y: 0 }]),
            stroke([{ x: env.x, y: 0 }, { x: env.x, y: env.y }]),
        );

        const result = routeConnector(exit, entry, ink, env);

        expect(pointsContained(result, env)).toBe(true);
        expect(everyStepContained(result, env)).toBe(true);
        // Endpoints still anchored exactly.
        expect(result.segment.pointsSteps[0]).toEqual({ x: 0, y: 0 });
        expect(result.segment.pointsSteps[result.segment.pointsSteps.length - 1]).toEqual({
            x: env.x,
            y: env.y,
        });
    });

    it('falls back to the always-containable straight connector when no hidden route helps', () => {
        // No relevant ink near the gap: the straight 2-point fallback is emitted,
        // which between two in-envelope endpoints is itself always contained.
        const env = ENV;
        const exit: Point = { x: 20, y: 20 };
        const entry: Point = { x: 70, y: 70 };
        const ink = inkIndexWith(env, stroke([{ x: 5, y: 95 }, { x: 6, y: 95 }]));

        const result = routeConnector(exit, entry, ink, env);

        expect(isStraightConnector(result, exit, entry)).toBe(true);
        expect(result.fellBack).toBe(true);
        expect(pointsContained(result, env)).toBe(true);
        expect(everyStepContained(result, env)).toBe(true);
    });
});

// -----------------------------------------------------------------------------
// 12.2 API shape matrix (Req 7.3, 7.4)
// -----------------------------------------------------------------------------
//
// The opt-in `connectorHiding` flag must be a well-behaved, backward-compatible
// option:
//   - Req 7.4: absent ⇒ disabled; an absent/false flag still returns a valid
//     `PlannedPath` and never throws.
//   - Req 7.3: the flag is exposed independent of the `twoOpt` stroke-order
//     refinement value (true OR false) and of every other option — toggling
//     hiding never changes the `stroke` segments, only how connectors are woven.
//
// `PathPlanner.plan` hardcodes `twoOpt: true` on the envelope-fit branch (the
// only branch where hiding is meaningful), so the `{twoOpt: true/false}`
// dimension of the matrix is exercised on the surface where `twoOpt` is
// actually configurable: `stitchPolylinesWithReport` (a `StitchOptions` field).
// We therefore drive the matrix on BOTH surfaces:
//   (A) plan-level — the `{connectorHiding}` dimension through `PathPlanner.plan`
//       with `envelopeSteps`, asserting a valid `PlannedPath`, default-disabled,
//       and stroke-segment independence.
//   (B) stitch-level — the full `{connectorHiding} × {twoOpt}` matrix, asserting
//       hiding is independent of `twoOpt` (identical strokes) and never throws.

/** Assert adjacent segments are endpoint-joined and each has ≥ 2 points. */
function expectContiguousSegments(segments: PlannedSegment[]): void {
    for (let i = 0; i < segments.length; i++) {
        expect(segments[i]!.pointsSteps.length).toBeGreaterThanOrEqual(2);
        if (i + 1 < segments.length) {
            const last = segments[i]!.pointsSteps[segments[i]!.pointsSteps.length - 1]!;
            const nextFirst = segments[i + 1]!.pointsSteps[0]!;
            expect(last).toEqual(nextFirst);
        }
    }
}

/** Assert `path` satisfies the `PlannedPath` invariants (contiguity + bounds). */
function expectValidPlannedPath(path: PlannedPath): void {
    expect(path.segments.length).toBeGreaterThan(0);
    expectContiguousSegments(path.segments);
    const { w, h } = path.drawableSteps;
    for (const seg of path.segments) {
        for (const p of seg.pointsSteps) {
            expect(Number.isInteger(p.x)).toBe(true);
            expect(Number.isInteger(p.y)).toBe(true);
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(w);
            expect(p.y).toBeLessThanOrEqual(h);
        }
    }
}

/** The ordered `stroke` segments' point sequences — the part hiding must NOT change. */
function strokeSequences(segments: PlannedSegment[]): Point[][] {
    return segments
        .filter((s) => s.kind === 'stroke')
        .map((s) => s.pointsSteps.map((p) => ({ x: p.x, y: p.y })));
}

describe('Connector_Router API shape matrix (Req 7.3, 7.4)', () => {
    // A multi-contour drawing: several disjoint polylines force inter-stroke
    // connectors (so hiding has something to route), and the gaps make the
    // 2-opt refinement observable.
    const polylines: Polyline[] = [
        [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }],
        [{ x: 0, y: 60 }, { x: 30, y: 60 }],
        [{ x: 60, y: 0 }, { x: 60, y: 40 }],
        [{ x: 10, y: 10 }, { x: 45, y: 45 }],
    ];
    const env = { x: 100, y: 100 };

    // -------------------------------------------------------------------------
    // (A) plan-level: the {connectorHiding} dimension via PathPlanner.plan
    // -------------------------------------------------------------------------
    const hidingVariants: Array<{ name: string; opts: PlanOptions }> = [
        { name: 'absent', opts: { envelopeSteps: env } },
        { name: 'false', opts: { envelopeSteps: env, connectorHiding: false } },
        { name: 'true', opts: { envelopeSteps: env, connectorHiding: true } },
    ];

    for (const variant of hidingVariants) {
        it(`plan() returns a valid PlannedPath and never throws (connectorHiding: ${variant.name})`, () => {
            const planner = new PathPlanner();
            let path!: PlannedPath;
            expect(() => {
                path = planner.plan({ polylines }, variant.opts);
            }).not.toThrow();
            expectValidPlannedPath(path);
        });
    }

    it('treats an absent connectorHiding flag as disabled — byte-for-byte equal to false (Req 7.4)', () => {
        const planner = new PathPlanner();
        const absent = planner.plan({ polylines }, { envelopeSteps: env });
        const explicitFalse = planner.plan(
            { polylines },
            { envelopeSteps: env, connectorHiding: false },
        );
        // Default-disabled: omitting the flag must be identical to passing false.
        expect(absent).toEqual(explicitFalse);
    });

    it('keeps the stroke segments independent of the connectorHiding value (Req 7.3)', () => {
        const planner = new PathPlanner();
        const strokesByVariant = hidingVariants.map((v) =>
            strokeSequences(planner.plan({ polylines }, v.opts).segments),
        );
        // Toggling hiding only changes how connectors are woven, never the
        // stroke order or per-stroke point sequences.
        expect(strokesByVariant[1]).toEqual(strokesByVariant[0]);
        expect(strokesByVariant[2]).toEqual(strokesByVariant[0]);
    });

    // -------------------------------------------------------------------------
    // (B) stitch-level: the full {connectorHiding: true/false/absent} ×
    //     {twoOpt: true/false} matrix, where twoOpt is a configurable surface
    // -------------------------------------------------------------------------
    // Integer step-space contours (the stitcher does not scale its inputs).
    const stitchPolys: Polyline[] = [
        [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }],
        [{ x: 0, y: 60 }, { x: 30, y: 60 }],
        [{ x: 60, y: 0 }, { x: 60, y: 40 }],
        [{ x: 10, y: 10 }, { x: 45, y: 45 }],
    ];

    const hidingAxis: Array<{ name: string; connectorHiding?: boolean }> = [
        { name: 'absent' },
        { name: 'false', connectorHiding: false },
        { name: 'true', connectorHiding: true },
    ];

    for (const twoOpt of [false, true]) {
        // Baseline strokes for this twoOpt value, with hiding off. Every hiding
        // variant at the same twoOpt must reproduce these strokes exactly.
        for (const hiding of hidingAxis) {
            it(`stitch matrix never throws and stays contiguous (twoOpt: ${twoOpt}, connectorHiding: ${hiding.name})`, () => {
                let segments!: PlannedSegment[];
                expect(() => {
                    segments = stitchPolylinesWithReport(stitchPolys, {
                        start: { x: 0, y: 0 },
                        twoOpt,
                        env,
                        ...(hiding.connectorHiding !== undefined
                            ? { connectorHiding: hiding.connectorHiding }
                            : {}),
                    }).segments;
                }).not.toThrow();
                expect(segments.length).toBeGreaterThan(0);
                expectContiguousSegments(segments);
            });
        }

        it(`connectorHiding is independent of twoOpt=${twoOpt}: identical strokes on or off (Req 7.3)`, () => {
            const off = stitchPolylinesWithReport(stitchPolys, {
                start: { x: 0, y: 0 },
                twoOpt,
                env,
            }).segments;
            const on = stitchPolylinesWithReport(stitchPolys, {
                start: { x: 0, y: 0 },
                twoOpt,
                env,
                connectorHiding: true,
            }).segments;
            expect(strokeSequences(on)).toEqual(strokeSequences(off));
        });
    }
});

// -----------------------------------------------------------------------------
// 12.3 Edge routing example (Req 1.4)
// -----------------------------------------------------------------------------
//
// The envelope's four inclusive perimeter edges are routable, zero-Exposed ink
// even before any stroke is drawn near them (Req 1.4) — exactly how
// `appendEdgeReturnToHome` hugs the border to reach home instead of slashing
// across the art. This example pins that behavior for a general inter-stroke
// connector: when the exit/entry endpoints sit on the perimeter, the router
// must hug the envelope edges, producing a multi-point route that is fully
// Hidden (Exposed_Travel == 0), axis-aligned along the boundary, and contained.

/** True iff `p` lies on one of the four inclusive envelope perimeter edges. */
function onPerimeter(p: Point, env: StepEnvelope): boolean {
    return p.x === 0 || p.x === env.x || p.y === 0 || p.y === env.y;
}

/**
 * True iff the leg `[a, b]` runs along a single envelope perimeter edge: it is
 * axis-aligned (changes exactly one coordinate) and the shared constant
 * coordinate pins it to a boundary line (x ∈ {0, env.x} or y ∈ {0, env.y}).
 * This is the same "every leg hugs an edge" guarantee `appendEdgeReturnToHome`
 * provides for the return-to-home connector.
 */
function legAlongEdge(a: Point, b: Point, env: StepEnvelope): boolean {
    const vertical = a.x === b.x && (a.x === 0 || a.x === env.x) && a.y !== b.y;
    const horizontal = a.y === b.y && (a.y === 0 || a.y === env.y) && a.x !== b.x;
    return vertical || horizontal;
}

describe('Connector_Router edge routing example (Req 1.4)', () => {
    it('hugs the envelope edges with zero Exposed for perimeter endpoints', () => {
        // exit on the left edge, entry on the right edge: the straight hop is a
        // 100-step line straight across the middle of the art (all Exposed). The
        // router instead drops to the nearest perimeter corner and runs along
        // the boundary, mirroring appendEdgeReturnToHome.
        const { env, exit, entry, ink, straightLen } = edgeHugScenario();

        const result = routeConnector(exit, entry, ink, env);
        const pts = result.segment.pointsSteps;

        // It is a routed connector, not the straight 2-point fallback.
        expect(result.segment.kind).toBe('connector');
        expect(pts.length).toBeGreaterThan(2);
        expect(result.fellBack).toBe(false);
        expect(result.rejected).toBe(false);

        // Routing over edges is entirely Hidden_Travel: zero Exposed, and it
        // strictly beats the straight baseline (Req 1.4, 5.2).
        expect(result.exposedTravel).toBe(0);
        expect(result.exposedTravel).toBeLessThan(straightLen);
        expect(result.hiddenTravel).toBe(result.totalTravel);
        expect(result.hiddenTravel + result.exposedTravel).toBe(result.totalTravel);

        // Endpoints anchored exactly (continuity).
        expect(pts[0]).toEqual({ x: exit.x, y: exit.y });
        expect(pts[pts.length - 1]).toEqual({ x: entry.x, y: entry.y });

        // The route follows the perimeter: every waypoint sits on an edge and
        // every leg runs along a single boundary line (axis-aligned edge hop).
        for (const p of pts) {
            expect(onPerimeter(p, env)).toBe(true);
        }
        for (let i = 0; i + 1 < pts.length; i++) {
            expect(legAlongEdge(pts[i], pts[i + 1], env)).toBe(true);
        }

        // The whole route — and every integer step along it — stays contained.
        expect(pointsContained(result, env)).toBe(true);
        expect(everyStepContained(result, env)).toBe(true);
    });

    it('routes a corner-to-corner connector along two adjoining edges (zero Exposed)', () => {
        // exit at the bottom-left corner, entry at the top-right corner. The
        // straight hop is a full diagonal across the art; hugging two adjoining
        // edges (up the left/right side, across the top/bottom) hides it all.
        const env = ENV;
        const exit: Point = { x: 0, y: 0 };
        const entry: Point = { x: env.x, y: env.y };
        // Non-empty, far-away ink so the hiding search actually runs.
        const ink = inkIndexWith(env, stroke([{ x: 40, y: 40 }, { x: 41, y: 40 }]));
        const straightLen = chebyshev(exit, entry);

        const result = routeConnector(exit, entry, ink, env);
        const pts = result.segment.pointsSteps;

        expect(result.segment.kind).toBe('connector');
        expect(pts.length).toBeGreaterThan(2);
        expect(result.exposedTravel).toBe(0);
        expect(result.exposedTravel).toBeLessThan(straightLen);
        expect(result.hiddenTravel).toBe(result.totalTravel);

        // Anchored, on-perimeter, and edge-following throughout.
        expect(pts[0]).toEqual({ x: 0, y: 0 });
        expect(pts[pts.length - 1]).toEqual({ x: env.x, y: env.y });
        for (const p of pts) {
            expect(onPerimeter(p, env)).toBe(true);
        }
        for (let i = 0; i + 1 < pts.length; i++) {
            expect(legAlongEdge(pts[i], pts[i + 1], env)).toBe(true);
        }
        expect(everyStepContained(result, env)).toBe(true);
    });
});

// -----------------------------------------------------------------------------
// 12.4 Budget tests (Req 6.4, 8.2, 8.3, 8.4)
// -----------------------------------------------------------------------------
//
// The router/stitcher self-protect against pathological inputs with two budgets
// that must NEVER compromise correctness — only how hard we search:
//
//   - Per-connector candidate cap (`maxCandidates`, default 32, Req 8.2/8.3):
//     `routeConnector` evaluates at most `maxCandidates` distinct candidate
//     routes and then emits the best strictly-improving one found so far, else
//     the straight fallback. A LOW cap must still yield a complete, valid
//     connector with `Exposed ≤ straight` (Req 6.4). The candidate counter is
//     internal; we cannot read it without changing the source, so we assert the
//     OBSERVABLE guarantee the default cap exists to provide: the default
//     behavior is exactly the `maxCandidates: 32` behavior (byte-for-byte), and
//     across many scenarios no result ever has `Exposed > straight`.
//
//   - Global time budget (`timeBudgetMs`, default 5000, Req 8.4): enforced by
//     the stitch loop between connectors via an injected clock — NOT inside the
//     pure `routeConnector`. Once the budget is exceeded, every remaining gap is
//     emitted as a straight connector and a complete, contiguous plan is still
//     returned (Req 8.4, 6.4). We drive this through `stitchPolylinesWithReport`
//     with a tiny budget and a clock that jumps past it.

import {
    DEFAULT_MAX_CANDIDATES,
    type RouterOptions,
} from './connector_router';

/**
 * A spread of router scenarios used to exercise the candidate-cap budget across
 * varied geometry: empty ink (short-circuit), far-away irrelevant ink (straight
 * fallback), and edge-hug ink (a genuine multi-point routed improvement). Each
 * must satisfy `Exposed ≤ straight` no matter the cap.
 */
function budgetScenarios(): Array<{
    name: string;
    exit: Point;
    entry: Point;
    ink: DrawnInkIndex;
    straightLen: number;
}> {
    const env = ENV;
    return [
        {
            name: 'empty ink (short-circuits to straight)',
            exit: { x: 10, y: 10 },
            entry: { x: 80, y: 80 },
            ink: new DrawnInkIndex(env),
            straightLen: chebyshev({ x: 10, y: 10 }, { x: 80, y: 80 }),
        },
        {
            name: 'far-away ink (no improvement available)',
            exit: { x: 20, y: 20 },
            entry: { x: 70, y: 70 },
            ink: inkIndexWith(env, stroke([{ x: 5, y: 95 }, { x: 6, y: 95 }])),
            straightLen: chebyshev({ x: 20, y: 20 }, { x: 70, y: 70 }),
        },
        {
            name: 'edge-hug ink (genuine multi-point improvement)',
            exit: { x: 0, y: 50 },
            entry: { x: 100, y: 50 },
            ink: inkIndexWith(env, stroke([{ x: 10, y: 10 }, { x: 11, y: 10 }])),
            straightLen: chebyshev({ x: 0, y: 50 }, { x: 100, y: 50 }),
        },
        {
            name: 'corner-to-corner edge-hug ink',
            exit: { x: 0, y: 0 },
            entry: { x: 100, y: 100 },
            ink: inkIndexWith(
                env,
                stroke([{ x: 0, y: 0 }, { x: env.x, y: 0 }]),
                stroke([{ x: env.x, y: 0 }, { x: env.x, y: env.y }]),
            ),
            straightLen: chebyshev({ x: 0, y: 0 }, { x: 100, y: 100 }),
        },
    ];
}

describe('Connector_Router per-connector candidate cap (Req 6.4, 8.2, 8.3)', () => {
    it('the documented default cap is 32', () => {
        expect(DEFAULT_MAX_CANDIDATES).toBe(32);
    });

    it('produces a complete, valid connector with Exposed ≤ straight under a LOW maxCandidates', () => {
        // maxCandidates = 1 is the most aggressive cap: at most one candidate is
        // ever scored before the search stops. The connector must still be a
        // complete, well-formed, contained, anchored route that never increases
        // visible ink (Req 6.4).
        for (const sc of budgetScenarios()) {
            const result = routeConnector(sc.exit, sc.entry, sc.ink, ENV, { maxCandidates: 1 });
            const pts = result.segment.pointsSteps;

            // Complete & well-formed.
            expect(result.segment.kind).toBe('connector');
            expect(pts.length).toBeGreaterThanOrEqual(2);
            // Anchored exactly to the endpoints (continuity).
            expect(pts[0]).toEqual({ x: sc.exit.x, y: sc.exit.y });
            expect(pts[pts.length - 1]).toEqual({ x: sc.entry.x, y: sc.entry.y });
            // Never increases visible ink (Req 6.4 / Property 1).
            expect(result.exposedTravel).toBeLessThanOrEqual(sc.straightLen);
            // Contained, and conservation holds.
            expect(pointsContained(result, ENV)).toBe(true);
            expect(everyStepContained(result, ENV)).toBe(true);
            expect(result.hiddenTravel + result.exposedTravel).toBe(result.totalTravel);
        }
    });

    it('keeps Exposed ≤ straight for every cap from 1 up past the default', () => {
        // Whatever the cap, the result is always at least as good as the
        // straight baseline — a low cap may forgo a better route but can never
        // make one worse than straight (Req 6.4, 8.3).
        const caps = [1, 2, 4, 8, 16, 32, 64, 1000];
        for (const sc of budgetScenarios()) {
            for (const maxCandidates of caps) {
                const result = routeConnector(sc.exit, sc.entry, sc.ink, ENV, { maxCandidates });
                expect(result.exposedTravel).toBeLessThanOrEqual(sc.straightLen);
                expect(result.hiddenTravel + result.exposedTravel).toBe(result.totalTravel);
                expect(pointsContained(result, ENV)).toBe(true);
            }
        }
    });

    it('default behavior equals an explicit maxCandidates: 32 — the candidate counter never exceeds 32', () => {
        // The internal per-connector candidate counter is not observable without
        // modifying the source, so we assert the equivalent guarantee: the
        // DEFAULT search already stops at 32 candidates. If the default counter
        // ever exceeded 32, raising the explicit cap to 64 would let it find a
        // strictly-better route and the outputs would diverge. Equality across
        // every scenario therefore witnesses "counter ≤ 32" for the default.
        for (const sc of budgetScenarios()) {
            const dflt = routeConnector(sc.exit, sc.entry, sc.ink, ENV);
            const explicit32 = routeConnector(sc.exit, sc.entry, sc.ink, ENV, {
                maxCandidates: DEFAULT_MAX_CANDIDATES,
            });
            const explicit64 = routeConnector(sc.exit, sc.entry, sc.ink, ENV, {
                maxCandidates: DEFAULT_MAX_CANDIDATES * 2,
            });
            // Default == explicit 32: the default cap IS 32.
            expect(dflt).toEqual(explicit32);
            // Raising the cap to 64 changes nothing: the default search already
            // exhausted (≤ 32) candidates, so no further candidate was withheld.
            expect(dflt).toEqual(explicit64);
        }
    });
});

// A multi-contour drawing whose disjoint polylines force several inter-stroke
// connectors, so the time-budget cutover has multiple gaps to convert to
// straight. Endpoints reach toward the perimeter so hiding WOULD route them
// under a generous budget — making the over-budget straight result observable.
const BUDGET_POLYS: Polyline[] = [
    [{ x: 0, y: 50 }, { x: 30, y: 50 }],
    [{ x: 100, y: 50 }, { x: 70, y: 50 }],
    [{ x: 0, y: 0 }, { x: 0, y: 20 }],
    [{ x: 100, y: 100 }, { x: 80, y: 100 }],
    [{ x: 50, y: 0 }, { x: 50, y: 25 }],
];
const BUDGET_ENV: StepEnvelope = { x: 100, y: 100 };

/**
 * A controllable monotonic clock for the stitch loop. The loop reads the clock
 * once for its start time and then once per connector gap. `advanceAfterFirst`
 * is the value every call after the first returns, so passing a value `≥
 * timeBudgetMs` forces every gap to be judged over-budget.
 */
function makeClock(firstValue: number, advanceAfterFirst: number): () => number {
    let calls = 0;
    return () => {
        calls += 1;
        return calls === 1 ? firstValue : advanceAfterFirst;
    };
}

describe('Connector_Router global time budget (Req 8.4, 6.4)', () => {
    it('returns a complete, contiguous plan with straight connectors when the budget is exceeded', () => {
        // Clock starts at 0, then jumps to 1e9 on every subsequent read — far
        // beyond the tiny 1 ms budget — so the loop converts every remaining gap
        // to a straight connector before routing it.
        const tinyBudget: RouterOptions = { timeBudgetMs: 1 };
        const overBudgetClock = makeClock(0, 1_000_000_000);

        const { segments, connectors } = stitchPolylinesWithReport(BUDGET_POLYS, {
            start: { x: 0, y: 0 },
            twoOpt: true,
            env: BUDGET_ENV,
            connectorHiding: true,
            routerOptions: tinyBudget,
            clock: overBudgetClock,
        });

        // Complete & contiguous: a full plan is still produced (Req 8.4).
        expect(segments.length).toBeGreaterThan(0);
        expectContiguousSegments(segments);
        expect(connectors.length).toBeGreaterThan(0);

        // Every connector emitted under the exhausted budget is the straight
        // 2-point fallback: it hides nothing, so its full Chebyshev length is
        // Exposed — which is exactly `≤ straight` (equality), never more.
        for (const c of connectors) {
            const pts = c.segment.pointsSteps;
            expect(pts.length).toBe(2);
            const straightLen = chebyshev(pts[0]!, pts[pts.length - 1]!);
            expect(c.fellBack).toBe(true);
            expect(c.hiddenTravel).toBe(0);
            expect(c.exposedTravel).toBe(straightLen);
            expect(c.exposedTravel).toBeLessThanOrEqual(straightLen);
            expect(c.hiddenTravel + c.exposedTravel).toBe(c.totalTravel);
        }
    });

    it('an over-budget hiding plan is identical to the hiding-off (straight-connector) plan', () => {
        // With the budget exhausted before the first gap, hiding-on must produce
        // exactly the same segments as hiding-off: same stroke order/orientation
        // AND straight connectors for every gap (Req 8.4). This pins "straight
        // connectors for unprocessed gaps" byte-for-byte.
        const overBudgetClock = makeClock(0, 1_000_000_000);

        const on = stitchPolylinesWithReport(BUDGET_POLYS, {
            start: { x: 0, y: 0 },
            twoOpt: true,
            env: BUDGET_ENV,
            connectorHiding: true,
            routerOptions: { timeBudgetMs: 1 },
            clock: overBudgetClock,
        }).segments;

        const off = stitchPolylinesWithReport(BUDGET_POLYS, {
            start: { x: 0, y: 0 },
            twoOpt: true,
            env: BUDGET_ENV,
        }).segments;

        expect(on).toEqual(off);
    });

    it('still returns a complete, valid plan under a generous budget (clock never trips)', () => {
        // Control: a clock pinned at 0 never exceeds even a tiny budget's start
        // reference, so routing proceeds normally and the plan is still complete,
        // contiguous, and every connector satisfies Exposed ≤ its own straight
        // baseline (Req 6.4).
        const steadyClock = makeClock(0, 0);

        const { segments, connectors } = stitchPolylinesWithReport(BUDGET_POLYS, {
            start: { x: 0, y: 0 },
            twoOpt: true,
            env: BUDGET_ENV,
            connectorHiding: true,
            clock: steadyClock,
        });

        expect(segments.length).toBeGreaterThan(0);
        expectContiguousSegments(segments);
        for (const c of connectors) {
            const pts = c.segment.pointsSteps;
            const straightLen = chebyshev(pts[0]!, pts[pts.length - 1]!);
            expect(c.exposedTravel).toBeLessThanOrEqual(straightLen);
            expect(c.hiddenTravel + c.exposedTravel).toBe(c.totalTravel);
        }
    });
});
