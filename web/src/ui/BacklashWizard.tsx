/**
 * `BacklashWizard` — the per-axis backlash calibration UI (Req 13.1–13.5,
 * 13.8, 13.9, 13.11).
 *
 * Backlash is the integer number of motor steps swallowed by gear lash and
 * play in the Etch-a-Sketch knobs after a direction reversal, before the
 * stylus actually starts moving again. This panel measures that value per
 * axis through a guided wizard, lets the user hand-edit it, shows the
 * currently stored values, and warns before drawing when the machine has
 * never been calibrated.
 *
 * Wizard flow (Design §5.3, Req 13.1–13.4), implemented as a small per-axis
 * state machine `idle → forward → reversing(count) → recorded`:
 *
 *   1. `idle`      — start buttons for each axis (Req 13.1, 13.9).
 *   2. `forward`   — on start we command a forward jog a known distance to
 *                    take up the slack in the positive direction
 *                    (`onJog(axis, +1)`, Req 13.2).
 *   3. `reversing` — the user reverses one step at a time
 *                    (`onJog(axis, -1)` per click) and is prompted after each
 *                    step whether the stylus has visibly started moving
 *                    (Req 13.3). The component counts the reverse steps issued
 *                    since the reversal.
 *   4. `recorded`  — when the user confirms motion, the reverse-step count is
 *                    recorded as that axis's backlash (`onRecordBacklash`,
 *                    Req 13.4).
 *
 * This component is purely presentational: it owns only the wizard's local
 * interaction state and emits intent upward through callbacks. The live
 * `WireClient` wiring (JOG / SET_BACKLASH control frames) is task 29.1; here
 * `onJog`'s direction sign is the whole contract — `+1` means "forward jog a
 * known distance" (the establish-direction move) and `-1` means "reverse a
 * single step" — so the host can map each to the right `JOG {steps}` command.
 *
 * @see Design §3.1.6, §5.3
 * @see Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.8, 13.9, 13.11
 */

import { useState } from 'preact/hooks';
import type { Axis, JogDir } from '../codec/control';
import { BACKLASH_STEPS_MAX, BACKLASH_STEPS_MIN } from '../constants';
import { validateBacklashSteps } from '../validators';

/** Currently stored per-axis backlash values, in full motor steps. */
export interface BacklashValues {
    /** Stored backlash for the X axis, in steps. */
    x: number;
    /** Stored backlash for the Y axis, in steps. */
    y: number;
}

/** Props accepted by {@link BacklashWizard}. */
export interface BacklashWizardProps {
    /** Currently stored per-axis backlash values (Req 13.8). */
    backlash: BacklashValues;
    /**
     * Whether a backlash calibration has been performed in the current
     * installation. Drives the uncalibrated-drawing warning (Req 13.11).
     */
    calibrationPerformed: boolean;
    /** Whether the machine has been homed (calibrated). Shown for context. */
    calibrated: boolean;
    /**
     * Whether a drawing is currently in progress. The wizard may be re-run
     * for either axis at any time *except* during a drawing (Req 13.9).
     */
    drawingInProgress?: boolean;
    /**
     * Command a jog on `axis`. `dir === 1` requests the forward,
     * known-distance establish-direction jog; `dir === -1` requests a single
     * reverse step (Req 13.2, 13.3).
     */
    onJog: (axis: Axis, dir: JogDir) => void;
    /** Record `steps` as the measured backlash for `axis` (Req 13.4). */
    onRecordBacklash: (axis: Axis, steps: number) => void;
    /** Persist a manually-edited backlash value for `axis` (Req 13.8). */
    onManualEdit: (axis: Axis, steps: number) => void;
    /** Acknowledge the uncalibrated warning and proceed with drawing (Req 13.11). */
    onProceedUncalibrated?: () => void;
    /** Dismiss the uncalibrated warning and cancel the drawing (Req 13.11). */
    onCancelUncalibrated?: () => void;
}

/** Phases of the per-axis calibration state machine. */
type WizardPhase = 'forward' | 'reversing' | 'recorded';

/** Human-readable label for an axis. */
function axisLabel(axis: Axis): 'X' | 'Y' {
    return axis === 0 ? 'X' : 'Y';
}

/**
 * Render the backlash calibration wizard. All wizard interaction state is
 * local; the only outputs are the `onJog`, `onRecordBacklash`,
 * `onManualEdit`, and warning callbacks.
 */
