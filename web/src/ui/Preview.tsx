/**
 * `Preview` — animated, self-contained preview of a {@link PlannedPath}.
 *
 * Renders the planned drawing in drawing order, progressively revealing the
 * stroke as a virtual stylus traverses each segment (Req 8.2). Connector
 * segments are visually distinguished from content strokes — strokes are
 * solid black, connectors are dashed and lighter — so the user can see where
 * unavoidable extra lines will appear on the physical Etch-a-Sketch (Req 14.4).
 *
 * ## Timing model
 *
 * "Real-time" is the wall-clock duration the physical machine would take to
 * draw the path at the configured feed rate. It is derived from the path's
 * total ISR-step count and the feed rate via {@link estimateMillisForSteps}
 * (the same `steps / feed_sps` model used for the headline time estimate,
 * Property 26). The animation's wall-clock duration is therefore
 * `realTimeMs / rate`, where `rate ∈ [0.25, 4]` is the user-adjustable
 * playback speed.
 *
 * Progress is integrated frame-by-frame from the per-frame delta time, so a
 * mid-playback rate change takes effect on the very next frame without any
 * discontinuity. The animation is driven by `requestAnimationFrame` and the
 * loop is always cancelled on unmount.
 *
 * This component owns its own `<canvas>` and all drawing logic so it does not
 * collide with the static `Canvas.tsx` component (task 24.1). When no path is
 * supplied (or the path has no drawable motion) it renders a placeholder and
 * disables the transport controls.
 *
 * @see Design §3.1.6 (UI / Canvas), §7 Property 26
 * @see Requirements 8.2, 14.4
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PlannedPath, Point } from '../types';
import { FEED_SPS_MAX } from '../constants';
import { totalStepCount } from '../path/planner';
import { estimateMillisForSteps } from '../path/ramp';
import {
    simulateStylusTrace,
    connectorTravelSteps,
    type BacklashSlack,
} from '../path/machine_sim';

/** Largest per-axis backlash (steps) the machine-view slider exposes. */
export const MACHINE_VIEW_MAX_SLACK = 40;

/** Minimum user-selectable playback rate (¼× real-time). */
export const PREVIEW_RATE_MIN = 0.25;
/** Maximum user-selectable playback rate (4× real-time). */
export const PREVIEW_RATE_MAX = 4;
/** Slider granularity for the playback-rate control. */
export const PREVIEW_RATE_STEP = 0.25;

/** Default canvas backing-store size (152:105 aspect, ≥300 CSS px wide, Req 8.1). */
const CANVAS_W = 456;
const CANVAS_H = Math.round((CANVAS_W * 105) / 152); // 315

/** Inner padding (device px) so strokes never touch the canvas edge. */
const PAD = 8;

export interface PreviewProps {
    /** The planned path to animate. `null`/`undefined` renders a placeholder. */
    path?: PlannedPath | null;
    /**
     * Feed rate (steps/second) that defines "real-time". Defaults to
     * {@link FEED_SPS_MAX}. Used only to derive the real-time duration.
     */
    feedSps?: number;
    /** Initial playback rate; clamped into `[0.25, 4]`. Defaults to `1`. */
    initialRate?: number;
    /**
     * When true, the built-in playback transport (Play/Restart + speed
     * slider + progress readout) is hidden so the host can supply its own
     * single source of playback control. The static rendering (canvas,
     * empty placeholder, meta line, legend) is unaffected. Set by the
     * unified Composer's Draw view, where `AnimationPlayback` is the sole
     * playback control surface; left `false` for any standalone use of
     * `Preview` so existing tests / hosts behave unchanged.
     */
    hideControls?: boolean;
    /**
     * Calibrated per-axis backlash (motor steps) seeding the "Machine view"
     * slider, e.g. from the backlash wizard / store. Machine view replays the
     * planned path through this slack to show the REAL device distortion. When
     * omitted the slider starts at 0 (machine view == ideal view).
     */
    backlash?: BacklashSlack;
}

/** Clamp an arbitrary number into the supported playback-rate range. */
export function clampRate(r: number): number {
    if (!Number.isFinite(r)) return 1;
    return Math.min(PREVIEW_RATE_MAX, Math.max(PREVIEW_RATE_MIN, r));
}

