// Host-side unit tests for StatusReporter (Task 7.3).
//
// Validates the contract from Design §3.2.9 / §4.7 and Requirements 7.4, 10.9,
// 12.2:
//   * cadence: emits at least once per second while drawing (Req 7.4)
//   * cadence: relaxes to the >= 0.2 Hz idle budget when not drawing (Req 12.2)
//   * a controller state change forces a prompt emit (UI tracks transitions)
//   * the serialised payload matches the §4.7 byte layout exactly: offsets,
//     little-endianness, and the position / percent / rssi / sps / state /
//     flags fields (incl. signed values and the zeroed reserved tail)
//   * the emit sink receives a well-formed 16-byte payload
//
// Run with:
//
//     pio test -e host_test
//
// The host_test environment in platformio.ini sets `test_build_src = no`, so
// this translation unit pulls the implementation in directly via a relative
// include to keep the binary self-contained (mirroring test_backlash, test_nvm,
// and test_frame).

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <vector>

#include "../../src/types.h"
#include "../../src/diagnostics/status_reporter.h"
#include "../../src/diagnostics/status_reporter.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::Position;
using etch::diagnostics::StatusReporter;
using etch::diagnostics::StatusSnapshot;
using etch::diagnostics::StatusState;
using etch::diagnostics::STATUS_PAYLOAD_SIZE;
using etch::diagnostics::STATUS_FLAG_CALIBRATED;
using etch::diagnostics::STATUS_FLAG_BUFFER_FULL;
using etch::diagnostics::STATUS_FLAG_ENVELOPE_CALIBRATED;
using etch::diagnostics::STATUS_DRAWING_INTERVAL_MS;
using etch::diagnostics::STATUS_IDLE_INTERVAL_MS;

namespace {

// A captured STATUS payload as handed to the emit sink.
struct Emission {
  std::uint8_t bytes[STATUS_PAYLOAD_SIZE];
  std::size_t  len;
};

// Records every payload the reporter emits so tests can count and inspect them.
class EmitRecorder {
 public:
  StatusReporter::EmitSink sink() {
    return [this](const std::uint8_t* p, std::size_t n) {
      Emission e{};
      e.len = n;
      if (n <= STATUS_PAYLOAD_SIZE && p != nullptr) {
        std::memcpy(e.bytes, p, n);
      }
      emissions_.push_back(e);
    };
  }

  std::size_t count() const { return emissions_.size(); }
  const Emission& last() const { return emissions_.back(); }
  const Emission& at(std::size_t i) const { return emissions_.at(i); }
  void clear() { emissions_.clear(); }

 private:
  std::vector<Emission> emissions_;
};

// ---------------------------------------------------------------------------
// Independent little-endian decoders — a true oracle, not the SUT's own helper.
// ---------------------------------------------------------------------------

std::int32_t readI32LE(const std::uint8_t* p) {
  const std::uint32_t u = static_cast<std::uint32_t>(p[0]) |
                          (static_cast<std::uint32_t>(p[1]) << 8) |
                          (static_cast<std::uint32_t>(p[2]) << 16) |
                          (static_cast<std::uint32_t>(p[3]) << 24);
  return static_cast<std::int32_t>(u);
}

std::uint16_t readU16LE(const std::uint8_t* p) {
  return static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[0]) |
                                    (static_cast<std::uint16_t>(p[1]) << 8));
}

}  // namespace

// ---------------------------------------------------------------------------
// §4.7 byte layout (offsets, little-endian, field placement)
// ---------------------------------------------------------------------------

