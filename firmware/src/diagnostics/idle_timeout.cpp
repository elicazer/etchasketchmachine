// IdleTimeoutManager implementation (Task 7.5). See idle_timeout.h for the
// full contract and the host/Arduino seam rationale.
//
// This translation unit is pure timing logic over the injected IEnableLine
// seam: it holds no Arduino includes and reads no clock of its own (the caller
// supplies every timestamp), so it compiles and runs identically under
// `framework = arduino` and `platform = native`. The only Arduino-specific
// concern -- mapping setEnabled() onto the active-low D8 EN pin -- lives in
// ArduinoStepSink (motion_planner.cpp); task 8.1 adapts that sink to
// IEnableLine, so there is no `#if defined(ARDUINO)` block needed here.

#include "idle_timeout.h"

namespace etch {
namespace diagnostics {

IdleTimeoutManager::IdleTimeoutManager(IEnableLine& en,
                                       std::uint32_t timeoutMs)
    : en_(en), timeout_ms_(timeoutMs) {}

void IdleTimeoutManager::begin(std::uint32_t nowMs) {
  last_activity_ms_ = nowMs;
  // Power-on idle state: hold both motors with holding torque disabled
  // (Requirement 6.8). Force the line low->high through setEnabled_ so the
  // initial EN HIGH is asserted even though enabled_ already starts false.
  enabled_ = true;            // pretend-on so setEnabled_(false) drives a write
  setEnabled_(false);
}

void IdleTimeoutManager::tick(std::uint32_t nowMs) {
  if (!enabled_) {
    return;  // already disabled: nothing to time out.
  }
  // Unsigned subtraction is wraparound-safe: if nowMs has wrapped past the
  // 32-bit ceiling since last_activity_ms_, the modular difference is still
  // the true elapsed interval.
  const std::uint32_t elapsed = nowMs - last_activity_ms_;
  if (elapsed >= timeout_ms_) {
    setEnabled_(false);  // remove holding torque (EN HIGH) exactly once.
  }
}

void IdleTimeoutManager::notifyActivity(std::uint32_t nowMs) {
  last_activity_ms_ = nowMs;
  // Re-energise the drivers before motion begins (Design §9.3). No-op when
  // already enabled.
  setEnabled_(true);
}

void IdleTimeoutManager::setEnabled_(bool enabled) {
  if (enabled == enabled_) {
    return;  // suppress redundant writes; each transition fires once.
  }
  enabled_ = enabled;
  en_.setEnabled(enabled);
}

}  // namespace diagnostics
}  // namespace etch
