# Implementation Plan: Drawing Motion Fix

## Overview

This plan fixes the two defects defined in `design.md` using the bug-condition
methodology. Exploration property tests (Task 1) come first and are EXPECTED TO
FAIL on the current unfixed code, confirming the bugs exist. Preservation tests
(Task 2) are written and verified PASSING on unfixed code. Implementation (Tasks
3–6) applies the design exactly, after which the exploration tests must pass and
the preservation tests must still pass (Task 7), ending in a build/test
checkpoint (Task 8).

Defect 1 (drawing-motion runaway, C1) is fixed by a constant-rate GPT tick set
ONCE to `STEP_TICK_HZ` plus an integer DDS/Bresenham step divider in
`onStepIsr()`; the per-microstep `setTimerRateHz_()` reprogramming is removed.
Defect 2 (blocked uncalibrated draw, C2) is fixed by a baked-in
`DEFAULT_ENVELOPE` (X=2158, Y=1650), an `effectiveEnvelope()` resolver, removal
of the `EnvelopeRequired` hard block, a firmware-authoritative HELLO envelope,
and matching web send-gate relaxation.

Scope guardrails: do NOT change `MICROSTEP_FACTOR` (16), `FEED_SPS_MIN` (100) /
`FEED_SPS_MAX` (1000), the wire protocol / `Drawing_Command` format, or the
working blocking JOG handler. Host-testability is preserved (`FspTimer` /
`digitalWrite` behind `#if defined(ARDUINO)`, public `onStepIsr()`).

Environment notes for the executor:
- Firmware host tests run via `pio test -e host_test` (cwd `firmware/`). The
  known pre-existing unrelated failure `test_backlash_props` is out of scope and
  MUST be ignored.
- Firmware device build: `pio run` (cwd `firmware/`).
- Web tests run via vitest single-run (`npx vitest --run`, cwd `web/`).
- Hardware-in-the-loop (HIL) / manual motion verification CANNOT be agent-completed
  and is marked optional. During any HIL/manual run the motor PSU / kill switch
  MUST be within reach; the software/BLE STOP is NOT a substitute for the hardware kill.

## Tasks

- [x] 1. Write bug-condition exploration property tests (EXPECTED TO FAIL on unfixed code)
  - [x] 1.1 Exploration test — drawing-motion runaway (C1)
    - **Property 1: Bug Condition** - Constant-Rate Tick / Runaway Effective Step Rate (C1)
    - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the runaway bug exists
    - **DO NOT attempt to fix the test or the code when it fails**
    - **NOTE**: This test encodes the expected behavior (set-once timer + software step division) and will validate the fix when it passes after implementation
    - **GOAL**: Surface counterexamples showing drawing speed is NOT realized in software (all rate control lives in per-step timer reprogramming, i.e. the runaway path on hardware)
    - **Scoped PBT Approach**: Drive `onStepIsr()` deterministically on the host (timer seam is a no-op). Over a property domain of commanded microstep rates in `[RAMP_MIN_SPS*MICROSTEP_FACTOR, FEED_SPS_MAX*MICROSTEP_FACTOR]`, assert that for K `onStepIsr()` calls the emitted microstep count ≈ `rate*K/STEP_TICK_HZ` within ±1 microstep (the post-fix DDS-divider expectation)
    - Also assert (by host seam instrumentation) that the GPT rate is programmed exactly ONCE after `begin()` and `setTimerRateHz_()` is NEVER called per step — Bug Condition C1: `X.kind = DRAW` exercises per-microstep `setTimerRateHz_() -> set_frequency()`
    - Create test at `firmware/tests/test_motion_planner_props/` (new `test_drawing_runaway_props.cpp`, rapidcheck + Catch2 host PBT)
    - Run on UNFIXED code via `pio test -e host_test -f test_motion_planner_props`
    - **EXPECTED OUTCOME**: Test FAILS — unfixed host code emits one microstep per `onStepIsr()` call independent of commanded `speedAt()` (no software division exists), and `setTimerRateHz_()` is called per step
    - Document counterexamples found (e.g. "at cur_micro_hz_=160, emitted=K not K*160/32000; per-step set_frequency calls > 1")
    - Mark complete when the test is written, run, and the failure is documented
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4_
    - _Design: Correctness Properties §Property 1 (C1)_
  - [x] 1.2 Exploration test — blocked uncalibrated draw (C2)
    - **Property 1: Bug Condition** - Blocked Uncalibrated Draw / EnvelopeRequired (C2)
    - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the blocked-draw bug exists
    - **DO NOT attempt to fix the test or the code when it fails**
    - **NOTE**: This test encodes the expected behavior (default-envelope fallback) and will validate the fix when it passes after implementation
    - **GOAL**: Surface counterexamples showing uncalibrated draws are refused with `NackReason::EnvelopeRequired` instead of using `DEFAULT_ENVELOPE`
    - **Scoped PBT Approach**: For a property domain of configs with `NVM_FLAG_ENVELOPE_CALIBRATED` clear and valid `Drawing_Command`/`BEGIN_DRAW` inputs, assert the handler does NOT NACK `EnvelopeRequired` and that `effectiveEnvelope` resolves to `DEFAULT_ENVELOPE` (X=2158, Y=1650)
    - Create test at `firmware/tests/test_draw_gate_props/` (new `test_default_envelope_props.cpp`, host PBT), exercising `handleCmdFrame` and the `BEGIN_DRAW` path with an uncalibrated config — Bug Condition C2: `X.kind = DRAW AND NOT X.envelopeCalibrated`
    - Run on UNFIXED code via `pio test -e host_test -f test_draw_gate_props`
    - **EXPECTED OUTCOME**: Test FAILS — unfixed code returns `EnvelopeRequired` for uncalibrated CMD and BEGIN_DRAW
    - Document counterexamples found (e.g. "uncalibrated handleCmdFrame(valid Drawing_Command) => NACK EnvelopeRequired")
    - Mark complete when the test is written, run, and the failure is documented
    - _Requirements: 1.4, 1.5, 1.6, 2.5, 2.6, 2.7, 2.8_
    - _Design: Correctness Properties §Property 2 (C2)_

