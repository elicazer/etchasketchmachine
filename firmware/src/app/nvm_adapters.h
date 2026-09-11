// NVM interface adapters (Task 8.1).
//
// Several firmware modules talk to the persistence layer through their own
// narrow, single-purpose interfaces rather than the concrete NVMManager, so
// they can be unit-tested in isolation with in-memory fakes:
//
//   * wifi::INVMManager        - WiFiManager (get + setWifiCredentials)
//   * motion::IMotionNvm       - MotionPlanner (mutate + flushIfDue)
//   * backlash::IBacklashStore - BacklashCompensator (get + mutate)
//   * http::ICalibrationState  - HttpServer (isCalibrated)
//
// NVMManager already exposes get() / mutate() / flushIfDue() with matching
// signatures, but it does not inherit any of those interfaces. These tiny
// stateless adapters wrap a single NVMManager& and forward each interface
// onto it, so the main-loop wiring (etchasketch.ino) can hand each module the
// facade it expects while keeping a single source of truth in EEPROM.
//
// The adapters are deliberately Arduino-include-free (pure forwarding over the
// equally Arduino-free module headers + NVMManager), so this header compiles
// under `platform = native` as well as the UNO R4 WiFi target. See Design
// §3.2.1 / §3.2.5 / §3.2.6 / §3.2.7 for the interface rationale.

#pragma once

#include <cstddef>
#include <functional>

#include "../backlash/backlash_compensator.h"  // backlash::IBacklashStore
#include "../http/http_server.h"                // http::ICalibrationState
#include "../motion/motion_planner.h"           // motion::IMotionNvm
#include "../nvm/nvm_manager.h"                  // nvm::NVMManager
#include "../types.h"
#include "../wifi/wifi_manager.h"                // wifi::INVMManager

namespace etch {
namespace app {

// --- WiFiManager facade ----------------------------------------------------
class WifiNvmAdapter : public wifi::INVMManager {
 public:
  explicit WifiNvmAdapter(nvm::NVMManager& nvm) : nvm_(nvm) {}

  const PersistedConfig& get() const override { return nvm_.get(); }

  void setWifiCredentials(const char* ssid, const char* password) override {
    nvm_.mutate([ssid, password](PersistedConfig& cfg) {
      copyBounded(cfg.wifi_ssid, sizeof(cfg.wifi_ssid), ssid);
      copyBounded(cfg.wifi_password, sizeof(cfg.wifi_password), password);
    });
  }

 private:
  // NUL-terminated bounded copy: copies at most cap-1 chars and always
  // terminates. A null source clears the field.
  static void copyBounded(char* dst, std::size_t cap, const char* src) {
    if (cap == 0) return;
    std::size_t i = 0;
    if (src != nullptr) {
      for (; i + 1 < cap && src[i] != '\0'; ++i) {
        dst[i] = src[i];
      }
    }
    dst[i] = '\0';
  }

  nvm::NVMManager& nvm_;
};

// --- MotionPlanner facade --------------------------------------------------
class MotionNvmAdapter : public motion::IMotionNvm {
 public:
  explicit MotionNvmAdapter(nvm::NVMManager& nvm) : nvm_(nvm) {}

  void mutate(std::function<void(PersistedConfig&)> fn) override {
    nvm_.mutate(std::move(fn));
  }
  void flushIfDue() override { nvm_.flushIfDue(); }

 private:
  nvm::NVMManager& nvm_;
};

// --- BacklashCompensator facade --------------------------------------------
class BacklashNvmAdapter : public backlash::IBacklashStore {
 public:
  explicit BacklashNvmAdapter(nvm::NVMManager& nvm) : nvm_(nvm) {}

  const PersistedConfig& get() const override { return nvm_.get(); }
  void mutate(std::function<void(PersistedConfig&)> fn) override {
    nvm_.mutate(std::move(fn));
  }

 private:
  nvm::NVMManager& nvm_;
};

// --- HttpServer calibration facade -----------------------------------------
class CalibrationStateAdapter : public http::ICalibrationState {
 public:
  explicit CalibrationStateAdapter(nvm::NVMManager& nvm) : nvm_(nvm) {}

  bool isCalibrated() const override {
    return (nvm_.get().flags & NVM_FLAG_CALIBRATED) != 0;
  }

 private:
  nvm::NVMManager& nvm_;
};

}  // namespace app
}  // namespace etch
