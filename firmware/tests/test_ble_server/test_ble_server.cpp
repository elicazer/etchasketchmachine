// Host-side tests for the non-Arduino parts of `etch::protocol::BleServer`
// (Task 3.4). See firmware/src/protocol/ble_server.{h,cpp} for the design
// notes, the shared `FrameCodec` seam, the MTU chunking/reassembly glue, and
// the host-test seam contract.
//
// On the host (`#if !defined(ARDUINO)`) all ArduinoBLE plumbing in ble_server.cpp
// is compiled out, so the file host-compiles and the transport-independent core
// is exercised directly through the public seam:
//
//   * acceptInboundChunk(chunk,len) — the SAME inbound path the on-device RX
//     write-handler runs: reassemble chunks, dispatch a complete frame through
//     codec_/onFrame, or emit a transmit-error ERROR on unrecoverable
//     reassembly.
//   * sendBinary(data,len) — on the host this captures the bytes to
//     sentBytesForTest()/sentLenForTest() (it no-ops when no client is
//     connected, so tests adopt a session via handleNewConnection first).
//   * handleNewConnection / closeConnection / isClientConnected — the single-
//     session enforcement delegated to FrameCodec.
//
// Coverage:
//   1. Host-side chunk path: fragment a frame, feed the chunks via
//      acceptInboundChunk(), and assert the onFrame handler receives the exact
//      reassembled frame (round-trip into FrameCodec).
//   2. Transmit-error on bad reassembly: feed a malformed chunk sequence and
//      assert a transmit-error ERROR frame (kind 0x03 UNRECOVERABLE_TX) is
//      emitted via sendBinary (observed through sentBytesForTest()).
//   3. Property 3 (rapidcheck): the single BLE session invariant.
//
// Convention (mirrors test_frame_codec / test_ble_chunk_props): the host_test
// env sets `test_build_src = no`, so this translation unit pulls the
// implementations in directly via relative includes to keep the binary
// self-contained, and provides its own `int main` running a Catch2 session.
// Each .cpp is included exactly once across this translation unit to respect
// the One Definition Rule. ble_server.cpp depends on frame.cpp (buildFrame),
// frame_codec.cpp (FrameCodec) and ble_chunk.cpp (fragment / Reassembler).
//
// Run with:
//
//     pio test -e host_test -f test_ble_server

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "../../src/protocol/frame.h"
#include "../../src/protocol/frame.cpp"        // NOLINT(bugprone-suspicious-include)
#include "../../src/protocol/frame_codec.h"
#include "../../src/protocol/frame_codec.cpp"  // NOLINT(bugprone-suspicious-include)
#include "../../src/protocol/ble_chunk.h"
#include "../../src/protocol/ble_chunk.cpp"    // NOLINT(bugprone-suspicious-include)
#include "../../src/protocol/ble_server.h"
#include "../../src/protocol/ble_server.cpp"   // NOLINT(bugprone-suspicious-include)

using etch::protocol::BleServer;
using etch::protocol::buildFrame;
using etch::protocol::encodeChunkHeader;
using etch::protocol::ESK_BLE_ERROR_KIND_UNRECOVERABLE_TX;
using etch::protocol::ESK_BLE_TX_BODY_SIZE;
using etch::protocol::ESK_BLE_TX_ERROR_FRAME_SIZE;
using etch::protocol::Frame;
using etch::protocol::FragmentStatus;
using etch::protocol::fragment;
using etch::protocol::FRAME_HEADER_SIZE;
using etch::protocol::FRAME_VERSION;
using etch::protocol::FrameType;
using etch::protocol::CODEC_SESSION_BUSY_FRAME_SIZE;

namespace {

// A single captured chunk (header byte + body slice), copied out of the
// fragment() sink's transient scratch buffer so it survives past the call.
using Chunk = std::vector<std::uint8_t>;

// Build a §4.5 frame of `type` carrying `payload` into a vector.
std::vector<std::uint8_t> makeFrame(FrameType type,
                                    const std::vector<std::uint8_t>& payload) {
  std::vector<std::uint8_t> out(FRAME_HEADER_SIZE + payload.size());
  const std::size_t n = buildFrame(
      type, payload.empty() ? nullptr : payload.data(),
      static_cast<std::uint16_t>(payload.size()), out.data(), out.size());
  out.resize(n);
  return out;
}

// Fragment `frame` into ordered chunks (body size `body`), copying each chunk
// out of the transient sink buffer.
std::vector<Chunk> chunksOf(const std::vector<std::uint8_t>& frame,
                            std::size_t body) {
  std::vector<Chunk> chunks;
  const FragmentStatus fs = fragment(
      frame.data(), frame.size(), body,
      [&chunks](const std::uint8_t* chunk, std::size_t len) {
        chunks.emplace_back(chunk, chunk + len);
      });
  REQUIRE(fs == FragmentStatus::Ok);
  return chunks;
}

// Build a raw chunk: 1-byte (total, index) header followed by `body`.
Chunk mkChunk(std::uint8_t total, std::uint8_t index,
              const std::vector<std::uint8_t>& body) {
  Chunk c;
  c.push_back(encodeChunkHeader(total, index));
  c.insert(c.end(), body.begin(), body.end());
  return c;
}

}  // namespace