- [x] 2. Write preservation property tests (BEFORE implementing fix — EXPECTED TO PASS on unfixed code)
  - **Property 2: Preservation** - Non-Buggy Inputs Behave Identically
  - **IMPORTANT**: Follow observation-first methodology — observe behavior on UNFIXED code, then encode it
  - Observe and record on unfixed code: jog pulse train (pulse count, travel-cap enforcement, `nudgePosition` accounting); for a calibrated-machine draw segment the emitted microstep sequence, counted full steps, and final `position()`; `fitPolylinesToEnvelope` output for captured envelopes; pause/resume/cancel/stop retained state; one debounced staged NVM write per completed segment
  - Write/confirm property-based tests capturing these observed patterns (Preservation Requirements from design):
    - Jog preservation — leverage existing `firmware/tests/test_jog_props/` and `test_jog_cap_props/` (the blocking JOG handler is untouched); assert no behavioral change
    - Captured-envelope draw preservation — in `firmware/tests/test_motion_planner_props/`, for random `dx,dy,feed` on a calibrated config assert emitted microsteps == `totalSteps*MICROSTEP_FACTOR` and final `position()` equals pre-fix accounting (timing may differ, sequence/accounting must not)
    - Captured-envelope fit preservation — leverage existing `firmware/tests/test_envelope_roundtrip_props/` and the web fit tests
    - Pause/resume/cancel/stop and NVM persistence preservation — leverage existing `firmware/tests/test_motion_planner/` and `test_nvm_position/`
  - **NOTE**: Non-buggy domain = all JOG requests + all draws on a machine with a valid captured envelope (parts independent of the timer-rate mechanism); these satisfy `NOT isBugCondition(X)`
  - Run tests on UNFIXED code via `pio test -e host_test` (ignore the known unrelated `test_backlash_props` failure)
  - **EXPECTED OUTCOME**: Tests PASS (confirms baseline behavior to preserve)
  - Mark complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - _Design: Correctness Properties §Property 3 (Preservation); §Preservation Requirements_

