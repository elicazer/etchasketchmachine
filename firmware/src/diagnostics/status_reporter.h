// StatusReporter - aggregates telemetry into a STATUS frame payload and paces
// its emission (Design §3.2.9, §4.7; Requirements 7.4, 10.9, 12.2).
//
// The Controller periodically reports its live state to the browser SPA: the
// current logical stylus position (counted full motor steps relative to home),
// percent complete, WiFi RSSI, the active step rate, a coarse controller-state
// code, and a couple of status flags. This component owns two responsibilities:
//
//   1. Aggregation. The main loop pushes the latest values in through narrow
//      setters (position/percent/rssi/active-sps/state/calibrated/buffer-full).
//      StatusReporter holds them in a single StatusSnapshot mirroring the
//      §4.7 wire layout field-for-field.
//
//   2. Cadence. tick(nowMs) decides whether enough time has elapsed to emit a
//      fresh STATUS frame. While a drawing is in progress the cadence is
//      >= 1 Hz (at most ~1000 ms between frames, Req 7.4); otherwise it relaxes
//      to >= 0.2 Hz (at most ~5000 ms between frames, Req 12.2). A controller
//      state change forces a prompt emit so the UI never lags a transition.
//
// When a frame is due, StatusReporter serialises the 16-byte §4.7 payload and
// hands it to an injected emit sink. It deliberately does NOT build the §4.5
// envelope or touch the WebSocket: the main loop's sink wraps the payload in a
// STATUS frame (type 0x20) and forwards it to WSServer. Keeping the socket out
// of this class is what lets the whole thing run deterministically on the host.
//
// This header is intentionally Arduino-include-free so it compiles both under
// `framework = arduino` for the UNO R4 WiFi target and under `platform =
// native` for the host-side Catch2 tests. The only Arduino dependency
// (millis()) lives behind `#if defined(ARDUINO)` in the .cpp; the core cadence
// logic takes nowMs as a parameter to tick() and is fully host-deterministic.
//
// References:
//   - Requirements 7.4 (>=1 Hz progress incl. position + percent during draw),
//     10.9 (live position display), 12.2 (RSSI reporting).
//   - Design §3.2.9 (StatusReporter surface), §4.7 (STATUS frame byte layout).

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

#include "../types.h"  // etch::Position

namespace etch {
namespace diagnostics {

// ---------------------------------------------------------------------------
// Wire constants (Design §4.7)
// ---------------------------------------------------------------------------

// Fixed STATUS payload size carried inside a STATUS frame (type 0x20). The
// outer §4.5 envelope is added by the emit sink, not here.
inline constexpr std::size_t STATUS_PAYLOAD_SIZE = 16;

// Coarse controller-state codes carried in the STATUS payload (offset 12).
// The numeric values are wire-stable and MUST match web/src/codec/frame.ts.
enum class StatusState : std::uint8_t {
  Idle    = 0,
  Drawing = 1,
  Paused  = 2,
  Fault   = 3,
  Stall   = 4,
  Aborted = 5,
};

// STATUS flag bits (offset 13). All other bits are reserved and MUST be zero.
inline constexpr std::uint8_t STATUS_FLAG_CALIBRATED          = 0x01;  // bit0
inline constexpr std::uint8_t STATUS_FLAG_BUFFER_FULL         = 0x02;  // bit1
inline constexpr std::uint8_t STATUS_FLAG_ENVELOPE_CALIBRATED = 0x04;  // bit2

// ---------------------------------------------------------------------------
// Cadence constants (Design §3.2.9; Requirements 7.4, 12.2)
// ---------------------------------------------------------------------------

// Maximum gap between STATUS frames while drawing: >= 1 Hz => <= 1000 ms.
inline constexpr std::uint32_t STATUS_DRAWING_INTERVAL_MS = 1000;

// Maximum gap between STATUS frames while idle: >= 0.2 Hz => <= 5000 ms.
inline constexpr std::uint32_t STATUS_IDLE_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// StatusSnapshot - in-memory mirror of the §4.7 STATUS payload
// ---------------------------------------------------------------------------
//
// Field order intentionally tracks the wire layout for readability; the actual
// byte offsets are pinned by serialize() and the static_asserts in the .cpp.
struct StatusSnapshot {
  std::int32_t  logical_x_steps = 0;   // offset  0  i32  steps from home
  std::int32_t  logical_y_steps = 0;   // offset  4  i32  steps from home
  std::uint8_t  pct_complete    = 0;   // offset  8  u8   0..100
  std::int8_t   rssi_dbm        = 0;   // offset  9  i8   Req 12.2
  std::uint16_t active_sps      = 0;   // offset 10  u16  current step rate
  StatusState   state           = StatusState::Idle;  // offset 12  u8
  std::uint8_t  flags           = 0;   // offset 13  u8   STATUS_FLAG_* bits
  // offset 14..15 reserved u16, always serialised as zero.
};

// ---------------------------------------------------------------------------
// StatusReporter
// ---------------------------------------------------------------------------

class StatusReporter {
 public:
  // Sink invoked with the serialised 16-byte §4.7 STATUS payload whenever a
  // frame is due. `payload` is valid only for the duration of the call; sinks
  // that need the bytes afterwards must copy them. The sink is responsible for
  // framing (§4.5 envelope) and transport; this class never touches the socket.
  using EmitSink = std::function<void(const std::uint8_t* payload,
                                      std::size_t len)>;