// ---------------------------------------------------------------------------
// 1. Host-side inbound chunk path: fragment -> acceptInboundChunk -> onFrame
// ---------------------------------------------------------------------------

TEST_CASE(
    "BleServer acceptInboundChunk reassembles chunks and dispatches the exact "
    "frame through onFrame",
    "[ble][server][chunk]") {
  BleServer server;
  server.begin();

  // Capture every frame the codec dispatches (payload aliases the parse buffer,
  // so copy it during the callback).
  std::vector<std::vector<std::uint8_t>> seenPayloads;
  std::vector<FrameType> seenTypes;
  server.onFrame([&](const Frame& f) {
    seenTypes.push_back(f.type);
    seenPayloads.emplace_back(f.payload, f.payload + f.len);
  });

  // A CMD frame with a recognizable 16-byte Drawing_Command payload. At 16
  // bytes payload (20-byte frame) and a 19-byte body this spans two chunks,
  // exercising the multi-chunk reassembly path.
  std::vector<std::uint8_t> payload(16);
  for (std::size_t i = 0; i < payload.size(); ++i) {
    payload[i] = static_cast<std::uint8_t>(i * 7u + 3u);
  }
  const std::vector<std::uint8_t> frame = makeFrame(FrameType::CMD, payload);
  const std::vector<Chunk> chunks = chunksOf(frame, ESK_BLE_TX_BODY_SIZE);
  REQUIRE(chunks.size() >= 2);  // confirm the multi-chunk path is exercised

  // Feed chunks in order; nothing dispatches until the frame completes.
  for (std::size_t i = 0; i < chunks.size(); ++i) {
    server.acceptInboundChunk(chunks[i].data(), chunks[i].size());
    if (i + 1 < chunks.size()) {
      REQUIRE(seenTypes.empty());
    }
  }

  REQUIRE(seenTypes.size() == 1);
  REQUIRE(seenTypes[0] == FrameType::CMD);
  REQUIRE(seenPayloads[0] == payload);  // byte-for-byte round trip (Req 5.3)
}

TEST_CASE(
    "BleServer acceptInboundChunk reassembles a single-chunk frame",
    "[ble][server][chunk]") {
  BleServer server;
  server.begin();

  std::vector<FrameType> seenTypes;
  std::vector<std::vector<std::uint8_t>> seenPayloads;
  server.onFrame([&](const Frame& f) {
    seenTypes.push_back(f.type);
    seenPayloads.emplace_back(f.payload, f.payload + f.len);
  });

  // A short CTL frame (1-byte payload => 5-byte frame) fits in one 19-byte
  // body, so it arrives as a single chunk.
  const std::vector<std::uint8_t> payload{0x01};
  const std::vector<std::uint8_t> frame = makeFrame(FrameType::CTL, payload);
  const std::vector<Chunk> chunks = chunksOf(frame, ESK_BLE_TX_BODY_SIZE);
  REQUIRE(chunks.size() == 1);

  server.acceptInboundChunk(chunks[0].data(), chunks[0].size());

  REQUIRE(seenTypes.size() == 1);
  REQUIRE(seenTypes[0] == FrameType::CTL);
  REQUIRE(seenPayloads[0] == payload);
}

// ---------------------------------------------------------------------------
// 2. Transmit-error on unrecoverable reassembly
// ---------------------------------------------------------------------------

