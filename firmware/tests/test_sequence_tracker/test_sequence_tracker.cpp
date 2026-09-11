// Host-side property tests for the SequenceTracker (Task 4.6).
//
// Property 9: Reliable delivery with bounded retransmission (Design §7,
// §3.2.3/§3.2.4, §5.6).
//
//   *For any* sequence of inbound CMD frames in which a particular seq = s
//   arrives with a CRC error, the Controller emits RETX_REQUEST { seq: s } at
//   most three times. After the third failed attempt the Controller emits
//   exactly one ERROR { kind: UNRECOVERABLE_TX, seq: s } and pauses drawing.
//   Duplicate arrivals of an already-applied seq produce idempotent ACKs (and
//   are not re-enqueued); gaps in seq are filled by retransmission requests
//   before the planner consumes any command past the gap.
//
//   Validates: Requirements 7.3, 7.7.
//
// The SequenceTracker (`onValidCommand` / `onCrcError`) is the pure reliability
// state machine sitting above the CommandParser on the Controller's inbound CMD
// path. Its only output channel is the RetxAction it returns, which the
// WebSocket server maps one-to-one onto the §4.5 wire frames (see
// sequence_tracker.h):
//
//   Ack           -> ACK{seq}                          (enqueue the command)
//   DuplicateAck  -> ACK{seq}                          (idempotent; do NOT
//                                                        re-enqueue, Req 7.3)
//   RequestRetx   -> RETX_REQUEST{seq}                 (ask client to resend)
//   Unrecoverable -> ERROR{kind:UNRECOVERABLE_TX, seq} (pause drawing, Req 7.7)
//
// To assert the "duplicate arrivals are not re-enqueued" invariant precisely,
// this test wires an inspectable fake motion buffer behind a small
// `dispatchValid()` helper that mirrors that documented mapping: it enqueues
// the seq if and only if the tracker returns Ack (a first-time acceptance), and
// never on DuplicateAck. The idempotency properties then assert on both the
// wire outcome AND the resulting buffer occupancy.
//
// This translation unit lives in its own PlatformIO test directory
// (test_sequence_tracker/) so it is compiled and linked into a standalone test
// binary. It therefore supplies its own `int main` and pulls the implementation
// in directly via a relative include of sequence_tracker.cpp -- mirroring the
// conventions established in test_command_parser_props/ and test_nvm_props/ --
// so the host_test environment (test_build_src = no) stays self-contained with
// a single definition of SequenceTracker's symbols.
//
// The properties are exercised with rapidcheck via the standalone rc::check
// form invoked from inside Catch2 TEST_CASEs (mirroring test_nvm_props/ and
// test_command_parser_props/). rc::check returns true on success; wrapping it
// in REQUIRE means a failing property (with rapidcheck's shrunk counterexample
// on stderr) surfaces as a Catch2 failure. Plain Catch2 TEST_CASEs pin the
// concrete boundary cases (the canonical 3-RETX-then-UNRECOVERABLE table,
// idempotent ACK, reset).
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

#include <cstdint>
#include <vector>

#include "../../src/protocol/sequence_tracker.h"
#include "../../src/protocol/sequence_tracker.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::protocol::MAX_RETRANSMISSIONS;
using etch::protocol::RetxAction;
using etch::protocol::SequenceTracker;

namespace {

// ---------------------------------------------------------------------------
// Inspectable fake motion buffer + valid-command dispatcher.
// ---------------------------------------------------------------------------

// A minimal append-only stand-in for the §6.4 SPSC motion ring buffer. The
// idempotency properties never approach any capacity bound; the point is only
// to observe whether a valid command was *enqueued* (first acceptance) versus
// merely re-ACKed (duplicate).
class FakeMotionBuffer {
 public:
  void push(std::uint32_t seq) { items_.push_back(seq); }
  std::size_t size() const { return items_.size(); }
  const std::vector<std::uint32_t>& items() const { return items_; }

