/**
 * Shared nearest-neighbor polyline ordering (pure ordering, no connectors).
 *
 * Both the {@link import('./stitch').stitchPolylines} stage of the path
 * pipeline and the `Image_Processor`'s contour ordering need the same
 * greedy heuristic: starting from the pen's current position, repeatedly
 * pick the unused polyline whose nearest endpoint - its first (head) or
 * last (tail) point - lies closest to the cursor, traverse it in the
 * orientation that puts that endpoint first (FLIPPING / reversing the
 * polyline when its tail is the nearer entry), then advance the cursor to
 * the chosen polyline's far (exit) endpoint.
 *
 * This module owns ONLY the ordering decision - "which polyline next and
 * whether to flip it" - and returns the ordered, possibly-reversed
 * polylines. It deliberately does NOT insert connector segments; that is
 * the concern of {@link import('./stitch').stitchPolylines}, which weaves
 * straight-line connectors between successive strokes. Keeping the
 * ordering logic factored out here lets the planner's stitch stage and
 * the Image_Processor share one robust, well-tested implementation
 * instead of two divergent greedy heuristics (Req 4.7, 14.2, 14.3).
 *
 * Determinism: ties in nearest-endpoint distance are broken by
 *   (a) earlier index in the input array, then
 *   (b) forward orientation before reversed.
 * The result is therefore a pure function of the inputs and `start`.
 *
 * Coordinates flow through unchanged - the function is numeric-generic and
 * works on float (mm / canvas) or integer (motor-step) coordinates alike.
 *
 * @see Requirements 4.7, 14.2, 14.3
 * @see Design §3.1.4 (path pipeline)
 */

import type { Point, Polyline } from '../types';

/** Options for {@link orderPolylinesNearestNeighbor}. */
export interface OrderPolylinesOptions {
    /**
     * Minimum number of points a polyline must have to be ordered.
     * Polylines shorter than this are dropped before ordering.
     *
     * Defaults to `1`, which drops only empty polylines and keeps the rest
     * (matching the Image_Processor's historical drop semantics). The
     * planner's stitch stage, which has no use for a zero-length stroke,
     * would pass `2`.
     */
    minPoints?: number;
    /**
     * When true, refine the greedy nearest-neighbor result with a
     * deterministic {@link twoOptReorder} pass that minimizes total PEN-UP
     * connector travel in the machine's Chebyshev metric (`max(|dx|,|dy|)` —
     * the per-move step count the firmware actually drives, and what the
     * planner's `totalStepCount` charges for connector segments). This is the
     * lever that shrinks the long diagonal "connector" lines a no-pen-lift
     * Etch-a-Sketch draws between strokes.
     *
     * Defaults to `false`, so the Image_Processor's contour-continuity
     * ordering and the bare greedy callers are byte-for-byte unchanged. The
     * planner opts in (`twoOpt: true`) because its order is the one that
     * reaches the machine.
     */
    twoOpt?: boolean;
}

/** Chebyshev (max-axis) distance — the machine's real per-move step count. */
function chebyshev(a: Point, b: Point): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Total pen-up connector travel for an ordered, oriented polyline list, in
 * the machine's Chebyshev step metric: the hop from `start` to the first
 * stroke's entry endpoint, plus every `exit → next-entry` gap between
 * consecutive strokes. The return-to-home hop is NOT counted — it is appended
 * downstream and is independent of the inter-stroke order. This mirrors the
 * connector cost the planner's `totalStepCount` sums for `connector` segments
 * and is the objective {@link twoOptReorder} minimizes.
 */
export function totalConnectorTravelChebyshev(
    ordered: Polyline[],
    start: Point,
): number {
    let total = 0;
    let cursor: Point = start;
    for (const poly of ordered) {
        if (poly.length === 0) continue;
        total += chebyshev(cursor, poly[0]!);
        cursor = poly[poly.length - 1]!;
    }
    return total;
}

