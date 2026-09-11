# Implementation Plan: Visual Corner Calibration

## Overview

This plan replaces the dangerous hard-coded gear-math scaling (`mm_per_rev`) with a measured **Step_Envelope** captured by a two-corner, jog-by-eye flow. The work spans firmware (C++) and the web SPA (TypeScript) and follows the backlash precedent: a single-source-of-truth wire layout shared between firmware and SPA, fixed-offset NVM/HELLO/STATUS fields pinned by `static_assert`, and host-testable parsing/serialisation/validation cores.

The bias is to keep the input-varying logic pure and host-testable. The new firmware logic (jog-cap check, envelope measurement/validation, draw-gate predicate) is extracted into a pure `envelope_calibration` core so the seven correctness properties can be exercised on `platform = native` without the radio or motors. The `.ino` becomes thin wiring over that core. On the web side the riskiest new code is `fitPolylinesToEnvelope` (Property 1) and the send-gate predicate (Property 2), both pure modules.

Tasks are ordered so each builds on the previous: firmware NVM record + constants → firmware pure calibration core + PBT → firmware protocol (NACK codes, CTL kinds) → firmware STATUS/HELLO fields → firmware sketch wiring → firmware checkpoint → web codec/scale/planner → web stores/controller/wire-client → web UI wizard → web checkpoint → cross-language single-source-of-truth fixtures → final matrix checkpoint → clearly-marked HIL/manual verification (non-blocking, requires the physical board + a re-flash).

Environment notes for the executor:
- Web: `cd web && npm test` (Vitest + fast-check), `cd web && npm run build`, `cd web && npm run lint` all work.
- Firmware host tests: `cd firmware && PATH="$HOME/Library/Python/3.13/bin:$PATH" pio test -e host_test` (Catch2 + rapidcheck, custom runner via per-suite `int main`). Each new host suite lives in its own `firmware/tests/test_*/` directory with its own `int main(...) { return Catch::Session().run(...); }`, mirroring the existing suites (e.g. `test_nvm`, `test_jog_props`).
- Firmware build: `cd firmware && pio run -e uno_r4_wifi_ble` and `-e uno_r4_wifi_wifi`. Adopting the new NVM record version (`NVM_VERSION = 2`) requires a re-flash of the board (`pio run -e uno_r4_wifi_ble -t upload`); older `version == 1` records are intentionally rejected to defaults.
- KNOWN PRE-EXISTING FAILURE: the `test_backlash_props` host suite fails on `main` for reasons unrelated to this feature. Do NOT chase it; treat the firmware host run as green if it is the only failing suite and all suites added/touched here pass.
- Physical behavior (real jog-by-eye capture, motors honoring the cap, persistence across a real power cycle, drawing landing on the canvas) CANNOT be verified by the executor. Those are HIL/manual items (section 13), explicitly non-blocking.

## Tasks

- [x] 1. Firmware NVM: PersistedConfig v2 record and fixed constants
  - [x] 1.1 Extend `PersistedConfig` to v2 with envelope fields, flag bit, and pinned layout
    - In `firmware/src/types.h`: add `uint32_t envelope_x_steps` (offset 126) and `uint32_t envelope_y_steps` (offset 130); move `flags`/`_pad1`/`record_crc32` to offsets 134/135/136; bit2 of `flags` is the envelope-calibrated bit
    - Add constants: `NVM_VERSION = 2`, `NVM_FLAG_ENVELOPE_CALIBRATED = 0x04`, `NVM_RECORD_SIZE = 140`, `NVM_RECORD_CRC_RANGE = 136`, and the fixed per-axis `JOG_TRAVEL_CAP_STEPS = 40000`
    - Add/update `static_assert`s: `sizeof(PersistedConfig) == 140`, `offsetof(envelope_x_steps) == 126`, `offsetof(envelope_y_steps) == 130`, `offsetof(flags) == 134`, `offsetof(_pad1) == 135`, `offsetof(record_crc32) == 136`
    - Ensure the new fields fall inside the CRC range (CRC now covers `[0..136)`)
    - In `firmware/src/nvm/nvm_manager.cpp` `loadDefaults_`: zero `envelope_x_steps`/`envelope_y_steps` and leave `NVM_FLAG_ENVELOPE_CALIBRATED` clear; confirm `readAndValidate_` rejects `version != 2` to defaults
    - _Requirements: 7.1, 7.4, 7.5, 5.2, 5.3, 11.3_
    - _Design: §Data Models (PersistedConfig v2), §"Firmware: types.h"_
  - [x]* 1.2 Add example NVM tests for defaults and version rejection
    - Extend `firmware/tests/test_nvm/test_nvm.cpp`: a fresh/defaulted record reports envelope `0,0` and `ENVELOPE_CALIBRATED` clear; a stored `version == 1` record is rejected to defaults (envelope treated absent, gate engaged)
    - _Requirements: 5.2, 5.3, 7.5_
    - _Design: §Data Models (PersistedConfig v2)_

