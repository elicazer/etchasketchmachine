// Host-side unit tests for the extracted shared framing/dispatch core
// `etch::protocol::FrameCodec` (Task 1.3).
//
// Task 1.1 extracted the byte-accumulator, frame splitter, version-byte
// resync, oversize-frame desync, and single-client enforcement out of
// `WSServer` into `FrameCodec` (Design §3.1, §3.3). Task 1.2 then refactored
// `WSServer` to delegate to it. This suite drives `FrameCodec` *directly* (no
// WebSocket/RFC6455 plumbing) to lock the extracted behaviour in place:
//
//   * Frame splitting: a single frame, two concatenated frames in order, and a
//     frame delivered one byte at a time all dispatch correctly.
//   * Resync: leading garbage / a bad version marker is skipped so a following
//     valid frame is still recovered.
//   * Oversize desync: a frame whose declared length exceeds the parse buffer
//     is treated as desync (dropped byte-by-byte) and never blocks a later
//     valid frame.
//   * Single-client: the first connection is adopted, a second is rejected with
//     a populated session-busy ERROR frame while the original session is
//     preserved, and closing the session frees the slot again.
//
// Convention (mirrors test_frame): the host_test env sets `test_build_src = no`,
// so this translation unit pulls the implementations in directly via relative
// include to keep the binary self-contained, and provides its own `int main`
// running a Catch2 session.
//
// Run with:
//
//     pio test -e host_test

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "../../src/protocol/frame.h"
#include "../../src/protocol/frame.cpp"        // NOLINT(bugprone-suspicious-include)
#include "../../src/protocol/frame_codec.h"
#include "../../src/protocol/frame_codec.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::protocol::buildFrame;
using etch::protocol::decodeFrameHeader;
using etch::protocol::Frame;
using etch::protocol::FrameCodec;
using etch::protocol::FrameHeader;
using etch::protocol::FRAME_HEADER_SIZE;
using etch::protocol::FRAME_VERSION;
using etch::protocol::FrameType;
using etch::protocol::CODEC_ERROR_KIND_SESSION_BUSY;
using etch::protocol::CODEC_SESSION_BUSY_FRAME_SIZE;
using etch::protocol::PARSE_BUFFER_CAPACITY;

namespace {

// Records frames as the codec dispatches them so tests can assert on the
// dispatched type and payload bytes. The codec's Frame::payload pointer aliases
// the parse buffer and is only valid during the callback, so we copy here.
struct CapturedFrame {
  FrameType type;
  std::vector<std::uint8_t> payload;
};

// A codec wired to record every dispatched frame into `seen`.
struct RecordingCodec {
  FrameCodec codec;
  std::vector<CapturedFrame> seen;

  RecordingCodec() {
    codec.onFrame([this](const Frame& f) {
      seen.push_back(
          {f.type, std::vector<std::uint8_t>(f.payload, f.payload + f.len)});
    });
  }
};

}  // namespace

// ---------------------------------------------------------------------------
// Frame splitting
// ---------------------------------------------------------------------------

TEST_CASE("FrameCodec dispatches a single CMD frame with type and payload",
          "[codec][dispatch]") {
  RecordingCodec rc;

  std::uint8_t payload[16];
  for (std::uint8_t i = 0; i < 16; ++i) {
    payload[i] = static_cast<std::uint8_t>(i + 1);
  }
  std::uint8_t frame[FRAME_HEADER_SIZE + 16] = {0};
  const std::size_t n =
      buildFrame(FrameType::CMD, payload, sizeof(payload), frame, sizeof(frame));
  REQUIRE(n == sizeof(frame));

  rc.codec.feedBytes(frame, n);

  REQUIRE(rc.seen.size() == 1);
  REQUIRE(rc.seen[0].type == FrameType::CMD);
  REQUIRE(rc.seen[0].payload.size() == 16);
  for (std::uint8_t i = 0; i < 16; ++i) {
    REQUIRE(rc.seen[0].payload[i] == static_cast<std::uint8_t>(i + 1));
  }
}

TEST_CASE("FrameCodec splits two concatenated frames in order",
          "[codec][dispatch]") {
  RecordingCodec rc;

  std::uint8_t cmd_payload[16] = {0};
  cmd_payload[0] = 0xCD;
  const std::uint8_t ctl_payload[1] = {0x01};  // CTL PAUSE

  std::uint8_t buf[FRAME_HEADER_SIZE + 16 + FRAME_HEADER_SIZE + 1] = {0};
  std::size_t off = 0;
  off += buildFrame(FrameType::CMD, cmd_payload, sizeof(cmd_payload), buf + off,
                    sizeof(buf) - off);
  off += buildFrame(FrameType::CTL, ctl_payload, sizeof(ctl_payload), buf + off,
                    sizeof(buf) - off);

  rc.codec.feedBytes(buf, off);

  REQUIRE(rc.seen.size() == 2);
  REQUIRE(rc.seen[0].type == FrameType::CMD);
  REQUIRE(rc.seen[0].payload[0] == 0xCD);
  REQUIRE(rc.seen[1].type == FrameType::CTL);
  REQUIRE(rc.seen[1].payload[0] == 0x01);
}

