/**
 * Nearest-neighbor polyline stitching with endpoint flipping.
 *
 * The Etch-a-Sketch stylus cannot lift, so a multi-contour drawing must
 * be linearised into a single continuous stroke. This module performs
 * step (4) of the path pipeline:
 *
 *   1. Scale/clamp     →  mm-space polylines inside the drawable area
 *   2. Step conversion →  integer-step polylines
 *   3. RDP simplify    →  fewer points per polyline
 *   4. NN stitch       ←  *this module*  (order + connectors)
 *   5. Auto-return     ←  *this module*  (`appendReturnToHome`)
 *
 * Greedy heuristic: starting from the current pen position
 * (defaulting to `(0, 0)`, i.e. home), repeatedly pick the unused
 * polyline whose nearest endpoint - its first or its last point - lies
 * closest to the pen, traverse it in the orientation that matches that
 * endpoint, then advance the pen to the polyline's far end. Allowing
 * the polyline to be FLIPPED (reversed) so its closer endpoint becomes
 * the entry point minimises the length of the connecting hop
 * (Req 14.2, 14.3). Between successive polylines emit a straight-line
 * `connector` segment, but suppress it when the gap is exactly zero
 * (the previous stroke already ended at the next stroke's start).
 *
 * The resulting `PlannedSegment[]` is contiguous: each segment's last
 * point equals the next segment's first point (Req 14.1). This is the
 * continuity invariant that downstream stages (G-code emit,
 * Drawing_Command codec) rely on, asserted by the unit tests in
 * `stitch.test.ts` and by the property test in task 12.3.
 *
 * Auto-return to home is appended separately by `appendReturnToHome`,
 * which adds a final `connector` segment from the path's last point
 * back to home (Req 10.7, 14.7).
 *
 * Coordinates flow through unchanged: the planner runs scale/step
 * conversion before stitching so inputs are normally integer step
 * coordinates, but the function is numeric-generic and works on floats
 * too.
 *
 * Determinism note: ties in nearest-endpoint distance are broken by
 * (a) earlier index in the input array, then (b) forward orientation
 * before reversed orientation. The ordering is therefore a pure
 * function of the input polylines and `start`.
 *
 * @see Requirements 4.7, 14.1, 14.2, 14.3
 * @see Design §3.1.4 (path pipeline), Property 11
 */

import type { Point, Polyline, PlannedSegment } from '../types';
import { orderPolylinesNearestNeighbor } from './nn_order';
import {
    DrawnInkIndex,
    routeConnector,
    DEFAULT_TIME_BUDGET_MS,
    type StepEnvelope,
    type RouterOptions,
    type ConnectorResult,
} from './connector_router';

/**
 * Options for {@link stitchPolylines}.
 */
export interface StitchOptions {
    /**
     * Pen position before the first stroke, used as the origin of the
     * nearest-neighbor search. Defaults to home, `(0, 0)`, which matches
     * the canonical origin for fresh drawings. Use the current logical
     * position when stitching a continuation.
     */
    start?: Point;
    /**
     * When true, refine the greedy nearest-neighbor stroke order with a
     * deterministic 2-opt pass (see {@link orderPolylinesNearestNeighbor}'s
     * `twoOpt`) that minimizes total Chebyshev connector travel before the
     * connectors are woven. Defaults to `false` so the bare greedy behavior
     * (and its property tests) are unchanged; the planner opts in because its
     * stroke order is the one that reaches the machine.
     */
    twoOpt?: boolean;
    /**
     * Opt-in connector hiding (Req 7.3). When falsy (the default), the stitcher
     * weaves straight 2-point connectors exactly as before — byte-for-byte
     * identical output (Req 7.2). When set, connectors are routed over
     * already-drawn ink and envelope edges to minimize visible travel. Routing
     * runs strictly AFTER the final stroke order/orientation are decided
     * (Req 7.5, 7.6), so the `stroke` segments are unchanged either way.
     * Requires {@link env} to be supplied; without it the stitcher degrades to
     * straight connectors.
     */
    connectorHiding?: boolean;
    /**
     * Inclusive integer step envelope `[0, env.x] × [0, env.y]`, required when
     * {@link connectorHiding} is set (Req 1.4, 4.1) — the router needs it to
     * route over perimeter edges and to enforce containment.
     */
    env?: StepEnvelope;
    /** Router tuning forwarded to {@link routeConnector} (Req 8). */
    routerOptions?: RouterOptions;
    /**
     * Injected monotonic clock (milliseconds) used only to enforce the global
     * routing time budget between connectors (Req 8.4). Defaults to
     * `Date.now`. Tests inject a controllable clock; the router core itself
     * stays pure (it never reads the clock), so determinism (Req 3.1) is
     * preserved — the clock only decides WHEN to stop routing further gaps, not
     * HOW any individual connector is routed.
     */
    clock?: () => number;
}

