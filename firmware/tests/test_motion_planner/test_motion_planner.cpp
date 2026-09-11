// Host-side unit / sanity tests for MotionPlanner (Task 6.9).
//
// Validates the contract in Design §3.2.5 and Requirements 6.1, 6.2, 6.4, 6.6,
// 9.2, 9.4, 9.5:
//   * submit() returns false once the 32-deep ring buffer is full (Req 6.4)
//   * a simple segment produces exactly |dx| / |dy| counted full steps and
//     ends at the expected logical position (Req 6.1, 6.2)
//   * microstep output count == full steps * MICROSTEP_FACTOR (16) (Req 6.2)
//   * pause() halts pulse generation and resume() continues from the exact
//     position (Req 9.2, 9.4)
//   * cancel() drains the ring buffer and goes idle (Req 9.5)
//   * the logical position is staged to NVM at segment boundaries (Design
//     §3.2.7)
//
// The property tests for pause/resume fidelity (Task 6.10) and jog (Task 6.11)
// are intentionally NOT here -- they are separate tasks.
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment sets `test_build_src = no`, so (mirroring
// test_backlash / test_nvm) this translation unit pulls the implementations in
// directly via relative includes, driving onStepIsr() by hand in place of a
// real GPT timer.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <cstring>
#include <functional>

#include "../../src/types.h"
#include "../../src/backlash/backlash_compensator.h"
#include "../../src/motion/motion_planner.h"

// Implementations (test_build_src = no -> include the .cpp bodies directly).
#include "../../src/backlash/backlash_compensator.cpp"  // NOLINT
#include "../../src/motion/bresenham.cpp"               // NOLINT
#include "../../src/motion/ramp.cpp"                    // NOLINT
#include "../../src/motion/motion_planner.cpp"          // NOLINT

using etch::DrawingCommand;
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

// --- In-memory backlash store (same shape as test_backlash's FakeStore) -----
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
      // Iteration budget exceeded: a logic bug kept the planner from idling.
      CHECK(guard <= maxFullSteps);
      return;
    }
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// Req 6.4 -- submit() returns false when the buffer is full
// ---------------------------------------------------------------------------

TEST_CASE("submit fills the 32-deep buffer then returns false",
          "[motion][buffer]") {
  Harness h;

  // Fill every logical slot without servicing (servicing would pop one and
  // free a slot). COMMAND_BUFFER_SIZE == 32 (Requirement 6.4).
  for (std::uint32_t i = 0; i < etch::COMMAND_BUFFER_SIZE; ++i) {
    CHECK(h.planner.submit(makeCmd(i, 10, 0, 500)));
  }
  CHECK(h.planner.freeSlots() == 0u);

  // The buffer is full: the next submit must fail without enqueuing.
  CHECK_FALSE(h.planner.submit(makeCmd(999, 10, 0, 500)));
  CHECK(h.planner.freeSlots() == 0u);
}

// ---------------------------------------------------------------------------
// Req 6.1 / 6.2 -- counted steps and final logical position
// ---------------------------------------------------------------------------

TEST_CASE("a single-axis segment ends at the expected logical position",
          "[motion][position]") {
  Harness h;

  REQUIRE(h.planner.submit(makeCmd(0, 25, 0, 600)));
  runToIdle(h.planner);

  const Position p = h.planner.position();
  CHECK(p.x_steps == 25);
  CHECK(p.y_steps == 0);
  CHECK(h.sink.enabled);          // drivers were energised for the move
  CHECK(h.sink.dirX == 1);        // +X direction latched
}

TEST_CASE("a diagonal segment counts both axes and lands on target",
          "[motion][position]") {
  Harness h;

  // Negative X, positive Y diagonal.
  REQUIRE(h.planner.submit(makeCmd(0, -12, 12, 400)));
  runToIdle(h.planner);

  const Position p = h.planner.position();
  CHECK(p.x_steps == -12);
  CHECK(p.y_steps == 12);
  CHECK(h.sink.dirX == -1);
  CHECK(h.sink.dirY == 1);
}

TEST_CASE("consecutive segments accumulate logical position",
          "[motion][position]") {
  Harness h;

  REQUIRE(h.planner.submit(makeCmd(0, 10, 5, 500)));
  REQUIRE(h.planner.submit(makeCmd(1, -4, 8, 500)));
  runToIdle(h.planner);

  const Position p = h.planner.position();
  CHECK(p.x_steps == 10 - 4);
  CHECK(p.y_steps == 5 + 8);
}

TEST_CASE("nudgePosition adds signed full-step deltas to the logical position",
          "[motion][position]") {
  Harness h;

  // Starts at home.
  REQUIRE(h.planner.position().x_steps == 0);
  REQUIRE(h.planner.position().y_steps == 0);

  // Nudges accumulate (used by the blocking jog path that pulses STEP outside
  // the timer-driven segment path).
  h.planner.nudgePosition(25, 0);
  CHECK(h.planner.position().x_steps == 25);
  CHECK(h.planner.position().y_steps == 0);

  h.planner.nudgePosition(-10, 7);
  CHECK(h.planner.position().x_steps == 15);
  CHECK(h.planner.position().y_steps == 7);

  // Nudges compose with timer-driven segment counting.
  REQUIRE(h.planner.submit(makeCmd(0, 4, -3, 500)));
  runToIdle(h.planner);
  CHECK(h.planner.position().x_steps == 15 + 4);
  CHECK(h.planner.position().y_steps == 7 - 3);
}

