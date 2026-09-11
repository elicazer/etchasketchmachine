// Pure envelope-calibration core — translation unit.
//
// Every function in this core is a small, pure `inline` free function defined
// in envelope_calibration.h (so callers in both the .ino and the host tests
// inline them directly). This .cpp exists to give the core a compiled
// translation unit in the build graph and to assert, at compile time, that the
// header is self-contained and Arduino-include-free. It deliberately carries
// no additional logic.
//
// See envelope_calibration.h for the function contracts and the Axis decision
// (reuse of etch::protocol::Axis rather than a duplicate enum).

#include "envelope_calibration.h"

namespace etch {
namespace app {

// Compile-time sanity checks pinning the documented predicate semantics so an
// accidental edit to the inline definitions fails the build rather than a test.
static_assert(drawingPermitted(true, true),
              "drawing must be permitted when home set AND envelope captured");
static_assert(!drawingPermitted(true, false),
              "home-set-only must block drawing (no envelope)");
static_assert(!drawingPermitted(false, true),
              "envelope-without-home must block drawing");
static_assert(!drawingPermitted(false, false),
              "uncalibrated must block drawing");

static_assert(isValidEnvelope(1, 1), "strictly positive envelope is valid");
static_assert(!isValidEnvelope(0, 1), "zero X axis is invalid");
static_assert(!isValidEnvelope(1, 0), "zero Y axis is invalid");
static_assert(!isValidEnvelope(-1, 1), "negative X axis is invalid");

}  // namespace app
}  // namespace etch
