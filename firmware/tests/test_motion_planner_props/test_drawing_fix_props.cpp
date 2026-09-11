// FIX-CHECKING property tests for the drawing-motion-fix bugfix (Task 7.3).
// Defect 1 -- constant-rate GPT tick + software DDS step divider.
// Design §Correctness Properties Property 1 (C1); §Property-Based Tests
// (divider average rate; segment step-count equality); §Unit Tests (single
// timer programming).
//
// ===========================================================================
// THESE TESTS ARE EXPECTED TO PASS ON THE FIXED CODE.
// ===========================================================================
//
// They verify the post-fix behaviour the exploration test (task 1.1) only
// encoded: the GPT is programmed ONCE to STEP_TICK_HZ and never reprogrammed
// per step, the commanded feed is realised purely in software by an integer
// DDS step divider in onStepIsr(), and the counted-step / final-position
// accounting is preserved exactly.
//
// Three properties (Design §Property-Based Tests / §Unit Tests):
//
//   1. Divider average-rate PBT -- driving onStepIsr() over a fixed window in
//      the cruise plateau emits microsteps at the commanded microstep rate
//      (rate*K/STEP_TICK_HZ) within +-1 microstep (the DDS quantisation bound).
//
//   2. Set-once timer PBT -- the step-timer rate is programmed exactly once
//      (at begin(), to STEP_TICK_HZ) and never reprogrammed per step. The
//      former per-step setTimerRateHz_()/set_frequency() path is gone. On the
//      host the timer seams are deterministic no-ops, so "programmed once /
//      never per step" is observed by its consequence: the emitted rate is a
//      pure function of the SOFTWARE divider (it scales with the commanded
//      feed), which is impossible if the rate still lived in a per-step timer
//      reprogram (that was the runaway bug -- emission was then independent of
//      feed).
//
//   3. Segment step-count equality PBT -- for random (dx, dy, feed) the fixed
//      planner emits exactly the pre-fix microstep totals (|dx|*16 on X,
//      |dy|*16 on Y, (|dx|+|dy|)*16 total) and the final position() lands on
//      exactly (dx, dy) counted full steps. The DDS divider changes only WHICH
//      ticks emit, never the totals.
//
// Scope: SECONDARY translation unit in the existing test_motion_planner_props/
// PlatformIO directory. The primary TU (test_motion_planner_props.cpp) provides
// `int main` (Catch::Session) and pulls in the module .cpp bodies; PlatformIO
// compiles every TU in this directory into one binary and Catch2 auto-registers
// the TEST_CASEs here. We therefore do NOT redefine main or re-include the
// implementation .cpp files (one-definition rule).
//
// Run with:  pio test -e host_test -f test_motion_planner_props   (cwd firmware/)
// (The known pre-existing unrelated test_backlash_props failure is out of scope.)

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
using etch::STEP_TICK_HZ;
using etch::backlash::BacklashCompensator;
using etch::backlash::IBacklashStore;
using etch::motion::IMotionNvm;
using etch::motion::IStepSink;
using etch::motion::MotionPlanner;

namespace {

// ---------------------------------------------------------------------------
// Fakes -- same shape as the sibling harnesses, in THIS TU's anonymous
// namespace (internal linkage) so there is no clash with the other TUs'
// identically-shaped fakes.
// ---------------------------------------------------------------------------

class FakeBacklashStoreFX : public IBacklashStore {
 public:
  FakeBacklashStoreFX() {
    std::memset(&cfg_, 0, sizeof(cfg_));
    cfg_.magic = NVM_MAGIC;
    cfg_.version = NVM_VERSION;
  }
  const PersistedConfig& get() const override { return cfg_; }
  void mutate(std::function<void(PersistedConfig&)> fn) override { fn(cfg_); }