- [x] 2. Firmware envelope-calibration pure core (host-compilable)
  - [x] 2.1 Implement the pure calibration core
    - Create `firmware/src/app/envelope_calibration.{h,cpp}`, Arduino-include-free so it compiles under `platform = native`
    - `bool drawingPermitted(bool homeSet, bool envelopeCaptured)` → `homeSet && envelopeCaptured` (the gate predicate; no gear-math path)
    - `bool jogWithinCap(int32_t curX, int32_t curY, Axis axis, int32_t delta, int32_t cap)` → true iff the resulting axis stays within `±cap`
    - `MeasuredEnvelope measureEnvelope(Position pos)` → `{ |pos.x_steps|, |pos.y_steps| }` (home is `(0,0)`, so envelope = `|position|`; never derived from any SPA-supplied value)
    - `bool isValidEnvelope(int32_t mx, int32_t my)` → `mx > 0 && my > 0`
    - _Requirements: 1.5, 1.6, 2.1, 4.2, 5.1, 6.1, 6.4_
    - _Design: §"Firmware: Sketch Handlers", §"Testing Strategy" (host-testable vs HIL)_
  - [x]* 2.2 Write property test for the jog travel cap (firmware, rapidcheck)
    - Create `firmware/tests/test_jog_cap_props/` (rapidcheck + Catch2, own `int main`), 100+ iterations
    - **Property 3: Jog travel cap is never exceeded** — for arbitrary jog sequences (any axis/direction/step count) applied from home, accumulated position never exceeds `±JOG_TRAVEL_CAP_STEPS`; a jog that would cross the cap is refused and leaves the position unchanged, holding even before any capture
    - Tag: `// Feature: visual-corner-calibration, Property 3`
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
    - _Design: §Correctness Properties (P3), §Testing Strategy_
  - [x]* 2.3 Write property test for envelope validity (firmware, rapidcheck)
    - Create `firmware/tests/test_envelope_validity_props/`, 100+ iterations
    - **Property 5: Envelope accepted iff both axes are positive** — for arbitrary measured count pairs `(mx,my)` (including zero/negative), `isValidEnvelope` returns true iff `mx > 0 && my > 0`; otherwise the capture is rejected and the captured state stays cleared
    - Tag: `// Feature: visual-corner-calibration, Property 5`
    - **Validates: Requirements 2.1, 2.2, 2.3**
    - _Design: §Correctness Properties (P5)_
  - [x]* 2.4 Write property test for envelope = accumulated travel (firmware, rapidcheck)
    - Create `firmware/tests/test_envelope_travel_props/`, 100+ iterations
    - **Property 6: Envelope equals the Controller's own accumulated travel** — for arbitrary within-cap jog sequences after a bottom-left capture, `measureEnvelope` over the resulting position equals the absolute net step displacement per axis since the capture, independent of any SPA-supplied value
    - Tag: `// Feature: visual-corner-calibration, Property 6`
    - **Validates: Requirements 1.5, 1.6**
    - _Design: §Correctness Properties (P6) — host part; physical confirm is HIL_
  - [x]* 2.5 Write property test for the draw-gate predicate (firmware, rapidcheck)
    - Create `firmware/tests/test_draw_gate_props/`, 100+ iterations
    - **Property 2: Drawing gate blocks unless envelope-calibrated, with no fallback** (firmware side) — for arbitrary `(homeSet, envelopeCaptured)` pairs, `drawingPermitted` is true iff both are true; every other combination is blocked and no gear-math scaling path is reachable
    - Tag: `// Feature: visual-corner-calibration, Property 2`
    - **Validates: Requirements 4.1, 4.2, 4.3, 5.1, 5.2, 5.3**
    - _Design: §Correctness Properties (P2)_

