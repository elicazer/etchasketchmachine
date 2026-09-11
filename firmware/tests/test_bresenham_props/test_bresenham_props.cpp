// Host-side property tests for the Bresenham two-axis coordinator (Task 6.2).
//
// Property 6: Bresenham line-error bound (Design §7, §2.4.2).
//
//   *For any* segment with deltas (dx, dy) where |dx| + |dy| > 0, the step
//   sequence emitted by the Bresenham coordinator contains exactly |dx|
//   X-steps in direction sign(dx) and exactly |dy| Y-steps in direction
//   sign(dy), and the maximum perpendicular distance from any intermediate
//   stylus position to the ideal line from the origin to (dx, dy) is at most
//   one step.
//
//   Validates: Requirements 6.1.
//
// The generator is a single function, `BresenhamLine`, advanced one tick at a
// time via nextStep() (see bresenham.h). To assert Property 6 precisely this
// test walks a line to completion, accumulating the visited integer points and
// the per-axis step tallies, then checks four independent facts against an
// oracle that never consults the implementation's internals:
//
//   1. Exactly |dx| X-steps and |dy| Y-steps are emitted (the major-axis tick
//      count equals max(|dx|, |dy|)).
//   2. Every realised single-tick move is a unit step whose sign equals the
//      segment's per-axis sign — so no axis ever steps the wrong way and no
//      tick moves an axis by more than one step.
//   3. The perpendicular distance from every visited point to the ideal line
//      through the origin and (dx, dy) is <= 1 step, computed with an
//      independent floating-point oracle |dx*py - dy*px| / sqrt(dx^2 + dy^2).
//   4. The walk ends exactly on (dx, dy).
//
// Deltas are drawn from [-kDeltaBound, kDeltaBound] on each axis. The wire
// format pins |dx|, |dy| <= 32767 (Design §4.3); a few-thousand bound keeps the
// per-trial walk short while still exercising shallow, steep, diagonal, and
// axis-aligned geometries across all four sign quadrants (including the
// degenerate (0, 0) move, for which every clause holds trivially).
//
// This translation unit lives in its own PlatformIO test directory
// (test_bresenham_props/) so it is compiled and linked into a standalone test
// binary, separate from test_bresenham/. It therefore supplies its own
// `int main` and pulls the implementation in directly via a relative include of
// bresenham.cpp -- matching the convention in test_bresenham/, test_nvm_props/,
// and test_command_parser_props/ -- so the host_test environment
// (test_build_src = no) stays self-contained with a single definition of the
// coordinator's symbols.
//
// The property is exercised with rapidcheck via the standalone rc::check form
// invoked from inside a Catch2 TEST_CASE (mirroring test_nvm_props/ and
// test_command_parser_props/). rc::check returns true on success; wrapping it
// in REQUIRE means a failing property (with rapidcheck's shrunk counterexample
// printed to stderr) surfaces as a Catch2 failure.
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

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <utility>
#include <vector>

#include "../../src/motion/bresenham.h"
#include "../../src/motion/bresenham.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::motion::BresenhamLine;
using etch::motion::StepOutput;