- [x] 3. Add firmware constants (STEP_TICK_HZ, DEFAULT_ENVELOPE) and effective-envelope resolver
  - [x] 3.1 Add STEP_TICK_HZ constant to `firmware/src/types.h`
    - Add `inline constexpr std::uint32_t STEP_TICK_HZ = 32000;` near the step-rate envelope (period 31.25 us)
    - Add `static_assert(STEP_TICK_HZ >= static_cast<std::uint32_t>(FEED_SPS_MAX) * MICROSTEP_FACTOR, "tick rate must be >= the maximum commanded microstep rate");`
    - Include the sizing / Nyquist rationale comment from the design
    - **DO NOT change** `MICROSTEP_FACTOR`, `FEED_SPS_MIN`, `FEED_SPS_MAX`
    - _Requirements: 2.1, 2.2, 2.3_
    - _Design: Fix Implementation §Defect 1 (STEP_TICK_HZ)_
  - [x] 3.2 Add DEFAULT_ENVELOPE constants to `firmware/src/types.h`
    - Add `inline constexpr std::uint32_t DEFAULT_ENVELOPE_X_STEPS = 2158;` and `DEFAULT_ENVELOPE_Y_STEPS = 1650;` near the envelope fields, with the bounded-measured-envelope safety comment
    - _Requirements: 2.5, 2.7_
    - _Design: Fix Implementation §Defect 2 (DEFAULT_ENVELOPE)_
  - [x] 3.3 Implement the `effectiveEnvelope()` resolver
    - Add a small free function (in `etchasketch.ino` / the app layer where the envelope is read) returning the captured envelope when `(cfg.flags & NVM_FLAG_ENVELOPE_CALIBRATED)` AND `isValidEnvelope(cfg.envelope_x_steps, cfg.envelope_y_steps)`, else `{ DEFAULT_ENVELOPE_X_STEPS, DEFAULT_ENVELOPE_Y_STEPS }`
    - Keep it Arduino-free so host tests can drive it
    - _Bug_Condition: isBugCondition(X) C2 = X.kind = DRAW AND NOT X.envelopeCalibrated_
    - _Expected_Behavior: effectiveEnvelope resolves captured-if-calibrated-and-valid else DEFAULT_ENVELOPE_
    - _Preservation: captured envelope overrides default (Req 2.6/3.5)_
    - _Requirements: 2.5, 2.6, 2.7, 3.5_
    - _Design: Fix Implementation §Defect 2 (effective-envelope resolver)_