- [x] 3. Firmware protocol: NACK reasons and new CTL kinds
  - [x] 3.1 Add envelope NACK reason codes
    - In `firmware/src/protocol/command_parser.h` extend `NackReason`: `EnvelopeRequired = 0x06`, `EnvelopeHomeNotSet = 0x07`, `EnvelopeInvalid = 0x08`, `JogTravelCap = 0x09` (wire-stable; reuse the existing `NACK { u32 seq, u8 reason }` payload)
    - _Requirements: 1.7, 2.2, 4.4, 5.1, 6.3, 9.2_
    - _Design: §Data Models (NACK Reason Codes), §Error Handling_
  - [x] 3.2 Add `CAPTURE_BOTTOM_LEFT`/`CAPTURE_TOP_RIGHT` control kinds + length validation
    - In `firmware/src/protocol/control_parser.{h,cpp}`: add `ControlKind::CAPTURE_BOTTOM_LEFT = 0x0E` and `CAPTURE_TOP_RIGHT = 0x0F`; add both to `isKnownControlKind` and to the parameterless branch of `parseControl` (valid iff `len == LEN_PARAMLESS == 1`, else `BadLength`)
    - Extend the header's byte-layout table with the two no-payload rows as the single source of truth shared with `web/src/codec/control.ts`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 11.2_
    - _Design: §"Firmware: Control Parser", §Data Models (CTL Wire Layout)_
  - [x]* 3.3 Write property test for CTL length validation + parse (firmware, rapidcheck)
    - Create `firmware/tests/test_capture_ctl_props/`, 100+ iterations
    - **Property 7: New CTL kinds validate length and round-trip** (parse side) — for arbitrary-length payloads presented as `0x0E`/`0x0F`, `parseControl` returns `Ok` iff the payload is exactly the one kind byte and `BadLength` otherwise; a well-formed single byte parses to the matching kind
    - Tag: `// Feature: visual-corner-calibration, Property 7`
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
    - _Design: §Correctness Properties (P7) — cross-language encode side is task 11.2_

- [x] 4. Firmware STATUS and HELLO frame fields
  - [x] 4.1 Add the STATUS envelope-calibrated flag bit
    - In `firmware/src/diagnostics/status_reporter.{h,cpp}`: add `STATUS_FLAG_ENVELOPE_CALIBRATED = 0x04` (bit2 of the flags byte at offset 13) and `void setEnvelopeCalibrated(bool)` that sets/clears the bit; no layout/size change
    - _Requirements: 8.2, 8.4_
    - _Design: §"Firmware: STATUS", §Data Models (STATUS Frame)_
  - [x]* 4.2 Add unit test for the STATUS flag bit
    - Extend `firmware/tests/test_status_reporter/`: `setEnvelopeCalibrated(true/false)` sets/clears bit2 without disturbing bit0 (calibrated) or bit1 (buffer-full)
    - _Requirements: 8.2, 8.4_
    - _Design: §Data Models (STATUS Frame)_
  - [x] 4.3 Extend the HELLO payload with envelope fields and flag
    - In `firmware/src/app/hello.{h,cpp}`: add `envelope_x_steps` (offset 32, u32), `envelope_y_steps` (offset 36, u32) to the payload; bump `HELLO_PAYLOAD_SIZE` to `40`; add `HELLO_FLAG_ENVELOPE_CALIBRATED = 0x04` riding bit2 of the existing flags byte (offset 28); add `envelope_x_steps`/`envelope_y_steps`/`envelope_calibrated` to `HelloFields` and `serializeHello`
    - _Requirements: 8.1, 8.3, 11.1_
    - _Design: §"Firmware: HELLO", §Data Models (HELLO Frame)_
  - [x]* 4.4 Write property test for envelope round-trip through NVM and HELLO (firmware, rapidcheck)
    - Create `firmware/tests/test_envelope_roundtrip_props/`, 100+ iterations
    - **Property 4: Envelope round-trips through NVM and HELLO unchanged** (firmware side) — for arbitrary valid envelopes (`x,y > 0`, flag set), writing then reading the `PersistedConfig` record yields identical values + flag, and `serializeHello` then parsing the payload bytes yields identical values + flag
    - Tag: `// Feature: visual-corner-calibration, Property 4`
    - **Validates: Requirements 7.2, 7.3, 8.1, 8.3**
    - _Design: §Correctness Properties (P4) — the TS-decode cross-check is task 11.1_

