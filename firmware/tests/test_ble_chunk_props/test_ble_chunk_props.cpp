// Host-side property tests for the BLE MTU chunking / reassembly core
// (Task 2.2). See firmware/src/protocol/ble_chunk.{h,cpp} for the wire format
// (Design §4.3) and the round-trip identity guarantee (Req 5.3).
//
// Feature: ble-transport-switch, Property 1: Chunking round-trip byte identity
//
//   *For any* Frame_Envelope byte sequence `frame` (4 <= frame.length <=
//   15 * body) and *any* chunk body size `body >= 1`,
//   `reassemble(fragment(frame, body))` produces a byte sequence identical to
//   `frame`. Because the reassembled bytes carry no chunk metadata, the frame
//   handed up to the protocol layer is byte-for-byte identical regardless of
//   the negotiated MTU, and identical across the BLE and WiFi builds.
//
//   Validates: Requirements 4.2, 5.1, 5.2, 5.3, 10.1, 13.3
//   Design: §7.1 (Property 1), §3.6, §4.3
//
// Mechanics. `fragment()` slices the frame into ordered chunks and hands each
// to a ChunkSink; the test sink copies every chunk into a vector (the chunk
// pointer aliases internal scratch, valid only for the call duration, so a
// copy is mandatory). The chunks are then fed in order to a Reassembler, and
// the frame recovered when accept() returns Complete is compared byte-for-byte
// against the original. fragment() MUST return Ok and the final accept() MUST
// return Complete for every in-range input, with no intermediate Error.
//
// Generator. `body` is drawn first; the frame length is then constrained to
// `4 <= len <= min(15*body, BLE_REASSEMBLY_CAPACITY)` so the slice count never
// exceeds the 15-chunk ceiling (fragment would otherwise return TooManyChunks)
// and the reassembly buffer (2048 B) is never overrun. The 4-byte floor is the
// minimum Frame_Envelope; the upper end covers multi-chunk HELLO/STATUS-sized
// and larger frames. body ranges into the hundreds to exercise both the
// single-chunk (body >= len) and many-small-chunk regimes.
//
// This translation unit lives in its own PlatformIO test directory so it links
// into a standalone binary and supplies its own `int main`. The host_test env
// uses `test_build_src = no`, so the implementation .cpp is #included directly
// (mirroring test_command_parser_props/ and the other host suites).
//
// Run with:
//
//     pio test -e host_test
//
// (platformio.ini pins Catch2 v3.5.3 and rapidcheck for the host_test env.)

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "../../src/protocol/ble_chunk.h"
#include "../../src/protocol/ble_chunk.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::protocol::BLE_CHUNK_MAX_BODY;
using etch::protocol::BLE_CHUNK_MAX_CHUNKS;
using etch::protocol::BLE_REASSEMBLY_CAPACITY;
using etch::protocol::FragmentStatus;
using etch::protocol::fragment;
using etch::protocol::Reassembler;

namespace {

// A single captured chunk (header byte + body slice), copied out of the sink's
// transient scratch buffer so it survives past the fragment() call.
using Chunk = std::vector<std::uint8_t>;

// Run one round trip: fragment `frame` with `bodySize`, capture every emitted
// chunk, then feed the chunks in order to a fresh Reassembler. Returns the
// recovered frame bytes. RC_ASSERTs every step of the contract so a violation
// anywhere (non-Ok fragment, premature Error, missing Complete) shrinks to a
// counterexample.
std::vector<std::uint8_t> roundTrip(const std::vector<std::uint8_t>& frame,
                                    std::size_t bodySize) {
  // --- fragment: collect ordered chunks via the sink ---
  std::vector<Chunk> chunks;
  const FragmentStatus fs = fragment(
      frame.data(), frame.size(), bodySize,
      [&chunks](const std::uint8_t* chunk, std::size_t len) {
        chunks.emplace_back(chunk, chunk + len);
      });
  RC_ASSERT(fs == FragmentStatus::Ok);
  RC_ASSERT(!chunks.empty());
  // ceil(len / body) chunks, never more than the 15-chunk ceiling.
  const std::size_t expectedTotal = (frame.size() + bodySize - 1) / bodySize;
  RC_ASSERT(chunks.size() == expectedTotal);
  RC_ASSERT(chunks.size() <= static_cast<std::size_t>(BLE_CHUNK_MAX_CHUNKS));

  // --- reassemble: feed chunks in emission order ---
  Reassembler re;
  std::vector<std::uint8_t> recovered;
  for (std::size_t i = 0; i < chunks.size(); ++i) {
    const Chunk& c = chunks[i];
    const Reassembler::Status st = re.accept(c.data(), c.size());
    if (i + 1 < chunks.size()) {
      // Every chunk before the last leaves the frame incomplete, never errored.
      RC_ASSERT(st == Reassembler::Status::NeedMore);
      RC_ASSERT(!re.hadError());
    } else {
      // The final chunk completes the frame.
      RC_ASSERT(st == Reassembler::Status::Complete);
      RC_ASSERT(!re.hadError());
      recovered.assign(re.frame(), re.frame() + re.frameLen());
    }
  }
  return recovered;
}

}  // namespace

