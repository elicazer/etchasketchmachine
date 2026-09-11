// HELLO frame payload serialiser (Design §4.8).
//
// The Controller sends a HELLO frame (FrameType 0x22) on every WebSocket open
// so the browser SPA can rehydrate its UI: firmware version, the step-rate
// ceiling, the persisted backlash and mm/rev calibration, the logical stylus
// position, and the calibrated / unclean-shutdown flags (Design §4.8,
// Requirements 7.5/7.6 reconnect rehydration, 10.2/10.12 calibration state).
//
// This translation unit owns ONLY the 32-byte little-endian payload layout. The
// §4.5 envelope (version / type / length) is added by the caller via
// protocol::buildFrame() before the bytes hit the socket. Keeping the payload
// serialiser free of the envelope (and of any Arduino include) is what lets it
// be exhaustively byte-checked on the host against the web decoder in
// web/src/codec/frame.ts / web/src/net/wire_client.ts.
//
// Wire layout (Design §4.8, little-endian, MUST match the web decoder):
//
//   Offset  Size  Field             Type
//   ------  ----  ----------------  -----
//     0      4   firmware_version  u32   maj<<16 | min<<8 | patch
//     4      2   max_sps           u16   1000
//     6      2   reserved          u16   0
//     8      2   backlash_x        u16
//    10      2   backlash_y        u16
//    12      4   mm_per_rev_x      f32
//    16      4   mm_per_rev_y      f32
//    20      4   logical_x_steps   i32
//    24      4   logical_y_steps   i32
//    28      1   flags             u8    bit0=calibrated, bit1=unclean,
//                                          bit2=envelope-calibrated
//    29      1   reserved          u8    0
//    30      2   buffer_capacity   u16   32
//    32      4   envelope_x_steps  u32
//    36      4   envelope_y_steps  u32
//
//   Total payload = 40 bytes
//
// References:
//   - Requirements 7.5, 7.6 (reconnect rehydration), 10.2 (calibration state).
//   - Design §4.8 (HELLO frame byte layout).

#pragma once

#include <cstddef>
#include <cstdint>

namespace etch {
namespace app {

// Fixed §4.8 HELLO payload size in bytes (the §4.5 envelope is added by the
// caller). Pinned by serializeHello() and the host tests.
inline constexpr std::size_t HELLO_PAYLOAD_SIZE = 40;

// HELLO flag bits (Design §4.8). These mirror the NVM flag bits in types.h and
// the web decoder's FLAG_CALIBRATED / HELLO_FLAG_UNCLEAN.
inline constexpr std::uint8_t HELLO_FLAG_CALIBRATED          = 0x01;  // bit0
inline constexpr std::uint8_t HELLO_FLAG_UNCLEAN             = 0x02;  // bit1
inline constexpr std::uint8_t HELLO_FLAG_ENVELOPE_CALIBRATED = 0x04;  // bit2

// The step-rate ceiling and buffer capacity advertised in HELLO. Wire-stable
// constants the SPA reads back to size its flow-control and speed UI.
inline constexpr std::uint16_t HELLO_MAX_SPS         = 1000;
inline constexpr std::uint16_t HELLO_BUFFER_CAPACITY = 32;

// Decoded HELLO fields gathered from NVM / MotionPlanner / BacklashCompensator
// at WS-open time. POD so the main loop can stack-allocate and fill it.
struct HelloFields {
  std::uint32_t firmware_version = 0;
  std::uint16_t max_sps          = HELLO_MAX_SPS;
  std::uint16_t backlash_x       = 0;
  std::uint16_t backlash_y       = 0;
  float         mm_per_rev_x     = 0.0f;
  float         mm_per_rev_y     = 0.0f;
  std::int32_t  logical_x_steps  = 0;
  std::int32_t  logical_y_steps  = 0;
  bool          calibrated       = false;
  bool          unclean          = false;
  std::uint16_t buffer_capacity  = HELLO_BUFFER_CAPACITY;
  std::uint32_t envelope_x_steps = 0;
  std::uint32_t envelope_y_steps = 0;
  bool          envelope_calibrated = false;
};

// Pack a u32 semantic version from its components (maj<<16 | min<<8 | patch),
// matching the web's `firmwareVersion` decode (e.g. 0.1.0 -> 0x000100).
constexpr std::uint32_t packFirmwareVersion(std::uint8_t major,
                                            std::uint8_t minor,
                                            std::uint8_t patch) {
  return (static_cast<std::uint32_t>(major) << 16) |
         (static_cast<std::uint32_t>(minor) << 8) |
         static_cast<std::uint32_t>(patch);
}

// Serialise `f` into the 40-byte little-endian §4.8 payload at `out`. Returns
// the number of bytes written (HELLO_PAYLOAD_SIZE) on success, or 0 if `out`
// is null or `cap` < HELLO_PAYLOAD_SIZE. Multi-byte integer fields are written
// with explicit shifts so the result is endianness-independent; the two f32
// fields are emitted in little-endian (matching DataView.setFloat32(.., true)
// on the web side and the RA4M1 / host little-endian byte order).
std::size_t serializeHello(const HelloFields& f, std::uint8_t* out,
                           std::size_t cap);

}  // namespace app
}  // namespace etch
