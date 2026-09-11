// WebSocket server (`/ws`) — RFC6455 radio plumbing over a shared FrameCodec.
//
// This is the WiFi half of the Controller's realtime channel (Design §3.2.3).
// Following the §3.3 module layout, the transport-independent framing /
// dispatch / single-client logic now lives in `FrameCodec` (frame_codec.h);
// `WSServer` owns ONLY the RFC6455 / WiFiS3 socket plumbing and holds a
// `FrameCodec codec_` member that it feeds inbound bytes into and forwards the
// framing seam (`onFrame`/`isClientConnected`/single-client) to. The BLE
// transport (`BleServer`) reuses the very same `FrameCodec` core, so the wire
// behaviour is identical across transports (Design §2, Requirement 13.4).
//
// What this class still owns:
//
//   * The RFC6455 WebSocket upgrade/handshake, masking/unmasking, and
//     ping/pong on the ESP32-S3 (WiFiS3) co-processor — all behind
//     `#if defined(ARDUINO)` in the .cpp. Inbound unmasked application bytes
//     are routed into `codec_.feedBytes(...)`; outbound `sendBinary()` writes a
//     complete §4.5 frame as a single binary WebSocket frame.
//
// The public seam (`begin`/`serviceLoop`/`sendBinary`/`onFrame`/
// `isClientConnected`, plus the single-client helpers and host-test seam) is
// preserved byte-for-byte so the sketch and the existing host tests are
// unaffected by the extraction.
//
// The header is Arduino-include-free: all WiFiS3 / Arduino headers live behind
// `#if defined(ARDUINO)` guards in the .cpp, so this compiles under
// `platform = native` for the Catch2 host tests.
//
// References:
//   - Requirement 7.1 (WebSocket bidirectional messaging)
//   - Requirement 13.1, 13.2 (preserved transport seam; no wire change)
//   - Design §3.2.3 (WSServer surface), §3.3 (module layout), §4.5 (frame format)

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

#include "frame.h"
#include "frame_codec.h"

namespace etch {
namespace protocol {

// ---------------------------------------------------------------------------
// session-busy ERROR frame (compatibility aliases)
// ---------------------------------------------------------------------------
//
// The session-busy ERROR kind (§4.5, kind 0x06) and frame sizing now live with
// the shared `FrameCodec`. These aliases preserve the historical `WS_*` names
// for existing call sites (the sketch and host tests) so the seam is unchanged.
inline constexpr std::uint8_t  WS_ERROR_KIND_SESSION_BUSY = CODEC_ERROR_KIND_SESSION_BUSY;
inline constexpr std::uint8_t  WS_ERROR_AXIS_NONE         = CODEC_ERROR_AXIS_NONE;
inline constexpr std::uint16_t WS_ERROR_DETAIL_NONE       = CODEC_ERROR_DETAIL_NONE;

// Total size of a session-busy frame: 4-byte envelope + 4-byte ERROR payload.
inline constexpr std::size_t WS_SESSION_BUSY_FRAME_SIZE = CODEC_SESSION_BUSY_FRAME_SIZE;

// Capacity of the inbound parse buffer (owned by the shared FrameCodec). Kept
// as a `WS_*` alias for call sites that size buffers against it.
inline constexpr std::size_t WS_PARSE_BUFFER_CAPACITY = PARSE_BUFFER_CAPACITY;

// ---------------------------------------------------------------------------
// WSServer
// ---------------------------------------------------------------------------

class WSServer {
 public:
  // Handler invoked once per fully-received frame. The Frame's `payload`
  // pointer is only valid for the duration of the call (it aliases the parse
  // buffer); handlers that need the bytes beyond the call must copy them.
  using FrameHandler = FrameCodec::FrameHandler;

  WSServer() = default;

  // Initialise the server. On-device this starts the WebSocket listener on the
  // ESP32-S3 co-processor (see the ARDUINO seam in the .cpp; full handshake is
  // task 31.1). On the host this just resets internal state.
  void begin();

  // Cooperative tick called from the main loop. On-device this polls for new
  // connections (enforcing the single-client rule), drains inbound socket bytes
  // into the codec, and detects disconnects. On the host it is a no-op; tests
  // drive the parser directly through ingestForTest().
  void serviceLoop();

  // Transmit `len` raw bytes to the active client. Callers build a complete
  // §4.5 frame (e.g. via buildFrame()) and hand it here. No-op when no client
  // is connected.
  void sendBinary(const std::uint8_t* data, std::size_t len);

  // Register the per-frame dispatch handler. Replaces any previous handler.
  void onFrame(FrameHandler handler);

  // ---- Single-client enforcement (delegates to FrameCodec) ----------------

  // True iff a client currently owns the single session.
  bool isClientConnected() const { return codec_.isClientConnected(); }

  // Handle a freshly-arrived connection. If no client is connected, registers
  // the new peer as the sole client and returns true (the caller keeps the
  // socket open). If a client is already connected, returns false and writes a
  // session-busy ERROR frame into `rejectOut` (setting *rejectLen) so the
  // caller can transmit it to the rejected peer and close the socket. When
  // `rejectOut` is null or too small, *rejectLen is set to 0 but the call still
  // returns false (the peer is still rejected).
  bool handleNewConnection(std::uint8_t* rejectOut, std::size_t rejectCap,
                           std::size_t* rejectLen) {
    return codec_.handleNewConnection(rejectOut, rejectCap, rejectLen);
  }

  // Mark the active session as closed and reset the parse buffer. Idempotent.
  void closeConnection() { codec_.closeConnection(); }

  // Build the session-busy ERROR frame (§4.5, kind 0x06) into `out`. Returns
  // the number of bytes written (WS_SESSION_BUSY_FRAME_SIZE) on success, or 0
  // if `out` is null or `cap` is too small. Pure/static: host-testable.
  static std::size_t buildSessionBusyFrame(std::uint8_t* out, std::size_t cap) {
    return FrameCodec::buildSessionBusyFrame(out, cap);
  }

  // ---- Host test seam ------------------------------------------------------

  // Feed raw bytes into the parse buffer exactly as if they had arrived on the
  // socket, dispatching any complete frames to the registered handler. This is
  // the seam the host tests use to exercise frame dispatch without a socket; on
  // device the same internal path runs against real inbound bytes.
  void ingestForTest(const std::uint8_t* bytes, std::size_t n) {
    codec_.ingestForTest(bytes, n);
  }

#if !defined(ARDUINO)
  // Host-only inspection of bytes passed to sendBinary(), so tests can assert
  // on outgoing frames without a socket. Not compiled on-device.
  const std::uint8_t* sentBytesForTest() const { return sent_buf_; }
  std::size_t sentLenForTest() const { return sent_len_; }
  void clearSentForTest() { sent_len_ = 0; }
#endif

 private:
  // Shared framing / dispatch / single-client core (Design §3.1, §3.3). The
  // RFC6455 plumbing in the .cpp feeds inbound application bytes into this and
  // forwards the framing seam to it.
  FrameCodec codec_{};

#if !defined(ARDUINO)
  // Capture of the last sendBinary() payload (host tests only).
  std::uint8_t sent_buf_[PARSE_BUFFER_CAPACITY] = {0};
  std::size_t  sent_len_ = 0;
#endif
};

}  // namespace protocol
}  // namespace etch