// ---------------------------------------------------------------------------
// Feature: ble-transport-switch, Property 1: Chunking round-trip byte identity
//
// For arbitrary frames with 4 <= len <= 15*body and arbitrary body >= 1,
// reassemble(fragment(frame, body)) == frame, byte-for-byte.
// ---------------------------------------------------------------------------
TEST_CASE("Property 1: chunking round-trip reproduces the exact frame bytes",
          "[ble][chunk][property][property-1]") {
  REQUIRE(rc::check(
      "reassemble(fragment(frame, body)) == frame for 4 <= len <= 15*body",
      [] {
        // body >= 1, up to the per-chunk body ceiling (512 B). The hundreds-
        // wide range mixes single-chunk (body >= len) and many-small-chunk
        // regimes within the 15-chunk limit.
        const std::size_t bodySize = static_cast<std::size_t>(
            *rc::gen::inRange<int>(1, static_cast<int>(BLE_CHUNK_MAX_BODY) + 1));

        // 4 <= len <= min(15*body, reassembly capacity). The 15*body cap keeps
        // the slice count <= 15 (else fragment returns TooManyChunks); the
        // capacity cap keeps the reassembly buffer from overflowing.
        std::size_t maxLen =
            static_cast<std::size_t>(BLE_CHUNK_MAX_CHUNKS) * bodySize;
        if (maxLen > BLE_REASSEMBLY_CAPACITY) {
          maxLen = BLE_REASSEMBLY_CAPACITY;
        }
        const std::size_t len = static_cast<std::size_t>(
            *rc::gen::inRange<int>(4, static_cast<int>(maxLen) + 1));

        // Arbitrary frame payload bytes; comparing position-by-position makes
        // any reordering or corruption a failure.
        std::vector<std::uint8_t> frame(len);
        for (std::size_t i = 0; i < len; ++i) {
          frame[i] = static_cast<std::uint8_t>(*rc::gen::arbitrary<std::uint8_t>());
        }

        const std::vector<std::uint8_t> recovered = roundTrip(frame, bodySize);
        RC_ASSERT(recovered == frame);
      }));
}

// ---------------------------------------------------------------------------
// Boundary anchors (plain Catch2). Concrete edges named in Property 1: the
// 4-byte minimum Frame_Envelope and representative HELLO (~33 B) / STATUS
// (20 B) sizes, each exercised across single-chunk, exact-multiple, and
// remainder body sizes.
// ---------------------------------------------------------------------------

