// Arduino EEPROM-emulation backend. See nvm_arduino_backend.h.
//
// Excluded from the host (`platform = native`, UNIT_TEST_HOST) build so
// Arduino-only headers like <EEPROM.h> are not required there.

#if !defined(UNIT_TEST_HOST)

#include "nvm_arduino_backend.h"

#include <EEPROM.h>

#include "../types.h"

namespace etch {
namespace nvm {

void ArduinoEEPROMBackend::readRecord(std::uint8_t* out, std::size_t len) {
  for (std::size_t i = 0; i < len; ++i) {
    out[i] = EEPROM.read(static_cast<int>(NVM_RECORD_OFFSET + i));
  }
}

void ArduinoEEPROMBackend::writeRecord(const std::uint8_t* in, std::size_t len) {
  // EEPROM.update() avoids a write cycle when the byte is unchanged, which
  // limits per-byte wear without us having to diff explicitly.
  for (std::size_t i = 0; i < len; ++i) {
    EEPROM.update(static_cast<int>(NVM_RECORD_OFFSET + i), in[i]);
  }
}

}  // namespace nvm
}  // namespace etch

#endif  // !UNIT_TEST_HOST
