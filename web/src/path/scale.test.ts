import { describe, it, expect } from 'vitest';
import {
    DRAWABLE_MM,
    FULL_STEPS_PER_KNOB_REV,
} from '../constants';
import { clampToDrawableMm, mmToSteps, scaleAndClamp, fitPolylinesToDrawable } from './scale';

/**
 * Unit tests for the scale → clamp → step-conversion boundary layer.
 *
 * These cover Requirements 5.2 (clamp to drawable area), 5.3 (integer
 * step quantisation via 400/mm_per_rev), and 10.10 (home-relative offset).
 */

describe('clampToDrawableMm', () => {
    it('clamps x and y independently against the (0, w) and (0, h) bounds', () => {
        // x below min, y above max -> both clamped, independently.
        expect(clampToDrawableMm({ x: -10, y: 999 })).toEqual({
            x: 0,
            y: DRAWABLE_MM.h,
        });
        // x above max, y below min.
        expect(clampToDrawableMm({ x: 999, y: -50 })).toEqual({
            x: DRAWABLE_MM.w,
            y: 0,
        });
    });

    it('returns a point exactly on the boundary unchanged', () => {
        expect(clampToDrawableMm({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
        expect(
            clampToDrawableMm({ x: DRAWABLE_MM.w, y: DRAWABLE_MM.h }),
        ).toEqual({ x: DRAWABLE_MM.w, y: DRAWABLE_MM.h });
        expect(clampToDrawableMm({ x: DRAWABLE_MM.w, y: 0 })).toEqual({
            x: DRAWABLE_MM.w,
            y: 0,
        });
    });

    it('passes interior points through untouched', () => {
        expect(clampToDrawableMm({ x: 12.5, y: 73.25 })).toEqual({
            x: 12.5,
            y: 73.25,
        });
    });
});

describe('mmToSteps', () => {
    it('at 100 mm/rev yields 4 steps/mm (since 400/100 = 4)', () => {
        expect(FULL_STEPS_PER_KNOB_REV).toBe(400);
        // 1 mm at 100 mm/rev -> 4 steps.
        expect(mmToSteps({ x: 1, y: 1 }, 100, 100)).toEqual({ x: 4, y: 4 });
        // 10 mm -> 40 steps.
        expect(mmToSteps({ x: 10, y: 10 }, 100, 100)).toEqual({ x: 40, y: 40 });
    });

    it('rounds to the nearest integer step (no fractional output)', () => {
        // 0.3 mm * 4 steps/mm = 1.2 -> rounds to 1.
        // 0.7 mm * 4 steps/mm = 2.8 -> rounds to 3.
        const r = mmToSteps({ x: 0.3, y: 0.7 }, 100, 100);
        expect(r).toEqual({ x: 1, y: 3 });
        expect(Number.isInteger(r.x)).toBe(true);
        expect(Number.isInteger(r.y)).toBe(true);
    });

    it('honours independent X and Y mm-per-rev calibrations', () => {
        // 50 mm/rev on X -> 8 steps/mm; 200 mm/rev on Y -> 2 steps/mm.
        expect(mmToSteps({ x: 5, y: 5 }, 50, 200)).toEqual({ x: 40, y: 10 });
    });
});

describe('scaleAndClamp', () => {
    it('returns integer coordinates for every emitted point', () => {
        const poly = [
            { x: 0.3, y: 0.7 },
            { x: 1.49, y: 2.51 },
            { x: 100.123, y: 50.987 },
        ];
        const out = scaleAndClamp(poly);
        expect(out).toHaveLength(poly.length);
        for (const p of out) {
            expect(Number.isInteger(p.x)).toBe(true);
            expect(Number.isInteger(p.y)).toBe(true);
        }
    });

    it('clamps an out-of-bounds point in a polyline to the boundary in step space', () => {
        // Pin calibration to 100 mm/rev → 4 steps/mm so the expected step
        // counts are fixed regardless of the machine-specific default.
        const cal = { mmPerRevX: 100, mmPerRevY: 100 };
        const drawableStepsW = Math.round(
            DRAWABLE_MM.w * (FULL_STEPS_PER_KNOB_REV / cal.mmPerRevX),
        );
        const drawableStepsH = Math.round(
            DRAWABLE_MM.h * (FULL_STEPS_PER_KNOB_REV / cal.mmPerRevY),
        );

        const poly = [
            { x: 10, y: 10 }, // in-bounds
            { x: -50, y: 999 }, // both axes out of bounds; should clamp to (0, h)
            { x: 50, y: 50 }, // in-bounds
        ];
        const out = scaleAndClamp(poly, cal);

        // First and last are unchanged in mm and quantise cleanly.
        expect(out[0]).toEqual({ x: 40, y: 40 });
        expect(out[2]).toEqual({ x: 200, y: 200 });

        // The OOB point clamps to (0, h) in mm, then quantises in step space.
        expect(out[1]).toEqual({ x: 0, y: drawableStepsH });

        // And nothing escapes the drawable rectangle in step space.
        for (const p of out) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(drawableStepsW);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(drawableStepsH);
        }
    });

    it('applies homeOffsetSteps additively after step conversion', () => {
        const poly = [
            { x: 0, y: 0 },
            { x: 10, y: 5 },
        ];
        const out = scaleAndClamp(poly, {
            mmPerRevX: 100,
            mmPerRevY: 100,
            homeOffsetSteps: { x: 100, y: -25 },
        });
        // (0,0) + offset
        expect(out[0]).toEqual({ x: 100, y: -25 });
        // (10mm,5mm) -> (40,20) steps + offset
        expect(out[1]).toEqual({ x: 140, y: -5 });
    });

    it('defaults homeOffsetSteps to {0,0} when omitted', () => {
        const out = scaleAndClamp([{ x: 10, y: 5 }], {
            mmPerRevX: 100,
            mmPerRevY: 100,
        });
        expect(out[0]).toEqual({ x: 40, y: 20 });
    });

    it('uses the provided mm-per-rev overrides instead of the defaults', () => {
        const out = scaleAndClamp([{ x: 10, y: 10 }], {
            mmPerRevX: 50, // 8 steps/mm
            mmPerRevY: 200, // 2 steps/mm
        });
        expect(out[0]).toEqual({ x: 80, y: 20 });
    });
    it('does NOT flip Y by default (text is already +Y up)', () => {
        // Source bottom point (largest y) must stay the largest y when no flip.
        const src = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }]];
        const out = fitPolylinesToDrawable(src);
        const sourceBottom = out[0][2]; // was (5,10), the largest source y
        const sourceTop = out[0][0]; // was (0,0)
        expect(sourceBottom.y).toBeGreaterThan(sourceTop.y);
    });
});

