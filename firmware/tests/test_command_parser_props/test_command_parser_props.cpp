// Host-side property tests for the Drawing_Command parser (Task 4.5).
//
// Property 8: Command parser rejects out-of-range fields without enqueuing
// (Design §7, §3.2.4, §4.3).
//
//   *For any* candidate Drawing_Command, the parser accepts the command if and
//   only if ALL of: feed_sps ∈ [100, 1000], |dx_steps| ≤ 32767,
//   |dy_steps| ≤ 32767, flags & ~0b11 == 0, reserved == 0, and the recomputed
//   CRC equals the transmitted CRC. Rejected commands never enter the motion
//   buffer; the parser emits NACK (range or parse error) or RETX_REQUEST (CRC
//   error) and continues processing the next command.
//
//   Validates: Requirements 6.7.
//
// The parser (`parseDrawingCommand`) is a pure, stateless function whose only
// channel for "this command is enqueueable" is ParseResult::Ok (see the
// documented wire mapping in command_parser.h: Ok -> ACK + enqueue,
// NackParse -> NACK{Parse}, NackRange -> NACK{Range}, RetxCrc -> RETX_REQUEST).
// To assert the *enqueue* invariant precisely, this test wires an inspectable
// fake motion buffer behind a small `dispatch()` helper that mirrors that
// documented mapping: it enqueues if and only if the parser returns Ok. Every
// property then asserts on both the wire outcome AND the resulting buffer
// occupancy, so "rejected commands never enter the motion buffer" is checked
// directly rather than inferred.
//
// dx/dy are decoded as i16 and are therefore in [-32768, 32767] by
// construction (they can never exceed the i16 range on the wire), so — exactly
// as the design notes — the range rules that can actually fail are feed_sps,
// undefined flag bits, and a non-zero reserved field. The properties below
// exercise each of those, a corrupted-CRC path, the accept path, and a single
// comprehensive biconditional over arbitrary 16-byte payloads.
//
// This translation unit lives in its own PlatformIO test directory
// (test_command_parser_props/) so it is compiled and linked into a standalone
// test binary, separate from test_command_parser/. It therefore supplies its
// own `int main` and pulls the parser + crc16 implementations in directly via
// relative includes — matching the convention in test_command_parser/ and
// test_crc16/ — so the host_test environment (test_build_src = no) stays
// self-contained with a single definition of the parser's symbols.
//
// The properties are exercised with rapidcheck via the standalone rc::check
// form invoked from inside Catch2 TEST_CASEs (mirroring test_nvm_props/).
// rc::check returns true on success; wrapping it in REQUIRE means a failing
// property (with rapidcheck's shrunk counterexample on stderr) surfaces as a
// Catch2 failure.
//
// Run with:
//
//     pio test -e host_test
//
// (PlatformIO pins Catch2 v3.5.3 and rapidcheck for the host_test env; see
// platformio.ini.)

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "../../src/types.h"
#include "../../src/protocol/command_parser.h"
#include "../../src/protocol/command_parser.cpp"  // NOLINT(bugprone-suspicious-include)
#include "../../src/protocol/crc16.cpp"            // NOLINT(bugprone-suspicious-include)

using etch::CMD_FLAG_RESERVED_MASK;
using etch::COMMAND_BUFFER_SIZE;
using etch::DrawingCommand;
using etch::DRAWING_COMMAND_CRC_RANGE;
using etch::DRAWING_COMMAND_SIZE;
using etch::FEED_SPS_MAX;
using etch::FEED_SPS_MIN;
using etch::protocol::crc16_ccitt;
using etch::protocol::parseDrawingCommand;
using etch::protocol::ParseResult;

namespace {

using Payload = std::array<std::uint8_t, DRAWING_COMMAND_SIZE>;

// ---------------------------------------------------------------------------
// Little-endian (de)serialisation helpers — independent of the parser's own
// internal helpers so the test is a true oracle, not a tautology.
// ---------------------------------------------------------------------------

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

std::uint16_t readU16LE(const std::uint8_t* p) {
  return static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[0]) |
                                    (static_cast<std::uint16_t>(p[1]) << 8));
}

