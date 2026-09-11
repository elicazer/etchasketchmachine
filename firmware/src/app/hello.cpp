// HELLO frame payload serialiser implementation (Design §4.8). See hello.h for
// the full byte-layout contract and the host/web cross-check rationale.
//
// This translation unit is intentionally Arduino-include-free: it only emits
// the 40-byte little-endian §4.8 payload. The §4.5 envelope is added by the
// caller (app::Controller::sendHello()). Every multi-byte integer field is
// written with explicit shifts so the result is endianness-independent, and
// the two f32 fields are emitted little-endian (matching the web decoder's
// DataView.setFloat32(.., true) in web/src/codec/frame.ts / wire_client.ts).

#include "hello.h"

#include <cstring>  // std::memcpy

namespace etch {
namespace app {

namespace {

// Write a little-endian u16 at out[pos..pos+2).
inline void putU16(std::uint8_t* out, std::size_t pos, std::uint16_t v) {
  out[pos]     = static_cast<std::uint8_t>(v & 0xFF);
  out[pos + 1] = static_cast<std::uint8_t>((v >> 8) & 0xFF);
}

// Write a little-endian u32 at out[pos..pos+4).
inline void putU32(std::uint8_t* out, std::size_t pos, std::uint32_t v) {
  out[pos]     = static_cast<std::uint8_t>(v & 0xFF);
  out[pos + 1] = static_cast<std::uint8_t>((v >> 8) & 0xFF);
  out[pos + 2] = static_cast<std::uint8_t>((v >> 16) & 0xFF);
  out[pos + 3] = static_cast<std::uint8_t>((v >> 24) & 0xFF);
}

// Write a little-endian i32 (two's complement bit pattern) at out[pos..pos+4).
inline void putI32(std::uint8_t* out, std::size_t pos, std::int32_t v) {
  putU32(out, pos, static_cast<std::uint32_t>(v));
}

// Write an IEEE-754 binary32 little-endian at out[pos..pos+4). The bit pattern
// is reinterpreted through a u32 so the byte order is explicit regardless of
// host endianness.
inline void putF32(std::uint8_t* out, std::size_t pos, float v) {
  std::uint32_t bits = 0;
  std::memcpy(&bits, &v, sizeof(bits));
  putU32(out, pos, bits);
}

}  // namespace

std::size_t serializeHello(const HelloFields& f, std::uint8_t* out,
                           std::size_t cap) {
  if (out == nullptr || cap < HELLO_PAYLOAD_SIZE) {
    return 0;
  }

  putU32(out, 0, f.firmware_version);   //  0  u32  firmware_version
  putU16(out, 4, f.max_sps);            //  4  u16  max_sps
  putU16(out, 6, 0);                    //  6  u16  reserved
  putU16(out, 8, f.backlash_x);         //  8  u16  backlash_x
  putU16(out, 10, f.backlash_y);        // 10  u16  backlash_y
  putF32(out, 12, f.mm_per_rev_x);      // 12  f32  mm_per_rev_x
  putF32(out, 16, f.mm_per_rev_y);      // 16  f32  mm_per_rev_y
  putI32(out, 20, f.logical_x_steps);   // 20  i32  logical_x_steps
  putI32(out, 24, f.logical_y_steps);   // 24  i32  logical_y_steps

  std::uint8_t flags = 0;               // 28  u8   flags
  if (f.calibrated)          flags |= HELLO_FLAG_CALIBRATED;
  if (f.unclean)             flags |= HELLO_FLAG_UNCLEAN;
  if (f.envelope_calibrated) flags |= HELLO_FLAG_ENVELOPE_CALIBRATED;
  out[28] = flags;
  out[29] = 0;                          // 29  u8   reserved
  putU16(out, 30, f.buffer_capacity);   // 30  u16  buffer_capacity
  putU32(out, 32, f.envelope_x_steps);  // 32  u32  envelope_x_steps
  putU32(out, 36, f.envelope_y_steps);  // 36  u32  envelope_y_steps

  return HELLO_PAYLOAD_SIZE;
}

}  // namespace app
}  // namespace etch
