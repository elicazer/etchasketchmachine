// Host-side unit tests for the HTTP server pure helpers (Task 3.2).
//
// Exercises the Arduino-free request-routing / parsing surface declared in
// firmware/src/http/http_server.h:
//   * parseMethod      - HTTP verb token -> HttpMethod
//   * routeMatches     - concrete path vs. route pattern (incl. /static/*)
//   * parseRequestLine - "METHOD target HTTP/1.1" -> method + path
//   * parseWifiJson    - { "ssid", "password" } extraction with capacity
//                        and missing-field detection (Requirement 1.4 bounds
//                        are enforced downstream by WiFiManager::saveCreds).
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment sets `test_build_src = no`, so this translation
// unit pulls the implementation in directly via relative include. None of the
// WiFiS3 / ArduinoJson / socket code is compiled because ARDUINO is undefined
// on the native host (everything network-shaped is behind `#if defined(ARDUINO)`).

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstring>
#include <string>

#include "../../src/http/http_server.h"
#include "../../src/http/http_server.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::http::HttpMethod;
using etch::http::WifiJsonResult;
using etch::http::parseMethod;
using etch::http::parseRequestLine;
using etch::http::parseWifiJson;
using etch::http::routeMatches;

namespace {

std::string repeated(std::size_t n, char ch = 'a') {
  return std::string(n, ch);
}

}  // namespace

// ---------------------------------------------------------------------------
// parseMethod
// ---------------------------------------------------------------------------

TEST_CASE("parseMethod recognises GET and POST", "[http][method]") {
  REQUIRE(parseMethod("GET") == HttpMethod::Get);
  REQUIRE(parseMethod("POST") == HttpMethod::Post);
}

TEST_CASE("parseMethod is case-sensitive and rejects unknown verbs",
          "[http][method]") {
  REQUIRE(parseMethod("get") == HttpMethod::Unknown);
  REQUIRE(parseMethod("Get") == HttpMethod::Unknown);
  REQUIRE(parseMethod("PUT") == HttpMethod::Unknown);
  REQUIRE(parseMethod("DELETE") == HttpMethod::Unknown);
  REQUIRE(parseMethod("HEAD") == HttpMethod::Unknown);
  REQUIRE(parseMethod("") == HttpMethod::Unknown);
  REQUIRE(parseMethod(nullptr) == HttpMethod::Unknown);
}

// ---------------------------------------------------------------------------
// routeMatches
// ---------------------------------------------------------------------------

TEST_CASE("routeMatches does exact matching for non-wildcard patterns",
          "[http][route]") {
  REQUIRE(routeMatches("/", "/"));
  REQUIRE(routeMatches("/api/info", "/api/info"));
  REQUIRE(routeMatches("/api/wifi", "/api/wifi"));

  REQUIRE_FALSE(routeMatches("/api/info", "/"));
  REQUIRE_FALSE(routeMatches("/", "/api/info"));
  REQUIRE_FALSE(routeMatches("/api/info/", "/api/info"));
  REQUIRE_FALSE(routeMatches("/api/inf", "/api/info"));
}

TEST_CASE("routeMatches does prefix matching for wildcard patterns",
          "[http][route]") {
  REQUIRE(routeMatches("/static/foo.js", "/static/*"));
  REQUIRE(routeMatches("/static/app.css", "/static/*"));
  REQUIRE(routeMatches("/static/img/logo.png", "/static/*"));
  // The boundary case: the prefix itself with nothing after the slash.
  REQUIRE(routeMatches("/static/", "/static/*"));

  // Non-matching prefixes.
  REQUIRE_FALSE(routeMatches("/api/info", "/static/*"));
  REQUIRE_FALSE(routeMatches("/stati", "/static/*"));
  REQUIRE_FALSE(routeMatches("/", "/static/*"));
}

TEST_CASE("routeMatches rejects null inputs", "[http][route]") {
  REQUIRE_FALSE(routeMatches(nullptr, "/"));
  REQUIRE_FALSE(routeMatches("/", nullptr));
  REQUIRE_FALSE(routeMatches(nullptr, nullptr));
}

// ---------------------------------------------------------------------------
// parseRequestLine
// ---------------------------------------------------------------------------

