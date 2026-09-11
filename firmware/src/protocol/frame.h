// WebSocket binary frame envelope (Design §4.5).
//
// Every frame exchanged between the browser SPA and the Controller is a
// fixed 4-byte little-endian envelope header followed by a typed payload:
//
//   Offset  Size  Field     Type   Notes
//   ------  ----  --------  -----  ----------------------------------------
//     0      1   version   u8     current = 0x01
//     1      1   type      u8     FrameType code (see below)
//     2      2   length    u16    little-endian, payload length in bytes
//     4    var   payload   bytes  per-type layout
//
// This translation unit is intentionally platform-independent: it pulls in
// nothing beyond <cstdint> / <cstddef> so the encode/decode/build helpers can
// be compiled and exhaustively tested on the host (Catch2) and reused verbatim
// inside the Arduino WebSocket server (ws_server.{h,cpp}).
//
// The canonical CRC over a Drawing_Command payload (Design §4.3) is independent
// of this envelope: the inner CRC-16 covers only the 16-byte command, so it
// survives any framing change. See firmware/src/protocol/crc16.{h,cpp}.
//
// References:
//   - Requirement 7.1 (WebSocket bidirectional messaging)
//   - Design §4.5 (frame format + type codes)

#pragma once

#include <cstddef>
#include <cstdint>

namespace etch {
namespace protocol {

// Envelope constants (Design §4.5).
inline constexpr std::uint8_t FRAME_VERSION     = 0x01;
inline constexpr std::size_t  FRAME_HEADER_SIZE = 4;

// Maximum payload length representable by the u16 length field. A frame can
// therefore never exceed FRAME_HEADER_SIZE + FRAME_MAX_PAYLOAD bytes total.
inline constexpr std::size_t FRAME_MAX_PAYLOAD = 0xFFFF;

// Frame type codes (Design §4.5). The numeric values are wire-stable and MUST
// match the web-side encoder in web/src/codec/frame.ts.
enum class FrameType : std::uint8_t {
  CMD          = 0x01,  // client -> ctrl   Drawing_Command (§4.3, 16 bytes)
  CTL          = 0x02,  // client -> ctrl   Control message (§4.6, variable)
  ACK          = 0x10,  // ctrl -> client   { u32 seq }
  NACK         = 0x11,  // ctrl -> client   { u32 seq, u8 reason }
  RETX_REQUEST = 0x12,  // ctrl -> client   { u32 seq }
  STATUS       = 0x20,  // ctrl -> client   §4.7 (16 bytes)
  CREDIT       = 0x21,  // ctrl -> client   { u8 n }
  HELLO        = 0x22,  // ctrl -> client   §4.8 (variable)
  STATE        = 0x30,  // ctrl -> client   { u8 state_code }
  ERROR        = 0x31,  // ctrl -> client   { u8 kind, u8 axis, u16 detail }
  PROGRESS     = 0x32,  // ctrl -> client   progress telemetry
};

// Decoded envelope header. `type` carries the raw type code even when it is not
// one of the codes above; use isKnownFrameType() to distinguish.
struct FrameHeader {
  std::uint8_t  version;
  FrameType     type;
  std::uint16_t length;
};

// A parsed, ready-to-dispatch frame. `payload` points into a parse buffer owned
// by the caller and is valid only for the duration of the dispatch callback.
// `len` is the payload length (matching the envelope's length field).
struct Frame {
  FrameType           type;
  const std::uint8_t* payload;
  std::uint16_t       len;
};

// True iff `type` is one of the FrameType codes defined above.
bool isKnownFrameType(std::uint8_t type);

// Write the 4-byte envelope header for a payload of `len` bytes into `out4`.
// Writes version (0x01), the raw type byte, and the little-endian length.
// Returns false (writing nothing) if `out4` is null; otherwise returns true.
bool encodeFrameHeader(std::uint8_t type, std::uint16_t len, std::uint8_t* out4);

// Decode and validate a 4-byte envelope header from the front of `in`.
// Validation:
//   * `in` must be non-null and `inLen >= FRAME_HEADER_SIZE`.
//   * version byte must equal FRAME_VERSION (0x01).
//   * the full frame must be present: `inLen >= FRAME_HEADER_SIZE + length`.
// On success populates `out` and returns true; on any failure returns false and
// leaves `out` unspecified. The decoded `type` is stored verbatim even if it is
// not a known code (callers gate on isKnownFrameType()).
bool decodeFrameHeader(const std::uint8_t* in, std::size_t inLen, FrameHeader& out);

// Serialise a complete frame (header + payload) of type `type` into `out`.
// Returns the total number of bytes written (FRAME_HEADER_SIZE + payloadLen) on
// success, or 0 on failure. Fails if:
//   * `out` is null or `outCap < FRAME_HEADER_SIZE + payloadLen`, or
//   * `payloadLen > 0` and `payload` is null.
// A zero-length payload with a null `payload` pointer is allowed.
std::size_t buildFrame(FrameType type, const std::uint8_t* payload,
                       std::uint16_t payloadLen, std::uint8_t* out,
                       std::size_t outCap);

}  // namespace protocol
}  // namespace etch
