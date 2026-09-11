import { describe, it, expect } from 'vitest';
import {
    buildSpeedSchedule,
    estimateMillisForSteps,
    estimateMillisFromSchedule,
} from './ramp';
import { FEED_SPS_MIN, FEED_SPS_MAX } from '../constants';

/**
 * Unit tests for the browser-side trapezoidal speed schedule.
 *
 * Property-based coverage of the same schedule lives in `ramp.test.ts`'s
 * sibling property-test file (Task 22.2); these unit tests cover the
 * specific shape contracts and error paths called out in Task 22.1 of
 * the implementation plan.
 *
 * The numeric tolerance allowed below (`1e-9`) accounts for ordinary IEEE
 * float drift in the per-step `Math.min` math; nothing in the algorithm
 * itself is approximate.
 */

const EPS = 1e-9;

describe('buildSpeedSchedule', () => {
    describe('shape contract', () => {
        it('returns a schedule whose length equals the requested step count', () => {
            const cases = [1, 2, 5, 10, 100, 1000];
            for (const steps of cases) {
                const sched = buildSpeedSchedule({
                    steps,
                    vMin: 100,
                    vPeak: 1000,
                    accelStepsPerSec2: 50,
                });
                expect(sched.length).toBe(steps);
            }
        });

        it('starts and ends at vMin', () => {
            const sched = buildSpeedSchedule({
                steps: 50,
                vMin: 100,
                vPeak: 800,
                accelStepsPerSec2: 25,
            });
            expect(sched[0]).toBe(100);
            expect(sched[sched.length - 1]).toBe(100);
        });

        it('returns [vMin] for a single-step segment', () => {
            const sched = buildSpeedSchedule({
                steps: 1,
                vMin: 100,
                vPeak: 1000,
                accelStepsPerSec2: 100,
            });
            expect(sched).toEqual([100]);
        });

        it('returns an empty array for zero steps', () => {
            expect(
                buildSpeedSchedule({
                    steps: 0,
                    vMin: 100,
                    vPeak: 1000,
                    accelStepsPerSec2: 100,
                }),
            ).toEqual([]);
        });

        it('never exceeds the post-speedPct peak', () => {
            const sched = buildSpeedSchedule({
                steps: 200,
                vMin: 100,
                vPeak: 1000,
                accelStepsPerSec2: 50,
                speedPct: 80,
            });
            const expectedPeak = (1000 * 80) / 100; // 800
            for (const v of sched) {
                expect(v).toBeLessThanOrEqual(expectedPeak + EPS);
            }
            // And it actually reaches the peak somewhere given a long segment.
            expect(Math.max(...sched)).toBeCloseTo(expectedPeak, 9);
        });
    });

    describe('monotonicity (single hump)', () => {
        it('is non-decreasing then non-increasing for a long segment', () => {
            const sched = buildSpeedSchedule({
                steps: 100,
                vMin: 100,
                vPeak: 700,
                accelStepsPerSec2: 50,
            });
            assertSingleHump(sched);
        });

        it('is non-decreasing then non-increasing for a short triangular segment', () => {
            // Plateau is unreachable: peak=1000 needs 18 steps of acceleration
            // at delta=50 from vMin=100, but we only allocate 11.
            const sched = buildSpeedSchedule({
                steps: 11,
                vMin: 100,
                vPeak: 1000,
                accelStepsPerSec2: 50,
            });
            assertSingleHump(sched);
        });

        it('is non-decreasing then non-increasing for an even-step triangle', () => {
            const sched = buildSpeedSchedule({
                steps: 10,
                vMin: 100,
                vPeak: 1000,
                accelStepsPerSec2: 50,
            });
            assertSingleHump(sched);
        });
    });

    describe('acceleration bound', () => {
        it('caps consecutive speed deltas at accelStepsPerSec2', () => {
            const accel = 50;
            const sched = buildSpeedSchedule({
                steps: 60,
                vMin: 100,
                vPeak: 1000,
                accelStepsPerSec2: accel,
            });
            for (let i = 1; i < sched.length; i++) {
                expect(Math.abs(sched[i]! - sched[i - 1]!)).toBeLessThanOrEqual(
                    accel + EPS,
                );
            }
        });
    });

    describe('triangular profile when segment is short', () => {
        it('never reaches vPeak when ramp length exceeds half the steps', () => {
            // delta=50; reaching vPeak=1000 from vMin=100 needs 18 steps of
            // acceleration. With only 11 steps total the up- and down-ramps
            // meet at step 5 (apex) far below the configured peak.
            const sched = buildSpeedSchedule({
                steps: 11,
                vMin: 100,
                vPeak: 1000,
                accelStepsPerSec2: 50,
            });
            const apex = Math.max(...sched);
            expect(apex).toBeLessThan(1000);
            // The classic triangular apex for an odd-length segment of N
            // steps is vMin + ((N-1)/2) * delta.
            expect(apex).toBeCloseTo(100 + 5 * 50, 9);
        });

        it('produces a triangular profile (one apex, no plateau) for even steps', () => {
            const sched = buildSpeedSchedule({
                steps: 10,
                vMin: 100,
                vPeak: 1000,
                accelStepsPerSec2: 50,
            });
            // For N=10 the two centre samples both sit at the apex value.
            const apex = Math.max(...sched);
            expect(apex).toBeLessThan(1000);
            expect(sched[4]).toBe(apex);
            expect(sched[5]).toBe(apex);
        });
    });

    describe('speedPct scaling', () => {
        it('halves the achievable peak when speedPct is 50', () => {
            const opts = {
                steps: 200,
                vMin: 100,
                vPeak: 1000,
                accelStepsPerSec2: 50,
            } as const;
            const full = buildSpeedSchedule({ ...opts, speedPct: 100 });
            const half = buildSpeedSchedule({ ...opts, speedPct: 50 });
            expect(Math.max(...full)).toBeCloseTo(1000, 9);
            expect(Math.max(...half)).toBeCloseTo(500, 9);
        });

        it('floors the scaled peak at vMin when the slider would drop below it', () => {
            // 500 * 25 / 100 = 125, comfortably above vMin=100.
            // Pick a vPeak / speedPct combo where scaledPeak < vMin and
            // verify the schedule degenerates to a flat run at vMin.
            const sched = buildSpeedSchedule({
                steps: 30,
                vMin: 200,
                vPeak: 500,
                accelStepsPerSec2: 50,
                speedPct: 25, // scaled peak = 125 < vMin=200
            });
            for (const v of sched) expect(v).toBe(200);
        });

        it('defaults to 100% when speedPct is omitted', () => {
            const explicit = buildSpeedSchedule({
                steps: 50,
                vMin: 100,
                vPeak: 800,
                accelStepsPerSec2: 50,
                speedPct: 100,
            });
            const implicit = buildSpeedSchedule({
                steps: 50,
                vMin: 100,
                vPeak: 800,
                accelStepsPerSec2: 50,
            });
            expect(implicit).toEqual(explicit);
        });
    });

    describe('input validation', () => {
        const base = {
            steps: 10,
            vMin: 100,
            vPeak: 1000,
            accelStepsPerSec2: 50,
        };

        it('throws when vMin is below FEED_SPS_MIN', () => {
            expect(() =>
                buildSpeedSchedule({ ...base, vMin: FEED_SPS_MIN - 1, vPeak: 1000 }),
            ).toThrow(RangeError);
        });

        it('throws when vPeak is above FEED_SPS_MAX', () => {
            expect(() =>
                buildSpeedSchedule({ ...base, vPeak: FEED_SPS_MAX + 1 }),
            ).toThrow(RangeError);
        });

        it('throws when vMin exceeds vPeak', () => {
            expect(() =>
                buildSpeedSchedule({ ...base, vMin: 800, vPeak: 500 }),
            ).toThrow(RangeError);
        });

        it('throws when accelStepsPerSec2 is non-positive', () => {
            expect(() =>
                buildSpeedSchedule({ ...base, accelStepsPerSec2: 0 }),
            ).toThrow(RangeError);
            expect(() =>
                buildSpeedSchedule({ ...base, accelStepsPerSec2: -1 }),
            ).toThrow(RangeError);
        });

        it('throws when steps is not a non-negative integer', () => {
            expect(() => buildSpeedSchedule({ ...base, steps: -1 })).toThrow(
                RangeError,
            );
            expect(() => buildSpeedSchedule({ ...base, steps: 1.5 })).toThrow(
                RangeError,
            );
        });

        it('throws when speedPct is outside [25, 100]', () => {
            expect(() =>
                buildSpeedSchedule({ ...base, speedPct: 24 }),
            ).toThrow(RangeError);
            expect(() =>
                buildSpeedSchedule({ ...base, speedPct: 101 }),
            ).toThrow(RangeError);
        });
    });
});

