import { describe, it, expect } from 'vitest';
import {
    isPointInBoundsMm,
    findOutOfBoundsSegments,
    findOutOfBoundsSegmentsForPolylines,
} from './bounds';
import { DRAWABLE_MM } from '../constants';
import type { Polyline } from '../types';

/**
 * Unit tests for mm-space out-of-bounds segment detection.
 *
 * The drawable rectangle is the closed `[0, 152] × [0, 105]` mm region;
 * boundary points are in-bounds. A segment is OOB when either of its
 * endpoints is outside that rectangle.
 */

describe('isPointInBoundsMm', () => {
    it('treats the four exact corners as in-bounds', () => {
        expect(isPointInBoundsMm({ x: 0, y: 0 })).toBe(true);
        expect(isPointInBoundsMm({ x: DRAWABLE_MM.w, y: DRAWABLE_MM.h })).toBe(true);
        expect(isPointInBoundsMm({ x: DRAWABLE_MM.w, y: 0 })).toBe(true);
        expect(isPointInBoundsMm({ x: 0, y: DRAWABLE_MM.h })).toBe(true);
    });

    it('treats interior points as in-bounds', () => {
        expect(isPointInBoundsMm({ x: 76, y: 52.5 })).toBe(true);
    });

    it('treats points just outside any edge as out-of-bounds', () => {
        expect(isPointInBoundsMm({ x: -0.001, y: 50 })).toBe(false);
        expect(isPointInBoundsMm({ x: 50, y: -0.001 })).toBe(false);
        expect(isPointInBoundsMm({ x: DRAWABLE_MM.w + 0.001, y: 50 })).toBe(false);
        expect(isPointInBoundsMm({ x: 50, y: DRAWABLE_MM.h + 0.001 })).toBe(false);
    });
});

describe('findOutOfBoundsSegments', () => {
    it('returns [] for a polyline entirely inside the drawable rectangle', () => {
        const poly: Polyline = [
            { x: 1, y: 1 },
            { x: 50, y: 25 },
            { x: 100, y: 80 },
            { x: 151, y: 104 },
        ];
        expect(findOutOfBoundsSegments(poly)).toEqual([]);
    });

    it('returns [] when every point lies exactly on the rectangle boundary', () => {
        const poly: Polyline = [
            { x: 0, y: 0 },
            { x: DRAWABLE_MM.w, y: 0 },
            { x: DRAWABLE_MM.w, y: DRAWABLE_MM.h },
            { x: 0, y: DRAWABLE_MM.h },
            { x: 0, y: 0 },
        ];
        expect(findOutOfBoundsSegments(poly)).toEqual([]);
    });

    it('returns [] for polylines with fewer than two points', () => {
        expect(findOutOfBoundsSegments([])).toEqual([]);
        expect(findOutOfBoundsSegments([{ x: 9999, y: 9999 }])).toEqual([]);
    });

    it('flags exactly the one segment touching a single OOB endpoint at the start', () => {
        const poly: Polyline = [
            { x: -10, y: 50 }, // OOB
            { x: 50, y: 50 },
            { x: 100, y: 50 },
        ];
        const oob = findOutOfBoundsSegments(poly);
        expect(oob).toHaveLength(1);
        expect(oob[0]).toEqual({
            index: 0,
            from: poly[0],
            to: poly[1],
        });
    });

    it('flags exactly the one segment touching a single OOB endpoint at the end', () => {
        const poly: Polyline = [
            { x: 50, y: 50 },
            { x: 100, y: 50 },
            { x: 200, y: 50 }, // OOB on +x
        ];
        const oob = findOutOfBoundsSegments(poly);
        expect(oob).toHaveLength(1);
        expect(oob[0]).toEqual({
            index: 1,
            from: poly[1],
            to: poly[2],
        });
    });

    it('flags exactly the one segment touching a single OOB endpoint in the middle', () => {
        const poly: Polyline = [
            { x: 10, y: 10 },
            { x: 20, y: 20 },
            { x: 30, y: -5 }, // OOB on -y
            { x: 40, y: 40 },
            { x: 50, y: 50 },
        ];
        const oob = findOutOfBoundsSegments(poly);
        // Segments touching index 2 are (1→2) and (2→3); (0→1) and (3→4) are clean.
        expect(oob).toHaveLength(2);
        expect(oob.map((s) => s.index)).toEqual([1, 2]);
    });

    it('flags the segment between two consecutive OOB points and the segments that cross back in', () => {
        const poly: Polyline = [
            { x: 10, y: 10 }, // in
            { x: -5, y: 50 }, // OOB
            { x: -5, y: 60 }, // OOB
            { x: 80, y: 80 }, // in
            { x: 120, y: 90 }, // in
        ];
        const oob = findOutOfBoundsSegments(poly);
        // Expected:
        //   (0→1) crosses out: flagged
        //   (1→2) both OOB: flagged
        //   (2→3) crosses back in: flagged
        //   (3→4) entirely in: not flagged
        expect(oob.map((s) => s.index)).toEqual([0, 1, 2]);
        expect(oob[0]?.from).toEqual(poly[0]);
        expect(oob[0]?.to).toEqual(poly[1]);
        expect(oob[1]?.from).toEqual(poly[1]);
        expect(oob[1]?.to).toEqual(poly[2]);
        expect(oob[2]?.from).toEqual(poly[2]);
        expect(oob[2]?.to).toEqual(poly[3]);
    });
});

describe('findOutOfBoundsSegmentsForPolylines', () => {
    it('returns [] when all input polylines are clean', () => {
        const polys: Polyline[] = [
            [
                { x: 0, y: 0 },
                { x: 10, y: 10 },
            ],
            [
                { x: 50, y: 50 },
                { x: 100, y: 80 },
            ],
        ];
        expect(findOutOfBoundsSegmentsForPolylines(polys)).toEqual([]);
    });

    it('preserves source order and reports the correct polyIndex per OOB segment', () => {
        const polys: Polyline[] = [
            [
                { x: 0, y: 0 },
                { x: 10, y: 10 },
            ],
            [
                { x: 50, y: 50 },
                { x: 200, y: 50 }, // OOB
                { x: 90, y: 90 },
            ],
            [
                { x: -1, y: 0 }, // OOB
                { x: 5, y: 5 },
            ],
        ];
        const flagged = findOutOfBoundsSegmentsForPolylines(polys);
        expect(flagged).toHaveLength(3);
        expect(flagged[0]).toMatchObject({ polyIndex: 1, index: 0 });
        expect(flagged[1]).toMatchObject({ polyIndex: 1, index: 1 });
        expect(flagged[2]).toMatchObject({ polyIndex: 2, index: 0 });
    });
});
