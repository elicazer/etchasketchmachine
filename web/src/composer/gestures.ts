/**
 * Pure gesture math for the Composer Scene.
 *
 * Owns the affine arithmetic that turns pointer-event coordinates (in
 * scene units) into new `Transform` values during translate / resize /
 * rotate gestures. Pure — no DOM, no signals, no I/O. Every function
 * depends only on its arguments and returns a fresh `Transform`; the
 * input is never mutated (Req 10.1, 10.2).
 *
 * Affine convention (matches `compose.ts` and the canvas selection
 * overlay; rotation is counter-clockwise about the item's local origin):
 *
 *     T(p) = R(rotationRad) · S(sx, sy) · p + (x, y)
 *          = ( cos(θ)·sx·p.x − sin(θ)·sy·p.y + x ,
 *              sin(θ)·sx·p.x + cos(θ)·sy·p.y + y )
 *
 * Invariants enforced here:
 *   - `clampScale` keeps `|sx| ≥ SCALE_MIN ∧ |sy| ≥ SCALE_MIN` so no
 *     gesture can collapse an item to a degenerate single point or single
 *     line (Req 5.4).
 *   - `normaliseRotation` keeps `rotationRad ∈ [0, 2π)` so equivalent
 *     rotations have a single canonical value (Req 6.2).
 *   - `rotateToPointer` returns a `rotationRad` already in `[0, 2π)`,
 *     optionally snapped to multiples of `π / 12` (15°) (Req 6.3).
 *
 * @see .kiro/specs/unified-composer-canvas/design.md §"Components and Interfaces" #9
 * @see Requirements 4.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3
 */

import type { Point } from '../types';
import type { Transform } from './types';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Minimum allowed magnitude for `Transform.sx` and `Transform.sy`. The
 * SceneStore commits, every resize gesture, and the selection-overlay
 * handles all clamp through {@link clampScale} so no Item can collapse to
 * a degenerate scale (Req 5.4).
 *
 * `1e-3` is small enough to feel "free" to the user — they cannot
 * perceive the floor at typical canvas DPIs — yet large enough that the
 * affine math stays well-conditioned (no divisions by near-zero).
 */
export const SCALE_MIN = 1e-3;

/** 2π, computed once. */
const TAU = Math.PI * 2;

/** π / 12 = 15°, the rotation-snap increment (Req 6.3, 8.5, 8.6). */
const SNAP_STEP_RAD = Math.PI / 12;

/**
 * Soft cardinal-snap tolerance: 4°. When the un-snapped rotation angle is
 * within ±this many radians of any multiple of π/2 (0°, 90°, 180°, 270°),
 * `rotateToPointer` snaps to that exact cardinal multiple regardless of the
 * caller's `snap15deg` flag. Outside the band rotation stays free (or falls
 * through to the 15° hard-snap when the caller asks for it). Cardinal
 * multiples are exact multiples of 15°, so the soft snap is consistent
 * with the hard 15° snap when both could apply.
 */
export const CARDINAL_SOFT_SNAP_RAD = (4 * Math.PI) / 180;

// -----------------------------------------------------------------------------
// Bounding box type alias
// -----------------------------------------------------------------------------

/**
 * Axis-aligned bounding box in scene units. Matches the shape returned by
 * `itemBoundingBox` in `compose.ts`.
 */
interface Bbox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

// -----------------------------------------------------------------------------
// Invariant enforcers
// -----------------------------------------------------------------------------

/**
 * Clamp `t.sx` and `t.sy` so neither falls below {@link SCALE_MIN} in
 * magnitude. Sign is preserved so a flipped item (negative scale) stays
 * flipped after the clamp.
 *
 * `Math.sign(0) === 0`, so an exact-zero scale is treated as having
 * positive sign and clamped to `+SCALE_MIN`. This matches the natural
 * read of "a fresh resize from a degenerate input should default to a
 * non-flipped output".
 *
 * Returns the same object reference when no clamp was needed (cheap
 * structural-equality short-circuit).
 *
 * @see Requirement 5.4
 */
export function clampScale(t: Transform): Transform {
    const sx = clampOne(t.sx);
    const sy = clampOne(t.sy);
    if (sx === t.sx && sy === t.sy) return t;
    return { x: t.x, y: t.y, sx, sy, rotationRad: t.rotationRad };
}

function clampOne(s: number): number {
    if (Math.abs(s) >= SCALE_MIN) return s;
    // Math.sign(0) === 0; treat exact zero as +1 so the clamp always lands
    // on a finite, signed value.
    const sign = s < 0 ? -1 : 1;
    return sign * SCALE_MIN;
}

