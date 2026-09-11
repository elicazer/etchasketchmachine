// Host-side full drawing-execution flow test (Task 32.1, Design §5.2,
// Requirements 6.1, 6.2, 10.6, 10.7, 14.6, 14.7).
//
// PlatformIO is not installed and there is no device, so the firmware half of
// the integration is realised as a host harness driving the REAL motion stack
// through a whole drawing:
//
//   1. BEGIN_DRAW  -> mark the (fake) NVM busy (unclean=true), arm AutoReturn.
//   2. Stream a sequence of DrawingCommands (strokes AND connector-flagged
//      commands) into the MotionPlanner and run them to idle by pumping
//      onStepIsr() exactly as test_motion_planner.cpp does.
//   3. END_DRAW    -> AutoReturn.onEndDraw(); poll() until it asks us to
//      EnqueueReturn, then build the return move with buildReturnCommands()
//      (app/auto_return.h) and run that to idle as well.
//   4. poll() once more at home -> Finalize -> markCleanIdle() + flush.
//
// Assertions (the §5.2 contract):
//   * the logical position tracks through the whole drawing: after each
//     command the planner.position() equals the running sum of the counted
//     deltas, and connector commands move the pen just like strokes
//     (Req 6.1, 6.2, 14.6);
//   * the logical position is STAGED into the (fake) NVM during the drawing
//     and again after it (mutate() called per segment boundary, the staged
//     logical_pos_* tracking the planner) (Req 10.6);
//   * the synthesized return parks the stylus exactly at home (0,0)
//     (Req 10.7 / 14.7), and once idle at home AutoReturn finalizes and the
//     NVM is marked clean-idle (unclean flag cleared) (Req 10.7).
//
// This mirrors the FakeStepSink / FakeMotionNvm / FakeBacklashStore seams from
// test_motion_planner.cpp and the AutoReturn driving from test_auto_return.cpp.
//
// Run with:
//
//     pio test -e host_test
//
// host_test sets test_build_src = no, so (like the sibling suites) this
// translation unit pulls the implementations in directly via relative includes
// and drives onStepIsr() by hand in place of a real GPT timer.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <cstring>
#include <functional>
#include <vector>

#include "../../src/types.h"
#include "../../src/app/auto_return.h"
#include "../../src/backlash/backlash_compensator.h"
#include "../../src/motion/motion_planner.h"

// Implementations (test_build_src = no -> include the .cpp bodies directly).
#include "../../src/backlash/backlash_compensator.cpp"  // NOLINT
#include "../../src/motion/bresenham.cpp"               // NOLINT
#include "../../src/motion/ramp.cpp"                    // NOLINT
#include "../../src/motion/motion_planner.cpp"          // NOLINT

using etch::CMD_FLAG_CONNECTOR;
using etch::CMD_FLAG_LAST_OF_BATCH;
using etch::DrawingCommand;
using etch::MICROSTEP_FACTOR;
using etch::NVM_FLAG_UNCLEAN;
using etch::NVM_MAGIC;
using etch::NVM_VERSION;
using etch::PersistedConfig;
using etch::Position;
using etch::app::AUTO_RETURN_MAX_COMMANDS;
using etch::app::AutoReturn;
using etch::app::buildReturnCommands;
using etch::app::RETURN_FEED_SPS;
using etch::backlash::BacklashCompensator;
using etch::backlash::IBacklashStore;
using etch::motion::IMotionNvm;
using etch::motion::IStepSink;
using etch::motion::MotionPlanner;
using Action = etch::app::AutoReturn::Action;

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

// --- NVM fake: records staged position + the unclean flag -------------------
// Models the slice of NVMManager the planner + main-loop Controller touch
// during a drawing. begin()-equivalent state is seeded busy (unclean=true) by
// the BEGIN_DRAW step; markCleanIdle() clears it at finalize. flushIfDue() is
// a no-op commit counter here (debounce semantics live in the real NVM layer).
class FakeMotionNvm : public IMotionNvm {
 public:
  PersistedConfig cfg{};
  std::size_t mutates = 0;
  std::size_t flushes = 0;

  FakeMotionNvm() {
    std::memset(&cfg, 0, sizeof(cfg));
    cfg.magic = NVM_MAGIC;
    cfg.version = NVM_VERSION;
  }

  // MotionPlanner stages the logical position through this at each segment
  // boundary (Design §3.2.7).
  void mutate(std::function<void(PersistedConfig&)> fn) override {
    fn(cfg);
    ++mutates;
  }
  void flushIfDue() override { ++flushes; }

