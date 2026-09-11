// Arduino-side EEPROM emulation backend for NVMManager.
//
// On the UNO R4 WiFi (Renesas RA4M1), the bundled `EEPROM` library exposes an
// 8 KB byte-addressable, wear-levelled view of the data flash (Design §2.4.3).
// This backend simply maps NVMBackend's read/write contract onto that view.
//
// The translation unit that defines the implementation is compiled only on
// the Arduino target; on `platform = native` host tests (the UNIT_TEST_HOST
// build flag), it is excluded so the Arduino headers don't need to be
// available. See nvm_arduino_backend.cpp for the gating.

#pragma once

#include "nvm_manager.h"

namespace etch {
namespace nvm {

class ArduinoEEPROMBackend : public NVMBackend {
 public:
  // Reads NVM_RECORD_SIZE bytes from EEPROM offset NVM_RECORD_OFFSET.
  void readRecord(std::uint8_t* out, std::size_t len) override;

  // Writes NVM_RECORD_SIZE bytes back, byte-by-byte. The Arduino EEPROM
  // library skips writes that would not change the stored byte, which gives
  // us partial wear avoidance without any explicit cache.
  void writeRecord(const std::uint8_t* in, std::size_t len) override;
};

}  // namespace nvm
}  // namespace etch
