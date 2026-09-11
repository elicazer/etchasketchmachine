/**
 * `usePlayback` — the on-canvas preview playback engine.
 *
 * Extracted from the old `AnimationPlayback` panel so a single playback
 * state can drive BOTH the slim transport bar and the main composer canvas
 * (the on-canvas preview). The hook owns the transport state machine, the
 * `requestAnimationFrame` position loop, the dual-readout derivations
 * (Preview duration vs Machine ETA), and the auto-stop-on-scene-change
 * guarantee. It is deliberately store-agnostic: it consumes the live
 * `composed` polylines and `machineEtaMs` as signals and exposes plain
 * outputs the UI layers render.
 *
 * ## Hard guarantees (carried over from the original panel)
 *
 *   - **No controller traffic.** The hook never imports `controller` and
 *     never calls any transmit method. Playback is confined to the SPA's
 *     rendering layer (Req 18.10).
 *   - **Empty-scene safety.** When `composed.value` has no drawable length
 *     `disabled` is `true`, `play()` is a no-op, and `indicatorPoint` is
 *     `null` (Req 18.4).
 *   - **Auto-stop on scene change.** Any change to `composed` while the
 *     transport is `'playing'` or `'paused'` resets the state to
 *     `'stopped'` and the position to 0 (Req 18.9).
 *   - **Dual-readout independence.** `etaText` mirrors `machineEtaMs` and is
 *     byte-for-byte identical across all preview speeds; `previewDurationMs`
 *     reflects the speed slider AND the path length (Req 18.13, 18.14).
 *
 * ## Timing model (unchanged)
 *
 *     s_{n+1} = s_n + (ts_{n+1} - ts_n) * speed * baseUnitsPerSecond / 1000
 *
 * Speed changes propagate within one frame because the rAF callback reads
 * `speedRef.current`, which `setSpeed` updates synchronously (Req 18.5).
 *
 * @see web/src/ui/composer/AnimationPlayback.tsx (transport that renders this)
 * @see web/src/ui/composer/ComposerCanvas.tsx (canvas that renders the reveal)
 * @see Requirements 18.2, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11,
 *      18.13, 18.14
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { effect, type ReadonlySignal } from '@preact/signals';

import type { Point, Polyline } from '../../types';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Transport state (Req 18.6, 18.7, 18.8). */
export type PlaybackState = 'stopped' | 'playing' | 'paused';

/** Imperative transport controls returned by {@link usePlayback}. */
export interface PlaybackControls {
    /** Start (or resume) playback. No-op on an empty scene (Req 18.4). */
    play(): void;
    /** Freeze at the current position; a later `play()` resumes (Req 18.7). */
    pause(): void;
    /** Stop and reset the position to 0; the indicator disappears (Req 18.8). */
    stop(): void;
    /** Set the preview-speed multiplier; clamped into `[SPEED_MIN, SPEED_MAX]`. */
    setSpeed(s: number): void;
}

/** Everything the transport bar and the canvas preview need to render. */
export interface UsePlaybackResult {
    /** Current transport state. */
    state: PlaybackState;
    /** Current preview-speed multiplier. */
    speed: number;
    /** Path-distance position along `composed`, in scene units. */
    position: number;
    /** Total Euclidean length of `composed`, in scene units. */
    totalLength: number;
    /** `true` when there is drawable content to preview. */
    hasPath: boolean;
    /** `true` when the transport should be disabled (empty scene). */
    disabled: boolean;
    /** `true` when the canvas should render the on-canvas preview overlay. */
    active: boolean;
    /** Preview wall-clock duration at the current speed, in milliseconds. */
    previewDurationMs: number;
    /** `previewDurationMs` formatted `m:ss`, or `'—'` on an empty scene. */
    previewDurationText: string;
    /** Machine ETA formatted `m:ss`, or `'—'` when unknown. */
    etaText: string;
    /** The moving stylus point, or `null` when stopped / empty. */
    indicatorPoint: Point | null;
    /** Fraction of the path revealed so far, in `[0, 1]`. */
    revealFraction: number;
    /** Imperative transport controls. */
    controls: PlaybackControls;
}

/** Options for {@link usePlayback}. */
export interface UsePlaybackOptions {
    /** Initial speed multiplier; clamped to `[SPEED_MIN, SPEED_MAX]`. Default 1. */
    initialSpeed?: number;
    /**
     * Default rate (scene units / second) along the composed path at
     * `speed = 1`. Default 200.
     */
    baseUnitsPerSecond?: number;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Minimum "Preview speed" multiplier (Req 18.5). */
export const SPEED_MIN = 0.25;
/** Maximum "Preview speed" multiplier (Req 18.5). */
export const SPEED_MAX = 8;
/** Slider granularity. */
export const SPEED_STEP = 0.25;

/** Default rate at speed = 1, in scene units per second. */
export const DEFAULT_BASE_UNITS_PER_SECOND = 200;

// -----------------------------------------------------------------------------
// Pure helpers (exported for reuse and unit tests)
// -----------------------------------------------------------------------------

/** Clamp a speed multiplier into `[SPEED_MIN, SPEED_MAX]`. NaN → 1. */
export function clampSpeed(s: number): number {
    if (!Number.isFinite(s)) return 1;
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, s));
}

