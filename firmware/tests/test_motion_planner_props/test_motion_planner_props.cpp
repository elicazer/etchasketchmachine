// Host-side property tests for MotionPlanner pause/resume (Task 6.10).
//
// Property 18: Pause/resume position fidelity (Design §7, §3.2.5, §5.5).
//
//   *For any* PlannedPath `prog` (here: a non-degenerate single segment or a
//   short sequence of segments) and *any* pause point `i` along its execution
//   timeline, the position observed at STATE = paused equals the position
//   resulting from executing prog[0..i], and the suffix executed after RESUME
//   produces the same final position as executing prog without pause. No
//   segment is partially repeated or skipped.
//
//   Validates: Requirements 9.4 (resume continues from the exact paused
//   position) and, in passing, 9.2 (pause halts motor movement: no pulses are
//   emitted while paused).
//
// Why this is the right shape for the property
// --------------------------------------------
// The planner's observable channels on the host are the logical position()
// (counted full steps from home), the cumulative microstepsEmitted() pulse
// count, isPaused(), and isIdle(). A real GPT timer is replaced by driving
// onStepIsr() by hand, exactly as the task-6.9 sanity test does (FakeStepSink,
// FakeBacklashStore, FakeMotionNvm, pumpFullStep, runToIdle). Each emitted full
// motor step is MICROSTEP_FACTOR (16) microstep ISR ticks; one onStepIsr() call
// emits one microstep pulse on each axis that steps on the current tick, so a
// segment with deltas (dx, dy) emits exactly (|dx| + |dy|) * 16 microstep
// pulses and lands on (dx, dy) counted full steps.
//
// To test Property 18 we run the SAME generated program three ways with three
// independent sets of fakes:
//
//   A) "reference": submit every segment, then run straight to idle with no
//      pause. This yields the no-pause final position and total pulse count.
//
//   B) "paused":    submit every segment, advance exactly `k` full steps,
//      pause(), pump an arbitrary number of onStepIsr() ticks AND a
//      serviceLoop() while paused (asserting position() and microstepsEmitted()
//      are frozen and that no new segment is started -- Req 9.2/9.4), then
//      resume() and run to idle.
//
//   C) "partial oracle": submit every segment and advance exactly `k` full
//      steps with NO pause. This is the independent witness for "executing
//      prog[0..i]": the position B observes at STATE = paused must equal C's
//      position, proving pause froze the stylus at the correct partial point
//      and the idle ticks neither lost nor duplicated a step.
//
// Headline assertions:
//   * position(A) == position(B) == (Σdx, Σdy)            (no-pause == paused)
//   * microstepsEmitted(A) == microstepsEmitted(B)
//        == Σ (|dx| + |dy|) * MICROSTEP_FACTOR            (no pulse lost/dup'd)
//   * position(B at pause) == position(C)                 (correct partial pos)
//   * while paused: position() and microstepsEmitted() are invariant under any
//     number of onStepIsr()/serviceLoop() calls           (Req 9.2)
//
// Generated segments are constrained to be non-degenerate (|dx| + |dy| >= 1) so
// that the full-step accounting used to choose the pause point is exact: a
// zero-length segment is finalised by serviceLoop() without consuming a full
// step, which would desynchronise the "pause after k full steps" index. The
// planner itself handles zero-length moves correctly (covered by the task-6.9
// sanity test); they are simply uninteresting for the pause-index arithmetic
// here. Backlash is left at its 0/0 default so no uncounted compensation steps
// are injected (that interaction is Property 10's job, task 6.8).
//
// This translation unit lives in its own PlatformIO test directory
// (test_motion_planner_props/) so it compiles and links into a standalone test
// binary, separate from test_motion_planner/. It therefore supplies its own
// `int main` and pulls the implementations in directly via relative includes of
// the .cpp bodies -- matching the convention in test_motion_planner/,
// test_bresenham_props/, and test_backlash_props/ -- so the host_test
// environment (test_build_src = no) stays self-contained with a single
// definition of each module's symbols.
//
// The properties are exercised with rapidcheck via the standalone rc::check
// form invoked from inside Catch2 TEST_CASEs (mirroring the other *_props/
// suites). rc::check returns true on success; wrapping it in REQUIRE means a
// failing property (with rapidcheck's shrunk counterexample on stderr) surfaces
// as a Catch2 failure.
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
#include "../../src/motion/motion_planner.h"

