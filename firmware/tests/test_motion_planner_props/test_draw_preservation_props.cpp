// PRESERVATION property test for the drawing-motion-fix bugfix (Task 2).
// Captured-envelope draw preservation -- Design §Correctness Properties
// Property 3 (Preservation) and §Preservation Requirements.
//
// ===========================================================================
// THIS TEST IS EXPECTED TO PASS ON THE CURRENT (UNFIXED) CODE.
// ===========================================================================
//
// Observation-first methodology
// -----------------------------
// This file encodes the pre-fix ("baseline") accounting of a calibrated-machine
// draw segment so the Defect-1 fix (constant-rate GPT tick + software DDS step
// divider in onStepIsr()) can be verified to PRESERVE it. The fix changes only
// the timer-rate MECHANISM (how fast microsteps are clocked); it must NOT change
// the emitted microstep SEQUENCE, the counted full-step accounting, or the final
// logical position(). After the fix, these same assertions must still hold
// (Task 7.5).
//
// Non-buggy domain (NOT isBugCondition(X))
// ----------------------------------------
// A draw on a machine with a VALID captured envelope is outside the bug
// condition for everything that does not depend on the timer-rate mechanism:
// the Bresenham step sequence, counted full steps, final position, ramp
// schedule, and backlash steps. At the MotionPlanner level the captured
// envelope has already been applied upstream (web fitPolylinesToEnvelope ->
// streamed Drawing_Command deltas), so a "calibrated-machine draw segment" is
// simply a DrawingCommand carrying within-envelope (dx, dy, feed). The envelope
// GATE itself lives in etchasketch.ino and is covered by test_draw_gate_props/.
//
// Observed pre-fix accounting (host timer seam is a deterministic no-op)
// ----------------------------------------------------------------------
// onStepIsr() emits one microstep pulse on each axis that steps on the current
// Bresenham tick, and MICROSTEP_FACTOR (16) microstep ticks make up one counted
// full step. Therefore for a single segment with signed deltas (dx, dy):
//   * stepsX  == |dx| * MICROSTEP_FACTOR     (per-axis pulse counts)
//   * stepsY  == |dy| * MICROSTEP_FACTOR
//   * microstepsEmitted == (|dx| + |dy|) * MICROSTEP_FACTOR   (a diagonal tick
//                          pulses BOTH axes)
//   * position()        == (dx, dy)          (counted full steps from home)
// Across a short sequence the final position is Σ(dx, dy) and the total pulse
// count is Σ (|dx| + |dy|) * MICROSTEP_FACTOR. Backlash is left at 0/0 so no
// uncounted compensation steps are injected (that interaction is its own
// property elsewhere); this isolates the counted-move accounting the fix must
// preserve.
//
// **Validates: Requirements 3.3**
// (Bresenham generator, TrapezoidRamp schedule, counted-vs-uncounted full-step
//  accounting -- unchanged across the timer-rate fix.)
//
// Scope: SECONDARY translation unit in the existing test_motion_planner_props/
// PlatformIO directory. The primary TU (test_motion_planner_props.cpp) provides
// `int main` (Catch::Session) and pulls in the module .cpp bodies; PlatformIO
// compiles all TUs in this directory into one binary and Catch2 auto-registers
// the TEST_CASEs here. We therefore do NOT redefine main or re-include the
// implementation .cpp files (one-definition rule).
//
// Run with:  pio test -e host_test -f test_motion_planner_props   (cwd firmware/)
// (The sibling exploration TU test_drawing_runaway_props.cpp is EXPECTED to fail
//  on unfixed code; the known unrelated test_backlash_props failure is out of
//  scope. The preservation properties in THIS file must PASS.)

#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>
#include <vector>

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

// ---------------------------------------------------------------------------
// Fakes -- same shape as the sibling harnesses, in THIS TU's anonymous
// namespace (internal linkage) so there is no clash with the other TUs'
// identically-shaped fakes.
// ---------------------------------------------------------------------------

class FakeBacklashStoreDP : public IBacklashStore {
 public:
  FakeBacklashStoreDP() {
    std::memset(&cfg_, 0, sizeof(cfg_));
    cfg_.magic = NVM_MAGIC;
    cfg_.version = NVM_VERSION;
  }
  const PersistedConfig& get() const override { return cfg_; }
  void mutate(std::function<void(PersistedConfig&)> fn) override { fn(cfg_); }

