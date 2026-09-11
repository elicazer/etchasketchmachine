// Host-side connection-loss / recovery flow test (Task 32.2, integration).
//
// Task 32.2 verifies the §5.6 "Connection Loss Mid-Drawing" flow end to end.
// The web half (web/src/net/conn_loss.e2e.test.ts) drives the real WireClient
// through an unexpected socket drop and proves the SPA side: it opens the 60 s
// reconnect window, retains pending commands across the drop, resumes on a
// reconnect inside the window, and — when the window elapses — surfaces a
// CONN_TIMEOUT fault and rejects the pending commands.
//
// This file is the firmware half. It frames the exact §5.6 sequence diagram
// against the pure app::ConnectionMonitor state machine the main-loop
// Controller drives (firmware/src/app/connection_monitor.h), as two end-to-end
// scenarios rather than per-method unit checks:
//
//   Scenario A — pause-retain → resume (Req 7.5):
//     onDrawingStarted() → onDisconnected() mid-draw returns PauseDrawing and
//     opens the window; the buffer/position are held; onConnected() inside the
//     window returns ResumeDrawing with NO CONN_TIMEOUT pending.
//
//   Scenario B — abort-after-timeout (Req 7.6):
//     after the same mid-draw drop, tick() past the 60 s window returns
//     AbortDrawing EXACTLY once and latches connTimeoutPending() so the next
//     connect can emit ERROR{CONN_TIMEOUT}.
//
// NOTE: tests/test_app_controller/test_app_controller.cpp (Task 8.1) already
// unit-tests ConnectionMonitor method-by-method (pause-on-disconnect,
// idempotent repeats, resume-one-ms-before-deadline, abort-once,
// deliver-then-clear CONN_TIMEOUT, clean-finish cancels the abort) plus the
// §4.8 HELLO byte layout. To avoid duplicating that wholesale, this file
// instead asserts the two §5.6 *flows* as cohesive sequences and the §5.6
// branch invariant that resume and abort are mutually exclusive for a single
// disconnect. See that file for the exhaustive per-transition coverage.
//
// The monitor has no Arduino / socket / motion dependencies, so the suite is
// fully deterministic: time is injected as millisecond stamps. As with the
// other host suites, host_test sets test_build_src = no and ConnectionMonitor
// is header-only, so there is no .cpp body to include.
//
// Run with:
//
//     pio test -e host_test
//
// or syntax-check against the stub when PlatformIO is unavailable:
//
//     c++ -std=gnu++17 -DUNIT_TEST_HOST -fsyntax-only \
//         -I src -I .compile_check_stub \
//         tests/test_conn_loss/test_conn_loss.cpp

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>

#include "../../src/app/connection_monitor.h"

using etch::app::ConnectionMonitor;
using Action = etch::app::ConnectionMonitor::Action;
using etch::app::CONN_RECONNECT_WINDOW_MS;

namespace {

// Bring a fresh monitor up to a live, mid-drawing session at t = `t0`, exactly
// as the Controller would on HELLO + BEGIN_DRAW (Design §5.6 preconditions).
ConnectionMonitor drawingSession(std::uint32_t t0) {
  ConnectionMonitor cm;
  cm.onConnected(t0);     // client opens the session
  cm.onDrawingStarted();  // BEGIN_DRAW: a drawing is now in progress
  REQUIRE(cm.isConnected());
  REQUIRE(cm.isDrawing());
  return cm;
}

}  // namespace

// ===========================================================================
// Scenario A — §5.6 happy path: pause-retain → resume within 60 s (Req 7.5)
// ===========================================================================

TEST_CASE(
    "§5.6 flow: a mid-drawing drop pauses and retains, then a reconnect inside "
    "the window resumes with no CONN_TIMEOUT",
    "[connloss][flow][req7.5]") {
  // t0: drawing in progress over a live session.
  ConnectionMonitor cm = drawingSession(1000);

  // Ping/pong missed twice -> WS disconnect mid-drawing. The Controller maps
  // PauseDrawing onto MotionPlanner.pause() and starts the 60 s window; the
  // command buffer / position are held (Req 7.5, §5.6 "keep buffer").
  REQUIRE(cm.onDisconnected(2000) == Action::PauseDrawing);
  REQUIRE(cm.isWaitingReconnect());
  REQUIRE_FALSE(cm.isConnected());
  // We are inside the window: nothing aborted, no timeout latched yet.
  CHECK_FALSE(cm.connTimeoutPending());

  // Halfway through the window a tick must not abort — still waiting.
  CHECK(cm.tick(2000 + CONN_RECONNECT_WINDOW_MS / 2) == Action::None);
  CHECK(cm.isWaitingReconnect());

  // SPA reconnects 30 s after the drop, comfortably inside the 60 s window:
  // ResumeDrawing (Controller -> MotionPlanner.resume(), STATE drawing).
  CHECK(cm.onConnected(2000 + 30000) == Action::ResumeDrawing);
  CHECK(cm.isConnected());
  CHECK(cm.isDrawing());
  // §5.6 happy path never reports a connection timeout.
  CHECK_FALSE(cm.connTimeoutPending());

  // Post-resume ticks are quiescent: no spurious abort once reconnected.
  CHECK(cm.tick(2000 + 30000 + CONN_RECONNECT_WINDOW_MS) == Action::None);
  CHECK_FALSE(cm.connTimeoutPending());
}