// Implementations (test_build_src = no -> include the .cpp bodies directly).
#include "../../src/backlash/backlash_compensator.cpp"  // NOLINT
#include "../../src/motion/bresenham.cpp"               // NOLINT
#include "../../src/motion/ramp.cpp"                    // NOLINT
#include "../../src/motion/motion_planner.cpp"          // NOLINT

using etch::DrawingCommand;
using etch::FEED_SPS_MAX;
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

// ---------------------------------------------------------------------------
// Fakes -- identical in shape to the task-6.9 sanity harness.
// ---------------------------------------------------------------------------

// In-memory backlash store. A default-shaped record carries backlash 0/0 so a
// fresh load() injects no compensation steps (Requirement 13.10).
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

// Pin-output fake: counts microstep pulses and latches DIR / EN.
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

// NVM fake: records the staged position and counts mutate/flush calls.
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

// Test harness bundling a planner with its fakes (backlash 0/0).
struct Harness {
  FakeBacklashStore store;
  BacklashCompensator backlash{store};
  FakeStepSink sink;
  FakeMotionNvm nvm;
  MotionPlanner::RingBufferT buffer;
  MotionPlanner planner{buffer, backlash, sink, nvm};

  Harness() {
    backlash.load();  // backlash 0/0 -> never injects compensation steps
    planner.begin();
  }
};

DrawingCommand makeCmd(std::uint32_t seq, std::int16_t dx, std::int16_t dy,
                       std::uint16_t feed) {
  DrawingCommand c{};
  c.seq = seq;
  c.dx_steps = dx;
  c.dy_steps = dy;
  c.feed_sps = feed;
  c.flags = 0;
  c.reserved = 0;
  c.crc16_payload = 0;
  return c;
}

// ---------------------------------------------------------------------------
// Generated program: a short sequence of non-degenerate segments.
// ---------------------------------------------------------------------------

struct Seg {
  std::int32_t dx;
  std::int32_t dy;
  std::uint16_t feed;
};

constexpr int kDeltaBound = 200;  // |dx|, |dy| <= 200 (modest, fits int16_t)
constexpr int kMaxSegments = 4;   // a "short sequence" of segments

long iabs(long v) { return v < 0 ? -v : v; }
long imax(long a, long b) { return a > b ? a : b; }

// Sample 1..kMaxSegments non-degenerate segments. Called from inside an
// rc::check property (uses rapidcheck's operator*).
std::vector<Seg> genSegments() {
  const int n = *rc::gen::inRange(1, kMaxSegments + 1);
  std::vector<Seg> segs;
  segs.reserve(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    Seg s{};
    s.dx = *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1);
    s.dy = *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1);
    // Force non-degenerate so the full-step pause index stays exact.
    if (s.dx == 0 && s.dy == 0) s.dx = 1;
    s.feed = static_cast<std::uint16_t>(
        *rc::gen::inRange(static_cast<int>(FEED_SPS_MIN),
                          static_cast<int>(FEED_SPS_MAX) + 1));
    segs.push_back(s);
  }
  return segs;
}

// Total full-step ticks across the program == Σ max(|dx|, |dy|).
long totalFullSteps(const std::vector<Seg>& segs) {
  long t = 0;
  for (const Seg& s : segs) t += imax(iabs(s.dx), iabs(s.dy));
  return t;
}

