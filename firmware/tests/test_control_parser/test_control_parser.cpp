// Host-side unit tests for the Control message (CTL) parser (Task 4.4).
//
// Covers, per the task and Design §4.6:
//   * Every parameterless kind parses Ok with length 1.
//   * Unknown kind code -> BadKind.
//   * SPEED_PCT 25 and 100 -> Ok; 24 and 101 -> BadRange.
//   * SET_BACKLASH 0 and 200 -> Ok; 201 -> BadRange; bad axis n/a (no axis),
//     plus per-axis upper-bound enforcement on x and y independently.
//   * JOG dir +1/-1 and axis X/Y -> Ok; dir 0 or axis 2 -> BadRange;
//     steps 0 or > 1000 -> BadRange.
//   * Truncated / wrong-length payloads -> BadLength.
//   * Little-endian decoding of multi-byte fields (steps, backlash, BEGIN_DRAW).
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment in platformio.ini is configured with
// `test_build_src = no`, so this translation unit pulls the implementation in
// directly via relative include to keep the binary self-contained (matching the
// convention in test_crc16 / test_frame). No Arduino headers are involved.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "../../src/protocol/control_parser.h"
#include "../../src/protocol/control_parser.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::protocol::Axis;
using etch::protocol::ControlKind;
using etch::protocol::ControlMessage;
using etch::protocol::CtlParseResult;
using etch::protocol::isKnownControlKind;
using etch::protocol::JOG_STEPS_MAX;
using etch::protocol::parseControl;

namespace {

CtlParseResult parseBytes(const std::vector<std::uint8_t>& bytes,
                          ControlMessage& out) {
  return parseControl(bytes.data(), bytes.size(), out);
}

}  // namespace

// ---------------------------------------------------------------------------
// Parameterless kinds (PAUSE/RESUME/CANCEL/STOP/SET_HOME/RE_HOME/END_DRAW/
// MOTOR_TEST/FAULT_RESET/CAPTURE_BOTTOM_LEFT/CAPTURE_TOP_RIGHT): length 1 -> Ok.
// ---------------------------------------------------------------------------

TEST_CASE("parameterless kinds parse Ok with exactly one byte", "[ctl][ok]") {
  const ControlKind paramless[] = {
      ControlKind::PAUSE,      ControlKind::RESUME,    ControlKind::CANCEL,
      ControlKind::STOP,       ControlKind::SET_HOME,  ControlKind::RE_HOME,
      ControlKind::END_DRAW,   ControlKind::MOTOR_TEST, ControlKind::FAULT_RESET,
      ControlKind::CAPTURE_BOTTOM_LEFT, ControlKind::CAPTURE_TOP_RIGHT,
  };
  for (ControlKind k : paramless) {
    ControlMessage out{};
    const std::vector<std::uint8_t> bytes = {static_cast<std::uint8_t>(k)};
    REQUIRE(parseBytes(bytes, out) == CtlParseResult::Ok);
    REQUIRE(out.kind == k);
  }
}

TEST_CASE("parameterless kind with trailing bytes is BadLength", "[ctl][length]") {
  ControlMessage out{};
  // PAUSE with an extra stray byte: exact-length check must reject it.
  const std::vector<std::uint8_t> bytes = {
      static_cast<std::uint8_t>(ControlKind::PAUSE), 0x00};
  REQUIRE(parseBytes(bytes, out) == CtlParseResult::BadLength);
}

// ---------------------------------------------------------------------------
// Length / empty payload handling.
// ---------------------------------------------------------------------------

TEST_CASE("empty payload is BadLength", "[ctl][length]") {
  ControlMessage out{};
  REQUIRE(parseControl(nullptr, 0, out) == CtlParseResult::BadLength);
  const std::uint8_t dummy = 0x01;
  REQUIRE(parseControl(&dummy, 0, out) == CtlParseResult::BadLength);
}

// ---------------------------------------------------------------------------
// Unknown kind code -> BadKind.
// ---------------------------------------------------------------------------

TEST_CASE("unknown kind code is BadKind", "[ctl][kind]") {
  ControlMessage out{};
  // 0x00 is below the defined range; 0x10 is one past CAPTURE_TOP_RIGHT; 0xFF
  // is far out. All must be rejected as BadKind regardless of payload length.
  for (std::uint8_t code : {std::uint8_t{0x00}, std::uint8_t{0x10},
                            std::uint8_t{0x7F}, std::uint8_t{0xFF}}) {
    REQUIRE_FALSE(isKnownControlKind(code));
    const std::vector<std::uint8_t> bytes = {code};
    REQUIRE(parseBytes(bytes, out) == CtlParseResult::BadKind);
  }
}

TEST_CASE("isKnownControlKind accepts every defined code", "[ctl][kind]") {
  for (std::uint8_t code = 0x01; code <= 0x0F; ++code) {
    REQUIRE(isKnownControlKind(code));
  }
}

// ---------------------------------------------------------------------------
// SPEED_PCT { u8 pct } : 25 and 100 -> Ok; 24 and 101 -> BadRange.
// ---------------------------------------------------------------------------

