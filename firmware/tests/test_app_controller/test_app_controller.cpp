// Host-side tests for the connection-loss state machine (Task 8.1).
//
// Validates Design §5.6 and Requirements 7.5 / 7.6 against the pure
// app::ConnectionMonitor state machine that the main-loop Controller drives:
//
//   * pause-on-disconnect: a WS drop mid-drawing returns PauseDrawing and
//     enters the 60 s reconnect window (Req 7.5).
//   * resume-within-60s: reconnecting inside the window returns ResumeDrawing
//     and clears the timer; no CONN_TIMEOUT is latched (Req 7.5).
//   * abort-after-60s: once the window elapses, tick() returns AbortDrawing
//     exactly once and latches connTimeoutPending() for the next connect
//     (Req 7.6).
//
// The monitor has no Arduino / socket / motion dependencies, so the suite is
// fully deterministic: time is injected as millisecond stamps. Run with:
//
//     pio test -e host_test
//
// Mirroring the other host suites, test_build_src = no means there is no .cpp
// to pull in — ConnectionMonitor is header-only.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <cstring>

#include "../../src/app/connection_monitor.h"
#include "../../src/app/hello.h"

// Implementation (test_build_src = no -> include the .cpp body directly,
// mirroring the other host suites).
#include "../../src/app/hello.cpp"  // NOLINT

using etch::app::ConnectionMonitor;
using Action = etch::app::ConnectionMonitor::Action;
using etch::app::CONN_RECONNECT_WINDOW_MS;
using etch::app::HelloFields;
using etch::app::HELLO_PAYLOAD_SIZE;
using etch::app::HELLO_FLAG_CALIBRATED;
using etch::app::HELLO_FLAG_UNCLEAN;
using etch::app::HELLO_FLAG_ENVELOPE_CALIBRATED;
using etch::app::packFirmwareVersion;
using etch::app::serializeHello;

namespace {

// Bring a fresh monitor up to a live, mid-drawing session at t = `t0`.
ConnectionMonitor drawingSession(std::uint32_t t0) {
  ConnectionMonitor cm;
  cm.onConnected(t0);        // client opens the session
  cm.onDrawingStarted();     // BEGIN_DRAW
  REQUIRE(cm.isConnected());
  REQUIRE(cm.isDrawing());
  return cm;
}

}  // namespace

// ---------------------------------------------------------------------------
// Req 7.5 -- pause on disconnect mid-drawing
// ---------------------------------------------------------------------------

TEST_CASE("disconnect mid-drawing pauses and opens the reconnect window",
          "[app][connloss]") {
  ConnectionMonitor cm = drawingSession(1000);

  CHECK(cm.onDisconnected(2000) == Action::PauseDrawing);
  CHECK(cm.isWaitingReconnect());
  CHECK_FALSE(cm.isConnected());
  // No timeout yet — we are inside the window.
  CHECK_FALSE(cm.connTimeoutPending());
}

TEST_CASE("disconnect while idle (no drawing) does not pause", "[app][connloss]") {
  ConnectionMonitor cm;
  cm.onConnected(0);
  // No drawing in progress.
  CHECK(cm.onDisconnected(500) == Action::None);
  CHECK_FALSE(cm.isWaitingReconnect());
}

TEST_CASE("a second disconnect is idempotent", "[app][connloss]") {
  ConnectionMonitor cm = drawingSession(0);
  CHECK(cm.onDisconnected(100) == Action::PauseDrawing);
  // Already waiting: a repeated drop does nothing.
  CHECK(cm.onDisconnected(200) == Action::None);
  CHECK(cm.isWaitingReconnect());
}

// ---------------------------------------------------------------------------
// Req 7.5 -- resume within the 60 s window
// ---------------------------------------------------------------------------