TEST_CASE("FrameCodec reassembles a frame delivered one byte at a time",
          "[codec][dispatch][partial]") {
  RecordingCodec rc;

  const std::uint8_t payload[4] = {0xDE, 0xAD, 0xBE, 0xEF};
  std::uint8_t frame[FRAME_HEADER_SIZE + 4] = {0};
  const std::size_t n = buildFrame(FrameType::STATE, payload, sizeof(payload),
                                   frame, sizeof(frame));

  // Handler must not fire until the final byte arrives.
  for (std::size_t i = 0; i < n; ++i) {
    rc.codec.feedBytes(frame + i, 1);
    if (i + 1 < n) {
      REQUIRE(rc.seen.empty());
    }
  }

  REQUIRE(rc.seen.size() == 1);
  REQUIRE(rc.seen[0].type == FrameType::STATE);
  REQUIRE(rc.seen[0].payload.size() == 4);
}

TEST_CASE("FrameCodec dispatches a zero-length payload frame",
          "[codec][dispatch]") {
  RecordingCodec rc;

  std::uint8_t frame[FRAME_HEADER_SIZE] = {0};
  const std::size_t n = buildFrame(FrameType::ACK, nullptr, 0, frame, sizeof(frame));
  REQUIRE(n == FRAME_HEADER_SIZE);

  rc.codec.feedBytes(frame, n);

  REQUIRE(rc.seen.size() == 1);
  REQUIRE(rc.seen[0].type == FrameType::ACK);
  REQUIRE(rc.seen[0].payload.empty());
}

TEST_CASE("FrameCodec ingestForTest delegates to feedBytes",
          "[codec][dispatch]") {
  RecordingCodec rc;

  const std::uint8_t payload[1] = {0x07};
  std::uint8_t frame[FRAME_HEADER_SIZE + 1] = {0};
  const std::size_t n = buildFrame(FrameType::CREDIT, payload, sizeof(payload),
                                   frame, sizeof(frame));

  rc.codec.ingestForTest(frame, n);

  REQUIRE(rc.seen.size() == 1);
  REQUIRE(rc.seen[0].type == FrameType::CREDIT);
  REQUIRE(rc.seen[0].payload[0] == 0x07);
}

TEST_CASE("FrameCodec tolerates a null byte pointer", "[codec][dispatch]") {
  RecordingCodec rc;
  rc.codec.feedBytes(nullptr, 8);  // must not crash or dispatch
  REQUIRE(rc.seen.empty());
}

// ---------------------------------------------------------------------------
// Resync past leading garbage / bad version markers
// ---------------------------------------------------------------------------

TEST_CASE("FrameCodec resynchronises past leading garbage bytes",
          "[codec][resync]") {
  RecordingCodec rc;

  const std::uint8_t payload[1] = {0x07};
  std::uint8_t frame[FRAME_HEADER_SIZE + 1] = {0};
  const std::size_t n = buildFrame(FrameType::CREDIT, payload, sizeof(payload),
                                   frame, sizeof(frame));

  // Prepend junk bytes that are not the version marker.
  const std::uint8_t junk[3] = {0x00, 0xFF, 0x55};
  rc.codec.feedBytes(junk, sizeof(junk));
  rc.codec.feedBytes(frame, n);

  REQUIRE(rc.seen.size() == 1);
  REQUIRE(rc.seen[0].type == FrameType::CREDIT);
  REQUIRE(rc.seen[0].payload[0] == 0x07);
}

TEST_CASE("FrameCodec recovers a valid frame after a bad-version frame header",
          "[codec][resync]") {
  RecordingCodec rc;

  // A header-shaped chunk with an invalid version byte, followed by a real
  // frame. The codec must drop the bad bytes one at a time and still surface
  // the good frame.
  const std::uint8_t bogus[FRAME_HEADER_SIZE] = {0x02, 0x01, 0x00, 0x00};
  rc.codec.feedBytes(bogus, sizeof(bogus));

  const std::uint8_t payload[2] = {0xA1, 0xB2};
  std::uint8_t frame[FRAME_HEADER_SIZE + 2] = {0};
  const std::size_t n = buildFrame(FrameType::STATUS, payload, sizeof(payload),
                                   frame, sizeof(frame));
  rc.codec.feedBytes(frame, n);

  REQUIRE(rc.seen.size() == 1);
  REQUIRE(rc.seen[0].type == FrameType::STATUS);
  REQUIRE(rc.seen[0].payload.size() == 2);
  REQUIRE(rc.seen[0].payload[0] == 0xA1);
  REQUIRE(rc.seen[0].payload[1] == 0xB2);
}

