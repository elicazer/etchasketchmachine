// MotorTest implementation (Task 7.4, Requirement 12.4).
//
// See motor_test.h for the rationale. This file is plain portable C++ with no
// Arduino dependencies: all hardware contact happens through the injected
// IStepSink, and all fault/stall state through IDiagnosticsMonitor, so the
// same code runs on the RA4M1 target and under the host Catch2 suite.

#include "motor_test.h"

namespace etch {
namespace diagnostics {
namespace {

// Emit exactly one microstep pulse on the selected axis through the sink.
void emitPulse(motion::IStepSink& sink, Axis axis) {
  if (axis == Axis::X) {
    sink.stepX();
  } else {
    sink.stepY();
  }
}

}  // namespace

MotorTest::MotorTest(motion::IStepSink& sink, IDiagnosticsMonitor& monitor,
                     std::uint16_t stepsPerDirection)
    : sink_(sink), monitor_(monitor), steps_per_direction_(stepsPerDirection) {}

bool MotorTest::failed_(Axis axis) const {
  // A4988 fault (A3) is shared across both drivers, so it fails whichever axis
  // is mid-sweep; the stall latch is per axis (Design §3.2.8).
  return monitor_.faultActive() || monitor_.stallDetected(axis);
}

bool MotorTest::sweep_(Axis axis, std::int8_t dir) {
  // Latch the direction line for this phase before any pulses.
  if (axis == Axis::X) {
    sink_.setDirX(dir);
  } else {
    sink_.setDirY(dir);
  }

  // Poll before the first pulse so a fault/stall that is already latched fails
  // the axis without emitting motion into a faulted driver.
  if (failed_(axis)) {
    return false;
  }

  for (std::uint16_t i = 0; i < steps_per_direction_; ++i) {
    emitPulse(sink_, axis);
    // Re-poll after every pulse: a stall raised mid-sweep fails immediately.
    if (failed_(axis)) {
      return false;
    }
  }
  return true;
}

bool MotorTest::runAxis_(Axis axis) {
  // Forward 200 steps. If the axis fails here, skip the reverse phase: a real
  // stall is not moving and a real fault has dropped EN, so there is nothing
  // to unwind.
  if (!sweep_(axis, +1)) {
    return false;
  }
  // Reverse 200 steps, returning the axis to its starting position on a clean
  // sweep (net-zero physical motion).
  return sweep_(axis, -1);
}

MotorTestResult MotorTest::run() {
  // Energise the drivers for the duration of the self-test (active-low EN).
  sink_.setEnabled(true);

  MotorTestResult result{};
  result.xPass = runAxis_(Axis::X);
  result.yPass = runAxis_(Axis::Y);

  return result;
}

}  // namespace diagnostics
}  // namespace etch
