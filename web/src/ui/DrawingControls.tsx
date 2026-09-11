/**
 * `DrawingControls` — the drawing-execution control panel (Req 9.1–9.8, 12.1).
 *
 * A purely presentational, prop-driven panel. It renders the real-time
 * execution controls and status read-outs but owns no transport: the live
 * `WireClient` wiring (sending PAUSE / RESUME / CANCEL / SPEED_PCT control
 * messages and feeding STATUS telemetry back in) happens in task 29.1. Here
 * we only reflect the props we are handed and emit intent through callbacks.
 *
 * Responsibilities:
 *   - show a Pause button only while a drawing is in progress (Req 9.1),
 *     a Resume button only while paused (Req 9.3), and a Cancel button in
 *     either of those states (Req 9.5, 9.6); buttons that do not apply to the
 *     current state are hidden;
 *   - expose a speed slider constrained to [25, 100] % in 1 % increments,
 *     validated through `validateSpeedPct`, emitting `onSpeedChange(pct)`
 *     for each accepted value (Req 9.7, 9.8);
 *   - display drawing progress: percentage complete and the current stylus
 *     position in steps relative to home (Req 7.4, 10.9);
 *   - render a color-coded connection-status indicator with an accessible
 *     text label that reflects the `connection` prop immediately
 *     (Req 12.1 — within 2 s; prop-driven so it updates on the next render).
 *
 * @see Design §3.1.6
 * @see Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 12.1
 */

import { SPEED_PCT_MAX, SPEED_PCT_MIN } from '../constants';
import { validateSpeedPct } from '../validators';

/**
 * Connection-level status surfaced by the panel's indicator. A deliberately
 * narrow trio (Req 12.1) — the live `WireClient` reports a slightly wider
 * `ConnectionState`; the wiring layer (task 29.1) maps transient states such
 * as `reconnecting` onto `connecting` before handing them down.
 */
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

/**
 * Drawing-execution state that governs which controls are visible. `idle`
 * and the terminal states (`completing`, `cancelled`, `error`) hide the
 * in-progress controls; only `drawing` and `paused` are "in progress".
 */
export type DrawingExecState =
    | 'idle'
    | 'drawing'
    | 'paused'
    | 'completing'
    | 'cancelled'
    | 'error';

/** A logical stylus position in integer motor steps relative to home. */
export interface PositionSteps {
    x: number;
    y: number;
}

/** Props accepted by {@link DrawingControls}. */
export interface DrawingControlsProps {
    /** Connection-level status driving the color-coded indicator (Req 12.1). */
    connection: ConnectionStatus;
    /** Drawing-execution state driving control visibility (Req 9.1, 9.3, 9.5). */
    drawingState: DrawingExecState;
    /** Percent complete in `[0, 100]`; clamped/rounded for display (Req 7.4). */
    progressPct: number;
    /** Current stylus position in steps relative to home (Req 10.9). */
    position: PositionSteps;
    /** Current speed percentage in `[25, 100]` shown on the slider (Req 9.7). */
    speedPct: number;
    /** Activated by the Pause button while drawing (Req 9.1, 9.2). */
    onPause?: () => void;
    /** Activated by the Resume button while paused (Req 9.3, 9.4). */
    onResume?: () => void;
    /** Activated by the Cancel button while drawing or paused (Req 9.5, 9.6). */
    onCancel?: () => void;
    /**
     * Activated by the always-visible emergency-stop button. Sends STOP, which
     * halts motion and flushes the controller's command buffer. Unlike Cancel,
     * this is shown in every state so a runaway can be halted at any time.
     */
    onStop?: () => void;
    /** Emitted with each accepted speed-slider value (Req 9.7, 9.8). */
    onSpeedChange?: (pct: number) => void;
}

/** Human-readable label + status-class for each connection state (Req 12.1). */
const CONNECTION_META: Record<
    ConnectionStatus,
    { label: string; status: string }
> = {
    connected: { label: 'Connected', status: 'connected' },
    connecting: { label: 'Connecting…', status: 'connecting' },
    disconnected: { label: 'Disconnected', status: 'disconnected' },
};

