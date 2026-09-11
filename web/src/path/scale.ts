/**
 * Coordinate scaling, clamping, and step quantisation.
 *
 * This module is the boundary between the planner's floating-point
 * mm-space geometry and the integer motor-step coordinates used by
 * everything downstream (G-code emitter, Drawing_Command codec, wire).
 *
 * Pipeline for each point:
 *   1. Clamp into the 152 × 105 mm drawable area (Req 5.2).
 *   2. Convert mm → integer full motor steps using
 *      `steps_per_mm = FULL_STEPS_PER_KNOB_REV / mm_per_rev_axis`
 *      with a single `Math.round` at the boundary (Req 5.3).
 *   3. Add the calibrated home offset, in steps, so the final coords
 *      are expressed relative to home (Req 10.10).
 *
 * Step quantisation happens exactly once, here. No layer above this
 * module produces non-integer step coordinates.
 *
 * @see Design §3.1.4 (planner)
 * @see Requirements 5.2, 5.3, 10.10
 */

import {
    DEFAULT_MM_PER_REV_X,
    DEFAULT_MM_PER_REV_Y,
    DRAWABLE_MM,
    FULL_STEPS_PER_KNOB_REV,
} from '../constants';
import type { Point, Polyline } from '../types';

/** Inputs for {@link scaleAndClamp}. All fields are optional with sensible defaults. */
export interface ScaleAndClampOptions {
    /** Calibrated mm per knob revolution on the X axis. Defaults to {@link DEFAULT_MM_PER_REV_X}. */
    mmPerRevX?: number;
    /** Calibrated mm per knob revolution on the Y axis. Defaults to {@link DEFAULT_MM_PER_REV_Y}. */
    mmPerRevY?: number;
    /**
     * Per-axis home offset added in step space after quantisation, so the
     * planner can emit coordinates relative to a non-zero home (Req 10.10).
     * Defaults to `{ x: 0, y: 0 }`.
     */
    homeOffsetSteps?: { x: number; y: number };
}

/**
 * Clamp a point into the drawable area on each axis independently.
 *
 * Out-of-bounds inputs are projected onto the nearest boundary; in-bounds
 * inputs are returned unchanged. Points exactly on the boundary are
 * treated as in-bounds.
 *
 * @see Requirements 5.2
 */
export function clampToDrawableMm(p: Point): Point {
    return {
        x: clamp(p.x, 0, DRAWABLE_MM.w),
        y: clamp(p.y, 0, DRAWABLE_MM.h),
    };
}

/**
 * Convert a mm-space point to integer motor-step coordinates using the
 * calibrated mm-per-revolution values for each axis. Rounds to the
 * nearest integer step.
 *
 * Note: this function does not clamp; combine with {@link clampToDrawableMm}
 * (or use {@link scaleAndClamp}) when working with raw planner input.
 *
 * @see Requirements 5.3
 */
export function mmToSteps(
    p: Point,
    mmPerRevX: number,
    mmPerRevY: number,
): { x: number; y: number } {
    const stepsPerMmX = FULL_STEPS_PER_KNOB_REV / mmPerRevX;
    const stepsPerMmY = FULL_STEPS_PER_KNOB_REV / mmPerRevY;
    return {
        x: Math.round(p.x * stepsPerMmX),
        y: Math.round(p.y * stepsPerMmY),
    };
}

/**
 * Run a polyline through the full scale → clamp → step-convert → home-offset
 * pipeline, producing integer step coordinates ready for the next planner
 * stage (RDP simplification, NN stitching, G-code emission).
 *
 * The drawable-area-in-steps for a given calibration is
 * `Math.round(DRAWABLE_MM.w * (FULL_STEPS_PER_KNOB_REV / mmPerRevX))`
 * (and similarly for Y); see `PlannedPath.drawableSteps` in `types.ts`.
 *
 * @see Design §3.1.4
 * @see Requirements 5.2, 5.3, 10.10
 */
export function scaleAndClamp(
    poly: Polyline,
    opts: ScaleAndClampOptions = {},
): { x: number; y: number }[] {
    const mmPerRevX = opts.mmPerRevX ?? DEFAULT_MM_PER_REV_X;
    const mmPerRevY = opts.mmPerRevY ?? DEFAULT_MM_PER_REV_Y;
    const home = opts.homeOffsetSteps ?? { x: 0, y: 0 };

    const out: { x: number; y: number }[] = new Array(poly.length);
    for (let i = 0; i < poly.length; i++) {
        const clamped = clampToDrawableMm(poly[i]);
        const stepped = mmToSteps(clamped, mmPerRevX, mmPerRevY);
        out[i] = {
            x: stepped.x + home.x,
            y: stepped.y + home.y,
        };
    }
    return out;
}

function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/** Options for {@link fitPolylinesToDrawable}. */
export interface FitOptions {
    /** Fraction of the drawable area to fill (0–1). Defaults to 0.9 (a 5% margin all round). */
    margin?: number;
    /**
     * Flip the Y axis (source Y-down → drawable Y-up). Set true for inputs that
     * arrive in screen/pixel space (image, SVG, freehand surface); leave false
     * for inputs already authored +Y up (the text renderer). Default false.
     */
    flipY?: boolean;
}

/**
 * Uniformly scale and center a set of polylines so they fit inside the
 * drawable area, preserving aspect ratio. This is what makes "import an image
 * and it's formatted correctly" work without any manual scale/position knobs:
 * whatever the source pixel dimensions, the geometry is mapped to fill the
 * 152 × 105 mm area (minus a small margin) and centered.
 *
 * Input polylines are in source units (image pixels, glyph units, etc.); the
 * output is in mm-space ready for {@link scaleAndClamp}. When `flipY` is set
 * the Y axis is inverted so screen-space (Y down) sources map to drawable
 * space (Y up); text (already +Y up) must NOT flip or it comes out upside down.
 *
 * Empty input, or geometry with zero extent on both axes, is returned centered
 * without scaling so a degenerate import never divides by zero.
 *
 * @see Requirements 2.3, 5.2
 */
