// BLE chunking / reassembly implementation. See ble_chunk.h for the wire
// format (Design §4.3), the round-trip identity guarantee (Req 5.3), and the
// unrecoverable-failure rules (Req 5.5).
//
// Fully platform-independent (Arduino-free): compiled on both the Arduino
// target inside `BleServer` and the `platform = native` host, where it is
// property-tested directly.

#include "ble_chunk.h"

#include <cstring>

namespace etch {
namespace protocol {

// ---------------------------------------------------------------------------
// fragment()
// ---------------------------------------------------------------------------

FragmentStatus fragment(const std::uint8_t* frame, std::size_t frameLen,
                        std::size_t bodySize, const ChunkSink& sink) {
  if (frameLen == 0 || frame == nullptr) {
    // A frame needs at least one chunk; there is nothing to slice.
    return FragmentStatus::EmptyFrame;
  }
  if (bodySize == 0 || bodySize > BLE_CHUNK_MAX_BODY) {
    return FragmentStatus::InvalidBody;
  }

  // total = ceil(frameLen / bodySize).
  const std::size_t total = (frameLen + bodySize - 1) / bodySize;
  if (total > BLE_CHUNK_MAX_CHUNKS) {
    // Unrepresentable in the 4-bit total field (Req 5.5): refuse to emit.
    return FragmentStatus::TooManyChunks;
  }

  // Emit chunks in ascending index order. Each chunk = 1-byte header + body
  // slice. Scratch holds one header byte followed by up to bodySize body bytes.
  std::uint8_t scratch[BLE_CHUNK_HEADER_SIZE + BLE_CHUNK_MAX_BODY];
  std::size_t offset = 0;
  for (std::size_t index = 0; index < total; ++index) {
    const std::size_t remaining = frameLen - offset;
    const std::size_t n = (remaining < bodySize) ? remaining : bodySize;

    scratch[0] = encodeChunkHeader(static_cast<std::uint8_t>(total),
                                   static_cast<std::uint8_t>(index));
    std::memcpy(scratch + BLE_CHUNK_HEADER_SIZE, frame + offset, n);
    if (sink) {
      sink(scratch, BLE_CHUNK_HEADER_SIZE + n);
    }
    offset += n;
  }
  return FragmentStatus::Ok;
}

// ---------------------------------------------------------------------------
// Reassembler
// ---------------------------------------------------------------------------

void Reassembler::reset() {
  in_flight_ = false;
  total_ = 0;
  received_ = 0;
  mask_ = 0;
  staging_len_ = 0;
  error_ = false;
}

void Reassembler::discard() {
  // Drop the in-flight partial frame but keep the last completed `out_`.
  in_flight_ = false;
  total_ = 0;
  received_ = 0;
  mask_ = 0;
  staging_len_ = 0;
}

Reassembler::Status Reassembler::accept(const std::uint8_t* chunk, std::size_t chunkLen) {
  // A valid chunk is at least a header byte (the body may legitimately be
  // empty only when fragment never produces it; we still accept >= header).
  if (chunk == nullptr || chunkLen < BLE_CHUNK_HEADER_SIZE) {
    discard();
    error_ = true;
    return Status::Error;
  }

  const std::uint8_t hdr = chunk[0];
  const std::uint8_t total = chunkHeaderTotal(hdr);
  const std::uint8_t index = chunkHeaderIndex(hdr);
  const std::uint8_t* body = chunk + BLE_CHUNK_HEADER_SIZE;
  const std::size_t bodyLen = chunkLen - BLE_CHUNK_HEADER_SIZE;

  // total == 0 is malformed (every frame has >= 1 chunk). total > 15 cannot be
  // encoded in the 4-bit field, but guard defensively.
  if (total == 0 || total > BLE_CHUNK_MAX_CHUNKS) {
    discard();
    error_ = true;
    return Status::Error;
  }

  if (index == 0) {
    // A new frame begins. If a previous frame is still in flight, its set was
    // never completed before a new start arrived — unrecoverable (Req 5.5).
    if (in_flight_) {
      discard();
      error_ = true;
      return Status::Error;
    }
    // Begin a fresh frame; clear any prior error latch.
    in_flight_ = true;
    error_ = false;
    total_ = total;
    received_ = 0;
    mask_ = 0;
    staging_len_ = 0;
  } else {
    // A continuation chunk with no frame in flight means the index-0 start was
    // lost — unrecoverable (Req 5.5).
    if (!in_flight_) {
      error_ = true;
      return Status::Error;
    }
    // The total must be consistent across all chunks of one in-flight frame.
    if (total != total_) {
      discard();
      error_ = true;
      return Status::Error;
    }
  }

  // index must be addressable within the declared total.
  if (index >= total_) {
    discard();
    error_ = true;
    return Status::Error;
  }

  // Duplicate index within the in-flight frame is unrecoverable (Req 5.5).
  const std::uint16_t bit = static_cast<std::uint16_t>(1u << index);
  if (mask_ & bit) {
    discard();
    error_ = true;
    return Status::Error;
  }

  // Stage the body bytes in arrival order, remembering where each index landed
  // so the final concatenation can run in index order.
  if (staging_len_ + bodyLen > BLE_REASSEMBLY_CAPACITY) {
    discard();
    error_ = true;
    return Status::Error;
  }
  off_[index] = staging_len_;
  len_[index] = bodyLen;
  if (bodyLen > 0) {
    std::memcpy(staging_ + staging_len_, body, bodyLen);
    staging_len_ += bodyLen;
  }

  mask_ |= bit;
  ++received_;

  // Not all indices present yet.
  if (received_ < total_) {
    return Status::NeedMore;
  }

  // Complete: concatenate bodies in ascending index order into `out_`.
  std::size_t outLen = 0;
  for (std::uint8_t i = 0; i < total_; ++i) {
    const std::size_t n = len_[i];
    if (n > 0) {
      std::memcpy(out_ + outLen, staging_ + off_[i], n);
      outLen += n;
    }
  }
  out_len_ = outLen;

  // Frame delivered; clear in-flight state so the next index-0 begins anew.
  in_flight_ = false;
  total_ = 0;
  received_ = 0;
  mask_ = 0;
  staging_len_ = 0;
  error_ = false;
  return Status::Complete;
}

}  // namespace protocol
}  // namespace etch
