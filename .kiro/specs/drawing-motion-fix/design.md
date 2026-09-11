# Drawing Motion Fix Bugfix Design

## Overview

This bugfix repairs two defects that block reliable drawing on the Etch-a-Sketch machine, without touching the now-working JOG path, the wire protocol, or the pure motion logic (Bresenham, ramp, ring buffer, backlash, position persistence).

**Defect 1 — drawing motion runaway.** `MotionPlanner` drives drawing motion from the RA4M1 GPT hardware timer (`FspTimer`) whose period is *reprogrammed on every microstep*: `fetchNextTick_()` calls `setTimerRateHz_(...)` for each tick and `setTimerRateHz_()` calls `s_step_timer.set_frequency()`. Reprogramming the GPT from in/around the overflow ISR on this board yields runaway timing — the motors spin far faster than commanded. The fix replaces per-step timer reprogramming with a **constant-rate timer tick + software step division**: the GPT is configured *once* at a fixed high microstep tick frequency and never reprogrammed; `onStepIsr()` runs an integer (Bresenham/DDS-style) rate divider that emits one microstep every N ticks, where N derives from `TrapezoidRamp::speedAt()`. This mirrors the proven-good reference sketch (`99ba69_.../code5_step_count/code5_step_count.ino`) and the JOG fix, both of which drive the identical motor reliably with a constant-rate pulse train.

**Defect 2 — no default envelope fallback.** The firmware blocks all drawing with `NackReason::EnvelopeRequired` until an envelope is calibrated, and the web `canDraw` gates on `envelopeCalibrated`. The fix adds a baked-in compile-time `DEFAULT_ENVELOPE` (X=2158, Y=1650 full steps) and an **effective-envelope resolver**: use the captured envelope when calibrated and valid, otherwise the default. The hard `EnvelopeRequired` gate is removed so an uncalibrated machine draws with the bounded default. This intentionally reverses the prior "no fallback" rule; it is safe because the default is a *bounded measured step envelope*, not unbounded gear-math scaling, so motion stays inside the physical drawing area.

The fix changes only the drawing timer-rate mechanism and the envelope gate. Everything else behaves identically.

## Glossary

- **Bug_Condition (C)**: The condition that triggers a bug. **C1 (runaway):** `X.kind = DRAW` — any drawing exercises the per-microstep `setTimerRateHz_()` reprogramming. **C2 (blocked):** `X.kind = DRAW AND NOT X.envelopeCalibrated` — drawing is wrongly refused with `EnvelopeRequired`.
- **Property (P)**: The desired behavior. For C1: timer rate set once, effective step rate matches the commanded feed, motion stays cooperative. For C2: draw is allowed using the default envelope instead of being NACKed.
- **Preservation**: All non-buggy inputs (jog, captured-envelope draws, ramp/Bresenham/backlash/position logic, protocol) must behave exactly as before.
- **F / F'**: Original (unfixed) firmware / fixed firmware.
- **STEP_TICK_HZ**: New constant — the fixed microstep tick frequency the GPT is programmed to ONCE.
- **Rate divider (DDS accumulator)**: Integer phase accumulator in `onStepIsr()` that decides on which ticks a microstep is emitted, realizing the commanded microstep rate in software without timer reprogramming.
- **`setTimerRateHz_()`**: The per-step GPT reprogramming method (`set_frequency`) — the root cause; removed from the per-step path by this fix.
- **`onStepIsr()`**: The GPT ISR body; public and Arduino-free so host tests drive it deterministically.
- **`TrapezoidRamp::speedAt(i)`**: O(1) integer commanded full-step rate (sps) at counted step index `i`. Unchanged.
- **DEFAULT_ENVELOPE**: New compile-time constant (X=2158, Y=1650 full steps) used when uncalibrated.
- **Effective envelope**: `captured envelope if (NVM_FLAG_ENVELOPE_CALIBRATED set AND stored envelope valid) else DEFAULT_ENVELOPE`.
- **MICROSTEP_FACTOR**: 16 microsteps per counted full step (unchanged, hardware-matched).

