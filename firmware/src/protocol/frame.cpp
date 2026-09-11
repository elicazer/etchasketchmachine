// WebSocket binary frame envelope implementation. See frame.h for the layout
// and validation contract (Design §4.5).
//
// The envelope length field is little-endian to match the web-side encoder
// (web/src/codec/frame.ts) and the Drawing_Command wire format (Design §4.3).
// All accessors are byte-wise so the code is endianness-agnostic on the host.

#include "frame.h"

namespace etch {
namespace protocol {

bool isKnownFrameType(std::uint8_t type) {
  switch (static_cast<FrameType>(type)) {
    case FrameType::CMD:
    case FrameType::CTL:
    case FrameType::ACK:
    case FrameType::NACK:
    case FrameType::RETX_REQUEST:
    case FrameType::STATUS:
    case FrameType::CREDIT:
    case FrameType::HELLO:
    case FrameType::STATE:
    case FrameType::ERROR:
    case FrameType::PROGRESS:
      return true;
    default:
      return false;
  }
}

bool encodeFrameHeader(std::uint8_t type, std::uint16_t len, std::uint8_t* out4) {
  if (out4 == nullptr) {
    return false;
  }
  out4[0] = FRAME_VERSION;
  out4[1] = type;
  out4[2] = static_cast<std::uint8_t>(len & 0xFF);         // little-endian low
  out4[3] = static_cast<std::uint8_t>((len >> 8) & 0xFF);  // little-endian high
  return true;
}

bool decodeFrameHeader(const std::uint8_t* in, std::size_t inLen, FrameHeader& out) {
  if (in == nullptr || inLen < FRAME_HEADER_SIZE) {
    return false;
  }
  if (in[0] != FRAME_VERSION) {
    return false;
  }
  const std::uint16_t length =
      static_cast<std::uint16_t>(in[2]) |
      static_cast<std::uint16_t>(static_cast<std::uint16_t>(in[3]) << 8);

  // Reject truncated frames: the declared payload must be fully present.
  if (inLen < FRAME_HEADER_SIZE + static_cast<std::size_t>(length)) {
    return false;
  }

  out.version = in[0];
  out.type = static_cast<FrameType>(in[1]);
  out.length = length;
  return true;
}

std::size_t buildFrame(FrameType type, const std::uint8_t* payload,
                       std::uint16_t payloadLen, std::uint8_t* out,
                       std::size_t outCap) {
  if (out == nullptr) {
    return 0;
  }
  if (payloadLen > 0 && payload == nullptr) {
    return 0;
  }
  const std::size_t total = FRAME_HEADER_SIZE + static_cast<std::size_t>(payloadLen);
  if (outCap < total) {
    return 0;
  }

  encodeFrameHeader(static_cast<std::uint8_t>(type), payloadLen, out);
  for (std::uint16_t i = 0; i < payloadLen; ++i) {
    out[FRAME_HEADER_SIZE + i] = payload[i];
  }
  return total;
}

}  // namespace protocol
}  // namespace etch