export function fitPolylinesToDrawable(
    polylines: Polyline[],
    opts: FitOptions = {},
): Polyline[] {
    if (polylines.length === 0) return [];

    const fill = clamp(opts.margin ?? 0.9, 0, 1);
    const flipY = opts.flipY ?? false;

    // Source bounding box across every point.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const poly of polylines) {
        for (const p of poly) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
    }
    if (!Number.isFinite(minX)) return polylines;

    const srcW = maxX - minX;
    const srcH = maxY - minY;

    const targetW = DRAWABLE_MM.w * fill;
    const targetH = DRAWABLE_MM.h * fill;

    // Uniform scale that fits the source box inside the target box.
    const sx = srcW > 0 ? targetW / srcW : Infinity;
    const sy = srcH > 0 ? targetH / srcH : Infinity;
    let s = Math.min(sx, sy);
    if (!Number.isFinite(s) || s <= 0) s = 1; // degenerate: no extent

    // Centre the scaled box within the full drawable area.
    const scaledW = srcW * s;
    const scaledH = srcH * s;
    const offX = (DRAWABLE_MM.w - scaledW) / 2;
    const offY = (DRAWABLE_MM.h - scaledH) / 2;

    return polylines.map((poly) =>
        poly.map((p) => ({
            x: offX + (p.x - minX) * s,
            // Flip Y only for screen-space sources; +Y-up sources keep Y as-is.
            y: flipY ? offY + (maxY - p.y) * s : offY + (p.y - minY) * s,
        })),
    );
}

/** A measured travel envelope in motor steps. */
export interface StepEnvelope {
    /** Envelope_X_Steps — measured X travel in steps (expected `> 0`). */
    x: number;
    /** Envelope_Y_Steps — measured Y travel in steps (expected `> 0`). */
    y: number;
}

/** Options for {@link fitPolylinesToEnvelope}. */
export interface FitToEnvelopeOptions {
    /** Fraction of the envelope to fill (0–1). Defaults to 1.0 (fill to edges). */
    margin?: number;
    /**
     * Flip the Y axis (source Y-down → envelope Y-up). Set true for inputs that
     * arrive in screen/pixel space (image, SVG, freehand surface); leave false
     * for inputs already authored +Y up (the text renderer). Default false.
     */
    flipY?: boolean;
}

/**
 * Uniformly scale and center a set of polylines so they fit inside the measured
 * {@link StepEnvelope}, preserving aspect ratio (letterbox, no stretch), and
 * emit INTEGER step coordinates clamped to the inclusive bounds `[0, env.x]` /
 * `[0, env.y]`.
 *
 * This is a step-space sibling of {@link fitPolylinesToDrawable}: rather than
 * fitting into the 152 × 105 mm rectangle and then converting mm → steps via
 * the `mm_per_rev` gear math, it fits directly into the measured step rectangle
 * `(env.x, env.y)` and rounds at the boundary. It therefore replaces
 * `fitPolylinesToDrawable` + {@link scaleAndClamp} for calibrated drawing —
 * there is no `mm_per_rev` conversion and no `DRAWABLE_MM` dependency.
 *
 * A single scale factor `s = min(targetW/srcW, targetH/srcH)` is applied to
 * both axes so aspect ratio is preserved (no stretch). The post-round clamp is
 * defensive: with `margin ≤ 1` and centering the pre-clamp value is already in
 * bounds up to a ½-step rounding margin, so the clamp only ever nudges an
 * extreme edge vertex by at most one step.
 *
 * Empty input is returned as `[]`; geometry with zero extent on both axes uses
 * `s = 1` so a degenerate import never divides by zero.
 *
 * @see Requirements 3.2, 3.3, 3.4
 * @see Design §"Web: Envelope-Fit (path/scale.ts)"
 */
export function fitPolylinesToEnvelope(
    polylines: Polyline[],
    env: StepEnvelope,
    opts: FitToEnvelopeOptions = {},
): { x: number; y: number }[][] {
    if (polylines.length === 0) return [];

    const fill = clamp(opts.margin ?? 1.0, 0, 1);
    const flipY = opts.flipY ?? false;

    // Source bounding box across every point.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const poly of polylines) {
        for (const p of poly) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
    }
    if (!Number.isFinite(minX)) return polylines.map((poly) => poly.map((p) => ({ ...p })));

    const srcW = maxX - minX;
    const srcH = maxY - minY;

    const targetW = env.x * fill;
    const targetH = env.y * fill;

    // Uniform scale that fits the source box inside the target box.
    const sx = srcW > 0 ? targetW / srcW : Infinity;
    const sy = srcH > 0 ? targetH / srcH : Infinity;
    let s = Math.min(sx, sy);
    if (!Number.isFinite(s) || s <= 0) s = 1; // degenerate: no extent

    // Centre the scaled box within the full envelope.
    const scaledW = srcW * s;
    const scaledH = srcH * s;
    const offX = (env.x - scaledW) / 2;
    const offY = (env.y - scaledH) / 2;

    return polylines.map((poly) =>
        poly.map((p) => ({
            x: clamp(Math.round(offX + (p.x - minX) * s), 0, env.x),
            // Flip Y only for screen-space sources; +Y-up sources keep Y as-is.
            y: flipY
                ? clamp(Math.round(offY + (maxY - p.y) * s), 0, env.y)
                : clamp(Math.round(offY + (p.y - minY) * s), 0, env.y),
        })),
    );
}
