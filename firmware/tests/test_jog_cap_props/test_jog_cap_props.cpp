// Host-side property tests for the fixed per-axis jog travel cap (Task 2.2).
//
// Feature: visual-corner-calibration, Property 3
//
// Property 3: Jog travel cap is never exceeded.
//
//   *For any* sequence of jog requests (each on an arbitrary axis, in an
//   arbitrary direction, with an arbitrary step count) applied from home
//   (0,0), where each jog is applied ONLY when `jogWithinCap` permits it and a
//   refused jog leaves the position unchanged:
//     * after any such sequence the accumulated position on each axis stays
//       within the inclusive band [-JOG_TRAVEL_CAP_STEPS, +JOG_TRAVEL_CAP_STEPS];
//     * a jog that would cross the cap is refused (`jogWithinCap` returns
//       false) and leaves the position unchanged;
//   and this holds even before any envelope is captured (the cap is a fixed
//   per-session limit independent of calibration state).
//
//   Validates: Requirements 6.1, 6.2, 6.3, 6.4.
//
// This translation unit lives in its own PlatformIO test directory
// (test_jog_cap_props/) so it links into a standalone binary with its own
// `int main`, mirroring the other *_props/ suites (test_jog_props,
// test_capture_ctl_props). The unit under test is the pure, header-only
// `envelope_calibration` core: `jogWithinCap` is a constexpr free function, so
// including the header suffices -- there is no .cpp body to pull in.
//
// Properties are exercised with rapidcheck via the standalone rc::check form
// invoked from inside Catch2 TEST_CASEs; rc::check returns true on success, so
// wrapping it in REQUIRE surfaces a failing property (with rapidcheck's shrunk
// counterexample on stderr) as a Catch2 failure.
//
// Run with:
//
//     pio test -e host_test -f test_jog_cap_props

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstdint>
#include <vector>

#include "../../src/app/envelope_calibration.h"
#include "../../src/types.h"

using etch::JOG_TRAVEL_CAP_STEPS;
using etch::Position;
using etch::app::Axis;
using etch::app::jogWithinCap;