TEST_CASE("reconnect inside the window resumes the drawing", "[app][connloss]") {
  ConnectionMonitor cm = drawingSession(1000);
  REQUIRE(cm.onDisconnected(2000) == Action::PauseDrawing);

  // Reconnect 30 s later — comfortably inside the 60 s window.
  CHECK(cm.onConnected(2000 + 30000) == Action::ResumeDrawing);
  CHECK(cm.isConnected());
  CHECK(cm.isDrawing());
  CHECK_FALSE(cm.connTimeoutPending());
}

TEST_CASE("reconnect exactly one ms before the deadline still resumes",
          "[app][connloss]") {
  ConnectionMonitor cm = drawingSession(0);
  REQUIRE(cm.onDisconnected(0) == Action::PauseDrawing);

  // tick() just before the boundary keeps waiting...
  CHECK(cm.tick(CONN_RECONNECT_WINDOW_MS - 1) == Action::None);
  // ...and a reconnect there resumes.
  CHECK(cm.onConnected(CONN_RECONNECT_WINDOW_MS - 1) == Action::ResumeDrawing);
  CHECK_FALSE(cm.connTimeoutPending());
}

// ---------------------------------------------------------------------------
// Req 7.6 -- abort after 60 s, report CONN_TIMEOUT on next connect
// ---------------------------------------------------------------------------

TEST_CASE("the reconnect window elapsing aborts the drawing once",
          "[app][connloss]") {
  ConnectionMonitor cm = drawingSession(1000);
  REQUIRE(cm.onDisconnected(5000) == Action::PauseDrawing);

  // Before the deadline: still waiting.
  CHECK(cm.tick(5000 + CONN_RECONNECT_WINDOW_MS - 1) == Action::None);
  CHECK(cm.isWaitingReconnect());

  // At the deadline: abort exactly once and latch the pending timeout.
  CHECK(cm.tick(5000 + CONN_RECONNECT_WINDOW_MS) == Action::AbortDrawing);
  CHECK(cm.connTimeoutPending());
  CHECK_FALSE(cm.isWaitingReconnect());
  CHECK_FALSE(cm.isDrawing());

  // Subsequent ticks do not re-abort.
  CHECK(cm.tick(5000 + CONN_RECONNECT_WINDOW_MS + 10000) == Action::None);
}

TEST_CASE("CONN_TIMEOUT is delivered to the next connection then cleared",
          "[app][connloss]") {
  ConnectionMonitor cm = drawingSession(0);
  REQUIRE(cm.onDisconnected(0) == Action::PauseDrawing);
  REQUIRE(cm.tick(CONN_RECONNECT_WINDOW_MS) == Action::AbortDrawing);
  REQUIRE(cm.connTimeoutPending());

  // The next connection is a fresh session (no resume — the drawing aborted).
  CHECK(cm.onConnected(CONN_RECONNECT_WINDOW_MS + 1000) == Action::None);
  // The Controller reads the pending flag to emit ERROR{CONN_TIMEOUT}, then
  // clears it.
  CHECK(cm.connTimeoutPending());
  cm.clearConnTimeoutPending();
  CHECK_FALSE(cm.connTimeoutPending());
}

TEST_CASE("a clean drawing finish cancels the pending abort", "[app][connloss]") {
  ConnectionMonitor cm = drawingSession(0);
  REQUIRE(cm.onDisconnected(0) == Action::PauseDrawing);

  // The drawing finishes (e.g. END_DRAW arrived just before the drop was
  // processed, or the planner drained). The abort timer must not fire.
  cm.onDrawingFinished();
  CHECK(cm.tick(CONN_RECONNECT_WINDOW_MS + 1) == Action::None);
  CHECK_FALSE(cm.connTimeoutPending());
}

// ---------------------------------------------------------------------------
// §4.8 HELLO frame byte layout (matches web/src/codec/frame.ts decode)
// ---------------------------------------------------------------------------

