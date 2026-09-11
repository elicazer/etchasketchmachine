/**
 * `Connector_Router` — routes inter-stroke connectors over already-drawn ink
 * (`Drawn_Ink`) and `Step_Envelope` perimeter edges so that travel which lands
 * in an existing groove is invisible (`Hidden_Travel`) and only the residual
 * gap remains visible (`Exposed_Travel`).
 *
 * The router is **opt-in** (see `connectorHiding` in the planner/stitcher) and a
 * **pure, deterministic** function of its inputs: it never reorders strokes,
 * never increases visible ink, and falls back to the straight 2-point connector
 * whenever it cannot strictly improve on it. With the feature off, planner
 * output is byte-for-byte identical to today.
 *
 * This module owns the routing algorithm, the spatial occupancy index
 * (`DrawnInkIndex`), overlap classification, candidate generation, the
 * deterministic tie-break, and per-connector guards.
 *
 * NOTE: This is the module skeleton (spec task 1). `DrawnInkIndex` and
 * `routeConnector` carry their final public signatures here but currently fall
 * back to the straight 2-point connector; the spatial index, classification,
 * candidate generation, selection, and guards land in later tasks.
 *
 * @see Design: Hidden Connector Routing (Components and Interfaces)
 * @see Requirements 2.2, 3.1, 6.5, 8.2
 */

import type { Point, PlannedSegment } from '../types';

// -----------------------------------------------------------------------------
// Shared types (Design §"Components and Interfaces")
// -----------------------------------------------------------------------------

/** Inclusive integer step rectangle [0,x] × [0,y] the drawing must stay in. */
export interface StepEnvelope {
    x: number;
    y: number;
}

/**
 * An axis-aligned-or-diagonal piece of already-drawn ink, in integer motor
 * steps. Stored as the ordered endpoint pair of a single drawn sub-segment
 * (one inter-vertex move of a stroke or earlier connector). Chebyshev metric.
 */
export interface InkSegment {
    a: Point;
    b: Point;
}

/** Per-connector outcome, used for observability (Req 9) and guards. */
export interface ConnectorResult {
    /** The emitted connector segment (routed multi-point, or straight 2-point). */
    segment: PlannedSegment; // kind: 'connector'
    /** Chebyshev steps overlapping Drawn_Ink / envelope edges (invisible). */
    hiddenTravel: number; // Req 9, 10.4
    /** Chebyshev steps NOT overlapping existing ink (visible). */
    exposedTravel: number; // Req 9, 10.4
    /** Total Chebyshev length == hiddenTravel + exposedTravel exactly. */
    totalTravel: number; // Req 10.4
    /** True when the straight 2-point fallback was emitted (no improvement). */
    fellBack: boolean; // Req 6
    /** True when a route was computed but rejected by a guard (Req 2.7, 4.4). */
    rejected: boolean;
}

/** Tuning knobs; all default to the documented performance bounds (Req 8). */
export interface RouterOptions {
    /** Max candidate routes evaluated per connector (Req 8.2). Default 32. */
    maxCandidates?: number;
    /** Hard cap on points in an emitted routed connector (Req 2.2, 2.7). Default 1000. */
    maxPoints?: number;
    /** Global routing time budget in ms (Req 8.1, 8.4). Default 5000. */
    timeBudgetMs?: number;
}

// -----------------------------------------------------------------------------
// Documented defaults & options clamping (Req 8.2)
// -----------------------------------------------------------------------------

/** Default max candidate routes evaluated per connector (Req 8.2). */
export const DEFAULT_MAX_CANDIDATES = 32;
/** Default hard cap on points in an emitted routed connector (Req 2.2, 2.7). */
export const DEFAULT_MAX_POINTS = 1000;
/** Default global routing time budget in milliseconds (Req 8.1, 8.4). */
export const DEFAULT_TIME_BUDGET_MS = 5000;

/**
 * Assumed segment count used to pick a default grid cell size when the caller
 * does not supply one. The index is built incrementally and never knows the
 * final stroke count up front, so we size cells against the documented
 * performance target (≈1000 strokes, Req 8.1): `cellSize ≈ max(1, round(maxDim
 * / sqrt(expectedSegments)))` yields ~`sqrt(expectedSegments)` cells per axis,
 * keeping per-query work local. Correctness is independent of this value — only
 * locality (and therefore speed) is affected.
 */
export const DEFAULT_EXPECTED_SEGMENTS = 1024;

