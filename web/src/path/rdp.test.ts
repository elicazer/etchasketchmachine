import { describe, it, expect } from 'vitest';
import { rdpSimplify } from './rdp';
import type { Polyline } from '../types';

/**
 * Unit tests for Ramer-Douglas-Peucker line simplification.
 *
 * These cover the example/edge-case surface called out in task 11.1.
 * Property-based tests for the universal distance bound and
 * idempotence live in task 11.2.
 */

describe('rdpSimplify', () => {
    it('reduces a straight line of collinear points to its endpoints', () => {
        const line: Polyline = [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3 },
            { x: 4, y: 4 },
            { x: 5, y: 5 },
        ];
        const out = rdpSimplify(line, 0.5);
        expect(out).toEqual([
            { x: 0, y: 0 },
            { x: 5, y: 5 },
        ]);
    });

    it('returns a 2-point polyline unchanged', () => {
        const poly: Polyline = [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
        ];
        const out = rdpSimplify(poly, 1.0);
        expect(out).toEqual(poly);
        // ensure it's a copy, not the same reference
        expect(out).not.toBe(poly);
    });

    it('returns shorter polylines unchanged', () => {
        expect(rdpSimplify([], 1.0)).toEqual([]);
        expect(rdpSimplify([{ x: 7, y: 9 }], 1.0)).toEqual([{ x: 7, y: 9 }]);
    });

    it("preserves a triangle's apex when its perpendicular distance exceeds tolerance", () => {
        // Apex sits 3 units above the chord (0,0)-(10,0), well outside ε=1.
        const triangle: Polyline = [
            { x: 0, y: 0 },
            { x: 5, y: 3 },
            { x: 10, y: 0 },
        ];
        const out = rdpSimplify(triangle, 1.0);
        expect(out).toEqual(triangle);
    });

    it("collapses a triangle's apex when its perpendicular distance is within tolerance", () => {
        // Same chord, but the apex is only 0.2 units above it - inside ε=0.5.
        const flat: Polyline = [
            { x: 0, y: 0 },
            { x: 5, y: 0.2 },
            { x: 10, y: 0 },
        ];
        const out = rdpSimplify(flat, 0.5);
        expect(out).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
        ]);
    });

    it('rejects epsilon below the documented [0.1, 5.0] range', () => {
        const poly: Polyline = [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 },
        ];
        expect(() => rdpSimplify(poly, 0.0)).toThrow(RangeError);
        expect(() => rdpSimplify(poly, 0.099)).toThrow(RangeError);
    });

    it('rejects epsilon above the documented [0.1, 5.0] range', () => {
        const poly: Polyline = [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 },
        ];
        expect(() => rdpSimplify(poly, 5.01)).toThrow(RangeError);
    });

    it('rejects non-finite epsilon', () => {
        const poly: Polyline = [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
        ];
        expect(() => rdpSimplify(poly, Number.NaN)).toThrow(RangeError);
        expect(() => rdpSimplify(poly, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });

    it('preserves the original endpoints for an arbitrary squiggle', () => {
        const squiggle: Polyline = [
            { x: 0, y: 0 },
            { x: 1, y: 4 },
            { x: 2, y: -2 },
            { x: 3, y: 5 },
            { x: 4, y: -1 },
            { x: 5, y: 3 },
            { x: 6, y: 0 },
            { x: 7, y: 6 },
            { x: 8, y: -3 },
            { x: 9, y: 2 },
            { x: 10, y: 0 },
        ];
        const out = rdpSimplify(squiggle, 1.0);
        expect(out[0]).toEqual(squiggle[0]);
        expect(out[out.length - 1]).toEqual(squiggle[squiggle.length - 1]);
        // Simplification cannot grow the polyline.
        expect(out.length).toBeLessThanOrEqual(squiggle.length);
        // The squiggle deviates well beyond ε=1, so at least some interior
        // points must have been kept.
        expect(out.length).toBeGreaterThanOrEqual(2);
    });

    it('is idempotent: simplifying twice with the same epsilon yields the same polyline', () => {
        const squiggle: Polyline = [
            { x: 0, y: 0 },
            { x: 1, y: 4 },
            { x: 2, y: -2 },
            { x: 3, y: 5 },
            { x: 4, y: -1 },
            { x: 5, y: 3 },
            { x: 6, y: 0 },
            { x: 7, y: 6 },
            { x: 8, y: -3 },
            { x: 9, y: 2 },
            { x: 10, y: 0 },
        ];
        const once = rdpSimplify(squiggle, 1.0);
        const twice = rdpSimplify(once, 1.0);
        expect(twice).toEqual(once);
    });
});
