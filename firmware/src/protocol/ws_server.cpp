// WebSocket server implementation. See ws_server.h for the design notes, the
// single-client rule, and the host-test seam contract.
//
// After the §3.3 extraction this module owns only the RFC6455 / WiFiS3 radio
// plumbing; all framing / dispatch / single-client logic lives in the shared
// `FrameCodec` member (`codec_`). The module is split into two layers:
//
//   1. The real WiFiS3 socket plumbing — accepting connections, the RFC6455
//      upgrade/handshake, reading inbound bytes, masking/unmasking, ping/pong,
//      writing outbound bytes, and detecting disconnects — all behind
//      `#if defined(ARDUINO)`. Inbound unmasked application bytes are routed
//      into `codec_.feedBytes(...)`; the single-client seam is forwarded to the
//      codec. Those bodies are intentionally thin here; the full handshake is
//      wired up in integration task 31.1.
//
//   2. Thin forwarding shims (`onFrame`, `sendBinary`, `begin`) that adapt the
//      preserved public seam onto the shared codec. The framing/dispatch and
//      single-client enforcement themselves are exercised on the host through
//      the inline `ingestForTest()` / `handleNewConnection()` / `closeConnection()`
//      forwarders in the header (see firmware/tests/test_frame).

#include "ws_server.h"

#include <cstring>

#if defined(ARDUINO)
#  include <Arduino.h>
#  include <WiFiS3.h>
#endif

namespace etch {
namespace protocol {

#if defined(ARDUINO)
// ---------------------------------------------------------------------------
// Real WebSocket transport (RFC6455) on a dedicated port. Kept self-contained
// here so the framing/dispatch logic (now in FrameCodec) stays Arduino-free and
// host-tested. The browser connects to ws://<host>:81/ws (see web config.ts).
// ---------------------------------------------------------------------------
namespace ws_net {

// Dedicated WS listener port (HTTP owns 80). Mirrors web config WS_PORT.
constexpr uint16_t WS_PORT = 81;
constexpr size_t   WS_RAW_BUF = 512;   // inbound socket byte accumulator
constexpr size_t   WS_IN_MAX  = 320;   // max single inbound message payload

WiFiServer g_server(WS_PORT);
WiFiClient g_client;
uint8_t    g_raw[WS_RAW_BUF];
size_t     g_rawLen = 0;

// --- SHA-1 (RFC3174), one-shot over small inputs --------------------------
void sha1(const uint8_t* data, size_t len, uint8_t out[20]) {
  uint32_t h0 = 0x67452301u, h1 = 0xEFCDAB89u, h2 = 0x98BADCFEu,
           h3 = 0x10325476u, h4 = 0xC3D2E1F0u;
  uint8_t buf[192];
  size_t total = 0;
  for (size_t i = 0; i < len && total < sizeof(buf); i++) buf[total++] = data[i];
  buf[total++] = 0x80;
  while ((total % 64) != 56) buf[total++] = 0x00;
  const uint64_t ml = static_cast<uint64_t>(len) * 8u;
  for (int i = 7; i >= 0; i--) buf[total++] = static_cast<uint8_t>((ml >> (i * 8)) & 0xFF);

  for (size_t chunk = 0; chunk < total; chunk += 64) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++) {
      w[i] = (static_cast<uint32_t>(buf[chunk + i * 4]) << 24) |
             (static_cast<uint32_t>(buf[chunk + i * 4 + 1]) << 16) |
             (static_cast<uint32_t>(buf[chunk + i * 4 + 2]) << 8) |
             static_cast<uint32_t>(buf[chunk + i * 4 + 3]);
    }
    for (int i = 16; i < 80; i++) {
      const uint32_t v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (v << 1) | (v >> 31);
    }
    uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20)      { f = (b & c) | ((~b) & d);          k = 0x5A827999u; }
      else if (i < 40) { f = b ^ c ^ d;                     k = 0x6ED9EBA1u; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d);   k = 0x8F1BBCDCu; }
      else             { f = b ^ c ^ d;                     k = 0xCA62C1D6u; }
      const uint32_t tmp = ((a << 5) | (a >> 27)) + f + e + k + w[i];
      e = d; d = c; c = (b << 30) | (b >> 2); b = a; a = tmp;
    }
    h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
  }
  const uint32_t hs[5] = {h0, h1, h2, h3, h4};
  for (int i = 0; i < 5; i++) {
    out[i * 4]     = static_cast<uint8_t>(hs[i] >> 24);
    out[i * 4 + 1] = static_cast<uint8_t>(hs[i] >> 16);
    out[i * 4 + 2] = static_cast<uint8_t>(hs[i] >> 8);
    out[i * 4 + 3] = static_cast<uint8_t>(hs[i]);
  }
}

