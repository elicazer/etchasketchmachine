// BacklashCompensator - injects per-axis backlash compensation steps on
// direction reversals (Design §3.2.6, Requirement 13).
//
// Gear lash plus play in the Etch-a-Sketch knobs means the stylus stalls for
// some integer number of motor steps after each direction reversal. This
// component tracks the last commanded direction per axis and, on a reversal,
// reports how many "uncounted" compensation steps the caller must prepend to
// the move before the real, counted steps. Those compensation steps take up
// the mechanical slack so the stylus is moving by the time the counted steps
// begin.
//
// IMPORTANT (Requirement 13.7): the compensation steps reported by
// prepareForMove() MUST NOT be counted toward the logical stylus position.
// This component only *reports* the count; the caller (MotionPlanner,
// task 6.9) is responsible for issuing them with count_into_position = false.
//
// This header is intentionally Arduino-include-free so it compiles both under
// `framework = arduino` for the UNO R4 WiFi target and under
// `platform = native` for the host-side Catch2 tests. It never touches EEPROM
// directly: it talks to the NVM layer through the narrow `IBacklashStore`
// facade below (mirroring the INVMManager pattern used by WiFiManager in
// firmware/src/wifi/wifi_manager.h), so host tests can plug in an in-memory
// fake.
//
// References:
//   - Requirements 13.4, 13.5, 13.6, 13.7, 13.10
//   - Design §3.2.6 (BacklashCompensator surface), §3.2.5 (MotionPlanner use),
//     §5.2 (SET_HOME -> onHome()), §5.3 (backlash calibration wizard)

#pragma once

#include <cstdint>
#include <functional>

#include "../types.h"  // etch::BacklashConfig, etch::PersistedConfig, limits

namespace etch {
namespace backlash {

// ---------------------------------------------------------------------------
// Axis selector
// ---------------------------------------------------------------------------

// Per-axis selector for prepareForMove(). The numeric values double as indices
// into the compensator's internal last-direction array, so X = 0, Y = 1 must
// not change without auditing those call sites. types.h does not define an
// axis type, so it lives here next to the only API that consumes it.
enum class Axis : std::uint8_t {
  X = 0,
  Y = 1,
};

// ---------------------------------------------------------------------------
// NVM facade
// ---------------------------------------------------------------------------

// Minimum interface BacklashCompensator needs from the NVM layer. The concrete
// `NVMManager` (firmware/src/nvm/, task 2.1) already exposes both of these
// methods with identical signatures, so it can satisfy this interface directly
// (or via a one-line adapter); host tests plug in a tiny in-memory fake.
//
// Keeping the facade narrow means the compensator never reads or writes EEPROM
// directly: it pulls the persisted backlash out of `get()` on load() and hands
// an edit to `mutate()` on save(). The mutate path is debounced and committed
// by the NVM layer (Design §3.2.7); this component never forces a flush.
class IBacklashStore {
 public:
  virtual ~IBacklashStore() = default;

  // Read-only view of the persisted record. load() reads backlash_x_steps /
  // backlash_y_steps from here (Requirement 13.5). When NVM held no valid
  // record the values are the documented defaults of 0 (Requirement 13.10).
  virtual const PersistedConfig& get() const = 0;

  // Apply a user-supplied edit to the cached record and mark it dirty. save()
  // uses this to stage backlash_x_steps / backlash_y_steps for the next
  // debounced commit (Design §3.2.7). The edit is not guaranteed to hit the
  // backing store until the NVM layer's next flush.
  virtual void mutate(std::function<void(PersistedConfig&)> fn) = 0;
};

// ---------------------------------------------------------------------------
// BacklashCompensator
// ---------------------------------------------------------------------------

// Tracks the last nonzero commanded direction for each axis and reports the
// compensation-step count to prepend on a reversal. Public surface mirrors
// Design §3.2.6 verbatim.
class BacklashCompensator {
 public:
  explicit BacklashCompensator(IBacklashStore& store);

  // Pull backlash_x/y from NVM into the in-memory cache (Requirement 13.5).
  // Values are clamped to [BACKLASH_STEPS_MIN, BACKLASH_STEPS_MAX] defensively.
  // With an empty / invalid NVM record the cache becomes {0, 0}
  // (Requirement 13.10).
  void load();

  // Persist the current cache to NVM via the store's mutate() path. The write
  // is debounced and committed by the NVM layer (Design §3.2.7); this call
  // only stages the edit.
  void save();

  // Current cached per-axis backlash, in full motor steps.
  BacklashConfig get() const;

  // Replace the cached backlash, clamping each axis to
  // [BACKLASH_STEPS_MIN, BACKLASH_STEPS_MAX] (Requirement 13.8). Does not
  // persist on its own; call save() to stage a write.
  void set(BacklashConfig cfg);

  // Returns the stored backlash step count for `axis` IFF `newDir` reverses
  // that axis's previous nonzero direction; otherwise returns 0. Specifically:
  //   * Returns 0 on the first move of an axis (last direction unknown), on a
  //     same-direction continuation, and whenever `newDir == 0` (no motion on
  //     this axis).
  //   * Returns the axis's stored backlash count when the sign of `newDir`
  //     differs from the sign of the previously stored nonzero direction.
  // Side effect: updates the stored last direction for `axis` to the sign of
  // `newDir` when `newDir != 0` (a zero move leaves the last direction
  // unchanged). (Requirements 13.4, 13.6.)
  //
  // The caller MUST issue the returned steps with count_into_position = false
  // so they are not counted toward the logical position (Requirement 13.7).
  std::uint8_t prepareForMove(Axis axis, std::int8_t newDir);

  // Reset the last-direction state for both axes to unknown (0) so the next
  // move on either axis never injects compensation. Called on SET_HOME /
  // RE_HOME (Design §5.2): after homing the mechanical slack state is unknown,
  // so the first post-home move must not assume a reversal.
  void onHome();

 private:
  static constexpr std::size_t kAxisCount = 2;

  // Normalises an arbitrary signed direction to its sign in {-1, 0, +1}.
  static std::int8_t sign(std::int8_t v);

  // Clamps a raw step count to [BACKLASH_STEPS_MIN, BACKLASH_STEPS_MAX] and
  // narrows it to the uint8_t storage used by BacklashConfig.
  static std::uint8_t clampSteps(std::uint16_t steps);

  IBacklashStore& store_;

  // Cached per-axis backlash in full motor steps. Defaults to 0/0 until
  // load() runs, matching the "no stored value" default (Requirement 13.10).
  BacklashConfig cfg_{0, 0};

  // Sign of the last nonzero move per axis: -1, 0 (unknown), or +1. Indexed by
  // static_cast<std::size_t>(Axis). Reset to 0 by onHome().
  std::int8_t last_dir_[kAxisCount] = {0, 0};
};

}  // namespace backlash
}  // namespace etch
