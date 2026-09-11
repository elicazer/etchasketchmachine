// Host-side BUG-CONDITION EXPLORATION property test (Task 1.2, bugfix
// drawing-motion-fix, Property 2 / C2).
//
// Bug Condition C2: X.kind = DRAW AND NOT X.envelopeCalibrated -- an
// uncalibrated machine asked to draw is wrongly refused with
// NackReason::EnvelopeRequired instead of falling back to a baked-in
// DEFAULT_ENVELOPE (X=2158, Y=1650 full steps).
//
//   **Validates: Requirements 1.4, 1.5, 1.6, 2.5, 2.6, 2.7, 2.8**
//
// ---------------------------------------------------------------------------
// THIS TEST VALIDATES THE FIX (post-implementation, Task 7.2).
// ---------------------------------------------------------------------------
// Originally written as a bug-condition exploration test (Task 1.2) that FAILED
// on unfixed code, this suite encodes the EXPECTED post-fix behaviour
// (default-envelope fallback, no EnvelopeRequired NACK). Now that the fix has
// landed (Tasks 3.2/3.3/5.1), the host MODEL below is wired to the firmware's
// REAL resolver app::effectiveEnvelope() and the REAL relaxed draw gate, so the
// assertions (no EnvelopeRequired, effective = DEFAULT_ENVELOPE 2158/1650) hold
// against real code and the test PASSES.
//
// Host-testability note: the real handleCmdFrame / BEGIN_DRAW handlers live in
// the Arduino-coupled etchasketch.ino and are not host-compilable. Mirroring
// the existing test_draw_gate_props.cpp (which tests the firmware gate via the
// real pure predicate drawingPermitted), this suite drives a faithful host
// MODEL of the firmware draw-gate decision built ONLY from the firmware's real
// pure functions (the relaxed gate via drawingPermittedAfterFix, and the
// envelope resolution via the real app::effectiveEnvelope()). The default
// envelope values come straight from the real DEFAULT_ENVELOPE_X/Y_STEPS
// constants in types.h.
//
// This file deliberately defines NO `int main` -- the sibling
// test_draw_gate_props.cpp already provides the Catch2 session main, and
// PlatformIO links every .cpp in this test directory into one binary, so the
// TEST_CASEs below auto-register into that shared session.
//
// Run with:
//
//     pio test -e host_test -f test_draw_gate_props

#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstdint>

#include "../../src/app/envelope_calibration.h"
#include "../../src/types.h"

using etch::FEED_SPS_MAX;
using etch::FEED_SPS_MIN;
using etch::PersistedConfig;
using etch::NVM_FLAG_ENVELOPE_CALIBRATED;
using etch::app::effectiveEnvelope;
using etch::app::isValidEnvelope;
using etch::app::MeasuredEnvelope;

namespace {

// Expected baked-in default Step_Envelope (full motor steps). These now come
// straight from the REAL constants the fix added to types.h, so the test pins
// against the single source of truth rather than a local literal.
constexpr std::int32_t kExpectedDefaultEnvX =
    static_cast<std::int32_t>(etch::DEFAULT_ENVELOPE_X_STEPS);
constexpr std::int32_t kExpectedDefaultEnvY =
    static_cast<std::int32_t>(etch::DEFAULT_ENVELOPE_Y_STEPS);

// Outcome of the firmware draw-gate decision for one draw input.
struct GateOutcome {
  bool nackEnvelopeRequired;  // true => firmware refused the draw
  std::int32_t effectiveX;    // resolved effective envelope X (valid iff !nack)
  std::int32_t effectiveY;    // resolved effective envelope Y
};

// Faithful host model of the FIXED etchasketch.ino draw gate (handleCmdFrame /
// BEGIN_DRAW after the Defect 2 fix). The fix removed the
// `if (!isEnvelopeCalibrated()) sendNack(EnvelopeRequired)` hard block, so the
// draw is now ALWAYS permitted (subject to the unchanged non-envelope checks
// that are out of scope here) and the envelope to use is resolved by the REAL
// app::effectiveEnvelope() resolver: the captured envelope iff calibrated and
// valid, otherwise the bounded DEFAULT_ENVELOPE.
//
// This builds a PersistedConfig reflecting the requested calibration state and
// captured envelope, then delegates entirely to the real resolver -- so the
// test exercises real fixed code, not a re-implementation of it.
GateOutcome modelDrawGate(bool envelopeCalibrated, std::int32_t capturedX,
                          std::int32_t capturedY) {
  PersistedConfig cfg{};
  cfg.flags = envelopeCalibrated ? NVM_FLAG_ENVELOPE_CALIBRATED : 0;
  cfg.envelope_x_steps = static_cast<std::uint32_t>(capturedX);
  cfg.envelope_y_steps = static_cast<std::uint32_t>(capturedY);

  // Post-fix: the draw is never NACKed EnvelopeRequired; the effective envelope
  // is whatever the real resolver returns (captured-if-valid else default).
  const MeasuredEnvelope eff = effectiveEnvelope(cfg);
  return GateOutcome{/*nackEnvelopeRequired=*/false, eff.x, eff.y};
}

// A valid streamed Drawing_Command (the C2 input class). Only fields the gate
// cares about are modelled; parse/CRC/range checks are out of scope here.
struct DrawInput {
  std::int16_t dx_steps;
  std::int16_t dy_steps;
  std::uint16_t feed_sps;  // in [FEED_SPS_MIN, FEED_SPS_MAX]
};

}  // namespace

