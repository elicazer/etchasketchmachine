/**
 * `ComposerCanvas` — the Composer Scene's main interactive rendering surface.
 *
 * SVG-first renderer (Req 1.3, 13.2): the Scene's items are emitted in
 * `Scene.items` order so the topmost item (highest Z-order) is the LAST
 * DOM child, each rendered as a `<g transform="translate(x,y) rotate(deg)
 * scale(sx,sy)">` whose children are the item's local-frame polylines as
 * `<polyline>` elements. The dashed drawable-envelope rectangle is rendered
 * inside the same SVG so the user sees the digital twin (Req 13.2).
 *
 * Affine convention: SVG's `translate(x,y) rotate(deg) scale(sx,sy)` matrix
 * applies in right-to-left order to local-frame points and produces:
 *
 *     (cos·sx·p.x − sin·sy·p.y + x, sin·sx·p.x + cos·sy·p.y + y)
 *
 * which is byte-for-byte the same closed form as `applyTransform` in
 * `compose.ts` (with `deg = rotationRad · 180/π`). The renderer therefore
 * shares the affine definition with `composeScene` and `gestures.ts`; no
 * special-case math lives here.
 *
 * Selection (Req 3.3, 8.7): when `store.selectedItem.value !== null` the
 * canvas overlays eight resize handles (four corners + four edges) and one
 * rotation handle around the selected item's transformed axis-aligned
 * bounding box. The overlay carries an `aria-label` describing the item
 * type so screen readers can announce the selection (Req 8.7).
 *
 * Pointer-event routing (every gesture brackets its `updateTransform` calls
 * between `beginGesture` and `endGesture` so the SceneStore coalesces the
 * run into one history entry, Req 15.4):
 *   - pointer-down on a handle starts a resize / rotate gesture
 *     (Req 5.1, 5.2, 6.1)
 *   - pointer-down inside an item's transformed bounding box selects the
 *     topmost hit (Req 3.1, 3.2) and starts a move gesture (Req 4.1)
 *   - pointer-down on empty canvas clears the selection (Req 3.4)
 *   - Shift held during a corner-resize aspect-locks the gesture (Req 5.3)
 *   - Rotation snaps to 15° increments by default; hold Shift to rotate
 *     freely (Req 6.3)
 *
 * Hit-testing (per the task notes): the topmost item whose *axis-aligned*
 * transformed bounding box contains the pointer wins. Under arbitrary
 * rotation this is approximate but is documented as adequate for selection
 * (Property 6 pins exactly this contract).
 *
 * Keyboard accessibility on the `tabindex=0` SVG root (Req 7.1, 8.1–8.6):
 *   - ArrowLeft / ArrowRight / ArrowUp / ArrowDown translate ±1 scene unit;
 *     ±10 units with Shift held.
 *   - `+` or `=` multiply both `sx` and `sy` by 1.1 (post-clamped to
 *     SCALE_MIN by the SceneStore on commit).
 *   - `-` multiply both `sx` and `sy` by 1 / 1.1 (post-clamped).
 *   - `[` rotates by −15°; `]` rotates by +15°. The SceneStore normalises
 *     `rotationRad` into `[0, 2π)` on every commit (Req 6.2).
 *   - `Backspace` / `Delete` removes the selected item from the Scene
 *     (Req 7.1). `removeItem` clears `selectedId` when the removed item
 *     was selected (Req 3.6), so the overlay disappears on the same
 *     render cycle.
 *
 * Canvas2D fallback (`?renderer=canvas2d` URL flag): a minimal alternative
 * render path that re-projects polylines per frame via
 * `applyTransformToPolyline`. The selection overlay and pointer
 * interactions are SVG-only and are NOT provided in the Canvas2D path; the
 * fallback exists to unblock the Wave-4 perf benchmark on browsers where
 * SVG rendering proves too slow. The SceneStore and the composition
 * pipeline are unchanged across the two render paths.
 *
 * @see .kiro/specs/unified-composer-canvas/design.md §"Components and Interfaces" #5
 * @see Requirements 1.3, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 5.1,
 *      5.2, 5.3, 5.5, 6.1, 6.4, 7.1, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 13.2
 */

import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { JSX } from 'preact';

import {
    applyTransformToPolyline,
    itemBoundingBox,
} from '../../composer/compose';
import {
    moveTransform,
    resizeFromCorner,
    resizeFromEdge,
    rotateToPointer,
} from '../../composer/gestures';
import type { SceneStore } from '../../composer/scene_store';
import type { Item, ItemId, Transform } from '../../composer/types';
import type { Point, Polyline } from '../../types';
import { revealedPolylines, pathLength } from './use_playback';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Margin around the envelope rectangle, expressed as a fraction of the
 * envelope's *larger* dimension. Picked so a small amount of off-envelope
 * geometry (during a drag) stays visible without making the envelope
 * itself look lost in negative space.
 */
