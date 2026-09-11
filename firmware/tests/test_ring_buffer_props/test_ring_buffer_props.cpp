// Host-side property tests for the SPSC command ring buffer (Task 6.6).
//
// Property 7: Command buffer is a bounded FIFO with flow control
// (Design §7, §3.2.5, §6.4).
//
//   *For any* sequence of `push` / `pop` operations on the 32-slot SPSC ring
//   buffer, the buffer's occupancy never exceeds 32; the order in which
//   commands are popped equals the order in which they were successfully
//   pushed. *For any* push that would exceed capacity, the push returns false
//   and no element is added (the protocol layer turns that into
//   NACK{BUFFER_FULL}). When buffer occupancy reaches the high-water mark (28)
//   the protocol layer ceases emitting CREDIT increments; when it drains to
//   the low-water mark (16), CREDIT emission resumes.
//
//   Validates: Requirements 6.4, 6.5.
//
// Scope of THIS test (the FIFO half of Property 7):
//
//   RingBuffer<T, Capacity> (firmware/src/motion/ring_buffer.h) is the bounded
//   FIFO itself. It deliberately exposes NO credit / watermark logic: the
//   high-water (28) / low-water (16) hysteresis that decides WHEN to emit
//   CREDIT frames lives in the FlowController state machine
//   (src/protocol/flow_control.h) and is exercised by test_flow_control/.
//   This file therefore proves the invariants the ring buffer is actually
//   responsible for -- bounded capacity, strict FIFO ordering, exact
//   occupancy/free-slot accounting, and the full/empty boundary behaviour --
//   which are precisely the signals the flow controller reads. The final
//   watermark TEST_CASE only asserts that size() reports occupancy *exactly*
//   as it crosses the 28 and 16 thresholds, i.e. that the FIFO feeds the flow
//   controller correct numbers; the credit decisions themselves are not
//   re-tested here.
//
// The core property is a model-based test: an arbitrary sequence of
// push(value) / pop operations is replayed in lockstep against a reference
// std::deque oracle. After every operation the buffer must agree with the
// model on the dequeued value (FIFO), the accept/reject outcome (capacity),
// and the size/free-slot/empty/full accounting.
//
// This translation unit lives in its own PlatformIO test directory
// (test_ring_buffer_props/) so it is compiled and linked into a standalone
// test binary, separate from test_ring_buffer/. It therefore supplies its own
// `int main`. RingBuffer is a header-only template, so it is pulled in via a
// relative include of ring_buffer.h and instantiated with `int` elements here
// (the firmware-facing RingBuffer<DrawingCommand> instantiation is
// type-checked in ring_buffer.cpp). The host_test environment uses
// `test_build_src = no`, so this stays self-contained.
//
// The properties are exercised with rapidcheck via the standalone rc::check
// form invoked from inside Catch2 TEST_CASEs (mirroring test_nvm_props/ and
// test_command_parser_props/). rc::check returns true on success; wrapping it
// in REQUIRE means a failing property (with rapidcheck's shrunk counterexample
// on stderr) surfaces as a Catch2 failure.
//
// Run with:
//
//     pio test -e host_test
//
// (PlatformIO pins Catch2 v3.5.3 and rapidcheck for the host_test env; see
// platformio.ini.)

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstddef>
#include <deque>
#include <vector>

#include "../../src/types.h"
#include "../../src/motion/ring_buffer.h"

using etch::COMMAND_BUFFER_HIGH_WATER;
using etch::COMMAND_BUFFER_LOW_WATER;
using etch::COMMAND_BUFFER_SIZE;
using etch::motion::RingBuffer;

