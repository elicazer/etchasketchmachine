// Host-side property test for NVMManager unclean-shutdown behaviour.
//
// Task 2.4 / Property 15 (Design §7, §4.4):
//
//   *For any* PersistedConfig loaded with flags.unclean_shutdown == 1, the
//   post-boot in-RAM state has calibrated = false, unclean_shutdown = 0
//   (cleared after read), and logical_pos == previous logical_pos (retained
//   as a hint). No drawing may proceed until the user verifies or re-declares
//   home.
//
//   **Validates: Requirements 10.12**
//
// This translation unit is self-contained and lives in its own PlatformIO
// test environment directory (test_nvm_unclean/), so it pulls the NVMManager
// implementation in directly via a relative include (matching the convention
// in test_nvm/test_nvm.cpp) and supplies its own `int main` running a
// Catch2 v3 session. Because it is a separate test binary from test_nvm/,
// there is no ODR conflict from including nvm_manager.cpp here as well.
//
// Properties are expressed with rapidcheck's rc::check inside Catch2
// TEST_CASEs; rapidcheck draws inputs with the `*` operator on its
// generators and shrinks any counterexample automatically. Run with:
//
//     pio test -e host_test
//
// (PlatformIO fetches Catch2 v3.5.3 and rapidcheck per platformio.ini
// lib_deps for the host_test environment.)

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <rapidcheck.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <string>

#include "../../src/types.h"
#include "../../src/nvm/nvm_manager.h"
#include "../../src/nvm/nvm_manager.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::PersistedConfig;
using etch::NVM_FLAG_CALIBRATED;
using etch::NVM_FLAG_UNCLEAN;
using etch::NVM_MAGIC;
using etch::NVM_RECORD_CRC_RANGE;
using etch::NVM_RECORD_SIZE;
using etch::NVM_VERSION;
using etch::NVM_WRITE_DEBOUNCE_MS;
using etch::DEFAULT_MM_PER_REV;
using etch::nvm::NVMBackend;
using etch::nvm::NVMManager;

namespace {

// In-memory backend that simulates erased flash (all-0xFF) and commits the
// full record atomically. Mirrors the FakeBackend used in test_nvm.cpp but
// is local to this TU so the two test binaries stay independent.
class FakeBackend final : public NVMBackend {
 public:
  FakeBackend() { storage_.fill(0xFF); }

  void readRecord(std::uint8_t* out, std::size_t len) override {
    REQUIRE(len == NVM_RECORD_SIZE);
    std::memcpy(out, storage_.data(), len);
  }

  void writeRecord(const std::uint8_t* in, std::size_t len) override {
    REQUIRE(len == NVM_RECORD_SIZE);
    std::memcpy(storage_.data(), in, len);
    ++write_count_;
  }

  std::uint8_t* raw() { return storage_.data(); }
  const std::uint8_t* raw() const { return storage_.data(); }
  std::size_t writes() const { return write_count_; }