const VIEWPORT_MARGIN_FRAC = 0.15;

/**
 * Resize-handle side length in scene units, expressed as a fraction of the
 * envelope's larger dimension. Sized for a comfortable pointer target while
 * still leaving the bounding box readable; bumped from 0.018 because the
 * smaller value was too tight to click reliably at typical zooms (regression
 * fix).
 */
const HANDLE_SIZE_FRAC = 0.04;

/**
 * Distance from the bounding-box top edge to the rotation handle, again as
 * a fraction of the envelope's larger dimension.
 */
const ROTATION_HANDLE_OFFSET_FRAC = 0.05;

/** Keyboard translation step in scene units (Req 8.1). */
const KEY_TRANSLATE_UNIT = 1;
/** Keyboard translation step with Shift held in scene units (Req 8.2). */
const KEY_TRANSLATE_UNIT_SHIFT = 10;
/** Keyboard scale multiplier for `+`/`=` (Req 8.3). */
const KEY_SCALE_FACTOR = 1.1;
/** Keyboard rotation increment in radians for `[`/`]` (Req 8.5, 8.6). */
const KEY_ROTATE_RAD = Math.PI / 12;

/** SVG dashed-stroke pattern for the envelope rectangle (mirrors Canvas.tsx). */
const ENVELOPE_DASH = '4 4';

/** Stroke colour for the dashed envelope. Matches Canvas.tsx tokens. */
const ENVELOPE_COLOR = '#9aa0a6';

/** Stroke colour for content polylines. Matches Canvas.tsx tokens. */
const STROKE_COLOR = '#111111';

/** Selection overlay accent colour. Matches the `--accent` CSS token. */
const SELECTION_COLOR = '#4f8cff';

/** Stroke colour for the progressively-revealed preview path. */
const PREVIEW_STROKE_COLOR = '#111111';

/** Fill colour for the moving stylus indicator dot (matches Preview.tsx). */
const PREVIEW_INDICATOR_COLOR = '#d62828';

/** Opacity applied to the static scene's item lines while previewing. */
const PREVIEW_DIM_OPACITY = 0.25;

/** Per-item-kind accessible-name prefix used by the selection overlay (Req 8.7). */
const KIND_LABELS: Record<Item['kind'], string> = {
    image: 'Image item',
    text: 'Text item',
    freehand: 'Freehand item',
};

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Resize / rotate handle identifier. */
export type HandleKey =
    | 'tl' | 't' | 'tr'
    | 'l' /*    */ | 'r'
    | 'bl' | 'b' | 'br'
    | 'rot';

/** The rendering modes recognised by `ComposerCanvas`. */
export type RendererMode = 'svg' | 'canvas2d';

/**
 * On-canvas preview state, supplied by the host's {@link usePlayback} hook.
 * When `active` is true the canvas switches from edit mode to preview mode:
 * selection handles are suppressed, the static scene is dimmed, and the
 * composed path is progressively revealed up to `revealFraction` with a red
 * stylus dot at `indicator`. When this prop is absent or `active` is false
 * the canvas behaves byte-for-byte as it did before this feature.
 */
export interface ComposerCanvasPreview {
    /** Whether preview mode is engaged. */
    active: boolean;
    /** Fraction of the composed path revealed so far, in `[0, 1]`. */
    revealFraction: number;
    /** The moving stylus point in scene coordinates, or `null`. */
    indicator: Point | null;
}

export interface ComposerCanvasProps {
    /** Reactive Composer store. */
    store: SceneStore;
    /**
     * Drawable envelope in millimetres. The dashed envelope rectangle and
     * the SVG viewBox sizing both derive from this. Treated as positive;
     * non-positive or non-finite values fall back to a 1×1 unit envelope so
     * the canvas still renders predictably.
     */
    envelopeMm: { w: number; h: number };
    /** Optional extra class on the canvas wrapper. */
    class?: string;
    /**
     * Renderer override. Defaults to inspecting the page's URL: a query
     * string of `?renderer=canvas2d` selects the Canvas2D fallback, anything
     * else (including missing window) selects the SVG path. Tests inject
     * the value directly; production reads the URL.
     */
    rendererMode?: RendererMode;
    /**
     * Optional on-canvas preview state. When `active`, the canvas renders the
     * playback preview instead of the edit-mode selection overlay. Absent /
     * inactive leaves edit-mode behaviour unchanged.
     */
    preview?: ComposerCanvasPreview;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Axis-aligned bounding box, scene units. */
interface Bbox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * Resolve the active renderer mode. The SVG path is the default; Canvas2D
 * is only selected when the page URL explicitly opts in via
 * `?renderer=canvas2d`. The lookup is wrapped in try/catch so a missing or
 * sandboxed `window` (SSR / tests) never throws.
 */
function detectRendererMode(): RendererMode {
    if (typeof window === 'undefined' || typeof window.location === 'undefined') {
        return 'svg';
    }
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('renderer') === 'canvas2d') return 'canvas2d';
    } catch {
        // Malformed URL search string: stay on the default.
    }
    return 'svg';
}

