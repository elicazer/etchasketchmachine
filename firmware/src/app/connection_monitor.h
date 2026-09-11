// ConnectionMonitor - WebSocket connection-loss state machine (Task 8.1,
// Design §5.6, Requirements 7.5, 7.6).
//
// When the single WebSocket session drops while a drawing is in progress, the
// Controller must pause the motion executor and retain position, hold the
// command buffer, and start a 60-second reconnect window. If the client
// reconnects inside that window the drawing resumes; if the window elapses the
// drawing is aborted, the position is retained, NVM is marked clean, and a
// CONN_TIMEOUT error is reported to the client on its next connection
// (Design §6.2 WiFi-loss table, §5.6 sequence diagram).
//
// This is a pure, host-testable state machine with no Arduino, socket, or
// motion dependencies — exactly like SequenceTracker / FlowController in the
// protocol layer. The Controller (app/controller.{h,cpp}) drives it by calling
// the lifecycle methods and performs the returned Action on the real modules
// (MotionPlanner.pause()/resume()/cancel(), NVMManager.markCleanIdle(), and the
// CONN_TIMEOUT ERROR frame). Time is always supplied by the caller as a
// millisecond stamp so the logic is fully deterministic under host tests.
//
// References:
//   - Requirement 7.5 (WS loss mid-drawing: pause + retain, resume within 60 s)
//   - Requirement 7.6 (60 s exceeded: abort, retain position, report timeout)
//   - Design §5.6 (connection loss sequence), §6.2 (WiFi-loss recovery table)

#pragma once

#include <cstdint>

namespace etch {
namespace app {

// Reconnect window after a mid-drawing WebSocket disconnect (Requirement 7.5,
// 7.6). Not on the wire, so retunable without protocol impact.
inline constexpr std::uint32_t CONN_RECONNECT_WINDOW_MS = 60000;

class ConnectionMonitor {
 public:
  // The action the Controller must perform after a lifecycle call. Mapped onto
  // the real modules:
  //   None          -> nothing
  //   PauseDrawing  -> MotionPlanner.pause(); STATE paused (retain position)
  //   ResumeDrawing -> MotionPlanner.resume(); STATE drawing
  //   AbortDrawing  -> MotionPlanner.cancel(); NVMManager.markCleanIdle();
  //                    STATE aborted (CONN_TIMEOUT reported on next connect)
  enum class Action : std::uint8_t {
    None          = 0,
    PauseDrawing  = 1,
    ResumeDrawing = 2,
    AbortDrawing  = 3,
  };

  explicit ConnectionMonitor(std::uint32_t windowMs = CONN_RECONNECT_WINDOW_MS)
      : window_ms_(windowMs) {}

  // Drawing lifecycle, driven by the CTL layer (BEGIN_DRAW / END_DRAW / cancel
  // / completion). A drawing must be "in progress" for a disconnect to trigger
  // the pause / 60 s window machinery (Design §5.6 only applies mid-drawing).
  void onDrawingStarted() { drawing_ = true; }
  void onDrawingFinished() {
    drawing_ = false;
    // A clean finish while waiting to reconnect cancels the abort timer.
    if (state_ == State::WaitingReconnect) {
      state_ = State::Disconnected;
    }
  }

  // WebSocket disconnect detected (ping/pong missed twice, Design §5.6).
  // Returns PauseDrawing iff this drop happened mid-drawing while connected;
  // idempotent on repeated calls and a no-op when no drawing is active.
  Action onDisconnected(std::uint32_t nowMs) {
    if (state_ != State::Connected) {
      return Action::None;  // already disconnected
    }
    if (drawing_) {
      state_ = State::WaitingReconnect;
      disconnect_ms_ = nowMs;
      return Action::PauseDrawing;
    }
    state_ = State::Disconnected;
    return Action::None;
  }

  // WebSocket (re)connect. Returns ResumeDrawing iff we were inside the
  // reconnect window of a mid-drawing disconnect (Requirement 7.5). The
  // CONN_TIMEOUT-pending flag is independent and is left for the Controller to
  // drain via connTimeoutPending() / clearConnTimeoutPending() after the HELLO.
  Action onConnected(std::uint32_t /*nowMs*/) {
    const bool wasWaiting = (state_ == State::WaitingReconnect);
    state_ = State::Connected;
    return wasWaiting ? Action::ResumeDrawing : Action::None;
  }

  // Cooperative tick. Returns AbortDrawing exactly once when the reconnect
  // window elapses while still disconnected mid-drawing (Requirement 7.6),
  // latching connTimeoutPending() for the next connection. No-op otherwise.
  // Unsigned subtraction keeps the elapsed check correct across the 32-bit
  // millis() wrap.
  Action tick(std::uint32_t nowMs) {
    if (state_ != State::WaitingReconnect) {
      return Action::None;
    }
    if (static_cast<std::uint32_t>(nowMs - disconnect_ms_) >= window_ms_) {
      state_ = State::Disconnected;
      drawing_ = false;
      conn_timeout_pending_ = true;
      return Action::AbortDrawing;
    }
    return Action::None;
  }

  // True iff a CONN_TIMEOUT must be reported to the client on its next
  // connection (Requirement 7.6). Set by tick() on abort; cleared by the
  // Controller after the ERROR frame is emitted.
  bool connTimeoutPending() const { return conn_timeout_pending_; }
  void clearConnTimeoutPending() { conn_timeout_pending_ = false; }

  // Diagnostics / test inspection.
  bool isConnected() const { return state_ == State::Connected; }
  bool isDrawing() const { return drawing_; }
  bool isWaitingReconnect() const { return state_ == State::WaitingReconnect; }

 private:
  enum class State : std::uint8_t {
    Connected,         // session live
    Disconnected,      // dropped, not mid-draw (no pause / timer)
    WaitingReconnect,  // dropped mid-draw, 60 s timer running, planner paused
  };

  std::uint32_t window_ms_;
  State         state_ = State::Disconnected;  // no client at boot
  bool          drawing_ = false;
  bool          conn_timeout_pending_ = false;
  std::uint32_t disconnect_ms_ = 0;
};

}  // namespace app
}  // namespace etch
