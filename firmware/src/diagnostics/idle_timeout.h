// IdleTimeoutManager - disables stepper holding torque after an idle period
// (Task 7.5, Design §9.3, Requirement 6.8).
//
// The A4988 ENABLE line (D8 on the CNC Shield) is active LOW: driving it LOW
// energises both drivers (holding torque on), driving it HIGH disables them
// (holding torque off). Continuously energising idle motors wastes power and
// lets the A4988s and NEMA-17s accumulate heat, so the firmware removes
// holding torque whenever the machine has been idle for IDLE_TIMEOUT_MS
// (5 s). The drivers are re-energised the instant the next motion activity is
// registered, before any pulses are emitted, so a move never starts against
// disabled drivers (Design §9.3).
//
// This manager owns only the *timing* policy; it drives the physical EN line
// through the narrow IEnableLine seam below. That keeps this header
// Arduino-include-free (so it compiles under both `framework = arduino` and
// `platform = native`) and lets host tests observe every EN transition with an
// in-memory fake. Time is always supplied by the caller as a millisecond
// stamp (millis() on Arduino) so the logic is fully host-deterministic -- the
// manager never reads a clock itself.
//
// Integration note (task 8.1): the production EN line is already driven by the
// MotionPlanner's IStepSink (motion_planner.h exposes setEnabled(bool), mapped
// onto D8 by ArduinoStepSink). To avoid a second owner of D8, the main loop
// wires this manager to that same sink via a one-line IEnableLine adapter
// rather than constructing a separate pin driver here.
//
// References:
//   - Requirement 6.8 (power-on idle: hold both motors with holding torque
//     disabled to prevent overheating).
//   - Design §9.3 (ENABLE line behaviour: EN HIGH after 5 s idle, EN LOW on
//     next motion command), §9.1 (EN = D8, active low).

#pragma once

#include <cstdint>

namespace etch {
namespace diagnostics {

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Idle window after which holding torque is removed (Design §9.3). Not on the
// wire, so it can be retuned without protocol impact.
inline constexpr std::uint32_t IDLE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// ENABLE-line abstraction (host seam)
// ---------------------------------------------------------------------------

// Narrow interface the idle manager uses to drive the shared active-low EN
// line. `enabled == true` energises the drivers (EN LOW, holding torque on);
// `enabled == false` removes holding torque (EN HIGH). This mirrors the
// semantics of motion::IStepSink::setEnabled(bool), so the production wiring
// can adapt the existing step sink to this interface in one line; host tests
// supply a fake that records each transition.
class IEnableLine {
 public:
  virtual ~IEnableLine() = default;

  // Drive EN: true -> LOW (drivers on), false -> HIGH (drivers disabled).
  virtual void setEnabled(bool enabled) = 0;
};

// ---------------------------------------------------------------------------
// IdleTimeoutManager
// ---------------------------------------------------------------------------

class IdleTimeoutManager {
 public:
  // `en` is the EN line seam; `timeoutMs` is the idle window before holding
  // torque is removed (defaults to IDLE_TIMEOUT_MS, overridable for tests).
  explicit IdleTimeoutManager(IEnableLine& en,
                              std::uint32_t timeoutMs = IDLE_TIMEOUT_MS);

  IdleTimeoutManager(const IdleTimeoutManager&) = delete;
  IdleTimeoutManager& operator=(const IdleTimeoutManager&) = delete;

  // Establish the power-on state (Requirement 6.8): with no commands received
  // yet, both motors are held idle with holding torque disabled (EN HIGH).
  // Records `nowMs` as the activity baseline. Idempotent.
  void begin(std::uint32_t nowMs);

  // Cooperative main-loop tick. When the drivers are enabled and at least
  // `timeoutMs` has elapsed since the last registered activity, drives EN HIGH
  // (disabled) exactly once. Cheap to call every loop pass; a no-op while
  // activity is recent or the drivers are already disabled. The elapsed-time
  // comparison uses unsigned subtraction so it stays correct across a 32-bit
  // millis() wraparound.
  void tick(std::uint32_t nowMs);

  // Register motion activity (a new segment / jog / motion command). Resets
  // the idle timer to `nowMs` and, if the drivers were disabled, re-enables
  // them (EN LOW) immediately so motion can begin against energised drivers
  // (Design §9.3). Re-enabling is synchronous: it happens before this call
  // returns, not on the next tick().
  void notifyActivity(std::uint32_t nowMs);

  // True when the drivers are energised (EN LOW / holding torque on).
  bool isEnabled() const { return enabled_; }

 private:
  // Drive the EN line only on an actual state change, so redundant writes are
  // suppressed and each transition is observable exactly once.
  void setEnabled_(bool enabled);

  IEnableLine& en_;
  std::uint32_t timeout_ms_;
  std::uint32_t last_activity_ms_ = 0;
  bool enabled_ = false;  // power-on: holding torque disabled (Req 6.8)
};

}  // namespace diagnostics
}  // namespace etch