/** {@link RouterOptions} with every field resolved to a concrete value. */
export interface NormalizedRouterOptions {
    maxCandidates: number;
    maxPoints: number;
    timeBudgetMs: number;
}

/**
 * Resolve and clamp {@link RouterOptions} to the documented minimums rather
 * than throwing, consistent with the planner's existing range-clamping style
 * (cf. `scale.ts`/`rdp.ts`). Absent or non-finite values fall back to the
 * documented defaults; counts are floored to whole candidates/points.
 *
 *   - `maxCandidates` clamped to ≥ 1   (Req 8.2)
 *   - `maxPoints`     clamped to ≥ 2   (Req 2.2, 2.7)
 *   - `timeBudgetMs`  clamped to ≥ 0   (Req 8.1, 8.4)
 */
export function normalizeRouterOptions(opts?: RouterOptions): NormalizedRouterOptions {
    return {
        maxCandidates: clampMin(opts?.maxCandidates, DEFAULT_MAX_CANDIDATES, 1, true),
        maxPoints: clampMin(opts?.maxPoints, DEFAULT_MAX_POINTS, 2, true),
        timeBudgetMs: clampMin(opts?.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, 0, false),
    };
}

/**
 * Clamp `value` to a documented minimum, falling back to `fallback` when it is
 * absent or non-finite. When `integer` is set the result is floored to a whole
 * number (candidate/point counts are integral).
 */
function clampMin(
    value: number | undefined,
    fallback: number,
    min: number,
    integer: boolean,
): number {
    const v = value === undefined || !Number.isFinite(value) ? fallback : value;
    const clamped = v < min ? min : v;
    return integer ? Math.floor(clamped) : clamped;
}

// -----------------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------------

/**
 * Chebyshev distance `max(|dx|, |dy|)` — the machine's real per-move step count
 * and the metric used to charge connector travel (Req 1.1).
 */
function chebyshev(a: Point, b: Point): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Walk the integer motor-step positions traversed along the move `a → b`, one
 * Chebyshev step at a time (integer DDA). Yields `chebyshev(a, b) + 1` points
 * starting exactly at `a` and ending exactly at `b`; a zero-length move yields
 * the single point `a`. Inputs are assumed to be integer step coordinates, so
 * every yielded coordinate is an integer.
 *
 * This is the same per-move stepping the firmware performs (`max(|dx|, |dy|)`
 * steps), so a diagonal move registers in every cell its groove physically
 * crosses (Design §"Drawn_Ink representation and the spatial index").
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

/** Stable cell key for the integer grid cell `(cx, cy)`. */
function cellKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
}

/**
 * Floating-point slack used when comparing perpendicular distances and
 * projections against the 1-integer-step tolerance, to absorb rounding from
 * the `sqrt`/division below. Coordinates are integers, so this only guards the
 * exact `== tolerance` boundary.
 */
const GEOM_EPS = 1e-9;

/**
 * The perpendicular-distance tolerance, in integer steps, within which a leg is
 * considered to lie "on" an ink piece (Req 1.1, 10.1).
 */
const HIDDEN_PERP_TOLERANCE = 1;

/**
 * Along-segment containment slack, in integer steps. Strict (0): a step that
 * extends past an ink piece's extent is not hidden by it, so a partly-covered
 * leg splits exactly at the ink boundary (Req 10.3).
 */
const HIDDEN_PROJ_TOLERANCE = 0;

/**
 * True iff the leg `[a, b]` is collinear with and fully contained within the
 * single ink/edge piece `seg` (Req 10.1).
 *
 * Two independent tolerances apply:
 *   - `perpTol` — the perpendicular distance from each endpoint to `seg`'s
 *     infinite line, the "collinear ... within 1 integer step" bound (Req 10.1).
 *   - `projTol` — slack on the along-segment projection (containment). This is
 *     strict (0) by default: a step reaching exactly to the ink endpoint counts
 *     as contained, but a step extending beyond the ink's extent does not, so a
 *     partly-covered leg splits exactly at the ink boundary (Req 10.3).
 *
 * Because both perpendicular distance and the projection are affine along the
 * straight leg, checking only the two endpoints guarantees the condition for
 * every interior point. A degenerate (zero-length) ink piece covers a leg only
 * when both endpoints sit within `perpTol` (Chebyshev) of that point.
 */
