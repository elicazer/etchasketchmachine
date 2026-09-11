// CRC-16/CCITT (a.k.a. CRC-16/CCITT-FALSE) shared utility for the firmware.
//
// Algorithm (matches the web-side implementation in web/src/codec/crc16.ts):
//   Polynomial : 0x1021
//   Initial    : 0xFFFF
//   RefIn      : false (input bytes are not bit-reversed)
//   RefOut     : false
//   XorOut     : 0x0000 (no final XOR)
//
// Canonical check value: crc16_ccitt("123456789", 9) == 0x29B1.
//
// Used by the protocol layer (Design §4.3, §4.5) to validate Drawing_Command
// payloads and detect on-the-wire corruption (Requirements 7.2, 7.3, 6.7).

#pragma once

#include <stddef.h>
#include <stdint.h>

namespace etch {
namespace protocol {

// Compute CRC-16/CCITT (CCITT-FALSE variant) over `len` bytes of `data`.
// `data` may be nullptr only if `len == 0`.
uint16_t crc16_ccitt(const uint8_t* data, size_t len);

}  // namespace protocol
}  // namespace etch
