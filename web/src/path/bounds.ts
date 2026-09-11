/**
 * Out-of-bounds detection for mm-space polylines.
 *
 * Operates on millimetre-space points _before_ the planner's scale-and-clamp
 * pass so the UI can highlight content that would otherwise be silently
 * clamped to the drawable rectangle. The drawable area is the closed
 * rectangle `[0, DRAWABLE_MM.w] × [0, DRAWABLE_MM.h]`; points exactly on
 * the boundary are considered in-bounds.
 *
 * A segment is flagged when _either_ of its endpoints lies outside the
 * drawable rectangle. We deliberately use endpoint-only detection rather
 * than full segment-rectangle intersection because:
 *
 *   - The UI just needs to highlight any visible part of the user's path
 *     that the planner will alter; an in-bounds → out-of-bounds → in-bounds
 *     trip is already represented by its OOB endpoints in the dense
 *     polylines that come out of the path pipeline.
 *   - Endpoint detection is exact, cheap, and matches the consuming
 *     preview, which renders polylines as discrete segments.
 *
 * @see Requirements 8.6
 * @see Design Property 25
 */

import type { Point, Polyline } from '../types';
import { DRAWABLE_MM } from '../constants';

/**
 * One segment identified as out-of-bounds, expressed by the index of its
 * starting point in the source polyline.
 */
export interface OutOfBoundsSegment {
    /** Index `i` in the polyline; the segment runs from `poly[i]` to `poly[i+1]`. */
    index: number;
    from: Point;
    to: Point;
}

/**
 * Same as {@link OutOfBoundsSegment} but extended with the index of the
 * polyline within an array, for the multi-polyline convenience helper.
 */
export interface OutOfBoundsSegmentRef extends OutOfBoundsSegment {
    /** Index of the polyline in the input array. */
    polyIndex: number;
}

/**
 * True iff `p` lies in the closed drawable rectangle
 * `[0, DRAWABLE_MM.w] × [0, DRAWABLE_MM.h]`. Boundary points count as
 * in-bounds; NaN coordinates are treated as out-of-bounds.
 */
export function isPointInBoundsMm(p: Point): boolean {
    return (
        p.x >= 0 &&
        p.x <= DRAWABLE_MM.w &&
        p.y >= 0 &&
        p.y <= DRAWABLE_MM.h
    );
}

/**
 * Find all segments of `poly` whose start or end endpoint is out of bounds.
 *
 * For a polyline of `n` points there are `n - 1` segments indexed
 * `0 .. n - 2`. Each returned record carries the index of the starting
 * endpoint along with the actual endpoint coordinates so callers can
 * highlight the segment without re-indexing into the original polyline.
 *
 * Polylines with fewer than two points yield an empty result; there are
 * no segments to flag.
 */
export function findOutOfBoundsSegments(poly: Polyline): OutOfBoundsSegment[] {
    const out: OutOfBoundsSegment[] = [];
    if (poly.length < 2) return out;

    for (let i = 0; i < poly.length - 1; i++) {
        const from = poly[i]!;
        const to = poly[i + 1]!;
        if (!isPointInBoundsMm(from) || !isPointInBoundsMm(to)) {
            out.push({ index: i, from, to });
        }
    }
    return out;
}

/**
 * Convenience over {@link findOutOfBoundsSegments} for an array of polylines.
 * The result preserves source order: all OOB segments of polyline 0 come
 * before those of polyline 1, and so on.
 */
export function findOutOfBoundsSegmentsForPolylines(
    polys: Polyline[],
): OutOfBoundsSegmentRef[] {
    const out: OutOfBoundsSegmentRef[] = [];
    for (let p = 0; p < polys.length; p++) {
        const segs = findOutOfBoundsSegments(polys[p]!);
        for (const s of segs) {
            out.push({ polyIndex: p, index: s.index, from: s.from, to: s.to });
        }
    }
    return out;
}