- [x] 5. Firmware sketch wiring (`etchasketch.ino`)
  - [x] 5.1 Wire capture handlers, re-home envelope clear, and HELLO population
    - Add `isEnvelopeCalibrated()` helper beside `isCalibrated()`
    - `CAPTURE_BOTTOM_LEFT` (0x0E): reuse `setHome()`/`onHome()`, persist `logical_pos = 0`, set `NVM_FLAG_CALIBRATED`, **clear** `NVM_FLAG_ENVELOPE_CALIBRATED`, zero `envelope_x/y_steps`; `g_status.setCalibrated(true)` + `setEnvelopeCalibrated(false)`; `sendAck(0)` + Idle state
    - `CAPTURE_TOP_RIGHT` (0x0F): if `!isCalibrated()` → `sendNack(0, EnvelopeHomeNotSet)`; else `measureEnvelope(g_planner.position())`, if `!isValidEnvelope` → `sendNack(0, EnvelopeInvalid)`; else persist envelope + set flag, `g_status.setEnvelopeCalibrated(true)`, `sendAck(0)` + Idle (replaces prior envelope on re-capture)
    - In `sendHello`: populate the new envelope members from `cfg.envelope_x_steps/y` and the `NVM_FLAG_ENVELOPE_CALIBRATED` bit
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.7, 2.1, 2.2, 2.3, 7.2, 8.4, 10.1, 10.3, 10.4_
    - _Design: §"Firmware: Sketch Handlers", §Calibration State Machine_
  - [x] 5.2 Tighten the drawing gate to envelope-calibrated
    - In `handleCmdFrame`: replace `if (!isCalibrated())` with `if (!isEnvelopeCalibrated())` → `sendNack(cmd.seq, EnvelopeRequired)`
    - In the `BEGIN_DRAW` handler: add a top guard — if `!isEnvelopeCalibrated()`, `sendNack(0, EnvelopeRequired)` and do not arm the draw (authoritative block; no gear-math fallback)
    - Use `drawingPermitted(isCalibrated(), isEnvelopeCalibrated())` where the composite check is clearer
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 10.2_
    - _Design: §"Firmware: Sketch Handlers" (Drawing gate), §Calibration State Machine_
  - [x] 5.3 Enforce the jog travel cap in the JOG handler
    - In the `JOG` handler: compute the prospective axis position and call `jogWithinCap(...)` with `JOG_TRAVEL_CAP_STEPS`; if it would exceed, `sendNack(0, JogTravelCap)` and do not submit the jog; otherwise proceed with the existing jog submit (active regardless of calibration state)
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
    - _Design: §"Firmware: Sketch Handlers" (Jog travel cap)_

- [x] 6. Checkpoint - firmware builds and host tests pass
  - Run `cd firmware && PATH="$HOME/Library/Python/3.13/bin:$PATH" pio test -e host_test`; run `cd firmware && pio run -e uno_r4_wifi_ble` and `pio run -e uno_r4_wifi_wifi`.
  - Treat the run as green if `test_backlash_props` is the only failing suite (known pre-existing, unrelated). Ensure all tests pass, ask the user if questions arise.