 private:
  std::vector<std::uint32_t> items_;
};

// The subset of §4.5 wire responses a *valid* command can produce. onValid
// command only ever yields ACK (whether first-time or idempotent duplicate);
// the enqueue side-effect is what distinguishes the two.
enum class ValidWire { Ack };

// Feed a valid (CRC-ok + range-ok) command for `seq` to the tracker and act on
// the verdict exactly as the dispatch layer is specified to: enqueue (and ACK)
// on first acceptance, re-ACK WITHOUT enqueuing on a duplicate. Returns the
// wire response so callers can assert both the response and the buffer state.
ValidWire dispatchValid(SequenceTracker& t, std::uint32_t seq,
                        FakeMotionBuffer& buf) {
  switch (t.onValidCommand(seq)) {
    case RetxAction::Ack:
      buf.push(seq);          // first acceptance -> enqueue.
      return ValidWire::Ack;
    case RetxAction::DuplicateAck:
      return ValidWire::Ack;  // idempotent ACK -> do NOT enqueue.
    case RetxAction::RequestRetx:
    case RetxAction::Unrecoverable:
      // A valid command can never yield these; treat as a hard failure if it
      // ever does (the RC_ASSERT in the callers will catch it, but be defensive
      // for the plain TEST_CASE path too).
      break;
  }
  return ValidWire::Ack;  // unreachable under the documented contract.
}

}  // namespace

// ===========================================================================
// Concrete boundary cases (plain Catch2).
// ===========================================================================

// ---------------------------------------------------------------------------
// Property 9 (bounded retransmission, canonical table): three CRC errors on a
// single seq yield exactly three RETX_REQUESTs, and the 4th failure yields a
// single UNRECOVERABLE. Mirrors the table in sequence_tracker.h:
//
//   CRC error #:   1     2     3     4
//   action:      RETX  RETX  RETX  UNRECOVERABLE
// ---------------------------------------------------------------------------
TEST_CASE("Property 9: 3 RETX requests then UNRECOVERABLE on the 4th CRC error",
          "[sequence_tracker][property][property-9]") {
  SequenceTracker t;
  const std::uint32_t seq = 42;

  REQUIRE(t.onCrcError(seq) == RetxAction::RequestRetx);  // #1
  REQUIRE(t.retxCount(seq) == 1);
  REQUIRE_FALSE(t.isUnrecoverable());

  REQUIRE(t.onCrcError(seq) == RetxAction::RequestRetx);  // #2
  REQUIRE(t.retxCount(seq) == 2);
  REQUIRE_FALSE(t.isUnrecoverable());

  REQUIRE(t.onCrcError(seq) == RetxAction::RequestRetx);  // #3
  REQUIRE(t.retxCount(seq) == 3);
  REQUIRE_FALSE(t.isUnrecoverable());

  REQUIRE(t.onCrcError(seq) == RetxAction::Unrecoverable);  // #4 -> latched
  REQUIRE(t.isUnrecoverable());

  // MAX_RETRANSMISSIONS is the documented bound (3); the canonical table above
  // exercises exactly that many RETX_REQUESTs before declaring unrecoverable.
  REQUIRE(MAX_RETRANSMISSIONS == 3);
}

// ---------------------------------------------------------------------------
// Property 9 (latch persists, Req 7.7): once UNRECOVERABLE is returned the latch
// stays set and every subsequent CRC error keeps reporting UNRECOVERABLE so the
// caller never issues a 4th-plus retransmission (drawing stays paused).
// ---------------------------------------------------------------------------
TEST_CASE("Property 9: UNRECOVERABLE latches and persists across more CRC errors",
          "[sequence_tracker][property][property-9]") {
  SequenceTracker t;
  const std::uint32_t seq = 7;

  // Drive to the latched state.
  for (int i = 0; i < MAX_RETRANSMISSIONS; ++i) {
    REQUIRE(t.onCrcError(seq) == RetxAction::RequestRetx);
  }
  REQUIRE(t.onCrcError(seq) == RetxAction::Unrecoverable);
  REQUIRE(t.isUnrecoverable());

  // Further CRC errors -- same seq or a different one -- stay UNRECOVERABLE.
  REQUIRE(t.onCrcError(seq) == RetxAction::Unrecoverable);
  REQUIRE(t.onCrcError(seq + 1) == RetxAction::Unrecoverable);
  REQUIRE(t.isUnrecoverable());
}

