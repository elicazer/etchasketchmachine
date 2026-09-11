// Pure envelope-calibration core (Visual Corner Calibration feature).
//
// This translation unit holds the input-varying logic introduced by the
// Visual_Calibration flow as small, pure, free functions with no I/O, no
// globals, and no Arduino includes, so it compiles unchanged both under
// `framework = arduino` for the UNO R4 WiFi target and under `platform =
// native` for the host-side Catch2 / rapidcheck tests. The `.ino` (task 5) is
// thin wiring over these functions; the firmware-side correctness properties
// (P2 draw gate, P3 jog cap, P5 envelope validity, P6 envelope = own travel)
// are exercised here on the host.
//
// Axis decision: this core reuses the existing wire-stable
// `etch::protocol::Axis` (X = 0, Y = 1) from protocol/control_parser.h rather
// than introducing a duplicate enum. control_parser.h is itself Arduino-free
// (it pulls in only <cstddef>/<cstdint> and types.h), so including it keeps
// this core host-compilable while guaranteeing the jog-cap axis selector is
// the very same type the CTL JOG payload already carries.
//
// References:
//   - Requirements 1.5, 1.6 (envelope = Controller's own accumulated travel),
//     2.1 (valid envelope is strictly positive on both axes),
//     4.2 (Envelope_Calibrated_State = Home_Set AND Envelope_Captured),
//     5.1 (no gear-math fallback — the gate is the only path),
//     6.1, 6.4 (fixed per-axis jog travel cap, independent of any envelope).
//   - Design §"Firmware: Sketch Handlers", §"Testing Strategy".

#pragma once

#include <cstdint>

#include "../protocol/control_parser.h"  // etch::protocol::Axis (X=0, Y=1)
#include "../types.h"                     // etch::Position

namespace etch {
namespace app {

// Axis selector for the jog-cap check. Aliased to the existing wire-stable
// protocol::Axis so the firmware uses one Axis concept end-to-end.
using Axis = protocol::Axis;

// A travel envelope measured from the Controller's own step counters. Held as
// signed 32-bit values to mirror the planner Position fields it is derived
// from; the .ino narrows the validated (strictly positive) result to the u32
// PersistedConfig / HELLO fields. Never derived from any SPA-supplied value.
struct MeasuredEnvelope {
  std::int32_t x;
  std::int32_t y;
};

// Drawing gate predicate (Req 4.2, 5.1). Drawing is permitted if and only if
// home has been set AND a valid envelope has been captured; there is no
// gear-math fallback path, so every other combination blocks drawing.
constexpr bool drawingPermitted(bool homeSet, bool envelopeCaptured) {
  return homeSet && envelopeCaptured;
}

// Jog travel cap predicate (Req 6.1, 6.4). Given the current logical position
// (curX, curY), the jogged `axis`, and the signed `delta` steps for that jog,
// returns true iff the resulting position on the jogged axis stays within the
// inclusive band [-cap, +cap]. The non-jogged axis is unchanged and therefore
// not re-checked. The cap is a fixed per-session limit independent of any
// captured envelope.
constexpr bool jogWithinCap(std::int32_t curX, std::int32_t curY, Axis axis,
                            std::int32_t delta, std::int32_t cap) {
  const std::int64_t resulting =
      (axis == Axis::X) ? static_cast<std::int64_t>(curX) + delta
                        : static_cast<std::int64_t>(curY) + delta;
  return resulting <= static_cast<std::int64_t>(cap) &&
         resulting >= -static_cast<std::int64_t>(cap);
}

// Measure the Step_Envelope from the Controller's own counters (Req 1.5, 1.6).
// Home is logical (0,0) (SET_HOME zeroes the planner position), so the envelope
// is simply the per-axis magnitude of the current position. Never reads any
// SPA-supplied value.
constexpr MeasuredEnvelope measureEnvelope(Position pos) {
  const std::int32_t mx = pos.x_steps < 0 ? -pos.x_steps : pos.x_steps;
  const std::int32_t my = pos.y_steps < 0 ? -pos.y_steps : pos.y_steps;
  return MeasuredEnvelope{mx, my};
}

// Envelope validity predicate (Req 2.1). A measured envelope is accepted only
// when both axes are strictly positive; zero or negative on either axis is
// rejected and leaves the captured state cleared.
constexpr bool isValidEnvelope(std::int32_t mx, std::int32_t my) {
  return mx > 0 && my > 0;
}

// Effective-envelope resolver (Req 2.5, 2.6, 2.7, 3.5; bug condition C2:
// X.kind = DRAW AND NOT X.envelopeCalibrated). Resolves which step envelope the
// firmware should use for a draw:
//   - return the CAPTURED envelope iff the machine is envelope-calibrated
//     (NVM_FLAG_ENVELOPE_CALIBRATED set) AND the stored pair is a valid
//     (strictly positive) envelope -- a captured envelope always overrides the
//     default (Req 2.6 / 3.5);
//   - otherwise return the baked-in, bounded DEFAULT_ENVELOPE so an
//     uncalibrated machine can still draw within the physical drawing area
//     instead of being hard-blocked with EnvelopeRequired (Req 2.5).
//
// Pure and Arduino-free so the host tests drive it directly. The PersistedConfig
// envelope fields are unsigned 32-bit; they are narrowed to the signed
// MeasuredEnvelope the rest of the app layer uses after the strictly-positive
// validity check (any value that survives isValidEnvelope is well within the
// positive int32 range for a physical step envelope).
constexpr MeasuredEnvelope effectiveEnvelope(const PersistedConfig& cfg) {
  const bool calibrated = (cfg.flags & NVM_FLAG_ENVELOPE_CALIBRATED) != 0;
  const std::int32_t capturedX =
      static_cast<std::int32_t>(cfg.envelope_x_steps);
  const std::int32_t capturedY =
      static_cast<std::int32_t>(cfg.envelope_y_steps);
  if (calibrated && isValidEnvelope(capturedX, capturedY)) {
    return MeasuredEnvelope{capturedX, capturedY};  // captured overrides default
  }
  return MeasuredEnvelope{
      static_cast<std::int32_t>(DEFAULT_ENVELOPE_X_STEPS),
      static_cast<std::int32_t>(DEFAULT_ENVELOPE_Y_STEPS)};
}

}  // namespace app
}  // namespace etch
