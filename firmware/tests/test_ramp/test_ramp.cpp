// Host-side unit tests for the trapezoidal speed-ramp generator (Task 6.3).
//
// Verifies that the firmware ramp in firmware/src/motion/ramp.cpp produces the
// same unimodal trapezoid/triangle schedule as the browser mirror in
// web/src/path/ramp.ts. Run with:
//
//     pio test -e host_test
//
// The host_test environment sets `test_build_src = no`, so this translation
// unit pulls the implementation in via a relative include to stay
// self-contained (same pattern as tests/test_crc16/test_crc16.cpp).

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>

#include "../../src/motion/ramp.h"
#include "../../src/motion/ramp.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::FEED_SPS_MAX;
using etch::FEED_SPS_MIN;
using etch::RAMP_MIN_SPS;
using etch::SPEED_PCT_MAX;
using etch::SPEED_PCT_MIN;
using etch::motion::TrapezoidRamp;

namespace {

// Highest sps anywhere in the schedule.
std::uint16_t maxSpeed(const TrapezoidRamp& r) {
  std::uint16_t hi = 0;
  for (std::uint32_t i = 0; i < r.steps(); ++i) {
    const std::uint16_t v = r.speedAt(i);
    if (v > hi) hi = v;
  }
  return hi;
}

// Verifies the four core Property-5 invariants over the whole schedule:
//   - endpoints clamped to vMin
//   - non-decreasing then non-increasing (single hump)
//   - never exceeds the post-speedPct peak
//   - consecutive deltas bounded by accel
void checkSchedule(const TrapezoidRamp& r) {
  const std::uint32_t n = r.steps();
  REQUIRE(n >= 1u);

  // Endpoints sit at vMin.
  CHECK(r.speedAt(0) == r.vMin());
  CHECK(r.speedAt(n - 1) == r.vMin());

  bool decreasing = false;  // flips true once we cross the hump
  for (std::uint32_t i = 0; i + 1 < n; ++i) {
    const std::uint16_t cur = r.speedAt(i);
    const std::uint16_t nxt = r.speedAt(i + 1);

    // Bound: every sample within [vMin, peak].
    CHECK(cur >= r.vMin());
    CHECK(cur <= r.peak());

    // Consecutive delta bounded by accel (symmetric on both ramps).
    const int delta = static_cast<int>(nxt) - static_cast<int>(cur);
    const int mag = delta < 0 ? -delta : delta;
    CHECK(mag <= static_cast<int>(r.accel()));

    // Unimodality: once the sequence starts decreasing it must not rise again.
    if (nxt < cur) {
      decreasing = true;
    } else if (nxt > cur) {
      CHECK_FALSE(decreasing);
    }
  }
  CHECK(r.speedAt(n - 1) <= r.peak());
}

}  // namespace

TEST_CASE("TrapezoidRamp: endpoints clamp to vMin", "[ramp]") {
  TrapezoidRamp r(50, FEED_SPS_MIN, 800, 50);
  REQUIRE(r.valid());
  CHECK(r.speedAt(0) == FEED_SPS_MIN);
  CHECK(r.speedAt(r.steps() - 1) == FEED_SPS_MIN);
}

TEST_CASE("TrapezoidRamp: long segment forms a full trapezoid with plateau",
          "[ramp]") {
  // 200 steps, accel 50 sps/step: the up-ramp needs (700/50)=14 steps to reach
  // the 800 sps peak, so a plateau exists.
  TrapezoidRamp r(200, FEED_SPS_MIN, 800, 50);
  REQUIRE(r.valid());
  CHECK(r.peak() == 800);
  CHECK(maxSpeed(r) == 800);   // plateau actually reached
  CHECK(maxSpeed(r) <= r.peak());
  checkSchedule(r);
}

TEST_CASE("TrapezoidRamp: peak is never exceeded after speedPct clamp",
          "[ramp]") {
  TrapezoidRamp r(120, FEED_SPS_MIN, 1000, 40, 75);
  REQUIRE(r.valid());
  // peak = min(1000, max(100, 1000*75/100)) = 750.
  CHECK(r.peak() == 750);
  CHECK(maxSpeed(r) <= r.peak());
  checkSchedule(r);
}

TEST_CASE("TrapezoidRamp: single hump (non-decreasing then non-increasing)",
          "[ramp]") {
  TrapezoidRamp r(64, FEED_SPS_MIN, 600, 25);
  REQUIRE(r.valid());
  checkSchedule(r);
}

TEST_CASE("TrapezoidRamp: consecutive deltas are bounded by accel", "[ramp]") {
  // Sweep a few accel values to exercise both short and long ramps.
  for (std::uint16_t accel : {1, 10, 37, 100, 250}) {
    TrapezoidRamp r(80, FEED_SPS_MIN, 900, accel);
    REQUIRE(r.valid());
    for (std::uint32_t i = 0; i + 1 < r.steps(); ++i) {
      const int delta =
          static_cast<int>(r.speedAt(i + 1)) - static_cast<int>(r.speedAt(i));
      const int mag = delta < 0 ? -delta : delta;
      CHECK(mag <= static_cast<int>(accel));
    }
  }
}

