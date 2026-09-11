// Host-side property test for NVMManager logical-position persistence
// at quiescent points (Task 2.3).
//
// Property 14: NVM position consistency at quiescent points (Design §7, §4.4)
//
//   *For any* sequence of position updates ending in a quiescent state
//   (planner idle + a flush past the debounce window), the persisted
//   `logical_pos` in NVM equals the firmware's in-RAM `logical_pos` at the
//   moment the quiescent state is entered. (At true idle the persisted value
//   is exact; during drawing it may lag by up to NVM_WRITE_DEBOUNCE_MS.)
//
//   Validates: Requirements 10.6.
//
// Modeling (the simpler, well-defined invariant the requirement guarantees):
//
//   1. Start from erased flash; begin() loads documented defaults (pos 0,0)
//      and queues the sanitisation write.
//   2. markBusy() once, modelling "a movement command is being executed"
//      (Requirement 10.6) so the unclean marker is live during the run.
//   3. Apply N random position mutations via mutate(). After each, advance a
//      fake monotonic clock by a random delta and call flushIfDue(). Some of
//      these commits land, some are deferred by the 250 ms debounce window;
//      the property is about the FINAL state, so either outcome is fine.
//   4. Reach a quiescent point: markCleanIdle() (planner idle), advance the
//      clock past NVM_WRITE_DEBOUNCE_MS, then flushIfDue() once more. This
//      idle flush ALWAYS commits the latest cached value.
//   5. The persisted logical_pos_{x,y} MUST equal the position from the final
//      mutation (or the (0,0) default when the sequence is empty), and the
//      persisted unclean flag MUST be cleared at the quiescent point.
//   6. A fresh begin() reads the same logical position back (round-trip).
//
// rapidcheck (rc::check) drives the random sequences; the host_test
// environment links rapidcheck per platformio.ini. The file follows the
// conventions in test_nvm/test_nvm.cpp: FakeBackend, FakeClock, a
// Catch::Session main(), and a relative include of nvm_manager.cpp so this
// standalone PlatformIO test binary gets the implementation directly
// (test_build_src = no).

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <tuple>
#include <vector>

#include "../../src/types.h"
#include "../../src/nvm/nvm_manager.h"
#include "../../src/nvm/nvm_manager.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::NVM_FLAG_UNCLEAN;
using etch::NVM_RECORD_SIZE;
using etch::NVM_WRITE_DEBOUNCE_MS;
using etch::PersistedConfig;
using etch::nvm::NVMBackend;
using etch::nvm::NVMManager;

namespace {

// In-memory backend that simulates erased flash (all-0xFF) so begin() falls
// through to documented defaults on first boot.
class FakeBackend final : public NVMBackend {
 public:
  FakeBackend() { storage_.fill(0xFF); }

  void readRecord(std::uint8_t* out, std::size_t len) override {
    REQUIRE(len == NVM_RECORD_SIZE);
    std::memcpy(out, storage_.data(), len);
  }

  void writeRecord(const std::uint8_t* in, std::size_t len) override {
    REQUIRE(len == NVM_RECORD_SIZE);
    std::memcpy(storage_.data(), in, len);
    ++write_count_;
  }

  std::uint8_t* raw() { return storage_.data(); }
  const std::uint8_t* raw() const { return storage_.data(); }
  std::size_t writes() const { return write_count_; }

