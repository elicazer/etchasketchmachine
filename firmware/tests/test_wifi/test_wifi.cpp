// Host-side unit tests for the WiFiManager helpers (Task 3.1).
//
// Validates the two host-testable surfaces called out in the task:
//   * Credential validation (SSID 1..32 chars, password 8..63 chars,
//     Requirement 1.4).
//   * AP-mode SSID derivation: "EtchSketch_<MAC4>" with the last 4 hex
//     characters in uppercase (Requirement 1.3).
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment in platformio.ini is configured with
// `test_build_src = no`, so this translation unit pulls the implementation
// in directly via relative include to keep the binary self-contained.

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_session.hpp>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

// Pull the WiFiManager header + the helper implementation in directly. We
// only need the helpers and the construction surface; the network methods
// in wifi_manager.cpp are guarded by `#if defined(ARDUINO)` so this stays
// host-friendly.
#include "../../src/wifi/wifi_manager.h"
#include "../../src/wifi/wifi_manager.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::PersistedConfig;
using etch::wifi::AP_SSID_BUF_LEN;
using etch::wifi::AP_SSID_LEN;
using etch::wifi::INVMManager;
using etch::wifi::WiFiManager;
using etch::wifi::isValidPassword;
using etch::wifi::isValidSsid;
using etch::wifi::makeApSsid;

namespace {

// Tiny in-memory NVM stand-in for the WiFiManager construction tests. The
// real implementation lives in firmware/src/nvm/ and is built in task 2.1.
class FakeNVM : public INVMManager {
 public:
  FakeNVM() {
    std::memset(&cfg_, 0, sizeof(cfg_));
    cfg_.magic = etch::NVM_MAGIC;
    cfg_.version = etch::NVM_VERSION;
    cfg_.mm_per_rev_x = etch::DEFAULT_MM_PER_REV;
    cfg_.mm_per_rev_y = etch::DEFAULT_MM_PER_REV;
  }

  const PersistedConfig& get() const override { return cfg_; }

  void setWifiCredentials(const char* ssid, const char* password) override {
    saved_ssid_ = ssid ? ssid : "";
    saved_password_ = password ? password : "";
    // Mirror what the real NVMManager will do: copy into the record buffers.
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

  std::string saved_ssid_;
  std::string saved_password_;

 private:
  PersistedConfig cfg_;
};

// Builds a NUL-terminated string of length `n` filled with `ch`. Useful for
// boundary tests where we care only about length.
std::string repeated(std::size_t n, char ch = 'a') {
  return std::string(n, ch);
}

}  // namespace

// ---------------------------------------------------------------------------
// makeApSsid -> "EtchSketch_<last 4 hex of MAC, uppercase>"
// ---------------------------------------------------------------------------

TEST_CASE("makeApSsid produces 'EtchSketch_' + last 4 hex chars uppercase",
          "[wifi][ap-ssid]") {
  // Canonical example from the task description.
  const std::uint8_t mac[6] = {0xDE, 0xAD, 0xBE, 0xEF, 0xAB, 0xCD};
  char buf[AP_SSID_BUF_LEN] = {0};

  const std::size_t n = makeApSsid(mac, buf, sizeof(buf));
  REQUIRE(n == AP_SSID_LEN);
  REQUIRE(std::string(buf) == "EtchSketch_ABCD");
}

TEST_CASE("makeApSsid uppercases hex digits a..f", "[wifi][ap-ssid]") {
  const std::uint8_t mac[6] = {0x00, 0x00, 0x00, 0x00, 0x0a, 0xfe};
  char buf[AP_SSID_BUF_LEN] = {0};
  REQUIRE(makeApSsid(mac, buf, sizeof(buf)) == AP_SSID_LEN);
  // 0x0A -> "0A", 0xFE -> "FE"; the last 4 hex chars are "0AFE".
  REQUIRE(std::string(buf) == "EtchSketch_0AFE");
}

TEST_CASE("makeApSsid pads single-digit hex with leading zero",
          "[wifi][ap-ssid]") {
  const std::uint8_t mac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x02};
  char buf[AP_SSID_BUF_LEN] = {0};
  REQUIRE(makeApSsid(mac, buf, sizeof(buf)) == AP_SSID_LEN);
  REQUIRE(std::string(buf) == "EtchSketch_0102");
}

TEST_CASE("makeApSsid uses only the last two MAC octets", "[wifi][ap-ssid]") {
  // mac[0..3] should not affect the output.
  const std::uint8_t a[6] = {0x11, 0x22, 0x33, 0x44, 0xAA, 0xBB};
  const std::uint8_t b[6] = {0xFE, 0xDC, 0xBA, 0x98, 0xAA, 0xBB};
  char buf_a[AP_SSID_BUF_LEN] = {0};
  char buf_b[AP_SSID_BUF_LEN] = {0};
  makeApSsid(a, buf_a, sizeof(buf_a));
  makeApSsid(b, buf_b, sizeof(buf_b));
  REQUIRE(std::string(buf_a) == std::string(buf_b));
  REQUIRE(std::string(buf_a) == "EtchSketch_AABB");
}