/** Clamp + round a percentage to a whole number in `[0, 100]` for display. */
function clampPct(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

/** Render a step coordinate as a whole number, falling back to 0. */
function stepLabel(n: number): number {
    return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Render the drawing-execution control panel. All inputs are props; the only
 * outputs are the `onPause` / `onResume` / `onCancel` / `onSpeedChange`
 * callbacks. The component holds no internal state.
 */
export function DrawingControls(props: DrawingControlsProps) {
    const {
        connection,
        drawingState,
        progressPct,
        position,
        speedPct,
        onPause,
        onResume,
        onCancel,
        onStop,
        onSpeedChange,
    } = props;

    const isDrawing = drawingState === 'drawing';
    const isPaused = drawingState === 'paused';
    // "In progress" covers both actively-drawing and paused (Req 9.5, 9.7).
    const inProgress = isDrawing || isPaused;
    // The speed slider is meaningful any time the user can start or affect a
    // drawing — i.e. whenever the controller is between draws (idle) or a
    // draw is in progress. It is only hidden in terminal states
    // (completing / cancelled / error), where the value is moot until idle
    // returns. Showing it pre-draw lets users set the speed before pressing
    // "Send to machine"; setSpeedPct safely updates the store and sends the
    // SPEED_PCT control either way.
    const speedSliderVisible =
        drawingState === 'idle' || inProgress;

    const conn = CONNECTION_META[connection] ?? CONNECTION_META.connecting;
    const pct = clampPct(progressPct);

    /**
     * Validate the slider value before emitting. The slider's
     * `min`/`max`/`step` already constrain the value to `[25, 100]` integers,
     * but we re-check with `validateSpeedPct` so a programmatic or otherwise
     * out-of-range / non-integer value is rejected rather than forwarded to
     * the firmware (Req 9.7).
     */
    function handleSpeed(e: Event): void {
        const raw = Number((e.currentTarget as HTMLInputElement).value);
        const v = validateSpeedPct(raw);
        if (v.ok) onSpeedChange?.(v.value);
    }

    return (
        <section class="drawing-controls" aria-label="Drawing execution controls">
            {/* Color-coded connection indicator with an accessible label. */}
            <div
                class={`drawing-controls__connection drawing-controls__connection--${conn.status}`}
                data-testid="connection-status"
                data-status={conn.status}
                role="status"
                aria-live="polite"
            >
                <span
                    class={`drawing-controls__indicator drawing-controls__indicator--${conn.status}`}
                    aria-hidden="true"
                />
                <span
                    class="drawing-controls__connection-label"
                    data-testid="connection-label"
                >
                    {conn.label}
                </span>
            </div>

            {/* Progress: percent complete + current position in steps. */}
            <div class="drawing-controls__progress" data-testid="progress">
                <span class="drawing-controls__progress-pct" data-testid="progress-percent">
                    {pct}%
                </span>
                <span
                    class="drawing-controls__position"
                    data-testid="position"
                    aria-label="Current position in steps"
                >
                    X {stepLabel(position.x)}, Y {stepLabel(position.y)} steps
                </span>
            </div>

            {/* Pause / Resume / Cancel — shown only in the states they apply to.
                E-STOP is ALWAYS visible so a runaway can be halted at any time. */}
            <div class="drawing-controls__buttons">
                <button
                    type="button"
                    class="drawing-controls__estop"
                    data-testid="estop-button"
                    aria-label="Emergency stop"
                    title="Emergency stop: halts motion and clears the command buffer"
                    onClick={() => onStop?.()}
                >
                    ⛔ STOP
                </button>
                {isDrawing && (
                    <button
                        type="button"
                        class="drawing-controls__pause"
                        data-testid="pause-button"
                        onClick={() => onPause?.()}
                    >
                        Pause
                    </button>
                )}
                {isPaused && (
                    <button
                        type="button"
                        class="drawing-controls__resume"
                        data-testid="resume-button"
                        onClick={() => onResume?.()}
                    >
                        Resume
                    </button>
                )}
                {inProgress && (
                    <button
                        type="button"
                        class="drawing-controls__cancel"
                        data-testid="cancel-button"
                        onClick={() => onCancel?.()}
                    >
                        Cancel
                    </button>
                )}
            </div>

            {/* Speed slider — visible whenever a drawing is starting/in
                progress (idle / drawing / paused). Hidden only in terminal
                states. setSpeedPct works safely either before or during a
                draw (Req 9.7). */}
            {speedSliderVisible && (
                <div class="drawing-controls__field">
                    <label class="drawing-controls__label" for="drawing-controls-speed">
                        Speed
                    </label>
                    <input
                        id="drawing-controls-speed"
                        class="drawing-controls__speed"
                        data-testid="speed-slider"
                        type="range"
                        min={SPEED_PCT_MIN}
                        max={SPEED_PCT_MAX}
                        step={1}
                        value={speedPct}
                        onInput={handleSpeed}
                        onChange={handleSpeed}
                    />
                    <output class="drawing-controls__speed-value" data-testid="speed-value">
                        {speedPct}%
                    </output>
                </div>
            )}
        </section>
    );
}

export default DrawingControls;
