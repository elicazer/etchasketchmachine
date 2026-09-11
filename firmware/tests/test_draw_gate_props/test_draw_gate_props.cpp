// Host-side property tests for the firmware drawing gate (Task 2.5).
//
// Feature: visual-corner-calibration, Property 2
//
// Property 2: Drawing gate blocks unless envelope-calibrated, with no fallback
// (firmware side).
//
//   *For any* (homeSet, envelopeCaptured) boolean pair, `drawingPermitted`
//   returns true if and only if BOTH are true; every other combination is
//   blocked. There is no gear-math fallback path -- the gate predicate is the
//   only way drawing is enabled.
//
//   Validates: Requirements 4.1, 4.2, 4.3, 5.1, 5.2, 5.3.
//
// This translation unit lives in its own PlatformIO test directory
// (test_draw_gate_props/) so it links into a standalone binary with its own
// `int main`, mirroring the other *_props/ suites. The unit under test is the
// pure, header-only `envelope_calibration` core: `drawingPermitted` is a
// constexpr free function, so including the header suffices.
//
// Properties are exercised with rapidcheck via the standalone rc::check form
// invoked from inside Catch2 TEST_CASEs.
//
// Run with:
//
//     pio test -e host_test -f test_draw_gate_props

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include "../../src/app/envelope_calibration.h"

using etch::app::drawingPermitted;

// ---------------------------------------------------------------------------
// Property 2: drawingPermitted is exactly the conjunction of the two gate bits.
// ---------------------------------------------------------------------------
TEST_CASE("Property 2: drawing permitted iff home set AND envelope captured",
          "[draw][gate][property][property-2]") {
  REQUIRE(rc::check("drawingPermitted(h,e) == (h && e)", [] {
    const auto homeSet = *rc::gen::arbitrary<bool>();
    const auto envelopeCaptured = *rc::gen::arbitrary<bool>();

    RC_ASSERT(drawingPermitted(homeSet, envelopeCaptured) ==
              (homeSet && envelopeCaptured));

    // No-fallback facet: if either bit is false, drawing is blocked outright.
    if (!homeSet || !envelopeCaptured) {
      RC_ASSERT(!drawingPermitted(homeSet, envelopeCaptured));
    }
  }));
}

// ---------------------------------------------------------------------------
// Concrete pins (plain Catch2): the full 2x2 truth table.
// ---------------------------------------------------------------------------
TEST_CASE("Property 2 (concrete): the gate truth table",
          "[draw][gate][property-2][example]") {
  CHECK(drawingPermitted(true, true));
  CHECK_FALSE(drawingPermitted(true, false));
  CHECK_FALSE(drawingPermitted(false, true));
  CHECK_FALSE(drawingPermitted(false, false));
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
