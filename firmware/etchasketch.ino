// Etch-a-Sketch Drawing Machine - main firmware sketch (Task 8.1).
//
// This is the top-level cooperative integration of every firmware module built
// in tasks 2-7. setup() constructs and begins the module graph; loop() services
// the modules in the fixed order mandated by Design §4.8. The inbound WebSocket
// frame router (CMD -> CommandParser + SequenceTracker -> MotionPlanner +
// FlowController; CTL -> control_parser -> the matching module action) and the
// HELLO / connection-loss handling live here too.
//
// Everything Arduino-specific (millis, FspTimer via MotionPlanner, WiFiS3 via
// WiFiManager / HttpServer / WSServer, the CNC-shield pin sink, and the .ino
// entry points themselves) is compiled only under `#if defined(ARDUINO)`. The
// genuinely host-testable logic is factored into Arduino-free headers and
// exercised by the host Catch2 suite:
//
//   * app::serializeHello()    - firmware/src/app/hello.{h,cpp}  (§4.8 layout)
//   * app::ConnectionMonitor   - firmware/src/app/connection_monitor.h (§5.6)
//   * the NVM interface adapters - firmware/src/app/nvm_adapters.h
//
// References:
//   - Requirements 7.5, 7.6 (connection loss), 10.2 (calibration on boot),
//     10.12 (unclean shutdown clears calibration).
//   - Design §4.8 (main loop order + HELLO frame), §5.6 (connection loss),
//     §3.2 (module surfaces), §9.1 (CNC Shield pin map).

#if defined(ARDUINO)

#include <Arduino.h>

#include "src/types.h"

#include "src/app/auto_return.h"
#include "src/app/connection_monitor.h"
#include "src/app/envelope_calibration.h"
#include "src/app/hello.h"
#include "src/app/nvm_adapters.h"

#include "src/backlash/backlash_compensator.h"
#include "src/diagnostics/diagnostics.h"
#include "src/diagnostics/idle_timeout.h"
#include "src/diagnostics/motor_test.h"
#include "src/diagnostics/status_reporter.h"
#include "src/http/http_server.h"
#include "src/motion/motion_planner.h"
#include "src/motion/ring_buffer.h"
#include "src/nvm/nvm_arduino_backend.h"
#include "src/nvm/nvm_manager.h"
#include "src/protocol/command_parser.h"
#include "src/protocol/control_parser.h"
#include "src/protocol/flow_control.h"
#include "src/protocol/frame.h"
#include "src/protocol/sequence_tracker.h"
#include "src/wifi/wifi_manager.h"

// Compile-time transport selection (Design §3.7, Req 1). Resolves the
// `ETCH_TRANSPORT` build flag, pulls in the selected server header, and
// typedefs `app::Transport` to either `protocol::BleServer` (BLE build) or
// `protocol::WSServer` (WiFi build). The frame router and every send helper
// below are written once against this typedef and are identical across builds.
#include "src/transport_config.h"

using namespace etch;

// ===========================================================================
// CNC Shield pin sink (Design §9.1)
// ===========================================================================
//
// The concrete ArduinoStepSink / ArduinoDiagPins defined inside the module
// .cpp files are file-local, so the integration layer owns its own shield I/O
// adapter here. One object implements every pin-facing interface so a single
// owner drives the shared active-low EN line (D8): the MotionPlanner's
// IStepSink, the Diagnostics IDiagPins fault tap, and the IdleTimeoutManager's
// IEnableLine. This avoids two writers fighting over D8 (idle_timeout.h's
// integration note).

namespace {

constexpr uint8_t PIN_X_STEP = 2;   // D2  -> A4988 X STEP
constexpr uint8_t PIN_Y_STEP = 3;   // D3  -> A4988 Y STEP
constexpr uint8_t PIN_X_DIR  = 5;   // D5  -> A4988 X DIR
constexpr uint8_t PIN_Y_DIR  = 6;   // D6  -> A4988 Y DIR
constexpr uint8_t PIN_EN     = 8;   // D8  -> shared active-low ENABLE
constexpr uint8_t PIN_FAULT  = A3;  // A3  -> aggregate driver fault (pull-up)

inline void pulsePin(uint8_t pin) {
  digitalWrite(pin, HIGH);
  delayMicroseconds(2);
  digitalWrite(pin, LOW);
}

// Implements every pin-facing seam against the CNC Shield V3.0 wiring.
class ShieldIO : public motion::IStepSink,
                 public diag::IDiagPins,
                 public diagnostics::IEnableLine {
 public:
  void beginPins() {
    pinMode(PIN_X_STEP, OUTPUT);
    pinMode(PIN_Y_STEP, OUTPUT);
    pinMode(PIN_X_DIR, OUTPUT);
    pinMode(PIN_Y_DIR, OUTPUT);
    pinMode(PIN_EN, OUTPUT);
    pinMode(PIN_FAULT, INPUT_PULLUP);
    digitalWrite(PIN_X_STEP, LOW);
    digitalWrite(PIN_Y_STEP, LOW);
    digitalWrite(PIN_EN, HIGH);  // start disabled (active-low, Req 6.8)
  }

  // motion::IStepSink + diagnostics::IEnableLine share setEnabled() semantics.
  void setEnabled(bool enabled) override {
    digitalWrite(PIN_EN, enabled ? LOW : HIGH);  // active-low
  }

  // motion::IStepSink
  // Both axes are direction-inverted relative to the firmware's +X=right,
  // +Y=up convention for this machine's gearing/wiring, so the DIR levels are
  // flipped here (verified by jog test: +X must drive right, +Y must drive up).
  void setDirX(int8_t dir) override {
    digitalWrite(PIN_X_DIR, dir >= 0 ? LOW : HIGH);
  }
  void setDirY(int8_t dir) override {
    digitalWrite(PIN_Y_DIR, dir >= 0 ? LOW : HIGH);
  }
  void stepX() override { pulsePin(PIN_X_STEP); }
  void stepY() override { pulsePin(PIN_Y_STEP); }

  // diag::IDiagPins
  bool readFault() override { return digitalRead(PIN_FAULT) == LOW; }
};

// Read-only fault/stall view for the MotorTest routine, backed by Diagnostics.
class DiagnosticsMonitorAdapter : public diagnostics::IDiagnosticsMonitor {
 public:
  explicit DiagnosticsMonitorAdapter(diag::Diagnostics& d) : diag_(d) {}

