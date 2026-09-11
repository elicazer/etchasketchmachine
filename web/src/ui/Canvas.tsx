/**
 * `Canvas` — the static drawing canvas for a planned path (task 24.1).
 *
 * Renders a {@link PlannedPath} at the physical 152:105 aspect ratio with a
 * minimum width of 300 CSS pixels (Req 8.1). Content strokes are drawn solid
 * black; connector segments are drawn dashed grey so the user can see where
 * unavoidable extra lines will appear on the physical Etch-a-Sketch
 * (Req 14.4). Any segment whose endpoints fall outside the drawable rectangle
 * is highlighted in a red dashed style and a warning message is shown
 * (Req 8.6).
 *
 * The headline "estimated drawing time" (mm:ss) and "total path length"
 * (steps) are derived from the path's total ISR-step count and the configured
 * feed rate using the same `total_steps / feed_sps` model as the rest of the
 * pipeline (Req 8.3, 14.5, Property 26).
 *
 * Out-of-bounds detection runs in two complementary spaces:
 *   - Against the path's own `drawableSteps` rectangle in motor-step space,
 *     which is what is actually rendered on the canvas. These segments get the
 *     red dashed overlay.
 *   - Optionally against the millimetre-space source polylines (`polylinesMm`)
 *     using the canonical {@link findOutOfBoundsSegmentsForPolylines}
 *     detector, so pre-clamp violations from the input panels still raise the
 *     Req 8.6 warning even though the planner has since clamped them.
 *
 * This component owns *only* the static canvas. The animated transport lives
 * in `Preview.tsx` (task 24.2); the input panels and execution controls live
 * in their own components (tasks 25.x / 26).
 *
 * @see Design §3.1.6 (UI / Canvas), §7 Properties 25, 26
 * @see Requirements 8.1, 8.3, 8.6, 14.4, 14.5
 */

import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { PlannedPath, Point, Polyline } from '../types';
import { FEED_SPS_MAX } from '../constants';
import { totalStepCount } from '../path/planner';
import { estimateMillisForSteps } from '../path/ramp';
import { findOutOfBoundsSegmentsForPolylines } from '../path/bounds';

/** Minimum canvas width in CSS pixels (Req 8.1). */
export const MIN_CANVAS_WIDTH = 300;
/** Default canvas backing-store width (152:105, ≥300 CSS px wide). */
export const CANVAS_DEFAULT_WIDTH = 456;
/** Canonical drawable aspect ratio, used for the CSS `aspect-ratio` property. */
export const CANVAS_ASPECT = '152 / 105';

/** Inner padding (device px) so strokes never touch the canvas edge. */
const PAD = 8;

/** Stroke (content) styling — solid black. */
const STROKE_COLOR = '#111111';
/** Connector styling — dashed grey (Req 14.4). */
const CONNECTOR_COLOR = '#9aa0a6';
const CONNECTOR_DASH = [4, 4];
/** Out-of-bounds styling — red dashed (Req 8.6). */
const OOB_COLOR = '#d62828';
const OOB_DASH = [5, 4];

export interface CanvasProps {
    /** The planned path to render. `null`/`undefined` renders a placeholder. */
    path?: PlannedPath | null;
    /**
     * Feed rate (steps/second) used to estimate drawing time. Defaults to
     * {@link FEED_SPS_MAX}. Non-positive or non-finite values fall back to the
     * default.
     */
    feedSps?: number;
    /**
     * Desired CSS width in pixels. Clamped up to {@link MIN_CANVAS_WIDTH}.
     * Defaults to {@link CANVAS_DEFAULT_WIDTH}.
     */
    widthCss?: number;
    /**
     * Optional millimetre-space source polylines (pre-clamp). When supplied,
     * their out-of-bounds segments also raise the Req 8.6 warning via the
     * canonical {@link findOutOfBoundsSegmentsForPolylines} detector.
     */
    polylinesMm?: Polyline[];
}

/**
 * One out-of-bounds sub-segment of a planned path, in motor-step space.
 * `segIndex` selects the {@link PlannedPath.segments} entry and `pointIndex`
 * the starting vertex within that segment's `pointsSteps`.
 */
