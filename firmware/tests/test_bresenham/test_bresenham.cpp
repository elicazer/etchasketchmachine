// Host-side tests for the Bresenham two-axis coordinator (Task 6.1).
//
// Validates the contract in Design §2.4.2 and the formal statement in
// Property 6 (Design §7), which Task 6.2 will cover with rapidcheck:
//
//   For any segment with deltas (dx, dy) where |dx| + |dy| > 0, the emitted
//   step sequence contains exactly |dx| X-steps in direction sign(dx) and
//   exactly |dy| Y-steps in direction sign(dy), and the maximum perpendicular
//   distance from any intermediate stylus position to the ideal line from the
//   origin to (dx, dy) is at most one step.
//
// These are example-based unit tests. Run under PlatformIO with:
//
//     pio test -e host_test
//
// The host_test environment sets `test_build_src = no`, so this translation
// unit pulls the implementation in directly via a relative include to stay
// self-contained, matching the test_crc16 / test_nvm pattern.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

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

// Maximum perpendicular distance from any visited point to the ideal line
// through the origin and (dx, dy). For a zero-length move this is 0.
double maxPerpDistance(const LineTrace& t, std::int32_t dx, std::int32_t dy) {
  const double len = std::sqrt(static_cast<double>(dx) * dx +
                               static_cast<double>(dy) * dy);
  if (len == 0.0) {
    return 0.0;
  }
  double worst = 0.0;
  for (const auto& p : t.points) {
    // Distance from P to the line through origin with direction (dx, dy):
    //   |dx * py - dy * px| / sqrt(dx^2 + dy^2)
    const double num = std::fabs(static_cast<double>(dx) * p.second -
                                 static_cast<double>(dy) * p.first);
    worst = std::max(worst, num / len);
  }
  return worst;
}

}  // namespace

TEST_CASE("Bresenham emits exactly |dx| X-steps and |dy| Y-steps",
          "[bresenham][counts]") {
  struct Case {
    std::int32_t dx;
    std::int32_t dy;
  };
  const Case cases[] = {
      {0, 0},       // degenerate: no motion
      {10, 0},      // axis-aligned +X
      {0, 7},       // axis-aligned +Y
      {-12, 0},     // axis-aligned -X
      {0, -9},      // axis-aligned -Y
      {5, 5},       // 45 degrees
      {-8, 8},      // 45 degrees, mixed sign
      {7, -7},      // 45 degrees, mixed sign
      {-6, -6},     // 45 degrees, both negative
      {100, 3},     // shallow
      {3, 100},     // steep
      {-100, 37},   // shallow, negative major
      {41, -97},    // steep, mixed sign
      {1, 1},       // smallest diagonal
      {32767, 0},   // wire delta limit, axis-aligned
      {12345, 6789}, // large arbitrary
  };

  for (const auto& c : cases) {
    INFO("dx=" << c.dx << " dy=" << c.dy);
    const LineTrace t = run(c.dx, c.dy);

    const std::int32_t adx = c.dx < 0 ? -c.dx : c.dx;
    const std::int32_t ady = c.dy < 0 ? -c.dy : c.dy;

    // Exactly |dx| X-steps and |dy| Y-steps.
    CHECK(t.x_steps == adx);
    CHECK(t.y_steps == ady);

    // The number of ticks equals the major-axis length.
    CHECK(t.ticks == std::max(adx, ady));
  }
}

TEST_CASE("Bresenham step directions match the signs of dx and dy",
          "[bresenham][direction]") {
  struct Case {
    std::int32_t dx;
    std::int32_t dy;
  };
  const Case cases[] = {
      {10, 4},   {-10, 4},  {10, -4},  {-10, -4},
      {4, 10},   {-4, 10},  {4, -10},  {-4, -10},
      {6, 6},    {-6, 6},   {6, -6},   {-6, -6},
      {15, 0},   {-15, 0},  {0, 15},   {0, -15},
  };

  for (const auto& c : cases) {
    INFO("dx=" << c.dx << " dy=" << c.dy);
    const LineTrace t = run(c.dx, c.dy);

    const std::int8_t want_x = static_cast<std::int8_t>((c.dx > 0) - (c.dx < 0));
    const std::int8_t want_y = static_cast<std::int8_t>((c.dy > 0) - (c.dy < 0));

    // Direction accessors always report the segment signs.
    CHECK(BresenhamLine(c.dx, c.dy).dirX() == want_x);
    CHECK(BresenhamLine(c.dx, c.dy).dirY() == want_y);

    // When an axis actually steps, the emitted direction matches its sign.
    if (c.dx != 0) {
      CHECK(t.emitted_dir_x == want_x);
    }
    if (c.dy != 0) {
      CHECK(t.emitted_dir_y == want_y);
    }

    // The endpoint of the walk lands exactly on (dx, dy).
    REQUIRE_FALSE(t.points.empty());
    CHECK(t.points.back().first == c.dx);
    CHECK(t.points.back().second == c.dy);
  }
}

TEST_CASE("Bresenham keeps perpendicular deviation within one step",
          "[bresenham][error_bound]") {
  struct Case {
    std::int32_t dx;
    std::int32_t dy;
  };
  const Case cases[] = {
      {100, 3},     {3, 100},    {100, 37},   {37, 100},
      {-100, 37},   {37, -100},  {50, 50},    {-50, 50},
      {1000, 1},    {1, 1000},   {7, 5},      {13, 8},
      {12345, 6789}, {32767, 511}, {255, 32767},
  };

  for (const auto& c : cases) {
    INFO("dx=" << c.dx << " dy=" << c.dy);
    const LineTrace t = run(c.dx, c.dy);
    const double worst = maxPerpDistance(t, c.dx, c.dy);
    // The classic integer Bresenham bound is half a step; assert the looser
    // <= 1 step requirement from Property 6 with margin.
    CHECK(worst <= 1.0);
  }
}

TEST_CASE("Bresenham nextStep returns false immediately for a zero-length move",
          "[bresenham][degenerate]") {
  BresenhamLine line(0, 0);
  StepOutput out;
  CHECK(line.done());
  CHECK(line.totalSteps() == 0);
  CHECK_FALSE(line.nextStep(out));
  // The no-step tick is well defined.
  CHECK_FALSE(out.stepX);
  CHECK_FALSE(out.stepY);
}

TEST_CASE("Bresenham reset reconfigures the generator for a new segment",
          "[bresenham][reset]") {
  BresenhamLine line(10, 0);
  StepOutput out;
  // Consume the first segment fully.
  while (line.nextStep(out)) {
  }
  CHECK(line.done());

  // Reset to a steep negative-Y segment and re-run.
  line.reset(0, -5);
  const std::int8_t dir_y = line.dirY();
  CHECK(dir_y == -1);
  std::int32_t y_steps = 0;
  while (line.nextStep(out)) {
    if (out.stepY) {
      ++y_steps;
      CHECK(out.dirY == -1);
    }
    CHECK_FALSE(out.stepX);
  }
  CHECK(y_steps == 5);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