namespace {

std::uint16_t rdU16(const std::uint8_t* p, std::size_t off) {
  return static_cast<std::uint16_t>(p[off]) |
         static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[off + 1]) << 8);
}
std::uint32_t rdU32(const std::uint8_t* p, std::size_t off) {
  return static_cast<std::uint32_t>(p[off]) |
         (static_cast<std::uint32_t>(p[off + 1]) << 8) |
         (static_cast<std::uint32_t>(p[off + 2]) << 16) |
         (static_cast<std::uint32_t>(p[off + 3]) << 24);
}
std::int32_t rdI32(const std::uint8_t* p, std::size_t off) {
  return static_cast<std::int32_t>(rdU32(p, off));
}
float rdF32(const std::uint8_t* p, std::size_t off) {
  std::uint32_t bits = rdU32(p, off);
  float f = 0.0f;
  std::memcpy(&f, &bits, sizeof(f));
  return f;
}

}  // namespace

TEST_CASE("serializeHello emits the §4.8 layout the web decoder expects",
          "[app][hello]") {
  HelloFields f;
  f.firmware_version = packFirmwareVersion(1, 2, 3);  // 0x010203
  f.max_sps          = 1000;
  f.backlash_x       = 7;
  f.backlash_y       = 9;
  f.mm_per_rev_x     = 100.0f;
  f.mm_per_rev_y     = 105.5f;
  f.logical_x_steps  = -1234;
  f.logical_y_steps  = 5678;
  f.calibrated       = true;
  f.unclean          = false;
  f.buffer_capacity  = 32;
  f.envelope_x_steps = 12345u;
  f.envelope_y_steps = 67890u;
  f.envelope_calibrated = true;

  std::uint8_t out[HELLO_PAYLOAD_SIZE];
  std::memset(out, 0xAB, sizeof(out));
  const std::size_t n = serializeHello(f, out, sizeof(out));
  REQUIRE(n == HELLO_PAYLOAD_SIZE);
  REQUIRE(n == 40u);

  // Offsets per Design §4.8 / wire_client.ts onHello().
  CHECK(rdU32(out, 0) == 0x010203u);    // firmware_version
  CHECK(rdU16(out, 4) == 1000u);        // max_sps
  CHECK(rdU16(out, 6) == 0u);           // reserved
  CHECK(rdU16(out, 8) == 7u);           // backlash_x
  CHECK(rdU16(out, 10) == 9u);          // backlash_y
  CHECK(rdF32(out, 12) == 100.0f);      // mm_per_rev_x
  CHECK(rdF32(out, 16) == 105.5f);      // mm_per_rev_y
  CHECK(rdI32(out, 20) == -1234);       // logical_x_steps
  CHECK(rdI32(out, 24) == 5678);        // logical_y_steps
  // flags: calibrated + envelope-calibrated
  CHECK(out[28] == (HELLO_FLAG_CALIBRATED | HELLO_FLAG_ENVELOPE_CALIBRATED));
  CHECK(out[29] == 0u);                 // reserved
  CHECK(rdU16(out, 30) == 32u);         // buffer_capacity
  CHECK(rdU32(out, 32) == 12345u);      // envelope_x_steps
  CHECK(rdU32(out, 36) == 67890u);      // envelope_y_steps
}

TEST_CASE("serializeHello sets the unclean flag bit", "[app][hello]") {
  HelloFields f;
  f.calibrated = false;
  f.unclean = true;
  std::uint8_t out[HELLO_PAYLOAD_SIZE];
  REQUIRE(serializeHello(f, out, sizeof(out)) == HELLO_PAYLOAD_SIZE);
  CHECK(out[28] == HELLO_FLAG_UNCLEAN);
}

TEST_CASE("serializeHello rejects an undersized buffer", "[app][hello]") {
  HelloFields f;
  std::uint8_t small[HELLO_PAYLOAD_SIZE - 1];
  CHECK(serializeHello(f, small, sizeof(small)) == 0u);
  CHECK(serializeHello(f, nullptr, HELLO_PAYLOAD_SIZE) == 0u);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