- [x] 4. Implement Defect 1 fix — constant-rate tick + software step division
  - [x] 4.1 Add DDS rate-divider state to `firmware/src/motion/motion_planner.h`
    - Add `volatile std::uint32_t acc_ = 0;` (phase accumulator) and `volatile std::uint32_t cur_micro_hz_ = 0;` (commanded microstep rate for active full step) in the ISR-advanced section
    - _Bug_Condition: isBugCondition(X) C1 = X.kind = DRAW_
    - _Expected_Behavior: software step division realizes commanded rate without timer reprogramming_
    - _Requirements: 2.1, 2.2_
    - _Design: Fix Implementation §Defect 1 (ISR-divider state)_
  - [x] 4.2 Configure the GPT timer once and remove per-step reprogramming
    - In `begin()` / `configureTimer_()` program the GPT once to `STEP_TICK_HZ` (periodic) and never call `set_frequency()` again
    - Delete `setTimerRateHz_()` (both ARDUINO and host no-op) from `firmware/src/motion/motion_planner.h` and `.cpp`; keep `configureTimer_`/`startTimer_`/`stopTimer_` host seams as deterministic no-ops
    - Reset `acc_ = 0`, `cur_micro_hz_ = 0` in `begin()` and `abortProgram_()`; reset `acc_ = 0` at each `beginSegment_()`
    - _Bug_Condition: isBugCondition(X) C1 = X.kind = DRAW (per-microstep set_frequency was root cause)_
    - _Expected_Behavior: timer rate set exactly once, never reprogrammed per step_
    - _Preservation: pause/resume/cancel/stop unchanged; resume re-arms already-programmed timer; host-testability preserved_
    - _Requirements: 2.1, 2.4, 3.2, 3.3_
    - _Design: Fix Implementation §Defect 1 (begin()/configureTimer_; retire setTimerRateHz_)_
  - [x] 4.3 Rewrite `onStepIsr()` with integer DDS step division
    - On each tick: `acc_ += cur_micro_hz_`; if `acc_ < STEP_TICK_HZ` return (no microstep this tick); else `acc_ -= STEP_TICK_HZ` and emit exactly one microstep
    - Keep microstep emission per axis, `micro_remaining_` countdown (MICROSTEP_FACTOR per counted full step), counted-vs-uncounted accounting (count in Main phase only), and program-completion/`stopTimer_()` IDENTICAL to today
    - Keep the ISR short and allocation-free so the cooperative loop keeps servicing BLE / credits / pause / stop
    - _Bug_Condition: isBugCondition(X) C1 = X.kind = DRAW_
    - _Expected_Behavior: effective microstep rate = speedAt(i)*MICROSTEP_FACTOR within one tick of jitter; cooperative_
    - _Preservation: emitted microstep sequence + counted/uncounted full-step accounting unchanged (Bresenham/ring buffer/backlash)_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.3_
    - _Design: Fix Implementation §Defect 1 (onStepIsr rewrite)_
  - [x] 4.4 Update `fetchNextTick_()` to set cur_micro_hz_ at full-step boundaries
    - Remove all `setTimerRateHz_(...)` calls
    - Backlash phase tick: `cur_micro_hz_ = MOTION_START_SPS * MICROSTEP_FACTOR`
    - Main phase tick: `cur_micro_hz_ = ramp_.speedAt(main_step_index_) * MICROSTEP_FACTOR; ++main_step_index_`
    - `cur_micro_hz_` is recomputed only once per full step (no per-microstep division); ramp schedule untouched
    - _Bug_Condition: isBugCondition(X) C1 = X.kind = DRAW_
    - _Expected_Behavior: commanded feed realized by software division reading speedAt at full-step boundaries_
    - _Preservation: TrapezoidRamp::speedAt schedule + counted/uncounted backlash pull-in unchanged_
    - _Requirements: 2.2, 2.3, 3.3_
    - _Design: Fix Implementation §Defect 1 (fetchNextTick_ change)_

- [x] 5. Implement Defect 2 fix — firmware gate relaxation + authoritative HELLO
  - [x] 5.1 Remove the EnvelopeRequired hard block and use the effective envelope
    - In `firmware/etchasketch.ino` `handleCmdFrame`: remove the `if (!isEnvelopeCalibrated()) sendNack(..., EnvelopeRequired)` block; drawing commands proceed using `effectiveEnvelope()` (keep jog travel cap and per-command parse/CRC/range NACKs unchanged)
    - `BEGIN_DRAW`: remove the `if (!isEnvelopeCalibrated()) sendNack(0, EnvelopeRequired)` block; arm the draw unconditionally subject to existing non-envelope checks
    - Keep `isEnvelopeCalibrated()` for status/HELLO reporting and the recalibration flow; it no longer gates drawing
    - **DO NOT change** the blocking JOG handler or the wire protocol
    - _Bug_Condition: isBugCondition(X) C2 = X.kind = DRAW AND NOT X.envelopeCalibrated_
    - _Expected_Behavior: no EnvelopeRequired NACK; draw allowed using effective (default) envelope, bounded within it_
    - _Preservation: jog travel cap, parse/CRC/range NACKs, recalibration flow unchanged_
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 3.5_
    - _Design: Fix Implementation §Defect 2 (Gate relaxation)_
  - [x] 5.2 Send the effective envelope in HELLO (firmware-authoritative, no wire-format change)
    - Fill `HelloFields.envelope_x_steps/envelope_y_steps` with the effective envelope (captured when calibrated, else `DEFAULT_ENVELOPE`)
    - Keep `envelope_calibrated` reporting only whether a captured envelope exists; `HELLO_PAYLOAD_SIZE` stays 40; `Drawing_Command` format untouched
    - _Bug_Condition: isBugCondition(X) C2 = X.kind = DRAW AND NOT X.envelopeCalibrated_
    - _Expected_Behavior: HELLO advertises effective envelope as single source of truth_
    - _Preservation: wire format / HELLO_PAYLOAD_SIZE unchanged (Req 3.7)_
    - _Requirements: 2.5, 2.6, 2.8, 3.7_
    - _Design: Fix Implementation §Defect 2 (HELLO authoritative)_

