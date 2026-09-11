// FrameCodec implementation. See frame_codec.h for the design notes, the
// single-client rule, and the host-test seam contract.
//
// This is a behaviour-preserving extraction of the framing / dispatch /
// single-client logic that previously lived in ws_server.cpp. It is fully
// platform-independent (Arduino-free) and is compiled on both the Arduino
// target and the `platform = native` host. It is exercised on the host through
// ingestForTest() (frame parsing) and handleNewConnection() / closeConnection()
// (single-client enforcement).

#include "frame_codec.h"

#include <cstring>

namespace etch {
namespace protocol {

// ---------------------------------------------------------------------------
// Dispatch handler
// ---------------------------------------------------------------------------

void FrameCodec::onFrame(FrameHandler handler) { handler_ = std::move(handler); }

// ---------------------------------------------------------------------------
// Single-client enforcement (platform-independent)
// ---------------------------------------------------------------------------

std::size_t FrameCodec::buildSessionBusyFrame(std::uint8_t* out, std::size_t cap) {
  // ERROR payload per §4.5: { u8 kind, u8 axis, u16 detail } (little-endian).
  const std::uint8_t payload[4] = {
      CODEC_ERROR_KIND_SESSION_BUSY,
      CODEC_ERROR_AXIS_NONE,
      static_cast<std::uint8_t>(CODEC_ERROR_DETAIL_NONE & 0xFF),
      static_cast<std::uint8_t>((CODEC_ERROR_DETAIL_NONE >> 8) & 0xFF),
  };
  return buildFrame(FrameType::ERROR, payload, sizeof(payload), out, cap);
}

bool FrameCodec::handleNewConnection(std::uint8_t* rejectOut, std::size_t rejectCap,
                                     std::size_t* rejectLen) {
  if (client_connected_) {
    // Reject the second client with a session-busy ERROR frame. The caller is
    // responsible for transmitting `rejectOut` to the rejected peer and then
    // closing that connection.
    const std::size_t n = buildSessionBusyFrame(rejectOut, rejectCap);
    if (rejectLen != nullptr) {
      *rejectLen = n;
    }
    return false;
  }

  // Adopt the new peer as the sole session and start with a clean parse buffer.
  client_connected_ = true;
  buf_len_ = 0;
  if (rejectLen != nullptr) {
    *rejectLen = 0;
  }
  return true;
}

void FrameCodec::closeConnection() {
  client_connected_ = false;
  buf_len_ = 0;
}

// ---------------------------------------------------------------------------
// Framing / dispatch (platform-independent)
// ---------------------------------------------------------------------------

void FrameCodec::feedBytes(const std::uint8_t* bytes, std::size_t n) {
  if (bytes == nullptr) {
    return;
  }
  for (std::size_t i = 0; i < n; ++i) {
    if (buf_len_ == sizeof(buf_)) {
      // Buffer full: try to make room by dispatching any complete frames.
      drainFrames();
      if (buf_len_ == sizeof(buf_)) {
        // Still full and no complete frame fits — the stream is desynced or a
        // single frame claims to be larger than the buffer. Drop the oldest
        // byte to resynchronise on the next valid version marker.
        std::memmove(buf_, buf_ + 1, buf_len_ - 1);
        --buf_len_;
      }
    }
    buf_[buf_len_++] = bytes[i];
  }
  drainFrames();
}

void FrameCodec::drainFrames() {
  std::size_t off = 0;

  while (buf_len_ - off >= FRAME_HEADER_SIZE) {
    const std::uint8_t* p = buf_ + off;

    // Resync on a bad version marker: drop one byte and keep scanning.
    if (p[0] != FRAME_VERSION) {
      ++off;
      continue;
    }

    const std::uint16_t length =
        static_cast<std::uint16_t>(p[2]) |
        static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[3]) << 8);
    const std::size_t total = FRAME_HEADER_SIZE + static_cast<std::size_t>(length);

    // A frame that can never fit the buffer is treated as desync.
    if (total > sizeof(buf_)) {
      ++off;
      continue;
    }

    // Incomplete frame: wait for more bytes.
    if ((buf_len_ - off) < total) {
      break;
    }

    // Complete, version-valid frame. Re-validate through decodeFrameHeader so
    // the parse goes through the single canonical decoder (Design §4.5), then
    // dispatch by type to the registered handler.
    FrameHeader hdr;
    if (decodeFrameHeader(p, buf_len_ - off, hdr) && handler_) {
      Frame frame{hdr.type, p + FRAME_HEADER_SIZE, hdr.length};
      handler_(frame);
    }

    off += total;
  }

  // Compact: shift any partial trailing frame to the front of the buffer.
  if (off > 0) {
    const std::size_t remaining = buf_len_ - off;
    if (remaining > 0) {
      std::memmove(buf_, buf_ + off, remaining);
    }
    buf_len_ = remaining;
  }
}

}  // namespace protocol
}  // namespace etch