TEST_CASE("parseRequestLine extracts method and path for the SPA routes",
          "[http][reqline]") {
  HttpMethod m = HttpMethod::Unknown;
  char path[128] = {0};

  REQUIRE(parseRequestLine("GET / HTTP/1.1", m, path, sizeof(path)));
  REQUIRE(m == HttpMethod::Get);
  REQUIRE(std::string(path) == "/");

  REQUIRE(parseRequestLine("GET /api/info HTTP/1.1", m, path, sizeof(path)));
  REQUIRE(m == HttpMethod::Get);
  REQUIRE(std::string(path) == "/api/info");

  REQUIRE(parseRequestLine("POST /api/wifi HTTP/1.1", m, path, sizeof(path)));
  REQUIRE(m == HttpMethod::Post);
  REQUIRE(std::string(path) == "/api/wifi");

  REQUIRE(parseRequestLine("GET /static/app.js HTTP/1.1", m, path,
                           sizeof(path)));
  REQUIRE(m == HttpMethod::Get);
  REQUIRE(std::string(path) == "/static/app.js");
}

TEST_CASE("parseRequestLine strips the query string from the target",
          "[http][reqline]") {
  HttpMethod m = HttpMethod::Unknown;
  char path[128] = {0};

  REQUIRE(parseRequestLine("GET /api/info?cache=0 HTTP/1.1", m, path,
                           sizeof(path)));
  REQUIRE(m == HttpMethod::Get);
  REQUIRE(std::string(path) == "/api/info");

  REQUIRE(parseRequestLine("GET /static/a.js?v=2&x=1 HTTP/1.1", m, path,
                           sizeof(path)));
  REQUIRE(std::string(path) == "/static/a.js");
}

TEST_CASE("parseRequestLine rejects malformed lines and unknown methods",
          "[http][reqline]") {
  HttpMethod m = HttpMethod::Get;  // seed non-Unknown to confirm reset
  char path[128] = {0};

  // Unknown verb.
  REQUIRE_FALSE(parseRequestLine("PUT /x HTTP/1.1", m, path, sizeof(path)));
  REQUIRE(m == HttpMethod::Unknown);

  // No target after the method.
  REQUIRE_FALSE(parseRequestLine("GET", m, path, sizeof(path)));
  REQUIRE(m == HttpMethod::Unknown);

  // Empty line / null.
  REQUIRE_FALSE(parseRequestLine("", m, path, sizeof(path)));
  REQUIRE_FALSE(parseRequestLine(nullptr, m, path, sizeof(path)));
}

TEST_CASE("parseRequestLine rejects a target that overflows the path buffer",
          "[http][reqline]") {
  HttpMethod m = HttpMethod::Unknown;
  char small[8] = {0};  // room for "/" + few chars only

  // "/abcdefghij" is far longer than 7 usable chars.
  REQUIRE_FALSE(
      parseRequestLine("GET /abcdefghij HTTP/1.1", m, small, sizeof(small)));
  REQUIRE(m == HttpMethod::Unknown);
  REQUIRE(small[0] == '\0');
}

// ---------------------------------------------------------------------------
// parseWifiJson
// ---------------------------------------------------------------------------

TEST_CASE("parseWifiJson extracts ssid and password from a valid object",
          "[http][wifijson]") {
  char ssid[33] = {0};
  char pw[64] = {0};

  const auto r = parseWifiJson(R"({"ssid":"home-net","password":"hunter22!"})",
                               ssid, sizeof(ssid), pw, sizeof(pw));
  REQUIRE(r == WifiJsonResult::Ok);
  REQUIRE(std::string(ssid) == "home-net");
  REQUIRE(std::string(pw) == "hunter22!");
}

TEST_CASE("parseWifiJson tolerates whitespace and reversed key order",
          "[http][wifijson]") {
  char ssid[33] = {0};
  char pw[64] = {0};

  const auto r = parseWifiJson(
      "{  \"password\" : \"s3cr3t-pass\" , \"ssid\" : \"my ssid\"  }", ssid,
      sizeof(ssid), pw, sizeof(pw));
  REQUIRE(r == WifiJsonResult::Ok);
  REQUIRE(std::string(ssid) == "my ssid");
  REQUIRE(std::string(pw) == "s3cr3t-pass");
}

TEST_CASE("parseWifiJson ignores unrelated extra fields", "[http][wifijson]") {
  char ssid[33] = {0};
  char pw[64] = {0};

  const auto r = parseWifiJson(
      R"({"channel":6,"ssid":"net","hidden":false,"password":"password1"})",
      ssid, sizeof(ssid), pw, sizeof(pw));
  REQUIRE(r == WifiJsonResult::Ok);
  REQUIRE(std::string(ssid) == "net");
  REQUIRE(std::string(pw) == "password1");
}

