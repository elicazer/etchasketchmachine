// BLE GATT server implementation. See ble_server.h for the design notes, the
// shared `FrameCodec` seam, the single bidirectional GATT pipe, and the
// host-test seam contract.
//
// Like `ws_server.cpp`, this module owns only the radio plumbing — here the
// ArduinoBLE GATT service/characteristics and the MTU chunking/reassembly glue.
// All framing / dispatch / single-client logic lives in the shared `FrameCodec`
// member (`codec_`); inbound reassembled frames are routed into
// `codec_.feedBytes(...)` and outbound frames are fragmented onto the TX
// notification characteristic. The module is split into two layers:
//
//   1. The real ArduinoBLE plumbing — building the GATT service + RX/TX
//      characteristics, advertising, polling, the RX write handler, the TX
//      notify, single-central adoption, and RSSI readback — all behind
//      `#if defined(ARDUINO)`. The detailed inbound/outbound chunk wiring is
//      task 3.2 and the serviceLoop session/advertising/RSSI logic is task 3.3;
//      this file lays in the structure those tasks fill in.
//
//   2. Thin forwarding shims (`begin`, `serviceLoop`, `sendBinary`) that adapt
//      the preserved public seam onto the shared codec / chunking core. The
//      framing/dispatch and single-client enforcement themselves are exercised
//      on the host through the inline `ingestForTest()` /
//      `handleNewConnection()` / `closeConnection()` forwarders in the header.

#include "ble_server.h"

#include <cstring>

#include "ble_chunk.h"

#if defined(ARDUINO)
#  include <Arduino.h>
#  include <ArduinoBLE.h>
#endif