TEST_CASE(
    "BleServer emits a transmit-error ERROR frame on unrecoverable reassembly",
    "[ble][server][chunk][error]") {
  BleServer server;
  server.begin();

  // sendBinary() no-ops unless a client owns the session, so adopt one first.
  std::uint8_t reject[CODEC_SESSION_BUSY_FRAME_SIZE] = {0};
  std::size_t rlen = 0;
  REQUIRE(server.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(server.isClientConnected());
  server.clearSentForTest();

  // A continuation chunk (index 1) with no in-flight frame is an unrecoverable
  // reassembly failure: the reassembler discards it and signals Error, so
  // BleServer builds a transmit-error frame and hands it to sendBinary().
  const std::vector<std::uint8_t> body{0xAA, 0xBB, 0xCC};
  const Chunk bad = mkChunk(/*total=*/3, /*index=*/1, body);
  server.acceptInboundChunk(bad.data(), bad.size());

  // sendBinary captured a complete transmit-error ERROR frame (§4.5).
  REQUIRE(server.sentLenForTest() == ESK_BLE_TX_ERROR_FRAME_SIZE);
  const std::uint8_t* sent = server.sentBytesForTest();
  REQUIRE(sent[0] == FRAME_VERSION);
  REQUIRE(sent[1] == static_cast<std::uint8_t>(FrameType::ERROR));  // 0x31
  REQUIRE(sent[2] == 0x04);  // payload length low (ERROR payload = 4 bytes)
  REQUIRE(sent[3] == 0x00);  // payload length high
  REQUIRE(sent[4] == ESK_BLE_ERROR_KIND_UNRECOVERABLE_TX);  // kind 0x03
  REQUIRE(sent[5] == 0x00);  // axis: none
  REQUIRE(sent[6] == 0x00);  // detail low
  REQUIRE(sent[7] == 0x00);  // detail high
}

TEST_CASE(
    "BleServer does not transmit a transmit-error when no client is connected",
    "[ble][server][chunk][error]") {
  BleServer server;
  server.begin();
  REQUIRE_FALSE(server.isClientConnected());

  // Same malformed chunk, but with no session: sendBinary is a no-op, so
  // nothing is captured.
  const std::vector<std::uint8_t> body{0x01, 0x02};
  const Chunk bad = mkChunk(/*total=*/3, /*index=*/2, body);
  server.acceptInboundChunk(bad.data(), bad.size());

  REQUIRE(server.sentLenForTest() == 0u);
}

// ---------------------------------------------------------------------------
// Feature: ble-transport-switch, Property 3: Single BLE session invariant
//
//   *For any* sequence of connect, reject, and disconnect events, at most one
//   client session is active at any time: a connection attempt while a session
//   is active is rejected (handleNewConnection returns false) and the active
//   session is preserved; the slot becomes available again only after the
//   active client disconnects (closeConnection).
//
//   Validates: Requirements 3.4, 3.5, 3.7
//   Design: §7.1 (Property 3), §7.2
//
// Mechanics. We drive a fresh BleServer with an arbitrary sequence of
// operations drawn from {connect, disconnect} (connect = handleNewConnection,
// disconnect = closeConnection) and track a boolean model of whether a session
// is active. After every operation we assert:
//   * the server's isClientConnected() matches the model (so the slot is a
//     single boolean — at most one session ever active),
//   * a connect while active returns false AND leaves the session connected
//     (the active session is preserved, Req 3.5/3.7),
//   * a connect while idle returns true and adopts the session (Req 3.4),
//   * a disconnect always leaves the slot free.
// ---------------------------------------------------------------------------

namespace {

enum class Op { Connect, Disconnect };

}  // namespace

TEST_CASE("Property 3: at most one BLE session is active across any sequence",
          "[ble][server][property][property-3]") {
  REQUIRE(rc::check(
      "single-session invariant holds for arbitrary connect/disconnect order",
      [] {
        // Arbitrary-length sequence of connect (0) / disconnect (1) ops.
        const std::vector<int> raw = *rc::gen::container<std::vector<int>>(
            rc::gen::inRange<int>(0, 2));

        BleServer server;
        server.begin();
        bool modelActive = false;  // mirrors the single-session slot

        for (int code : raw) {
          const Op op = (code == 0) ? Op::Connect : Op::Disconnect;
          if (op == Op::Connect) {
            const bool wasActive = modelActive;
            std::uint8_t reject[CODEC_SESSION_BUSY_FRAME_SIZE] = {0};
            std::size_t rlen = 123;  // sentinel
            const bool adopted =
                server.handleNewConnection(reject, sizeof(reject), &rlen);

            if (wasActive) {
              // Concurrent connect is rejected; active session is preserved.
              RC_ASSERT(!adopted);
              RC_ASSERT(server.isClientConnected());
              // A populated session-busy ERROR frame is produced for the peer.
              RC_ASSERT(rlen == CODEC_SESSION_BUSY_FRAME_SIZE);
            } else {
              // Idle slot adopts the new session; no rejection frame.
              RC_ASSERT(adopted);
              RC_ASSERT(server.isClientConnected());
              RC_ASSERT(rlen == 0u);
              modelActive = true;
            }
          } else {
            // Disconnect always frees the slot (idempotent when already idle).
            server.closeConnection();
            modelActive = false;
            RC_ASSERT(!server.isClientConnected());
          }

          // The slot is a single boolean: never more than one active session.
          RC_ASSERT(server.isClientConnected() == modelActive);
        }
      }));
}

// Boundary anchor (plain Catch2): the canonical adopt -> reject -> free cycle.
TEST_CASE("Property 3 boundary: adopt, reject concurrent, free after close",
          "[ble][server][property][property-3][boundary]") {
  BleServer server;
  server.begin();
  REQUIRE_FALSE(server.isClientConnected());

  std::uint8_t reject[CODEC_SESSION_BUSY_FRAME_SIZE] = {0};
  std::size_t rlen = 0;

  // First connect adopts the session.
  REQUIRE(server.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(server.isClientConnected());
  REQUIRE(rlen == 0u);

  // Second concurrent connect is rejected; the active session is preserved.
  rlen = 0;
  REQUIRE_FALSE(server.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(server.isClientConnected());
  REQUIRE(rlen == CODEC_SESSION_BUSY_FRAME_SIZE);

  // The slot frees only after the active client disconnects.
  server.closeConnection();
  REQUIRE_FALSE(server.isClientConnected());

  // A fresh client may then be adopted again.
  REQUIRE(server.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(server.isClientConnected());
  REQUIRE(rlen == 0u);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
