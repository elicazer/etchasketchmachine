// HTTP server for SPA hosting and REST endpoints (Task 3.2).
//
// Surface (Design §3.2.2):
//
//   | Method | Path        | Purpose                                          |
//   | ------ | ----------- | ------------------------------------------------ |
//   | GET    | /           | SPA index (gzipped, Content-Encoding: gzip)      |
//   | GET    | /static/*   | SPA assets (gzipped)                             |
//   | GET    | /api/info   | firmware version, IP, RSSI, hostname, calibrated |
//   | POST   | /api/wifi   | submit WiFi credentials (AP mode only)           |
//
// Design split (mirrors WiFiManager in firmware/src/wifi/):
//
//   1. Always-on, Arduino-free pure helpers. `parseMethod`, `routeMatches`,
//      `parseRequestLine`, and `parseWifiJson` carry the request-routing and
//      parsing logic and are exercised directly by the host Catch2 suite in
//      firmware/tests/test_http/test_http.cpp (no live socket required).
//
//   2. The HttpServer class. It stores its collaborators by reference/interface
//      (a WiFiManager& for RSSI / hostname / saveCreds / AP-mode detection, and
//      an ICalibrationState& for the persisted "calibrated" flag) so it can be
//      developed and tested without the concrete EEPROM-backed NVMManager.
//      All socket / WiFiS3 / ArduinoJson code lives behind `#if defined(ARDUINO)`
//      so this header (and the .cpp's pure helpers) compile under
//      `platform = native`.
//
// Web-asset embedding: the gzipped SPA blob comes from the generated header
// firmware/src/web_assets.h (produced by task 29.2). Until that task runs the
// header does not exist, so the .cpp guards the include behind
// `#if __has_include("web_assets.h")` and serves a tiny inline "web assets not
// embedded" page as a weak fallback, keeping the firmware linkable in the
// meantime. See http_server.cpp for details.
//
// References:
//   - Requirements 1.2 (HTTP server on :80, ack within 500 ms),
//     1.4 (credential bounds: SSID 1..32, password 8..63)
//   - Design §3.2.2 (HTTP surface), §4.8 (firmware version semantics)

#pragma once

#include <cstddef>
#include <cstdint>

#include "../wifi/wifi_manager.h"  // etch::wifi::WiFiManager

// WiFiClient is a plain class in the GLOBAL namespace (WiFiS3, UNO R4 WiFi).
// Forward-declare it at global scope so the member-function signatures below
// refer to the real `::WiFiClient`. Writing `class WiFiClient&` *inside*
// namespace etch::http would instead declare a phantom incomplete type
// `etch::http::WiFiClient`, which shadows the real one and breaks every
// client.*() call in the .cpp.
#if defined(ARDUINO)
class WiFiClient;
#endif