/**
 * Order `polys` greedily by nearest endpoint, allowing per-polyline
 * direction flips, and weave straight-line connectors between them.
 *
 * Polylines with fewer than two points have no length to draw and are
 * dropped before stitching. An empty input (after filtering) yields an
 * empty result.
 *
 * @param polys      Source polylines in any coordinate system; the
 *                   coordinates flow through unchanged into the
 *                   `pointsSteps` field of the returned segments.
 *                   Polylines must be length ≥ 2 to contribute; shorter
 *                   ones are dropped.
 * @param opts.start Pen position before the first stroke; default `{x:0, y:0}`.
 * @returns          A `PlannedSegment[]` whose adjacent segments share
 *                   endpoints. The first segment may be a `connector`
 *                   (when the first polyline does not start at `start`)
 *                   or a `stroke` (when it does).
 */
export function stitchPolylines(
    polys: Polyline[],
    opts: StitchOptions = {},
): PlannedSegment[] {
    // Delegate to the report-producing variant and discard the per-connector
    // report. The default (hiding-off) path inside is the verbatim original
    // straight-connector loop, so this preserves byte-for-byte output (Req 7.2).
    return stitchPolylinesWithReport(polys, opts).segments;
}

/**
 * Like {@link stitchPolylines}, but also returns the per-connector
 * {@link ConnectorResult} list so the planner can aggregate the connector
 * hiding observability report (Req 9).
 *
 * Two branches share the SAME `orderPolylinesNearestNeighbor` ordering so the
 * `stroke` segments (order and orientation) are identical regardless of whether
 * hiding is on (Req 7.5, 7.6, Property 12):
 *
 * - **Hiding off (default).** Runs the original straight-connector loop
 *   unchanged, producing output byte-for-byte identical to before this feature
 *   existed (Req 7.1, 7.2). The returned `connectors` list is empty; the
 *   planner computes the off-mode accounting separately (Req 9.5).
 * - **Hiding on.** Weaves connectors incrementally: it maintains a
 *   {@link DrawnInkIndex} of every stroke and routed connector emitted so far
 *   and calls {@link routeConnector} for each gap, so connector index `i` only
 *   ever hides over ink at indices `< i` (Req 1.3). Each emitted stroke and
 *   connector is added to the index before the next gap is routed.
 *
 * The global routing time budget (Req 8.4) is enforced here, not in the pure
 * router: an injected {@link StitchOptions.clock} is read between connectors,
 * and once `timeBudgetMs` is exceeded every remaining gap is emitted as a
 * straight connector so a complete plan is still returned.
 */
export function stitchPolylinesWithReport(
    polys: Polyline[],
    opts: StitchOptions = {},
): { segments: PlannedSegment[]; connectors: ConnectorResult[] } {
    const start: Point = opts.start ?? { x: 0, y: 0 };

    // Order strokes by nearest endpoint (with per-stroke flips), optionally
    // refined by a 2-opt connector-travel pass. The shared ordering helper is
    // the single canonical implementation reused by the Image_Processor too,
    // so the two never diverge. Polylines with < 2 points have no length to
    // draw and are dropped (minPoints: 2). The result is ordered, oriented
    // entry-first, and never aliases the inputs.
    const ordered = orderPolylinesNearestNeighbor(polys, start, {
        minPoints: 2,
        ...(opts.twoOpt ? { twoOpt: true } : {}),
    });
    if (ordered.length === 0) return { segments: [], connectors: [] };

    // Opt-in connector hiding requires an envelope to route over edges and to
    // enforce containment. With hiding off (or no envelope), fall through to
    // the original straight-connector loop, kept verbatim for Req 7.2.
    if (opts.connectorHiding && opts.env) {
        return weaveWithRouter(ordered, start, opts.env, opts);
    }

    const result: PlannedSegment[] = [];
    let current: Point = { x: start.x, y: start.y };

    for (const oriented of ordered) {
        const segStart = oriented[0]!;
        const segEnd = oriented[oriented.length - 1]!;

        // Emit a connector only when the pen actually has to move. A
        // zero-length connector would violate the no-zero-length-segment
        // invariant on PlannedSegment and add wire-format noise.
        if (segStart.x !== current.x || segStart.y !== current.y) {
            result.push({
                kind: 'connector',
                pointsSteps: [
                    { x: current.x, y: current.y },
                    { x: segStart.x, y: segStart.y },
                ],
            });
        }

        result.push({
            kind: 'stroke',
            pointsSteps: oriented.map((p) => ({ x: p.x, y: p.y })),
        });

        current = { x: segEnd.x, y: segEnd.y };
    }

    return { segments: result, connectors: [] };
}

