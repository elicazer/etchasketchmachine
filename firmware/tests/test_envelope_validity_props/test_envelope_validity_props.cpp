// Host-side property tests for envelope validity (Task 2.3).
//
// Feature: visual-corner-calibration, Property 5
//
// Property 5: Envelope accepted iff both axes are positive.
//
//   *For any* measured count pair (mx, my) -- including zero and negative
//   values on either axis -- `isValidEnvelope(mx, my)` returns true if and only
//   if `mx > 0 && my > 0`. Every other combination is rejected, modelling the
//   capture being refused and the captured state staying cleared.
//
//   Validates: Requirements 2.1, 2.2, 2.3.
//
// This translation unit lives in its own PlatformIO test directory
// (test_envelope_validity_props/) so it links into a standalone binary with its
// own `int main`, mirroring the other *_props/ suites. The unit under test is
// the pure, header-only `envelope_calibration` core: `isValidEnvelope` is a
// constexpr free function, so including the header suffices.
//
// Properties are exercised with rapidcheck via the standalone rc::check form
// invoked from inside Catch2 TEST_CASEs.
//
// Run with:
//
//     pio test -e host_test -f test_envelope_validity_props

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstdint>

#include "../../src/app/envelope_calibration.h"

using etch::app::isValidEnvelope;

// ---------------------------------------------------------------------------
// Property 5 (full range): for arbitrary (mx, my) across the entire int32
// range, validity is exactly the conjunction of both axes being strictly
// positive.
// ---------------------------------------------------------------------------
TEST_CASE("Property 5: envelope is valid iff both axes are strictly positive",
          "[envelope][validity][property][property-5]") {
  REQUIRE(rc::check("isValidEnvelope(mx,my) == (mx > 0 && my > 0)", [] {
    const auto mx = *rc::gen::arbitrary<std::int32_t>();
    const auto my = *rc::gen::arbitrary<std::int32_t>();

    const bool expected = (mx > 0) && (my > 0);
    RC_ASSERT(isValidEnvelope(mx, my) == expected);
  }));
}

// ---------------------------------------------------------------------------
// Property 5 (boundary focus): bias the generators toward {negative, zero,
// positive} on each axis so the zero/negative rejection cases (Req 2.2/2.3)
// are exercised densely rather than only at the random-range tails.
// ---------------------------------------------------------------------------
TEST_CASE("Property 5: zero or negative on either axis is rejected",
          "[envelope][validity][property][property-5]") {
  REQUIRE(rc::check("near-boundary (mx,my) accepted iff both strictly > 0", [] {
    // Draw each axis from a small band straddling zero so we hit -1, 0, +1 etc.
    const auto mx = *rc::gen::inRange<std::int32_t>(-3, 4);
    const auto my = *rc::gen::inRange<std::int32_t>(-3, 4);

    const bool expected = (mx > 0) && (my > 0);
    RC_ASSERT(isValidEnvelope(mx, my) == expected);

    // Spell out the rejection clauses explicitly for the boundary band.
    if (mx <= 0 || my <= 0) {
      RC_ASSERT(!isValidEnvelope(mx, my));
    }
  }));
}

// ---------------------------------------------------------------------------
// Concrete pins (plain Catch2): the canonical accept/reject cases.
// ---------------------------------------------------------------------------
TEST_CASE("Property 5 (concrete): strictly-positive pair is accepted",
          "[envelope][validity][property-5][example]") {
  CHECK(isValidEnvelope(1, 1));
  CHECK(isValidEnvelope(40000, 30000));
}

TEST_CASE("Property 5 (concrete): zero or negative axis is rejected",
          "[envelope][validity][property-5][example]") {
  CHECK_FALSE(isValidEnvelope(0, 0));
  CHECK_FALSE(isValidEnvelope(0, 100));
  CHECK_FALSE(isValidEnvelope(100, 0));
  CHECK_FALSE(isValidEnvelope(-1, 100));
  CHECK_FALSE(isValidEnvelope(100, -1));
  CHECK_FALSE(isValidEnvelope(-5, -5));
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