 private:
  std::array<std::uint8_t, NVM_RECORD_SIZE> storage_;
  std::size_t write_count_ = 0;
};

// Manually advanced fake clock so debounce timing is deterministic.
struct FakeClock {
  static std::uint32_t now_ms;
  static std::uint32_t read() { return now_ms; }
};
std::uint32_t FakeClock::now_ms = 0;

// Build an otherwise-valid PersistedConfig (correct magic / version, packed
// padding zeroed) with the supplied flags byte (written at offset 126),
// logical position, and backlash, then recompute the trailing CRC-32 over
// bytes [0..128) so it passes NVMManager's readAndValidate_(). The fully
// formed record is committed byte-for-byte to the backend's storage.
void writeValidRecord(FakeBackend& backend, std::uint8_t flags,
                      std::int32_t pos_x, std::int32_t pos_y,
                      std::uint16_t backlash_x, std::uint16_t backlash_y) {
  PersistedConfig c{};
  std::memset(&c, 0, sizeof(c));  // well-defined padding for a reproducible CRC
  c.magic = NVM_MAGIC;
  c.version = NVM_VERSION;
  c.reserved = 0;
  // WiFi credentials left as empty C strings; not relevant to this property.
  c.backlash_x_steps = backlash_x;
  c.backlash_y_steps = backlash_y;
  c.mm_per_rev_x = DEFAULT_MM_PER_REV;
  c.mm_per_rev_y = DEFAULT_MM_PER_REV;
  c.logical_pos_x = pos_x;
  c.logical_pos_y = pos_y;
  c.flags = flags;  // PersistedConfig::flags lives at offset 126 (Design §4.4)
  c._pad0 = 0;
  c._pad1 = 0;

  std::uint8_t buf[NVM_RECORD_SIZE];
  std::memcpy(buf, &c, NVM_RECORD_SIZE);
  const std::uint32_t crc = NVMManager::crc32(buf, NVM_RECORD_CRC_RANGE);
  std::memcpy(buf + NVM_RECORD_CRC_RANGE, &crc, sizeof(crc));

  std::memcpy(backend.raw(), buf, NVM_RECORD_SIZE);
}

}  // namespace

// ---------------------------------------------------------------------------
// Property 15: Unclean shutdown clears calibration and retains hint.
// ---------------------------------------------------------------------------
//
// For an arbitrary stored record that is otherwise valid with
// NVM_FLAG_UNCLEAN set, an arbitrary calibrated bit, and an arbitrary
// (bounded i32) logical position, a fresh begin() must yield:
//   * wasUncleanShutdown() == true
//   * the calibrated bit cleared in the cache (Req 10.12)
//   * the unclean bit cleared in the cache
//   * logical_pos_{x,y} unchanged from what was stored (retained as a hint)
// and, after flushIfDue() past the debounce window, the sanitised flags reach
// the backing store while the position is still retained. A subsequent boot
// from the now-clean record reports wasUncleanShutdown() == false.
//
// **Validates: Requirements 10.12**
TEST_CASE(
    "Property 15: unclean shutdown clears calibration and retains position hint",
    "[nvm][unclean][property][property-15]") {
  const bool ok = rc::check(
      "unclean boot: calibrated cleared, unclean cleared, position retained",
      [] {
        const std::int32_t pos_x = *rc::gen::arbitrary<std::int32_t>();
        const std::int32_t pos_y = *rc::gen::arbitrary<std::int32_t>();
        // The property must hold whether or not the device was calibrated
        // before the unclean shutdown.
        const bool was_calibrated = *rc::gen::arbitrary<bool>();
        const std::uint16_t backlash_x =
            static_cast<std::uint16_t>(*rc::gen::inRange(0, 201));
        const std::uint16_t backlash_y =
            static_cast<std::uint16_t>(*rc::gen::inRange(0, 201));

        std::uint8_t flags = NVM_FLAG_UNCLEAN;
        if (was_calibrated) {
          flags = static_cast<std::uint8_t>(flags | NVM_FLAG_CALIBRATED);
        }

        FakeBackend backend;
        writeValidRecord(backend, flags, pos_x, pos_y, backlash_x, backlash_y);

        FakeClock::now_ms = 0;
        NVMManager m(backend, &FakeClock::read);
        m.begin();

        // (1) The unclean marker is surfaced.
        RC_ASSERT(m.wasUncleanShutdown());

        const PersistedConfig& c = m.get();
        // (2) Calibrated cleared in the in-memory cache regardless of prior
        //     value (Req 10.12).
        RC_ASSERT((c.flags & NVM_FLAG_CALIBRATED) == 0u);
        // (3) Unclean cleared in the in-memory cache.
        RC_ASSERT((c.flags & NVM_FLAG_UNCLEAN) == 0u);
        // (4) Logical position retained verbatim as a hint.
        RC_ASSERT(c.logical_pos_x == pos_x);
        RC_ASSERT(c.logical_pos_y == pos_y);
        // Other persisted fields untouched.
        RC_ASSERT(c.backlash_x_steps == backlash_x);
        RC_ASSERT(c.backlash_y_steps == backlash_y);
        RC_ASSERT(c.magic == NVM_MAGIC);
        RC_ASSERT(c.version == NVM_VERSION);
        // begin() queues a write so the sanitised flags will be committed.
        RC_ASSERT(m.isDirty());

        // After a flush past the debounce window, the on-disk record reflects
        // unclean=0 AND calibrated=0, with the position still retained.
        FakeClock::now_ms = NVM_WRITE_DEBOUNCE_MS;
        m.flushIfDue();
        PersistedConfig stored{};
        std::memcpy(&stored, backend.raw(), sizeof(stored));
        RC_ASSERT((stored.flags & NVM_FLAG_UNCLEAN) == 0u);
        RC_ASSERT((stored.flags & NVM_FLAG_CALIBRATED) == 0u);
        RC_ASSERT(stored.logical_pos_x == pos_x);
        RC_ASSERT(stored.logical_pos_y == pos_y);

        // The unclean marker was one-shot state: a second boot from the now
        // clean record reports wasUncleanShutdown() == false and keeps
        // calibrated cleared and the position retained.
        FakeClock::now_ms = NVM_WRITE_DEBOUNCE_MS + 10;
        NVMManager m2(backend, &FakeClock::read);
        m2.begin();
        RC_ASSERT(!m2.wasUncleanShutdown());
        RC_ASSERT((m2.get().flags & NVM_FLAG_UNCLEAN) == 0u);
        RC_ASSERT((m2.get().flags & NVM_FLAG_CALIBRATED) == 0u);
        RC_ASSERT(m2.get().logical_pos_x == pos_x);
        RC_ASSERT(m2.get().logical_pos_y == pos_y);
      });
  REQUIRE(ok);
}