function legCoveredBySegment(
    a: Point,
    b: Point,
    seg: InkSegment,
    perpTol: number,
    projTol: number,
): boolean {
    const vx = seg.b.x - seg.a.x;
    const vy = seg.b.y - seg.a.y;
    const len2 = vx * vx + vy * vy;

    if (len2 === 0) {
        // Degenerate ink "piece" is a single point; it can only cover points
        // sitting essentially on top of it.
        return chebyshev(a, seg.a) <= perpTol && chebyshev(b, seg.a) <= perpTol;
    }

    const len = Math.sqrt(len2);

    // Perpendicular distance of each endpoint to the (infinite) line of `seg`.
    const perpA = Math.abs((a.x - seg.a.x) * vy - (a.y - seg.a.y) * vx) / len;
    const perpB = Math.abs((b.x - seg.a.x) * vy - (b.y - seg.a.y) * vx) / len;
    if (perpA > perpTol + GEOM_EPS || perpB > perpTol + GEOM_EPS) return false;

    // Projection of each endpoint along `seg`'s direction, in absolute step
    // units measured from `seg.a`. The piece spans `[0, len]`; containment is
    // strict up to `projTol` slack at each end.
    const projA = ((a.x - seg.a.x) * vx + (a.y - seg.a.y) * vy) / len;
    const projB = ((b.x - seg.a.x) * vx + (b.y - seg.a.y) * vy) / len;
    if (projA < -projTol - GEOM_EPS || projA > len + projTol + GEOM_EPS) return false;
    if (projB < -projTol - GEOM_EPS || projB > len + projTol + GEOM_EPS) return false;

    return true;
}

// -----------------------------------------------------------------------------
// Spatial occupancy index over Drawn_Ink
// -----------------------------------------------------------------------------

/**
 * Spatial occupancy structure over Drawn_Ink for bounded overlap queries.
 * Backed by a uniform grid (bucket size ~ envelope / sqrt(N)) keyed by integer
 * cell, so per-connector candidate queries touch O(local) ink rather than all
 * of it — keeping total routing cost ~linear in stroke count (Req 8.1, 8.2).
 *
 * The four inclusive `Step_Envelope` perimeter edges are held as implicit
 * `InkSegment`s and consulted by `coveringSegments` alongside the grid, so a
 * route hugging the border reads as routable Hidden_Travel even before any
 * stroke is drawn near it (Req 1.4, 4.1).
 *
 * NOTE (task 2.1): the uniform grid, endpoint buckets, and DDA insertion are
 * implemented here. `isHidden` (collinear-and-contained overlap classification)
 * lands in task 3.1 and currently remains a stub.
 */
export class DrawnInkIndex {
    private readonly env: StepEnvelope;
    private readonly cellSize: number;
    /** Inter-vertex ink sub-segments bucketed by the grid cells they cross. */
    private readonly cells = new Map<string, InkSegment[]>();
    /** Ink endpoints bucketed by the grid cell they fall in. */
    private readonly endpointCells = new Map<string, Point[]>();
    /** The four inclusive perimeter edges, treated as zero-Exposed ink. */
    private readonly envelopeEdges: readonly InkSegment[];
    /** Count of inter-vertex ink sub-segments added (excludes envelope edges). */
    private inkSegmentCount = 0;

    constructor(env: StepEnvelope, cellSize?: number) {
        this.env = { x: env.x, y: env.y };
        const maxDim = Math.max(env.x, env.y, 1);
        // `cellSize ≈ max(1, round(maxDim / sqrt(expectedSegments)))` when the
        // caller does not supply one (Design §"the spatial index"). A supplied
        // size is honoured but clamped to ≥ 1 so a cell always spans ≥ 1 step.
        const chosen =
            cellSize === undefined || !Number.isFinite(cellSize)
                ? Math.round(maxDim / Math.sqrt(DEFAULT_EXPECTED_SEGMENTS))
                : Math.round(cellSize);
        this.cellSize = Math.max(1, chosen);

        // The inclusive perimeter of [0,env.x] × [0,env.y]: left, right, bottom,
        // top. Kept as implicit ink so border-hugging routes are Hidden_Travel.
        this.envelopeEdges = [
            { a: { x: 0, y: 0 }, b: { x: 0, y: env.y } },
            { a: { x: env.x, y: 0 }, b: { x: env.x, y: env.y } },
            { a: { x: 0, y: 0 }, b: { x: env.x, y: 0 } },
            { a: { x: 0, y: env.y }, b: { x: env.x, y: env.y } },
        ];
    }

