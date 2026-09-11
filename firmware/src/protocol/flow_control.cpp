// Credit-based flow controller implementation.
//
// See flow_control.h for the full credit model, the capacity invariant
//
//     creditsOutstanding + occupancy <= COMMAND_BUFFER_SIZE (32)
//
// and the two-watermark hysteresis latch. The logic here is deliberately tiny
// and branch-explicit so it can be reasoned about (and host-tested) directly.

#include "flow_control.h"

namespace etch {
namespace protocol {

std::uint8_t FlowController::onBeginDraw() {
  // Empty buffer => grant its full capacity. The client may send up to 32
  // commands before it must wait for a slot to free. Invariant holds at
  // equality: 0 (occupancy) + 32 (credits) == 32 (capacity).
  occupancy_ = 0;
  withholding_ = false;
  credits_outstanding_ = static_cast<std::uint8_t>(COMMAND_BUFFER_SIZE);
  return credits_outstanding_;
}

void FlowController::onCommandEnqueued() {
  // A validated command landed in the ring buffer: one filled slot, one spent
  // credit. The cap is a defensive guard; the capacity invariant guarantees a
  // legitimately credited client never drives occupancy past the buffer size.
  if (occupancy_ < static_cast<std::uint8_t>(COMMAND_BUFFER_SIZE)) {
    ++occupancy_;
  }
  if (credits_outstanding_ > 0) {
    --credits_outstanding_;
  }

  // Engage the latch as occupancy rises into the high-water zone (Design §6.4).
  if (occupancy_ >= static_cast<std::uint8_t>(COMMAND_BUFFER_HIGH_WATER)) {
    withholding_ = true;
  }
}

std::uint8_t FlowController::onSlotConsumed() {
  // Nothing buffered => nothing was consumed, nothing to grant.
  if (occupancy_ == 0) {
    return 0;
  }

  const bool was_withholding = withholding_;
  --occupancy_;

  if (was_withholding) {
    // While the latch is engaged, freed slots earn no credit (no debt is
    // remembered) UNTIL occupancy drains to the low-water mark. The client's
    // send queue stays stalled in the meantime (Design §6.4).
    if (occupancy_ > static_cast<std::uint8_t>(COMMAND_BUFFER_LOW_WATER)) {
      return 0;
    }

    // Reached the low-water mark: release the latch and refill the window back
    // toward capacity in one CREDIT burst. The grant is the deficit needed to
    // restore creditsOutstanding + occupancy to COMMAND_BUFFER_SIZE, so the
    // outstanding credits never exceed the buffer's free space and the capacity
    // invariant is restored to equality. This is the >1 "resume" grant; steady
    // state below stays at 1 per slot.
    withholding_ = false;
    const std::size_t window = static_cast<std::size_t>(credits_outstanding_) +
                               occupancy_;
    const std::uint8_t grant =
        static_cast<std::uint8_t>(COMMAND_BUFFER_SIZE - window);
    credits_outstanding_ =
        static_cast<std::uint8_t>(credits_outstanding_ + grant);
    return grant;
  }

  // Steady state: grant exactly one credit for the freed slot (CREDIT{1} per
  // consumed slot, Requirement 6.5), but never let outstanding credits plus
  // current occupancy exceed the buffer capacity. Because a slot was just
  // freed, the sum is at most 31 here, so a single grant restores it to at most
  // 32 (the invariant ceiling).
  if (static_cast<std::size_t>(credits_outstanding_) + occupancy_ <
      COMMAND_BUFFER_SIZE) {
    ++credits_outstanding_;
    return 1;
  }
  return 0;
}

}  // namespace protocol
}  // namespace etch
