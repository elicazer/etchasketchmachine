// Host-side unit tests for the credit-based FlowController (Task 4.3).
//
// Covers, per the task and Design §6.4 (Requirements 6.4, 6.5):
//   * onBeginDraw() returns COMMAND_BUFFER_SIZE (32) and resets state.
//   * Enqueuing up to the high-water mark (28) toggles the withholding latch.
//   * Consuming slots while above the high-water mark returns 0 credits until
//     occupancy drains to the low-water mark (16), then granting resumes.
//   * Steady-state behaviour grants CREDIT{1} per consumed slot.
//   * The capacity invariant `creditsOutstanding + occupancy <= 32` holds
//     across a long simulated enqueue/consume sequence, so the client can never
//     be granted credits that would overflow the 32-slot ring buffer.
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment in platformio.ini sets `test_build_src = no`, so
// this translation unit pulls the implementation in directly via relative
// include to keep the binary self-contained (matching test_crc16 / test_frame).
// FlowController is independent of CommandParser / WSServer, so this links into
// its own test binary with no other protocol sources.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstdint>

#include "../../src/protocol/flow_control.h"
#include "../../src/protocol/flow_control.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::COMMAND_BUFFER_HIGH_WATER;
using etch::COMMAND_BUFFER_LOW_WATER;
using etch::COMMAND_BUFFER_SIZE;
using etch::protocol::FlowController;

namespace {

// Convenience: the invariant that makes buffer overflow impossible.
bool capacityInvariantHolds(const FlowController& fc) {
  return static_cast<std::size_t>(fc.creditsOutstanding()) + fc.occupancy() <=
         COMMAND_BUFFER_SIZE;
}

}  // namespace

// ---------------------------------------------------------------------------
// onBeginDraw resets state and grants the full buffer capacity.

TEST_CASE("onBeginDraw returns 32 and resets state", "[flow]") {
  FlowController fc;

  const std::uint8_t initial = fc.onBeginDraw();

  REQUIRE(initial == static_cast<std::uint8_t>(COMMAND_BUFFER_SIZE));
  REQUIRE(initial == 32);
  REQUIRE(fc.occupancy() == 0);
  REQUIRE(fc.creditsOutstanding() == 32);
  REQUIRE_FALSE(fc.isWithholding());
  REQUIRE(capacityInvariantHolds(fc));
}

TEST_CASE("onBeginDraw re-grants full capacity after a prior session", "[flow]") {
  FlowController fc;
  fc.onBeginDraw();

  // Dirty the state: fill toward the high-water mark and partially drain.
  for (int i = 0; i < 20; ++i) {
    fc.onCommandEnqueued();
  }
  for (int i = 0; i < 5; ++i) {
    fc.onSlotConsumed();
  }
  REQUIRE(fc.occupancy() != 0);

  // A fresh BEGIN_DRAW must wipe occupancy, credits, and the latch.
  const std::uint8_t regranted = fc.onBeginDraw();
  REQUIRE(regranted == 32);
  REQUIRE(fc.occupancy() == 0);
  REQUIRE(fc.creditsOutstanding() == 32);
  REQUIRE_FALSE(fc.isWithholding());
}

// ---------------------------------------------------------------------------
// Enqueuing up to the high-water mark toggles the withholding latch.

TEST_CASE("enqueuing up to HIGH_WATER toggles withholding", "[flow]") {
  FlowController fc;
  fc.onBeginDraw();

  // One below the high-water mark: still granting.
  for (std::size_t i = 0; i < COMMAND_BUFFER_HIGH_WATER - 1; ++i) {
    fc.onCommandEnqueued();
    REQUIRE_FALSE(fc.isWithholding());
  }
  REQUIRE(fc.occupancy() == COMMAND_BUFFER_HIGH_WATER - 1);

  // The enqueue that reaches the high-water mark engages the latch.
  fc.onCommandEnqueued();
  REQUIRE(fc.occupancy() == COMMAND_BUFFER_HIGH_WATER);
  REQUIRE(fc.isWithholding());

  // Each enqueue spent exactly one outstanding credit; the invariant is
  // preserved throughout (occupancy + credits stays at 32).
  REQUIRE(fc.creditsOutstanding() ==
          static_cast<std::uint8_t>(COMMAND_BUFFER_SIZE -
                                    COMMAND_BUFFER_HIGH_WATER));
  REQUIRE(capacityInvariantHolds(fc));
}

// ---------------------------------------------------------------------------
// Consuming while above HIGH_WATER returns 0 until LOW_WATER, then resumes.

