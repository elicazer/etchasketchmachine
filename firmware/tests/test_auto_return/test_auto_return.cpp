// Host-side tests for the drawing-completion / return-to-home state machine
// (Task 8.2, Requirements 10.7 & 14.7, Design §5.2).
//
// Validates the pure app::AutoReturn state machine and the buildReturnCommands
// connector synthesis that the main-loop Controller drives:
//
//   * END_DRAW -> awaiting -> EnqueueReturn (once) when the planner drains
//     idle away from home, then Finalize when it returns idle at home;
//   * no double-trigger: the synthesized return move does not itself spawn
//     another return, and Finalize fires at most once per drawing;
//   * no-op when the stream already ended at home (Finalize directly);
//   * CANCEL / STOP / abort (reset()) suppresses any auto-return;
//   * buildReturnCommands emits connector (-x,-y) commands that sum exactly to
//     home, stay within the i16 wire bound, and flag the final command
//     LAST_OF_BATCH (Req 14.7 / Property 12).
//
// The state machine has no Arduino / socket / motion dependencies, so the
// suite is fully deterministic. Run with:
//
//     pio test -e host_test
//
// AutoReturn is header-only (test_build_src = no), so no .cpp body is pulled.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>

#include "../../src/app/auto_return.h"
#include "../../src/types.h"

using etch::DrawingCommand;
using etch::Position;
using etch::CMD_FLAG_CONNECTOR;
using etch::CMD_FLAG_LAST_OF_BATCH;
using etch::CMD_FLAG_RESERVED_MASK;
using etch::app::AutoReturn;
using etch::app::buildReturnCommands;
using etch::app::AUTO_RETURN_MAX_COMMANDS;
using etch::app::RETURN_DELTA_MAX;
using etch::app::RETURN_FEED_SPS;
using Action = etch::app::AutoReturn::Action;

namespace {

// Drive a fresh AutoReturn through BEGIN_DRAW so it is mid-session.
AutoReturn drawingSession() {
  AutoReturn ar;
  ar.onBeginDraw();
  REQUIRE(ar.sessionActive());
  REQUIRE_FALSE(ar.awaitingReturn());
  return ar;
}

// Sum the per-axis deltas of a command list (the concatenated logical motion).
struct Delta {
  std::int32_t x = 0;
  std::int32_t y = 0;
};
Delta sumDeltas(const DrawingCommand* c, std::size_t n) {
  Delta d;
  for (std::size_t i = 0; i < n; ++i) {
    d.x += c[i].dx_steps;
    d.y += c[i].dy_steps;
  }
  return d;
}

}  // namespace

// ---------------------------------------------------------------------------
// State machine: END_DRAW -> awaiting -> enqueue -> finalize
// ---------------------------------------------------------------------------

TEST_CASE("END_DRAW away from home enqueues exactly one return then finalizes",
          "[app][autoreturn]") {
  AutoReturn ar = drawingSession();

  // While the planner is still streaming/draining, nothing happens even after
  // END_DRAW until it is idle.
  ar.onEndDraw();
  CHECK(ar.awaitingReturn());
  CHECK(ar.poll(/*plannerIdle=*/false, 100, 50) == Action::None);

  // Planner drains to idle away from home -> request the return move (once).
  CHECK(ar.poll(/*plannerIdle=*/true, 100, 50) == Action::EnqueueReturn);
  CHECK(ar.returnEnqueued());

  // The just-submitted return move makes the planner non-idle; no re-trigger.
  CHECK(ar.poll(/*plannerIdle=*/false, 100, 50) == Action::None);

  // A spurious idle observation before the move starts must NOT enqueue again
  // (guarded by return_enqueued_).
  CHECK(ar.poll(/*plannerIdle=*/true, 100, 50) == Action::None);

  // Return completes: planner idle AT home -> finalize exactly once.
  CHECK(ar.poll(/*plannerIdle=*/true, 0, 0) == Action::Finalize);
  CHECK_FALSE(ar.sessionActive());
  CHECK_FALSE(ar.awaitingReturn());

  // No further actions after finalize.
  CHECK(ar.poll(/*plannerIdle=*/true, 0, 0) == Action::None);
}

TEST_CASE("END_DRAW already at home finalizes without enqueuing a return",
          "[app][autoreturn]") {
  AutoReturn ar = drawingSession();
  ar.onEndDraw();

  // Stream ended exactly at home (web Path_Planner appended the connector):
  // the planner drains idle at (0,0), so we finalize directly with no move.
  CHECK(ar.poll(/*plannerIdle=*/true, 0, 0) == Action::Finalize);
  CHECK_FALSE(ar.returnEnqueued());
  CHECK_FALSE(ar.sessionActive());
}

TEST_CASE("auto-return only triggers after END_DRAW", "[app][autoreturn]") {
  AutoReturn ar = drawingSession();
  // Mid-drawing the planner is repeatedly idle between segments (buffer
  // briefly empties); without END_DRAW this must never enqueue a return.
  CHECK(ar.poll(/*plannerIdle=*/true, 100, 100) == Action::None);
  CHECK(ar.poll(/*plannerIdle=*/true, 0, 0) == Action::None);
  CHECK_FALSE(ar.awaitingReturn());
}

