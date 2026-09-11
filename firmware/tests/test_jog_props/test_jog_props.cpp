// Host-side property tests for the single full-step manual jog (Task 6.11).
//
// Property 16: Single full-step jog (Design §7, Requirement 10.3).
//
//   *For any* jog click on axis a ∈ {X, Y} in direction d ∈ {-1, +1} while the
//   system is in the calibration / idle state, the logical position observed
//   after the resulting JOG { steps: 1 } completes equals the previous position
//   offset by exactly ONE full motor step on axis a in direction d, with the
//   other axis unchanged. A full motor step is 1.8° of rotation and is emitted
//   as MICROSTEP_FACTOR (16) microstep pulses.
//
//   Validates: Requirement 10.3.
//
// What "jog" is in this firmware, and why this is the right mechanism to test
// ---------------------------------------------------------------------------
// There is no separate jog code path in the motion stack. On the wire a jog is
// a CTL frame `JOG { axis, dir, steps }` (control_parser.h, Design §4.6); the
// common case is steps == 1 (Req 10.3, JOG_STEPS_MIN). The main cooperative
// loop (task 8.1) turns that CTL message into a single Drawing_Command on the
// chosen axis and feeds it to the MotionPlanner exactly like any other segment
// (Design §5.2: "CTL JOG {axis, dir, steps:1}" -> "1 full step (16 microsteps)"
// -> "STATUS {pos updated by +/-1}"). The motion semantics of a jog therefore
// live entirely in the MotionPlanner: a jog is a one-full-step move with
// dx = ±1, dy = 0 (X axis) or dx = 0, dy = ±1 (Y axis).
//
// So this test models a jog as that single-full-step Drawing_Command submitted
// to a real MotionPlanner and asserts the full-step semantics on the planner's
// observable outputs:
//   * the logical position (counted full steps; Requirement 6.2 / 13.7), and
//   * the microstep pulse stream emitted through the IStepSink (Requirement 6.2:
//     one full step == MICROSTEP_FACTOR microsteps).
//
// Property 16 is checked through five facets, matching the task breakdown:
//   1. A single jog moves exactly one full step on the chosen axis and zero on
//      the other (planner pulses + logical delta).
//   2. The logical position changes by exactly ±1 on the chosen axis (matching
//      the jog direction) and is unchanged on the other axis.
//   3. The microstep output for the jog is exactly MICROSTEP_FACTOR (16) pulses
//      on the chosen axis and 0 on the other.
//   4. Repeated jogs accumulate: N jogs in one direction move exactly N full
//      steps (and 16·N microsteps) on that axis.
//   5. A +1 jog followed by a -1 jog returns to the original position (net
//      zero), with the DIR line latched to each jog's direction in turn.
// Plus the headline position-fidelity invariant (logical == physical) is held
// with backlash 0, and one extra facet shows that with NON-zero backlash a
// reversing jog still changes the logical position by exactly ±1 even though
// extra (uncounted) compensation microsteps are physically emitted (task 6.7,
// Requirement 13.7).
//
// Harness / build convention
// ---------------------------
// This translation unit lives in its own PlatformIO test directory
// (test_jog_props/) so it links into a standalone binary with its own
// `int main`. Mirroring test_motion_planner/ and the other *_props/ suites, and
// because the host_test environment sets `test_build_src = no`, it pulls the
// implementations in directly via relative .cpp includes (backlash +
// bresenham + ramp + motion_planner) and drives onStepIsr() by hand in place of
// a real GPT timer. The host harness shape (FakeStepSink, FakeBacklashStore,
// FakeMotionNvm, pumpFullStep, runToIdle) is reused from test_motion_planner/.
//
// Properties are exercised with rapidcheck via the standalone rc::check form
// invoked from inside Catch2 TEST_CASEs (as in test_backlash_props/ /
// test_command_parser_props/); rc::check returns true on success, so wrapping it
// in REQUIRE surfaces a failing property (with rapidcheck's shrunk
// counterexample on stderr) as a Catch2 failure.
//
// Run with:
//
//     pio test -e host_test
//
// (PlatformIO pins Catch2 v3.5.3 + rapidcheck for the host_test env; see
// platformio.ini.)

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>

