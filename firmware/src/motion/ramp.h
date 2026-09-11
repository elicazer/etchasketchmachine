// Trapezoidal speed-ramp generator for a single motion segment (Task 6.3).
//
// This is the firmware-side mirror of the browser ramp in
// web/src/path/ramp.ts (Task 22.1). Both sides MUST agree on the per-step
// speed so that the preview-time estimate the browser shows matches the
// motion the machine actually executes. The unified per-step formula is:
//
//     peak  = clamp(vPeak * speedPct / 100, vMin, FEED_SPS_MAX)
//     v[i]  = min(peak, vMin + i*accel, vMin + (steps-1-i)*accel)
//
// which yields the classical unimodal trapezoid:
//
//     peak  ────────                 ┐
//             ╱           ╲          │  plateau when the segment is long
//            ╱             ╲         │  enough to reach `peak`
//     vMin  ─               ─        ┘  start and end clamped to vMin
//
// For segments too short to reach `peak`, the up-ramp and down-ramp meet
// before the plateau and the profile collapses to a triangle. The `min`
// makes this branch-free: the up-ramp wins near i=0, the down-ramp wins
// near i=last, and `peak` caps the middle whenever the segment is long
// enough.
//
// `accel` is the per-step velocity increment in sps (i.e.
// `|v[i+1] - v[i]| <= accel`), matching the browser ramp's interpretation
// of its `accelStepsPerSec2` parameter (Design §2.4.2). Advancing the speed
// by a fixed sps increment per emitted step keeps the deterministic-step
// GPT ISR cheap: speedAt() is O(1), allocation-free, and therefore safe to
// call from the ISR path.
//
// This header is intentionally free of Arduino-specific includes so that it
// compiles both under `framework = arduino` (UNO R4 WiFi) and under
// `platform = native` for the host-side Catch2 tests.
//
// References:
//   - Requirements 5.5 (speed envelope), 6.3 (step-rate), 9.7/9.8 (live
//     speed-percent scaling).
//   - Design §2.4.2 (firmware ramp), Property 5 (monotonicity and bounds).

#pragma once

#include <cstdint>

#include "../types.h"

namespace etch {
namespace motion {

// Closed-form trapezoidal (or triangular) speed schedule for one segment.
//
// Construct or `init()` with the segment length and speed envelope, then call
// `speedAt(i)` to read the commanded sps at step `i`. No memory is allocated
// and `speedAt()` performs only integer arithmetic, so it is safe to call from
// the GPT step ISR.
struct TrapezoidRamp {
  // Default-constructed ramps are flat at FEED_SPS_MIN and report `!valid()`
  // until `init()` succeeds. This keeps `speedAt()` divide-by-zero-safe for
  // callers that integrate 1/v before initialising.
  TrapezoidRamp() = default;

  // Convenience constructor; equivalent to default-construct + init().
  TrapezoidRamp(std::uint32_t steps, std::uint16_t vMin, std::uint16_t vPeak,
                std::uint16_t accelStepsPerSec,
                std::uint8_t speedPct = SPEED_PCT_MAX) {
    init(steps, vMin, vPeak, accelStepsPerSec, speedPct);
  }

  // Configure the ramp.
  //
  // Valid inputs (mirrors web/src/path/ramp.ts validation, except the vMin
  // floor -- see below):
  //   - steps  >= 1
  //   - vMin   >= RAMP_MIN_SPS  (motion pull-in floor, BELOW the protocol
  //                              FEED_SPS_MIN so cold starts ease in; the web
  //                              mirror still floors at FEED_SPS_MIN since it
  //                              only previews and need not match this tweak)
  //   - vPeak  <= FEED_SPS_MAX (1000)
  //   - vMin   <= vPeak
  //   - accelStepsPerSec > 0
  //   - speedPct in [SPEED_PCT_MIN, SPEED_PCT_MAX] (25..100)
  //
  // Out-of-range inputs are CLAMPED into the ranges above so that `speedAt()`
  // always returns a sane sps value, and `valid()` returns false to let the
  // caller detect that clamping occurred. Returns the same boolean as
  // `valid()`.
  bool init(std::uint32_t steps, std::uint16_t vMin, std::uint16_t vPeak,
            std::uint16_t accelStepsPerSec,
            std::uint8_t speedPct = SPEED_PCT_MAX);

  // Commanded speed in full steps per second at step index `i`.
  //
  // O(1), allocation-free, ISR-safe. Indices >= steps() are clamped to the
  // last step. For an uninitialised / zero-length ramp this returns vMin so
  // that 1/v time integration never divides by zero.
  std::uint16_t speedAt(std::uint32_t i) const;

  // True when the most recent init() inputs were all within range (no
  // clamping was required).
  bool valid() const { return valid_; }

  std::uint32_t steps() const { return steps_; }
  std::uint16_t vMin() const { return v_min_; }
  std::uint16_t vPeak() const { return v_peak_; }
  std::uint16_t accel() const { return accel_; }
  std::uint8_t speedPct() const { return speed_pct_; }

  // The post-speedPct peak the schedule actually targets, i.e.
  // clamp(vPeak * speedPct / 100, vMin, FEED_SPS_MAX). The schedule never
  // exceeds this value.
  std::uint16_t peak() const { return peak_; }

 private:
  // vMin + n*accel, saturated at peak_. Branch-free overflow guard: because
  // accel_ >= 1, any n greater than (peak_ - vMin_) already saturates.
  std::uint16_t rampValue(std::uint32_t n) const;

  std::uint32_t steps_ = 0;
  std::uint16_t v_min_ = FEED_SPS_MIN;
  std::uint16_t v_peak_ = FEED_SPS_MIN;
  std::uint16_t accel_ = 1;
  std::uint8_t speed_pct_ = SPEED_PCT_MAX;
  std::uint16_t peak_ = FEED_SPS_MIN;
  bool valid_ = false;
};

}  // namespace motion
}  // namespace etch