export interface OutOfBoundsStepSegment {
    segIndex: number;
    pointIndex: number;
    from: Point;
    to: Point;
}

/**
 * True iff `p` lies in the closed step-space rectangle `[0, w] × [0, h]`.
 * Boundary points count as in-bounds; NaN coordinates are out-of-bounds.
 * Mirrors {@link import('../path/bounds').isPointInBoundsMm} for step space.
 */
export function isPointInStepBounds(
    p: Point,
    w: number,
    h: number,
): boolean {
    return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
}

/**
 * Find every sub-segment of `path` with an endpoint outside the path's own
 * `drawableSteps` rectangle. A planned path produced by the planner is always
 * clamped in-bounds, so this is normally empty; it exists so the canvas can
 * still flag any out-of-bounds geometry it is handed (Req 8.6).
 */
export function findOutOfBoundsStepSegments(
    path: PlannedPath,
): OutOfBoundsStepSegment[] {
    const out: OutOfBoundsStepSegment[] = [];
    const { w, h } = path.drawableSteps;
    for (let s = 0; s < path.segments.length; s++) {
        const pts = path.segments[s]!.pointsSteps;
        for (let k = 0; k < pts.length - 1; k++) {
            const from = pts[k]!;
            const to = pts[k + 1]!;
            if (
                !isPointInStepBounds(from, w, h) ||
                !isPointInStepBounds(to, w, h)
            ) {
                out.push({ segIndex: s, pointIndex: k, from, to });
            }
        }
    }
    return out;
}

/**
 * Format a duration in milliseconds as `m:ss` (minutes and seconds, Req 8.3).
 * Negative or non-finite inputs render as `0:00`.
 */
export function formatDuration(ms: number): string {
    const totalSeconds =
        Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format a step count with a thousands separator and the `steps` unit. */
export function formatStepCount(steps: number): string {
    const n = Number.isFinite(steps) ? Math.max(0, Math.round(steps)) : 0;
    return `${n.toLocaleString('en-US')} steps`;
}

/**
 * Render a planned path onto a 2D context. Pure apart from the canvas it
 * mutates: strokes solid black, connectors dashed grey, and any
 * out-of-bounds sub-segment overlaid in red dashed (Req 14.4, 8.6).
 *
 * Step space has +Y up; canvas space has +Y down, so the Y axis is flipped.
 */
export function drawPath(
    ctx: CanvasRenderingContext2D,
    path: PlannedPath,
    width: number,
    height: number,
): void {
    const dw = path.drawableSteps.w;
    const dh = path.drawableSteps.h;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, width, height);

    if (dw <= 0 || dh <= 0) return;

    const sx = (width - 2 * PAD) / dw;
    const sy = (height - 2 * PAD) / dh;
    const tx = (p: Point): number => PAD + p.x * sx;
    const ty = (p: Point): number => PAD + (dh - p.y) * sy;

    // Content strokes and connectors.
    for (const seg of path.segments) {
        const isConnector = seg.kind === 'connector';
        ctx.lineWidth = isConnector ? 1 : 2;
        ctx.strokeStyle = isConnector ? CONNECTOR_COLOR : STROKE_COLOR;
        ctx.setLineDash(isConnector ? CONNECTOR_DASH : []);
        ctx.beginPath();

        const pts = seg.pointsSteps;
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
            ctx.lineTo(tx(b), ty(b));
        }
        ctx.stroke();
    }

    // Out-of-bounds overlay drawn on top so it is never hidden by content.
    const oob = findOutOfBoundsStepSegments(path);
    if (oob.length > 0) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = OOB_COLOR;
        ctx.setLineDash(OOB_DASH);
        ctx.beginPath();
        for (const s of oob) {
            ctx.moveTo(tx(s.from), ty(s.from));
            ctx.lineTo(tx(s.to), ty(s.to));
        }
        ctx.stroke();
    }

    ctx.setLineDash([]);
}

