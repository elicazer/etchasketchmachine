// Host-side unit tests for the WebSocket binary frame envelope (Task 3.3).
//
// Covers, per the task:
//   * Frame header encode/decode round-trip (Design §4.5).
//   * Version rejection (decodeFrameHeader rejects version != 0x01).
//   * Length-mismatch rejection (truncated frames).
//   * isKnownFrameType() for every defined code and an unknown code.
//   * buildFrame() capacity handling.
//   * Frame dispatch: feeding CMD / CTL frames through WSServer::ingestForTest()
//     drives the registered handler with the right FrameType and payload.
//   * Single-client enforcement: a second connection is rejected with a
//     session-busy ERROR frame (Design §2.1, §4.5).
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment in platformio.ini is configured with
// `test_build_src = no`, so this translation unit pulls the implementations in
// directly via relative include to keep the binary self-contained (matching the
// convention in test_crc16 / test_wifi).

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "../../src/protocol/frame.h"
#include "../../src/protocol/frame.cpp"        // NOLINT(bugprone-suspicious-include)
#include "../../src/protocol/frame_codec.h"
#include "../../src/protocol/frame_codec.cpp"  // NOLINT(bugprone-suspicious-include)
#include "../../src/protocol/ws_server.h"
#include "../../src/protocol/ws_server.cpp"    // NOLINT(bugprone-suspicious-include)

using etch::protocol::buildFrame;
using etch::protocol::decodeFrameHeader;
using etch::protocol::encodeFrameHeader;
using etch::protocol::Frame;
using etch::protocol::FrameHeader;
using etch::protocol::FRAME_HEADER_SIZE;
using etch::protocol::FRAME_VERSION;
using etch::protocol::FrameType;
using etch::protocol::isKnownFrameType;
using etch::protocol::WSServer;
using etch::protocol::WS_ERROR_KIND_SESSION_BUSY;
using etch::protocol::WS_SESSION_BUSY_FRAME_SIZE;

namespace {

// Records frames as the WSServer dispatches them so tests can assert on the
// dispatched type and payload bytes.
struct CapturedFrame {
  FrameType type;
  std::vector<std::uint8_t> payload;
};

}  // namespace

// ---------------------------------------------------------------------------
// encodeFrameHeader / decodeFrameHeader round-trip (Design §4.5)
// ---------------------------------------------------------------------------

TEST_CASE("encodeFrameHeader writes version, type, little-endian length",
          "[frame][header]") {
  std::uint8_t hdr[FRAME_HEADER_SIZE] = {0};
  REQUIRE(encodeFrameHeader(static_cast<std::uint8_t>(FrameType::STATUS), 0x1234,
                            hdr));
  REQUIRE(hdr[0] == FRAME_VERSION);
  REQUIRE(hdr[1] == 0x20);  // STATUS type code
  REQUIRE(hdr[2] == 0x34);  // length low byte
  REQUIRE(hdr[3] == 0x12);  // length high byte
}

TEST_CASE("encodeFrameHeader rejects a null output buffer", "[frame][header]") {
  REQUIRE_FALSE(encodeFrameHeader(0x01, 0, nullptr));
}

TEST_CASE("header encode -> decode is a round-trip", "[frame][header]") {
  // A full frame buffer: header + `length` payload bytes so decode's
  // completeness check is satisfied.
  const std::uint16_t length = 16;
  std::uint8_t buf[FRAME_HEADER_SIZE + length] = {0};
  REQUIRE(encodeFrameHeader(static_cast<std::uint8_t>(FrameType::CMD), length,
                            buf));

  FrameHeader out{};
  REQUIRE(decodeFrameHeader(buf, sizeof(buf), out));
  REQUIRE(out.version == FRAME_VERSION);
  REQUIRE(out.type == FrameType::CMD);
  REQUIRE(out.length == length);
}

TEST_CASE("decodeFrameHeader round-trips a zero-length payload",
          "[frame][header]") {
  std::uint8_t buf[FRAME_HEADER_SIZE] = {0};
  REQUIRE(encodeFrameHeader(static_cast<std::uint8_t>(FrameType::ACK), 0, buf));

  FrameHeader out{};
  REQUIRE(decodeFrameHeader(buf, sizeof(buf), out));
  REQUIRE(out.type == FrameType::ACK);
  REQUIRE(out.length == 0);
}

