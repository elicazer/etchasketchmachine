// MotionPlanner implementation (Task 6.9). See motion_planner.h for the full
// contract and the host/Arduino seam rationale.
//
// The file has three layers, mirroring wifi_manager.cpp:
//
//   1. Planner logic (always compiled). Pure C++ that pulls commands from the
//      ring buffer, applies backlash, runs the ramp + Bresenham, advances the
//      logical position on counted full steps, and persists position at
//      segment boundaries. Host tests exercise this directly by calling
//      onStepIsr() in a loop.
//
//   2. Hardware seam methods (configureTimer_ / startTimer_ / stopTimer_).
//      Real FspTimer (GPT) code under `#if defined(ARDUINO)`; no-ops on the
//      host so the planner runs deterministically under `platform = native`.
//      The GPT is programmed ONCE to a fixed STEP_TICK_HZ and never reprogrammed
//      per step; onStepIsr() realises the commanded feed in software (DDS).
//
//   3. ArduinoStepSink + ISR trampoline, entirely behind `#if defined(ARDUINO)`.
//      Maps IStepSink onto the CNC Shield pins (Design §9.1) and routes the GPT
//      overflow IRQ to the active planner instance.

#include "motion_planner.h"

#if defined(ARDUINO)
#  include <Arduino.h>
#  include <FspTimer.h>
#endif