namespace {

// Non-RC helper for the example tests: round-trips with plain REQUIREs.
std::vector<std::uint8_t> roundTripChecked(const std::vector<std::uint8_t>& frame,
                                           std::size_t bodySize) {
  std::vector<Chunk> chunks;
  const FragmentStatus fs = fragment(
      frame.data(), frame.size(), bodySize,
      [&chunks](const std::uint8_t* chunk, std::size_t len) {
        chunks.emplace_back(chunk, chunk + len);
      });
  REQUIRE(fs == FragmentStatus::Ok);
  REQUIRE_FALSE(chunks.empty());

  Reassembler re;
  std::vector<std::uint8_t> recovered;
  for (std::size_t i = 0; i < chunks.size(); ++i) {
    const Chunk& c = chunks[i];
    const Reassembler::Status st = re.accept(c.data(), c.size());
    if (i + 1 < chunks.size()) {
      REQUIRE(st == Reassembler::Status::NeedMore);
    } else {
      REQUIRE(st == Reassembler::Status::Complete);
      recovered.assign(re.frame(), re.frame() + re.frameLen());
    }
  }
  REQUIRE_FALSE(re.hadError());
  return recovered;
}

// Build a frame of `len` bytes with a recognizable, position-dependent pattern.
std::vector<std::uint8_t> patterned(std::size_t len) {
  std::vector<std::uint8_t> f(len);
  for (std::size_t i = 0; i < len; ++i) {
    f[i] = static_cast<std::uint8_t>((i * 31u + 7u) & 0xFFu);
  }
  return f;
}

}  // namespace

TEST_CASE("Property 1 boundary: 4-byte minimum frame round-trips identically",
          "[ble][chunk][property][property-1][boundary]") {
  const std::vector<std::uint8_t> frame = patterned(4);
  // Single chunk (body >= len), exact-fit, and sub-length bodies.
  for (std::size_t body : {std::size_t{1}, std::size_t{2}, std::size_t{4},
                           std::size_t{16}}) {
    REQUIRE(roundTripChecked(frame, body) == frame);
  }
}

TEST_CASE("Property 1 boundary: HELLO- and STATUS-sized frames round-trip",
          "[ble][chunk][property][property-1][boundary]") {
  // STATUS is 20 bytes, HELLO ~33 bytes (Design §4.3 commentary).
  for (std::size_t len : {std::size_t{20}, std::size_t{33}}) {
    const std::vector<std::uint8_t> frame = patterned(len);
    // body 1 (max chunk count for this len) is intentionally bounded so the
    // slice count stays within the 15-chunk ceiling; pick bodies that keep
    // ceil(len/body) <= 15 while spanning single- and multi-chunk regimes.
    for (std::size_t body : {std::size_t{3}, std::size_t{5}, std::size_t{20},
                             std::size_t{33}, std::size_t{64}}) {
      REQUIRE(roundTripChecked(frame, body) == frame);
    }
  }
}

TEST_CASE("Property 1 boundary: maximal 15-chunk frame round-trips identically",
          "[ble][chunk][property][property-1][boundary]") {
  // len == 15*body exactly fills all 15 chunks at the chunk-count ceiling.
  const std::size_t body = 64;
  const std::size_t len = static_cast<std::size_t>(BLE_CHUNK_MAX_CHUNKS) * body;
  const std::vector<std::uint8_t> frame = patterned(len);
  REQUIRE(roundTripChecked(frame, body) == frame);
}

// ---------------------------------------------------------------------------
// Feature: ble-transport-switch, Property 2: Chunk reassembly rejects malformed
// sequences
//
//   *For any* malformed chunk sequence — an invalid chunk count (total == 0,
//   the stand-in for the unrepresentable total > 15 since the 4-bit field
//   cannot encode it), an index >= total, a duplicate index, an inconsistent
//   total across one in-flight frame, or a continuation chunk arriving with no
//   in-flight frame start (a dropped / reordered-beyond-recovery start) — a
//   fresh Reassembler discards the partial frame, latches a transmit error
//   (accept() returns Status::Error and hadError() becomes true), and NEVER
//   emits a frame (accept() never returns Status::Complete) for that sequence.
//
//   Validates: Requirements 5.5
//   Design: §7.1 (Property 2), §3.6, §4.3
//
// Mechanics. Each generator branch builds a raw chunk sequence drawn from one
// malformed category and feeds it, one chunk at a time, to a fresh Reassembler.
// We record whether any accept() returned Complete (a leaked frame — a
// violation) and whether any returned Error (the required transmit-error
// signal). A correct reassembler must, for every generated sequence, raise the
// error and never complete, and end with hadError() latched.
//
// Why these categories are guaranteed unrecoverable AT ACCEPT TIME. The host
// Reassembler is a streaming inverse with no end-of-stream hook, so a plain
// trailing-chunk drop (index 0 present, a later index missing) parks in
// NeedMore rather than signalling an error — that case is resolved by the next
// frame's index-0 start (Req 5.5) and is out of scope for the per-accept error
// signal. The "drop / reorder-beyond-recovery" category modelled here is the
// dropped/late START: a continuation chunk reaching the reassembler with no
// frame in flight, which accept() rejects immediately. Every branch below is
// constructed so the in-flight set can never complete before the offending
// chunk lands, so no valid frame is ever emitted.
// ---------------------------------------------------------------------------

