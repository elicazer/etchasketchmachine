// Control message (CTL) parser implementation. See control_parser.h for the
// full wire contract and validation order (Design §4.6).
//
// The decoder is byte-wise and endianness-agnostic on the host: every
// multi-byte field is assembled little-endian from individual bytes, matching
// the web-side encoder and the Drawing_Command / frame envelope conventions.

#include "control_parser.h"

namespace etch {
namespace protocol {

namespace {

// Little-endian field readers. Callers guarantee the bytes are in-bounds via
// the per-kind exact-length check before these are invoked.
inline std::uint16_t readU16LE(const std::uint8_t* p) {
  return static_cast<std::uint16_t>(p[0]) |
         static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[1]) << 8);
}

inline std::uint32_t readU32LE(const std::uint8_t* p) {
  return static_cast<std::uint32_t>(p[0]) |
         (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) |
         (static_cast<std::uint32_t>(p[3]) << 24);
}

// Exact total CTL payload length (including the 1-byte kind) for each kind.
constexpr std::size_t LEN_PARAMLESS   = 1;  // PAUSE/RESUME/CANCEL/STOP/...
constexpr std::size_t LEN_JOG         = 5;  // kind + u8 + i8 + u16
constexpr std::size_t LEN_SPEED_PCT   = 2;  // kind + u8
constexpr std::size_t LEN_SET_BACKLASH = 5; // kind + u16 + u16
constexpr std::size_t LEN_BEGIN_DRAW  = 9;  // kind + u32 + u32

}  // namespace

bool isKnownControlKind(std::uint8_t kind) {
  switch (static_cast<ControlKind>(kind)) {
    case ControlKind::PAUSE:
    case ControlKind::RESUME:
    case ControlKind::CANCEL:
    case ControlKind::STOP:
    case ControlKind::JOG:
    case ControlKind::SET_HOME:
    case ControlKind::RE_HOME:
    case ControlKind::BEGIN_DRAW:
    case ControlKind::END_DRAW:
    case ControlKind::SPEED_PCT:
    case ControlKind::SET_BACKLASH:
    case ControlKind::MOTOR_TEST:
    case ControlKind::FAULT_RESET:
    case ControlKind::CAPTURE_BOTTOM_LEFT:
    case ControlKind::CAPTURE_TOP_RIGHT:
      return true;
    default:
      return false;
  }
}

CtlParseResult parseControl(const std::uint8_t* payload, std::size_t len,
                            ControlMessage& out) {
  // 1. Need at least the kind byte.
  if (payload == nullptr || len < 1) {
    return CtlParseResult::BadLength;
  }

  // 2. The kind code must be known.
  const std::uint8_t kind_code = payload[0];
  if (!isKnownControlKind(kind_code)) {
    return CtlParseResult::BadKind;
  }
  const ControlKind kind = static_cast<ControlKind>(kind_code);

  switch (kind) {
    // --- Parameterless kinds: exactly the kind byte, no payload. ----------
    case ControlKind::PAUSE:
    case ControlKind::RESUME:
    case ControlKind::CANCEL:
    case ControlKind::STOP:
    case ControlKind::SET_HOME:
    case ControlKind::RE_HOME:
    case ControlKind::END_DRAW:
    case ControlKind::MOTOR_TEST:
    case ControlKind::FAULT_RESET:
    case ControlKind::CAPTURE_BOTTOM_LEFT:
    case ControlKind::CAPTURE_TOP_RIGHT: {
      if (len != LEN_PARAMLESS) {
        return CtlParseResult::BadLength;
      }
      out.kind = kind;
      return CtlParseResult::Ok;
    }

    // --- JOG { u8 axis, i8 dir, u16 steps } (Req 10.3) --------------------
    case ControlKind::JOG: {
      if (len != LEN_JOG) {
        return CtlParseResult::BadLength;
      }
      const std::uint8_t axis_raw = payload[1];
      const std::int8_t  dir      = static_cast<std::int8_t>(payload[2]);
      const std::uint16_t steps   = readU16LE(&payload[3]);

      // axis ∈ {0,1}; dir ∈ {+1,-1}; steps ∈ [JOG_STEPS_MIN, JOG_STEPS_MAX].
      if (axis_raw != static_cast<std::uint8_t>(Axis::X) &&
          axis_raw != static_cast<std::uint8_t>(Axis::Y)) {
        return CtlParseResult::BadRange;
      }
      if (dir != 1 && dir != -1) {
        return CtlParseResult::BadRange;
      }
      if (steps < JOG_STEPS_MIN || steps > JOG_STEPS_MAX) {
        return CtlParseResult::BadRange;
      }

      out.kind = kind;
      out.jog.axis = static_cast<Axis>(axis_raw);
      out.jog.dir = dir;
      out.jog.steps = steps;
      return CtlParseResult::Ok;
    }

    // --- BEGIN_DRAW { u32 total_segments, u32 total_steps } ---------------
    case ControlKind::BEGIN_DRAW: {
      if (len != LEN_BEGIN_DRAW) {
        return CtlParseResult::BadLength;
      }
      out.kind = kind;
      out.begin_draw.total_segments = readU32LE(&payload[1]);
      out.begin_draw.total_steps = readU32LE(&payload[5]);
      return CtlParseResult::Ok;
    }

    // --- SPEED_PCT { u8 pct }, pct ∈ [25,100] (Req 9.7) -------------------
    case ControlKind::SPEED_PCT: {
      if (len != LEN_SPEED_PCT) {
        return CtlParseResult::BadLength;
      }
      const std::uint8_t pct = payload[1];
      if (pct < SPEED_PCT_MIN || pct > SPEED_PCT_MAX) {
        return CtlParseResult::BadRange;
      }
      out.kind = kind;
      out.speed_pct.pct = pct;
      return CtlParseResult::Ok;
    }

    // --- SET_BACKLASH { u16 x, u16 y }, each ∈ [0,200] (Req 13.8) ---------
    case ControlKind::SET_BACKLASH: {
      if (len != LEN_SET_BACKLASH) {
        return CtlParseResult::BadLength;
      }
      const std::uint16_t x = readU16LE(&payload[1]);
      const std::uint16_t y = readU16LE(&payload[3]);
      // The lower bound BACKLASH_STEPS_MIN (0) is structurally satisfied by the
      // unsigned u16 fields, so only the upper bound needs an explicit check
      // (writing `x < BACKLASH_STEPS_MIN` would be a tautological compare).
      static_assert(BACKLASH_STEPS_MIN == 0,
                    "lower-bound check elided assuming BACKLASH_STEPS_MIN == 0");
      if (x > BACKLASH_STEPS_MAX || y > BACKLASH_STEPS_MAX) {
        return CtlParseResult::BadRange;
      }
      out.kind = kind;
      out.set_backlash.x = x;
      out.set_backlash.y = y;
      return CtlParseResult::Ok;
    }
  }

  // Unreachable: every known kind is handled above, and unknown kinds were
  // rejected as BadKind. Defensive default keeps the compiler happy.
  return CtlParseResult::BadKind;
}

}  // namespace protocol
}  // namespace etch
