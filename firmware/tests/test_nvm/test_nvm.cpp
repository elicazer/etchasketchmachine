// Host-side tests for NVMManager (Task 2.1).
//
// Validates the contract laid out in Design §3.2.7 and §4.4:
//   * defaults returned on bad magic
//   * defaults returned on bad CRC (mutate one byte after a successful write,
//     re-read)
//   * round-trip after mutate + flushIfDue
//   * debounced write interval (NVM_WRITE_DEBOUNCE_MS = 250 ms)
//   * wasUncleanShutdown() is true iff the stored record had NVM_FLAG_UNCLEAN
//     set at begin()
//   * markCleanIdle() / markBusy() round-trip
//
// These are unit tests, not property tests; the property tests for round-trip
// behaviour and corruption defaults live in a sibling task (2.2). The host
// build pulls the implementation in directly via relative include so the
// test environment in platformio.ini (test_build_src = no) stays self-
// contained.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstring>
#include <string>

#include "../../src/types.h"
#include "../../src/nvm/nvm_manager.h"
#include "../../src/nvm/nvm_manager.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::PersistedConfig;
using etch::NVM_FLAG_CALIBRATED;
using etch::NVM_FLAG_ENVELOPE_CALIBRATED;
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

// In-memory backend that simulates erased flash (all-0xFF) and records the
// number of writes that have been issued so debounce behaviour can be
// asserted directly.
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

  // Direct access for test plumbing.
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

}  // namespace

// crc32 is a public static on NVMManager; no shim needed.