TEST_CASE("a stray END_DRAW with no active session is ignored",
          "[app][autoreturn]") {
  AutoReturn ar;  // never received BEGIN_DRAW
  ar.onEndDraw();
  CHECK_FALSE(ar.awaitingReturn());
  CHECK(ar.poll(/*plannerIdle=*/true, 50, 50) == Action::None);
}

// ---------------------------------------------------------------------------
// CANCEL / STOP / abort suppress the auto-return
// ---------------------------------------------------------------------------

TEST_CASE("reset() before drain suppresses the auto-return", "[app][autoreturn]") {
  AutoReturn ar = drawingSession();
  ar.onEndDraw();
  CHECK(ar.awaitingReturn());

  ar.reset();  // CANCEL / STOP / connection-loss abort
  CHECK_FALSE(ar.awaitingReturn());
  CHECK_FALSE(ar.sessionActive());

  // Even idle away from home, a reset session never returns home.
  CHECK(ar.poll(/*plannerIdle=*/true, 200, 0) == Action::None);
}

TEST_CASE("BEGIN_DRAW clears stale awaiting/enqueued state", "[app][autoreturn]") {
  AutoReturn ar = drawingSession();
  ar.onEndDraw();
  REQUIRE(ar.poll(/*plannerIdle=*/true, 100, 0) == Action::EnqueueReturn);
  REQUIRE(ar.returnEnqueued());

  // A brand new drawing starts: the previous session's flags must not leak.
  ar.onBeginDraw();
  CHECK(ar.sessionActive());
  CHECK_FALSE(ar.awaitingReturn());
  CHECK_FALSE(ar.returnEnqueued());
  CHECK(ar.poll(/*plannerIdle=*/true, 100, 0) == Action::None);
}

// ---------------------------------------------------------------------------
// buildReturnCommands: connector synthesis toward (0,0)
// ---------------------------------------------------------------------------

TEST_CASE("buildReturnCommands returns no commands when already at home",
          "[app][autoreturn]") {
  DrawingCommand out[AUTO_RETURN_MAX_COMMANDS];
  CHECK(buildReturnCommands(0, 0, RETURN_FEED_SPS, 0, out,
                            AUTO_RETURN_MAX_COMMANDS) == 0u);
}

TEST_CASE("buildReturnCommands emits a single connector for an in-range move",
          "[app][autoreturn]") {
  DrawingCommand out[AUTO_RETURN_MAX_COMMANDS];
  const std::size_t n =
      buildReturnCommands(/*x=*/120, /*y=*/-80, RETURN_FEED_SPS, /*seq=*/7, out,
                          AUTO_RETURN_MAX_COMMANDS);
  REQUIRE(n == 1u);
  CHECK(out[0].seq == 7u);
  CHECK(out[0].dx_steps == -120);  // dx = -x
  CHECK(out[0].dy_steps == 80);    // dy = -y
  CHECK(out[0].feed_sps == RETURN_FEED_SPS);
  // Connector + final-of-batch, no reserved bits (Req 14.7).
  CHECK((out[0].flags & CMD_FLAG_CONNECTOR) != 0);
  CHECK((out[0].flags & CMD_FLAG_LAST_OF_BATCH) != 0);
  CHECK((out[0].flags & CMD_FLAG_RESERVED_MASK) == 0);
  CHECK(out[0].reserved == 0);
}

TEST_CASE("buildReturnCommands splits an over-i16 move and sums to home",
          "[app][autoreturn]") {
  // 70000 steps on X exceeds the 32767 i16 bound -> 3 chunks; pair with a
  // smaller Y so collinearity / cumulative rounding is exercised.
  const std::int32_t x = 70000;
  const std::int32_t y = 1000;
  DrawingCommand out[AUTO_RETURN_MAX_COMMANDS];
  const std::size_t n =
      buildReturnCommands(x, y, RETURN_FEED_SPS, /*seq=*/100, out,
                          AUTO_RETURN_MAX_COMMANDS);
  REQUIRE(n > 1u);
  REQUIRE(n <= AUTO_RETURN_MAX_COMMANDS);

  // Concatenated deltas reproduce (-x, -y) exactly: the final command lands
  // precisely on home (Property 12 / Req 7.8).
  const Delta d = sumDeltas(out, n);
  CHECK(d.x == -x);
  CHECK(d.y == -y);

  for (std::size_t i = 0; i < n; ++i) {
    // Every chunk within the i16 wire bound.
    CHECK(static_cast<std::int32_t>(out[i].dx_steps) <= RETURN_DELTA_MAX);
    CHECK(static_cast<std::int32_t>(out[i].dx_steps) >= -RETURN_DELTA_MAX);
    CHECK(static_cast<std::int32_t>(out[i].dy_steps) <= RETURN_DELTA_MAX);
    CHECK(static_cast<std::int32_t>(out[i].dy_steps) >= -RETURN_DELTA_MAX);
    // Sequence numbers are consecutive from seqStart.
    CHECK(out[i].seq == 100u + static_cast<std::uint32_t>(i));
    // Every chunk is a connector; only the last is LAST_OF_BATCH.
    CHECK((out[i].flags & CMD_FLAG_CONNECTOR) != 0);
    const bool isLast = (i == n - 1);
    CHECK(((out[i].flags & CMD_FLAG_LAST_OF_BATCH) != 0) == isLast);
  }
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
