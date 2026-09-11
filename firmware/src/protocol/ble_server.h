// BLE GATT server — the Bluetooth Low Energy half of the Controller's realtime
// channel, mirroring the `WSServer` seam exactly so the sketch is transport-
// agnostic (Design §3.2, §3.3).
//
// Following the §3.3 module layout, the transport-independent framing /
// dispatch / single-client logic lives in the shared `FrameCodec`
// (frame_codec.h) — the very same core the WiFi `WSServer` uses — so the wire
// behaviour is byte-for-byte identical across transports (Design §2,
// Requirement 13.4). `BleServer` owns ONLY the ArduinoBLE GATT plumbing plus
// the MTU chunking/reassembly glue:
//
//   * A single bidirectional GATT pipe (Design §3.3): one RX characteristic
//     (Write / WriteWithoutResponse) carries browser→controller frames, one TX
//     characteristic (Notify) carries controller→browser frames. The framed
//     byte stream is the SAME stream `FrameCodec` already parses, so the frame
//     router is reused verbatim.
//   * Inbound MTU reassembly via a `Reassembler rx_` (ble_chunk.h): each RX
//     write is a chunk; when a complete §4.5 `Frame_Envelope` reassembles, the
//     exact bytes are fed into `codec_.feedBytes(...)`. (Wired in task 3.2.)
//   * Outbound MTU chunking via `fragment(...)`: `sendBinary()` slices a
//     complete frame into notification-sized chunks on the TX characteristic.
//     (Wired in task 3.2.)
//   * Single-session / advertising / RSSI readback live in `serviceLoop()`
//     (wired in task 3.3) and forward single-client state to `codec_`.
//
// The public seam (`begin`/`serviceLoop`/`sendBinary`/`onFrame`/
// `isClientConnected`, plus the single-client helpers, the host-test seam, and
// the BLE-specific `lastRssiDbm()`) mirrors `WSServer` so `transport_config.h`
// can typedef either server as `app::Transport` and the sketch is unchanged
// (Design §3.7).
//
// The header is Arduino-include-free: all `ArduinoBLE` headers and objects live
// behind `#if defined(ARDUINO)` guards in the .cpp, so this compiles under
// `platform = native` for the Catch2 host tests (the chunking core and
// `FrameCodec` are exercised on the host).
//
// References:
//   - Requirement 2.1, 2.2 (advertising: service UUID + name `EtchASketch`)
//   - Requirement 3.1 (browser connects and discovers the service)
//   - Requirement 5.1 (frames carried over the GATT pipe via chunking)
//   - Requirement 9.4 (RSSI sourced controller-side for STATUS)
//   - Requirement 13.4 (shared protocol core; no wire-layout change)
//   - Design §3.2 (BleServer surface), §3.3 (GATT), §4.5 (UUIDs)

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

#include "ble_chunk.h"
#include "frame.h"
#include "frame_codec.h"