// ---------------------------------------------------------------------------
// Req 6.2 -- microstep output count == full steps * MICROSTEP_FACTOR
// ---------------------------------------------------------------------------

TEST_CASE("microstep pulses equal full steps times the microstep factor",
          "[motion][microstep]") {
  Harness h;

  const std::int16_t dx = 30;
  const std::int16_t dy = 0;
  REQUIRE(h.planner.submit(makeCmd(0, dx, dy, 700)));
  runToIdle(h.planner);

  // Pure X move: |dx| full steps, each emitted as MICROSTEP_FACTOR microsteps.
  CHECK(h.sink.stepsX == static_cast<std::uint32_t>(dx) * MICROSTEP_FACTOR);
  CHECK(h.sink.stepsY == 0u);
  CHECK(h.planner.microstepsEmitted() ==
        static_cast<std::uint32_t>(dx) * MICROSTEP_FACTOR);
}

TEST_CASE("diagonal microstep counts equal each axis full steps times 16",
          "[motion][microstep]") {
  Harness h;

  // |dx| == |dy| == 8: Bresenham steps both axes on every tick, so each axis
  // emits 8 * 16 microsteps.
  REQUIRE(h.planner.submit(makeCmd(0, 8, -8, 500)));
  runToIdle(h.planner);

  CHECK(h.sink.stepsX == 8u * MICROSTEP_FACTOR);
  CHECK(h.sink.stepsY == 8u * MICROSTEP_FACTOR);
}

// ---------------------------------------------------------------------------
// Req 9.2 / 9.4 -- pause halts pulses, resume continues from exact position
// ---------------------------------------------------------------------------

TEST_CASE("pause halts pulse generation and resume continues to target",
          "[motion][pause]") {
  Harness h;

  REQUIRE(h.planner.submit(makeCmd(0, 40, 0, 500)));
  h.planner.serviceLoop();  // start the segment

  // Advance 10 full steps, then pause mid-segment.
  for (int i = 0; i < 10; ++i) {
    pumpFullStep(h.planner);
  }
  CHECK(h.planner.position().x_steps == 10);

  h.planner.pause();
  CHECK(h.planner.isPaused());

  // Snapshot pulse + position state, then pump many ISR ticks while paused.
  const std::uint32_t pulses_at_pause = h.planner.microstepsEmitted();
  const std::int32_t pos_at_pause = h.planner.position().x_steps;
  for (int i = 0; i < 100; ++i) {
    h.planner.onStepIsr();
  }
  // No pulses emitted and no position change while paused (Req 9.2).
  CHECK(h.planner.microstepsEmitted() == pulses_at_pause);
  CHECK(h.planner.position().x_steps == pos_at_pause);

  // Resume and run to completion: the move finishes at the exact target with
  // no lost or duplicated steps (Req 9.4).
  h.planner.resume();
  CHECK_FALSE(h.planner.isPaused());
  runToIdle(h.planner);

  CHECK(h.planner.position().x_steps == 40);
  CHECK(h.sink.stepsX == 40u * MICROSTEP_FACTOR);
}

// ---------------------------------------------------------------------------
// Req 9.5 -- cancel drains the buffer and returns to idle
// ---------------------------------------------------------------------------

TEST_CASE("cancel clears the command buffer and goes idle", "[motion][cancel]") {
  Harness h;

  for (std::uint32_t i = 0; i < 12; ++i) {
    REQUIRE(h.planner.submit(makeCmd(i, 20, 0, 500)));
  }
  h.planner.serviceLoop();          // pop + start the first segment
  pumpFullStep(h.planner);          // make some progress
  REQUIRE(h.planner.freeSlots() < etch::COMMAND_BUFFER_SIZE);

  h.planner.cancel();

  // Buffer fully drained and planner idle within the (trivially met) 100 ms
  // budget; position is retained, not reset.
  CHECK(h.planner.freeSlots() == etch::COMMAND_BUFFER_SIZE);
  CHECK(h.planner.isIdle());
  CHECK(h.planner.position().x_steps >= 1);  // progress before cancel survived
}

TEST_CASE("stop discards buffered commands and halts", "[motion][stop]") {
  Harness h;

  for (std::uint32_t i = 0; i < 6; ++i) {
    REQUIRE(h.planner.submit(makeCmd(i, 15, 0, 500)));
  }
  h.planner.serviceLoop();
  pumpFullStep(h.planner);

  h.planner.stop();
  CHECK(h.planner.freeSlots() == etch::COMMAND_BUFFER_SIZE);
  CHECK(h.planner.isIdle());
}

// ---------------------------------------------------------------------------
// Design §3.2.7 -- logical position is staged to NVM at segment boundaries
// ---------------------------------------------------------------------------

TEST_CASE("completing a segment stages the logical position into NVM",
          "[motion][nvm]") {
  Harness h;

  REQUIRE(h.planner.submit(makeCmd(0, 7, 3, 500)));
  runToIdle(h.planner);

  // The planner staged the final position via mutate() (debounced commit is
  // the NVM layer's job; we only verify the staged record here).
  CHECK(h.nvm.mutates >= 1u);
  CHECK(h.nvm.cfg.logical_pos_x == 7);
  CHECK(h.nvm.cfg.logical_pos_y == 3);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
