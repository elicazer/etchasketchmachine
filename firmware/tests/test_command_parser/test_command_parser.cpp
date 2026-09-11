// Host-side unit tests for the Drawing_Command parser (Task 4.1).
//
// Covers, per the task and Design §3.2.4 / §4.3 / Req 6.7, 7.3:
//   * A valid command round-trips to ParseResult::Ok with the exact field
//     values recovered from the wire bytes.
//   * Wrong payload length (too short / too long / zero) => NackParse.
//   * A corrupted CRC byte => RetxCrc (transport error => RETX_REQUEST).
//   * feed_sps = 99 and feed_sps = 1001 => NackRange (just outside [100, 1000]).
//   * A reserved flag bit set => NackRange.
//   * reserved != 0 => NackRange.
//   * Boundary feed_sps = 100 and feed_sps = 1000 => Ok.
//   * i16 boundaries dx = -32768 / dy = 32767 => Ok.
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment uses `test_build_src = no`, so this translation
// unit pulls the implementations in directly via relative include — both the
// parser AND its crc16 dependency — to keep the binary self-contained (matching
// the convention in test_crc16 / test_frame). No Arduino headers are involved;
// the parser is platform-independent.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstdint>

#include "../../src/protocol/command_parser.h"
#include "../../src/protocol/command_parser.cpp"  // NOLINT(bugprone-suspicious-include)
#include "../../src/protocol/crc16.cpp"            // NOLINT(bugprone-suspicious-include)

using etch::CMD_FLAG_CONNECTOR;
using etch::CMD_FLAG_LAST_OF_BATCH;
using etch::DrawingCommand;
using etch::DRAWING_COMMAND_CRC_RANGE;
using etch::DRAWING_COMMAND_SIZE;
using etch::FEED_SPS_MAX;
using etch::FEED_SPS_MIN;
using etch::protocol::crc16_ccitt;
using etch::protocol::parseDrawingCommand;
using etch::protocol::ParseResult;

namespace {

// Fields a test wants to place on the wire. Mirrors the §4.3 layout; the helper
// below serialises these into the 16-byte little-endian payload and seals the
// trailing CRC so a "valid" frame is the default.
struct CommandFields {
  std::uint32_t seq      = 0;
  std::int16_t  dx       = 0;
  std::int16_t  dy       = 0;
  std::uint16_t feed_sps = FEED_SPS_MIN;
  std::uint16_t flags    = 0;
  std::uint16_t reserved = 0;
};

void writeU16LE(std::uint8_t* p, std::uint16_t v) {
  p[0] = static_cast<std::uint8_t>(v & 0xFF);
  p[1] = static_cast<std::uint8_t>((v >> 8) & 0xFF);
}

void writeU32LE(std::uint8_t* p, std::uint32_t v) {
  p[0] = static_cast<std::uint8_t>(v & 0xFF);
  p[1] = static_cast<std::uint8_t>((v >> 8) & 0xFF);
  p[2] = static_cast<std::uint8_t>((v >> 16) & 0xFF);
  p[3] = static_cast<std::uint8_t>((v >> 24) & 0xFF);
}

// Serialise `f` into the 16-byte `out` buffer and seal bytes [0..14) with a
// correct CRC-16/CCITT at offset 14. The result is a well-formed, CRC-valid
// frame unless a test mutates it afterwards.
void buildCommand(const CommandFields& f, std::uint8_t out[DRAWING_COMMAND_SIZE]) {
  writeU32LE(out + 0, f.seq);
  writeU16LE(out + 4, static_cast<std::uint16_t>(f.dx));
  writeU16LE(out + 6, static_cast<std::uint16_t>(f.dy));
  writeU16LE(out + 8, f.feed_sps);
  writeU16LE(out + 10, f.flags);
  writeU16LE(out + 12, f.reserved);
  const std::uint16_t crc = crc16_ccitt(out, DRAWING_COMMAND_CRC_RANGE);
  writeU16LE(out + 14, crc);
}

}  // namespace

// ---------------------------------------------------------------------------
// Valid command round-trip (Design §4.3)
// ---------------------------------------------------------------------------

TEST_CASE("parseDrawingCommand accepts a valid command and recovers fields",
          "[command_parser][ok]") {
  CommandFields f;
  f.seq = 0x01020304u;
  f.dx = -1234;
  f.dy = 5678;
  f.feed_sps = 500;
  f.flags = CMD_FLAG_CONNECTOR | CMD_FLAG_LAST_OF_BATCH;
  f.reserved = 0;

  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::Ok);
  REQUIRE(out.seq == 0x01020304u);
  REQUIRE(out.dx_steps == -1234);
  REQUIRE(out.dy_steps == 5678);
  REQUIRE(out.feed_sps == 500);
  REQUIRE(out.flags == (CMD_FLAG_CONNECTOR | CMD_FLAG_LAST_OF_BATCH));
  REQUIRE(out.reserved == 0);
}

