// Diagnostics implementation (Task 7.1). See diagnostics.h for the full
// contract and the host/Arduino seam rationale.
//
// The file has two layers, mirroring wifi_manager.cpp / motion_planner.cpp:
//
//   1. The Diagnostics latch logic. Pure C++ that compiles under both
//      `framework = arduino` and `platform = native`. It never touches a pin
//      directly -- all pin access goes through the injected IDiagPins, so the
//      host tests in firmware/tests/test_diagnostics exercise the full state
//      machine with an in-memory fake.
//
//   2. ArduinoDiagPins, the concrete IDiagPins for the CNC Shield, entirely
//      behind `#if defined(ARDUINO)`. It is the only place that reads A3 and
//      writes the active-low EN line (Design §9.1, §9.3, §9.4). Task 8.1
//      constructs one and injects it.

#include "diagnostics.h"

#include <utility>  // std::move

#if defined(ARDUINO)
#  include <Arduino.h>
#endif

namespace etch {
namespace diag {

// ---------------------------------------------------------------------------
// Diagnostics latch logic (always-on; host-tested)
// ---------------------------------------------------------------------------

Diagnostics::Diagnostics(IDiagPins& pins, ErrorSink sink)
    : pins_(pins), sink_(std::move(sink)) {}

void Diagnostics::begin() {
  faulted_ = false;
  stalled_ = false;
  for (std::size_t i = 0; i < kAxisCount; ++i) {
    missed_[i] = 0;
    stall_emitted_[i] = false;
  }
  last_error_ = DiagError{0, 0, 0};
}

void Diagnostics::poll() {
  // A latched fault stays latched until faultReset(); A3 returning HIGH must
  // not silently re-enable the drivers (Req 12.6). So we only act on the
  // unfaulted -> faulted edge.
  if (faulted_) {
    return;
  }
  if (pins_.readFault()) {
    // Drop EN HIGH (drivers disabled) first so torque is removed within this
    // single loop pass (<= 10 ms latency, Req 12.5), then latch and report.
    pins_.setEnabled(false);
    faulted_ = true;
    emit_(DiagError{ERROR_KIND_FAULT, ERROR_AXIS_NONE, 0});
  }
}

void Diagnostics::reportMissedDeadline(Axis axis) {
  const std::size_t i = static_cast<std::size_t>(axis);
  if (i >= kAxisCount) {
    return;  // defensive: ignore out-of-range axis
  }

  // Saturate the counter so a long-running stall cannot wrap the byte.
  if (missed_[i] < 0xFF) {
    ++missed_[i];
  }

  // Raise the stall on the first poll at/above the threshold for this axis,
  // and only once per latch (Req 12.3). The stall latch is global, but the
  // per-axis emit guard keeps a second axis able to report independently
  // within the same segment.
  if (missed_[i] >= STALL_THRESHOLD && !stall_emitted_[i]) {
    stall_emitted_[i] = true;
    stalled_ = true;
    emit_(DiagError{ERROR_KIND_STALL, static_cast<std::uint8_t>(axis),
                    missed_[i]});
  }
}

void Diagnostics::resetSegment() {
  // Zero the per-segment counters and their emit guards so misses in distinct
  // segments never accumulate toward the threshold (Req 12.3). A stall that
  // has already latched is intentionally left set -- only faultReset() clears
  // it.
  for (std::size_t i = 0; i < kAxisCount; ++i) {
    missed_[i] = 0;
    stall_emitted_[i] = false;
  }
}

void Diagnostics::faultReset() {
  // Re-enable EN (drive LOW) and clear both latches plus the per-segment
  // counters (Req 12.6). lastError() is retained as a record of what tripped.
  pins_.setEnabled(true);
  faulted_ = false;
  stalled_ = false;
  for (std::size_t i = 0; i < kAxisCount; ++i) {
    missed_[i] = 0;
    stall_emitted_[i] = false;
  }
}

std::uint8_t Diagnostics::missedDeadlines(Axis axis) const {
  const std::size_t i = static_cast<std::size_t>(axis);
  return (i < kAxisCount) ? missed_[i] : 0;
}

void Diagnostics::emit_(const DiagError& err) {
  last_error_ = err;
  if (sink_) {
    sink_(err);
  }
}

// ---------------------------------------------------------------------------
// Hardware seam: A3 fault tap + EN line -- real on Arduino, absent on host
// ---------------------------------------------------------------------------

#if defined(ARDUINO)

namespace {

// CNC Shield V3.0 -> Arduino pin map (Design §9.1).
//   A3 is repurposed as the aggregate driver-fault input, INPUT_PULLUP,
//   active LOW (Design §9.4). EN (D8) is shared, active LOW (Design §9.3):
//   LOW energises the drivers, HIGH removes drive.
constexpr std::uint8_t PIN_FAULT = A3;
constexpr std::uint8_t PIN_EN    = 8;

}  // namespace

// Concrete IDiagPins for the CNC Shield. Lives here (not the header) so the
// header stays Arduino-include-free; task 8.1 constructs one and injects it.
// The EN pin is shared with ArduinoStepSink (motion_planner.cpp); whichever
// module is wired to drive it in the main-loop integration owns pinMode().
class ArduinoDiagPins : public IDiagPins {
 public:
  // Configure A3 with its internal pull-up so an unwired tap reads HIGH
  // (no fault) and any external normally-closed sensor pulls it LOW on a
  // fault (Design §9.4). EN is configured by the motion layer; we only ever
  // drive it.
  void beginPins() {
    pinMode(PIN_FAULT, INPUT_PULLUP);
    pinMode(PIN_EN, OUTPUT);
  }

  bool readFault() override { return digitalRead(PIN_FAULT) == LOW; }

  void setEnabled(bool enabled) override {
    digitalWrite(PIN_EN, enabled ? LOW : HIGH);  // active-low
  }
};

#endif  // defined(ARDUINO)

}  // namespace diag
}  // namespace etch