TEST_CASE("SPEED_PCT accepts boundary values 25 and 100", "[ctl][speed][ok]") {
  for (std::uint8_t pct : {std::uint8_t{25}, std::uint8_t{100}}) {
    ControlMessage out{};
    const std::vector<std::uint8_t> bytes = {
        static_cast<std::uint8_t>(ControlKind::SPEED_PCT), pct};
    REQUIRE(parseBytes(bytes, out) == CtlParseResult::Ok);
    REQUIRE(out.kind == ControlKind::SPEED_PCT);
    REQUIRE(out.speed_pct.pct == pct);
  }
}

TEST_CASE("SPEED_PCT rejects out-of-range 24 and 101", "[ctl][speed][range]") {
  for (std::uint8_t pct : {std::uint8_t{0}, std::uint8_t{24}, std::uint8_t{101},
                           std::uint8_t{255}}) {
    ControlMessage out{};
    const std::vector<std::uint8_t> bytes = {
        static_cast<std::uint8_t>(ControlKind::SPEED_PCT), pct};
    REQUIRE(parseBytes(bytes, out) == CtlParseResult::BadRange);
  }
}

TEST_CASE("SPEED_PCT with wrong length is BadLength", "[ctl][speed][length]") {
  ControlMessage out{};
  // kind byte only (missing pct).
  const std::vector<std::uint8_t> short_bytes = {
      static_cast<std::uint8_t>(ControlKind::SPEED_PCT)};
  REQUIRE(parseBytes(short_bytes, out) == CtlParseResult::BadLength);
  // kind + pct + stray trailing byte.
  const std::vector<std::uint8_t> long_bytes = {
      static_cast<std::uint8_t>(ControlKind::SPEED_PCT), 50, 0x00};
  REQUIRE(parseBytes(long_bytes, out) == CtlParseResult::BadLength);
}

// ---------------------------------------------------------------------------
// SET_BACKLASH { u16 x, u16 y } : 0 and 200 -> Ok; 201 -> BadRange.
// ---------------------------------------------------------------------------

TEST_CASE("SET_BACKLASH accepts boundary values 0 and 200", "[ctl][backlash][ok]") {
  // x=0, y=200 little-endian.
  ControlMessage out{};
  const std::vector<std::uint8_t> bytes = {
      static_cast<std::uint8_t>(ControlKind::SET_BACKLASH),
      0x00, 0x00,   // x = 0
      0xC8, 0x00};  // y = 200
  REQUIRE(parseBytes(bytes, out) == CtlParseResult::Ok);
  REQUIRE(out.kind == ControlKind::SET_BACKLASH);
  REQUIRE(out.set_backlash.x == 0);
  REQUIRE(out.set_backlash.y == 200);
}

TEST_CASE("SET_BACKLASH rejects 201 on either axis", "[ctl][backlash][range]") {
  // x = 201 (0xC9), y = 0.
  ControlMessage out{};
  const std::vector<std::uint8_t> x_bad = {
      static_cast<std::uint8_t>(ControlKind::SET_BACKLASH),
      0xC9, 0x00,   // x = 201
      0x00, 0x00};  // y = 0
  REQUIRE(parseBytes(x_bad, out) == CtlParseResult::BadRange);

  // x = 0, y = 201.
  const std::vector<std::uint8_t> y_bad = {
      static_cast<std::uint8_t>(ControlKind::SET_BACKLASH),
      0x00, 0x00,   // x = 0
      0xC9, 0x00};  // y = 201
  REQUIRE(parseBytes(y_bad, out) == CtlParseResult::BadRange);

  // A large value (1000 = 0x03E8) confirms the high byte is honoured too.
  const std::vector<std::uint8_t> big = {
      static_cast<std::uint8_t>(ControlKind::SET_BACKLASH),
      0xE8, 0x03,   // x = 1000
      0x00, 0x00};
  REQUIRE(parseBytes(big, out) == CtlParseResult::BadRange);
}

TEST_CASE("SET_BACKLASH with wrong length is BadLength", "[ctl][backlash][length]") {
  ControlMessage out{};
  // Only 4 bytes total (one byte short of the 5-byte payload).
  const std::vector<std::uint8_t> short_bytes = {
      static_cast<std::uint8_t>(ControlKind::SET_BACKLASH), 0x00, 0x00, 0x00};
  REQUIRE(parseBytes(short_bytes, out) == CtlParseResult::BadLength);
}

// ---------------------------------------------------------------------------
// JOG { u8 axis, i8 dir, u16 steps } (Req 10.3).
// ---------------------------------------------------------------------------

TEST_CASE("JOG accepts axis X/Y with dir +1/-1", "[ctl][jog][ok]") {
  struct Case {
    std::uint8_t axis;
    std::int8_t dir;
    Axis expect_axis;
  };
  const Case cases[] = {
      {0, +1, Axis::X},
      {0, -1, Axis::X},
      {1, +1, Axis::Y},
      {1, -1, Axis::Y},
  };
  for (const Case& c : cases) {
    ControlMessage out{};
    const std::vector<std::uint8_t> bytes = {
        static_cast<std::uint8_t>(ControlKind::JOG),
        c.axis,
        static_cast<std::uint8_t>(c.dir),
        0x01, 0x00};  // steps = 1
    REQUIRE(parseBytes(bytes, out) == CtlParseResult::Ok);
    REQUIRE(out.kind == ControlKind::JOG);
    REQUIRE(out.jog.axis == c.expect_axis);
    REQUIRE(out.jog.dir == c.dir);
    REQUIRE(out.jog.steps == 1);
  }
}

