/**
 * Trapezoidal speed schedule (browser-side mirror of the firmware ramp).
 *
 * The browser uses this schedule for two purposes:
 *   1. Accurate preview-time estimation (Req 8.3, Property 26): integrating
 *      `1 / v` over the per-step schedule yields a much tighter estimate
 *      than `total_steps / vAvg` whenever segments are short enough that
 *      the trapezoid never reaches its plateau.
 *   2. Driving the animated preview's playback rate so it visibly speeds up
 *      and slows down at segment boundaries the same way the physical
 *      machine will.
 *
 * The shape is the classical unimodal trapezoid:
 *
 *     v_peak ────────                  ┐
 *               ╱            ╲         │   plateau when steps allow
 *              ╱              ╲        │
 *             ╱                ╲       │
 *      v_min ─                  ─      ┘   start and end clamped to v_min
 *
 * For segments too short to reach `v_peak`, the up- and down-ramps meet
 * before the plateau and the profile collapses to a triangle. The unified
 * formula
 *
 *     v[i] = min(peak, v_min + i * Δ, v_min + (steps - 1 - i) * Δ)
 *
 * handles both cases without branching: the up-ramp dominates near the
 * start, the down-ramp dominates near the end, and `peak` caps the middle
 * whenever the segment is long enough.
 *
 * `accelStepsPerSec2` is interpreted as the per-step velocity delta in
 * sps. This matches the firmware ramp generator (Task 6.3, Design §2.4.2),
 * which advances the speed by a fixed sps increment per emitted step
 * rather than integrating a continuous acceleration in sps²; that keeps
 * the deterministic-step ISR cheap and makes the per-step delta the
 * natural acceleration unit on both sides of the wire.
 *
 * NOTE (firmware cold-start tuning): the firmware ramp now starts each
 * segment's vMin BELOW the protocol floor FEED_SPS_MIN, at a gentle
 * pull-in speed (MOTION_START_SPS in firmware/src/types.h), so the stepper
 * eases in from its pull-in rate and does not stall on a cold start. This
 * browser mirror intentionally keeps its vMin floor at FEED_SPS_MIN: it is
 * only used for preview-time estimation and animation, where the handful
 * of sub-floor pull-in steps at the very start/end of a segment have
 * negligible impact on the total-time estimate. The two sides therefore do
 * NOT need to match on this firmware-internal start tweak.
 *
 * @see Requirements 5.5, 6.3, 8.3, 9.7, 9.8
 * @see Design §3.1.4 (path planner), §2.4.2 (firmware ramp)
 */

import {
    FEED_SPS_MIN,
    FEED_SPS_MAX,
    SPEED_PCT_MIN,
    SPEED_PCT_MAX,
} from '../constants';

/** Inputs to {@link buildSpeedSchedule}. */
export interface SpeedScheduleOptions {
    /** Number of motor steps in the segment; the returned array has this length. */
    steps: number;
    /**
     * Speed at the very first and very last step of the segment, in sps.
     * Must satisfy `FEED_SPS_MIN ≤ vMin ≤ vPeak`.
     */
    vMin: number;
    /**
     * Maximum speed the segment is allowed to reach before the
     * `speedPct` slider is applied. Must satisfy `vMin ≤ vPeak ≤ FEED_SPS_MAX`.
     */
    vPeak: number;
    /**
     * Per-step velocity increment in sps (i.e. `v[i+1] - v[i] ≤ accelStepsPerSec2`
     * during the up-ramp; symmetric on the down-ramp). Must be a positive,
     * finite number.
     */
    accelStepsPerSec2: number;
    /**
     * Live speed-percent scaling applied to `vPeak` (Req 9.7, 9.8). Defaults
     * to 100. Must be in `[SPEED_PCT_MIN, SPEED_PCT_MAX]` when supplied.
     */
    speedPct?: number;
}

/**
 * Build a per-step speed schedule for a single motion segment.
 *
 * @param opts See {@link SpeedScheduleOptions}.
 * @returns An array of length `opts.steps` giving the commanded sps at
 *          each motor step. The schedule:
 *            - has length `opts.steps`
 *            - starts and ends at `opts.vMin`
 *            - never exceeds the post-`speedPct` peak
 *            - is non-decreasing then non-increasing (single hump)
 *            - has consecutive deltas bounded by `opts.accelStepsPerSec2`
 *            - collapses to a triangular profile when the segment is too
 *              short to reach the plateau.
 *          Returns an empty array when `opts.steps == 0`.
 *
 * @throws  `RangeError` if any input is outside its documented range.
 */