/**
 * Build the SVG `transform` attribute value for an item's affine. Order is
 * `translate(x,y) rotate(deg) scale(sx,sy)`, matching the right-to-left
 * matrix multiplication that produces the same closed-form output as
 * `applyTransform` in `compose.ts` (with `deg = rotationRad · 180/π`).
 */
function transformAttr(t: Transform): string {
    const deg = (t.rotationRad * 180) / Math.PI;
    return `translate(${t.x} ${t.y}) rotate(${deg}) scale(${t.sx} ${t.sy})`;
}

/** Render a polyline as the SVG `points` attribute value. */
function pointsAttr(poly: Polyline): string {
    let s = '';
    for (let i = 0; i < poly.length; i++) {
        if (i > 0) s += ' ';
        s += `${poly[i].x},${poly[i].y}`;
    }
    return s;
}

/**
 * Map a pointer event's client coordinates into the SVG's viewBox
 * coordinate space (scene units).
 *
 * Tries the platform `getScreenCTM()` first: that is the SVG-correct path
 * and accounts for any CSS transforms on the surrounding tree. When the
 * platform reports a null CTM (jsdom) or `createSVGPoint` is unavailable,
 * falls back to a manual computation using the bounding rect and the
 * surface's viewBox. Returns `null` only when the surface has no layout
 * (zero-size rect) so callers can ignore phantom events safely.
 */
function clientToScene(
    svg: SVGSVGElement,
    clientX: number,
    clientY: number,
): Point | null {
    // Preferred path: platform CTM.
    try {
        const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null;
        const createPt = (svg as unknown as {
            createSVGPoint?: () => DOMPoint & { x: number; y: number; matrixTransform: (m: DOMMatrix) => DOMPoint };
        }).createSVGPoint;
        if (ctm !== null && typeof createPt === 'function') {
            const pt = createPt.call(svg);
            pt.x = clientX;
            pt.y = clientY;
            const inv = ctm.inverse();
            const out = pt.matrixTransform(inv);
            return { x: out.x, y: out.y };
        }
    } catch {
        // Fall through to manual mapping.
    }
    // Manual mapping: viewBox + bounding rect, accounting for `meet`
    // letterboxing.
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const vb = svg.viewBox?.baseVal;
    if (!vb) {
        return { x: clientX - rect.left, y: clientY - rect.top };
    }
    const scale = Math.min(rect.width / vb.width, rect.height / vb.height);
    if (scale <= 0) return null;
    const drawnW = vb.width * scale;
    const drawnH = vb.height * scale;
    const offsetX = (rect.width - drawnW) / 2;
    const offsetY = (rect.height - drawnH) / 2;
    const px = clientX - rect.left - offsetX;
    const py = clientY - rect.top - offsetY;
    return { x: vb.x + px / scale, y: vb.y + py / scale };
}

/**
 * Hit-test a scene-coordinate point against the items in `scene.items`.
 *
 * Returns the id of the topmost (highest-index) item whose *axis-aligned*
 * transformed bounding box contains `p`, or `null` when no item contains
 * the point. Under arbitrary rotation the AABB is approximate but is
 * documented as adequate for selection (Property 6 pins exactly this
 * contract).
 */
function hitTopmost(items: Item[], p: Point): ItemId | null {
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const b = itemBoundingBox(item);
        if (p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY) {
            return item.id;
        }
    }
    return null;
}

/** Resolve the four corner / four edge handles' centres against a bbox. */
function handlePositions(b: Bbox, rotationOffset: number): Record<HandleKey, Point> {
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    return {
        tl: { x: b.minX, y: b.minY },
        t: { x: cx, y: b.minY },
        tr: { x: b.maxX, y: b.minY },
        l: { x: b.minX, y: cy },
        r: { x: b.maxX, y: cy },
        bl: { x: b.minX, y: b.maxY },
        b: { x: cx, y: b.maxY },
        br: { x: b.maxX, y: b.maxY },
        rot: { x: cx, y: b.minY - rotationOffset },
    };
}

// -----------------------------------------------------------------------------
// Gesture state
// -----------------------------------------------------------------------------