TEST_CASE("JOG decodes steps little-endian up to the documented max",
          "[ctl][jog][ok]") {
  // steps = 1000 = 0x03E8 -> low 0xE8, high 0x03.
  ControlMessage out{};
  const std::vector<std::uint8_t> bytes = {
      static_cast<std::uint8_t>(ControlKind::JOG), 0x01 /*Y*/,
      static_cast<std::uint8_t>(-1), 0xE8, 0x03};
  REQUIRE(parseBytes(bytes, out) == CtlParseResult::Ok);
  REQUIRE(out.jog.steps == JOG_STEPS_MAX);
  REQUIRE(out.jog.steps == 1000);
}

TEST_CASE("JOG rejects dir 0 and other non +/-1 directions", "[ctl][jog][range]") {
  for (std::int8_t dir : {std::int8_t{0}, std::int8_t{2}, std::int8_t{-2},
                          std::int8_t{127}}) {
    ControlMessage out{};
    const std::vector<std::uint8_t> bytes = {
        static_cast<std::uint8_t>(ControlKind::JOG), 0x00,
        static_cast<std::uint8_t>(dir), 0x01, 0x00};
    REQUIRE(parseBytes(bytes, out) == CtlParseResult::BadRange);
  }
}

TEST_CASE("JOG rejects axis values other than 0 or 1", "[ctl][jog][range]") {
  for (std::uint8_t axis : {std::uint8_t{2}, std::uint8_t{3}, std::uint8_t{255}}) {
    ControlMessage out{};
    const std::vector<std::uint8_t> bytes = {
        static_cast<std::uint8_t>(ControlKind::JOG), axis, 0x01, 0x01, 0x00};
    REQUIRE(parseBytes(bytes, out) == CtlParseResult::BadRange);
  }
}

TEST_CASE("JOG rejects zero steps and steps above the max", "[ctl][jog][range]") {
  ControlMessage out{};
  // steps = 0.
  const std::vector<std::uint8_t> zero = {
      static_cast<std::uint8_t>(ControlKind::JOG), 0x00, 0x01, 0x00, 0x00};
  REQUIRE(parseBytes(zero, out) == CtlParseResult::BadRange);

  // steps = 1001 = 0x03E9 (one past max).
  const std::vector<std::uint8_t> over = {
      static_cast<std::uint8_t>(ControlKind::JOG), 0x00, 0x01, 0xE9, 0x03};
  REQUIRE(parseBytes(over, out) == CtlParseResult::BadRange);
}

TEST_CASE("JOG with wrong length is BadLength", "[ctl][jog][length]") {
  ControlMessage out{};
  // Truncated: kind + axis + dir only (missing the 2 steps bytes).
  const std::vector<std::uint8_t> truncated = {
      static_cast<std::uint8_t>(ControlKind::JOG), 0x00, 0x01};
  REQUIRE(parseBytes(truncated, out) == CtlParseResult::BadLength);

  // One byte too long.
  const std::vector<std::uint8_t> too_long = {
      static_cast<std::uint8_t>(ControlKind::JOG), 0x00, 0x01, 0x01, 0x00, 0xFF};
  REQUIRE(parseBytes(too_long, out) == CtlParseResult::BadLength);
}

// ---------------------------------------------------------------------------
// BEGIN_DRAW { u32 total_segments, u32 total_steps }.
// ---------------------------------------------------------------------------

TEST_CASE("BEGIN_DRAW decodes two little-endian u32 fields", "[ctl][begin][ok]") {
  // total_segments = 0x01020304, total_steps = 0x0A0B0C0D.
  ControlMessage out{};
  const std::vector<std::uint8_t> bytes = {
      static_cast<std::uint8_t>(ControlKind::BEGIN_DRAW),
      0x04, 0x03, 0x02, 0x01,   // total_segments
      0x0D, 0x0C, 0x0B, 0x0A};  // total_steps
  REQUIRE(parseBytes(bytes, out) == CtlParseResult::Ok);
  REQUIRE(out.kind == ControlKind::BEGIN_DRAW);
  REQUIRE(out.begin_draw.total_segments == 0x01020304u);
  REQUIRE(out.begin_draw.total_steps == 0x0A0B0C0Du);
}

TEST_CASE("BEGIN_DRAW with wrong length is BadLength", "[ctl][begin][length]") {
  ControlMessage out{};
  // 8 bytes total -- one short of the 9-byte payload.
  const std::vector<std::uint8_t> short_bytes = {
      static_cast<std::uint8_t>(ControlKind::BEGIN_DRAW),
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  REQUIRE(parseBytes(short_bytes, out) == CtlParseResult::BadLength);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