/**
 * Normalise `t.rotationRad` into the half-open interval `[0, 2π)` so
 * equivalent rotations have a single canonical value (Req 6.2).
 *
 * The formula `((r % TAU) + TAU) % TAU` handles negatives, exact
 * multiples of 2π, and floating-point `-0` uniformly. Non-finite inputs
 * (`NaN`, `±Infinity`) are passed through unchanged so the caller can
 * detect and handle them.
 *
 * Returns the same object reference when no change was needed.
 *
 * @see Requirement 6.2
 */
export function normaliseRotation(t: Transform): Transform {
    const original = t.rotationRad;
    if (!Number.isFinite(original)) return t;
    let r = ((original % TAU) + TAU) % TAU;
    // Defensive: some FP edge cases can land at exactly TAU; collapse to 0.
    if (r >= TAU) r -= TAU;
    // Treat -0 as +0 so structural comparisons see a single canonical value.
    if (Object.is(r, -0)) r = 0;
    if (r === original) return t;
    return { x: t.x, y: t.y, sx: t.sx, sy: t.sy, rotationRad: r };
}

// -----------------------------------------------------------------------------
// Translation
// -----------------------------------------------------------------------------

/**
 * Translate by raw pointer delta in scene units. Only `(x, y)` change;
 * `sx`, `sy`, and `rotationRad` are carried through unmodified
 * (Req 4.2, Property 7).
 *
 * Returns the same object reference when both deltas are exactly zero.
 *
 * @see Requirements 4.2, 8.1, 8.2
 */
export function moveTransform(t: Transform, dxScene: number, dyScene: number): Transform {
    if (dxScene === 0 && dyScene === 0) return t;
    return {
        x: t.x + dxScene,
        y: t.y + dyScene,
        sx: t.sx,
        sy: t.sy,
        rotationRad: t.rotationRad,
    };
}

// -----------------------------------------------------------------------------
// Resize: shared "scale around a fixed scene point" helper
// -----------------------------------------------------------------------------

/**
 * Internal: produce a new Transform whose scale relative to `t0` is
 * `(rX, rY)` and whose translation is recomputed so the scene point
 * `(pivotX, pivotY)` remains fixed under the new transform.
 *
 * Method:
 *   1. Inverse-transform the pivot under `t0` to find the local-frame
 *      point `(localX, localY)` that originally mapped to it.
 *   2. Set `sxNew = t0.sx · rX`, `syNew = t0.sy · rY`.
 *   3. Solve for `(xNew, yNew)` so that
 *      `R(θ) · S(sxNew, syNew) · (localX, localY) + (xNew, yNew) = pivot`.
 *
 * The rotation `t0.rotationRad` is preserved; only translation and scale
 * change. The result is run through `clampScale` so the SCALE_MIN
 * invariant always holds (Req 5.4).
 *
 * `t0.sx` and `t0.sy` are assumed to satisfy `|sx|, |sy| ≥ SCALE_MIN`
 * (the SceneStore enforces this on every commit), so the divisions in
 * the inverse step are well-conditioned.
 */
function scaleAroundScenePoint(
    t0: Transform,
    pivotX: number,
    pivotY: number,
    rX: number,
    rY: number,
): Transform {
    const cos = Math.cos(t0.rotationRad);
    const sin = Math.sin(t0.rotationRad);
    const dx = pivotX - t0.x;
    const dy = pivotY - t0.y;
    // Inverse of T(p) = R · S · p + (x, y): localised pivot.
    const localX = (cos * dx + sin * dy) / t0.sx;
    const localY = (-sin * dx + cos * dy) / t0.sy;

    const sxNew = t0.sx * rX;
    const syNew = t0.sy * rY;

    // Forward-transform (localX, localY) under the new scale and the same
    // rotation, then back-solve the new translation that puts the result
    // exactly at the pivot.
    const xNew = pivotX - (cos * sxNew * localX - sin * syNew * localY);
    const yNew = pivotY - (sin * sxNew * localX + cos * syNew * localY);

    return clampScale({
        x: xNew,
        y: yNew,
        sx: sxNew,
        sy: syNew,
        rotationRad: t0.rotationRad,
    });
}

// -----------------------------------------------------------------------------
// Resize: corner handles
// -----------------------------------------------------------------------------

/**
 * Lookup table for the corner-handle pivot and signed-direction values.
 *
 * For a given dragged corner, `pivot` is the *opposite* corner of
 * `bbox0` (which is held fixed under the new transform, Req 5.1) and
 * `(sgnX, sgnY)` is the sign of `(corner − pivot)` along each axis,
 * used to recover a per-axis scale ratio from the live pointer offset.
 */
