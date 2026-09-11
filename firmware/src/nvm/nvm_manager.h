// NVMManager - owns the single PersistedConfig record in EEPROM emulation.
//
// Responsibilities (Design §3.2.7):
//   * Read the 132-byte record at offset 0 on begin(), validate magic / version
//     / trailing CRC-32. On any failure, surface documented defaults.
//   * Cache a hot copy in RAM. mutate() applies a user-supplied edit and marks
//     the cache dirty. flushIfDue() is the only path that issues an actual
//     EEPROM commit; writes are debounced to NVM_WRITE_DEBOUNCE_MS (250 ms)
//     to limit flash wear (Design §4.4, Requirement 10.6).
//   * Track the unclean-shutdown marker so the firmware can surface it through
//     wasUncleanShutdown() (Requirement 10.12). begin() always clears the
//     in-memory unclean flag and queues a write so the very next mid-drawing
//     markBusy() flips it back to "in flight".
//
// The class is intentionally backend-agnostic so the same logic compiles for
// both `framework = arduino` (with an EEPROM-backed adapter linked in via a
// separate translation unit, see nvm_arduino_backend.{h,cpp}) and
// `platform = native` host tests (with an in-memory backend supplied by the
// test fixture).

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

#include "../types.h"

namespace etch {
namespace nvm {

// Storage abstraction for the 132-byte PersistedConfig record. Implementations
// MUST treat the buffer as opaque bytes and MUST persist the full
// NVM_RECORD_SIZE atomically per call.
class NVMBackend {
 public:
  virtual ~NVMBackend() = default;

  // Read NVM_RECORD_SIZE bytes from offset NVM_RECORD_OFFSET into `out`.
  // If the underlying storage is uninitialised, implementations SHOULD return
  // 0xFF bytes (matching erased flash) so the magic / CRC checks fail and
  // NVMManager falls through to defaults.
  virtual void readRecord(std::uint8_t* out, std::size_t len) = 0;

  // Write NVM_RECORD_SIZE bytes from `in` to offset NVM_RECORD_OFFSET. The
  // caller has already populated the trailing CRC-32, so this is a pure
  // byte-for-byte commit. Implementations are responsible for any required
  // commit / flush semantics on their backing store.
  virtual void writeRecord(const std::uint8_t* in, std::size_t len) = 0;
};

class NVMManager {
 public:
  // Monotonic millisecond clock. On Arduino this is `millis`; the host test
  // fixture supplies a fake clock so debounce timing can be exercised
  // deterministically.
  using Clock = std::uint32_t (*)();

  NVMManager(NVMBackend& backend, Clock clock);

  // Read and validate the stored record, populate the in-memory cache,
  // capture the unclean-shutdown marker, then clear the unclean flag in the
  // cache and mark it dirty so the next flushIfDue() rewrites the record.
  // When wasUncleanShutdown() would return true, also clears
  // NVM_FLAG_CALIBRATED in the cache (Requirement 10.12 / Design §4.4):
  // the stored logical position is retained only as a hint and the user
  // must verify or re-declare home before any drawing can begin.
  // Idempotent: calling begin() twice re-reads from the backend.
  void begin();

  // Read-only view of the cached record.
  const PersistedConfig& get() const { return cfg_; }

  // Apply a user-supplied edit to the cached record and mark it dirty. The
  // mutation is not visible on the backing store until a subsequent
  // flushIfDue() (or, equivalently, on the next boot if a write is pending
  // when power is removed).
  void mutate(std::function<void(PersistedConfig&)> fn);

  // If the cache is dirty AND either no write has happened yet OR at least
  // NVM_WRITE_DEBOUNCE_MS have elapsed since the last write, recompute the
  // trailing CRC-32 and commit the record to the backend. Otherwise this is
  // a no-op. Intended to be called every iteration of the cooperative main
  // loop (see Design §3.2.7).
  void flushIfDue();

  // True if the record loaded at begin() had NVM_FLAG_UNCLEAN set. The value
  // is captured before the in-memory copy is cleared, so calling
  // markCleanIdle() / markBusy() after begin() does not change this flag.
  // (Requirement 10.12.) Returns false if begin() has not been called or if
  // the stored record was invalid (defaults loaded).
  bool wasUncleanShutdown() const { return was_unclean_shutdown_; }

  // Clear NVM_FLAG_UNCLEAN in the cache and mark dirty. Call after a drawing
  // completes and the buffer drains (Design §4.4).
  void markCleanIdle();

  // Set NVM_FLAG_UNCLEAN in the cache and mark dirty. Call before any motion
  // command is accepted (Design §4.4).
  void markBusy();

  // Whether the cache currently differs from what was last written. Exposed
  // for diagnostics and for tests; production code MUST go through
  // flushIfDue().
  bool isDirty() const { return dirty_; }

  // CRC-32/ISO-HDLC (a.k.a. zlib / PNG): poly 0xEDB88320 (reflected),
  // init 0xFFFFFFFF, reflected input/output, final XOR 0xFFFFFFFF.
  // Catalogue check: crc32("123456789") == 0xCBF43926.
  // Exposed publicly because the algorithm is generic and the test fixture
  // needs it to recompute CRCs after deliberately corrupting bytes.
  static std::uint32_t crc32(const std::uint8_t* data, std::size_t len);

 private:
  NVMBackend& backend_;
  Clock clock_;
  PersistedConfig cfg_;
  bool dirty_;
  bool ever_written_;
  bool was_unclean_shutdown_;
  std::uint32_t last_write_ms_;

  // Read the 132-byte record from the backend, validate magic + version +
  // trailing CRC-32. On success, populate cfg_ and return true. On any
  // validation failure, leave cfg_ untouched and return false.
  bool readAndValidate_();

  // Populate cfg_ with the documented defaults (Design §4.4).
  void loadDefaults_();

  // Serialise cfg_ into a 132-byte buffer with a freshly computed trailing
  // CRC-32 and hand it to backend_.writeRecord(). Updates cfg_.record_crc32
  // so the in-memory copy stays consistent with what was just persisted.
  void writeRecord_();
};

}  // namespace nvm
}  // namespace etch