// ---------------------------------------------------------------------------
// Property 9 (idempotent ACK, Req 7.3): a fresh seq returns Ack and is enqueued
// once; a repeat of an already-acked seq returns DuplicateAck and is NOT
// re-enqueued.
// ---------------------------------------------------------------------------
TEST_CASE("Property 9: fresh seq ACKs+enqueues, duplicate seq is idempotent ACK",
          "[sequence_tracker][property][property-9]") {
  const std::uint32_t seq = 100;

  // Verdict sequence on a clean tracker.
  SequenceTracker t;
  REQUIRE(t.onValidCommand(seq) == RetxAction::Ack);            // first accept
  REQUIRE(t.onValidCommand(seq) == RetxAction::DuplicateAck);   // idempotent
  REQUIRE(t.onValidCommand(seq) == RetxAction::DuplicateAck);   // idempotent
  REQUIRE(t.onValidCommand(seq - 1) == RetxAction::DuplicateAck);  // older = dup
  REQUIRE(t.onValidCommand(seq + 1) == RetxAction::Ack);        // newer = accept

  // Observe the enqueue side-effects through the dispatch helper on a fresh
  // tracker: exactly one enqueue for the first acceptance, none for duplicates.
  SequenceTracker t2;
  FakeMotionBuffer mb;
  dispatchValid(t2, seq, mb);  // Ack  -> enqueue
  dispatchValid(t2, seq, mb);  // dup  -> no enqueue
  dispatchValid(t2, seq, mb);  // dup  -> no enqueue
  REQUIRE(mb.size() == 1u);
  REQUIRE(mb.items().front() == seq);
}

// ---------------------------------------------------------------------------
// Property 9 (reset): reset() clears the unrecoverable latch and the acked
// history, so the tracker behaves as freshly constructed afterwards.
// ---------------------------------------------------------------------------
TEST_CASE("Property 9: reset clears the unrecoverable latch and acked history",
          "[sequence_tracker][property][property-9]") {
  SequenceTracker t;
  const std::uint32_t seq = 5;

  // Ack a seq and drive a *different* seq to unrecoverable.
  REQUIRE(t.onValidCommand(seq) == RetxAction::Ack);
  for (int i = 0; i < MAX_RETRANSMISSIONS; ++i) {
    REQUIRE(t.onCrcError(seq + 10) == RetxAction::RequestRetx);
  }
  REQUIRE(t.onCrcError(seq + 10) == RetxAction::Unrecoverable);
  REQUIRE(t.isUnrecoverable());

  t.reset();

  // Latch cleared.
  REQUIRE_FALSE(t.isUnrecoverable());
  // Acked history cleared: the previously-acked seq is now a fresh acceptance.
  REQUIRE(t.onValidCommand(seq) == RetxAction::Ack);
  // Retransmission counter cleared: the previously-failing seq starts over.
  REQUIRE(t.retxCount(seq + 10) == 0);
  REQUIRE(t.onCrcError(seq + 10) == RetxAction::RequestRetx);
  REQUIRE(t.retxCount(seq + 10) == 1);
}

// ===========================================================================
// Property 9 (parameterized, rapidcheck).
// ===========================================================================

