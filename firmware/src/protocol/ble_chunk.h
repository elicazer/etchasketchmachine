// BLE MTU chunking / reassembly — the pure, transport-internal fragmenting
// core that splits a complete §4.5 Frame_Envelope into BLE-notification-sized
// pieces and reassembles them back into the exact original bytes (Design §3.6,
// §4.3).
//
// This layer lives ONLY between `BleSocket` (browser) and `BleServer`
// (firmware): once a frame is reassembled, the bytes handed up to `FrameCodec`
// / `WireClient` contain no chunk metadata, so the protocol layer is byte-for-
// byte identical across the BLE and WiFi builds (Req 4.2, 5.3, 13.3).
//
// Chunk wire format (Design §4.3):
//
//   Offset  Size  Field   Notes
//   ------  ----  ------  -----------------------------------------------
//     0      1   hdr     bits[7:4] = total_chunks (1..15)
//                        bits[3:0] = chunk_index  (0..total-1)
//     1      N   body    slice of the Frame_Envelope bytes
//
//   reassemble(fragment(frame, body)) == frame   (round-trip identity, Req 5.3)
//
// The 4/4-bit split supports up to 15 chunks per frame. With a negotiated MTU
// giving even ~100-byte bodies, 15 chunks cover 1500 bytes — well beyond any
// frame this protocol produces (`HELLO` ~33 bytes, `STATUS` 20 bytes). Any
// frame that would require more than 15 chunks is unrepresentable: `fragment`
// refuses to produce it and the reassembler treats it as unrecoverable
// (Req 5.5).
//
// This translation unit is intentionally Arduino-include-free: it pulls in
// nothing beyond the standard library, so `fragment()` and `Reassembler` can be
// compiled and exhaustively property-tested on the host (`platform = native`)
// and reused verbatim inside `BleServer` on the Arduino target.
//
// References:
//   - Requirements 5.2 (incremental chunking), 5.3 (exact reassembly),
//     5.5 (unrecoverable-error signalling on malformed sequences)
//   - Design §3.6 (chunking/reassembly), §4.3 (BLE chunk layout)

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

