// Feature: visual-corner-calibration, Property 1
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fitPolylinesToEnvelope, type StepEnvelope } from './scale';
import type { Point, Polyline } from '../types';

/**
 * Property 1: Fit-to-envelope stays in bounds and preserves aspect ratio.
 *
 * Validates: Requirements 3.2, 3.3, 3.4
 *
 * For ANY set of source polylines and ANY valid {@link StepEnvelope} with
 * `x > 0` and `y > 0`, `fitPolylinesToEnvelope`:
 *
 *   1. BOUNDS   — emits only integer coordinates within the inclusive bounds
 *                 `[0, env.x]` on X and `[0, env.y]` on Y (Req 3.4).
 *   2. ASPECT   — applies a SINGLE uniform scale factor to both axes, so the
 *                 drawing is centered and letterboxed, never stretched
 *                 (Req 3.2, 3.3). We verify this by independently
 *                 reconstructing the expected uniform scale `s` and the
 *                 center offsets, then checking every emitted point matches the
 *                 single-`s` model within a 1-step rounding tolerance. Matching
 *                 a single-`s` model on both axes IS the proof that the X and Y
 *                 scale factors are equal.
 *
 * @see Design §Correctness Properties (P1)
 */

const NUM_RUNS = { numRuns: 300 } as const;

// Generators ------------------------------------------------------------------

/** Finite source coordinates spanning a wide arbitrary range. */
const arbCoord = fc.double({
    min: -100000,
    max: 100000,
    noNaN: true,
    noDefaultInfinity: true,
});

const arbPoint: fc.Arbitrary<Point> = fc.record({ x: arbCoord, y: arbCoord });

/** Non-empty polyline (at least one point). */
const arbPolyline: fc.Arbitrary<Polyline> = fc.array(arbPoint, {
    minLength: 1,
    maxLength: 20,
});

/** A non-empty set of non-empty polylines. */
const arbPolylines: fc.Arbitrary<Polyline[]> = fc.array(arbPolyline, {
    minLength: 1,
    maxLength: 6,
});

/** A valid measured envelope: integer step counts in [1, 60000] on each axis. */
const arbEnvelope: fc.Arbitrary<StepEnvelope> = fc.record({
    x: fc.integer({ min: 1, max: 60000 }),
    y: fc.integer({ min: 1, max: 60000 }),
});

const arbFlipY = fc.boolean();

// Helpers ---------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
    if (v < min) return min;
    if (v > max) return max;
    return v;
}

function isInteger(n: number): boolean {
    return Number.isInteger(n);
}

// Properties ------------------------------------------------------------------