    /** Integer grid cell coordinate containing the (integer or fractional) point. */
    private cellOf(p: Point): { cx: number; cy: number } {
        return {
            cx: Math.floor(p.x / this.cellSize),
            cy: Math.floor(p.y / this.cellSize),
        };
    }

    /**
     * Insert every inter-vertex sub-segment of an emitted segment (Req 1.3).
     *
     * Each adjacent vertex pair becomes one `InkSegment {a, b}`, registered in
     * every grid cell its groove crosses (via the integer DDA walk, so diagonal
     * ink lands in all crossed cells, not just bbox corners). Both endpoints
     * are also stored in their cell's endpoint bucket for `nearbyEndpoints`.
     */
    add(segment: PlannedSegment): void {
        const pts = segment.pointsSteps;
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = { x: pts[i].x, y: pts[i].y };
            const b = { x: pts[i + 1].x, y: pts[i + 1].y };
            const ink: InkSegment = { a, b };
            this.inkSegmentCount++;

            // Register the sub-segment once per distinct cell its groove crosses.
            const seen = new Set<string>();
            for (const step of walkLineSteps(a, b)) {
                const { cx, cy } = this.cellOf(step);
                const key = cellKey(cx, cy);
                if (seen.has(key)) continue;
                seen.add(key);
                const bucket = this.cells.get(key);
                if (bucket) bucket.push(ink);
                else this.cells.set(key, [ink]);
            }

            this.addEndpoint(a);
            this.addEndpoint(b);
        }
    }

    /** Store an ink endpoint in its grid cell's endpoint bucket. */
    private addEndpoint(p: Point): void {
        const { cx, cy } = this.cellOf(p);
        const key = cellKey(cx, cy);
        const bucket = this.endpointCells.get(key);
        if (bucket) bucket.push({ x: p.x, y: p.y });
        else this.endpointCells.set(key, [{ x: p.x, y: p.y }]);
    }

    /**
     * Drawn-ink endpoints within `radius` (Chebyshev) of `p`, for candidate
     * snap targets. Only the cells overlapping `[p ± radius]` are scanned, so
     * the result is local rather than all endpoints (Req 8.2). The returned
     * list is deduplicated and sorted lexicographically (x before y) so the
     * order is independent of insertion order (Req 3.4).
     */
    nearbyEndpoints(p: Point, radius: number): Point[] {
        const r = Math.max(0, radius);
        const cxMin = Math.floor((p.x - r) / this.cellSize);
        const cxMax = Math.floor((p.x + r) / this.cellSize);
        const cyMin = Math.floor((p.y - r) / this.cellSize);
        const cyMax = Math.floor((p.y + r) / this.cellSize);

        const seen = new Set<string>();
        const out: Point[] = [];
        for (let cy = cyMin; cy <= cyMax; cy++) {
            for (let cx = cxMin; cx <= cxMax; cx++) {
                const bucket = this.endpointCells.get(cellKey(cx, cy));
                if (!bucket) continue;
                for (const e of bucket) {
                    if (chebyshev(p, e) > r) continue;
                    const key = cellKey(e.x, e.y);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({ x: e.x, y: e.y });
                }
            }
        }
        out.sort((u, v) => (u.x - v.x !== 0 ? u.x - v.x : u.y - v.y));
        return out;
    }

    /**
     * Ink pieces local to `p` — those registered in `p`'s cell or the 8
     * neighbouring cells — plus any inclusive envelope perimeter edge within 1
     * integer step of `p`. This is the bounded candidate set consulted by the
     * overlap classifier; precise collinear-and-contained checking is done by
     * `isHidden` (Design §"Overlap query").
     */
    coveringSegments(p: Point): InkSegment[] {
        const { cx, cy } = this.cellOf(p);
        const seen = new Set<InkSegment>();
        const out: InkSegment[] = [];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const bucket = this.cells.get(cellKey(cx + dx, cy + dy));
                if (!bucket) continue;
                for (const ink of bucket) {
                    if (seen.has(ink)) continue;
                    seen.add(ink);
                    out.push(ink);
                }
            }
        }
        for (const edge of this.nearbyEnvelopeEdges(p)) out.push(edge);
        return out;
    }

    /** Inclusive perimeter edges within 1 integer step of `p` (Req 1.4). */
    private nearbyEnvelopeEdges(p: Point): InkSegment[] {
        const [left, right, bottom, top] = this.envelopeEdges;
        const out: InkSegment[] = [];
        if (Math.abs(p.x - 0) <= 1) out.push(left);
        if (Math.abs(p.x - this.env.x) <= 1) out.push(right);
        if (Math.abs(p.y - 0) <= 1) out.push(bottom);
        if (Math.abs(p.y - this.env.y) <= 1) out.push(top);
        return out;
    }

    /** True iff no Drawn_Ink sub-segment has been added (envelope edges excluded). */
    isEmpty(): boolean {
        return this.inkSegmentCount === 0;
    }

    /** True iff [a,b] is collinear-and-contained in some ink piece within 1 step. */
    isHidden(a: Point, b: Point): boolean {
        // Consult ink/edges local to BOTH endpoints. For the per-step coverage
        // probes `classifyRoute` performs, `a` and `b` are adjacent, so this is
        // a bounded local scan (Req 8.2); for a longer leg the union still
        // catches any piece touching either end. References are deduplicated so
        // a piece registered against both endpoints is only tested once.
        const seen = new Set<InkSegment>();
        for (const seg of this.coveringSegments(a)) seen.add(seg);
        for (const seg of this.coveringSegments(b)) seen.add(seg);
        for (const seg of seen) {
            if (legCoveredBySegment(a, b, seg, HIDDEN_PERP_TOLERANCE, HIDDEN_PROJ_TOLERANCE)) {
                return true;
            }
        }
        return false;
    }
}

