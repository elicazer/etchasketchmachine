// Bug-condition EXPLORATION property test for Defect 1 -- drawing-motion
// runaway (Bug Condition C1: X.kind = DRAW). Bugfix spec drawing-motion-fix,
// Task 1.1; Design §Correctness Properties Property 1 (C1).
//
// ===========================================================================
// THIS TEST IS EXPECTED TO FAIL ON THE CURRENT (UNFIXED) CODE.
// ===========================================================================
//
// The failure is the SUCCESS case for an exploration test: it confirms the
// runaway bug exists. DO NOT "fix" this test or the production code to make it
// pass here -- the fix is implemented in later tasks (constant-rate GPT tick +
// software DDS step divider in onStepIsr()), after which this same test must
// PASS unchanged (Task 7.1).
//
// What the bug is
// ---------------
// Today MotionPlanner realises the commanded feed rate ENTIRELY by reprogramming
// the RA4M1 GPT period on every microstep: fetchNextTick_() calls
// setTimerRateHz_(speedAt(i)) -> s_step_timer.set_frequency(hz * 16) for each
// full-step tick. There is NO software notion of "ticks between steps":
// onStepIsr() unconditionally emits one microstep per call on each stepping
// axis. On the host the timer seam is a deterministic no-op, so the commanded
// speed has ZERO effect on how many microsteps a given number of onStepIsr()
// calls produces. On hardware, reprogramming the GPT from in/around the
// overflow ISR every microstep yields runaway (far-too-fast) timing.
//
// What the fix will do (the post-fix behaviour this test encodes)
// ---------------------------------------------------------------
// The GPT is programmed ONCE to a fixed high microstep tick rate STEP_TICK_HZ
// (32000) and never reprogrammed. onStepIsr() runs an integer DDS phase
// accumulator: each tick adds the commanded microstep rate cur_micro_hz_; a
// microstep is emitted only when the accumulator rolls over STEP_TICK_HZ. So
// over K onStepIsr() calls at a constant commanded microstep rate `rate`, the
// emitted microstep count is approximately rate*K/STEP_TICK_HZ (within +-1
// microstep, the DDS quantisation bound). The drawing speed is then realised in
// SOFTWARE, independent of any per-step timer reprogramming.
//
// How this test surfaces the counterexample
// ------------------------------------------
// Drive onStepIsr() deterministically on the host over a long single-axis
// segment. After warming past the trapezoid's acceleration ramp into the
// cruise plateau (where speedAt(i) == feed, hence the commanded microstep rate
// is feed*MICROSTEP_FACTOR), count the microsteps emitted across exactly
// STEP_TICK_HZ onStepIsr() calls and compare to the post-fix DDS expectation
// rate*K/STEP_TICK_HZ.
//
//   * UNFIXED: emitted == K (== STEP_TICK_HZ == 32000), because every call
//     emits one microstep regardless of the commanded feed -> WAY more than the
//     expected feed*MICROSTEP_FACTOR (1600..16000). The assertion FAILS,
//     proving the speed is not realised in software (the runaway path).
//   * FIXED:   emitted ~= feed*MICROSTEP_FACTOR within +-1 -> the assertion
//     PASSES.
//
// Scope: this TU is a SECONDARY translation unit in the existing
// test_motion_planner_props/ PlatformIO test directory. The sibling TU
// (test_motion_planner_props.cpp) provides `int main` (Catch::Session) and pulls
// in the module .cpp bodies; PlatformIO compiles both into one binary and
// Catch2 auto-registers the TEST_CASEs here. We therefore do NOT redefine main
// or re-include the implementation .cpp files (one definition rule).
//
// Run with:  pio test -e host_test -f test_motion_planner_props   (cwd firmware/)
// (The known pre-existing unrelated failure test_backlash_props is out of scope.)

#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>

#include "../../src/types.h"
#include "../../src/backlash/backlash_compensator.h"
#include "../../src/motion/motion_planner.h"

using etch::DrawingCommand;
using etch::FEED_SPS_MAX;
using etch::FEED_SPS_MIN;
using etch::MICROSTEP_FACTOR;
using etch::NVM_MAGIC;
using etch::NVM_VERSION;
using etch::PersistedConfig;
using etch::Position;
using etch::backlash::BacklashCompensator;
using etch::backlash::IBacklashStore;
using etch::motion::IMotionNvm;
using etch::motion::IStepSink;
using etch::motion::MotionPlanner;