// The field values a test wants on the wire (§4.3 layout). The trailing CRC is
// always sealed by buildPayload() so a freshly built frame is well-formed
// unless a test mutates a byte afterwards.
struct CommandFields {
  std::uint32_t seq      = 0;
  std::int16_t  dx       = 0;
  std::int16_t  dy       = 0;
  std::uint16_t feed_sps = FEED_SPS_MIN;
  std::uint16_t flags    = 0;
  std::uint16_t reserved = 0;
};

// Serialise `f` into a 16-byte payload and seal bytes [0..14) with a correct
// CRC-16/CCITT at offset 14.
Payload buildPayload(const CommandFields& f) {
  Payload buf{};
  writeU32LE(buf.data() + 0, f.seq);
  writeU16LE(buf.data() + 4, static_cast<std::uint16_t>(f.dx));
  writeU16LE(buf.data() + 6, static_cast<std::uint16_t>(f.dy));
  writeU16LE(buf.data() + 8, f.feed_sps);
  writeU16LE(buf.data() + 10, f.flags);
  writeU16LE(buf.data() + 12, f.reserved);
  const std::uint16_t crc = crc16_ccitt(buf.data(), DRAWING_COMMAND_CRC_RANGE);
  writeU16LE(buf.data() + 14, crc);
  return buf;
}

// ---------------------------------------------------------------------------
// Inspectable fake motion buffer + dispatcher.
// ---------------------------------------------------------------------------

// A minimal bounded FIFO standing in for the §6.4 SPSC motion ring buffer
// (the real one is built in Task 6.5). Push fails when full; the property
// tests here never approach capacity, so a full buffer is not exercised —
// the point is only to observe whether a parsed command was enqueued.
class FakeMotionBuffer {
 public:
  bool push(const DrawingCommand& c) {
    if (items_.size() >= COMMAND_BUFFER_SIZE) {
      return false;  // would be NACK{BufferFull}, handled by flow control.
    }
    items_.push_back(c);
    return true;
  }
  std::size_t size() const { return items_.size(); }

 private:
  std::vector<DrawingCommand> items_;
};

// The wire response the dispatch layer would emit for a parsed command. This
// mirrors the documented mapping in command_parser.h one-to-one.
enum class Wire { Ack, NackParse, NackRange, Retx };

// Parse one payload and act on the result exactly as the protocol dispatch
// layer is specified to: enqueue (and ACK) only on ParseResult::Ok; otherwise
// emit the corresponding NACK / RETX_REQUEST and leave the buffer untouched.
Wire dispatch(const std::uint8_t* payload, std::size_t len,
              FakeMotionBuffer& buf) {
  DrawingCommand out{};
  switch (parseDrawingCommand(payload, len, out)) {
    case ParseResult::Ok:
      buf.push(out);
      return Wire::Ack;
    case ParseResult::NackParse:
      return Wire::NackParse;
    case ParseResult::NackRange:
      return Wire::NackRange;
    case ParseResult::RetxCrc:
      return Wire::Retx;
  }
  return Wire::NackParse;  // unreachable; ParseResult is exhaustive.
}

// ---------------------------------------------------------------------------
// Independent oracle: classify a raw 16-byte payload exactly as the parser is
// specified to (validation order: structural -> CRC -> range). Length is fixed
// at 16 here, so the structural step always passes and NackParse never arises.
// ---------------------------------------------------------------------------
Wire oracle(const Payload& buf) {
  const std::uint16_t feed     = readU16LE(buf.data() + 8);
  const std::uint16_t flags    = readU16LE(buf.data() + 10);
  const std::uint16_t reserved = readU16LE(buf.data() + 12);
  const std::uint16_t crc_tx   = readU16LE(buf.data() + 14);
  const std::uint16_t crc_calc = crc16_ccitt(buf.data(), DRAWING_COMMAND_CRC_RANGE);

  // CRC is checked before range (Design §4.3 validation order).
  if (crc_calc != crc_tx) {
    return Wire::Retx;
  }
  const bool feed_ok     = (feed >= FEED_SPS_MIN && feed <= FEED_SPS_MAX);
  const bool flags_ok    = ((flags & CMD_FLAG_RESERVED_MASK) == 0);
  const bool reserved_ok = (reserved == 0);
  if (!feed_ok || !flags_ok || !reserved_ok) {
    return Wire::NackRange;
  }
  return Wire::Ack;
}

