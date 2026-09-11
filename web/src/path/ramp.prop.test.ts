import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    buildSpeedSchedule,
    estimateMillisFromSchedule,
} from './ramp';
import {
    FEED_SPS_MIN,
    FEED_SPS_MAX,
    SPEED_PCT_MIN,
    SPEED_PCT_MAX,
} from '../constants';

/**
 * Property 5: Trapezoidal speed schedule monotonicity and bounds (web mirror).
 *
 * **Validates: Requirements 5.5, 6.3, 9.7, 9.8**
 *
 * Mirror of the firmware ramp property (Design §7, Property 5) for the
 * browser-side `buildSpeedSchedule`. For any segment of `steps ≥ 1` with a
 * configured peak `vPeak ∈ [vMin, FEED_SPS_MAX]`, minimum `vMin ≥
 * FEED_SPS_MIN`, positive per-step acceleration, and live speed-percent
 * scaling `speedPct ∈ [SPEED_PCT_MIN, SPEED_PCT_MAX]`, the emitted schedule
 * `v[0..steps-1]`:
 *
 *   1. has length `steps`;
 *   2. starts and ends at `vMin`;
 *   3. never drops below `vMin` (Req 5.5: ramps from a minimum speed);
 *   4. never exceeds the post-`speedPct` peak, nor `FEED_SPS_MAX`
 *      (Req 6.3: bounded maximum step rate);
 *   5. is non-decreasing then non-increasing — a single hump
 *      (Req 5.5: trapezoid / triangle profile);
 *   6. has consecutive deltas bounded by the configured acceleration
 *      step (Req 9.8: ramp continuity);
 *   7. produces a peak speed monotonic in `speedPct` (Req 9.7: the live
 *      slider scales the achievable maximum).
 *
 * A companion property checks that `estimateMillisFromSchedule` integrates
 * the schedule as `1000 * Σ(1 / v_i)`.
 *
 * Example-based coverage of the same module lives in `ramp.test.ts`; this
 * file focuses on the universal properties across the valid input space.
 */

// -----------------------------------------------------------------------------
// Tolerances
// -----------------------------------------------------------------------------

/** Absolute slack for bound / monotonicity checks: only absorbs IEEE drift
 *  in the per-step `Math.min` arithmetic; the algorithm itself is exact. */
const ABS_EPS = 1e-9;

/** Relative tolerance for the time-integration cross-check. */
const REL_EPS = 1e-6;

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/**
 * A fully valid `{steps, vMin, vPeak, accelStepsPerSec2, speedPct}` tuple.
 *
 * `vPeak` is generated *after* `vMin` so it is always `≥ vMin` (the
 * implementation rejects `vMin > vPeak`). `vMin` is capped at 600 so there
 * is room above it for a meaningful peak while staying inside the
 * `[FEED_SPS_MIN, FEED_SPS_MAX]` envelope.
 */
const arbScheduleOptions = fc
    .record({
        steps: fc.integer({ min: 1, max: 2000 }),
        vMin: fc.integer({ min: FEED_SPS_MIN, max: 600 }),
        accelStepsPerSec2: fc.integer({ min: 1, max: 300 }),
        speedPct: fc.integer({ min: SPEED_PCT_MIN, max: SPEED_PCT_MAX }),
    })
    .chain((base) =>
        fc
            .integer({ min: base.vMin, max: FEED_SPS_MAX })
            .map((vPeak) => ({ ...base, vPeak })),
    );

const NUM_RUNS = { numRuns: 500 } as const;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Post-speedPct peak used by the implementation (clamped up to vMin and
 *  down to FEED_SPS_MAX). */
function expectedPeak(
    vMin: number,
    vPeak: number,
    speedPct: number,
): number {
    return Math.min(FEED_SPS_MAX, Math.max(vMin, (vPeak * speedPct) / 100));
}

// -----------------------------------------------------------------------------
// Property 5
// -----------------------------------------------------------------------------