#include "../../src/types.h"
#include "../../src/backlash/backlash_compensator.h"
#include "../../src/motion/motion_planner.h"

// Implementations (test_build_src = no -> include the .cpp bodies directly).
#include "../../src/backlash/backlash_compensator.cpp"  // NOLINT
#include "../../src/motion/bresenham.cpp"               // NOLINT
#include "../../src/motion/ramp.cpp"                    // NOLINT
#include "../../src/motion/motion_planner.cpp"          // NOLINT

using etch::BacklashConfig;
using etch::DrawingCommand;
using etch::FEED_SPS_MIN;
using etch::MICROSTEP_FACTOR;
using etch::NVM_MAGIC;
using etch::NVM_VERSION;
using etch::PersistedConfig;
using etch::Position;
using etch::backlash::BacklashCompensator;
using etch::backlash::IBacklashStore;
using etch::motion::IMotionNvm;
using etch::motion::IStepSink;
using etch::motion::MotionPlanner;

namespace {

// --- In-memory backlash store (same shape as test_motion_planner's fake) ----
class FakeBacklashStore : public IBacklashStore {
 public:
  FakeBacklashStore() {
    std::memset(&cfg_, 0, sizeof(cfg_));
    cfg_.magic = NVM_MAGIC;
    cfg_.version = NVM_VERSION;
  }
  const PersistedConfig& get() const override { return cfg_; }
  void mutate(std::function<void(PersistedConfig&)> fn) override { fn(cfg_); }
  PersistedConfig& raw() { return cfg_; }

 private:
  PersistedConfig cfg_;
};

// --- Pin-output fake: counts microstep pulses and latches DIR / EN ----------
class FakeStepSink : public IStepSink {
 public:
  std::int8_t dirX = 0;
  std::int8_t dirY = 0;
  std::uint32_t stepsX = 0;
  std::uint32_t stepsY = 0;
  bool enabled = false;

  void setDirX(std::int8_t dir) override { dirX = dir; }
  void setDirY(std::int8_t dir) override { dirY = dir; }
  void stepX() override { ++stepsX; }
  void stepY() override { ++stepsY; }
  void setEnabled(bool e) override { enabled = e; }
};

// --- NVM fake: records staged position + counts mutate/flush calls ----------
class FakeMotionNvm : public IMotionNvm {
 public:
  PersistedConfig cfg{};
  std::size_t mutates = 0;
  std::size_t flushes = 0;

  FakeMotionNvm() { std::memset(&cfg, 0, sizeof(cfg)); }

  void mutate(std::function<void(PersistedConfig&)> fn) override {
    fn(cfg);
    ++mutates;
  }
  void flushIfDue() override { ++flushes; }
};

// --- Test harness bundling a planner with its fakes -------------------------
// Optionally seeds a per-axis backlash and starts in the post-home state, so
// the same harness covers both the backlash-0 fidelity facets and the
// non-zero-backlash "compensation steps stay uncounted" facet.
struct Harness {
  FakeBacklashStore store;
  BacklashCompensator backlash{store};
  FakeStepSink sink;
  FakeMotionNvm nvm;
  MotionPlanner::RingBufferT buffer;
  MotionPlanner planner{buffer, backlash, sink, nvm};

