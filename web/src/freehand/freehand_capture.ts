/**
 * Freehand drawing capture and stroke state.
 *
 * Framework-agnostic core for the freehand input tool (Req 11). A Preact
 * panel (task 25.3) wires `pointerdown` / `pointermove` / `pointerup`
 * events to this module; everything here is pure logic so it can be unit-
 * and property-tested without a DOM.
 *
 * Responsibilities:
 *   - Capture the ordered points of a stroke between pointer-down and
 *     pointer-up (Req 11.1).
 *   - Discard strokes with fewer than 3 captured points (Req 11.6).
 *   - Smooth a completed stroke with two iterations of Chaikin's
 *     corner-cutting on pointer-up (Req 11.3).
 *   - Maintain an undo stack supporting at least 50 consecutive undos
 *     (Req 11.4) and a clear-all operation (Req 11.5).
 *
 * Sampling rate: Requirement 11.2 asks the *UI* to sample at ≥ 60 Hz.
 * That is a concern of the panel that owns the pointer events, so this
 * module simply appends every point handed to it via `addPoint`. The
 * `decimateToHz` helper is provided for callers that capture at a higher
 * rate and want to thin the stream back down to a target frequency.
 *
 * @see Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 * @see Design §3.1.3
 */

import type { Point, Polyline } from '../types';

/** Number of Chaikin iterations applied to a completed stroke (Req 11.3). */
export const FREEHAND_CHAIKIN_ITERATIONS = 2;

/** Minimum captured points for a stroke to be committed (Req 11.6). */
export const FREEHAND_MIN_POINTS = 3;

/**
 * Default cap on retained strokes. The requirement is that at least 50
 * consecutive undos work (Req 11.4); this generous bound keeps the undo
 * history from growing without limit while staying well above that floor.
 */
export const FREEHAND_DEFAULT_MAX_STROKES = 200;

/**
 * Apply Chaikin's corner-cutting to an open polyline.
 *
 * Each iteration keeps the first and last points fixed and replaces every
 * segment `(Pᵢ, Pᵢ₊₁)` with two interior points using the classic
 * 0.25 / 0.75 split:
 *
 *   Q = ¾·Pᵢ + ¼·Pᵢ₊₁     R = ¼·Pᵢ + ¾·Pᵢ₊₁
 *
 * so one round maps an `n`-point polyline to a `2n`-point polyline. The
 * endpoints are never moved, which keeps the smoothed curve anchored to
 * the user's original start and end points.
 *
 * @param poly       The polyline to smooth. Polylines shorter than two
 *                   points are returned as a defensive copy (no corners to
 *                   cut).
 * @param iterations How many rounds of corner-cutting to apply. Must be a
 *                   non-negative integer. `0` returns a defensive copy of
 *                   the input unchanged.
 * @returns          A new polyline of freshly allocated points.
 * @throws           `RangeError` if `iterations` is negative or not an
 *                   integer.
 */
export function chaikin(poly: Polyline, iterations: number): Polyline {
    if (!Number.isInteger(iterations) || iterations < 0) {
        throw new RangeError(
            `chaikin: iterations must be a non-negative integer, got ${iterations}`,
        );
    }

    let current = clonePolyline(poly);
    for (let i = 0; i < iterations; i++) {
        current = chaikinOnce(current);
    }
    return current;
}

/**
 * One round of Chaikin corner-cutting on an open polyline. Keeps the first
 * and last point fixed and emits two cut points per segment.
 */
function chaikinOnce(poly: Polyline): Polyline {
    const n = poly.length;
    if (n < 2) {
        return clonePolyline(poly);
    }

    const out: Point[] = [];
    // Anchor the original first point.
    out.push({ x: poly[0]!.x, y: poly[0]!.y });

    for (let i = 0; i < n - 1; i++) {
        const a = poly[i]!;
        const b = poly[i + 1]!;
        out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
        out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }

    // Anchor the original last point.
    out.push({ x: poly[n - 1]!.x, y: poly[n - 1]!.y });
    return out;
}

/** Options for {@link FreehandCapture}. */
export interface FreehandCaptureOptions {
    /**
     * Maximum number of committed strokes retained for undo. Must be at
     * least {@link FREEHAND_MIN_UNDO} so the 50-undo guarantee holds. When
     * the cap is exceeded the oldest stroke is dropped. Defaults to
     * {@link FREEHAND_DEFAULT_MAX_STROKES}.
     */
    maxStrokes?: number;
}

/** Hard floor on `maxStrokes`, derived from Req 11.4 (≥ 50 undos). */
export const FREEHAND_MIN_UNDO = 50;

/**
 * Captures freehand strokes and owns the committed-stroke / undo state.
 *
 * Lifecycle of a single stroke:
 *   1. `beginStroke(p, tMs)` on pointer-down starts capture.
 *   2. `addPoint(p, tMs)` on each pointer-move appends a sample.
 *   3. `endStroke()` on pointer-up smooths and commits the stroke, or
 *      discards it if it had fewer than {@link FREEHAND_MIN_POINTS} points.
 */
export class FreehandCapture {
    private readonly maxStrokes: number;
    private committed: Polyline[] = [];
    private activePoints: Point[] | null = null;
    private activeTimes: number[] = [];