- [x] 7. Web codec, scale, and planner
  - [x] 7.1 Add the capture control encoders
    - In `web/src/codec/control.ts`: add `CtlKind.CAPTURE_BOTTOM_LEFT = 0x0e` and `CAPTURE_TOP_RIGHT = 0x0f`; add `{ kind: 'captureBottomLeft' }` / `{ kind: 'captureTopRight' }` to `ControlMessage`; `encodeControl` emits the single kind byte (no payload — the Controller measures its own steps)
    - _Requirements: 9.1, 9.4, 11.2_
    - _Design: §"Web: New CTL Encoders"_
  - [x] 7.2 Implement `fitPolylinesToEnvelope` (step-space fit)
    - In `web/src/path/scale.ts`: add `StepEnvelope`, `FitToEnvelopeOptions`, and `fitPolylinesToEnvelope(polylines, env, opts)` — bounding box → uniform scale `s = min(targetW/srcW, targetH/srcH)` → center/letterbox → emit `round(...)` per point and clamp to `[0, env.x]`/`[0, env.y]`; one scale factor for both axes (aspect preserved, no stretch); degenerate extent → `s = 1`
    - _Requirements: 3.2, 3.3, 3.4_
    - _Design: §"Web: Envelope-Fit (path/scale.ts)"_
  - [x]* 7.3 Write property test for fit-to-envelope bounds + aspect (web, fast-check)
    - Create `web/src/path/scale_envelope.props.test.ts` (Vitest + fast-check), 100+ runs, generators for arbitrary polylines and envelopes (`x,y ∈ [1, 60000]`)
    - **Property 1: Fit-to-envelope stays in bounds and preserves aspect ratio** — every emitted coordinate is an integer within `[0, x]`/`[0, y]`, and the X and Y scale factors are equal (single uniform scale; centered, letterboxed, never stretched)
    - Tag: `// Feature: visual-corner-calibration, Property 1`
    - **Validates: Requirements 3.2, 3.3, 3.4**
    - _Design: §Correctness Properties (P1)_
  - [x] 7.4 Add the envelope-fit branch to the planner
    - In `web/src/path/planner.ts`: add `envelopeSteps?: { x: number; y: number }` to `PlanOptions`; when present, the per-polyline stage uses `fitPolylinesToEnvelope` and **skips `scaleAndClamp`** (no `mmPerRev`/`DRAWABLE_MM`), RDP runs on the fitted integer polylines (ε in steps), and `drawableSteps = envelopeSteps`; `toCommands` unchanged
    - _Requirements: 3.1, 3.2_
    - _Design: §"Web: Planner Envelope-Fit Path"_
  - [x]* 7.5 Add unit tests for the planner envelope-fit path
    - Extend `web/src/path/planner.test.ts`: with `envelopeSteps` set, output coords lie within the envelope, `mmPerRev` is not consulted, `drawableSteps` equals the envelope; degenerate (single-point/zero-extent) input handled
    - _Requirements: 3.1, 3.2, 3.4_
    - _Design: §"Web: Planner Envelope-Fit Path"_