describe('fitPolylinesToDrawable — fit geometry', () => {
    const bbox = (polys: { x: number; y: number }[][]) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const poly of polys) for (const p of poly) {
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
        return { minX, minY, maxX, maxY };
    };

    it('returns [] for empty input', () => {
        expect(fitPolylinesToDrawable([])).toEqual([]);
    });

    it('scales a tiny source up to fill (within margin) and centers it', () => {
        // 10x10 source square in pixel space.
        const src = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]];
        const out = fitPolylinesToDrawable(src, { margin: 0.9 });
        const b = bbox(out);

        // Everything lands inside the drawable area.
        expect(b.minX).toBeGreaterThanOrEqual(0);
        expect(b.minY).toBeGreaterThanOrEqual(0);
        expect(b.maxX).toBeLessThanOrEqual(DRAWABLE_MM.w + 1e-6);
        expect(b.maxY).toBeLessThanOrEqual(DRAWABLE_MM.h + 1e-6);

        // A square keeps its aspect ratio (equal width and height after fit).
        expect(b.maxX - b.minX).toBeCloseTo(b.maxY - b.minY, 6);

        // Centered: left margin equals right margin.
        expect(b.minX).toBeCloseTo(DRAWABLE_MM.w - b.maxX, 6);
        expect(b.minY).toBeCloseTo(DRAWABLE_MM.h - b.maxY, 6);
    });

    it('scales a huge source down to fit', () => {
        const src = [[{ x: 0, y: 0 }, { x: 100000, y: 0 }, { x: 100000, y: 50000 }]];
        const out = fitPolylinesToDrawable(src);
        const b = bbox(out);
        expect(b.maxX).toBeLessThanOrEqual(DRAWABLE_MM.w + 1e-6);
        expect(b.maxY).toBeLessThanOrEqual(DRAWABLE_MM.h + 1e-6);
        expect(b.minX).toBeGreaterThanOrEqual(0);
        expect(b.minY).toBeGreaterThanOrEqual(0);
    });

    it('flips Y so source Y-down becomes drawable Y-up', () => {
        // Source (0,0) and (10,0) are visually the TOP in Y-down space;
        // (5,10) is visually the BOTTOM. After flipping to Y-up, the source
        // bottom point must end up with the SMALLEST output y.
        const src = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }]];
        const out = fitPolylinesToDrawable(src, { flipY: true });
        const sourceBottom = out[0][2]; // was (5,10)
        const sourceTop = out[0][0]; // was (0,0)
        expect(sourceBottom.y).toBeLessThan(sourceTop.y);
    });
});