  // Main-loop Controller helpers (etchasketch.ino markBusy/markCleanIdle).
  void markBusy() {
    cfg.flags = static_cast<std::uint8_t>(cfg.flags | NVM_FLAG_UNCLEAN);
  }
  void markCleanIdle() {
    cfg.flags = static_cast<std::uint8_t>(cfg.flags & ~NVM_FLAG_UNCLEAN);
  }
  bool unclean() const { return (cfg.flags & NVM_FLAG_UNCLEAN) != 0; }
};

// --- Test harness bundling a planner with its fakes -------------------------
struct Harness {
  FakeBacklashStore store;
  BacklashCompensator backlash{store};
  FakeStepSink sink;
  FakeMotionNvm nvm;
  MotionPlanner::RingBufferT buffer;
  MotionPlanner planner{buffer, backlash, sink, nvm};
  AutoReturn autoReturn;

  Harness() {
    backlash.load();  // backlash 0/0 -> never injects compensation steps
    planner.begin();
  }
};

DrawingCommand makeCmd(std::uint32_t seq, std::int16_t dx, std::int16_t dy,
                       std::uint16_t feed, std::uint16_t flags) {
  DrawingCommand c{};
  c.seq = seq;
  c.dx_steps = dx;
  c.dy_steps = dy;
  c.feed_sps = feed;
  c.flags = flags;
  c.reserved = 0;
  c.crc16_payload = 0;
  return c;
}

// Pump exactly one full motor step worth of microstep ISR ticks.
void pumpFullStep(MotionPlanner& mp) {
  for (std::uint8_t k = 0; k < MICROSTEP_FACTOR; ++k) {
    mp.onStepIsr();
  }
}

// Drive the planner to idle (bounded so a logic bug fails fast). MUST NOT be
// used while paused. Mirrors test_motion_planner.cpp's runToIdle.
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

// ---------------------------------------------------------------------------
// Full drawing flow: stream strokes + connectors, track position through the
// whole drawing, then auto-return to home and mark clean-idle.
// ---------------------------------------------------------------------------

