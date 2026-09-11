// CRC-16/CCITT (CCITT-FALSE) implementation.
//
// See crc16.h for the algorithm parameters. The bit-by-bit form is used here
// rather than a 256-entry lookup table to keep code size minimal — the
// firmware only validates fixed-size 14-byte Drawing_Command payloads
// (Design §4.3), so the per-call cost (≈112 iterations) is negligible.

#include "crc16.h"

namespace etch {
namespace protocol {

uint16_t crc16_ccitt(const uint8_t* data, size_t len) {
  uint16_t crc = 0xFFFF;
  if (data == nullptr) {
    return crc;
  }
  for (size_t i = 0; i < len; ++i) {
    crc ^= static_cast<uint16_t>(data[i]) << 8;
    for (uint8_t bit = 0; bit < 8; ++bit) {
      if (crc & 0x8000) {
        crc = static_cast<uint16_t>((crc << 1) ^ 0x1021);
      } else {
        crc = static_cast<uint16_t>(crc << 1);
      }
    }
  }
  return crc;
}

}  // namespace protocol
}  // namespace etch