 private:
  PersistedConfig cfg_;
};

class FakeStepSinkDP : public IStepSink {
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

class FakeMotionNvmDP : public IMotionNvm {
 public:
  PersistedConfig cfg{};
  std::size_t mutates = 0;
  std::size_t flushes = 0;
  FakeMotionNvmDP() { std::memset(&cfg, 0, sizeof(cfg)); }
  void mutate(std::function<void(PersistedConfig&)> fn) override {
    fn(cfg);
    ++mutates;
  }
  void flushIfDue() override { ++flushes; }
};

struct HarnessDP {
  FakeBacklashStoreDP store;
  BacklashCompensator backlash{store};
  FakeStepSinkDP sink;
  FakeMotionNvmDP nvm;
  MotionPlanner::RingBufferT buffer;
  MotionPlanner planner{buffer, backlash, sink, nvm};

  HarnessDP() {
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

// Drive the planner to idle. Bounded so a logic bug fails fast instead of
// hanging. With the unfixed no-op timer seam one full step is emitted per
// MICROSTEP_FACTOR onStepIsr() calls; the same accounting must hold after the
// fix (the DDS divider only changes WHICH ticks emit, not the totals).
void runToIdle(MotionPlanner& mp, long maxFullSteps = 500000) {
  long guard = 0;
  while (!mp.isIdle()) {
    mp.serviceLoop();
    for (std::uint8_t k = 0; k < MICROSTEP_FACTOR; ++k) mp.onStepIsr();
    if (++guard > maxFullSteps) {
      RC_ASSERT(guard <= maxFullSteps);
      return;
    }
  }
}

// Within-captured-envelope step deltas. The reference machine envelope is
// X=2158, Y=1650 full steps; a fitted draw segment's per-command deltas are
// bounded well inside that. We sample a generous in-envelope range; the
// accounting property is independent of the exact bound.
constexpr int kDeltaBound = 1650;
constexpr int kMaxSegments = 5;

}  // namespace

// ---------------------------------------------------------------------------
// Preservation 1: single calibrated-machine draw segment -- emitted microstep
// sequence, per-axis pulse counts, counted full-step accounting, and final
// position() match the closed-form pre-fix oracle.
//
// **Validates: Requirements 3.3**
// ---------------------------------------------------------------------------
TEST_CASE(
    "Preservation: single draw segment accounting is unchanged "
    "(microsteps + counted position)",
    "[motion][property][preservation][bugfix][property-3]") {
  REQUIRE(rc::check(
      "single segment: emitted == (|dx|+|dy|)*16 and position == (dx,dy)",
      [] {
        const auto dx = static_cast<std::int32_t>(
            *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1));
        const auto dy = static_cast<std::int32_t>(
            *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1));
        const auto feed = static_cast<std::uint16_t>(
            *rc::gen::inRange(static_cast<int>(FEED_SPS_MIN),
                              static_cast<int>(FEED_SPS_MAX) + 1));

        HarnessDP h;
        h.planner.submit(makeDrawCmd(0, static_cast<std::int16_t>(dx),
                                     static_cast<std::int16_t>(dy), feed));
        runToIdle(h.planner);

        // Counted full-step accounting: position lands exactly on (dx, dy).
        RC_ASSERT(h.planner.position().x_steps == dx);
        RC_ASSERT(h.planner.position().y_steps == dy);

        // Per-axis microstep pulse counts: |delta| * MICROSTEP_FACTOR.
        RC_ASSERT(h.sink.stepsX ==
                  static_cast<std::uint32_t>(iabs(dx)) * MICROSTEP_FACTOR);
        RC_ASSERT(h.sink.stepsY ==
                  static_cast<std::uint32_t>(iabs(dy)) * MICROSTEP_FACTOR);

        // Total emitted microsteps: (|dx| + |dy|) * MICROSTEP_FACTOR.
        const std::uint32_t expectedMicro =
            static_cast<std::uint32_t>(iabs(dx) + iabs(dy)) * MICROSTEP_FACTOR;
        RC_ASSERT(h.planner.microstepsEmitted() == expectedMicro);

        // DIR latched to the move direction for any axis that moves.
        if (dx > 0) RC_ASSERT(h.sink.dirX == 1);
        if (dx < 0) RC_ASSERT(h.sink.dirX == -1);
        if (dy > 0) RC_ASSERT(h.sink.dirY == 1);
        if (dy < 0) RC_ASSERT(h.sink.dirY == -1);
      }));
}