namespace etch {
namespace protocol {

#if defined(ARDUINO)
// ---------------------------------------------------------------------------
// Real BLE transport (ArduinoBLE GATT). Kept self-contained here so the
// framing/dispatch logic (in FrameCodec) and the chunking core (ble_chunk)
// stay Arduino-free and host-tested. A single bidirectional pipe carries the
// existing framed byte stream (Design §3.3): the RX characteristic accepts
// browser→controller chunks (Write / WriteWithoutResponse) and the TX
// characteristic notifies controller→browser chunks.
// ---------------------------------------------------------------------------
namespace ble_net {

// The GATT service and its two characteristics. The characteristic value sizes
// are the BLE attribute ceiling so any negotiated MTU fits one chunk.
BLEService        g_service(ESK_BLE_SERVICE_UUID);
BLECharacteristic g_rxChar(ESK_BLE_RX_CHAR_UUID,
                           BLEWrite | BLEWriteWithoutResponse,
                           ESK_BLE_CHAR_VALUE_SIZE);
BLECharacteristic g_txChar(ESK_BLE_TX_CHAR_UUID,
                           BLENotify,
                           ESK_BLE_CHAR_VALUE_SIZE);

// The owning BleServer for the static ArduinoBLE characteristic-event handler
// (ArduinoBLE callbacks are free functions, so the instance is reached through
// this back-pointer). Set in buildAndAdvertise(); only one BleServer is ever
// active on the device.
BleServer* g_self = nullptr;

// Address of the central that currently owns the single session, or empty when
// no session is active (Design §3.2, Req 3.4). serviceLoop() polls
// `BLE.central()` and compares its address against this to (a) detect the
// connect/disconnect edges that drive session adoption/release and advertising,
// and (b) recognise a *different* central surfaced by the stack while a session
// is active so it can be rejected without disturbing the active session
// (Req 3.5, 3.7). `String` is the type returned by `BLEDevice::address()`.
String g_activeAddr;

// RX write-handler: each write on the RX characteristic is one inbound chunk
// (Design §3.2, §3.3). Forward the exact bytes to the shared inbound path,
// which reassembles and either dispatches a complete frame through the codec or
// emits a transmit-error so the SPA retransmits (Req 5.1, 5.2, 5.3, 5.5).
void onRxWritten(BLEDevice /*central*/, BLECharacteristic characteristic) {
  if (g_self == nullptr) {
    return;
  }
  g_self->acceptInboundChunk(characteristic.value(),
                             static_cast<std::size_t>(characteristic.valueLength()));
}

// Build the GATT service, register the characteristics, set the advertised
// device name + service UUID, and begin advertising. Detailed connect-handler
// registration is wired in task 3.3.
void buildAndAdvertise(BleServer* self) {
  g_self = self;
  g_activeAddr = "";

  BLE.setDeviceName(ESK_BLE_DEVICE_NAME);
  BLE.setLocalName(ESK_BLE_DEVICE_NAME);
  BLE.setAdvertisedService(g_service);

  g_service.addCharacteristic(g_rxChar);
  g_service.addCharacteristic(g_txChar);
  BLE.addService(g_service);

  // Inbound chunks arrive as RX-characteristic writes.
  g_rxChar.setEventHandler(BLEWritten, onRxWritten);

  BLE.advertise();
}

}  // namespace ble_net
#endif  // ARDUINO

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

void BleServer::begin() {
  // Reset the shared framing/session state and the inbound reassembler to a
  // clean baseline.
  codec_.closeConnection();
  rx_.reset();
  last_rssi_dbm_ = ESK_BLE_RSSI_UNKNOWN;
#if !defined(ARDUINO)
  sent_len_ = 0;
#endif

#if defined(ARDUINO)
  if (BLE.begin()) {
    ble_net::buildAndAdvertise(this);
  }
#endif
}

void BleServer::serviceLoop() {
#if defined(ARDUINO)
  // Design choice — poll `BLE.central()` here rather than registering
  // BLEConnected/BLEDisconnected event handlers. Polling mirrors the
  // cooperative-tick shape of `WSServer::serviceLoop()` (accept/poll, drain,
  // detect disconnect), keeps all single-session state transitions in one
  // place, and lets us re-sample the link RSSI every tick (Req 9.4). The RX
  // write path is still event-driven via `onRxWritten` (task 3.2); event
  // handlers and polling coexist under ArduinoBLE.

  // 1. Service the BLE stack so the RX write handler fires and connection
  //    bookkeeping advances.
  BLE.poll();

  // 2. Inspect the central the stack currently associates with this peripheral.
  BLEDevice central = BLE.central();

  if (central && central.connected()) {
    const String addr = central.address();

    if (!isClientConnected()) {
      // GATT is connected, but the browser's BleSocket only subscribes to the
      // TX (notify) characteristic AFTER it finishes service/characteristic
      // discovery. If we adopt the session (and let the sketch fire HELLO on
      // the resulting connect edge) before that subscription lands, the HELLO
      // notification is written into an unsubscribed pipe and silently lost —
      // the browser then only ever sees periodic STATUS frames, which carry no
      // envelope dimensions, so the SPA never learns the (default) envelope and
      // blocks drawing. Defer "session established" until the central has
      // actually subscribed to TX notifications, so HELLO is delivered on a
      // live pipe (Design §3.2/§3.3: HELLO on session establishment).
      if (!ble_net::g_txChar.subscribed()) {
        return;  // connected but not yet subscribed; wait for the CCCD write
      }
      // Fresh connection: adopt the single session via the shared codec and
      // stop advertising so no second central can connect while one is active
      // (Req 2.4, 3.4). handleNewConnection() returns true here because no
      // session is active.
      std::uint8_t reject[CODEC_SESSION_BUSY_FRAME_SIZE];
      std::size_t rlen = 0;
      handleNewConnection(reject, sizeof(reject), &rlen);  // adopts session
      ble_net::g_activeAddr = addr;
      BLE.stopAdvertise();
      // Seed the RSSI snapshot immediately so the first STATUS after connect
      // carries a real reading.
      last_rssi_dbm_ = central.rssi();
    } else if (addr != ble_net::g_activeAddr) {
      // A *different* central surfaced while a session is already active. The
      // active session must be preserved (Req 3.5, 3.7): reject the intruder by
      // disconnecting it and leave codec_/g_activeAddr untouched. Advertising is
      // already stopped, so this path only triggers if the stack races a second
      // central onto the link. The disconnect IS the rejection — the TX-notify
      // pipe is owned by the active subscribed central, so a session-busy ERROR
      // (kind 0x06) cannot be reliably delivered to the intruder over GATT.
      central.disconnect();
      return;  // active session preserved
    } else {
      // Steady state on the active session: refresh the link RSSI for STATUS
      // telemetry (Req 9.4, Design §3.8).
      last_rssi_dbm_ = central.rssi();
    }
  } else if (isClientConnected()) {
    // The active central dropped: release the single session, reset inbound
    // reassembly, clear the RSSI snapshot, and resume advertising so a client
    // can reconnect. Re-advertising happens on this very tick, well within the
    // 5 s budget (Req 2.5).
    closeConnection();
    ble_net::g_activeAddr = "";
    last_rssi_dbm_ = ESK_BLE_RSSI_UNKNOWN;
    BLE.advertise();
  }
#endif
}

void BleServer::sendBinary(const std::uint8_t* data, std::size_t len) {
  if (data == nullptr || len == 0 || !isClientConnected()) {
    return;
  }
#if defined(ARDUINO)
  // Outbound MTU chunking (Design §3.2, §3.6): fragment the complete frame into
  // notification-sized chunks and notify each on the TX characteristic. The
  // body size is the safe floor ESK_BLE_TX_BODY_SIZE (19 bytes), matching the
  // browser side so both directions chunk identically (Req 5.1, 5.2, 5.4).
  fragment(data, len, ESK_BLE_TX_BODY_SIZE,
           [](const std::uint8_t* chunk, std::size_t chunkLen) {
             ble_net::g_txChar.writeValue(chunk, static_cast<int>(chunkLen));
           });
#else
  // Host build: capture the bytes so tests can assert on outgoing frames.
  const std::size_t n = (len <= sizeof(sent_buf_)) ? len : sizeof(sent_buf_);
  std::memcpy(sent_buf_, data, n);
  sent_len_ = n;
#endif
}

std::size_t BleServer::buildTransmitErrorFrame(std::uint8_t* out, std::size_t cap) {
  if (out == nullptr || cap < ESK_BLE_TX_ERROR_FRAME_SIZE) {
    return 0;
  }
  // ERROR payload per §4.5: { u8 kind, u8 axis, u16 detail } (little-endian).
  // kind = UNRECOVERABLE_TX (0x03); axis/detail are not meaningful for a
  // reassembly transmit error, so both are 0.
  const std::uint8_t payload[4] = {
      ESK_BLE_ERROR_KIND_UNRECOVERABLE_TX,
      0x00,  // axis: none
      0x00,  // detail low
      0x00,  // detail high
  };
  return buildFrame(FrameType::ERROR, payload, sizeof(payload), out, cap);
}

void BleServer::acceptInboundChunk(const std::uint8_t* chunk, std::size_t len) {
  const Reassembler::Status status = rx_.accept(chunk, len);
  switch (status) {
    case Reassembler::Status::Complete:
      // The reassembled bytes are the exact original Frame_Envelope (Req 5.3);
      // hand them to the shared codec so the SAME onFrame handler the WiFi
      // build uses dispatches them (Design §3.2).
      codec_.feedBytes(rx_.frame(), rx_.frameLen());
      break;
    case Reassembler::Status::Error: {
      // Unrecoverable reassembly: the partial frame has already been dropped by
      // the reassembler. Signal a transmit error so the SPA retransmits the
      // whole frame (Req 5.5).
      std::uint8_t err[ESK_BLE_TX_ERROR_FRAME_SIZE];
      const std::size_t n = buildTransmitErrorFrame(err, sizeof(err));
      if (n > 0) {
        sendBinary(err, n);
      }
      break;
    }
    case Reassembler::Status::NeedMore:
      // Frame not yet complete; nothing to dispatch.
      break;
  }
}

}  // namespace protocol
}  // namespace etch