/**
 * Hard cap on {@link twoOptReorder} passes. Each pass is `O(n²)` endpoint
 * comparisons, so the whole refinement is bounded by `MAX_2OPT_PASSES · n²`.
 * For the hatch fill's worst case (~1000 strokes) that is at most
 * `8 · 1000² / 2 ≈ 4M` cheap Chebyshev evaluations — a few milliseconds, well
 * under the "few seconds" budget. A pass that makes no improvement breaks
 * early, so typical inputs finish in 1–3 passes.
 */
export const MAX_2OPT_PASSES = 8;

/** Squared Euclidean distance. Avoids a `Math.sqrt` in the inner loop. */
function distSq(a: Point, b: Point): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

/**
 * Greedily order `polys` by nearest endpoint from `start`, flipping each
 * polyline end-for-end when its tail is the closer entry point.
 *
 * The returned polylines are ordered in visit sequence and oriented so
 * that each one's first point is the endpoint the pen reaches first; the
 * pen then exits at its last point. No connector segments are inserted -
 * this is pure ordering. Input polylines are never mutated (oriented
 * copies are returned).
 *
 * @param polys Source polylines in any coordinate system. Polylines with
 *              fewer than `opts.minPoints` points (default `1`, i.e. only
 *              empty polylines) are dropped.
 * @param start Pen position before the first stroke; ordering begins from
 *              the polyline whose nearest endpoint is closest to this point.
 * @param opts  Ordering options; see {@link OrderPolylinesOptions}.
 * @returns     A new array of ordered, possibly-reversed polylines (no
 *              connectors). Empty when no polyline survives filtering.
 *
 * @see Requirements 4.7, 14.2, 14.3
 */
export function orderPolylinesNearestNeighbor(
    polys: Polyline[],
    start: Point,
    opts: OrderPolylinesOptions = {},
): Polyline[] {
    const minPoints = opts.minPoints ?? 1;

    // Copy survivors so callers' input arrays are never mutated.
    const usable: Polyline[] = polys
        .filter((p) => p.length >= minPoints)
        .map((p) => p.slice());
    if (usable.length === 0) return [];

    const used = new Array<boolean>(usable.length).fill(false);
    const ordered: Polyline[] = [];
    let cursor: Point = { x: start.x, y: start.y };

    for (let picked = 0; picked < usable.length; picked++) {
        let bestIdx = -1;
        let bestReversed = false;
        let bestDistSq = Number.POSITIVE_INFINITY;

        for (let i = 0; i < usable.length; i++) {
            if (used[i]) continue;
            const poly = usable[i]!;
            const head = poly[0]!;
            const tail = poly[poly.length - 1]!;

            // Strict-less keeps the earliest-found candidate on ties, so
            // earlier-indexed polylines and forward orientation are
            // preferred - the deterministic tie-break documented above.
            const dHead = distSq(cursor, head);
            if (dHead < bestDistSq) {
                bestDistSq = dHead;
                bestIdx = i;
                bestReversed = false;
            }

            const dTail = distSq(cursor, tail);
            if (dTail < bestDistSq) {
                bestDistSq = dTail;
                bestIdx = i;
                bestReversed = true;
            }
        }

        used[bestIdx] = true;
        const chosen = usable[bestIdx]!;
        // Flip when the far endpoint is the nearer entry so the pen enters
        // at the closer end and the connector hop (added later by the
        // stitcher) stays short.
        const oriented: Polyline = bestReversed
            ? chosen.slice().reverse()
            : chosen;
        ordered.push(oriented);
        cursor = oriented[oriented.length - 1]!;
    }

    // Optionally refine the greedy order with a deterministic 2-opt pass that
    // minimizes total Chebyshev connector travel (the machine's real pen-up
    // step cost). Off by default so non-planner callers are unchanged.
    return opts.twoOpt ? twoOptReorder(ordered, start) : ordered;
}

