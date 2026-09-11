import { describe, it, expect } from 'vitest';
import {
    chaikin,
    FreehandCapture,
    FREEHAND_MIN_POINTS,
} from './freehand_capture';
import type { Point, Polyline } from '../types';

/**
 * Unit tests for freehand capture and Chaikin smoothing.
 *
 * These cover the example/edge-case surface called out in task 19.1.
 * The bounded-deviation property test (Chaikin within 5 px) and the
 * undo/clear property test live in tasks 19.2 and 19.3.
 */

describe('chaikin', () => {
    it('returns the input unchanged (as a copy) for iterations=0', () => {
        const poly: Polyline = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
        ];
        const out = chaikin(poly, 0);
        expect(out).toEqual(poly);
        expect(out).not.toBe(poly);
        // Points are copies, not shared references.
        expect(out[0]).not.toBe(poly[0]);
    });

    it('cuts corners: output has more points than input for iterations ≥ 1', () => {
        // An open, square-ish polyline with sharp 90° corners.
        const square: Polyline = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ];
        const once = chaikin(square, 1);
        const twice = chaikin(square, 2);
        expect(once.length).toBeGreaterThan(square.length);
        expect(twice.length).toBeGreaterThan(once.length);
    });

    it('keeps the first and last points fixed (open-polyline variant)', () => {
        const poly: Polyline = [
            { x: 1, y: 2 },
            { x: 5, y: 9 },
            { x: 11, y: 3 },
            { x: 14, y: 7 },
        ];
        const out = chaikin(poly, 2);
        expect(out[0]).toEqual(poly[0]);
        expect(out[out.length - 1]).toEqual(poly[poly.length - 1]);
    });

    it('reduces sharp corners by pulling cut points off the original vertex', () => {
        // A single sharp peak. After one round the apex (5,10) is replaced
        // by two points that are strictly below it, so the corner is cut.
        const peak: Polyline = [
            { x: 0, y: 0 },
            { x: 5, y: 10 },
            { x: 10, y: 0 },
        ];
        const out = chaikin(peak, 1);
        // No output point sits at the original apex height.
        const maxY = Math.max(...out.map((p) => p.y));
        expect(maxY).toBeLessThan(10);
    });

    it('returns a defensive copy for polylines shorter than two points', () => {
        expect(chaikin([], 3)).toEqual([]);
        const single: Polyline = [{ x: 4, y: 4 }];
        const out = chaikin(single, 3);
        expect(out).toEqual(single);
        expect(out).not.toBe(single);
    });

    it('rejects negative or non-integer iteration counts', () => {
        const poly: Polyline = [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 0 },
        ];
        expect(() => chaikin(poly, -1)).toThrow(RangeError);
        expect(() => chaikin(poly, 1.5)).toThrow(RangeError);
    });
});

