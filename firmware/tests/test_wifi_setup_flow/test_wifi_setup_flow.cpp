// Host-side unit tests for the AP-mode WiFi credential submission flow
// (Task 31.2 — POST /api/wifi).
//
// The real `HttpServer::handlePostWifi` socket handler is compiled only under
// `#if defined(ARDUINO)`, but the *logic* it runs is composed entirely of two
// host-testable surfaces:
//
//   1. `etch::http::parseWifiJson`  — extract { "ssid", "password" } from the
//      POST body (firmware/src/http/http_server.{h,cpp}).
//   2. `etch::wifi::WiFiManager::saveCreds` — enforce the Requirement-1.4
//      length bounds (SSID 1..32, password 8..63), persist via the NVM facade
//      on success (Req 1.5), and restart the STA association.
//
// This suite reproduces the handler's exact pipeline on the host — parse the
// body, then feed the parsed fields to `saveCreds` against an in-memory
// `FakeNVM` seam — and asserts the three behaviours called out in the task:
//
//   * an empty SSID is rejected and nothing is persisted;
//   * a password shorter than 8 chars is rejected and nothing is persisted;
//   * a well-formed body with valid credentials reaches `saveCreds`, which
//     persists the credentials through the NVM facade.
//
// Run with:
//
//     pio test -e host_test
//
// `test_build_src = no`, so this translation unit pulls both implementations
// in directly via relative include. None of the WiFiS3 / ArduinoJson / socket
// code compiles because ARDUINO is undefined on the native host.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstring>
#include <string>

#include "../../src/http/http_server.h"
#include "../../src/wifi/wifi_manager.h"
#include "../../src/http/http_server.cpp"   // NOLINT(bugprone-suspicious-include)
#include "../../src/wifi/wifi_manager.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::PersistedConfig;
using etch::http::WifiJsonResult;
using etch::http::parseWifiJson;
using etch::wifi::INVMManager;
using etch::wifi::WiFiManager;
using etch::wifi::WIFI_PASSWORD_MAX_LEN;
using etch::wifi::WIFI_SSID_MAX_LEN;

namespace {

// In-memory NVM stand-in mirroring the one used in test_wifi.cpp. Records the
// last credentials written so the test can assert whether saveCreds reached
// the persistence layer.
class FakeNVM : public INVMManager {
 public:
  FakeNVM() {
    std::memset(&cfg_, 0, sizeof(cfg_));
    cfg_.magic = etch::NVM_MAGIC;
    cfg_.version = etch::NVM_VERSION;
  }

  const PersistedConfig& get() const override { return cfg_; }

  void setWifiCredentials(const char* ssid, const char* password) override {
    ++writes_;
    saved_ssid_ = ssid ? ssid : "";
    saved_password_ = password ? password : "";
    std::memset(cfg_.wifi_ssid, 0, sizeof(cfg_.wifi_ssid));
    std::memset(cfg_.wifi_password, 0, sizeof(cfg_.wifi_password));
    if (ssid != nullptr) {
      std::strncpy(cfg_.wifi_ssid, ssid, sizeof(cfg_.wifi_ssid) - 1);
    }
    if (password != nullptr) {
      std::strncpy(cfg_.wifi_password, password,
                   sizeof(cfg_.wifi_password) - 1);
    }
  }

  int writes_ = 0;
  std::string saved_ssid_;
  std::string saved_password_;

 private:
  PersistedConfig cfg_;
};

// Outcome of the host-side reproduction of the POST /api/wifi pipeline.
struct PostResult {
  WifiJsonResult parse;  // body-parse result
  bool parsed;           // true iff parse == Ok
  bool saved;            // true iff saveCreds() accepted + persisted
};

// Reproduce HttpServer::handlePostWifi's parse->validate->persist sequence on
// the host. Buffers are sized exactly as the real handler sizes them.
PostResult postWifi(const char* body, WiFiManager& mgr) {
  char ssid[WIFI_SSID_MAX_LEN + 1] = {0};
  char pw[WIFI_PASSWORD_MAX_LEN + 1] = {0};
  const WifiJsonResult pr =
      parseWifiJson(body, ssid, sizeof(ssid), pw, sizeof(pw));
  if (pr != WifiJsonResult::Ok) {
    return {pr, false, false};
  }
  const bool saved = mgr.saveCreds(ssid, pw);
  return {pr, true, saved};
}

}  // namespace

