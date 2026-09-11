// NVMManager implementation. See nvm_manager.h for the full contract.
//
// CRC-32 (ISO-HDLC / zlib / PNG):
//   poly       : 0xEDB88320 (reflected form of 0x04C11DB7)
//   init       : 0xFFFFFFFF
//   reflected  : input bytes are processed LSB-first; the residue is
//                kept in reflected form throughout
//   final XOR  : 0xFFFFFFFF
//   check      : crc32("123456789") == 0xCBF43926
//
// A 256-entry table is built once on first use to keep per-byte cost cheap
// while still avoiding a static initializer in flash. The table lives in
// static storage with a one-time guard, which is safe in the firmware's
// single-threaded cooperative loop and in single-threaded host tests.

#include "nvm_manager.h"

#include <cstring>

namespace etch {
namespace nvm {

namespace {

// CRC-32/ISO-HDLC lookup table. Lazily populated on first use.
struct Crc32Table {
  std::uint32_t entries[256];
  bool ready;
};

Crc32Table& crc32_table() {
  static Crc32Table table{{}, false};
  if (!table.ready) {
    for (std::uint32_t i = 0; i < 256; ++i) {
      std::uint32_t c = i;
      for (int k = 0; k < 8; ++k) {
        c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
      }
      table.entries[i] = c;
    }
    table.ready = true;
  }
  return table;
}

// Documented defaults (Design §4.4). Returned on bad magic, bad CRC, or
// version mismatch. The structure is built field-by-field so the packed
// padding bytes (_pad0, _pad1, reserved) end up well-defined zeros and the
// CRC computed over the resulting bytes is reproducible.
void buildDefaults(PersistedConfig& out) {
  std::memset(&out, 0, sizeof(out));
  out.magic = NVM_MAGIC;
  out.version = NVM_VERSION;
  out.reserved = 0;
  // wifi_ssid / wifi_password remain all-zero (i.e. empty C strings).
  out.backlash_x_steps = 0;
  out.backlash_y_steps = 0;
  out.mm_per_rev_x = DEFAULT_MM_PER_REV;
  out.mm_per_rev_y = DEFAULT_MM_PER_REV;
  out.logical_pos_x = 0;
  out.logical_pos_y = 0;
  out.envelope_x_steps = 0;  // envelope absent until Visual_Calibration (Req 5.2, 5.3)
  out.envelope_y_steps = 0;
  out.flags = 0;  // calibrated cleared, unclean cleared, envelope-calibrated cleared
  out._pad0 = 0;
  out._pad1 = 0;
  out.record_crc32 = 0;  // recomputed on write
}

}  // namespace

NVMManager::NVMManager(NVMBackend& backend, Clock clock)
    : backend_(backend),
      clock_(clock),
      cfg_{},
      dirty_(false),
      ever_written_(false),
      was_unclean_shutdown_(false),
      last_write_ms_(0) {
  buildDefaults(cfg_);
}

void NVMManager::begin() {
  was_unclean_shutdown_ = false;
  if (!readAndValidate_()) {
    // Bad magic, bad version, or bad CRC: surface defaults and queue a write
    // so the next flushIfDue() initialises the backing store.
    loadDefaults_();
    dirty_ = true;
    return;
  }

  // Capture the unclean marker as it sat on the backing store before this
  // boot, then unconditionally clear it in the cache. Queue a write so the
  // sanitised record (unclean = 0) is committed at the next debounce window.
  was_unclean_shutdown_ = (cfg_.flags & NVM_FLAG_UNCLEAN) != 0;
  cfg_.flags = static_cast<std::uint8_t>(cfg_.flags & ~NVM_FLAG_UNCLEAN);
  // Per Requirement 10.12 and Design §4.4: on an unclean boot the firmware
  // MUST clear the "position calibrated" flag and retain the stored logical
  // position only as a hint, so the user is required to verify or re-declare
  // home before any drawing can begin. (logical_pos_x / logical_pos_y are
  // intentionally left untouched.)
  if (was_unclean_shutdown_) {
    cfg_.flags =
        static_cast<std::uint8_t>(cfg_.flags & ~NVM_FLAG_CALIBRATED);
  }
  dirty_ = true;
}

void NVMManager::mutate(std::function<void(PersistedConfig&)> fn) {
  fn(cfg_);
  // Keep the magic / version invariants intact regardless of what the
  // mutator wrote, so a buggy caller cannot corrupt the record.
  cfg_.magic = NVM_MAGIC;
  cfg_.version = NVM_VERSION;
  dirty_ = true;
}

void NVMManager::flushIfDue() {
  if (!dirty_) {
    return;
  }
  if (ever_written_) {
    const std::uint32_t now = clock_();
    const std::uint32_t elapsed = now - last_write_ms_;
    if (elapsed < NVM_WRITE_DEBOUNCE_MS) {
      return;
    }
  }
  writeRecord_();
}

void NVMManager::markCleanIdle() {
  cfg_.flags = static_cast<std::uint8_t>(cfg_.flags & ~NVM_FLAG_UNCLEAN);
  dirty_ = true;
}

void NVMManager::markBusy() {
  cfg_.flags = static_cast<std::uint8_t>(cfg_.flags | NVM_FLAG_UNCLEAN);
  dirty_ = true;
}

bool NVMManager::readAndValidate_() {
  std::uint8_t buf[NVM_RECORD_SIZE];
  backend_.readRecord(buf, NVM_RECORD_SIZE);

  PersistedConfig candidate;
  std::memcpy(&candidate, buf, NVM_RECORD_SIZE);

  if (candidate.magic != NVM_MAGIC) {
    return false;
  }
  if (candidate.version != NVM_VERSION) {
    return false;
  }
  const std::uint32_t computed = crc32(buf, NVM_RECORD_CRC_RANGE);
  if (computed != candidate.record_crc32) {
    return false;
  }

  cfg_ = candidate;
  return true;
}

void NVMManager::loadDefaults_() {
  buildDefaults(cfg_);
}

void NVMManager::writeRecord_() {
  // Recompute the CRC over the packed bytes [0..136) of the current cache.
  std::uint8_t buf[NVM_RECORD_SIZE];
  std::memcpy(buf, &cfg_, NVM_RECORD_SIZE);
  const std::uint32_t crc = crc32(buf, NVM_RECORD_CRC_RANGE);
  cfg_.record_crc32 = crc;
  std::memcpy(buf + NVM_RECORD_CRC_RANGE, &crc, sizeof(crc));

  backend_.writeRecord(buf, NVM_RECORD_SIZE);

  dirty_ = false;
  ever_written_ = true;
  last_write_ms_ = clock_();
}

std::uint32_t NVMManager::crc32(const std::uint8_t* data, std::size_t len) {
  const Crc32Table& t = crc32_table();
  std::uint32_t crc = 0xFFFFFFFFu;
  for (std::size_t i = 0; i < len; ++i) {
    const std::uint8_t idx = static_cast<std::uint8_t>((crc ^ data[i]) & 0xFFu);
    crc = (crc >> 8) ^ t.entries[idx];
  }
  return crc ^ 0xFFFFFFFFu;
}

}  // namespace nvm
}  // namespace etch
