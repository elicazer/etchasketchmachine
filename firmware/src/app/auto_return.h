// AutoReturn - drawing-completion / return-to-home state machine (Task 8.2,
// Requirements 10.7 & 14.7, Design §5.2).
//
// When a drawing finishes, the Controller must automatically drive the stylus
// from wherever the last user segment left it back to Home (0,0) before going
// idle. Because the Etch-a-Sketch stylus cannot be lifted, that return travel
// is itself a visible line, i.e. a Connector_Segment (Req 14.7). Once the
// stylus is parked at home and the planner is idle, the NVM record is marked
// clean-idle (unclean=false) so the next boot is treated as a clean shutdown
// (Design §4.4).
//
// In the normal streamed case the browser Path_Planner already appends an
// auto-return connector to the command stream (task 12.2), so the firmware
// simply executes it like any other command. This module is the *firmware-side
// guarantee* of Req 10.7: even if the stream does not end exactly at home (a
// short stream, a client that omitted the connector, rounding, ...), the
// Controller still parks at home and transitions to clean idle.
//
// The logic is a pure, host-testable state machine with no Arduino, socket, or
// motion dependencies — mirroring app::ConnectionMonitor. The main-loop
// Controller (etchasketch.ino) drives it:
//
//   * BEGIN_DRAW          -> onBeginDraw()   (a draw session is now active)
//   * END_DRAW            -> onEndDraw()     (await drain, then return home)
//   * CANCEL / STOP / abort-> reset()        (no auto-return on a cancel)
//   * every loop pass     -> poll(plannerIdle, pos) and perform the Action:
//       - EnqueueReturn : build the connector command(s) toward (0,0) with
//                         buildReturnCommands() and submit them to the planner.
//       - Finalize      : MotionPlanner is idle AT home -> NVMManager
//                         .markCleanIdle() + flush + STATE idle.
//
// References:
//   - Requirement 10.7 (auto-return to home before idle, as a connector).
//   - Requirement 14.7 (render the return travel as a Connector_Segment).
//   - Design §5.2 (normal drawing flow with auto-return), §4.4 (clean idle).

#pragma once

#include <cstddef>
#include <cstdint>

#include "../types.h"  // DrawingCommand, Position, CMD_FLAG_*, FEED_SPS_MAX

namespace etch {
namespace app {

// Inclusive i16 wire-delta limit for a single Drawing_Command dx/dy (Design
// §4.3). Mirrors the web `DRAWING_COMMAND_DELTA_MAX` so the firmware split
// matches the browser `splitMotion` behaviour. A return move whose per-axis
// magnitude exceeds this is fanned out across several consecutive commands.
inline constexpr std::int32_t RETURN_DELTA_MAX = 32767;

// Feed rate used for the synthesized return-to-home connector. The travel is
// "just" repositioning, so it runs at the step-rate ceiling; the planner still
// applies any live SPEED_PCT scaling and trapezoidal ramp on top (Req 6.3).
inline constexpr std::uint16_t RETURN_FEED_SPS = FEED_SPS_MAX;

// Upper bound on the number of commands a single return move can fan out into.
// The drawable area is at most a few hundred full steps per axis (152x105 mm,
// ~400 steps / 100 mm), far below RETURN_DELTA_MAX, so a return is normally a
// single command. This bound covers any realistic calibration with generous
// head-room (8 * 32767 ~= 262k steps/axis) so the caller can stack-allocate.
inline constexpr std::size_t AUTO_RETURN_MAX_COMMANDS = 8;

// Round num/den to the nearest integer (half away from zero). `den` MUST be
// positive. Used for the cumulative-rounding split below; the exact endpoint
// is reproduced regardless of rounding because the running total telescopes.
inline std::int32_t autoReturnRoundDiv(std::int64_t num, std::int32_t den) {
  const std::int64_t d = static_cast<std::int64_t>(den);
  if (num >= 0) {
    return static_cast<std::int32_t>((num + d / 2) / d);
  }
  return static_cast<std::int32_t>(-((-num + d / 2) / d));
}

// Build the Drawing_Command(s) that move the stylus from (x, y) back to home
// (0, 0). The logical motion is (dx, dy) = (-x, -y), split with cumulative
// rounding into the smallest number of equal shares whose per-axis magnitude
// is <= RETURN_DELTA_MAX (mirroring web `splitMotion`). The concatenated
// deltas reproduce (-x, -y) exactly, so the final command lands precisely on
// home (Property 12 / Req 7.8).
//
// Every emitted command carries CMD_FLAG_CONNECTOR (the return is a visible
// connector line, Req 14.7); only the final command carries
// CMD_FLAG_LAST_OF_BATCH. `seq` numbers run from `seqStart`. Returns the
// number of commands written (0 when already at home, capped at `cap`).
inline std::size_t buildReturnCommands(std::int32_t x, std::int32_t y,
                                       std::uint16_t feed,
                                       std::uint32_t seqStart,
                                       DrawingCommand* out, std::size_t cap) {
  if (out == nullptr || cap == 0) {
    return 0;
  }
  const std::int32_t dx = -x;
  const std::int32_t dy = -y;
  if (dx == 0 && dy == 0) {
    return 0;  // already home: no motion needed
  }

  const std::int32_t adx = dx < 0 ? -dx : dx;
  const std::int32_t ady = dy < 0 ? -dy : dy;

  // Smallest N so every chunk stays within the i16 wire bound on both axes.
  std::int32_t n = 1;
  if (adx > RETURN_DELTA_MAX) {
    const std::int32_t need = (adx + RETURN_DELTA_MAX - 1) / RETURN_DELTA_MAX;
    if (need > n) n = need;
  }
  if (ady > RETURN_DELTA_MAX) {
    const std::int32_t need = (ady + RETURN_DELTA_MAX - 1) / RETURN_DELTA_MAX;
    if (need > n) n = need;
  }

  std::size_t count = 0;
  std::int32_t prevCumX = 0;
  std::int32_t prevCumY = 0;
  for (std::int32_t i = 1; i <= n && count < cap; ++i) {
    const std::int32_t cumX =
        autoReturnRoundDiv(static_cast<std::int64_t>(i) * dx, n);
    const std::int32_t cumY =
        autoReturnRoundDiv(static_cast<std::int64_t>(i) * dy, n);
    const std::int32_t dxi = cumX - prevCumX;
    const std::int32_t dyi = cumY - prevCumY;
    prevCumX = cumX;
    prevCumY = cumY;

    DrawingCommand& c = out[count++];
    c.seq = seqStart + static_cast<std::uint32_t>(i - 1);
    c.dx_steps = static_cast<std::int16_t>(dxi);
    c.dy_steps = static_cast<std::int16_t>(dyi);
    c.feed_sps = feed;
    c.flags = static_cast<std::uint16_t>(
        CMD_FLAG_CONNECTOR | (i == n ? CMD_FLAG_LAST_OF_BATCH : 0));
    c.reserved = 0;
    c.crc16_payload = 0;  // firmware-internal submission; CRC unused by planner
  }
  return count;
}

// Drawing-completion / return-to-home state machine.
class AutoReturn {
 public:
  // The action the Controller must perform after poll():
  //   None          -> nothing this pass
  //   EnqueueReturn -> build buildReturnCommands(pos) and submit to the planner
  //   Finalize      -> planner idle AT home: markCleanIdle() + flush + STATE idle
  enum class Action : std::uint8_t {
    None          = 0,
    EnqueueReturn = 1,
    Finalize      = 2,
  };