namespace {

// Post-fix design constant (design.md §Fix Implementation, Defect 1: the GPT is
// programmed ONCE to this fixed microstep tick rate). The PRODUCTION
// STEP_TICK_HZ constant is added later in Task 3.1; this exploration test
// encodes the expected value locally so it compiles AND runs on the current
// UNFIXED tree (which has no such constant yet). It must match the production
// value once added.
constexpr std::uint32_t kStepTickHz = 32000;

// ---------------------------------------------------------------------------
// Fakes -- same shape as the sibling pause/resume property harness. Defined in
// this TU's own anonymous namespace (internal linkage) so there is no clash
// with the sibling TU's identically-shaped fakes.
// ---------------------------------------------------------------------------

class FakeBacklashStoreRA : public IBacklashStore {
 public:
  FakeBacklashStoreRA() {
    std::memset(&cfg_, 0, sizeof(cfg_));
    cfg_.magic = NVM_MAGIC;
    cfg_.version = NVM_VERSION;
  }
  const PersistedConfig& get() const override { return cfg_; }
  void mutate(std::function<void(PersistedConfig&)> fn) override { fn(cfg_); }

 private:
  PersistedConfig cfg_;
};

class FakeStepSinkRA : public IStepSink {
 public:
  std::int8_t dirX = 0;
  std::int8_t dirY = 0;
  std::uint32_t stepsX = 0;
  std::uint32_t stepsY = 0;
  bool enabled = false;

  void setDirX(std::int8_t dir) override { dirX = dir; }
  void setDirY(std::int8_t dir) override { dirY = dir; }
  void stepX() override { ++stepsX; }
  void stepY() override { ++stepsY; }
  void setEnabled(bool e) override { enabled = e; }
};

class FakeMotionNvmRA : public IMotionNvm {
 public:
  PersistedConfig cfg{};
  FakeMotionNvmRA() { std::memset(&cfg, 0, sizeof(cfg)); }
  void mutate(std::function<void(PersistedConfig&)> fn) override { fn(cfg); }
  void flushIfDue() override {}
};

struct HarnessRA {
  FakeBacklashStoreRA store;
  BacklashCompensator backlash{store};
  FakeStepSinkRA sink;
  FakeMotionNvmRA nvm;
  MotionPlanner::RingBufferT buffer;
  MotionPlanner planner{buffer, backlash, sink, nvm};

