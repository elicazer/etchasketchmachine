// Diagnostics - fault & stall detection (Task 7.1, Design §3.2.8).
//
// Two complementary safety signals feed one latch (Design §2.2 "Fault
// detection", §9.4):
//
//   1. Hardware fault: an aggregate driver-health input on A3 (INPUT_PULLUP,
//      active LOW). poll() samples it every main-loop iteration; on a LOW
//      assertion it drops the shared active-low EN line (drivers disabled)
//      within one loop pass (<= 10 ms, Req 12.5) and emits
//      ERROR{kind=FAULT} (Design §4.5).
//
//   2. Software stall: the motion executor reports a missed step deadline per
//      axis through reportMissedDeadline(). When the per-segment counter for
//      an axis reaches STALL_THRESHOLD (>= 4 in a single segment) the latch
//      raises ERROR{kind=STALL, axis} (Req 12.3). resetSegment() zeroes the
//      counters at each segment boundary so misses never accumulate across
//      segments.
//
// Both conditions are latched and cleared only by faultReset() (the handler
// for the FAULT_RESET control message), which re-enables EN and clears the
// fault/stall state (Req 12.6).
//
// Host-testability seams (this header is Arduino-include-free, mirroring
// wifi_manager.h / motion_planner.h):
//   * Pin access is injected through the narrow IDiagPins interface
//     (readFault() -> bool, setEnabled(bool)), so host tests can simulate an
//     A3 assertion and observe EN transitions with an in-memory fake. The
//     concrete ArduinoDiagPins lives in the .cpp behind `#if defined(ARDUINO)`
//     and is the only place that touches digitalRead/digitalWrite.
//   * ERROR frames are handed to an injected error-sink callback rather than
//     written to the socket directly; the WS layer (task 8.1) supplies a sink
//     that serialises a §4.5 ERROR frame.
//
// References:
//   - Requirements 12.3 (stall threshold), 12.5 (fault disables EN <= 10 ms),
//     12.6 (fault reset).
//   - Design §3.2.8 (Diagnostics surface), §4.5 (ERROR frame layout),
//     §9.3 (EN line behaviour), §9.4 (fault-pin tap).

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

namespace etch {
namespace diag {

// ---------------------------------------------------------------------------
// Axis selector
// ---------------------------------------------------------------------------

// Per-axis selector for reportMissedDeadline() and the STALL error axis byte.
// The numeric values double as indices into the per-axis counter array and as
// the wire `axis` byte of a §4.5 ERROR frame, so X = 0, Y = 1 must not change
// without auditing both. types.h does not define an axis type, so it lives
// here next to the only API that consumes it (matching control_parser.h and
// backlash_compensator.h).
enum class Axis : std::uint8_t {
  X = 0,
  Y = 1,
};

// ---------------------------------------------------------------------------
// Wire-stable ERROR kind / axis codes (Design §4.5)
// ---------------------------------------------------------------------------

// ERROR kinds carried in the §4.5 ERROR frame body. Only the two kinds this
// module raises are defined here; the remaining kinds (UNRECOVERABLE_TX,
// CONN_TIMEOUT, HOME_REQUIRED, SESSION_BUSY) are owned by other layers.
inline constexpr std::uint8_t ERROR_KIND_STALL = 0x01;
inline constexpr std::uint8_t ERROR_KIND_FAULT = 0x02;

// Axis byte used when an ERROR is not axis-specific. The A3 fault tap is an
// aggregate driver-health signal (Design §9.4) and cannot resolve which A4988
// tripped, so a FAULT carries this sentinel rather than X/Y. 0xFF is outside
// the {0, 1} axis range so the UI can render an "aggregate" label.
inline constexpr std::uint8_t ERROR_AXIS_NONE = 0xFF;

// Missed-deadline count within a single segment that raises a stall
// (Req 12.3: "4 or more missed steps within a single movement segment").
inline constexpr std::uint8_t STALL_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// ERROR payload (Design §4.5 frame body: { u8 kind, u8 axis, u16 detail })
// ---------------------------------------------------------------------------

// Decoded ERROR frame body. The injected ErrorSink serialises this onto the
// wire; Diagnostics never touches the socket. `detail` carries supplementary
// context: the missed-deadline count for STALL, 0 for FAULT.
struct DiagError {
  std::uint8_t  kind;    // ERROR_KIND_*
  std::uint8_t  axis;    // Axis value, or ERROR_AXIS_NONE
  std::uint16_t detail;  // kind-specific (stall: missed count; fault: 0)
};

// Callback the WS layer supplies to serialise a §4.5 ERROR frame. Invoked
// exactly once on each latch transition (one FAULT per assertion, one STALL
// per axis per segment), never per poll().
using ErrorSink = std::function<void(const DiagError&)>;

// ---------------------------------------------------------------------------
// Pin abstraction (host seam)
// ---------------------------------------------------------------------------

// Narrow interface Diagnostics uses to read the A3 fault tap and drive the
// shared active-low EN line. The concrete ArduinoDiagPins (diagnostics.cpp,
// guarded by ARDUINO) maps these onto digitalRead(A3) / digitalWrite(D8);
// host tests supply a fake that returns a scripted fault level and records EN
// transitions. Polarity is hidden behind this facade so the header stays
// Arduino-agnostic.
class IDiagPins {
 public:
  virtual ~IDiagPins() = default;