// Final logical position == Σ (dx, dy).
Position expectedPosition(const std::vector<Seg>& segs) {
  Position p{0, 0};
  for (const Seg& s : segs) {
    p.x_steps += s.dx;
    p.y_steps += s.dy;
  }
  return p;
}

// Total microstep pulses == Σ (|dx| + |dy|) * MICROSTEP_FACTOR.
std::uint32_t expectedMicrosteps(const std::vector<Seg>& segs) {
  long pulses = 0;
  for (const Seg& s : segs) pulses += (iabs(s.dx) + iabs(s.dy));
  return static_cast<std::uint32_t>(pulses * MICROSTEP_FACTOR);
}

// ---------------------------------------------------------------------------
// Drivers (reuse the task-6.9 harness shape).
// ---------------------------------------------------------------------------

void submitAll(Harness& h, const std::vector<Seg>& segs) {
  for (std::size_t i = 0; i < segs.size(); ++i) {
    // kMaxSegments (4) << COMMAND_BUFFER_SIZE (32), so every push succeeds.
    h.planner.submit(makeCmd(static_cast<std::uint32_t>(i),
                             static_cast<std::int16_t>(segs[i].dx),
                             static_cast<std::int16_t>(segs[i].dy),
                             segs[i].feed));
  }
}

// Pump exactly one full motor step worth of emitted microsteps.
//
// DDS-aware: the GPT now ticks at a fixed STEP_TICK_HZ and onStepIsr() only
// emits a microstep when the software phase accumulator rolls over, so one full
// motor step spans a *variable* number of raw onStepIsr() calls depending on
// the commanded speed (fast feeds emit roughly every 2 ticks; the slow pull-in
// step emits roughly every 62 ticks). One full Bresenham step is always
// MICROSTEP_FACTOR *emitting* ticks (each emitting tick decrements
// micro_remaining_ once and pulses every stepping axis), so we drive raw ticks
// until MICROSTEP_FACTOR emitting ticks have occurred. This reproduces the
// pre-DDS contract of advancing exactly one counted full step, independent of
// the timer-rate mechanism.
void pumpFullStep(MotionPlanner& mp) {
  long emittingTicks = 0;
  std::uint32_t prev = mp.microstepsEmitted();
  long guard = 0;
  const long guardMax = 5'000'000;
  while (emittingTicks < MICROSTEP_FACTOR) {
    mp.onStepIsr();
    const std::uint32_t now = mp.microstepsEmitted();
    if (now != prev) {  // a microstep was emitted -> one emitting (Bresenham) tick
      ++emittingTicks;
      prev = now;
    }
    if (++guard > guardMax) break;  // logic bug guard (never reached in practice)
  }
}

// Advance the planner by exactly `count` full motor steps, servicing the loop
// each step so segments start and finalise. Because every generated segment is
// non-degenerate, one full step is emitted per iteration with no wasted ticks,
// so this lands precisely on the `count`-th full step (for count in
// [0, totalFullSteps]). MUST NOT be called while paused.
void advanceFullSteps(MotionPlanner& mp, long count) {
  for (long i = 0; i < count; ++i) {
    mp.serviceLoop();
    pumpFullStep(mp);
  }
}

