# Bugfix Requirements Document

## Introduction

This bugfix addresses two related defects in the Etch-a-Sketch motion stack that block reliable drawing.

**Defect 1 — Drawing motion runaway.** When the user starts a drawing (a `BEGIN_DRAW` control followed by streamed `Drawing_Command` frames), the stepper motors spin far faster than commanded — "way too many rotations per minute," "insanely spinning," "full blast." This occurs even immediately after a successful envelope calibration that produced a sane envelope (X: 2158, Y: 1650 full steps). The JOG path now works correctly, so jogging is reliable while drawing motion is broken.

The diagnosed root cause is that the `MotionPlanner` drives drawing motion with the RA4M1 GPT hardware timer (`FspTimer`) whose period is **reprogrammed on every microstep**. `fetchNextTick_()` in `firmware/src/motion/motion_planner.cpp` calls `setTimerRateHz_(ramp_.speedAt(...))` for each full-step tick, and `setTimerRateHz_()` calls `s_step_timer.set_frequency(micro_hz)` where `micro_hz = hz * MICROSTEP_FACTOR (16)`. Reprogramming the GPT frequency from inside / around the overflow ISR on every microstep produces incorrect, runaway timing on this board, so the effective step rate is far higher than commanded. This is the same class of defect that previously made JOG knock once and stall. The proven-good reference (`99ba69_a7a1581cdb1d4997bae98a8bd442e2d8/code5_step_count/code5_step_count.ino`) drives the identical motor/driver reliably with a simple constant-rate pulse train and no per-step timer reprogramming.

**Defect 2 — No default envelope fallback.** The firmware blocks all drawing until an envelope is calibrated: `handleCmdFrame` and `BEGIN_DRAW` reply with `NackReason::EnvelopeRequired` when `NVM_FLAG_ENVELOPE_CALIBRATED` is not set, and the web App's `canDraw` gates on `envelopeCalibrated`. The user wants a baked-in **default envelope** of approximately X=2158, Y=1650 full steps (the measured value for their physical machine) so an uncalibrated machine can still draw using this default, while recalibration remains available and a captured envelope overrides the default.

This intentionally **reverses** the earlier visual-corner-calibration requirement of "no fallback / block until calibrated." That earlier rule existed to prevent dangerous unbounded gear-math scaling (`mm_per_rev`) from slamming the axes into their mechanical limits. The relaxation here is safe because the default is a **bounded, real measured step envelope** (not unbounded gear-math scaling), so motion stays inside the physical drawing area. This document explicitly records that reversal and its safety justification.

**Scope guardrails.** This fix changes only the timer-rate mechanism for drawing motion and adds the default-envelope fallback. It must NOT change: the working JOG handler, `MICROSTEP_FACTOR` (confirmed 16 via physical jumper), `FEED_SPS_MIN`/`FEED_SPS_MAX`, or the wire protocol / `Drawing_Command` format. Host-testability must be preserved: motion logic stays in Arduino-include-free units exercised by the host Catch2 suite, with `FspTimer`/`digitalWrite` behind `#if defined(ARDUINO)`. The existing pure logic (Bresenham generator, `TrapezoidRamp::speedAt`, ring buffer, backlash phase, counted-vs-uncounted full steps, pause/resume/cancel/stop, NVM position persistence) is preserved; only the timer-rate mechanism changes.

## Bug Analysis

### Current Behavior (Defect)

What currently happens when the bug is triggered.

**Drawing motion runaway:**

1.1 WHEN a drawing is executed (BEGIN_DRAW followed by streamed Drawing_Commands) THEN the system reprograms the GPT timer frequency on every microstep via `setTimerRateHz_()`, producing runaway step rates far higher than the commanded feed rate.

1.2 WHEN the trapezoidal ramp changes the commanded speed during a segment THEN the system calls `s_step_timer.set_frequency()` from within / around the overflow ISR, yielding incorrect effective timing rather than the intended `speedAt(...)` rate.

1.3 WHEN drawing motion runs immediately after a valid envelope calibration THEN the system still spins the motors at uncontrolled high speed despite a sane envelope (X: 2158, Y: 1650 full steps).

**Default envelope fallback (missing):**

1.4 WHEN the machine is not envelope-calibrated (`NVM_FLAG_ENVELOPE_CALIBRATED` clear) and a Drawing_Command frame is received THEN the system rejects it with `NackReason::EnvelopeRequired` and refuses to draw.

1.5 WHEN the machine is not envelope-calibrated and a BEGIN_DRAW control is received THEN the system NACKs with `EnvelopeRequired` and refuses to arm the draw.

1.6 WHEN the machine is not envelope-calibrated THEN the web App's `canDraw` gate stays false and blocks drawing in the UI.

### Expected Behavior (Correct)

What should happen instead.

**Drawing motion runaway:**

2.1 WHEN a drawing is executed (BEGIN_DRAW followed by streamed Drawing_Commands) THEN the system SHALL drive drawing motion from a periodic tick whose rate is set ONCE to a fixed high microstep frequency and is NEVER reprogrammed per step.

2.2 WHEN the trapezoidal ramp changes the commanded speed during a segment THEN the system SHALL realize that speed by software step division (emit a step every N ticks, where N derives from `TrapezoidRamp::speedAt`) rather than by changing the timer frequency.

