// StatusReporter implementation (Design §3.2.9, §4.7; Requirements 7.4, 10.9,
// 12.2).
//
// Structure mirrors the other firmware modules:
//
//   1. Portable aggregation, cadence, and serialisation logic. No Arduino
//      includes, no socket access. This compiles and is exhaustively tested
//      under `platform = native` (host Catch2) and reused verbatim on-device.
//
//   2. A single Arduino seam: the tick() convenience overload that samples
//      millis(), compiled only under `#if defined(ARDUINO)`. The host build
//      drives tick(nowMs) directly so timing is deterministic.

#include "status_reporter.h"

#if defined(ARDUINO)
#  include <Arduino.h>  // millis()
#endif

namespace etch {
namespace diagnostics {

// The serialiser pins the §4.7 byte layout; assert the snapshot field widths so
// a future type change cannot silently shift the wire format.
static_assert(sizeof(std::int32_t) == 4, "logical_*_steps must be 32-bit");
static_assert(STATUS_PAYLOAD_SIZE == 16, "STATUS payload is 16 bytes (§4.7)");

// ---------------------------------------------------------------------------
// Aggregation setters
// ---------------------------------------------------------------------------

void StatusReporter::setPercentComplete(std::uint8_t pct) {
  // §4.7 constrains pct_complete to 0..100; clamp defensively so an upstream
  // rounding overshoot never spills onto the wire.
  snap_.pct_complete = (pct > 100) ? 100 : pct;
}

void StatusReporter::setState(StatusState state) {
  // A genuine transition forces the next tick() to emit promptly so the UI
  // tracks idle<->drawing<->paused/fault/stall without waiting out the cadence
  // interval. A no-op write (same state) does not arm the force flag.
  if (state != snap_.state) {
    snap_.state = state;
    force_emit_ = true;
  }
}

void StatusReporter::setCalibrated(bool calibrated) {
  if (calibrated) {
    snap_.flags = static_cast<std::uint8_t>(snap_.flags | STATUS_FLAG_CALIBRATED);
  } else {
    snap_.flags = static_cast<std::uint8_t>(snap_.flags & ~STATUS_FLAG_CALIBRATED);
  }
}

void StatusReporter::setBufferFull(bool full) {
  if (full) {
    snap_.flags = static_cast<std::uint8_t>(snap_.flags | STATUS_FLAG_BUFFER_FULL);
  } else {
    snap_.flags = static_cast<std::uint8_t>(snap_.flags & ~STATUS_FLAG_BUFFER_FULL);
  }
}

void StatusReporter::setEnvelopeCalibrated(bool calibrated) {
  if (calibrated) {
    snap_.flags = static_cast<std::uint8_t>(snap_.flags | STATUS_FLAG_ENVELOPE_CALIBRATED);
  } else {
    snap_.flags = static_cast<std::uint8_t>(snap_.flags & ~STATUS_FLAG_ENVELOPE_CALIBRATED);
  }
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

void StatusReporter::begin() {
  // Arm an initial emit on the next tick() and clear the elapsed-time baseline.
  have_emitted_ = false;
  force_emit_ = true;
  last_emit_ms_ = 0;
}

void StatusReporter::emit(std::uint32_t nowMs) {
  if (sink_) {
    std::uint8_t buf[STATUS_PAYLOAD_SIZE];
    const std::size_t n = serialize(snap_, buf, sizeof(buf));
    sink_(buf, n);
  }
  last_emit_ms_ = nowMs;
  have_emitted_ = true;
  force_emit_ = false;
}

bool StatusReporter::tick(std::uint32_t nowMs) {
  // First tick after begin() (or a state change) always emits so the client
  // gets a prompt baseline / transition update.
  if (force_emit_ || !have_emitted_) {
    emit(nowMs);
    return true;
  }

  // Otherwise emit once the activity-dependent budget has elapsed. Unsigned
  // subtraction keeps the comparison correct across the 32-bit millis() wrap.
  const std::uint32_t elapsed = nowMs - last_emit_ms_;
  if (elapsed >= intervalMs()) {
    emit(nowMs);
    return true;
  }
  return false;
}

#if defined(ARDUINO)
bool StatusReporter::tick() { return tick(static_cast<std::uint32_t>(millis())); }
#endif

// ---------------------------------------------------------------------------
// Serialisation (Design §4.7)
// ---------------------------------------------------------------------------
//
// STATUS payload, 16 bytes, little-endian:
//
//   Offset  Size  Field            Type
//   ------  ----  ---------------  -----
//     0      4   logical_x_steps  i32
//     4      4   logical_y_steps  i32
//     8      1   pct_complete     u8   0..100
//     9      1   rssi_dbm         i8
//    10      2   active_sps       u16
//    12      1   state_code       u8   0=idle,1=drawing,2=paused,
//                                       3=fault,4=stall,5=aborted
//    13      1   flags            u8   bit0=calibrated, bit1=buffer_full,
//                                       bit2=envelope_calibrated
//    14      2   reserved         u16  always zero
//
// All multi-byte fields are written byte-wise least-significant-byte-first so
// the routine is endianness-agnostic on the host and matches the web decoder
// (web/src/codec/frame.ts) and the §4.3 Drawing_Command convention.
std::size_t StatusReporter::serialize(const StatusSnapshot& snap,
                                      std::uint8_t* out, std::size_t cap) {
  if (out == nullptr || cap < STATUS_PAYLOAD_SIZE) {
    return 0;
  }

  // Reinterpret signed positions through their unsigned bit pattern so the
  // shift-and-mask writes are well-defined for negative values (two's
  // complement on every supported target).
  const std::uint32_t x = static_cast<std::uint32_t>(snap.logical_x_steps);
  const std::uint32_t y = static_cast<std::uint32_t>(snap.logical_y_steps);

  out[0]  = static_cast<std::uint8_t>(x & 0xFF);
  out[1]  = static_cast<std::uint8_t>((x >> 8) & 0xFF);
  out[2]  = static_cast<std::uint8_t>((x >> 16) & 0xFF);
  out[3]  = static_cast<std::uint8_t>((x >> 24) & 0xFF);

  out[4]  = static_cast<std::uint8_t>(y & 0xFF);
  out[5]  = static_cast<std::uint8_t>((y >> 8) & 0xFF);
  out[6]  = static_cast<std::uint8_t>((y >> 16) & 0xFF);
  out[7]  = static_cast<std::uint8_t>((y >> 24) & 0xFF);

  out[8]  = snap.pct_complete;
  out[9]  = static_cast<std::uint8_t>(snap.rssi_dbm);

  out[10] = static_cast<std::uint8_t>(snap.active_sps & 0xFF);
  out[11] = static_cast<std::uint8_t>((snap.active_sps >> 8) & 0xFF);

  out[12] = static_cast<std::uint8_t>(snap.state);
  out[13] = snap.flags;

  out[14] = 0;  // reserved low byte
  out[15] = 0;  // reserved high byte

  return STATUS_PAYLOAD_SIZE;
}

std::size_t StatusReporter::serializePayload(std::uint8_t* out,
                                             std::size_t cap) const {
  return serialize(snap_, out, cap);
}

}  // namespace diagnostics
}  // namespace etch
