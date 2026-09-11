// Host-side property tests for NVMManager (Task 2.2).
//
// Property 13: NVM round-trip and corruption defaults (Design §7, §4.4).
//
//   *For any* PersistedConfig value `c` whose fields lie in their documented
//   ranges (SSID 1..32 chars, password 8..63 chars, backlash 0..200,
//   mm_per_rev > 0, finite logical pos, defined flag bits), load(save(c)) == c.
//   *For any* byte sequence whose magic or trailing CRC-32 does not match,
//   load returns the documented defaults: empty creds, backlash (0, 0),
//   mm_per_rev (100.0, 100.0), position (0, 0), calibrated = false.
//
//   Validates: Requirements 1.5, 13.5, 13.10.
//
// This translation unit lives in its own PlatformIO test directory
// (test_nvm_props/) so it is compiled and linked into a standalone test
// binary, separate from test_nvm/. It therefore supplies its own
// `int main` and pulls the implementation in directly via a relative
// include of nvm_manager.cpp -- mirroring the conventions established in
// test_nvm/test_nvm.cpp -- so the host_test environment (test_build_src = no)
// stays self-contained with a single definition of NVMManager's symbols.
//
// The properties are exercised with rapidcheck via the standalone rc::check
// form invoked from inside Catch2 TEST_CASEs. rc::check returns true on
// success; wrapping it in REQUIRE means a failing property (with its
// shrunk counterexample printed to stderr by rapidcheck) surfaces as a
// Catch2 failure and integrates with the Catch::Session below.
//
// Run with:
//
//     pio test -e host_test
//
// (PlatformIO pins Catch2 v3.5.3 and rapidcheck for the host_test env; see
// platformio.ini.)

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>
#include <rapidcheck.h>

#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>

#include "../../src/types.h"
#include "../../src/nvm/nvm_manager.h"
#include "../../src/nvm/nvm_manager.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::DEFAULT_MM_PER_REV;
using etch::NVM_FLAG_CALIBRATED;
using etch::NVM_FLAG_UNCLEAN;
using etch::NVM_MAGIC;
using etch::NVM_RECORD_CRC_RANGE;
using etch::NVM_RECORD_SIZE;
using etch::NVM_VERSION;
using etch::PersistedConfig;
using etch::nvm::NVMBackend;
using etch::nvm::NVMManager;

namespace {

// In-memory NVM backend that simulates erased flash (all-0xFF). A fresh
// instance is created per property iteration so each trial sees clean
// (uninitialised) storage unless the test writes a record first.
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

  // Write a PersistedConfig byte-for-byte into the backing store WITHOUT
  // recomputing its CRC -- the caller is responsible for populating
  // record_crc32 so the test can deliberately construct valid, corrupted,
  // or bad-magic records.
  void writeRaw(const PersistedConfig& c) {
    std::memcpy(storage_.data(), &c, NVM_RECORD_SIZE);
  }

  std::uint8_t* raw() { return storage_.data(); }
  const std::uint8_t* raw() const { return storage_.data(); }
  std::size_t writes() const { return write_count_; }

 private:
  std::array<std::uint8_t, NVM_RECORD_SIZE> storage_;
  std::size_t write_count_ = 0;
};

// Manually advanced fake clock. The first write after begin() is
// unconditional (ever_written_ == false), so for round-trip purposes the
// exact value is irrelevant; we reset it to 0 per trial for determinism.
struct FakeClock {
  static std::uint32_t now_ms;
  static std::uint32_t read() { return now_ms; }
};
std::uint32_t FakeClock::now_ms = 0;

// Recompute the trailing CRC-32 over bytes [0..128) of `c` and store it in
// c.record_crc32, leaving `c` as a valid on-disk record.
void sealCrc(PersistedConfig& c) {
  std::uint8_t buf[NVM_RECORD_SIZE];
  std::memcpy(buf, &c, NVM_RECORD_SIZE);
  c.record_crc32 = NVMManager::crc32(buf, NVM_RECORD_CRC_RANGE);
}

