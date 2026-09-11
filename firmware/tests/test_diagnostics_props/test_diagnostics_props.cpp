// Host-side property tests for the Diagnostics stall detector (Task 7.2).
//
// Property 19: Stall-detector threshold (Design §3.2.8, §4.5, Requirement 12.3).
//
//   *For any* per-axis sequence of `(expected_steps_at_t, observed_steps_at_t)`
//   measurements during a single segment, the stall flag is raised for that
//   axis if and only if `max_t (expected - observed) >= 4` at some point in the
//   segment, with the offending axis correctly identified.
//
// Mapping the design framing onto the implementation
// ---------------------------------------------------
// Diagnostics does not consume raw `(expected, observed)` pairs directly; the
// motion executor reduces each tick to a single signal -- "this axis missed its
// step deadline this tick" -- and reports it via reportMissedDeadline(axis).
// The per-segment missed-deadline counter for an axis is therefore exactly the
// running `expected - observed` deficit within the current segment, and the
// design's `max_t (expected - observed) >= 4` is equivalent to "the per-segment
// missed count reaches STALL_THRESHOLD (>= 4)". resetSegment() marks a segment
// boundary (Req 12.3: "within a single movement segment"), zeroing the
// counters so deficits never accumulate across segments.
//
// This translation unit pins down four facets of Property 19, each over many
// generated inputs (rapidcheck) plus a couple of hand-worked boundary cases:
//
//   1. Threshold (iff): for an arbitrary miss count m in [0, 10] on an
//      arbitrary axis within a single segment, a stall is raised IFF
//      m >= STALL_THRESHOLD. For m < 4: not stalled, no STALL emitted. For
//      m >= 4: stalled, exactly one STALL carrying that axis, detail == 4.
//      (The "exactly one" also exercises facet 4 -- at-most-once -- because m
//      may exceed the threshold.)
//   2. Per-segment latch: for a generated sequence of (miss, reset) events, the
//      emitted STALL stream matches an independent oracle that re-derives the
//      "a stall fires the first time any axis reaches 4 misses within a maximal
//      run between resets" rule from scratch. This proves 3 + reset + 3 never
//      stalls while >= 4 in one segment does.
//   3. Per-axis independence: misses on X and misses on Y are tallied against
//      independent thresholds; X reaching 4 raises an X stall regardless of Y's
//      count and vice versa.
//   4. At-most-once per axis per latch: a counter climbing past the threshold
//      re-emits nothing until a resetSegment() reopens that axis's guard.
//
// Why this shape is the right test
// --------------------------------
// The stall detector is a pure, allocation-free state machine whose only
// observable channels are isStalled(), missedDeadlines(axis), and the ERROR
// frames handed to the injected sink. We therefore drive a real Diagnostics
// through generated event streams with an in-memory IDiagPins fake (the fault
// tap is held HIGH throughout, so no FAULT ever fires and the stall path is
// isolated) and compare the emitted STALL stream + latch state + counters
// against an oracle written independently of the implementation. The oracle
// mirrors the *requirement* ("4 or more missed steps within a single movement
// segment", Req 12.3), not the code, so it is a genuine cross-check.
//
// This file lives in its own PlatformIO test directory (test_diagnostics_props/)
// so it links into a standalone binary separate from test_diagnostics/. It
// supplies its own `int main` and pulls the implementation in via a relative
// include of diagnostics.cpp -- matching the convention in test_backlash_props/,
// test_command_parser_props/, and test_nvm_props/ -- so the host_test
// environment (test_build_src = no) stays self-contained with a single
// definition of Diagnostics's symbols. Diagnostics is Arduino-include-free, so
// the ArduinoDiagPins block in the .cpp is excluded by `#if defined(ARDUINO)`.
//
// The properties are exercised with rapidcheck via the standalone rc::check
// form invoked from inside Catch2 TEST_CASEs; rc::check returns true on success,
// so wrapping it in REQUIRE surfaces a failing property (with rapidcheck's
// shrunk counterexample on stderr) as a Catch2 failure.
//
// Run with:
//
//     pio test -e host_test

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "../../src/diagnostics/diagnostics.h"
#include "../../src/diagnostics/diagnostics.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::diag::Axis;
using etch::diag::DiagError;
using etch::diag::Diagnostics;
using etch::diag::IDiagPins;
using etch::diag::ERROR_KIND_FAULT;
using etch::diag::ERROR_KIND_STALL;
using etch::diag::STALL_THRESHOLD;