// -----------------------------------------------------------------------------
// Overlap classification & Chebyshev accounting
// -----------------------------------------------------------------------------

/** Hidden vs. Exposed travel breakdown of a route, in Chebyshev steps. */
export interface RouteClassification {
    /** Chebyshev steps that land on Drawn_Ink / envelope edges (invisible). */
    hiddenTravel: number;
    /** Chebyshev steps that do NOT overlap existing ink (visible). */
    exposedTravel: number;
    /** Total Chebyshev length of the route == hiddenTravel + exposedTravel. */
    totalTravel: number;
}

/**
 * Walk a route's adjacent legs in integer motor steps and charge each step as
 * Hidden_Travel (it lands on a `Drawn_Ink` piece or envelope edge) or
 * Exposed_Travel (a gap not coverable by existing ink), splitting each leg at
 * the integer step where coverage changes (Req 10.1, 10.3).
 *
 * Every integer step is counted in exactly one category, so the returned
 * `hiddenTravel + exposedTravel` equals `totalTravel` (the route's full
 * Chebyshev length) exactly (Req 10.4). A leg the router intended to hide but
 * which cannot be placed on ink is, step by step, simply found uncovered and
 * charged as Exposed_Travel — i.e. an unhideable Hidden leg is reclassified as
 * Exposed while the route itself is retained (Req 10.2).
 *
 * Pure: depends only on `points` and the supplied ink (Req 3.1).
 */
export function classifyRoute(points: Point[], ink: DrawnInkIndex): RouteClassification {
    let hiddenTravel = 0;
    let exposedTravel = 0;
    let totalTravel = 0;

    for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        const legLen = chebyshev(a, b);
        totalTravel += legLen;
        if (legLen === 0) continue;

        // Charge each unit Chebyshev step of this leg to exactly one category.
        let prev: Point | null = null;
        for (const step of walkLineSteps(a, b)) {
            if (prev !== null) {
                if (ink.isHidden(prev, step)) hiddenTravel++;
                else exposedTravel++;
            }
            prev = step;
        }
    }

    return { hiddenTravel, exposedTravel, totalTravel };
}

// -----------------------------------------------------------------------------
// Connector routing
// -----------------------------------------------------------------------------