## Bug Details

### Bug Condition

The bug manifests in two overlapping input classes. **C1**: any drawing motion drives the GPT timer whose period is reprogrammed every microstep via `setTimerRateHz_() -> set_frequency()`, producing runaway step rates. **C2**: an uncalibrated machine asked to draw is rejected with `EnvelopeRequired` and refuses to draw.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type MotionRequest
  OUTPUT: boolean

  // C1: drawing exercises the per-microstep timer-reprogramming path.
  // C2: drawing on an uncalibrated machine is wrongly blocked.
  RETURN (X.kind = DRAW)
      OR (X.kind = DRAW AND NOT X.envelopeCalibrated)
END FUNCTION
```

(Note: C2 is a subset of C1; together they reduce to `X.kind = DRAW`, which is why jog inputs are entirely outside the bug condition and are preserved verbatim.)

### Examples

- **Runaway after good calibration**: User calibrates a sane envelope (X=2158, Y=1650), starts a drawing. Expected: axes move at the commanded feed (100..1000 sps). Actual: motors spin "full blast" because the GPT is reprogrammed every microstep.
- **Mid-segment ramp**: The trapezoid raises commanded speed during a segment. Expected: a smooth software-divided rate change. Actual: `set_frequency()` called from around the overflow ISR yields incorrect effective timing.
- **Uncalibrated draw blocked**: Fresh machine (`NVM_FLAG_ENVELOPE_CALIBRATED` clear) receives a `Drawing_Command`. Expected: draw using DEFAULT_ENVELOPE. Actual: `NackReason::EnvelopeRequired`, drawing refused.
- **Edge — slowest pull-in speed**: At cold start the ramp commands `MOTION_START_SPS` (32 full-sps = 512 microstep Hz). The software divider must represent this cleanly at the fixed tick rate (it does: STEP_TICK_HZ/512 = 62.5 ticks per microstep average, exact under DDS accumulation).

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- The blocking constant-rate JOG handler in `etchasketch.ino` (DIR, EN, `microPulses` loop at `JOG_PULSE_INTERVAL_US`, then `nudgePosition`) must remain byte-for-byte unchanged.
- The pure motion logic: `BresenhamLine`, `TrapezoidRamp::speedAt` schedule, the 32-deep ring buffer, the backlash compensation phase, counted-vs-uncounted full-step accounting, and pause/resume/cancel/stop semantics.
- NVM position persistence: one staged write per completed segment, debounced.
- Captured envelope behavior: a fresh calibration still records, persists, and applies the captured `Step_Envelope`, overriding the default; the captured-envelope coordinate→step fit (`fitPolylinesToEnvelope`, aspect-preserving/letterboxed) is unchanged.
- `MICROSTEP_FACTOR` (16), `FEED_SPS_MIN` (100)/`FEED_SPS_MAX` (1000), and the wire protocol / `Drawing_Command` 16-byte format and layout.
- Host-testability: motion logic stays Arduino-free; `FspTimer`/`digitalWrite` behind `#if defined(ARDUINO)`; `onStepIsr()` public.

**Scope:**
All inputs that do NOT satisfy the bug condition must be completely unaffected. This includes:
- All JOG requests (single and multi-step) on either axis.
- All draws on a machine with a valid captured envelope, for everything that does not depend on the timer-rate mechanism (Bresenham step sequence, counted full steps, final position, ramp schedule, backlash steps).
- Calibration capture (CAPTURE_BOTTOM_LEFT / CAPTURE_TOP_RIGHT), SET_HOME/RE_HOME, SPEED_PCT, SET_BACKLASH, and all protocol framing.

The actual expected correct behavior for buggy inputs is defined in the Correctness Properties section (Property 1, Property 3).

## Hypothesized Root Cause

Based on the bug description and the code in `motion_planner.cpp`, the most likely issues are:

1. **Per-microstep GPT reprogramming (primary, high confidence)**: `fetchNextTick_()` calls `setTimerRateHz_(ramp_.speedAt(...))` on every full-step tick, and `setTimerRateHz_()` calls `s_step_timer.set_frequency(hz * MICROSTEP_FACTOR)`. Reprogramming the RA4M1 GPT period from in/around the overflow ISR is unreliable: the new period may be latched mid-count or take effect on a truncated cycle, so the effective rate runs far higher than commanded. This is the same class of defect that made JOG knock-once-and-stall before JOG was switched to a constant-rate pulse train.

2. **ISR re-entrancy / latch timing**: Calling `set_frequency()` while the overflow IRQ is the calling context can corrupt the compare/period registers, compounding (1).

3. **Hard envelope gate (Defect 2)**: `handleCmdFrame` and `BEGIN_DRAW` NACK `EnvelopeRequired` whenever `NVM_FLAG_ENVELOPE_CALIBRATED` is clear; the web `canDraw` mirrors this. There is no default fallback.

The proven-good reference sketch drives the identical motor with a fixed-period constant-rate pulse train and never reprograms a timer per step, strongly supporting (1) as the root cause. If host tests of the new divider pass but hardware still runs away, the hypothesis is refuted and we would re-investigate GPT channel/IRQ configuration.

## Correctness Properties

Property 1: Bug Condition (C1) — Constant-Rate Tick, Software Step Division

_For any_ input where `X.kind = DRAW` (isBugCondition C1 holds), the fixed planner SHALL program the step-timer rate exactly once (at `begin()`, to `STEP_TICK_HZ`) and never reprogram it per step, and SHALL realize the commanded feed rate by software step division such that the effective microstep rate over a segment matches `speedAt(i) * MICROSTEP_FACTOR` within one tick period of jitter, while keeping `onStepIsr()` short and allocation-free so the cooperative loop continues to service BLE / credits / pause / resume / stop.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Bug Condition (C2) — Default Envelope Fallback

_For any_ input where `X.kind = DRAW AND NOT X.envelopeCalibrated` (isBugCondition C2 holds), the fixed firmware SHALL NOT return `NackReason::EnvelopeRequired`, SHALL resolve the effective envelope to `DEFAULT_ENVELOPE` (X=2158, Y=1650 full steps), SHALL allow the draw, and SHALL constrain motion to remain within that bounded default envelope. A valid captured envelope, when present, SHALL override the default.

**Validates: Requirements 2.5, 2.6, 2.7, 2.8**

Property 3: Preservation — Non-Buggy Inputs Behave Identically

_For any_ input where the bug condition does NOT hold (all JOG requests, and all draws on a machine with a valid captured envelope for the parts independent of the timer-rate mechanism), the fixed firmware SHALL produce the same result as the original firmware: identical jog pulse train, identical emitted microstep sequence and counted full-step accounting, identical final logical position and NVM persistence, identical ramp/Bresenham/backlash behavior, identical pause/resume/cancel/stop semantics, and an unchanged `MICROSTEP_FACTOR` / `FEED_SPS_*` / wire-protocol contract.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

## Fix Implementation

### Defect 1 — Constant-rate tick + software step division

**Files**: `firmware/src/motion/motion_planner.h`, `firmware/src/motion/motion_planner.cpp`, `firmware/src/types.h`