namespace {

// Upper bound on the length of a generated operation sequence. Comfortably
// larger than the 32-slot capacity so a random push/pop stream both fills the
// buffer (exercising the full-rejection path) and wraps the physical indices
// many times.
constexpr int kMaxOps = 256;

// Small capacity used by the wrap-around property so the head/tail indices
// cross the physical-array boundary densely within a short sequence.
constexpr std::size_t kSmallCap = 5;

// Sentinel written into the pop out-param before each pop so the "pop on an
// empty buffer leaves out untouched" clause can be asserted directly.
constexpr int kSentinel = -987654321;

// A single modelled operation: either push(value) or pop. `value` is unused
// for Pop.
enum class OpKind { Push, Pop };
struct Op {
  OpKind kind;
  int value;
};

// Generate one operation sequence inside an active rapidcheck context (so the
// rc::gen draws are recorded and shrinkable). Pushes are favoured ~2:1 over
// pops so the buffer reliably fills to capacity and the full-rejection path is
// exercised; pop-heavy prefixes still occur, exercising pop-on-empty. Push
// payloads are arbitrary ints -- comparing each popped value position-by-
// position against the deque makes any reordering of distinct values a
// failure, so FIFO order is checked strictly.
std::vector<Op> genOps() {
  const int n = *rc::gen::inRange<int>(0, kMaxOps + 1);  // [0, kMaxOps]
  std::vector<Op> ops;
  ops.reserve(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    const bool is_push = (*rc::gen::inRange<int>(0, 3) != 0);  // ~2/3 push
    if (is_push) {
      ops.push_back({OpKind::Push, *rc::gen::arbitrary<int>()});
    } else {
      ops.push_back({OpKind::Pop, 0});
    }
  }
  return ops;
}

// Replay `ops` against a RingBuffer<int, Cap> and a std::deque<int> reference
// model, asserting Property 7's FIFO / bounded-capacity / accounting clauses
// after every operation. Templated on Cap because the logical capacity is a
// compile-time template parameter of RingBuffer. Intended to be called from
// inside an rc::check property (uses RC_ASSERT).
template <std::size_t Cap>
void replayAgainstModel(const std::vector<Op>& ops) {
  RingBuffer<int, Cap> buf;
  std::deque<int> model;  // front() == the element a correct pop must return

  for (const Op& op : ops) {
    if (op.kind == OpKind::Push) {
      const bool accepted = buf.push(op.value);
      if (model.size() < Cap) {
        // Room available: push must succeed and the element joins the back.
        RC_ASSERT(accepted);
        model.push_back(op.value);
      } else {
        // Buffer full: push must return false and must NOT add an element.
        // (Contents are left intact -- verified by the continuing FIFO
        // comparison on subsequent pops and the size check below.)
        RC_ASSERT(!accepted);
      }
    } else {  // OpKind::Pop
      int out = kSentinel;
      const bool got = buf.pop(out);
      if (!model.empty()) {
        // Non-empty: pop must succeed and return the FIFO front element.
        RC_ASSERT(got);
        RC_ASSERT(out == model.front());
        model.pop_front();
      } else {
        // Empty: pop must report empty and leave the out-param untouched.
        RC_ASSERT(!got);
        RC_ASSERT(out == kSentinel);
      }
    }

    // Accounting invariants, exact in this single-threaded replay:
    RC_ASSERT(buf.size() == model.size());          // tracks the model
    RC_ASSERT(buf.size() <= Cap);                    // never exceeds capacity
    RC_ASSERT(buf.size() + buf.freeSlots() == Cap);  // size + free == capacity
    RC_ASSERT(buf.empty() == model.empty());
    RC_ASSERT(buf.full() == (model.size() == Cap));
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 7 (core): an arbitrary push/pop sequence on the 32-slot buffer is a
// bounded FIFO -- occupancy never exceeds 32, pop order equals push order,
// full pushes are rejected without adding, empty pops report empty, and the
// size/free-slot/empty/full accounting is always consistent with the model.
// ---------------------------------------------------------------------------
TEST_CASE("Property 7: 32-slot ring buffer is a bounded FIFO vs deque model",
          "[ring][property][property-7]") {
  REQUIRE(rc::check(
      "arbitrary push/pop sequence matches a std::deque FIFO reference (cap 32)",
      [] {
        // Capacity is the production COMMAND_BUFFER_SIZE (32) per Req 6.4.
        static_assert(COMMAND_BUFFER_SIZE == 32u,
                      "Property 7 assumes the 32-deep command buffer");
        const std::vector<Op> ops = genOps();
        replayAgainstModel<COMMAND_BUFFER_SIZE>(ops);
      }));
}

// ---------------------------------------------------------------------------
// Property 7 (wrap-around): the same FIFO / accounting invariants hold across
// many physical-index wraps. A small capacity makes the head and tail cross
// the backing array boundary densely, so this stresses the modulo/advance
// logic that the 32-slot test wraps only occasionally.
// ---------------------------------------------------------------------------
TEST_CASE("Property 7: FIFO invariants survive dense ring-boundary wrap-around",
          "[ring][property][property-7]") {
  REQUIRE(rc::check(
      "arbitrary push/pop sequence matches the deque model across wraps (cap 5)",
      [] { replayAgainstModel<kSmallCap>(genOps()); }));
}

// ---------------------------------------------------------------------------
// Boundary anchors (plain Catch2). These pin the exact edges named in Property
// 7 with concrete sequences; the comprehensive example-based coverage lives in
// test_ring_buffer/.
// ---------------------------------------------------------------------------

TEST_CASE("Property 7 boundary: fill to exactly 32, then the 33rd push fails",
          "[ring][property][property-7][boundary]") {
  RingBuffer<int> buf;  // defaults to COMMAND_BUFFER_SIZE (32)
  const std::size_t cap = buf.capacity();
  REQUIRE(cap == 32u);

  // Fill to exactly capacity; every push up to 32 succeeds.
  for (std::size_t i = 0; i < cap; ++i) {
    REQUIRE(buf.push(static_cast<int>(i)));
  }
  REQUIRE(buf.full());
  REQUIRE(buf.size() == cap);
  REQUIRE(buf.freeSlots() == 0u);

  // The 33rd push must fail and must not perturb occupancy or contents.
  REQUIRE_FALSE(buf.push(9999));
  REQUIRE(buf.size() == cap);
  REQUIRE(buf.full());
}

TEST_CASE("Property 7 boundary: drain fully preserves FIFO and reports empty",
          "[ring][property][property-7][boundary]") {
  RingBuffer<int> buf;
  const std::size_t cap = buf.capacity();

  for (std::size_t i = 0; i < cap; ++i) {
    REQUIRE(buf.push(static_cast<int>(i) * 7 + 1));
  }
  // Dequeue order equals enqueue order, all the way down.
  for (std::size_t i = 0; i < cap; ++i) {
    int out = kSentinel;
    REQUIRE(buf.pop(out));
    REQUIRE(out == static_cast<int>(i) * 7 + 1);
  }
  REQUIRE(buf.empty());
  REQUIRE(buf.size() == 0u);
  REQUIRE(buf.freeSlots() == cap);

  // Pop on the now-empty buffer reports empty and leaves out untouched.
  int out = kSentinel;
  REQUIRE_FALSE(buf.pop(out));
  REQUIRE(out == kSentinel);
}

// ---------------------------------------------------------------------------
// Property 7 (flow-control bridge): the ring buffer's size() reports occupancy
// EXACTLY as it passes through the high-water (28) and low-water (16) marks the
// flow controller compares against. This only asserts that the FIFO supplies
// the correct occupancy signal -- the CREDIT withhold/resume hysteresis itself
// lives in FlowController (src/protocol/flow_control.h) and is covered by
// test_flow_control/, not duplicated here.
// ---------------------------------------------------------------------------
TEST_CASE("Property 7: size() reports occupancy exactly at the 28/16 watermarks",
          "[ring][property][property-7][watermark]") {
  static_assert(COMMAND_BUFFER_HIGH_WATER == 28u, "Design §6.4 high-water");
  static_assert(COMMAND_BUFFER_LOW_WATER == 16u, "Design §6.4 low-water");
  static_assert(COMMAND_BUFFER_HIGH_WATER <= COMMAND_BUFFER_SIZE,
                "high-water must fit within capacity");
  static_assert(COMMAND_BUFFER_LOW_WATER < COMMAND_BUFFER_HIGH_WATER,
                "low-water must be below high-water for hysteresis");

  RingBuffer<int> buf;

  // Rising edge: size() reads exactly the high-water value as we fill past it,
  // and the buffer is not yet full at the high-water mark.
  for (std::size_t i = 0; i < COMMAND_BUFFER_SIZE; ++i) {
    REQUIRE(buf.push(static_cast<int>(i)));
    REQUIRE(buf.size() == i + 1);
    if (buf.size() == COMMAND_BUFFER_HIGH_WATER) {
      REQUIRE_FALSE(buf.full());  // high-water (28) < capacity (32)
      REQUIRE(buf.freeSlots() == COMMAND_BUFFER_SIZE - COMMAND_BUFFER_HIGH_WATER);
    }
  }
  REQUIRE(buf.size() == COMMAND_BUFFER_SIZE);

  // Falling edge: size() reads exactly the low-water value as we drain through
  // it, with free slots accounted consistently.
  for (std::size_t i = 0; i < COMMAND_BUFFER_SIZE; ++i) {
    int out = 0;
    REQUIRE(buf.pop(out));
    if (buf.size() == COMMAND_BUFFER_LOW_WATER) {
      REQUIRE(buf.freeSlots() == COMMAND_BUFFER_SIZE - COMMAND_BUFFER_LOW_WATER);
      REQUIRE_FALSE(buf.empty());
    }
  }
  REQUIRE(buf.empty());
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
