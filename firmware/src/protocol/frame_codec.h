// Shared framing / dispatch core — the transport-independent byte accumulator
// and single-client enforcement extracted from `WSServer` (Design §3.1, §3.3).
//
// This is the protocol-bearing half of the Controller's realtime channel that
// is reused verbatim by BOTH transports (WiFi `WSServer` and BLE `BleServer`).
// It owns:
//
//   * A parse buffer that accumulates raw bytes (from the WebSocket on-device,
//     from reassembled BLE chunks, or from ingestForTest() on the host) and
//     splits them into binary frames per the §4.5 envelope, dispatching each
//     complete frame to a registered handler by type code.
//   * Single-client enforcement: only one session is allowed at a time. A
//     second connection attempt is rejected with a `session-busy` ERROR frame
//     (Design §2.1).
//
// The behaviour here is a behaviour-preserving extraction of the framing logic
// that previously lived in `ws_server.{h,cpp}`: version-byte resync,
// oversize-frame desync, and the canonical `decodeFrameHeader` dispatch are
// carried over byte-for-byte so the existing host tests continue to pass.
//
// The header is Arduino-include-free: it pulls in nothing beyond the standard
// library and `frame.h`, so it compiles under `platform = native` for the
// Catch2 host tests.
//
// References:
//   - Requirement 13.4 (no wire-layout change; shared protocol core)
//   - Design §3.1 (FrameCodec interface), §3.3 (module layout)

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

#include "frame.h"

namespace etch {
namespace protocol {

// ---------------------------------------------------------------------------
// session-busy ERROR frame
// ---------------------------------------------------------------------------
//
// Design §4.5 defines the ERROR payload as { u8 kind, u8 axis, u16 detail } and
// enumerates kinds 0x01..0x05 (STALL, FAULT, UNRECOVERABLE_TX, CONN_TIMEOUT,
// HOME_REQUIRED). The single-client rule needs a "session-busy" rejection with
// the next free kind code:
//
//   0x06 SESSION_BUSY — a second client tried to connect while a session was
//                       already active; the connection was refused.
//
// The rejection is delivered as an ERROR frame: kind = 0x06, axis = 0 (not
// axis-specific), detail = 0 (reserved). The web client treats this as a
// terminal "another device is controlling the machine" condition.
inline constexpr std::uint8_t  CODEC_ERROR_KIND_SESSION_BUSY = 0x06;
inline constexpr std::uint8_t  CODEC_ERROR_AXIS_NONE         = 0x00;
inline constexpr std::uint16_t CODEC_ERROR_DETAIL_NONE       = 0x0000;

// Total size of a session-busy frame: 4-byte envelope + 4-byte ERROR payload.
inline constexpr std::size_t CODEC_SESSION_BUSY_FRAME_SIZE = FRAME_HEADER_SIZE + 4;

// ---------------------------------------------------------------------------
// Parse buffer
// ---------------------------------------------------------------------------

// Capacity of the inbound parse buffer. The only client->controller frames are
// CMD (16-byte payload => 20 bytes total, §4.3) and CTL (a one-byte kind plus a
// small payload, §4.6), so 256 bytes comfortably holds several queued frames
// while staying tiny in SRAM. A declared frame larger than this is treated as
// stream desync and resynchronised byte-by-byte.
inline constexpr std::size_t PARSE_BUFFER_CAPACITY = 256;

// ---------------------------------------------------------------------------
// FrameCodec
// ---------------------------------------------------------------------------

class FrameCodec {
 public:
  // Handler invoked once per fully-received frame. The Frame's `payload`
  // pointer is only valid for the duration of the call (it aliases the parse
  // buffer); handlers that need the bytes beyond the call must copy them.
  using FrameHandler = std::function<void(const Frame&)>;

  FrameCodec() = default;

  // Register the per-frame dispatch handler. Replaces any previous handler.
  void onFrame(FrameHandler handler);

  // Append `n` raw bytes to the parse buffer and dispatch every complete §4.5
  // frame to the registered handler, compacting any partial trailing frame to
  // the front. Identical algorithm to the original WSServer::feedBytes:
  // version-byte resync, oversize-frame desync, canonical decodeFrameHeader.
  void feedBytes(const std::uint8_t* bytes, std::size_t n);

  // ---- Single-client enforcement (platform-independent) -------------------

  // True iff a client currently owns the single session.
  bool isClientConnected() const { return client_connected_; }

  // Handle a freshly-arrived connection. If no client is connected, registers
  // the new peer as the sole client and returns true (the caller keeps the
  // connection open). If a client is already connected, returns false and
  // writes a session-busy ERROR frame into `rejectOut` (setting *rejectLen) so
  // the caller can transmit it to the rejected peer and close the connection.
  // When `rejectOut` is null or too small, *rejectLen is set to 0 but the call
  // still returns false (the peer is still rejected).
  bool handleNewConnection(std::uint8_t* rejectOut, std::size_t rejectCap,
                           std::size_t* rejectLen);

  // Mark the active session as closed and reset the parse buffer. Idempotent.
  void closeConnection();

  // Build the session-busy ERROR frame (§4.5, kind 0x06) into `out`. Returns
  // the number of bytes written (CODEC_SESSION_BUSY_FRAME_SIZE) on success, or
  // 0 if `out` is null or `cap` is too small. Pure/static: host-testable.
  static std::size_t buildSessionBusyFrame(std::uint8_t* out, std::size_t cap);

  // ---- Host test seam ------------------------------------------------------

  // Feed raw bytes into the parse buffer exactly as if they had arrived on the
  // transport, dispatching any complete frames to the registered handler. This
  // is the seam the host tests use to exercise frame dispatch without a radio;
  // on device the same internal path runs against real inbound bytes.
  void ingestForTest(const std::uint8_t* bytes, std::size_t n) { feedBytes(bytes, n); }

 private:
  // Parse and dispatch every complete frame currently buffered, then compact
  // the buffer so any partial trailing frame starts at offset 0.
  void drainFrames();

  FrameHandler handler_{};

  std::uint8_t buf_[PARSE_BUFFER_CAPACITY] = {0};
  std::size_t  buf_len_ = 0;

  bool client_connected_ = false;
};

}  // namespace protocol
}  // namespace etch