**New constant (`types.h`, near the step-rate envelope):**
```cpp
// Fixed microstep tick frequency for the drawing step timer. The GPT is
// programmed to this rate ONCE in configureTimer_() and NEVER reprogrammed per
// step (the prior per-step set_frequency() was the runaway root cause). The
// commanded feed is realized in software by a Bresenham/DDS rate divider in
// onStepIsr().
//
// Sizing: the maximum commanded microstep rate is
//   FEED_SPS_MAX * MICROSTEP_FACTOR = 1000 * 16 = 16000 Hz.
// A small integer multiple (2x) gives headroom for the divider to represent
// fast speeds with low quantization error while leaving the ISR ample time:
//   STEP_TICK_HZ = 32000  ->  period = 31.25 us per tick.
// Slowest representable speeds remain clean under DDS accumulation:
//   RAMP_MIN_SPS=10  -> 160 microstep Hz  -> rollover every 200 ticks (exact)
//   MOTION_START_SPS=32 -> 512 microstep Hz -> 62.5 ticks/microstep (exact avg)
// 2x the max microstep rate also satisfies Nyquist for the fastest emission
// (one microstep every 2 ticks at FEED_SPS_MAX), so even peak feed is divisible.
inline constexpr std::uint32_t STEP_TICK_HZ = 32000;

static_assert(STEP_TICK_HZ >= static_cast<std::uint32_t>(FEED_SPS_MAX) * MICROSTEP_FACTOR,
              "tick rate must be >= the maximum commanded microstep rate");
```

**New ISR-divider state (`motion_planner.h`, ISR-advanced section):**
```cpp
// Software step divider (DDS phase accumulator). On each fixed-rate tick we add
// the current commanded microstep rate to acc_; when acc_ >= STEP_TICK_HZ we
// subtract STEP_TICK_HZ and emit one microstep. This realizes an average
// microstep rate of cur_micro_hz_ with no per-step timer reprogramming and no
// per-tick division (cur_micro_hz_ is recomputed only at full-step boundaries).
volatile std::uint32_t acc_ = 0;            // phase accumulator
volatile std::uint32_t cur_micro_hz_ = 0;   // commanded microstep rate for the active full step
```

**`onStepIsr()` rewrite (integer-only, allocation-free):**
```
onStepIsr():
  if paused_ or not program_active_: return
  acc_ += cur_micro_hz_
  if acc_ < STEP_TICK_HZ: return        // no microstep this tick (slow speed)
  acc_ -= STEP_TICK_HZ                  // emit exactly one microstep this tick
  // --- emit one microstep on each axis that steps on the current Bresenham tick
  if cur_.stepX: sink_.stepX(); ++microsteps_emitted_
  if cur_.stepY: sink_.stepY(); ++microsteps_emitted_
  --micro_remaining_
  if micro_remaining_ > 0: return       // more microsteps remain in this full step
  // full step complete: count it (Main phase only), then advance the tick
  if phase_ == Main:
     if cur_.stepX: x_steps_ += cur_.dirX
     if cur_.stepY: y_steps_ += cur_.dirY
  if not fetchNextTick_():
     program_active_ = false; program_complete_ = true; stopTimer_()
```

Notes:
- The microstep emission, `micro_remaining_` countdown (MICROSTEP_FACTOR per counted full step), counted-vs-uncounted accounting, and program completion are **identical** to today; only the gating (DDS accumulator decides *which* ticks emit) and the removal of `setTimerRateHz_` change.
- At FEED_SPS_MAX the accumulator emits on every 2nd tick; at RAMP_MIN_SPS roughly every 200th tick. Empty ticks are a single add + compare (cheapest possible ISR path).

**`fetchNextTick_()` change:** remove all `setTimerRateHz_(...)` calls; instead set `cur_micro_hz_` from the ramp/pull-in speed at each full-step boundary:
```
backlash phase tick:  cur_micro_hz_ = MOTION_START_SPS * MICROSTEP_FACTOR
main phase tick:      cur_micro_hz_ = ramp_.speedAt(main_step_index_) * MICROSTEP_FACTOR
                      ++main_step_index_
```
Acceleration still works purely through the divider reading `speedAt(i)` at full-step boundaries; the ramp schedule itself is untouched. `cur_micro_hz_` is recomputed once per full step (every MICROSTEP_FACTOR microsteps), so there is no per-microstep division.