// Sample a random PersistedConfig whose fields all lie within their
// documented ranges and whose trailing CRC-32 is valid. Intended to be
// called from inside an rc::check property (uses rapidcheck's operator*).
//
//   * wifi_ssid     : 0..32 printable-ASCII chars, NUL terminated
//   * wifi_password : 0..63 printable-ASCII chars, NUL terminated
//   * backlash_x/y  : 0..200 (Requirement 13.8)
//   * mm_per_rev_x/y: positive finite float in (0.001, 10000.0]
//   * logical_pos   : arbitrary int32 (full range)
//   * flags         : CALIBRATED arbitrary; UNCLEAN intentionally 0 so the
//                     round-trip is not perturbed by begin()'s unconditional
//                     unclean-clear (and the unclean-driven calibrated-clear).
PersistedConfig genValidConfig() {
  PersistedConfig c;
  // Zero-fill so the packed padding bytes (_pad0, _pad1, reserved) and the
  // unused tails of the credential buffers are well-defined, making the CRC
  // reproducible.
  std::memset(&c, 0, sizeof(c));
  c.magic = NVM_MAGIC;
  c.version = NVM_VERSION;
  c.reserved = 0;

  const int ssid_len = *rc::gen::inRange(0, 33);            // [0, 32]
  for (int i = 0; i < ssid_len; ++i) {
    c.wifi_ssid[i] = static_cast<char>(*rc::gen::inRange(0x21, 0x7F));  // '!'..'~'
  }
  c.wifi_ssid[ssid_len] = '\0';

  const int pw_len = *rc::gen::inRange(0, 64);              // [0, 63]
  for (int i = 0; i < pw_len; ++i) {
    c.wifi_password[i] = static_cast<char>(*rc::gen::inRange(0x21, 0x7F));
  }
  c.wifi_password[pw_len] = '\0';

  c.backlash_x_steps = static_cast<std::uint16_t>(*rc::gen::inRange(0, 201));
  c.backlash_y_steps = static_cast<std::uint16_t>(*rc::gen::inRange(0, 201));

  // Positive finite floats. Constructed by scaling an integer so the value
  // is an exact float and therefore round-trips byte-for-byte (no NaN/inf,
  // which would also break the == comparison).
  c.mm_per_rev_x =
      static_cast<float>(*rc::gen::inRange(1, 10000001)) / 1000.0f;
  c.mm_per_rev_y =
      static_cast<float>(*rc::gen::inRange(1, 10000001)) / 1000.0f;

  c.logical_pos_x = *rc::gen::arbitrary<std::int32_t>();
  c.logical_pos_y = *rc::gen::arbitrary<std::int32_t>();

  const bool calibrated = *rc::gen::arbitrary<bool>();
  c.flags = calibrated ? NVM_FLAG_CALIBRATED : 0;  // UNCLEAN deliberately clear
  c._pad0 = 0;
  c._pad1 = 0;

  sealCrc(c);
  return c;
}

