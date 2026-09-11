// Host-side unit tests for the SPSC command ring buffer (Task 6.5).
//
// Validates the FIFO / bounded-capacity / flow-control accounting contract of
// RingBuffer<T, Capacity> from firmware/src/motion/ring_buffer.h against
// Requirements 6.4 (32-deep buffer) and 6.5 (push fails when full).
//
// Run with:
//     pio test -e host_test
//
// The host_test environment uses `test_build_src = no`, so this translation
// unit pulls in the (header-only) ring buffer directly via a relative include.
// The buffer is exercised with `int` elements here -- the firmware-facing
// RingBuffer<DrawingCommand> instantiation is type-checked in ring_buffer.cpp.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <vector>

#include "../../src/motion/ring_buffer.h"

using etch::motion::RingBuffer;
using etch::COMMAND_BUFFER_SIZE;

namespace {

// A small, explicit capacity used by the wraparound stress test so the
// ring-boundary crossings are dense and easy to reason about.
constexpr std::size_t kSmallCap = 4;

}  // namespace

TEST_CASE("capacity() reports the fixed 32-slot depth", "[ring][capacity]") {
  RingBuffer<int> buf;  // defaults to COMMAND_BUFFER_SIZE
  REQUIRE(buf.capacity() == 32u);
  REQUIRE(buf.capacity() == COMMAND_BUFFER_SIZE);
}

TEST_CASE("a fresh buffer is empty, not full, and all slots free",
          "[ring][accounting]") {
  RingBuffer<int> buf;
  REQUIRE(buf.empty());
  REQUIRE_FALSE(buf.full());
  REQUIRE(buf.size() == 0u);
  REQUIRE(buf.freeSlots() == buf.capacity());

  int out = -1;
  REQUIRE_FALSE(buf.pop(out));   // pop on empty returns false ...
  REQUIRE(out == -1);            // ... and leaves the out param untouched
}

TEST_CASE("push/pop preserve FIFO order over many elements", "[ring][fifo]") {
  RingBuffer<int> buf;
  const int n = static_cast<int>(buf.capacity());

  for (int i = 0; i < n; ++i) {
    REQUIRE(buf.push(i * 7 + 1));
  }
  for (int i = 0; i < n; ++i) {
    int out = 0;
    REQUIRE(buf.pop(out));
    REQUIRE(out == i * 7 + 1);   // dequeued in the exact order enqueued
  }
  REQUIRE(buf.empty());
}

TEST_CASE("push returns false when full; pop returns false when empty",
          "[ring][bounds]") {
  RingBuffer<int> buf;
  const std::size_t cap = buf.capacity();

  // Fill to exactly 32 elements.
  for (std::size_t i = 0; i < cap; ++i) {
    REQUIRE(buf.push(static_cast<int>(i)));
  }
  REQUIRE(buf.full());
  REQUIRE(buf.size() == cap);
  REQUIRE(buf.freeSlots() == 0u);

  // The 33rd push must fail and must not perturb occupancy or the FIFO head.
  REQUIRE_FALSE(buf.push(9999));
  REQUIRE(buf.size() == cap);
  REQUIRE(buf.full());

  // Drain completely; the rejected element must never appear.
  for (std::size_t i = 0; i < cap; ++i) {
    int out = -1;
    REQUIRE(buf.pop(out));
    REQUIRE(out == static_cast<int>(i));
  }
  REQUIRE(buf.empty());

  int out = -1;
  REQUIRE_FALSE(buf.pop(out));   // pop on empty returns false
  REQUIRE(out == -1);
}

TEST_CASE("size/freeSlots/full/empty track through a fill and drain",
          "[ring][accounting]") {
  RingBuffer<int> buf;
  const std::size_t cap = buf.capacity();

  for (std::size_t i = 0; i < cap; ++i) {
    REQUIRE(buf.size() == i);
    REQUIRE(buf.freeSlots() == cap - i);
    REQUIRE(buf.empty() == (i == 0));
    REQUIRE_FALSE(buf.full());
    REQUIRE(buf.push(static_cast<int>(i)));
  }
  REQUIRE(buf.full());
  REQUIRE(buf.size() == cap);
  REQUIRE(buf.freeSlots() == 0u);

  for (std::size_t i = 0; i < cap; ++i) {
    REQUIRE(buf.size() == cap - i);
    REQUIRE(buf.freeSlots() == i);
    REQUIRE_FALSE(buf.empty());
    REQUIRE(buf.full() == (i == 0));
    int out = 0;
    REQUIRE(buf.pop(out));
  }
  REQUIRE(buf.empty());
  REQUIRE(buf.size() == 0u);
  REQUIRE(buf.freeSlots() == cap);
}

TEST_CASE("wraparound stays FIFO across many ring-boundary crossings",
          "[ring][wraparound]") {
  // Small capacity so the head/tail indices wrap repeatedly. Fill, drain a
  // partial amount, refill, and keep crossing the physical boundary while a
  // reference std::vector predicts the exact dequeue order.
  RingBuffer<int, kSmallCap> buf;
  REQUIRE(buf.capacity() == kSmallCap);

  std::vector<int> model;  // mirrors the logical contents, front == next pop
  int next_value = 0;

  auto do_push = [&](int times) {
    for (int i = 0; i < times; ++i) {
      const bool accepted = buf.push(next_value);
      if (model.size() < kSmallCap) {
        REQUIRE(accepted);
        model.push_back(next_value);
        ++next_value;
      } else {
        REQUIRE_FALSE(accepted);  // full: push rejected, model unchanged
      }
    }
  };

  auto do_pop = [&](int times) {
    for (int i = 0; i < times; ++i) {
      int out = -1;
      const bool got = buf.pop(out);
      if (!model.empty()) {
        REQUIRE(got);
        REQUIRE(out == model.front());
        model.erase(model.begin());
      } else {
        REQUIRE_FALSE(got);
      }
      REQUIRE(buf.size() == model.size());
    }
  };

  // Many uneven push/pop bursts so head and tail wrap independently.
  for (int round = 0; round < 50; ++round) {
    do_push(3);
    do_pop(2);
    do_push(2);
    do_pop(1);
    do_push(4);  // includes attempts that overflow the 4-slot buffer
    do_pop(3);
    REQUIRE(buf.size() == model.size());
    REQUIRE(buf.empty() == model.empty());
    REQUIRE(buf.full() == (model.size() == kSmallCap));
  }

  // Drain whatever remains and confirm strict FIFO to the end.
  do_pop(static_cast<int>(model.size()) + 1);
  REQUIRE(buf.empty());
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