  StatusReporter() = default;
  explicit StatusReporter(EmitSink sink) : sink_(std::move(sink)) {}

  // Reset cadence bookkeeping so the very next tick() emits an initial frame.
  // Does not clear the aggregated snapshot (the main loop owns those values).
  void begin();

  // Replace the emit sink. May be called before or after begin().
  void setEmitSink(EmitSink sink) { sink_ = std::move(sink); }

  // ---- Aggregation setters (called by the main loop) ----------------------

  // Logical stylus position in counted full motor steps relative to home
  // (Req 10.9). Backlash compensation steps are excluded upstream.
  void setPosition(const Position& p) {
    snap_.logical_x_steps = p.x_steps;
    snap_.logical_y_steps = p.y_steps;
  }

  // Percent complete, clamped to [0, 100] (Req 7.4).
  void setPercentComplete(std::uint8_t pct);

  // WiFi signal strength in dBm (Req 12.2).
  void setRssiDbm(std::int8_t dbm) { snap_.rssi_dbm = dbm; }

  // Active step rate in full steps per second.
  void setActiveSps(std::uint16_t sps) { snap_.active_sps = sps; }

  // Controller state code. A change from the current value forces the next
  // tick() to emit promptly so the UI tracks transitions without waiting out
  // the cadence interval.
  void setState(StatusState state);

  // Set/clear the calibrated flag bit (bit0).
  void setCalibrated(bool calibrated);

  // Set/clear the buffer-full flag bit (bit1).
  void setBufferFull(bool full);

  // Set/clear the envelope-calibrated flag bit (bit2).
  void setEnvelopeCalibrated(bool calibrated);

  // ---- Inspection ----------------------------------------------------------

  const StatusSnapshot& snapshot() const { return snap_; }
  StatusState state() const { return snap_.state; }
  std::uint8_t flags() const { return snap_.flags; }

  // ---- Cadence -------------------------------------------------------------

  // Cooperative tick from the main loop. Emits a STATUS frame (via the sink)
  // iff one is due: on the first tick after begin(), after a state change, or
  // once the activity-dependent interval has elapsed since the last emit.
  // `nowMs` is a free-running millisecond clock; unsigned subtraction makes the
  // elapsed-time check correct across the 32-bit wrap. Returns true iff a frame
  // was emitted.
  bool tick(std::uint32_t nowMs);

#if defined(ARDUINO)
  // Convenience overload that samples the Arduino millis() clock. On-device
  // only; host tests call tick(nowMs) for deterministic timing.
  bool tick();
#endif

  // ---- Serialisation -------------------------------------------------------

  // Serialise the current snapshot into the 16-byte §4.7 little-endian payload.
  // Returns the number of bytes written (STATUS_PAYLOAD_SIZE) on success, or 0
  // if `out` is null or `cap` < STATUS_PAYLOAD_SIZE.
  std::size_t serializePayload(std::uint8_t* out, std::size_t cap) const;

  // Pure/static serialiser so host tests can assert the §4.7 byte layout
  // without constructing a reporter. Same contract as serializePayload().
  static std::size_t serialize(const StatusSnapshot& snap, std::uint8_t* out,
                               std::size_t cap);

 private:
  // Activity-dependent cadence: the tight 1 Hz budget while drawing, otherwise
  // the relaxed 0.2 Hz idle budget.
  std::uint32_t intervalMs() const {
    return (snap_.state == StatusState::Drawing) ? STATUS_DRAWING_INTERVAL_MS
                                                 : STATUS_IDLE_INTERVAL_MS;
  }

  // Serialise the snapshot and push it to the sink, then update bookkeeping.
  void emit(std::uint32_t nowMs);

  EmitSink      sink_{};
  StatusSnapshot snap_{};

  std::uint32_t last_emit_ms_ = 0;   // timestamp of the most recent emit
  bool          have_emitted_ = false;  // false until the first emit
  bool          force_emit_   = false;  // set by begin()/setState() transitions
};

}  // namespace diagnostics
}  // namespace etch
