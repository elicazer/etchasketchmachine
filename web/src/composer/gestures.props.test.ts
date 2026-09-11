// Feature: unified-composer-canvas — property tests for `gestures.ts`
//
// Covers Property 7 ("transform laws — move / resize / rotate") which the
// design pins to Requirements 4.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 8.1,
// 8.2, 8.3, 8.4, 8.5, 8.6.
//
// Property 7 is large enough that it splits cleanly into one `it(...)` per
// universal sub-law. Every `it` line is tagged with the
// `// Feature: unified-composer-canvas, Property 7: <text>` comment so the
// mapping to the design property is unambiguous.
//
// Iterations: ≥ 100 per property (project standard / fast-check default).
//
// `gestures.ts` is pure — no DOM, no signals, no I/O — so the tests only
// need to generate Transform / Bbox / Point inputs and pin universal laws on
// the output.
//
// @see web/src/composer/gestures.ts
// @see .kiro/specs/unified-composer-canvas/design.md §"Correctness Properties"
//   #7 (transform laws — move / resize / rotate)

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
    SCALE_MIN,
    moveTransform,
    resizeFromCorner,
    resizeFromEdge,
    rotateToPointer,
} from './gestures';
import { applyTransform } from './compose';
import type { Transform } from './types';
import type { Point } from '../types';

const NUM_RUNS = { numRuns: 100 } as const;
const TAU = Math.PI * 2;
const SNAP_STEP_RAD = Math.PI / 12; // 15°

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/**
 * Finite scene-unit coordinates over a wide-enough range to exercise both
 * sign branches of the affine math. `+ 0` canonicalises any `-0` to `+0`
 * so structural equality is not tripped by signed-zero artifacts.
 */
const arbCoord = fc
    .double({
        min: -1_000,
        max: 1_000,
        noNaN: true,
        noDefaultInfinity: true,
    })
    .map((v) => v + 0);

const arbPoint: fc.Arbitrary<Point> = fc.record({ x: arbCoord, y: arbCoord });

const arbDelta = fc
    .double({
        min: -1_000,
        max: 1_000,
        noNaN: true,
        noDefaultInfinity: true,
    })
    .map((v) => v + 0);

/**
 * Signed scale magnitudes for the *starting* Transform, well above
 * SCALE_MIN so that the SceneStore-committed-shape precondition holds and
 * the inverse step in `scaleAroundScenePoint` is well-conditioned.
 *
 * `|sx|, |sy| ∈ [0.1, 50]` matches the production mutator-committed range
 * (clampScale floor is 1e-3; 0.1 is two orders of magnitude above it).
 */
const arbSignedScale = fc
    .tuple(
        fc.double({
            min: 0.1,
            max: 50,
            noNaN: true,
            noDefaultInfinity: true,
        }),
        fc.boolean(),
    )
    .map(([m, neg]) => (neg ? -m : m));

/** Unconstrained signed scale — covers the SCALE_MIN-engaged branch. */
const arbAnySignedScale = fc
    .tuple(
        fc.double({
            min: 1e-4,
            max: 50,
            noNaN: true,
            noDefaultInfinity: true,
        }),
        fc.boolean(),
    )
    .map(([m, neg]) => (neg ? -m : m));

const arbTransform: fc.Arbitrary<Transform> = fc.record({
    x: arbCoord,
    y: arbCoord,
    sx: arbSignedScale,
    sy: arbSignedScale,
    rotationRad: fc
        .double({
            min: 0,
            max: TAU - 1e-9,
            noNaN: true,
            noDefaultInfinity: true,
        })
        .map((v) => v + 0),
});

/** Transform with possibly-tiny scales — used by the SCALE_MIN-floor test. */
const arbAnyTransform: fc.Arbitrary<Transform> = fc.record({
    x: arbCoord,
    y: arbCoord,
    sx: arbAnySignedScale,
    sy: arbAnySignedScale,
    rotationRad: fc
        .double({
            min: 0,
            max: TAU - 1e-9,
            noNaN: true,
            noDefaultInfinity: true,
        })
        .map((v) => v + 0),
});

interface Bbox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * Non-degenerate axis-aligned bounding box (W, H ∈ [1, 100]). Bounds are
 * positive on both axes so the resize math has a real signed direction
 * for every corner / edge.
 */
const arbBbox: fc.Arbitrary<Bbox> = fc
    .record({
        minX: arbCoord,
        minY: arbCoord,
        w: fc.double({
            min: 1,
            max: 100,
            noNaN: true,
            noDefaultInfinity: true,
        }),
        h: fc.double({
            min: 1,
            max: 100,
            noNaN: true,
            noDefaultInfinity: true,
        }),
    })
    .map(({ minX, minY, w, h }) => ({
        minX,
        minY,
        maxX: minX + w,
        maxY: minY + h,
    }));