- [x] 6. Implement Defect 2 fix — web side uses effective envelope
  - [x] 6.1 Fold the effective envelope into the web stores and plan
    - In `web/src/app/controller.ts`: fold the HELLO/STATUS envelope into `stores.envelope` even when `envelopeCalibrated === false` (it now carries the effective/default envelope); keep `stores.envelopeCalibrated` tracking only captured calibration
    - `rebuildPlan()` uses `stores.envelope` (effective) for the envelope-fit branch whenever an envelope is present, regardless of `envelopeCalibrated`
    - _Bug_Condition: isBugCondition(X) C2 = X.kind = DRAW AND NOT X.envelopeCalibrated_
    - _Expected_Behavior: web plans/draws using the effective (default) envelope_
    - _Preservation: recalibration wizard remains reachable (Req 2.8); captured-envelope fit unchanged (Req 3.6)_
    - _Requirements: 2.5, 2.8, 3.6_
    - _Design: Fix Implementation §Defect 2 (Web side)_
  - [x] 6.2 Relax the canDraw / draw / send gates to the effective envelope
    - `web/src/ui/App.tsx` `canDraw`: change to `hasPath && !!stores.envelope.value && !drawingActive`
    - `web/src/app/controller.ts` `draw()`: drop the `if (!envelopeCalibrated) error` early-return; gate on planned path + effective envelope
    - `web/src/net/wire_client.ts` send-gate: allow `sendCommand` / `BEGIN_DRAW` when an effective envelope is known; keep the envelope-family NACK→fault mirror for genuine invalid-envelope cases
    - _Bug_Condition: isBugCondition(X) C2 = X.kind = DRAW AND NOT X.envelopeCalibrated_
    - _Expected_Behavior: drawing allowed with default envelope; not blocked in UI or send path_
    - _Preservation: recalibration available; invalid-envelope fault mirror retained_
    - _Requirements: 2.8, 3.5_
    - _Design: Fix Implementation §Defect 2 (Web side; within-envelope guarantee)_

- [x] 7. Write fix-checking property tests and re-verify (run AFTER implementation)
  - [x] 7.1 Verify bug-condition exploration test 1.1 now passes (C1)
    - **Property 1: Expected Behavior** - Constant-Rate Tick / Software Step Division (C1)
    - **IMPORTANT**: Re-run the SAME test from task 1.1 - do NOT write a new test
    - Run via `pio test -e host_test -f test_motion_planner_props`
    - **EXPECTED OUTCOME**: Test PASSES (set-once timer; emitted ≈ rate*N/STEP_TICK_HZ within ±1 microstep; cooperative)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
    - _Design: Fix Checking (C1 pseudocode)_
  - [x] 7.2 Verify bug-condition exploration test 1.2 now passes (C2)
    - **Property 1: Expected Behavior** - Default Envelope Fallback (C2)
    - **IMPORTANT**: Re-run the SAME test from task 1.2 - do NOT write a new test
    - Run via `pio test -e host_test -f test_draw_gate_props`
    - **EXPECTED OUTCOME**: Test PASSES (no EnvelopeRequired NACK; effectiveEnvelope = DEFAULT_ENVELOPE; motion within envelope)
    - _Requirements: 2.5, 2.6, 2.7, 2.8_
    - _Design: Fix Checking (C2 pseudocode)_
  - [x] 7.3 Add fix-checking host PBTs (divider timing + set-once timer + segment step-count equality)
    - Divider average-rate PBT: for random commanded microstep rates in `[RAMP_MIN_SPS*16, FEED_SPS_MAX*16]`, driving `onStepIsr()` N ticks yields `emitted ≈ rate*N/STEP_TICK_HZ` within ±1 microstep (DDS bound)
    - Set-once timer PBT: assert the GPT is programmed exactly once and `setTimerRateHz_` no longer exists in the per-step path (host seam reprogram-count == 0 after `begin()`)
    - Segment step-count equality PBT: for random `dx,dy,feed`, the fixed planner emits exactly `totalSteps*MICROSTEP_FACTOR` microsteps and final `position()` equals pre-fix accounting
    - Place in `firmware/tests/test_motion_planner_props/`; run via `pio test -e host_test -f test_motion_planner_props`
    - _Requirements: 2.1, 2.2, 2.3_
    - _Design: Property-Based Tests (divider average rate; segment step-count equality); Unit Tests (single timer programming)_
  - [x] 7.4 Add fix-checking web + resolver PBTs
    - Within-default-envelope (web PBT): for random polylines fitted into `DEFAULT_ENVELOPE`, all generated step coordinates satisfy `0 <= x <= 2158`, `0 <= y <= 1650` (add to `web/src/` `*.prop.test.ts`, run via vitest)
    - Resolver selection (host PBT): for random configs, `effectiveEnvelope` returns captured iff calibrated+valid, else default (add to `firmware/tests/test_draw_gate_props/`)
    - _Requirements: 2.5, 2.6, 2.7_
    - _Design: Property-Based Tests (within-envelope; resolver selection)_
  - [x] 7.5 Verify preservation tests still pass (no regressions)
    - **Property 2: Preservation** - Non-Buggy Inputs Behave Identically
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run via `pio test -e host_test` and the `web` vitest suite
    - **EXPECTED OUTCOME**: Tests PASS (jog unchanged; captured-envelope draws/sequence/accounting/position/persistence unchanged)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
    - _Design: Preservation Checking_