**`begin()` / `configureTimer_()` change:** program the GPT once to `STEP_TICK_HZ` (periodic) and never call `set_frequency()` again. Reset `acc_ = 0`, `cur_micro_hz_ = 0` in `begin()` and in `abortProgram_()`. Reset `acc_` to 0 at each `beginSegment_()` so a new segment starts on a clean phase.

**Remove / retire `setTimerRateHz_()`:** delete the per-step method (both ARDUINO and host no-op) from the header and `.cpp`. The host timer seams (`configureTimer_`/`startTimer_`/`stopTimer_`) remain deterministic no-ops.

**Pause/resume/cancel/stop:** unchanged — they still gate `paused_` / disarm via `stopTimer_()` and retain segment state. `resume()` re-arms the (already-correctly-programmed) timer; no rate is reprogrammed.

### Defect 2 — Default envelope fallback

**File**: `firmware/src/types.h` (constant, near the envelope fields)
```cpp
// Baked-in default Step_Envelope (full motor steps) used when the machine is
// not envelope-calibrated. This is the measured envelope of the reference
// physical machine. Safe as a fallback because it is a BOUNDED measured step
// envelope (not unbounded gear-math scaling), so motion stays inside the
// physical drawing area even uncalibrated.
inline constexpr std::uint32_t DEFAULT_ENVELOPE_X_STEPS = 2158;
inline constexpr std::uint32_t DEFAULT_ENVELOPE_Y_STEPS = 1650;
```

**Effective-envelope resolver** (small helper, placed where the envelope is read — e.g. an `effectiveEnvelope()` free function in `etchasketch.ino` / the app layer):
```
effectiveEnvelope(cfg) -> {x, y}:
  if (cfg.flags & NVM_FLAG_ENVELOPE_CALIBRATED) and isValidEnvelope(cfg.envelope_x_steps, cfg.envelope_y_steps):
     return { cfg.envelope_x_steps, cfg.envelope_y_steps }   // captured overrides default (Req 2.6/3.5)
  return { DEFAULT_ENVELOPE_X_STEPS, DEFAULT_ENVELOPE_Y_STEPS }  // bounded fallback (Req 2.5)
```

**Gate relaxation (`etchasketch.ino`):**
- `handleCmdFrame`: remove the `if (!isEnvelopeCalibrated()) sendNack(..., EnvelopeRequired)` block. Drawing commands proceed using the effective envelope. (The jog travel cap and per-command parse/CRC/range NACKs are unchanged.)
- `BEGIN_DRAW`: remove the `if (!isEnvelopeCalibrated()) sendNack(0, EnvelopeRequired)` block; arm the draw unconditionally (subject to existing non-envelope checks).
- Keep `isEnvelopeCalibrated()` for status/HELLO reporting and recalibration flow; it no longer gates drawing.

**HELLO is authoritative for the envelope (chosen approach):** the firmware fills `HelloFields.envelope_x_steps/envelope_y_steps` with the **effective** envelope (captured when calibrated, else `DEFAULT_ENVELOPE`), while `envelope_calibrated` continues to report only whether a *captured* envelope exists. Rationale: a single source of truth avoids the web and firmware diverging if the default is ever retuned; the web already decodes `envelope_x/y_steps` and `envelope_calibrated` from HELLO, so no wire-format change is needed (`HELLO_PAYLOAD_SIZE` stays 40; the `Drawing_Command` format is untouched). The web mirroring its own DEFAULT constant is explicitly rejected to prevent divergence.