2.3 WHEN a drawing is executed THEN the system SHALL move each axis at the commanded feed rate (bounded by FEED_SPS_MIN..FEED_SPS_MAX) such that the effective step rate matches the commanded rate within the motor's reliable operating range.

2.4 WHILE a drawing is executing THEN the system SHALL remain cooperative / non-blocking so that BLE polling, flow-control credits, pause/resume/stop, and connection-loss handling continue to run.

**Default envelope fallback:**

2.5 WHEN the machine is not envelope-calibrated and a Drawing_Command or BEGIN_DRAW is received THEN the system SHALL use a baked-in default envelope of approximately X=2158, Y=1650 full steps and SHALL allow drawing rather than returning `EnvelopeRequired`.

2.6 WHEN a valid captured envelope exists in NVM THEN the system SHALL use the captured envelope in preference to the default envelope.

2.7 WHEN the machine is uncalibrated and drawing with the default envelope THEN the system SHALL constrain motion to remain within the bounded default step envelope (not unbounded gear-math scaling), keeping the stylus inside the physical drawing area.

2.8 WHEN the machine is uncalibrated THEN the web App SHALL allow drawing using the default envelope while keeping recalibration available.

### Unchanged Behavior (Regression Prevention)

Existing behavior that must be preserved.

3.1 WHEN the user jogs an axis THEN the system SHALL CONTINUE TO use the working blocking constant-rate pulse train in the JOG handler (DIR, EN, `microPulses` loop at `JOG_PULSE_INTERVAL_US`, then `nudgePosition`) unchanged.

3.2 WHEN motion logic runs under the host Catch2 suite (`platform = native`) THEN the system SHALL CONTINUE TO compile and run Arduino-free, with `FspTimer`/`digitalWrite` behind `#if defined(ARDUINO)` and `onStepIsr` public for host tests.

3.3 WHEN a drawing executes THEN the system SHALL CONTINUE TO use the existing Bresenham generator, `TrapezoidRamp::speedAt` schedule, ring buffer, backlash compensation phase, counted-vs-uncounted full-step accounting, and pause/resume/cancel/stop handling.

3.4 WHEN a segment or drawing completes THEN the system SHALL CONTINUE TO persist the logical position to NVM as before.

3.5 WHEN the user performs a fresh envelope calibration (capture bottom-left then top-right) THEN the system SHALL CONTINUE TO record, persist, and apply the captured Step_Envelope, overriding the default.

3.6 WHEN drawing coordinates are converted to motor steps using a captured envelope THEN the system SHALL CONTINUE TO fit-to-envelope (aspect-preserving, centered/letterboxed) exactly as before.

3.7 WHEN `MICROSTEP_FACTOR`, `FEED_SPS_MIN`/`FEED_SPS_MAX`, and the wire protocol / `Drawing_Command` format are referenced THEN the system SHALL CONTINUE TO use their existing values and layout unchanged.

## Bug Condition Methodology

### Bug Condition

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type MotionRequest
  OUTPUT: boolean

  // Drawing motion (not jog) triggers the runaway timer-reprogramming path,
  // OR an uncalibrated machine is asked to draw and is wrongly blocked.
  RETURN (X.kind = DRAW)
      OR (X.kind = DRAW AND NOT X.envelopeCalibrated)
END FUNCTION
```

Concretely, two overlapping buggy input classes:
- **C1 (runaway):** `X.kind = DRAW` — any drawing motion exercises the per-microstep `setTimerRateHz_()` reprogramming.
- **C2 (blocked):** `X.kind = DRAW AND NOT X.envelopeCalibrated` — drawing is refused with `EnvelopeRequired`.

### Property (Fix Checking)

```pascal
// Property: Fix Checking - constant-rate tick, software step division
FOR ALL X WHERE X.kind = DRAW DO
  result <- runDraw'(X)
  ASSERT timerFrequencySetCount(result) = 1            // set once, never per step
  ASSERT effectiveStepRate(result) ~= commandedRate(X) // within reliable range
  ASSERT cooperative(result)                           // BLE/credits/pause/stop still serviced
END FOR

// Property: Fix Checking - default envelope fallback
FOR ALL X WHERE X.kind = DRAW AND NOT X.envelopeCalibrated DO
  result <- runDraw'(X)
  ASSERT NOT nacked(result, EnvelopeRequired)
  ASSERT envelopeUsed(result) = DEFAULT_ENVELOPE        // ~X=2158, Y=1650 full steps
  ASSERT withinEnvelope(motionOf(result), DEFAULT_ENVELOPE)
END FOR
```

### Preservation (Preservation Checking)

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT runMotion(X) = runMotion'(X)
END FOR
```

Where **F** is the original (unfixed) firmware and **F'** is the fixed firmware. Non-buggy inputs include all JOG requests and all draws on a machine with a valid captured envelope using behavior that does not depend on the timer-rate mechanism. The fix changes only the drawing timer-rate mechanism and the envelope gate; everything else (jog, Bresenham, ramp schedule, backlash, position persistence, captured-envelope fit) behaves identically.

### Hardware Testing Safety Note

Motion changes are physically risky. During hardware testing the motor PSU / kill switch MUST be within reach. The software/BLE STOP is NOT a substitute for the hardware kill. The host build runs via `pio` (env `host_test`); the known pre-existing unrelated failure `test_backlash_props` is out of scope and should be ignored.
