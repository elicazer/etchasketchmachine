// Host-side property tests for the trapezoidal speed-ramp generator (Task 6.4).
//
// Property 5: Trapezoidal speed schedule monotonicity and bounds (Design §7,
// §2.4.2).
//
//   *For any* segment of `steps >= 1` with a configured peak
//   `vPeak in [vMin, FEED_SPS_MAX]`, minimum `vMin >= FEED_SPS_MIN`, positive
//   per-step acceleration, and live speed-percent scaling
//   `speedPct in [SPEED_PCT_MIN, SPEED_PCT_MAX]`, the schedule
//   `v[i] = TrapezoidRamp::speedAt(i)` for `i in [0, steps)`:
//
//     1. has exactly `steps` entries;
//     2. starts and ends at `vMin`;
//     3. never drops below `vMin` and never exceeds either the post-speedPct
//        peak or FEED_SPS_MAX (Req 5.5, 6.3);
//     4. is non-decreasing up to an apex then non-increasing -- a single hump
//        (Req 5.5: trapezoid / triangle profile);
//     5. has consecutive deltas bounded by the configured acceleration step
//        (Req 9.8: ramp continuity);
//     6. collapses to a triangle (the apex stays strictly below the configured
//        peak) whenever the segment is too short to reach it, i.e. when
//        `2 * rampLen > steps` where `rampLen = ceil((peak - vMin) / accel)`;
//     7. exposes an achievable peak that scales monotonically with `speedPct`
//        and equals `clamp(vPeak * speedPct / 100, vMin, FEED_SPS_MAX)`
//        (Req 9.7, 9.8: the live slider scales the achievable maximum).
//
//   Validates: Requirements 5.5, 6.3, 9.7, 9.8.
//
// This is the firmware mirror of the browser-side Property 5 in
// web/src/path/ramp.prop.test.ts (Task 22.2). Both sides MUST agree on the
// per-step speed so the preview estimate matches the executed motion; the
// invariants below are intentionally the same set the web mirror checks, with
// the addition of the integer-exact peak oracle (firmware uses integer math,
// so there is no IEEE drift to absorb -- every check is exact).
//
// This translation unit lives in its own PlatformIO test directory
// (test_ramp_props/) so it is compiled and linked into a standalone test
// binary, separate from test_ramp/. It therefore supplies its own `int main`
// and pulls the implementation in directly via a relative include of ramp.cpp
// -- mirroring the conventions in test_ramp/, test_command_parser_props/, and
// test_nvm_props/ -- so the host_test environment (test_build_src = no) stays
// self-contained with a single definition of TrapezoidRamp's symbols.
//
// The properties are exercised with rapidcheck via the standalone rc::check
// form invoked from inside Catch2 TEST_CASEs (mirroring test_nvm_props/).
// rc::check returns true on success; wrapping it in REQUIRE means a failing
// property (with rapidcheck's shrunk counterexample on stderr) surfaces as a
// Catch2 failure.
//
// Run with:
//
//     pio test -e host_test
//
// (PlatformIO pins Catch2 v3.5.3 and rapidcheck for the host_test env; see
// platformio.ini.)

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstdint>

#include "../../src/types.h"
#include "../../src/motion/ramp.h"
#include "../../src/motion/ramp.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::FEED_SPS_MAX;
using etch::FEED_SPS_MIN;
using etch::SPEED_PCT_MAX;
using etch::SPEED_PCT_MIN;
using etch::motion::TrapezoidRamp;