const arbCorner = fc.constantFrom(
    'tl' as const,
    'tr' as const,
    'bl' as const,
    'br' as const,
);
const arbEdge = fc.constantFrom(
    't' as const,
    'b' as const,
    'l' as const,
    'r' as const,
);

/**
 * Per-axis "resize ratio" generator constrained so the implied pointer
 * gives a post-resize scale comfortably above SCALE_MIN. With |t0.s*| ≥
 * 0.1 (`arbTransform`) and |r| ∈ [0.1, 10], we get
 * `|t0.s* · r| ∈ [0.01, 500]`, two orders of magnitude above SCALE_MIN
 * (= 1e-3) — so `clampScale` cannot engage and the pivot-invariance and
 * aspect-lock laws hold without the clamp branch interfering.
 */
const arbResizeRatio = fc
    .tuple(
        fc.double({
            min: 0.1,
            max: 10,
            noNaN: true,
            noDefaultInfinity: true,
        }),
        fc.boolean(),
    )
    .map(([m, neg]) => (neg ? -m : m));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Lookup of the *opposite-corner pivot* for a given dragged corner. Mirrors
 * the private CORNER_TABLE in `gestures.ts`; defined here independently so
 * the test would catch a regression if the production table desynced from
 * the documented contract.
 */
function pivotFromBbox(
    bbox: Bbox,
    corner: 'tl' | 'tr' | 'bl' | 'br',
): { pivotX: number; pivotY: number; sgnX: -1 | 1; sgnY: -1 | 1 } {
    switch (corner) {
        case 'tl':
            return { pivotX: bbox.maxX, pivotY: bbox.maxY, sgnX: -1, sgnY: -1 };
        case 'tr':
            return { pivotX: bbox.minX, pivotY: bbox.maxY, sgnX: 1, sgnY: -1 };
        case 'bl':
            return { pivotX: bbox.maxX, pivotY: bbox.minY, sgnX: -1, sgnY: 1 };
        case 'br':
            return { pivotX: bbox.minX, pivotY: bbox.minY, sgnX: 1, sgnY: 1 };
    }
}

/**
 * Relative-or-absolute float closeness. The pivot-invariance law is
 * algebraically exact, but FP arithmetic introduces sub-ULP error after
 * the inverse-then-forward chain. The tolerances here are generous
 * enough to absorb that noise on any reasonable input but tight enough
 * that a real algebraic regression would still be caught.
 */
function approxEqual(
    a: number,
    b: number,
    relTol = 1e-9,
    absTol = 1e-7,
): boolean {
    return (
        Math.abs(a - b)
        <= Math.max(absTol, relTol * Math.max(Math.abs(a), Math.abs(b)))
    );
}

// -----------------------------------------------------------------------------
// Property 7 — sub-law: moveTransform shifts only (x, y)
// -----------------------------------------------------------------------------