 private:
  std::array<std::uint8_t, NVM_RECORD_SIZE> storage_;
  std::size_t write_count_ = 0;
};

// Manually advanced fake clock so the debounce window can be crossed
// deterministically.
struct FakeClock {
  static std::uint32_t now_ms;
  static std::uint32_t read() { return now_ms; }
};
std::uint32_t FakeClock::now_ms = 0;

// A single position update interleaved with a debounce-respecting flush. The
// dt is the clock advance applied immediately before flushIfDue().
//   <0> logical_pos_x, <1> logical_pos_y, <2> clock delta (ms)
using Step = std::tuple<std::int32_t, std::int32_t, std::uint32_t>;

// i32 positions are bounded to a sane range so shrunk counterexamples stay
// readable; the full int32 range is not needed to exercise this property.
constexpr std::int32_t kPosMin = -1000000;
constexpr std::int32_t kPosMax = 1000000;  // inclusive
constexpr std::uint32_t kDtMax = 1000;     // exclusive upper bound on dt

// Drive the manager through an arbitrary sequence of position updates to a
// quiescent point and return the position observed on the persisted record.
// Also reports whether the persisted unclean flag is clear at that point and
// what the in-RAM logical position is when idle is entered (the value the
// requirement says NVM must match).
struct QuiescentOutcome {
  std::int32_t expected_x;       // in-RAM logical pos as idle is entered
  std::int32_t expected_y;
  std::int32_t persisted_x;      // value read back from the backing store
  std::int32_t persisted_y;
  bool persisted_unclean_clear;  // unclean flag cleared on the stored record
  std::int32_t reloaded_x;       // value a fresh begin() reads back
  std::int32_t reloaded_y;
};

QuiescentOutcome runToQuiescent(const std::vector<Step>& steps) {
  FakeBackend backend;
  FakeClock::now_ms = 0;

  NVMManager m(backend, &FakeClock::read);
  m.begin();  // defaults (pos 0,0), queues sanitisation write.

  // A movement command is being executed: mark the record busy so the
  // unclean marker is live throughout the run (Design §4.4).
  m.markBusy();

  // Defaults put the stylus at the home origin before any motion.
  std::int32_t expected_x = 0;
  std::int32_t expected_y = 0;

  for (const auto& s : steps) {
    const std::int32_t x = std::get<0>(s);
    const std::int32_t y = std::get<1>(s);
    const std::uint32_t dt = std::get<2>(s);

    m.mutate([&](PersistedConfig& c) {
      c.logical_pos_x = x;
      c.logical_pos_y = y;
    });
    expected_x = x;
    expected_y = y;

    FakeClock::now_ms += dt;  // some flushes land, some are debounced away.
    m.flushIfDue();
  }

  // Quiescent point: planner idle, then a flush guaranteed to be past the
  // debounce window (advancing by NVM_WRITE_DEBOUNCE_MS from "now" makes the
  // elapsed-since-last-write at least one full window, since the last write
  // could only have happened at or before "now").
  m.markCleanIdle();
  FakeClock::now_ms += NVM_WRITE_DEBOUNCE_MS;
  m.flushIfDue();

  // Inspect the persisted record directly (the fresh begin() below would
  // queue another write but not flush it, so the backing store is stable).
  PersistedConfig persisted{};
  std::memcpy(&persisted, backend.raw(), sizeof(persisted));

  // Round-trip: a fresh manager must read the same logical position.
  NVMManager fresh(backend, &FakeClock::read);
  fresh.begin();
  const PersistedConfig& reloaded = fresh.get();

  return QuiescentOutcome{
      expected_x,
      expected_y,
      persisted.logical_pos_x,
      persisted.logical_pos_y,
      (persisted.flags & NVM_FLAG_UNCLEAN) == 0u,
      reloaded.logical_pos_x,
      reloaded.logical_pos_y,
  };
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 14: NVM position consistency at quiescent points.
// ---------------------------------------------------------------------------
//
// Validates: Requirements 10.6.
TEST_CASE(
    "Property 14: persisted logical position at a quiescent point equals the "
    "last committed in-RAM position",
    "[nvm][position][property][property-14]") {
  const bool ok = rc::check(
      "persisted logical_pos at idle == in-RAM logical_pos when idle entered",
      [] {
        const auto step_gen = rc::gen::tuple(
            rc::gen::inRange<std::int32_t>(kPosMin, kPosMax + 1),
            rc::gen::inRange<std::int32_t>(kPosMin, kPosMax + 1),
            rc::gen::inRange<std::uint32_t>(0u, kDtMax));
        const auto steps =
            *rc::gen::container<std::vector<Step>>(step_gen);

        const QuiescentOutcome out = runToQuiescent(steps);

        // The idle flush always commits the latest cached value, so the
        // stored position is exactly the in-RAM position as idle is entered.
        RC_ASSERT(out.persisted_x == out.expected_x);
        RC_ASSERT(out.persisted_y == out.expected_y);

        // The unclean marker is cleared at the quiescent point.
        RC_ASSERT(out.persisted_unclean_clear);

        // A fresh boot reads the same logical position back.
        RC_ASSERT(out.reloaded_x == out.expected_x);
        RC_ASSERT(out.reloaded_y == out.expected_y);
      });
  REQUIRE(ok);
}

// ---------------------------------------------------------------------------
// Companion unit test: a concrete, hand-checked sequence pinning the exact
// quiescent-point behaviour (complements the property with a worked example).
// ---------------------------------------------------------------------------
TEST_CASE(
    "Property 14 example: a fixed update sequence persists its final position "
    "at idle",
    "[nvm][position][example]") {
  // Two early updates that land within the same debounce window (so only the
  // first commit is written), followed by a final update committed at idle.
  const std::vector<Step> steps = {
      Step{10, -20, 50},        // dt 50 ms  -> first flush is unconditional
      Step{-333, 777, 100},     // dt 100 ms -> within debounce, deferred
      Step{123456, -654321, 0}  // dt 0 ms   -> still within debounce, deferred
  };

  const QuiescentOutcome out = runToQuiescent(steps);

  // The final mutation wins at the quiescent point.
  CHECK(out.expected_x == 123456);
  CHECK(out.expected_y == -654321);
  CHECK(out.persisted_x == 123456);
  CHECK(out.persisted_y == -654321);
  CHECK(out.persisted_unclean_clear);
  CHECK(out.reloaded_x == 123456);
  CHECK(out.reloaded_y == -654321);
}

TEST_CASE(
    "Property 14 example: an empty update sequence persists the home default "
    "at idle",
    "[nvm][position][example]") {
  const std::vector<Step> steps;  // no movement commands at all
  const QuiescentOutcome out = runToQuiescent(steps);

  // With no mutations the in-RAM position stays at the (0,0) default, and
  // that is what the quiescent-point flush commits.
  CHECK(out.expected_x == 0);
  CHECK(out.expected_y == 0);
  CHECK(out.persisted_x == 0);
  CHECK(out.persisted_y == 0);
  CHECK(out.persisted_unclean_clear);
  CHECK(out.reloaded_x == 0);
  CHECK(out.reloaded_y == 0);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