// ---------------------------------------------------------------------------
// Property 15 (contrapositive): a CLEAN stored record must NOT trigger the
// unclean-boot path.
// ---------------------------------------------------------------------------
//
// For an arbitrary otherwise-valid record with NVM_FLAG_UNCLEAN clear and an
// arbitrary calibrated bit, begin() must yield wasUncleanShutdown() == false
// and PRESERVE the calibrated bit (and the logical position). This guards
// against an implementation that clears calibrated unconditionally on every
// boot, which would still pass the unclean-case property above.
//
// **Validates: Requirements 10.12**
TEST_CASE(
    "Property 15 contrapositive: clean boot preserves calibration and position",
    "[nvm][unclean][property][property-15]") {
  const bool ok = rc::check(
      "clean boot: unclean=false reported, calibrated and position preserved",
      [] {
        const std::int32_t pos_x = *rc::gen::arbitrary<std::int32_t>();
        const std::int32_t pos_y = *rc::gen::arbitrary<std::int32_t>();
        const bool calibrated = *rc::gen::arbitrary<bool>();

        std::uint8_t flags = 0;  // NVM_FLAG_UNCLEAN intentionally clear
        if (calibrated) {
          flags = static_cast<std::uint8_t>(flags | NVM_FLAG_CALIBRATED);
        }

        FakeBackend backend;
        writeValidRecord(backend, flags, pos_x, pos_y, 0, 0);

        FakeClock::now_ms = 0;
        NVMManager m(backend, &FakeClock::read);
        m.begin();

        RC_ASSERT(!m.wasUncleanShutdown());
        const PersistedConfig& c = m.get();
        // Calibrated must be preserved exactly across a clean boot.
        RC_ASSERT((c.flags & NVM_FLAG_CALIBRATED)
                  == (flags & NVM_FLAG_CALIBRATED));
        // Unclean was already clear; nothing to clear.
        RC_ASSERT((c.flags & NVM_FLAG_UNCLEAN) == 0u);
        // Position retained verbatim.
        RC_ASSERT(c.logical_pos_x == pos_x);
        RC_ASSERT(c.logical_pos_y == pos_y);
      });
  REQUIRE(ok);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