- [ ] 8. Checkpoint — build and run full suites
  - [x] 8.1 Run the host test suite
    - Run `pio test -e host_test` (cwd `firmware/`)
    - IGNORE the known pre-existing unrelated failure `test_backlash_props` (out of scope)
    - Ensure all other tests pass, including the new exploration (now passing), fix-checking, and preservation tests
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [x] 8.2 Build the firmware
    - Run the firmware device build via `pio run` (cwd `firmware/`) to confirm the device target compiles (Arduino/FspTimer paths behind `#if defined(ARDUINO)`)
    - _Requirements: 2.1, 3.2_
  - [x] 8.3 Run the web test suite
    - Run vitest single-run (`npx vitest --run`, cwd `web/`) to confirm the within-default-envelope PBT and web gate changes pass
    - _Requirements: 2.5, 2.8, 3.6_
  - [~] 8.4 (OPTIONAL — HIL/manual, cannot be agent-completed) Hardware verification
    - **HARDWARE SAFETY**: keep the motor PSU / kill switch within reach; software/BLE STOP is NOT a substitute for the hardware kill
    - Bring up at low feed first; confirm the effective step rate matches the commanded feed before testing peak speeds
    - Verify uncalibrated full-draw flow (HELLO advertises default envelope → canDraw true → BEGIN_DRAW + stream + END_DRAW completes without EnvelopeRequired; recalibration still reachable)
    - Verify calibrated capture overrides the default and draws fit to it; verify pause/resume/stop serviced promptly during a draw
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.8_
    - _Design: Integration Tests; Hardware Testing Safety Note_

## Notes

- This is a BUGFIX workflow: Task 1 (exploration) MUST FAIL on unfixed code and Task 2 (preservation) MUST PASS on unfixed code before any implementation begins.
- Property 1 covers the Bug Condition / Expected Behavior (C1 runaway + C2 blocked draw); Property 2 covers Preservation. The `**Property N:**` format enables hover status.
- Scope guardrails (DO NOT change): `MICROSTEP_FACTOR` (16), `FEED_SPS_MIN` (100) / `FEED_SPS_MAX` (1000), the wire protocol / `Drawing_Command` format, and the working blocking JOG handler.
- Host tests run via `pio test -e host_test` (cwd `firmware/`); the known pre-existing unrelated failure `test_backlash_props` is out of scope and MUST be ignored.
- Task 8.4 is OPTIONAL and CANNOT be agent-completed (hardware-in-the-loop); it is excluded from the dependency graph. During any HIL/manual run the motor PSU / kill switch MUST be within reach.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["4.1", "5.1", "6.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "5.2", "6.2"] },
    { "id": 5, "tasks": ["7.1", "7.2", "7.3", "7.4"] },
    { "id": 6, "tasks": ["7.5"] },
    { "id": 7, "tasks": ["8.1", "8.2", "8.3"] }
  ]
}
```