// --- base64 encode --------------------------------------------------------
void base64(const uint8_t* in, size_t len, char* out) {
  static const char T[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t o = 0, i = 0;
  while (i + 3 <= len) {
    const uint32_t n = (static_cast<uint32_t>(in[i]) << 16) |
                       (static_cast<uint32_t>(in[i + 1]) << 8) |
                       static_cast<uint32_t>(in[i + 2]);
    out[o++] = T[(n >> 18) & 63];
    out[o++] = T[(n >> 12) & 63];
    out[o++] = T[(n >> 6) & 63];
    out[o++] = T[n & 63];
    i += 3;
  }
  const size_t rem = len - i;
  if (rem == 1) {
    const uint32_t n = static_cast<uint32_t>(in[i]) << 16;
    out[o++] = T[(n >> 18) & 63];
    out[o++] = T[(n >> 12) & 63];
    out[o++] = '=';
    out[o++] = '=';
  } else if (rem == 2) {
    const uint32_t n = (static_cast<uint32_t>(in[i]) << 16) |
                       (static_cast<uint32_t>(in[i + 1]) << 8);
    out[o++] = T[(n >> 18) & 63];
    out[o++] = T[(n >> 12) & 63];
    out[o++] = T[(n >> 6) & 63];
    out[o++] = '=';
  }
  out[o] = '\0';
}

// Read the HTTP upgrade request and complete the RFC6455 handshake. Returns
// true on success (101 sent), false otherwise.
bool performHandshake(WiFiClient& c) {
  char key[40] = {0};
  size_t keyLen = 0;
  char line[160];
  size_t li = 0;
  bool done = false;
  const unsigned long deadline = millis() + 3000;

  while (millis() < deadline && c.connected()) {
    while (c.available() > 0) {
      const int ci = c.read();
      if (ci < 0) break;
      const char ch = static_cast<char>(ci);
      if (ch == '\r') continue;
      if (ch == '\n') {
        line[li < sizeof(line) ? li : sizeof(line) - 1] = '\0';
        if (li == 0) { done = true; break; }
        if (strncasecmp(line, "Sec-WebSocket-Key:", 18) == 0) {
          const char* v = line + 18;
          while (*v == ' ') ++v;
          size_t n = 0;
          while (v[n] != '\0' && n < sizeof(key) - 1) { key[n] = v[n]; n++; }
          key[n] = '\0';
          keyLen = n;
        }
        li = 0;
      } else if (li + 1 < sizeof(line)) {
        line[li++] = ch;
      }
    }
    if (done) break;
  }
  if (keyLen == 0) return false;

  static const char GUID[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  uint8_t concat[96];
  size_t cl = 0;
  for (size_t i = 0; i < keyLen && cl < sizeof(concat); i++) concat[cl++] = static_cast<uint8_t>(key[i]);
  for (size_t i = 0; GUID[i] != '\0' && cl < sizeof(concat); i++) concat[cl++] = static_cast<uint8_t>(GUID[i]);

  uint8_t digest[20];
  sha1(concat, cl, digest);
  char accept[32];
  base64(digest, 20, accept);

  c.print("HTTP/1.1 101 Switching Protocols\r\n");
  c.print("Upgrade: websocket\r\n");
  c.print("Connection: Upgrade\r\n");
  c.print("Sec-WebSocket-Accept: ");
  c.print(accept);
  c.print("\r\n\r\n");
  return true;
}

// Send one unmasked server frame (opcode: 0x2 binary, 0x8 close, 0xA pong).
void sendFrame(WiFiClient& c, uint8_t opcode, const uint8_t* data, size_t len) {
  uint8_t hdr[4];
  size_t hl = 0;
  hdr[hl++] = static_cast<uint8_t>(0x80 | (opcode & 0x0F));
  if (len < 126) {
    hdr[hl++] = static_cast<uint8_t>(len);
  } else {
    hdr[hl++] = 126;
    hdr[hl++] = static_cast<uint8_t>((len >> 8) & 0xFF);
    hdr[hl++] = static_cast<uint8_t>(len & 0xFF);
  }
  c.write(hdr, hl);
  if (len > 0 && data != nullptr) c.write(data, len);
}

}  // namespace ws_net
#endif  // ARDUINO

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

void WSServer::begin() {
  // Reset the shared framing/session state (clears the active session and the
  // parse buffer) to a clean baseline.
  codec_.closeConnection();
#if !defined(ARDUINO)
  sent_len_ = 0;
#endif

#if defined(ARDUINO)
  ws_net::g_server.begin();
  ws_net::g_rawLen = 0;
#endif
}

void WSServer::serviceLoop() {
#if defined(ARDUINO)
  using namespace ws_net;

  // 1. Accept a freshly-arrived connection if we have no active client.
  if (!g_client || !g_client.connected()) {
    if (isClientConnected()) {
      // The active peer dropped: tear down the session.
      closeConnection();
      g_client.stop();
    }
    WiFiClient incoming = g_server.available();
    if (incoming) {
      if (isClientConnected()) {
        // Single-client rule: reject the second peer (it never completed a
        // handshake, so just drop it).
        incoming.stop();
      } else if (performHandshake(incoming)) {
        g_client = incoming;
        g_rawLen = 0;
        uint8_t reject[WS_SESSION_BUSY_FRAME_SIZE];
        std::size_t rlen = 0;
        handleNewConnection(reject, sizeof(reject), &rlen);  // adopts session
      } else {
        incoming.stop();
      }
    }
  }

  if (!g_client || !g_client.connected()) return;

  // 2. Drain inbound socket bytes into the raw accumulator.
  while (g_client.available() > 0 && g_rawLen < WS_RAW_BUF) {
    const int ci = g_client.read();
    if (ci < 0) break;
    g_raw[g_rawLen++] = static_cast<uint8_t>(ci);
  }

  // 3. Parse as many complete RFC6455 frames as the buffer holds.
  size_t off = 0;
  for (;;) {
    if (g_rawLen - off < 2) break;
    const uint8_t b0 = g_raw[off];
    const uint8_t b1 = g_raw[off + 1];
    const uint8_t opcode = b0 & 0x0F;
    const bool masked = (b1 & 0x80) != 0;
    uint64_t payLen = b1 & 0x7F;
    size_t hdr = 2;
    if (payLen == 126) {
      if (g_rawLen - off < 4) break;
      payLen = (static_cast<uint64_t>(g_raw[off + 2]) << 8) | g_raw[off + 3];
      hdr = 4;
    } else if (payLen == 127) {
      // 64-bit lengths are never expected from this client; drop the frame.
      off = g_rawLen;
      break;
    }
    const size_t maskLen = masked ? 4 : 0;
    if (g_rawLen - off < hdr + maskLen + payLen) break;  // wait for more bytes

    const uint8_t* mask = g_raw + off + hdr;
    const uint8_t* pay = g_raw + off + hdr + maskLen;

    if (opcode == 0x8) {                 // close
      sendFrame(g_client, 0x8, nullptr, 0);
      g_client.stop();
      closeConnection();
      g_rawLen = 0;
      return;
    } else if (opcode == 0x9) {          // ping -> pong
      static uint8_t pong[WS_IN_MAX];
      const size_t n = payLen > WS_IN_MAX ? WS_IN_MAX : static_cast<size_t>(payLen);
      for (size_t i = 0; i < n; i++) pong[i] = masked ? (pay[i] ^ mask[i & 3]) : pay[i];
      sendFrame(g_client, 0xA, pong, n);
    } else if (opcode == 0x1 || opcode == 0x2 || opcode == 0x0) {
      // text/binary/continuation: unmask into the shared framing parser.
      static uint8_t msg[WS_IN_MAX];
      const size_t n = payLen > WS_IN_MAX ? WS_IN_MAX : static_cast<size_t>(payLen);
      for (size_t i = 0; i < n; i++) msg[i] = masked ? (pay[i] ^ mask[i & 3]) : pay[i];
      codec_.feedBytes(msg, n);
    }
    off += hdr + maskLen + static_cast<size_t>(payLen);
  }

  // 4. Compact any partial trailing frame to the front.
  if (off > 0) {
    const size_t rem = g_rawLen - off;
    if (rem > 0) memmove(g_raw, g_raw + off, rem);
    g_rawLen = rem;
  }
#endif
}

void WSServer::sendBinary(const std::uint8_t* data, std::size_t len) {
  if (data == nullptr || len == 0 || !isClientConnected()) {
    return;
  }
#if defined(ARDUINO)
  if (ws_net::g_client && ws_net::g_client.connected()) {
    ws_net::sendFrame(ws_net::g_client, 0x2, data, len);  // binary frame
  }
#else
  // Host build: capture the bytes so tests can assert on outgoing frames.
  const std::size_t n = (len <= sizeof(sent_buf_)) ? len : sizeof(sent_buf_);
  std::memcpy(sent_buf_, data, n);
  sent_len_ = n;
#endif
}

void WSServer::onFrame(FrameHandler handler) { codec_.onFrame(std::move(handler)); }

}  // namespace protocol
}  // namespace etch