// Drive the planner to idle. Bounded so a logic bug fails fast. MUST NOT be
// used while paused (a paused planner never reaches idle by design).
void runToIdle(MotionPlanner& mp, long maxFullSteps = 200000) {
  long guard = 0;
  while (!mp.isIdle()) {
    mp.serviceLoop();
    pumpFullStep(mp);
    if (++guard > maxFullSteps) {
      RC_ASSERT(guard <= maxFullSteps);  // iteration budget blown -> bug
      return;
    }
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 18 (headline): pausing after k full steps then resuming yields the
// same final position and the same total pulse count as never pausing, and the
// position observed at the pause equals executing only the first k full steps.
// ---------------------------------------------------------------------------
TEST_CASE("Property 18: pause/resume preserves final position and step count",
          "[motion][property][property-18]") {
  REQUIRE(rc::check(
      "paused run == no-pause run; pause freezes at the correct partial pos",
      [] {
        const std::vector<Seg> segs = genSegments();
        const long total = totalFullSteps(segs);
        const Position expPos = expectedPosition(segs);
        const std::uint32_t expMicro = expectedMicrosteps(segs);

        // Pause point: an arbitrary full-step index in [0, total], inclusive of
        // both ends (pause before the first step and after the last).
        const long k = *rc::gen::inRange<long>(0, total + 1);

        // --- Run A: reference, no pause -------------------------------------
        Harness a;
        submitAll(a, segs);
        runToIdle(a.planner);
        const Position posA = a.planner.position();
        const std::uint32_t microA = a.planner.microstepsEmitted();

        // Sanity: the no-pause run matches the closed-form oracle.
        RC_ASSERT(posA.x_steps == expPos.x_steps);
        RC_ASSERT(posA.y_steps == expPos.y_steps);
        RC_ASSERT(microA == expMicro);

        // --- Run C: independent partial-position witness (no pause) ----------
        Harness c;
        submitAll(c, segs);
        advanceFullSteps(c.planner, k);
        const Position posPartial = c.planner.position();

        // --- Run B: pause after k full steps, then resume --------------------
        Harness b;
        submitAll(b, segs);
        advanceFullSteps(b.planner, k);

        b.planner.pause();
        RC_ASSERT(b.planner.isPaused());

        // The position at STATE = paused equals executing only prog[0..k]
        // (Property 18 first clause): no over- or under-shoot from pausing.
        const Position posAtPause = b.planner.position();
        const std::uint32_t microAtPause = b.planner.microstepsEmitted();
        RC_ASSERT(posAtPause.x_steps == posPartial.x_steps);
        RC_ASSERT(posAtPause.y_steps == posPartial.y_steps);

        // While paused, NO pulses are emitted and the position does not move,
        // no matter how many ISR ticks (and a serviceLoop) occur (Req 9.2).
        const int idleTicks = *rc::gen::inRange(0, 500);
        for (int i = 0; i < idleTicks; ++i) {
          b.planner.onStepIsr();
        }
        b.planner.serviceLoop();  // must not start a new segment while paused
        RC_ASSERT(b.planner.isPaused());
        RC_ASSERT(b.planner.microstepsEmitted() == microAtPause);
        RC_ASSERT(b.planner.position().x_steps == posAtPause.x_steps);
        RC_ASSERT(b.planner.position().y_steps == posAtPause.y_steps);

        // --- Resume and finish: identical to the no-pause run ----------------
        b.planner.resume();
        RC_ASSERT(!b.planner.isPaused());
        runToIdle(b.planner);

        const Position posB = b.planner.position();
        RC_ASSERT(posB.x_steps == posA.x_steps);
        RC_ASSERT(posB.y_steps == posA.y_steps);
        // No step lost or duplicated across the pause boundary.
        RC_ASSERT(b.planner.microstepsEmitted() == microA);
        RC_ASSERT(b.sink.stepsX == a.sink.stepsX);
        RC_ASSERT(b.sink.stepsY == a.sink.stepsY);
      }));
}

// ---------------------------------------------------------------------------
// Property 18 (freeze invariant, microstep granularity): pausing partway
// through a single segment -- including partway through a full step -- freezes
// position() and microstepsEmitted() under an arbitrary number of onStepIsr()
// calls, and resuming still lands exactly on target. This exercises the
// retention of mid-full-step ISR state (micro_remaining_) across the pause.
// ---------------------------------------------------------------------------
TEST_CASE("Property 18: pause mid-microstep freezes state and resumes exactly",
          "[motion][property][property-18]") {
  REQUIRE(rc::check(
      "single segment: arbitrary microstep pause point is frozen then exact",
      [] {
        // One non-degenerate segment so microstep accounting is unambiguous.
        std::int32_t dx = *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1);
        std::int32_t dy = *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1);
        if (dx == 0 && dy == 0) dx = 1;
        const auto feed = static_cast<std::uint16_t>(
            *rc::gen::inRange(static_cast<int>(FEED_SPS_MIN),
                              static_cast<int>(FEED_SPS_MAX) + 1));

        // A single segment runs for max(|dx|, |dy|) full-step ticks, each of
        // MICROSTEP_FACTOR microstep ISR ticks. Its TOTAL emitted microstep
        // pulses, however, are (|dx| + |dy|) * MICROSTEP_FACTOR (a diagonal
        // tick pulses both axes), which is what the final count must equal.
        const long tickCount = imax(iabs(dx), iabs(dy)) * MICROSTEP_FACTOR;
        const long totalMicro = (iabs(dx) + iabs(dy)) * MICROSTEP_FACTOR;
        // Pause after `m` microstep ISR ticks, anywhere in [0, tickCount].
        const long m = *rc::gen::inRange<long>(0, tickCount + 1);

        Harness h;
        h.planner.submit(makeCmd(0, static_cast<std::int16_t>(dx),
                                 static_cast<std::int16_t>(dy), feed));

        // Advance exactly `m` microstep ticks, servicing the loop so the single
        // segment starts. Stops early if the program goes idle.
        long done = 0;
        while (done < m && !h.planner.isIdle()) {
          h.planner.serviceLoop();
          if (h.planner.isIdle()) break;
          h.planner.onStepIsr();
          ++done;
        }

        h.planner.pause();
        RC_ASSERT(h.planner.isPaused());

        const std::uint32_t microAtPause = h.planner.microstepsEmitted();
        const Position posAtPause = h.planner.position();

        // The pulses emitted so far equal exactly the ticks we drove (each
        // onStepIsr emits one pulse per stepping axis; a single segment steps
        // at most one axis... or both on a pure diagonal). We only need that
        // pausing does not change the running pulse total.
        const int extraTicks = *rc::gen::inRange(0, 400);
        for (int i = 0; i < extraTicks; ++i) {
          h.planner.onStepIsr();
        }
        RC_ASSERT(h.planner.microstepsEmitted() == microAtPause);
        RC_ASSERT(h.planner.position().x_steps == posAtPause.x_steps);
        RC_ASSERT(h.planner.position().y_steps == posAtPause.y_steps);

        // Resume and complete: lands exactly on (dx, dy) with the full pulse
        // count -- no microstep lost or duplicated across the pause boundary.
        h.planner.resume();
        runToIdle(h.planner);
        RC_ASSERT(h.planner.position().x_steps == dx);
        RC_ASSERT(h.planner.position().y_steps == dy);
        RC_ASSERT(h.planner.microstepsEmitted() ==
                  static_cast<std::uint32_t>(totalMicro));
      }));
}