/**
 * Total Euclidean length of all polylines combined: sums the segment
 * lengths within each polyline. Polylines with fewer than two points
 * contribute zero. Pure.
 */
export function pathLength(polylines: Polyline[]): number {
    let total = 0;
    for (const poly of polylines) {
        if (poly.length < 2) continue;
        for (let i = 1; i < poly.length; i++) {
            const a = poly[i - 1]!;
            const b = poly[i]!;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            total += Math.hypot(dx, dy);
        }
    }
    return total;
}

/**
 * Map a path-distance `s` to a `(x, y)` point along the flat list of
 * polylines. Polylines are walked in order; segments within a polyline are
 * walked in order. `s` is clamped to `[0, totalLength]`. Polylines with
 * fewer than 2 points are skipped. Pure.
 *
 * Returns `null` only when there is literally no point to land on (every
 * polyline empty / single-point).
 */
export function pointAtDistance(
    polylines: Polyline[],
    s: number,
): Point | null {
    if (s <= 0) {
        for (const poly of polylines) {
            if (poly.length >= 1) return { x: poly[0]!.x, y: poly[0]!.y };
        }
        return null;
    }
    let consumed = 0;
    let lastValid: Point | null = null;
    for (const poly of polylines) {
        if (poly.length < 2) continue;
        for (let i = 1; i < poly.length; i++) {
            const a = poly[i - 1]!;
            const b = poly[i]!;
            const segLen = Math.hypot(b.x - a.x, b.y - a.y);
            if (segLen === 0) {
                lastValid = { x: a.x, y: a.y };
                continue;
            }
            if (consumed + segLen >= s) {
                const t = (s - consumed) / segLen;
                return {
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t,
                };
            }
            consumed += segLen;
            lastValid = { x: b.x, y: b.y };
        }
    }
    return lastValid;
}

/**
 * Walk the polylines accumulating length and emit the prefix of each
 * polyline that lies within the first `reveal` scene units of the path.
 * The result is a fresh `Polyline[]` (one entry per source polyline that
 * contributes at least two revealed points), suitable for drawing the
 * progressively-revealed stroke on the canvas. Pure.
 *
 * The walk mirrors {@link pointAtDistance}: polylines and the segments
 * within them are consumed in order, and a partially-revealed segment is
 * truncated at the exact reveal point so the drawn stroke ends precisely
 * under the stylus indicator.
 */
export function revealedPolylines(
    polylines: Polyline[],
    reveal: number,
): Polyline[] {
    if (!(reveal > 0)) return [];
    const out: Polyline[] = [];
    let consumed = 0;
    let done = false;
    for (const poly of polylines) {
        if (poly.length < 2) continue;
        const prefix: Point[] = [{ x: poly[0]!.x, y: poly[0]!.y }];
        for (let i = 1; i < poly.length; i++) {
            const a = poly[i - 1]!;
            const b = poly[i]!;
            const segLen = Math.hypot(b.x - a.x, b.y - a.y);
            if (segLen === 0) {
                continue;
            }
            if (consumed + segLen >= reveal) {
                const t = (reveal - consumed) / segLen;
                prefix.push({
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t,
                });
                done = true;
                break;
            }
            consumed += segLen;
            prefix.push({ x: b.x, y: b.y });
        }
        if (prefix.length >= 2) out.push(prefix);
        if (done) break;
    }
    return out;
}

/**
 * Format a duration in milliseconds as `m:ss`. Negative or non-finite
 * inputs render as `0:00`.
 */