  explicit Harness(BacklashConfig lash = BacklashConfig{0, 0}) {
    backlash.load();    // empty record -> documented default 0/0 (Req 13.10).
    backlash.set(lash);  // override per the facet under test (clamped 0..200).
    backlash.onHome();   // calibration/idle state: no remembered direction.
    planner.begin();
  }
};

// Build the single-full-step Drawing_Command that the main loop synthesises
// from a JOG { axis, dir, steps: 1 } (Design §5.2). dir is in {-1, +1}; the
// jog moves exactly one full step on the selected axis and zero on the other.
DrawingCommand makeJogCmd(std::uint32_t seq, bool isX, std::int8_t dir) {
  DrawingCommand c{};
  c.seq = seq;
  c.dx_steps = isX ? static_cast<std::int16_t>(dir) : 0;
  c.dy_steps = isX ? 0 : static_cast<std::int16_t>(dir);
  c.feed_sps = FEED_SPS_MIN;  // jogs run at the safe step-rate floor.
  c.flags = 0;
  c.reserved = 0;
  c.crc16_payload = 0;
  return c;
}

// Pump exactly one full motor step worth of microstep ISR ticks.
void pumpFullStep(MotionPlanner& mp) {
  for (std::uint8_t k = 0; k < MICROSTEP_FACTOR; ++k) {
    mp.onStepIsr();
  }
}

// Drive the planner to idle: service the loop, pump a full step's worth of ISR
// ticks, repeat until idle. Bounded so a logic bug fails fast instead of
// hanging the suite.
void runToIdle(MotionPlanner& mp, int maxFullSteps = 100000) {
  int guard = 0;
  while (!mp.isIdle()) {
    mp.serviceLoop();
    pumpFullStep(mp);
    if (++guard > maxFullSteps) {
      CHECK(guard <= maxFullSteps);
      return;
    }
  }
}

// Submit one jog and run it to completion, exactly as the main loop would.
void doJog(MotionPlanner& mp, std::uint32_t seq, bool isX, std::int8_t dir) {
  const bool accepted = mp.submit(makeJogCmd(seq, isX, dir));
  RC_ASSERT(accepted);  // an idle planner always has a free buffer slot.
  runToIdle(mp);
}

// rapidcheck generators (used inside an rc::check property body). A jog targets
// a uniformly chosen axis and a direction in {-1, +1}.
bool genIsX() { return *rc::gen::inRange(0, 2) == 0; }
std::int8_t genDir() { return (*rc::gen::inRange(0, 2) == 0) ? -1 : 1; }

}  // namespace

// ---------------------------------------------------------------------------
// Property 16 (facets 1-3): a single jog moves exactly one full step on the
// chosen axis (16 microsteps), zero on the other; the logical position changes
// by exactly ±1 matching the direction; backlash 0 -> logical == physical.
// ---------------------------------------------------------------------------
TEST_CASE("Property 16: a single jog moves exactly one full step on one axis",
          "[motion][jog][property][property-16]") {
  REQUIRE(rc::check(
      "JOG {steps:1} -> +/-1 full step on chosen axis, 0 on the other", [] {
        const bool isX = genIsX();
        const std::int8_t dir = genDir();

        Harness h;  // backlash 0/0, post-home (calibration/idle state).
        const Position before = h.planner.position();

        doJog(h.planner, /*seq=*/0, isX, dir);

        const Position after = h.planner.position();

        if (isX) {
          // Facet 2: logical X moves by exactly the jog direction; Y unchanged.
          RC_ASSERT(after.x_steps == before.x_steps + dir);
          RC_ASSERT(after.y_steps == before.y_steps);
          // Facet 3: exactly 16 microsteps on X, none on Y.
          RC_ASSERT(h.sink.stepsX == static_cast<std::uint32_t>(MICROSTEP_FACTOR));
          RC_ASSERT(h.sink.stepsY == 0u);
          // DIR latched to the jog direction; drivers energised for the move.
          RC_ASSERT(h.sink.dirX == dir);
        } else {
          RC_ASSERT(after.y_steps == before.y_steps + dir);
          RC_ASSERT(after.x_steps == before.x_steps);
          RC_ASSERT(h.sink.stepsY == static_cast<std::uint32_t>(MICROSTEP_FACTOR));
          RC_ASSERT(h.sink.stepsX == 0u);
          RC_ASSERT(h.sink.dirY == dir);
        }
        RC_ASSERT(h.sink.enabled);

        // Facet 1 / headline fidelity: with backlash 0 the counted (logical)
        // motion equals the physical microstep stream divided by the microstep
        // factor -- exactly one full step total, no extra (uncounted) pulses.
        const std::uint32_t total_micro = h.sink.stepsX + h.sink.stepsY;
        RC_ASSERT(total_micro == static_cast<std::uint32_t>(MICROSTEP_FACTOR));
        RC_ASSERT(h.planner.microstepsEmitted() == total_micro);
      }));
}