// ---------------------------------------------------------------------------
// Version rejection
// ---------------------------------------------------------------------------

TEST_CASE("decodeFrameHeader rejects an unsupported version byte",
          "[frame][header][reject]") {
  std::uint8_t buf[FRAME_HEADER_SIZE] = {0x02, 0x01, 0x00, 0x00};  // version 0x02
  FrameHeader out{};
  REQUIRE_FALSE(decodeFrameHeader(buf, sizeof(buf), out));

  buf[0] = 0x00;  // version 0x00 is also invalid
  REQUIRE_FALSE(decodeFrameHeader(buf, sizeof(buf), out));
}

// ---------------------------------------------------------------------------
// Length / truncation rejection
// ---------------------------------------------------------------------------

TEST_CASE("decodeFrameHeader rejects buffers shorter than the header",
          "[frame][header][reject]") {
  std::uint8_t buf[FRAME_HEADER_SIZE] = {FRAME_VERSION, 0x01, 0x00, 0x00};
  FrameHeader out{};
  REQUIRE_FALSE(decodeFrameHeader(buf, FRAME_HEADER_SIZE - 1, out));
  REQUIRE_FALSE(decodeFrameHeader(nullptr, FRAME_HEADER_SIZE, out));
}

TEST_CASE("decodeFrameHeader rejects a frame whose payload is truncated",
          "[frame][header][reject]") {
  // Declares a 16-byte payload but only 8 payload bytes are present.
  std::uint8_t buf[FRAME_HEADER_SIZE + 8] = {0};
  REQUIRE(encodeFrameHeader(static_cast<std::uint8_t>(FrameType::CMD), 16, buf));

  FrameHeader out{};
  REQUIRE_FALSE(decodeFrameHeader(buf, sizeof(buf), out));
}

TEST_CASE("decodeFrameHeader accepts trailing bytes beyond one frame",
          "[frame][header]") {
  // 4-byte payload declared, but the buffer carries extra trailing bytes (e.g.
  // the start of a following frame). decode validates the first frame only.
  const std::uint16_t length = 4;
  std::uint8_t buf[FRAME_HEADER_SIZE + length + 5] = {0};
  REQUIRE(encodeFrameHeader(static_cast<std::uint8_t>(FrameType::CTL), length,
                            buf));

  FrameHeader out{};
  REQUIRE(decodeFrameHeader(buf, sizeof(buf), out));
  REQUIRE(out.type == FrameType::CTL);
  REQUIRE(out.length == length);
}

// ---------------------------------------------------------------------------
// isKnownFrameType for every code + an unknown code
// ---------------------------------------------------------------------------

TEST_CASE("isKnownFrameType accepts every defined type code",
          "[frame][type]") {
  REQUIRE(isKnownFrameType(0x01));  // CMD
  REQUIRE(isKnownFrameType(0x02));  // CTL
  REQUIRE(isKnownFrameType(0x10));  // ACK
  REQUIRE(isKnownFrameType(0x11));  // NACK
  REQUIRE(isKnownFrameType(0x12));  // RETX_REQUEST
  REQUIRE(isKnownFrameType(0x20));  // STATUS
  REQUIRE(isKnownFrameType(0x21));  // CREDIT
  REQUIRE(isKnownFrameType(0x22));  // HELLO
  REQUIRE(isKnownFrameType(0x30));  // STATE
  REQUIRE(isKnownFrameType(0x31));  // ERROR
  REQUIRE(isKnownFrameType(0x32));  // PROGRESS
}

TEST_CASE("isKnownFrameType rejects unknown codes", "[frame][type]") {
  REQUIRE_FALSE(isKnownFrameType(0x00));
  REQUIRE_FALSE(isKnownFrameType(0x03));  // gap between CTL and ACK
  REQUIRE_FALSE(isKnownFrameType(0x13));  // just past RETX_REQUEST
  REQUIRE_FALSE(isKnownFrameType(0x33));  // just past PROGRESS
  REQUIRE_FALSE(isKnownFrameType(0xFF));
}

// ---------------------------------------------------------------------------
// buildFrame capacity handling
// ---------------------------------------------------------------------------