export function formatDuration(ms: number): string {
    const totalSeconds =
        Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

/**
 * Own the preview playback state for a composed path. See the module
 * doc-comment for the guarantees and timing model.
 */
export function usePlayback(
    composed: ReadonlySignal<Polyline[]>,
    machineEtaMs: ReadonlySignal<number | null>,
    opts?: UsePlaybackOptions,
): UsePlaybackResult {
    const baseUps = opts?.baseUnitsPerSecond ?? DEFAULT_BASE_UNITS_PER_SECOND;

    // Reactive reads — `.value` access during render subscribes us.
    const polylines = composed.value;
    const etaMs = machineEtaMs.value;

    const [state, setState] = useState<PlaybackState>('stopped');
    const [speed, setSpeedState] = useState<number>(() =>
        clampSpeed(opts?.initialSpeed ?? 1),
    );
    const [position, setPosition] = useState<number>(0);

    const stateRef = useRef<PlaybackState>(state);
    const positionRef = useRef<number>(0);
    const speedRef = useRef<number>(speed);
    const lastTsRef = useRef<number | null>(null);
    const rafRef = useRef<number | null>(null);
    const totalLengthRef = useRef<number>(0);

    // Mirror state into refs every render. Cheap; no re-subscribe.
    stateRef.current = state;
    speedRef.current = speed;

    // -------------------------------------------------------------------------
    // Derived display values
    // -------------------------------------------------------------------------

    const totalLength = useMemo(() => pathLength(polylines), [polylines]);
    totalLengthRef.current = totalLength;

    const previewDurationMs = useMemo(() => {
        if (totalLength <= 0) return 0;
        const denom = baseUps * speed;
        if (denom <= 0) return 0;
        return (totalLength / denom) * 1000;
    }, [totalLength, baseUps, speed]);

    const etaText =
        etaMs === null || !Number.isFinite(etaMs)
            ? '—'
            : formatDuration(etaMs);

    const hasPath = polylines.length > 0 && totalLength > 0;
    const disabled = !hasPath;
    const active = state !== 'stopped';

    const indicatorPoint = useMemo(() => {
        if (state === 'stopped') return null;
        if (!hasPath) return null;
        return pointAtDistance(polylines, position);
    }, [state, hasPath, polylines, position]);

    const revealFraction = totalLength > 0 ? Math.min(1, position / totalLength) : 0;
    const previewDurationText = hasPath ? formatDuration(previewDurationMs) : '—';

    // -------------------------------------------------------------------------
    // rAF loop
    // -------------------------------------------------------------------------

    const cancelLoop = useCallback(() => {
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        lastTsRef.current = null;
    }, []);

    const frame = useCallback((ts: number) => {
        if (stateRef.current !== 'playing') {
            rafRef.current = null;
            lastTsRef.current = null;
            return;
        }
        const last = lastTsRef.current;
        if (last === null) {
            lastTsRef.current = ts;
            rafRef.current = requestAnimationFrame(frame);
            return;
        }
        const dtMs = Math.max(0, ts - last);
        lastTsRef.current = ts;

        const total = totalLengthRef.current;
        // Read live speed from the ref so a slider change takes effect within
        // one frame (Req 18.5).
        const s = speedRef.current;
        const advance = (dtMs / 1000) * s * baseUps;
        let next = positionRef.current + advance;
        if (next >= total) {
            next = Number.isFinite(total) ? total : 0;
            positionRef.current = next;
            setPosition(next);
            stateRef.current = 'stopped';
            setState('stopped');
            // Reset to 0 so a subsequent Play restarts from the beginning.
            positionRef.current = 0;
            setPosition(0);
            rafRef.current = null;
            lastTsRef.current = null;
            return;
        }
        positionRef.current = next;
        setPosition(next);
        rafRef.current = requestAnimationFrame(frame);
    }, [baseUps]);

    const startLoop = useCallback(() => {
        cancelLoop();
        rafRef.current = requestAnimationFrame(frame);
    }, [cancelLoop, frame]);

    // Always cancel any in-flight frame on unmount.
    useEffect(() => cancelLoop, [cancelLoop]);

    // -------------------------------------------------------------------------
    // Auto-stop on `composed` change (Req 18.9)
    // -------------------------------------------------------------------------

    useEffect(() => {
        let primed = false;
        const dispose = effect(() => {
            const next = composed.value;
            totalLengthRef.current = pathLength(next);
            if (!primed) {
                primed = true;
                return;
            }
            cancelLoop();
            stateRef.current = 'stopped';
            setState('stopped');
            positionRef.current = 0;
            setPosition(0);
        });
        return dispose;
    }, [composed, cancelLoop]);

    // -------------------------------------------------------------------------
    // Transport controls
    // -------------------------------------------------------------------------

    const play = useCallback(() => {
        if (totalLengthRef.current <= 0) return;
        if (stateRef.current === 'playing') return;
        stateRef.current = 'playing';
        setState('playing');
        startLoop();
    }, [startLoop]);

    const pause = useCallback(() => {
        if (stateRef.current !== 'playing') return;
        cancelLoop();
        stateRef.current = 'paused';
        setState('paused');
    }, [cancelLoop]);

    const stop = useCallback(() => {
        cancelLoop();
        positionRef.current = 0;
        setPosition(0);
        stateRef.current = 'stopped';
        setState('stopped');
    }, [cancelLoop]);

    const setSpeed = useCallback((v: number) => {
        const clamped = clampSpeed(v);
        // Mirror to the ref synchronously so the next rAF tick sees it even
        // before the state update flushes (Req 18.5).
        speedRef.current = clamped;
        setSpeedState(clamped);
    }, []);

    const controls = useMemo<PlaybackControls>(
        () => ({ play, pause, stop, setSpeed }),
        [play, pause, stop, setSpeed],
    );

    return {
        state,
        speed,
        position,
        totalLength,
        hasPath,
        disabled,
        active,
        previewDurationMs,
        previewDurationText,
        etaText,
        indicatorPoint,
        revealFraction,
        controls,
    };
}