const CORNER_TABLE = {
    tl: { pivot: 'maxX-maxY', sgnX: -1, sgnY: -1 },
    tr: { pivot: 'minX-maxY', sgnX: 1, sgnY: -1 },
    bl: { pivot: 'maxX-minY', sgnX: -1, sgnY: 1 },
    br: { pivot: 'minX-minY', sgnX: 1, sgnY: 1 },
} as const;

/**
 * Resize from a corner handle.
 *
 * `bbox0` is the item's *transformed* axis-aligned bounding box at
 * gesture-start (Req 5.1). The opposite corner of `bbox0` is the pivot
 * and remains fixed in scene coordinates under the returned Transform.
 * `pointerScene` is the live pointer position; the dragged corner moves
 * toward it (exactly to it for axis-aligned items, approximately for
 * rotated items — the property only requires the *opposite* corner to
 * stay fixed, see Property 7).
 *
 * When `aspectLock` is true (Shift held during drag, Req 5.3), the new
 * scale ratios are forced equal so the result satisfies
 * `sxNew / syNew === t0.sx / t0.sy`. The dominant pointer axis (by
 * absolute ratio) wins so a primarily-horizontal drag does not get
 * overridden by a tiny vertical jitter.
 *
 * Degenerate input (`bbox0` width or height of zero on the affected
 * axis) is treated as a no-op on that axis: the corresponding scale
 * factor is left at 1 rather than producing NaN or Infinity.
 *
 * The output's scale is run through `clampScale` so the SCALE_MIN
 * invariant always holds (Req 5.4). Rotation is unchanged.
 *
 * @see Requirements 5.1, 5.3, 5.4
 */
export function resizeFromCorner(
    t0: Transform,
    bbox0: Bbox,
    corner: 'tl' | 'tr' | 'bl' | 'br',
    pointerScene: Point,
    aspectLock: boolean,
): Transform {
    const W = bbox0.maxX - bbox0.minX;
    const H = bbox0.maxY - bbox0.minY;

    const entry = CORNER_TABLE[corner];
    const pivotX = entry.pivot.startsWith('max') ? bbox0.maxX : bbox0.minX;
    const pivotY = entry.pivot.endsWith('maxY') ? bbox0.maxY : bbox0.minY;
    const sgnX = entry.sgnX;
    const sgnY = entry.sgnY;

    // Per-axis ratio: how far has the dragged corner travelled relative to
    // its original signed offset from the pivot (`sgnX·W`, `sgnY·H`)?
    let rX = W > 0 ? (pointerScene.x - pivotX) / (sgnX * W) : 1;
    let rY = H > 0 ? (pointerScene.y - pivotY) / (sgnY * H) : 1;

    if (aspectLock) {
        // Force `rX === rY` so `sxNew / syNew = (t0.sx · rX) / (t0.sy · rY)`
        // collapses to `t0.sx / t0.sy` (Property 7 aspect-lock clause). The
        // dominant axis wins so primarily-X or primarily-Y drags both feel
        // natural; a perfectly diagonal drag yields the same ratio either
        // way so there is no tie-breaking ambiguity in practice.
        const r = Math.abs(rX) >= Math.abs(rY) ? rX : rY;
        rX = r;
        rY = r;
    }

    return scaleAroundScenePoint(t0, pivotX, pivotY, rX, rY);
}

// -----------------------------------------------------------------------------
// Resize: edge handles
// -----------------------------------------------------------------------------

/**
 * Resize from an edge handle (top, bottom, left, or right).
 *
 * Only one axis of scale changes — `sy` for top/bottom edges, `sx` for
 * left/right edges — so the orthogonal axis is preserved exactly
 * (Req 5.2). The midpoint of the *opposite* edge of `bbox0` is held
 * fixed in scene coordinates: that single point gives a unique pivot for
 * the `scaleAroundScenePoint` solver, which keeps the orthogonal axis
 * untouched (since the corresponding ratio is 1).
 *
 * Degenerate input (zero `bbox0` extent on the affected axis) is treated
 * as a no-op: the scale factor on that axis stays at 1.
 *
 * The output's scale is run through `clampScale` (Req 5.4). Rotation is
 * unchanged.
 *
 * @see Requirements 5.2, 5.4
 */
