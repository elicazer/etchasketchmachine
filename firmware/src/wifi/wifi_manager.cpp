// WiFiManager implementation. See wifi_manager.h for design notes.
//
// The module is split into three layers:
//
//   1. Always-on helpers (validation + AP-SSID derivation). Pure C++ that
//      compiles under both `framework = arduino` and `platform = native`.
//      These are exercised by firmware/tests/test_wifi/test_wifi.cpp on the
//      host (Catch2).
//
//   2. The WiFiManager state machine. Compiles everywhere; under `ARDUINO`
//      it drives the WiFiS3 / WiFiUdp APIs, under host builds the same
//      transitions run with stubbed network calls so tests can still link
//      against the class without dragging the radio library into the host
//      compiler.
//
//   3. Real radio calls, all behind `#if defined(ARDUINO)` guards. Anything
//      that would require <WiFi.h> on the host stays inside these guards.

#include "wifi_manager.h"

#include <cstring>

#if defined(ARDUINO)
// On UNO R4 WiFi, <WiFi.h> is the umbrella header that resolves to the
// WiFiS3 implementation in the renesas-ra Arduino core. <WiFiUdp.h> backs a
// future minimal mDNS responder; we reserve a slot here so it is part of
// the link surface from day one.
#  include <Arduino.h>
#  include <WiFi.h>
#  include <WiFiUdp.h>
#endif