  HarnessRA() {
    backlash.load();  // backlash 0/0 -> no uncounted compensation steps
    planner.begin();
  }
};

DrawingCommand makeDrawCmd(std::uint32_t seq, std::int16_t dx, std::int16_t dy,
                           std::uint16_t feed) {
  DrawingCommand c{};
  c.seq = seq;
  c.dx_steps = dx;
  c.dy_steps = dy;
  c.feed_sps = feed;
  c.flags = 0;
  c.reserved = 0;
  c.crc16_payload = 0;
  return c;
}

// A single long +X segment so a wide cruise plateau exists. The trapezoid
// reaches its peak (== feed at speedPct=100) within ceil((feed-MOTION_START_SPS)
// /accel) <= ~10 full steps, and the decel tail occupies a similar count at the
// end, so steps roughly [10, kSegmentSteps-10] run flat at `feed`.
constexpr std::int16_t kSegmentSteps = 3000;
// Warm past the acceleration ramp before measuring (well inside the plateau).
constexpr std::int32_t kWarmupSteps = 50;

// Drive onStepIsr() through one long +X segment at `feed`, warm into the cruise
// plateau, then count the microsteps emitted across exactly K onStepIsr()
// calls. K == kStepTickHz makes the post-fix DDS expectation an exact integer:
// rate*K/STEP_TICK_HZ == rate == feed*MICROSTEP_FACTOR.
std::uint32_t measureCruiseEmission(std::uint16_t feed, std::uint32_t K) {
  HarnessRA h;
  h.planner.submit(makeDrawCmd(0, kSegmentSteps, 0, feed));
  h.planner.serviceLoop();  // arm the segment

  // Warm up into the plateau: advance until the counted position reaches
  // kWarmupSteps. Bounded so a logic bug fails fast instead of hanging.
  std::uint64_t guard = 0;
  const std::uint64_t guardMax = 50'000'000ull;
  while (h.planner.position().x_steps < kWarmupSteps) {
    h.planner.onStepIsr();
    if (++guard > guardMax) {
      RC_ASSERT(guard <= guardMax);  // never reached the plateau -> bug
      return 0;
    }
  }

  const std::uint32_t before = h.planner.microstepsEmitted();
  for (std::uint32_t t = 0; t < K; ++t) {
    h.planner.onStepIsr();
  }
  return h.planner.microstepsEmitted() - before;
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 1 (C1) -- drawing speed must be realised in SOFTWARE step division.
//
// For a commanded feed in [FEED_SPS_MIN, FEED_SPS_MAX], the microsteps emitted
// across K == STEP_TICK_HZ onStepIsr() calls in the cruise plateau must equal
// the DDS expectation rate*K/STEP_TICK_HZ (== feed*MICROSTEP_FACTOR) within +-1.
//
// UNFIXED OUTCOME: emitted == K == 32000 (one microstep per call, independent of
// `feed`), so the assertion fails -- confirming all rate control lives in the
// per-step timer reprogramming (the runaway path on hardware).
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.4
// ---------------------------------------------------------------------------
TEST_CASE(
    "Property 1 (C1 exploration): drawing speed is realised by software step "
    "division (emitted ~= rate*K/STEP_TICK_HZ)",
    "[motion][property][property-1][bugfix][exploration][C1]") {
  REQUIRE(rc::check(
      "cruise-plateau emission over STEP_TICK_HZ ticks ~= feed*MICROSTEP_FACTOR",
      [] {
        const auto feed = static_cast<std::uint16_t>(
            *rc::gen::inRange(static_cast<int>(FEED_SPS_MIN),
                              static_cast<int>(FEED_SPS_MAX) + 1));

        const std::uint32_t K = kStepTickHz;
        const std::uint32_t emitted = measureCruiseEmission(feed, K);

        // Commanded microstep rate in the plateau (speedPct=100 -> peak==feed).
        const std::uint32_t rate =
            static_cast<std::uint32_t>(feed) * MICROSTEP_FACTOR;
        // DDS expectation: emitted ~= rate*K/STEP_TICK_HZ. With K==STEP_TICK_HZ
        // this is exactly `rate`. The DDS phase accumulator is accurate within
        // +-1 microstep over the window.
        const long expected =
            static_cast<long>(static_cast<std::uint64_t>(rate) * K / kStepTickHz);
        const long diff = static_cast<long>(emitted) - expected;

        RC_ASSERT(diff <= 1);
        RC_ASSERT(diff >= -1);
      }));
}

// ---------------------------------------------------------------------------
// Property 1 (C1) concrete counterexample: the emitted microstep count over a
// fixed number of onStepIsr() calls must SCALE with the commanded feed. A
// 10x-faster feed must emit ~10x more microsteps in the same window.
//
// UNFIXED OUTCOME: the slow (FEED_SPS_MIN) and fast (FEED_SPS_MAX) feeds emit
// the SAME count (== K), so the ratio is 1, not 10 -- a crisp, human-readable
// counterexample that the commanded speed has no software effect.
//
// Validates: Requirements 2.1, 2.2, 2.3
// ---------------------------------------------------------------------------
TEST_CASE(
    "Property 1 (C1 exploration, concrete): emission scales with commanded feed",
    "[motion][property-1][bugfix][exploration][C1][example]") {
  const std::uint32_t K = kStepTickHz;

  const std::uint32_t emittedSlow = measureCruiseEmission(FEED_SPS_MIN, K);
  const std::uint32_t emittedFast = measureCruiseEmission(FEED_SPS_MAX, K);

  // Post-fix: emittedSlow ~= FEED_SPS_MIN*16 (1600), emittedFast ~=
  // FEED_SPS_MAX*16 (16000). Unfixed: both == K (32000). A faster feed MUST
  // emit strictly more microsteps in the same window.
  CHECK(emittedFast > emittedSlow + 1);

  // And each must match its own commanded rate (post-fix), not the tick count.
  CHECK(emittedSlow <
        static_cast<std::uint32_t>(FEED_SPS_MIN) * MICROSTEP_FACTOR + 2);
  CHECK(emittedFast <
        static_cast<std::uint32_t>(FEED_SPS_MAX) * MICROSTEP_FACTOR + 2);
}
