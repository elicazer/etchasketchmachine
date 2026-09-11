// Integer Bresenham line coordinator implementation (Task 6.1).
//
// See bresenham.h for the contract. The algorithm is the classic symmetric
// integer Bresenham, generalised to signed deltas. The major axis (the one
// with the larger absolute delta) pulses on every tick; the minor axis pulses
// whenever the doubled error term crosses the major-axis count. The error term
// is kept within +/- one major-axis count, which bounds the deviation of the
// realised path to at most half a step in the minor direction and therefore at
// most half a step perpendicular to the ideal line (Requirement 6.1).

#include "bresenham.h"

namespace etch {
namespace motion {

namespace {

// Branchless sign of a signed value: returns -1, 0, or +1.
inline std::int8_t signOf(std::int32_t v) {
  return static_cast<std::int8_t>((v > 0) - (v < 0));
}

// Absolute value that is safe for the bounded delta range used here (the wire
// format pins |dx|, |dy| <= 32767, so no INT32_MIN edge case can occur).
inline std::int32_t absOf(std::int32_t v) { return v < 0 ? -v : v; }

}  // namespace

void BresenhamLine::reset(std::int32_t dx, std::int32_t dy) {
  adx_ = absOf(dx);
  ady_ = absOf(dy);
  sx_ = signOf(dx);
  sy_ = signOf(dy);
  x_major_ = (adx_ >= ady_);
  err_ = 0;
  remaining_ = (adx_ >= ady_) ? adx_ : ady_;
}

bool BresenhamLine::nextStep(StepOutput& out) {
  if (remaining_ <= 0) {
    // Line complete (or zero-length move): report a no-step tick so callers
    // that read `out` unconditionally see a well-defined value.
    out.stepX = false;
    out.stepY = false;
    out.dirX = sx_;
    out.dirY = sy_;
    return false;
  }

  bool step_x = false;
  bool step_y = false;

  if (x_major_) {
    // Major axis is X: it pulses every tick. The minor axis (Y) pulses when
    // the accumulated error crosses the major count.
    step_x = true;
    err_ += 2 * ady_;
    if (err_ > adx_) {
      step_y = (sy_ != 0);
      err_ -= 2 * adx_;
    }
  } else {
    // Major axis is Y.
    step_y = true;
    err_ += 2 * adx_;
    if (err_ > ady_) {
      step_x = (sx_ != 0);
      err_ -= 2 * ady_;
    }
  }

  out.stepX = step_x;
  out.stepY = step_y;
  out.dirX = sx_;
  out.dirY = sy_;
  --remaining_;
  return true;
}

}  // namespace motion
}  // namespace etch
