// MotionPlanner - per-segment planning + GPT-timer-driven step generation
// (Task 6.9, Design §3.2.5).
//
// The planner is the consumer end of the 32-deep SPSC ring buffer. It pulls
// one Drawing_Command at a time, asks the BacklashCompensator whether to
// prepend an (uncounted) compensation phase on each axis, computes the
// trapezoidal speed schedule for the counted move, and coordinates the two
// axes with integer Bresenham. Step pulses are emitted at 1/16-microstep
// resolution (MICROSTEP_FACTOR), but the *logical* position is advanced only
// by counted full steps (Requirement 6.2; backlash steps are uncounted per
// task 6.7).
//
// Split of work (Design §2.4.2):
//   * serviceLoop() runs in the cooperative main loop. It builds the
//     per-segment StepProgram (both phases' Bresenham generators + the ramp),
//     stages the DIR pins, and finalises a completed segment (persisting the
//     logical position to NVM, debounced).
//   * onStepIsr() runs from the GPT timer ISR. It is short and allocation-free:
//     it advances the active Bresenham generator, pulses the STEP pins for one
//     microstep, and on each completed full step advances the logical-position
//     counter (counted phase only). No init(), no division beyond the ramp's
//     O(1) speedAt(), no heap.
//
// Host-testability seams (this header is Arduino-include-free):
//   * onStepIsr() is public, so a host test can drive ticks deterministically
//     without a real timer (no separate tick() shim is needed).
//   * Dependencies are injected by reference through narrow interfaces
//     (IStepSink for pin output, IMotionNvm for position persistence) plus the
//     concrete RingBuffer / BacklashCompensator, mirroring the INVMManager /
//     IBacklashStore pattern already used by WiFiManager and
//     BacklashCompensator. Host tests substitute in-memory fakes.
//   * All FspTimer / digitalWrite code lives behind `#if defined(ARDUINO)` in
//     the .cpp (and in the ArduinoStepSink defined there), so the planner
//     logic compiles and runs under `platform = native`.
//
// References:
//   - Requirements 6.1 (Bresenham), 6.2 (1/16 microstep, logical full steps),
//     6.3 (<=1000 sps ramp), 6.4 (32-deep buffer), 6.6 (stop: decel + discard
//     within 50 ms), 9.2 (pause within 50 ms), 9.4 (resume from exact pos),
//     9.5 (cancel: clear buffer within 100 ms).
//   - Design §3.2.5 (MotionPlanner surface), §2.4.2 (custom timer ISR stack),
//     §9.1 (CNC Shield pin map: X.STEP=D2, Y.STEP=D3, X.DIR=D5, Y.DIR=D6,
//     EN=D8).

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

#include "../backlash/backlash_compensator.h"  // etch::backlash::{Axis,...}
#include "../types.h"                           // DrawingCommand, Position, ...
#include "bresenham.h"
#include "ramp.h"
#include "ring_buffer.h"

