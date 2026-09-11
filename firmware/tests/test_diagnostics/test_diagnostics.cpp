// Host-side unit tests for Diagnostics fault & stall detection (Task 7.1).
//
// Covers, per the task and Design §3.2.8 / §4.5:
//   * A3 LOW (fault asserted) disables EN within one poll() and emits
//     ERROR{kind=FAULT} (Req 12.5).
//   * A latched fault stays latched: A3 returning HIGH does not re-enable EN
//     and does not re-emit; only faultReset() clears it (Req 12.6).
//   * 4 missed deadlines in a single segment raise ERROR{kind=STALL} carrying
//     the right axis, exactly once (Req 12.3); the X and Y counters are
//     independent.
//   * resetSegment() clears the per-segment counter, so 3 misses -> reset ->
//     3 misses does NOT stall (the "within a single movement segment" rule).
//   * faultReset() re-enables EN and clears both the fault and stall latches.
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment in platformio.ini is configured with
// `test_build_src = no`, so this translation unit pulls the implementation in
// directly via relative include to keep the binary self-contained (matching
// the convention in test_backlash / test_control_parser). Diagnostics is
// Arduino-include-free, so no Arduino headers are involved on the host: the
// ArduinoDiagPins block in the .cpp is excluded by `#if defined(ARDUINO)`.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "../../src/diagnostics/diagnostics.h"
#include "../../src/diagnostics/diagnostics.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::diag::Axis;
using etch::diag::DiagError;
using etch::diag::Diagnostics;
using etch::diag::IDiagPins;
using etch::diag::ERROR_AXIS_NONE;
using etch::diag::ERROR_KIND_FAULT;
using etch::diag::ERROR_KIND_STALL;
using etch::diag::STALL_THRESHOLD;

namespace {

// In-memory IDiagPins fake. Mirrors the slice of the real ArduinoDiagPins the
// latch logic touches: readFault() returns a scripted level, setEnabled()
// records each EN transition (and the latest level) so a test can assert both
// "EN was driven HIGH" and "how many times".
class FakePins : public IDiagPins {
 public:
  bool readFault() override { return fault_; }

  void setEnabled(bool enabled) override {
    enabled_ = enabled;
    ++set_enabled_calls_;
    if (!enabled) ++disable_calls_;
    if (enabled) ++enable_calls_;
  }

  // Test plumbing.
  void assertFault(bool asserted) { fault_ = asserted; }
  bool enabled() const { return enabled_; }
  int disableCalls() const { return disable_calls_; }
  int enableCalls() const { return enable_calls_; }

 private:
  bool fault_ = false;     // A3 reads HIGH (no fault) by default
  bool enabled_ = true;    // assume drivers start energised
  int set_enabled_calls_ = 0;
  int disable_calls_ = 0;
  int enable_calls_ = 0;
};

// Collects every ERROR the latch emits so a test can assert count + contents.
struct ErrorLog {
  std::vector<DiagError> errors;

  std::size_t count() const { return errors.size(); }
  const DiagError& last() const { return errors.back(); }
};

// Build a Diagnostics wired to `pins` that appends each emit into `log`.
Diagnostics makeDiag(FakePins& pins, ErrorLog& log) {
  return Diagnostics(pins, [&log](const DiagError& e) { log.errors.push_back(e); });
}

}  // namespace

// ---------------------------------------------------------------------------
// Fault: A3 LOW disables EN and emits FAULT (Req 12.5)
// ---------------------------------------------------------------------------

TEST_CASE("A3 LOW disables EN within one poll and emits FAULT",
          "[diag][fault]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  // No fault yet: poll() is a no-op, EN stays enabled, nothing emitted.
  diag.poll();
  CHECK(pins.enabled());
  CHECK(log.count() == 0u);
  CHECK_FALSE(diag.isFaulted());

  // Assert the A3 tap LOW, then a single poll must disable EN and emit FAULT.
  pins.assertFault(true);
  diag.poll();

  CHECK(diag.isFaulted());
  CHECK_FALSE(pins.enabled());          // EN driven HIGH (drivers disabled)
  CHECK(pins.disableCalls() == 1);
  REQUIRE(log.count() == 1u);
  CHECK(log.last().kind == ERROR_KIND_FAULT);
  CHECK(log.last().axis == ERROR_AXIS_NONE);  // aggregate tap, not axis-specific
  CHECK(diag.lastError().kind == ERROR_KIND_FAULT);
}

TEST_CASE("a latched fault is not re-emitted and A3 HIGH does not re-enable EN",
          "[diag][fault]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  pins.assertFault(true);
  diag.poll();
  REQUIRE(log.count() == 1u);
  REQUIRE_FALSE(pins.enabled());

  // Hold the fault for several more polls: still latched, no new emits.
  diag.poll();
  diag.poll();
  CHECK(log.count() == 1u);

  // A3 recovers to HIGH on its own. The latch must persist (Req 12.6): EN must
  // stay disabled and no further emit happens until faultReset().
  pins.assertFault(false);
  diag.poll();
  CHECK(diag.isFaulted());
  CHECK_FALSE(pins.enabled());
  CHECK(log.count() == 1u);
  CHECK(pins.enableCalls() == 0);
}