namespace {

// Per-axis delta bound for the parameterized property. Comfortably inside the
// wire delta limit (+/-32767) while keeping each trial's walk short and fast.
constexpr int kDeltaBound = 4000;

// Summary of running a line to completion: the visited integer points
// (including the origin), per-axis step tallies, and the per-axis direction
// signs actually emitted on stepping ticks.
struct LineTrace {
  std::vector<std::pair<std::int32_t, std::int32_t>> points;
  std::int32_t x_steps = 0;
  std::int32_t y_steps = 0;
  std::int8_t emitted_dir_x = 0;  // sign seen on X-stepping ticks (0 if none)
  std::int8_t emitted_dir_y = 0;  // sign seen on Y-stepping ticks (0 if none)
  std::int32_t ticks = 0;
};

// Walk the coordinator to completion, integrating the emitted step/direction
// pairs into an absolute position and recording every visited point.
LineTrace run(std::int32_t dx, std::int32_t dy) {
  BresenhamLine line(dx, dy);
  LineTrace t;
  std::int32_t x = 0;
  std::int32_t y = 0;
  t.points.emplace_back(x, y);

  StepOutput out;
  while (line.nextStep(out)) {
    ++t.ticks;
    if (out.stepX) {
      x += out.dirX;
      ++t.x_steps;
      t.emitted_dir_x = out.dirX;
    }
    if (out.stepY) {
      y += out.dirY;
      ++t.y_steps;
      t.emitted_dir_y = out.dirY;
    }
    t.points.emplace_back(x, y);
  }
  return t;
}

// Branchless integer sign: -1, 0, or +1.
std::int8_t signOf(std::int32_t v) {
  return static_cast<std::int8_t>((v > 0) - (v < 0));
}

// Independent oracle for the perpendicular distance from point P to the ideal
// line through the origin with direction (dx, dy):
//   |dx * py - dy * px| / sqrt(dx^2 + dy^2)
// Zero-length moves have a degenerate line; their only visited point is the
// origin, whose distance is defined as 0.
double maxPerpDistance(const LineTrace& t, std::int32_t dx, std::int32_t dy) {
  const double len =
      std::sqrt(static_cast<double>(dx) * dx + static_cast<double>(dy) * dy);
  if (len == 0.0) {
    return 0.0;
  }
  double worst = 0.0;
  for (const auto& p : t.points) {
    const double num = std::fabs(static_cast<double>(dx) * p.second -
                                 static_cast<double>(dy) * p.first);
    worst = std::max(worst, num / len);
  }
  return worst;
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 6: Bresenham line-error bound.
// ---------------------------------------------------------------------------
TEST_CASE("Property 6: Bresenham line-error bound",
          "[bresenham][property][property-6]") {
  REQUIRE(rc::check(
      "exact step counts, correct directions, <=1 step deviation, exact end",
      [] {
        const std::int32_t dx = *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1);
        const std::int32_t dy = *rc::gen::inRange(-kDeltaBound, kDeltaBound + 1);

        const LineTrace t = run(dx, dy);

        const std::int32_t adx = dx < 0 ? -dx : dx;
        const std::int32_t ady = dy < 0 ? -dy : dy;
        const std::int8_t sx = signOf(dx);
        const std::int8_t sy = signOf(dy);

        // (1) Exactly |dx| X-steps and |dy| Y-steps; tick count == major axis.
        RC_ASSERT(t.x_steps == adx);
        RC_ASSERT(t.y_steps == ady);
        RC_ASSERT(t.ticks == std::max(adx, ady));

        // (2) Every realised single-tick move is a unit step in the correct
        //     direction: each axis advances by 0 or its segment sign, never
        //     the opposite sign and never more than one step per tick.
        RC_ASSERT(!t.points.empty());
        for (std::size_t i = 1; i < t.points.size(); ++i) {
          const std::int32_t step_x = t.points[i].first - t.points[i - 1].first;
          const std::int32_t step_y =
              t.points[i].second - t.points[i - 1].second;
          RC_ASSERT(step_x == 0 || step_x == sx);
          RC_ASSERT(step_y == 0 || step_y == sy);
        }
        // When an axis moves at all, the emitted direction matches its sign.
        if (dx != 0) {
          RC_ASSERT(t.emitted_dir_x == sx);
        }
        if (dy != 0) {
          RC_ASSERT(t.emitted_dir_y == sy);
        }

        // (3) Perpendicular deviation from the ideal line stays within one
        //     step (the classic integer Bresenham bound is half a step).
        RC_ASSERT(maxPerpDistance(t, dx, dy) <= 1.0);

        // (4) The walk ends exactly on (dx, dy).
        RC_ASSERT(t.points.back().first == dx);
        RC_ASSERT(t.points.back().second == dy);
      }));
}

// ---------------------------------------------------------------------------
// Concrete cases anchoring the property at notable geometries.
// ---------------------------------------------------------------------------

TEST_CASE("Property 6 (concrete): axis-aligned moves step one axis only",
          "[bresenham][property-6][axis]") {
  struct Case {
    std::int32_t dx;
    std::int32_t dy;
  };
  const Case cases[] = {
      {10, 0}, {-10, 0}, {0, 7}, {0, -7}, {32767, 0}, {0, 32767},
  };
  for (const auto& c : cases) {
    INFO("dx=" << c.dx << " dy=" << c.dy);
    const LineTrace t = run(c.dx, c.dy);
    const std::int32_t adx = c.dx < 0 ? -c.dx : c.dx;
    const std::int32_t ady = c.dy < 0 ? -c.dy : c.dy;

    CHECK(t.x_steps == adx);
    CHECK(t.y_steps == ady);
    // An axis-aligned move is exactly on its own axis: zero deviation.
    CHECK(maxPerpDistance(t, c.dx, c.dy) == 0.0);
    CHECK(t.points.back().first == c.dx);
    CHECK(t.points.back().second == c.dy);
  }
}

TEST_CASE("Property 6 (concrete): 45-degree diagonals step both axes every tick",
          "[bresenham][property-6][diagonal]") {
  struct Case {
    std::int32_t dx;
    std::int32_t dy;
  };
  const Case cases[] = {
      {5, 5}, {-5, 5}, {5, -5}, {-5, -5}, {1000, 1000}, {-1000, 1000},
  };
  for (const auto& c : cases) {
    INFO("dx=" << c.dx << " dy=" << c.dy);
    const LineTrace t = run(c.dx, c.dy);
    const std::int32_t mag = c.dx < 0 ? -c.dx : c.dx;

    CHECK(t.x_steps == mag);
    CHECK(t.y_steps == mag);
    CHECK(t.ticks == mag);  // both axes pulse on every tick.
    // The realised path is exactly the ideal diagonal: zero deviation.
    CHECK(maxPerpDistance(t, c.dx, c.dy) == 0.0);
    CHECK(t.points.back().first == c.dx);
    CHECK(t.points.back().second == c.dy);
  }
}

TEST_CASE("Property 6 (concrete): degenerate zero-length move emits no steps",
          "[bresenham][property-6][degenerate]") {
  const LineTrace t = run(0, 0);
  CHECK(t.ticks == 0);
  CHECK(t.x_steps == 0);
  CHECK(t.y_steps == 0);
  // Only the origin is visited, and its deviation is zero.
  REQUIRE(t.points.size() == 1u);
  CHECK(t.points.back().first == 0);
  CHECK(t.points.back().second == 0);
  CHECK(maxPerpDistance(t, 0, 0) == 0.0);
}

TEST_CASE("Property 6 (concrete): shallow and steep lines stay within one step",
          "[bresenham][property-6][error_bound]") {
  struct Case {
    std::int32_t dx;
    std::int32_t dy;
  };
  const Case cases[] = {
      {100, 3}, {3, 100}, {-100, 37}, {41, -97}, {1000, 1}, {1, 1000},
  };
  for (const auto& c : cases) {
    INFO("dx=" << c.dx << " dy=" << c.dy);
    const LineTrace t = run(c.dx, c.dy);
    CHECK(maxPerpDistance(t, c.dx, c.dy) <= 1.0);
    CHECK(t.points.back().first == c.dx);
    CHECK(t.points.back().second == c.dy);
  }
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