namespace {

// Build a raw chunk: 1-byte (total, index) header followed by `body`.
Chunk mkChunk(std::uint8_t total, std::uint8_t index,
              const std::vector<std::uint8_t>& body) {
  Chunk c;
  c.reserve(etch::protocol::BLE_CHUNK_HEADER_SIZE + body.size());
  c.push_back(etch::protocol::encodeChunkHeader(total, index));
  c.insert(c.end(), body.begin(), body.end());
  return c;
}

// A small arbitrary chunk body — the body size is irrelevant to the failure,
// so a few bytes keep counterexamples readable.
std::vector<std::uint8_t> genBody() {
  const std::size_t n = static_cast<std::size_t>(*rc::gen::inRange<int>(0, 9));
  std::vector<std::uint8_t> b(n);
  for (std::size_t i = 0; i < n; ++i) {
    b[i] = static_cast<std::uint8_t>(*rc::gen::arbitrary<std::uint8_t>());
  }
  return b;
}

// Generate one malformed chunk sequence, picking uniformly among the five
// unrecoverable categories. Every returned sequence is guaranteed to (a) never
// let the in-flight frame complete and (b) drive accept() to Status::Error.
std::vector<Chunk> genMalformed() {
  const int cat = *rc::gen::inRange<int>(0, 5);
  switch (cat) {
    case 0: {
      // (a) total_chunks == 0 — an invalid count (stands in for the
      //     unrepresentable total > 15). Rejected on the first chunk.
      const std::uint8_t index =
          static_cast<std::uint8_t>(*rc::gen::inRange<int>(0, 16));
      return {mkChunk(0, index, genBody())};
    }
    case 1: {
      // (b) continuation chunk with no in-flight frame — a dropped or
      //     reordered-beyond-recovery start. index >= 1 with nothing open.
      const std::uint8_t total =
          static_cast<std::uint8_t>(*rc::gen::inRange<int>(2, 16));
      const std::uint8_t index =
          static_cast<std::uint8_t>(*rc::gen::inRange<int>(1, total));
      return {mkChunk(total, index, genBody())};
    }
    case 2: {
      // (c) index >= total within an in-flight frame. total in 2..14 so the
      //     index-0 opener cannot complete the frame; the follow-up carries an
      //     out-of-range index in [total, 15].
      const std::uint8_t total =
          static_cast<std::uint8_t>(*rc::gen::inRange<int>(2, 15));
      const std::uint8_t badIndex =
          static_cast<std::uint8_t>(*rc::gen::inRange<int>(total, 16));
      return {mkChunk(total, 0, genBody()),
              mkChunk(total, badIndex, genBody())};
    }
    case 3: {
      // (d) duplicate index. total in 3..15 so neither index 0 nor index 1
      //     completes the frame; the repeated index 1 is rejected as a dup.
      const std::uint8_t total =
          static_cast<std::uint8_t>(*rc::gen::inRange<int>(3, 16));
      return {mkChunk(total, 0, genBody()), mkChunk(total, 1, genBody()),
              mkChunk(total, 1, genBody())};
    }
    default: {
      // (e) inconsistent total across one in-flight frame. t1 in 2..15 opens a
      //     frame without completing it; the continuation carries a different,
      //     in-range total t2 (t2 != t1).
      const std::uint8_t t1 =
          static_cast<std::uint8_t>(*rc::gen::inRange<int>(2, 16));
      // Pick t2 in 1..15 excluding t1 by drawing from 1..14 and skipping t1.
      int t2raw = *rc::gen::inRange<int>(1, 15);
      if (t2raw >= static_cast<int>(t1)) {
        ++t2raw;
      }
      const std::uint8_t t2 = static_cast<std::uint8_t>(t2raw);
      const std::uint8_t idx2 =
          static_cast<std::uint8_t>(*rc::gen::inRange<int>(1, 16));
      return {mkChunk(t1, 0, genBody()), mkChunk(t2, idx2, genBody())};
    }
  }
}

}  // namespace

