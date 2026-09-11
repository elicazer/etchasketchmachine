// Host-side control-flow tests for MotionPlanner (Task 32.3, integration).
//
// Task 32.3 verifies the *real motion semantics* behind the three drawing
// control messages the web UI sends mid-drawing (Requirement 9.1-9.8):
//
//   * PAUSE / RESUME  -> MotionPlanner::pause() / resume()
//   * CANCEL          -> MotionPlanner::cancel()
//   * SPEED_PCT       -> MotionPlanner::setSpeedPct()
//
// The web side of this same task (web/src/net/control_flow.e2e.test.ts) checks
// that the UI control callbacks map to the correct CTL frames and fold the
// firmware's STATE replies into the stores. This file is the firmware half: it
// drives the planner directly to prove the underlying motion behaviour those
// control messages trigger, namely:
//
//   * pause() mid-segment halts pulse emission immediately (no further
//     microsteps while paused) and retains the exact position; resume()
//     finishes the segment at the exact target with no lost or duplicated
//     steps (Req 9.2, 9.4).
//   * cancel() drains the ring buffer and goes idle immediately, retaining the
//     logical position (Req 9.5).
//   * setSpeedPct() applies at the NEXT segment boundary, never mid-segment:
//     the in-flight segment is not interrupted and completes intact, while the
//     newly-started segment picks up the new scaling (Req 9.7, 9.8).
//
// This COMPLEMENTS the pause/resume property test (Task 6.10) and the
// MotionPlanner sanity tests (Task 6.9) with concrete control-flow scenarios;
// it deliberately does not re-derive those properties wholesale.
//
// Harness shape (FakeStepSink / FakeBacklashStore / FakeMotionNvm, pumpFullStep,
// runToIdle) mirrors tests/test_motion_planner/test_motion_planner.cpp. As in
// that file, the host_test environment sets `test_build_src = no`, so this
// translation unit pulls the implementations in directly via relative includes
// and drives onStepIsr() by hand in place of a real GPT timer.
//
// Note on timer rate observability: on the host build setTimerRateHz_() is a
// deterministic no-op (the ramp speed never reaches a real timer), so the
// commanded sps is not observable through the step sink. The planner exposes
// speedPct() for the live scaling value, and the trapezoidal schedule is
// computed by the shared TrapezoidRamp; the SPEED_PCT test therefore asserts
// (a) the live speedPct() updates immediately, (b) the in-flight segment is not
// interrupted and finishes intact, and (c) the per-segment scaling the planner
// applies at a boundary, reconstructed with the same TrapezoidRamp the planner
// uses internally, lowers the achievable peak for the post-change segment.
//
// Run with:
//
//     pio test -e host_test
//
// or syntax-check against the stub when PlatformIO is unavailable:
//
//     c++ -std=gnu++17 -DUNIT_TEST_HOST -I.compile_check_stub \
//         -fsyntax-only tests/test_control_flow/test_control_flow.cpp

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <cstring>
#include <functional>

#include "../../src/types.h"
#include "../../src/backlash/backlash_compensator.h"
#include "../../src/motion/motion_planner.h"
#include "../../src/motion/ramp.h"

// Implementations (test_build_src = no -> include the .cpp bodies directly).
#include "../../src/backlash/backlash_compensator.cpp"  // NOLINT
#include "../../src/motion/bresenham.cpp"               // NOLINT
#include "../../src/motion/ramp.cpp"                    // NOLINT
#include "../../src/motion/motion_planner.cpp"          // NOLINT

using etch::DrawingCommand;
using etch::FEED_SPS_MIN;
using etch::MICROSTEP_FACTOR;
using etch::NVM_MAGIC;
using etch::NVM_VERSION;
using etch::PersistedConfig;
using etch::Position;
using etch::SPEED_PCT_MAX;
using etch::SPEED_PCT_MIN;
using etch::backlash::BacklashCompensator;
using etch::backlash::IBacklashStore;
using etch::motion::IMotionNvm;
using etch::motion::IStepSink;
using etch::motion::MotionPlanner;
using etch::motion::MOTION_DEFAULT_ACCEL_SPS;
using etch::motion::TrapezoidRamp;

namespace {

// --- In-memory backlash store (same shape as test_motion_planner) -----------
class FakeBacklashStore : public IBacklashStore {
 public:
  FakeBacklashStore() {
    std::memset(&cfg_, 0, sizeof(cfg_));
    cfg_.magic = NVM_MAGIC;
    cfg_.version = NVM_VERSION;
  }
  const PersistedConfig& get() const override { return cfg_; }
  void mutate(std::function<void(PersistedConfig&)> fn) override { fn(cfg_); }
  PersistedConfig& raw() { return cfg_; }