// ===========================================================================
// Scenario B — §5.6 timeout branch: abort after 60 s, latch CONN_TIMEOUT for
// the next connect (Req 7.6)
// ===========================================================================

TEST_CASE(
    "§5.6 flow: a mid-drawing drop with no reconnect aborts exactly once at the "
    "deadline and latches CONN_TIMEOUT for the next connect",
    "[connloss][flow][req7.6]") {
  ConnectionMonitor cm = drawingSession(1000);
  REQUIRE(cm.onDisconnected(5000) == Action::PauseDrawing);

  // One ms before the deadline: still holding the paused drawing.
  CHECK(cm.tick(5000 + CONN_RECONNECT_WINDOW_MS - 1) == Action::None);
  CHECK(cm.isWaitingReconnect());
  CHECK_FALSE(cm.connTimeoutPending());

  // At the deadline: abort exactly once. The Controller maps AbortDrawing onto
  // MotionPlanner.cancel() + NVMManager.markCleanIdle() (§5.6: "abort drawing,
  // retain last_pos, write pos, unclean=false").
  CHECK(cm.tick(5000 + CONN_RECONNECT_WINDOW_MS) == Action::AbortDrawing);
  CHECK_FALSE(cm.isWaitingReconnect());
  CHECK_FALSE(cm.isDrawing());
  // The timeout is latched to report on the next connection.
  CHECK(cm.connTimeoutPending());

  // Idempotent: further ticks never re-abort.
  CHECK(cm.tick(5000 + CONN_RECONNECT_WINDOW_MS + 5000) == Action::None);
  CHECK(cm.tick(5000 + 2 * CONN_RECONNECT_WINDOW_MS) == Action::None);

  // The next connect is a fresh session: NOT a resume (the drawing aborted),
  // and CONN_TIMEOUT is still pending for the Controller to emit, then clear
  // (§5.6: "on next reconnect, FW emits ERROR CONN_TIMEOUT").
  CHECK(cm.onConnected(5000 + 2 * CONN_RECONNECT_WINDOW_MS) == Action::None);
  CHECK(cm.connTimeoutPending());
  cm.clearConnTimeoutPending();
  CHECK_FALSE(cm.connTimeoutPending());
}

// ===========================================================================
// §5.6 branch invariant — resume and abort are mutually exclusive for a single
// disconnect: whichever fires first wins, and the other path is then inert.
// ===========================================================================

TEST_CASE(
    "§5.6 invariant: a reconnect inside the window forecloses the abort branch",
    "[connloss][flow][req7.5][req7.6]") {
  ConnectionMonitor cm = drawingSession(0);
  REQUIRE(cm.onDisconnected(0) == Action::PauseDrawing);

  // Resume just before the deadline.
  REQUIRE(cm.onConnected(CONN_RECONNECT_WINDOW_MS - 1) == Action::ResumeDrawing);

  // Because we resumed, the previously-armed window must NOT later abort the
  // (now live) drawing: a tick at/after the original deadline is a no-op and
  // never latches CONN_TIMEOUT.
  CHECK(cm.tick(CONN_RECONNECT_WINDOW_MS) == Action::None);
  CHECK(cm.tick(CONN_RECONNECT_WINDOW_MS + 10000) == Action::None);
  CHECK_FALSE(cm.connTimeoutPending());
  CHECK(cm.isConnected());
  CHECK(cm.isDrawing());
}

TEST_CASE(
    "§5.6 invariant: once the window aborts, a later reconnect cannot resume",
    "[connloss][flow][req7.5][req7.6]") {
  ConnectionMonitor cm = drawingSession(0);
  REQUIRE(cm.onDisconnected(0) == Action::PauseDrawing);
  REQUIRE(cm.tick(CONN_RECONNECT_WINDOW_MS) == Action::AbortDrawing);

  // The abort already fired; a reconnect after the deadline is a fresh,
  // non-drawing session — never a ResumeDrawing.
  CHECK(cm.onConnected(CONN_RECONNECT_WINDOW_MS + 1) == Action::None);
  CHECK(cm.isConnected());
  CHECK_FALSE(cm.isDrawing());
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