/**
 * Render the planned path onto a 2D context, revealing only the portion the
 * virtual stylus has reached at `fraction ∈ [0, 1]` of the whole path.
 *
 * Strokes are solid black; connectors are dashed and lighter. A small marker
 * is drawn at the current stylus tip. The function is a no-op-safe pure
 * drawing routine: it reads nothing but its arguments.
 */
export interface DrawSceneOptions {
    /** Stroke colour for content segments. Defaults to near-black. */
    strokeColor?: string;
    /**
     * Colour for connector segments. Defaults to light grey (the ideal view's
     * "this extra line is unavoidable" hint). In machine view this is set to red
     * because a no-lift Etch-a-Sketch draws every connector as REAL ink.
     */
    connectorColor?: string;
    /** Dash pattern for connectors. Defaults to `[4, 4]`; `[]` for solid. */
    connectorDash?: number[];
}

export function drawScene(
    ctx: CanvasRenderingContext2D,
    path: PlannedPath,
    fraction: number,
    width: number,
    height: number,
    opts?: DrawSceneOptions,
): void {
    const strokeColor = opts?.strokeColor ?? '#111111';
    const connectorColor = opts?.connectorColor ?? '#9aa0a6';
    const connectorDash = opts?.connectorDash ?? [4, 4];
    const dw = path.drawableSteps.w;
    const dh = path.drawableSteps.h;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, width, height);

    if (dw <= 0 || dh <= 0) return;

    const sx = (width - 2 * PAD) / dw;
    const sy = (height - 2 * PAD) / dh;
    // +Y is up in step space, but down in canvas space, so flip Y.
    const tx = (p: Point): number => PAD + p.x * sx;
    const ty = (p: Point): number => PAD + (dh - p.y) * sy;

    const total = totalStepCount(path);
    const reveal = Math.max(0, Math.min(1, fraction)) * total;

    let consumed = 0;
    let tip: Point | null = null;
    let done = false;

    for (const seg of path.segments) {
        const pts = seg.pointsSteps;
        const isConnector = seg.kind === 'connector';

        ctx.lineWidth = isConnector ? 1 : 2;
        ctx.strokeStyle = isConnector ? connectorColor : strokeColor;
        ctx.setLineDash(isConnector ? connectorDash : []);
        ctx.beginPath();

        let started = false;
        for (let k = 0; k < pts.length - 1; k++) {
            const a = pts[k]!;
            const b = pts[k + 1]!;
            const len = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
            if (len === 0) continue;

            if (!started) {
                ctx.moveTo(tx(a), ty(a));
                started = true;
            }

            if (consumed + len <= reveal) {
                ctx.lineTo(tx(b), ty(b));
                consumed += len;
                tip = b;
            } else {
                // Partially reveal this move and stop the whole walk.
                const t = (reveal - consumed) / len;
                const px: Point = {
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t,
                };
                ctx.lineTo(tx(px), ty(px));
                tip = px;
                done = true;
                break;
            }
        }

        ctx.stroke();
        if (done) break;
    }

    ctx.setLineDash([]);

    if (tip) {
        ctx.beginPath();
        ctx.fillStyle = '#d62828';
        ctx.arc(tx(tip), ty(tip), 3, 0, Math.PI * 2);
        ctx.fill();
    }
}

