/**
 * Freehand drawing panel (Req 11).
 *
 * A pointer-driven drawing surface that captures mouse / touch strokes,
 * feeds them to the framework-agnostic {@link FreehandCapture} core, and
 * exposes undo / clear / "add to scene" controls. The commit button hands
 * the captured strokes upward via `onSend`; the host (today the Composer's
 * `AddItemMenu` popover) decides what to do with them, which for the
 * unified composer means pushing them into the SceneStore via
 * `store.addItem` rather than calling `controller.setPolylines` directly.
 *
 * Division of responsibility:
 *   - This component owns the DOM: it translates `pointerdown` /
 *     `pointermove` / `pointerup` into begin/add/end calls and renders the
 *     committed + in-progress strokes as SVG polylines (Req 11.1).
 *   - {@link FreehandCapture} owns the logic: <3-point discard (Req 11.6),
 *     two iterations of Chaikin smoothing on pointer-up (Req 11.3), and the
 *     ≥50-deep undo stack + clear (Req 11.4, 11.5). We deliberately do *not*
 *     reimplement any of that here.
 *
 * Sampling rate (Req 11.2): browsers may deliver `pointermove` below the
 * required 60 Hz, but each event can carry the higher-rate samples that were
 * coalesced for that frame. When `PointerEvent.getCoalescedEvents()` is
 * available we replay every coalesced sample into the capture, which lifts
 * the effective sample rate to the hardware pointer rate (well above 60 Hz).
 * Where it is unavailable we fall back to the single event position.
 *
 * @see Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7
 * @see Design §3.1.3
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Point, Polyline } from '../types';
import { FreehandCapture } from '../freehand/freehand_capture';

/**
 * Minimal shape of the pointer-event data this panel reads. Real
 * `PointerEvent`s satisfy it, and so does the synthetic `MouseEvent`-based
 * stand-in the tests dispatch (jsdom has no `PointerEvent` constructor).
 * `getCoalescedEvents` is optional and feature-detected at the call site.
 */
interface PointerLike {
    clientX: number;
    clientY: number;
    timeStamp: number;
    pointerId?: number;
    getCoalescedEvents?: () => PointerLike[];
}

/** Props for {@link FreehandPanel}. */
export interface FreehandPanelProps {
    /**
     * Invoked when the user activates "Add to scene" (Req 11.7) with the
     * full composition's smoothed polylines (oldest stroke first). The panel
     * hands the path pipeline a deep copy it is free to mutate. The
     * callback shape is intentionally agnostic: in the standalone tab the
     * host wires it to `controller.setPolylines`; in the unified composer
     * the host wires it to `store.addItem` (Req 2.5, 16.4).
     */
    onSend: (polylines: Polyline[]) => void;
    /** Optional extra class on the panel root. */
    class?: string;
}

/** The freehand surface's SVG viewBox, in drawable units (matches DRAWABLE_MM). */
const VIEWBOX_W = 152;
const VIEWBOX_H = 105;

/**
 * Translate a pointer event's client coordinates into the SVG's *viewBox*
 * coordinate space (0..152 × 0..105), not raw CSS pixels.
 *
 * The surface renders at `width:100%` with `viewBox="0 0 152 105"` and
 * `preserveAspectRatio="xMidYMid meet"`, so the drawn box is letterboxed and
 * uniformly scaled inside the element. We must (a) scale client pixels by the
 * viewBox/displayed-size ratio and (b) subtract the letterbox offset, or the
 * captured point lands far from the cursor. Falls back to a 1:1 mapping when
 * `getBoundingClientRect` reports a zero-size box (e.g. under jsdom).
 */
function localPoint(e: { clientX: number; clientY: number }, surface: Element): Point {
    const rect = surface.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
        // jsdom / not laid out: behave like the old 1:1 mapping for tests.
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // Uniform scale used by xMidYMid meet = fit the viewBox inside the element.
    const scale = Math.min(rect.width / VIEWBOX_W, rect.height / VIEWBOX_H);
    // The rendered content is centered; compute the letterbox margins.
    const drawnW = VIEWBOX_W * scale;
    const drawnH = VIEWBOX_H * scale;
    const offsetX = (rect.width - drawnW) / 2;
    const offsetY = (rect.height - drawnH) / 2;

    const px = e.clientX - rect.left - offsetX;
    const py = e.clientY - rect.top - offsetY;

    // Convert displayed pixels to viewBox units and clamp into the box.
    const x = Math.min(VIEWBOX_W, Math.max(0, px / scale));
    const y = Math.min(VIEWBOX_H, Math.max(0, py / scale));
    return { x, y };
}

/** Render a polyline's points as the SVG `points` attribute value. */
function pointsAttr(poly: Polyline): string {
    return poly.map((p) => `${p.x},${p.y}`).join(' ');
}

