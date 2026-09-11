// Host-side unit tests for IdleTimeoutManager (Task 7.5).
//
// Validates the contract in Design §9.3 and Requirement 6.8:
//   * power-on holds both motors idle with holding torque disabled (EN HIGH)
//   * EN stays enabled (LOW) while activity is recent
//   * EN goes HIGH (disabled) exactly once, 5 s after the last activity
//   * notifyActivity() before the timeout keeps the drivers enabled and resets
//     the idle timer (so the 5 s is measured from the latest activity)
//   * activity after a timeout re-enables EN (LOW) immediately (before tick)
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment sets `test_build_src = no`, so (mirroring
// test_backlash / test_motion_planner) this translation unit pulls the
// implementation in directly via a relative include and drives the clock by
// hand with explicit millisecond stamps.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstdint>

#include "../../src/diagnostics/idle_timeout.h"
#include "../../src/diagnostics/idle_timeout.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::diagnostics::IdleTimeoutManager;
using etch::diagnostics::IEnableLine;
using etch::diagnostics::IDLE_TIMEOUT_MS;

namespace {

// In-memory EN line: records the latest level plus how many times the level
// actually transitioned, so tests can assert each transition fires exactly
// once. `enabled == true` means EN LOW (drivers on); false means EN HIGH.
class FakeEnableLine : public IEnableLine {
 public:
  bool enabled = false;
  std::size_t transitions = 0;  // number of distinct level changes observed
  std::size_t calls = 0;        // total setEnabled() invocations

  void setEnabled(bool e) override {
    ++calls;
    if (e != enabled) {
      ++transitions;
      enabled = e;
    }
  }
};

}  // namespace

// ---------------------------------------------------------------------------
// Power-on idle state (Requirement 6.8)
// ---------------------------------------------------------------------------

TEST_CASE("power-on holds motors idle with holding torque disabled",
          "[idle][poweron]") {
  FakeEnableLine en;
  IdleTimeoutManager mgr(en);

  mgr.begin(0);

  // No commands received yet -> drivers disabled (EN HIGH) (Req 6.8).
  CHECK_FALSE(mgr.isEnabled());
  CHECK_FALSE(en.enabled);
}

// ---------------------------------------------------------------------------
// EN stays enabled while activity is recent (Design §9.3)
// ---------------------------------------------------------------------------

TEST_CASE("EN stays enabled while activity is recent", "[idle][hold]") {
  FakeEnableLine en;
  IdleTimeoutManager mgr(en);
  mgr.begin(0);

  // First motion command at t=1000 energises the drivers.
  mgr.notifyActivity(1000);
  CHECK(mgr.isEnabled());
  CHECK(en.enabled);

  // Tick repeatedly while still inside the idle window: stays enabled.
  mgr.tick(1500);
  mgr.tick(3000);
  mgr.tick(1000 + IDLE_TIMEOUT_MS - 1);  // 5999: one ms short of timeout
  CHECK(mgr.isEnabled());
  CHECK(en.enabled);
}

// ---------------------------------------------------------------------------
// EN goes HIGH exactly once at the timeout boundary (Design §9.3, Req 6.8)
// ---------------------------------------------------------------------------

TEST_CASE("EN goes disabled exactly once 5 s after the last activity",
          "[idle][timeout]") {
  FakeEnableLine en;
  IdleTimeoutManager mgr(en);
  mgr.begin(0);

  mgr.notifyActivity(1000);
  REQUIRE(mgr.isEnabled());
  const std::size_t before = en.transitions;  // includes the enable at t=1000

  // One ms short: still enabled.
  mgr.tick(1000 + IDLE_TIMEOUT_MS - 1);
  CHECK(mgr.isEnabled());

  // Exactly at the boundary (t = 1000 + 5000 = 6000): disable.
  mgr.tick(1000 + IDLE_TIMEOUT_MS);
  CHECK_FALSE(mgr.isEnabled());
  CHECK_FALSE(en.enabled);

  // The disable transition happened exactly once...
  CHECK(en.transitions == before + 1);

  // ...and further ticks past the boundary do not re-toggle the line.
  mgr.tick(1000 + IDLE_TIMEOUT_MS + 1);
  mgr.tick(1000 + IDLE_TIMEOUT_MS + 5000);
  CHECK_FALSE(mgr.isEnabled());
  CHECK(en.transitions == before + 1);
}

// ---------------------------------------------------------------------------
// notifyActivity() before timeout keeps it enabled and resets the timer
// (Design §9.3)
// ---------------------------------------------------------------------------

TEST_CASE("activity before timeout keeps drivers enabled and resets the timer",
          "[idle][reset]") {
  FakeEnableLine en;
  IdleTimeoutManager mgr(en);
  mgr.begin(0);

  mgr.notifyActivity(1000);
  const std::size_t after_first = en.transitions;

  // Tick to just before the timeout, then register fresh activity. Because
  // the drivers never disabled, this is a pure timer reset: no new EN edge.
  mgr.tick(1000 + IDLE_TIMEOUT_MS - 1);
  CHECK(mgr.isEnabled());
  mgr.notifyActivity(1000 + IDLE_TIMEOUT_MS - 1);  // resets baseline to 5999
  CHECK(mgr.isEnabled());
  CHECK(en.transitions == after_first);  // still enabled, no extra transition

  // 5000 ms after the *original* activity would have timed out, but the timer
  // was reset, so at the old boundary the drivers are still enabled.
  mgr.tick(1000 + IDLE_TIMEOUT_MS);
  CHECK(mgr.isEnabled());

  // The new timeout is measured from the reset (5999): at 5999 + 5000 = 10999
  // the drivers finally disable.
  mgr.tick(1000 + IDLE_TIMEOUT_MS - 1 + IDLE_TIMEOUT_MS - 1);  // 10998: short
  CHECK(mgr.isEnabled());
  mgr.tick(1000 + IDLE_TIMEOUT_MS - 1 + IDLE_TIMEOUT_MS);  // 10999: boundary
  CHECK_FALSE(mgr.isEnabled());
}

// ---------------------------------------------------------------------------
// Activity after a timeout re-enables EN immediately (Design §9.3)
// ---------------------------------------------------------------------------

TEST_CASE("activity after a timeout re-enables EN immediately",
          "[idle][reenable]") {
  FakeEnableLine en;
  IdleTimeoutManager mgr(en);
  mgr.begin(0);

  // Energise, then let it time out.
  mgr.notifyActivity(1000);
  mgr.tick(1000 + IDLE_TIMEOUT_MS);
  REQUIRE_FALSE(mgr.isEnabled());

  // The next motion command re-enables the drivers synchronously -- before any
  // tick() and before motion begins (Design §9.3).
  const std::size_t before = en.transitions;
  mgr.notifyActivity(20000);
  CHECK(mgr.isEnabled());
  CHECK(en.enabled);
  CHECK(en.transitions == before + 1);

  // And it now holds enabled across the full window again.
  mgr.tick(20000 + IDLE_TIMEOUT_MS - 1);
  CHECK(mgr.isEnabled());
  mgr.tick(20000 + IDLE_TIMEOUT_MS);
  CHECK_FALSE(mgr.isEnabled());
}

// ---------------------------------------------------------------------------
// Wraparound safety: elapsed time is computed with unsigned subtraction
// ---------------------------------------------------------------------------

TEST_CASE("timeout is correct across a 32-bit millis() wraparound",
          "[idle][wraparound]") {
  FakeEnableLine en;
  IdleTimeoutManager mgr(en);
  mgr.begin(0);

  // Last activity near the 32-bit ceiling.
  const std::uint32_t near_max = 0xFFFFFFFFu - 2000u;  // 2000 ms before wrap
  mgr.notifyActivity(near_max);
  REQUIRE(mgr.isEnabled());

  // 3000 ms later the counter has wrapped to 999. Elapsed = 3000 < 5000.
  const std::uint32_t after_wrap = near_max + 3000u;  // wraps to 999
  mgr.tick(after_wrap);
  CHECK(mgr.isEnabled());

  // 5000 ms after activity (wrapped to 2999): boundary reached, disable.
  mgr.tick(near_max + IDLE_TIMEOUT_MS);
  CHECK_FALSE(mgr.isEnabled());
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
