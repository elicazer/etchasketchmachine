// BacklashCompensator implementation (Design §3.2.6, Requirement 13).
//
// Pure host/target-portable logic: no Arduino includes, no direct EEPROM
// access. All persistence flows through the IBacklashStore facade so the same
// translation unit compiles under `framework = arduino` and `platform =
// native` (host Catch2 tests pull this file in directly).

#include "backlash_compensator.h"

#include <cstddef>

namespace etch {
namespace backlash {

BacklashCompensator::BacklashCompensator(IBacklashStore& store)
    : store_(store) {}

std::int8_t BacklashCompensator::sign(std::int8_t v) {
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

std::uint8_t BacklashCompensator::clampSteps(std::uint16_t steps) {
  if (steps < BACKLASH_STEPS_MIN) steps = BACKLASH_STEPS_MIN;
  if (steps > BACKLASH_STEPS_MAX) steps = BACKLASH_STEPS_MAX;
  return static_cast<std::uint8_t>(steps);
}

void BacklashCompensator::load() {
  // Pull the persisted per-axis backlash out of the NVM cache. The values are
  // already the documented defaults of 0 when NVM held no valid record
  // (Requirement 13.10); we clamp defensively in case a corrupt-but-valid-CRC
  // record carried an out-of-range value.
  const PersistedConfig& cfg = store_.get();
  cfg_.x = clampSteps(cfg.backlash_x_steps);
  cfg_.y = clampSteps(cfg.backlash_y_steps);
}

void BacklashCompensator::save() {
  // Stage the current cache for the next debounced NVM commit. We capture the
  // cache by value so the closure does not alias `cfg_`.
  const BacklashConfig snapshot = cfg_;
  store_.mutate([snapshot](PersistedConfig& cfg) {
    cfg.backlash_x_steps = snapshot.x;
    cfg.backlash_y_steps = snapshot.y;
  });
}

BacklashConfig BacklashCompensator::get() const { return cfg_; }

void BacklashCompensator::set(BacklashConfig cfg) {
  // Clamp each axis to [0, 200] (Requirement 13.8). BacklashConfig stores
  // uint8_t, so widen before clamping to catch values above the 200 limit.
  cfg_.x = clampSteps(cfg.x);
  cfg_.y = clampSteps(cfg.y);
}

std::uint8_t BacklashCompensator::prepareForMove(Axis axis,
                                                 std::int8_t newDir) {
  const std::size_t idx = static_cast<std::size_t>(axis);
  const std::int8_t new_sign = sign(newDir);

  // A zero move on this axis is neither motion nor a reversal: report no
  // compensation and leave the remembered direction untouched so a later real
  // move is still judged against the last genuine direction.
  if (new_sign == 0) {
    return 0;
  }

  const std::int8_t prev = last_dir_[idx];

  // Reversal iff we had a known previous direction and the sign flipped.
  // First move (prev == 0) and same-direction continuation report 0.
  const bool reversal = (prev != 0) && (new_sign != prev);

  // Update the remembered direction before returning (Design §3.2.6).
  last_dir_[idx] = new_sign;

  if (!reversal) {
    return 0;
  }
  return (idx == static_cast<std::size_t>(Axis::X)) ? cfg_.x : cfg_.y;
}

void BacklashCompensator::onHome() {
  // After homing the mechanical slack state is unknown, so forget the last
  // direction on both axes; the next move on either axis then reports 0
  // (no reversal against an "unknown" baseline).
  for (std::size_t i = 0; i < kAxisCount; ++i) {
    last_dir_[i] = 0;
  }
}

}  // namespace backlash
}  // namespace etch