// ---------------------------------------------------------------------------
// Happy path: valid body -> saveCreds called -> persisted (Req 1.4, 1.5)
// ---------------------------------------------------------------------------

TEST_CASE("POST /api/wifi persists valid credentials via saveCreds",
          "[wifi][setup][flow]") {
  FakeNVM nvm;
  WiFiManager mgr(nvm);

  const PostResult r =
      postWifi(R"({"ssid":"home-net","password":"hunter22!"})", mgr);

  REQUIRE(r.parsed);
  REQUIRE(r.saved);
  REQUIRE(nvm.writes_ == 1);
  REQUIRE(nvm.saved_ssid_ == "home-net");
  REQUIRE(nvm.saved_password_ == "hunter22!");
  // saveCreds restarts the STA association (Req 1.5).
  REQUIRE(mgr.mode() == WiFiManager::Mode::ConnectingSta);
}

// ---------------------------------------------------------------------------
// Empty SSID is rejected (Req 1.4)
// ---------------------------------------------------------------------------

TEST_CASE("POST /api/wifi rejects an empty SSID without persisting",
          "[wifi][setup][flow]") {
  FakeNVM nvm;
  WiFiManager mgr(nvm);

  // The body is well-formed JSON with an empty ssid string. parseWifiJson
  // accepts it (capacity is fine); saveCreds rejects it on the length bound.
  const PostResult r =
      postWifi(R"({"ssid":"","password":"hunter22!"})", mgr);

  REQUIRE(r.parse == WifiJsonResult::Ok);
  REQUIRE(r.parsed);
  REQUIRE_FALSE(r.saved);
  REQUIRE(nvm.writes_ == 0);
  REQUIRE(nvm.saved_ssid_.empty());
}

// ---------------------------------------------------------------------------
// Short password is rejected (Req 1.4)
// ---------------------------------------------------------------------------

TEST_CASE("POST /api/wifi rejects a password shorter than 8 chars",
          "[wifi][setup][flow]") {
  FakeNVM nvm;
  WiFiManager mgr(nvm);

  const PostResult r =
      postWifi(R"({"ssid":"home-net","password":"short"})", mgr);

  REQUIRE(r.parse == WifiJsonResult::Ok);
  REQUIRE(r.parsed);
  REQUIRE_FALSE(r.saved);
  REQUIRE(nvm.writes_ == 0);
  REQUIRE(nvm.saved_password_.empty());
}

// ---------------------------------------------------------------------------
// A malformed / missing-field body never reaches saveCreds
// ---------------------------------------------------------------------------

TEST_CASE("POST /api/wifi rejects a body missing the password field",
          "[wifi][setup][flow]") {
  FakeNVM nvm;
  WiFiManager mgr(nvm);

  const PostResult r = postWifi(R"({"ssid":"home-net"})", mgr);

  REQUIRE(r.parse == WifiJsonResult::MissingPassword);
  REQUIRE_FALSE(r.parsed);
  REQUIRE_FALSE(r.saved);
  REQUIRE(nvm.writes_ == 0);
}

TEST_CASE("POST /api/wifi rejects a malformed (non-object) body",
          "[wifi][setup][flow]") {
  FakeNVM nvm;
  WiFiManager mgr(nvm);

  const PostResult r = postWifi(R"(["ssid","password"])", mgr);

  REQUIRE(r.parse == WifiJsonResult::Malformed);
  REQUIRE_FALSE(r.saved);
  REQUIRE(nvm.writes_ == 0);
}

// ---------------------------------------------------------------------------
// Boundary credentials at the inclusive 32 / 63 upper bounds are accepted.
// ---------------------------------------------------------------------------

TEST_CASE("POST /api/wifi accepts credentials at the 32/63 length bounds",
          "[wifi][setup][flow]") {
  FakeNVM nvm;
  WiFiManager mgr(nvm);

  const std::string ssid32(WIFI_SSID_MAX_LEN, 's');       // exactly 32
  const std::string pw63(WIFI_PASSWORD_MAX_LEN, 'p');     // exactly 63
  const std::string body =
      std::string(R"({"ssid":")") + ssid32 + R"(","password":")" + pw63 +
      R"("})";

  const PostResult r = postWifi(body.c_str(), mgr);

  REQUIRE(r.parsed);
  REQUIRE(r.saved);
  REQUIRE(nvm.saved_ssid_ == ssid32);
  REQUIRE(nvm.saved_password_ == pw63);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