describe('FreehandCapture', () => {
    /**
     * Drive the real begin/add/end lifecycle with a list of points sampled
     * ~16 ms (60 Hz) apart, then commit. Returns whatever `endStroke`
     * returned (the committed stroke, or `null` if it was discarded).
     */
    function endStrokeFrom(cap: FreehandCapture, points: Point[]): Polyline | null {
        if (points.length > 0) {
            cap.beginStroke(points[0]!, 0);
            for (let i = 1; i < points.length; i++) {
                cap.addPoint(points[i]!, i * 16);
            }
        }
        return cap.endStroke();
    }

    it('discards a stroke with fewer than 3 points (endStroke returns null)', () => {
        const cap = new FreehandCapture();
        const result = endStrokeFrom(cap, [
            { x: 0, y: 0 },
            { x: 5, y: 5 },
        ]);
        expect(result).toBeNull();
        expect(cap.strokes()).toEqual([]);
        expect(cap.strokeCount).toBe(0);
    });

    it('treats a single-point tap as below the minimum and discards it', () => {
        const cap = new FreehandCapture();
        cap.beginStroke({ x: 3, y: 3 }, 0);
        expect(cap.endStroke()).toBeNull();
        expect(cap.strokes()).toEqual([]);
    });

    it('commits and smooths a stroke with ≥ 3 points', () => {
        const cap = new FreehandCapture();
        const raw: Point[] = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
        ];
        expect(raw.length).toBeGreaterThanOrEqual(FREEHAND_MIN_POINTS);
        const before = cap.strokes().length;
        const committed = endStrokeFrom(cap, raw);
        expect(committed).not.toBeNull();
        expect(cap.strokes().length).toBe(before + 1);
        // The committed stroke is smoothed: more points than the raw input.
        expect(committed!.length).toBeGreaterThan(raw.length);
    });

    it('preserves the raw endpoints in the smoothed stroke', () => {
        const cap = new FreehandCapture();
        const raw: Point[] = [
            { x: 2, y: 3 },
            { x: 9, y: 1 },
            { x: 14, y: 8 },
            { x: 20, y: 4 },
        ];
        const committed = endStrokeFrom(cap, raw)!;
        expect(committed[0]).toEqual(raw[0]);
        expect(committed[committed.length - 1]).toEqual(raw[raw.length - 1]);
    });

    it('undo removes the most recent stroke', () => {
        const cap = new FreehandCapture();
        endStrokeFrom(cap, [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 0 },
        ]);
        endStrokeFrom(cap, [
            { x: 5, y: 5 },
            { x: 6, y: 6 },
            { x: 7, y: 5 },
        ]);
        expect(cap.strokeCount).toBe(2);
        expect(cap.undo()).toBe(true);
        expect(cap.strokeCount).toBe(1);
    });

    it('undo returns false when there is nothing to undo', () => {
        const cap = new FreehandCapture();
        expect(cap.undo()).toBe(false);
    });

    it('supports 50 consecutive undos (push 50, undo 50, empty)', () => {
        const cap = new FreehandCapture();
        for (let i = 0; i < 50; i++) {
            endStrokeFrom(cap, [
                { x: i, y: 0 },
                { x: i + 1, y: 1 },
                { x: i + 2, y: 0 },
            ]);
        }
        expect(cap.strokeCount).toBe(50);
        for (let i = 0; i < 50; i++) {
            expect(cap.undo()).toBe(true);
        }
        expect(cap.strokeCount).toBe(0);
        expect(cap.strokes()).toEqual([]);
        // Nothing left to undo.
        expect(cap.undo()).toBe(false);
    });

    it('clear empties all strokes', () => {
        const cap = new FreehandCapture();
        for (let i = 0; i < 5; i++) {
            endStrokeFrom(cap, [
                { x: i, y: 0 },
                { x: i + 1, y: 1 },
                { x: i + 2, y: 0 },
            ]);
        }
        expect(cap.strokeCount).toBe(5);
        cap.clear();
        expect(cap.strokeCount).toBe(0);
        expect(cap.strokes()).toEqual([]);
    });

    it('strokes() returns a deep defensive copy', () => {
        const cap = new FreehandCapture();
        endStrokeFrom(cap, [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 0 },
        ]);
        const a = cap.strokes();
        a[0]![0]!.x = 999;
        const b = cap.strokes();
        expect(b[0]![0]!.x).not.toBe(999);
    });

    it('rejects a maxStrokes cap below the 50-undo floor', () => {
        expect(() => new FreehandCapture({ maxStrokes: 10 })).toThrow(RangeError);
    });

    it('addPoint is a no-op when no stroke is active', () => {
        const cap = new FreehandCapture();
        cap.addPoint({ x: 1, y: 1 }, 0);
        expect(cap.isCapturing).toBe(false);
        expect(cap.endStroke()).toBeNull();
    });
});

describe('FreehandCapture.decimateToHz', () => {
    it('thins a high-rate stream toward the target frequency, keeping endpoints', () => {
        // 11 points spaced 8 ms apart (125 Hz). Decimating to 60 Hz
        // (~16.7 ms) should keep roughly every other interior point.
        const points: Polyline = [];
        const times: number[] = [];
        for (let i = 0; i < 11; i++) {
            points.push({ x: i, y: 0 });
            times.push(i * 8);
        }
        const out = FreehandCapture.decimateToHz(points, times, 60);
        expect(out.length).toBeLessThan(points.length);
        expect(out[0]).toEqual(points[0]);
        expect(out[out.length - 1]).toEqual(points[points.length - 1]);
    });

    it('rejects mismatched array lengths and non-positive hz', () => {
        expect(() =>
            FreehandCapture.decimateToHz([{ x: 0, y: 0 }], [0, 1], 60),
        ).toThrow();
        expect(() =>
            FreehandCapture.decimateToHz(
                [
                    { x: 0, y: 0 },
                    { x: 1, y: 0 },
                    { x: 2, y: 0 },
                ],
                [0, 8, 16],
                0,
            ),
        ).toThrow(RangeError);
    });
});
