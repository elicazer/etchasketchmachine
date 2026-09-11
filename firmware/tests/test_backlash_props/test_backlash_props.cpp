// Host-side property tests for BacklashCompensator (Task 6.8).
//
// Property 10: Backlash compensation preserves logical position
// (Design §7, §3.2.6, Requirement 13).
//
//   *For any* finite move sequence `M` issued from home with the compensator
//   in its post-onHome() state, and *for any* BacklashConfig (b_x, b_y) ∈
//   [0, 200]², the final logical stylus position (counting only "counted"
//   steps) equals the position computed under the same sequence with
//   BacklashConfig {0, 0}. Furthermore: on each direction reversal of axis `a`
//   after the first move on `a`, exactly `b_a` compensation steps are emitted
//   in the new direction immediately before the actual segment; on the first
//   move per axis after onHome(), no compensation is emitted; consecutive
//   same-direction moves emit no compensation between them.
//
//   Validates: Requirements 13.4, 13.6, 13.7, 13.10.
//
// Why this is the right shape for the property
// --------------------------------------------
// BacklashCompensator is a pure state machine. Its only observable channels
// are (a) the compensation-step count returned by prepareForMove() and (b) the
// last-direction state it mutates (observable only through subsequent
// prepareForMove() / onHome() calls). It deliberately does NOT move motors and
// does NOT track position itself: per the header contract (Requirement 13.7)
// the *caller* (MotionPlanner, task 6.9) issues the reported compensation steps
// with count_into_position = false, and the real commanded steps with
// count_into_position = true.
//
// To test Property 10 end-to-end we therefore model that caller contract with a
// small replay harness that consumes a generated move sequence and, for each
// move, drives a physical step stream split into two classes:
//   * `comp` uncounted steps in the new direction (from prepareForMove), and
//   * `|delta|` counted steps in the new direction (the real segment).
// The harness then tracks two positions per axis: `logical` (counted steps
// only) and `physical` (every emitted step). The headline invariant is that
// `logical` equals an independent backlash-free oracle (the naive sum of
// commanded deltas) for ANY backlash config — i.e. compensation steps never
// leak into the logical position (Requirement 13.7). The harness also captures
// the exact comp count returned per move and checks it against an independent
// reversal oracle (Requirements 13.4 reversal count, 13.6 reversal-only,
// 13.10 default-0), and confirms `physical - logical` is exactly the injected
// compensation, proving those steps are real motion that simply is not counted.
//
// The reversal oracle re-derives the documented semantics from scratch (first
// move per axis = 0; same-direction continuation = 0; sign flip versus the last
// genuine nonzero direction = b_a; a zero-delta move emits nothing and does not
// disturb the remembered direction; onHome() forgets both axes) so the test is
// a true oracle rather than a mirror of the implementation.
//
// This translation unit lives in its own PlatformIO test directory
// (test_backlash_props/) so it compiles and links into a standalone test
// binary, separate from test_backlash/. It therefore supplies its own
// `int main` and pulls the implementation in directly via a relative include
// of backlash_compensator.cpp — matching the convention in test_backlash/,
// test_command_parser_props/, and test_nvm_props/ — so the host_test
// environment (test_build_src = no) stays self-contained with a single
// definition of BacklashCompensator's symbols.
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
#include <cstdint>
#include <cstring>
#include <functional>
#include <vector>

#include "../../src/types.h"
#include "../../src/backlash/backlash_compensator.h"
#include "../../src/backlash/backlash_compensator.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::BacklashConfig;
using etch::PersistedConfig;
using etch::BACKLASH_STEPS_MAX;
using etch::DEFAULT_MM_PER_REV;
using etch::NVM_MAGIC;
using etch::NVM_VERSION;
using etch::backlash::Axis;
using etch::backlash::BacklashCompensator;
using etch::backlash::IBacklashStore;

namespace {

// ---------------------------------------------------------------------------
// In-memory NVM stand-in (same slice the compensator uses; mirrors the fake in
// test_backlash/). A default-shaped record carries backlash 0/0 so a fresh
// load() yields the documented defaults (Requirement 13.10).
// ---------------------------------------------------------------------------
class FakeStore : public IBacklashStore {
 public:
  FakeStore() {
    std::memset(&cfg_, 0, sizeof(cfg_));
    cfg_.magic = NVM_MAGIC;
    cfg_.version = NVM_VERSION;
    cfg_.mm_per_rev_x = DEFAULT_MM_PER_REV;
    cfg_.mm_per_rev_y = DEFAULT_MM_PER_REV;
  }