**Web side (`web/src/app/controller.ts`, `web/src/ui/App.tsx`, `web/src/net/wire_client.ts`):**
- Fold the HELLO/STATUS envelope into `stores.envelope` even when `envelopeCalibrated === false` (it now carries the effective/default envelope), while keeping `stores.envelopeCalibrated` tracking only captured calibration so the recalibration wizard stays available (Req 2.8).
- `rebuildPlan()` uses `stores.envelope` (effective) for the envelope-fit branch whenever an envelope is present, regardless of `envelopeCalibrated`.
- `App.canDraw`: change `hasPath && envelopeCalibrated && !drawingActive` to gate on an effective envelope being present (`hasPath && !!stores.envelope.value && !drawingActive`) so drawing is allowed with the default; recalibration remains reachable.
- `wire_client` send-gate: allow `sendCommand` / `BEGIN_DRAW` when an effective envelope is known (the firmware no longer NACKs `EnvelopeRequired`); the envelope-family NACK→fault mirror stays for genuine invalid-envelope cases.
- `controller.draw()`: drop the `if (!envelopeCalibrated) error` early-return; gate on a planned path + effective envelope instead.

**Within-envelope guarantee (Req 2.7):** the web `fitPolylinesToEnvelope` already bounds generated step deltas to the supplied envelope; supplying the effective (default) envelope keeps the fitted path — and therefore the streamed `Drawing_Command` deltas — inside `DEFAULT_ENVELOPE`.

## Testing Strategy

### Validation Approach

Two phases: first surface counterexamples that demonstrate each defect on unfixed code, then verify the fix works and preserves existing behavior. Host tests run via `pio` (env `host_test`); the known pre-existing unrelated failure `test_backlash_props` is out of scope and ignored.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE the fix; confirm or refute the root-cause analysis.

**Test Plan**: For Defect 1, drive `onStepIsr()` deterministically on the host and observe the current emission model. Because the host timer seam is a no-op, the *unfixed* host code emits one microstep per `onStepIsr()` call regardless of `speedAt()` (the rate lived only in the discarded `set_frequency` call), so there is no software notion of "ticks between steps" — demonstrating that all speed control depended on per-step timer reprogramming (the runaway path on hardware). For Defect 2, exercise `handleCmdFrame`/`BEGIN_DRAW` with an uncalibrated config and observe the `EnvelopeRequired` NACK.

**Test Cases**:
1. **Runaway model (Defect 1)**: On unfixed code, assert that emitted microsteps over K `onStepIsr()` calls is independent of the commanded `speedAt()` value (no software division exists) — the rate is entirely delegated to the per-step timer reprogram. (Will differ from the fixed divider behavior.)
2. **Mid-segment ramp (Defect 1)**: Confirm `fetchNextTick_()` calls `setTimerRateHz_()` per step on unfixed code (root-cause confirmation by inspection/instrumentation).
3. **Uncalibrated CMD blocked (Defect 2)**: Uncalibrated config + valid `Drawing_Command` ⇒ unfixed code returns `EnvelopeRequired` (will fail/refuse).
4. **Uncalibrated BEGIN_DRAW blocked (Defect 2)**: Uncalibrated config + `BEGIN_DRAW` ⇒ unfixed code NACKs `EnvelopeRequired`.

**Expected Counterexamples**:
- Drawing speed is not realized in software (all rate control is per-step timer reprogramming — the runaway path on hardware).
- Uncalibrated draws are refused with `EnvelopeRequired`.

### Fix Checking

**Goal**: For all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
// C1 — constant-rate tick + software division
FOR ALL X WHERE X.kind = DRAW DO
  result := runDraw'(X)
  ASSERT timerFrequencySetCount(result) = 1            // programmed once, never per step
  ASSERT effectiveStepRate(result) ~= commandedRate(X) // within one tick period
  ASSERT cooperative(result)                           // ISR short/allocation-free; loop services BLE/credits/pause/stop
END FOR

// C2 — default envelope fallback
FOR ALL X WHERE X.kind = DRAW AND NOT X.envelopeCalibrated DO
  result := runDraw'(X)
  ASSERT NOT nacked(result, EnvelopeRequired)
  ASSERT envelopeUsed(result) = DEFAULT_ENVELOPE        // X=2158, Y=1650
  ASSERT withinEnvelope(motionOf(result), DEFAULT_ENVELOPE)
