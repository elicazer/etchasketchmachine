// Integer Bresenham line coordinator for two-axis stepping (Task 6.1).
//
// Generates the coordinated STEP/DIR sequence for a single straight segment
// described by signed deltas (dx, dy) in full motor steps. The sequence pulses
// the major axis on every tick and the minor axis only when the integer error
// term crosses, which keeps the realised path within half a step of the ideal
// line (Design §2.4.2, Requirement 6.1).
//
// This header is deliberately free of Arduino-specific includes so it compiles
// both under `framework = arduino` for the UNO R4 WiFi target and under
// `platform = native` for the host-side Catch2 tests. The advancing primitive
// `nextStep()` performs no allocation and no division, so it is safe to call
// directly from the GPT timer ISR that drives the STEP pins.
//
// Guarantees (for any |dx|, |dy| that fit in the wire delta limit, ±32767):
//   * exactly |dx| X-steps in direction sign(dx)
//   * exactly |dy| Y-steps in direction sign(dy)
//   * the realised stylus position after each tick stays within one step
//     (in fact <= 0.5 step) of the ideal line from the origin to (dx, dy)

#pragma once

#include <cstdint>

namespace etch {
namespace motion {

// One tick of output for ISR consumption. `stepX` / `stepY` indicate whether
// the corresponding axis pulses on this tick. `dirX` / `dirY` carry the sign of
// the move on each axis (-1, 0, or +1); they are constant for the lifetime of a
// line and are meaningful for an axis only on ticks where that axis steps.
struct StepOutput {
  bool stepX;
  bool stepY;
  std::int8_t dirX;  // sign(dx): -1, 0, or +1
  std::int8_t dirY;  // sign(dy): -1, 0, or +1
};

// Incremental integer Bresenham generator for a single (dx, dy) segment.
//
// Usage:
//   BresenhamLine line(dx, dy);
//   StepOutput out;
//   while (line.nextStep(out)) { /* pulse pins per out */ }
class BresenhamLine {
 public:
  BresenhamLine() { reset(0, 0); }
  BresenhamLine(std::int32_t dx, std::int32_t dy) { reset(dx, dy); }

  // Re-initialise the generator for a new segment. Precomputes |dx|, |dy|, the
  // per-axis direction signs, the major axis, the tick count, and the error
  // accumulator. Cheap enough to call per segment from the main loop.
  void reset(std::int32_t dx, std::int32_t dy);

  // Advance one Bresenham tick. Sets `out` to describe which axis/axes pulse on
  // this tick and their directions. Returns false (and leaves `out` cleared to
  // a no-step state) once the line is complete.
  bool nextStep(StepOutput& out);

  // True once every tick of the line has been emitted (also true for a zero
  // length move).
  bool done() const { return remaining_ <= 0; }

  // Total number of ticks in the line == max(|dx|, |dy|).
  std::int32_t totalSteps() const { return (adx_ >= ady_) ? adx_ : ady_; }

  // Number of remaining ticks not yet emitted.
  std::int32_t remainingSteps() const { return remaining_; }

  std::int8_t dirX() const { return sx_; }
  std::int8_t dirY() const { return sy_; }

 private:
  std::int32_t adx_ = 0;  // |dx|
  std::int32_t ady_ = 0;  // |dy|
  std::int8_t sx_ = 0;    // sign(dx)
  std::int8_t sy_ = 0;    // sign(dy)
  bool x_major_ = true;   // true when |dx| >= |dy|
  std::int32_t err_ = 0;  // running Bresenham error term
  std::int32_t remaining_ = 0;  // ticks left to emit
};

}  // namespace motion
}  // namespace etch