- [x] 8. Web stores, wire client, and controller
  - [x] 8.1 Add envelope signals to the stores
    - In `web/src/app/stores.ts`: add `StepEnvelope`, `envelope: Signal<StepEnvelope | null>` (default `null`), `envelopeCalibrated: Signal<boolean>` (default `false`); keep `calibrated` (home set) distinct
    - _Requirements: 8.3, 8.5, 4.5_
    - _Design: §"Web: Stores"_
  - [x] 8.2 Decode envelope from HELLO/STATUS and gate sends on `envelopeCalibrated`
    - In `web/src/net/wire_client.ts`: `onHello` decodes `envelope_x_steps`@32 / `envelope_y_steps`@36 and bit2 of flags@28 (raise the min-length check while staying tolerant of a longer payload); the `home` event payload gains `envelope` + `envelopeCalibrated`; `onStatus` reads STATUS flags bit2
    - The send-gate predicate becomes `envelopeCalibrated`: `sendCommand` and `sendControl({kind:'beginDraw'})` reject with `WireError('notCalibrated', …)` unless an envelope is calibrated
    - Map the `EnvelopeRequired` NACK/ERROR reason to a `fault` event kind (mirror existing `homeRequired` handling)
    - _Requirements: 4.1, 5.1, 8.2, 8.3, 8.4, 11.1_
    - _Design: §"Web: Wire Client"_
  - [x]* 8.3 Write property test for the web send-gate (web, fast-check)
    - Extend `web/src/net/wire_client.props.test.ts`, 100+ runs over `(homeSet, envelopeCaptured)` state pairs
    - **Property 2: Drawing gate blocks unless envelope-calibrated, with no fallback** (web side) — the wire client permits `beginDraw`/`sendCommand` iff both bits are true; every other combination rejects with `WireError('notCalibrated', …)` and emits no command
    - Tag: `// Feature: visual-corner-calibration, Property 2`
    - **Validates: Requirements 4.1, 4.2, 4.3, 5.1, 5.2, 5.3**
    - _Design: §Correctness Properties (P2)_
  - [x] 8.4 Wire capture actions, HELLO/STATUS fold, and the draw gate in the controller
    - In `web/src/app/controller.ts`: add `captureBottomLeft()` (sends `{kind:'captureBottomLeft'}`, optimistic homeSet + clear envelope) and `captureTopRight()` (sends `{kind:'captureTopRight'}`); HELLO `home` fold sets `stores.envelope` + `stores.envelopeCalibrated`; STATUS fold sets `stores.envelopeCalibrated`; `draw()` is gated on `stores.envelopeCalibrated` (else surface calibration-required, no `BEGIN_DRAW`) and builds the plan with `envelopeSteps: stores.envelope.value`
    - _Requirements: 1.2, 1.4, 3.1, 4.1, 4.4, 8.3, 8.4, 10.1_
    - _Design: §"Web: Controller"_
  - [x]* 8.5 Add unit tests for controller capture actions and gate
    - Extend `web/src/app/controller.test.ts`: capture actions send the right CTL kinds and apply optimistic state; HELLO/STATUS folds rehydrate `envelope`/`envelopeCalibrated`; `draw()` blocks when not envelope-calibrated and uses `envelopeSteps` when calibrated
    - _Requirements: 4.1, 4.4, 8.3, 8.4_
    - _Design: §"Web: Controller"_

- [x] 9. Web UI: guided calibration wizard
  - [x] 9.1 Implement the guided two-corner flow with distinct state indicators
    - In `web/src/ui/CalibrationWizard.tsx`: step 1 (bottom-left) reuses jog + Set Home + position readout with a **Capture bottom-left** button → `onCaptureBottomLeft`; step 2 (top-right, enabled only in Home_Set_State) with a **Capture top-right** button → `onCaptureTopRight`; a complete state showing "Calibration complete — envelope NNNN × NNNN steps" and enabling drawing
    - Add `data-testid` markers `calib-state-uncalibrated`, `calib-state-home-set`, `calib-state-envelope-captured`, `capture-bottom-left`, `capture-top-right`, `calibration-complete`
    - _Requirements: 1.1, 4.5, 8.5, 10.1, 10.3_
    - _Design: §"Web: CalibrationWizard"_
  - [x]* 9.2 Add component tests for the wizard states
    - Extend `web/src/ui/CalibrationWizard.test.tsx`: distinct Home_Set vs Envelope_Captured indicators, top-right disabled until home set, "calibration complete" shown when `envelopeCalibrated`
    - _Requirements: 4.5, 8.5_
    - _Design: §"Web: CalibrationWizard", §Testing Strategy (component tests)_

- [x] 10. Checkpoint - web tests, build, and lint pass
  - Run `cd web && npm test`; run `cd web && npm run build`; run `cd web && npm run lint`.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Cross-language single-source-of-truth fixtures
  - [x]* 11.1 HELLO envelope cross-check fixture (firmware ↔ web)
    - Add a shared golden-bytes fixture: firmware `serializeHello` output for a known envelope decodes identically in the TS `wire_client.onHello` (offsets 32/36 + flag bit2), pinning the HELLO layout; add the TS assertion (e.g. `web/src/net/hello_envelope_crosscheck.test.ts`) and the matching firmware serialiser assertion
    - **Property 4: Envelope round-trips through NVM and HELLO unchanged** (cross-language decode side)
    - Tag: `// Feature: visual-corner-calibration, Property 4`
    - **Validates: Requirements 8.1, 8.3, 11.1**
    - _Design: §Testing Strategy (cross-check fixture)_
  - [x]* 11.2 CTL capture-message cross-check (firmware ↔ web)
    - Assert that `encodeControl({kind:'captureBottomLeft'})` / `captureTopRight` produce the single bytes `0x0E` / `0x0F` and that the firmware `parseControl` accepts exactly those bytes — pinning the CTL layout as a single source of truth
    - **Property 7: New CTL kinds validate length and round-trip** (cross-language encode side)
    - Tag: `// Feature: visual-corner-calibration, Property 7`
    - **Validates: Requirements 9.1, 9.4, 11.2**
    - _Design: §Testing Strategy (cross-check fixture)_

