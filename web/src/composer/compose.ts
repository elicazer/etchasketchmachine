/**
 * Pure composition layer for the Composer Scene.
 *
 * Owns the affine transform math and the `composeScene` flattener that
 * turns a `Scene` into the flat `Polyline[]` consumed by
 * `controller.setPolylines` (downstream of `fitPolylinesToEnvelope` and
 * `PathPlanner.plan`). No DOM, no signals, no I/O, no globals — every
 * function in this module depends only on its arguments (Req 10.1, 10.2).
 *
 * Affine convention (single shared definition; matches `gestures.ts` and the
 * canvas selection overlay):
 *
 *     T(p) = R(rotationRad) · S(sx, sy) · p + (x, y)
 *          = ( cos(θ)·sx·p.x − sin(θ)·sy·p.y + x ,
 *              sin(θ)·sx·p.x + cos(θ)·sy·p.y + y )
 *
 * Rotation is counter-clockwise about the item's local origin (= the local
 * origin of `content`, i.e. `(0, 0)` in the generator's own frame).
 *
 * @see .kiro/specs/unified-composer-canvas/design.md §"Components and Interfaces" #2
 * @see Requirements 9.1, 9.2, 9.3, 9.6, 9.7, 10.1, 10.2
 */

import type { Point, Polyline } from '../types';
import type { Item, Scene, Transform } from './types';

// -----------------------------------------------------------------------------
// Affine helpers
// -----------------------------------------------------------------------------

/**
 * Apply an item's Transform to a single local-frame point.
 *
 * Pure: returns a fresh `Point`; does not mutate `t` or `p`.
 *
 * @see Requirement 9.2
 */
export function applyTransform(t: Transform, p: Point): Point {
    const cos = Math.cos(t.rotationRad);
    const sin = Math.sin(t.rotationRad);
    return {
        x: cos * t.sx * p.x - sin * t.sy * p.y + t.x,
        y: sin * t.sx * p.x + cos * t.sy * p.y + t.y,
    };
}

/**
 * Apply an item's Transform to every point of a single polyline.
 *
 * Allocates a new array (and new `Point` objects) so callers can keep both
 * the local-frame source and the transformed output without aliasing.
 * The trig values are computed once and reused across every point in the
 * polyline.
 *
 * @see Requirement 9.2
 */
export function applyTransformToPolyline(t: Transform, poly: Polyline): Polyline {
    const cos = Math.cos(t.rotationRad);
    const sin = Math.sin(t.rotationRad);
    const out: Polyline = new Array(poly.length);
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        out[i] = {
            x: cos * t.sx * p.x - sin * t.sy * p.y + t.x,
            y: sin * t.sx * p.x + cos * t.sy * p.y + t.y,
        };
    }
    return out;
}

// -----------------------------------------------------------------------------
// Composition
// -----------------------------------------------------------------------------

/**
 * Compose the Scene into a flat `Polyline[]` ready for
 * `controller.setPolylines`.
 *
 * For each item in `scene.items` (in array order, lowest index first =
 * Z-order bottommost first per Req 1.3, 9.1), apply
 * `T(p) = R(rotationRad) · S(sx, sy) · p + (x, y)` to every point in every
 * local-frame polyline, then concatenate the results.
 *
 * Defensive: any input polyline with fewer than two points is skipped —
 * the planner would skip it anyway, and this keeps the composed output
 * conformant with the `Polyline` invariant (≥ 2 points per polyline) used
 * downstream.
 *
 * Pure: depends only on its `scene` argument; does not mutate it. Calling
 * this twice with structurally equal Scenes produces structurally equal
 * outputs (Req 10.1, 10.2).
 *
 * Empty Scene (or a Scene with no qualifying polylines) returns `[]`
 * (Req 9.3).
 *
 * @see Requirements 9.1, 9.2, 9.3, 10.1, 10.2
 */
export function composeScene(scene: Scene): Polyline[] {
    const out: Polyline[] = [];
    const items = scene.items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const t = item.transform;
        const cos = Math.cos(t.rotationRad);
        const sin = Math.sin(t.rotationRad);
        const content = item.content;
        for (let j = 0; j < content.length; j++) {
            const poly = content[j];
            // Defensive: skip degenerate polylines (< 2 points). The planner
            // would skip them anyway, but emitting a single-point polyline
            // here would violate the downstream `Polyline` invariant.
            if (poly.length < 2) continue;
            const transformed: Polyline = new Array(poly.length);
            for (let k = 0; k < poly.length; k++) {
                const p = poly[k];
                transformed[k] = {
                    x: cos * t.sx * p.x - sin * t.sy * p.y + t.x,
                    y: sin * t.sx * p.x + cos * t.sy * p.y + t.y,
                };
            }
            out.push(transformed);
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// Bounding box
// -----------------------------------------------------------------------------

/**
 * Bounding box of an item's *transformed* content, used by the canvas for
 * hit-testing and selection-overlay rendering.
 *
 * Pure: depends only on its `item` argument.
 *
 * Polylines with fewer than two points are skipped to match the
 * composition convention. If no qualifying points exist, returns a
 * degenerate box at the item's translation origin so callers (selection
 * overlay, hit-test) can still place a marker without special-casing the
 * empty-content case.
 */
export function itemBoundingBox(item: Item): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} {
    const t = item.transform;
    const cos = Math.cos(t.rotationRad);
    const sin = Math.sin(t.rotationRad);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let any = false;
    const content = item.content;
    for (let j = 0; j < content.length; j++) {
        const poly = content[j];
        if (poly.length < 2) continue;
        for (let k = 0; k < poly.length; k++) {
            const p = poly[k];
            const x = cos * t.sx * p.x - sin * t.sy * p.y + t.x;
            const y = sin * t.sx * p.x + cos * t.sy * p.y + t.y;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            any = true;
        }
    }
    if (!any) {
        return { minX: t.x, minY: t.y, maxX: t.x, maxY: t.y };
    }
    return { minX, minY, maxX, maxY };
}