namespace etch {
namespace wifi {

namespace {

// Uppercase hex nibble lookup. We do all hex formatting by hand because
// `String` and `printf` carry weight we do not need on a 32 KB SRAM target.
constexpr char kHexUpper[16] = {
    '0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F'};

// Bounded strnlen so we never walk off the end of a malformed input. We
// scan at most `max + 1` bytes (so a length of exactly `max` returns `max`,
// while a length of `max + 1` returns `max + 1` and is rejected by the
// callers as too long). The +1 lets the caller distinguish "exactly at the
// upper bound" from "no NUL within the allowed window".
std::size_t bounded_strnlen(const char* s, std::size_t max_plus_one) {
  if (s == nullptr) return 0;
  std::size_t n = 0;
  while (n < max_plus_one && s[n] != '\0') ++n;
  return n;
}

// Platform-conditional millisecond clock. On the host the clock is frozen
// at 0; the WiFiManager state machine never queries it on host builds
// because none of the time-sensitive transitions are exercised on host.
std::uint32_t now_ms() {
#if defined(ARDUINO)
  return millis();
#else
  return 0;
#endif
}

}  // namespace

// ---------------------------------------------------------------------------
// Free helpers (host-testable)
// ---------------------------------------------------------------------------

std::size_t makeApSsid(const std::uint8_t mac[6], char* out, std::size_t out_len) {
  // Requirement 1.3: AP SSID is the prefix "EtchSketch_" followed by the
  // last four hex characters of the MAC, uppercase. The "last four hex
  // characters" of the canonical aa:bb:cc:dd:ee:ff representation are the
  // hex digits of the final two MAC octets, i.e. mac[4] and mac[5].
  if (out == nullptr || out_len < AP_SSID_BUF_LEN) {
    return 0;
  }
  // Copy the literal prefix without the trailing NUL.
  std::memcpy(out, AP_SSID_PREFIX, AP_SSID_PREFIX_LEN);

  out[AP_SSID_PREFIX_LEN + 0] = kHexUpper[(mac[4] >> 4) & 0x0F];
  out[AP_SSID_PREFIX_LEN + 1] = kHexUpper[(mac[4]     ) & 0x0F];
  out[AP_SSID_PREFIX_LEN + 2] = kHexUpper[(mac[5] >> 4) & 0x0F];
  out[AP_SSID_PREFIX_LEN + 3] = kHexUpper[(mac[5]     ) & 0x0F];
  out[AP_SSID_LEN] = '\0';
  return AP_SSID_LEN;
}

bool isValidSsid(const char* ssid) {
  // Scan one byte past the inclusive max so we can distinguish "exactly 32"
  // from "33 or longer". Same trick for password validation below.
  const std::size_t n = bounded_strnlen(ssid, WIFI_SSID_MAX_LEN + 1);
  if (n == 0 && ssid == nullptr) return false;
  return n >= WIFI_SSID_MIN_LEN && n <= WIFI_SSID_MAX_LEN;
}

bool isValidPassword(const char* password) {
  const std::size_t n = bounded_strnlen(password, WIFI_PASSWORD_MAX_LEN + 1);
  if (password == nullptr) return false;
  return n >= WIFI_PASSWORD_MIN_LEN && n <= WIFI_PASSWORD_MAX_LEN;
}

// ---------------------------------------------------------------------------
// WiFiManager construction
// ---------------------------------------------------------------------------

WiFiManager::WiFiManager(INVMManager& nvm) : nvm_(nvm) {
  // Pre-fill the AP SSID with a deterministic placeholder. The real value
  // is computed in begin() / enterAP() once the radio reports its MAC, but
  // having a valid NUL-terminated string here keeps apSsid() safe to call
  // immediately after construction.
  const std::uint8_t kZeroMac[6] = {0, 0, 0, 0, 0, 0};
  makeApSsid(kZeroMac, ap_ssid_, sizeof(ap_ssid_));
}

// ---------------------------------------------------------------------------
// MAC retrieval (split per platform)
// ---------------------------------------------------------------------------

void WiFiManager::readMacAddress(std::uint8_t mac[6]) {
#if defined(ARDUINO)
  // WiFiS3 returns the MAC in reverse order for historical reasons; we
  // normalise to mac[0..5] = aa..ff (most-significant byte first) so the
  // SSID matches what users see on the back-of-the-board sticker.
  std::uint8_t raw[6] = {0, 0, 0, 0, 0, 0};
  WiFi.macAddress(raw);
  for (std::size_t i = 0; i < 6; ++i) {
    mac[i] = raw[5 - i];
  }
#else
  // Deterministic stub for host builds. Tests that exercise SSID derivation
  // pass an explicit MAC into the free helper directly, so this path is
  // never relied upon by the host suite.
  for (std::size_t i = 0; i < 6; ++i) mac[i] = 0;
#endif
}

void WiFiManager::cacheApSsidFromMac() {
  std::uint8_t mac[6];
  readMacAddress(mac);
  makeApSsid(mac, ap_ssid_, sizeof(ap_ssid_));
}

// ---------------------------------------------------------------------------
// Public surface (Design §3.2.1)
// ---------------------------------------------------------------------------

void WiFiManager::begin() {
  cacheApSsidFromMac();

  const PersistedConfig& cfg = nvm_.get();

  // If we have valid stored credentials, kick off STA association. The
  // 30-second timeout is enforced cooperatively by supervise() (Req 1.6).
  if (isValidSsid(cfg.wifi_ssid) && isValidPassword(cfg.wifi_password)) {
    mode_ = Mode::ConnectingSta;
    connect_started_ms_ = now_ms();
    last_poll_ms_ = connect_started_ms_;
    startStaAssociation();
  } else {
    // No usable creds yet: jump straight to the AP fallback so the user
    // can hit the captive config page on first boot (Req 1.3).
    enterAP();
  }
}

bool WiFiManager::isSTAConnected() {
#if defined(ARDUINO)
  return WiFi.status() == WL_CONNECTED;
#else
  return mode_ == Mode::Sta;
#endif
}

void WiFiManager::enterAP() {
  cacheApSsidFromMac();
  mode_ = Mode::Ap;
  mdns_registered_ = false;

#if defined(ARDUINO)
  // Bring down any in-progress STA association before flipping the radio.
  WiFi.disconnect();
  // beginAP returns the resulting status code; we ignore it because we have
  // no fallback beyond AP and a degraded AP is still surfaced to the user
  // through the diagnostics panel.
  WiFi.beginAP(ap_ssid_);
#endif
}

void WiFiManager::registerMDNS() {
  // The WiFiS3 stack on UNO R4 WiFi does not ship with a built-in mDNS
  // responder; the canonical wiring uses the ArduinoMDNS library. We keep
  // this method on the public surface (Design §3.2.1) and stage the work
  // here so the rest of the firmware (HTTP server, status reporter) can
  // call registerMDNS() unconditionally. The hostname is set via
  // WiFi.setHostname() so DHCP-advertised hostname matches the spec; the
  // ".local" multicast resolution is left as a TODO tracked alongside the
  // HTTP server work in task 3.2.
  if (!isSTAConnected()) {
    mdns_registered_ = false;
    return;
  }

#if defined(ARDUINO)
  WiFi.setHostname(MDNS_HOSTNAME);
#endif
  mdns_registered_ = true;
}

bool WiFiManager::saveCreds(const char* ssid, const char* pw) {
  // Requirement 1.4: SSID 1..32, password 8..63.
  if (!isValidSsid(ssid) || !isValidPassword(pw)) {
    return false;
  }

  // Persist via the NVM facade (Requirement 1.5). The implementation
  // debounces the actual flash write behind its own write-coalescing
  // policy (Design §3.2.7).
  nvm_.setWifiCredentials(ssid, pw);

  // Restart the connection process so the new creds take effect now
  // (Requirement 1.5: "...store the credentials in non-volatile memory
  // and restart the connection process"). We re-enter the connecting
  // state and let supervise() drive the timeout / fallback.
  mode_ = Mode::ConnectingSta;
  connect_started_ms_ = now_ms();
  last_poll_ms_ = connect_started_ms_;
  mdns_registered_ = false;

#if defined(ARDUINO)
  WiFi.disconnect();
#endif
  startStaAssociation();
  return true;
}

std::int8_t WiFiManager::rssiDbm() {
#if defined(ARDUINO)
  if (WiFi.status() != WL_CONNECTED) return 0;
  // WiFi.RSSI() returns a `long`; valid RSSI values fit comfortably into
  // an int8_t (-128..127 dBm) and we clamp defensively just in case the
  // radio returns an out-of-range value during a transient.
  long r = WiFi.RSSI();
  if (r > 127)  r = 127;
  if (r < -128) r = -128;
  return static_cast<std::int8_t>(r);
#else
  return 0;
#endif
}

void WiFiManager::supervise() {
  // Cooperative tick: cheap when nothing is changing.
  const std::uint32_t now = now_ms();
  if (now - last_poll_ms_ < STA_POLL_INTERVAL_MS) return;
  last_poll_ms_ = now;

  switch (mode_) {
    case Mode::Disconnected:
      // begin() has not been called yet, or saveCreds() decided neither
      // path was viable. Nothing to do until something kicks us back into
      // a connecting state.
      break;

    case Mode::ConnectingSta: {
      if (isSTAConnected()) {
        mode_ = Mode::Sta;
        registerMDNS();
        break;
      }
      // Requirements 1.3, 1.6: STA timeout -> AP fallback.
      if (now - connect_started_ms_ >= STA_CONNECT_TIMEOUT_MS) {
        enterAP();
      }
      break;
    }

    case Mode::Sta: {
      // Link-loss detection: if we drop association, swing back into the
      // 30 s reconnect window and fall through to AP if it expires
      // (Requirement 1.6).
      if (!isSTAConnected()) {
        mode_ = Mode::ConnectingSta;
        connect_started_ms_ = now;
        mdns_registered_ = false;
        startStaAssociation();
      } else if (!mdns_registered_) {
        // Re-register mDNS opportunistically in case the responder dropped.
        registerMDNS();
      }
      break;
    }

    case Mode::Ap:
      // AP mode is terminal until the user submits new creds via
      // saveCreds() or the firmware is rebooted.
      break;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

void WiFiManager::startStaAssociation() {
#if defined(ARDUINO)
  const PersistedConfig& cfg = nvm_.get();
  // WiFiS3's WiFi.begin() is non-blocking on UNO R4 WiFi: status() returns
  // WL_IDLE_STATUS / WL_CONNECTING / WL_CONNECTED as the association
  // progresses. We rely on supervise() to poll for the result.
  WiFi.begin(cfg.wifi_ssid, cfg.wifi_password);
#else
  // Host build: nothing to do. The state machine keeps mode_ at
  // ConnectingSta until a test explicitly transitions it.
#endif
}

}  // namespace wifi
}  // namespace etch