TEST_CASE("crc32 catalogue check vector", "[nvm][crc32]") {
  const std::uint8_t input[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
  // CRC-32/ISO-HDLC check value from the catalogue at
  // https://reveng.sourceforge.io/crc-catalogue/all.htm
  REQUIRE(etch::nvm::NVMManager::crc32(input, sizeof(input))
          == 0xCBF43926u);
}

TEST_CASE("begin() returns documented defaults on erased flash (bad magic)",
          "[nvm][defaults]") {
  FakeBackend backend;  // all-0xFF backing store
  FakeClock::now_ms = 0;
  NVMManager m(backend, &FakeClock::read);

  m.begin();

  const PersistedConfig& cfg = m.get();
  CHECK(cfg.magic == NVM_MAGIC);
  CHECK(cfg.version == NVM_VERSION);
  CHECK(cfg.wifi_ssid[0] == '\0');
  CHECK(cfg.wifi_password[0] == '\0');
  CHECK(cfg.backlash_x_steps == 0);
  CHECK(cfg.backlash_y_steps == 0);
  CHECK(cfg.mm_per_rev_x == DEFAULT_MM_PER_REV);
  CHECK(cfg.mm_per_rev_y == DEFAULT_MM_PER_REV);
  CHECK(cfg.logical_pos_x == 0);
  CHECK(cfg.logical_pos_y == 0);
  CHECK((cfg.flags & NVM_FLAG_CALIBRATED) == 0u);
  CHECK((cfg.flags & NVM_FLAG_UNCLEAN) == 0u);

  // begin() with invalid storage should NOT report unclean shutdown.
  CHECK_FALSE(m.wasUncleanShutdown());
  // It SHOULD queue a write so the next flush sanitises the backing store.
  CHECK(m.isDirty());
}

TEST_CASE("begin() returns defaults on bad CRC", "[nvm][defaults]") {
  FakeBackend backend;
  FakeClock::now_ms = 0;

  // Seed with a valid record, then corrupt one byte in the CRC-covered range
  // and re-instantiate so begin() re-reads from the (now-broken) backing
  // store.
  {
    NVMManager seed(backend, &FakeClock::read);
    seed.begin();
    seed.mutate([](PersistedConfig& c) {
      c.backlash_x_steps = 42;
      c.logical_pos_x = 1234;
      c.flags |= NVM_FLAG_CALIBRATED;
    });
    seed.flushIfDue();
  }

  // Corrupt one of the CRC-covered bytes (offset 110 = mm_per_rev_x).
  backend.raw()[110] ^= 0x01;

  FakeClock::now_ms = 1000;
  NVMManager m(backend, &FakeClock::read);
  m.begin();

  const PersistedConfig& cfg = m.get();
  // Defaults: backlash and position fall back to zero, calibrated cleared.
  CHECK(cfg.backlash_x_steps == 0);
  CHECK(cfg.logical_pos_x == 0);
  CHECK((cfg.flags & NVM_FLAG_CALIBRATED) == 0u);
  CHECK_FALSE(m.wasUncleanShutdown());
}

TEST_CASE("begin() returns defaults on version mismatch", "[nvm][defaults]") {
  FakeBackend backend;
  FakeClock::now_ms = 0;

  // Seed valid record, then bump the version field and recompute the CRC so
  // only the version check fails.
  {
    NVMManager seed(backend, &FakeClock::read);
    seed.begin();
    seed.mutate([](PersistedConfig& c) { c.backlash_x_steps = 7; });
    seed.flushIfDue();
  }
  // Replace version with 0xBEEF and recompute the trailing CRC.
  std::uint16_t bad_ver = 0xBEEFu;
  std::memcpy(backend.raw() + 4, &bad_ver, sizeof(bad_ver));
  const std::uint32_t crc =
      etch::nvm::NVMManager::crc32(backend.raw(), NVM_RECORD_CRC_RANGE);
  std::memcpy(backend.raw() + NVM_RECORD_CRC_RANGE, &crc, sizeof(crc));

  FakeClock::now_ms = 1000;
  NVMManager m(backend, &FakeClock::read);
  m.begin();

  CHECK(m.get().backlash_x_steps == 0);
  CHECK(m.get().version == NVM_VERSION);  // restored to current version
}

TEST_CASE("mutate + flushIfDue persists, re-load round-trips",
          "[nvm][round_trip]") {
  FakeBackend backend;
  FakeClock::now_ms = 0;

  {
    NVMManager m(backend, &FakeClock::read);
    m.begin();
    m.mutate([](PersistedConfig& c) {
      std::strcpy(c.wifi_ssid, "etchnet");
      std::strcpy(c.wifi_password, "supersecret123");
      c.backlash_x_steps = 12;
      c.backlash_y_steps = 9;
      c.mm_per_rev_x = 99.5f;
      c.mm_per_rev_y = 100.25f;
      c.logical_pos_x = -250;
      c.logical_pos_y = 4096;
      c.flags |= NVM_FLAG_CALIBRATED;
    });
    m.flushIfDue();
    REQUIRE(backend.writes() == 1u);
  }

  // Fresh manager re-reads the same backing store.
  FakeClock::now_ms = 100000;
  NVMManager fresh(backend, &FakeClock::read);
  fresh.begin();
  const PersistedConfig& c = fresh.get();
  CHECK(std::string(c.wifi_ssid) == "etchnet");
  CHECK(std::string(c.wifi_password) == "supersecret123");
  CHECK(c.backlash_x_steps == 12);
  CHECK(c.backlash_y_steps == 9);
  CHECK(c.mm_per_rev_x == 99.5f);
  CHECK(c.mm_per_rev_y == 100.25f);
  CHECK(c.logical_pos_x == -250);
  CHECK(c.logical_pos_y == 4096);
  CHECK((c.flags & NVM_FLAG_CALIBRATED) != 0u);
  // begin() always clears unclean in memory regardless of input.
  CHECK((c.flags & NVM_FLAG_UNCLEAN) == 0u);
  CHECK_FALSE(fresh.wasUncleanShutdown());
}

TEST_CASE("flushIfDue is debounced to NVM_WRITE_DEBOUNCE_MS", "[nvm][debounce]") {
  FakeBackend backend;
  FakeClock::now_ms = 0;
  NVMManager m(backend, &FakeClock::read);

  m.begin();           // queues an initial write (defaults sanitisation)
  m.flushIfDue();      // first write is unconditional (ever_written_ false)
  REQUIRE(backend.writes() == 1u);
  // last_write_ms_ is now 0.

  // A subsequent mutation shortly after the first write must be deferred.
  m.mutate([](PersistedConfig& c) { c.backlash_x_steps = 1; });
  FakeClock::now_ms = 100;  // < 250 ms
  m.flushIfDue();
  CHECK(backend.writes() == 1u);
  CHECK(m.isDirty());

  FakeClock::now_ms = 249;
  m.flushIfDue();
  CHECK(backend.writes() == 1u);

  // At exactly the debounce window we are due.
  FakeClock::now_ms = NVM_WRITE_DEBOUNCE_MS;
  m.flushIfDue();
  CHECK(backend.writes() == 2u);
  CHECK_FALSE(m.isDirty());

  // Repeated flushIfDue with no further mutation must not write again.
  FakeClock::now_ms = 10000;
  m.flushIfDue();
  CHECK(backend.writes() == 2u);

  // Another mutation respects the debounce relative to the last write.
  // last_write_ms_ is still NVM_WRITE_DEBOUNCE_MS (250). The next write is
  // due at last_write_ms_ + NVM_WRITE_DEBOUNCE_MS = 500.
  FakeClock::now_ms = NVM_WRITE_DEBOUNCE_MS + 1;
  m.mutate([](PersistedConfig& c) { c.backlash_x_steps = 2; });
  FakeClock::now_ms = NVM_WRITE_DEBOUNCE_MS + 100;  // 100 ms after last write
  m.flushIfDue();
  CHECK(backend.writes() == 2u);
  FakeClock::now_ms = 2 * NVM_WRITE_DEBOUNCE_MS;
  m.flushIfDue();
  CHECK(backend.writes() == 3u);
}

TEST_CASE("wasUncleanShutdown reflects the stored marker at begin()",
          "[nvm][unclean]") {
  FakeBackend backend;
  FakeClock::now_ms = 0;

  // Seed a record with the unclean flag set.
  {
    NVMManager seed(backend, &FakeClock::read);
    seed.begin();
    seed.mutate([](PersistedConfig& c) {
      c.flags = NVM_FLAG_CALIBRATED | NVM_FLAG_UNCLEAN;
      c.logical_pos_x = 100;
      c.logical_pos_y = 200;
    });
    seed.flushIfDue();
  }

  // Re-load from a fresh manager. begin() must capture unclean=true and
  // clear it in the cache (so a subsequent markBusy still flips the bit
  // back deterministically). It must ALSO clear NVM_FLAG_CALIBRATED per
  // Requirement 10.12 / Design §4.4: on unclean boot the user must
  // re-verify or re-declare home before any drawing may proceed. The
  // logical position is retained as a hint only.
  FakeClock::now_ms = 1000;
  NVMManager m(backend, &FakeClock::read);
  m.begin();
  CHECK(m.wasUncleanShutdown());
  CHECK((m.get().flags & NVM_FLAG_UNCLEAN) == 0u);
  CHECK((m.get().flags & NVM_FLAG_CALIBRATED) == 0u);
  CHECK(m.get().logical_pos_x == 100);
  CHECK(m.get().logical_pos_y == 200);
  CHECK(m.isDirty());

  // After the next flush, the backing store should have unclean cleared
  // AND calibrated cleared.
  FakeClock::now_ms = 1000 + NVM_WRITE_DEBOUNCE_MS;
  m.flushIfDue();
  PersistedConfig stored;
  std::memcpy(&stored, backend.raw(), sizeof(stored));
  CHECK((stored.flags & NVM_FLAG_UNCLEAN) == 0u);
  CHECK((stored.flags & NVM_FLAG_CALIBRATED) == 0u);

  // A second boot from a clean record reports unclean=false.
  FakeClock::now_ms = 2000;
  NVMManager m2(backend, &FakeClock::read);
  m2.begin();
  CHECK_FALSE(m2.wasUncleanShutdown());
}

TEST_CASE("markBusy / markCleanIdle round-trip the unclean flag",
          "[nvm][unclean]") {
  FakeBackend backend;
  FakeClock::now_ms = 0;
  NVMManager m(backend, &FakeClock::read);
  m.begin();
  m.flushIfDue();
  REQUIRE((m.get().flags & NVM_FLAG_UNCLEAN) == 0u);

  m.markBusy();
  CHECK((m.get().flags & NVM_FLAG_UNCLEAN) != 0u);
  CHECK(m.isDirty());

  // Walk past the debounce window so the busy marker actually lands in
  // backing store.
  FakeClock::now_ms = NVM_WRITE_DEBOUNCE_MS;
  m.flushIfDue();
  PersistedConfig snapshot;
  std::memcpy(&snapshot, backend.raw(), sizeof(snapshot));
  CHECK((snapshot.flags & NVM_FLAG_UNCLEAN) != 0u);

  m.markCleanIdle();
  CHECK((m.get().flags & NVM_FLAG_UNCLEAN) == 0u);
  CHECK(m.isDirty());

  FakeClock::now_ms = 2 * NVM_WRITE_DEBOUNCE_MS;
  m.flushIfDue();
  std::memcpy(&snapshot, backend.raw(), sizeof(snapshot));
  CHECK((snapshot.flags & NVM_FLAG_UNCLEAN) == 0u);
}

TEST_CASE("flushIfDue is a no-op when nothing is dirty", "[nvm][debounce]") {
  FakeBackend backend;
  FakeClock::now_ms = 0;
  NVMManager m(backend, &FakeClock::read);
  m.begin();
  m.flushIfDue();
  const std::size_t writes_after_init = backend.writes();

  for (int i = 0; i < 100; ++i) {
    FakeClock::now_ms += 5000;
    m.flushIfDue();
  }
  CHECK(backend.writes() == writes_after_init);
}

// ---------------------------------------------------------------------------
// Visual corner calibration (Task 1.2): envelope defaults + version rejection.
// ---------------------------------------------------------------------------

// A fresh/defaulted record (erased flash -> bad magic) reports an absent
// envelope (0,0) with the ENVELOPE_CALIBRATED flag clear, so the draw gate
// stays engaged until Visual_Calibration runs (Req 5.2, 5.3).
TEST_CASE("begin() defaults report an absent envelope with the gate engaged",
          "[nvm][defaults][envelope]") {
  FakeBackend backend;  // all-0xFF backing store -> bad magic -> defaults
  FakeClock::now_ms = 0;
  NVMManager m(backend, &FakeClock::read);

  m.begin();

  const PersistedConfig& cfg = m.get();
  CHECK(cfg.envelope_x_steps == 0u);
  CHECK(cfg.envelope_y_steps == 0u);
  CHECK((cfg.flags & NVM_FLAG_ENVELOPE_CALIBRATED) == 0u);
  // The composite gate also requires home (CALIBRATED); defaults clear it too.
  CHECK((cfg.flags & NVM_FLAG_CALIBRATED) == 0u);
}

// A stored record carrying the OLD version (1) is rejected to defaults on read:
// the persisted envelope is treated as absent and the gate is engaged, forcing
// re-calibration after a firmware/NVM-version bump (Req 7.5, 5.3).
TEST_CASE("an old (version==1) record is rejected to envelope defaults",
          "[nvm][defaults][envelope][version]") {
  FakeBackend backend;
  FakeClock::now_ms = 0;

  // Seed a fully-calibrated v2 record (home set + envelope captured), so we can
  // prove the rejection is driven purely by the version field and not by a
  // missing envelope.
  {
    NVMManager seed(backend, &FakeClock::read);
    seed.begin();
    seed.mutate([](PersistedConfig& c) {
      c.envelope_x_steps = 12000;
      c.envelope_y_steps = 8000;
      c.flags = static_cast<std::uint8_t>(NVM_FLAG_CALIBRATED |
                                          NVM_FLAG_ENVELOPE_CALIBRATED);
    });
    seed.flushIfDue();
  }

  // Rewrite ONLY the version field to the old value (1) and reseal the CRC so
  // the magic and CRC checks both pass and only the version mismatch trips.
  std::uint16_t old_ver = 1u;
  std::memcpy(backend.raw() + 4, &old_ver, sizeof(old_ver));
  const std::uint32_t crc =
      etch::nvm::NVMManager::crc32(backend.raw(), NVM_RECORD_CRC_RANGE);
  std::memcpy(backend.raw() + NVM_RECORD_CRC_RANGE, &crc, sizeof(crc));

  FakeClock::now_ms = 1000;
  NVMManager m(backend, &FakeClock::read);
  m.begin();

  const PersistedConfig& cfg = m.get();
  // Restored to current version with the envelope treated absent.
  CHECK(cfg.version == NVM_VERSION);
  CHECK(cfg.envelope_x_steps == 0u);
  CHECK(cfg.envelope_y_steps == 0u);
  CHECK((cfg.flags & NVM_FLAG_ENVELOPE_CALIBRATED) == 0u);
  // Gate engaged: home flag is cleared by the defaults too.
  CHECK((cfg.flags & NVM_FLAG_CALIBRATED) == 0u);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
