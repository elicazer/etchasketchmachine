// Drawing_Command parser + validator (Design §3.2.4, §4.3).
//
// This is the per-command half of the protocol layer: it turns a raw 16-byte
// CMD payload (carried inside a §4.5 frame) into a validated
// `etch::DrawingCommand`, classifying every input into exactly one of four
// outcomes (see ParseResult). It owns NO state — no sequence tracking, no
// retransmission counting, no flow-control credits, no CTL handling. Those live
// in sibling tasks (4.2 retransmission, 4.3 flow control, 4.4 CTL parser); this
// translation unit stays a pure, host-testable function.
//
// Validation order (Design §4.3, Req 6.7, 7.3):
//   1. Structural   : payload length must be exactly 16 bytes, else NackParse.
//   2. Decode       : read the little-endian fields into `out` (endian-safe).
//   3. Integrity    : recompute CRC-16/CCITT over bytes [0..14) and compare
//                     with the transmitted CRC at offset 14. Mismatch => RetxCrc
//                     (the firmware answers with RETX_REQUEST {seq}).
//   4. Range        : only after CRC passes — feed_sps ∈ [FEED_SPS_MIN,
//                     FEED_SPS_MAX], no undefined flag bits, reserved == 0.
//                     Any failure => NackRange.
//   5. Accept       : ParseResult::Ok with `out` fully populated.
//
// The header is Arduino-include-free so it compiles under `platform = native`
// for the host Catch2 tests as well as the Arduino target. The parser itself is
// platform-independent; there are no Arduino dependencies to guard.
//
// References:
//   - Requirement 6.7 (range rejection without enqueue)
//   - Requirement 7.3 (CRC mismatch => retransmission request)
//   - Design §3.2.4 (CommandParser), §4.3 (Drawing_Command wire format),
//     §4.5 (NACK reason codes)

#pragma once

#include <cstddef>
#include <cstdint>

#include "../types.h"

namespace etch {
namespace protocol {

// Outcome of parsing a single Drawing_Command payload. Exactly one of these is
// returned per call; the caller maps each to a wire response:
//
//   Ok        -> ACK {seq}              and enqueue the command
//   NackParse -> NACK {seq, reason=Parse}    (structural / length error)
//   NackRange -> NACK {seq, reason=Range}    (a field is out of range)
//   RetxCrc   -> RETX_REQUEST {seq}          (CRC mismatch; ask for resend)
//
// On NackParse the payload may be too short to recover a trustworthy `seq`, so
// callers should treat `out.seq` as meaningful only for the Range/Crc/Ok cases
// (it is still decoded when the 16 bytes are present).
enum class ParseResult : std::uint8_t {
  Ok,
  NackParse,
  NackRange,
  RetxCrc,
};

// Wire reason codes carried in the one-byte `reason` field of a NACK payload
// (`{ u32 seq, u8 reason }`, Design §4.5). The full enumeration is
// {0x01 PARSE, 0x02 CRC, 0x03 RANGE, 0x04 BUFFER_FULL, 0x05 NOT_READY,
// 0x06 ENVELOPE_REQUIRED, 0x07 ENVELOPE_HOME_NOT_SET, 0x08 ENVELOPE_INVALID,
// 0x09 JOG_TRAVEL_CAP}; the two reasons this parser can emit (PARSE, RANGE) are
// named here so the dispatch layer and the browser-side decoder agree on the
// byte values. (BUFFER_FULL / NOT_READY and the envelope/jog reasons 0x06–0x09
// are raised elsewhere — flow control, calibration gating, and the visual
// corner calibration envelope checks — and CRC errors map to RETX_REQUEST
// rather than a NACK, so 0x02 is reserved here for completeness and not
// produced by parseDrawingCommand.) These byte values are wire-stable; existing
// codes must never be renumbered.
enum class NackReason : std::uint8_t {
  Parse              = 0x01,
  Crc                = 0x02,
  Range              = 0x03,
  BufferFull         = 0x04,
  NotReady           = 0x05,
  // Visual corner calibration envelope gating (visual-corner-calibration spec):
  EnvelopeRequired   = 0x06,  // a draw/move was attempted before an envelope was set
  EnvelopeHomeNotSet = 0x07,  // envelope operation requires home to be established first
  EnvelopeInvalid    = 0x08,  // supplied envelope is malformed / degenerate / out of bounds
  JogTravelCap       = 0x09,  // jog rejected: would exceed the per-jog travel cap
};

// Parse and validate a single Drawing_Command payload.
//
// `payload` points at the `len`-byte CMD body (the frame envelope has already
// been stripped by the framing layer). On ParseResult::Ok, `out` is fully
// populated with the decoded fields. On NackRange/RetxCrc, `out` still holds the
// decoded fields (so the caller can read `out.seq` to address its response). On
// NackParse the input was structurally invalid and `out` is left unspecified.
//
// The decode is performed byte-by-byte with explicit shifts, so the result is
// independent of the host's endianness and does not rely on struct packing.
ParseResult parseDrawingCommand(const std::uint8_t* payload, std::size_t len,
                                DrawingCommand& out);

}  // namespace protocol
}  // namespace etch