TEST_CASE("buildFrame writes header + payload and returns total length",
          "[frame][build]") {
  const std::uint8_t payload[3] = {0xAA, 0xBB, 0xCC};
  std::uint8_t out[FRAME_HEADER_SIZE + 3] = {0};

  const std::size_t n =
      buildFrame(FrameType::CREDIT, payload, sizeof(payload), out, sizeof(out));
  REQUIRE(n == FRAME_HEADER_SIZE + 3);
  REQUIRE(out[0] == FRAME_VERSION);
  REQUIRE(out[1] == 0x21);  // CREDIT
  REQUIRE(out[2] == 0x03);  // length low
  REQUIRE(out[3] == 0x00);  // length high
  REQUIRE(out[4] == 0xAA);
  REQUIRE(out[5] == 0xBB);
  REQUIRE(out[6] == 0xCC);
}

TEST_CASE("buildFrame returns 0 when the output buffer is too small",
          "[frame][build][capacity]") {
  const std::uint8_t payload[3] = {1, 2, 3};
  std::uint8_t out[FRAME_HEADER_SIZE + 3] = {0};

  // One byte short of header + payload.
  REQUIRE(buildFrame(FrameType::CREDIT, payload, sizeof(payload), out,
                     FRAME_HEADER_SIZE + 2) == 0u);
  // Header-only capacity cannot hold a 3-byte payload.
  REQUIRE(buildFrame(FrameType::CREDIT, payload, sizeof(payload), out,
                     FRAME_HEADER_SIZE) == 0u);
  // Zero capacity.
  REQUIRE(buildFrame(FrameType::CREDIT, payload, sizeof(payload), out, 0) == 0u);
}

TEST_CASE("buildFrame handles a zero-length payload with a null pointer",
          "[frame][build]") {
  std::uint8_t out[FRAME_HEADER_SIZE] = {0};
  const std::size_t n = buildFrame(FrameType::ACK, nullptr, 0, out, sizeof(out));
  REQUIRE(n == FRAME_HEADER_SIZE);
  REQUIRE(out[1] == 0x10);  // ACK
  REQUIRE(out[2] == 0x00);
  REQUIRE(out[3] == 0x00);
}

TEST_CASE("buildFrame rejects a null output or a non-null-required payload",
          "[frame][build][reject]") {
  const std::uint8_t payload[2] = {1, 2};
  std::uint8_t out[FRAME_HEADER_SIZE + 2] = {0};
  // Null output buffer.
  REQUIRE(buildFrame(FrameType::CMD, payload, sizeof(payload), nullptr,
                     sizeof(out)) == 0u);
  // Non-zero payload length but null payload pointer.
  REQUIRE(buildFrame(FrameType::CMD, nullptr, 2, out, sizeof(out)) == 0u);
}

// ---------------------------------------------------------------------------
// Frame dispatch through WSServer::ingestForTest()
// ---------------------------------------------------------------------------

TEST_CASE("WSServer dispatches a CMD frame with the correct type and payload",
          "[ws][dispatch]") {
  WSServer server;
  std::vector<CapturedFrame> seen;
  server.onFrame([&](const Frame& f) {
    seen.push_back({f.type, std::vector<std::uint8_t>(f.payload, f.payload + f.len)});
  });
  server.begin();

  // A 16-byte CMD payload (Design §4.3) carried in a §4.5 frame.
  std::uint8_t payload[16];
  for (std::uint8_t i = 0; i < 16; ++i) payload[i] = static_cast<std::uint8_t>(i + 1);

  std::uint8_t frame[FRAME_HEADER_SIZE + 16] = {0};
  const std::size_t n =
      buildFrame(FrameType::CMD, payload, sizeof(payload), frame, sizeof(frame));
  REQUIRE(n == sizeof(frame));

  server.ingestForTest(frame, n);

  REQUIRE(seen.size() == 1);
  REQUIRE(seen[0].type == FrameType::CMD);
  REQUIRE(seen[0].payload.size() == 16);
  for (std::uint8_t i = 0; i < 16; ++i) {
    REQUIRE(seen[0].payload[i] == static_cast<std::uint8_t>(i + 1));
  }
}