// ---------------------------------------------------------------------------
// Stall: 4 missed deadlines in a segment raise STALL with the right axis
// (Req 12.3)
// ---------------------------------------------------------------------------

TEST_CASE("4 missed deadlines in a segment raise STALL for the X axis",
          "[diag][stall]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  // First three misses stay below the threshold: no stall yet.
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  CHECK_FALSE(diag.isStalled());
  CHECK(log.count() == 0u);
  CHECK(diag.missedDeadlines(Axis::X) == 3);

  // The fourth miss reaches STALL_THRESHOLD and raises the stall once.
  diag.reportMissedDeadline(Axis::X);
  CHECK(diag.isStalled());
  REQUIRE(log.count() == 1u);
  CHECK(log.last().kind == ERROR_KIND_STALL);
  CHECK(log.last().axis == static_cast<std::uint8_t>(Axis::X));
  CHECK(log.last().detail == STALL_THRESHOLD);

  // Further misses on the same (already-stalled) axis do not re-emit.
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  CHECK(log.count() == 1u);
}

TEST_CASE("STALL identifies the Y axis when Y misses its deadlines",
          "[diag][stall]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  for (int i = 0; i < STALL_THRESHOLD; ++i) {
    diag.reportMissedDeadline(Axis::Y);
  }

  REQUIRE(log.count() == 1u);
  CHECK(log.last().kind == ERROR_KIND_STALL);
  CHECK(log.last().axis == static_cast<std::uint8_t>(Axis::Y));
}

TEST_CASE("per-axis missed-deadline counters are independent",
          "[diag][stall]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  // Three on X and three on Y: neither axis hits the threshold on its own, so
  // no stall is raised even though six total misses occurred.
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::Y);
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::Y);
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::Y);

  CHECK_FALSE(diag.isStalled());
  CHECK(log.count() == 0u);
  CHECK(diag.missedDeadlines(Axis::X) == 3);
  CHECK(diag.missedDeadlines(Axis::Y) == 3);
}

// ---------------------------------------------------------------------------
// resetSegment() clears the per-segment counter (Req 12.3)
// ---------------------------------------------------------------------------

TEST_CASE("resetSegment clears the counter so 3 + reset + 3 does not stall",
          "[diag][stall][segment]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  // Three misses in the first segment: below threshold.
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  REQUIRE_FALSE(diag.isStalled());
  CHECK(diag.missedDeadlines(Axis::X) == 3);

  // Segment boundary zeroes the counter.
  diag.resetSegment();
  CHECK(diag.missedDeadlines(Axis::X) == 0);

  // Three more misses in the next segment: still below threshold because the
  // earlier three did not carry over (Req 12.3: within a single segment).
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  CHECK_FALSE(diag.isStalled());
  CHECK(log.count() == 0u);
  CHECK(diag.missedDeadlines(Axis::X) == 3);
}

TEST_CASE("misses spanning a reset still stall once they reach 4 in one segment",
          "[diag][stall][segment]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  // Pile up to the threshold inside a single segment after a reset.
  diag.reportMissedDeadline(Axis::X);
  diag.resetSegment();
  for (int i = 0; i < STALL_THRESHOLD; ++i) {
    diag.reportMissedDeadline(Axis::X);
  }
  CHECK(diag.isStalled());
  REQUIRE(log.count() == 1u);
  CHECK(log.last().kind == ERROR_KIND_STALL);
}

// ---------------------------------------------------------------------------
// faultReset() re-enables EN and clears the latch (Req 12.6)
// ---------------------------------------------------------------------------

TEST_CASE("faultReset re-enables EN and clears the fault latch",
          "[diag][reset]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  pins.assertFault(true);
  diag.poll();
  REQUIRE(diag.isFaulted());
  REQUIRE_FALSE(pins.enabled());

  // Clear the underlying condition, then reset.
  pins.assertFault(false);
  diag.faultReset();

  CHECK_FALSE(diag.isFaulted());
  CHECK(pins.enabled());            // EN driven LOW again (drivers energised)
  CHECK(pins.enableCalls() == 1);

  // After reset the latch is clean: a subsequent fault assertion latches and
  // emits afresh.
  pins.assertFault(true);
  diag.poll();
  CHECK(diag.isFaulted());
  CHECK_FALSE(pins.enabled());
  CHECK(log.count() == 2u);
  CHECK(log.last().kind == ERROR_KIND_FAULT);
}

TEST_CASE("faultReset clears a latched stall and resets the counters",
          "[diag][reset]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  for (int i = 0; i < STALL_THRESHOLD; ++i) {
    diag.reportMissedDeadline(Axis::X);
  }
  REQUIRE(diag.isStalled());
  REQUIRE(diag.missedDeadlines(Axis::X) == STALL_THRESHOLD);

  diag.faultReset();
  CHECK_FALSE(diag.isStalled());
  CHECK(diag.missedDeadlines(Axis::X) == 0);

  // The stall guard is cleared too: a fresh run of 4 misses stalls and emits
  // again (the first STALL plus this one => 2 total).
  for (int i = 0; i < STALL_THRESHOLD; ++i) {
    diag.reportMissedDeadline(Axis::X);
  }
  CHECK(diag.isStalled());
  CHECK(log.count() == 2u);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
