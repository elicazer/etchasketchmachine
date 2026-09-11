import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    DRAWABLE_MM,
    FULL_STEPS_PER_KNOB_REV,
} from '../constants';
import { clampToDrawableMm, mmToSteps, scaleAndClamp } from './scale';

/**
 * Property 3: Planner clamp, scale, and home-relative offset.
 *
 * Validates: Requirements 5.2, 5.3, 10.10
 *
 * Design §7, Property 3:
 *   For any canvas-space input polyline P, calibration (mm_per_rev_x,
 *   mm_per_rev_y) and home offset H, every output coordinate produced by the
 *   planner satisfies 0 ≤ x_steps ≤ round(152 * 400 / mm_per_rev_x) and
 *   0 ≤ y_steps ≤ round(105 * 400 / mm_per_rev_y) (before the home offset is
 *   applied), the quantisation is integer-valued, and the home offset is a
 *   purely additive translation of the planner output.
 *
 * This file covers the five sub-properties of Property 3:
 *   1. CLAMP                — clamped mm in the drawable area; scaled steps in
 *                             the drawable step rectangle (Req 5.2).
 *   2. INTEGER QUANTISATION — every emitted step coordinate is an integer
 *                             (Req 5.3).
 *   3. SCALE CORRECTNESS    — mmToSteps matches the round(mm * 400/mm_per_rev)
 *                             definition for in-bounds points (Req 5.3).
 *   4. HOME OFFSET ADDITIVITY — scaleAndClamp is linear in homeOffsetSteps
 *                             (Req 10.10).
 *   5. CLAMP IDEMPOTENCE     — clamping a clamped point is a no-op (Req 5.2).
 */

// Generators ------------------------------------------------------------------

/**
 * mm-space coordinate over a wide finite range that deliberately straddles the
 * drawable area on both sides (negative and large-positive), so both clamp
 * branches are exercised on every axis.
 */
const arbMmCoord = fc.double({
    min: -1000,
    max: 1000,
    noNaN: true,
    noDefaultInfinity: true,
});

const arbPoint = fc.record({ x: arbMmCoord, y: arbMmCoord });

/**
 * Polyline of 1..32 points. The boundary layer works point-wise, so a single
 * point is a valid input here even though the planner proper retains 2+.
 */
const arbPolyline = fc.array(arbPoint, { minLength: 1, maxLength: 32 });

/** Calibrated mm-per-knob-revolution in a sane mechanical range. */
const arbMmPerRev = fc.double({
    min: 10,
    max: 500,
    noNaN: true,
    noDefaultInfinity: true,
});

/** Integer home offset in step space, big enough to expose sign bugs. */
const arbHomeOffset = fc.record({
    x: fc.integer({ min: -10_000, max: 10_000 }),
    y: fc.integer({ min: -10_000, max: 10_000 }),
});

/** In-bounds mm-space point: no clamping happens, so scaling is exact. */
const arbInBoundsPoint = fc.record({
    x: fc.double({ min: 0, max: DRAWABLE_MM.w, noNaN: true, noDefaultInfinity: true }),
    y: fc.double({ min: 0, max: DRAWABLE_MM.h, noNaN: true, noDefaultInfinity: true }),
});

const NUM_RUNS = { numRuns: 500 } as const;

// Properties ------------------------------------------------------------------

