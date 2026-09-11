/**
 * Shared physical, mechanical, and protocol constants for the
 * Etch-a-Sketch SPA.
 *
 * Everything here is canonical and must match the firmware's compile-time
 * constants in `firmware/src/types.h`. All step↔mm and protocol math in
 * the browser derives from this file so that there is exactly one place
 * to tune calibration and buffer sizing.
 *
 * @see Design §2.2 (gear math), §4.1–4.3 (data models), §4.5 (frames)
 * @see Requirements 5.2, 5.3, 6.3
 */

// -----------------------------------------------------------------------------
// Drawable area
// -----------------------------------------------------------------------------

/**
 * Physical drawable area of the Etch-a-Sketch in millimetres.
 * Home is the bottom-left corner; +X is right, +Y is up.
 *
 * @see Requirements 5.2, 10.1
 */
export const DRAWABLE_MM = Object.freeze({ w: 152, h: 105 });

// -----------------------------------------------------------------------------
// Gear math (canonical step ↔ revolution constants)
//
// Every step↔mm conversion in the system derives from these. Per Design §2.2,
// motors are NEMA 17 (1.8°/step → 200 steps/rev) driven through 1/16
// microstepping by A4988s, with an 18:36 pinion-on-knob reduction (motor turns
// twice per knob turn).
// -----------------------------------------------------------------------------

/** Native motor steps per revolution (1.8°/step NEMA 17). */
export const MOTOR_STEPS_PER_REV = 200;

/** A4988 microstepping factor with all three MS jumpers populated. */
export const MICROSTEP_FACTOR = 16;

/** Motor turns 36/18 = 2 times per knob revolution. */
export const GEAR_RATIO_MOTOR_TO_KNOB = 2;

/** Full motor steps per knob revolution: 200 × 2 = 400. */
export const FULL_STEPS_PER_KNOB_REV =
    MOTOR_STEPS_PER_REV * GEAR_RATIO_MOTOR_TO_KNOB;

/** Microsteps per knob revolution: 400 × 16 = 6400. */
export const MICROSTEPS_PER_KNOB_REV =
    FULL_STEPS_PER_KNOB_REV * MICROSTEP_FACTOR;

/**
 * Default mm-per-knob-revolution for the X axis. Measured by jog calibration
 * on the assembled machine: 1000 motor steps moved the stylus 8.5 mm, so
 * mm_per_rev = 8.5 × 400 / 1000 = 3.4. (The 100.0 design default was a
 * pre-build placeholder and made drawings come out ~29× too small.)
 */
export const DEFAULT_MM_PER_REV_X = 3.4;

/** Default mm-per-knob-revolution for the Y axis (same gearing as X). */
export const DEFAULT_MM_PER_REV_Y = 3.4;

/**
 * Steps-per-millimetre derived from a calibrated mm/rev value.
 * Integer step quantisation happens at the planner layer; this returns a float.
 *
 * @see Requirements 5.3
 */
export function stepsPerMm(mmPerRev: number): number {
    return FULL_STEPS_PER_KNOB_REV / mmPerRev;
}

// -----------------------------------------------------------------------------
// Speed limits
// -----------------------------------------------------------------------------

/**
 * Minimum step rate at the start and end of every trapezoidal ramp.
 *
 * @see Requirements 5.5, 6.3
 */
export const FEED_SPS_MIN = 100;

/**
 * Maximum step rate to prevent stalling at the 18:36 gear ratio load.
 *
 * @see Requirements 6.3
 */
export const FEED_SPS_MAX = 1000;

/**
 * User-facing speed-percent slider bounds, applied as a multiplier on the
 * configured peak rate.
 *
 * @see Requirements 9.7
 */
export const SPEED_PCT_MIN = 25;
export const SPEED_PCT_MAX = 100;

// -----------------------------------------------------------------------------
// Backlash (mirrors firmware-side bounds for the per-axis backlash value)
// -----------------------------------------------------------------------------

/**
 * Inclusive bounds for the per-axis backlash value, in full motor steps.
 * Mirrors the firmware command-parser range check on `SET_BACKLASH`
 * (see Design §3.2.6, Req 13.8).
 */
export const BACKLASH_STEPS_MIN = 0;
export const BACKLASH_STEPS_MAX = 200;

// -----------------------------------------------------------------------------
// Drawing_Command wire format (§4.3)
// -----------------------------------------------------------------------------

/** Fixed payload size of a Drawing_Command on the wire, in bytes. */
export const DRAWING_COMMAND_BYTES = 16;

/** Inclusive bound for the i16 dx/dy step deltas. */
export const DRAWING_COMMAND_DELTA_MAX = 32767;
export const DRAWING_COMMAND_DELTA_MIN = -32768;

/**
 * Bit positions of the documented flags in the `flags` field.
 * All other bits MUST be zero (validated by the firmware command parser).
 */
export const DRAWING_COMMAND_FLAGS = Object.freeze({
    /** bit0: this segment is a connector (visible but non-content motion). */
    CONNECTOR: 1 << 0,
    /** bit1: this is the final command of the current batch. */
    LAST_OF_BATCH: 1 << 1,
});

/** Mask of all defined flag bits; `flags & ~MASK` MUST be 0. */
export const DRAWING_COMMAND_FLAGS_MASK =
    DRAWING_COMMAND_FLAGS.CONNECTOR | DRAWING_COMMAND_FLAGS.LAST_OF_BATCH;

// -----------------------------------------------------------------------------
// Buffer / flow control (mirrors firmware constants)
// -----------------------------------------------------------------------------

/** Controller's command ring buffer depth (Req 6.4). */
export const COMMAND_BUFFER_DEPTH = 32;

/** Maximum retransmission attempts per Drawing_Command before giving up (Req 7.3). */
export const MAX_RETRANSMISSIONS = 3;

/** Reconnect window during a drawing before the controller aborts (Req 7.5, 7.6). */
export const RECONNECT_WINDOW_MS = 60_000;