namespace {

// Parameters for one valid ramp. Kept separate from the constructed ramp so the
// properties can assert against the *requested* envelope as an independent
// oracle (the accessors echo these back unchanged whenever valid() is true).
struct RampParams {
  std::uint32_t steps;
  std::uint16_t vMin;
  std::uint16_t vPeak;
  std::uint16_t accel;
  std::uint8_t speedPct;
};

// Highest sps anywhere in the schedule.
std::uint16_t maxSpeed(const TrapezoidRamp& r) {
  std::uint16_t hi = 0;
  for (std::uint32_t i = 0; i < r.steps(); ++i) {
    const std::uint16_t v = r.speedAt(i);
    if (v > hi) hi = v;
  }
  return hi;
}

// Integer clamp of v into [lo, hi]; callers guarantee lo <= hi.
std::uint16_t clamp16(std::uint16_t v, std::uint16_t lo, std::uint16_t hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// Independent oracle for the post-speedPct peak the schedule should target:
//   clamp(vPeak * speedPct / 100, vMin, FEED_SPS_MAX).
// Mirrors ramp.cpp / web ramp.ts but is computed here from the raw params so it
// is a true oracle rather than a tautology against the implementation.
std::uint16_t expectedPeak(std::uint16_t vMin, std::uint16_t vPeak,
                           std::uint8_t speedPct) {
  const std::uint32_t scaled =
      (static_cast<std::uint32_t>(vPeak) * static_cast<std::uint32_t>(speedPct)) /
      100u;
  const std::uint16_t scaled16 =
      scaled > FEED_SPS_MAX ? FEED_SPS_MAX : static_cast<std::uint16_t>(scaled);
  return clamp16(scaled16, vMin, FEED_SPS_MAX);
}

// Number of steps the up-ramp needs to climb from vMin to the (post-speedPct)
// peak: ceil((peak - vMin) / accel). The plateau exists iff 2*rampLen <=
// steps-1; conversely 2*rampLen > steps guarantees the apex never reaches peak
// (a triangular profile). Computed from the ramp's own accessors so it tracks
// whatever peak the implementation settled on.
std::uint32_t rampLenToPeak(const TrapezoidRamp& r) {
  const std::uint32_t headroom = static_cast<std::uint32_t>(r.peak() - r.vMin());
  const std::uint32_t a = r.accel();  // accel() >= 1 by init()
  return (headroom + a - 1u) / a;     // ceil(headroom / a)
}

// ---------------------------------------------------------------------------
// rapidcheck generators (called from inside rc::check via operator*).
// ---------------------------------------------------------------------------

// A fully valid parameter tuple. vPeak is sampled *after* vMin so it is always
// >= vMin (init() would otherwise clamp and flag invalid). vMin is capped at
// 600 so there is room above it for a meaningful peak while staying inside the
// [FEED_SPS_MIN, FEED_SPS_MAX] envelope.
RampParams genValidParams() {
  RampParams p;
  p.steps = static_cast<std::uint32_t>(*rc::gen::inRange<int>(1, 2001));  // [1,2000]
  p.vMin = static_cast<std::uint16_t>(
      *rc::gen::inRange<int>(FEED_SPS_MIN, 601));  // [100, 600]
  p.vPeak = static_cast<std::uint16_t>(
      *rc::gen::inRange<int>(p.vMin, FEED_SPS_MAX + 1));  // [vMin, 1000]
  p.accel = static_cast<std::uint16_t>(*rc::gen::inRange<int>(1, 301));  // [1,300]
  p.speedPct = static_cast<std::uint8_t>(
      *rc::gen::inRange<int>(SPEED_PCT_MIN, SPEED_PCT_MAX + 1));  // [25,100]
  return p;
}

// A deliberately *short* segment paired with a *high* peak and *small* accel so
// the up- and down-ramps meet well below the peak. This biases generation
// toward the triangular branch (2*rampLen > steps) so Property 6 is exercised
// in practice, not just asserted vacuously.
RampParams genShortParams() {
  RampParams p;
  p.steps = static_cast<std::uint32_t>(*rc::gen::inRange<int>(2, 40));  // short
  p.vMin = static_cast<std::uint16_t>(
      *rc::gen::inRange<int>(FEED_SPS_MIN, 401));  // [100, 400]
  p.vPeak = static_cast<std::uint16_t>(
      *rc::gen::inRange<int>(700, FEED_SPS_MAX + 1));  // [700, 1000]
  p.accel = static_cast<std::uint16_t>(*rc::gen::inRange<int>(1, 30));  // [1,29]
  p.speedPct = SPEED_PCT_MAX;  // full slider so the configured peak stays high
  return p;
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 5.1: LENGTH -- the schedule has exactly `steps` entries.
// ---------------------------------------------------------------------------
TEST_CASE("Property 5: schedule length equals the requested step count",
          "[ramp][property][property-5]") {
  REQUIRE(rc::check("steps() == requested steps", [] {
    const RampParams p = genValidParams();
    TrapezoidRamp r(p.steps, p.vMin, p.vPeak, p.accel, p.speedPct);
    RC_ASSERT(r.valid());  // all inputs in range -> no clamping
    RC_ASSERT(r.steps() == p.steps);
  }));
}

// ---------------------------------------------------------------------------
// Property 5.2: ENDPOINTS -- first and last step both run at vMin.
// ---------------------------------------------------------------------------
TEST_CASE("Property 5: endpoints clamp to vMin",
          "[ramp][property][property-5]") {
  REQUIRE(rc::check("speedAt(0) == speedAt(last) == vMin", [] {
    const RampParams p = genValidParams();
    TrapezoidRamp r(p.steps, p.vMin, p.vPeak, p.accel, p.speedPct);
    RC_ASSERT(r.valid());
    RC_ASSERT(r.speedAt(0) == p.vMin);
    RC_ASSERT(r.speedAt(r.steps() - 1u) == p.vMin);
  }));
}

// ---------------------------------------------------------------------------
// Property 5.3: BOUNDS -- every sample lies in [vMin, peak] and never exceeds
// FEED_SPS_MAX (Req 5.5, 6.3).
// ---------------------------------------------------------------------------
TEST_CASE("Property 5: every sample is within [vMin, peak] and <= FEED_SPS_MAX",
          "[ramp][property][property-5]") {
  REQUIRE(rc::check("vMin <= v[i] <= peak <= FEED_SPS_MAX", [] {
    const RampParams p = genValidParams();
    TrapezoidRamp r(p.steps, p.vMin, p.vPeak, p.accel, p.speedPct);
    RC_ASSERT(r.valid());
    for (std::uint32_t i = 0; i < r.steps(); ++i) {
      const std::uint16_t v = r.speedAt(i);
      RC_ASSERT(v >= r.vMin());
      RC_ASSERT(v <= r.peak());
      RC_ASSERT(v <= FEED_SPS_MAX);
    }
  }));
}

// ---------------------------------------------------------------------------
// Property 5.4: SINGLE HUMP -- non-decreasing up to an apex, then
// non-increasing (Req 5.5). Find the apex as the end of the leading
// non-decreasing run, then assert the remainder is non-increasing.
// ---------------------------------------------------------------------------
TEST_CASE("Property 5: schedule is unimodal (rises to an apex then falls)",
          "[ramp][property][property-5]") {
  REQUIRE(rc::check("non-decreasing then non-increasing about the apex", [] {
    const RampParams p = genValidParams();
    TrapezoidRamp r(p.steps, p.vMin, p.vPeak, p.accel, p.speedPct);
    RC_ASSERT(r.valid());

    const std::uint32_t n = r.steps();
    // Advance through the leading non-decreasing run to locate the apex.
    std::uint32_t apex = 0;
    while (apex + 1u < n && r.speedAt(apex + 1u) >= r.speedAt(apex)) {
      ++apex;
    }
    // Everything past the apex must be non-increasing.
    for (std::uint32_t i = apex; i + 1u < n; ++i) {
      RC_ASSERT(r.speedAt(i + 1u) <= r.speedAt(i));
    }
  }));
}

// ---------------------------------------------------------------------------
// Property 5.5: ACCEL BOUND -- consecutive speeds differ by at most accel
// (Req 9.8).
// ---------------------------------------------------------------------------
TEST_CASE("Property 5: consecutive deltas are bounded by accel",
          "[ramp][property][property-5]") {
  REQUIRE(rc::check("|v[i+1] - v[i]| <= accel", [] {
    const RampParams p = genValidParams();
    TrapezoidRamp r(p.steps, p.vMin, p.vPeak, p.accel, p.speedPct);
    RC_ASSERT(r.valid());
    for (std::uint32_t i = 0; i + 1u < r.steps(); ++i) {
      const int cur = static_cast<int>(r.speedAt(i));
      const int nxt = static_cast<int>(r.speedAt(i + 1u));
      const int delta = nxt - cur;
      const int mag = delta < 0 ? -delta : delta;
      RC_ASSERT(mag <= static_cast<int>(r.accel()));
    }
  }));
}

// ---------------------------------------------------------------------------
// Property 5.6: TRIANGULAR SHORT SEGMENTS -- when the segment is too short to
// reach the configured peak (2*rampLen > steps), the apex stays strictly below
// the peak. The implication is universally true, so it is asserted on the
// general generator; the short-biased generator ensures the antecedent
// actually fires.
// ---------------------------------------------------------------------------
TEST_CASE("Property 5: short segments are triangular (apex below peak)",
          "[ramp][property][property-5]") {
  // General space: the implication holds for every valid input.
  REQUIRE(rc::check("2*rampLen > steps  =>  maxSpeed < peak", [] {
    const RampParams p = genValidParams();
    TrapezoidRamp r(p.steps, p.vMin, p.vPeak, p.accel, p.speedPct);
    RC_ASSERT(r.valid());
    if (2u * rampLenToPeak(r) > r.steps()) {
      RC_ASSERT(maxSpeed(r) < r.peak());
    }
  }));

  // Short-biased space: the antecedent fires often, so the body is real work.
  REQUIRE(rc::check("short segment with high peak collapses to a triangle", [] {
    const RampParams p = genShortParams();
    TrapezoidRamp r(p.steps, p.vMin, p.vPeak, p.accel, p.speedPct);
    RC_ASSERT(r.valid());
    if (2u * rampLenToPeak(r) > r.steps()) {
      RC_ASSERT(maxSpeed(r) < r.peak());
    }
    // Whether or not it reached the peak, the schedule stays well-formed.
    RC_ASSERT(maxSpeed(r) <= r.peak());
  }));
}

// ---------------------------------------------------------------------------
// Property 5.7: SPEEDPCT SCALING -- the achievable peak equals
// clamp(vPeak * speedPct / 100, vMin, FEED_SPS_MAX) and is monotonic
// non-decreasing in speedPct; raising the slider never lowers the realised
// maximum speed (Req 9.7, 9.8).
// ---------------------------------------------------------------------------
TEST_CASE("Property 5: achievable peak scales monotonically with speedPct",
          "[ramp][property][property-5]") {
  REQUIRE(rc::check("peak() matches the oracle and grows with speedPct", [] {
    // Shared envelope; vary only speedPct between the two ramps.
    const std::uint32_t steps =
        static_cast<std::uint32_t>(*rc::gen::inRange<int>(1, 2001));
    const std::uint16_t vMin = static_cast<std::uint16_t>(
        *rc::gen::inRange<int>(FEED_SPS_MIN, 601));
    const std::uint16_t vPeak = static_cast<std::uint16_t>(
        *rc::gen::inRange<int>(vMin, FEED_SPS_MAX + 1));
    const std::uint16_t accel =
        static_cast<std::uint16_t>(*rc::gen::inRange<int>(1, 301));
    const std::uint8_t p1 = static_cast<std::uint8_t>(
        *rc::gen::inRange<int>(SPEED_PCT_MIN, SPEED_PCT_MAX + 1));
    const std::uint8_t p2 = static_cast<std::uint8_t>(
        *rc::gen::inRange<int>(SPEED_PCT_MIN, SPEED_PCT_MAX + 1));
    const std::uint8_t lo = p1 < p2 ? p1 : p2;
    const std::uint8_t hi = p1 < p2 ? p2 : p1;

    TrapezoidRamp rlo(steps, vMin, vPeak, accel, lo);
    TrapezoidRamp rhi(steps, vMin, vPeak, accel, hi);
    RC_ASSERT(rlo.valid());
    RC_ASSERT(rhi.valid());

    // Oracle equality: peak() is exactly the clamped, speedPct-scaled target.
    RC_ASSERT(rlo.peak() == expectedPeak(vMin, vPeak, lo));
    RC_ASSERT(rhi.peak() == expectedPeak(vMin, vPeak, hi));

    // Monotonicity: a higher slider never lowers the target peak...
    RC_ASSERT(rlo.peak() <= rhi.peak());
    // ...nor the realised maximum (the segment-length cap is speedPct-free, so
    // min(peak, cap) inherits the monotonicity of peak).
    RC_ASSERT(maxSpeed(rlo) <= maxSpeed(rhi));
  }));
}

// ---------------------------------------------------------------------------
// Boundary cases (plain Catch2) -- exact, deterministic checks at the corners
// of the input space that the randomized properties only hit probabilistically.
// ---------------------------------------------------------------------------

TEST_CASE("Property 5 boundary: steps=0 clamps to a single vMin step",
          "[ramp][property][property-5]") {
  // steps below the minimum is clamped up to 1 and flagged invalid, but the
  // resulting one-entry schedule is still well-formed at vMin.
  TrapezoidRamp r(0, FEED_SPS_MIN, 800, 50);
  CHECK_FALSE(r.valid());
  REQUIRE(r.steps() == 1u);
  CHECK(r.speedAt(0) == FEED_SPS_MIN);
}

TEST_CASE("Property 5 boundary: steps=1 is a single vMin step",
          "[ramp][property][property-5]") {
  TrapezoidRamp r(1, FEED_SPS_MIN, 1000, 50);
  REQUIRE(r.valid());
  CHECK(r.steps() == 1u);
  CHECK(r.speedAt(0) == FEED_SPS_MIN);
  CHECK(maxSpeed(r) == FEED_SPS_MIN);
  CHECK(maxSpeed(r) <= r.peak());
}

TEST_CASE("Property 5 boundary: very short segment stays triangular",
          "[ramp][property][property-5]") {
  // 6 steps, accel 50, peak 1000: rampLen = ceil(900/50) = 18, and
  // 2*18 = 36 > 6, so the apex never reaches the configured peak.
  TrapezoidRamp r(6, FEED_SPS_MIN, 1000, 50);
  REQUIRE(r.valid());
  CHECK(r.peak() == 1000);
  CHECK(2u * rampLenToPeak(r) > r.steps());
  CHECK(maxSpeed(r) < r.peak());
  // Apex sits at the middle step: vMin + 2*accel = 100 + 100 = 200.
  CHECK(r.speedAt(2) == 200);
  CHECK(r.speedAt(3) == 200);
}

TEST_CASE("Property 5 boundary: long segment reaches a full trapezoid plateau",
          "[ramp][property][property-5]") {
  // 200 steps, accel 50, peak 800: rampLen = ceil(700/50) = 14, and
  // 2*14 = 28 <= 199, so a plateau at the peak exists.
  TrapezoidRamp r(200, FEED_SPS_MIN, 800, 50);
  REQUIRE(r.valid());
  CHECK(r.peak() == 800);
  CHECK(2u * rampLenToPeak(r) <= r.steps());
  CHECK(maxSpeed(r) == r.peak());  // plateau actually reached
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