// ---------------------------------------------------------------------------
// Concrete pause points (plain Catch2). These pin down the headline framing on
// hand-worked examples: pause at the very start, mid-segment, and at the last
// step, complementing the randomized properties above.
// ---------------------------------------------------------------------------

TEST_CASE("Property 18 (concrete): pause at step 0 then resume reaches target",
          "[motion][property-18][example]") {
  Harness h;
  REQUIRE(h.planner.submit(makeCmd(0, 40, 0, 500)));

  // Pause before emitting a single step.
  h.planner.pause();
  CHECK(h.planner.isPaused());
  CHECK(h.planner.position().x_steps == 0);
  CHECK(h.planner.microstepsEmitted() == 0u);

  // Servicing + ISR ticks while paused do nothing (no segment starts).
  for (int i = 0; i < 50; ++i) {
    h.planner.serviceLoop();
    h.planner.onStepIsr();
  }
  CHECK(h.planner.position().x_steps == 0);
  CHECK(h.planner.microstepsEmitted() == 0u);

  h.planner.resume();
  runToIdle(h.planner);
  CHECK(h.planner.position().x_steps == 40);
  CHECK(h.planner.position().y_steps == 0);
  CHECK(h.planner.microstepsEmitted() == 40u * MICROSTEP_FACTOR);
}

