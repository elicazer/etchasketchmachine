// Implementation of the trapezoidal speed-ramp generator (Task 6.3).
//
// See ramp.h for the formula and rationale. This file deliberately avoids
// <algorithm> / std::min so it has no surprises on the embedded toolchain;
// the arithmetic is plain integer math.

#include "ramp.h"

namespace etch {
namespace motion {

namespace {

inline std::uint16_t u16_min(std::uint16_t a, std::uint16_t b) {
  return a < b ? a : b;
}

inline std::uint16_t u16_max(std::uint16_t a, std::uint16_t b) {
  return a > b ? a : b;
}

// clamp v into [lo, hi]; callers guarantee lo <= hi.
inline std::uint16_t u16_clamp(std::uint16_t v, std::uint16_t lo,
                               std::uint16_t hi) {
  return u16_min(u16_max(v, lo), hi);
}

}  // namespace

bool TrapezoidRamp::init(std::uint32_t steps, std::uint16_t vMin,
                         std::uint16_t vPeak, std::uint16_t accelStepsPerSec,
                         std::uint8_t speedPct) {
  bool ok = true;

  // --- steps: require at least one step ---------------------------------
  if (steps < 1) {
    steps = 1;
    ok = false;
  }

  // --- vMin >= RAMP_MIN_SPS --------------------------------------------
  // The ramp's start speed (vMin) floor is RAMP_MIN_SPS, NOT the protocol
  // FEED_SPS_MIN: motion intentionally starts BELOW the wire floor at the
  // motor's pull-in rate (MOTION_START_SPS) so a cold start eases in without
  // stalling. RAMP_MIN_SPS is the absolute >0 floor that keeps the schedule
  // well-formed and 1/v integration divide-by-zero-safe.
  if (vMin < RAMP_MIN_SPS) {
    vMin = RAMP_MIN_SPS;
    ok = false;
  }
  // vMin must also stay within the overall envelope so the trapezoid is
  // well-formed even when the caller passes nonsense.
  if (vMin > FEED_SPS_MAX) {
    vMin = FEED_SPS_MAX;
    ok = false;
  }

  // --- vPeak <= FEED_SPS_MAX -------------------------------------------
  if (vPeak > FEED_SPS_MAX) {
    vPeak = FEED_SPS_MAX;
    ok = false;
  }

  // --- vMin <= vPeak ----------------------------------------------------
  if (vMin > vPeak) {
    vPeak = vMin;
    ok = false;
  }

  // --- accel > 0 --------------------------------------------------------
  if (accelStepsPerSec == 0) {
    accelStepsPerSec = 1;
    ok = false;
  }

  // --- speedPct in [SPEED_PCT_MIN, SPEED_PCT_MAX] -----------------------
  if (speedPct < SPEED_PCT_MIN || speedPct > SPEED_PCT_MAX) {
    speedPct = u16_clamp(speedPct, SPEED_PCT_MIN, SPEED_PCT_MAX) & 0xFF;
    ok = false;
  }

  steps_ = steps;
  v_min_ = vMin;
  v_peak_ = vPeak;
  accel_ = accelStepsPerSec;
  speed_pct_ = speedPct;

  // Apply the live speed-percent slider then clamp into [vMin, FEED_SPS_MAX].
  // This mirrors web/src/path/ramp.ts exactly:
  //     scaledPeak = (vPeak * speedPct) / 100
  //     peak       = min(FEED_SPS_MAX, max(vMin, scaledPeak))
  // Integer division floors the scaled value; the unit tests account for this
  // (e.g. speedPct=50 halves the peak "within integer rounding"). Clamping up
  // to vMin is intentional: at low speedPct the scaled peak can fall below
  // vMin, in which case the whole segment runs flat at vMin.
  const std::uint32_t scaled =
      (static_cast<std::uint32_t>(vPeak) * static_cast<std::uint32_t>(speedPct)) /
      100u;
  std::uint16_t scaled16 =
      scaled > FEED_SPS_MAX ? FEED_SPS_MAX : static_cast<std::uint16_t>(scaled);
  peak_ = u16_clamp(scaled16, vMin, FEED_SPS_MAX);

  valid_ = ok;
  return ok;
}

std::uint16_t TrapezoidRamp::rampValue(std::uint32_t n) const {
  // min(peak_, vMin + n*accel) -- the same clamp the browser ramp applies via
  // Math.min(peak, vMin + i*delta). Saturate only once the *linear* value
  // reaches peak_, i.e. when n >= ceil(headroom / accel). Clamping at the
  // floor instead would let the final pre-plateau step jump to peak_ by more
  // than `accel` and break the per-step delta bound (Property 5).
  const std::uint32_t headroom =
      static_cast<std::uint32_t>(peak_ - v_min_);  // peak_ >= v_min_ by init()
  const std::uint32_t a = accel_;                  // accel_ >= 1 by init()
  const std::uint32_t threshold = (headroom + a - 1u) / a;  // ceil(headroom/a)
  if (n >= threshold) {
    return peak_;
  }
  // Safe from overflow: n < threshold = ceil(headroom/a) implies
  // n*a < headroom <= FEED_SPS_MAX - vMin, so vMin + n*a <= FEED_SPS_MAX.
  return static_cast<std::uint16_t>(v_min_ + n * a);
}

std::uint16_t TrapezoidRamp::speedAt(std::uint32_t i) const {
  if (steps_ == 0) {
    return v_min_;
  }
  const std::uint32_t last = steps_ - 1u;
  if (i > last) {
    i = last;
  }
  // v[i] = min(peak, vMin + i*accel, vMin + (last - i)*accel).
  // rampValue already caps each ramp at peak_, so the min of the two ramps
  // is the unified trapezoid/triangle value.
  const std::uint16_t up = rampValue(i);
  const std::uint16_t down = rampValue(last - i);
  return u16_min(up, down);
}

}  // namespace motion
}  // namespace etch