export function resizeFromEdge(
    t0: Transform,
    bbox0: Bbox,
    edge: 't' | 'b' | 'l' | 'r',
    pointerScene: Point,
): Transform {
    const W = bbox0.maxX - bbox0.minX;
    const H = bbox0.maxY - bbox0.minY;
    const cx = (bbox0.minX + bbox0.maxX) / 2;
    const cy = (bbox0.minY + bbox0.maxY) / 2;

    let pivotX: number;
    let pivotY: number;
    let rX: number;
    let rY: number;
    switch (edge) {
        case 't':
            // Pivot is the midpoint of the bottom edge; only sy ratio changes.
            pivotX = cx;
            pivotY = bbox0.maxY;
            rX = 1;
            rY = H > 0 ? (pointerScene.y - pivotY) / -H : 1;
            break;
        case 'b':
            pivotX = cx;
            pivotY = bbox0.minY;
            rX = 1;
            rY = H > 0 ? (pointerScene.y - pivotY) / H : 1;
            break;
        case 'l':
            pivotX = bbox0.maxX;
            pivotY = cy;
            rX = W > 0 ? (pointerScene.x - pivotX) / -W : 1;
            rY = 1;
            break;
        case 'r':
            pivotX = bbox0.minX;
            pivotY = cy;
            rX = W > 0 ? (pointerScene.x - pivotX) / W : 1;
            rY = 1;
            break;
    }

    return scaleAroundScenePoint(t0, pivotX, pivotY, rX, rY);
}

// -----------------------------------------------------------------------------
// Rotation
// -----------------------------------------------------------------------------

/**
 * Rotate to the angle implied by `pointerScene` relative to `pivotScene`.
 *
 * The new `rotationRad` is `atan2(pointer.y − pivot.y, pointer.x −
 * pivot.x)`, then snapped through a two-stage rule:
 *
 *   1. Soft cardinal snap (always on, regardless of `snap15deg`): if the
 *      raw angle is within ±{@link CARDINAL_SOFT_SNAP_RAD} (= 4°) of a
 *      multiple of π/2, snap to that cardinal multiple. This makes
 *      free-rotation feel intentional near 0°/90°/180°/270° without
 *      forcing the user to hold Shift.
 *   2. Otherwise, when `snap15deg` is true, snap to the nearest multiple
 *      of `π / 12` (15°) (Req 6.3, 8.5, 8.6). The soft cardinal snap takes
 *      precedence — cardinal multiples are exact multiples of 15° anyway,
 *      so this is consistent. Pointer-driven gestures pass `snap15deg`
 *      `true` by default (Shift inverts to free rotation); the keyboard
 *      `[`/`]` increments are themselves multiples of 15° so the flag is
 *      moot for the keyboard path.
 *   3. Otherwise, the angle stays free.
 *
 * Result is normalised into `[0, 2π)` (Req 6.2). Translation `(t0.x, t0.y)`
 * and scale `(t0.sx, t0.sy)` are carried through unmodified — callers that
 * need to pivot about a non-origin scene point should compose this with
 * their own translation adjustment.
 *
 * Snapping is applied *before* normalisation. Because `2π = 24 · π/12` and
 * `2π = 4 · π/2`, both snap grids divide 2π evenly, so snapping commutes
 * with the mod-2π normalisation; the order does not change the result for
 * finite inputs.
 *
 * @see Requirements 6.1, 6.2, 6.3
 */
export function rotateToPointer(
    t0: Transform,
    pivotScene: Point,
    pointerScene: Point,
    snap15deg: boolean,
): Transform {
    let angle = Math.atan2(
        pointerScene.y - pivotScene.y,
        pointerScene.x - pivotScene.x,
    );
    // Soft snap to cardinal angles (0, π/2, π, 3π/2) within a small tolerance
    // regardless of `snap15deg`. The user almost always wants clean cardinal
    // alignment when close, and dropping into a clean 90° feels intentional;
    // outside the tolerance band, rotation stays free.
    const HALF_PI = Math.PI / 2;
    const nearestCardinal = Math.round(angle / HALF_PI) * HALF_PI;
    if (Math.abs(angle - nearestCardinal) <= CARDINAL_SOFT_SNAP_RAD) {
        angle = nearestCardinal;
    } else if (snap15deg) {
        angle = Math.round(angle / SNAP_STEP_RAD) * SNAP_STEP_RAD;
    }
    let r = ((angle % TAU) + TAU) % TAU;
    if (r >= TAU) r -= TAU;
    if (Object.is(r, -0)) r = 0;
    return {
        x: t0.x,
        y: t0.y,
        sx: t0.sx,
        sy: t0.sy,
        rotationRad: r,
    };
}