namespace {

// ---------------------------------------------------------------------------
// In-memory IDiagPins fake. Same slice the latch logic touches as the unit
// test's FakePins; for the stall properties the fault tap is held HIGH (no
// fault) so poll() never fires and the stall path is exercised in isolation.
// ---------------------------------------------------------------------------
class FakePins : public IDiagPins {
 public:
  bool readFault() override { return fault_; }
  void setEnabled(bool enabled) override { enabled_ = enabled; }

  void assertFault(bool asserted) { fault_ = asserted; }
  bool enabled() const { return enabled_; }

 private:
  bool fault_ = false;   // A3 reads HIGH (no fault) by default
  bool enabled_ = true;  // assume drivers start energised
};

// Collects every ERROR the latch emits so a property can assert count/contents.
struct ErrorLog {
  std::vector<DiagError> errors;

  // The axes of the STALL errors, in emission order. Used to compare against
  // the oracle's expected STALL stream.
  std::vector<std::uint8_t> stallAxes() const {
    std::vector<std::uint8_t> out;
    for (const DiagError& e : errors) {
      if (e.kind == ERROR_KIND_STALL) out.push_back(e.axis);
    }
    return out;
  }

  std::size_t stallCount() const { return stallAxes().size(); }
  bool anyFault() const {
    for (const DiagError& e : errors) {
      if (e.kind == ERROR_KIND_FAULT) return true;
    }
    return false;
  }
};

// Build a Diagnostics wired to `pins` that appends each emit into `log`.
Diagnostics makeDiag(FakePins& pins, ErrorLog& log) {
  return Diagnostics(pins,
                     [&log](const DiagError& e) { log.errors.push_back(e); });
}

std::size_t axisIndex(Axis a) { return static_cast<std::size_t>(a); }

// ---------------------------------------------------------------------------
// Event stream for the per-segment latch property.
// ---------------------------------------------------------------------------

// A single replay event: either a segment boundary (resetSegment()) or a missed
// deadline on a specific axis (reportMissedDeadline(axis)).
struct Event {
  bool reset;  // true => resetSegment(); axis is then ignored.
  Axis axis;
};

// Sample a finite event sequence. ~1-in-5 events is a segment reset; the rest
// are misses on a uniformly chosen axis. Called from inside an rc::check
// property (uses rapidcheck's operator*).
std::vector<Event> genEvents() {
  const int n = *rc::gen::inRange(0, 50);
  std::vector<Event> events;
  events.reserve(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    Event e{};
    const bool reset = (*rc::gen::inRange(0, 5) == 0);
    if (reset) {
      e.reset = true;
    } else {
      e.reset = false;
      e.axis = (*rc::gen::inRange(0, 2) == 0) ? Axis::X : Axis::Y;
    }
    events.push_back(e);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Independent oracle for the per-segment latch (derived from Req 12.3, NOT from
// the implementation): replay the events, and emit a STALL for an axis the
// first time its per-segment miss count reaches STALL_THRESHOLD; a reset zeroes
// both axes' counts and reopens their emit guards. Returns the expected STALL
// axis stream in emission order.
// ---------------------------------------------------------------------------
std::vector<std::uint8_t> oracleStallAxes(const std::vector<Event>& events) {
  std::vector<std::uint8_t> emits;
  int seg[2] = {0, 0};            // per-axis miss count in the current segment
  bool emitted[2] = {false, false};  // per-axis "already stalled this segment"
  for (const Event& e : events) {
    if (e.reset) {
      seg[0] = seg[1] = 0;
      emitted[0] = emitted[1] = false;
      continue;
    }
    const std::size_t a = axisIndex(e.axis);
    ++seg[a];
    if (seg[a] >= STALL_THRESHOLD && !emitted[a]) {
      emitted[a] = true;
      emits.push_back(static_cast<std::uint8_t>(e.axis));
    }
  }
  return emits;
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 19 (threshold iff): a stall is raised in a single segment iff the
// per-axis miss count reaches STALL_THRESHOLD (Req 12.3). Also pins the
// at-most-once guard, since m may exceed the threshold.
// ---------------------------------------------------------------------------
TEST_CASE("Property 19: stall raised iff per-segment misses reach the threshold",
          "[diag][property][property-19]") {
  REQUIRE(rc::check(
      "isStalled() and the STALL emit fire exactly when m >= STALL_THRESHOLD",
      [] {
        const int m = *rc::gen::inRange(0, 11);  // spans both sides of 4
        const Axis axis = (*rc::gen::inRange(0, 2) == 0) ? Axis::X : Axis::Y;
        const Axis other = (axis == Axis::X) ? Axis::Y : Axis::X;

        FakePins pins;
        ErrorLog log;
        Diagnostics diag = makeDiag(pins, log);
        diag.begin();

        for (int i = 0; i < m; ++i) {
          diag.reportMissedDeadline(axis);
        }

        const bool shouldStall = (m >= STALL_THRESHOLD);
        RC_ASSERT(diag.isStalled() == shouldStall);

        // Exactly one STALL once the threshold is crossed (at-most-once per
        // latch), none below it -- never a fault on the stall path.
        RC_ASSERT(log.stallCount() == (shouldStall ? 1u : 0u));
        RC_ASSERT(!log.anyFault());

        if (shouldStall) {
          RC_ASSERT(log.errors.back().kind == ERROR_KIND_STALL);
          // The offending axis is correctly identified...
          RC_ASSERT(log.errors.back().axis ==
                    static_cast<std::uint8_t>(axis));
          // ...and the stall fires AT the threshold, so detail == 4 regardless
          // of how far past 4 the counter climbed.
          RC_ASSERT(log.errors.back().detail == STALL_THRESHOLD);
        }

        // The counter tracks the misses (m <= 10 never saturates), and the
        // untouched axis stays clean -- the threshold is purely per-axis.
        RC_ASSERT(diag.missedDeadlines(axis) == static_cast<std::uint8_t>(m));
        RC_ASSERT(diag.missedDeadlines(other) == 0);
      }));
}

// ---------------------------------------------------------------------------
// Property 19 (per-segment latch): for a generated (miss, reset) sequence, the
// emitted STALL stream matches the independent oracle. This proves the
// "within a single movement segment" rule -- misses split across a reset never
// stall, while >= 4 in one segment does -- and that resetSegment() reopens the
// per-axis emit guard (so a later segment can stall again) while never clearing
// an already-latched isStalled().
// ---------------------------------------------------------------------------
TEST_CASE("Property 19: per-segment latch matches the independent oracle",
          "[diag][property][property-19]") {
  REQUIRE(rc::check(
      "STALL stream over (miss, reset) events == oracle; latch is sticky", [] {
        const std::vector<Event> events = genEvents();

        FakePins pins;
        ErrorLog log;
        Diagnostics diag = makeDiag(pins, log);
        diag.begin();

        for (const Event& e : events) {
          if (e.reset) {
            diag.resetSegment();
          } else {
            diag.reportMissedDeadline(e.axis);
          }
        }

        const std::vector<std::uint8_t> expected = oracleStallAxes(events);
        const std::vector<std::uint8_t> got = log.stallAxes();

        // Same number of STALLs, each carrying the same axis, in order.
        RC_ASSERT(got.size() == expected.size());
        for (std::size_t i = 0; i < expected.size(); ++i) {
          RC_ASSERT(got[i] == expected[i]);
        }

        // isStalled() is true iff at least one STALL was ever raised, and once
        // raised it is never cleared by a later resetSegment() (sticky latch).
        RC_ASSERT(diag.isStalled() == !expected.empty());
        RC_ASSERT(!log.anyFault());
      }));
}

// ---------------------------------------------------------------------------
// Property 19 (per-axis independence): with mx misses on X and my misses on Y
// in a single segment, X stalls iff mx >= 4 and Y stalls iff my >= 4, each
// independent of the other axis's count. Misses on one axis never contribute to
// the other axis's threshold.
// ---------------------------------------------------------------------------
TEST_CASE("Property 19: X and Y thresholds are independent",
          "[diag][property][property-19]") {
  REQUIRE(rc::check(
      "per-axis stall depends only on that axis's miss count", [] {
        const int mx = *rc::gen::inRange(0, 11);
        const int my = *rc::gen::inRange(0, 11);

        FakePins pins;
        ErrorLog log;
        Diagnostics diag = makeDiag(pins, log);
        diag.begin();

        // All in one segment (no reset): X misses first, then Y misses.
        for (int i = 0; i < mx; ++i) diag.reportMissedDeadline(Axis::X);
        for (int i = 0; i < my; ++i) diag.reportMissedDeadline(Axis::Y);

        const bool xStall = (mx >= STALL_THRESHOLD);
        const bool yStall = (my >= STALL_THRESHOLD);

        // Build the expected STALL axis stream: X (if any) is emitted before Y
        // because the X misses were reported first.
        std::vector<std::uint8_t> expected;
        if (xStall) expected.push_back(static_cast<std::uint8_t>(Axis::X));
        if (yStall) expected.push_back(static_cast<std::uint8_t>(Axis::Y));

        const std::vector<std::uint8_t> got = log.stallAxes();
        RC_ASSERT(got.size() == expected.size());
        for (std::size_t i = 0; i < expected.size(); ++i) {
          RC_ASSERT(got[i] == expected[i]);
        }

        RC_ASSERT(diag.isStalled() == (xStall || yStall));
        RC_ASSERT(diag.missedDeadlines(Axis::X) ==
                  static_cast<std::uint8_t>(mx));
        RC_ASSERT(diag.missedDeadlines(Axis::Y) ==
                  static_cast<std::uint8_t>(my));
      }));
}

// ---------------------------------------------------------------------------
// Boundary cases (plain Catch2): the exact threshold edge requested by Req
// 12.3 -- 3 misses do not stall, 4 misses do -- on hand-worked examples that
// complement the randomized properties above.
// ---------------------------------------------------------------------------

TEST_CASE("Property 19 (boundary): exactly 3 misses in a segment does not stall",
          "[diag][property-19][example]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);

  CHECK_FALSE(diag.isStalled());
  CHECK(log.stallCount() == 0u);
  CHECK(diag.missedDeadlines(Axis::X) == 3);
}

TEST_CASE("Property 19 (boundary): exactly 4 misses in a segment stalls once",
          "[diag][property-19][example]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  for (int i = 0; i < STALL_THRESHOLD; ++i) {
    diag.reportMissedDeadline(Axis::Y);
  }

  CHECK(diag.isStalled());
  REQUIRE(log.stallCount() == 1u);
  CHECK(log.errors.back().kind == ERROR_KIND_STALL);
  CHECK(log.errors.back().axis == static_cast<std::uint8_t>(Axis::Y));
  CHECK(log.errors.back().detail == STALL_THRESHOLD);
}

TEST_CASE("Property 19 (boundary): 3 + reset + 3 never stalls",
          "[diag][property-19][example]") {
  FakePins pins;
  ErrorLog log;
  Diagnostics diag = makeDiag(pins, log);
  diag.begin();

  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  diag.resetSegment();
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);
  diag.reportMissedDeadline(Axis::X);

  CHECK_FALSE(diag.isStalled());
  CHECK(log.stallCount() == 0u);
  CHECK(diag.missedDeadlines(Axis::X) == 3);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