TEST_CASE("serialize lays out the §4.7 STATUS payload byte-for-byte",
          "[status][layout]") {
  StatusSnapshot snap{};
  snap.logical_x_steps = 0x01020304;   // distinct bytes to catch ordering bugs
  snap.logical_y_steps = -2;           // negative => exercises sign/endianness
  snap.pct_complete = 73;
  snap.rssi_dbm = -67;                 // typical WiFi RSSI (Req 12.2)
  snap.active_sps = 0x0240;            // 576 sps -> bytes 0x40, 0x02
  snap.state = StatusState::Drawing;   // code 1
  snap.flags = STATUS_FLAG_CALIBRATED; // bit0 set

  std::uint8_t buf[STATUS_PAYLOAD_SIZE] = {0};
  const std::size_t n = StatusReporter::serialize(snap, buf, sizeof(buf));
  REQUIRE(n == STATUS_PAYLOAD_SIZE);

  // logical_x_steps @ 0, little-endian.
  CHECK(buf[0] == 0x04);
  CHECK(buf[1] == 0x03);
  CHECK(buf[2] == 0x02);
  CHECK(buf[3] == 0x01);
  CHECK(readI32LE(&buf[0]) == 0x01020304);

  // logical_y_steps @ 4, little-endian, negative.
  CHECK(readI32LE(&buf[4]) == -2);

  // pct_complete @ 8.
  CHECK(buf[8] == 73);

  // rssi_dbm @ 9, signed.
  CHECK(static_cast<std::int8_t>(buf[9]) == -67);

  // active_sps @ 10, little-endian u16.
  CHECK(buf[10] == 0x40);
  CHECK(buf[11] == 0x02);
  CHECK(readU16LE(&buf[10]) == 0x0240);

  // state_code @ 12.
  CHECK(buf[12] == 1);

  // flags @ 13.
  CHECK(buf[13] == STATUS_FLAG_CALIBRATED);

  // reserved @ 14..15 always zero.
  CHECK(buf[14] == 0);
  CHECK(buf[15] == 0);
}

TEST_CASE("serialize encodes each state code per §4.7", "[status][layout]") {
  struct Case { StatusState state; std::uint8_t code; };
  const Case cases[] = {
      {StatusState::Idle, 0},  {StatusState::Drawing, 1},
      {StatusState::Paused, 2}, {StatusState::Fault, 3},
      {StatusState::Stall, 4},  {StatusState::Aborted, 5},
  };
  for (const auto& c : cases) {
    StatusSnapshot snap{};
    snap.state = c.state;
    std::uint8_t buf[STATUS_PAYLOAD_SIZE] = {0};
    REQUIRE(StatusReporter::serialize(snap, buf, sizeof(buf)) ==
            STATUS_PAYLOAD_SIZE);
    CHECK(buf[12] == c.code);
  }
}

TEST_CASE("serialize combines both flag bits", "[status][layout]") {
  StatusSnapshot snap{};
  snap.flags = static_cast<std::uint8_t>(STATUS_FLAG_CALIBRATED |
                                         STATUS_FLAG_BUFFER_FULL);
  std::uint8_t buf[STATUS_PAYLOAD_SIZE] = {0};
  REQUIRE(StatusReporter::serialize(snap, buf, sizeof(buf)) ==
          STATUS_PAYLOAD_SIZE);
  CHECK(buf[13] == 0x03);
}

TEST_CASE("serialize rejects a null or too-small buffer", "[status][layout]") {
  StatusSnapshot snap{};
  std::uint8_t buf[STATUS_PAYLOAD_SIZE] = {0};
  CHECK(StatusReporter::serialize(snap, nullptr, sizeof(buf)) == 0u);
  CHECK(StatusReporter::serialize(snap, buf, STATUS_PAYLOAD_SIZE - 1) == 0u);
}

// ---------------------------------------------------------------------------
// Setters aggregate into the snapshot / serialised payload
// ---------------------------------------------------------------------------

