/**
 * `CalibrationWizard` — guided two-corner visual calibration + jog/homing UI
 * (Req 1.1, 4.5, 8.5, 10.1, 10.3; design §"Web: CalibrationWizard").
 *
 * This is a *presentational / control* component: it owns no machine state of
 * its own and performs no I/O. Everything it shows is driven by props, and
 * every user action is forwarded upward through callbacks. The live wiring to
 * the {@link WireClient} (sending `CTL JOG` / `CAPTURE_BOTTOM_LEFT` /
 * `CAPTURE_TOP_RIGHT` / `SET_HOME` / `RE_HOME` frames and subscribing to STATUS
 * position updates) is the job of the controller — this component only renders
 * + prompts.
 *
 * Guided one-corner-at-a-time flow (chosen for dummy-proofing over a free-form
 * two-button panel). Three distinct visible states keyed off the props:
 *
 *   1. **Uncalibrated** (`!calibrated`, no home set): prompt the user to jog to
 *      the bottom-left corner and press **Capture bottom-left**
 *      (`onCaptureBottomLeft`). "Capture bottom-left" is the calibration-flow
 *      superset of Set Home — it declares home AND begins envelope measurement.
 *      Marker: `data-testid="calib-state-uncalibrated"`.
 *   2. **Home set** (`calibrated && !envelopeCalibrated`): prompt the user to
 *      jog to the top-right corner and press **Capture top-right**
 *      (`onCaptureTopRight`, enabled only while home is set). The bottom-left
 *      re-capture (re-home) remains available. Marker:
 *      `data-testid="calib-state-home-set"`.
 *   3. **Envelope captured** (`envelopeCalibrated`): a "Calibration complete —
 *      envelope NNNN × NNNN steps" indicator, enabling drawing. Marker:
 *      `data-testid="calib-state-envelope-captured"` plus
 *      `data-testid="calibration-complete"`.
 *
 * The jog controls and position readout are reused across all three states.
 *
 * @see Design §"Web: CalibrationWizard", §Calibration State Machine
 * @see Requirements 1.1, 4.5, 8.5, 10.1, 10.3, 10.9, 10.12, 10.13
 */

import { useState } from 'preact/hooks';

import type { Point } from '../types';

/** Preset jog distances, in full motor steps. ~400 steps ≈ one knob turn. */
const JOG_STEP_PRESETS: ReadonlyArray<{ label: string; steps: number }> = [
    { label: 'Fine (1)', steps: 1 },
    { label: 'Small (10)', steps: 10 },
    { label: 'Medium (40)', steps: 40 },
    { label: 'Large (100)', steps: 100 },
];

/** A single full-step jog direction: positive or negative. */
export type JogDir = 1 | -1;
/** The two controllable axes. */
export type JogAxis = 'x' | 'y';

/** A measured travel envelope in motor steps (Envelope_X_Steps / _Y_Steps). */
export interface StepEnvelope {
    x: number;
    y: number;
}

/** Props accepted by {@link CalibrationWizard}. */
export interface CalibrationWizardProps {
    /**
     * Whether the Controller's "position calibrated" (home set) flag is set.
     * While false the panel is in the bottom-left capture step and blocks
     * drawing, prompting the manual-home flow (Req 10.11).
     */
    calibrated: boolean;
    /**
     * The measured Step_Envelope in motor steps, or `null` when no valid
     * envelope has been captured yet (Req 8.3). Only meaningful while
     * `envelopeCalibrated` is true.
     */
    envelope: StepEnvelope | null;
    /**
     * Whether a valid Step_Envelope is calibrated — the Drawing_Gate predicate
     * (Req 4.5, 8.5). Distinct from {@link calibrated} (home set): an envelope
     * exists only after both corners are captured.
     */
    envelopeCalibrated: boolean;
    /**
     * Current estimated stylus position in motor steps relative to the
     * Home_Position, mirrored from STATUS frames (Req 10.9).
     */
    currentPosition: Point;
    /**
     * True when the firmware reported an unclean shutdown on boot. The panel
     * then surfaces the last-known-position hint and asks the user to verify
     * or re-declare home before drawing (Req 10.12).
     */
    uncleanShutdown: boolean;
    /**
     * Last known logical position retained as a hint after an unclean
     * shutdown, in steps relative to home. Only meaningful while
     * `uncleanShutdown` is true.
     */
    lastKnownPosition?: Point;
    /**
     * Fired once per jog button click with the axis, direction, and the number
     * of full motor steps to move (chosen via the step-size selector).
     */
    onJog: (axis: JogAxis, dir: JogDir, steps: number) => void;
    /**
     * Fired when the user captures the bottom-left corner (Req 1.1, 10.1).
     * Declares the current position as home AND begins envelope measurement.
     */
    onCaptureBottomLeft: () => void;
    /**
     * Fired when the user captures the top-right corner (Req 1.1). The
     * Controller measures the travel envelope from its own step counters.
     */
    onCaptureTopRight: () => void;
    /**
     * Fired when the user clears the stored calibration (RE_HOME). The firmware
     * zeroes the captured Step_Envelope and clears NVM_FLAG_ENVELOPE_CALIBRATED,
     * so the machine falls back to the baked-in DEFAULT_ENVELOPE until a fresh
     * calibration is captured. Useful to discard a stale/incorrect stored
     * envelope without reflashing.
     */
    onReHome?: () => void;
    /** Optional extra class on the panel root. */
    class?: string;
}