/**
 * Deterministic 2-opt refinement of an already-ordered, already-oriented
 * polyline list. Reduces total pen-up connector travel measured in the
 * machine's Chebyshev metric (see {@link totalConnectorTravelChebyshev}) — the
 * objective that controls how much visible diagonal "connector" ink a
 * no-pen-lift Etch-a-Sketch lays down between strokes.
 *
 * ## Move set
 *
 * The only move is "reverse the sub-sequence `[i..j]`", with each stroke in
 * that block ALSO flipped end-for-end (its traversal direction reverses).
 * Because the Chebyshev metric is symmetric, every connector cost *interior*
 * to the reversed block is preserved, so the move changes exactly the two
 * boundary connectors — the classic 2-opt edge swap:
 *
 *   - left boundary:  `exit(i-1) → entry(i)`   becomes `exit(i-1) → exit(j)`
 *   - right boundary: `exit(j)   → entry(j+1)` becomes `entry(i)  → entry(j+1)`
 *
 * (`exit(i-1)` is `start` when `i === 0`; the right boundary is dropped when
 * `j === n-1`, since the return-to-home hop is appended later and is not part
 * of the inter-stroke objective.)
 *
 * The degenerate `i === j` case reverses a single stroke — i.e. a pure
 * head/tail orientation flip — so individual-stroke reorientation is covered
 * by the same loop without special-casing.
 *
 * ## Determinism & runtime
 *
 * The `(i, j)` scan order is fixed (ascending `i`, then ascending `j`) and the
 * only randomness-free decision is "apply when the change is strictly
 * negative". A strictly-decreasing objective guarantees termination; the pass
 * count is additionally capped at {@link MAX_2OPT_PASSES}. Runtime is
 * `O(passes · n²)` — see the {@link MAX_2OPT_PASSES} note for the bound.
 *
 * The set of strokes and their geometry are unchanged; only their order and
 * per-stroke orientation change. Input polylines are never mutated (oriented
 * copies are returned).
 *
 * @param ordered Polylines already in visit order and oriented entry-first,
 *                e.g. the output of the greedy pass above.
 * @param start   Pen position before the first stroke (the left anchor of the
 *                first connector).
 * @returns       A new array of reordered / re-oriented polylines whose total
 *                Chebyshev connector travel is ≤ that of `ordered`.
 */
export function twoOptReorder(ordered: Polyline[], start: Point): Polyline[] {
    const n = ordered.length;
    // Work on copies so inputs are never mutated; also covers n < 2 (nothing
    // to reorder — a single stroke's orientation was already fixed by greedy).
    const route: Polyline[] = ordered.map((p) => p.slice());
    if (n < 2) return route;

    const entryOf = (p: Polyline): Point => p[0]!;
    const exitOf = (p: Polyline): Point => p[p.length - 1]!;

    for (let pass = 0; pass < MAX_2OPT_PASSES; pass++) {
        let improved = false;

        for (let i = 0; i < n; i++) {
            for (let j = i; j < n; j++) {
                const left = i === 0 ? start : exitOf(route[i - 1]!);
                const blockFirst = route[i]!;
                const blockLast = route[j]!;
                const hasRight = j + 1 < n;
                const rightEntry = hasRight ? entryOf(route[j + 1]!) : start;

                const oldCost =
                    chebyshev(left, entryOf(blockFirst)) +
                    (hasRight ? chebyshev(exitOf(blockLast), rightEntry) : 0);

                // After reverse+flip: the block's new first stroke is old `j`
                // flipped (entry = its old exit), and its new last stroke is
                // old `i` flipped (exit = its old entry).
                const newCost =
                    chebyshev(left, exitOf(blockLast)) +
                    (hasRight ? chebyshev(entryOf(blockFirst), rightEntry) : 0);

                if (newCost < oldCost) {
                    reverseBlockWithFlip(route, i, j);
                    improved = true;
                }
            }
        }

        if (!improved) break;
    }

    return route;
}

/**
 * Reverse the order of strokes in `route[i..j]` AND flip each stroke in that
 * block end-for-end, in place. Together these realise one 2-opt move: the
 * block is traversed in the opposite direction, so both its position order and
 * each stroke's entry/exit swap.
 */
function reverseBlockWithFlip(route: Polyline[], i: number, j: number): void {
    for (let k = i; k <= j; k++) route[k] = route[k]!.slice().reverse();
    let a = i;
    let b = j;
    while (a < b) {
        const tmp = route[a]!;
        route[a] = route[b]!;
        route[b] = tmp;
        a += 1;
        b -= 1;
    }
}