TEST_CASE("TrapezoidRamp: short segment is triangular and never reaches vPeak",
          "[ramp]") {
  // Only 6 steps with a modest accel: the up- and down-ramps meet well below
  // the configured 1000 sps peak, so the profile is a triangle.
  TrapezoidRamp r(6, FEED_SPS_MIN, 1000, 50);
  REQUIRE(r.valid());
  CHECK(r.peak() == 1000);          // configured target...
  CHECK(maxSpeed(r) < r.peak());    // ...but the segment is too short to reach it
  // Apex is the middle step. last=5, mid=2 (and 3 by symmetry).
  // apex = vMin + min(2,3)*accel = 100 + 2*50 = 200.
  CHECK(r.speedAt(2) == 200);
  CHECK(r.speedAt(3) == 200);
  checkSchedule(r);
}

TEST_CASE("TrapezoidRamp: speedPct=50 halves the achievable peak", "[ramp]") {
  TrapezoidRamp full(400, FEED_SPS_MIN, 800, 30, 100);
  TrapezoidRamp half(400, FEED_SPS_MIN, 800, 30, 50);
  REQUIRE(full.valid());
  REQUIRE(half.valid());

  CHECK(full.peak() == 800);
  CHECK(half.peak() == 400);  // 800 * 50 / 100

  // Both segments are long enough to reach their respective plateaus.
  CHECK(maxSpeed(full) == 800);
  CHECK(maxSpeed(half) == 400);

  // Halving relationship holds within integer rounding (exact here).
  CHECK(static_cast<int>(half.peak()) ==
        static_cast<int>(full.peak()) / 2);
  checkSchedule(full);
  checkSchedule(half);
}

TEST_CASE("TrapezoidRamp: low speedPct can clamp the peak up to vMin",
          "[ramp]") {
  // vPeak=120, speedPct=25 -> scaled=30, clamped up to vMin=100. The whole
  // segment runs flat at vMin (degenerate trapezoid).
  TrapezoidRamp r(20, FEED_SPS_MIN, 120, 10, 25);
  REQUIRE(r.valid());
  CHECK(r.peak() == FEED_SPS_MIN);
  for (std::uint32_t i = 0; i < r.steps(); ++i) {
    CHECK(r.speedAt(i) == FEED_SPS_MIN);
  }
}

TEST_CASE("TrapezoidRamp: single-step segment stays at vMin", "[ramp]") {
  TrapezoidRamp r(1, FEED_SPS_MIN, 1000, 50);
  REQUIRE(r.valid());
  CHECK(r.steps() == 1u);
  CHECK(r.speedAt(0) == FEED_SPS_MIN);
}

TEST_CASE("TrapezoidRamp: speedAt clamps out-of-range indices to the last step",
          "[ramp]") {
  TrapezoidRamp r(10, FEED_SPS_MIN, 500, 40);
  REQUIRE(r.valid());
  CHECK(r.speedAt(9) == r.speedAt(100));   // saturates at last index
  CHECK(r.speedAt(100) == FEED_SPS_MIN);   // ...which is vMin
}

TEST_CASE("TrapezoidRamp: out-of-range inputs are clamped and flagged invalid",
          "[ramp]") {
  // vMin below the ramp pull-in floor, vPeak above ceiling, accel zero,
  // speedPct out of band. vMin clamps up to RAMP_MIN_SPS (the motion pull-in
  // floor, BELOW the protocol FEED_SPS_MIN), not FEED_SPS_MIN.
  TrapezoidRamp r(0, 1, 5000, 0, 5);
  CHECK_FALSE(r.valid());
  CHECK(r.steps() >= 1u);
  CHECK(r.vMin() >= RAMP_MIN_SPS);
  CHECK(r.vPeak() <= FEED_SPS_MAX);
  CHECK(r.accel() >= 1u);
  CHECK(r.speedPct() >= SPEED_PCT_MIN);
  CHECK(r.speedPct() <= SPEED_PCT_MAX);
  // Even after clamping the schedule remains well-formed.
  checkSchedule(r);
}

TEST_CASE("TrapezoidRamp: starts at the sub-floor pull-in speed when asked",
          "[ramp]") {
  // The motion planner starts every segment's ramp at MOTION_START_SPS, which
  // is below the protocol FEED_SPS_MIN. A ramp configured with such a vMin is
  // valid (no clamping) and its endpoints sit at that sub-floor start speed so
  // the motor eases in from its pull-in rate.
  using etch::MOTION_START_SPS;
  TrapezoidRamp r(50, MOTION_START_SPS, 800, 50);
  REQUIRE(r.valid());
  CHECK(r.vMin() == MOTION_START_SPS);
  CHECK(r.speedAt(0) == MOTION_START_SPS);
  CHECK(r.speedAt(r.steps() - 1) == MOTION_START_SPS);
  CHECK(MOTION_START_SPS < FEED_SPS_MIN);
  checkSchedule(r);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