TEST_CASE("withholding holds off credits until occupancy reaches LOW_WATER",
          "[flow]") {
  FlowController fc;
  fc.onBeginDraw();

  // Fill the buffer completely (32 commands). The latch engaged at HIGH_WATER.
  for (std::size_t i = 0; i < COMMAND_BUFFER_SIZE; ++i) {
    fc.onCommandEnqueued();
  }
  REQUIRE(fc.occupancy() == COMMAND_BUFFER_SIZE);
  REQUIRE(fc.creditsOutstanding() == 0);
  REQUIRE(fc.isWithholding());

  // Drain one slot at a time. Every consume that leaves occupancy strictly
  // above the low-water mark must grant 0 (credits withheld).
  while (fc.occupancy() > COMMAND_BUFFER_LOW_WATER + 1) {
    const std::uint8_t granted = fc.onSlotConsumed();
    REQUIRE(granted == 0);
    REQUIRE(fc.isWithholding());
    REQUIRE(capacityInvariantHolds(fc));
  }

  // occupancy is now LOW_WATER + 1. The next consume lands exactly on the
  // low-water mark, releases the latch, and emits a refill burst that restores
  // the window to full capacity without exceeding it.
  REQUIRE(fc.occupancy() == COMMAND_BUFFER_LOW_WATER + 1);
  const std::uint8_t resumeGrant = fc.onSlotConsumed();
  REQUIRE(fc.occupancy() == COMMAND_BUFFER_LOW_WATER);
  REQUIRE_FALSE(fc.isWithholding());
  REQUIRE(resumeGrant > 0);
  // Burst restores creditsOutstanding + occupancy back to exactly capacity.
  REQUIRE(static_cast<std::size_t>(fc.creditsOutstanding()) + fc.occupancy() ==
          COMMAND_BUFFER_SIZE);
  REQUIRE(capacityInvariantHolds(fc));
}

TEST_CASE("steady state grants one credit per consumed slot", "[flow]") {
  FlowController fc;
  fc.onBeginDraw();

  // Stay well below the high-water mark so the latch never engages.
  for (int i = 0; i < 10; ++i) {
    fc.onCommandEnqueued();
  }
  REQUIRE_FALSE(fc.isWithholding());
  REQUIRE(fc.occupancy() == 10);

  const std::uint8_t creditsBefore = fc.creditsOutstanding();
  const std::uint8_t granted = fc.onSlotConsumed();

  REQUIRE(granted == 1);
  REQUIRE(fc.occupancy() == 9);
  REQUIRE(fc.creditsOutstanding() == creditsBefore + 1);
  REQUIRE(capacityInvariantHolds(fc));
}

TEST_CASE("onSlotConsumed on an empty buffer grants nothing", "[flow]") {
  FlowController fc;
  fc.onBeginDraw();

  REQUIRE(fc.occupancy() == 0);
  REQUIRE(fc.onSlotConsumed() == 0);
  REQUIRE(fc.occupancy() == 0);
  REQUIRE(capacityInvariantHolds(fc));
}

// ---------------------------------------------------------------------------
// Capacity invariant across a long simulated enqueue/consume sequence.
//
// Models a real client + ring buffer driven only through the public API:
//   * the client sends a command only when it holds a credit (mirrors the
//     credit gate); each send pushes into a reference buffer and calls
//     onCommandEnqueued().
//   * the planner consumes a slot whenever the reference buffer is non-empty;
//     any credits returned by onSlotConsumed() are handed back to the client.
// The assertions prove the client can NEVER be granted credits that would let
// the reference buffer exceed the 32-slot capacity.

TEST_CASE("capacity invariant holds across a simulated enqueue/consume run",
          "[flow]") {
  FlowController fc;
  std::uint32_t clientCredits = fc.onBeginDraw();
  std::size_t referenceBuffer = 0;  // the "real" ring buffer occupancy

  // Reproducible pseudo-random driver (LCG) — no external RNG needed so this
  // compiles against the host_test framework and the compile-check stub alike.
  std::uint32_t rng = 0xC0FFEEu;
  auto nextBit = [&rng]() -> bool {
    rng = rng * 1664525u + 1013904223u;
    return (rng >> 17) & 1u;
  };

  for (int step = 0; step < 100000; ++step) {
    const bool canEnqueue = clientCredits > 0;
    const bool canConsume = referenceBuffer > 0;

    bool doEnqueue;
    if (canEnqueue && canConsume) {
      doEnqueue = nextBit();
    } else if (canEnqueue) {
      doEnqueue = true;
    } else if (canConsume) {
      doEnqueue = false;
    } else {
      continue;  // neither possible (cannot happen after BEGIN_DRAW)
    }

    if (doEnqueue) {
      // The client spends a credit and pushes a command into the real buffer.
      --clientCredits;
      ++referenceBuffer;
      fc.onCommandEnqueued();
    } else {
      // The planner frees a slot; returned credits go back to the client.
      --referenceBuffer;
      clientCredits += fc.onSlotConsumed();
    }

    // Core safety property: the real buffer never overflows its 32 slots.
    REQUIRE(referenceBuffer <= COMMAND_BUFFER_SIZE);

    // The controller's accounting tracks the real buffer exactly, and the
    // capacity invariant that guarantees the above always holds.
    REQUIRE(fc.occupancy() == referenceBuffer);
    REQUIRE(static_cast<std::size_t>(fc.creditsOutstanding()) + fc.occupancy() <=
            COMMAND_BUFFER_SIZE);

    // The controller and the client agree on how many credits are outstanding.
    REQUIRE(fc.creditsOutstanding() == clientCredits);
  }
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