// ---------------------------------------------------------------------------
// Property 16 (facet 4): repeated jogs accumulate. N jogs in one direction move
// exactly N full steps (and 16·N microsteps) on the chosen axis, none on the
// other. Same-direction jogs never inject backlash, so logical == physical.
// ---------------------------------------------------------------------------
TEST_CASE("Property 16: N jogs in one direction accumulate to N full steps",
          "[motion][jog][property][property-16]") {
  REQUIRE(rc::check("N same-direction jogs -> N full steps on the axis", [] {
    const bool isX = genIsX();
    const std::int8_t dir = genDir();
    const int n = *rc::gen::inRange(1, 21);  // 1..20 jog clicks.

    Harness h;
    for (int i = 0; i < n; ++i) {
      doJog(h.planner, static_cast<std::uint32_t>(i), isX, dir);
    }

    const Position p = h.planner.position();
    const std::int32_t expected = static_cast<std::int32_t>(dir) * n;
    const std::uint32_t expected_micro =
        static_cast<std::uint32_t>(n) * MICROSTEP_FACTOR;

    if (isX) {
      RC_ASSERT(p.x_steps == expected);
      RC_ASSERT(p.y_steps == 0);
      RC_ASSERT(h.sink.stepsX == expected_micro);
      RC_ASSERT(h.sink.stepsY == 0u);
    } else {
      RC_ASSERT(p.y_steps == expected);
      RC_ASSERT(p.x_steps == 0);
      RC_ASSERT(h.sink.stepsY == expected_micro);
      RC_ASSERT(h.sink.stepsX == 0u);
    }
    // No compensation injected for same-direction jogs: physical == logical.
    RC_ASSERT(h.planner.microstepsEmitted() == expected_micro);
  }));
}

// ---------------------------------------------------------------------------
// Property 16 (facet 5): a +d jog then a -d jog returns to the original
// position (net zero), with DIR latched to each jog's direction in turn.
// ---------------------------------------------------------------------------
TEST_CASE("Property 16: a jog and its opposite return to the start position",
          "[motion][jog][property][property-16]") {
  REQUIRE(rc::check("+d then -d jog -> net zero, DIR follows each jog", [] {
    const bool isX = genIsX();
    const std::int8_t dir = genDir();

    Harness h;  // backlash 0/0 so the round trip is exactly net zero.
    const Position before = h.planner.position();

    doJog(h.planner, /*seq=*/0, isX, dir);
    if (isX) {
      RC_ASSERT(h.planner.position().x_steps == before.x_steps + dir);
      RC_ASSERT(h.sink.dirX == dir);
    } else {
      RC_ASSERT(h.planner.position().y_steps == before.y_steps + dir);
      RC_ASSERT(h.sink.dirY == dir);
    }

    const std::int8_t back = static_cast<std::int8_t>(-dir);
    doJog(h.planner, /*seq=*/1, isX, back);

    const Position after = h.planner.position();
    // Net displacement is zero on both axes.
    RC_ASSERT(after.x_steps == before.x_steps);
    RC_ASSERT(after.y_steps == before.y_steps);
    // DIR was latched to the second (opposite) jog's direction.
    if (isX) {
      RC_ASSERT(h.sink.dirX == back);
    } else {
      RC_ASSERT(h.sink.dirY == back);
    }
  }));
}

