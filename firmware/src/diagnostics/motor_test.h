// MotorTest - per-axis motor self-test routine (Task 7.4, Requirement 12.4).
//
// Drives each motor 200 steps forward and 200 steps backward and reports a
// per-axis pass/fail. An axis PASSES when the full 200-fwd / 200-back sweep
// completes without the A4988 shared fault line (A3) asserting or the stall
// detector latching for that axis; it FAILS the moment either condition is
// observed during its sweep (Requirement 12.4, Design §3.2.8, §6 fault table).
//
// Why this lives in its own translation unit
// -------------------------------------------
// The routine deliberately depends only on narrow, injected seams so it never
// has to edit the motion planner or the Diagnostics module (task 7.1):
//
//   * Step output goes through `motion::IStepSink` -- the same abstraction the
//     MotionPlanner uses to pulse the A4988 STEP/DIR/EN lines (task 6.9). On
//     the target the concrete ArduinoStepSink maps these onto digitalWrite; a
//     host test plugs in a fake that simply counts pulses.
//   * Fault / stall state is read through `IDiagnosticsMonitor` below. The
//     Diagnostics module (task 7.1) already owns the A3 poll and the
//     missed-deadline stall counter (Req 12.3, 12.5); it can satisfy this
//     read-only facade directly (or via a one-line adapter wired in task 8.1).
//     Host tests substitute an in-memory fake to simulate a stall on one axis
//     and a clean run on the other.
//
// Because the routine emits pulses straight through IStepSink and never calls
// into the MotionPlanner's counted-position path, it is *uncounted diagnostic
// motion*: it CANNOT corrupt the tracked logical position (Requirement 6.2,
// 13.7). On a clean sweep the physical motion is also net-zero per axis (200
// forward + 200 back returns the stylus to where it started), so the machine
// is left exactly where the self-test found it. See the note on run() below.
//
// This header is intentionally Arduino-include-free (it only pulls in the
// equally Arduino-free motion_planner.h / backlash_compensator.h for the
// IStepSink and Axis seams), so it compiles both under `framework = arduino`
// and under `platform = native` for the host-side Catch2 tests.
//
// References:
//   - Requirement 12.4 (motor test: 200 fwd + 200 back, per-axis pass/fail).
//   - Design §3.2.8 (Diagnostics fault & stall), §6 fault table row
//     "Motor test fail (200 fwd + 200 rev)".

#pragma once

#include <cstdint>

#include "../backlash/backlash_compensator.h"  // etch::backlash::Axis
#include "../motion/motion_planner.h"           // etch::motion::IStepSink

namespace etch {
namespace diagnostics {

// Per-axis selector, reused from the backlash module so the whole firmware
// shares one canonical X=0 / Y=1 axis type (Design §3.2.6). Aliased here so
// diagnostics call sites read naturally without a cross-module qualifier.
using Axis = backlash::Axis;

// Steps issued in each direction of an axis sweep (Requirement 12.4). The
// routine emits this many forward pulses then this many reverse pulses, so a
// clean sweep is net-zero per axis.
inline constexpr std::uint16_t MOTOR_TEST_STEPS_PER_DIRECTION = 200;

// ---------------------------------------------------------------------------
// Fault / stall query facade (host seam)
// ---------------------------------------------------------------------------

// Read-only view of the live fault and stall state the motor test polls while
// stepping. The concrete Diagnostics module (task 7.1) owns the underlying
// A3 fault poll (Req 12.5) and the per-axis missed-deadline stall counter
// (Req 12.3) and implements this facade; host tests plug in a fake.
//
// Contract:
//   * faultActive() reflects the shared A4988 fault line (A3). It is not
//     axis-specific: while it is asserted, whichever axis is mid-sweep fails.
//   * stallDetected(axis) is true once the stall detector has latched a stall
//     for that axis (missed-deadline counter >= threshold, Req 12.3).
// Both are pure observers -- the motor test never clears a latch; that is the
// job of the FAULT_RESET control path (Req 12.6).
class IDiagnosticsMonitor {
 public:
  virtual ~IDiagnosticsMonitor() = default;

  // True when the A4988 shared fault input (A3) is currently asserted.
  virtual bool faultActive() const = 0;

  // True when a stall is currently latched for `axis`.
  virtual bool stallDetected(Axis axis) const = 0;
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

// Per-axis outcome of run(). true == pass (full sweep completed clean),
// false == fail (stall or fault observed during that axis's sweep).
struct MotorTestResult {
  bool xPass;
  bool yPass;
};

// ---------------------------------------------------------------------------
// MotorTest
// ---------------------------------------------------------------------------

// Collaborators are injected by reference (mirroring MotionPlanner /
// BacklashCompensator) so host tests can substitute fakes. The routine holds
// no mutable state of its own; run() may be invoked repeatedly.
class MotorTest {
 public:
  MotorTest(motion::IStepSink& sink, IDiagnosticsMonitor& monitor,
            std::uint16_t stepsPerDirection = MOTOR_TEST_STEPS_PER_DIRECTION);

  MotorTest(const MotorTest&) = delete;
  MotorTest& operator=(const MotorTest&) = delete;

  // Run the self-test on X then Y and return the per-axis result.
  //
  // For each axis the routine energises the drivers, latches DIR forward and
  // emits `stepsPerDirection` pulses, then latches DIR reverse and emits the
  // same number of pulses. It polls the monitor before every pulse and once
  // more after the final pulse of each phase; the axis fails the instant
  // faultActive() or stallDetected(axis) is observed, and the reverse phase is
  // skipped for an axis that already failed forward (a real stall is not
  // moving and a real fault has dropped EN, so there is nothing to unwind).
  //
  // Position interaction: pulses are emitted directly through IStepSink and
  // never touch the MotionPlanner's logical-position counter, so this is
  // uncounted diagnostic motion and the tracked logical position is unchanged
  // by the test. A clean sweep is additionally net-zero in physical space
  // (200 forward + 200 back per axis), leaving the stylus where it started.
  MotorTestResult run();

 private:
  // Run one axis (forward then reverse). Returns true on a clean sweep.
  bool runAxis_(Axis axis);

  // Emit `steps_per_direction_` pulses on `axis` in `dir` (+1/-1), polling the
  // monitor around each pulse. Returns false the moment a fault/stall is seen.
  bool sweep_(Axis axis, std::int8_t dir);

  // True if a fault or a stall on `axis` is currently observed.
  bool failed_(Axis axis) const;

  motion::IStepSink& sink_;
  IDiagnosticsMonitor& monitor_;
  std::uint16_t steps_per_direction_;
};

}  // namespace diagnostics
}  // namespace etch