END FOR
```

### Preservation Checking

**Goal**: For all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT runMotion(X) = runMotion'(X)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation because it generates many inputs across the domain, catches edge cases manual tests miss, and gives strong guarantees that non-buggy behavior is unchanged. Capture pre-fix behavior (emitted microstep sequence, counted full steps, final position) and assert the fixed code reproduces it.

**Test Cases**:
1. **Jog preservation**: The blocking JOG handler is untouched; existing jog tests (pulse count, cap enforcement, `nudgePosition` accounting) continue to pass unchanged.
2. **Captured-envelope draw preservation**: For a calibrated machine, the emitted microstep sequence, counted full steps, and final `position()` for a segment match the pre-fix accounting (only timing differs).
3. **Captured-envelope fit preservation**: `fitPolylinesToEnvelope` output for captured envelopes is identical (web round-trip).
4. **Pause/resume/cancel/stop preservation**: Behavior and retained state across these controls is unchanged.
5. **NVM persistence preservation**: One staged write per completed segment, debounced.

### Unit Tests

- **Divider timing (host)**: Drive `onStepIsr()` `STEP_TICK_HZ` times with `cur_micro_hz_` fixed at several rates (RAMP_MIN_SPS, MOTION_START_SPS, FEED_SPS_MIN, FEED_SPS_MAX × MICROSTEP_FACTOR); assert emitted microsteps ≈ commanded rate within one tick.
- **Single timer programming**: Assert the GPT is programmed exactly once and `setTimerRateHz_` no longer exists in the per-step path (instrument the host seam to count reprogram calls = 0 after `begin()`).
- **Effective-envelope resolver**: calibrated+valid ⇒ captured; uncalibrated or invalid ⇒ DEFAULT_ENVELOPE.
- **Gate relaxation**: uncalibrated `handleCmdFrame`/`BEGIN_DRAW` no longer NACK `EnvelopeRequired`.
- **Edge cases**: zero-length segment, single-microstep step, out-of-range feed clamped, slowest pull-in speed divisibility.
- **Constants unchanged**: static_asserts confirm `MICROSTEP_FACTOR`, `FEED_SPS_MIN/MAX`, `DrawingCommand` layout unchanged.

### Property-Based Tests

- **Divider average rate (host PBT)**: For random commanded microstep rates in `[RAMP_MIN_SPS*16, FEED_SPS_MAX*16]`, driving `onStepIsr()` N ticks yields `emitted ≈ rate*N/STEP_TICK_HZ` within ±1 microstep (DDS bound).
- **Segment step-count equality (host PBT)**: For random `dx,dy,feed`, the fixed planner emits exactly `totalSteps*MICROSTEP_FACTOR` microsteps and the final `position()` equals the pre-fix accounting (preservation of Bresenham/counted-step invariants).
- **Within-envelope (web PBT)**: For random polylines fitted into DEFAULT_ENVELOPE, all generated step coordinates satisfy `0 <= x <= 2158`, `0 <= y <= 1650`.
- **Resolver selection (host PBT)**: For random configs, `effectiveEnvelope` returns captured iff calibrated+valid, else default.

### Integration Tests

- **Uncalibrated full draw flow**: HELLO advertises effective (default) envelope ⇒ web `canDraw` true ⇒ BEGIN_DRAW + stream + END_DRAW completes without `EnvelopeRequired`; recalibration wizard still reachable.
- **Calibrated overrides default**: After CAPTURE_TOP_RIGHT, HELLO advertises the captured envelope and draws fit to it.
- **Cooperative draw**: pause/resume/stop during a draw are serviced promptly (ISR stays short, loop keeps polling).

### Hardware Testing Safety Note

Motion changes are physically risky. During hardware testing the motor PSU / kill switch MUST be within reach; the software/BLE STOP is NOT a substitute for the hardware kill. Bring up at low feed first and confirm the effective step rate matches the commanded feed before testing peak speeds. The host build runs via `pio` (env `host_test`); ignore the known unrelated `test_backlash_props` failure.
