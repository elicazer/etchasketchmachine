// Shared data types and constants for the Etch-a-Sketch Drawing Machine firmware.
//
// This header is intentionally free of Arduino-specific includes so that it can
// be compiled both under `framework = arduino` for the UNO R4 WiFi target and
// under `platform = native` for the host-side Catch2 tests. All sizes and
// offsets are pinned to Design §4.3 (Drawing_Command wire format) and
// Design §4.4 (PersistedConfig NVM record).
//
// References:
//   - Requirements 6.3 (motor step rate), 6.4 (32-deep buffer), 6.5 (flow ctrl),
//     7.2 (CRC-16 wire format), 7.8 (round-trip), 10.5/10.6/10.12 (NVM), 13.x.
//   - Design §4.3 Drawing_Command, §4.4 PersistedConfig, §2.2 gear math.

#pragma once

#include <cstdint>
#include <cstddef>

namespace etch {

// ---------------------------------------------------------------------------
// Buffering and protocol limits (Requirements 6.4, 6.5, 6.7)
// ---------------------------------------------------------------------------

// Depth of the SPSC ring buffer between the protocol layer and the motion
// planner. Sized to keep the motors fed across worst-case WiFi jitter while
// remaining cheap in RAM (32 * 16 B = 512 B). Design §3.2.5, §6.4.
inline constexpr std::size_t COMMAND_BUFFER_SIZE = 32;

// Credit-based flow control thresholds. The firmware withholds credits at
// HIGH_WATER and resumes issuing them at LOW_WATER (Design §6.4).
inline constexpr std::size_t COMMAND_BUFFER_HIGH_WATER = 28;
inline constexpr std::size_t COMMAND_BUFFER_LOW_WATER = 16;

// Step-rate envelope in full motor steps per second (Requirements 5.5, 6.3).
// FEED_SPS_MIN / FEED_SPS_MAX are the WIRE / protocol-validation bounds: every
// Drawing_Command feed_sps on the wire must lie in [FEED_SPS_MIN, FEED_SPS_MAX],
// and the web client mirrors these exact values. DO NOT change them for motion
// tuning -- the cold-start tunables below handle that without touching the
// protocol contract.
inline constexpr std::uint16_t FEED_SPS_MIN = 100;
inline constexpr std::uint16_t FEED_SPS_MAX = 1000;

// ---------------------------------------------------------------------------
// Motion cold-start / pull-in tuning (NOT on the wire; firmware-internal)
// ---------------------------------------------------------------------------
//
// A stepper has a "pull-in rate": the highest step rate at which it can start
// from a dead stop WITHOUT acceleration and not lose steps. For this NEMA-17 +
// 18:36 gearing load that rate is well BELOW FEED_SPS_MIN. A known-good
// reference sketch drives the same motor reliably by pulsing STEP at a gentle
// constant ~250-500 Hz (microstep level) on a cold start.
//
// At MICROSTEP_FACTOR=16, FEED_SPS_MIN=100 full-sps = 1600 microstep Hz, which
// is ABOVE the pull-in rate. Starting a move flat at that rate (as JOG used to)
// makes the motor buzz/stall and only occasionally catch. Drawings already ramp
// so they don't stall, but they used to start the ramp at FEED_SPS_MIN, still
// above pull-in. These constants let ALL motion EASE IN from a gentle pull-in
// rate and accelerate up to the requested feed.
//
// FIELD TUNING: these are educated defaults and may need per-machine tuning. If
// the motor still stalls/buzzes on a cold start, LOWER MOTION_START_SPS; if
// jogs feel sluggish, RAISE it (but keep it at or below the pull-in rate).

// Ramp start / pull-in speed in full steps per second. The trapezoidal ramp's
// vMin starts HERE instead of at FEED_SPS_MIN, so the very first pulses of every
// segment are in the proven-good cold-start zone. 32 full-sps * MICROSTEP_FACTOR
// (16) = 512 microstep Hz, squarely inside the reference sketch's ~250-500 Hz
// pull-in band.
inline constexpr std::uint16_t MOTION_START_SPS = 32;

// Absolute lower bound for a ramp's start speed (vMin). This is the
// motion-internal floor that REPLACES FEED_SPS_MIN as the ramp's vMin clamp, so
// a ramp may legitimately start BELOW the protocol floor for pull-in. Must be
// > 0 so the 1/v time integration never divides by zero. FEED_SPS_MIN remains
// the wire bound and is unchanged; RAMP_MIN_SPS <= MOTION_START_SPS.
inline constexpr std::uint16_t RAMP_MIN_SPS = 10;

// Cruise feed (ramp PEAK) for a manual jog (Req 10.3). A multi-step jog ramps
// from MOTION_START_SPS up to this peak so it eases in instead of slamming; a
// 1-step jog just emits a single pulse at the start rate, which is gentle. Kept
// at the protocol floor so jogging (used for calibration) stays slow and
// precise. This is a feed on the wire-shaped Drawing_Command the .ino submits,
// so it must stay within [FEED_SPS_MIN, FEED_SPS_MAX].
inline constexpr std::uint16_t JOG_FEED_SPS = FEED_SPS_MIN;

static_assert(RAMP_MIN_SPS > 0, "RAMP_MIN_SPS must be > 0 (no divide-by-zero)");
static_assert(RAMP_MIN_SPS <= MOTION_START_SPS,
              "ramp floor must be <= the pull-in start speed");
static_assert(MOTION_START_SPS < FEED_SPS_MIN,
              "pull-in start must be below the protocol floor to help cold start");
static_assert(JOG_FEED_SPS >= FEED_SPS_MIN && JOG_FEED_SPS <= FEED_SPS_MAX,
              "jog cruise feed must be a valid wire feed");

// Speed-percent envelope for live scaling via SPEED_PCT (Requirement 9.7).
inline constexpr std::uint8_t SPEED_PCT_MIN = 25;
inline constexpr std::uint8_t SPEED_PCT_MAX = 100;

// Backlash compensation envelope per axis (Requirement 13.8).
inline constexpr std::uint16_t BACKLASH_STEPS_MIN = 0;
inline constexpr std::uint16_t BACKLASH_STEPS_MAX = 200;

// ---------------------------------------------------------------------------
// Gear math (Design §2.2)
// ---------------------------------------------------------------------------

// NEMA 17 native step count per motor revolution (1.8°/step).
inline constexpr std::uint16_t MOTOR_STEPS_PER_REV = 200;

// A4988 microstepping factor. MUST match the MS1/MS2/MS3 jumper configuration
// on the CNC shield: all three jumpers populated => 16 (1/16 microstepping);
// no jumpers => 1 (full step); intermediate (1/2 => 2, 1/4 => 4, 1/8 => 8).
//
// HARDWARE-MATCH NOTE: the firmware emits MICROSTEP_FACTOR pulses per full
// motor step; the commanded microstep rate (full-step rate * MICROSTEP_FACTOR)
// is realised in software by the DDS step divider in onStepIsr() against the
// fixed STEP_TICK_HZ tick. This MUST equal the driver's actual microstep
// setting. The CNC shield has all three MS jumpers populated under each A4988
// => 1/16 microstepping => 16.
inline constexpr std::uint8_t MICROSTEP_FACTOR = 16;

// Fixed microstep tick frequency for the drawing step timer. The GPT is
// programmed to this rate ONCE in configureTimer_() and NEVER reprogrammed per
// step (the prior per-step set_frequency() was the runaway root cause). The
// commanded feed is realized in software by a Bresenham/DDS rate divider in
// onStepIsr().
//
// Sizing: the maximum commanded microstep rate is
//   FEED_SPS_MAX * MICROSTEP_FACTOR = 1000 * 16 = 16000 Hz.
// A small integer multiple (2x) gives headroom for the divider to represent
// fast speeds with low quantization error while leaving the ISR ample time:
//   STEP_TICK_HZ = 32000  ->  period = 31.25 us per tick.
// Slowest representable speeds remain clean under DDS accumulation:
//   RAMP_MIN_SPS=10  -> 160 microstep Hz  -> rollover every 200 ticks (exact)
//   MOTION_START_SPS=32 -> 512 microstep Hz -> 62.5 ticks/microstep (exact avg)
// 2x the max microstep rate also satisfies Nyquist for the fastest emission
// (one microstep every 2 ticks at FEED_SPS_MAX), so even peak feed is divisible.
inline constexpr std::uint32_t STEP_TICK_HZ = 32000;

static_assert(STEP_TICK_HZ >= static_cast<std::uint32_t>(FEED_SPS_MAX) * MICROSTEP_FACTOR,
              "tick rate must be >= the maximum commanded microstep rate");

// Mechanical advantage from the 18:36 pinion-on-knob pair: the motor turns
// twice per knob revolution.
inline constexpr std::uint8_t GEAR_RATIO = 2;

// Derived: full motor steps per knob revolution (200 * 2 = 400).
inline constexpr std::uint16_t FULL_STEPS_PER_KNOB_REV =
    MOTOR_STEPS_PER_REV * GEAR_RATIO;

// Derived: microsteps per knob revolution (400 * 16 = 6400).
inline constexpr std::uint32_t MICROSTEPS_PER_KNOB_REV =
    static_cast<std::uint32_t>(FULL_STEPS_PER_KNOB_REV) * MICROSTEP_FACTOR;

// Default mm-per-knob-revolution before per-machine calibration refines it
// (Design §2.2). Used as the documented default when NVM is uninitialised.
inline constexpr float DEFAULT_MM_PER_REV = 100.0f;

// ---------------------------------------------------------------------------
// Drawing_Command wire format (Design §4.3)
// ---------------------------------------------------------------------------

// Flag bits carried in DrawingCommand::flags. All other bits MUST be zero
// (Requirement 6.7).
inline constexpr std::uint16_t CMD_FLAG_CONNECTOR     = 0x0001;
inline constexpr std::uint16_t CMD_FLAG_LAST_OF_BATCH = 0x0002;
inline constexpr std::uint16_t CMD_FLAG_RESERVED_MASK =
    static_cast<std::uint16_t>(~(CMD_FLAG_CONNECTOR | CMD_FLAG_LAST_OF_BATCH));

// Fixed 16-byte little-endian wire payload carried inside a CMD frame.
// Layout MUST match Design §4.3 byte-for-byte; do not add, remove, or reorder
// fields without updating the design document and the host-side decoder.
#if defined(_MSC_VER)
#  pragma pack(push, 1)
struct DrawingCommand {
#else
struct __attribute__((packed)) DrawingCommand {
#endif
  std::uint32_t seq;            // offset  0  monotonic per session
  std::int16_t  dx_steps;       // offset  4  signed delta on X
  std::int16_t  dy_steps;       // offset  6  signed delta on Y
  std::uint16_t feed_sps;       // offset  8  [FEED_SPS_MIN, FEED_SPS_MAX]
  std::uint16_t flags;          // offset 10  CMD_FLAG_* bits only
  std::uint16_t reserved;       // offset 12  MUST be zero
  std::uint16_t crc16_payload;  // offset 14  CRC-16/CCITT over bytes [0..14)
};
#if defined(_MSC_VER)
#  pragma pack(pop)
#endif

inline constexpr std::size_t DRAWING_COMMAND_SIZE = 16;
inline constexpr std::size_t DRAWING_COMMAND_CRC_RANGE = 14;  // bytes [0..14)

static_assert(sizeof(DrawingCommand) == DRAWING_COMMAND_SIZE,
              "DrawingCommand must be exactly 16 bytes (Design §4.3)");
static_assert(offsetof(DrawingCommand, seq)           ==  0, "seq @ 0");
static_assert(offsetof(DrawingCommand, dx_steps)      ==  4, "dx_steps @ 4");
static_assert(offsetof(DrawingCommand, dy_steps)      ==  6, "dy_steps @ 6");
static_assert(offsetof(DrawingCommand, feed_sps)      ==  8, "feed_sps @ 8");
static_assert(offsetof(DrawingCommand, flags)         == 10, "flags @ 10");
static_assert(offsetof(DrawingCommand, reserved)      == 12, "reserved @ 12");
static_assert(offsetof(DrawingCommand, crc16_payload) == 14, "crc16 @ 14");

// ---------------------------------------------------------------------------
// In-memory motion types
// ---------------------------------------------------------------------------

// Logical stylus position in counted full motor steps relative to home.
// Backlash compensation steps are NOT included (Requirement 13.7).
struct Position {
  std::int32_t x_steps;
  std::int32_t y_steps;
};

// Per-axis backlash compensation in full motor steps. Each value is bounded
// by [BACKLASH_STEPS_MIN, BACKLASH_STEPS_MAX] (Requirement 13.8).
struct BacklashConfig {
  std::uint8_t x;
  std::uint8_t y;
};

// ---------------------------------------------------------------------------
// PersistedConfig NVM record (Design §4.4)
// ---------------------------------------------------------------------------

// Sizes for the in-record null-terminated WiFi credential strings. The
// inclusive lengths come from Requirement 1.4 (SSID 1..32 chars, password
// 8..63 chars); the +1 is the null terminator.
inline constexpr std::size_t WIFI_SSID_BUF_LEN     = 33;  // 32 + NUL
inline constexpr std::size_t WIFI_PASSWORD_BUF_LEN = 64;  // 63 + NUL

// Magic / version constants for the PersistedConfig record.
inline constexpr std::uint32_t NVM_MAGIC   = 0x45534B31u;  // "ESK1" little-endian
inline constexpr std::uint16_t NVM_VERSION = 2;            // bumped for envelope (Req 7.4)

// Bit positions in PersistedConfig::flags.
inline constexpr std::uint8_t NVM_FLAG_CALIBRATED          = 0x01;  // bit0
inline constexpr std::uint8_t NVM_FLAG_UNCLEAN             = 0x02;  // bit1
inline constexpr std::uint8_t NVM_FLAG_ENVELOPE_CALIBRATED = 0x04;  // bit2 (Req 7.1)

// Baked-in default Step_Envelope (full motor steps) used when the machine is
// not envelope-calibrated. This is the measured envelope of the reference
// physical machine. Safe as a fallback because it is a BOUNDED measured step
// envelope (not unbounded gear-math scaling), so motion stays inside the
// physical drawing area even uncalibrated.
inline constexpr std::uint32_t DEFAULT_ENVELOPE_X_STEPS = 1640;
inline constexpr std::uint32_t DEFAULT_ENVELOPE_Y_STEPS = 1220;

// Fixed per-axis jog travel safety cap in full motor steps, active even before
// any corner is captured. Set generously above any realistic envelope while
// still bounding a runaway (Design §Sketch Handlers, Req 6.1).
inline constexpr std::int32_t JOG_TRAVEL_CAP_STEPS = 40000;

// EEPROM emulation layout. The record lives at offset 0; the size is fixed.
inline constexpr std::size_t NVM_RECORD_OFFSET = 0;
inline constexpr std::size_t NVM_RECORD_SIZE   = 140;

// Minimum interval between successive NVM record writes (Design §3.2.7).
inline constexpr std::uint32_t NVM_WRITE_DEBOUNCE_MS = 250;

// 140-byte packed NVM record. See Design §4.4 / §Data Models (PersistedConfig
// v2) for the canonical field/offset table. record_crc32 covers bytes [0..136).
#if defined(_MSC_VER)
#  pragma pack(push, 1)
struct PersistedConfig {
#else
struct __attribute__((packed)) PersistedConfig {
#endif
  std::uint32_t magic;                              // offset   0
  std::uint16_t version;                            // offset   4
  std::uint16_t reserved;                           // offset   6
  char          wifi_ssid[WIFI_SSID_BUF_LEN];       // offset   8  (33 bytes)
  std::uint8_t  _pad0;                              // offset  41
  char          wifi_password[WIFI_PASSWORD_BUF_LEN]; // offset 42 (64 bytes)
  std::uint16_t backlash_x_steps;                   // offset 106
  std::uint16_t backlash_y_steps;                   // offset 108
  float         mm_per_rev_x;                       // offset 110
  float         mm_per_rev_y;                       // offset 114
  std::int32_t  logical_pos_x;                      // offset 118
  std::int32_t  logical_pos_y;                      // offset 122
  std::uint32_t envelope_x_steps;                   // offset 126 (Req 7.1)
  std::uint32_t envelope_y_steps;                   // offset 130 (Req 7.1)
  std::uint8_t  flags;                              // offset 134
  std::uint8_t  _pad1;                              // offset 135
  std::uint32_t record_crc32;                       // offset 136
};
#if defined(_MSC_VER)
#  pragma pack(pop)
#endif

inline constexpr std::size_t NVM_RECORD_CRC_RANGE = 136;  // bytes [0..136)

static_assert(sizeof(PersistedConfig) == NVM_RECORD_SIZE,
              "PersistedConfig must be exactly 140 bytes (Design §Data Models v2)");
static_assert(offsetof(PersistedConfig, magic)            ==   0, "magic @ 0");
static_assert(offsetof(PersistedConfig, version)          ==   4, "version @ 4");
static_assert(offsetof(PersistedConfig, reserved)         ==   6, "reserved @ 6");
static_assert(offsetof(PersistedConfig, wifi_ssid)        ==   8, "wifi_ssid @ 8");
static_assert(offsetof(PersistedConfig, _pad0)            ==  41, "_pad0 @ 41");
static_assert(offsetof(PersistedConfig, wifi_password)    ==  42, "wifi_password @ 42");
static_assert(offsetof(PersistedConfig, backlash_x_steps) == 106, "backlash_x @ 106");
static_assert(offsetof(PersistedConfig, backlash_y_steps) == 108, "backlash_y @ 108");
static_assert(offsetof(PersistedConfig, mm_per_rev_x)     == 110, "mm_per_rev_x @ 110");
static_assert(offsetof(PersistedConfig, mm_per_rev_y)     == 114, "mm_per_rev_y @ 114");
static_assert(offsetof(PersistedConfig, logical_pos_x)    == 118, "logical_pos_x @ 118");
static_assert(offsetof(PersistedConfig, logical_pos_y)    == 122, "logical_pos_y @ 122");
static_assert(offsetof(PersistedConfig, envelope_x_steps) == 126, "envelope_x_steps @ 126");
static_assert(offsetof(PersistedConfig, envelope_y_steps) == 130, "envelope_y_steps @ 130");
static_assert(offsetof(PersistedConfig, flags)            == 134, "flags @ 134");
static_assert(offsetof(PersistedConfig, _pad1)            == 135, "_pad1 @ 135");
static_assert(offsetof(PersistedConfig, record_crc32)     == 136, "record_crc32 @ 136");

// Sanity checks on the field type widths in case a future toolchain treats
// `float` as something other than IEEE-754 binary32.
static_assert(sizeof(float) == 4, "PersistedConfig assumes 32-bit float");
static_assert(sizeof(std::int32_t) == 4, "logical_pos_* must be 32-bit");

}  // namespace etch