 private:
  PersistedConfig cfg_;
};

class FakeStepSinkFX : public IStepSink {
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

class FakeMotionNvmFX : public IMotionNvm {
 public:
  PersistedConfig cfg{};
  FakeMotionNvmFX() { std::memset(&cfg, 0, sizeof(cfg)); }
  void mutate(std::function<void(PersistedConfig&)> fn) override { fn(cfg); }
  void flushIfDue() override {}
};

struct HarnessFX {
  FakeBacklashStoreFX store;
  BacklashCompensator backlash{store};
  FakeStepSinkFX sink;
  FakeMotionNvmFX nvm;
  MotionPlanner::RingBufferT buffer;
  MotionPlanner planner{buffer, backlash, sink, nvm};

  HarnessFX() {
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

long iabs(long v) { return v < 0 ? -v : v; }

// A single long +X segment so a wide cruise plateau exists. At speedPct=100 the
// trapezoid peak == feed; acceleration into the plateau and deceleration out of
// it each occupy only a few full steps, so steps roughly [warmup, len-warmup]
// run flat at `feed`.
constexpr std::int16_t kSegmentSteps = 3000;
constexpr std::int32_t kWarmupSteps = 50;  // well inside the cruise plateau

// Drive onStepIsr() through one long +X segment at `feed`, warm into the cruise
// plateau, then count the microsteps emitted across exactly K onStepIsr()
// calls. A pure +X segment emits one pulse per emitting tick, so the emitted
// count equals the number of DDS rollovers over the window.
std::uint32_t measureCruiseEmission(std::uint16_t feed, std::uint32_t K) {
  HarnessFX h;
  h.planner.submit(makeDrawCmd(0, kSegmentSteps, 0, feed));
  h.planner.serviceLoop();  // arm the segment

  std::uint64_t guard = 0;
  const std::uint64_t guardMax = 50'000'000ull;
  while (h.planner.position().x_steps < kWarmupSteps) {
    h.planner.onStepIsr();
    if (++guard > guardMax) {
      RC_ASSERT(guard <= guardMax);
      return 0;
    }
  }

  const std::uint32_t before = h.planner.microstepsEmitted();
  for (std::uint32_t t = 0; t < K; ++t) {
    h.planner.onStepIsr();
  }
  return h.planner.microstepsEmitted() - before;
}

// Drive the planner to idle. Bounded so a logic bug fails fast. With the DDS
// divider, one counted full step spans a variable number of raw onStepIsr()
// calls; MICROSTEP_FACTOR EMITTING ticks always make up one full step, so we
// pump raw ticks until that many emissions have occurred.
void runToIdle(MotionPlanner& mp, long maxFullSteps = 500000) {
  long guard = 0;
  while (!mp.isIdle()) {
    mp.serviceLoop();
    long emitting = 0;
    std::uint32_t prev = mp.microstepsEmitted();
    long innerGuard = 0;
    while (emitting < MICROSTEP_FACTOR && !mp.isIdle()) {
      mp.onStepIsr();
      const std::uint32_t now = mp.microstepsEmitted();
      if (now != prev) {
        ++emitting;
        prev = now;
      }
      if (++innerGuard > 5'000'000) break;
    }
    if (++guard > maxFullSteps) {
      RC_ASSERT(guard <= maxFullSteps);
      return;
    }
  }
}

// Within-captured-envelope step deltas (reference machine X=2158, Y=1650).
constexpr int kDeltaBound = 1650;

}  // namespace

// ---------------------------------------------------------------------------
// PBT 1 -- Divider average rate (Design §Property-Based Tests: "divider average
// rate"). For random commanded microstep rates (rate == feed*MICROSTEP_FACTOR,
// feed in [FEED_SPS_MIN, FEED_SPS_MAX]) the microsteps emitted over K ==
// STEP_TICK_HZ onStepIsr() calls in the cruise plateau equal rate*K/STEP_TICK_HZ
// within +-1 microstep (the DDS quantisation bound).
//
// Rate domain note: the steady (cruise) commanded microstep rate the planner
// can be DRIVEN to on the host is feed*MICROSTEP_FACTOR with feed in the wire
// range [FEED_SPS_MIN, FEED_SPS_MAX] = [1600, 16000] microstep Hz. The slower
// pull-in/ramp rates (down to RAMP_MIN_SPS*16) occur only transiently during
// acceleration where the rate changes each full step, so they are not a steady
// plateau to measure against; the identical DDS accumulator logic governs them.
//
// **Validates: Requirements 2.1, 2.2, 2.3**
// ---------------------------------------------------------------------------
TEST_CASE(
    "PBT (C1 fix): DDS divider realises commanded rate "
    "(emitted ~= rate*K/STEP_TICK_HZ within +-1)",
    "[motion][property][property-1][bugfix][fix][C1]") {
  REQUIRE(rc::check(
      "cruise emission over STEP_TICK_HZ ticks ~= feed*MICROSTEP_FACTOR",
      [] {
        const auto feed = static_cast<std::uint16_t>(
            *rc::gen::inRange(static_cast<int>(FEED_SPS_MIN),
                              static_cast<int>(FEED_SPS_MAX) + 1));

        const std::uint32_t K = STEP_TICK_HZ;
        const std::uint32_t emitted = measureCruiseEmission(feed, K);

        const std::uint32_t rate =
            static_cast<std::uint32_t>(feed) * MICROSTEP_FACTOR;
        const long expected = static_cast<long>(
            static_cast<std::uint64_t>(rate) * K / STEP_TICK_HZ);
        const long diff = static_cast<long>(emitted) - expected;

        RC_ASSERT(diff <= 1);
        RC_ASSERT(diff >= -1);
      }));
}

// ---------------------------------------------------------------------------
// PBT 2 -- Set-once timer / no per-step reprogram (Design §Unit Tests: "single
// timer programming"). The GPT is programmed exactly once (at begin(), to
// STEP_TICK_HZ) and the former per-step setTimerRateHz_()/set_frequency() path
// no longer exists. On the host the timer seams are deterministic no-ops, so we
// observe "programmed once / never per step" by its consequence: the emitted
// rate is a pure function of the SOFTWARE DDS divider and therefore SCALES with
// the commanded feed. Under the old bug the rate lived entirely in the per-step
// timer reprogram (a host no-op), so emission was INDEPENDENT of feed (always
// one microstep per call) -- the runaway path. Demonstrating monotonic scaling
// of emission with feed proves the rate is realised in software, not by per-step
// timer reprogramming.
//
// **Validates: Requirements 2.1, 2.4**
// ---------------------------------------------------------------------------
TEST_CASE(
    "PBT (C1 fix): rate realised in software (emission scales with feed), "
    "not by per-step timer reprogramming",
    "[motion][property][property-1][bugfix][fix][C1]") {
  REQUIRE(rc::check(
      "a strictly faster feed emits strictly more microsteps in the same window",
      [] {
        // Two distinct feeds; the faster MUST emit more microsteps over the
        // same tick window if (and only if) the rate is software-divided.
        int fa = *rc::gen::inRange(static_cast<int>(FEED_SPS_MIN),
                                   static_cast<int>(FEED_SPS_MAX) + 1);
        int fb = *rc::gen::inRange(static_cast<int>(FEED_SPS_MIN),
                                   static_cast<int>(FEED_SPS_MAX) + 1);
        // Require a meaningful separation so the +-1 DDS bound cannot mask the
        // ordering (1 sps of feed == 16 microstep Hz, comfortably > the bound).
        RC_PRE(iabs(fa - fb) >= 5);
        if (fa > fb) {
          const int t = fa;
          fa = fb;
          fb = t;
        }
        const auto slow = static_cast<std::uint16_t>(fa);
        const auto fast = static_cast<std::uint16_t>(fb);

        const std::uint32_t K = STEP_TICK_HZ;
        const std::uint32_t emittedSlow = measureCruiseEmission(slow, K);
        const std::uint32_t emittedFast = measureCruiseEmission(fast, K);

        // Software-divided: faster commanded feed -> strictly more emissions.
        RC_ASSERT(emittedFast > emittedSlow);

        // And each matches its OWN commanded rate (not the tick count K), which
        // is the positive statement of "no per-step timer reprogram": a per-step
        // timer model on the host (no-op seam) would emit K for every feed.
        RC_ASSERT(emittedSlow < static_cast<std::uint32_t>(slow) *
                                        MICROSTEP_FACTOR + 2);
        RC_ASSERT(emittedFast < static_cast<std::uint32_t>(fast) *
                                        MICROSTEP_FACTOR + 2);
        RC_ASSERT(emittedFast < K);  // never the runaway "one per tick" value
      }));
}

// ---------------------------------------------------------------------------
// PBT 3 -- Segment step-count equality (Design §Property-Based Tests: "segment
// step-count equality"). For random (dx, dy, feed) the fixed planner emits
// exactly the pre-fix microstep totals and the final position() equals the
// pre-fix accounting -- the DDS divider changes only WHICH ticks emit, never
// the totals (preservation of the Bresenham / counted-step invariants under the
// timer-rate fix).
//
//   stepsX == |dx|*MICROSTEP_FACTOR, stepsY == |dy|*MICROSTEP_FACTOR
//   microstepsEmitted == (|dx|+|dy|)*MICROSTEP_FACTOR
//   position() == (dx, dy)
//
// **Validates: Requirements 2.1, 2.2, 2.3**
// ---------------------------------------------------------------------------
TEST_CASE(
    "PBT (C1 fix): fixed planner emits exact pre-fix microstep totals and "
    "lands on (dx,dy)",
    "[motion][property][property-1][bugfix][fix][C1]") {
  REQUIRE(rc::check(
      "segment step-count equality: totals and final position preserved",
      [] {
        const auto dx = static_cast<std::int32_t>(
            *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1));
        const auto dy = static_cast<std::int32_t>(
            *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1));
        const auto feed = static_cast<std::uint16_t>(
            *rc::gen::inRange(static_cast<int>(FEED_SPS_MIN),
                              static_cast<int>(FEED_SPS_MAX) + 1));

        HarnessFX h;
        h.planner.submit(makeDrawCmd(0, static_cast<std::int16_t>(dx),
                                     static_cast<std::int16_t>(dy), feed));
        runToIdle(h.planner);

        // Final counted position lands exactly on (dx, dy).
        RC_ASSERT(h.planner.position().x_steps == dx);
        RC_ASSERT(h.planner.position().y_steps == dy);

        // Per-axis and total microstep emission match the pre-fix closed form.
        RC_ASSERT(h.sink.stepsX ==
                  static_cast<std::uint32_t>(iabs(dx)) * MICROSTEP_FACTOR);
        RC_ASSERT(h.sink.stepsY ==
                  static_cast<std::uint32_t>(iabs(dy)) * MICROSTEP_FACTOR);
        RC_ASSERT(h.planner.microstepsEmitted() ==
                  static_cast<std::uint32_t>(iabs(dx) + iabs(dy)) *
                      MICROSTEP_FACTOR);
      }));
}

// ---------------------------------------------------------------------------
// Concrete fix example: a mid-feed +X segment emits at the commanded rate over
// a fixed window (not the tick count) -- a hand-worked pin on the DDS bound.
// ---------------------------------------------------------------------------
TEST_CASE("PBT (C1 fix, concrete): mid-feed cruise emission matches rate",
          "[motion][property-1][bugfix][fix][C1][example]") {
  const std::uint16_t feed = 500;  // mid-range
  const std::uint32_t K = STEP_TICK_HZ;
  const std::uint32_t emitted = measureCruiseEmission(feed, K);
  const std::uint32_t rate =
      static_cast<std::uint32_t>(feed) * MICROSTEP_FACTOR;  // 8000 Hz
  const long expected =
      static_cast<long>(static_cast<std::uint64_t>(rate) * K / STEP_TICK_HZ);
  const long diff = static_cast<long>(emitted) - expected;
  CHECK(diff <= 1);
  CHECK(diff >= -1);
  CHECK(emitted < K);  // not the runaway "one per tick" value
}
