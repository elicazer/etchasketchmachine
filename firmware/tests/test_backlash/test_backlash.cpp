// Host-side unit tests for BacklashCompensator (Task 6.7).
//
// Validates the contract laid out in Design §3.2.6 and Requirement 13:
//   * first move on each axis reports 0 compensation (last direction unknown)
//   * same-direction continuation reports 0
//   * a direction reversal reports the stored backlash for that axis
//   * per-axis independence (reversing X does not trigger Y compensation)
//   * onHome() resets last-direction state so the next move reports 0
//   * set() clamps to [0, 200]; the default with an empty NVM record is 0/0
//   * load() / save() round-trip through the NVM facade
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment in platformio.ini is configured with
// `test_build_src = no`, so this translation unit pulls the implementation in
// directly via relative include to keep the binary self-contained (mirroring
// test_nvm and test_wifi).

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <cstring>
#include <functional>

#include "../../src/types.h"
#include "../../src/backlash/backlash_compensator.h"
#include "../../src/backlash/backlash_compensator.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::BacklashConfig;
using etch::PersistedConfig;
using etch::BACKLASH_STEPS_MAX;
using etch::NVM_MAGIC;
using etch::NVM_VERSION;
using etch::DEFAULT_MM_PER_REV;
using etch::backlash::Axis;
using etch::backlash::BacklashCompensator;
using etch::backlash::IBacklashStore;

namespace {

// Tiny in-memory NVM stand-in. Mirrors the slice of NVMManager that the
// compensator uses: get() exposes the cached record, mutate() applies an edit
// to it. The real NVMManager (firmware/src/nvm/) is the production backing.
class FakeStore : public IBacklashStore {
 public:
  FakeStore() {
    std::memset(&cfg_, 0, sizeof(cfg_));
    // Default-shaped record: valid header, backlash 0/0 (Requirement 13.10).
    cfg_.magic = NVM_MAGIC;
    cfg_.version = NVM_VERSION;
    cfg_.mm_per_rev_x = DEFAULT_MM_PER_REV;
    cfg_.mm_per_rev_y = DEFAULT_MM_PER_REV;
  }

  const PersistedConfig& get() const override { return cfg_; }

  void mutate(std::function<void(PersistedConfig&)> fn) override {
    fn(cfg_);
    ++mutate_count_;
  }

  // Direct access for test plumbing.
  PersistedConfig& raw() { return cfg_; }
  std::size_t mutates() const { return mutate_count_; }

 private:
  PersistedConfig cfg_;
  std::size_t mutate_count_ = 0;
};

}  // namespace

// ---------------------------------------------------------------------------
// Defaults (Requirement 13.10)
// ---------------------------------------------------------------------------

TEST_CASE("default backlash is 0/0 before load with empty NVM",
          "[backlash][defaults]") {
  FakeStore store;
  BacklashCompensator comp(store);

  // Constructed cache defaults to 0/0.
  CHECK(comp.get().x == 0);
  CHECK(comp.get().y == 0);

  // load() from an empty (backlash 0/0) record keeps 0/0.
  comp.load();
  CHECK(comp.get().x == 0);
  CHECK(comp.get().y == 0);
}

// ---------------------------------------------------------------------------
// First move / same-direction continuation report 0 (Requirements 13.4, 13.6)
// ---------------------------------------------------------------------------

TEST_CASE("first move on each axis reports 0 (unknown last direction)",
          "[backlash][reversal]") {
  FakeStore store;
  store.raw().backlash_x_steps = 17;
  store.raw().backlash_y_steps = 23;
  BacklashCompensator comp(store);
  comp.load();

  // No prior direction recorded, so the very first move never compensates,
  // regardless of stored backlash or chosen direction.
  CHECK(comp.prepareForMove(Axis::X, +1) == 0);
  CHECK(comp.prepareForMove(Axis::Y, -1) == 0);
}