/**
 * Render the guided two-corner calibration wizard. Pure with respect to its
 * props: the only outputs are the `onJog`, `onCaptureBottomLeft`, and
 * `onCaptureTopRight` callbacks.
 */
export function CalibrationWizard(props: CalibrationWizardProps) {
    const {
        calibrated,
        envelope,
        envelopeCalibrated,
        currentPosition,
        uncleanShutdown,
        lastKnownPosition,
        onJog,
        onCaptureBottomLeft,
        onCaptureTopRight,
        onReHome,
        class: className,
    } = props;

    // Default to a medium jog so the stylus actually moves a visible amount per
    // click; a single full step is ~0.9° at the knob (basically a twitch).
    const [jogSteps, setJogSteps] = useState<number>(40);

    // Resolve the single active calibration state. `envelopeCalibrated` implies
    // home is set, so it takes precedence; otherwise `calibrated` selects the
    // home-set (top-right) step, falling back to the uncalibrated step.
    const state: 'uncalibrated' | 'home-set' | 'envelope-captured' =
        envelopeCalibrated ? 'envelope-captured' : calibrated ? 'home-set' : 'uncalibrated';

    return (
        <section
            class={`calibration-wizard${className ? ` ${className}` : ''}`}
            aria-label="Calibration and homing"
            data-testid="calibration-wizard"
        >
            {/* Unclean-shutdown recovery prompt (Req 10.12). Shown above the
                jog controls so the user verifies position before anything else. */}
            {uncleanShutdown && (
                <div
                    class="calibration-wizard__recovery"
                    data-testid="unclean-shutdown-hint"
                    role="alert"
                >
                    <p class="calibration-wizard__recovery-title">
                        Position uncertain after an unexpected shutdown.
                    </p>
                    <p
                        class="calibration-wizard__recovery-hint"
                        data-testid="last-known-position"
                    >
                        {lastKnownPosition
                            ? `Last known position: X ${lastKnownPosition.x}, Y ${lastKnownPosition.y} steps from home.`
                            : 'Last known position is unavailable.'}
                    </p>
                    <p class="calibration-wizard__recovery-action">
                        Verify the stylus by jogging to the bottom-left corner,
                        then re-capture it before drawing.
                    </p>
                </div>
            )}

            {/* Step 1 — Bottom-left capture (Req 1.1, 10.1). Active when no home
                has been set yet; drawing is blocked until both corners land. */}
            {state === 'uncalibrated' && (
                <div
                    class="calibration-wizard__uncalibrated"
                    data-testid="calib-state-uncalibrated"
                    role="status"
                >
                    <p
                        class="calibration-wizard__blocked"
                        data-testid="drawing-blocked-notice"
                    >
                        Drawing is blocked until calibration is complete.
                    </p>
                    <p class="calibration-wizard__prompt">
                        Step 1 of 2 — Jog the stylus to the bottom-left corner of
                        the drawable area, then capture it.
                    </p>
                </div>
            )}

            {/* Step 2 — Top-right capture (Req 1.1). Active once home is set but
                the envelope has not been measured yet. */}
            {state === 'home-set' && (
                <div
                    class="calibration-wizard__home-set"
                    data-testid="calib-state-home-set"
                    role="status"
                >
                    <p class="calibration-wizard__prompt">
                        Step 2 of 2 — Bottom-left captured. Now jog the stylus to
                        the top-right corner, then capture it.
                    </p>
                </div>
            )}

            {/* Complete — envelope captured (Req 4.5, 8.5). Drawing is enabled. */}
            {state === 'envelope-captured' && (
                <div
                    class="calibration-wizard__complete"
                    data-testid="calib-state-envelope-captured"
                    role="status"
                >
                    <p
                        class="calibration-wizard__complete-text"
                        data-testid="calibration-complete"
                    >
                        {envelope
                            ? `Calibration complete — envelope ${envelope.x} × ${envelope.y} steps`
                            : 'Calibration complete.'}
                    </p>
                </div>
            )}

            {/* Current position readout in steps relative to home (Req 10.9). */}
            <div class="calibration-wizard__position" data-testid="current-position">
                <span class="calibration-wizard__position-label">Position</span>
                <span class="calibration-wizard__position-value" data-testid="position-x">
                    X: {currentPosition.x}
                </span>
                <span class="calibration-wizard__position-value" data-testid="position-y">
                    Y: {currentPosition.y}
                </span>
                <span class="calibration-wizard__position-units">steps from home</span>
            </div>

            {/* Jog distance selector: how far each click moves. */}
            <div
                class="calibration-wizard__jog-size"
                data-testid="jog-size"
                role="group"
                aria-label="Jog distance"
            >
                <span class="calibration-wizard__position-label">Jog distance</span>
                <select
                    data-testid="jog-step-select"
                    value={String(jogSteps)}
                    onChange={(e) =>
                        setJogSteps(Number((e.currentTarget as HTMLSelectElement).value))
                    }
                >
                    {JOG_STEP_PRESETS.map((p) => (
                        <option value={String(p.steps)}>{p.label}</option>
                    ))}
                </select>
            </div>

            {/* Manual jog controls. Each click moves `jogSteps` full motor steps. */}
            <div
                class="calibration-wizard__jog"
                data-testid="jog-controls"
                role="group"
                aria-label="Manual jog"
            >
                <button
                    type="button"
                    data-testid="jog-x-plus"
                    class="calibration-wizard__jog-btn"
                    onClick={() => onJog('x', 1, jogSteps)}
                >
                    +X
                </button>
                <button
                    type="button"
                    data-testid="jog-x-minus"
                    class="calibration-wizard__jog-btn"
                    onClick={() => onJog('x', -1, jogSteps)}
                >
                    -X
                </button>
                <button
                    type="button"
                    data-testid="jog-y-plus"
                    class="calibration-wizard__jog-btn"
                    onClick={() => onJog('y', 1, jogSteps)}
                >
                    +Y
                </button>
                <button
                    type="button"
                    data-testid="jog-y-minus"
                    class="calibration-wizard__jog-btn"
                    onClick={() => onJog('y', -1, jogSteps)}
                >
                    -Y
                </button>
            </div>

            {/* Guided capture controls (Req 1.1, 10.1). "Capture bottom-left" is
                always available so the user can (re-)declare home and restart
                envelope measurement; re-homing clears any prior envelope. The
                "Capture top-right" button is enabled only once home is set. */}
            <div
                class="calibration-wizard__home"
                role="group"
                aria-label="Corner capture controls"
            >
                <button
                    type="button"
                    data-testid="capture-bottom-left"
                    class="calibration-wizard__set-home"
                    onClick={() => onCaptureBottomLeft()}
                >
                    {calibrated ? 'Re-capture bottom-left' : 'Capture bottom-left'}
                </button>
                <button
                    type="button"
                    data-testid="capture-top-right"
                    class="calibration-wizard__re-home"
                    disabled={!calibrated}
                    onClick={() => onCaptureTopRight()}
                >
                    Capture top-right
                </button>
            </div>

            {/* Clear stored calibration (RE_HOME). Discards any captured
                Step_Envelope and clears the envelope-calibrated flag so the
                firmware falls back to the baked-in DEFAULT_ENVELOPE. Useful to
                remove a stale/incorrect stored envelope without reflashing. */}
            {onReHome && (
                <div
                    class="calibration-wizard__rehome"
                    role="group"
                    aria-label="Clear calibration"
                >
                    <button
                        type="button"
                        data-testid="clear-calibration"
                        class="calibration-wizard__clear-calibration"
                        onClick={() => onReHome()}
                    >
                        Clear calibration (use default envelope)
                    </button>
                </div>
            )}
        </section>
    );
}

export default CalibrationWizard;