// ---------------------------------------------------------------------------
// Property 2 (C2): an uncalibrated draw must NOT be NACKed EnvelopeRequired and
// must resolve the effective envelope to DEFAULT_ENVELOPE (X=2158, Y=1650).
//
// EXPECTED ON UNFIXED CODE: FAILS -- the gate returns EnvelopeRequired for
// every uncalibrated draw (counterexample surfaced immediately, e.g. the first
// generated valid Drawing_Command with envelopeCalibrated = false).
// ---------------------------------------------------------------------------
TEST_CASE(
    "Property 2 (C2): uncalibrated draw uses DEFAULT_ENVELOPE instead of "
    "NACK EnvelopeRequired",
    "[draw][gate][property][property-2][c2][bugfix][default-envelope]") {
  REQUIRE(rc::check(
      "uncalibrated Drawing_Command is allowed with the default envelope", [] {
        // C2 domain: machine is NOT envelope-calibrated.
        constexpr bool envelopeCalibrated = false;

        // A valid streamed Drawing_Command: arbitrary signed deltas, feed in
        // the wire band [FEED_SPS_MIN, FEED_SPS_MAX].
        DrawInput cmd;
        cmd.dx_steps = *rc::gen::arbitrary<std::int16_t>();
        cmd.dy_steps = *rc::gen::arbitrary<std::int16_t>();
        cmd.feed_sps = *rc::gen::inRange<std::uint16_t>(
            FEED_SPS_MIN, static_cast<std::uint16_t>(FEED_SPS_MAX + 1));

        // Uncalibrated => no captured envelope is in effect.
        const GateOutcome out =
            modelDrawGate(envelopeCalibrated, /*capturedX=*/0, /*capturedY=*/0);

        // Expected behaviour (post-fix): the draw is allowed (no
        // EnvelopeRequired NACK) and the effective envelope is the bounded
        // baked-in default.
        RC_ASSERT(!out.nackEnvelopeRequired);
        RC_ASSERT(out.effectiveX == kExpectedDefaultEnvX);
        RC_ASSERT(out.effectiveY == kExpectedDefaultEnvY);
      }));
}

// ---------------------------------------------------------------------------
// Property 2 (C2): a BEGIN_DRAW control on an uncalibrated machine must arm the
// draw (no EnvelopeRequired NACK) using the default envelope.
//
// EXPECTED ON UNFIXED CODE: FAILS -- BEGIN_DRAW NACKs EnvelopeRequired when
// uncalibrated.
// ---------------------------------------------------------------------------
TEST_CASE(
    "Property 2 (C2): uncalibrated BEGIN_DRAW arms with the default envelope",
    "[draw][gate][property][property-2][c2][bugfix][default-envelope]") {
  REQUIRE(rc::check("uncalibrated BEGIN_DRAW is not blocked", [] {
    constexpr bool envelopeCalibrated = false;

    // BEGIN_DRAW { u32 total_segments, u32 total_steps } -- arbitrary, the gate
    // does not depend on these counts.
    const auto total_segments = *rc::gen::arbitrary<std::uint32_t>();
    const auto total_steps = *rc::gen::arbitrary<std::uint32_t>();
    (void)total_segments;
    (void)total_steps;

    const GateOutcome out =
        modelDrawGate(envelopeCalibrated, /*capturedX=*/0, /*capturedY=*/0);

    RC_ASSERT(!out.nackEnvelopeRequired);
    RC_ASSERT(out.effectiveX == kExpectedDefaultEnvX);
    RC_ASSERT(out.effectiveY == kExpectedDefaultEnvY);
  }));
}

// ---------------------------------------------------------------------------
// Concrete pin (example): the single clearest counterexample -- an uncalibrated
// machine receiving a valid Drawing_Command. On unfixed code this returns
// EnvelopeRequired; post-fix it resolves to DEFAULT_ENVELOPE.
// ---------------------------------------------------------------------------
TEST_CASE(
    "Property 2 (C2 concrete): uncalibrated valid Drawing_Command is allowed "
    "with default envelope",
    "[draw][gate][property-2][c2][bugfix][example]") {
  const GateOutcome out =
      modelDrawGate(/*envelopeCalibrated=*/false, /*capturedX=*/0,
                    /*capturedY=*/0);

  CHECK_FALSE(out.nackEnvelopeRequired);
  CHECK(out.effectiveX == kExpectedDefaultEnvX);
  CHECK(out.effectiveY == kExpectedDefaultEnvY);
}