namespace {

// A single jog request: which axis it moves and by how many signed steps.
struct Jog {
  Axis axis;
  std::int32_t delta;
};

// Generate one jog: a uniformly chosen axis and a signed delta drawn wide
// enough (well past the cap on either side) that both within-cap and
// over-cap jogs occur frequently across a sequence.
Jog genJog() {
  const Axis axis = (*rc::gen::inRange(0, 2) == 0) ? Axis::X : Axis::Y;
  const std::int32_t delta = *rc::gen::inRange<std::int32_t>(
      -2 * JOG_TRAVEL_CAP_STEPS, 2 * JOG_TRAVEL_CAP_STEPS + 1);
  return Jog{axis, delta};
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 3 (sequence invariant): applying an arbitrary jog sequence from
// home, honouring `jogWithinCap` (refused jogs leave the position unchanged),
// never lets either axis leave [-cap, +cap]; and every refusal is exactly a
// would-cross-the-cap jog that leaves the position unchanged.
// ---------------------------------------------------------------------------
TEST_CASE("Property 3: a jog sequence never exceeds the fixed travel cap",
          "[jog][cap][property][property-3]") {
  REQUIRE(rc::check(
      "honouring jogWithinCap keeps both axes within +/-JOG_TRAVEL_CAP_STEPS",
      [] {
        const auto jogs = *rc::gen::container<std::vector<Jog>>(
            rc::gen::exec(genJog));

        // Start from home; no capture has happened yet (cap is independent of
        // calibration state).
        std::int32_t x = 0;
        std::int32_t y = 0;

        for (const Jog& j : jogs) {
          const std::int32_t beforeX = x;
          const std::int32_t beforeY = y;

          const bool permitted =
              jogWithinCap(x, y, j.axis, j.delta, JOG_TRAVEL_CAP_STEPS);

          if (permitted) {
            // Apply the jog on its axis only; the other axis is untouched.
            if (j.axis == Axis::X) {
              x += j.delta;
            } else {
              y += j.delta;
            }
          } else {
            // A refused jog is exactly one that would cross the cap on its
            // axis; it must leave BOTH axes unchanged.
            const std::int64_t would =
                (j.axis == Axis::X)
                    ? static_cast<std::int64_t>(beforeX) + j.delta
                    : static_cast<std::int64_t>(beforeY) + j.delta;
            RC_ASSERT(would > JOG_TRAVEL_CAP_STEPS ||
                      would < -static_cast<std::int64_t>(JOG_TRAVEL_CAP_STEPS));
          }

          // Refused jogs change nothing; this is the no-op-on-refusal facet.
          if (!permitted) {
            RC_ASSERT(x == beforeX);
            RC_ASSERT(y == beforeY);
          }

          // The headline invariant: after every step, both axes are in band.
          RC_ASSERT(x <= JOG_TRAVEL_CAP_STEPS);
          RC_ASSERT(x >= -JOG_TRAVEL_CAP_STEPS);
          RC_ASSERT(y <= JOG_TRAVEL_CAP_STEPS);
          RC_ASSERT(y >= -JOG_TRAVEL_CAP_STEPS);
        }
      }));
}

// ---------------------------------------------------------------------------
// Property 3 (per-jog predicate): from an arbitrary in-band position,
// `jogWithinCap` returns true iff the resulting jogged-axis position stays in
// [-cap, +cap], and the non-jogged axis never affects the decision.
// ---------------------------------------------------------------------------
TEST_CASE("Property 3: jogWithinCap permits iff the resulting axis is in band",
          "[jog][cap][property][property-3]") {
  REQUIRE(rc::check(
      "jogWithinCap == (resulting jogged axis within +/-cap)", [] {
        // Arbitrary current position anywhere in band on both axes.
        const std::int32_t curX = *rc::gen::inRange<std::int32_t>(
            -JOG_TRAVEL_CAP_STEPS, JOG_TRAVEL_CAP_STEPS + 1);
        const std::int32_t curY = *rc::gen::inRange<std::int32_t>(
            -JOG_TRAVEL_CAP_STEPS, JOG_TRAVEL_CAP_STEPS + 1);
        const Axis axis = (*rc::gen::inRange(0, 2) == 0) ? Axis::X : Axis::Y;
        const std::int32_t delta = *rc::gen::inRange<std::int32_t>(
            -2 * JOG_TRAVEL_CAP_STEPS, 2 * JOG_TRAVEL_CAP_STEPS + 1);

        const std::int64_t resulting =
            (axis == Axis::X) ? static_cast<std::int64_t>(curX) + delta
                              : static_cast<std::int64_t>(curY) + delta;
        const bool expected =
            resulting <= JOG_TRAVEL_CAP_STEPS &&
            resulting >= -static_cast<std::int64_t>(JOG_TRAVEL_CAP_STEPS);

        RC_ASSERT(jogWithinCap(curX, curY, axis, delta,
                               JOG_TRAVEL_CAP_STEPS) == expected);
      }));
}

// ---------------------------------------------------------------------------
// Concrete pins (plain Catch2): the boundary cases on each axis.
// ---------------------------------------------------------------------------
TEST_CASE("Property 3 (concrete): boundary jogs at the cap are permitted",
          "[jog][cap][property-3][example]") {
  // Landing exactly on +cap / -cap is allowed (inclusive band).
  CHECK(jogWithinCap(0, 0, Axis::X, JOG_TRAVEL_CAP_STEPS, JOG_TRAVEL_CAP_STEPS));
  CHECK(jogWithinCap(0, 0, Axis::Y, -JOG_TRAVEL_CAP_STEPS, JOG_TRAVEL_CAP_STEPS));
  // One step past the cap is refused.
  CHECK_FALSE(
      jogWithinCap(0, 0, Axis::X, JOG_TRAVEL_CAP_STEPS + 1, JOG_TRAVEL_CAP_STEPS));
  CHECK_FALSE(jogWithinCap(0, 0, Axis::Y, -(JOG_TRAVEL_CAP_STEPS + 1),
                           JOG_TRAVEL_CAP_STEPS));
}

TEST_CASE("Property 3 (concrete): the non-jogged axis does not affect the cap",
          "[jog][cap][property-3][example]") {
  // Y is already at the cap, but a within-band X jog is still permitted.
  CHECK(jogWithinCap(0, JOG_TRAVEL_CAP_STEPS, Axis::X, 10, JOG_TRAVEL_CAP_STEPS));
  // X is already at the cap, but a within-band Y jog is still permitted.
  CHECK(jogWithinCap(JOG_TRAVEL_CAP_STEPS, 0, Axis::Y, -10, JOG_TRAVEL_CAP_STEPS));
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