  // True iff a hardware fault is currently asserted. The Arduino backing maps
  // this to `digitalRead(A3) == LOW` (active-low tap, Design §9.4); the host
  // fake returns a scripted value.
  virtual bool readFault() = 0;

  // Drive the shared active-low EN line: enabled == true energises the drivers
  // (EN LOW); enabled == false removes drive (EN HIGH). Matches IStepSink's
  // setEnabled() polarity so both can target the same physical pin.
  virtual void setEnabled(bool enabled) = 0;
};

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// Fault & stall latch. Public surface mirrors Design §3.2.8: poll() every
// loop, reportMissedDeadline()/resetSegment() driven by the MotionPlanner/ISR,
// faultReset() driven by the FAULT_RESET control message.
class Diagnostics {
 public:
  // Collaborators injected by reference / value so host tests can substitute
  // fakes. `sink` may be empty (no-op) but is normally the WS serialiser.
  Diagnostics(IDiagPins& pins, ErrorSink sink);

  Diagnostics(const Diagnostics&) = delete;
  Diagnostics& operator=(const Diagnostics&) = delete;

  // Reset all latch/counter state to a clean, unfaulted baseline. Does not
  // touch the EN line (driver power is owned by the MotionPlanner's idle/seed
  // logic); idempotent. Call from setup().
  void begin();

  // Sample the A3 fault tap. On the transition from unfaulted to faulted it
  // disables EN (within this one loop pass, <= 10 ms, Req 12.5), latches the
  // fault, and emits ERROR{kind=FAULT} once. A latched fault is NOT cleared by
  // A3 returning HIGH -- only faultReset() clears it (Req 12.6). Cheap; call
  // every main-loop iteration.
  void poll();

  // Report that one expected step deadline was missed on `axis` within the
  // current segment. When the axis's per-segment counter reaches
  // STALL_THRESHOLD it latches the stall and emits ERROR{kind=STALL, axis}
  // once. Further misses on an already-stalled axis do not re-emit. Safe to
  // call from the motion ISR (no allocation; the sink call happens here, so
  // the sink supplied for ISR use must itself be ISR-safe -- task 8.1 wires a
  // deferred sink if required).
  void reportMissedDeadline(Axis axis);

  // Zero the per-segment missed-deadline counters. Called by the planner at
  // every segment boundary so misses in distinct segments never accumulate
  // toward the threshold (Req 12.3: "within a single movement segment"). Does
  // not clear a stall that has already latched.
  void resetSegment();

  // Handle the FAULT_RESET control message (Req 12.6): re-enable EN (drive
  // LOW), clear the fault and stall latches, and zero the per-segment
  // counters so a fresh segment starts clean.
  void faultReset();

  // True between a fault assertion and the next faultReset().
  bool isFaulted() const { return faulted_; }

  // True between a stall latch and the next faultReset(). resetSegment() does
  // not clear this (a raised stall persists until the user resets).
  bool isStalled() const { return stalled_; }

  // The most recently emitted ERROR body. Zero-initialised until the first
  // fault or stall is raised.
  DiagError lastError() const { return last_error_; }

  // Current per-segment missed-deadline counter for `axis` (diagnostics/tests).
  std::uint8_t missedDeadlines(Axis axis) const;

 private:
  static constexpr std::size_t kAxisCount = 2;

  // Emit `err` through the sink (if any) and remember it as lastError().
  void emit_(const DiagError& err);

  IDiagPins& pins_;
  ErrorSink  sink_;

  bool faulted_ = false;  // hardware fault latched (A3)
  bool stalled_ = false;  // software stall latched (missed-deadline threshold)

  // Per-axis missed-deadline counters for the current segment, indexed by
  // static_cast<std::size_t>(Axis). Zeroed by resetSegment() / faultReset().
  std::uint8_t missed_[kAxisCount] = {0, 0};

  // Per-axis "already emitted a STALL this latch" guard so a counter that
  // keeps climbing past the threshold does not spam the sink.
  bool stall_emitted_[kAxisCount] = {false, false};

  DiagError last_error_ = {0, 0, 0};
};

}  // namespace diag
}  // namespace etch