/**
 * Static canvas component. Renders the supplied {@link PlannedPath}, the
 * estimated-time / total-length readouts, and the out-of-bounds warning.
 */
export function Canvas(props: CanvasProps): preact.JSX.Element {
    const path = props.path ?? null;
    const feedSps =
        Number.isFinite(props.feedSps) && (props.feedSps as number) > 0
            ? (props.feedSps as number)
            : FEED_SPS_MAX;

    const widthCss = Math.max(
        MIN_CANVAS_WIDTH,
        Number.isFinite(props.widthCss) && (props.widthCss as number) > 0
            ? (props.widthCss as number)
            : CANVAS_DEFAULT_WIDTH,
    );
    const backingW = Math.round(widthCss);
    const backingH = Math.round((backingW * 105) / 152);

    const hasPath = !!path && path.segments.length > 0;

    const totalSteps = useMemo(
        () => (path ? totalStepCount(path) : 0),
        [path],
    );

    const estMs = useMemo(
        () => (totalSteps > 0 ? estimateMillisForSteps(totalSteps, feedSps) : 0),
        [totalSteps, feedSps],
    );

    // Out-of-bounds segments in step space (rendered + highlighted) plus, when
    // mm-space source polylines are provided, the canonical pre-clamp check.
    const oobStep = useMemo(
        () => (path ? findOutOfBoundsStepSegments(path) : []),
        [path],
    );
    const oobMm = useMemo(
        () =>
            props.polylinesMm
                ? findOutOfBoundsSegmentsForPolylines(props.polylinesMm)
                : [],
        [props.polylinesMm],
    );
    const oobCount = oobStep.length + oobMm.length;
    const hasOob = oobCount > 0;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    // Repaint on every path / size change. Canvas pixels are best-effort: in
    // headless environments without a 2D context we simply skip drawing.
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
        if (!hasPath || !path) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#fafafa';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return;
        }
        drawPath(ctx, path, canvas.width, canvas.height);
    }, [path, hasPath, backingW, backingH]);

    return (
        <div class="canvas" data-testid="canvas">
            <canvas
                ref={canvasRef}
                class="canvas__surface"
                width={backingW}
                height={backingH}
                style={{
                    width: '100%',
                    minWidth: `${MIN_CANVAS_WIDTH}px`,
                    maxWidth: `${widthCss}px`,
                    aspectRatio: CANVAS_ASPECT,
                    border: '1px solid #ddd',
                    display: 'block',
                    background: '#fafafa',
                }}
                data-testid="canvas-surface"
                role="img"
                aria-label="Drawing preview canvas"
            />

            {!hasPath && (
                <p class="canvas__empty" data-testid="canvas-empty">
                    No path to preview yet.
                </p>
            )}

            {hasOob && (
                <p
                    class="canvas__warning"
                    data-testid="canvas-oob-warning"
                    role="alert"
                >
                    Path exceeds the drawable area:{' '}
                    {oobCount} out-of-bounds{' '}
                    {oobCount === 1 ? 'segment' : 'segments'} will be clamped.
                </p>
            )}

            <dl class="canvas__readouts" data-testid="canvas-readouts">
                <div class="canvas__readout">
                    <dt>Estimated time</dt>
                    <dd data-testid="canvas-time">
                        {hasPath ? formatDuration(estMs) : '—'}
                    </dd>
                </div>
                <div class="canvas__readout">
                    <dt>Total length</dt>
                    <dd data-testid="canvas-length">
                        {hasPath ? formatStepCount(totalSteps) : '—'}
                    </dd>
                </div>
            </dl>

            <ul class="canvas__legend" data-testid="canvas-legend">
                <li>
                    <span class="canvas__swatch canvas__swatch--stroke" /> Stroke
                    (solid black)
                </li>
                <li>
                    <span class="canvas__swatch canvas__swatch--connector" />{' '}
                    Connector (dashed grey)
                </li>
                <li>
                    <span class="canvas__swatch canvas__swatch--oob" /> Out of
                    bounds (red dashed)
                </li>
            </ul>
        </div>
    );
}

export default Canvas;