export function buildSpeedSchedule(opts: SpeedScheduleOptions): number[] {
    const { steps, vMin, vPeak, accelStepsPerSec2 } = opts;
    const speedPct = opts.speedPct ?? 100;

    if (!Number.isInteger(steps) || steps < 0) {
        throw new RangeError(
            `buildSpeedSchedule: steps must be a non-negative integer, got ${steps}`,
        );
    }
    if (!Number.isFinite(vMin) || vMin < FEED_SPS_MIN) {
        throw new RangeError(
            `buildSpeedSchedule: vMin must be >= ${FEED_SPS_MIN}, got ${vMin}`,
        );
    }
    if (!Number.isFinite(vPeak) || vPeak > FEED_SPS_MAX) {
        throw new RangeError(
            `buildSpeedSchedule: vPeak must be <= ${FEED_SPS_MAX}, got ${vPeak}`,
        );
    }
    if (vMin > vPeak) {
        throw new RangeError(
            `buildSpeedSchedule: vMin (${vMin}) must not exceed vPeak (${vPeak})`,
        );
    }
    if (!Number.isFinite(accelStepsPerSec2) || accelStepsPerSec2 <= 0) {
        throw new RangeError(
            `buildSpeedSchedule: accelStepsPerSec2 must be a positive finite number, got ${accelStepsPerSec2}`,
        );
    }
    if (
        !Number.isFinite(speedPct) ||
        speedPct < SPEED_PCT_MIN ||
        speedPct > SPEED_PCT_MAX
    ) {
        throw new RangeError(
            `buildSpeedSchedule: speedPct must be in [${SPEED_PCT_MIN}, ${SPEED_PCT_MAX}], got ${speedPct}`,
        );
    }

    if (steps === 0) return [];

    // Apply the live speed-percent slider then clamp into [vMin, FEED_SPS_MAX].
    // Clamping up to vMin is intentional: at low speedPct the scaled peak
    // can fall below vMin, in which case the entire segment runs at vMin
    // (no plateau, schedule degenerates to a flat line).
    const scaledPeak = (vPeak * speedPct) / 100;
    const peak = Math.min(FEED_SPS_MAX, Math.max(vMin, scaledPeak));

    const delta = accelStepsPerSec2;
    const sched = new Array<number>(steps);
    const last = steps - 1;
    for (let i = 0; i < steps; i++) {
        const upRamp = vMin + i * delta;
        const downRamp = vMin + (last - i) * delta;
        // The `min` is what makes the unified formula work: up-ramp wins
        // near i=0, down-ramp wins near i=last, plateau wins in the middle
        // (when the segment is long enough), and when neither ramp reaches
        // the plateau the two ramps meet at the natural triangle apex.
        sched[i] = Math.min(peak, upRamp, downRamp);
    }
    return sched;
}

/**
 * Integrate a per-step speed schedule into a wall-clock duration in
 * milliseconds. Each step at speed `v_i` (in sps) takes `1 / v_i`
 * seconds, so the total time is `1000 * Σ (1 / v_i)` ms.
 *
 * @throws `RangeError` if the schedule contains a non-positive or
 *         non-finite speed, which would imply a divide-by-zero or
 *         garbage estimate.
 */
export function estimateMillisFromSchedule(sched: number[]): number {
    let totalSeconds = 0;
    for (let i = 0; i < sched.length; i++) {
        const v = sched[i]!;
        if (!Number.isFinite(v) || v <= 0) {
            throw new RangeError(
                `estimateMillisFromSchedule: schedule[${i}] must be a positive finite number, got ${v}`,
            );
        }
        totalSeconds += 1 / v;
    }
    return 1000 * totalSeconds;
}

/**
 * Fast approximation when the full schedule is not needed: assumes the
 * segment runs at a constant `vAvg` for `steps` steps. Used for headline
 * "estimated drawing time" displays where the cumulative ramp error is
 * small relative to total path length (Req 8.3, Property 26).
 *
 * @throws `RangeError` if `steps < 0`, `vAvg ≤ 0`, or either argument is
 *         non-finite.
 */
export function estimateMillisForSteps(steps: number, vAvg: number): number {
    if (!Number.isFinite(steps) || steps < 0) {
        throw new RangeError(
            `estimateMillisForSteps: steps must be a non-negative finite number, got ${steps}`,
        );
    }
    if (!Number.isFinite(vAvg) || vAvg <= 0) {
        throw new RangeError(
            `estimateMillisForSteps: vAvg must be a positive finite number, got ${vAvg}`,
        );
    }
    return (1000 * steps) / vAvg;
}