/**
 * Route a single connector from `exit` to `entry`, given the ink drawn so far
 * and the envelope. Pure: depends only on its arguments (Req 3.1).
 *
 * Returns the best routed connector whose Exposed_Travel is STRICTLY less than
 * the straight 2-point connector's Chebyshev length; otherwise returns the
 * straight 2-point fallback (Req 1.6, 5.2, 6.1). Always begins at `exit` and
 * ends at `entry` (Req 2.1, 6.5).
 *
 * Algorithm (Design §"Routing Algorithm"): build *approach → traverse → depart*
 * candidate routes `exit → sExit → …along ink…→ sEntry → entry`, where `sExit`
 * and `sEntry` are snap targets drawn from `nearbyEndpoints` and the nearest
 * point on each envelope edge. The snap radius `R` grows geometrically over
 * rounds until a strictly-improving route is found or the per-connector
 * candidate cap is reached. Each candidate is scored with `classifyRoute`, and
 * the winner is chosen by the deterministic three-key order (Req 1.5, 3.3, 5.3):
 *   1. minimise Exposed_Travel,
 *   2. tie → minimise total Chebyshev length,
 *   3. tie → lexicographically smallest ordered point-coordinate sequence.
 *
 * Guards before emit (Design §"Guards before emit", Req 2.x/4.x/5.2): the
 * selected route is collapsed, bounded to `2 ≤ points ≤ maxPoints`, checked for
 * zero-length sub-segments, anchored exactly to `exit`/`entry`, and verified
 * envelope-contained; any failure degrades to the straight 2-point fallback.
 * The empty-ink short-circuit and the per-connector candidate cap (`maxCandidates`,
 * default 32) bound the work; the global time budget is enforced by the stitch
 * loop between connectors.
 */
export function routeConnector(
    exit: Point,
    entry: Point,
    ink: DrawnInkIndex,
    env: StepEnvelope,
    opts?: RouterOptions,
): ConnectorResult {
    const options = normalizeRouterOptions(opts);
    const straightLen = chebyshev(exit, entry);

    // No ink drawn yet (or i == 0): skip the hiding search and emit straight
    // (Req 6.3). The straight fallback is always envelope-safe.
    if (ink.isEmpty()) {
        return straightFallback(exit, entry, straightLen);
    }

    const maxDim = Math.max(env.x, env.y, 1);
    let evaluated = 0;
    let best: Candidate | null = null;
    // Distinct candidate point-sequences already scored. The envelope-edge snap
    // targets are constant across rounds, so without this the budget would be
    // spent re-scoring identical routes before `R` grows enough to reach the
    // ink; deduping lets each unit of budget buy a genuinely new candidate and
    // keeps the per-connector candidate count (Req 8.2) honest.
    const seenCandidates = new Set<string>();

    // Grow the snap radius geometrically over rounds, accumulating distinct
    // candidates until the per-connector cap is hit (Req 8.2, 8.3) or the radius
    // already spans the whole envelope. Among all evaluated candidates the
    // global best is chosen, so a larger-radius route that hides more wins over
    // an early mediocre one.
    for (let R = 1; ; R *= 2) {
        const aTargets = snapTargets(ink, exit, env, R);
        const bTargets = snapTargets(ink, entry, env, R);

        let capReached = false;
        for (const sExit of aTargets) {
            if (capReached) break;
            for (const sEntry of bTargets) {
                const points = collapseConsecutive([exit, sExit, sEntry, entry]);
                if (points.length < 2) continue;
                const key = candidateKey(points);
                if (seenCandidates.has(key)) continue;
                if (evaluated >= options.maxCandidates) {
                    capReached = true;
                    break;
                }
                seenCandidates.add(key);
                evaluated++;
                const cls = classifyRoute(points, ink);
                const cand: Candidate = {
                    points,
                    exposed: cls.exposedTravel,
                    total: cls.totalTravel,
                };
                if (best === null || isBetterCandidate(cand, best)) best = cand;
            }
        }

        if (capReached || evaluated >= options.maxCandidates) break;
        if (R >= maxDim) break;
    }

    // The candidate cap (Req 8.2/8.3) and time budget (enforced by the stitch
    // loop between connectors) have already bounded `evaluated`. Emit the best
    // strictly-improving route found so far, else the straight fallback
    // (Req 6.1, 6.4). The selected route must still clear the full guard suite
    // before it can be emitted (Req 2.x, 4.x, 5.2).
    if (best !== null && best.exposed < straightLen) {
        return applyGuards(best.points, exit, entry, ink, env, straightLen, options.maxPoints);
    }

    return straightFallback(exit, entry, straightLen);
}

