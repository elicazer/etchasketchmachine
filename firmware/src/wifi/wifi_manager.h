// WiFi connection manager for the Etch-a-Sketch Drawing Machine.
//
// Owns the STA -> AP fallback state machine, mDNS registration, credential
// validation, and persistence delegation. The class is intentionally backed
// by a thin `INVMManager` interface (not a concrete NVMManager) so the WiFi
// layer can be developed and tested independently of the EEPROM-backed
// implementation in firmware/src/nvm/, and so host tests can plug in a
// minimal in-memory fake.
//
// This header is Arduino-include-free. The implementation file is the only
// place that pulls in <WiFi.h> / <WiFiUdp.h>, behind `#if defined(ARDUINO)`
// guards, so the rest of the firmware (and the host-side Catch2 tests) can
// drag this header in under `platform=native` without trying to resolve the
// WiFiS3 library.
//
// References:
//   - Requirements 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 12.2
//   - Design §3.2.1 (WiFiManager surface), §6.2 (WiFi loss recovery)

#pragma once

#include <cstddef>
#include <cstdint>

#include "../types.h"  // etch::PersistedConfig (Design §4.4)

namespace etch {
namespace wifi {

// ---------------------------------------------------------------------------
// Credential and AP-SSID limits (Requirements 1.3, 1.4)
// ---------------------------------------------------------------------------

// Inclusive credential length envelopes per Req 1.4.
inline constexpr std::size_t WIFI_SSID_MIN_LEN     = 1;
inline constexpr std::size_t WIFI_SSID_MAX_LEN     = 32;
inline constexpr std::size_t WIFI_PASSWORD_MIN_LEN = 8;
inline constexpr std::size_t WIFI_PASSWORD_MAX_LEN = 63;

// AP-mode SSID is exactly "EtchSketch_" + last 4 hex chars of MAC, uppercase.
// Example: MAC ending 0xAB,0xCD -> "EtchSketch_ABCD" (Requirement 1.3).
inline constexpr char        AP_SSID_PREFIX[]    = "EtchSketch_";
inline constexpr std::size_t AP_SSID_PREFIX_LEN  = 11;     // strlen("EtchSketch_")
inline constexpr std::size_t AP_SSID_MAC_HEX_LEN = 4;      // last 4 hex chars
inline constexpr std::size_t AP_SSID_LEN         =
    AP_SSID_PREFIX_LEN + AP_SSID_MAC_HEX_LEN;              // 15
inline constexpr std::size_t AP_SSID_BUF_LEN     = AP_SSID_LEN + 1;  // +NUL

// mDNS hostname (Requirement 1.7). The trailing ".local" is added by the
// mDNS responder.
inline constexpr const char* MDNS_HOSTNAME = "etchasketch";

// ---------------------------------------------------------------------------
// State-machine timing budgets (Requirements 1.1, 1.3, 1.6)
// ---------------------------------------------------------------------------

// STA association timeout before falling back to AP mode (Req 1.3, Req 1.6).
inline constexpr std::uint32_t STA_CONNECT_TIMEOUT_MS = 30000;

// Polling interval for the supervise() state machine on each main-loop tick.
// Keeps WiFi.status() polling cheap without starving the rest of the loop.
inline constexpr std::uint32_t STA_POLL_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// NVM facade
// ---------------------------------------------------------------------------

// Minimum interface WiFiManager needs from the NVM layer. The concrete
// `NVMManager` (firmware/src/nvm/, task 2.1) implements this interface; host
// tests plug in a simple in-memory fake. Keeping this interface narrow means
// the WiFi state machine never reads or writes EEPROM directly.
class INVMManager {
 public:
  virtual ~INVMManager() = default;

  // Returns the cached PersistedConfig record. The reference must remain
  // valid for the lifetime of the manager.
  virtual const PersistedConfig& get() const = 0;

