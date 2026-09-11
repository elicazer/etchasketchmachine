// Host-side property tests for envelope persistence + HELLO serialisation
// (Task 4.4).
//
// Feature: visual-corner-calibration, Property 4
//
// Property 4: Envelope round-trips through NVM and HELLO unchanged (firmware
// side).
//
//   *For any* valid Step_Envelope (envelope_x_steps > 0, envelope_y_steps > 0,
//   with the envelope-calibrated flag set):
//
//     (a) NVM round-trip: writing the PersistedConfig record (mutate +
//         flushIfDue) and re-reading it through a fresh NVMManager.begin()
//         reproduces envelope_x_steps, envelope_y_steps, and the
//         NVM_FLAG_ENVELOPE_CALIBRATED bit identically.
//
//     (b) HELLO round-trip: serializeHello() with those envelope fields and
//         envelope_calibrated=true, then independently parsing the payload's
//         u32 at offset 32 / offset 36 and bit2 of the flags byte at offset 28,
//         yields identical values + flag.
//
//   Validates: Requirements 7.2, 7.3, 8.1, 8.3.
//
// This translation unit lives in its own PlatformIO test directory
// (test_envelope_roundtrip_props/) so it links into a standalone test binary
// with its own `int main`, mirroring the other *_props/ suites. Because the
// host_test environment sets `test_build_src = no`, it pulls nvm_manager.cpp
// and hello.cpp in directly via relative includes so the binary is
// self-contained.
//
// Properties are exercised with rapidcheck via the standalone rc::check form
// invoked from inside Catch2 TEST_CASEs; rc::check returns true on success, so
// wrapping it in REQUIRE surfaces a failing property (with rapidcheck's shrunk
// counterexample on stderr) as a Catch2 failure.
//
// Run with:
//
//     pio test -e host_test -f test_envelope_roundtrip_props

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "../../src/types.h"
#include "../../src/nvm/nvm_manager.h"
#include "../../src/nvm/nvm_manager.cpp"  // NOLINT(bugprone-suspicious-include)
#include "../../src/app/hello.h"
#include "../../src/app/hello.cpp"        // NOLINT(bugprone-suspicious-include)

using etch::NVM_FLAG_ENVELOPE_CALIBRATED;
using etch::NVM_RECORD_SIZE;
using etch::PersistedConfig;
using etch::nvm::NVMBackend;
using etch::nvm::NVMManager;
using etch::app::HelloFields;
using etch::app::HELLO_FLAG_ENVELOPE_CALIBRATED;
using etch::app::HELLO_PAYLOAD_SIZE;
using etch::app::serializeHello;

namespace {

// In-memory backend simulating erased flash (all-0xFF). A fresh instance is
// created per property iteration so each trial sees clean storage.
class FakeBackend final : public NVMBackend {
 public:
  FakeBackend() { storage_.fill(0xFF); }

  void readRecord(std::uint8_t* out, std::size_t len) override {
    assert(len == NVM_RECORD_SIZE);
    std::memcpy(out, storage_.data(), len);
  }
  void writeRecord(const std::uint8_t* in, std::size_t len) override {
    assert(len == NVM_RECORD_SIZE);
    std::memcpy(storage_.data(), in, len);
    ++write_count_;
  }
  std::size_t writes() const { return write_count_; }