namespace etch {
namespace motion {

// ---------------------------------------------------------------------------
// Construction / lifecycle
// ---------------------------------------------------------------------------

MotionPlanner::MotionPlanner(RingBufferT& buffer,
                             backlash::BacklashCompensator& backlash,
                             IStepSink& sink, IMotionNvm& nvm,
                             std::uint16_t accelSps)
    : buffer_(buffer),
      backlash_(backlash),
      sink_(sink),
      nvm_(nvm),
      accel_sps_(accelSps == 0 ? 1 : accelSps) {}

void MotionPlanner::begin() {
  phase_ = Phase::Idle;
  program_active_ = false;
  program_complete_ = false;
  paused_ = false;
  micro_remaining_ = 0;
  main_step_index_ = 0;
  cur_ = StepOutput{false, false, 0, 0};
  acc_ = 0;
  cur_micro_hz_ = 0;
  configureTimer_();
}

// ---------------------------------------------------------------------------
// Static helpers
// ---------------------------------------------------------------------------

std::int8_t MotionPlanner::signOf_(std::int32_t v) {
  return static_cast<std::int8_t>((v > 0) - (v < 0));
}

std::uint16_t MotionPlanner::clampFeed_(std::uint16_t feed) {
  if (feed < FEED_SPS_MIN) return FEED_SPS_MIN;
  if (feed > FEED_SPS_MAX) return FEED_SPS_MAX;
  return feed;
}

// ---------------------------------------------------------------------------
// Design §3.2.5 public surface
// ---------------------------------------------------------------------------

bool MotionPlanner::submit(const DrawingCommand& cmd) {
  // Producer side from the planner's perspective is the protocol layer; here
  // we simply forward to the ring buffer, which returns false when full
  // (Requirement 6.4 / 6.5).
  return buffer_.push(cmd);
}

void MotionPlanner::serviceLoop() {
  // 1) Finalise a segment the ISR just completed: persist the logical
  //    position once per segment (debounced by the NVM layer), never per step.
  if (program_complete_) {
    program_complete_ = false;
    persistPosition_();
  }

  // 2) If the planner is idle and not paused, start the next buffered command.
  if (!program_active_ && !paused_) {
    DrawingCommand cmd;
    if (buffer_.pop(cmd)) {
      beginSegment_(cmd);
    } else {
      // Truly idle: nudge a debounced flush so the last position lands while
      // quiescent (Design §3.2.7, Requirement 10.6). flushIfDue() is a no-op
      // unless the cache is dirty and the debounce window has elapsed.
      nvm_.flushIfDue();
    }
  }
}

void MotionPlanner::onStepIsr() {
  // Keep this short and allocation-free (Design §2.4.2). When paused or with no
  // active program there is nothing to pulse.
  if (paused_ || !program_active_) {
    return;
  }

  // Software step divider (DDS phase accumulator). The GPT fires at a fixed
  // STEP_TICK_HZ; we realise the commanded microstep rate purely in software by
  // accumulating cur_micro_hz_ per tick and emitting one microstep only when
  // the accumulator rolls over STEP_TICK_HZ. Empty ticks cost a single add +
  // compare (the cheapest possible ISR path), so even at slow speeds the
  // cooperative loop keeps servicing BLE / credits / pause / stop.
  acc_ += cur_micro_hz_;
  if (acc_ < STEP_TICK_HZ) {
    return;  // no microstep this tick (commanded rate < tick rate)
  }
  acc_ -= STEP_TICK_HZ;  // emit exactly one microstep on this tick

  // Emit one microstep pulse on each axis that steps on the current full-step
  // tick. MICROSTEP_FACTOR microsteps make up one full motor step.
  if (cur_.stepX) {
    sink_.stepX();
    ++microsteps_emitted_;
  }
  if (cur_.stepY) {
    sink_.stepY();
    ++microsteps_emitted_;
  }

  --micro_remaining_;
  if (micro_remaining_ > 0) {
    return;  // more microsteps remain for this full step
  }

  // The full step (one Bresenham tick) is complete. Count it toward the
  // logical position ONLY in the main phase; backlash compensation steps are
  // uncounted (Requirement 6.2 / 13.7).
  if (phase_ == Phase::Main) {
    if (cur_.stepX) x_steps_ += cur_.dirX;
    if (cur_.stepY) y_steps_ += cur_.dirY;
  }

  // Advance to the next tick; if the whole program (backlash + main) is done,
  // hand the segment back to serviceLoop() for finalisation.
  if (!fetchNextTick_()) {
    program_active_ = false;
    program_complete_ = true;
    stopTimer_();
  }
}

void MotionPlanner::pause() {
  // Gate the ISR (it returns immediately while paused_) and disarm the timer.
  // The active-segment state (Bresenham generators, ramp index, micro_remaining_)
  // is retained verbatim so resume() continues from the exact position
  // (Requirements 9.2, 9.4). onStepIsr() checks paused_ first, so pulse
  // generation halts at the very next tick boundary -- well within 50 ms.
  paused_ = true;
  stopTimer_();
}

void MotionPlanner::resume() {
  if (!paused_) {
    return;
  }
  paused_ = false;
  // Only re-arm the timer if a segment is mid-flight; if the planner went idle
  // while paused there is nothing to resume and serviceLoop() will pick up the
  // next command.
  if (program_active_) {
    startTimer_();
  }
}

void MotionPlanner::cancel() {
  // Abort the active segment and discard everything queued. Clearing a 32-deep
  // buffer plus dropping the active program is O(32) and trivially within the
  // 100 ms budget (Requirement 9.5). The logical position is retained at the
  // last completed full step.
  abortProgram_();
  DrawingCommand discard;
  while (buffer_.pop(discard)) {
    // drain
  }
  paused_ = false;
}

void MotionPlanner::stop() {
  // Requirement 6.6: decelerate to a stop within 50 ms and discard buffered
  // commands. The ramp already brings every segment back down to FEED_SPS_MIN
  // (100 sps) at its tail, and a controlled halt of the active segment plus a
  // buffer drain completes far inside 50 ms at the <=1000 sps step rate. We
  // therefore halt the active program immediately and discard the queue; the
  // motors stop at the last completed full step (which is the retained logical
  // position). A finer multi-step decel ramp is a hardware-tuning refinement
  // tracked with the main-loop integration (task 8.1) and does not change this
  // contract.
  abortProgram_();
  DrawingCommand discard;
  while (buffer_.pop(discard)) {
    // drain remaining commands
  }
  paused_ = false;
}

Position MotionPlanner::position() const {
  Position p;
  p.x_steps = x_steps_;
  p.y_steps = y_steps_;
  return p;
}

void MotionPlanner::setHome() {
  // Declare the current physical position to be home (Requirement 10.5,
  // Design §5.2). Only meaningful while idle; zero the counted-position
  // counters so subsequent moves are relative to the new origin. The caller
  // (task 8.1 Controller) also calls BacklashCompensator::onHome() and
  // persists the calibrated flag via NVM.
  x_steps_ = 0;
  y_steps_ = 0;
}

void MotionPlanner::nudgePosition(std::int32_t dxFullSteps,
                                  std::int32_t dyFullSteps) {
  // Advance the counted logical position by a signed full-step delta without
  // generating any motion. Used for jog / manual moves whose pulses are emitted
  // outside the timer-driven segment path (see header). Pure counter mutation;
  // must only be called while idle so it never races onStepIsr().
  x_steps_ += dxFullSteps;
  y_steps_ += dyFullSteps;
}

void MotionPlanner::setSpeedPct(std::uint8_t pct) {
  // Clamp into [SPEED_PCT_MIN, SPEED_PCT_MAX] (Requirement 9.7). The value is
  // applied at the next beginSegment_() so an in-flight segment finishes at
  // its current schedule (Requirement 9.8: applied at the next segment
  // boundary).
  if (pct < SPEED_PCT_MIN) pct = SPEED_PCT_MIN;
  if (pct > SPEED_PCT_MAX) pct = SPEED_PCT_MAX;
  speed_pct_ = pct;
}

std::uint8_t MotionPlanner::freeSlots() const {
  const std::size_t free = buffer_.freeSlots();
  return (free > 0xFFu) ? 0xFFu : static_cast<std::uint8_t>(free);
}

bool MotionPlanner::isIdle() const {
  return !program_active_ && !program_complete_ && buffer_.empty();
}

// ---------------------------------------------------------------------------
// Per-segment planning (main loop)
// ---------------------------------------------------------------------------

void MotionPlanner::beginSegment_(const DrawingCommand& cmd) {
  const std::int32_t dx = cmd.dx_steps;
  const std::int32_t dy = cmd.dy_steps;
  const std::int8_t dirX = signOf_(dx);
  const std::int8_t dirY = signOf_(dy);

  // Ask the compensator for the uncounted compensation-step count per axis. A
  // non-zero result means this move reverses that axis versus the last move;
  // prepareForMove() also updates the remembered direction. An axis that does
  // not move (dir == 0) yields 0 and leaves its remembered direction intact
  // (Requirement 13.4, 13.6).
  const std::uint8_t compX = backlash_.prepareForMove(backlash::Axis::X, dirX);
  const std::uint8_t compY = backlash_.prepareForMove(backlash::Axis::Y, dirY);

  // Latch the DIR lines to the move direction ahead of any pulses. Both the
  // backlash phase and the main phase travel in the same direction, so the DIR
  // pins are set once here and never toggled mid-segment. Leave a non-moving
  // axis's DIR untouched.
  if (dirX != 0) sink_.setDirX(dirX);
  if (dirY != 0) sink_.setDirY(dirY);
  sink_.setEnabled(true);

  // Backlash phase: travel `comp` steps on each axis in the move direction,
  // coordinated with Bresenham so a diagonal reversal takes up slack on both
  // axes together. These ticks are uncounted.
  backlash_line_.reset(dirX * static_cast<std::int32_t>(compX),
                       dirY * static_cast<std::int32_t>(compY));

  // Main phase: the counted move.
  main_line_.reset(dx, dy);

  // Trapezoidal speed schedule over the counted steps. vMin is the gentle
  // pull-in start speed MOTION_START_SPS (BELOW the protocol FEED_SPS_MIN) so
  // the segment eases in from the motor's pull-in rate and never cold-starts
  // above it; vPeak is the command's clamped feed rate (Requirements 5.5, 6.3).
  // The ramp accelerates from MOTION_START_SPS up to the requested feed.
  const std::uint32_t mainSteps =
      static_cast<std::uint32_t>(main_line_.totalSteps());
  ramp_.init(mainSteps == 0 ? 1u : mainSteps, MOTION_START_SPS,
             clampFeed_(cmd.feed_sps), accel_sps_, speed_pct_);
  main_step_index_ = 0;

  // Start in the backlash phase iff there are compensation steps; otherwise go
  // straight to the main phase.
  phase_ = backlash_line_.done() ? Phase::Main : Phase::Backlash;
  program_complete_ = false;

  // Reset the DDS phase accumulator so a new segment starts on a clean phase.
  acc_ = 0;

  if (!fetchNextTick_()) {
    // Degenerate move (dx == dy == 0 and no backlash): nothing to pulse. Mark
    // it complete so serviceLoop() persists the unchanged position and moves
    // on to the next command.
    phase_ = Phase::Idle;
    program_active_ = false;
    program_complete_ = true;
    return;
  }

  // Publish program_active_ last so a preempting onStepIsr() never observes a
  // half-built program (the ISR returns early while program_active_ is false).
  program_active_ = true;
  startTimer_();
}

bool MotionPlanner::fetchNextTick_() {
  // Pull the next full-step tick, transitioning backlash -> main when the
  // compensation phase is exhausted. Sequential (not else-if) so a single call
  // can cross the phase boundary when the backlash phase has zero remaining
  // steps.
  if (phase_ == Phase::Backlash) {
    if (backlash_line_.nextStep(cur_)) {
      micro_remaining_ = MICROSTEP_FACTOR;
      // Backlash comp steps run flat (no ramp), and they are the very first
      // pulses of a segment when present -- a cold start. Clock them at the
      // gentle pull-in rate MOTION_START_SPS (not FEED_SPS_MIN) so taking up
      // slack never starts above the motor's pull-in rate and stalls. The
      // software DDS divider in onStepIsr() realises this microstep rate
      // against the fixed STEP_TICK_HZ tick; no timer reprogramming.
      cur_micro_hz_ = static_cast<std::uint32_t>(MOTION_START_SPS) *
                      MICROSTEP_FACTOR;
      return true;
    }
    phase_ = Phase::Main;
    main_step_index_ = 0;
  }

  if (phase_ == Phase::Main) {
    if (main_line_.nextStep(cur_)) {
      micro_remaining_ = MICROSTEP_FACTOR;
      // Commanded microstep rate for this counted full step, read once at the
      // full-step boundary from the trapezoid schedule (no per-microstep
      // division). onStepIsr() divides STEP_TICK_HZ down to this rate in
      // software.
      cur_micro_hz_ = static_cast<std::uint32_t>(ramp_.speedAt(main_step_index_)) *
                      MICROSTEP_FACTOR;
      ++main_step_index_;
      return true;
    }
    phase_ = Phase::Idle;
  }

  return false;
}

void MotionPlanner::persistPosition_() {
  // Stage the logical position into the cached NVM record. The NVM layer
  // commits it on a later debounced flushIfDue() (Design §3.2.7); we never
  // force a write here, so a fast burst of short segments coalesces into at
  // most one flash write per debounce window.
  const std::int32_t x = x_steps_;
  const std::int32_t y = y_steps_;
  nvm_.mutate([x, y](PersistedConfig& cfg) {
    cfg.logical_pos_x = x;
    cfg.logical_pos_y = y;
  });
}

void MotionPlanner::abortProgram_() {
  // Disarm and drop the active program without touching the logical position.
  stopTimer_();
  program_active_ = false;
  program_complete_ = false;
  phase_ = Phase::Idle;
  micro_remaining_ = 0;
  acc_ = 0;
  cur_micro_hz_ = 0;
  cur_ = StepOutput{false, false, 0, 0};
}

// ---------------------------------------------------------------------------
// Hardware seam: GPT timer (FspTimer) -- real on Arduino, no-op on host
// ---------------------------------------------------------------------------

#if defined(ARDUINO)

namespace {

// CNC Shield V3.0 -> Arduino pin map for the X and Y axes (Design §9.1).
constexpr std::uint8_t PIN_X_STEP = 2;   // D2  -> A4988 X STEP
constexpr std::uint8_t PIN_Y_STEP = 3;   // D3  -> A4988 Y STEP
constexpr std::uint8_t PIN_X_DIR  = 5;   // D5  -> A4988 X DIR
constexpr std::uint8_t PIN_Y_DIR  = 6;   // D6  -> A4988 Y DIR
constexpr std::uint8_t PIN_EN     = 8;   // D8  -> shared active-low ENABLE

// A4988 STEP needs only a ~1 us minimum high pulse; a single NOP-ish delay is
// plenty at our <=1000 full-sps (16 kHz microstep) ceiling.
inline void pulse(std::uint8_t pin) {
  digitalWrite(pin, HIGH);
  delayMicroseconds(2);
  digitalWrite(pin, LOW);
}

// The GPT overflow IRQ is a free function, so it routes through a single
// file-static target pointer set in MotionPlanner::begin().
MotionPlanner* s_isr_target = nullptr;
FspTimer s_step_timer;
bool s_timer_open = false;

void stepTimerCallback(timer_callback_args_t* /*args*/) {
  if (s_isr_target != nullptr) {
    s_isr_target->onStepIsr();
  }
}

}  // namespace

// Concrete IStepSink for the CNC Shield. Lives here (not the header) so the
// header stays Arduino-include-free; task 8.1 constructs one and injects it.
class ArduinoStepSink : public IStepSink {
 public:
  void beginPins() {
    pinMode(PIN_X_STEP, OUTPUT);
    pinMode(PIN_Y_STEP, OUTPUT);
    pinMode(PIN_X_DIR, OUTPUT);
    pinMode(PIN_Y_DIR, OUTPUT);
    pinMode(PIN_EN, OUTPUT);
    digitalWrite(PIN_X_STEP, LOW);
    digitalWrite(PIN_Y_STEP, LOW);
    digitalWrite(PIN_EN, HIGH);  // start disabled (active-low)
  }