namespace etch {
namespace protocol {

// ---------------------------------------------------------------------------
// Chunk format constants (Design §4.3)
// ---------------------------------------------------------------------------

// Size of the 1-byte chunk micro-header.
inline constexpr std::size_t BLE_CHUNK_HEADER_SIZE = 1;

// Maximum number of chunks per frame representable by the 4-bit total field.
inline constexpr std::uint8_t BLE_CHUNK_MAX_CHUNKS = 15;

// Largest body slice `fragment` will place in a single chunk. A BLE attribute
// value tops out at 512 bytes; the usable notification payload is
// `negotiatedMtu - 3 (ATT) - 1 (chunk hdr)`, so a body never exceeds this.
inline constexpr std::size_t BLE_CHUNK_MAX_BODY = 512;

// Largest Frame_Envelope the reassembler will buffer. Comfortably exceeds every
// frame this protocol emits (the §4.5 parse buffer is only 256 bytes); a
// sequence whose reassembled length would exceed this is rejected as
// unrecoverable (Req 5.5). Keeps the per-session reassembly state bounded.
inline constexpr std::size_t BLE_REASSEMBLY_CAPACITY = 2048;

// ---------------------------------------------------------------------------
// Chunk header pack / unpack (pure helpers)
// ---------------------------------------------------------------------------

// Pack a `(total, index)` pair into the 1-byte chunk header. `total` occupies
// bits[7:4], `index` occupies bits[3:0]; callers are responsible for ensuring
// `1 <= total <= 15` and `index < total` (only the low nibble of each is used).
inline constexpr std::uint8_t encodeChunkHeader(std::uint8_t total, std::uint8_t index) {
  return static_cast<std::uint8_t>(((total & 0x0F) << 4) | (index & 0x0F));
}

// Extract `total` (bits[7:4]) and `index` (bits[3:0]) from a chunk header byte.
inline constexpr std::uint8_t chunkHeaderTotal(std::uint8_t hdr) {
  return static_cast<std::uint8_t>((hdr >> 4) & 0x0F);
}
inline constexpr std::uint8_t chunkHeaderIndex(std::uint8_t hdr) {
  return static_cast<std::uint8_t>(hdr & 0x0F);
}

// ---------------------------------------------------------------------------
// fragment()
// ---------------------------------------------------------------------------

// Outcome of a fragment() call.
enum class FragmentStatus {
  Ok,             // chunks were emitted in index order
  EmptyFrame,     // frameLen == 0: nothing to fragment, no chunks emitted
  InvalidBody,    // bodySize == 0 or bodySize > BLE_CHUNK_MAX_BODY
  TooManyChunks,  // ceil(frameLen / bodySize) > 15 — unrepresentable (Req 5.5)
};

// Sink invoked once per chunk, in ascending index order, with the complete
// chunk bytes (1-byte header followed by the body slice). The pointer aliases
// internal scratch storage and is valid ONLY for the duration of the call; a
// sink that needs the bytes afterwards must copy them (e.g. the firmware sink
// issues a BLE notify, the browser sink issues a GATT write).
using ChunkSink = std::function<void(const std::uint8_t* chunk, std::size_t len)>;

// Slice `frame[0..frameLen)` into `ceil(frameLen / bodySize)` ordered chunks and
// hand each to `sink`. Chunks 0..total-2 carry exactly `bodySize` body bytes;
// the final chunk carries the remainder (1..bodySize bytes). Returns:
//   * Ok            on success (chunks emitted),
//   * EmptyFrame    if frameLen == 0 (a frame needs at least one chunk),
//   * InvalidBody   if bodySize is 0 or exceeds BLE_CHUNK_MAX_BODY,
//   * TooManyChunks if the slice count would exceed 15 (Req 5.5).
// On any non-Ok status no chunks are emitted. A null `frame` with frameLen > 0
// is treated as EmptyFrame (nothing is read).
FragmentStatus fragment(const std::uint8_t* frame, std::size_t frameLen,
                        std::size_t bodySize, const ChunkSink& sink);

// ---------------------------------------------------------------------------
// Reassembler
// ---------------------------------------------------------------------------

// Stateful inverse of fragment(): feed received chunks one at a time and, when
// the in-flight frame's full index set has arrived, recover the exact original
// Frame_Envelope bytes (Req 5.3).
//
// New-frame detection. A chunk with index 0 marks the start of a frame (the
// single ordered notify pipe preserves global frame ordering, Design §3.3). A
// frame completes when every index 0..total-1 has been received; the bodies are
// concatenated in index order to reproduce the original frame.
//
// Unrecoverable failures (Req 5.5) — the in-flight partial frame is discarded,
// a transmit error is latched (hadError()), accept() returns Error, and NO
// frame is emitted for that sequence:
//   * an index-0 chunk arrives while the current frame is still incomplete
//     ("incomplete set when a new-frame chunk starts"),
//   * a non-index-0 chunk arrives with no frame in flight (lost frame start),
//   * a chunk's `total` differs from the in-flight frame's `total`
//     (inconsistent total),
//   * a duplicate index arrives,
//   * an index >= total arrives,
//   * total == 0, or the reassembled length would exceed BLE_REASSEMBLY_CAPACITY,
//   * a malformed chunk (null / missing header) arrives.
// After an error the reassembler discards its partial state and is ready to
// begin a fresh frame on the next index-0 chunk (the sender retransmits the
// whole frame, Req 5.5). `total > 15` cannot be encoded in the 4-bit field and
// is enforced at fragment() time.
class Reassembler {
 public:
  // Result of feeding one chunk.
  enum class Status {
    NeedMore,  // chunk accepted; the frame is not yet complete
    Complete,  // frame fully reassembled — see frame() / frameLen()
    Error,     // unrecoverable failure — partial frame discarded (Req 5.5)
  };

  Reassembler() = default;

  // Feed one received chunk (1-byte header + body). See class docs for the
  // completeness and failure rules.
  Status accept(const std::uint8_t* chunk, std::size_t chunkLen);

  // Pointer to / length of the most recently completed frame. Valid only
  // immediately after accept() returns Complete.
  const std::uint8_t* frame() const { return out_; }
  std::size_t frameLen() const { return out_len_; }

  // True iff the most recent accept() discarded a partial frame due to an
  // unrecoverable failure. Cleared by reset() and when a fresh frame begins.
  bool hadError() const { return error_; }

  // Discard any in-flight partial frame and clear the error latch.
  void reset();

 private:
  // Drop in-flight partial state (keeps the last completed `out_`).
  void discard();

  // ---- in-flight frame state ----
  bool         in_flight_   = false;
  std::uint8_t total_       = 0;  // expected chunk count for the in-flight frame
  std::uint8_t received_    = 0;  // count of distinct indices received so far
  std::uint16_t mask_       = 0;  // received-index bitmask (one bit per index)
  std::size_t  off_[BLE_CHUNK_MAX_CHUNKS] = {0};  // staging offset per index
  std::size_t  len_[BLE_CHUNK_MAX_CHUNKS] = {0};  // body length per index
  std::uint8_t staging_[BLE_REASSEMBLY_CAPACITY] = {0};  // bodies in arrival order
  std::size_t  staging_len_ = 0;

  // ---- last completed frame ----
  std::uint8_t out_[BLE_REASSEMBLY_CAPACITY] = {0};
  std::size_t  out_len_ = 0;

  bool error_ = false;
};

}  // namespace protocol
}  // namespace etch