namespace etch {
namespace http {

// ---------------------------------------------------------------------------
// Firmware version (Design §4.8: surfaced as a string by GET /api/info and as
// a semver-packed u32 by the WebSocket HELLO frame in task 8.1).
// ---------------------------------------------------------------------------

inline constexpr const char* ETCH_FW_VERSION = "0.1.0";
inline constexpr std::uint8_t ETCH_FW_VERSION_MAJOR = 0;
inline constexpr std::uint8_t ETCH_FW_VERSION_MINOR = 1;
inline constexpr std::uint8_t ETCH_FW_VERSION_PATCH = 0;

// mDNS / advertised hostname returned in GET /api/info (Requirement 1.7).
inline constexpr const char* ETCH_HOSTNAME = "etchasketch.local";

// TCP port for the HTTP server (Requirement 1.2).
inline constexpr std::uint16_t HTTP_PORT = 80;

// Bounded buffer sizes for request parsing. The only POST body we accept is
// the WiFi-credentials JSON, which is at most ssid(32) + password(63) plus
// JSON punctuation and key names -- comfortably under 256 bytes.
inline constexpr std::size_t HTTP_REQUEST_LINE_MAX = 256;
inline constexpr std::size_t HTTP_PATH_MAX         = 128;
inline constexpr std::size_t HTTP_BODY_MAX         = 512;

// ---------------------------------------------------------------------------
// Host-testable pure helpers (Arduino-free)
// ---------------------------------------------------------------------------

// HTTP methods we route on. Anything we do not implement maps to Unknown so
// the dispatcher can answer 405 / 404 deterministically.
enum class HttpMethod : std::uint8_t {
  Unknown = 0,
  Get,
  Post,
};

// Parse an HTTP method token (the first whitespace-delimited word of the
// request line). Case-sensitive per RFC 7230 (methods are uppercase). Returns
// HttpMethod::Unknown for null input or any unrecognised verb.
HttpMethod parseMethod(const char* token);

// Match a concrete request `path` against a route `pattern`.
//   * A pattern with no trailing '*' matches iff the strings are byte-equal.
//   * A pattern ending in '*' matches iff `path` starts with the pattern's
//     prefix (the characters before the '*'). The prefix may be empty.
// Examples (see the host suite for the full table):
//   routeMatches("/",               "/")          -> true
//   routeMatches("/api/info",       "/api/info")  -> true
//   routeMatches("/static/foo.js",  "/static/*")  -> true
//   routeMatches("/static/",        "/static/*")  -> true
//   routeMatches("/api/info",       "/static/*")  -> false
// Returns false if either argument is null.
bool routeMatches(const char* path, const char* pattern);

// Parse an HTTP request line ("METHOD SP request-target SP HTTP-version") into
// a method and a path. The query string (everything from the first '?') and
// the HTTP-version token are stripped, leaving just the absolute path in
// `pathOut` (always NUL-terminated when `pathCap > 0`). Returns true on a
// well-formed line with a recognised method that fit within `pathCap`;
// otherwise returns false and sets `methodOut` to HttpMethod::Unknown.
bool parseRequestLine(const char* line, HttpMethod& methodOut, char* pathOut,
                      std::size_t pathCap);

// Result of parsing the POST /api/wifi JSON body.
enum class WifiJsonResult : std::uint8_t {
  Ok = 0,           // both fields present and copied within capacity
  Malformed,        // not a JSON object / unparseable
  MissingSsid,      // no "ssid" string field
  MissingPassword,  // no "password" string field
  SsidTooLong,      // "ssid" value did not fit in ssidCap (incl. NUL)
  PasswordTooLong,  // "password" value did not fit in pwCap (incl. NUL)
};

// Extract the "ssid" and "password" string fields from a small JSON object of
// the shape { "ssid": "...", "password": "..." }. This is a deliberately
// minimal, dependency-free parser (no ArduinoJson) so it is host-testable and
// adds no flash weight for the one fixed-shape body the firmware accepts.
//
// On WifiJsonResult::Ok, `ssidOut` and `pwOut` hold the NUL-terminated field
// values. The function only enforces *capacity* (oversize -> *TooLong); the
// full Requirement-1.4 length bounds (SSID 1..32, password 8..63) are enforced
// by WiFiManager::saveCreds at the call site. Supports the common JSON string
// escapes \" \\ \/ \n \r \t \b \f and \uXXXX (BMP, encoded to UTF-8).
WifiJsonResult parseWifiJson(const char* body, char* ssidOut,
                             std::size_t ssidCap, char* pwOut,
                             std::size_t pwCap);

// ---------------------------------------------------------------------------
// Calibration-state facade
// ---------------------------------------------------------------------------

// Minimal interface the HTTP server needs to report calibration state in
// GET /api/info. The concrete NVMManager (firmware/src/nvm/) exposes the
// persisted `calibrated` flag via PersistedConfig::flags; task 8.1 wires a
// thin adapter implementing this interface. Keeping the dependency narrow
// means the HTTP layer never reads EEPROM directly and host tests can plug in
// a trivial fake.
class ICalibrationState {
 public:
  virtual ~ICalibrationState() = default;

  // True iff the controller's position is calibrated (NVM_FLAG_CALIBRATED).
  virtual bool isCalibrated() const = 0;
};

// ---------------------------------------------------------------------------
// HttpServer
// ---------------------------------------------------------------------------

// Serves the embedded SPA and the REST surface in Design §3.2.2. The network
// implementation (WiFiServer / WiFiClient on the UNO R4 WiFi target, plus
// ArduinoJson for response bodies) is compiled only under `#if defined(ARDUINO)`;
// on the host the class still constructs (storing its references) so the
// translation unit links into the Catch2 test binary alongside the pure
// helpers.
class HttpServer {
 public:
  HttpServer(wifi::WiFiManager& wifi, ICalibrationState& calib);

  // Start listening on HTTP_PORT. Call from setup() (task 8.1).
  void begin();

  // Cooperative tick: accept at most one pending client and service its single
  // request, then close. Call every main-loop pass. Cheap when idle.
  void serviceLoop();

 private:
  wifi::WiFiManager& wifi_ [[maybe_unused]];
  ICalibrationState& calib_ [[maybe_unused]];
  bool started_ = false;

#if defined(ARDUINO)
  // Definitions live in the .cpp behind the same guard. The parameters use the
  // fully-qualified ::WiFiClient so they bind to the global WiFiS3 class, not a
  // phantom etch::http::WiFiClient.
  void handleClient(::WiFiClient& client);
  void handleGetIndex(::WiFiClient& client);
  void handleGetStatic(::WiFiClient& client);
  void handleGetInfo(::WiFiClient& client);
  void handlePostWifi(::WiFiClient& client, const char* body);
  void writeInfoJson(::WiFiClient& client, int statusCode,
                     const char* statusText);
#endif
};

}  // namespace http
}  // namespace etch
