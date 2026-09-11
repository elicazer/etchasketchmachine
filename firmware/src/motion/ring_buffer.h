// Single-producer / single-consumer (SPSC) lock-free ring buffer (Task 6.5).
//
// This is the 32-deep command queue that sits between the protocol layer
// (the producer, running in the cooperative main loop) and the motion
// planner's GPT timer ISR (the consumer). The producer pushes decoded
// DrawingCommand records; the ISR pops them one at a time to feed the
// Bresenham / ramp stepper. Capacity is fixed at COMMAND_BUFFER_SIZE (32)
// from src/types.h (Requirement 6.4); push() returns false when full so the
// protocol layer can withhold credit / emit NACK{BUFFER_FULL} (Requirement
// 6.5, Design Property 7).
//
// Concurrency model (why this is lock-free and correct without CAS):
//
//   The UNO R4 WiFi's RA4M1 is a single-core Cortex-M4. There is exactly one
//   producer (main loop) and exactly one consumer (the GPT timer ISR). On a
//   single core an ISR cannot run concurrently with the main loop -- it
//   strictly preempts it -- so there is never true simultaneous access to the
//   same word. The only hazard is a torn or stale read across the
//   preemption boundary. We avoid that with the classic SPSC discipline:
//
//     * The producer ONLY writes `tail_` and ONLY reads `head_`.
//     * The consumer ONLY writes `head_` and ONLY reads `tail_`.
//
//   Because each index has a single writer, and 32-bit aligned loads/stores
//   are atomic on Cortex-M, no compare-and-swap and no critical section is
//   needed. The indices are marked `volatile` so the compiler always emits a
//   real load/store at the preemption boundary (the Arduino-idiomatic way to
//   share a word between an ISR and the main loop) rather than caching the
//   value in a register. The slot itself is written before `tail_` is
//   advanced and read before `head_` is advanced, so a popped element is
//   always fully published, and a pushed element is never observed before its
//   payload is in place.
//
//   This header is Arduino/native dual-target: it has no Arduino includes,
//   uses only <cstdint>/<cstddef>, and lives in namespace etch::motion so the
//   host Catch2 tests can exercise it with `int` elements while the firmware
//   instantiates it with DrawingCommand.
//
// Capacity representation: we use the "one slot reserved" scheme -- the
// backing array has CAPACITY + 1 physical slots and the buffer is full when
// advancing `tail_` would collide with `head_`. This keeps `head_ == tail_`
// as the unambiguous empty condition, so each index still has a single writer
// (a separate `count_` would be written by both sides and break the SPSC
// guarantee). The buffer still holds the full 32 logical elements.
//
// References:
//   - Requirements 6.4 (32-deep buffer), 6.5 (flow control / push fails full)
//   - Design §3.2.5 (MotionPlanner pulls from the 32-deep ring buffer)
//   - Design §6.4 (credit-based flow control), Property 7 (bounded FIFO)

#pragma once

#include <cstddef>
#include <cstdint>

#include "../types.h"

namespace etch {
namespace motion {

// Lock-free SPSC ring buffer with a compile-time fixed logical capacity.
//
// Template parameters:
//   T        - element type (DrawingCommand in firmware, int in host tests).
//              Must be trivially assignable for the slot copy to be safe to do
//              outside any lock; DrawingCommand and int both satisfy this.
//   Capacity - number of logical elements the buffer can hold. Defaults to
//              COMMAND_BUFFER_SIZE (32) per Requirement 6.4.
template <typename T, std::size_t Capacity = COMMAND_BUFFER_SIZE>
class RingBuffer {
 public:
  static_assert(Capacity > 0, "RingBuffer capacity must be positive");

  RingBuffer() = default;

  // Non-copyable / non-movable: the buffer owns shared state that is read and
  // written across the ISR/main-loop boundary, so copying it makes no sense.
  RingBuffer(const RingBuffer&) = delete;
  RingBuffer& operator=(const RingBuffer&) = delete;

  // --- Producer side (main loop) -----------------------------------------
  // Append `value` to the back of the queue. Returns false (without modifying
  // the buffer) when the queue already holds Capacity elements. Only ever
  // writes tail_ and reads head_, so it is safe against a concurrent pop().
  bool push(const T& value) {
    const std::size_t tail = tail_;             // sole writer: plain read ok
    const std::size_t next = advance(tail);
    if (next == head_) {
      return false;                             // full: do not overwrite
    }
    slots_[tail] = value;                       // publish payload first ...
    tail_ = next;                               // ... then advance tail_
    return true;
  }

  // --- Consumer side (ISR) -----------------------------------------------
  // Remove the front element into `out`. Returns false (leaving `out`
  // untouched) when the queue is empty. Only ever writes head_ and reads
  // tail_, so it is safe against a concurrent push().
  bool pop(T& out) {
    const std::size_t head = head_;             // sole writer: plain read ok
    if (head == tail_) {
      return false;                             // empty
    }
    out = slots_[head];                         // read payload first ...
    head_ = advance(head);                      // ... then advance head_
    return true;
  }

  // --- Observers ----------------------------------------------------------
  // empty()/full()/size()/freeSlots() take a consistent snapshot of both
  // indices. Each is exact when called from the side that owns the relevant
  // index; called from the opposite side the result is a conservative,
  // monotonic-safe estimate (the true occupancy can only have grown for the
  // consumer or shrunk for the producer), which is exactly what flow-control
  // high/low-water checks need.
  bool empty() const { return head_ == tail_; }

  bool full() const { return advance(tail_) == head_; }

  std::size_t size() const {
    const std::size_t head = head_;
    const std::size_t tail = tail_;
    if (tail >= head) {
      return tail - head;
    }
    return PHYSICAL_SLOTS - head + tail;
  }

  std::size_t freeSlots() const { return Capacity - size(); }

  // Logical capacity (Requirement 6.4 == 32). Compile-time constant exposed as
  // a method to match the MotionPlanner-facing API.
  std::size_t capacity() const { return Capacity; }

 private:
  // One physical slot is reserved to disambiguate full from empty, so the
  // backing array is one larger than the logical capacity.
  static constexpr std::size_t PHYSICAL_SLOTS = Capacity + 1;

  static std::size_t advance(std::size_t index) {
    // Single increment with wrap. PHYSICAL_SLOTS is small and not generally a
    // power of two (33 by default), so a modulo-free branch is used.
    const std::size_t next = index + 1;
    return (next == PHYSICAL_SLOTS) ? 0 : next;
  }

  T slots_[PHYSICAL_SLOTS] = {};

  // Shared indices. `volatile` forces a real memory access at the ISR / main
  // loop boundary on the single-core RA4M1. head_ is written only by the
  // consumer; tail_ is written only by the producer. 32-bit aligned access is
  // atomic on Cortex-M, so no CAS or critical section is required.
  volatile std::size_t head_ = 0;  // consumer writes, producer reads
  volatile std::size_t tail_ = 0;  // producer writes, consumer reads
};

}  // namespace motion
}  // namespace etch