  // Stores `ssid` and `password` (both null-terminated) into the persisted
  // record. Implementations must copy the strings into the record buffers
  // (max WIFI_SSID_MAX_LEN / WIFI_PASSWORD_MAX_LEN respectively, plus NUL)
  // and arrange for the next debounced flush to commit the change to NVM.
  // Callers must validate the inputs first (see isValidSsid / isValidPassword).
  virtual void setWifiCredentials(const char* ssid, const char* password) = 0;
};

// ---------------------------------------------------------------------------
// Host-testable free helpers
// ---------------------------------------------------------------------------

// Writes "EtchSketch_<MAC4>" into `out`, where <MAC4> is the last four hex
// digits of the MAC (i.e. uppercase hex of mac[4] and mac[5]). Returns the
// number of characters written excluding the trailing NUL on success, or 0
// if `out` is null or `out_len < AP_SSID_BUF_LEN`. Validates Requirement 1.3.
std::size_t makeApSsid(const std::uint8_t mac[6], char* out, std::size_t out_len);

// True iff `ssid` is non-null, null-terminated within WIFI_SSID_MAX_LEN+1
// bytes, and its length lies in [WIFI_SSID_MIN_LEN, WIFI_SSID_MAX_LEN].
// Validates Requirement 1.4 (SSID length 1..32 chars).
bool isValidSsid(const char* ssid);

// True iff `password` is non-null, null-terminated within
// WIFI_PASSWORD_MAX_LEN+1 bytes, and its length lies in
// [WIFI_PASSWORD_MIN_LEN, WIFI_PASSWORD_MAX_LEN]. Validates Requirement 1.4
// (password length 8..63 chars).
bool isValidPassword(const char* password);

// ---------------------------------------------------------------------------
// WiFiManager
// ---------------------------------------------------------------------------

// Owns the STA/AP/mDNS lifecycle. Public surface mirrors Design §3.2.1
// verbatim. The implementation is split: helpers above are always-on; the
// network methods below are real Arduino code under `#if defined(ARDUINO)`
// and reduce to deterministic stubs on the host (so tests can exercise the
// helpers without dragging in WiFiS3).
class WiFiManager {
 public:
  // Coarse mode tracking exposed for diagnostics and tests.
  enum class Mode : std::uint8_t {
    Disconnected,    // pre-begin() or after an unrecoverable failure
    ConnectingSta,   // STA association in progress (within timeout window)
    Sta,             // STA associated, IP acquired
    Ap,              // AP fallback active
  };

  explicit WiFiManager(INVMManager& nvm);

  // STA attempt against the credentials in NVM. If creds are missing or
  // invalid we go straight to AP fallback. Must be called from setup() so
  // that Req 1.1 ("connection attempt within 10 s of boot") is satisfied
  // by the firmware's main initialization sequence.
  void begin();

  // True iff currently associated to STA with an IP. Cheap; can be called
  // every loop iteration.
  bool isSTAConnected();

  // Force-enter AP mode. Used by begin() / supervise() on STA timeout
  // (Requirements 1.3, 1.6) and may be called manually for diagnostics.
  // Sets the AP SSID to `EtchSketch_<MAC4>`.
  void enterAP();

  // Register the mDNS hostname `etchasketch.local` (Requirement 1.7).
  // Idempotent: subsequent calls re-register only if the network came back
  // up after a drop.
  void registerMDNS();

  // Validate, persist, and apply new STA credentials (Requirements 1.4, 1.5).
  // Returns false without touching NVM if either input fails validation.
  // On success the credentials are committed via the INVMManager and the
  // STA association is restarted; the resulting transition is observable
  // through subsequent supervise() calls.
  bool saveCreds(const char* ssid, const char* pw);

  // Current STA RSSI in dBm (Requirement 12.2). Returns 0 on host or when
  // not associated; callers should gate on isSTAConnected() if they want
  // to distinguish "no signal yet" from "0 dBm" (which never occurs in
  // practice for real WiFi hardware).
  std::int8_t rssiDbm();

  // Cooperative tick. Drives reconnect attempts, the 30 s STA timeout,
  // AP fallback on link loss (Requirement 1.6), and lazy mDNS
  // re-registration after a reconnect. Cheap to call every main-loop pass.
  void supervise();

  // Diagnostic accessors.
  Mode mode() const { return mode_; }
  const char* apSsid() const { return ap_ssid_; }

 private:
  INVMManager& nvm_;
  Mode mode_ = Mode::Disconnected;

  // State-machine timestamps in millis() (Arduino) / 0 (host).
  std::uint32_t connect_started_ms_ = 0;
  std::uint32_t last_poll_ms_       = 0;

  // mDNS registration is sticky across STA disconnect/reconnect cycles, but
  // we re-issue the registration call on every fresh STA acquisition.
  bool mdns_registered_ = false;

  // Cached AP SSID derived once at begin() / enterAP() so we can return a
  // stable pointer from apSsid() without recomputing.
  char ap_ssid_[AP_SSID_BUF_LEN] = {0};

  // Internal helpers split by build mode. The .cpp guards the bodies.
  void startStaAssociation();   // arduino-only (host: no-op)
  void cacheApSsidFromMac();    // always-on; uses platform mac()
  void readMacAddress(std::uint8_t mac[6]);  // arduino: WiFi.macAddress; host: zeros
};

}  // namespace wifi
}  // namespace etch
