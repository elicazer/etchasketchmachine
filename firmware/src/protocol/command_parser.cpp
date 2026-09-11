// Drawing_Command parser + validator implementation.
//
// See command_parser.h for the contract and validation order. The decode reads
// little-endian fields manually (load each byte and shift) so the parser is
// correct regardless of the target's native byte order and does not depend on
// the packed-struct layout of `etch::DrawingCommand`.

#include "command_parser.h"

#include "crc16.h"

namespace etch {
namespace protocol {

namespace {

// Read a little-endian unsigned 16-bit value from `p[0..2)`.
inline std::uint16_t loadU16LE(const std::uint8_t* p) {
  return static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[0]) |
                                    (static_cast<std::uint16_t>(p[1]) << 8));
}

// Read a little-endian unsigned 32-bit value from `p[0..4)`.
inline std::uint32_t loadU32LE(const std::uint8_t* p) {
  return static_cast<std::uint32_t>(p[0]) |
         (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) |
         (static_cast<std::uint32_t>(p[3]) << 24);
}

// Reinterpret a little-endian 16-bit pattern as a signed two's-complement
// value without relying on implementation-defined unsigned->signed conversion.
inline std::int16_t loadI16LE(const std::uint8_t* p) {
  const std::uint16_t raw = loadU16LE(p);
  // For raw <= 0x7FFF the value is already non-negative; otherwise subtract
  // 2^16 to land in [-32768, -1]. This is well-defined for every bit pattern.
  return (raw <= 0x7FFF)
             ? static_cast<std::int16_t>(raw)
             : static_cast<std::int16_t>(static_cast<std::int32_t>(raw) -
                                         0x10000);
}

}  // namespace

ParseResult parseDrawingCommand(const std::uint8_t* payload, std::size_t len,
                                DrawingCommand& out) {
  // 1. Structural check: a CMD payload is always exactly 16 bytes (Design §4.3).
  if (payload == nullptr || len != DRAWING_COMMAND_SIZE) {
    return ParseResult::NackParse;
  }

  // 2. Decode the little-endian fields (endian-independent).
  out.seq           = loadU32LE(payload + 0);
  out.dx_steps      = loadI16LE(payload + 4);
  out.dy_steps      = loadI16LE(payload + 6);
  out.feed_sps      = loadU16LE(payload + 8);
  out.flags         = loadU16LE(payload + 10);
  out.reserved      = loadU16LE(payload + 12);
  out.crc16_payload = loadU16LE(payload + 14);

  // 3. Integrity check: recompute CRC over bytes [0..14) and compare with the
  //    transmitted CRC at offset 14. A mismatch is a transport error, not a
  //    semantic one, so the firmware answers with RETX_REQUEST {seq} (Req 7.3).
  const std::uint16_t computed =
      crc16_ccitt(payload, DRAWING_COMMAND_CRC_RANGE);
  if (computed != out.crc16_payload) {
    return ParseResult::RetxCrc;
  }

  // 4. Range checks (only meaningful once the bytes are known-good). dx/dy are
  //    decoded as i16 and therefore inherently within [-32768, 32767]; the
  //    checks that can actually fail are feed_sps, undefined flag bits, and a
  //    non-zero reserved field (Req 6.7, Design §4.3).
  if (out.feed_sps < FEED_SPS_MIN || out.feed_sps > FEED_SPS_MAX) {
    return ParseResult::NackRange;
  }
  if ((out.flags & CMD_FLAG_RESERVED_MASK) != 0) {
    return ParseResult::NackRange;
  }
  if (out.reserved != 0) {
    return ParseResult::NackRange;
  }

  // 5. Fully valid and in range.
  return ParseResult::Ok;
}

}  // namespace protocol
}  // namespace etch