TEST_CASE("makeApSsid rejects undersized buffers and null pointers",
          "[wifi][ap-ssid]") {
  const std::uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
  char small[8] = {0};
  REQUIRE(makeApSsid(mac, small, sizeof(small)) == 0u);
  // Buffer length one short of AP_SSID_BUF_LEN must also be rejected so we
  // can never write past the trailing NUL.
  char almost[AP_SSID_BUF_LEN - 1] = {0};
  REQUIRE(makeApSsid(mac, almost, sizeof(almost)) == 0u);
  // Null output buffer.
  REQUIRE(makeApSsid(mac, nullptr, AP_SSID_BUF_LEN) == 0u);
}

TEST_CASE("makeApSsid output is exactly 15 chars (prefix + 4 hex)",
          "[wifi][ap-ssid]") {
  const std::uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
  char buf[AP_SSID_BUF_LEN] = {0};
  REQUIRE(makeApSsid(mac, buf, sizeof(buf)) == 15u);
  REQUIRE(std::strlen(buf) == 15u);
}

// ---------------------------------------------------------------------------
// SSID validation (Requirement 1.4: 1..32 chars)
// ---------------------------------------------------------------------------

TEST_CASE("isValidSsid accepts 1..32 character strings", "[wifi][validate]") {
  REQUIRE(isValidSsid("a"));                        // length 1 (lower bound)
  REQUIRE(isValidSsid("home-network"));             // typical
  REQUIRE(isValidSsid(repeated(32).c_str()));       // length 32 (upper bound)
}

TEST_CASE("isValidSsid rejects empty, oversize, and null inputs",
          "[wifi][validate]") {
  REQUIRE_FALSE(isValidSsid(""));                   // length 0
  REQUIRE_FALSE(isValidSsid(repeated(33).c_str())); // length 33
  REQUIRE_FALSE(isValidSsid(repeated(64).c_str())); // far oversize
  REQUIRE_FALSE(isValidSsid(nullptr));
}

// ---------------------------------------------------------------------------
// Password validation (Requirement 1.4: 8..63 chars)
// ---------------------------------------------------------------------------

TEST_CASE("isValidPassword accepts 8..63 character strings",
          "[wifi][validate]") {
  REQUIRE(isValidPassword(repeated(8).c_str()));    // lower bound
  REQUIRE(isValidPassword("hunter22-correct"));     // typical
  REQUIRE(isValidPassword(repeated(63).c_str()));   // upper bound
}

TEST_CASE("isValidPassword rejects too-short, too-long, and null inputs",
          "[wifi][validate]") {
  REQUIRE_FALSE(isValidPassword(""));               // length 0
  REQUIRE_FALSE(isValidPassword(repeated(7).c_str())); // 1 short of min
  REQUIRE_FALSE(isValidPassword(repeated(64).c_str())); // 1 over max
  REQUIRE_FALSE(isValidPassword(nullptr));
}

// ---------------------------------------------------------------------------
// saveCreds() integrates validation with the NVM facade
// ---------------------------------------------------------------------------

TEST_CASE("saveCreds persists valid credentials via the NVM facade",
          "[wifi][savecreds]") {
  FakeNVM nvm;
  WiFiManager mgr(nvm);

  REQUIRE(mgr.saveCreds("home-network", "hunter22-correct"));
  REQUIRE(nvm.saved_ssid_ == "home-network");
  REQUIRE(nvm.saved_password_ == "hunter22-correct");
}

TEST_CASE("saveCreds rejects invalid inputs without touching NVM",
          "[wifi][savecreds]") {
  FakeNVM nvm;
  WiFiManager mgr(nvm);

  // SSID too long.
  REQUIRE_FALSE(mgr.saveCreds(repeated(33).c_str(), "valid-pass-1"));
  REQUIRE(nvm.saved_ssid_.empty());
  REQUIRE(nvm.saved_password_.empty());

  // Password too short.
  REQUIRE_FALSE(mgr.saveCreds("home", "short"));
  REQUIRE(nvm.saved_ssid_.empty());
  REQUIRE(nvm.saved_password_.empty());

  // Empty SSID.
  REQUIRE_FALSE(mgr.saveCreds("", repeated(8).c_str()));
  REQUIRE(nvm.saved_ssid_.empty());

  // Null inputs.
  REQUIRE_FALSE(mgr.saveCreds(nullptr, "valid-pass-1"));
  REQUIRE_FALSE(mgr.saveCreds("home", nullptr));
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