namespace etch {
namespace protocol {

// ---------------------------------------------------------------------------
// GATT UUIDs and advertised name (Design §3.3, §4.5)
// ---------------------------------------------------------------------------
//
// Fixed, randomly-generated 128-bit UUIDs for the Etch-a-Sketch wire service.
// A single bidirectional pipe (one RX, one TX) carries the existing framed byte
// stream, so the on-device frame router and the browser `WireClient` dispatcher
// work unchanged (Design §3.3). These MUST stay in sync with the browser side
// (web/src/net/ble_socket.ts / config.ts).
inline constexpr char ESK_BLE_SERVICE_UUID[] = "6b1d0001-5f8e-4b3a-9c2d-1e7a4f8b2c10";
inline constexpr char ESK_BLE_RX_CHAR_UUID[] = "6b1d0002-5f8e-4b3a-9c2d-1e7a4f8b2c10";
inline constexpr char ESK_BLE_TX_CHAR_UUID[] = "6b1d0003-5f8e-4b3a-9c2d-1e7a4f8b2c10";

// Human-readable advertised device name (Req 2.2). Listed alongside the 128-bit
// service UUID in the advertisement so a Web Bluetooth
// `requestDevice({filters:[{services:[SERVICE_UUID]}]})` lists it (Req 2.1, 2.3).
inline constexpr char ESK_BLE_DEVICE_NAME[] = "EtchASketch";

// Largest TX-characteristic attribute value the server will declare. A BLE
// attribute value tops out at 512 bytes; the usable notification body is
// `negotiatedMtu - 3 (ATT) - 1 (chunk hdr)`. The characteristic is sized to the
// attribute ceiling so any negotiated MTU fits a single chunk.
inline constexpr std::size_t ESK_BLE_CHAR_VALUE_SIZE = 512;

// Body bytes placed in each outbound TX chunk (Design §3.6, Req 8.4).
//
// MTU-sizing rationale. ArduinoBLE does not expose the per-connection
// negotiated ATT MTU to the application, so we cannot reliably grow the body to
// match a larger negotiated MTU on-device. We therefore fragment to the safe
// floor: the BLE default ATT MTU is 23 bytes (20 usable after the 3-byte ATT
// header); reserving 1 byte for the chunk micro-header (§4.3) leaves 19 body
// bytes that EVERY central is guaranteed to accept regardless of the negotiated
// MTU. This matches the browser side exactly (web `DEFAULT_MTU_PAYLOAD = 19`),
// keeping both directions chunked identically. If a future ArduinoBLE exposes
// the negotiated MTU, this can grow up to BLE_CHUNK_MAX_BODY for fewer chunks
// per frame without any wire-format change (the reassembler is body-size
// agnostic).
inline constexpr std::size_t ESK_BLE_TX_BODY_SIZE = 19;

// Transmit-error ERROR kind (Design §4.5). The §4.5 ERROR payload is
// { u8 kind, u8 axis, u16 detail } and kind 0x03 = UNRECOVERABLE_TX. An
// unrecoverable inbound reassembly failure (Req 5.5) is surfaced to the SPA as
// an ERROR{kind:UNRECOVERABLE_TX} so it retransmits the frame, reusing the same
// kind the WiFi build emits when retransmission is exhausted.
inline constexpr std::uint8_t ESK_BLE_ERROR_KIND_UNRECOVERABLE_TX = 0x03;

// Total size of a transmit-error frame: 4-byte envelope + 4-byte ERROR payload.
inline constexpr std::size_t ESK_BLE_TX_ERROR_FRAME_SIZE = FRAME_HEADER_SIZE + 4;

// RSSI sentinel returned by lastRssiDbm() when no link RSSI has been sampled
// (e.g. no client connected). Chosen to be an implausible real dBm reading.
inline constexpr int ESK_BLE_RSSI_UNKNOWN = 127;

// ---------------------------------------------------------------------------
// BleServer
// ---------------------------------------------------------------------------

class BleServer {
 public:
  // Handler invoked once per fully-received frame. The Frame's `payload`
  // pointer is only valid for the duration of the call (it aliases the parse
  // buffer); handlers that need the bytes beyond the call must copy them.
  using FrameHandler = FrameCodec::FrameHandler;

  BleServer() = default;

  // Initialise the server. On-device this starts the ArduinoBLE stack, builds
  // the GATT service + RX/TX characteristics, sets the advertised name/UUID,
  // and begins advertising (see the ARDUINO seam in the .cpp; full GATT wiring
  // is tasks 3.2/3.3). On the host this just resets internal state.
  void begin();

  // Cooperative tick called from the main loop. On-device this polls the BLE
  // stack (`BLE.poll()`), adopts/releases the single central session, manages
  // advertising across connect/disconnect (stop on connect per Req 2.4, resume
  // within 5 s on disconnect per Req 2.5), rejects a concurrent central while a
  // session is active (Req 3.5, 3.7), and snapshots the link RSSI for
  // lastRssiDbm() (Req 9.4). The inbound RX-drain into the reassembler is
  // event-driven via the RX write handler (task 3.2). On the host it is a
  // no-op; tests drive the parser directly through ingestForTest().
  void serviceLoop();

  // Transmit `len` raw bytes to the active client. Callers build a complete
  // §4.5 frame (e.g. via buildFrame()) and hand it here; on-device it is
  // fragmented into MTU-sized chunks and notified on the TX characteristic
  // (wired in task 3.2). No-op when no client is connected.
  void sendBinary(const std::uint8_t* data, std::size_t len);

  // Register the per-frame dispatch handler. Forwards to the shared codec so
  // the SAME handler the WiFi build uses dispatches BLE-delivered frames.
  void onFrame(FrameHandler handler) { codec_.onFrame(std::move(handler)); }

  // ---- Single-client enforcement (delegates to FrameCodec) ----------------

  // True iff a client currently owns the single session.
  bool isClientConnected() const { return codec_.isClientConnected(); }

  // Handle a freshly-arrived connection. If no client is connected, registers
  // the new peer as the sole client and returns true. If a client is already
  // connected, returns false and writes a session-busy ERROR frame into
  // `rejectOut` (setting *rejectLen) so the caller can transmit it to the
  // rejected peer and close the connection. When `rejectOut` is null or too
  // small, *rejectLen is set to 0 but the call still returns false.
  bool handleNewConnection(std::uint8_t* rejectOut, std::size_t rejectCap,
                           std::size_t* rejectLen) {
    return codec_.handleNewConnection(rejectOut, rejectCap, rejectLen);
  }