TEST_CASE("Property 18 (concrete): pause mid-segment freezes the partial pos",
          "[motion][property-18][example]") {
  Harness h;
  REQUIRE(h.planner.submit(makeCmd(0, 40, 0, 500)));
  h.planner.serviceLoop();  // start the segment

  // Advance 15 full steps, then pause mid-segment.
  for (int i = 0; i < 15; ++i) pumpFullStep(h.planner);
  CHECK(h.planner.position().x_steps == 15);

  h.planner.pause();
  const std::uint32_t pulses = h.planner.microstepsEmitted();
  const std::int32_t pos = h.planner.position().x_steps;

  // Pump many ISR ticks while paused: nothing moves (Req 9.2).
  for (int i = 0; i < 200; ++i) h.planner.onStepIsr();
  CHECK(h.planner.microstepsEmitted() == pulses);
  CHECK(h.planner.position().x_steps == pos);

  // Resume and finish: exact target, no steps lost (Req 9.4).
  h.planner.resume();
  runToIdle(h.planner);
  CHECK(h.planner.position().x_steps == 40);
  CHECK(h.planner.microstepsEmitted() == 40u * MICROSTEP_FACTOR);
}

TEST_CASE("Property 18 (concrete): pause at the last step still lands on target",
          "[motion][property-18][example]") {
  Harness h;
  REQUIRE(h.planner.submit(makeCmd(0, 12, 12, 400)));  // diagonal: 12 ticks

  // Advance all 12 full steps (max(|dx|,|dy|) == 12), then pause.
  advanceFullSteps(h.planner, 12);
  CHECK(h.planner.position().x_steps == 12);
  CHECK(h.planner.position().y_steps == 12);

  h.planner.pause();
  const std::uint32_t pulses = h.planner.microstepsEmitted();
  for (int i = 0; i < 100; ++i) h.planner.onStepIsr();
  CHECK(h.planner.microstepsEmitted() == pulses);

  // Resume + service finalises the already-complete segment; idle at target.
  h.planner.resume();
  runToIdle(h.planner);
  CHECK(h.planner.position().x_steps == 12);
  CHECK(h.planner.position().y_steps == 12);
  // Diagonal steps both axes every tick: (12 + 12) * 16 microsteps.
  CHECK(h.planner.microstepsEmitted() == 24u * MICROSTEP_FACTOR);
}

TEST_CASE("Property 18 (concrete): multi-segment pause at a segment boundary",
          "[motion][property-18][example]") {
  // Two segments; pause exactly when the first completes (boundary case).
  Harness h;
  REQUIRE(h.planner.submit(makeCmd(0, 10, 0, 500)));   // 10 full steps
  REQUIRE(h.planner.submit(makeCmd(1, 0, 8, 500)));    // 8 full steps

  advanceFullSteps(h.planner, 10);  // first segment fully done
  h.planner.pause();
  CHECK(h.planner.position().x_steps == 10);
  CHECK(h.planner.position().y_steps == 0);

  const std::uint32_t pulses = h.planner.microstepsEmitted();
  for (int i = 0; i < 80; ++i) h.planner.onStepIsr();
  h.planner.serviceLoop();  // must not start the second segment while paused
  CHECK(h.planner.microstepsEmitted() == pulses);
  CHECK(h.planner.position().y_steps == 0);

  h.planner.resume();
  runToIdle(h.planner);
  CHECK(h.planner.position().x_steps == 10);
  CHECK(h.planner.position().y_steps == 8);
  CHECK(h.planner.microstepsEmitted() == (10u + 8u) * MICROSTEP_FACTOR);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