/**
 * Chebyshev (max-coordinate) distance — the machine's per-move step count and
 * the metric used to charge connector travel (Req 1.1, 8.4). Local copy so the
 * stitcher can score the straight over-budget fallback without depending on the
 * router's private helper.
 */
function chebyshevSteps(a: Point, b: Point): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Build the straight 2-point connector {@link ConnectorResult} for `[exit,
 * entry]`, charging its full Chebyshev length as Exposed_Travel (it hides
 * nothing). Used when the global time budget is exhausted (Req 8.4).
 */
function straightConnectorResult(exit: Point, entry: Point): ConnectorResult {
    const len = chebyshevSteps(exit, entry);
    return {
        segment: {
            kind: 'connector',
            pointsSteps: [
                { x: exit.x, y: exit.y },
                { x: entry.x, y: entry.y },
            ],
        },
        hiddenTravel: 0,
        exposedTravel: len,
        totalTravel: len,
        fellBack: true,
        rejected: false,
    };
}

/**
 * The opt-in branch: weave connectors incrementally over already-drawn ink.
 *
 * Walks the already-ordered, already-oriented strokes front to back. For each
 * gap between the running pen position and the next stroke's entry point it
 * routes a connector against the ink committed so far ({@link DrawnInkIndex}),
 * then commits both the connector and the stroke to the index before advancing
 * — so later connectors can hide over earlier ones (Req 1.3). The global time
 * budget is checked via the injected clock between connectors (Req 8.4).
 */
function weaveWithRouter(
    ordered: Point[][],
    start: Point,
    env: StepEnvelope,
    opts: StitchOptions,
): { segments: PlannedSegment[]; connectors: ConnectorResult[] } {
    const clock = opts.clock ?? Date.now;
    const timeBudgetMs = Math.max(
        0,
        opts.routerOptions?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    );

    const ink = new DrawnInkIndex(env);
    const segments: PlannedSegment[] = [];
    const connectors: ConnectorResult[] = [];
    let current: Point = { x: start.x, y: start.y };
    const startTime = clock();

    for (const oriented of ordered) {
        const segStart = oriented[0]!;
        const segEnd = oriented[oriented.length - 1]!;

        // Emit a connector only when the pen actually has to move, matching the
        // straight-connector branch's zero-gap suppression.
        if (segStart.x !== current.x || segStart.y !== current.y) {
            // Once the global routing budget is exceeded, stop routing and emit
            // straight connectors for every remaining gap so we still return a
            // complete, continuous plan (Req 8.4).
            const overBudget = clock() - startTime >= timeBudgetMs;
            const result = overBudget
                ? straightConnectorResult(current, segStart)
                : routeConnector(current, segStart, ink, env, opts.routerOptions);

            segments.push(result.segment);
            connectors.push(result);
            // Commit the routed connector to the ink index so later connectors
            // can hide over it (Req 1.3).
            ink.add(result.segment);
        }

        const stroke: PlannedSegment = {
            kind: 'stroke',
            pointsSteps: oriented.map((p) => ({ x: p.x, y: p.y })),
        };
        segments.push(stroke);
        // Commit the stroke to the ink index before the next gap is routed.
        ink.add(stroke);

        current = { x: segEnd.x, y: segEnd.y };
    }

    return { segments, connectors };
}

/**
 * Sum of the Euclidean lengths of every `connector` segment in
 * `segments`. Stroke segments are ignored. Useful for tests asserting
 * the NN-with-flip ordering shortens travel, and for the UI's
 * "connector travel" estimate.
 *
 * A connector is always a straight, two-point hop, but this sums every
 * sub-segment so it stays correct even if a connector ever holds more
 * than two points.
 */
export function totalConnectorLength(segments: PlannedSegment[]): number {
    let total = 0;
    for (const seg of segments) {
        if (seg.kind !== 'connector') continue;
        const pts = seg.pointsSteps;
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i]!;
            const b = pts[i + 1]!;
            total += Math.hypot(b.x - a.x, b.y - a.y);
        }
    }
    return total;
}

/**
 * Append the auto-return-to-home connector, completing step (5) of the
 * path pipeline.
 *
 * The Etch-a-Sketch stylus cannot lift, so once every stroke has been
 * stitched the path must travel back to the Home_Position so the next
 * drawing starts from a known origin. That travel is unavoidable motion
 * (it leaves a visible line), so it is tagged `kind: 'connector'`
 * (Req 10.7, 14.7).
 *
 * Continuity (Req 14.1) is preserved: the appended connector's first
 * point is exactly the previous path's last point, so the whole
 * `PlannedSegment[]` remains a single contiguous stroke ending at
 * `home`.
 *
 * @param segments Stitched path from {@link stitchPolylines}. Treated as
 *                 immutable - a new array is returned and the input is
 *                 never mutated.
 * @param home     Target end point; defaults to `(0, 0)`.
 * @returns        A NEW `PlannedSegment[]`. Returned unchanged (same
 *                 contents, new array not guaranteed) only conceptually:
 *                 - empty input → returned as-is (nothing to return from)
 *                 - path already ending at `home` → returned as-is
 *                   (no zero-length connector)
 *                 Otherwise a shallow copy with one trailing connector
 *                 `[endPoint, home]`.
 *
 * @see Requirements 10.7, 14.1, 14.7
 * @see Design §3.1.4 (path pipeline)
 */