// Assert that `c` matches the documented defaults (Design §4.4).
void expectDefaults(const PersistedConfig& c) {
  RC_ASSERT(c.magic == NVM_MAGIC);
  RC_ASSERT(c.version == NVM_VERSION);
  RC_ASSERT(c.wifi_ssid[0] == '\0');
  RC_ASSERT(c.wifi_password[0] == '\0');
  RC_ASSERT(c.backlash_x_steps == 0);
  RC_ASSERT(c.backlash_y_steps == 0);
  RC_ASSERT(c.mm_per_rev_x == DEFAULT_MM_PER_REV);  // 100.0
  RC_ASSERT(c.mm_per_rev_y == DEFAULT_MM_PER_REV);  // 100.0
  RC_ASSERT(c.logical_pos_x == 0);
  RC_ASSERT(c.logical_pos_y == 0);
  RC_ASSERT((c.flags & NVM_FLAG_CALIBRATED) == 0u);
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 13 (part 1): round-trip.
// ---------------------------------------------------------------------------
//
// Writing an arbitrary valid PersistedConfig via mutate() + flushIfDue() and
// re-reading it through a fresh NVMManager.begin() reproduces every field
// exactly. The unclean bit is always cleared at begin(), so flags are
// compared with NVM_FLAG_UNCLEAN masked out (the generator never sets it).
//
// Validates: Requirements 1.5 (credentials persisted), 13.5 (backlash
// persisted).
TEST_CASE("Property 13: NVM round-trip reproduces every field",
          "[nvm][property][property-13]") {
  REQUIRE(rc::check(
      "save(c) then load() reproduces c (unclean bit masked)", [] {
        const PersistedConfig original = genValidConfig();

        FakeBackend backend;
        FakeClock::now_ms = 0;

        // Write through the public mutate() + flushIfDue() path. The first
        // flush is unconditional (nothing written yet), so the record lands
        // regardless of the clock.
        {
          NVMManager writer(backend, &FakeClock::read);
          writer.begin();  // erased flash -> defaults, dirty
          writer.mutate([&](PersistedConfig& d) { d = original; });
          writer.flushIfDue();
          RC_ASSERT(backend.writes() == 1u);
        }

        // Re-read via a fresh manager.
        FakeClock::now_ms = 100000;
        NVMManager reader(backend, &FakeClock::read);
        reader.begin();
        const PersistedConfig& got = reader.get();

        // Every field reproduced exactly.
        RC_ASSERT(got.magic == original.magic);
        RC_ASSERT(got.version == original.version);
        RC_ASSERT(std::string(got.wifi_ssid) ==
                  std::string(original.wifi_ssid));
        RC_ASSERT(std::string(got.wifi_password) ==
                  std::string(original.wifi_password));
        RC_ASSERT(got.backlash_x_steps == original.backlash_x_steps);
        RC_ASSERT(got.backlash_y_steps == original.backlash_y_steps);
        RC_ASSERT(got.mm_per_rev_x == original.mm_per_rev_x);
        RC_ASSERT(got.mm_per_rev_y == original.mm_per_rev_y);
        RC_ASSERT(got.logical_pos_x == original.logical_pos_x);
        RC_ASSERT(got.logical_pos_y == original.logical_pos_y);

        // Flags compared with the always-cleared unclean bit masked out.
        const std::uint8_t mask =
            static_cast<std::uint8_t>(~NVM_FLAG_UNCLEAN);
        RC_ASSERT((got.flags & mask) == (original.flags & mask));

        // begin() never reports unclean for a record stored with the bit
        // clear, and never leaves the unclean bit set in the cache.
        RC_ASSERT(!reader.wasUncleanShutdown());
        RC_ASSERT((got.flags & NVM_FLAG_UNCLEAN) == 0u);
      }));
}

// ---------------------------------------------------------------------------
// Property 13 (part 2): single-byte corruption in the CRC-covered range
// yields the documented defaults.
// ---------------------------------------------------------------------------
//
// For an arbitrary single-byte corruption at an arbitrary offset within the
// CRC-covered range [0, 128) of a previously-valid record, a fresh begin()
// returns the documented defaults. XORing the chosen byte with a non-zero
// mask guarantees the byte actually changes, so the stored CRC (computed
// over the pristine bytes) can no longer match -- a single-byte (8-bit
// burst) error is always detected by CRC-32 -- and the magic/version checks
// likewise fail when the corruption lands in those fields. Either way the
// loader must fall through to defaults.
//
// Validates: Requirements 13.10 (default backlash 0 when no valid record).
TEST_CASE("Property 13: corrupted CRC-covered byte falls back to defaults",
          "[nvm][property][property-13]") {
  REQUIRE(rc::check(
      "single-byte corruption in [0,128) -> documented defaults", [] {
        const PersistedConfig valid = genValidConfig();

        FakeBackend backend;
        backend.writeRaw(valid);

        // Choose a byte in the CRC-covered range and flip at least one bit.
        const std::size_t offset = static_cast<std::size_t>(
            *rc::gen::inRange<int>(0, static_cast<int>(NVM_RECORD_CRC_RANGE)));
        const std::uint8_t flip =
            static_cast<std::uint8_t>(*rc::gen::inRange(1, 256));  // 1..255
        backend.raw()[offset] ^= flip;

        FakeClock::now_ms = 0;
        NVMManager m(backend, &FakeClock::read);
        m.begin();

        expectDefaults(m.get());
        // An invalid record never reports unclean shutdown.
        RC_ASSERT(!m.wasUncleanShutdown());
      }));
}

// ---------------------------------------------------------------------------
// Property 13 (part 3): bad magic yields the documented defaults.
// ---------------------------------------------------------------------------
//
// For an arbitrary magic value != NVM_MAGIC written into the first 4 bytes,
// with the trailing CRC-32 recomputed so ONLY the magic is wrong, begin()
// returns the documented defaults. This isolates the magic check from the
// CRC check (the record is otherwise byte-consistent).
//
// Validates: Requirements 13.10.
TEST_CASE("Property 13: bad magic falls back to defaults",
          "[nvm][property][property-13]") {
  REQUIRE(rc::check("magic != NVM_MAGIC (valid CRC) -> documented defaults",
                    [] {
                      PersistedConfig c = genValidConfig();

                      // Force a magic value that is guaranteed not to equal
                      // the expected magic.
                      std::uint32_t bad_magic =
                          *rc::gen::arbitrary<std::uint32_t>();
                      if (bad_magic == NVM_MAGIC) {
                        bad_magic ^= 0x1u;
                      }
                      c.magic = bad_magic;
                      // Recompute the CRC so the record is internally
                      // consistent and only the magic check can fail.
                      sealCrc(c);

                      FakeBackend backend;
                      backend.writeRaw(c);

                      FakeClock::now_ms = 0;
                      NVMManager m(backend, &FakeClock::read);
                      m.begin();

                      expectDefaults(m.get());
                      RC_ASSERT(!m.wasUncleanShutdown());
                    }));
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