 private:
  std::array<std::uint8_t, NVM_RECORD_SIZE> storage_;
  std::size_t write_count_ = 0;
};

struct FakeClock {
  static std::uint32_t now_ms;
  static std::uint32_t read() { return now_ms; }
};
std::uint32_t FakeClock::now_ms = 0;

// Independent little-endian u32 reader (oracle, not the SUT's own helper).
std::uint32_t readU32LE(const std::uint8_t* p) {
  return static_cast<std::uint32_t>(p[0]) |
         (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) |
         (static_cast<std::uint32_t>(p[3]) << 24);
}

// Sample an arbitrary VALID envelope: both axes strictly positive (Req 2.1).
// Range covers small values through well beyond any plausible physical
// envelope so the round-trip is exercised across the full u32-relevant space.
std::uint32_t genValidAxis() {
  return static_cast<std::uint32_t>(*rc::gen::inRange<std::int64_t>(1, 2000001));
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 4 (a): NVM round-trip preserves the envelope + flag.
// ---------------------------------------------------------------------------
TEST_CASE("Property 4: valid envelope round-trips through NVM unchanged",
          "[nvm][hello][envelope][property][property-4]") {
  REQUIRE(rc::check(
      "write(envelope) then read() reproduces envelope + flag", [] {
        const std::uint32_t ex = genValidAxis();
        const std::uint32_t ey = genValidAxis();

        FakeBackend backend;
        FakeClock::now_ms = 0;

        // Persist the envelope through the public mutate()+flushIfDue() path.
        {
          NVMManager writer(backend, &FakeClock::read);
          writer.begin();  // erased flash -> defaults, dirty
          writer.mutate([&](PersistedConfig& c) {
            c.envelope_x_steps = ex;
            c.envelope_y_steps = ey;
            c.flags = static_cast<std::uint8_t>(
                c.flags | NVM_FLAG_ENVELOPE_CALIBRATED);
          });
          writer.flushIfDue();
          RC_ASSERT(backend.writes() == 1u);
        }

        // Re-read through a fresh manager (simulates a reboot, Req 7.3).
        FakeClock::now_ms = 100000;
        NVMManager reader(backend, &FakeClock::read);
        reader.begin();
        const PersistedConfig& got = reader.get();

        RC_ASSERT(got.envelope_x_steps == ex);
        RC_ASSERT(got.envelope_y_steps == ey);
        RC_ASSERT((got.flags & NVM_FLAG_ENVELOPE_CALIBRATED) != 0);
      }));
}

// ---------------------------------------------------------------------------
// Property 4 (b): HELLO serialisation preserves the envelope + flag at the
// pinned offsets (32 / 36 / bit2 of flags @ 28).
// ---------------------------------------------------------------------------
TEST_CASE("Property 4: valid envelope round-trips through HELLO serialisation",
          "[nvm][hello][envelope][property][property-4]") {
  REQUIRE(rc::check(
      "serializeHello(envelope) -> bytes @32/@36 + flag bit2 match", [] {
        const std::uint32_t ex = genValidAxis();
        const std::uint32_t ey = genValidAxis();

        HelloFields f{};
        f.envelope_x_steps = ex;
        f.envelope_y_steps = ey;
        f.envelope_calibrated = true;

        std::uint8_t buf[HELLO_PAYLOAD_SIZE] = {0};
        const std::size_t n = serializeHello(f, buf, sizeof(buf));
        RC_ASSERT(n == HELLO_PAYLOAD_SIZE);

        // Envelope fields decode identically from offsets 32 / 36.
        RC_ASSERT(readU32LE(&buf[32]) == ex);
        RC_ASSERT(readU32LE(&buf[36]) == ey);
        // Flag bit2 of the flags byte at offset 28 is set.
        RC_ASSERT((buf[28] & HELLO_FLAG_ENVELOPE_CALIBRATED) != 0);
      }));
}

// ---------------------------------------------------------------------------
// Property 4 (combined): NVM -> HELLO end-to-end. The values that survive a
// persist/reload also serialise into the HELLO payload unchanged, exactly as
// the sketch's sendHello() populates HelloFields from the reloaded config.
// ---------------------------------------------------------------------------
TEST_CASE("Property 4: envelope survives NVM reload then HELLO serialisation",
          "[nvm][hello][envelope][property][property-4]") {
  REQUIRE(rc::check("persist -> reload -> serializeHello preserves envelope",
                    [] {
                      const std::uint32_t ex = genValidAxis();
                      const std::uint32_t ey = genValidAxis();

                      FakeBackend backend;
                      FakeClock::now_ms = 0;
                      {
                        NVMManager writer(backend, &FakeClock::read);
                        writer.begin();
                        writer.mutate([&](PersistedConfig& c) {
                          c.envelope_x_steps = ex;
                          c.envelope_y_steps = ey;
                          c.flags = static_cast<std::uint8_t>(
                              c.flags | NVM_FLAG_ENVELOPE_CALIBRATED);
                        });
                        writer.flushIfDue();
                      }

                      FakeClock::now_ms = 100000;
                      NVMManager reader(backend, &FakeClock::read);
                      reader.begin();
                      const PersistedConfig& cfg = reader.get();

                      // Populate HELLO from the reloaded config (mirrors
                      // sendHello()).
                      HelloFields f{};
                      f.envelope_x_steps = cfg.envelope_x_steps;
                      f.envelope_y_steps = cfg.envelope_y_steps;
                      f.envelope_calibrated =
                          (cfg.flags & NVM_FLAG_ENVELOPE_CALIBRATED) != 0u;

                      std::uint8_t buf[HELLO_PAYLOAD_SIZE] = {0};
                      RC_ASSERT(serializeHello(f, buf, sizeof(buf)) ==
                                HELLO_PAYLOAD_SIZE);

                      RC_ASSERT(readU32LE(&buf[32]) == ex);
                      RC_ASSERT(readU32LE(&buf[36]) == ey);
                      RC_ASSERT((buf[28] & HELLO_FLAG_ENVELOPE_CALIBRATED) != 0);
                    }));
}

// ---------------------------------------------------------------------------
// Concrete pin (plain Catch2): a hand-worked envelope through both stages.
// ---------------------------------------------------------------------------
TEST_CASE("Property 4 (concrete): 12000 x 8000 envelope round-trips",
          "[nvm][hello][envelope][property-4][example]") {
  FakeBackend backend;
  FakeClock::now_ms = 0;
  {
    NVMManager writer(backend, &FakeClock::read);
    writer.begin();
    writer.mutate([](PersistedConfig& c) {
      c.envelope_x_steps = 12000;
      c.envelope_y_steps = 8000;
      c.flags = static_cast<std::uint8_t>(c.flags |
                                          NVM_FLAG_ENVELOPE_CALIBRATED);
    });
    writer.flushIfDue();
  }
  FakeClock::now_ms = 100000;
  NVMManager reader(backend, &FakeClock::read);
  reader.begin();
  CHECK(reader.get().envelope_x_steps == 12000u);
  CHECK(reader.get().envelope_y_steps == 8000u);
  CHECK((reader.get().flags & NVM_FLAG_ENVELOPE_CALIBRATED) != 0);

  HelloFields f{};
  f.envelope_x_steps = reader.get().envelope_x_steps;
  f.envelope_y_steps = reader.get().envelope_y_steps;
  f.envelope_calibrated = true;
  std::uint8_t buf[HELLO_PAYLOAD_SIZE] = {0};
  REQUIRE(serializeHello(f, buf, sizeof(buf)) == HELLO_PAYLOAD_SIZE);
  CHECK(readU32LE(&buf[32]) == 12000u);
  CHECK(readU32LE(&buf[36]) == 8000u);
  CHECK((buf[28] & HELLO_FLAG_ENVELOPE_CALIBRATED) != 0);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