export function appendReturnToHome(
    segments: PlannedSegment[],
    home: Point = { x: 0, y: 0 },
): PlannedSegment[] {
    // Nothing to return from: an empty path has no current position.
    if (segments.length === 0) return segments;

    const lastSeg = segments[segments.length - 1]!;
    const endPoint = lastSeg.pointsSteps[lastSeg.pointsSteps.length - 1]!;

    // Already home: suppress a zero-length connector, which would
    // violate the no-zero-length-segment invariant on PlannedSegment.
    if (endPoint.x === home.x && endPoint.y === home.y) return segments;

    // Shallow-copy the segment list and push the return connector so the
    // input array is never mutated. The connector's first point equals
    // the previous last point, preserving continuity (Req 14.1).
    return [
        ...segments,
        {
            kind: 'connector',
            pointsSteps: [
                { x: endPoint.x, y: endPoint.y },
                { x: home.x, y: home.y },
            ],
        },
    ];
}

/**
 * Append a return-to-home connector that routes via the ENVELOPE EDGES instead
 * of cutting straight across the finished drawing.
 *
 * On an Etch-a-Sketch the pen cannot lift, so any return travel is a visible
 * line. A straight diagonal home would draw a line through the middle of the
 * art; instead we route the pen to the nearest envelope edge, then hug the
 * perimeter to the home corner (0,0 = bottom-left). The perimeter sits in the
 * drawing's margin (especially below 100% scale), so the return line stays
 * around the border rather than slashing across the content.
 *
 * Home is assumed to be the bottom-left corner (0,0) and `env` is the inclusive
 * step envelope `[0,env.x] x [0,env.y]`. The route is:
 *   end → (nearest of the 4 edges) → corner-hops along the perimeter → (0,0).
 *
 * Returns a new segment array (input is never mutated). A zero-length return
 * (already at home) is suppressed to preserve the no-zero-length invariant.
 */
export function appendEdgeReturnToHome(
    segments: PlannedSegment[],
    env: { x: number; y: number },
    home: Point = { x: 0, y: 0 },
): PlannedSegment[] {
    if (segments.length === 0) return segments;

    const lastSeg = segments[segments.length - 1]!;
    const end = lastSeg.pointsSteps[lastSeg.pointsSteps.length - 1]!;

    if (end.x === home.x && end.y === home.y) return segments;

    // Distance from the end point to each of the four edges.
    const toLeft = end.x;            // x = 0
    const toRight = env.x - end.x;   // x = env.x
    const toBottom = end.y;          // y = 0
    const toTop = env.y - end.y;     // y = env.y
    const minDist = Math.min(toLeft, toRight, toBottom, toTop);

    // Build the perimeter waypoint list from the chosen edge entry point to the
    // home corner (0,0), hopping corner to corner so every leg runs along an
    // edge. The four envelope corners:
    const BL = { x: 0, y: 0 };
    const BR = { x: env.x, y: 0 };
    const TL = { x: 0, y: env.y };

    const pts: Point[] = [{ x: end.x, y: end.y }];

    if (minDist === toBottom) {
        // Drop straight down to the bottom edge, then run left to (0,0).
        pts.push({ x: end.x, y: 0 });
        pts.push(BL);
    } else if (minDist === toLeft) {
        // Go left to the left edge, then down to (0,0).
        pts.push({ x: 0, y: end.y });
        pts.push(BL);
    } else if (minDist === toRight) {
        // Out to the right edge, down to BR, then left along the bottom to BL.
        pts.push({ x: env.x, y: end.y });
        pts.push(BR);
        pts.push(BL);
    } else {
        // Nearest is the top edge: up to TL is shortest perimeter to home —
        // go to the top edge, then to the top-left corner, then down to BL.
        pts.push({ x: end.x, y: env.y });
        pts.push(TL);
        pts.push(BL);
    }

    // Collapse any consecutive duplicate points (e.g. the end point already on
    // an edge) so we never emit a zero-length leg.
    const deduped: Point[] = [];
    for (const p of pts) {
        const prev = deduped[deduped.length - 1];
        if (!prev || prev.x !== p.x || prev.y !== p.y) deduped.push(p);
    }
    if (deduped.length < 2) return segments;  // nothing to travel

    return [
        ...segments,
        { kind: 'connector', pointsSteps: deduped },
    ];
}
