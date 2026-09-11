// Sequence tracking + bounded retransmission state machine implementation
// (Task 4.2).
//
// See sequence_tracker.h for the full contract, counting semantics, and the
// references to Requirements 7.3 / 7.7, Design §5.6, and Design Property 9.
//
// This translation unit is Arduino-include-free and depends only on the
// standard fixed-width integer types, so it links cleanly into the host-side
// Catch2 / rapidcheck test binaries as well as the firmware target.

#include "sequence_tracker.h"

namespace etch {
namespace protocol {

RetxAction SequenceTracker::onValidCommand(std::uint32_t seq) {
  // Duplicate detection under the monotonic-seq contract: any valid command
  // whose seq is <= the last acked seq has already been applied, so re-ACK it
  // idempotently without touching state and WITHOUT re-enqueuing (Req 7.3,
  // Design Property 9). The unrecoverable latch is intentionally left alone.
  if (has_acked_ && seq <= last_acked_seq_) {
    return RetxAction::DuplicateAck;
  }

  // First acceptance of this seq: record it as the new high-water acked seq.
  has_acked_      = true;
  last_acked_seq_ = seq;

  // A successful delivery resolves any retransmission in flight for this exact
  // seq, so clear its counter (the CRC error and its eventual good copy share
  // the same seq under the in-order protocol).
  if (has_failing_ && failing_seq_ == seq) {
    has_failing_   = false;
    failing_count_ = 0;
  }

  return RetxAction::Ack;
}

RetxAction SequenceTracker::onCrcError(std::uint32_t seq) {
  // Once the transmission has been declared unrecoverable the caller keeps
  // drawing paused; further CRC errors neither advance the counter nor produce
  // another RETX_REQUEST. They simply re-report the latched state so the caller
  // never issues a 4th-plus retransmission for the seq (Req 7.7).
  if (unrecoverable_) {
    return RetxAction::Unrecoverable;
  }

  // Account this CRC error against the failing seq. Under the in-order protocol
  // only one seq can be mid-retransmission at a time; a CRC error for a
  // different seq replaces the tracked one and restarts its counter.
  if (has_failing_ && failing_seq_ == seq) {
    ++failing_count_;
  } else {
    has_failing_   = true;
    failing_seq_   = seq;
    failing_count_ = 1;
  }

  // While the counter is within the budget (attempts 1..MAX_RETRANSMISSIONS)
  // ask the client to resend. The would-be (MAX_RETRANSMISSIONS + 1)th failure
  // crosses the budget: latch unrecoverable and report it exactly once on this
  // transition (subsequent calls take the early-return above).
  if (failing_count_ <= MAX_RETRANSMISSIONS) {
    return RetxAction::RequestRetx;
  }

  unrecoverable_ = true;
  return RetxAction::Unrecoverable;
}

std::uint8_t SequenceTracker::retxCount(std::uint32_t seq) const {
  if (has_failing_ && failing_seq_ == seq) {
    return failing_count_;
  }
  return 0;
}

void SequenceTracker::reset() {
  has_acked_      = false;
  last_acked_seq_ = 0;
  has_failing_    = false;
  failing_seq_    = 0;
  failing_count_  = 0;
  unrecoverable_  = false;
}

}  // namespace protocol
}  // namespace etch