    constructor(options: FreehandCaptureOptions = {}) {
        const requested = options.maxStrokes ?? FREEHAND_DEFAULT_MAX_STROKES;
        if (!Number.isInteger(requested) || requested < FREEHAND_MIN_UNDO) {
            throw new RangeError(
                `FreehandCapture: maxStrokes must be an integer ≥ ${FREEHAND_MIN_UNDO}, got ${requested}`,
            );
        }
        this.maxStrokes = requested;
    }

    /**
     * Begin a new stroke at pointer-down. Any in-progress stroke is
     * abandoned (its points are not committed).
     *
     * @param p   The pointer-down position.
     * @param tMs Event timestamp in milliseconds (e.g. `event.timeStamp`).
     */
    beginStroke(p: Point, tMs: number): void {
        this.activePoints = [{ x: p.x, y: p.y }];
        this.activeTimes = [tMs];
    }

    /**
     * Append a sample to the active stroke. No-op when no stroke is active.
     *
     * @param p   The current pointer position.
     * @param tMs Event timestamp in milliseconds.
     */
    addPoint(p: Point, tMs: number): void {
        if (this.activePoints === null) return;
        this.activePoints.push({ x: p.x, y: p.y });
        this.activeTimes.push(tMs);
    }

    /**
     * Finish the active stroke on pointer-up.
     *
     * If fewer than {@link FREEHAND_MIN_POINTS} points were captured the
     * stroke is discarded and `null` is returned (Req 11.6). Otherwise the
     * raw stroke is smoothed with {@link FREEHAND_CHAIKIN_ITERATIONS}
     * iterations of Chaikin (Req 11.3), pushed onto the committed list, and
     * returned.
     *
     * @returns The committed, smoothed stroke, or `null` if nothing was
     *          committed (no active stroke, or too few points).
     */
    endStroke(): Polyline | null {
        const raw = this.activePoints;
        this.activePoints = null;
        this.activeTimes = [];

        if (raw === null || raw.length < FREEHAND_MIN_POINTS) {
            return null;
        }

        const smoothed = chaikin(raw, FREEHAND_CHAIKIN_ITERATIONS);
        this.committed.push(smoothed);
        if (this.committed.length > this.maxStrokes) {
            this.committed.shift();
        }
        return clonePolyline(smoothed);
    }

    /**
     * Remove the most recently committed stroke (Req 11.4).
     *
     * @returns `true` if a stroke was removed, `false` if there was nothing
     *          to undo.
     */
    undo(): boolean {
        if (this.committed.length === 0) return false;
        this.committed.pop();
        return true;
    }

    /** Remove every committed stroke and any in-progress capture (Req 11.5). */
    clear(): void {
        this.committed = [];
        this.activePoints = null;
        this.activeTimes = [];
    }

    /**
     * The committed strokes, oldest first, as a deep defensive copy. Callers
     * may freely mutate the result without affecting internal state.
     */
    strokes(): Polyline[] {
        return this.committed.map(clonePolyline);
    }

    /** Number of committed strokes currently retained. */
    get strokeCount(): number {
        return this.committed.length;
    }

    /** Whether a stroke is currently being captured. */
    get isCapturing(): boolean {
        return this.activePoints !== null;
    }

    /**
     * Thin a captured stream down to a target frequency, keeping a point
     * only once at least `1000 / hz` milliseconds have elapsed since the
     * previously kept point. The first and last points are always kept so
     * the stroke's extent is preserved.
     *
     * This is a convenience for callers that capture above the target rate;
     * `FreehandCapture` itself keeps every point handed to `addPoint`.
     *
     * @param points Captured positions.
     * @param times  Per-point timestamps in milliseconds, same length as
     *               `points`.
     * @param hz     Target sample rate in hertz. Must be positive.
     * @returns      The retained subset of `points` (a new array).
     * @throws       `RangeError` if `hz` is not positive, or `Error` if
     *               `points` and `times` differ in length.
     */
    static decimateToHz(points: Polyline, times: number[], hz: number): Polyline {
        if (!Number.isFinite(hz) || hz <= 0) {
            throw new RangeError(`decimateToHz: hz must be a positive number, got ${hz}`);
        }
        if (points.length !== times.length) {
            throw new Error(
                `decimateToHz: points (${points.length}) and times (${times.length}) must be the same length`,
            );
        }
        if (points.length <= 2) {
            return clonePolyline(points);
        }

        const minIntervalMs = 1000 / hz;
        const out: Point[] = [{ x: points[0]!.x, y: points[0]!.y }];
        let lastKeptTime = times[0]!;
        for (let i = 1; i < points.length - 1; i++) {
            if (times[i]! - lastKeptTime >= minIntervalMs) {
                out.push({ x: points[i]!.x, y: points[i]!.y });
                lastKeptTime = times[i]!;
            }
        }
        const last = points[points.length - 1]!;
        out.push({ x: last.x, y: last.y });
        return out;
    }
}

/** Deep-copy a polyline into freshly allocated points. */
function clonePolyline(poly: Polyline): Polyline {
    return poly.map((p) => ({ x: p.x, y: p.y }));
}
