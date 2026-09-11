// Control message (CTL) parser (Design §4.6).
//
// A CTL frame (FrameType::CTL, 0x02) carries a variable-length payload whose
// first byte is a u8 `ctl_kind` code, optionally followed by a per-kind
// payload. This translation unit decodes and validates that payload into a
// tagged `ControlMessage`. It is intentionally free of Arduino includes (only
// <cstdint>/<cstddef>) so it compiles both for the UNO R4 WiFi target and for
// the host-side Catch2 tests, and so the exact same range checks back the
// firmware and document the shared wire contract with the web `WireClient`.
//
// ---------------------------------------------------------------------------
// Wire contract (Design §4.6) -- THIS IS THE SHARED CONTRACT WITH THE WEB SIDE
// ---------------------------------------------------------------------------
// The numeric `ctl_kind` codes below are wire-stable and MUST match the
// web-side encoder. They are the §4.6 codes (0x01..0x0D) plus the
// visual-corner-calibration capture kinds (0x0E..0x0F); the existing
// frame-dispatch tests (firmware/tests/test_frame) already encode JOG as 0x05
// and PAUSE as 0x01, so do not renumber without updating §4.6, the web
// `WireClient`, and those tests in lockstep.
//
// Every CTL payload begins with the 1-byte kind; multi-byte fields are
// little-endian. Offsets below are relative to the start of the CTL payload
// (i.e. the kind byte is at offset 0).
//
//   kind  name          total len  payload layout (offsets from kind byte)
//   ----  ------------  ---------  -----------------------------------------
//   0x01  PAUSE             1      (none)
//   0x02  RESUME            1      (none)
//   0x03  CANCEL            1      (none)
//   0x04  STOP              1      (none)
//   0x05  JOG               5      [1] u8  axis (0=X,1=Y)
//                                  [2] i8  dir  (+1 or -1)
//                                  [3] u16 steps  (little-endian, [1,1000])
//   0x06  SET_HOME          1      (none)
//   0x07  RE_HOME           1      (none)
//   0x08  BEGIN_DRAW        9      [1] u32 total_segments (little-endian)
//                                  [5] u32 total_steps    (little-endian)
//   0x09  END_DRAW          1      (none)
//   0x0A  SPEED_PCT         2      [1] u8  pct  ([25,100], Req 9.7)
//   0x0B  SET_BACKLASH      5      [1] u16 x  (little-endian, [0,200])
//                                  [3] u16 y  (little-endian, [0,200])
//   0x0C  MOTOR_TEST        1      (none)
//   0x0D  FAULT_RESET       1      (none)
//   0x0E  CAPTURE_BOTTOM_LEFT  1   (none)  -- Controller measures its own steps
//   0x0F  CAPTURE_TOP_RIGHT    1   (none)  -- Controller measures its own steps
//
// References:
//   - Requirements 9.1-9.8 (pause/resume/cancel/stop, speed pct),
//     10.3 (single full-step jog), 10.4/10.5 (set/re-home),
//     10.13 (re-home clears calibration), 12.4 (motor test),
//     12.6 (fault reset), 13.8 (backlash 0..200 range).
//   - Design §4.6 Control Messages.

#pragma once

#include <cstddef>
#include <cstdint>

#include "../types.h"  // SPEED_PCT_MIN/MAX, BACKLASH_STEPS_MIN/MAX

namespace etch {
namespace protocol {

// Axis selector for per-axis control payloads (JOG, SET_BACKLASH). `types.h`
// does not define an Axis concept, so it lives here next to the wire contract
// that uses it. The numeric values (X=0, Y=1) are part of the wire format.
enum class Axis : std::uint8_t {
  X = 0,
  Y = 1,
};

// CTL kind codes (Design §4.6). Values are the wire contract; see the byte
// layout table at the top of this header. Listed in ascending code order.
enum class ControlKind : std::uint8_t {
  PAUSE        = 0x01,
  RESUME       = 0x02,
  CANCEL       = 0x03,
  STOP         = 0x04,
  JOG          = 0x05,
  SET_HOME     = 0x06,
  RE_HOME      = 0x07,
  BEGIN_DRAW   = 0x08,
  END_DRAW     = 0x09,
  SPEED_PCT    = 0x0A,
  SET_BACKLASH = 0x0B,
  MOTOR_TEST   = 0x0C,
  FAULT_RESET  = 0x0D,
  CAPTURE_BOTTOM_LEFT = 0x0E,
  CAPTURE_TOP_RIGHT   = 0x0F,
};

// Bounds for the JOG step count. Req 10.3 specifies single full-step jogs
// (steps == 1 is the common case); a small upper bound is documented here so a
// malformed or hostile client cannot request an unbounded jog. A jog of zero
// steps is meaningless and is rejected as out-of-range.
inline constexpr std::uint16_t JOG_STEPS_MIN = 1;
inline constexpr std::uint16_t JOG_STEPS_MAX = 1000;

// Per-kind decoded payloads. All are trivial/POD so they may live in a union.
struct JogPayload {
  Axis          axis;   // X or Y
  std::int8_t   dir;    // +1 or -1
  std::uint16_t steps;  // [JOG_STEPS_MIN, JOG_STEPS_MAX]
};

struct SpeedPctPayload {
  std::uint8_t pct;  // [SPEED_PCT_MIN, SPEED_PCT_MAX]
};

struct SetBacklashPayload {
  std::uint16_t x;  // [BACKLASH_STEPS_MIN, BACKLASH_STEPS_MAX]
  std::uint16_t y;  // [BACKLASH_STEPS_MIN, BACKLASH_STEPS_MAX]
};

struct BeginDrawPayload {
  std::uint32_t total_segments;
  std::uint32_t total_steps;
};

// Tagged decoded control message. `kind` is always populated on a successful
// parse; the active union member (if any) is determined by `kind`:
//   JOG          -> jog
//   SPEED_PCT    -> speed_pct
//   SET_BACKLASH -> set_backlash
//   BEGIN_DRAW   -> begin_draw
//   all others   -> no payload (union is left unspecified)
struct ControlMessage {
  ControlKind kind;
  union {
    JogPayload         jog;
    SpeedPctPayload    speed_pct;
    SetBacklashPayload set_backlash;
    BeginDrawPayload   begin_draw;
  };
};

// Result of parseControl(). Ordering of checks (Design §4.6):
//   1. len >= 1                       else BadLength
//   2. kind code is known             else BadKind
//   3. per-kind payload length exact  else BadLength
//   4. per-kind value ranges valid    else BadRange
enum class CtlParseResult : std::uint8_t {
  Ok        = 0,
  BadKind   = 1,
  BadLength = 2,
  BadRange  = 3,
};

// True iff `kind` is one of the ControlKind codes defined above.
bool isKnownControlKind(std::uint8_t kind);

// Decode and validate a CTL payload of `len` bytes (the leading kind byte is
// included in `len`, so a parameterless kind has len == 1). On CtlParseResult::Ok
// `out.kind` and the corresponding union member are populated; on any failure
// the return code identifies the reason and `out` is left unspecified.
//
// Multi-byte fields are decoded little-endian. Validation matches the table at
// the top of this header: exact per-kind length, JOG axis in {0,1} and
// dir in {+1,-1} and steps in [1,1000], SPEED_PCT pct in [25,100], and
// SET_BACKLASH x/y in [0,200].
CtlParseResult parseControl(const std::uint8_t* payload, std::size_t len,
                            ControlMessage& out);

}  // namespace protocol
}  // namespace etch