  const PersistedConfig& get() const override { return cfg_; }

  void mutate(std::function<void(PersistedConfig&)> fn) override { fn(cfg_); }

  PersistedConfig& raw() { return cfg_; }

 private:
  PersistedConfig cfg_;
};

// ---------------------------------------------------------------------------
// Generated event stream.
// ---------------------------------------------------------------------------

// A single replay event: either a homing reset or a per-axis commanded move
// of `delta` full steps (delta may be 0, negative, or positive). |delta| is
// kept within int8_t range so it can be handed to prepareForMove() unchanged,
// exercising the implementation's own sign() reduction (magnitude > 1).
struct Event {
  bool home;    // true => onHome(); the other fields are then ignored.
  Axis axis;
  int  delta;
};

constexpr int kDeltaAbsMax = 100;  // |delta| ≤ 100 < 128 => fits int8_t.

// Independent sign in {-1, 0, +1}. Written here rather than reusing the
// implementation's private helper so the oracle stands alone.
std::int8_t signum(int v) {
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

std::size_t axisIndex(Axis a) { return static_cast<std::size_t>(a); }

// Sample a finite event sequence. ~1-in-8 events is a homing reset; the rest
// are moves on a uniformly chosen axis with a delta in [-100, 100] (including
// 0 to exercise the "zero move does not disturb state" rule). Called from
// inside an rc::check property (uses rapidcheck's operator*).
std::vector<Event> genEvents() {
  const int n = *rc::gen::inRange(0, 60);
  std::vector<Event> events;
  events.reserve(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    Event e{};
    const bool home = (*rc::gen::inRange(0, 8) == 0);
    if (home) {
      e.home = true;
    } else {
      e.home = false;
      e.axis = (*rc::gen::inRange(0, 2) == 0) ? Axis::X : Axis::Y;
      e.delta = *rc::gen::inRange(-kDeltaAbsMax, kDeltaAbsMax + 1);
    }
    events.push_back(e);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Independent reversal oracle: the expected compensation count per move,
// derived directly from the Requirement 13 semantics (NOT from the
// implementation).
// ---------------------------------------------------------------------------

// Returns, for each *move* event (in order, skipping home events), the number
// of compensation steps that move should emit given `cfg` and home resets.
std::vector<int> oracleCompPerMove(const std::vector<Event>& events,
                                   const BacklashConfig& cfg) {
  std::vector<int> out;
  std::int8_t last[2] = {0, 0};  // last genuine nonzero direction per axis
  for (const Event& e : events) {
    if (e.home) {
      last[0] = 0;
      last[1] = 0;
      continue;
    }
    const std::size_t a = axisIndex(e.axis);
    const std::int8_t nd = signum(e.delta);
    if (nd == 0) {
      // A zero-delta move is neither motion nor a reversal: no compensation,
      // and the remembered direction is untouched.
      out.push_back(0);
      continue;
    }
    const bool reversal = (last[a] != 0) && (nd != last[a]);
    const int b = (a == 0) ? cfg.x : cfg.y;
    out.push_back(reversal ? b : 0);
    last[a] = nd;
  }
  return out;
}

// Backlash-free position oracle: the naive per-axis sum of commanded deltas,
// completely ignoring backlash and home resets (homing does not move the
// logical position; it only resets direction memory).
void oraclePosition(const std::vector<Event>& events, long pos[2]) {
  pos[0] = 0;
  pos[1] = 0;
  for (const Event& e : events) {
    if (e.home) continue;
    pos[axisIndex(e.axis)] += e.delta;
  }
}

// ---------------------------------------------------------------------------
// Replay harness: drive the events through a real compensator, modelling the
// MotionPlanner caller contract (Requirement 13.7). Records the comp count
// returned per move, plus the resulting logical (counted) and physical
// (counted + compensation) positions and the total injected compensation.
// ---------------------------------------------------------------------------
struct ReplayResult {
  std::vector<int> comp_per_move;  // prepareForMove() return per move event
  long logical[2] = {0, 0};        // counted steps only (Requirement 13.7)
  long physical[2] = {0, 0};       // every emitted step (counted + comp)
  long comp_total[2] = {0, 0};     // injected compensation steps per axis
};

ReplayResult replay(BacklashCompensator& comp,
                    const std::vector<Event>& events) {
  ReplayResult r;
  for (const Event& e : events) {
    if (e.home) {
      comp.onHome();
      continue;
    }
    const std::size_t a = axisIndex(e.axis);
    const std::int8_t nd = signum(e.delta);

    // The caller derives the direction and asks for compensation. We hand the
    // raw delta (clamped to int8_t, always exact since |delta| ≤ 100) so the
    // compensator performs its own sign reduction.
    const std::uint8_t c =
        comp.prepareForMove(e.axis, static_cast<std::int8_t>(e.delta));
    r.comp_per_move.push_back(static_cast<int>(c));

    // Contract: compensation steps move in the new direction but are NOT
    // counted toward the logical position (Requirement 13.7).
    r.comp_total[a] += c;
    r.physical[a] += static_cast<long>(nd) * static_cast<long>(c);

    // The real commanded segment IS counted.
    r.logical[a] += e.delta;
    r.physical[a] += e.delta;
  }
  return r;
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 10 (core invariant): logical position is preserved for ANY backlash.
//
// For an arbitrary event sequence and arbitrary BacklashConfig in [0, 200]²,
// the logical position (counted steps only) equals the backlash-free oracle.
// Equivalently, the same sequence replayed with {0, 0} yields an identical
// logical position. This is the heart of Requirement 13.7: compensation steps
// never leak into the logical position.
// ---------------------------------------------------------------------------
TEST_CASE("Property 10: logical position is independent of backlash",
          "[backlash][property][property-10]") {
  REQUIRE(rc::check(
      "logical position == backlash-free oracle for any BacklashConfig", [] {
        const std::vector<Event> events = genEvents();
        const auto bx =
            static_cast<std::uint8_t>(*rc::gen::inRange(0, BACKLASH_STEPS_MAX + 1));
        const auto by =
            static_cast<std::uint8_t>(*rc::gen::inRange(0, BACKLASH_STEPS_MAX + 1));

        // Run with the arbitrary backlash config.
        FakeStore store;
        BacklashCompensator comp(store);
        comp.set(BacklashConfig{bx, by});
        comp.onHome();  // start in the documented post-home state.
        const ReplayResult got = replay(comp, events);

        // Independent backlash-free oracle.
        long oracle[2];
        oraclePosition(events, oracle);
        RC_ASSERT(got.logical[0] == oracle[0]);
        RC_ASSERT(got.logical[1] == oracle[1]);

        // Cross-check: the same sequence under {0, 0} yields the SAME logical
        // position (and, per Requirement 13.10, injects zero compensation).
        FakeStore zero_store;
        BacklashCompensator zero_comp(zero_store);
        zero_comp.set(BacklashConfig{0, 0});
        zero_comp.onHome();
        const ReplayResult zero = replay(zero_comp, events);
        RC_ASSERT(zero.logical[0] == got.logical[0]);
        RC_ASSERT(zero.logical[1] == got.logical[1]);
        RC_ASSERT(zero.comp_total[0] == 0);
        RC_ASSERT(zero.comp_total[1] == 0);

        // The physical stream differs from the logical position by exactly the
        // injected compensation: comp steps are real motion that is not counted.
        RC_ASSERT(got.physical[0] - got.logical[0] == got.comp_total[0]);
        RC_ASSERT(got.physical[1] - got.logical[1] == got.comp_total[1]);
      }));
}

// ---------------------------------------------------------------------------
// Property 10 (reversal semantics): per-move compensation matches the oracle.
//
// Compensation is emitted exactly on a direction reversal after the first move
// on that axis (Requirement 13.6), the count equals the axis's configured
// backlash (Requirement 13.4), and home resets restart the per-axis "first
// move" state. Comparing the full per-move vector against the independent
// oracle pins down all three at once.
// ---------------------------------------------------------------------------
TEST_CASE("Property 10: compensation is emitted only on reversals, equal to b_a",
          "[backlash][property][property-10]") {
  REQUIRE(rc::check(
      "prepareForMove() per-move comp == independent reversal oracle", [] {
        const std::vector<Event> events = genEvents();
        const auto bx =
            static_cast<std::uint8_t>(*rc::gen::inRange(0, BACKLASH_STEPS_MAX + 1));
        const auto by =
            static_cast<std::uint8_t>(*rc::gen::inRange(0, BACKLASH_STEPS_MAX + 1));
        const BacklashConfig cfg{bx, by};

        FakeStore store;
        BacklashCompensator comp(store);
        comp.set(cfg);
        comp.onHome();

        const ReplayResult got = replay(comp, events);
        const std::vector<int> expected = oracleCompPerMove(events, cfg);

        RC_ASSERT(got.comp_per_move.size() == expected.size());
        for (std::size_t i = 0; i < expected.size(); ++i) {
          RC_ASSERT(got.comp_per_move[i] == expected[i]);
          // Every emitted comp count is either 0 or the axis backlash — never
          // a partial or out-of-range value.
          RC_ASSERT(got.comp_per_move[i] == 0 ||
                    got.comp_per_move[i] == bx ||
                    got.comp_per_move[i] == by);
        }
      }));
}

// ---------------------------------------------------------------------------
// Property 10 (default backlash 0 => never any compensation): Requirement
// 13.10. With no stored value, load() yields 0/0 and no move sequence ever
// injects a compensation step; logical position still tracks the commands.
// ---------------------------------------------------------------------------
TEST_CASE("Property 10: default (unstored) backlash injects zero compensation",
          "[backlash][property][property-10]") {
  REQUIRE(rc::check(
      "empty NVM -> load() 0/0 -> comp always 0, logical == oracle", [] {
        const std::vector<Event> events = genEvents();

        FakeStore store;             // default record: backlash 0/0.
        BacklashCompensator comp(store);
        comp.load();                 // documented default of 0 (Req 13.10).
        RC_ASSERT(comp.get().x == 0);
        RC_ASSERT(comp.get().y == 0);
        comp.onHome();

        const ReplayResult got = replay(comp, events);

        // No compensation is ever injected at backlash 0.
        for (int c : got.comp_per_move) {
          RC_ASSERT(c == 0);
        }
        RC_ASSERT(got.comp_total[0] == 0);
        RC_ASSERT(got.comp_total[1] == 0);

        long oracle[2];
        oraclePosition(events, oracle);
        RC_ASSERT(got.logical[0] == oracle[0]);
        RC_ASSERT(got.logical[1] == oracle[1]);
      }));
}

// ---------------------------------------------------------------------------
// Property 10 (onHome resets the first-move state): Requirement 13.6 / Design
// §5.2. After any homing reset, the next move on each axis must emit zero
// compensation even if it reverses the pre-home direction; normal reversal
// behaviour then resumes.
// ---------------------------------------------------------------------------
TEST_CASE("Property 10: onHome() makes the next move per axis emit no comp",
          "[backlash][property][property-10]") {
  REQUIRE(rc::check(
      "first move per axis after onHome() emits 0 regardless of prior dir", [] {
        const auto bx = static_cast<std::uint8_t>(
            *rc::gen::inRange(1, BACKLASH_STEPS_MAX + 1));  // nonzero so a bug
        const auto by = static_cast<std::uint8_t>(
            *rc::gen::inRange(1, BACKLASH_STEPS_MAX + 1));  // would be visible
        // Pre-home directions and the (possibly reversing) post-home directions.
        const std::int8_t pre_x = (*rc::gen::inRange(0, 2) == 0) ? -1 : 1;
        const std::int8_t pre_y = (*rc::gen::inRange(0, 2) == 0) ? -1 : 1;
        const std::int8_t post_x = (*rc::gen::inRange(0, 2) == 0) ? -1 : 1;
        const std::int8_t post_y = (*rc::gen::inRange(0, 2) == 0) ? -1 : 1;

        FakeStore store;
        BacklashCompensator comp(store);
        comp.set(BacklashConfig{bx, by});
        comp.onHome();

        // Establish a direction on each axis (first move => 0).
        RC_ASSERT(comp.prepareForMove(Axis::X, pre_x) == 0);
        RC_ASSERT(comp.prepareForMove(Axis::Y, pre_y) == 0);

        comp.onHome();  // forget both axes.

        // The first post-home move on each axis emits no compensation, even if
        // it reverses the pre-home direction.
        RC_ASSERT(comp.prepareForMove(Axis::X, post_x) == 0);
        RC_ASSERT(comp.prepareForMove(Axis::Y, post_y) == 0);

        // ...and a genuine reversal afterwards resumes emitting the backlash.
        RC_ASSERT(comp.prepareForMove(Axis::X,
                                      static_cast<std::int8_t>(-post_x)) == bx);
        RC_ASSERT(comp.prepareForMove(Axis::Y,
                                      static_cast<std::int8_t>(-post_y)) == by);
      }));
}

// ---------------------------------------------------------------------------
// Concrete reversal scenarios (plain Catch2). These pin down the headline
// "logical position preserved" framing on hand-worked examples, complementing
// the randomized properties above.
// ---------------------------------------------------------------------------

TEST_CASE("Property 10 (concrete): a single X reversal injects b_x uncounted",
          "[backlash][property-10][example]") {
  FakeStore store;
  BacklashCompensator comp(store);
  comp.set(BacklashConfig{40, 0});
  comp.onHome();

  // Move +10 on X (first move, no comp), then -10 on X (reversal => 40 comp).
  const std::vector<Event> events = {
      Event{false, Axis::X, +10},
      Event{false, Axis::X, -10},
  };
  const ReplayResult r = replay(comp, events);

  // Logical position is the naive sum: +10 - 10 = 0, untouched by the 40 comp.
  CHECK(r.logical[0] == 0);
  // 40 compensation steps were injected (uncounted), in the -X direction.
  CHECK(r.comp_total[0] == 40);
  CHECK(r.physical[0] == -40);  // 0 counted net + 40 steps of -X compensation.
  REQUIRE(r.comp_per_move.size() == 2u);
  CHECK(r.comp_per_move[0] == 0);
  CHECK(r.comp_per_move[1] == 40);
}

TEST_CASE("Property 10 (concrete): logical position matches the no-backlash run",
          "[backlash][property-10][example]") {
  // A zig-zag on both axes with substantial backlash on each.
  const std::vector<Event> events = {
      Event{false, Axis::X, +30}, Event{false, Axis::Y, +20},
      Event{false, Axis::X, -15}, Event{false, Axis::Y, -25},
      Event{false, Axis::X, +5},  Event{false, Axis::Y, +40},
  };

  FakeStore store_a;
  BacklashCompensator with_lash(store_a);
  with_lash.set(BacklashConfig{37, 19});
  with_lash.onHome();
  const ReplayResult a = replay(with_lash, events);

  FakeStore store_b;
  BacklashCompensator no_lash(store_b);
  no_lash.set(BacklashConfig{0, 0});
  no_lash.onHome();
  const ReplayResult b = replay(no_lash, events);

  // Logical X: 30 - 15 + 5 = 20; logical Y: 20 - 25 + 40 = 35. Backlash-free.
  CHECK(a.logical[0] == 20);
  CHECK(a.logical[1] == 35);
  CHECK(a.logical[0] == b.logical[0]);
  CHECK(a.logical[1] == b.logical[1]);

  // The zero-backlash run injects nothing; the configured run injects on every
  // reversal. X reverses twice (+30 -> -15 -> +5) and Y reverses twice
  // (+20 -> -25 -> +40), so each axis pays its backlash twice: 37*2 and 19*2.
  CHECK(b.comp_total[0] == 0);
  CHECK(b.comp_total[1] == 0);
  CHECK(a.comp_total[0] == 74);
  CHECK(a.comp_total[1] == 38);
}

TEST_CASE("Property 10 (concrete): consecutive same-direction moves emit no comp",
          "[backlash][property-10][example]") {
  FakeStore store;
  BacklashCompensator comp(store);
  comp.set(BacklashConfig{50, 50});
  comp.onHome();

  const std::vector<Event> events = {
      Event{false, Axis::X, +5}, Event{false, Axis::X, +7},
      Event{false, Axis::X, +1}, Event{false, Axis::X, +9},
  };
  const ReplayResult r = replay(comp, events);

  for (int c : r.comp_per_move) {
    CHECK(c == 0);  // no reversal anywhere => no compensation.
  }
  CHECK(r.comp_total[0] == 0);
  CHECK(r.logical[0] == 22);  // 5 + 7 + 1 + 9.
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