// ---------------------------------------------------------------------------
// Oversize-frame desync
// ---------------------------------------------------------------------------

TEST_CASE("FrameCodec treats an oversize declared length as desync",
          "[codec][desync]") {
  RecordingCodec rc;

  // A version-valid header that declares a payload larger than the parse
  // buffer can ever hold. This can never be a real frame, so the codec must
  // drop bytes to resync rather than block forever — and a following valid
  // frame must still be dispatched.
  std::uint8_t oversize_hdr[FRAME_HEADER_SIZE] = {0};
  const std::uint16_t huge = PARSE_BUFFER_CAPACITY + 100;  // > buffer capacity
  oversize_hdr[0] = FRAME_VERSION;
  oversize_hdr[1] = static_cast<std::uint8_t>(FrameType::CMD);
  oversize_hdr[2] = static_cast<std::uint8_t>(huge & 0xFF);
  oversize_hdr[3] = static_cast<std::uint8_t>((huge >> 8) & 0xFF);
  rc.codec.feedBytes(oversize_hdr, sizeof(oversize_hdr));
  REQUIRE(rc.seen.empty());

  const std::uint8_t payload[1] = {0x42};
  std::uint8_t frame[FRAME_HEADER_SIZE + 1] = {0};
  const std::size_t n = buildFrame(FrameType::CTL, payload, sizeof(payload),
                                   frame, sizeof(frame));
  rc.codec.feedBytes(frame, n);

  REQUIRE(rc.seen.size() == 1);
  REQUIRE(rc.seen[0].type == FrameType::CTL);
  REQUIRE(rc.seen[0].payload[0] == 0x42);
}

TEST_CASE("FrameCodec keeps draining when the parse buffer overflows",
          "[codec][desync]") {
  RecordingCodec rc;

  // Feed many complete small frames in one burst whose total size exceeds the
  // parse buffer capacity. Because each frame is independently parseable, the
  // codec must dispatch all of them (draining makes room as it goes) without
  // dropping any to the overflow path.
  const std::uint8_t payload[1] = {0xEE};
  std::uint8_t one[FRAME_HEADER_SIZE + 1] = {0};
  const std::size_t one_n =
      buildFrame(FrameType::CREDIT, payload, sizeof(payload), one, sizeof(one));

  // Enough frames that the cumulative bytes well exceed PARSE_BUFFER_CAPACITY.
  const std::size_t frame_count =
      (PARSE_BUFFER_CAPACITY / one_n) + 20;
  std::vector<std::uint8_t> stream;
  stream.reserve(frame_count * one_n);
  for (std::size_t i = 0; i < frame_count; ++i) {
    stream.insert(stream.end(), one, one + one_n);
  }

  rc.codec.feedBytes(stream.data(), stream.size());

  REQUIRE(rc.seen.size() == frame_count);
  for (const auto& f : rc.seen) {
    REQUIRE(f.type == FrameType::CREDIT);
    REQUIRE(f.payload.size() == 1);
    REQUIRE(f.payload[0] == 0xEE);
  }
}

// ---------------------------------------------------------------------------
// Single-client enforcement: adopt / reject / close
// ---------------------------------------------------------------------------