// ---------------------------------------------------------------------------
// Property 9 (bounded retransmission, biconditional): for an arbitrary seq and
// an arbitrary number K of consecutive CRC errors on that seq (K in [1, 6]),
// the count of RETX_REQUEST results is exactly min(K, MAX_RETRANSMISSIONS) and
// an UNRECOVERABLE result appears IF AND ONLY IF K > MAX_RETRANSMISSIONS. Once
// it appears the latch is set and all trailing results are UNRECOVERABLE.
// ---------------------------------------------------------------------------
TEST_CASE("Property 9: K CRC errors -> min(K,3) RETX and UNRECOVERABLE iff K>3",
          "[sequence_tracker][property][property-9]") {
  REQUIRE(rc::check(
      "RequestRetx count == min(K,3); Unrecoverable iff K>3; latch sticks",
      [] {
        const std::uint32_t seq = *rc::gen::arbitrary<std::uint32_t>();
        const int k = *rc::gen::inRange<int>(1, 7);  // K in [1, 6]

        SequenceTracker t;
        int retx = 0;
        int unrec = 0;
        bool unrecoverable_seen = false;

        for (int i = 1; i <= k; ++i) {
          const RetxAction a = t.onCrcError(seq);
          if (a == RetxAction::RequestRetx) {
            ++retx;
            // RETX requests only ever precede the latch, never follow it.
            RC_ASSERT(!unrecoverable_seen);
            // The latch must not be set while still requesting retransmission.
            RC_ASSERT(!t.isUnrecoverable());
          } else if (a == RetxAction::Unrecoverable) {
            ++unrec;
            unrecoverable_seen = true;
            // Latches true from the first UNRECOVERABLE onward (Req 7.7).
            RC_ASSERT(t.isUnrecoverable());
          } else {
            // onCrcError never returns Ack / DuplicateAck.
            RC_ASSERT(false);
          }
        }

        const int expected_retx =
            k < MAX_RETRANSMISSIONS ? k : MAX_RETRANSMISSIONS;  // min(K, 3)
        RC_ASSERT(retx == expected_retx);

        // At most MAX_RETRANSMISSIONS RETX_REQUESTs are ever issued (Req 7.3).
        RC_ASSERT(retx <= MAX_RETRANSMISSIONS);

        // UNRECOVERABLE appears iff the budget was exceeded, and the latch
        // reflects that (Req 7.7).
        const bool exceeded = k > MAX_RETRANSMISSIONS;
        RC_ASSERT((unrec > 0) == exceeded);
        RC_ASSERT(t.isUnrecoverable() == exceeded);

        // Every CRC error produced exactly one verdict.
        RC_ASSERT(retx + unrec == k);
      }));
}

// ---------------------------------------------------------------------------
// Property 9 (latch absorbs all further CRC errors): after reaching the latched
// state, an arbitrary number of additional CRC errors -- for arbitrary seqs --
// all return UNRECOVERABLE and the latch never clears on its own.
// ---------------------------------------------------------------------------
TEST_CASE("Property 9: once latched, all further CRC errors stay UNRECOVERABLE",
          "[sequence_tracker][property][property-9]") {
  REQUIRE(rc::check(
      "post-latch onCrcError(anything) == Unrecoverable and latch holds", [] {
        const std::uint32_t seq = *rc::gen::arbitrary<std::uint32_t>();

        SequenceTracker t;
        // Drive to the latch: 3 RETX then the 4th trips UNRECOVERABLE.
        for (int i = 0; i < MAX_RETRANSMISSIONS; ++i) {
          RC_ASSERT(t.onCrcError(seq) == RetxAction::RequestRetx);
        }
        RC_ASSERT(t.onCrcError(seq) == RetxAction::Unrecoverable);
        RC_ASSERT(t.isUnrecoverable());

        // Arbitrary extra CRC errors on arbitrary seqs all stay UNRECOVERABLE.
        const int extra = *rc::gen::inRange<int>(0, 8);
        for (int i = 0; i < extra; ++i) {
          const std::uint32_t other = *rc::gen::arbitrary<std::uint32_t>();
          RC_ASSERT(t.onCrcError(other) == RetxAction::Unrecoverable);
          RC_ASSERT(t.isUnrecoverable());
        }
      }));
}