TEST_CASE("setters feed the serialised payload", "[status][aggregate]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());

  reporter.setPosition(Position{1234, -5678});
  reporter.setPercentComplete(42);
  reporter.setRssiDbm(-55);
  reporter.setActiveSps(800);
  reporter.setState(StatusState::Drawing);
  reporter.setCalibrated(true);
  reporter.setBufferFull(true);

  std::uint8_t buf[STATUS_PAYLOAD_SIZE] = {0};
  REQUIRE(reporter.serializePayload(buf, sizeof(buf)) == STATUS_PAYLOAD_SIZE);
  CHECK(readI32LE(&buf[0]) == 1234);
  CHECK(readI32LE(&buf[4]) == -5678);
  CHECK(buf[8] == 42);
  CHECK(static_cast<std::int8_t>(buf[9]) == -55);
  CHECK(readU16LE(&buf[10]) == 800);
  CHECK(buf[12] == 1);  // drawing
  CHECK(buf[13] == 0x03);  // calibrated | buffer_full
}

TEST_CASE("setPercentComplete clamps to 100", "[status][aggregate]") {
  StatusReporter reporter;
  reporter.setPercentComplete(250);
  CHECK(reporter.snapshot().pct_complete == 100);
  reporter.setPercentComplete(0);
  CHECK(reporter.snapshot().pct_complete == 0);
  reporter.setPercentComplete(100);
  CHECK(reporter.snapshot().pct_complete == 100);
}

TEST_CASE("flag setters are independent and idempotent", "[status][aggregate]") {
  StatusReporter reporter;
  reporter.setCalibrated(true);
  CHECK(reporter.flags() == STATUS_FLAG_CALIBRATED);
  reporter.setBufferFull(true);
  CHECK(reporter.flags() == (STATUS_FLAG_CALIBRATED | STATUS_FLAG_BUFFER_FULL));
  // Clearing one leaves the other untouched.
  reporter.setCalibrated(false);
  CHECK(reporter.flags() == STATUS_FLAG_BUFFER_FULL);
  // Idempotent clear.
  reporter.setBufferFull(false);
  reporter.setBufferFull(false);
  CHECK(reporter.flags() == 0);
}

// ---------------------------------------------------------------------------
// Cadence: >= 1 Hz while drawing (Req 7.4)
// ---------------------------------------------------------------------------

TEST_CASE("emits at least once per second while drawing", "[status][cadence]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());
  reporter.setState(StatusState::Drawing);
  reporter.begin();

  // Initial emit on the first tick.
  REQUIRE(reporter.tick(0));
  REQUIRE(rec.count() == 1);

  // Walk a 10 s drawing window in 100 ms steps; assert the gap between
  // successive emissions never exceeds the 1000 ms budget.
  std::uint32_t last_emit_t = 0;
  std::uint32_t max_gap = 0;
  for (std::uint32_t t = 100; t <= 10000; t += 100) {
    const std::size_t before = rec.count();
    if (reporter.tick(t)) {
      max_gap = std::max<std::uint32_t>(max_gap, t - last_emit_t);
      last_emit_t = t;
    }
    (void)before;
  }
  // The largest inter-emit gap respects the >= 1 Hz contract.
  CHECK(max_gap <= STATUS_DRAWING_INTERVAL_MS);
  // Over ~10 s we expect roughly 10 cadence emits plus the initial one.
  CHECK(rec.count() >= 10u);
}

TEST_CASE("does not emit before the drawing interval elapses",
          "[status][cadence]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());
  reporter.setState(StatusState::Drawing);
  reporter.begin();

  REQUIRE(reporter.tick(0));        // initial
  REQUIRE(rec.count() == 1);

  // Just shy of the budget: no new frame.
  CHECK_FALSE(reporter.tick(999));
  CHECK(rec.count() == 1);

  // Exactly at the budget: a frame is due.
  CHECK(reporter.tick(1000));
  CHECK(rec.count() == 2);
}

// ---------------------------------------------------------------------------
// Cadence: relaxed >= 0.2 Hz idle budget (Req 12.2)
// ---------------------------------------------------------------------------