// ---------------------------------------------------------------------------
// Property 16 (facet, non-zero backlash): a reversing jog still changes the
// logical position by exactly ±1. The reversal injects `b_a` uncounted
// compensation microsteps ahead of the single counted step, so the PHYSICAL
// microstep count exceeds 16, yet the LOGICAL position moves by exactly one
// step (task 6.7 / Requirement 13.7: compensation steps are not counted).
// ---------------------------------------------------------------------------
TEST_CASE("Property 16: a reversing jog moves logical +/-1 with backlash uncounted",
          "[motion][jog][property][property-16]") {
  REQUIRE(rc::check(
      "reversing jog: logical delta == +/-1 regardless of backlash", [] {
        const bool isX = genIsX();
        const std::int8_t dir = genDir();
        // Non-zero backlash on the jogged axis (1..200) so a reversal injects
        // compensation; the other axis's value is irrelevant here.
        const auto b = static_cast<std::uint8_t>(
            *rc::gen::inRange(1, etch::BACKLASH_STEPS_MAX + 1));
        const BacklashConfig lash =
            isX ? BacklashConfig{b, 0} : BacklashConfig{0, b};

        Harness h(lash);

        // First jog establishes a direction (first move after home -> no comp).
        doJog(h.planner, /*seq=*/0, isX, dir);
        const std::uint32_t micro_after_first = h.planner.microstepsEmitted();
        RC_ASSERT(micro_after_first ==
                  static_cast<std::uint32_t>(MICROSTEP_FACTOR));

        const Position mid = h.planner.position();
        // Second jog reverses direction -> backlash compensation is prepended.
        const std::int8_t back = static_cast<std::int8_t>(-dir);
        doJog(h.planner, /*seq=*/1, isX, back);
        const Position after = h.planner.position();

        // Logical position changed by exactly the jog direction (one step),
        // even though compensation steps were physically emitted.
        if (isX) {
          RC_ASSERT(after.x_steps == mid.x_steps + back);
          RC_ASSERT(after.y_steps == mid.y_steps);
        } else {
          RC_ASSERT(after.y_steps == mid.y_steps + back);
          RC_ASSERT(after.x_steps == mid.x_steps);
        }

        // The reversing jog physically emitted b compensation microsteps plus
        // the one counted full step: (b + 1) * 16 microsteps total. Those
        // b * 16 compensation microsteps are real motion that is NOT counted
        // toward the logical position (Requirement 13.7).
        const std::uint32_t micro_second =
            h.planner.microstepsEmitted() - micro_after_first;
        RC_ASSERT(micro_second ==
                  static_cast<std::uint32_t>(b + 1) * MICROSTEP_FACTOR);
      }));
}

// ---------------------------------------------------------------------------
// Concrete (axis, dir) combinations (plain Catch2). These pin down Property 16
// on the four hand-worked cases the manual jog UI exposes (both axes, both
// directions; Req 10.3), complementing the randomized properties above.
// ---------------------------------------------------------------------------

TEST_CASE("Property 16 (concrete): jog +X moves one full step right",
          "[motion][jog][property-16][example]") {
  Harness h;
  REQUIRE(h.planner.submit(makeJogCmd(0, /*isX=*/true, +1)));
  runToIdle(h.planner);

  CHECK(h.planner.position().x_steps == 1);
  CHECK(h.planner.position().y_steps == 0);
  CHECK(h.sink.stepsX == static_cast<std::uint32_t>(MICROSTEP_FACTOR));
  CHECK(h.sink.stepsY == 0u);
  CHECK(h.sink.dirX == 1);
  CHECK(h.sink.enabled);
}

TEST_CASE("Property 16 (concrete): jog -X moves one full step left",
          "[motion][jog][property-16][example]") {
  Harness h;
  REQUIRE(h.planner.submit(makeJogCmd(0, /*isX=*/true, -1)));
  runToIdle(h.planner);

  CHECK(h.planner.position().x_steps == -1);
  CHECK(h.planner.position().y_steps == 0);
  CHECK(h.sink.stepsX == static_cast<std::uint32_t>(MICROSTEP_FACTOR));
  CHECK(h.sink.stepsY == 0u);
  CHECK(h.sink.dirX == -1);
}

TEST_CASE("Property 16 (concrete): jog +Y moves one full step up",
          "[motion][jog][property-16][example]") {
  Harness h;
  REQUIRE(h.planner.submit(makeJogCmd(0, /*isX=*/false, +1)));
  runToIdle(h.planner);

  CHECK(h.planner.position().y_steps == 1);
  CHECK(h.planner.position().x_steps == 0);
  CHECK(h.sink.stepsY == static_cast<std::uint32_t>(MICROSTEP_FACTOR));
  CHECK(h.sink.stepsX == 0u);
  CHECK(h.sink.dirY == 1);
}

TEST_CASE("Property 16 (concrete): jog -Y moves one full step down",
          "[motion][jog][property-16][example]") {
  Harness h;
  REQUIRE(h.planner.submit(makeJogCmd(0, /*isX=*/false, -1)));
  runToIdle(h.planner);

  CHECK(h.planner.position().y_steps == -1);
  CHECK(h.planner.position().x_steps == 0);
  CHECK(h.sink.stepsY == static_cast<std::uint32_t>(MICROSTEP_FACTOR));
  CHECK(h.sink.stepsX == 0u);
  CHECK(h.sink.dirY == -1);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