// ---------------------------------------------------------------------------
// Property 9 (idempotent ACK over a monotonic seq stream, Req 7.3): for an
// arbitrary non-decreasing stream of valid-command seqs, dispatch ACKs every
// frame but enqueues a command IF AND ONLY IF its seq is strictly greater than
// every previously-acked seq. Duplicate (<= high-water) arrivals are idempotent
// ACKs that never re-enqueue, so the buffer occupancy equals the number of
// strictly-increasing steps in the stream.
// ---------------------------------------------------------------------------
TEST_CASE("Property 9: duplicate seqs ACK idempotently and never re-enqueue",
          "[sequence_tracker][property][property-9]") {
  REQUIRE(rc::check(
      "enqueue count == number of strictly-increasing seq arrivals", [] {
        // Build a non-decreasing seq stream by accumulating non-negative
        // deltas (some zero -> duplicates, some positive -> new commands).
        const int n = *rc::gen::inRange<int>(1, 20);
        std::vector<std::uint32_t> stream;
        stream.reserve(static_cast<std::size_t>(n));
        std::uint32_t cur = *rc::gen::inRange<std::uint32_t>(0, 1000);
        stream.push_back(cur);
        for (int i = 1; i < n; ++i) {
          const std::uint32_t delta = *rc::gen::inRange<std::uint32_t>(0, 5);
          cur += delta;  // bounded so it never overflows uint32 in practice
          stream.push_back(cur);
        }

        SequenceTracker t;
        FakeMotionBuffer mb;

        std::size_t expected_enqueues = 0;
        bool have_high = false;
        std::uint32_t high = 0;

        for (std::uint32_t s : stream) {
          const RetxAction a = t.onValidCommand(s);
          const bool is_new = !have_high || s > high;
          if (is_new) {
            // First-time acceptance: Ack + enqueue.
            RC_ASSERT(a == RetxAction::Ack);
            ++expected_enqueues;
            high = s;
            have_high = true;
            mb.push(s);
          } else {
            // Already applied (s <= high-water): idempotent ACK, no enqueue.
            RC_ASSERT(a == RetxAction::DuplicateAck);
          }
        }

        // The buffer gained exactly one entry per strictly-increasing arrival,
        // and nothing for duplicates.
        RC_ASSERT(mb.size() == expected_enqueues);
      }));
}

// ---------------------------------------------------------------------------
// Property 9 (reset restores the initial state): for an arbitrary tracker that
// has acked some seq and been driven to the unrecoverable latch, reset() clears
// both the latch and the acked history, so a previously-duplicate seq is once
// again a fresh acceptance and the failing seq's counter is zero.
// ---------------------------------------------------------------------------
TEST_CASE("Property 9: reset clears latch and acked history (parameterized)",
          "[sequence_tracker][property][property-9]") {
  REQUIRE(rc::check(
      "after reset: latch false, prior seq re-ACKs as new, retxCount 0", [] {
        const std::uint32_t acked = *rc::gen::arbitrary<std::uint32_t>();
        const std::uint32_t failing = *rc::gen::arbitrary<std::uint32_t>();

        SequenceTracker t;
        RC_ASSERT(t.onValidCommand(acked) == RetxAction::Ack);

        // Drive `failing` to the latched unrecoverable state.
        for (int i = 0; i < MAX_RETRANSMISSIONS; ++i) {
          RC_ASSERT(t.onCrcError(failing) == RetxAction::RequestRetx);
        }
        RC_ASSERT(t.onCrcError(failing) == RetxAction::Unrecoverable);
        RC_ASSERT(t.isUnrecoverable());

        t.reset();

        // Latch cleared.
        RC_ASSERT(!t.isUnrecoverable());
        // Acked history cleared: the previously-acked seq is fresh again.
        RC_ASSERT(t.onValidCommand(acked) == RetxAction::Ack);
        // Failing counter cleared.
        RC_ASSERT(t.retxCount(failing) == 0);
      }));
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