// ---------------------------------------------------------------------------
// rapidcheck generators (called from inside rc::check via operator*).
// ---------------------------------------------------------------------------

// A fully valid, CRC-sealed command: feed in [100,1000], only defined flag
// bits (0b00..0b11), reserved == 0, arbitrary seq/dx/dy.
Payload genValidPayload() {
  CommandFields f;
  f.seq      = *rc::gen::arbitrary<std::uint32_t>();
  f.dx       = *rc::gen::arbitrary<std::int16_t>();
  f.dy       = *rc::gen::arbitrary<std::int16_t>();
  f.feed_sps = static_cast<std::uint16_t>(
      *rc::gen::inRange<int>(FEED_SPS_MIN, FEED_SPS_MAX + 1));  // [100, 1000]
  f.flags    = static_cast<std::uint16_t>(*rc::gen::inRange<int>(0, 4));  // {0..3}
  f.reserved = 0;
  return buildPayload(f);
}

// A command identical to a valid one except feed_sps is pushed strictly out of
// [100, 1000] — either below (0..99) or above (1001..65535). CRC is recomputed
// over the mutated bytes so the ONLY violation is the range one.
Payload genBadFeedPayload() {
  CommandFields f;
  f.seq      = *rc::gen::arbitrary<std::uint32_t>();
  f.dx       = *rc::gen::arbitrary<std::int16_t>();
  f.dy       = *rc::gen::arbitrary<std::int16_t>();
  f.flags    = static_cast<std::uint16_t>(*rc::gen::inRange<int>(0, 4));
  f.reserved = 0;
  const bool below = *rc::gen::arbitrary<bool>();
  f.feed_sps = below
      ? static_cast<std::uint16_t>(*rc::gen::inRange<int>(0, FEED_SPS_MIN))  // 0..99
      : static_cast<std::uint16_t>(
            *rc::gen::inRange<int>(FEED_SPS_MAX + 1, 65536));  // 1001..65535
  return buildPayload(f);
}

// A command with at least one reserved (undefined) flag bit set. The reserved
// mask is bits 2..15, so OR in a randomly chosen bit in [2, 15]. CRC recomputed.
Payload genReservedFlagPayload() {
  CommandFields f;
  f.seq      = *rc::gen::arbitrary<std::uint32_t>();
  f.dx       = *rc::gen::arbitrary<std::int16_t>();
  f.dy       = *rc::gen::arbitrary<std::int16_t>();
  f.feed_sps = static_cast<std::uint16_t>(
      *rc::gen::inRange<int>(FEED_SPS_MIN, FEED_SPS_MAX + 1));
  f.reserved = 0;
  const int reserved_bit = *rc::gen::inRange<int>(2, 16);  // 2..15
  const std::uint16_t defined = static_cast<std::uint16_t>(
      *rc::gen::inRange<int>(0, 4));  // optionally also set defined bits
  f.flags = static_cast<std::uint16_t>(
      defined | (static_cast<std::uint16_t>(1u) << reserved_bit));
  return buildPayload(f);
}

// A command whose reserved field is non-zero (must be exactly 0). CRC recomputed.
Payload genNonZeroReservedPayload() {
  CommandFields f;
  f.seq      = *rc::gen::arbitrary<std::uint32_t>();
  f.dx       = *rc::gen::arbitrary<std::int16_t>();
  f.dy       = *rc::gen::arbitrary<std::int16_t>();
  f.feed_sps = static_cast<std::uint16_t>(
      *rc::gen::inRange<int>(FEED_SPS_MIN, FEED_SPS_MAX + 1));
  f.flags    = static_cast<std::uint16_t>(*rc::gen::inRange<int>(0, 4));
  f.reserved = static_cast<std::uint16_t>(*rc::gen::inRange<int>(1, 65536));  // 1..65535
  return buildPayload(f);
}