describe('Property 3: Planner clamp, scale, and home-relative offset', () => {
    it('1a. CLAMP (Req 5.2): clampToDrawableMm output is in [0, w] × [0, h]', () => {
        fc.assert(
            fc.property(arbPoint, (p) => {
                const c = clampToDrawableMm(p);
                expect(c.x).toBeGreaterThanOrEqual(0);
                expect(c.x).toBeLessThanOrEqual(DRAWABLE_MM.w);
                expect(c.y).toBeGreaterThanOrEqual(0);
                expect(c.y).toBeLessThanOrEqual(DRAWABLE_MM.h);
            }),
            NUM_RUNS,
        );
    });

    it('1b. CLAMP (Req 5.2): scaleAndClamp output minus home offset lies in the drawable step rectangle', () => {
        fc.assert(
            fc.property(
                arbPolyline,
                arbMmPerRev,
                arbMmPerRev,
                arbHomeOffset,
                (poly, mmX, mmY, home) => {
                    const out = scaleAndClamp(poly, {
                        mmPerRevX: mmX,
                        mmPerRevY: mmY,
                        homeOffsetSteps: home,
                    });
                    expect(out).toHaveLength(poly.length);

                    // Drawable rectangle in steps. Math.round mirrors the
                    // quantisation in mmToSteps, so the bound is exact (a point
                    // clamped to the far edge quantises to exactly this value).
                    const drawableStepsW = Math.round(
                        (DRAWABLE_MM.w * FULL_STEPS_PER_KNOB_REV) / mmX,
                    );
                    const drawableStepsH = Math.round(
                        (DRAWABLE_MM.h * FULL_STEPS_PER_KNOB_REV) / mmY,
                    );

                    for (const p of out) {
                        // Subtract the home offset back out and check the
                        // residual pre-offset step coordinate is in range.
                        const sx = p.x - home.x;
                        const sy = p.y - home.y;
                        expect(sx).toBeGreaterThanOrEqual(0);
                        expect(sx).toBeLessThanOrEqual(drawableStepsW);
                        expect(sy).toBeGreaterThanOrEqual(0);
                        expect(sy).toBeLessThanOrEqual(drawableStepsH);
                    }
                },
            ),
            NUM_RUNS,
        );
    });

    it('2. INTEGER QUANTISATION (Req 5.3): every scaleAndClamp output coordinate is an integer', () => {
        fc.assert(
            fc.property(
                arbPolyline,
                arbMmPerRev,
                arbMmPerRev,
                arbHomeOffset,
                (poly, mmX, mmY, home) => {
                    const out = scaleAndClamp(poly, {
                        mmPerRevX: mmX,
                        mmPerRevY: mmY,
                        homeOffsetSteps: home,
                    });
                    for (const p of out) {
                        expect(Number.isInteger(p.x)).toBe(true);
                        expect(Number.isInteger(p.y)).toBe(true);
                    }
                },
            ),
            NUM_RUNS,
        );
    });

    it('3. SCALE CORRECTNESS (Req 5.3): mmToSteps equals round(mm * 400/mm_per_rev) on each axis for in-bounds points', () => {
        fc.assert(
            fc.property(
                arbInBoundsPoint,
                arbMmPerRev,
                arbMmPerRev,
                (p, mmX, mmY) => {
                    const actual = mmToSteps(p, mmX, mmY);
                    // Independently-computed expected value. Comparing against
                    // Math.round of the same float expression is exact, so this
                    // guards the 400/mm_per_rev quantisation against regressions.
                    const expected = {
                        x: Math.round((p.x * FULL_STEPS_PER_KNOB_REV) / mmX),
                        y: Math.round((p.y * FULL_STEPS_PER_KNOB_REV) / mmY),
                    };
                    expect(actual).toEqual(expected);
                },
            ),
            NUM_RUNS,
        );
    });

    it('4. HOME OFFSET ADDITIVITY (Req 10.10): scaleAndClamp(poly, {home: H}) === scaleAndClamp(poly) + H', () => {
        fc.assert(
            fc.property(
                arbPolyline,
                arbMmPerRev,
                arbMmPerRev,
                arbHomeOffset,
                (poly, mmX, mmY, home) => {
                    const base = scaleAndClamp(poly, {
                        mmPerRevX: mmX,
                        mmPerRevY: mmY,
                    });
                    const offset = scaleAndClamp(poly, {
                        mmPerRevX: mmX,
                        mmPerRevY: mmY,
                        homeOffsetSteps: home,
                    });
                    expect(offset).toHaveLength(base.length);
                    for (let i = 0; i < base.length; i++) {
                        expect(offset[i].x).toBe(base[i].x + home.x);
                        expect(offset[i].y).toBe(base[i].y + home.y);
                    }
                },
            ),
            NUM_RUNS,
        );
    });

    it('5. CLAMP IDEMPOTENCE (Req 5.2): clampToDrawableMm(clampToDrawableMm(p)) === clampToDrawableMm(p)', () => {
        fc.assert(
            fc.property(arbPoint, (p) => {
                const once = clampToDrawableMm(p);
                const twice = clampToDrawableMm(once);
                expect(twice).toEqual(once);
            }),
            NUM_RUNS,
        );
    });
});