describe('Property 1: Fit-to-envelope bounds + aspect ratio', () => {
    it('1. BOUNDS: every emitted coordinate is an integer within [0, env.x] / [0, env.y]', () => {
        fc.assert(
            fc.property(arbPolylines, arbEnvelope, arbFlipY, (polylines, env, flipY) => {
                const out = fitPolylinesToEnvelope(polylines, env, { flipY });

                // One output polyline per input polyline, preserving point counts.
                expect(out.length).toBe(polylines.length);
                for (let i = 0; i < out.length; i++) {
                    expect(out[i]!.length).toBe(polylines[i]!.length);
                    for (const p of out[i]!) {
                        expect(isInteger(p.x)).toBe(true);
                        expect(isInteger(p.y)).toBe(true);
                        expect(p.x).toBeGreaterThanOrEqual(0);
                        expect(p.x).toBeLessThanOrEqual(env.x);
                        expect(p.y).toBeGreaterThanOrEqual(0);
                        expect(p.y).toBeLessThanOrEqual(env.y);
                    }
                }
            }),
            NUM_RUNS,
        );
    });

    it('2. ASPECT: a single uniform scale is applied to both axes (centered, letterboxed, never stretched)', () => {
        fc.assert(
            fc.property(arbPolylines, arbEnvelope, arbFlipY, (polylines, env, flipY) => {
                // Independently reconstruct the source bounding box.
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const poly of polylines) {
                    for (const p of poly) {
                        if (p.x < minX) minX = p.x;
                        if (p.x > maxX) maxX = p.x;
                        if (p.y < minY) minY = p.y;
                        if (p.y > maxY) maxY = p.y;
                    }
                }

                const srcW = maxX - minX;
                const srcH = maxY - minY;

                // Guard against degenerate-extent false negatives: the aspect
                // check is only meaningful when both axes have non-zero extent.
                fc.pre(srcW > 0 && srcH > 0);

                // Reconstruct the single uniform scale the implementation uses
                // (default margin/fill = 1.0). One `s` for BOTH axes.
                const targetW = env.x;
                const targetH = env.y;
                const sx = targetW / srcW;
                const sy = targetH / srcH;
                const s = Math.min(sx, sy);

                // Centering offsets (letterbox the unused area).
                const offX = (env.x - srcW * s) / 2;
                const offY = (env.y - srcH * s) / 2;

                const out = fitPolylinesToEnvelope(polylines, env, { flipY });

                // Every emitted point must match the single-`s` model within a
                // 1-step rounding tolerance, after the defensive edge clamp.
                for (let i = 0; i < out.length; i++) {
                    const inPoly = polylines[i]!;
                    const outPoly = out[i]!;
                    for (let j = 0; j < outPoly.length; j++) {
                        const src = inPoly[j]!;
                        const expectedX = clamp(offX + (src.x - minX) * s, 0, env.x);
                        const expectedYRaw = flipY
                            ? offY + (maxY - src.y) * s
                            : offY + (src.y - minY) * s;
                        const expectedY = clamp(expectedYRaw, 0, env.y);

                        // |emitted - expected| <= 1: the implementation rounds
                        // the same single-`s` expression and clamps to bounds.
                        expect(Math.abs(outPoly[j]!.x - expectedX)).toBeLessThanOrEqual(1);
                        expect(Math.abs(outPoly[j]!.y - expectedY)).toBeLessThanOrEqual(1);
                    }
                }
            }),
            NUM_RUNS,
        );
    });

    it('3. NEVER STRETCHED: the realized X and Y scale factors are equal (uniform)', () => {
        fc.assert(
            fc.property(arbPolylines, arbEnvelope, (polylines, env) => {
                // Reconstruct source bbox.
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const poly of polylines) {
                    for (const p of poly) {
                        if (p.x < minX) minX = p.x;
                        if (p.x > maxX) maxX = p.x;
                        if (p.y < minY) minY = p.y;
                        if (p.y > maxY) maxY = p.y;
                    }
                }
                const srcW = maxX - minX;
                const srcH = maxY - minY;

                // Need a meaningful extent on both axes, and large enough that
                // integer rounding noise does not dominate the realized ratio.
                fc.pre(srcW >= 100 && srcH >= 100);

                const out = fitPolylinesToEnvelope(polylines, env);

                // Measure the realized output extent on each axis.
                let oMinX = Infinity;
                let oMinY = Infinity;
                let oMaxX = -Infinity;
                let oMaxY = -Infinity;
                for (const poly of out) {
                    for (const p of poly) {
                        if (p.x < oMinX) oMinX = p.x;
                        if (p.x > oMaxX) oMaxX = p.x;
                        if (p.y < oMinY) oMinY = p.y;
                        if (p.y > oMaxY) oMaxY = p.y;
                    }
                }
                const outW = oMaxX - oMinX;
                const outH = oMaxY - oMinY;

                // Realized per-axis scale factors.
                const realizedSx = outW / srcW;
                const realizedSy = outH / srcH;

                // A single uniform scale means these are equal up to integer
                // rounding of the output extents (±~1 step per extent over the
                // source extent). Allow a small relative tolerance.
                const tol = 2 / Math.min(srcW, srcH) + 1e-9;
                expect(Math.abs(realizedSx - realizedSy)).toBeLessThanOrEqual(tol);
            }),
            NUM_RUNS,
        );
    });
});