TEST_CASE(
    "Property 2: reassembly rejects malformed sequences with a transmit error "
    "and never emits a frame",
    "[ble][chunk][property][property-2]") {
  REQUIRE(rc::check(
      "malformed sequences -> Status::Error, hadError(), and no Complete",
      [] {
        const std::vector<Chunk> chunks = genMalformed();
        RC_ASSERT(!chunks.empty());

        Reassembler re;
        bool sawError = false;
        bool sawComplete = false;
        for (const Chunk& c : chunks) {
          const Reassembler::Status st = re.accept(c.data(), c.size());
          if (st == Reassembler::Status::Complete) {
            sawComplete = true;
          } else if (st == Reassembler::Status::Error) {
            sawError = true;
          }
        }

        // No valid frame ever leaked to the protocol layer.
        RC_ASSERT(!sawComplete);
        // The transmit error was signalled (Req 5.5).
        RC_ASSERT(sawError);
        // The partial frame was discarded and the error is latched.
        RC_ASSERT(re.hadError());
      }));
}

// ---------------------------------------------------------------------------
// Boundary anchors for Property 2 (plain Catch2). One concrete instance of
// each malformed category, asserting accept() returns Error and never Complete.
// ---------------------------------------------------------------------------
TEST_CASE("Property 2 boundary: each malformed category is rejected",
          "[ble][chunk][property][property-2][boundary]") {
  const std::vector<std::uint8_t> body{0x11, 0x22, 0x33};

  // (a) total == 0.
  {
    Reassembler re;
    const Chunk c = mkChunk(0, 0, body);
    REQUIRE(re.accept(c.data(), c.size()) == Reassembler::Status::Error);
    REQUIRE(re.hadError());
  }

  // (b) continuation with no in-flight start (lost/reordered start).
  {
    Reassembler re;
    const Chunk c = mkChunk(3, 1, body);
    REQUIRE(re.accept(c.data(), c.size()) == Reassembler::Status::Error);
    REQUIRE(re.hadError());
  }

  // (c) index >= total within an in-flight frame.
  {
    Reassembler re;
    const Chunk c0 = mkChunk(2, 0, body);
    const Chunk cBad = mkChunk(2, 5, body);
    REQUIRE(re.accept(c0.data(), c0.size()) == Reassembler::Status::NeedMore);
    REQUIRE(re.accept(cBad.data(), cBad.size()) == Reassembler::Status::Error);
    REQUIRE(re.hadError());
  }

  // (d) duplicate index.
  {
    Reassembler re;
    const Chunk c0 = mkChunk(3, 0, body);
    const Chunk c1 = mkChunk(3, 1, body);
    const Chunk c1dup = mkChunk(3, 1, body);
    REQUIRE(re.accept(c0.data(), c0.size()) == Reassembler::Status::NeedMore);
    REQUIRE(re.accept(c1.data(), c1.size()) == Reassembler::Status::NeedMore);
    REQUIRE(re.accept(c1dup.data(), c1dup.size()) ==
            Reassembler::Status::Error);
    REQUIRE(re.hadError());
  }

  // (e) inconsistent total across one in-flight frame.
  {
    Reassembler re;
    const Chunk c0 = mkChunk(3, 0, body);
    const Chunk cBad = mkChunk(2, 1, body);
    REQUIRE(re.accept(c0.data(), c0.size()) == Reassembler::Status::NeedMore);
    REQUIRE(re.accept(cBad.data(), cBad.size()) == Reassembler::Status::Error);
    REQUIRE(re.hadError());
  }
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
