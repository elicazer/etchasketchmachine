// Host-side property tests for the new envelope-capture CTL kinds (Task 3.3).
//
// Feature: visual-corner-calibration, Property 7
//
// Property 7: New CTL kinds validate length and round-trip (parse side).
//
//   *For any* payload presented with a leading kind byte of 0x0E
//   (CAPTURE_BOTTOM_LEFT) or 0x0F (CAPTURE_TOP_RIGHT), parseControl returns
//   CtlParseResult::Ok if and only if the payload is exactly one byte (just the
//   kind byte, since these kinds are parameterless), and CtlParseResult::BadLength
//   otherwise. A well-formed single byte parses to the matching ControlKind.
//
//   Validates: Requirements 9.1, 9.2, 9.3, 9.4.
//
// This translation unit lives in its own PlatformIO test directory
// (test_capture_ctl_props/) so it links into a standalone test binary with its
// own `int main`, mirroring the other *_props/ suites (test_jog_props,
// test_command_parser_props). Because the host_test environment sets
// `test_build_src = no`, it pulls control_parser.cpp in directly via a relative
// include so the binary is self-contained.
//
// Properties are exercised with rapidcheck via the standalone rc::check form
// invoked from inside Catch2 TEST_CASEs; rc::check returns true on success, so
// wrapping it in REQUIRE surfaces a failing property (with rapidcheck's shrunk
// counterexample on stderr) as a Catch2 failure.
//
// Run with:
//
//     pio test -e host_test -f test_capture_ctl_props

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "../../src/protocol/control_parser.h"
#include "../../src/protocol/control_parser.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::protocol::ControlKind;
using etch::protocol::ControlMessage;
using etch::protocol::CtlParseResult;
using etch::protocol::parseControl;

namespace {

// The two capture kind codes under test (Design §4.6 / Data Models CTL layout).
constexpr std::uint8_t kCaptureBottomLeft =
    static_cast<std::uint8_t>(ControlKind::CAPTURE_BOTTOM_LEFT);  // 0x0E
constexpr std::uint8_t kCaptureTopRight =
    static_cast<std::uint8_t>(ControlKind::CAPTURE_TOP_RIGHT);  // 0x0F

// Pick one of the two capture kind codes from inside an rc::check body.
std::uint8_t genCaptureKind() {
  return (*rc::gen::inRange(0, 2) == 0) ? kCaptureBottomLeft
                                        : kCaptureTopRight;
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 7 (length validation): for an arbitrary-length payload whose first
// byte is a capture kind, parse succeeds iff the total length is exactly 1.
// ---------------------------------------------------------------------------
TEST_CASE("Property 7: capture CTL parses Ok iff payload is exactly one byte",
          "[ctl][capture][property][property-7]") {
  REQUIRE(rc::check(
      "0x0E/0x0F: Ok iff len==1, BadLength otherwise", [] {
        const std::uint8_t kind = genCaptureKind();
        // Arbitrary total payload length in [1, 16]; len==1 is the only valid
        // case, every other length must be rejected as BadLength.
        const std::size_t len =
            static_cast<std::size_t>(*rc::gen::inRange(1, 17));

        std::vector<std::uint8_t> bytes(len, 0u);
        bytes[0] = kind;
        // Fill any trailing bytes with arbitrary noise: they must never make a
        // longer-than-one payload valid.
        for (std::size_t i = 1; i < len; ++i) {
          bytes[i] = static_cast<std::uint8_t>(*rc::gen::inRange(0, 256));
        }

        ControlMessage out{};
        const CtlParseResult result =
            parseControl(bytes.data(), bytes.size(), out);

        if (len == 1) {
          RC_ASSERT(result == CtlParseResult::Ok);
          // A well-formed single byte parses to the matching kind.
          RC_ASSERT(out.kind == static_cast<ControlKind>(kind));
        } else {
          RC_ASSERT(result == CtlParseResult::BadLength);
        }
      }));
}

// ---------------------------------------------------------------------------
// Property 7 (round-trip): a well-formed single capture byte always parses to
// the exact matching ControlKind (the encode side is a single kind byte, so a
// 1-byte buffer is the canonical wire form).
// ---------------------------------------------------------------------------
TEST_CASE("Property 7: a well-formed capture byte round-trips to its kind",
          "[ctl][capture][property][property-7]") {
  REQUIRE(rc::check("single kind byte -> matching ControlKind", [] {
    const std::uint8_t kind = genCaptureKind();
    const std::uint8_t buf[1] = {kind};

    ControlMessage out{};
    const CtlParseResult result = parseControl(buf, 1, out);

    RC_ASSERT(result == CtlParseResult::Ok);
    RC_ASSERT(out.kind == static_cast<ControlKind>(kind));
    // The decoded kind re-encodes to the same wire byte.
    RC_ASSERT(static_cast<std::uint8_t>(out.kind) == kind);
  }));
}

// ---------------------------------------------------------------------------
// Concrete pins (plain Catch2): the two kinds, exact codes, and the empty
// payload edge case.
// ---------------------------------------------------------------------------
TEST_CASE("Property 7 (concrete): capture kinds use codes 0x0E and 0x0F",
          "[ctl][capture][property-7][example]") {
  CHECK(kCaptureBottomLeft == 0x0E);
  CHECK(kCaptureTopRight == 0x0F);

  ControlMessage out{};
  const std::uint8_t bl[1] = {kCaptureBottomLeft};
  REQUIRE(parseControl(bl, 1, out) == CtlParseResult::Ok);
  CHECK(out.kind == ControlKind::CAPTURE_BOTTOM_LEFT);

  const std::uint8_t tr[1] = {kCaptureTopRight};
  REQUIRE(parseControl(tr, 1, out) == CtlParseResult::Ok);
  CHECK(out.kind == ControlKind::CAPTURE_TOP_RIGHT);
}

TEST_CASE("Property 7 (concrete): capture kind with a trailing byte is BadLength",
          "[ctl][capture][property-7][example]") {
  ControlMessage out{};
  const std::uint8_t bl2[2] = {kCaptureBottomLeft, 0x00};
  CHECK(parseControl(bl2, 2, out) == CtlParseResult::BadLength);
  const std::uint8_t tr2[2] = {kCaptureTopRight, 0xFF};
  CHECK(parseControl(tr2, 2, out) == CtlParseResult::BadLength);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