TEST_CASE("FrameCodec adopts the first client and rejects the second",
          "[codec][session-busy]") {
  FrameCodec codec;
  REQUIRE_FALSE(codec.isClientConnected());

  // First client is admitted; no rejection frame produced.
  std::uint8_t reject[CODEC_SESSION_BUSY_FRAME_SIZE] = {0};
  std::size_t rlen = 123;  // sentinel
  REQUIRE(codec.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(codec.isClientConnected());
  REQUIRE(rlen == 0u);

  // Second client is rejected with a populated session-busy ERROR frame.
  rlen = 0;
  REQUIRE_FALSE(codec.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(codec.isClientConnected());  // original session preserved
  REQUIRE(rlen == CODEC_SESSION_BUSY_FRAME_SIZE);
  REQUIRE(reject[0] == FRAME_VERSION);
  REQUIRE(reject[1] == 0x31);                          // ERROR type code
  REQUIRE(reject[4] == CODEC_ERROR_KIND_SESSION_BUSY);  // kind 0x06

  // The rejection frame is itself a valid, fully-present §4.5 frame.
  FrameHeader hdr{};
  REQUIRE(decodeFrameHeader(reject, rlen, hdr));
  REQUIRE(hdr.type == FrameType::ERROR);
  REQUIRE(hdr.length == 4);

  // After the active client disconnects, a new client is admitted again.
  codec.closeConnection();
  REQUIRE_FALSE(codec.isClientConnected());
  REQUIRE(codec.handleNewConnection(reject, sizeof(reject), &rlen));
  REQUIRE(codec.isClientConnected());
  REQUIRE(rlen == 0u);
}

TEST_CASE("FrameCodec rejection still occurs when reject buffer is too small",
          "[codec][session-busy]") {
  FrameCodec codec;
  std::uint8_t reject[CODEC_SESSION_BUSY_FRAME_SIZE] = {0};
  std::size_t rlen = 0;
  REQUIRE(codec.handleNewConnection(reject, sizeof(reject), &rlen));

  // Undersized reject buffer: peer is still rejected (returns false) but no
  // frame bytes are produced.
  std::uint8_t small[CODEC_SESSION_BUSY_FRAME_SIZE - 1] = {0};
  rlen = 999;
  REQUIRE_FALSE(codec.handleNewConnection(small, sizeof(small), &rlen));
  REQUIRE(codec.isClientConnected());  // active session preserved
  REQUIRE(rlen == 0u);
}

TEST_CASE("FrameCodec closeConnection is idempotent and resets parse state",
          "[codec][session-busy]") {
  RecordingCodec rc;

  std::uint8_t reject[CODEC_SESSION_BUSY_FRAME_SIZE] = {0};
  std::size_t rlen = 0;
  REQUIRE(rc.codec.handleNewConnection(reject, sizeof(reject), &rlen));

  // Feed a partial frame (header claims 4 bytes of payload, none delivered).
  std::uint8_t partial[FRAME_HEADER_SIZE] = {0};
  buildFrame(FrameType::CMD, nullptr, 0, partial, sizeof(partial));
  partial[2] = 0x04;  // declare 4-byte payload, but send none
  rc.codec.feedBytes(partial, sizeof(partial));
  REQUIRE(rc.seen.empty());

  // Closing twice must not crash and must clear the parse buffer.
  rc.codec.closeConnection();
  rc.codec.closeConnection();
  REQUIRE_FALSE(rc.codec.isClientConnected());

  // A fresh, complete frame after reconnect dispatches cleanly — the stale
  // partial bytes from before the close were discarded.
  REQUIRE(rc.codec.handleNewConnection(reject, sizeof(reject), &rlen));
  const std::uint8_t payload[1] = {0x55};
  std::uint8_t frame[FRAME_HEADER_SIZE + 1] = {0};
  const std::size_t n = buildFrame(FrameType::CTL, payload, sizeof(payload),
                                   frame, sizeof(frame));
  rc.codec.feedBytes(frame, n);

  REQUIRE(rc.seen.size() == 1);
  REQUIRE(rc.seen[0].type == FrameType::CTL);
  REQUIRE(rc.seen[0].payload[0] == 0x55);
}

TEST_CASE("FrameCodec buildSessionBusyFrame emits a valid ERROR frame",
          "[codec][session-busy]") {
  std::uint8_t out[CODEC_SESSION_BUSY_FRAME_SIZE] = {0};
  const std::size_t n = FrameCodec::buildSessionBusyFrame(out, sizeof(out));
  REQUIRE(n == CODEC_SESSION_BUSY_FRAME_SIZE);
  REQUIRE(out[0] == FRAME_VERSION);
  REQUIRE(out[1] == 0x31);                          // ERROR
  REQUIRE(out[2] == 0x04);                          // payload length low (4)
  REQUIRE(out[3] == 0x00);                          // payload length high
  REQUIRE(out[4] == CODEC_ERROR_KIND_SESSION_BUSY);  // kind 0x06
  REQUIRE(out[5] == 0x00);                          // axis none
  REQUIRE(out[6] == 0x00);                          // detail low
  REQUIRE(out[7] == 0x00);                          // detail high

  // Undersized / null buffers produce no frame.
  REQUIRE(FrameCodec::buildSessionBusyFrame(out, CODEC_SESSION_BUSY_FRAME_SIZE - 1) == 0u);
  REQUIRE(FrameCodec::buildSessionBusyFrame(nullptr, CODEC_SESSION_BUSY_FRAME_SIZE) == 0u);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