/** Format a fraction in `[0,1]` as an integer-percent string. */
function pct(fraction: number): string {
    return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

export function Preview(props: PreviewProps): preact.JSX.Element {
    const feedSps = props.feedSps ?? FEED_SPS_MAX;
    const path = props.path ?? null;

    // Machine view: replay the planned path through a per-axis backlash deadband
    // so the preview shows the REAL device distortion, not the ideal geometry.
    const [machineView, setMachineView] = useState(false);
    const [slack, setSlack] = useState<number>(() => {
        const seed = Math.max(props.backlash?.x ?? 0, props.backlash?.y ?? 0);
        return Math.max(0, Math.min(MACHINE_VIEW_MAX_SLACK, Math.round(seed)));
    });

    // The path actually rendered: the ideal plan, or its backlash-distorted
    // stylus trace when machine view is on (and there is slack to apply).
    const renderPath = useMemo<PlannedPath | null>(() => {
        if (!path) return null;
        if (!machineView || slack <= 0) return path;
        return simulateStylusTrace(path, { x: slack, y: slack });
    }, [path, machineView, slack]);

    const connectorSteps = useMemo(
        () => (renderPath ? connectorTravelSteps(renderPath) : 0),
        [renderPath],
    );

    const totalSteps = useMemo(
        () => (path ? totalStepCount(path) : 0),
        [path],
    );
    const hasPath =
        !!path && path.segments.length > 0 && totalSteps > 0;
    const realTimeMs = hasPath
        ? estimateMillisForSteps(totalSteps, feedSps)
        : 0;

    const [rate, setRate] = useState(() => clampRate(props.initialRate ?? 1));
    const [progress, setProgress] = useState(0);
    const [playing, setPlaying] = useState(false);

    // Refs mirror state so the rAF callback always reads live values without
    // re-subscribing each frame.
    const rateRef = useRef(rate);
    const progressRef = useRef(0);
    const playingRef = useRef(false);
    const realTimeMsRef = useRef(realTimeMs);
    const lastTsRef = useRef<number | null>(null);
    const rafRef = useRef<number | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    rateRef.current = rate;
    realTimeMsRef.current = realTimeMs;

    const cancelLoop = useCallback(() => {
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
    }, []);

    const frame = useCallback(
        (ts: number) => {
            if (!playingRef.current) return;
            if (lastTsRef.current === null) lastTsRef.current = ts;
            const dt = Math.max(0, ts - lastTsRef.current);
            lastTsRef.current = ts;

            const playbackMs = realTimeMsRef.current / rateRef.current;
            let next: number;
            if (!(playbackMs > 0)) {
                next = 1;
            } else {
                next = Math.min(1, progressRef.current + dt / playbackMs);
            }
            progressRef.current = next;
            setProgress(next);

            if (next >= 1) {
                playingRef.current = false;
                setPlaying(false);
                rafRef.current = null;
                return;
            }
            rafRef.current = requestAnimationFrame(frame);
        },
        [],
    );

    const startLoop = useCallback(() => {
        cancelLoop();
        lastTsRef.current = null;
        rafRef.current = requestAnimationFrame(frame);
    }, [cancelLoop, frame]);

    const handlePlayPause = useCallback(() => {
        if (!hasPath) return;
        if (playingRef.current) {
            playingRef.current = false;
            setPlaying(false);
            cancelLoop();
            return;
        }
        // Resume, or restart from the top if the previous run finished.
        if (progressRef.current >= 1) {
            progressRef.current = 0;
            setProgress(0);
        }
        playingRef.current = true;
        setPlaying(true);
        startLoop();
    }, [hasPath, cancelLoop, startLoop]);

    const handleRestart = useCallback(() => {
        if (!hasPath) return;
        progressRef.current = 0;
        setProgress(0);
        lastTsRef.current = null;
        if (playingRef.current) startLoop();
    }, [hasPath, startLoop]);

    const handleRateInput = useCallback((e: Event) => {
        const el = e.currentTarget as HTMLInputElement;
        const v = clampRate(parseFloat(el.value));
        rateRef.current = v;
        setRate(v);
    }, []);

    // Reset transport whenever the path (or its real-time basis) changes.
    useEffect(() => {
        cancelLoop();
        progressRef.current = 0;
        playingRef.current = false;
        lastTsRef.current = null;
        setProgress(0);
        setPlaying(false);
    }, [path, feedSps, cancelLoop]);

    // Always cancel any in-flight frame on unmount.
    useEffect(() => cancelLoop, [cancelLoop]);

    // Redraw on every progress/path change. Canvas pixels are best-effort:
    // in headless environments without a 2D context we simply skip drawing.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        let ctx: CanvasRenderingContext2D | null = null;
        try {
            ctx = canvas.getContext('2d');
        } catch {
            ctx = null;
        }
        if (!ctx) return;
        if (!hasPath || !renderPath) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#fafafa';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return;
        }
        // In machine view, connectors are drawn as solid red because the real
        // device lays them down as visible ink (no pen lift).
        const opts = machineView
            ? { connectorColor: '#d62828', connectorDash: [] }
            : undefined;
        drawScene(ctx, renderPath, progress, canvas.width, canvas.height, opts);
    }, [renderPath, hasPath, progress, machineView]);

    const realSeconds = realTimeMs / 1000;
    const playbackSeconds = rate > 0 ? realSeconds / rate : 0;

    return (
        <div class="preview" data-testid="preview">
            <canvas
                ref={canvasRef}
                class="preview__canvas"
                width={CANVAS_W}
                height={CANVAS_H}
                style={{
                    width: '100%',
                    maxWidth: `${CANVAS_W}px`,
                    aspectRatio: '152 / 105',
                    border: '1px solid #ddd',
                    display: 'block',
                }}
                data-testid="preview-canvas"
                role="img"
                aria-label="Animated drawing preview"
            />

            {!hasPath && (
                <p class="preview__empty" data-testid="preview-empty">
                    No path to preview yet.
                </p>
            )}

            {props.hideControls !== true && (
                <div class="preview__controls" data-testid="preview-controls">
                    <button
                        type="button"
                        onClick={handlePlayPause}
                        disabled={!hasPath}
                        data-testid="preview-playpause"
                        aria-pressed={playing}
                    >
                        {playing ? 'Pause' : 'Play'}
                    </button>
                    <button
                        type="button"
                        onClick={handleRestart}
                        disabled={!hasPath}
                        data-testid="preview-restart"
                    >
                        Restart
                    </button>

                    <label class="preview__rate">
                        <span>Speed</span>
                        <input
                            type="range"
                            min={PREVIEW_RATE_MIN}
                            max={PREVIEW_RATE_MAX}
                            step={PREVIEW_RATE_STEP}
                            value={rate}
                            onInput={handleRateInput}
                            disabled={!hasPath}
                            data-testid="preview-rate"
                            aria-label="Playback speed"
                            aria-valuemin={PREVIEW_RATE_MIN}
                            aria-valuemax={PREVIEW_RATE_MAX}
                            aria-valuenow={rate}
                        />
                        <span data-testid="preview-rate-value">
                            {rate.toFixed(2)}×
                        </span>
                    </label>

                    <output
                        class="preview__progress"
                        data-testid="preview-progress"
                        aria-label="Preview progress"
                    >
                        {pct(progress)}
                    </output>
                </div>
            )}

            <p class="preview__meta" data-testid="preview-meta">
                {hasPath
                    ? `Real-time ${realSeconds.toFixed(1)}s · playback ${playbackSeconds.toFixed(1)}s`
                    : '—'}
            </p>

            <div class="preview__machine" data-testid="preview-machine">
                <label class="preview__machine-toggle">
                    <input
                        type="checkbox"
                        checked={machineView}
                        disabled={!hasPath}
                        onChange={(e) =>
                            setMachineView(
                                (e.currentTarget as HTMLInputElement).checked,
                            )
                        }
                        data-testid="preview-machine-toggle"
                    />
                    <span>Machine view (simulate backlash)</span>
                </label>

                {machineView && (
                    <label class="preview__machine-slack">
                        <span>Backlash {slack} steps/axis</span>
                        <input
                            type="range"
                            min={0}
                            max={MACHINE_VIEW_MAX_SLACK}
                            step={1}
                            value={slack}
                            disabled={!hasPath}
                            onInput={(e) =>
                                setSlack(
                                    Number(
                                        (e.currentTarget as HTMLInputElement)
                                            .value,
                                    ),
                                )
                            }
                            data-testid="preview-machine-slack"
                            aria-label="Simulated backlash steps per axis"
                        />
                    </label>
                )}

                {machineView && (
                    <p
                        class="preview__machine-readout"
                        data-testid="preview-machine-readout"
                    >
                        Exposed travel (ink the machine draws between strokes):{' '}
                        {connectorSteps.toLocaleString()} steps
                    </p>
                )}
            </div>

            <ul class="preview__legend" data-testid="preview-legend">
                <li>
                    <span class="preview__swatch preview__swatch--stroke" /> Stroke
                    (solid)
                </li>
                <li>
                    <span
                        class="preview__swatch preview__swatch--connector"
                        style={
                            machineView
                                ? {
                                      borderTopColor: '#d62828',
                                      borderTopStyle: 'solid',
                                  }
                                : undefined
                        }
                    />{' '}
                    {machineView
                        ? 'Exposed travel — real ink (red)'
                        : 'Connector (dashed)'}
                </li>
            </ul>
        </div>
    );
}

export default Preview;