/**
 * Apply the per-connector guard suite, in order, to a selected route, falling
 * back to the straight 2-point connector on any failure (Design §"Guards before
 * emit"). The route reaching here was already chosen as the best
 * strictly-improving candidate; the guards re-validate it as well-formed,
 * continuous, contained, and genuinely visible-ink-reducing before it is
 * emitted, so no malformed route can ever escape the router.
 *
 * Guard order and failure handling:
 *   1. Collapse consecutive duplicate points, preserving first/last (Req 2.4).
 *   2. Require `2 ≤ points ≤ maxPoints` after collapse, else discard and emit
 *      straight with `rejected = true` (Req 2.7).
 *   3. Require every adjacent pair to differ in ≥ 1 integer coordinate (no
 *      zero-length sub-segment), else discard, `rejected = true` (Req 2.3).
 *   4. Require the first point `== exit` and the last `== entry` exactly, else
 *      discard, `rejected = true` (Req 2.1, 6.5).
 *   5. Require every route point and every traversed integer step inside the
 *      inclusive envelope; on a containment failure do NOT emit the route, fall
 *      back to straight and report it via `rejected = true` (Req 4.1, 4.3, 4.4).
 *   6. Require `exposedTravel < straightLen` strictly; else emit straight with
 *      `fellBack = true` (Req 5.2, 6.2).
 */
function applyGuards(
    candidatePoints: Point[],
    exit: Point,
    entry: Point,
    ink: DrawnInkIndex,
    env: StepEnvelope,
    straightLen: number,
    maxPoints: number,
): ConnectorResult {
    // Guard 1: collapse consecutive duplicate points (preserve first/last).
    const points = collapseConsecutive(candidatePoints);

    // Guard 2: bounded point count after collapse.
    if (points.length < 2 || points.length > maxPoints) {
        return straightFallback(exit, entry, straightLen, true);
    }

    // Guard 3: no zero-length sub-segment — every adjacent pair must differ.
    for (let i = 0; i + 1 < points.length; i++) {
        if (points[i].x === points[i + 1].x && points[i].y === points[i + 1].y) {
            return straightFallback(exit, entry, straightLen, true);
        }
    }

    // Guard 4: exact endpoint anchoring (Continuity_Invariant).
    const first = points[0];
    const last = points[points.length - 1];
    if (first.x !== exit.x || first.y !== exit.y || last.x !== entry.x || last.y !== entry.y) {
        return straightFallback(exit, entry, straightLen, true);
    }

    // Guard 5: envelope containment of every route point and traversed step.
    if (!isRouteContained(points, env)) {
        return straightFallback(exit, entry, straightLen, true);
    }

    // Guard 6: must strictly reduce visible ink versus the straight connector.
    const cls = classifyRoute(points, ink);
    if (!(cls.exposedTravel < straightLen)) {
        return straightFallback(exit, entry, straightLen);
    }

    return {
        segment: {
            kind: 'connector',
            pointsSteps: points.map((p) => ({ x: p.x, y: p.y })),
        },
        hiddenTravel: cls.hiddenTravel,
        exposedTravel: cls.exposedTravel,
        totalTravel: cls.totalTravel,
        fellBack: false,
        rejected: false,
    };
}

/**
 * True iff every route point and every integer motor-step traversed between
 * adjacent points lies within the inclusive envelope `[0,env.x] × [0,env.y]`
 * (Req 4.1, 4.2, 4.3). The straight 2-point fallback between two in-envelope
 * endpoints is always itself in-envelope (the box is convex in the Chebyshev
 * sense), so failing this guard safely degrades to that fallback (Req 4.4).
 */
function isRouteContained(points: Point[], env: StepEnvelope): boolean {
    const inside = (p: Point): boolean => p.x >= 0 && p.x <= env.x && p.y >= 0 && p.y <= env.y;
    for (let i = 0; i + 1 < points.length; i++) {
        for (const step of walkLineSteps(points[i], points[i + 1])) {
            if (!inside(step)) return false;
        }
    }
    // A length-1 sequence (no legs walked above) still needs its lone point
    // checked; cheap to verify every vertex regardless.
    for (const p of points) {
        if (!inside(p)) return false;
    }
    return true;
}

/**
 * Stable signature for a candidate route, used to deduplicate identical
 * point-sequences across radius-growth rounds so repeated candidates never
 * consume the per-connector budget (Req 8.2).
 */
function candidateKey(points: Point[]): string {
    return points.map((p) => `${p.x},${p.y}`).join(';');
}

/** A scored candidate route under evaluation. */
interface Candidate {
    /** Ordered route points (consecutive duplicates already collapsed). */
    points: Point[];
    /** Exposed_Travel in Chebyshev steps (the primary minimisation key). */
    exposed: number;
    /** Total Chebyshev length of the route (the secondary tie-break key). */
    total: number;
}

