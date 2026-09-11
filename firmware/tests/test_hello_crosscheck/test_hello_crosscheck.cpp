// Host-side cross-language golden-bytes fixture for the HELLO envelope layout
// (Task 11.1).
//
// Feature: visual-corner-calibration, Property 4
//
// Property 4: Envelope round-trips through NVM and HELLO unchanged
// (cross-language decode side).
//
//   This pins the §4.8 HELLO payload layout as a SINGLE SOURCE OF TRUTH shared
//   between firmware and the web SPA. A known HelloFields fixture is serialised
//   by serializeHello() and asserted byte-for-byte against a 40-byte golden
//   array. The SAME golden bytes are fed into the TS wire client's onHello
//   decode path in:
//
//       web/src/net/hello_envelope_crosscheck.test.ts
//
//   If either side changes the HELLO offsets (envelope_x @ 32, envelope_y @ 36,
//   flags @ 28 bit2) the golden array here and the matching array there diverge
//   and one of the two suites fails the build — the layouts can never silently
//   drift apart.
//
//   Validates: Requirements 8.1, 8.3, 11.1.
//
// Fixture (HelloFields):
//   firmware_version   = 0x00010002
//   max_sps            = 1000   (HELLO_MAX_SPS, serialiser-fixed)
//   backlash_x/y       = 0
//   mm_per_rev_x/y     = 0.0f
//   logical_x/y_steps  = 0
//   flags              = CALIBRATED | ENVELOPE_CALIBRATED = 0x05
//   buffer_capacity    = 32     (HELLO_BUFFER_CAPACITY, serialiser-fixed)
//   envelope_x_steps   = 12345  (0x00003039)
//   envelope_y_steps   = 67890  (0x00010932)
//
// This translation unit lives in its own PlatformIO test directory so it links
// into a standalone test binary with its own `int main`, mirroring the other
// suites. Because the host_test environment sets `test_build_src = no`, it
// pulls hello.cpp in directly via a relative include so the binary is
// self-contained.
//
// Run with:
//
//     pio test -e host_test -f test_hello_crosscheck

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstddef>
#include <cstdint>

#include "../../src/app/hello.h"
#include "../../src/app/hello.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::app::HELLO_FLAG_CALIBRATED;
using etch::app::HELLO_FLAG_ENVELOPE_CALIBRATED;
using etch::app::HELLO_PAYLOAD_SIZE;
using etch::app::HelloFields;
using etch::app::serializeHello;

namespace {

// The 40-byte golden HELLO payload (little-endian, §4.8). These EXACT bytes are
// duplicated in web/src/net/hello_envelope_crosscheck.test.ts (GOLDEN_HELLO) as
// the shared single source of truth — keep the two arrays in lock-step.
constexpr std::array<std::uint8_t, 40> kGoldenHello = {{
    0x02, 0x00, 0x01, 0x00,  //  0  u32  firmware_version = 0x00010002
    0xE8, 0x03,              //  4  u16  max_sps          = 1000
    0x00, 0x00,              //  6  u16  reserved         = 0
    0x00, 0x00,              //  8  u16  backlash_x        = 0
    0x00, 0x00,              // 10  u16  backlash_y        = 0
    0x00, 0x00, 0x00, 0x00,  // 12  f32  mm_per_rev_x      = 0.0f
    0x00, 0x00, 0x00, 0x00,  // 16  f32  mm_per_rev_y      = 0.0f
    0x00, 0x00, 0x00, 0x00,  // 20  i32  logical_x_steps   = 0
    0x00, 0x00, 0x00, 0x00,  // 24  i32  logical_y_steps   = 0
    0x05,                    // 28  u8   flags = CALIBRATED|ENVELOPE_CALIBRATED
    0x00,                    // 29  u8   reserved          = 0
    0x20, 0x00,              // 30  u16  buffer_capacity   = 32
    0x39, 0x30, 0x00, 0x00,  // 32  u32  envelope_x_steps  = 12345 (0x3039)
    0x32, 0x09, 0x01, 0x00,  // 36  u32  envelope_y_steps  = 67890 (0x10932)
}};

HelloFields makeFixture() {
  HelloFields f{};
  f.firmware_version = 0x00010002u;
  f.max_sps = 1000;
  f.backlash_x = 0;
  f.backlash_y = 0;
  f.mm_per_rev_x = 0.0f;
  f.mm_per_rev_y = 0.0f;
  f.logical_x_steps = 0;
  f.logical_y_steps = 0;
  f.calibrated = true;
  f.unclean = false;
  f.buffer_capacity = 32;
  f.envelope_x_steps = 12345u;
  f.envelope_y_steps = 67890u;
  f.envelope_calibrated = true;
  return f;
}

}  // namespace

TEST_CASE("HELLO cross-check: serializeHello matches the golden 40 bytes",
          "[hello][envelope][crosscheck][property-4]") {
  const HelloFields f = makeFixture();

  std::uint8_t buf[HELLO_PAYLOAD_SIZE] = {0};
  const std::size_t n = serializeHello(f, buf, sizeof(buf));
  REQUIRE(n == HELLO_PAYLOAD_SIZE);
  REQUIRE(n == kGoldenHello.size());

  for (std::size_t i = 0; i < kGoldenHello.size(); ++i) {
    INFO("byte index " << i);
    CHECK(buf[i] == kGoldenHello[i]);
  }

  // Spell out the layout-critical fields the web decoder reads, so a failure
  // points straight at the offset that drifted.
  CHECK((buf[28] & HELLO_FLAG_CALIBRATED) != 0);
  CHECK((buf[28] & HELLO_FLAG_ENVELOPE_CALIBRATED) != 0);
  CHECK(buf[32] == 0x39);  // envelope_x_steps low byte (12345)
  CHECK(buf[36] == 0x32);  // envelope_y_steps low byte (67890)
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