describe('estimateMillisFromSchedule', () => {
    it('returns 1000 * N / v for a constant-speed schedule', () => {
        const v = 500;
        const N = 200;
        const sched = new Array<number>(N).fill(v);
        const expected = (1000 * N) / v;
        expect(estimateMillisFromSchedule(sched)).toBeCloseTo(expected, 9);
    });

    it('returns 0 for an empty schedule', () => {
        expect(estimateMillisFromSchedule([])).toBe(0);
    });

    it('integrates a varying schedule as the sum of 1/v_i', () => {
        const sched = [100, 200, 400];
        const expected = 1000 * (1 / 100 + 1 / 200 + 1 / 400);
        expect(estimateMillisFromSchedule(sched)).toBeCloseTo(expected, 9);
    });

    it('throws on a non-positive speed entry', () => {
        expect(() => estimateMillisFromSchedule([100, 0, 100])).toThrow(
            RangeError,
        );
        expect(() => estimateMillisFromSchedule([100, -50])).toThrow(RangeError);
    });
});

describe('estimateMillisForSteps', () => {
    it('returns 1000 * steps / vAvg', () => {
        expect(estimateMillisForSteps(1000, 500)).toBeCloseTo(2000, 9);
        expect(estimateMillisForSteps(0, 500)).toBe(0);
    });

    it('throws on invalid arguments', () => {
        expect(() => estimateMillisForSteps(-1, 500)).toThrow(RangeError);
        expect(() => estimateMillisForSteps(100, 0)).toThrow(RangeError);
        expect(() => estimateMillisForSteps(100, -10)).toThrow(RangeError);
    });
});

/**
 * Assert that `sched` is non-decreasing up to some apex index `k` and
 * non-increasing thereafter. Equivalently: there exists no valley
 * `i < j < k` with `sched[i] > sched[j] < sched[k]`.
 */
function assertSingleHump(sched: number[]): void {
    let k = 0;
    while (k + 1 < sched.length && sched[k + 1]! >= sched[k]! - EPS) k++;
    for (let i = k + 1; i < sched.length; i++) {
        expect(sched[i]!).toBeLessThanOrEqual(sched[i - 1]! + EPS);
    }
}