TEST_CASE("same-direction continuation reports 0", "[backlash][reversal]") {
  FakeStore store;
  store.raw().backlash_x_steps = 17;
  BacklashCompensator comp(store);
  comp.load();

  CHECK(comp.prepareForMove(Axis::X, +1) == 0);  // first move
  CHECK(comp.prepareForMove(Axis::X, +1) == 0);  // continuation
  CHECK(comp.prepareForMove(Axis::X, +1) == 0);  // continuation
}

TEST_CASE("a zero-direction move does not change remembered direction",
          "[backlash][reversal]") {
  FakeStore store;
  store.raw().backlash_x_steps = 30;
  BacklashCompensator comp(store);
  comp.load();

  CHECK(comp.prepareForMove(Axis::X, +1) == 0);  // establish +X
  CHECK(comp.prepareForMove(Axis::X, 0) == 0);   // no motion: no comp, no update
  // The reversal is still judged against the last *genuine* direction (+1),
  // so a subsequent -X move is a reversal.
  CHECK(comp.prepareForMove(Axis::X, -1) == 30);
}

// ---------------------------------------------------------------------------
// Reversal reports stored backlash (Requirements 13.4, 13.6)
// ---------------------------------------------------------------------------

TEST_CASE("reversal reports the stored backlash for that axis",
          "[backlash][reversal]") {
  FakeStore store;
  store.raw().backlash_x_steps = 42;
  store.raw().backlash_y_steps = 7;
  BacklashCompensator comp(store);
  comp.load();

  // X: + then - => reversal of 42; - then + => reversal of 42 again.
  CHECK(comp.prepareForMove(Axis::X, +1) == 0);
  CHECK(comp.prepareForMove(Axis::X, -1) == 42);
  CHECK(comp.prepareForMove(Axis::X, -1) == 0);   // continuation in -X
  CHECK(comp.prepareForMove(Axis::X, +1) == 42);  // reversal back to +X

  // Y carries its own backlash value of 7.
  CHECK(comp.prepareForMove(Axis::Y, -1) == 0);
  CHECK(comp.prepareForMove(Axis::Y, +1) == 7);
}

TEST_CASE("reversal with magnitude > 1 still uses the sign only",
          "[backlash][reversal]") {
  FakeStore store;
  store.raw().backlash_x_steps = 12;
  BacklashCompensator comp(store);
  comp.load();

  // Arbitrary positive then arbitrary negative magnitudes: still a reversal.
  CHECK(comp.prepareForMove(Axis::X, +5) == 0);
  CHECK(comp.prepareForMove(Axis::X, -9) == 12);
}

// ---------------------------------------------------------------------------
// Per-axis independence (Requirement 13.6)
// ---------------------------------------------------------------------------

TEST_CASE("reversing X does not trigger Y compensation",
          "[backlash][independence]") {
  FakeStore store;
  store.raw().backlash_x_steps = 50;
  store.raw().backlash_y_steps = 60;
  BacklashCompensator comp(store);
  comp.load();

  // Establish +X and +Y independently.
  CHECK(comp.prepareForMove(Axis::X, +1) == 0);
  CHECK(comp.prepareForMove(Axis::Y, +1) == 0);

  // Reverse only X; Y must remain a continuation (still +Y => 0).
  CHECK(comp.prepareForMove(Axis::X, -1) == 50);
  CHECK(comp.prepareForMove(Axis::Y, +1) == 0);

  // Now reverse only Y; X stays in -X continuation => 0.
  CHECK(comp.prepareForMove(Axis::Y, -1) == 60);
  CHECK(comp.prepareForMove(Axis::X, -1) == 0);
}

// ---------------------------------------------------------------------------
// onHome resets last-direction state (Design §5.2)
// ---------------------------------------------------------------------------

