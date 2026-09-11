// Host-side FIX-CHECKING property test (Task 7.4, bugfix drawing-motion-fix,
// Defect 2 resolver selection).
//
//   **Validates: Requirements 2.5, 2.6, 2.7**
//
// Resolver selection (host PBT): for random PersistedConfigs, the REAL
// app::effectiveEnvelope() resolver returns the CAPTURED envelope iff the
// machine is envelope-calibrated (NVM_FLAG_ENVELOPE_CALIBRATED set) AND the
// stored pair is a valid (strictly positive) envelope; otherwise it returns the
// baked-in, bounded DEFAULT_ENVELOPE (X=2158, Y=1650). This pins the
// "captured-iff-calibrated-and-valid else default" contract from the design
// across the whole config domain, including the uncalibrated and
// calibrated-but-degenerate edge cases.
//
// This file defines NO `int main` -- the sibling test_draw_gate_props.cpp
// provides the Catch2 session main, and PlatformIO links every .cpp in this
// test directory into one binary, so the TEST_CASEs below auto-register into
// that shared session.
//
// Run with:
//
//     pio test -e host_test -f test_draw_gate_props

#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstdint>

#include "../../src/app/envelope_calibration.h"
#include "../../src/types.h"

using etch::DEFAULT_ENVELOPE_X_STEPS;
using etch::DEFAULT_ENVELOPE_Y_STEPS;
using etch::NVM_FLAG_ENVELOPE_CALIBRATED;
using etch::PersistedConfig;
using etch::app::effectiveEnvelope;
using etch::app::isValidEnvelope;
using etch::app::MeasuredEnvelope;

namespace {

constexpr std::int32_t kDefaultX =
    static_cast<std::int32_t>(DEFAULT_ENVELOPE_X_STEPS);
constexpr std::int32_t kDefaultY =
    static_cast<std::int32_t>(DEFAULT_ENVELOPE_Y_STEPS);

}  // namespace

// ---------------------------------------------------------------------------
// Resolver selection: captured iff calibrated+valid, else DEFAULT_ENVELOPE.
// ---------------------------------------------------------------------------
TEST_CASE(
    "Resolver selection: effectiveEnvelope returns captured iff "
    "calibrated+valid, else default",
    "[draw][gate][property][bugfix][default-envelope][resolver]") {
  REQUIRE(rc::check("effectiveEnvelope captured-iff-calibrated-and-valid", [] {
    // Random calibration bit and random captured envelope dimensions spanning
    // the full unsigned-32 range so invalid (zero) and valid pairs both occur.
    const bool calibrated = *rc::gen::arbitrary<bool>();
    const auto capturedX = *rc::gen::arbitrary<std::uint32_t>();
    const auto capturedY = *rc::gen::arbitrary<std::uint32_t>();

    PersistedConfig cfg{};
    // Random non-envelope flag bits should not influence the resolver; only the
    // envelope-calibrated bit matters.
    cfg.flags = static_cast<std::uint8_t>(
        (*rc::gen::arbitrary<std::uint8_t>() &
         static_cast<std::uint8_t>(~NVM_FLAG_ENVELOPE_CALIBRATED)) |
        (calibrated ? NVM_FLAG_ENVELOPE_CALIBRATED : 0));
    cfg.envelope_x_steps = capturedX;
    cfg.envelope_y_steps = capturedY;

    const MeasuredEnvelope eff = effectiveEnvelope(cfg);

    const bool calibratedBit = (cfg.flags & NVM_FLAG_ENVELOPE_CALIBRATED) != 0;
    const std::int32_t sx = static_cast<std::int32_t>(capturedX);
    const std::int32_t sy = static_cast<std::int32_t>(capturedY);
    const bool useCaptured = calibratedBit && isValidEnvelope(sx, sy);

    if (useCaptured) {
      // Captured overrides default (Req 2.6 / 3.5).
      RC_ASSERT(eff.x == sx);
      RC_ASSERT(eff.y == sy);
    } else {
      // Bounded fallback (Req 2.5).
      RC_ASSERT(eff.x == kDefaultX);
      RC_ASSERT(eff.y == kDefaultY);
    }
  }));
}

// ---------------------------------------------------------------------------
// Concrete pins for the three meaningful selection cases.
// ---------------------------------------------------------------------------
TEST_CASE("Resolver selection (concrete) cases",
          "[draw][gate][property][bugfix][default-envelope][resolver][example]") {
  // Calibrated + valid => captured.
  {
    PersistedConfig cfg{};
    cfg.flags = NVM_FLAG_ENVELOPE_CALIBRATED;
    cfg.envelope_x_steps = 4000;
    cfg.envelope_y_steps = 3000;
    const MeasuredEnvelope eff = effectiveEnvelope(cfg);
    CHECK(eff.x == 4000);
    CHECK(eff.y == 3000);
  }
  // Uncalibrated (even with a valid-looking stored pair) => default.
  {
    PersistedConfig cfg{};
    cfg.flags = 0;
    cfg.envelope_x_steps = 4000;
    cfg.envelope_y_steps = 3000;
    const MeasuredEnvelope eff = effectiveEnvelope(cfg);
    CHECK(eff.x == kDefaultX);
    CHECK(eff.y == kDefaultY);
  }
  // Calibrated but degenerate (zero on an axis) => default.
  {
    PersistedConfig cfg{};
    cfg.flags = NVM_FLAG_ENVELOPE_CALIBRATED;
    cfg.envelope_x_steps = 0;
    cfg.envelope_y_steps = 3000;
    const MeasuredEnvelope eff = effectiveEnvelope(cfg);
    CHECK(eff.x == kDefaultX);
    CHECK(eff.y == kDefaultY);
  }
}