TEST_CASE("a full drawing tracks position through strokes and connectors then returns home",
          "[integration][draw][autoreturn]") {
  Harness h;

  // ---- BEGIN_DRAW: arm the completion machine and mark the NVM busy -------
  h.autoReturn.onBeginDraw();
  h.nvm.markBusy();
  REQUIRE(h.nvm.unclean());
  REQUIRE(h.autoReturn.sessionActive());

  // A multi-contour drawing as the web Path_Planner would emit it: a stroke,
  // an inter-contour CONNECTOR hop, then a second stroke. Each command's
  // deltas sum into the logical position regardless of the connector flag
  // (Req 14.6 -- connectors are real motion). We do NOT include the final
  // auto-return connector here; AutoReturn synthesizes that below (Req 10.7).
  struct Step {
    std::int16_t dx;
    std::int16_t dy;
    std::uint16_t flags;
  };
  const Step program[] = {
      {30, 0, 0},                  // stroke: contour A, rightwards
      {0, 20, 0},                  // stroke: contour A, up
      {-15, 25, CMD_FLAG_CONNECTOR},  // CONNECTOR hop to contour B
      {12, 0, 0},                  // stroke: contour B
      {0, -10, 0},                 // stroke: contour B
  };
  const std::size_t nSteps = sizeof(program) / sizeof(program[0]);

  // ---- stream the program, running each command to idle and checking the
  //      logical position tracks the running sum of counted deltas ----------
  std::int32_t expX = 0;
  std::int32_t expY = 0;
  std::size_t mutatesBefore = h.nvm.mutates;
  for (std::size_t i = 0; i < nSteps; ++i) {
    const Step& s = program[i];
    REQUIRE(h.planner.submit(
        makeCmd(static_cast<std::uint32_t>(i), s.dx, s.dy, 500, s.flags)));
    runToIdle(h.planner);

    expX += s.dx;
    expY += s.dy;

    const Position p = h.planner.position();
    CHECK(p.x_steps == expX);  // Req 6.1 / 6.2: counted-step position tracking
    CHECK(p.y_steps == expY);
  }
  CHECK(h.sink.enabled);  // drivers were energised for the drawing

  // The end of the user content is away from home, so the drawing did move.
  const Position afterContent = h.planner.position();
  CHECK((afterContent.x_steps != 0 || afterContent.y_steps != 0));

  // Req 10.6: the logical position was STAGED to NVM during the drawing (the
  // planner mutates the cached record at every segment boundary), and the
  // staged value tracks the planner's current position.
  CHECK(h.nvm.mutates > mutatesBefore);
  CHECK(h.nvm.cfg.logical_pos_x == afterContent.x_steps);
  CHECK(h.nvm.cfg.logical_pos_y == afterContent.y_steps);
  // ...and we are still mid-drawing, so the unclean marker is still set.
  CHECK(h.nvm.unclean());

  // ---- END_DRAW: drain is already idle, so AutoReturn requests the return --
  h.autoReturn.onEndDraw();
  CHECK(h.autoReturn.awaitingReturn());

  Position pos = h.planner.position();
  Action act = h.autoReturn.poll(h.planner.isIdle(), pos);
  REQUIRE(act == Action::EnqueueReturn);  // idle away from home -> return move
  CHECK(h.autoReturn.returnEnqueued());

  // Build the connector command(s) toward home exactly as etchasketch.ino's
  // serviceAutoReturn() does, and submit them.
  DrawingCommand ret[AUTO_RETURN_MAX_COMMANDS];
  const std::size_t n =
      buildReturnCommands(pos.x_steps, pos.y_steps, RETURN_FEED_SPS,
                          /*seqStart=*/0, ret, AUTO_RETURN_MAX_COMMANDS);
  REQUIRE(n >= 1u);
  // Req 14.7: the return travel is a visible CONNECTOR; the last chunk is the
  // batch terminator.
  for (std::size_t i = 0; i < n; ++i) {
    CHECK((ret[i].flags & CMD_FLAG_CONNECTOR) != 0);
    const bool isLast = (i == n - 1);
    CHECK(((ret[i].flags & CMD_FLAG_LAST_OF_BATCH) != 0) == isLast);
    REQUIRE(h.planner.submit(ret[i]));
  }

  // The just-submitted return makes the planner non-idle; poll() must not
  // enqueue a second return (the guard) before it executes.
  CHECK(h.autoReturn.poll(h.planner.isIdle(), h.planner.position()) ==
        Action::None);

  // ---- run the return to idle: the stylus parks exactly at home (0,0) ------
  runToIdle(h.planner);
  const Position home = h.planner.position();
  CHECK(home.x_steps == 0);  // Req 10.7 / 14.7: returned to Home_Position
  CHECK(home.y_steps == 0);

  // Req 10.6 (after drawing): the staged NVM position followed the return all
  // the way back to home.
  CHECK(h.nvm.cfg.logical_pos_x == 0);
  CHECK(h.nvm.cfg.logical_pos_y == 0);

  // ---- Finalize: idle AT home -> mark clean-idle + flush -------------------
  act = h.autoReturn.poll(h.planner.isIdle(), home);
  REQUIRE(act == Action::Finalize);
  h.nvm.markCleanIdle();
  h.nvm.flushIfDue();

  // Req 10.7: after auto-return completes at home the NVM is clean-idle.
  CHECK_FALSE(h.nvm.unclean());
  CHECK(h.nvm.flushes >= 1u);
  CHECK_FALSE(h.autoReturn.sessionActive());

  // The auto-return fires at most once: a further poll is a no-op.
  CHECK(h.autoReturn.poll(h.planner.isIdle(), h.planner.position()) ==
        Action::None);
}

// ---------------------------------------------------------------------------
// A drawing that already ends at home finalizes directly with no return move
// (the web Path_Planner appended the auto-return connector into the stream).
// ---------------------------------------------------------------------------

TEST_CASE("a drawing whose stream already ends at home finalizes without a synthesized return",
          "[integration][draw][autoreturn]") {
  Harness h;
  h.autoReturn.onBeginDraw();
  h.nvm.markBusy();

  // Out and back: the streamed commands (including the trailing connector home)
  // leave the planner idle exactly at (0,0).
  REQUIRE(h.planner.submit(makeCmd(0, 40, 30, 500, 0)));                 // stroke out
  REQUIRE(h.planner.submit(makeCmd(1, -40, -30, 500,
                                   CMD_FLAG_CONNECTOR | CMD_FLAG_LAST_OF_BATCH)));  // connector home
  runToIdle(h.planner);

  const Position p = h.planner.position();
  REQUIRE(p.x_steps == 0);
  REQUIRE(p.y_steps == 0);
  // The staged NVM position came back to home with the stream.
  CHECK(h.nvm.cfg.logical_pos_x == 0);
  CHECK(h.nvm.cfg.logical_pos_y == 0);

  h.autoReturn.onEndDraw();
  // Idle already AT home -> Finalize directly, no EnqueueReturn.
  CHECK(h.autoReturn.poll(h.planner.isIdle(), p) == Action::Finalize);
  CHECK_FALSE(h.autoReturn.returnEnqueued());

  h.nvm.markCleanIdle();
  h.nvm.flushIfDue();
  CHECK_FALSE(h.nvm.unclean());
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