 private:
  PersistedConfig cfg_;
};

// --- Pin-output fake: counts microstep pulses and latches DIR / EN ----------
class FakeStepSink : public IStepSink {
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

// --- NVM fake: records staged position + counts mutate/flush calls ----------
class FakeMotionNvm : public IMotionNvm {
 public:
  PersistedConfig cfg{};
  std::size_t mutates = 0;
  std::size_t flushes = 0;

  FakeMotionNvm() { std::memset(&cfg, 0, sizeof(cfg)); }

  void mutate(std::function<void(PersistedConfig&)> fn) override {
    fn(cfg);
    ++mutates;
  }
  void flushIfDue() override { ++flushes; }
};

// --- Test harness bundling a planner with its fakes -------------------------
struct Harness {
  FakeBacklashStore store;
  BacklashCompensator backlash{store};
  FakeStepSink sink;
  FakeMotionNvm nvm;
  MotionPlanner::RingBufferT buffer;
  MotionPlanner planner{buffer, backlash, sink, nvm};

  Harness() {
    backlash.load();  // backlash 0/0 -> never injects compensation steps
    planner.begin();
  }
};

DrawingCommand makeCmd(std::uint32_t seq, std::int16_t dx, std::int16_t dy,
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

// Pump exactly one full motor step worth of EMITTED microsteps.
//
// DDS-aware: the GPT now ticks at a fixed STEP_TICK_HZ and onStepIsr() emits a
// microstep only when the software phase accumulator rolls over, so one full
// motor step spans a variable number of raw onStepIsr() calls depending on the
// commanded speed. One full Bresenham step is always MICROSTEP_FACTOR
// *emitting* ticks, so drive raw ticks until MICROSTEP_FACTOR microsteps have
// been emitted. This reproduces the pre-DDS contract of advancing exactly one
// counted full step, independent of the timer-rate mechanism.
void pumpFullStep(MotionPlanner& mp) {
  long emittingTicks = 0;
  std::uint32_t prev = mp.microstepsEmitted();
  long guard = 0;
  const long guardMax = 5'000'000;
  while (emittingTicks < MICROSTEP_FACTOR) {
    mp.onStepIsr();
    const std::uint32_t now = mp.microstepsEmitted();
    if (now != prev) {
      ++emittingTicks;
      prev = now;
    }
    if (++guard > guardMax) break;
  }
}

// Pump `n` full motor steps.
void pumpFullSteps(MotionPlanner& mp, int n) {
  for (int i = 0; i < n; ++i) {
    pumpFullStep(mp);
  }
}

// Drive the planner to idle: service the loop, then pump a full step's worth of
// ISR ticks, repeating until idle. Bounded so a logic bug fails fast instead of
// hanging the suite. MUST NOT be used while paused (a paused planner never
// reaches idle by design).
void runToIdle(MotionPlanner& mp, int maxFullSteps = 200000) {
  int guard = 0;
  while (!mp.isIdle()) {
    mp.serviceLoop();
    pumpFullStep(mp);
    if (++guard > maxFullSteps) {
      CHECK(guard <= maxFullSteps);
      return;
    }
  }
}

}  // namespace

// ===========================================================================
// PAUSE / RESUME -- Req 9.2 (pause halts pulses) + Req 9.4 (resume from exact
// position, no lost/duplicated steps). Concrete diagonal-segment scenario,
// complementing the Task 6.10 property test.
// ===========================================================================

TEST_CASE(
    "pause mid-segment halts pulses immediately and resume finishes the "
    "diagonal at the exact target",
    "[control][pause][resume]") {
  Harness h;

  // A 30x30 diagonal: both axes step on every Bresenham tick, so a paused
  // tick that leaked through would show up on BOTH axis pulse counters.
  REQUIRE(h.planner.submit(makeCmd(0, 30, 30, 600)));
  h.planner.serviceLoop();  // pop + start the segment
  REQUIRE_FALSE(h.planner.isIdle());

  // Advance 12 full steps into the move, then pause mid-segment.
  pumpFullSteps(h.planner, 12);
  CHECK(h.planner.position().x_steps == 12);
  CHECK(h.planner.position().y_steps == 12);

  h.planner.pause();
  CHECK(h.planner.isPaused());

  // Snapshot pulse + position state, then pump MANY ISR ticks while paused.
  // Req 9.2: no further microsteps may be emitted while paused, and the exact
  // position must be retained for resume().
  const std::uint32_t pulses_at_pause = h.planner.microstepsEmitted();
  const std::uint32_t sx_at_pause = h.sink.stepsX;
  const std::uint32_t sy_at_pause = h.sink.stepsY;
  const std::int32_t px_at_pause = h.planner.position().x_steps;
  const std::int32_t py_at_pause = h.planner.position().y_steps;

  for (int i = 0; i < 500; ++i) {
    h.planner.onStepIsr();
  }

  CHECK(h.planner.microstepsEmitted() == pulses_at_pause);
  CHECK(h.sink.stepsX == sx_at_pause);
  CHECK(h.sink.stepsY == sy_at_pause);
  CHECK(h.planner.position().x_steps == px_at_pause);
  CHECK(h.planner.position().y_steps == py_at_pause);
  // The segment is still in flight (paused, not aborted): not idle.
  CHECK_FALSE(h.planner.isIdle());

  // Resume and run to completion. Req 9.4: the move finishes at the exact
  // target with no lost or duplicated steps.
  h.planner.resume();
  CHECK_FALSE(h.planner.isPaused());
  runToIdle(h.planner);

  CHECK(h.planner.position().x_steps == 30);
  CHECK(h.planner.position().y_steps == 30);
  // Exactly |dx| / |dy| full steps' worth of microsteps on each axis -- no
  // step was lost or duplicated across the pause boundary.
  CHECK(h.sink.stepsX == 30u * MICROSTEP_FACTOR);
  CHECK(h.sink.stepsY == 30u * MICROSTEP_FACTOR);
}

TEST_CASE(
    "resume only continues an in-flight segment and never replays the paused "
    "tick",
    "[control][resume]") {
  Harness h;

  REQUIRE(h.planner.submit(makeCmd(0, 16, 0, 500)));
  h.planner.serviceLoop();

  pumpFullSteps(h.planner, 4);
  CHECK(h.planner.position().x_steps == 4);

  // Pause, then resume immediately without pumping while paused: the planner
  // must pick up at exactly the same position (no duplicated step on resume).
  h.planner.pause();
  const std::int32_t px = h.planner.position().x_steps;
  h.planner.resume();
  CHECK(h.planner.position().x_steps == px);

  runToIdle(h.planner);
  CHECK(h.planner.position().x_steps == 16);
  CHECK(h.sink.stepsX == 16u * MICROSTEP_FACTOR);
}

// ===========================================================================
// CANCEL -- Req 9.5: stop both motors and clear the command buffer
// immediately (within 100 ms), retaining the logical position.
// ===========================================================================

TEST_CASE(
    "cancel drains the ring buffer, goes idle immediately, and retains "
    "position",
    "[control][cancel]") {
  Harness h;

  // Queue several segments and make partial progress on the first.
  for (std::uint32_t i = 0; i < 10; ++i) {
    REQUIRE(h.planner.submit(makeCmd(i, 25, 0, 500)));
  }
  h.planner.serviceLoop();  // pop + start the first segment
  pumpFullSteps(h.planner, 7);
  const std::int32_t progressed = h.planner.position().x_steps;
  REQUIRE(progressed >= 1);
  REQUIRE(h.planner.freeSlots() < etch::COMMAND_BUFFER_SIZE);

  h.planner.cancel();

  // The buffer is fully drained and the planner is idle right away (the O(32)
  // drain is trivially within the 100 ms budget). Position is retained at the
  // last completed full step, not reset.
  CHECK(h.planner.freeSlots() == etch::COMMAND_BUFFER_SIZE);
  CHECK(h.planner.isIdle());
  CHECK_FALSE(h.planner.isPaused());
  CHECK(h.planner.position().x_steps == progressed);

  // After cancel the planner stays idle: servicing the loop and pumping ticks
  // emits no further motion (nothing left to draw).
  const std::uint32_t pulses_after_cancel = h.planner.microstepsEmitted();
  h.planner.serviceLoop();
  pumpFullSteps(h.planner, 20);
  CHECK(h.planner.microstepsEmitted() == pulses_after_cancel);
  CHECK(h.planner.position().x_steps == progressed);
}

TEST_CASE("cancel while paused also drains the buffer and clears the pause",
          "[control][cancel][pause]") {
  Harness h;

  for (std::uint32_t i = 0; i < 5; ++i) {
    REQUIRE(h.planner.submit(makeCmd(i, 20, 0, 500)));
  }
  h.planner.serviceLoop();
  pumpFullSteps(h.planner, 3);
  h.planner.pause();
  REQUIRE(h.planner.isPaused());

  h.planner.cancel();

  CHECK_FALSE(h.planner.isPaused());
  CHECK(h.planner.freeSlots() == etch::COMMAND_BUFFER_SIZE);
  CHECK(h.planner.isIdle());
  CHECK(h.planner.position().x_steps == 3);
}

// ===========================================================================
// SPEED_PCT -- Req 9.7 / 9.8: a speed change applies at the NEXT segment
// boundary, not mid-segment. The in-flight segment is not interrupted.
// ===========================================================================

TEST_CASE(
    "setSpeedPct updates the live scaling immediately without interrupting "
    "the in-flight segment",
    "[control][speed]") {
  Harness h;

  // Two back-to-back single-axis segments. The speed change happens while the
  // first is running; it must finish intact, and the second must start under
  // the new scaling.
  REQUIRE(h.planner.submit(makeCmd(0, 40, 0, 1000)));  // segment 1
  REQUIRE(h.planner.submit(makeCmd(1, 40, 0, 1000)));  // segment 2

  // Planner starts at the default full speed.
  CHECK(h.planner.speedPct() == SPEED_PCT_MAX);

  h.planner.serviceLoop();  // pop + start segment 1 (built at 100%)
  pumpFullSteps(h.planner, 15);
  CHECK(h.planner.position().x_steps == 15);
  REQUIRE_FALSE(h.planner.isIdle());

  // Adjust speed mid-segment-1.
  const std::uint32_t pulses_before = h.planner.microstepsEmitted();
  const std::int32_t pos_before = h.planner.position().x_steps;
  h.planner.setSpeedPct(50);

  // Req 9.8: the change does NOT interrupt the current segment -- no pulses
  // emitted, no position change, still active (not paused, not idle) as a pure
  // side effect of the call.
  CHECK(h.planner.speedPct() == 50);                       // live value updated
  CHECK(h.planner.microstepsEmitted() == pulses_before);   // no pulse emitted
  CHECK(h.planner.position().x_steps == pos_before);       // no position change
  CHECK_FALSE(h.planner.isPaused());
  CHECK_FALSE(h.planner.isIdle());

  // Finish segment 1: it completes at its exact target with the full step
  // count, unaffected by the mid-flight speed change (no lost/duplicated steps).
  pumpFullSteps(h.planner, 25);  // 15 + 25 == 40
  CHECK(h.planner.position().x_steps == 40);
  CHECK(h.sink.stepsX == 40u * MICROSTEP_FACTOR);

  // Boundary crossing: serviceLoop finalises segment 1 and starts segment 2,
  // which reads the new speed_pct_ (50) in beginSegment_.
  runToIdle(h.planner);
  CHECK(h.planner.position().x_steps == 80);  // both 40-step segments done
  CHECK(h.sink.stepsX == 80u * MICROSTEP_FACTOR);
  CHECK(h.planner.speedPct() == 50);
}

TEST_CASE("setSpeedPct clamps out-of-range values into [25, 100]",
          "[control][speed]") {
  Harness h;

  h.planner.setSpeedPct(10);  // below SPEED_PCT_MIN
  CHECK(h.planner.speedPct() == SPEED_PCT_MIN);

  h.planner.setSpeedPct(200);  // above SPEED_PCT_MAX
  CHECK(h.planner.speedPct() == SPEED_PCT_MAX);

  h.planner.setSpeedPct(60);  // in range
  CHECK(h.planner.speedPct() == 60);
}

TEST_CASE(
    "the post-change segment uses the new speed scaling at its boundary "
    "(reconstructed ramp)",
    "[control][speed][ramp]") {
  // On the host, the commanded sps drives setTimerRateHz_() which is a no-op,
  // so the per-step rate is not observable through the step sink. We instead
  // reconstruct the trapezoidal schedule with the SAME TrapezoidRamp the
  // planner builds in beginSegment_() (ramp_.init(steps, FEED_SPS_MIN, feed,
  // accel, speed_pct_)) to document the scaling each segment receives at its
  // boundary:
  //   * segment 1 begins while speed_pct_ == 100  -> full peak
  //   * segment 2 begins after setSpeedPct(50)     -> halved peak
  const std::uint32_t steps = 40;
  const std::uint16_t feed = 1000;
  const std::uint16_t accel = MOTION_DEFAULT_ACCEL_SPS;

  TrapezoidRamp seg1{steps, FEED_SPS_MIN, feed, accel, SPEED_PCT_MAX};  // 100%
  TrapezoidRamp seg2{steps, FEED_SPS_MIN, feed, accel, 50};            // 50%

  // The newly-started segment targets a strictly lower peak speed than the
  // segment that was already in flight when the slider moved (Req 9.7/9.8).
  CHECK(seg2.peak() < seg1.peak());
  // The pre-change segment is unaffected: its peak still reflects 100% scaling.
  CHECK(seg1.peak() == feed);
  // The post-change segment's peak reflects the 50% scaling (clamped >= vMin).
  CHECK(seg2.peak() == (feed / 2));
  // Both schedules still start and end at the safe floor speed (Req 5.5).
  CHECK(seg1.speedAt(0) == FEED_SPS_MIN);
  CHECK(seg1.speedAt(steps - 1) == FEED_SPS_MIN);
  CHECK(seg2.speedAt(0) == FEED_SPS_MIN);
  CHECK(seg2.speedAt(steps - 1) == FEED_SPS_MIN);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