  // A4988 latches direction on the STEP rising edge; map +1 -> HIGH, -1 -> LOW.
  void setDirX(std::int8_t dir) override {
    digitalWrite(PIN_X_DIR, dir >= 0 ? HIGH : LOW);
  }
  void setDirY(std::int8_t dir) override {
    digitalWrite(PIN_Y_DIR, dir >= 0 ? HIGH : LOW);
  }
  void stepX() override { pulse(PIN_X_STEP); }
  void stepY() override { pulse(PIN_Y_STEP); }
  void setEnabled(bool enabled) override {
    digitalWrite(PIN_EN, enabled ? LOW : HIGH);  // active-low
  }
};

void MotionPlanner::configureTimer_() {
  s_isr_target = this;
  if (s_timer_open) {
    return;  // idempotent
  }
  // Reserve a free GPT channel and open it in periodic mode at the FIXED
  // microstep tick rate STEP_TICK_HZ. The timer is programmed exactly ONCE
  // here and NEVER reprogrammed per step -- the prior per-microstep
  // set_frequency() reprogramming was the runaway root cause. The commanded
  // feed is realised in software by the DDS step divider in onStepIsr().
  // get_available_timer() fills `type` by non-const reference (GPT vs AGT) and
  // returns the channel index, so `type` must be a plain uint8_t lvalue.
  uint8_t type = 0;
  const std::int8_t ch = FspTimer::get_available_timer(type);
  if (ch < 0) {
    return;  // no free timer; integration (task 8.1) surfaces this as a fault
  }
  s_step_timer.begin(TIMER_MODE_PERIODIC, type, ch,
                     static_cast<float>(STEP_TICK_HZ), 0.0f, stepTimerCallback);
  s_step_timer.setup_overflow_irq();
  s_step_timer.open();
  s_step_timer.stop();  // armed per segment by startTimer_()
  s_timer_open = true;
}

void MotionPlanner::startTimer_() {
  if (s_timer_open) {
    s_step_timer.start();
  }
}

void MotionPlanner::stopTimer_() {
  if (s_timer_open) {
    s_step_timer.stop();
  }
}

#else  // !ARDUINO -- host build: timer seams are deterministic no-ops.

void MotionPlanner::configureTimer_() {}
void MotionPlanner::startTimer_() {}
void MotionPlanner::stopTimer_() {}

#endif  // defined(ARDUINO)

}  // namespace motion
}  // namespace etch