describe('Property 5: Trapezoidal speed schedule monotonicity and bounds (web mirror)', () => {
    it('1. LENGTH: schedule length equals the requested step count', () => {
        fc.assert(
            fc.property(arbScheduleOptions, (opts) => {
                const sched = buildSpeedSchedule(opts);
                expect(sched.length).toBe(opts.steps);
            }),
            NUM_RUNS,
        );
    });

    it('2. ENDPOINTS: first and last step both run at vMin', () => {
        fc.assert(
            fc.property(arbScheduleOptions, (opts) => {
                const sched = buildSpeedSchedule(opts);
                expect(sched[0]).toBe(opts.vMin);
                expect(sched[opts.steps - 1]).toBe(opts.vMin);
            }),
            NUM_RUNS,
        );
    });

    it('3. LOWER BOUND: no step ever drops below vMin (Req 5.5)', () => {
        fc.assert(
            fc.property(arbScheduleOptions, (opts) => {
                const sched = buildSpeedSchedule(opts);
                for (const v of sched) {
                    expect(v).toBeGreaterThanOrEqual(opts.vMin - ABS_EPS);
                }
            }),
            NUM_RUNS,
        );
    });

    it('4. UPPER BOUND: no step exceeds the post-speedPct peak or FEED_SPS_MAX (Req 6.3)', () => {
        fc.assert(
            fc.property(arbScheduleOptions, (opts) => {
                const sched = buildSpeedSchedule(opts);
                const peak = expectedPeak(opts.vMin, opts.vPeak, opts.speedPct);
                for (const v of sched) {
                    expect(v).toBeLessThanOrEqual(peak + ABS_EPS);
                    expect(v).toBeLessThanOrEqual(FEED_SPS_MAX + ABS_EPS);
                }
            }),
            NUM_RUNS,
        );
    });

    it('5. SINGLE HUMP: non-decreasing up to an apex then non-increasing (Req 5.5)', () => {
        fc.assert(
            fc.property(arbScheduleOptions, (opts) => {
                const sched = buildSpeedSchedule(opts);
                // Scan the leading non-decreasing run (with float slack) to
                // find the apex, then assert the remainder is non-increasing.
                let k = 0;
                while (
                    k + 1 < sched.length &&
                    sched[k + 1]! >= sched[k]! - ABS_EPS
                ) {
                    k++;
                }
                for (let i = k + 1; i < sched.length; i++) {
                    expect(sched[i]!).toBeLessThanOrEqual(sched[i - 1]! + ABS_EPS);
                }
            }),
            NUM_RUNS,
        );
    });

    it('6. ACCEL BOUND: consecutive speeds differ by at most accelStepsPerSec2 (Req 9.8)', () => {
        fc.assert(
            fc.property(arbScheduleOptions, (opts) => {
                const sched = buildSpeedSchedule(opts);
                for (let i = 1; i < sched.length; i++) {
                    expect(Math.abs(sched[i]! - sched[i - 1]!)).toBeLessThanOrEqual(
                        opts.accelStepsPerSec2 + ABS_EPS,
                    );
                }
            }),
            NUM_RUNS,
        );
    });

    it('7. SPEEDPCT MONOTONIC: a higher speedPct never lowers the achievable peak (Req 9.7)', () => {
        const arbTwoPct = fc.record({
            steps: fc.integer({ min: 1, max: 2000 }),
            vMin: fc.integer({ min: FEED_SPS_MIN, max: 600 }),
            accelStepsPerSec2: fc.integer({ min: 1, max: 300 }),
            p1: fc.integer({ min: SPEED_PCT_MIN, max: SPEED_PCT_MAX }),
            p2: fc.integer({ min: SPEED_PCT_MIN, max: SPEED_PCT_MAX }),
        }).chain((base) =>
            fc
                .integer({ min: base.vMin, max: FEED_SPS_MAX })
                .map((vPeak) => ({ ...base, vPeak })),
        );

        fc.assert(
            fc.property(arbTwoPct, (g) => {
                const lo = Math.min(g.p1, g.p2);
                const hi = Math.max(g.p1, g.p2);
                const common = {
                    steps: g.steps,
                    vMin: g.vMin,
                    vPeak: g.vPeak,
                    accelStepsPerSec2: g.accelStepsPerSec2,
                };
                const maxLo = Math.max(
                    ...buildSpeedSchedule({ ...common, speedPct: lo }),
                );
                const maxHi = Math.max(
                    ...buildSpeedSchedule({ ...common, speedPct: hi }),
                );
                expect(maxLo).toBeLessThanOrEqual(maxHi + ABS_EPS);
            }),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Companion property: schedule time integration
// -----------------------------------------------------------------------------

describe('estimateMillisFromSchedule (properties)', () => {
    it('equals 1000 * Σ(1 / v_i) and is strictly positive for steps ≥ 1', () => {
        fc.assert(
            fc.property(arbScheduleOptions, (opts) => {
                const sched = buildSpeedSchedule(opts);
                const actual = estimateMillisFromSchedule(sched);

                // Reference integral computed independently of the
                // implementation's accumulation order.
                let seconds = 0;
                for (const v of sched) seconds += 1 / v;
                const expected = 1000 * seconds;

                // Every speed is >= FEED_SPS_MIN > 0, so the estimate is
                // strictly positive whenever there is at least one step.
                expect(actual).toBeGreaterThan(0);

                const tolerance = REL_EPS * Math.abs(expected) + ABS_EPS;
                expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
                    tolerance,
                );
            }),
            NUM_RUNS,
        );
    });
});
