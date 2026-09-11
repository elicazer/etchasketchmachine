// Host-side unit tests for the MotorTest self-test routine (Task 7.4,
// Requirement 12.4).
//
// Covers, per the task and Design §3.2.8 / §6 fault table:
//   * Clean run: both axes PASS, each axis emits exactly 400 step pulses
//     (200 forward + 200 reverse), and the per-axis net signed motion is zero
//     (200 fwd + 200 back leaves the stylus where it started).
//   * DIR is latched forward (+1) then backward (-1) for each axis, in order.
//   * An injected stall on one axis reports FAIL for that axis and PASS for
//     the other -- both for an immediately-latched stall and one that trips
//     mid-sweep (the routine stops emitting pulses on the failed axis the
//     moment it observes the stall).
//   * The shared A4988 fault line (A3) fails whichever axis is mid-sweep, so a
//     fault active for the whole run fails both axes.
//   * By construction the routine never touches a MotionPlanner / logical
//     position: it is built from only an IStepSink and an IDiagnosticsMonitor,
//     so no Position type is involved and repeated runs are stateless.
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment sets `test_build_src = no`, so (mirroring
// test_diagnostics / test_idle_timeout) this translation unit pulls the
// implementation in directly via a relative include. MotorTest is
// Arduino-include-free, so no Arduino headers are involved on the host.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "../../src/diagnostics/motor_test.h"
#include "../../src/diagnostics/motor_test.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::diagnostics::Axis;
using etch::diagnostics::IDiagnosticsMonitor;
using etch::diagnostics::MotorTest;
using etch::diagnostics::MotorTestResult;
using etch::diagnostics::MOTOR_TEST_STEPS_PER_DIRECTION;
using etch::motion::IStepSink;

namespace {

// Total pulses a clean axis sweep emits: 200 forward + 200 reverse.
constexpr std::uint32_t kPulsesPerAxis = 2u * MOTOR_TEST_STEPS_PER_DIRECTION;

// --- Pin-output fake --------------------------------------------------------
// Counts microstep pulses per axis, records the ordered DIR latch sequence,
// and tracks a signed net position (applying the current DIR on each pulse) so
// a test can assert the sweep is net-zero. This is the ONLY "position" in the
// whole test: the routine has no access to a MotionPlanner counter.
class FakeStepSink : public IStepSink {
 public:
  std::int8_t dirX = 0;
  std::int8_t dirY = 0;
  std::uint32_t stepsX = 0;
  std::uint32_t stepsY = 0;
  std::int32_t netX = 0;  // signed: + forward pulses, - reverse pulses
  std::int32_t netY = 0;
  bool enabled = false;
  std::vector<std::int8_t> dirSeqX;  // ordered DIR latches on X
  std::vector<std::int8_t> dirSeqY;  // ordered DIR latches on Y

  void setDirX(std::int8_t dir) override {
    dirX = dir;
    dirSeqX.push_back(dir);
  }
  void setDirY(std::int8_t dir) override {
    dirY = dir;
    dirSeqY.push_back(dir);
  }
  void stepX() override {
    ++stepsX;
    netX += dirX;
  }
  void stepY() override {
    ++stepsY;
    netY += dirY;
  }
  void setEnabled(bool e) override { enabled = e; }
};

// --- Fault/stall monitor fake ----------------------------------------------
// Simulates the live fault/stall state the routine polls. Supports a clean
// run (all false), an immediately-latched stall per axis, a fault held for the
// whole run, and -- by linking the sink -- a stall that trips once an axis has
// emitted a chosen number of pulses (mid-sweep).
class FakeMonitor : public IDiagnosticsMonitor {
 public:
  bool fault = false;
  bool stallX = false;
  bool stallY = false;

  // Optional mid-sweep trip: when `sink` is set and stall*After >= 0, the axis
  // stalls as soon as the sink has emitted >= that many pulses on it.
  const FakeStepSink* sink = nullptr;
  std::int32_t stallXAfter = -1;  // -1 disables
  std::int32_t stallYAfter = -1;

  bool faultActive() const override { return fault; }

  bool stallDetected(Axis axis) const override {
    if (axis == Axis::X) {
      if (stallX) return true;
      return sink != nullptr && stallXAfter >= 0 &&
             sink->stepsX >= static_cast<std::uint32_t>(stallXAfter);
    }
    if (stallY) return true;
    return sink != nullptr && stallYAfter >= 0 &&
           sink->stepsY >= static_cast<std::uint32_t>(stallYAfter);
  }
};

}  // namespace

// ---------------------------------------------------------------------------
// Clean run: both axes pass, exactly 400 pulses each, net-zero per axis
// (Requirement 12.4)
// ---------------------------------------------------------------------------

TEST_CASE("clean run passes both axes with 400 pulses each and net-zero motion",
          "[motor_test][clean]") {
  FakeStepSink sink;
  FakeMonitor monitor;  // all clean
  MotorTest test(sink, monitor);

  MotorTestResult result = test.run();

  // Both axes complete their full sweep cleanly.
  CHECK(result.xPass);
  CHECK(result.yPass);

  // Exactly 200 forward + 200 reverse pulses on each axis.
  CHECK(sink.stepsX == kPulsesPerAxis);
  CHECK(sink.stepsY == kPulsesPerAxis);

  // Net signed motion is zero per axis: the stylus ends where it started.
  CHECK(sink.netX == 0);
  CHECK(sink.netY == 0);

  // The drivers were energised for the test.
  CHECK(sink.enabled);
}

// ---------------------------------------------------------------------------
// DIR latched forward then backward, in order, for each axis (Requirement 12.4)
// ---------------------------------------------------------------------------

TEST_CASE("each axis latches DIR forward then backward", "[motor_test][dir]") {
  FakeStepSink sink;
  FakeMonitor monitor;
  MotorTest test(sink, monitor);

  test.run();

  REQUIRE(sink.dirSeqX.size() == 2u);
  CHECK(sink.dirSeqX[0] == 1);   // forward first
  CHECK(sink.dirSeqX[1] == -1);  // then backward

  REQUIRE(sink.dirSeqY.size() == 2u);
  CHECK(sink.dirSeqY[0] == 1);
  CHECK(sink.dirSeqY[1] == -1);
}

// ---------------------------------------------------------------------------
// Injected stall on one axis: that axis fails, the other passes
// (Requirement 12.4)
// ---------------------------------------------------------------------------

TEST_CASE("an immediate stall on X fails X and passes Y", "[motor_test][stall]") {
  FakeStepSink sink;
  FakeMonitor monitor;
  monitor.stallX = true;  // latched before X moves
  MotorTest test(sink, monitor);

  MotorTestResult result = test.run();

  CHECK_FALSE(result.xPass);
  CHECK(result.yPass);

  // X never pulsed (the stall is seen before the first pulse); Y ran clean.
  CHECK(sink.stepsX == 0u);
  CHECK(sink.stepsY == kPulsesPerAxis);
}

TEST_CASE("an immediate stall on Y fails Y and passes X", "[motor_test][stall]") {
  FakeStepSink sink;
  FakeMonitor monitor;
  monitor.stallY = true;
  MotorTest test(sink, monitor);

  MotorTestResult result = test.run();

  CHECK(result.xPass);
  CHECK_FALSE(result.yPass);

  // X ran clean; Y never pulsed.
  CHECK(sink.stepsX == kPulsesPerAxis);
  CHECK(sink.stepsY == 0u);
}

TEST_CASE("a stall that trips mid-sweep fails that axis and stops its pulses",
          "[motor_test][stall][midsweep]") {
  FakeStepSink sink;
  FakeMonitor monitor;
  monitor.sink = &sink;
  monitor.stallXAfter = 50;  // X stalls once it has emitted 50 pulses
  MotorTest test(sink, monitor);

  MotorTestResult result = test.run();

  CHECK_FALSE(result.xPass);
  CHECK(result.yPass);

  // X stopped emitting the instant the stall was observed (after 50 pulses),
  // well short of the full 400-pulse sweep.
  CHECK(sink.stepsX == 50u);
  CHECK(sink.stepsX < kPulsesPerAxis);

  // Y, polled independently, ran the full clean sweep.
  CHECK(sink.stepsY == kPulsesPerAxis);
}

// ---------------------------------------------------------------------------
// Shared A4988 fault line fails whichever axis is mid-sweep (Design §9.4)
// ---------------------------------------------------------------------------

TEST_CASE("a fault active for the whole run fails both axes",
          "[motor_test][fault]") {
  FakeStepSink sink;
  FakeMonitor monitor;
  monitor.fault = true;  // A3 asserted throughout
  MotorTest test(sink, monitor);

  MotorTestResult result = test.run();

  CHECK_FALSE(result.xPass);
  CHECK_FALSE(result.yPass);

  // Neither axis pulses into a faulted driver.
  CHECK(sink.stepsX == 0u);
  CHECK(sink.stepsY == 0u);
}

// ---------------------------------------------------------------------------
// By construction: no MotionPlanner / logical position is involved
// (Requirement 6.2, 13.7)
// ---------------------------------------------------------------------------

TEST_CASE("routine is built from only a step sink and a monitor (no position)",
          "[motor_test][position]") {
  // MotorTest is constructible from just an IStepSink and an
  // IDiagnosticsMonitor: it has no MotionPlanner, no IMotionNvm, and no
  // Position parameter, so it cannot read or mutate the tracked logical
  // position. The drawing-side position is therefore inherently untouched.
  FakeStepSink sink;
  FakeMonitor monitor;
  MotorTest test(sink, monitor);

  // Running it twice yields the same result: the routine holds no mutable
  // state of its own that could accumulate or drift a position counter.
  MotorTestResult first = test.run();
  MotorTestResult second = test.run();

  CHECK(first.xPass == second.xPass);
  CHECK(first.yPass == second.yPass);
  CHECK(first.xPass);
  CHECK(first.yPass);

  // Each run is net-zero, so even the test's own fake position is unchanged.
  CHECK(sink.netX == 0);
  CHECK(sink.netY == 0);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
