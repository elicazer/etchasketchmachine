/**
 * `AnimationPlayback` — the slim on-canvas preview transport.
 *
 * Previously this component owned the playback engine AND rendered a
 * (CSS-hidden, dead) SVG indicator overlay docked beside the canvas. The
 * unified-composer-canvas redesign moves the engine into the
 * {@link usePlayback} hook and the moving stylus / progressive reveal onto
 * the MAIN {@link ComposerCanvas} surface. What remains here is a purely
 * presentational transport bar — Play / Pause / Stop, a Preview-speed
 * slider, and a single dual-readout line — driven entirely by a
 * {@link UsePlaybackResult} supplied by the host (App), which shares the
 * same hook instance with the canvas. There is no longer any rendering of
 * the animation here; the canvas IS the preview surface.
 *
 * The transport is meant to be rendered as a stacked section at the TOP of
 * the right-hand control dock (`.studio-dock--right`), above the machine
 * drawing controls.
 *
 * ## Hard guarantees (now enforced by the hook)
 *
 *   - **No controller traffic.** Neither this component nor `usePlayback`
 *     imports `controller` or calls any transmit method (Req 18.10).
 *   - **Empty-scene safety.** When the scene has no drawable length the
 *     transport is disabled and the readout shows the `'—'` sentinel
 *     (Req 18.4).
 *   - **Dual-readout independence.** "Machine ETA" mirrors `machineEtaMs`
 *     and is identical across all preview speeds; "Preview" reflects the
 *     speed slider and the path length (Req 18.13, 18.14).
 *
 * The pure helpers and speed constants are re-exported from
 * {@link ./use_playback} so existing imports (`pathLength`,
 * `pointAtDistance`, `formatDuration`, `clampSpeed`, `SPEED_MIN`,
 * `SPEED_MAX`, `SPEED_STEP`) keep resolving from this module.
 *
 * @see web/src/ui/composer/use_playback.ts
 * @see Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.10,
 *      18.13, 18.14
 */

import type { JSX } from 'preact';

import {
    SPEED_MAX,
    SPEED_MIN,
    SPEED_STEP,
    type UsePlaybackResult,
} from './use_playback';

// Re-export the engine surface so existing imports from this module keep
// working unchanged.
export {
    SPEED_MIN,
    SPEED_MAX,
    SPEED_STEP,
    clampSpeed,
    pathLength,
    pointAtDistance,
    revealedPolylines,
    formatDuration,
    usePlayback,
} from './use_playback';
export type {
    PlaybackState,
    PlaybackControls,
    UsePlaybackResult,
    UsePlaybackOptions,
} from './use_playback';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface AnimationPlaybackProps {
    /**
     * The shared playback state, produced by {@link usePlayback} in the host
     * and also consumed by the {@link ComposerCanvas} so the transport and
     * the on-canvas preview stay in lock-step.
     */
    playback: UsePlaybackResult;
    /** Optional extra class on the transport wrapper. */
    class?: string;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function AnimationPlayback(props: AnimationPlaybackProps): JSX.Element {
    const { playback, class: className } = props;
    const {
        state,
        speed,
        disabled,
        hasPath,
        previewDurationText,
        etaText,
        controls,
    } = playback;

    const isPlaying = state === 'playing';
    const isPaused = state === 'paused';

    const handleSpeedInput = (e: Event): void => {
        const el = e.currentTarget as HTMLInputElement;
        controls.setSpeed(parseFloat(el.value));
    };

    return (
        <div
            class={`animation-playback${className !== undefined ? ` ${className}` : ''}`}
            data-testid="animation-playback"
            data-state={state}
        >
            <div
                class="animation-playback__controls"
                data-testid="animation-playback-controls"
            >
                <button
                    type="button"
                    onClick={controls.play}
                    disabled={disabled || isPlaying}
                    data-testid="animation-playback-play"
                    aria-pressed={isPlaying}
                    aria-label="Play preview"
                >
                    Play
                </button>
                <button
                    type="button"
                    onClick={controls.pause}
                    disabled={disabled || !isPlaying}
                    data-testid="animation-playback-pause"
                    aria-pressed={isPaused}
                    aria-label="Pause preview"
                >
                    Pause
                </button>
                <button
                    type="button"
                    onClick={controls.stop}
                    disabled={disabled || state === 'stopped'}
                    data-testid="animation-playback-stop"
                    aria-label="Stop preview"
                >
                    Stop
                </button>

                <label class="animation-playback__speed">
                    <span class="animation-playback__speed-label">Speed</span>
                    <input
                        type="range"
                        min={SPEED_MIN}
                        max={SPEED_MAX}
                        step={SPEED_STEP}
                        value={speed}
                        onInput={handleSpeedInput}
                        data-testid="animation-playback-speed"
                        aria-label="Preview speed"
                        aria-valuemin={SPEED_MIN}
                        aria-valuemax={SPEED_MAX}
                        aria-valuenow={speed}
                    />
                    <span
                        class="animation-playback__speed-value"
                        data-testid="animation-playback-speed-value"
                    >
                        {speed.toFixed(2)}×
                    </span>
                </label>
            </div>

            {/* Single dual-readout line: Preview duration · Machine ETA. The
                Machine ETA half is a pure function of `machineEtaMs` and never
                moves with the speed slider (Req 18.13, 18.14). */}
            <p
                class="animation-playback__readout"
                data-testid="animation-playback-readout"
            >
                <span data-testid="animation-playback-preview-duration">
                    Preview{' '}
                    <span data-testid="animation-playback-preview-duration-value">
                        {hasPath ? previewDurationText : '—'}
                    </span>
                </span>
                <span aria-hidden="true"> · </span>
                <span data-testid="animation-playback-machine-eta">
                    Machine ETA{' '}
                    <span data-testid="animation-playback-machine-eta-value">
                        {etaText}
                    </span>
                </span>
            </p>
        </div>
    );
}

export default AnimationPlayback;