  // CTL BEGIN_DRAW: a draw session is now active. Clears any stale awaiting /
  // enqueued state so a fresh drawing always starts clean.
  void onBeginDraw() {
    session_active_ = true;
    awaiting_return_ = false;
    return_enqueued_ = false;
  }

  // CTL END_DRAW: the client has finished streaming. Once the planner drains
  // we drive the return-to-home. Ignored if no session is active (a stray
  // END_DRAW cannot trigger an auto-return).
  void onEndDraw() {
    if (session_active_) {
      awaiting_return_ = true;
    }
  }

  // CANCEL / STOP / connection-loss abort: drop the session with no return.
  void reset() {
    session_active_ = false;
    awaiting_return_ = false;
    return_enqueued_ = false;
  }

  // Cooperative poll, called once per main-loop pass with the planner's idle
  // state (no active segment + empty buffer) and current logical position.
  //
  // Behaviour (only while awaiting return and the planner is idle):
  //   * pos != home -> EnqueueReturn exactly once. The guard prevents asking
  //     again before the just-submitted return move has been picked up by the
  //     planner (which makes it non-idle on the next pass), so the synthesized
  //     return move never re-triggers another return (Task 8.2 guidance).
  //   * pos == home -> Finalize exactly once, then reset() so the auto-return
  //     fires at most once per drawing.
  Action poll(bool plannerIdle, std::int32_t x, std::int32_t y) {
    if (!awaiting_return_ || !plannerIdle) {
      return Action::None;
    }
    if (x != 0 || y != 0) {
      if (return_enqueued_) {
        return Action::None;  // return already submitted; await its execution
      }
      return_enqueued_ = true;
      return Action::EnqueueReturn;
    }
    // Idle and at home: park complete. Finalize once and forget the session.
    reset();
    return Action::Finalize;
  }

  // Position overload for the common planner.position() call site.
  Action poll(bool plannerIdle, const Position& pos) {
    return poll(plannerIdle, pos.x_steps, pos.y_steps);
  }

  // Diagnostics / test inspection.
  bool sessionActive() const { return session_active_; }
  bool awaitingReturn() const { return awaiting_return_; }
  bool returnEnqueued() const { return return_enqueued_; }

 private:
  bool session_active_ = false;  // between BEGIN_DRAW and finalize/cancel
  bool awaiting_return_ = false; // END_DRAW seen; waiting for drain then home
  bool return_enqueued_ = false; // the return command(s) have been submitted
};

}  // namespace app
}  // namespace etch