  bool faultActive() const override { return diag_.isFaulted(); }
  bool stallDetected(diagnostics::Axis /*axis*/) const override {
    // Diagnostics latches a single stall flag; surface it for either axis.
    return diag_.isStalled();
  }

 private:
  diag::Diagnostics& diag_;
};

inline uint32_t nowMs() { return static_cast<uint32_t>(millis()); }

// ===========================================================================
// Module graph (file-static so the ISR trampoline + loop() can reach them)
// ===========================================================================

ShieldIO g_io;

// NVM: EEPROM-backed record + manager.
nvm::ArduinoEEPROMBackend g_nvm_backend;
nvm::NVMManager g_nvm(g_nvm_backend, nowMs);

// NVM interface adapters (app/nvm_adapters.h).
app::WifiNvmAdapter        g_wifi_nvm(g_nvm);
app::MotionNvmAdapter      g_motion_nvm(g_nvm);
app::BacklashNvmAdapter    g_backlash_nvm(g_nvm);
app::CalibrationStateAdapter g_calib_state(g_nvm);

// Connectivity.
//
// The realtime transport (`g_transport`) is the build-selected server
// (BleServer or WSServer, see transport_config.h). The WiFi-only managers
// (`g_wifi`, `g_http`) are compiled solely into the WiFi image; under the BLE
// build they are excluded so WiFi is never constructed or initialised at
// runtime (Req 1.6, 9.3). The complete WiFi source stays in the tree; the BLE
// PlatformIO env drops the WiFi/HTTP/WS .cpp files from the link (Req 1.4).
#if ETCH_TRANSPORT_RESOLVED == ETCH_TRANSPORT_WIFI
wifi::WiFiManager g_wifi(g_wifi_nvm);
http::HttpServer  g_http(g_wifi, g_calib_state);
#endif
app::Transport g_transport;

// Motion stack.
backlash::BacklashCompensator g_backlash(g_backlash_nvm);
motion::MotionPlanner::RingBufferT g_buffer;
motion::MotionPlanner g_planner(g_buffer, g_backlash, g_io, g_motion_nvm);

// Protocol bookkeeping.
protocol::SequenceTracker g_seq;
protocol::FlowController  g_flow;

// Diagnostics + status.
diag::Diagnostics* g_diag_ptr = nullptr;  // set in setup() (needs ErrorSink)
diagnostics::StatusReporter g_status;
diagnostics::IdleTimeoutManager g_idle(g_io);

// Connection-loss state machine (Design §5.6).
app::ConnectionMonitor g_conn;

// Drawing-completion / return-to-home state machine (Task 8.2, Req 10.7/14.7).
app::AutoReturn g_auto_return;

// Auto-return-to-home enable flag. DEFAULT OFF (hardware-safety): the synthesized
// return-to-home is a single large open-loop move back to (0,0) with no
// end-stop protection, so on an Etch-a-Sketch (hard mechanical stops, no homing
// sensor) a stale/mismatched logical position can drive a knob into its stop and
// damage it. Until a travel clamp against the physical envelope is in place, the
// physical return move is disabled by default; completion still finalizes to a
// clean idle in place. (Follow-up: expose this as a UI checkbox via a control
// message; for now it is a firmware-side default.)
bool g_auto_return_enabled = false;

// ---------------------------------------------------------------------------
// Outbound frame helpers
// ---------------------------------------------------------------------------

void sendFrame(protocol::FrameType type, const uint8_t* payload, uint16_t len) {
  uint8_t frame[protocol::FRAME_HEADER_SIZE + 64];
  const size_t n = protocol::buildFrame(type, payload, len, frame, sizeof(frame));
  if (n > 0) {
    g_transport.sendBinary(frame, n);
  }
}

void sendAck(uint32_t seq) {
  uint8_t p[4] = {static_cast<uint8_t>(seq & 0xFF),
                  static_cast<uint8_t>((seq >> 8) & 0xFF),
                  static_cast<uint8_t>((seq >> 16) & 0xFF),
                  static_cast<uint8_t>((seq >> 24) & 0xFF)};
  sendFrame(protocol::FrameType::ACK, p, sizeof(p));
}

void sendNack(uint32_t seq, protocol::NackReason reason) {
  uint8_t p[5] = {static_cast<uint8_t>(seq & 0xFF),
                  static_cast<uint8_t>((seq >> 8) & 0xFF),
                  static_cast<uint8_t>((seq >> 16) & 0xFF),
                  static_cast<uint8_t>((seq >> 24) & 0xFF),
                  static_cast<uint8_t>(reason)};
  sendFrame(protocol::FrameType::NACK, p, sizeof(p));
}

void sendRetx(uint32_t seq) {
  uint8_t p[4] = {static_cast<uint8_t>(seq & 0xFF),
                  static_cast<uint8_t>((seq >> 8) & 0xFF),
                  static_cast<uint8_t>((seq >> 16) & 0xFF),
                  static_cast<uint8_t>((seq >> 24) & 0xFF)};
  sendFrame(protocol::FrameType::RETX_REQUEST, p, sizeof(p));
}

void sendCredit(uint8_t n) {
  if (n == 0) return;
  sendFrame(protocol::FrameType::CREDIT, &n, 1);
}

void sendState(diagnostics::StatusState state) {
  uint8_t code = static_cast<uint8_t>(state);
  sendFrame(protocol::FrameType::STATE, &code, 1);
  g_status.setState(state);
}

void sendError(uint8_t kind, uint8_t axis, uint16_t detail) {
  uint8_t p[4] = {kind, axis, static_cast<uint8_t>(detail & 0xFF),
                  static_cast<uint8_t>((detail >> 8) & 0xFF)};
  sendFrame(protocol::FrameType::ERROR, p, sizeof(p));
}

// Build and send the §4.8 HELLO frame from current NVM / planner / backlash
// state (Requirements 7.5/7.6 rehydration, 10.2/10.12 calibration state).
void sendHello() {
  const PersistedConfig& cfg = g_nvm.get();
  const Position pos = g_planner.position();

  app::HelloFields f;
  f.firmware_version =
      app::packFirmwareVersion(http::ETCH_FW_VERSION_MAJOR,
                               http::ETCH_FW_VERSION_MINOR,
                               http::ETCH_FW_VERSION_PATCH);
  f.max_sps         = FEED_SPS_MAX;
  f.backlash_x      = cfg.backlash_x_steps;
  f.backlash_y      = cfg.backlash_y_steps;
  f.mm_per_rev_x    = cfg.mm_per_rev_x;
  f.mm_per_rev_y    = cfg.mm_per_rev_y;
  f.logical_x_steps = pos.x_steps;
  f.logical_y_steps = pos.y_steps;
  f.calibrated      = (cfg.flags & NVM_FLAG_CALIBRATED) != 0;
  f.unclean         = g_nvm.wasUncleanShutdown();
  f.buffer_capacity = static_cast<uint16_t>(COMMAND_BUFFER_SIZE);
  // HELLO is authoritative for the envelope (Defect 2 fix, Req 2.5/2.6/2.8/3.7):
  // advertise the EFFECTIVE envelope as the single source of truth -- the
  // captured envelope when calibrated and valid, otherwise the bounded
  // DEFAULT_ENVELOPE. The web side decodes these fields directly, so no
  // wire-format change is needed (HELLO_PAYLOAD_SIZE stays 40, Drawing_Command
  // untouched). envelope_calibrated still reports ONLY whether a captured
  // envelope exists, so the recalibration flow remains reachable.
  const app::MeasuredEnvelope eff = app::effectiveEnvelope(cfg);
  f.envelope_x_steps = static_cast<uint32_t>(eff.x);
  f.envelope_y_steps = static_cast<uint32_t>(eff.y);
  f.envelope_calibrated = (cfg.flags & NVM_FLAG_ENVELOPE_CALIBRATED) != 0;

  uint8_t payload[app::HELLO_PAYLOAD_SIZE];
  const size_t plen = app::serializeHello(f, payload, sizeof(payload));
  if (plen > 0) {
    sendFrame(protocol::FrameType::HELLO, payload, static_cast<uint16_t>(plen));
  }
}

// ---------------------------------------------------------------------------
// Calibration helpers
// ---------------------------------------------------------------------------

bool isCalibrated() { return (g_nvm.get().flags & NVM_FLAG_CALIBRATED) != 0; }

bool isEnvelopeCalibrated() {
  return (g_nvm.get().flags & NVM_FLAG_ENVELOPE_CALIBRATED) != 0;
}

void setCalibratedFlag(bool calibrated) {
  g_nvm.mutate([calibrated](PersistedConfig& cfg) {
    if (calibrated) {
      cfg.flags = static_cast<uint8_t>(cfg.flags | NVM_FLAG_CALIBRATED);
    } else {
      cfg.flags = static_cast<uint8_t>(cfg.flags & ~NVM_FLAG_CALIBRATED);
    }
  });
  g_status.setCalibrated(calibrated);
}

// ---------------------------------------------------------------------------
// Inbound CMD routing (Design §5.2): CommandParser -> SequenceTracker ->
// MotionPlanner.submit + flow-control credits.
// ---------------------------------------------------------------------------

void handleCmdFrame(const protocol::Frame& frame) {
  // Drawing commands are no longer hard-blocked on envelope calibration
  // (Defect 2 fix, Req 2.5-2.8 / 3.5). An uncalibrated machine draws using the
  // bounded DEFAULT_ENVELOPE resolved by app::effectiveEnvelope(); a valid
  // captured envelope still overrides the default. The fitted Drawing_Command
  // deltas streamed by the web client are already bounded to the effective
  // envelope advertised in HELLO, so the firmware just validates and enqueues
  // them. Parse / CRC / range NACKs and the jog travel cap are unchanged.
  DrawingCommand cmd;
  const protocol::ParseResult pr =
      protocol::parseDrawingCommand(frame.payload, frame.len, cmd);

  switch (pr) {
    case protocol::ParseResult::Ok: {
      const protocol::RetxAction act = g_seq.onValidCommand(cmd.seq);
      if (act == protocol::RetxAction::DuplicateAck) {
        sendAck(cmd.seq);  // idempotent; do NOT re-enqueue (Req 7.3)
        return;
      }
      // Fresh, valid command: enqueue then ACK.
      if (!g_planner.submit(cmd)) {
        sendNack(cmd.seq, protocol::NackReason::BufferFull);
        return;
      }
      g_idle.notifyActivity(nowMs());  // re-energise drivers before motion
      g_flow.onCommandEnqueued();
      sendAck(cmd.seq);
      break;
    }
    case protocol::ParseResult::RetxCrc: {
      const protocol::RetxAction act = g_seq.onCrcError(cmd.seq);
      if (act == protocol::RetxAction::Unrecoverable) {
        g_planner.pause();
        sendState(diagnostics::StatusState::Paused);
        sendError(0x03 /*UNRECOVERABLE_TX*/, diag::ERROR_AXIS_NONE,
                  static_cast<uint16_t>(cmd.seq));
      } else {
        sendRetx(cmd.seq);
      }
      break;
    }
    case protocol::ParseResult::NackRange:
      sendNack(cmd.seq, protocol::NackReason::Range);
      break;
    case protocol::ParseResult::NackParse:
    default:
      sendNack(cmd.seq, protocol::NackReason::Parse);
      break;
  }
}

// ---------------------------------------------------------------------------
// Inbound CTL routing (Design §4.6): control_parser -> matching module action.
// ---------------------------------------------------------------------------

void handleCtlFrame(const protocol::Frame& frame) {
  protocol::ControlMessage msg;
  const protocol::CtlParseResult cr =
      protocol::parseControl(frame.payload, frame.len, msg);
  if (cr != protocol::CtlParseResult::Ok) {
    return;  // malformed control message: ignore (no seq to NACK)
  }

  switch (msg.kind) {
    case protocol::ControlKind::PAUSE:
      g_planner.pause();
      sendState(diagnostics::StatusState::Paused);
      break;
    case protocol::ControlKind::RESUME:
      g_idle.notifyActivity(nowMs());
      g_planner.resume();
      sendState(diagnostics::StatusState::Drawing);
      break;
    case protocol::ControlKind::CANCEL:
      g_planner.cancel();
      g_conn.onDrawingFinished();
      g_auto_return.reset();  // a cancelled drawing does not auto-return home
      sendState(diagnostics::StatusState::Aborted);
      break;
    case protocol::ControlKind::STOP:
      g_planner.stop();
      g_auto_return.reset();  // STOP discards the drawing; no auto-return
      sendState(diagnostics::StatusState::Idle);
      break;
    case protocol::ControlKind::JOG: {
      // Single full-step jog (Req 10.3). Synthesize a counted move so the
      // logical position tracks the jog; calibration is NOT required (jogging
      // is how the user calibrates). The per-axis jog travel cap IS enforced
      // here regardless of calibration state (Req 6.1-6.4): a jog that would
      // push the jogged axis past +/-JOG_TRAVEL_CAP_STEPS is refused with a
      // JogTravelCap NACK and the motor is not moved.
      //
      // DIAGNOSTIC JOG PATH (jog reliability fix): instead of routing the jog
      // through the planner's GPT-timer segment path (which reprograms the
      // step timer EVERY microstep via setTimerRateHz_ and was observed to
      // knock once then stall), we drive the STEP pin directly in a blocking,
      // constant-rate pulse train -- exactly the way the proven-reliable sample
      // sketch does it (digitalWrite HIGH; delay; LOW; delay; repeat). This
      // bypasses the per-step timer reconfiguration entirely to confirm it is
      // the cause of the jog knock/stall.
      //
      // This jog runs SYNCHRONOUSLY in the BLE/CTL handler context: it blocks
      // loop() (so BLE polling is paused) for the duration of the jog. That is
      // acceptable for short manual jogs -- e.g. a big 100-step jog is
      // 100 * MICROSTEP_FACTOR(16) = 1600 pulses * ~2 ms = ~3.2 s; typical
      // small calibration jogs are brief. Jogging only happens while idle, so
      // blocking the cooperative loop here is fine.
      g_idle.notifyActivity(nowMs());
      // Use a wide int32 delta for the cap check to avoid int16 overflow on
      // large step counts.
      const int32_t capDelta =
          static_cast<int32_t>(msg.jog.dir) * static_cast<int32_t>(msg.jog.steps);
      const Position cur = g_planner.position();
      if (!app::jogWithinCap(cur.x_steps, cur.y_steps, msg.jog.axis, capDelta,
                             JOG_TRAVEL_CAP_STEPS)) {
        sendNack(0, protocol::NackReason::JogTravelCap);
        break;  // over-cap: do not move (motor stays put)
      }

      // Inter-pulse spacing AFTER each STEP pulse. g_io.stepX()/stepY() already
      // emits a HIGH; delayMicroseconds(2); LOW pulse (~2 us high), so adding
      // ~1800 us here gives a total period of ~1802 us => ~555 Hz microstep
      // rate, squarely inside the proven-reliable sample sketch's constant
      // ~250-500 Hz cold-start band. Field-tunable: raise to slow the jog,
      // lower to speed it up. This is a constant rate (no per-step timer
      // reprogramming), which is the whole point of the diagnostic.
      static constexpr uint32_t JOG_PULSE_INTERVAL_US = 1800;

      const int8_t jogDir = static_cast<int8_t>(msg.jog.dir >= 0 ? 1 : -1);
      const uint32_t microPulses =
          static_cast<uint32_t>(msg.jog.steps) * MICROSTEP_FACTOR;

      // Energize the drivers and let the A4988 charge pump settle before
      // stepping (a cold STEP into an un-settled driver is part of the knock).
      g_io.setEnabled(true);
      delay(2);

      if (msg.jog.axis == protocol::Axis::X) {
        g_io.setDirX(jogDir);
        for (uint32_t i = 0; i < microPulses; ++i) {
          g_io.stepX();
          delayMicroseconds(JOG_PULSE_INTERVAL_US);
        }
        // Position is COUNTED FULL STEPS (not microsteps): advance by the
        // signed full-step delta on the jogged axis only.
        g_planner.nudgePosition(jogDir * static_cast<int32_t>(msg.jog.steps), 0);
      } else {
        g_io.setDirY(jogDir);
        for (uint32_t i = 0; i < microPulses; ++i) {
          g_io.stepY();
          delayMicroseconds(JOG_PULSE_INTERVAL_US);
        }
        g_planner.nudgePosition(0, jogDir * static_cast<int32_t>(msg.jog.steps));
      }

      // Preserve JOG's existing response behavior: no ACK is sent for a jog;
      // only the motion generation changed.
      break;
    }
    case protocol::ControlKind::SET_HOME:
      g_planner.setHome();
      g_backlash.onHome();
      g_nvm.mutate([](PersistedConfig& cfg) {
        cfg.logical_pos_x = 0;
        cfg.logical_pos_y = 0;
        cfg.flags = static_cast<uint8_t>(cfg.flags | NVM_FLAG_CALIBRATED);
      });
      g_status.setCalibrated(true);
      g_status.setPosition(g_planner.position());
      sendState(diagnostics::StatusState::Idle);
      break;
    case protocol::ControlKind::RE_HOME:
      // Clear calibration and enter the manual jog flow (Req 10.13). Also clear
      // any captured Step_Envelope so the firmware falls back to the baked-in
      // DEFAULT_ENVELOPE (types.h DEFAULT_ENVELOPE_X/Y_STEPS). This makes
      // RE_HOME a clean "discard stored calibration, use the hardcoded default"
      // action — the web "Clear calibration" button relies on this to drop a
      // stale/incorrect stored envelope without a reflash.
      setCalibratedFlag(false);
      g_backlash.onHome();
      g_nvm.mutate([](PersistedConfig& cfg) {
        cfg.flags =
            static_cast<uint8_t>(cfg.flags & ~NVM_FLAG_ENVELOPE_CALIBRATED);
        cfg.envelope_x_steps = 0;
        cfg.envelope_y_steps = 0;
      });
      g_status.setEnvelopeCalibrated(false);
      // Re-advertise the now-effective (default) envelope immediately so the
      // client picks up the hardcoded dimensions without reconnecting.
      sendHello();
      sendAck(0);
      sendState(diagnostics::StatusState::Idle);
      break;
    case protocol::ControlKind::CAPTURE_BOTTOM_LEFT:
      // Set logical home (0,0) as the measurement baseline, reusing the
      // SET_HOME machinery, and clear any prior envelope: a re-home discards
      // the previously captured envelope (Req 1.2, 1.3, 10.1).
      g_planner.setHome();   // logical position -> (0,0); measurement baseline
      g_backlash.onHome();
      g_nvm.mutate([](PersistedConfig& cfg) {
        cfg.logical_pos_x = 0;
        cfg.logical_pos_y = 0;
        cfg.flags = static_cast<uint8_t>(cfg.flags | NVM_FLAG_CALIBRATED);
        // re-home clears the envelope-captured state (Req 10.1)
        cfg.flags =
            static_cast<uint8_t>(cfg.flags & ~NVM_FLAG_ENVELOPE_CALIBRATED);
        cfg.envelope_x_steps = 0;
        cfg.envelope_y_steps = 0;
      });
      g_status.setCalibrated(true);
      g_status.setEnvelopeCalibrated(false);
      g_status.setPosition(g_planner.position());
      sendAck(0);  // CTL ACK semantics (Req 9.2)
      sendState(diagnostics::StatusState::Idle);
      break;
    case protocol::ControlKind::CAPTURE_TOP_RIGHT: {
      // Record the Controller's own accumulated travel as the envelope. Home
      // is (0,0), so the envelope is |position| on each axis (Req 1.4, 1.5).
      if (!isCalibrated()) {  // not in Home_Set_State (Req 1.7)
        sendNack(0, protocol::NackReason::EnvelopeHomeNotSet);
        break;
      }
      const app::MeasuredEnvelope env =
          app::measureEnvelope(g_planner.position());
      if (!app::isValidEnvelope(env.x, env.y)) {  // Req 2.1, 2.2
        sendNack(0, protocol::NackReason::EnvelopeInvalid);
        break;
      }
      // Validated envelope is strictly positive on both axes; narrow to the
      // u32 PersistedConfig fields. Replaces any prior envelope on re-capture.
      const uint32_t ex = static_cast<uint32_t>(env.x);
      const uint32_t ey = static_cast<uint32_t>(env.y);
      g_nvm.mutate([ex, ey](PersistedConfig& cfg) {
        cfg.envelope_x_steps = ex;
        cfg.envelope_y_steps = ey;
        cfg.flags =
            static_cast<uint8_t>(cfg.flags | NVM_FLAG_ENVELOPE_CALIBRATED);
      });
      g_status.setEnvelopeCalibrated(true);
      sendAck(0);
      sendState(diagnostics::StatusState::Idle);
      break;
    }
    case protocol::ControlKind::BEGIN_DRAW:
      // Drawing is no longer gated on envelope calibration (Defect 2 fix,
      // Req 2.5-2.8 / 3.5): an uncalibrated machine arms the draw using the
      // bounded DEFAULT_ENVELOPE (resolved via app::effectiveEnvelope), a valid
      // captured envelope still overrides it. Arm unconditionally, subject to
      // the existing non-envelope draw bookkeeping below.
      g_nvm.markBusy();  // unclean marker set while drawing (Design §4.4)
      g_seq.reset();
      sendCredit(g_flow.onBeginDraw());
      g_conn.onDrawingStarted();
      g_auto_return.onBeginDraw();  // arm the completion / return-home machine
      sendState(diagnostics::StatusState::Drawing);
      break;
    case protocol::ControlKind::END_DRAW:
      g_conn.onDrawingFinished();
      g_auto_return.onEndDraw();  // await drain, then auto-return home (10.7)
      break;
    case protocol::ControlKind::SPEED_PCT:
      g_planner.setSpeedPct(msg.speed_pct.pct);  // applied next segment (9.8)
      break;
    case protocol::ControlKind::SET_BACKLASH: {
      BacklashConfig bc;
      bc.x = static_cast<uint8_t>(msg.set_backlash.x);
      bc.y = static_cast<uint8_t>(msg.set_backlash.y);
      g_backlash.set(bc);
      g_backlash.save();
      break;
    }
    case protocol::ControlKind::MOTOR_TEST: {
      DiagnosticsMonitorAdapter monitor(*g_diag_ptr);
      diagnostics::MotorTest test(g_io, monitor);
      const diagnostics::MotorTestResult r = test.run();
      // detail bit0 = X pass, bit1 = Y pass.
      const uint16_t detail = static_cast<uint16_t>((r.xPass ? 1 : 0) |
                                                    (r.yPass ? 2 : 0));
      sendError(0x00 /*motor-test report, non-fatal*/, diag::ERROR_AXIS_NONE,
                detail);
      break;
    }
    case protocol::ControlKind::FAULT_RESET:
      g_diag_ptr->faultReset();
      g_seq.reset();
      sendState(diagnostics::StatusState::Idle);
      break;
  }
}

void handleFrame(const protocol::Frame& frame) {
  switch (frame.type) {
    case protocol::FrameType::CMD:
      handleCmdFrame(frame);
      break;
    case protocol::FrameType::CTL:
      handleCtlFrame(frame);
      break;
    default:
      break;  // client -> controller only accepts CMD / CTL
  }
}

// ---------------------------------------------------------------------------
// Connection-loss action dispatch (Design §5.6)
// ---------------------------------------------------------------------------

void applyConnAction(app::ConnectionMonitor::Action action) {
  switch (action) {
    case app::ConnectionMonitor::Action::PauseDrawing:
      g_planner.pause();
      sendState(diagnostics::StatusState::Paused);
      break;
    case app::ConnectionMonitor::Action::ResumeDrawing:
      g_idle.notifyActivity(nowMs());
      g_planner.resume();
      sendState(diagnostics::StatusState::Drawing);
      break;
    case app::ConnectionMonitor::Action::AbortDrawing:
      g_planner.cancel();
      g_auto_return.reset();   // aborted drawing does not auto-return home
      g_nvm.markCleanIdle();  // retain position, mark clean (Req 7.6)
      sendState(diagnostics::StatusState::Aborted);
      break;
    case app::ConnectionMonitor::Action::None:
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Drawing-completion / return-to-home service (Task 8.2, Req 10.7 / 14.7)
// ---------------------------------------------------------------------------
//
// Driven every main-loop pass once the planner has been serviced. When a draw
// session has ended (END_DRAW) and the planner has drained to idle, this:
//   * synthesizes the connector move back to (0,0) and submits it to the
//     planner if the stylus is not already home (split into <= i16 chunks,
//     mirroring the web splitMotion), then
//   * once the planner is idle AT home, marks the NVM record clean-idle,
//     flushes it, and emits STATE idle (Design §4.4, §5.2).
//
// The AutoReturn guard guarantees the auto-return fires at most once per
// drawing and that the synthesized return move itself does not re-trigger it.
void serviceAutoReturn() {
  const Position pos = g_planner.position();
  const app::AutoReturn::Action action =
      g_auto_return.poll(g_planner.isIdle(), pos);

  switch (action) {
    case app::AutoReturn::Action::EnqueueReturn: {
      if (!g_auto_return_enabled) {
        // Auto-return disabled (default, hardware-safety): do NOT drive the
        // open-loop move back to (0,0) — that is the move that can grind a knob
        // into its mechanical stop. Instead finalize cleanly in place: clear
        // the awaiting-return state so we don't poll EnqueueReturn forever, mark
        // NVM clean-idle, and emit STATE idle. The stylus simply stays where the
        // drawing ended.
        g_auto_return.reset();
        g_nvm.markCleanIdle();
        g_nvm.flushIfDue();
        g_conn.onDrawingFinished();
        sendState(diagnostics::StatusState::Idle);
        break;
      }
      DrawingCommand ret[app::AUTO_RETURN_MAX_COMMANDS];
      const std::size_t n = app::buildReturnCommands(
          pos.x_steps, pos.y_steps, app::RETURN_FEED_SPS, /*seqStart=*/0, ret,
          app::AUTO_RETURN_MAX_COMMANDS);
      g_idle.notifyActivity(nowMs());  // re-energise drivers before the move
      for (std::size_t i = 0; i < n; ++i) {
        // The buffer is empty here (planner just went idle), so all chunks of
        // a single return move fit comfortably within the 32-deep ring.
        g_planner.submit(ret[i]);
      }
      break;
    }
    case app::AutoReturn::Action::Finalize:
      g_nvm.markCleanIdle();  // clear unclean marker: clean shutdown (Req 10.7)
      g_nvm.flushIfDue();
      g_conn.onDrawingFinished();
      sendState(diagnostics::StatusState::Idle);
      break;
    case app::AutoReturn::Action::None:
    default:
      break;
  }
}

}  // namespace

// ===========================================================================
// setup() / loop()
// ===========================================================================

void setup() {
  g_io.beginPins();

  // NVM first: every other module reads persisted state at begin().
  g_nvm.begin();
  // On an unclean shutdown begin() already cleared the calibrated flag and
  // retained logical position as a hint (Req 10.2 / 10.12, Design §4.4). The
  // HELLO frame surfaces the unclean flag so the SPA prompts the user to
  // verify or re-home.

  g_backlash.load();

  // WiFi/HTTP managers exist only in the WiFi image; under BLE they are never
  // constructed, so WiFi is never initialised at runtime (Req 1.6, 9.3). The
  // realtime transport (g_transport) is begun in both builds.
#if ETCH_TRANSPORT_RESOLVED == ETCH_TRANSPORT_WIFI
  g_wifi.begin();
  g_http.begin();
#endif
  g_transport.begin();

  g_planner.begin();
  g_status.begin();
  g_idle.begin(nowMs());

  // Diagnostics needs an ErrorSink that serialises a §4.5 ERROR frame.
  static diag::Diagnostics diag(
      g_io, [](const diag::DiagError& e) {
        sendError(e.kind, e.axis, e.detail);
      });
  diag.begin();
  g_diag_ptr = &diag;

  // StatusReporter emits a §4.7 payload; wrap it in a STATUS frame.
  g_status.setEmitSink([](const uint8_t* payload, size_t len) {
    sendFrame(protocol::FrameType::STATUS, payload,
              static_cast<uint16_t>(len));
  });
  g_status.setCalibrated(isCalibrated());

  // Route every fully-received inbound frame through the dispatcher.
  g_transport.onFrame(handleFrame);

  // Seed the live position display.
  g_status.setPosition(g_planner.position());
}

// Tracks whether a transport client owned the session on the previous loop
// pass so we can detect connect / disconnect edges and drive the §5.6 state
// machine and the HELLO handshake.
static bool s_client_was_connected = false;

void loop() {
  const uint32_t t = nowMs();

  // Fixed cooperative service order (Design §4.8). The WiFi/HTTP managers run
  // only in the WiFi image; under BLE they are excluded entirely (Req 1.6).
#if ETCH_TRANSPORT_RESOLVED == ETCH_TRANSPORT_WIFI
  g_wifi.supervise();
  g_http.serviceLoop();  // serve SPA + REST (AP config page, /api/wifi, etc.)
#endif
  g_transport.serviceLoop();

  // Detect transport connect / disconnect edges around the socket service.
  const bool connected = g_transport.isClientConnected();
  if (connected && !s_client_was_connected) {
    // Fresh session: greet with HELLO, then report any pending CONN_TIMEOUT
    // from a prior aborted drawing (Req 7.6).
    sendHello();
    const app::ConnectionMonitor::Action a = g_conn.onConnected(t);
    applyConnAction(a);
    if (g_conn.connTimeoutPending()) {
      sendError(0x04 /*CONN_TIMEOUT*/, diag::ERROR_AXIS_NONE, 0);
      g_conn.clearConnTimeoutPending();
    }
  } else if (!connected && s_client_was_connected) {
    applyConnAction(g_conn.onDisconnected(t));
  }
  s_client_was_connected = connected;

  // Sample buffer free-slots immediately before servicing the planner so we
  // can detect how many slots the planner consumes this pass and translate
  // each into a flow-control credit (Design §6.4). serviceLoop() starts at
  // most one new segment per call, so the delta is 0 or 1, but the loop below
  // handles any non-negative delta defensively.
  const uint8_t free_before = g_planner.freeSlots();

  g_planner.serviceLoop();
  g_diag_ptr->poll();

  const uint8_t free_after = g_planner.freeSlots();
  for (uint8_t i = free_before; i < free_after; ++i) {
    sendCredit(g_flow.onSlotConsumed());
  }

  // Drawing completion: auto-return to home then transition to clean idle
  // (Task 8.2, Req 10.7 / 14.7). Runs after the planner is serviced so it
  // observes the true idle/position state for this pass.
  serviceAutoReturn();

  // Keep telemetry fresh: position + RSSI feed the STATUS frame.
  g_status.setPosition(g_planner.position());
  // Signal_Strength (STATUS offset 9, i8 dBm): the WiFi build reads the
  // associated-AP RSSI; the BLE build reads the link RSSI sampled controller-
  // side in BleServer::serviceLoop() (Web Bluetooth hides it from the page).
  // Same byte layout, so the browser decode is unchanged (Design §3.8, Req 9.4).
#if ETCH_TRANSPORT_RESOLVED == ETCH_TRANSPORT_WIFI
  g_status.setRssiDbm(g_wifi.rssiDbm());
#else
  g_status.setRssiDbm(g_transport.lastRssiDbm());
#endif
  g_status.setBufferFull(g_planner.freeSlots() == 0);
  g_status.tick(t);

  // Connection-loss 60 s window (Design §5.6).
  applyConnAction(g_conn.tick(t));

  g_nvm.flushIfDue();

  // Keep the idle-timeout manager in sync with real motion. The MotionPlanner
  // energises the EN line directly per segment (and the JOG/BEGIN_DRAW paths
  // call g_io.setEnabled(true) directly), so without this the idle manager's
  // internal enabled_ flag desyncs from the physical EN line: during a long
  // draw notifyActivity() (only fired on CMD-enqueue) can fall silent for
  // >IDLE_TIMEOUT_MS, tick() flips enabled_ to false while the motors are still
  // physically energised, and from then on tick() early-returns forever — so EN
  // is never driven HIGH and the motors hum indefinitely after the draw ends.
  // Treat "planner not idle" as continuous activity: this keeps enabled_ true
  // through the whole drawing and restarts the 5 s countdown the instant the
  // planner goes idle, so holding torque is dropped ~IDLE_TIMEOUT_MS after the
  // last motion (Design §9.3, Req 6.8).
  if (!g_planner.isIdle()) {
    g_idle.notifyActivity(t);
  }
  g_idle.tick(t);
}

#endif  // defined(ARDUINO)