namespace etch {
namespace motion {

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Per-step velocity increment fed to the trapezoidal ramp (sps added per
// emitted full step). Chosen conservatively so the NEMA-17-through-18:36 load
// never out-accelerates and stalls (Requirement 6.3). Used as the default;
// the value is not on the wire and can be retuned without protocol impact.
inline constexpr std::uint16_t MOTION_DEFAULT_ACCEL_SPS = 100;

// ---------------------------------------------------------------------------
// Pin-output abstraction (host seam)
// ---------------------------------------------------------------------------

// Narrow interface the planner uses to drive the A4988 STEP / DIR / EN lines.
// The concrete ArduinoStepSink (motion_planner.cpp, guarded by ARDUINO) maps
// these onto digitalWrite of the CNC Shield pins; host tests supply a fake
// that simply counts pulses so the microstep/position invariants are
// observable. A direction is in {-1, +1}; the planner never calls setDir*()
// with 0 (an axis that does not move is never re-directed).
class IStepSink {
 public:
  virtual ~IStepSink() = default;

  // Latch the DIR line for an axis ahead of the pulses for a segment.
  virtual void setDirX(std::int8_t dir) = 0;
  virtual void setDirY(std::int8_t dir) = 0;

  // Emit exactly one microstep pulse (a STEP rising+falling edge) on an axis.
  virtual void stepX() = 0;
  virtual void stepY() = 0;

  // Drive the shared active-low EN line: enabled == true energises the
  // drivers (EN LOW); false removes holding torque (EN HIGH).
  virtual void setEnabled(bool enabled) = 0;
};

// ---------------------------------------------------------------------------
// NVM facade (host seam)
// ---------------------------------------------------------------------------

// Minimum slice of NVMManager the planner needs to persist the logical
// position. The concrete NVMManager (firmware/src/nvm/) exposes both methods
// with identical signatures, so it satisfies this interface directly (or via a
// one-line adapter wired in task 8.1); host tests plug in an in-memory fake.
// The planner only ever STAGES an edit through mutate() at a segment boundary
// and nudges flushIfDue() when it goes idle -- it never writes per step
// (Design §3.2.7: debounced, 250 ms minimum interval).
class IMotionNvm {
 public:
  virtual ~IMotionNvm() = default;

  // Apply an edit to the cached PersistedConfig and mark it dirty.
  virtual void mutate(std::function<void(PersistedConfig&)> fn) = 0;

  // Commit the cached record if dirty and past the debounce window. No-op
  // otherwise. Safe to call redundantly with the main loop's own flush.
  virtual void flushIfDue() = 0;
};

// ---------------------------------------------------------------------------
// MotionPlanner
// ---------------------------------------------------------------------------

class MotionPlanner {
 public:
  using RingBufferT = RingBuffer<DrawingCommand, COMMAND_BUFFER_SIZE>;

  // All collaborators are injected by reference so host tests can substitute
  // fakes. `accelSps` defaults to MOTION_DEFAULT_ACCEL_SPS.
  MotionPlanner(RingBufferT& buffer, backlash::BacklashCompensator& backlash,
                IStepSink& sink, IMotionNvm& nvm,
                std::uint16_t accelSps = MOTION_DEFAULT_ACCEL_SPS);

  MotionPlanner(const MotionPlanner&) = delete;
  MotionPlanner& operator=(const MotionPlanner&) = delete;

  // One-time setup. On Arduino this configures the GPT timer (FspTimer) and
  // registers this instance as the ISR target; on the host it just resets
  // state. Idempotent.
  void begin();

  // --- Design §3.2.5 public surface ---------------------------------------

  // Enqueue a command. Returns false (without enqueuing) when the buffer is
  // full (Requirement 6.4, 6.5).
  bool submit(const DrawingCommand& cmd);

  // Cooperative tick: finalise a completed segment, then start the next one if
  // idle and not paused. Cheap to call every main-loop pass.
  void serviceLoop();

  // GPT timer ISR body. Advances the active Bresenham generator by one
  // microstep and updates the logical position on completed counted full
  // steps. Short and allocation-free.
  void onStepIsr();

  // Halt pulse generation while retaining the exact active-segment state so
  // resume() can continue from the same position (Requirements 9.2, 9.4).
  void pause();

  // Resume pulse generation after pause().
  void resume();

  // Discard all buffered commands and abort the active segment immediately
  // (Requirement 9.5: clear the buffer within 100 ms). Position is retained.
  void cancel();

  // Decelerate the active segment to a stop and discard buffered commands
  // (Requirement 6.6: within 50 ms). Position is retained at the last
  // completed full step (which is where the motors physically stop).
  void stop();

  // Current logical stylus position in counted full steps from home.
  Position position() const;

  // Declare the current physical position to be home: zero the logical
  // position counters (Requirement 10.5, Design §5.2 SET_HOME). Tiny adapter
  // added for task 8.1 so the main-loop Controller can service SET_HOME /
  // RE_HOME without reaching into the planner's private counters. Must only be
  // called while idle (no active segment); the caller is responsible for also
  // resetting the BacklashCompensator (onHome()) and persisting the calibrated
  // flag through NVM.
  void setHome();

  // Set the live speed-percent scaling applied to subsequent segments'
  // trapezoidal ramps (Requirements 9.7, 9.8; clamped to
  // [SPEED_PCT_MIN, SPEED_PCT_MAX]). Tiny adapter added for task 8.1 so the
  // Controller can service the SPEED_PCT control message. The new value takes
  // effect at the next segment boundary (beginSegment_), matching Req 9.8.
  void setSpeedPct(std::uint8_t pct);

  // Bump the logical position by a signed full-step delta on each axis,
  // WITHOUT generating any timer-driven motion. This exists for jog / manual
  // moves whose step pulses are emitted OUTSIDE the planner's timer-driven
  // segment path (e.g. the diagnostic blocking jog in etchasketch.ino that
  // pulses STEP directly to mirror the proven-reliable sample sketch). Because
  // those pulses never pass through onStepIsr(), the counted position would
  // otherwise drift; calling nudgePosition() with the same signed full-step
  // delta keeps position() authoritative for the calibration capture handlers.
  //
  // Deltas are COUNTED FULL STEPS, not microsteps -- do NOT pre-multiply by
  // MICROSTEP_FACTOR. Must only be called while the planner is idle (no active
  // segment); it mutates the same counters the ISR advances and does no
  // locking. Host-compilable (pure counter arithmetic, no Arduino includes).
  void nudgePosition(std::int32_t dxFullSteps, std::int32_t dyFullSteps);

  // Current live speed-percent scaling.
  std::uint8_t speedPct() const { return speed_pct_; }

  // Free ring-buffer slots, clamped into a byte for the credit accounting in
  // the protocol layer (Design §6.4).
  std::uint8_t freeSlots() const;

  // --- Diagnostics / status (used by the main loop & host tests) ----------

  // True when there is no active segment, no segment awaiting finalisation,
  // and the ring buffer is empty.
  bool isIdle() const;

  // True between pause() and resume().
  bool isPaused() const { return paused_; }

  // Total microstep pulses emitted since begin()/construction (both axes,
  // counted and uncounted). Exposed for host tests and diagnostics.
  std::uint32_t microstepsEmitted() const { return microsteps_emitted_; }

 private:
  // Which Bresenham generator onStepIsr() is currently advancing.
  enum class Phase : std::uint8_t {
    Idle,      // no active program
    Backlash,  // uncounted compensation steps (not added to position)
    Main,      // counted move steps (added to position)
  };

  // Build the StepProgram (backlash + main Bresenham generators, ramp, DIR
  // pins) for `cmd` and arm the ISR. Runs in the main loop only.
  void beginSegment_(const DrawingCommand& cmd);

  // Fetch the next full-step tick into cur_, advancing the phase across the
  // backlash->main boundary. Returns false when the whole program is done.
  bool fetchNextTick_();

  // Stage the current logical position into NVM (debounced commit handled by
  // the NVM layer). Called at segment boundaries, never per step.
  void persistPosition_();

  // Reset the active-program state to Idle (used by cancel()/stop()).
  void abortProgram_();

  // sign of a signed delta in {-1, 0, +1}.
  static std::int8_t signOf_(std::int32_t v);

  // clamp a wire feed rate into [FEED_SPS_MIN, FEED_SPS_MAX].
  static std::uint16_t clampFeed_(std::uint16_t feed);

  // --- Hardware seams (no-ops on host) ------------------------------------
  void configureTimer_();  // begin(): set up FspTimer (programmed ONCE)
  void startTimer_();      // arm the constant-rate ISR for a segment
  void stopTimer_();       // disarm when idle

  // --- Collaborators ------------------------------------------------------
  RingBufferT& buffer_;
  backlash::BacklashCompensator& backlash_;
  IStepSink& sink_;
  IMotionNvm& nvm_;
  std::uint16_t accel_sps_;

  // Live speed-percent scaling applied to the ramp peak of subsequent segments
  // (Requirements 9.7, 9.8). Defaults to 100% (no scaling); updated by
  // setSpeedPct() and read in beginSegment_().
  std::uint8_t speed_pct_ = SPEED_PCT_MAX;
  // --- StepProgram (rebuilt per segment in the main loop) -----------------
  BresenhamLine backlash_line_;
  BresenhamLine main_line_;
  TrapezoidRamp ramp_;
  std::uint32_t main_step_index_ = 0;  // counted full-step index for the ramp

  // --- ISR-advanced state (shared across the ISR/main-loop boundary) ------
  // `volatile` for the same single-core SPSC reasons documented in
  // ring_buffer.h: head-of-line state has a single writer on each side and
  // 32-bit aligned access is atomic on the RA4M1.
  volatile Phase phase_ = Phase::Idle;
  StepOutput cur_ = {false, false, 0, 0};   // current full-step tick
  volatile std::int32_t micro_remaining_ = 0;  // microsteps left in this step
  volatile bool program_active_ = false;       // a segment is in flight
  volatile bool program_complete_ = false;     // ISR finished; await finalise
  volatile bool paused_ = false;               // pause()/resume() gate

  // Logical position in counted full steps from home (Requirement 6.2).
  volatile std::int32_t x_steps_ = 0;
  volatile std::int32_t y_steps_ = 0;

  // Cumulative microstep pulse count (diagnostics/tests).
  volatile std::uint32_t microsteps_emitted_ = 0;

  // Software step divider (DDS phase accumulator). On each fixed-rate tick we
  // add the current commanded microstep rate to acc_; when acc_ >=
  // STEP_TICK_HZ we subtract STEP_TICK_HZ and emit one microstep. This
  // realizes an average microstep rate of cur_micro_hz_ with no per-step timer
  // reprogramming and no per-tick division (cur_micro_hz_ is recomputed only at
  // full-step boundaries).
  volatile std::uint32_t acc_ = 0;            // phase accumulator
  volatile std::uint32_t cur_micro_hz_ = 0;   // commanded microstep rate for the active full step
};

}  // namespace motion
}  // namespace etch