TEST_CASE("WSServer dispatches a CTL frame distinctly from CMD", "[ws][dispatch]") {
  WSServer server;
  std::vector<CapturedFrame> seen;
  server.onFrame([&](const Frame& f) {
    seen.push_back({f.type, std::vector<std::uint8_t>(f.payload, f.payload + f.len)});
  });
  server.begin();

  // CTL JOG {axis=0, dir=+1, steps=1} per §4.6: kind 0x05 + {u8, i8, u16}.
  const std::uint8_t ctl[5] = {0x05, 0x00, 0x01, 0x01, 0x00};
  std::uint8_t frame[FRAME_HEADER_SIZE + 5] = {0};
  const std::size_t n = buildFrame(FrameType::CTL, ctl, sizeof(ctl), frame, sizeof(frame));

  server.ingestForTest(frame, n);

  REQUIRE(seen.size() == 1);
  REQUIRE(seen[0].type == FrameType::CTL);
  REQUIRE(seen[0].payload.size() == 5);
  REQUIRE(seen[0].payload[0] == 0x05);  // JOG kind
}

TEST_CASE("WSServer dispatches two concatenated frames in order",
          "[ws][dispatch]") {
  WSServer server;
  std::vector<CapturedFrame> seen;
  server.onFrame([&](const Frame& f) {
    seen.push_back({f.type, std::vector<std::uint8_t>(f.payload, f.payload + f.len)});
  });
  server.begin();

  std::uint8_t cmd_payload[16] = {0};
  cmd_payload[0] = 0xCD;
  const std::uint8_t ctl_payload[1] = {0x01};  // CTL PAUSE

  std::uint8_t buf[FRAME_HEADER_SIZE + 16 + FRAME_HEADER_SIZE + 1] = {0};
  std::size_t off = 0;
  off += buildFrame(FrameType::CMD, cmd_payload, sizeof(cmd_payload), buf + off,
                    sizeof(buf) - off);
  off += buildFrame(FrameType::CTL, ctl_payload, sizeof(ctl_payload), buf + off,
                    sizeof(buf) - off);

  server.ingestForTest(buf, off);

  REQUIRE(seen.size() == 2);
  REQUIRE(seen[0].type == FrameType::CMD);
  REQUIRE(seen[0].payload[0] == 0xCD);
  REQUIRE(seen[1].type == FrameType::CTL);
  REQUIRE(seen[1].payload[0] == 0x01);
}

TEST_CASE("WSServer reassembles a frame delivered one byte at a time",
          "[ws][dispatch][partial]") {
  WSServer server;
  std::vector<CapturedFrame> seen;
  server.onFrame([&](const Frame& f) {
    seen.push_back({f.type, std::vector<std::uint8_t>(f.payload, f.payload + f.len)});
  });
  server.begin();

  const std::uint8_t payload[4] = {0xDE, 0xAD, 0xBE, 0xEF};
  std::uint8_t frame[FRAME_HEADER_SIZE + 4] = {0};
  const std::size_t n = buildFrame(FrameType::STATE, payload, sizeof(payload),
                                   frame, sizeof(frame));

  // Feed byte-by-byte; the handler must not fire until the final byte arrives.
  for (std::size_t i = 0; i < n; ++i) {
    server.ingestForTest(frame + i, 1);
    if (i + 1 < n) {
      REQUIRE(seen.empty());
    }
  }
  REQUIRE(seen.size() == 1);
  REQUIRE(seen[0].type == FrameType::STATE);
  REQUIRE(seen[0].payload.size() == 4);
}

TEST_CASE("WSServer resynchronises past leading garbage bytes",
          "[ws][dispatch][resync]") {
  WSServer server;
  std::vector<CapturedFrame> seen;
  server.onFrame([&](const Frame& f) {
    seen.push_back({f.type, std::vector<std::uint8_t>(f.payload, f.payload + f.len)});
  });
  server.begin();

  const std::uint8_t payload[1] = {0x07};
  std::uint8_t frame[FRAME_HEADER_SIZE + 1] = {0};
  const std::size_t n = buildFrame(FrameType::CREDIT, payload, sizeof(payload),
                                   frame, sizeof(frame));

  // Prepend junk bytes that are not the version marker.
  const std::uint8_t junk[3] = {0x00, 0xFF, 0x55};
  server.ingestForTest(junk, sizeof(junk));
  server.ingestForTest(frame, n);

  REQUIRE(seen.size() == 1);
  REQUIRE(seen[0].type == FrameType::CREDIT);
  REQUIRE(seen[0].payload[0] == 0x07);
}

// ---------------------------------------------------------------------------
// Single-client enforcement (Design §2.1, §4.5)
// ---------------------------------------------------------------------------

