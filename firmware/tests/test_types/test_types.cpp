// Host-side checks that the shared firmware types in src/types.h match the
// canonical wire / NVM layouts pinned in Design §4.3 (Drawing_Command) and
// Design §4.4 (PersistedConfig).
//
// These are deliberately light-weight: the static_asserts in types.h already
// fail the build if any field drifts. The runtime checks below give a clear
// per-field message in CI output if the layout ever changes, and confirm the
// header is usable from a `platform = native` test target with no Arduino
// dependencies (Task 1.6, Requirements 6.3, 6.4, Design §4.3-§4.4).

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstdint>

#include "../../src/types.h"

using namespace etch;

TEST_CASE("DrawingCommand wire layout matches Design §4.3", "[types][wire]") {
  REQUIRE(sizeof(DrawingCommand) == 16u);
  REQUIRE(DRAWING_COMMAND_SIZE == 16u);
  REQUIRE(DRAWING_COMMAND_CRC_RANGE == 14u);

  CHECK(offsetof(DrawingCommand, seq)           ==  0u);
  CHECK(offsetof(DrawingCommand, dx_steps)      ==  4u);
  CHECK(offsetof(DrawingCommand, dy_steps)      ==  6u);
  CHECK(offsetof(DrawingCommand, feed_sps)      ==  8u);
  CHECK(offsetof(DrawingCommand, flags)         == 10u);
  CHECK(offsetof(DrawingCommand, reserved)      == 12u);
  CHECK(offsetof(DrawingCommand, crc16_payload) == 14u);

  CHECK(CMD_FLAG_CONNECTOR     == 0x0001u);
  CHECK(CMD_FLAG_LAST_OF_BATCH == 0x0002u);
  // Reserved-mask covers every bit other than the two defined flags.
  CHECK((CMD_FLAG_CONNECTOR | CMD_FLAG_LAST_OF_BATCH | CMD_FLAG_RESERVED_MASK)
        == 0xFFFFu);
  CHECK((CMD_FLAG_CONNECTOR & CMD_FLAG_RESERVED_MASK) == 0u);
  CHECK((CMD_FLAG_LAST_OF_BATCH & CMD_FLAG_RESERVED_MASK) == 0u);
}

TEST_CASE("PersistedConfig NVM record matches Design §4.4", "[types][nvm]") {
  // PersistedConfig v2 (visual-corner-calibration): two u32 envelope fields
  // were appended before the flags/_pad1/record_crc32 tail, growing the record
  // 132 -> 140 and the CRC range 128 -> 136 (Design §Data Models v2, Req 7.1/7.4).
  REQUIRE(sizeof(PersistedConfig) == 140u);
  REQUIRE(NVM_RECORD_SIZE == 140u);
  REQUIRE(NVM_RECORD_OFFSET == 0u);
  REQUIRE(NVM_RECORD_CRC_RANGE == 136u);

  CHECK(offsetof(PersistedConfig, magic)            ==   0u);
  CHECK(offsetof(PersistedConfig, version)          ==   4u);
  CHECK(offsetof(PersistedConfig, reserved)         ==   6u);
  CHECK(offsetof(PersistedConfig, wifi_ssid)        ==   8u);
  CHECK(offsetof(PersistedConfig, _pad0)            ==  41u);
  CHECK(offsetof(PersistedConfig, wifi_password)    ==  42u);
  CHECK(offsetof(PersistedConfig, backlash_x_steps) == 106u);
  CHECK(offsetof(PersistedConfig, backlash_y_steps) == 108u);
  CHECK(offsetof(PersistedConfig, mm_per_rev_x)     == 110u);
  CHECK(offsetof(PersistedConfig, mm_per_rev_y)     == 114u);
  CHECK(offsetof(PersistedConfig, logical_pos_x)    == 118u);
  CHECK(offsetof(PersistedConfig, logical_pos_y)    == 122u);
  CHECK(offsetof(PersistedConfig, envelope_x_steps) == 126u);
  CHECK(offsetof(PersistedConfig, envelope_y_steps) == 130u);
  CHECK(offsetof(PersistedConfig, flags)            == 134u);
  CHECK(offsetof(PersistedConfig, _pad1)            == 135u);
  CHECK(offsetof(PersistedConfig, record_crc32)     == 136u);

  CHECK(NVM_MAGIC == 0x45534B31u);
  CHECK(NVM_VERSION == 2u);
  CHECK(NVM_FLAG_CALIBRATED == 0x01u);
  CHECK(NVM_FLAG_UNCLEAN    == 0x02u);
  CHECK(NVM_FLAG_ENVELOPE_CALIBRATED == 0x04u);
  CHECK(WIFI_SSID_BUF_LEN     == 33u);
  CHECK(WIFI_PASSWORD_BUF_LEN == 64u);
}

TEST_CASE("Buffer, speed, and gear constants match the design", "[types][const]") {
  CHECK(COMMAND_BUFFER_SIZE       == 32u);
  CHECK(COMMAND_BUFFER_HIGH_WATER == 28u);
  CHECK(COMMAND_BUFFER_LOW_WATER  == 16u);

  CHECK(FEED_SPS_MIN == 100u);
  CHECK(FEED_SPS_MAX == 1000u);
  CHECK(SPEED_PCT_MIN == 25u);
  CHECK(SPEED_PCT_MAX == 100u);

  CHECK(BACKLASH_STEPS_MIN ==   0u);
  CHECK(BACKLASH_STEPS_MAX == 200u);

  CHECK(MOTOR_STEPS_PER_REV    == 200u);
  CHECK(MICROSTEP_FACTOR       ==  16u);
  CHECK(GEAR_RATIO             ==   2u);
  CHECK(FULL_STEPS_PER_KNOB_REV == 400u);
  CHECK(MICROSTEPS_PER_KNOB_REV == 6400u);
  CHECK(DEFAULT_MM_PER_REV     == 100.0f);

  CHECK(NVM_WRITE_DEBOUNCE_MS == 250u);
}

TEST_CASE("Position and BacklashConfig field widths", "[types][motion]") {
  CHECK(sizeof(Position::x_steps) == 4u);
  CHECK(sizeof(Position::y_steps) == 4u);
  CHECK(sizeof(BacklashConfig::x) == 1u);
  CHECK(sizeof(BacklashConfig::y) == 1u);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
