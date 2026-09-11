// Sequence tracking + bounded retransmission state machine (Task 4.2).
//
// This is the reliability bookkeeping that sits *above* the CommandParser
// (task 4.1) on the Controller's inbound CMD path. The parser decides whether a
// given Drawing_Command frame is valid (CRC ok + range ok), a CRC error, or a
// range/parse error; this module turns that per-frame verdict into the wire
// action the WebSocket server must take, while tracking how many times a single
// sequence number has been retransmitted.
//
// It is deliberately decoupled from CommandParser and WSServer: the caller
// signals the parse outcome by calling onValidCommand()/onCrcError() and acts on
// the returned RetxAction (emit ACK / RETX_REQUEST / ERROR{UNRECOVERABLE_TX}).
// That keeps this a pure, host-testable state machine with no Arduino, socket,
// or parser dependencies, so it links cleanly into its own Catch2 binary.
//
// Counting semantics (Req 7.3 "up to a maximum of 3 retransmission attempts",
// Req 7.7, Design §5.6 error table "4th retransmission failure on a single
// seq"):
//
//   * Each CRC error observed for a sequence number `s` increments that seq's
//     retransmission counter.
//   * While the counter is <= MAX_RETRANSMISSIONS (3) the tracker returns
//     RequestRetx, i.e. the Controller emits RETX_REQUEST{seq:s}. The tracker
//     therefore issues *at most three* RETX_REQUESTs for any one seq.
//   * The failure that would be the 4th attempt (counter == 4, i.e. it now
//     EXCEEDS MAX_RETRANSMISSIONS) returns Unrecoverable exactly once: the
//     Controller emits ERROR{kind:UNRECOVERABLE_TX, seq:s} and pauses drawing.
//
//   CRC error #:   1     2     3     4
//   counter:       1     2     3     4
//   action:      RETX  RETX  RETX  UNRECOVERABLE   (then latched)
//
// Duplicate handling (Req 7.3, Design Property 9 "duplicate arrivals of an
// already-applied seq produce idempotent ACKs"): a valid command whose seq was
// already acked returns DuplicateAck so the caller re-ACKs without re-enqueuing
// the command into the motion buffer.
//
// References:
//   - Requirements 7.3 (bounded retransmission), 7.7 (unrecoverable -> pause)
//   - Design §3.2.3 / §3.2.4 (parser + transport split), §5.6 (error table)
//   - Design Property 9 (reliable delivery with bounded retransmission)

#pragma once

#include <cstdint>

namespace etch {
namespace protocol {

// Maximum number of retransmission *requests* issued for a single sequence
// number before the transmission is declared unrecoverable (Req 7.3).
inline constexpr std::uint8_t MAX_RETRANSMISSIONS = 3;

// The action the caller must take after signalling a parse outcome. Mapped by
// the WebSocket server to a §4.5 frame:
//   Ack          -> ACK{seq}                            (enqueue the command)
//   RequestRetx  -> RETX_REQUEST{seq}                   (ask client to resend)
//   Unrecoverable-> ERROR{kind:UNRECOVERABLE_TX, seq}   (pause drawing, Req 7.7)
//   DuplicateAck -> ACK{seq}                            (idempotent; do NOT
//                                                        re-enqueue, Req 7.3)
enum class RetxAction : std::uint8_t {
  Ack          = 0,
  RequestRetx  = 1,
  Unrecoverable = 2,
  DuplicateAck = 3,
};

// Tracks per-sequence retransmission state for the single active drawing
// session. Not thread-safe; it is driven from the cooperative main loop only.
//
// Duplicate detection model: sequence numbers issued by the Path Planner's
// toCommands() are monotonically non-decreasing, and the planner does not
// consume any command past a gap until the gap is filled (Design Property 9).
// The tracker therefore records the last acked seq and treats any later valid
// command whose seq is <= the last acked seq as a duplicate. This is O(1) in
// SRAM (no per-seq set) and exact under the monotonic-seq contract.
class SequenceTracker {
 public:
  SequenceTracker() = default;

  // Signal that a command with sequence `seq` passed CRC *and* range checks.
  //   * If `seq` was already acked -> returns DuplicateAck and changes no
  //     state (idempotent ACK; the caller must NOT re-enqueue the command).
  //   * Otherwise -> records `seq` as acked, clears any retransmission counter
  //     being tracked for `seq`, and returns Ack.
  // Does not clear the unrecoverable latch; only reset() does.
  RetxAction onValidCommand(std::uint32_t seq);

  // Signal that a CRC error was observed for sequence `seq`. Increments that
  // seq's retransmission counter and returns:
  //   * RequestRetx   while counter <= MAX_RETRANSMISSIONS (attempts 1..3), or
  //   * Unrecoverable on the counter == MAX_RETRANSMISSIONS + 1 failure (the
  //     would-be 4th attempt), latching isUnrecoverable() true.
  // Once latched, every further onCrcError() keeps returning Unrecoverable
  // without incrementing further.
  RetxAction onCrcError(std::uint32_t seq);

  // Latched true once onCrcError() has returned Unrecoverable for any seq, so
  // the caller keeps drawing paused until reset() is called (e.g. FAULT_RESET
  // or a new session). Req 7.7.
  bool isUnrecoverable() const { return unrecoverable_; }

  // Current retransmission counter for `seq` (0 if `seq` is not the seq
  // currently failing CRC). For tests/diagnostics.
  std::uint8_t retxCount(std::uint32_t seq) const;

  // Clear all state: acked history, the active retransmission counter, and the
  // unrecoverable latch. Used at the start of a new session or on fault reset.
  void reset();

 private:
  // Last acked sequence number and whether anything has been acked yet.
  bool          has_acked_      = false;
  std::uint32_t last_acked_seq_ = 0;

  // The seq currently failing CRC and its retransmission counter. Only one seq
  // can be mid-retransmission at a time under the in-order protocol; a CRC
  // error for a different seq replaces the tracked one (its counter restarts).
  bool          has_failing_    = false;
  std::uint32_t failing_seq_    = 0;
  std::uint8_t  failing_count_  = 0;

  // Latched once Unrecoverable is returned; cleared only by reset().
  bool unrecoverable_ = false;
};

}  // namespace protocol
}  // namespace etch
