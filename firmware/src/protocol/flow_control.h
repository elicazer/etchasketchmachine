// Credit-based flow controller (Design §6.4, Requirements 6.4, 6.5).
//
// This is the flow-control half of the protocol layer. It decides WHEN the
// firmware hands the browser permission ("credits") to send more
// Drawing_Commands so the 32-deep SPSC ring buffer (Design §3.2.5, §6.5) stays
// fed without ever overflowing. It owns NO transport: no sockets, no framing,
// no sequence tracking, no CRC. The dispatch layer turns the return values into
// CREDIT frames ({ u8 n }, Design §4.5 type 0x21). The class is a pure,
// host-testable state machine with no Arduino dependencies.
//
// ---------------------------------------------------------------------------
// The credit model
// ---------------------------------------------------------------------------
// A "credit" is permission for the client to put exactly one more command into
// the buffer. The client must hold a credit to send a command. The controller
// tracks two counters and one latch:
//
//   occupancy            slots currently filled in the ring buffer
//                        (commands enqueued but not yet consumed by the
//                        motion planner). Incremented by onCommandEnqueued(),
//                        decremented by onSlotConsumed().
//
//   creditsOutstanding   credits granted to the client that it has not yet
//                        spent — i.e. the number of additional commands the
//                        client may still send right now.
//
//   withholding          hysteresis latch (see below).
//
// The central safety invariant, true after every public call, is:
//
//       creditsOutstanding + occupancy <= COMMAND_BUFFER_SIZE (32)
//
// Read it as: the most the client can drive the buffer to is what is already
// filled (occupancy) plus what it is still allowed to send (creditsOutstanding).
// Keeping that sum at or below the 32-slot capacity makes overflow impossible.
//
// onBeginDraw() grants the empty buffer's full capacity (32 credits), so the
// invariant starts at equality (0 + 32 == 32). Thereafter every enqueue moves
// one unit from creditsOutstanding to occupancy (the sum is preserved), and
// every grant on a consumed slot is capped so the sum never climbs past 32.
//
// ---------------------------------------------------------------------------
// The hysteresis (anti-thrash) latch
// ---------------------------------------------------------------------------
// To avoid emitting/withholding credits on every single slot as occupancy
// hovers near the limit, credit emission is gated by a two-watermark latch
// (Design §6.4):
//
//   * ENTER withholding when occupancy >= COMMAND_BUFFER_HIGH_WATER (28).
//     Checked as occupancy rises in onCommandEnqueued().
//   * EXIT  withholding when occupancy <= COMMAND_BUFFER_LOW_WATER (16).
//     Checked as occupancy falls in onSlotConsumed().
//
// Between the two marks the latch holds its current state, so the controller
// does not flip-flop. While withholding, onSlotConsumed() returns 0 even as
// slots free up; credits are simply not granted (they are NOT accrued as a
// debt). Once occupancy drains to the low-water mark the latch releases and
// onSlotConsumed() resumes emitting CREDIT{1} per consumed slot.
//
// References:
//   - Requirement 6.4 (buffer up to 32 commands for continuous motion)
//   - Requirement 6.5 (signal the client to pause when the buffer is full)
//   - Design §6.4 (withhold CREDIT at high-water 28, resume at low-water 16)

#pragma once

#include <cstdint>

#include "../types.h"

namespace etch {
namespace protocol {

// Credit-based flow controller for the 32-deep command ring buffer.
//
// Usage sketch (driven by the dispatch layer / motion planner):
//
//   FlowController fc;
//   uint8_t n = fc.onBeginDraw();        // emit CREDIT{n} (== 32)
//   ...
//   // a CMD frame was validated and pushed into the ring buffer:
//   fc.onCommandEnqueued();
//   ...
//   // the motion planner finished a command and freed a slot:
//   uint8_t grant = fc.onSlotConsumed(); // if grant > 0, emit CREDIT{grant}
//
// All counters are bytes; the buffer capacity (32) and watermarks fit easily,
// so no overflow is possible.
class FlowController {
 public:
  FlowController() = default;

  // Reset all state for a fresh drawing session and return the initial credit
  // grant. The buffer is empty, so the client is granted the full capacity
  // (COMMAND_BUFFER_SIZE == 32). Corresponds to "Send initial CREDIT {n:32} on
  // BEGIN_DRAW" (Requirement 6.4). After this call: occupancy == 0,
  // creditsOutstanding == 32, isWithholding() == false.
  std::uint8_t onBeginDraw();

  // Notify the controller that a validated command was accepted into the ring
  // buffer (occupancy increases by one). The client spends one outstanding
  // credit. If occupancy reaches the high-water mark the withholding latch is
  // engaged. Occupancy is never allowed to exceed COMMAND_BUFFER_SIZE.
  void onCommandEnqueued();

  // Notify the controller that the motion planner consumed (freed) one buffer
  // slot (occupancy decreases by one). Returns the number of NEW credits to
  // emit to the client right now:
  //   * 0 if the buffer was already empty (nothing to consume),
  //   * 0 while withholding and occupancy is still above the low-water mark,
  //   * a one-time refill burst (>= 1) on the call that drains occupancy to the
  //     low-water mark, sized to restore creditsOutstanding + occupancy back to
  //     COMMAND_BUFFER_SIZE without exceeding it,
  //   * otherwise 1 in steady state (CREDIT{1} per consumed slot),
  //   * 0 if granting would break the capacity invariant.
  // Crossing down to the low-water mark releases the withholding latch.
  std::uint8_t onSlotConsumed();

  // Number of filled slots in the ring buffer as tracked by this controller.
  std::uint8_t occupancy() const { return occupancy_; }

  // True while credit emission is latched off (between an occupancy >=
  // HIGH_WATER event and the subsequent drain to <= LOW_WATER).
  bool isWithholding() const { return withholding_; }

  // Credits granted to the client that it has not yet spent — the number of
  // additional commands the client may send right now.
  std::uint8_t creditsOutstanding() const { return credits_outstanding_; }

 private:
  std::uint8_t occupancy_ = 0;
  std::uint8_t credits_outstanding_ = 0;
  bool withholding_ = false;
};

}  // namespace protocol
}  // namespace etch