TEST_CASE("buildSessionBusyFrame emits an ERROR frame with kind SESSION_BUSY",
          "[ws][session-busy]") {
  std::uint8_t out[WS_SESSION_BUSY_FRAME_SIZE] = {0};
  const std::size_t n = WSServer::buildSessionBusyFrame(out, sizeof(out));
  REQUIRE(n == WS_SESSION_BUSY_FRAME_SIZE);
  REQUIRE(out[0] == FRAME_VERSION);
  REQUIRE(out[1] == 0x31);  // ERROR type code
  REQUIRE(out[2] == 0x04);  // payload length low (4)
  REQUIRE(out[3] == 0x00);  // payload length high
  REQUIRE(out[4] == WS_ERROR_KIND_SESSION_BUSY);  // kind = 0x06
  REQUIRE(out[5] == 0x00);  // axis = none
  REQUIRE(out[6] == 0x00);  // detail low
  REQUIRE(out[7] == 0x00);  // detail high

  // The session-busy frame must itself be a valid, fully-present §4.5 frame.
  FrameHeader hdr{};
  REQUIRE(decodeFrameHeader(out, n, hdr));
  REQUIRE(hdr.type == FrameType::ERROR);
  REQUIRE(hdr.length == 4);
}

TEST_CASE("buildSessionBusyFrame rejects an undersized buffer",
          "[ws][session-busy]") {
  std::uint8_t out[WS_SESSION_BUSY_FRAME_SIZE - 1] = {0};
  REQUIRE(WSServer::buildSessionBusyFrame(out, sizeof(out)) == 0u);
  REQUIRE(WSServer::buildSessionBusyFrame(nullptr, WS_SESSION_BUSY_FRAME_SIZE) == 0u);
}

TEST_CASE("WSServer admits the first client and rejects the second",
          "[ws][session-busy]") {
  WSServer server;
  server.begin();
  REQUIRE_FALSE(server.isClientConnected());

  // First client is admitted; no rejection frame produced.
  std::uint8_t reject[WS_SESSION_BUSY_FRAME_SIZE] = {0};
  std::size_t rlen = 123;  // sentinel
  REQUIRE(server.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(server.isClientConnected());
  REQUIRE(rlen == 0u);

  // Second client is rejected with a populated session-busy frame.
  rlen = 0;
  REQUIRE_FALSE(server.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(server.isClientConnected());  // original session preserved
  REQUIRE(rlen == WS_SESSION_BUSY_FRAME_SIZE);
  REQUIRE(reject[1] == 0x31);                       // ERROR
  REQUIRE(reject[4] == WS_ERROR_KIND_SESSION_BUSY);  // kind 0x06

  // After the active client disconnects, a new client is admitted again.
  server.closeConnection();
  REQUIRE_FALSE(server.isClientConnected());
  REQUIRE(server.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(server.isClientConnected());
}

TEST_CASE("WSServer rejection still occurs when the reject buffer is too small",
          "[ws][session-busy]") {
  WSServer server;
  server.begin();
  std::uint8_t reject[WS_SESSION_BUSY_FRAME_SIZE] = {0};
  std::size_t rlen = 0;
  REQUIRE(server.handleNewConnection(reject, sizeof(reject), &rlen));

  // Undersized reject buffer: the peer is still rejected (returns false) but no
  // frame bytes are produced.
  std::uint8_t small[WS_SESSION_BUSY_FRAME_SIZE - 1] = {0};
  rlen = 999;
  REQUIRE_FALSE(server.handleNewConnection(small, sizeof(small), &rlen));
  REQUIRE(rlen == 0u);
}

TEST_CASE("WSServer sendBinary is a no-op until a client connects",
          "[ws][send]") {
  WSServer server;
  server.begin();
  const std::uint8_t data[4] = {1, 2, 3, 4};

  // No client yet: nothing captured.
  server.sendBinary(data, sizeof(data));
  REQUIRE(server.sentLenForTest() == 0u);

  // Once connected, the bytes are forwarded (captured on the host).
  std::uint8_t reject[WS_SESSION_BUSY_FRAME_SIZE] = {0};
  std::size_t rlen = 0;
  REQUIRE(server.handleNewConnection(reject, sizeof(reject), &rlen));
  server.sendBinary(data, sizeof(data));
  REQUIRE(server.sentLenForTest() == sizeof(data));
  REQUIRE(server.sentBytesForTest()[0] == 1);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