/**
 * Strict three-key ordering used to select the winning route (Req 1.5, 3.3,
 * 5.3): smaller Exposed_Travel wins; ties break to smaller total Chebyshev
 * length; remaining ties break to the lexicographically smallest ordered
 * point-coordinate sequence. This is a total order, so no tie is ever left
 * unresolved and selection is independent of generation/iteration order.
 */
function isBetterCandidate(cand: Candidate, best: Candidate): boolean {
    if (cand.exposed !== best.exposed) return cand.exposed < best.exposed;
    if (cand.total !== best.total) return cand.total < best.total;
    return comparePointSequence(cand.points, best.points) < 0;
}

/**
 * Lexicographic comparison of two ordered point sequences, comparing x before y
 * at each index and treating a shorter sequence as smaller when it is a prefix
 * of the longer one (Req 3.3). Returns <0, 0, or >0.
 */
function comparePointSequence(a: Point[], b: Point[]): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i].x !== b[i].x) return a[i].x - b[i].x;
        if (a[i].y !== b[i].y) return a[i].y - b[i].y;
    }
    return a.length - b.length;
}

/**
 * Snap targets for one connector endpoint at radius `R`: the local Drawn_Ink
 * endpoints (`nearbyEndpoints`) together with the nearest point on each of the
 * four inclusive envelope edges. The combined list is deduplicated and sorted
 * lexicographically (x before y) so candidate generation order is independent
 * of `Drawn_Ink` iteration order (Req 3.4) and fully deterministic (Req 3.1).
 */
function snapTargets(ink: DrawnInkIndex, p: Point, env: StepEnvelope, R: number): Point[] {
    const seen = new Set<string>();
    const out: Point[] = [];
    const push = (q: Point): void => {
        const key = `${q.x},${q.y}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ x: q.x, y: q.y });
    };

    for (const e of ink.nearbyEndpoints(p, R)) push(e);
    for (const e of nearestPointsOnEnvelopeEdges(p, env)) push(e);

    out.sort((u, v) => (u.x !== v.x ? u.x - v.x : u.y - v.y));
    return out;
}

/**
 * The nearest integer point on each of the four inclusive envelope edges to
 * `p`, clamped into `[0,env.x] × [0,env.y]`. These let a route hug the
 * perimeter as zero-Exposed Hidden_Travel (Req 1.4), mirroring
 * `appendEdgeReturnToHome`.
 */
function nearestPointsOnEnvelopeEdges(p: Point, env: StepEnvelope): Point[] {
    const cx = clampInt(p.x, 0, env.x);
    const cy = clampInt(p.y, 0, env.y);
    return [
        { x: 0, y: cy }, // left edge   x = 0
        { x: env.x, y: cy }, // right edge  x = env.x
        { x: cx, y: 0 }, // bottom edge y = 0
        { x: cx, y: env.y }, // top edge    y = env.y
    ];
}

/** Clamp `v` to the inclusive integer range `[lo, hi]`, rounding to an integer. */
function clampInt(v: number, lo: number, hi: number): number {
    const r = Math.round(v);
    if (r < lo) return lo;
    if (r > hi) return hi;
    return r;
}

/**
 * Collapse runs of consecutive identical points to a single occurrence,
 * preserving the first and last points unchanged (Req 2.4). Returned points are
 * fresh copies so callers cannot mutate index/route state.
 */
function collapseConsecutive(points: Point[]): Point[] {
    const out: Point[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last === undefined || last.x !== p.x || last.y !== p.y) {
            out.push({ x: p.x, y: p.y });
        }
    }
    return out;
}

/**
 * Build the straight 2-point connector `[exit, entry]` and its accounting. The
 * straight connector is always a valid, envelope-safe fallback whose full
 * Chebyshev length is Exposed_Travel (Req 5.1, 6.1).
 *
 * `fellBack` is always set because the straight 2-point connector was emitted.
 * `rejected` is set additionally when the fallback was reached because a
 * computed route failed a structural/containment guard (Req 2.7, 4.4) rather
 * than merely failing to improve on the baseline.
 */
function straightFallback(
    exit: Point,
    entry: Point,
    total: number,
    rejected = false,
): ConnectorResult {
    return {
        segment: {
            kind: 'connector',
            pointsSteps: [
                { x: exit.x, y: exit.y },
                { x: entry.x, y: entry.y },
            ],
        },
        hiddenTravel: 0,
        exposedTravel: total,
        totalTravel: total,
        fellBack: true,
        rejected,
    };
}