export function FreehandPanel({ onSend, class: className }: FreehandPanelProps) {
    // The capture core persists across renders. Lazy-init so we don't build a
    // new FreehandCapture (and reset undo history) on every render.
    const captureRef = useRef<FreehandCapture | null>(null);
    if (captureRef.current === null) {
        captureRef.current = new FreehandCapture();
    }
    const capture = captureRef.current;

    const surfaceRef = useRef<SVGSVGElement | null>(null);
    const activePointsRef = useRef<Point[] | null>(null);

    // Committed strokes mirrored from the capture core for rendering, and the
    // in-progress stroke for live feedback while the pointer is down.
    const [strokes, setStrokes] = useState<Polyline[]>([]);
    const [activeStroke, setActiveStroke] = useState<Polyline | null>(null);

    const refreshStrokes = useCallback(() => {
        setStrokes(capture.strokes());
    }, [capture]);

    const onPointerDown = useCallback(
        (e: PointerLike) => {
            const surface = surfaceRef.current;
            if (surface === null) return;
            // Keep receiving moves even if the pointer leaves the surface.
            if (e.pointerId !== undefined && typeof surface.setPointerCapture === 'function') {
                try {
                    surface.setPointerCapture(e.pointerId);
                } catch {
                    /* not all environments implement pointer capture */
                }
            }
            const p = localPoint(e, surface);
            capture.beginStroke(p, e.timeStamp);
            activePointsRef.current = [p];
            setActiveStroke([p]);
        },
        [capture],
    );

    const onPointerMove = useCallback(
        (e: PointerLike) => {
            if (!capture.isCapturing) return;
            const surface = surfaceRef.current;
            if (surface === null) return;

            // Replay coalesced samples when available to reach ≥60 Hz (Req 11.2).
            // Feature-detected: jsdom and older browsers lack getCoalescedEvents,
            // so we fall back to the single event position.
            let events: PointerLike[] = [e];
            if (typeof e.getCoalescedEvents === 'function') {
                const coalesced = e.getCoalescedEvents();
                if (coalesced.length > 0) events = coalesced;
            }

            const active = activePointsRef.current ?? [];
            for (const ev of events) {
                const p = localPoint(ev, surface);
                capture.addPoint(p, ev.timeStamp);
                active.push(p);
            }
            activePointsRef.current = active;
            // New array reference so Preact re-renders the live stroke.
            setActiveStroke(active.slice());
        },
        [capture],
    );

    const finishStroke = useCallback(
        (e: PointerLike) => {
            if (!capture.isCapturing) return;
            const surface = surfaceRef.current;
            if (surface !== null) {
                // The pointer-up position is the stroke's final sample.
                capture.addPoint(localPoint(e, surface), e.timeStamp);
                if (
                    e.pointerId !== undefined &&
                    typeof surface.releasePointerCapture === 'function'
                ) {
                    try {
                        surface.releasePointerCapture(e.pointerId);
                    } catch {
                        /* ignore */
                    }
                }
            }
            // Commit (smooth + push) or discard (<3 points) — core decides.
            capture.endStroke();
            activePointsRef.current = null;
            setActiveStroke(null);
            refreshStrokes();
        },
        [capture, refreshStrokes],
    );

    // Attach pointer listeners imperatively with the lowercase DOM event names
    // browsers actually dispatch. Going through addEventListener (rather than
    // JSX `onPointerDown=…`) keeps the wiring identical in real browsers and in
    // jsdom, where pointer-event DOM properties are absent and Preact would
    // otherwise register the listener under a case-preserved, never-matched
    // name.
    useEffect(() => {
        const surface = surfaceRef.current;
        if (surface === null) return;

        const down = (e: Event) => onPointerDown(e as unknown as PointerLike);
        const move = (e: Event) => onPointerMove(e as unknown as PointerLike);
        const up = (e: Event) => finishStroke(e as unknown as PointerLike);

        surface.addEventListener('pointerdown', down);
        surface.addEventListener('pointermove', move);
        surface.addEventListener('pointerup', up);
        surface.addEventListener('pointercancel', up);

        return () => {
            surface.removeEventListener('pointerdown', down);
            surface.removeEventListener('pointermove', move);
            surface.removeEventListener('pointerup', up);
            surface.removeEventListener('pointercancel', up);
        };
    }, [onPointerDown, onPointerMove, finishStroke]);

    const handleUndo = useCallback(() => {
        if (capture.undo()) {
            refreshStrokes();
        }
    }, [capture, refreshStrokes]);

    const handleClear = useCallback(() => {
        capture.clear();
        activePointsRef.current = null;
        setActiveStroke(null);
        refreshStrokes();
    }, [capture, refreshStrokes]);

    const handleSend = useCallback(() => {
        onSend(capture.strokes());
    }, [capture, onSend]);

    const hasStrokes = strokes.length > 0;

    return (
        <div class={`freehand-panel${className ? ` ${className}` : ''}`}>
            <svg
                ref={surfaceRef}
                class="freehand-surface"
                data-testid="freehand-surface"
                viewBox="0 0 152 105"
                preserveAspectRatio="xMidYMid meet"
                role="application"
                aria-label="Freehand drawing surface"
                style={{ touchAction: 'none', width: '100%', aspectRatio: '152 / 105' }}
            >
                {strokes.map((poly, i) => (
                    <polyline
                        key={`stroke-${i}`}
                        class="freehand-stroke"
                        data-testid="freehand-stroke"
                        points={pointsAttr(poly)}
                        fill="none"
                        stroke="#111"
                        stroke-width={1}
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                ))}
                {activeStroke !== null && activeStroke.length > 1 && (
                    <polyline
                        class="freehand-stroke freehand-stroke--active"
                        data-testid="freehand-active-stroke"
                        points={pointsAttr(activeStroke)}
                        fill="none"
                        stroke="#2a6"
                        stroke-width={1}
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                )}
            </svg>

            <div class="freehand-controls">
                <span data-testid="freehand-stroke-count">{strokes.length}</span>
                <button
                    type="button"
                    data-testid="freehand-undo"
                    onClick={handleUndo}
                    disabled={!hasStrokes}
                >
                    Undo
                </button>
                <button
                    type="button"
                    data-testid="freehand-clear"
                    onClick={handleClear}
                    disabled={!hasStrokes && activeStroke === null}
                >
                    Clear
                </button>
                <button
                    type="button"
                    data-testid="freehand-send"
                    onClick={handleSend}
                    disabled={!hasStrokes}
                >
                    Add to scene
                </button>
            </div>
        </div>
    );
}

export default FreehandPanel;
