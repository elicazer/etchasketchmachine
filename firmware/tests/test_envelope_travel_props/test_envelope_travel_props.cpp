// Host-side property tests for envelope = own accumulated travel (Task 2.4).
//
// Feature: visual-corner-calibration, Property 6
//
// Property 6: Envelope equals the Controller's own accumulated travel.
//
//   *For any* sequence of within-cap jogs applied after a bottom-left capture
//   that put home at logical (0,0), `measureEnvelope` over the resulting
//   position equals the absolute net step displacement per axis since the
//   capture -- i.e. { |net dx|, |net dy| } computed independently from the same
//   jog sequence. The envelope is derived solely from the Controller's own
//   counters and never from any SPA-supplied value.
//
//   Validates: Requirements 1.5, 1.6.
//
// This translation unit lives in its own PlatformIO test directory
// (test_envelope_travel_props/) so it links into a standalone binary with its
// own `int main`, mirroring the other *_props/ suites. The unit under test is
// the pure, header-only `envelope_calibration` core: `measureEnvelope` and
// `jogWithinCap` are constexpr free functions, so including the header
// suffices.
//
// Properties are exercised with rapidcheck via the standalone rc::check form
// invoked from inside Catch2 TEST_CASEs.
//
// Run with:
//
//     pio test -e host_test -f test_envelope_travel_props

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
using etch::app::measureEnvelope;
using etch::app::MeasuredEnvelope;

namespace {

struct Jog {
  Axis axis;
  std::int32_t delta;
};

Jog genJog() {
  const Axis axis = (*rc::gen::inRange(0, 2) == 0) ? Axis::X : Axis::Y;
  // Wide enough to sometimes propose an over-cap jog so the within-cap
  // filtering is genuinely exercised.
  const std::int32_t delta = *rc::gen::inRange<std::int32_t>(
      -2 * JOG_TRAVEL_CAP_STEPS, 2 * JOG_TRAVEL_CAP_STEPS + 1);
  return Jog{axis, delta};
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 6: simulate the Controller applying a within-cap jog sequence from
// home (0,0) after a bottom-left capture, and independently accumulate the net
// displacement per axis. measureEnvelope over the resulting position must equal
// the absolute net displacement on each axis.
// ---------------------------------------------------------------------------
TEST_CASE("Property 6: measured envelope equals own accumulated travel",
          "[envelope][travel][property][property-6]") {
  REQUIRE(rc::check(
      "measureEnvelope(pos) == { |net dx|, |net dy| } since capture", [] {
        const auto jogs = *rc::gen::container<std::vector<Jog>>(
            rc::gen::exec(genJog));

        // Controller-side simulation: home at (0,0), apply each jog only when
        // within the fixed travel cap (refused jogs leave position unchanged).
        std::int32_t posX = 0;
        std::int32_t posY = 0;
        // Independent accounting of net displacement per axis.
        std::int64_t netX = 0;
        std::int64_t netY = 0;

        for (const Jog& j : jogs) {
          if (!jogWithinCap(posX, posY, j.axis, j.delta,
                            JOG_TRAVEL_CAP_STEPS)) {
            continue;  // over-cap jog refused: no change to position or net.
          }
          if (j.axis == Axis::X) {
            posX += j.delta;
            netX += j.delta;
          } else {
            posY += j.delta;
            netY += j.delta;
          }
        }

        const Position resulting{posX, posY};
        const MeasuredEnvelope env = measureEnvelope(resulting);

        const std::int64_t absNetX = netX < 0 ? -netX : netX;
        const std::int64_t absNetY = netY < 0 ? -netY : netY;

        // The envelope is exactly the per-axis absolute net travel...
        RC_ASSERT(static_cast<std::int64_t>(env.x) == absNetX);
        RC_ASSERT(static_cast<std::int64_t>(env.y) == absNetY);
        // ...and it equals |resulting position| since home was (0,0).
        RC_ASSERT(env.x == (posX < 0 ? -posX : posX));
        RC_ASSERT(env.y == (posY < 0 ? -posY : posY));
      }));
}

// ---------------------------------------------------------------------------
// Concrete pins (plain Catch2): a simple two-axis travel and a back-and-forth
// that nets a smaller envelope than the gross travel.
// ---------------------------------------------------------------------------
TEST_CASE("Property 6 (concrete): envelope is the net per-axis magnitude",
          "[envelope][travel][property-6][example]") {
  // Net travel +1200 X, +800 Y -> envelope {1200, 800}.
  const MeasuredEnvelope a = measureEnvelope(Position{1200, 800});
  CHECK(a.x == 1200);
  CHECK(a.y == 800);

  // A top-right capture reached by jogging right then partway back still
  // measures the net position, not the gross distance travelled.
  std::int32_t x = 0;
  x += 1000;  // jog right
  x -= 300;   // jog left
  const MeasuredEnvelope b = measureEnvelope(Position{x, 0});
  CHECK(b.x == 700);
  CHECK(b.y == 0);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