// A well-formed, in-range command whose CRC is then broken by flipping a single
// (non-zero mask) byte AFTER sealing. Any single-byte change — whether in the
// CRC-covered region [0,14) or in the transmitted CRC field [14,16) —
// guarantees crc_calc != crc_tx, so the parser must report RetxCrc.
Payload genCorruptedCrcPayload() {
  Payload buf = genValidPayload();
  const std::size_t offset = static_cast<std::size_t>(
      *rc::gen::inRange<int>(0, static_cast<int>(DRAWING_COMMAND_SIZE)));  // 0..15
  const std::uint8_t flip =
      static_cast<std::uint8_t>(*rc::gen::inRange<int>(1, 256));  // 1..255
  buf[offset] ^= flip;
  return buf;
}

// An arbitrary 16-byte payload: each byte independently uniform. Used for the
// comprehensive biconditional against the oracle.
Payload genArbitraryPayload() {
  Payload buf{};
  for (std::size_t i = 0; i < buf.size(); ++i) {
    buf[i] = *rc::gen::arbitrary<std::uint8_t>();
  }
  return buf;
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 8 (accept path): a well-formed, in-range, CRC-correct command is
// accepted (ACK) and enqueued exactly once.
// ---------------------------------------------------------------------------
TEST_CASE("Property 8: valid in-range command is accepted and enqueued",
          "[command_parser][property][property-8]") {
  REQUIRE(rc::check(
      "feed in [100,1000], defined flags, reserved 0, correct CRC -> ACK + enqueue",
      [] {
        const Payload buf = genValidPayload();

        FakeMotionBuffer mb;
        const Wire w = dispatch(buf.data(), buf.size(), mb);

        RC_ASSERT(w == Wire::Ack);
        RC_ASSERT(mb.size() == 1u);  // accepted commands ARE enqueued.
      }));
}

// ---------------------------------------------------------------------------
// Property 8 (reject: feed out of range): feed_sps outside [100,1000] yields
// NackRange and is NOT enqueued.
// ---------------------------------------------------------------------------
TEST_CASE("Property 8: out-of-range feed_sps is rejected without enqueuing",
          "[command_parser][property][property-8]") {
  REQUIRE(rc::check(
      "feed_sps in [0,99] U [1001,65535] (CRC resealed) -> NACK{Range}, no enqueue",
      [] {
        const Payload buf = genBadFeedPayload();
        // Sanity: the generated feed really is out of range.
        const std::uint16_t feed = readU16LE(buf.data() + 8);
        RC_ASSERT(feed < FEED_SPS_MIN || feed > FEED_SPS_MAX);

        FakeMotionBuffer mb;
        const Wire w = dispatch(buf.data(), buf.size(), mb);

        RC_ASSERT(w == Wire::NackRange);
        RC_ASSERT(mb.size() == 0u);  // rejected -> never enters the buffer.
      }));
}

// ---------------------------------------------------------------------------
// Property 8 (reject: undefined flag bit): any reserved flag bit set yields
// NackRange and is NOT enqueued.
// ---------------------------------------------------------------------------
TEST_CASE("Property 8: flags with a reserved bit set is rejected without enqueuing",
          "[command_parser][property][property-8]") {
  REQUIRE(rc::check(
      "flags & ~0b11 != 0 (CRC resealed) -> NACK{Range}, no enqueue", [] {
        const Payload buf = genReservedFlagPayload();
        const std::uint16_t flags = readU16LE(buf.data() + 10);
        RC_ASSERT((flags & CMD_FLAG_RESERVED_MASK) != 0);

        FakeMotionBuffer mb;
        const Wire w = dispatch(buf.data(), buf.size(), mb);

        RC_ASSERT(w == Wire::NackRange);
        RC_ASSERT(mb.size() == 0u);
      }));
}

// ---------------------------------------------------------------------------
// Property 8 (reject: non-zero reserved): reserved != 0 yields NackRange and is
// NOT enqueued.
// ---------------------------------------------------------------------------
TEST_CASE("Property 8: non-zero reserved field is rejected without enqueuing",
          "[command_parser][property][property-8]") {
  REQUIRE(rc::check(
      "reserved != 0 (CRC resealed) -> NACK{Range}, no enqueue", [] {
        const Payload buf = genNonZeroReservedPayload();
        RC_ASSERT(readU16LE(buf.data() + 12) != 0);

        FakeMotionBuffer mb;
        const Wire w = dispatch(buf.data(), buf.size(), mb);

        RC_ASSERT(w == Wire::NackRange);
        RC_ASSERT(mb.size() == 0u);
      }));
}

// ---------------------------------------------------------------------------
// Property 8 (reject: CRC error): a corrupted byte breaks the CRC, yielding
// RetxCrc (RETX_REQUEST path) and is NOT enqueued.
// ---------------------------------------------------------------------------
TEST_CASE("Property 8: corrupted CRC is rejected (RETX) without enqueuing",
          "[command_parser][property][property-8]") {
  REQUIRE(rc::check(
      "single-byte flip after sealing -> RETX_REQUEST, no enqueue", [] {
        const Payload buf = genCorruptedCrcPayload();
        const std::uint16_t crc_tx = readU16LE(buf.data() + 14);
        const std::uint16_t crc_calc =
            crc16_ccitt(buf.data(), DRAWING_COMMAND_CRC_RANGE);
        RC_ASSERT(crc_tx != crc_calc);  // the flip really broke integrity.

        FakeMotionBuffer mb;
        const Wire w = dispatch(buf.data(), buf.size(), mb);

        RC_ASSERT(w == Wire::Retx);
        RC_ASSERT(mb.size() == 0u);
      }));
}

// ---------------------------------------------------------------------------
// Property 8 ("continues processing the next command"): a rejected command does
// not poison the stream — a subsequent valid command is still enqueued, and the
// rejected one is not.
// ---------------------------------------------------------------------------
TEST_CASE("Property 8: a rejected command does not block the next valid command",
          "[command_parser][property][property-8]") {
  REQUIRE(rc::check(
      "reject(bad) then dispatch(valid) -> exactly one enqueue (the valid one)",
      [] {
        // Pick any one of the rejection flavours for the first command.
        const int kind = *rc::gen::inRange<int>(0, 4);
        Payload bad;
        switch (kind) {
          case 0: bad = genBadFeedPayload(); break;
          case 1: bad = genReservedFlagPayload(); break;
          case 2: bad = genNonZeroReservedPayload(); break;
          default: bad = genCorruptedCrcPayload(); break;
        }
        const Payload good = genValidPayload();

        FakeMotionBuffer mb;
        const Wire w_bad = dispatch(bad.data(), bad.size(), mb);
        RC_ASSERT(w_bad != Wire::Ack);
        RC_ASSERT(mb.size() == 0u);  // rejected one not enqueued...

        const Wire w_good = dispatch(good.data(), good.size(), mb);
        RC_ASSERT(w_good == Wire::Ack);
        RC_ASSERT(mb.size() == 1u);  // ...and the parser kept going.
      }));
}

// ---------------------------------------------------------------------------
// Property 8 (biconditional): for ANY 16-byte payload, the dispatcher enqueues
// the command IF AND ONLY IF every field is in range AND the CRC matches; the
// emitted wire response equals the oracle's classification (CRC checked before
// range), and the buffer gains exactly one entry on accept and none on reject.
// ---------------------------------------------------------------------------
TEST_CASE("Property 8: accept iff in-range and CRC-valid (arbitrary payload)",
          "[command_parser][property][property-8]") {
  REQUIRE(rc::check(
      "dispatch(payload) matches the independent oracle; enqueue iff accepted",
      [] {
        const Payload buf = genArbitraryPayload();

        FakeMotionBuffer mb;
        const Wire actual = dispatch(buf.data(), buf.size(), mb);
        const Wire expected = oracle(buf);

        RC_ASSERT(actual == expected);
        // Enqueue happens exactly on (and only on) acceptance.
        RC_ASSERT(mb.size() == (actual == Wire::Ack ? 1u : 0u));
      }));
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