TEST_CASE("parseWifiJson decodes common string escapes", "[http][wifijson]") {
  char ssid[33] = {0};
  char pw[64] = {0};

  const auto r = parseWifiJson(
      R"({"ssid":"a\/b","password":"p\u0041ss\tword"})", ssid, sizeof(ssid),
      pw, sizeof(pw));
  REQUIRE(r == WifiJsonResult::Ok);
  REQUIRE(std::string(ssid) == "a/b");
  REQUIRE(std::string(pw) == "pAss\tword");
}

TEST_CASE("parseWifiJson reports missing ssid field", "[http][wifijson]") {
  char ssid[33] = {0};
  char pw[64] = {0};

  const auto r = parseWifiJson(R"({"password":"hunter22!"})", ssid,
                               sizeof(ssid), pw, sizeof(pw));
  REQUIRE(r == WifiJsonResult::MissingSsid);
  REQUIRE(ssid[0] == '\0');
}

TEST_CASE("parseWifiJson reports missing password field", "[http][wifijson]") {
  char ssid[33] = {0};
  char pw[64] = {0};

  const auto r = parseWifiJson(R"({"ssid":"home-net"})", ssid, sizeof(ssid),
                               pw, sizeof(pw));
  REQUIRE(r == WifiJsonResult::MissingPassword);
}

TEST_CASE("parseWifiJson reports missing ssid for an empty object",
          "[http][wifijson]") {
  char ssid[33] = {0};
  char pw[64] = {0};

  const auto r = parseWifiJson("{}", ssid, sizeof(ssid), pw, sizeof(pw));
  REQUIRE(r == WifiJsonResult::MissingSsid);
}

TEST_CASE("parseWifiJson reports oversize ssid that does not fit capacity",
          "[http][wifijson]") {
  // Use a deliberately tiny ssid buffer so a normal value overflows it.
  char ssid[5] = {0};  // holds at most 4 chars + NUL
  char pw[64] = {0};

  const std::string body =
      std::string(R"({"ssid":")") + repeated(10) + R"(","password":"password1"})";
  const auto r = parseWifiJson(body.c_str(), ssid, sizeof(ssid), pw,
                               sizeof(pw));
  REQUIRE(r == WifiJsonResult::SsidTooLong);
  REQUIRE(ssid[0] == '\0');
}

TEST_CASE("parseWifiJson reports oversize password that does not fit capacity",
          "[http][wifijson]") {
  char ssid[33] = {0};
  char pw[5] = {0};  // holds at most 4 chars + NUL

  const std::string body = std::string(R"({"ssid":"net","password":")") +
                           repeated(20) + R"("})";
  const auto r = parseWifiJson(body.c_str(), ssid, sizeof(ssid), pw,
                               sizeof(pw));
  REQUIRE(r == WifiJsonResult::PasswordTooLong);
  REQUIRE(pw[0] == '\0');
}

TEST_CASE("parseWifiJson treats ssid capacity exactly at the buffer edge",
          "[http][wifijson]") {
  // ssidCap = 5 means values up to length 4 fit; length 4 is the boundary.
  char ssid[5] = {0};
  char pw[64] = {0};

  const auto ok = parseWifiJson(R"({"ssid":"abcd","password":"password1"})",
                                ssid, sizeof(ssid), pw, sizeof(pw));
  REQUIRE(ok == WifiJsonResult::Ok);
  REQUIRE(std::string(ssid) == "abcd");

  const auto over = parseWifiJson(R"({"ssid":"abcde","password":"password1"})",
                                  ssid, sizeof(ssid), pw, sizeof(pw));
  REQUIRE(over == WifiJsonResult::SsidTooLong);
}

TEST_CASE("parseWifiJson rejects malformed bodies", "[http][wifijson]") {
  char ssid[33] = {0};
  char pw[64] = {0};

  // Not an object.
  REQUIRE(parseWifiJson(R"(["ssid","password"])", ssid, sizeof(ssid), pw,
                        sizeof(pw)) == WifiJsonResult::Malformed);
  // Truncated.
  REQUIRE(parseWifiJson(R"({"ssid":"net)", ssid, sizeof(ssid), pw,
                        sizeof(pw)) == WifiJsonResult::Malformed);
  // Missing colon.
  REQUIRE(parseWifiJson(R"({"ssid" "net"})", ssid, sizeof(ssid), pw,
                        sizeof(pw)) == WifiJsonResult::Malformed);
  // Empty string.
  REQUIRE(parseWifiJson("", ssid, sizeof(ssid), pw, sizeof(pw)) ==
          WifiJsonResult::Malformed);
  // Null body.
  REQUIRE(parseWifiJson(nullptr, ssid, sizeof(ssid), pw, sizeof(pw)) ==
          WifiJsonResult::Malformed);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