  // Mark the active session as closed and reset the parse + reassembly state.
  // Idempotent.
  void closeConnection() {
    codec_.closeConnection();
    rx_.reset();
  }

  // Build the session-busy ERROR frame (§4.5, kind 0x06) into `out`. Returns
  // the number of bytes written on success, or 0 if `out` is null or `cap` is
  // too small. Pure/static: host-testable.
  static std::size_t buildSessionBusyFrame(std::uint8_t* out, std::size_t cap) {
    return FrameCodec::buildSessionBusyFrame(out, cap);
  }

  // Build the transmit-error ERROR frame (§4.5, kind 0x03 UNRECOVERABLE_TX)
  // into `out`. Emitted when inbound reassembly fails unrecoverably so the SPA
  // retransmits (Req 5.5). Returns the number of bytes written
  // (ESK_BLE_TX_ERROR_FRAME_SIZE) on success, or 0 if `out` is null or `cap` is
  // too small. Pure/static: host-testable.
  static std::size_t buildTransmitErrorFrame(std::uint8_t* out, std::size_t cap);

  // Feed one received inbound RX chunk (1-byte header + body) through the
  // reassembler exactly as the on-device RX write-handler does (Design §3.2):
  //   * Reassembler::Status::Complete -> the exact reassembled Frame_Envelope
  //     bytes are handed to codec_.feedBytes(...), dispatching through the SAME
  //     onFrame handler the WiFi build uses.
  //   * Reassembler::Status::Error    -> the partial frame has been dropped and
  //     a transmit-error ERROR frame is sent via sendBinary() so the SPA
  //     retransmits (Req 5.5).
  //   * Reassembler::Status::NeedMore -> nothing is dispatched yet.
  // Shared by the ARDUINO RX write-handler and the host tests so both exercise
  // the identical inbound path.
  void acceptInboundChunk(const std::uint8_t* chunk, std::size_t len);

  // ---- BLE telemetry -------------------------------------------------------

  // Most recently sampled link RSSI in dBm, for the STATUS frame's
  // Signal_Strength field (Design §3.8, Req 9.4). Web Bluetooth does not expose
  // connection RSSI to the page, so it is read controller-side via
  // `BLEDevice::rssi()` during serviceLoop() (wired in task 3.3). Returns
  // ESK_BLE_RSSI_UNKNOWN when no link RSSI has been sampled.
  int lastRssiDbm() const { return last_rssi_dbm_; }

  // ---- Host test seam ------------------------------------------------------

  // Feed raw bytes into the parse buffer exactly as if a complete frame had
  // arrived over the GATT pipe, dispatching any complete frames to the
  // registered handler. This is the seam the host tests use to exercise frame
  // dispatch without a radio; on device the reassembled-frame path runs the
  // same internal call against real inbound chunks.
  void ingestForTest(const std::uint8_t* bytes, std::size_t n) {
    codec_.ingestForTest(bytes, n);
  }

#if !defined(ARDUINO)
  // Host-only inspection of bytes passed to sendBinary(), so tests can assert
  // on outgoing frames without a radio. Not compiled on-device.
  const std::uint8_t* sentBytesForTest() const { return sent_buf_; }
  std::size_t sentLenForTest() const { return sent_len_; }
  void clearSentForTest() { sent_len_ = 0; }
#endif

 private:
  // Shared framing / dispatch / single-client core (Design §3.1, §3.3). The
  // ArduinoBLE plumbing in the .cpp feeds reassembled frame bytes into this and
  // forwards the single-client seam to it.
  FrameCodec codec_{};

  // Inbound MTU reassembly: each RX-characteristic write is a chunk; a complete
  // frame's bytes are handed to `codec_.feedBytes(...)` (ble_chunk.h).
  Reassembler rx_{};

  // Last link RSSI snapshot (dBm) for STATUS telemetry; ESK_BLE_RSSI_UNKNOWN
  // until first sampled (Design §3.8).
  int last_rssi_dbm_ = ESK_BLE_RSSI_UNKNOWN;

#if !defined(ARDUINO)
  // Capture of the last sendBinary() payload (host tests only).
  std::uint8_t sent_buf_[PARSE_BUFFER_CAPACITY] = {0};
  std::size_t  sent_len_ = 0;
#endif
};

}  // namespace protocol
}  // namespace etch