TEST_CASE("emits at the slower idle cadence when idle", "[status][cadence]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());
  reporter.setState(StatusState::Idle);
  reporter.begin();

  REQUIRE(reporter.tick(0));  // initial
  REQUIRE(rec.count() == 1);

  // At the 1 s mark an idle reporter must NOT have emitted again (that is the
  // drawing budget, not the idle one).
  CHECK_FALSE(reporter.tick(1000));
  CHECK(rec.count() == 1);

  // Just shy of the 5 s idle budget: still nothing.
  CHECK_FALSE(reporter.tick(4999));
  CHECK(rec.count() == 1);

  // At the 5 s idle budget: a frame is due.
  CHECK(reporter.tick(5000));
  CHECK(rec.count() == 2);
}

TEST_CASE("idle cadence holds its 5 s gap across a long idle window",
          "[status][cadence]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());
  reporter.setState(StatusState::Idle);
  reporter.begin();

  REQUIRE(reporter.tick(0));

  std::uint32_t last_emit_t = 0;
  std::uint32_t max_gap = 0;
  for (std::uint32_t t = 250; t <= 30000; t += 250) {
    if (reporter.tick(t)) {
      max_gap = std::max<std::uint32_t>(max_gap, t - last_emit_t);
      last_emit_t = t;
    }
  }
  CHECK(max_gap <= STATUS_IDLE_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// State change forces a prompt emit
// ---------------------------------------------------------------------------

TEST_CASE("a state change forces a prompt emit", "[status][cadence]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());
  reporter.setState(StatusState::Drawing);
  reporter.begin();

  REQUIRE(reporter.tick(0));   // initial emit @ t=0
  REQUIRE(rec.count() == 1);

  // Only 200 ms later — well within the 1 s budget, so no time-based emit.
  CHECK_FALSE(reporter.tick(200));
  CHECK(rec.count() == 1);

  // A transition to Paused arms the force flag; the very next tick emits even
  // though the cadence interval has not elapsed.
  reporter.setState(StatusState::Paused);
  CHECK(reporter.tick(250));
  REQUIRE(rec.count() == 2);
  // The forced frame carries the new state code (2 = paused).
  CHECK(rec.last().bytes[12] == 2);
}

TEST_CASE("setting the same state does not force an emit", "[status][cadence]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());
  reporter.setState(StatusState::Drawing);
  reporter.begin();

  REQUIRE(reporter.tick(0));
  REQUIRE(rec.count() == 1);

  // Re-asserting the current state is a no-op: no forced emit, and the cadence
  // budget still applies.
  reporter.setState(StatusState::Drawing);
  CHECK_FALSE(reporter.tick(300));
  CHECK(rec.count() == 1);
}

TEST_CASE("begin re-arms an initial emit on the next tick",
          "[status][cadence]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());
  reporter.setState(StatusState::Idle);

  // No begin() yet but tick still emits the first time (have_emitted_ false).
  REQUIRE(reporter.tick(100));
  REQUIRE(rec.count() == 1);
  CHECK_FALSE(reporter.tick(200));  // within idle budget
  REQUIRE(rec.count() == 1);

  // begin() re-arms: the next tick emits immediately regardless of elapsed time.
  reporter.begin();
  CHECK(reporter.tick(250));
  CHECK(rec.count() == 2);
}

// ---------------------------------------------------------------------------
// Sink robustness
// ---------------------------------------------------------------------------

TEST_CASE("the emitted payload is a well-formed 16-byte §4.7 frame",
          "[status][cadence]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());
  reporter.setPosition(Position{7, 9});
  reporter.setPercentComplete(50);
  reporter.setRssiDbm(-40);
  reporter.setActiveSps(500);
  reporter.setState(StatusState::Drawing);
  reporter.begin();

  REQUIRE(reporter.tick(0));
  REQUIRE(rec.count() == 1);
  REQUIRE(rec.last().len == STATUS_PAYLOAD_SIZE);
  CHECK(readI32LE(&rec.last().bytes[0]) == 7);
  CHECK(readI32LE(&rec.last().bytes[4]) == 9);
  CHECK(rec.last().bytes[8] == 50);
  CHECK(static_cast<std::int8_t>(rec.last().bytes[9]) == -40);
  CHECK(readU16LE(&rec.last().bytes[10]) == 500);
}

TEST_CASE("tick without a sink still paces and returns true when due",
          "[status][cadence]") {
  StatusReporter reporter;  // no sink installed
  reporter.setState(StatusState::Drawing);
  reporter.begin();

  // Emitting with no sink must not crash and still advances the cadence state.
  CHECK(reporter.tick(0));
  CHECK_FALSE(reporter.tick(500));
  CHECK(reporter.tick(1000));
}

// ---------------------------------------------------------------------------
// Envelope-calibrated flag bit (Task 4.2; Design §"Firmware: STATUS",
// §Data Models STATUS Frame; Req 8.2, 8.4).
// ---------------------------------------------------------------------------

TEST_CASE("setEnvelopeCalibrated toggles bit2 (0x04) at flags offset 13",
          "[status][envelope]") {
  EmitRecorder rec;
  StatusReporter reporter(rec.sink());

  // Bit2 starts clear.
  CHECK((reporter.flags() & STATUS_FLAG_ENVELOPE_CALIBRATED) == 0);

  reporter.setEnvelopeCalibrated(true);
  CHECK(STATUS_FLAG_ENVELOPE_CALIBRATED == 0x04);
  CHECK(reporter.flags() == STATUS_FLAG_ENVELOPE_CALIBRATED);

  // The bit lands at offset 13 of the serialised payload.
  reporter.setState(StatusState::Idle);
  reporter.begin();
  REQUIRE(reporter.tick(0));
  REQUIRE(rec.count() == 1);
  CHECK(rec.last().bytes[13] == 0x04);

  reporter.setEnvelopeCalibrated(false);
  CHECK((reporter.flags() & STATUS_FLAG_ENVELOPE_CALIBRATED) == 0);
}

TEST_CASE("setEnvelopeCalibrated does not disturb bit0 or bit1",
          "[status][envelope]") {
  StatusReporter reporter;

  // Pre-set the calibrated (bit0) and buffer-full (bit1) flags.
  reporter.setCalibrated(true);
  reporter.setBufferFull(true);
  REQUIRE(reporter.flags() ==
          (STATUS_FLAG_CALIBRATED | STATUS_FLAG_BUFFER_FULL));

  // Setting bit2 leaves bit0 and bit1 untouched.
  reporter.setEnvelopeCalibrated(true);
  CHECK(reporter.flags() == (STATUS_FLAG_CALIBRATED | STATUS_FLAG_BUFFER_FULL |
                             STATUS_FLAG_ENVELOPE_CALIBRATED));
  CHECK((reporter.flags() & STATUS_FLAG_CALIBRATED) != 0);
  CHECK((reporter.flags() & STATUS_FLAG_BUFFER_FULL) != 0);

  // Clearing bit2 also leaves bit0 and bit1 intact.
  reporter.setEnvelopeCalibrated(false);
  CHECK(reporter.flags() ==
        (STATUS_FLAG_CALIBRATED | STATUS_FLAG_BUFFER_FULL));
  CHECK((reporter.flags() & STATUS_FLAG_ENVELOPE_CALIBRATED) == 0);

  // Conversely, toggling bit0/bit1 must not touch bit2.
  reporter.setEnvelopeCalibrated(true);
  reporter.setCalibrated(false);
  reporter.setBufferFull(false);
  CHECK(reporter.flags() == STATUS_FLAG_ENVELOPE_CALIBRATED);
}

TEST_CASE("setEnvelopeCalibrated is idempotent", "[status][envelope]") {
  StatusReporter reporter;
  reporter.setEnvelopeCalibrated(true);
  reporter.setEnvelopeCalibrated(true);
  CHECK(reporter.flags() == STATUS_FLAG_ENVELOPE_CALIBRATED);
  reporter.setEnvelopeCalibrated(false);
  reporter.setEnvelopeCalibrated(false);
  CHECK(reporter.flags() == 0);
}

int main(int argc, char* argv[]) {
  return Catch::Session().run(argc, argv);
}