export function BacklashWizard(props: BacklashWizardProps) {
    const {
        backlash,
        calibrationPerformed,
        calibrated,
        drawingInProgress = false,
        onJog,
        onRecordBacklash,
        onManualEdit,
        onProceedUncalibrated,
        onCancelUncalibrated,
    } = props;

    // Only one axis is calibrated at a time. `activeAxis === null` is the
    // machine's idle state.
    const [activeAxis, setActiveAxis] = useState<Axis | null>(null);
    const [phase, setPhase] = useState<WizardPhase>('forward');
    const [reverseCount, setReverseCount] = useState(0);
    const [recordedSteps, setRecordedSteps] = useState(0);

    // Manual-edit fields are uncontrolled mirrors seeded from the stored
    // values; invalid entries surface an inline error and are not emitted.
    const [xInput, setXInput] = useState(String(backlash.x));
    const [yInput, setYInput] = useState(String(backlash.y));
    const [xError, setXError] = useState<string | null>(null);
    const [yError, setYError] = useState<string | null>(null);

    const wizardActive = activeAxis !== null;
    const startDisabled = wizardActive || drawingInProgress;

    function startWizard(axis: Axis): void {
        setActiveAxis(axis);
        setPhase('forward');
        setReverseCount(0);
        setRecordedSteps(0);
        // Establish a known forward direction by taking up the slack (Req 13.2).
        onJog(axis, 1);
    }

    function beginReversing(): void {
        setPhase('reversing');
        setReverseCount(0);
    }

    function reverseOneStep(): void {
        if (activeAxis === null) return;
        // One reverse step, prompting after each whether motion resumed (Req 13.3).
        onJog(activeAxis, -1);
        setReverseCount((c) => c + 1);
    }

    function confirmMoved(): void {
        if (activeAxis === null) return;
        // The reverse steps issued since the reversal are this axis's backlash
        // (Req 13.4).
        onRecordBacklash(activeAxis, reverseCount);
        setRecordedSteps(reverseCount);
        setPhase('recorded');
    }

    function cancelWizard(): void {
        setActiveAxis(null);
        setPhase('forward');
        setReverseCount(0);
    }

    function handleManualEdit(axis: Axis, value: string): void {
        if (axis === 0) setXInput(value);
        else setYInput(value);

        const result = validateBacklashSteps(Number(value));
        if (result.ok) {
            if (axis === 0) setXError(null);
            else setYError(null);
            onManualEdit(axis, result.value);
        } else if (axis === 0) {
            setXError(result.reason);
        } else {
            setYError(result.reason);
        }
    }

    // Pre-flight warning: either axis still at 0 and never calibrated this
    // installation (Req 13.11).
    const showWarning =
        !calibrationPerformed && (backlash.x === 0 || backlash.y === 0);

    return (
        <section class="backlash-wizard" aria-label="Backlash calibration">
            <header class="backlash-wizard__header">
                <h2 class="backlash-wizard__title">Backlash calibration</h2>
                <p class="backlash-wizard__homed" data-testid="backlash-homed">
                    Machine homed: {calibrated ? 'yes' : 'no'}
                </p>
            </header>

            {/* Currently stored values (Req 13.8). */}
            <dl class="backlash-wizard__stored">
                <div class="backlash-wizard__stored-row">
                    <dt>Stored X backlash</dt>
                    <dd data-testid="backlash-stored-x">{backlash.x} steps</dd>
                </div>
                <div class="backlash-wizard__stored-row">
                    <dt>Stored Y backlash</dt>
                    <dd data-testid="backlash-stored-y">{backlash.y} steps</dd>
                </div>
            </dl>

            {/* Uncalibrated-drawing warning (Req 13.11). */}
            {showWarning && (
                <div
                    class="backlash-wizard__warning"
                    role="alert"
                    data-testid="backlash-warning"
                >
                    <p>
                        This machine has not been calibrated for backlash.
                        Uncalibrated drawings may show visible discontinuities
                        at direction reversals.
                    </p>
                    <div class="backlash-wizard__warning-actions">
                        <button
                            type="button"
                            data-testid="backlash-warning-proceed"
                            onClick={() => onProceedUncalibrated?.()}
                        >
                            Proceed anyway
                        </button>
                        <button
                            type="button"
                            data-testid="backlash-warning-cancel"
                            onClick={() => onCancelUncalibrated?.()}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Per-axis wizard (Req 13.1–13.4, 13.9). */}
            <div class="backlash-wizard__run">
                {!wizardActive && (
                    <div
                        class="backlash-wizard__start"
                        data-testid="backlash-start-controls"
                    >
                        <p class="backlash-wizard__instructions">
                            Calibrate an axis by jogging forward, then reversing
                            one step at a time until the stylus moves.
                        </p>
                        <button
                            type="button"
                            data-testid="backlash-start-x"
                            disabled={startDisabled}
                            onClick={() => startWizard(0)}
                        >
                            Calibrate X axis
                        </button>
                        <button
                            type="button"
                            data-testid="backlash-start-y"
                            disabled={startDisabled}
                            onClick={() => startWizard(1)}
                        >
                            Calibrate Y axis
                        </button>
                        {drawingInProgress && (
                            <p
                                class="backlash-wizard__hint"
                                data-testid="backlash-start-blocked"
                            >
                                Calibration is unavailable while a drawing is in
                                progress.
                            </p>
                        )}
                    </div>
                )}

                {wizardActive && activeAxis !== null && (
                    <div
                        class="backlash-wizard__active"
                        data-testid="backlash-active"
                        data-axis={axisLabel(activeAxis)}
                    >
                        <p class="backlash-wizard__active-title">
                            Calibrating {axisLabel(activeAxis)} axis
                        </p>

                        {phase === 'forward' && (
                            <div data-testid="backlash-forward">
                                <p>
                                    Jogged the {axisLabel(activeAxis)} axis
                                    forward to take up the slack. When you are
                                    ready, reverse one step at a time and watch
                                    the stylus.
                                </p>
                                <button
                                    type="button"
                                    data-testid="backlash-begin-reverse"
                                    onClick={beginReversing}
                                >
                                    Begin reverse stepping
                                </button>
                            </div>
                        )}

                        {phase === 'reversing' && (
                            <div data-testid="backlash-reversing">
                                <p>
                                    Reverse steps issued:{' '}
                                    <span data-testid="backlash-reverse-count">
                                        {reverseCount}
                                    </span>
                                </p>
                                <p>Has the stylus started moving?</p>
                                <button
                                    type="button"
                                    data-testid="backlash-step"
                                    onClick={reverseOneStep}
                                >
                                    Not yet — reverse one step
                                </button>
                                <button
                                    type="button"
                                    data-testid="backlash-confirm"
                                    onClick={confirmMoved}
                                >
                                    Yes, it moved
                                </button>
                            </div>
                        )}

                        {phase === 'recorded' && (
                            <div data-testid="backlash-recorded">
                                <p>
                                    Recorded {recordedSteps} steps of backlash
                                    for the {axisLabel(activeAxis)} axis.
                                </p>
                                <button
                                    type="button"
                                    data-testid="backlash-done"
                                    onClick={cancelWizard}
                                >
                                    Done
                                </button>
                            </div>
                        )}

                        {phase !== 'recorded' && (
                            <button
                                type="button"
                                data-testid="backlash-cancel"
                                onClick={cancelWizard}
                            >
                                Cancel calibration
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Manual edit fields, 0–200 steps (Req 13.8). */}
            <div class="backlash-wizard__manual">
                <div class="backlash-wizard__field">
                    <label for="backlash-edit-x">Edit X backlash (steps)</label>
                    <input
                        id="backlash-edit-x"
                        data-testid="backlash-edit-x"
                        type="number"
                        min={BACKLASH_STEPS_MIN}
                        max={BACKLASH_STEPS_MAX}
                        step={1}
                        value={xInput}
                        onInput={(e) =>
                            handleManualEdit(
                                0,
                                (e.currentTarget as HTMLInputElement).value,
                            )
                        }
                    />
                    {xError !== null && (
                        <p
                            class="backlash-wizard__error"
                            data-testid="backlash-edit-error-x"
                        >
                            {xError}
                        </p>
                    )}
                </div>
                <div class="backlash-wizard__field">
                    <label for="backlash-edit-y">Edit Y backlash (steps)</label>
                    <input
                        id="backlash-edit-y"
                        data-testid="backlash-edit-y"
                        type="number"
                        min={BACKLASH_STEPS_MIN}
                        max={BACKLASH_STEPS_MAX}
                        step={1}
                        value={yInput}
                        onInput={(e) =>
                            handleManualEdit(
                                1,
                                (e.currentTarget as HTMLInputElement).value,
                            )
                        }
                    />
                    {yError !== null && (
                        <p
                            class="backlash-wizard__error"
                            data-testid="backlash-edit-error-y"
                        >
                            {yError}
                        </p>
                    )}
                </div>
            </div>
        </section>
    );
}

export default BacklashWizard;
