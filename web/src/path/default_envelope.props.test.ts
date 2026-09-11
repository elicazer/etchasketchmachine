// Feature: drawing-motion-fix (Defect 2), fix-checking PBT (Task 7.4).
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fitPolylinesToEnvelope, type StepEnvelope } from './scale';
import type { Point, Polyline } from '../types';

/**
 * Within-default-envelope (web PBT).
 *
 * Validates: Requirements 2.5, 2.6, 2.7
 *
 * Defect 2 lets an UNCALIBRATED machine draw by falling back to the baked-in
 * DEFAULT_ENVELOPE (X = 2158, Y = 1650 full steps). The web fits source
 * polylines directly into that step rectangle via {@link fitPolylinesToEnvelope}
 * before streaming Drawing_Commands. This property pins the within-envelope
 * guarantee (Req 2.7): for ANY source polylines fitted into DEFAULT_ENVELOPE,
 * every emitted step coordinate stays inside the inclusive bounds
 * `0 <= x <= 2158`, `0 <= y <= 1650`, so an uncalibrated draw can never command
 * motion outside the bounded physical drawing area.
 *
 * @see Design §"Defect 2 — Web side; within-envelope guarantee"
 */

// Baked-in DEFAULT_ENVELOPE (full motor steps), mirroring the firmware
// DEFAULT_ENVELOPE_X/Y_STEPS constants the firmware advertises in HELLO.
const DEFAULT_ENVELOPE: StepEnvelope = { x: 2158, y: 1650 };

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

const arbFlipY = fc.boolean();

// Property --------------------------------------------------------------------

describe('Within-default-envelope: uncalibrated draws stay inside DEFAULT_ENVELOPE', () => {
    it('every fitted step coordinate satisfies 0 <= x <= 2158 and 0 <= y <= 1650', () => {
        fc.assert(
            fc.property(arbPolylines, arbFlipY, (polylines, flipY) => {
                const out = fitPolylinesToEnvelope(polylines, DEFAULT_ENVELOPE, { flipY });

                // One output polyline per input polyline, point counts preserved.
                expect(out.length).toBe(polylines.length);
                for (let i = 0; i < out.length; i++) {
                    expect(out[i]!.length).toBe(polylines[i]!.length);
                    for (const p of out[i]!) {
                        expect(Number.isInteger(p.x)).toBe(true);
                        expect(Number.isInteger(p.y)).toBe(true);
                        expect(p.x).toBeGreaterThanOrEqual(0);
                        expect(p.x).toBeLessThanOrEqual(DEFAULT_ENVELOPE.x);
                        expect(p.y).toBeGreaterThanOrEqual(0);
                        expect(p.y).toBeLessThanOrEqual(DEFAULT_ENVELOPE.y);
                    }
                }
            }),
            NUM_RUNS,
        );
    });
});
