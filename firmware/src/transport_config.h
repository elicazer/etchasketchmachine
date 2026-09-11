// Compile-time transport selection (Design §3.7, §4; Requirement 1).
//
// On the Arduino UNO R4 WiFi the WiFi stack (`WiFiS3`) and the BLE stack
// (`ArduinoBLE`) share one ESP32-S3 radio co-processor and cannot run
// concurrently, so EXACTLY ONE transport is linked per firmware image, chosen
// at build time by the `ETCH_TRANSPORT` PlatformIO build flag — never at
// runtime (Req 1.1, 1.6). This header resolves that flag to:
//
//   * a hard compile error when the flag is unset or set to an unknown value,
//     with a diagnostic naming the valid options (Req 1.5), and
//   * a single `app::Transport` typedef that the sketch constructs, so the
//     frame router and every send helper are written once and are identical
//     across both builds (Req 1.2, 1.3; Design §3.7).
//
// -------------------------------------------------------------------------
// Why this is not the literal `#if ETCH_TRANSPORT == ETCH_TRANSPORT_BLE`
// -------------------------------------------------------------------------
// The build env passes a *token*: `-D ETCH_TRANSPORT=ble`. That makes the
// preprocessor expand `ETCH_TRANSPORT` to the bare identifier `ble`. The
// design sketch's `#if ETCH_TRANSPORT == ETCH_TRANSPORT_BLE` only behaves
// correctly if `ble` and `wifi` are themselves macros — i.e. we would have to
// `#define ble ...` / `#define wifi ...` globally. Defining bare `ble`/`wifi`
// macros is dangerous: any variable, member, or parameter named `ble`/`wifi`
// anywhere in the translation unit would be silently rewritten.
//
// Instead we keep the env flag exactly as the design specifies
// (`-D ETCH_TRANSPORT=ble` / `=wifi`) and map the token to a numeric code with
// a token-paste indirection: `ETCH_TRANSPORT_##<token>`. This pastes the flag
// token onto a unique `ETCH_TRANSPORT_` prefix, so only the intentional
// `ETCH_TRANSPORT_ble` / `ETCH_TRANSPORT_wifi` mapping macros are consulted and
// no common identifier is polluted. An unknown token pastes to an undefined
// macro, which the preprocessor evaluates to 0 in `#if`, so it falls through
// to the invalid-option `#error` (Req 1.5).

#pragma once

// --- Numeric transport codes (Design §3.7 names them ETCH_TRANSPORT_BLE/WIFI).
#define ETCH_TRANSPORT_BLE 1
#define ETCH_TRANSPORT_WIFI 2

// --- Map the lowercase build-flag tokens to their numeric codes.
//
// `-D ETCH_TRANSPORT=ble`  -> ETCH_TRANSPORT_ble  -> ETCH_TRANSPORT_BLE  (1)
// `-D ETCH_TRANSPORT=wifi` -> ETCH_TRANSPORT_wifi -> ETCH_TRANSPORT_WIFI (2)
#define ETCH_TRANSPORT_ble ETCH_TRANSPORT_BLE
#define ETCH_TRANSPORT_wifi ETCH_TRANSPORT_WIFI

// Two-level paste so the *value* of ETCH_TRANSPORT is expanded before being
// pasted onto the `ETCH_TRANSPORT_` prefix (the classic expand-then-paste
// idiom). ETCH_TRANSPORT_CODE(ble) -> ETCH_TRANSPORT_CODE_IMPL(ble)
//                                  -> ETCH_TRANSPORT_##ble
//                                  -> ETCH_TRANSPORT_ble -> 1.
#define ETCH_TRANSPORT_CODE_IMPL(token) ETCH_TRANSPORT_##token
#define ETCH_TRANSPORT_CODE(token) ETCH_TRANSPORT_CODE_IMPL(token)

#if !defined(ETCH_TRANSPORT)
#error "ETCH_TRANSPORT unset. Set -D ETCH_TRANSPORT=ble or -D ETCH_TRANSPORT=wifi."
#endif

// Resolve the flag token to its numeric code. An unknown token (e.g. `foo`)
// pastes to the undefined macro ETCH_TRANSPORT_foo, which evaluates to 0 here
// and therefore matches neither code below, hitting the invalid-option #error.
#define ETCH_TRANSPORT_RESOLVED ETCH_TRANSPORT_CODE(ETCH_TRANSPORT)

#if ETCH_TRANSPORT_RESOLVED == ETCH_TRANSPORT_BLE
#include "protocol/ble_server.h"
namespace etch {
namespace app {
using Transport = etch::protocol::BleServer;
}  // namespace app
}  // namespace etch
#elif ETCH_TRANSPORT_RESOLVED == ETCH_TRANSPORT_WIFI
#include "protocol/ws_server.h"
namespace etch {
namespace app {
using Transport = etch::protocol::WSServer;
}  // namespace app
}  // namespace etch
#else
#error "ETCH_TRANSPORT invalid. Valid options: ble, wifi."
#endif