- [x] 12. Final checkpoint - full test + build matrix
  - Run `cd web && npm test`, `cd web && npm run build`, and `cd web && npm run lint`.
  - Run `cd firmware && PATH="$HOME/Library/Python/3.13/bin:$PATH" pio test -e host_test`, `cd firmware && pio run -e uno_r4_wifi_ble`, and `pio run -e uno_r4_wifi_wifi`.
  - Treat the firmware host run as green if `test_backlash_props` is the only failing suite. Ensure all tests pass, ask the user if questions arise.

- [ ] 13. HIL / manual verification (REQUIRES REAL HARDWARE — non-blocking)
  - NOTE: The following items require a physical Arduino UNO R4 WiFi RE-FLASHED with the new NVM record version (`pio run -e uno_r4_wifi_ble -t upload`) and a Chromium-based browser. They CANNOT be completed by a coding agent and MUST NOT block the codeable/testable tasks above.
  - [~] 13.1 Real jog-by-eye capture: jog to bottom-left and capture (home set), jog to top-right and capture; confirm the wizard advances through Home_Set → Envelope_Captured → complete with a sensible reported envelope
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 8.5_
  - [~] 13.2 Motors honor the jog cap: drive an axis toward `JOG_TRAVEL_CAP_STEPS` and confirm the controller refuses the over-cap jog (JogTravelCap NACK) without slamming the axis, even before any capture
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [~] 13.3 Persistence across a real power cycle: calibrate, power-cycle the board, reconnect, and confirm HELLO restores the envelope and `envelopeCalibrated` so drawing stays enabled
    - _Requirements: 7.2, 7.3, 8.1, 8.3_
  - [~] 13.4 End-to-end fit: load a drawing and confirm it lands centered, aspect-preserved, and inside the measured envelope on the physical canvas (no axis overrun)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [~] 13.5 Byte-identity / draw gate on hardware: confirm drawing is blocked (EnvelopeRequired) before calibration and permitted after, with no gear-math fallback
    - _Requirements: 4.1, 4.4, 5.1, 5.2_

## Notes

- Tasks marked with `*` are optional (tests/verification) and can be skipped for a faster MVP; core implementation tasks are never optional.
- All seven correctness properties get fresh property-based tests at 100+ iterations, tagged `Feature: visual-corner-calibration, Property {n}`. Firmware uses Catch2 + rapidcheck (each suite in its own `firmware/tests/test_*/` with its own `int main`); web uses fast-check + Vitest.
- The pure `envelope_calibration` core (task 2.1) is the host-testable surface for Properties 2 (firmware side), 3, 5, and 6; the `.ino` (task 5) is thin wiring over it.
- Property 4 spans firmware NVM/HELLO round-trip (4.4) and the firmware↔web HELLO cross-check fixture (11.1); Property 7 spans the firmware parse side (3.3) and the web encode cross-check (11.2).
- KNOWN: `test_backlash_props` fails on `main` for unrelated reasons; do not chase it. The firmware host run is green if it is the only failing suite.
- Re-flashing the board is required to adopt `NVM_VERSION = 2`; older records are intentionally rejected to defaults (envelope absent, gate engaged).
- Section 13 is HIL/manual and requires real hardware; it is intentionally non-blocking and excluded from the dependency graph.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1", "7.1", "7.2", "8.1"] },
    { "id": 1, "tasks": ["2.1", "3.2", "4.1", "4.3", "7.4", "8.2"] },
    { "id": 2, "tasks": ["1.2", "2.2", "2.3", "2.4", "2.5", "3.3", "4.2", "4.4", "7.3", "7.5", "8.3", "8.4", "11.1", "11.2"] },
    { "id": 3, "tasks": ["5.1", "8.5", "9.1"] },
    { "id": 4, "tasks": ["5.2", "9.2"] },
    { "id": 5, "tasks": ["5.3"] }
  ]
}
```