// ---------------------------------------------------------------------------
// Preservation 2: a short sequence of calibrated-machine draw segments -- the
// final logical position equals Σ(dx, dy) and the total pulse count equals
// Σ (|dx| + |dy|) * MICROSTEP_FACTOR, with exactly one staged NVM write per
// completed segment (debounced persistence preserved, Req 3.4 in passing).
//
// **Validates: Requirements 3.3**
// ---------------------------------------------------------------------------
TEST_CASE(
    "Preservation: multi-segment draw accounting + one NVM stage per segment",
    "[motion][property][preservation][bugfix][property-3]") {
  REQUIRE(rc::check(
      "sequence: final position == sum(dx,dy); pulses == sum(|dx|+|dy|)*16",
      [] {
        const int n = *rc::gen::inRange(1, kMaxSegments + 1);
        std::vector<std::int32_t> dxs;
        std::vector<std::int32_t> dys;
        std::vector<std::uint16_t> feeds;
        dxs.reserve(static_cast<std::size_t>(n));
        dys.reserve(static_cast<std::size_t>(n));
        feeds.reserve(static_cast<std::size_t>(n));
        for (int i = 0; i < n; ++i) {
          dxs.push_back(static_cast<std::int32_t>(
              *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1)));
          dys.push_back(static_cast<std::int32_t>(
              *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1)));
          feeds.push_back(static_cast<std::uint16_t>(
              *rc::gen::inRange(static_cast<int>(FEED_SPS_MIN),
                                static_cast<int>(FEED_SPS_MAX) + 1)));
        }

        HarnessDP h;
        for (int i = 0; i < n; ++i) {
          h.planner.submit(makeDrawCmd(static_cast<std::uint32_t>(i),
                                       static_cast<std::int16_t>(dxs[i]),
                                       static_cast<std::int16_t>(dys[i]),
                                       feeds[i]));
        }
        runToIdle(h.planner);

        std::int32_t sumX = 0;
        std::int32_t sumY = 0;
        std::uint32_t sumMicro = 0;
        for (int i = 0; i < n; ++i) {
          sumX += dxs[i];
          sumY += dys[i];
          sumMicro += static_cast<std::uint32_t>(iabs(dxs[i]) + iabs(dys[i])) *
                      MICROSTEP_FACTOR;
        }

        RC_ASSERT(h.planner.position().x_steps == sumX);
        RC_ASSERT(h.planner.position().y_steps == sumY);
        RC_ASSERT(h.planner.microstepsEmitted() == sumMicro);

        // One staged NVM write per completed segment (debounced persistence is
        // unchanged by the timer-rate fix; Req 3.4). Every segment, including a
        // degenerate (0,0) one, is finalised exactly once via persistPosition_.
        RC_ASSERT(h.nvm.mutates == static_cast<std::size_t>(n));
      }));
}

// ---------------------------------------------------------------------------
// Preservation 3 (concrete): a representative within-envelope diagonal draw.
// Pins the accounting on a hand-worked example so a regression is obvious.
// ---------------------------------------------------------------------------
TEST_CASE("Preservation (concrete): diagonal within-envelope draw accounting",
          "[motion][preservation][bugfix][property-3][example]") {
  HarnessDP h;
  // A within-envelope diagonal: dx=200, dy=-120 at mid feed.
  REQUIRE(h.planner.submit(makeDrawCmd(0, 200, -120, 500)));
  runToIdle(h.planner);

  CHECK(h.planner.position().x_steps == 200);
  CHECK(h.planner.position().y_steps == -120);
  CHECK(h.sink.stepsX == 200u * MICROSTEP_FACTOR);
  CHECK(h.sink.stepsY == 120u * MICROSTEP_FACTOR);
  CHECK(h.planner.microstepsEmitted() == (200u + 120u) * MICROSTEP_FACTOR);
  CHECK(h.sink.dirX == 1);
  CHECK(h.sink.dirY == -1);
}