TEST_CASE("onHome resets last-direction so the next move reports 0",
          "[backlash][home]") {
  FakeStore store;
  store.raw().backlash_x_steps = 33;
  store.raw().backlash_y_steps = 44;
  BacklashCompensator comp(store);
  comp.load();

  // Build up direction state on both axes.
  CHECK(comp.prepareForMove(Axis::X, +1) == 0);
  CHECK(comp.prepareForMove(Axis::Y, +1) == 0);
  CHECK(comp.prepareForMove(Axis::X, -1) == 33);  // confirm state is live

  comp.onHome();

  // After homing, the first move on either axis is treated as a first move
  // again: no compensation even though directions reverse versus before home.
  CHECK(comp.prepareForMove(Axis::X, +1) == 0);
  CHECK(comp.prepareForMove(Axis::Y, -1) == 0);

  // ...and normal reversal behaviour resumes afterwards.
  CHECK(comp.prepareForMove(Axis::X, -1) == 33);
  CHECK(comp.prepareForMove(Axis::Y, +1) == 44);
}

// ---------------------------------------------------------------------------
// set() clamps to [0, 200] (Requirement 13.8)
// ---------------------------------------------------------------------------

TEST_CASE("set clamps each axis to [0, 200]", "[backlash][clamp]") {
  FakeStore store;
  BacklashCompensator comp(store);

  comp.set(BacklashConfig{0, 0});
  CHECK(comp.get().x == 0);
  CHECK(comp.get().y == 0);

  comp.set(BacklashConfig{200, 200});
  CHECK(comp.get().x == 200);
  CHECK(comp.get().y == 200);

  // Above the max (BacklashConfig stores uint8_t, so 255 is representable):
  // clamp down to BACKLASH_STEPS_MAX.
  comp.set(BacklashConfig{255, 201});
  CHECK(comp.get().x == BACKLASH_STEPS_MAX);
  CHECK(comp.get().y == BACKLASH_STEPS_MAX);

  // A typical in-range value passes through unchanged.
  comp.set(BacklashConfig{75, 125});
  CHECK(comp.get().x == 75);
  CHECK(comp.get().y == 125);
}

TEST_CASE("clamped set is reflected in subsequent reversal compensation",
          "[backlash][clamp]") {
  FakeStore store;
  BacklashCompensator comp(store);
  comp.set(BacklashConfig{255, 0});  // clamps X to 200

  CHECK(comp.prepareForMove(Axis::X, +1) == 0);
  CHECK(comp.prepareForMove(Axis::X, -1) == BACKLASH_STEPS_MAX);
}

// ---------------------------------------------------------------------------
// load() / save() round-trip through the NVM facade (Requirement 13.5)
// ---------------------------------------------------------------------------

TEST_CASE("load pulls backlash from NVM into the cache",
          "[backlash][persistence]") {
  FakeStore store;
  store.raw().backlash_x_steps = 11;
  store.raw().backlash_y_steps = 22;
  BacklashCompensator comp(store);

  comp.load();
  CHECK(comp.get().x == 11);
  CHECK(comp.get().y == 22);
}

TEST_CASE("load clamps an out-of-range stored value defensively",
          "[backlash][persistence]") {
  FakeStore store;
  store.raw().backlash_x_steps = 5000;  // far above the 200 ceiling
  store.raw().backlash_y_steps = 3;
  BacklashCompensator comp(store);

  comp.load();
  CHECK(comp.get().x == BACKLASH_STEPS_MAX);
  CHECK(comp.get().y == 3);
}

TEST_CASE("save stages the cache into NVM via mutate",
          "[backlash][persistence]") {
  FakeStore store;
  BacklashCompensator comp(store);

  comp.set(BacklashConfig{15, 80});
  REQUIRE(store.mutates() == 0u);
  comp.save();
  REQUIRE(store.mutates() == 1u);

  // The store's record now carries the staged values.
  CHECK(store.raw().backlash_x_steps == 15);
  CHECK(store.raw().backlash_y_steps == 80);
}

TEST_CASE("save then load round-trips through a fresh compensator",
          "[backlash][persistence]") {
  FakeStore store;

  {
    BacklashCompensator writer(store);
    writer.set(BacklashConfig{19, 91});
    writer.save();
  }

  // A second compensator reading the same store recovers the saved values.
  BacklashCompensator reader(store);
  reader.load();
  CHECK(reader.get().x == 19);
  CHECK(reader.get().y == 91);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
