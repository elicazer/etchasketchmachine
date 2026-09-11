/**
 * Ramer-Douglas-Peucker line simplification.
 *
 * Given a polyline and a tolerance ε (in motor steps), produces a
 * subsequence of the input points such that every dropped point lies
 * within ε of the simplified polyline measured by point-to-segment
 * distance to the chord that replaces it. The first and last points
 * of the input are always preserved.
 *
 * The tolerance bound `[0.1, 5.0]` matches the user-facing slider
 * range from Requirement 5.4 and is validated here so callers cannot
 * accidentally request an aggressive simplification that would erase
 * whole curves.
 *
 * Implementation note: this is the classical RDP procedure but
 * expressed iteratively with an explicit work stack so deeply nested
 * polylines (long freehand strokes, dense Canny output) do not blow
 * the JS call stack. The asymptotic behaviour is the same as the
 * recursive form (O(n log n) average, O(n²) worst case).
 *
 * @see Requirements 5.4
 * @see Design §3.1.4
 */

import type { Point, Polyline } from '../types';

const EPSILON_MIN = 0.1;
const EPSILON_MAX = 5.0;

/**
 * Simplify a polyline using the Ramer-Douglas-Peucker algorithm.
 *
 * @param poly    The polyline to simplify. May be empty or any length.
 *                Polylines of length ≤ 2 are returned unchanged
 *                (a defensive copy).
 * @param epsilon Tolerance in motor steps. Must satisfy
 *                `0.1 ≤ epsilon ≤ 5.0`.
 * @returns       A new polyline containing a subset of the input
 *                points. The first and last points of the result equal
 *                the first and last of the input. Every point in the
 *                input is within `epsilon` point-to-segment distance of
 *                the returned polyline.
 * @throws        `RangeError` if `epsilon` is outside `[0.1, 5.0]` or
 *                is not a finite number.
 */
export function rdpSimplify(poly: Polyline, epsilon: number): Polyline {
    if (!Number.isFinite(epsilon) || epsilon < EPSILON_MIN || epsilon > EPSILON_MAX) {
        throw new RangeError(
            `rdpSimplify: epsilon must be a finite number in [${EPSILON_MIN}, ${EPSILON_MAX}], got ${epsilon}`,
        );
    }

    const n = poly.length;
    if (n <= 2) {
        // Defensive copy so callers can mutate the result freely.
        return poly.slice();
    }

    // `keep[i] === 1` means index `i` survives simplification.
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;

    // Iterative work stack of half-open ranges [start, end] inclusive.
    // For each range we find the farthest interior point from the chord
    // (start, end). If it exceeds epsilon, we keep it and push the two
    // sub-ranges; otherwise the entire interior collapses to the chord.
    const stack: Array<[number, number]> = [[0, n - 1]];
    while (stack.length > 0) {
        const range = stack.pop();
        if (range === undefined) break;
        const [start, end] = range;
        if (end <= start + 1) continue;

        const a = poly[start]!;
        const b = poly[end]!;

        let maxDist = 0;
        let maxIdx = -1;
        for (let i = start + 1; i < end; i++) {
            const d = pointToSegmentDistance(poly[i]!, a, b);
            if (d > maxDist) {
                maxDist = d;
                maxIdx = i;
            }
        }

        if (maxIdx !== -1 && maxDist > epsilon) {
            keep[maxIdx] = 1;
            stack.push([start, maxIdx]);
            stack.push([maxIdx, end]);
        }
    }

    const out: Point[] = [];
    for (let i = 0; i < n; i++) {
        if (keep[i] === 1) out.push(poly[i]!);
    }
    return out;
}

/**
 * Distance from `p` to the line *segment* `[a, b]` (not the infinite
 * line through `a` and `b`).
 *
 * RDP's correctness guarantee — every dropped point lies within ε of
 * the polyline that replaces it — is stated against the simplified
 * polyline *treated as a piecewise-linear curve* (Design §7,
 * Property 4). The replacement for a collapsed run is the finite chord
 * `[a, b]`, so the deviation that matters is the point-to-segment
 * distance, which clamps the projection to the chord's endpoints.
 *
 * Using the infinite-line perpendicular distance instead understates
 * the error whenever a point projects beyond an endpoint. The
 * pathological case is a near-degenerate chord (`a ≈ b`): an interior
 * spike can sit exactly on the infinite line (perpendicular distance
 * ≈ 0) yet be far from the tiny segment, so it would be wrongly
 * dropped and the ε bound violated. Measuring to the segment closes
 * that gap and also subsumes the fully degenerate `a === b` case.
 *
 * When `a === b` the segment collapses to a point and this returns the
 * Euclidean distance from `p` to that point.
 */
function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return Math.hypot(p.x - a.x, p.y - a.y);
    }
    // Project p onto the chord and clamp the parameter to [0, 1] so the
    // result is the distance to the finite segment, not the infinite line.
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY);
}