type ActiveGesture =
    | null
    | {
        kind: 'move';
        itemId: ItemId;
        pointerId: number;
        anchorScene: Point;
        t0: Transform;
    }
    | {
        kind: 'resize-corner';
        itemId: ItemId;
        pointerId: number;
        corner: 'tl' | 'tr' | 'bl' | 'br';
        bbox0: Bbox;
        t0: Transform;
    }
    | {
        kind: 'resize-edge';
        itemId: ItemId;
        pointerId: number;
        edge: 't' | 'b' | 'l' | 'r';
        bbox0: Bbox;
        t0: Transform;
    }
    | {
        kind: 'rotate';
        itemId: ItemId;
        pointerId: number;
        pivot: Point;
        t0: Transform;
    };

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function ComposerCanvas(props: ComposerCanvasProps): JSX.Element {
    const { store, envelopeMm, class: className, preview } = props;

    const mode: RendererMode = props.rendererMode ?? detectRendererMode();

    const previewActive = preview?.active === true;

    // Defensive envelope sizing: non-positive or non-finite inputs collapse
    // to a unit box so the SVG viewBox computation never produces NaN.
    const envW = Number.isFinite(envelopeMm.w) && envelopeMm.w > 0 ? envelopeMm.w : 1;
    const envH = Number.isFinite(envelopeMm.h) && envelopeMm.h > 0 ? envelopeMm.h : 1;

    const margin = Math.max(envW, envH) * VIEWPORT_MARGIN_FRAC;
    const handleSize = Math.max(envW, envH) * HANDLE_SIZE_FRAC;
    const rotationOffset = Math.max(envW, envH) * ROTATION_HANDLE_OFFSET_FRAC;

    const viewBox = `${-margin} ${-margin} ${envW + 2 * margin} ${envH + 2 * margin}`;

    // Reactive reads. Inline `.value` access registers this component as a
    // signal subscriber; the canvas re-renders whenever the Scene or the
    // selection changes.
    const scene = store.scene.value;
    const selected = store.selectedItem.value;
    const items = scene.items;

    // Preview-mode reveal geometry. Read the composed polylines (the exact
    // same scene-space output `Send to machine` transmits) only while
    // previewing so edit mode keeps its existing subscription set. The
    // composed path is progressively revealed up to `revealFraction` of its
    // total length, matching the moving indicator.
    const previewReveal = useMemo(() => {
        if (!previewActive) return null;
        const composed = store.composed.value;
        const total = pathLength(composed);
        if (total <= 0) return null;
        const reveal = Math.max(0, Math.min(1, preview?.revealFraction ?? 0)) * total;
        return revealedPolylines(composed, reveal);
        // `store` is stable; `composed.value` access subscribes us.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewActive, preview?.revealFraction, store.composed.value]);

    // -------------------------------------------------------------------------
    // Refs
    // -------------------------------------------------------------------------

    const svgRef = useRef<SVGSVGElement | null>(null);
    const gestureRef = useRef<ActiveGesture>(null);
    // -------------------------------------------------------------------------
    // Pointer-event helpers
    // -------------------------------------------------------------------------

    const finishGesture = (cancelled: boolean): void => {
        const g = gestureRef.current;
        if (g === null) return;
        gestureRef.current = null;
        if (cancelled) {
            store.cancelGesture();
        } else {
            store.endGesture();
        }
    };

    const onPointerDown = (e: PointerEvent): void => {
        const svg = svgRef.current;
        if (svg === null) return;
        // Ignore non-primary buttons; the move/resize gestures are bound to
        // the primary pointer button only.
        if (typeof e.button === 'number' && e.button !== 0) return;

        const target = e.target as Element | null;
        const handleKey = target?.getAttribute?.('data-handle') as HandleKey | null;

        const pointerScene = clientToScene(svg, e.clientX, e.clientY);
        if (pointerScene === null) return;

        // Focus the SVG so subsequent keyboard input lands on the canvas
        // (Req 8.x). pointerdown without preventDefault would normally take
        // focus already, but explicit focus is robust across browsers.
        try {
            svg.focus();
        } catch {
            // Some headless environments throw; non-fatal.
        }

        // Capture pointer so we keep receiving move / up events even if the
        // pointer leaves the SVG bounds mid-drag.
        try {
            (svg as unknown as { setPointerCapture?: (id: number) => void })
                .setPointerCapture?.(e.pointerId);
        } catch {
            // Older browsers / jsdom: graceful degradation.
        }

        e.preventDefault();

        // Case 1: pointer-down on a handle of the currently-selected item.
        if (handleKey !== null && selected !== null) {
            const bbox0 = itemBoundingBox(selected);
            const t0 = selected.transform;
            store.beginGesture(selected.id, handleKey === 'rot' ? 'rotate' : 'resize');
            if (handleKey === 'rot') {
                const pivot: Point = {
                    x: (bbox0.minX + bbox0.maxX) / 2,
                    y: (bbox0.minY + bbox0.maxY) / 2,
                };
                gestureRef.current = {
                    kind: 'rotate',
                    itemId: selected.id,
                    pointerId: e.pointerId,
                    pivot,
                    t0,
                };
                applyRotateGesture(pointerScene, !e.shiftKey);
            } else if (handleKey === 'tl' || handleKey === 'tr' || handleKey === 'bl' || handleKey === 'br') {
                gestureRef.current = {
                    kind: 'resize-corner',
                    itemId: selected.id,
                    pointerId: e.pointerId,
                    corner: handleKey,
                    bbox0,
                    t0,
                };
                applyResizeCornerGesture(pointerScene, !!e.shiftKey);
            } else if (handleKey === 't' || handleKey === 'b' || handleKey === 'l' || handleKey === 'r') {
                gestureRef.current = {
                    kind: 'resize-edge',
                    itemId: selected.id,
                    pointerId: e.pointerId,
                    edge: handleKey,
                    bbox0,
                    t0,
                };
                applyResizeEdgeGesture(pointerScene);
            }
            return;
        }

        // Case 2: pointer-down on an item — select topmost and start a move.
        const hitId = hitTopmost(items, pointerScene);
        if (hitId !== null) {
            store.select(hitId);
            // Look up the freshly-selected item from the live scene so the
            // gesture reads the post-select transform.
            const hit = items[items.findIndex((it) => it.id === hitId)];
            store.beginGesture(hitId, 'move');
            gestureRef.current = {
                kind: 'move',
                itemId: hitId,
                pointerId: e.pointerId,
                anchorScene: pointerScene,
                t0: hit.transform,
            };
            return;
        }

        // Case 3: pointer-down on empty canvas — clear selection (Req 3.4).
        if (selected !== null) store.select(null);
    };

    const applyMoveGesture = (pointerScene: Point): void => {
        const g = gestureRef.current;
        if (g === null || g.kind !== 'move') return;
        const dx = pointerScene.x - g.anchorScene.x;
        const dy = pointerScene.y - g.anchorScene.y;
        const next = moveTransform(g.t0, dx, dy);
        store.updateTransform(g.itemId, { x: next.x, y: next.y });
    };

    const applyResizeCornerGesture = (
        pointerScene: Point,
        aspectLock: boolean,
    ): void => {
        const g = gestureRef.current;
        if (g === null || g.kind !== 'resize-corner') return;
        const next = resizeFromCorner(g.t0, g.bbox0, g.corner, pointerScene, aspectLock);
        store.updateTransform(g.itemId, {
            x: next.x,
            y: next.y,
            sx: next.sx,
            sy: next.sy,
        });
    };

    const applyResizeEdgeGesture = (pointerScene: Point): void => {
        const g = gestureRef.current;
        if (g === null || g.kind !== 'resize-edge') return;
        const next = resizeFromEdge(g.t0, g.bbox0, g.edge, pointerScene);
        store.updateTransform(g.itemId, {
            x: next.x,
            y: next.y,
            sx: next.sx,
            sy: next.sy,
        });
    };

    const applyRotateGesture = (
        pointerScene: Point,
        snap15deg: boolean,
    ): void => {
        const g = gestureRef.current;
        if (g === null || g.kind !== 'rotate') return;
        const next = rotateToPointer(g.t0, g.pivot, pointerScene, snap15deg);
        store.updateTransform(g.itemId, { rotationRad: next.rotationRad });
    };

    const onPointerMove = (e: PointerEvent): void => {
        const g = gestureRef.current;
        if (g === null) return;
        if (e.pointerId !== g.pointerId) return;
        const svg = svgRef.current;
        if (svg === null) return;
        const pointerScene = clientToScene(svg, e.clientX, e.clientY);
        if (pointerScene === null) return;
        switch (g.kind) {
            case 'move':
                applyMoveGesture(pointerScene);
                break;
            case 'resize-corner':
                applyResizeCornerGesture(pointerScene, !!e.shiftKey);
                break;
            case 'resize-edge':
                applyResizeEdgeGesture(pointerScene);
                break;
            case 'rotate':
                applyRotateGesture(pointerScene, !e.shiftKey);
                break;
        }
    };

    const onPointerUp = (e: PointerEvent): void => {
        const g = gestureRef.current;
        if (g === null) return;
        if (e.pointerId !== g.pointerId) return;
        try {
            (svgRef.current as unknown as { releasePointerCapture?: (id: number) => void } | null)
                ?.releasePointerCapture?.(e.pointerId);
        } catch {
            // Non-fatal.
        }
        finishGesture(false);
    };

    const onPointerCancel = (e: PointerEvent): void => {
        const g = gestureRef.current;
        if (g === null) return;
        if (e.pointerId !== g.pointerId) return;
        finishGesture(true);
    };

    // -------------------------------------------------------------------------
    // Keyboard handling (Req 8.1–8.6)
    // -------------------------------------------------------------------------

    const onKeyDown = (e: KeyboardEvent): void => {
        if (selected === null) return;
        const t = selected.transform;
        let handled = true;
        switch (e.key) {
            case 'ArrowLeft': {
                const d = e.shiftKey ? KEY_TRANSLATE_UNIT_SHIFT : KEY_TRANSLATE_UNIT;
                store.updateTransform(selected.id, { x: t.x - d });
                break;
            }
            case 'ArrowRight': {
                const d = e.shiftKey ? KEY_TRANSLATE_UNIT_SHIFT : KEY_TRANSLATE_UNIT;
                store.updateTransform(selected.id, { x: t.x + d });
                break;
            }
            case 'ArrowUp': {
                const d = e.shiftKey ? KEY_TRANSLATE_UNIT_SHIFT : KEY_TRANSLATE_UNIT;
                store.updateTransform(selected.id, { y: t.y - d });
                break;
            }
            case 'ArrowDown': {
                const d = e.shiftKey ? KEY_TRANSLATE_UNIT_SHIFT : KEY_TRANSLATE_UNIT;
                store.updateTransform(selected.id, { y: t.y + d });
                break;
            }
            case '+':
            case '=': {
                store.updateTransform(selected.id, {
                    sx: t.sx * KEY_SCALE_FACTOR,
                    sy: t.sy * KEY_SCALE_FACTOR,
                });
                break;
            }
            case '-': {
                // SCALE_MIN is enforced by `clampScale` inside the SceneStore
                // commit, so a deeply-shrunk item stays renderable.
                store.updateTransform(selected.id, {
                    sx: t.sx / KEY_SCALE_FACTOR,
                    sy: t.sy / KEY_SCALE_FACTOR,
                });
                break;
            }
            case '[': {
                store.updateTransform(selected.id, {
                    rotationRad: t.rotationRad - KEY_ROTATE_RAD,
                });
                break;
            }
            case ']': {
                store.updateTransform(selected.id, {
                    rotationRad: t.rotationRad + KEY_ROTATE_RAD,
                });
                break;
            }
            case 'Backspace':
            case 'Delete': {
                // Remove the selected item from the Scene (Req 7.1). The
                // store clears `selectedId` automatically when the removed
                // item was selected (Req 3.6), so the overlay disappears
                // on the same render cycle.
                store.removeItem(selected.id);
                break;
            }
            default:
                handled = false;
                break;
        }
        if (handled) e.preventDefault();
    };

    // -------------------------------------------------------------------------
    // Selection overlay geometry
    // -------------------------------------------------------------------------

    const selectionOverlay = useMemo(() => {
        if (selected === null) return null;
        const bbox = itemBoundingBox(selected);
        const handles = handlePositions(bbox, rotationOffset);
        const ariaLabel = formatSelectionAriaLabel(selected);
        return { bbox, handles, ariaLabel };
    }, [selected, rotationOffset]);

    // -------------------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------------------

    useEffect(() => {
        return () => {
            // If the component unmounts mid-gesture, cancel so the SceneStore
            // restores the pre-gesture state (Req 4.4 / Req 5.5 / Req 6.4
            // continuity-of-state guarantee).
            if (gestureRef.current !== null) {
                gestureRef.current = null;
                try {
                    store.cancelGesture();
                } catch {
                    // Non-fatal during teardown.
                }
            }
        };
    }, [store]);

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    if (mode === 'canvas2d') {
        // Minimal Canvas2D fallback. Renders polylines via
        // `applyTransformToPolyline` per frame and intentionally omits the
        // selection overlay and pointer interactions: the SVG path is the
        // default, and the fallback exists only as a perf escape hatch.
        return (
            <ComposerCanvas2D
                items={items}
                envW={envW}
                envH={envH}
                margin={margin}
                class={className}
            />
        );
    }

    return (
        <div
            class={`composer-canvas${className !== undefined ? ` ${className}` : ''}`}
            data-testid="composer-canvas"
            data-renderer="svg"
            data-preview={previewActive ? 'active' : undefined}
        >
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
            <svg
                ref={svgRef}
                class="composer-canvas__surface"
                data-testid="composer-canvas-surface"
                viewBox={viewBox}
                preserveAspectRatio="xMidYMid meet"
                role="application"
                aria-label="Composer canvas"
                tabIndex={0}
                onPointerDown={(e) => onPointerDown(e as PointerEvent)}
                onPointerMove={(e) => onPointerMove(e as PointerEvent)}
                onPointerUp={(e) => onPointerUp(e as PointerEvent)}
                onPointerCancel={(e) => onPointerCancel(e as PointerEvent)}
                onKeyDown={(e) => onKeyDown(e as KeyboardEvent)}
                style={{
                    width: '100%',
                    height: 'auto',
                    display: 'block',
                    background: '#fafafa',
                    border: '1px solid #ddd',
                    touchAction: 'none',
                }}
            >
                {/* Items, rendered in `Scene.items` order so the LAST DOM
                    child is the topmost item (Req 1.3). */}
                {items.map((item) => (
                    <g
                        key={item.id}
                        data-testid="composer-canvas-item"
                        data-item-id={item.id}
                        data-kind={item.kind}
                        transform={transformAttr(item.transform)}
                        opacity={previewActive ? PREVIEW_DIM_OPACITY : undefined}
                    >
                        {item.content.map((poly, j) =>
                            poly.length >= 2 ? (
                                <polyline
                                    key={j}
                                    points={pointsAttr(poly)}
                                    fill="none"
                                    stroke={STROKE_COLOR}
                                    strokeWidth={Math.max(envW, envH) / 300}
                                    // Stroke width is authored in scene units,
                                    // but each item is wrapped in a `scale(sx,
                                    // sy)` transform. Without this, the rendered
                                    // stroke is multiplied by the item's scale,
                                    // so a pixel-space import that the
                                    // fit-transform shrinks to ~0.1× collapses
                                    // to a sub-pixel hairline (present in the
                                    // DOM and inside the envelope, but
                                    // invisible) while up-scaled content (e.g.
                                    // text) renders an exaggerated fat stroke.
                                    // `non-scaling-stroke` keeps the stroke a
                                    // constant width in viewBox units for every
                                    // item regardless of its transform scale.
                                    vector-effect="non-scaling-stroke"
                                    strokeLinejoin="round"
                                    strokeLinecap="round"
                                />
                            ) : null,
                        )}
                    </g>
                ))}

                {/* Dashed drawable-envelope rectangle — the digital twin
                    (Req 13.2). Rendered AFTER content so the user can see
                    where strokes exit the envelope, mirroring Canvas.tsx's
                    overlay-on-top approach. */}
                <rect
                    data-testid="composer-canvas-envelope"
                    x={0}
                    y={0}
                    width={envW}
                    height={envH}
                    fill="none"
                    stroke={ENVELOPE_COLOR}
                    strokeWidth={Math.max(envW, envH) / 300}
                    strokeDasharray={ENVELOPE_DASH}
                />

                {/* On-canvas preview: the progressively-revealed composed
                    path at full strength, plus a red stylus dot at the
                    indicator. Rendered in scene space (composeScene output)
                    so it matches exactly what `Send to machine` transmits.
                    `non-scaling-stroke` keeps the revealed stroke visible at
                    any envelope scale. */}
                {previewActive && previewReveal !== null && (
                    <g
                        class="composer-canvas__preview"
                        data-testid="composer-canvas-preview"
                        aria-hidden="true"
                    >
                        {previewReveal.map((poly, i) =>
                            poly.length >= 2 ? (
                                <polyline
                                    key={i}
                                    points={pointsAttr(poly)}
                                    fill="none"
                                    stroke={PREVIEW_STROKE_COLOR}
                                    strokeWidth={Math.max(envW, envH) / 300}
                                    vector-effect="non-scaling-stroke"
                                    strokeLinejoin="round"
                                    strokeLinecap="round"
                                    pointerEvents="none"
                                />
                            ) : null,
                        )}
                    </g>
                )}
                {previewActive && preview?.indicator != null && (
                    <circle
                        class="composer-canvas__preview-indicator"
                        data-testid="composer-canvas-preview-indicator"
                        cx={preview.indicator.x}
                        cy={preview.indicator.y}
                        r={Math.max(envW, envH) / 90}
                        fill={PREVIEW_INDICATOR_COLOR}
                        pointerEvents="none"
                    />
                )}

                {/* Selection overlay: 8 resize handles + 1 rotation handle.
                    Suppressed entirely while previewing so the moving stylus
                    and revealed stroke read cleanly (Req: preview mode hides
                    edit affordances). */}
                {!previewActive && selectionOverlay !== null && (
                    <g
                        class="composer-canvas__selection"
                        data-testid="composer-canvas-selection"
                        aria-label={selectionOverlay.ariaLabel}
                        role="group"
                    >
                        {/* Bounding-box rectangle. */}
                        <rect
                            x={selectionOverlay.bbox.minX}
                            y={selectionOverlay.bbox.minY}
                            width={selectionOverlay.bbox.maxX - selectionOverlay.bbox.minX}
                            height={selectionOverlay.bbox.maxY - selectionOverlay.bbox.minY}
                            fill="none"
                            stroke={SELECTION_COLOR}
                            strokeWidth={Math.max(envW, envH) / 250}
                            strokeDasharray="2 2"
                            pointerEvents="none"
                        />
                        {/* Rotation handle line + circle. */}
                        <line
                            x1={selectionOverlay.handles.t.x}
                            y1={selectionOverlay.handles.t.y}
                            x2={selectionOverlay.handles.rot.x}
                            y2={selectionOverlay.handles.rot.y}
                            stroke={SELECTION_COLOR}
                            strokeWidth={Math.max(envW, envH) / 400}
                            pointerEvents="none"
                        />
                        <circle
                            data-testid="composer-canvas-handle"
                            data-handle="rot"
                            cx={selectionOverlay.handles.rot.x}
                            cy={selectionOverlay.handles.rot.y}
                            r={handleSize / 1.5}
                            fill="#fff"
                            stroke={SELECTION_COLOR}
                            strokeWidth={Math.max(envW, envH) / 200}
                            style={{ cursor: 'grab' }}
                        />
                        {/* Eight resize handles. Solid accent fill with a
                            white stroke so they read as obvious click
                            targets against the white-ish canvas; the
                            rotation circle keeps the inverted (white fill
                            + accent stroke) treatment so the user can tell
                            it apart from the resize handles at a glance. */}
                        {(['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'] as const).map(
                            (key) => (
                                <rect
                                    key={key}
                                    data-testid="composer-canvas-handle"
                                    data-handle={key}
                                    x={selectionOverlay.handles[key].x - handleSize / 2}
                                    y={selectionOverlay.handles[key].y - handleSize / 2}
                                    width={handleSize}
                                    height={handleSize}
                                    fill={SELECTION_COLOR}
                                    stroke="#fff"
                                    strokeWidth={Math.max(envW, envH) / 200}
                                    style={{ cursor: handleCursor(key) }}
                                />
                            ),
                        )}
                    </g>
                )}
            </svg>
        </div>
    );
}

// -----------------------------------------------------------------------------
// Selection accessibility
// -----------------------------------------------------------------------------

/**
 * Build the selection overlay's accessible name. Tracks the design's
 * suggested wording (Req 8.7) — image / freehand items get the kind label,
 * text items append the entered string for context.
 */
function formatSelectionAriaLabel(item: Item): string {
    const base = KIND_LABELS[item.kind];
    if (item.kind === 'text') {
        return `${base}: ${item.source.text}`;
    }
    return base;
}

// -----------------------------------------------------------------------------
// Handle cursors
// -----------------------------------------------------------------------------

/** Per-handle CSS cursor name. Purely cosmetic; selection still works without. */
function handleCursor(key: HandleKey): string {
    switch (key) {
        case 'tl':
        case 'br':
            return 'nwse-resize';
        case 'tr':
        case 'bl':
            return 'nesw-resize';
        case 't':
        case 'b':
            return 'ns-resize';
        case 'l':
        case 'r':
            return 'ew-resize';
        case 'rot':
            return 'grab';
    }
}

// -----------------------------------------------------------------------------
// Canvas2D fallback
// -----------------------------------------------------------------------------

interface ComposerCanvas2DProps {
    items: Item[];
    envW: number;
    envH: number;
    margin: number;
    class: string | undefined;
}

/**
 * Minimal Canvas2D fallback. Renders the dashed envelope and every item's
 * polylines via `applyTransformToPolyline`. The selection overlay and
 * pointer interactions are SVG-only (per task notes); this path exists only
 * as a perf escape hatch. The SceneStore is unchanged across the two
 * render paths.
 */
function ComposerCanvas2D(props: ComposerCanvas2DProps): JSX.Element {
    const { items, envW, envH, margin, class: className } = props;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    // Backing-store size: keep it modest, the rasterisation will be
    // letterboxed by the wrapper's `aspect-ratio` style.
    const sceneW = envW + 2 * margin;
    const sceneH = envH + 2 * margin;
    const backingW = 600;
    const backingH = Math.max(1, Math.round((backingW * sceneH) / sceneW));

    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas === null) return;
        let ctx: CanvasRenderingContext2D | null = null;
        try {
            ctx = canvas.getContext('2d');
        } catch {
            ctx = null;
        }
        if (ctx === null) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fafafa';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const sx = canvas.width / sceneW;
        const sy = canvas.height / sceneH;
        const ox = margin;
        const oy = margin;
        const tx = (p: Point): number => (p.x + ox) * sx;
        const ty = (p: Point): number => (p.y + oy) * sy;

        // Items in array order: last item drawn last = topmost (Req 1.3).
        ctx.strokeStyle = STROKE_COLOR;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const item of items) {
            const t = item.transform;
            for (const poly of item.content) {
                if (poly.length < 2) continue;
                const transformed = applyTransformToPolyline(t, poly);
                ctx.beginPath();
                ctx.moveTo(tx(transformed[0]), ty(transformed[0]));
                for (let i = 1; i < transformed.length; i++) {
                    ctx.lineTo(tx(transformed[i]), ty(transformed[i]));
                }
                ctx.stroke();
            }
        }

        // Dashed envelope rectangle.
        ctx.strokeStyle = ENVELOPE_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(ox * sx, oy * sy, envW * sx, envH * sy);
        ctx.setLineDash([]);
    }, [items, envW, envH, margin, sceneW, sceneH]);

    return (
        <div
            class={`composer-canvas${className !== undefined ? ` ${className}` : ''}`}
            data-testid="composer-canvas"
            data-renderer="canvas2d"
        >
            <canvas
                ref={canvasRef}
                width={backingW}
                height={backingH}
                data-testid="composer-canvas-surface"
                role="img"
                aria-label="Composer canvas (Canvas2D fallback)"
                style={{
                    width: '100%',
                    height: 'auto',
                    display: 'block',
                    background: '#fafafa',
                    border: '1px solid #ddd',
                }}
            />
        </div>
    );
}

export default ComposerCanvas;