TEST_CASE("parseDrawingCommand accepts a command with no flags set",
          "[command_parser][ok]") {
  CommandFields f;
  f.feed_sps = 250;
  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::Ok);
  REQUIRE(out.flags == 0);
}

// ---------------------------------------------------------------------------
// Structural / length errors => NackParse
// ---------------------------------------------------------------------------

TEST_CASE("parseDrawingCommand rejects a payload that is too short",
          "[command_parser][parse]") {
  CommandFields f;
  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, DRAWING_COMMAND_SIZE - 1, out) ==
          ParseResult::NackParse);
}

TEST_CASE("parseDrawingCommand rejects a payload that is too long",
          "[command_parser][parse]") {
  std::uint8_t buf[DRAWING_COMMAND_SIZE + 1] = {0};
  CommandFields f;
  buildCommand(f, buf);  // seals the first 16 bytes

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::NackParse);
}

TEST_CASE("parseDrawingCommand rejects a zero-length / null payload",
          "[command_parser][parse]") {
  std::uint8_t buf[DRAWING_COMMAND_SIZE] = {0};
  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, 0, out) == ParseResult::NackParse);
  REQUIRE(parseDrawingCommand(nullptr, DRAWING_COMMAND_SIZE, out) ==
          ParseResult::NackParse);
}

// ---------------------------------------------------------------------------
// CRC mismatch => RetxCrc
// ---------------------------------------------------------------------------

TEST_CASE("parseDrawingCommand reports RetxCrc when a payload byte is corrupted",
          "[command_parser][crc]") {
  CommandFields f;
  f.seq = 42;
  f.feed_sps = 600;
  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  // Flip a bit in a CRC-covered byte without updating the trailing CRC.
  buf[5] ^= 0x01;

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::RetxCrc);
  // seq is still decoded so the caller can address RETX_REQUEST {seq}.
  REQUIRE(out.seq == 42);
}

TEST_CASE("parseDrawingCommand reports RetxCrc when the CRC field itself is wrong",
          "[command_parser][crc]") {
  CommandFields f;
  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  buf[14] ^= 0xFF;  // corrupt only the transmitted CRC

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::RetxCrc);
}

// ---------------------------------------------------------------------------
// Range errors => NackRange (only after CRC passes)
// ---------------------------------------------------------------------------

TEST_CASE("parseDrawingCommand rejects feed_sps just below the minimum",
          "[command_parser][range]") {
  CommandFields f;
  f.feed_sps = FEED_SPS_MIN - 1;  // 99
  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::NackRange);
}

TEST_CASE("parseDrawingCommand rejects feed_sps just above the maximum",
          "[command_parser][range]") {
  CommandFields f;
  f.feed_sps = FEED_SPS_MAX + 1;  // 1001
  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::NackRange);
}

TEST_CASE("parseDrawingCommand rejects flags with a reserved bit set",
          "[command_parser][range]") {
  CommandFields f;
  f.feed_sps = 300;
  f.flags = CMD_FLAG_CONNECTOR | 0x0004;  // 0x0004 is outside the defined mask
  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::NackRange);
}

TEST_CASE("parseDrawingCommand rejects a non-zero reserved field",
          "[command_parser][range]") {
  CommandFields f;
  f.feed_sps = 300;
  f.reserved = 1;
  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::NackRange);
}

// ---------------------------------------------------------------------------
// Boundary acceptance
// ---------------------------------------------------------------------------

TEST_CASE("parseDrawingCommand accepts feed_sps at both range boundaries",
          "[command_parser][ok][boundary]") {
  for (std::uint16_t sps : {FEED_SPS_MIN, FEED_SPS_MAX}) {
    CommandFields f;
    f.feed_sps = sps;
    std::uint8_t buf[DRAWING_COMMAND_SIZE];
    buildCommand(f, buf);

    DrawingCommand out{};
    REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::Ok);
    REQUIRE(out.feed_sps == sps);
  }
}

TEST_CASE("parseDrawingCommand accepts i16 delta boundaries dx=-32768 dy=32767",
          "[command_parser][ok][boundary]") {
  CommandFields f;
  f.dx = static_cast<std::int16_t>(-32768);
  f.dy = static_cast<std::int16_t>(32767);
  f.feed_sps = 400;
  std::uint8_t buf[DRAWING_COMMAND_SIZE];
  buildCommand(f, buf);

  DrawingCommand out{};
  REQUIRE(parseDrawingCommand(buf, sizeof(buf), out) == ParseResult::Ok);
  REQUIRE(out.dx_steps == static_cast<std::int16_t>(-32768));
  REQUIRE(out.dy_steps == static_cast<std::int16_t>(32767));
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