describe('gestures.ts — Property 7 (moveTransform shifts only translation)', () => {
    /**
     * **Validates: Requirements 4.2, 8.1, 8.2**
     *
     * `moveTransform(t0, dx, dy)` adds `(dx, dy)` to `(t0.x, t0.y)` and
     * carries `sx`, `sy`, `rotationRad` through unchanged. Holds for any
     * starting Transform and any finite delta — including the
     * 1-/10-unit arrow-key deltas exercised by Req 8.1 / 8.2.
     */
    // Feature: unified-composer-canvas, Property 7: moveTransform translates only (x, y); sx, sy, rotationRad unchanged
    it('moveTransform translates only (x, y); sx, sy, rotationRad unchanged for any delta', () => {
        fc.assert(
            fc.property(arbTransform, arbDelta, arbDelta, (t0, dx, dy) => {
                const t1 = moveTransform(t0, dx, dy);

                expect(t1.x).toBe(t0.x + dx);
                expect(t1.y).toBe(t0.y + dy);

                // Identity on every other field — strict equality matches
                // the implementation's documented contract (no
                // numerical-accuracy slack here).
                expect(t1.sx).toBe(t0.sx);
                expect(t1.sy).toBe(t0.sy);
                expect(t1.rotationRad).toBe(t0.rotationRad);
            }),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 7 — sub-law: resizeFromCorner keeps the opposite corner fixed
// -----------------------------------------------------------------------------

describe('gestures.ts — Property 7 (resizeFromCorner pivot invariance)', () => {
    /**
     * **Validates: Requirements 5.1, 5.4**
     *
     * The opposite corner of `bbox0` is the gesture pivot (Req 5.1). The
     * helper computes the local-frame point that maps to that pivot under
     * `t0`, then back-solves the new translation so the same local point
     * maps to the same scene-space pivot under the new transform. The
     * precise law is therefore:
     *
     *     applyTransform(tNew, applyInverse(t0, pivot)) == pivot
     *
     * That holds *regardless* of rotation (the rotation is unchanged
     * across t0 → tNew, so the inverse-then-forward chain telescopes
     * cleanly). Inputs are constrained so `|t0.s* · r*| ≫ SCALE_MIN` —
     * `clampScale` never engages — so the algebraic identity is
     * exercised without the clamp branch interfering.
     */
    // Feature: unified-composer-canvas, Property 7: resizeFromCorner keeps the opposite corner of bbox0 fixed under the new transform (pivot scene point invariant)
    it('resizeFromCorner keeps the opposite-corner scene point invariant under the new transform (any rotation)', () => {
        fc.assert(
            fc.property(
                arbTransform,
                arbBbox,
                arbCorner,
                arbResizeRatio,
                arbResizeRatio,
                fc.boolean(),
                (t0, bbox, corner, rX, rY, aspectLock) => {
                    const { pivotX, pivotY, sgnX, sgnY } = pivotFromBbox(
                        bbox,
                        corner,
                    );
                    const pointer: Point = {
                        x: pivotX + sgnX * (bbox.maxX - bbox.minX) * rX,
                        y: pivotY + sgnY * (bbox.maxY - bbox.minY) * rY,
                    };

                    const tNew = resizeFromCorner(
                        t0,
                        bbox,
                        corner,
                        pointer,
                        aspectLock,
                    );

                    // The local-frame point that mapped to the pivot under
                    // t0. We compute it independently of `gestures.ts` so a
                    // regression in the back-solve would surface here.
                    const cos = Math.cos(t0.rotationRad);
                    const sin = Math.sin(t0.rotationRad);
                    const dx = pivotX - t0.x;
                    const dy = pivotY - t0.y;
                    const localPivot: Point = {
                        x: (cos * dx + sin * dy) / t0.sx,
                        y: (-sin * dx + cos * dy) / t0.sy,
                    };

                    // The new transform applied to the same local-frame
                    // point should land back on the same scene pivot.
                    const recovered = applyTransform(tNew, localPivot);
                    expect(approxEqual(recovered.x, pivotX)).toBe(true);
                    expect(approxEqual(recovered.y, pivotY)).toBe(true);

                    // Rotation is preserved across resize (Req 5; only sx,
                    // sy, x, y change).
                    expect(tNew.rotationRad).toBe(t0.rotationRad);
                },
            ),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 7 — sub-law: aspect-lock preserves the starting aspect ratio
// -----------------------------------------------------------------------------

describe('gestures.ts — Property 7 (resizeFromCorner aspect lock)', () => {
    /**
     * **Validates: Requirements 5.3, 8.3, 8.4**
     *
     * With `aspectLock=true` (Shift held during a corner drag), the
     * implementation forces a single shared ratio `r := dominant(rX, rY)`
     * and sets `sxNew = t0.sx · r`, `syNew = t0.sy · r`. Therefore
     * `sxNew / syNew == t0.sx / t0.sy` to floating-point precision —
     * "preserves the starting aspect ratio" in the design sense.
     *
     * Inputs are again constrained so `clampScale` does not engage; if
     * the clamp ran on only one of `sx`/`sy`, the ratio would shift.
     */
    // Feature: unified-composer-canvas, Property 7: resizeFromCorner with aspectLock preserves t0.sx / t0.sy (aspect ratio at gesture-start)
    it('resizeFromCorner with aspectLock=true preserves sxNew / syNew = t0.sx / t0.sy', () => {
        fc.assert(
            fc.property(
                arbTransform,
                arbBbox,
                arbCorner,
                arbResizeRatio,
                arbResizeRatio,
                (t0, bbox, corner, rX, rY) => {
                    const { pivotX, pivotY, sgnX, sgnY } = pivotFromBbox(
                        bbox,
                        corner,
                    );
                    const pointer: Point = {
                        x: pivotX + sgnX * (bbox.maxX - bbox.minX) * rX,
                        y: pivotY + sgnY * (bbox.maxY - bbox.minY) * rY,
                    };

                    const tNew = resizeFromCorner(
                        t0,
                        bbox,
                        corner,
                        pointer,
                        true,
                    );

                    // Ratio invariance: sxNew / syNew == t0.sx / t0.sy.
                    // Compare via cross-product to avoid the divide and to
                    // accept the FP tolerance uniformly across magnitudes.
                    const cross = tNew.sx * t0.sy - tNew.sy * t0.sx;
                    const scale = Math.max(
                        1,
                        Math.abs(tNew.sx * t0.sy),
                        Math.abs(tNew.sy * t0.sx),
                    );
                    expect(Math.abs(cross) / scale).toBeLessThan(1e-9);
                },
            ),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 7 — sub-law: SCALE_MIN floor after every resize
// -----------------------------------------------------------------------------

describe('gestures.ts — Property 7 (clampScale floor after resize)', () => {
    /**
     * **Validates: Requirements 5.4, 8.3, 8.4**
     *
     * Every output of a corner / edge resize, post `clampScale`, must
     * satisfy `|sx| ≥ SCALE_MIN ∧ |sy| ≥ SCALE_MIN` so an item cannot
     * collapse to a degenerate single point or single line.
     *
     * Inputs here are *un*-restricted relative to the SCALE_MIN floor:
     *   - `t0` may have scales as small as 1e-4 (below SCALE_MIN).
     *   - The pointer may be anywhere in the [-1000, 1000]² scene range,
     *     including very close to or exactly at the pivot.
     * If the implementation forgot to call `clampScale`, the output
     * could go arbitrarily small / zero / sign-flipped-to-zero, so this
     * test pins the floor universally.
     */
    // Feature: unified-composer-canvas, Property 7: every resize output (post-clampScale) satisfies |sx|, |sy| ≥ SCALE_MIN
    it('resizeFromCorner output (post-clampScale) satisfies |sx|, |sy| ≥ SCALE_MIN for any pointer', () => {
        fc.assert(
            fc.property(
                arbAnyTransform,
                arbBbox,
                arbCorner,
                arbPoint,
                fc.boolean(),
                (t0, bbox, corner, pointer, aspectLock) => {
                    const tNew = resizeFromCorner(
                        t0,
                        bbox,
                        corner,
                        pointer,
                        aspectLock,
                    );
                    expect(Math.abs(tNew.sx)).toBeGreaterThanOrEqual(
                        SCALE_MIN,
                    );
                    expect(Math.abs(tNew.sy)).toBeGreaterThanOrEqual(
                        SCALE_MIN,
                    );
                    // No NaN / Infinity should leak even from degenerate
                    // pointer placements (rX or rY = 0).
                    expect(Number.isFinite(tNew.sx)).toBe(true);
                    expect(Number.isFinite(tNew.sy)).toBe(true);
                },
            ),
            NUM_RUNS,
        );
    });

    // Feature: unified-composer-canvas, Property 7: every resize output (post-clampScale) satisfies |sx|, |sy| ≥ SCALE_MIN — edge handles
    it('resizeFromEdge output (post-clampScale) satisfies |sx|, |sy| ≥ SCALE_MIN for any pointer', () => {
        fc.assert(
            fc.property(
                arbAnyTransform,
                arbBbox,
                arbEdge,
                arbPoint,
                (t0, bbox, edge, pointer) => {
                    const tNew = resizeFromEdge(t0, bbox, edge, pointer);
                    expect(Math.abs(tNew.sx)).toBeGreaterThanOrEqual(
                        SCALE_MIN,
                    );
                    expect(Math.abs(tNew.sy)).toBeGreaterThanOrEqual(
                        SCALE_MIN,
                    );
                    expect(Number.isFinite(tNew.sx)).toBe(true);
                    expect(Number.isFinite(tNew.sy)).toBe(true);
                },
            ),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 7 — sub-law: rotateToPointer (no snap)
// -----------------------------------------------------------------------------

describe('gestures.ts — Property 7 (rotateToPointer without snap)', () => {
    /**
     * **Validates: Requirements 6.1, 6.2**
     *
     * Without snap, the result equals
     *
     *     ((atan2(p.y − pivot.y, p.x − pivot.x) % 2π) + 2π) % 2π
     *
     * and lies in `[0, 2π)`. Translation and scale are carried through
     * unchanged.
     *
     * `atan2(0, 0) === 0` by IEEE-754 convention, so the
     * pointer-coincides-with-pivot edge case still produces a well-defined
     * `0` and is not excluded.
     */
    // Feature: unified-composer-canvas, Property 7: rotateToPointer (snap=false) returns rotationRad ∈ [0, 2π) equal to atan2(p − pivot) mod 2π
    it('rotateToPointer (snap=false) returns rotationRad ∈ [0, 2π) equal to atan2(p − pivot) mod 2π', () => {
        fc.assert(
            fc.property(
                arbTransform,
                arbPoint,
                arbPoint,
                (t0, pivot, pointer) => {
                    const tNew = rotateToPointer(t0, pivot, pointer, false);

                    // Domain: rotationRad ∈ [0, 2π).
                    expect(tNew.rotationRad).toBeGreaterThanOrEqual(0);
                    expect(tNew.rotationRad).toBeLessThan(TAU);

                    // Equal to atan2(...) mod 2π.
                    const raw = Math.atan2(
                        pointer.y - pivot.y,
                        pointer.x - pivot.x,
                    );
                    let expected = ((raw % TAU) + TAU) % TAU;
                    if (expected >= TAU) expected -= TAU;
                    if (Object.is(expected, -0)) expected = 0;
                    expect(approxEqual(tNew.rotationRad, expected)).toBe(true);

                    // Translation and scale carried through unchanged.
                    expect(tNew.x).toBe(t0.x);
                    expect(tNew.y).toBe(t0.y);
                    expect(tNew.sx).toBe(t0.sx);
                    expect(tNew.sy).toBe(t0.sy);
                },
            ),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 7 — sub-law: rotateToPointer (snap=true)
// -----------------------------------------------------------------------------

describe('gestures.ts — Property 7 (rotateToPointer with 15° snap)', () => {
    /**
     * **Validates: Requirements 6.3, 8.5, 8.6**
     *
     * With `snap15deg=true`, the result is rounded to the nearest multiple
     * of `π / 12` (15°) and then normalised into `[0, 2π)`. Because
     * `2π = 24 · π/12`, the snap step divides 2π evenly and snapping
     * commutes with mod-2π normalisation: every output is a clean
     * multiple `k · π/12` for some integer `k ∈ [0, 24)`.
     *
     * Note: floating-point arithmetic means the literal value may be
     * `k · π/12 + ε`, but `result mod (π/12)` is within ULP of zero. The
     * test pins both:
     *   1. `rotationRad ∈ [0, 2π)` (domain).
     *   2. `rotationRad / (π/12)` is an integer-with-FP-noise in
     *      `[0, 24)` (snap to grid).
     */
    // Feature: unified-composer-canvas, Property 7: rotateToPointer (snap=true) returns rotationRad ∈ [0, 2π) snapped to a multiple of π/12
    it('rotateToPointer (snap=true) returns a multiple of π/12 in [0, 2π)', () => {
        fc.assert(
            fc.property(
                arbTransform,
                arbPoint,
                arbPoint,
                (t0, pivot, pointer) => {
                    const tNew = rotateToPointer(t0, pivot, pointer, true);

                    // Domain: rotationRad ∈ [0, 2π).
                    expect(tNew.rotationRad).toBeGreaterThanOrEqual(0);
                    expect(tNew.rotationRad).toBeLessThan(TAU);

                    // Snap-to-grid: there is some integer k ∈ [0, 24) with
                    // |rotationRad − k · π/12| within FP tolerance.
                    const k = Math.round(tNew.rotationRad / SNAP_STEP_RAD);
                    expect(k).toBeGreaterThanOrEqual(0);
                    expect(k).toBeLessThanOrEqual(24);
                    const expected = k * SNAP_STEP_RAD;
                    expect(approxEqual(tNew.rotationRad, expected)).toBe(true);

                    // Cross-check against the closed-form: round(atan2 /
                    // step) · step, mod 2π. A regression that snapped to
                    // a different step (e.g. π/8) or skipped the
                    // normalisation would surface here.
                    const raw = Math.atan2(
                        pointer.y - pivot.y,
                        pointer.x - pivot.x,
                    );
                    const snapped =
                        Math.round(raw / SNAP_STEP_RAD) * SNAP_STEP_RAD;
                    let expectedNormalised =
                        ((snapped % TAU) + TAU) % TAU;
                    if (expectedNormalised >= TAU) expectedNormalised -= TAU;
                    if (Object.is(expectedNormalised, -0)) {
                        expectedNormalised = 0;
                    }
                    expect(
                        approxEqual(tNew.rotationRad, expectedNormalised),
                    ).toBe(true);

                    // Translation and scale carried through unchanged.
                    expect(tNew.x).toBe(t0.x);
                    expect(tNew.y).toBe(t0.y);
                    expect(tNew.sx).toBe(t0.sx);
                    expect(tNew.sy).toBe(t0.sy);
                },
            ),
            NUM_RUNS,
        );
    });
});
