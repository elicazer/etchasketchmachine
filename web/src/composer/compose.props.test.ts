// Feature: unified-composer-canvas — property tests for `compose.ts`
//
// Covers four universal properties of the pure composer:
//
//   - Property 1: composeScene Z-order
//                 (Validates Requirements 1.2, 1.3, 1.4, 9.1, 9.3)
//   - Property 2: composeScene affine correctness
//                 (Validates Requirements 1.3, 9.2)
//   - Property 3: composeScene determinism and purity
//                 (Validates Requirements 10.1, 10.2)
//   - Property 4: composeScene non-degenerate bounding box
//                 (Validates Requirements 9.7)
//
// Iterations: ≥ 100 per property (project standard / fast-check default).
// `composeScene` is pure — no DOM, no signals, no I/O — so the tests need
// only generate `Scene` values and pin universal laws on the output.
//
// @see web/src/composer/compose.ts
// @see .kiro/specs/unified-composer-canvas/design.md §"Correctness Properties"

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { composeScene } from './compose';
import { SCALE_MIN } from './gestures';
import type { Item, ItemId, Scene, Transform } from './types';
import type { Point, Polyline } from '../types';

const NUM_RUNS = { numRuns: 100 } as const;

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/**
 * Finite scene-unit coordinates over a wide-enough range to exercise both
 * sign branches of the affine math. `+ 0` canonicalises any `-0` to `+0` so
 * structural equality (`toEqual`) is not tripped by signed-zero artifacts of
 * floating-point arithmetic — the SceneStore mutators commit transforms via
 * arithmetic that produces canonical zeros, matching what production sees.
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

/**
 * Polyline of ≥ 2 points — matches the SceneStore-committed shape and the
 * subset that `composeScene` actually retains (single-point polylines are
 * pruned defensively, see compose.ts). Sticking to ≥ 2 keeps the test
 * focused on the retained-polyline algebra; the skip path is a defensive
 * implementation detail covered by the unit tests.
 */
const arbPolyline: fc.Arbitrary<Polyline> = fc.array(arbPoint, {
    minLength: 2,
    maxLength: 6,
});

const arbContent: fc.Arbitrary<Polyline[]> = fc.array(arbPolyline, {
    minLength: 1,
    maxLength: 3,
});

/**
 * Signed scale magnitudes well above SCALE_MIN so the affine is always
 * well-conditioned for these tests. The property statements quantify over
 * `|sx|, |sy| > SCALE_MIN`; the SceneStore additionally clamps via
 * `clampScale`, so this generator stays in the production-realistic range.
 */
const arbSignedScale = fc
    .tuple(
        fc.double({
            min: 0.01,
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
            max: Math.PI * 2 - 1e-9,
            noNaN: true,
            noDefaultInfinity: true,
        })
        .map((v) => v + 0),
});

const arbItemId: fc.Arbitrary<ItemId> = fc.string({
    minLength: 1,
    maxLength: 16,
});

const arbImageItem = (content: fc.Arbitrary<Polyline[]>): fc.Arbitrary<Item> =>
    fc.record({
        id: arbItemId,
        kind: fc.constant('image' as const),
        transform: arbTransform,
        content,
        source: fc.record({
            filename: fc.string({ minLength: 1, maxLength: 32 }),
            sizeBytes: fc.integer({ min: 0, max: 10_000_000 }),
        }),
    });

const arbTextItem = (content: fc.Arbitrary<Polyline[]>): fc.Arbitrary<Item> =>
    fc.record({
        id: arbItemId,
        kind: fc.constant('text' as const),
        transform: arbTransform,
        content,
        source: fc.record({
            text: fc.string({ minLength: 0, maxLength: 32 }),
            fontName: fc.string({ minLength: 1, maxLength: 16 }),
            fontSizeMm: fc.double({
                min: 1,
                max: 100,
                noNaN: true,
                noDefaultInfinity: true,
            }),
            letterSpacingPct: fc
                .double({
                    min: 0,
                    max: 50,
                    noNaN: true,
                    noDefaultInfinity: true,
                })
                .map((v) => v + 0),
        }),
    });

const arbFreehandItem = (
    content: fc.Arbitrary<Polyline[]>,
): fc.Arbitrary<Item> =>
    fc.record({
        id: arbItemId,
        kind: fc.constant('freehand' as const),
        transform: arbTransform,
        content,
        source: fc.record({
            capturedAtMs: fc.integer({ min: 0, max: 10_000_000_000 }),
        }),
    });

const arbItem: fc.Arbitrary<Item> = fc.oneof(
    arbImageItem(arbContent),
    arbTextItem(arbContent),
    arbFreehandItem(arbContent),
);

/**
 * General Scene generator: 0..5 mixed-kind items, each with arbitrary
 * non-degenerate-length polylines (≥ 2 points). `selectedId` is left null
 * here — `composeScene` does not depend on it.
 */
const arbScene: fc.Arbitrary<Scene> = fc
    .array(arbItem, { minLength: 0, maxLength: 5 })
    .map((items) => ({
        schemaVersion: 1 as const,
        items,
        selectedId: null as ItemId | null,
    }));

/**
 * Non-degenerate item content: every item's first polyline is a
 * non-collinear triangle (three points spanning both X and Y in local
 * frame). Combined with `|sx|, |sy| > SCALE_MIN`, the linear part of the
 * affine has `|det| ≥ SCALE_MIN²` so the transformed triangle preserves a
 * positive area, which forces the axis-aligned bounding box to have both
 * width > 0 AND height > 0 — independent of rotation. This matches the
 * "≥ 2 distinct content points" precondition of Property 4 (we generate
 * three non-collinear points, which is the strongest reading of "distinct"
 * and the one that makes the property a theorem under any rotation).
 */
const arbNonDegenerateContent: fc.Arbitrary<Polyline[]> = fc
    .tuple(
        arbCoord,
        arbCoord,
        fc.double({
            min: 0.5,
            max: 50,
            noNaN: true,
            noDefaultInfinity: true,
        }),
        fc.array(arbPolyline, { minLength: 0, maxLength: 2 }),
    )
    .map(([cx, cy, size, extras]) => {
        const triangle: Polyline = [
            { x: cx, y: cy },
            { x: cx + size, y: cy },
            { x: cx, y: cy + size },
        ];
        return [triangle, ...extras];
    });

const arbNonDegenerateItem: fc.Arbitrary<Item> = fc.oneof(
    arbImageItem(arbNonDegenerateContent),
    arbTextItem(arbNonDegenerateContent),
    arbFreehandItem(arbNonDegenerateContent),
);

/**
 * Non-empty Scene whose every item satisfies the Property 4 precondition.
 * Scale magnitudes inherited from `arbTransform` (≥ 0.01 ≫ SCALE_MIN).
 */
const arbNonDegenerateScene: fc.Arbitrary<Scene> = fc
    .array(arbNonDegenerateItem, { minLength: 1, maxLength: 5 })
    .map((items) => ({
        schemaVersion: 1 as const,
        items,
        selectedId: null as ItemId | null,
    }));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Relative-or-absolute float closeness. `composeScene` uses the exact same
 * arithmetic order as the closed-form expected value below, so in practice
 * the two agree bit-for-bit; the small tolerance is a forward-compatibility
 * cushion for any future re-association of the multiply / add chain.
 */
function approxEqual(
    a: number,
    b: number,
    relTol = 1e-12,
    absTol = 1e-9,
): boolean {
    return (
        Math.abs(a - b)
        <= Math.max(absTol, relTol * Math.max(Math.abs(a), Math.abs(b)))
    );
}

// -----------------------------------------------------------------------------
// Property 1: composeScene Z-order
// -----------------------------------------------------------------------------

describe('compose.ts — Property 1 (composeScene Z-order)', () => {
    /**
     * **Validates: Requirements 1.2, 1.3, 1.4, 9.1, 9.3**
     *
     * For any Scene, `composeScene(scene)` is the per-item concatenation of
     * `applyTransformToPolyline(item.transform, p)` over every retained
     * polyline `p` (length ≥ 2) of every item, taken in ascending `items`
     * index order. As a consequence: for any pair `i < j`, every polyline
     * contributed by `items[i]` appears at a strictly lower index in the
     * output than every polyline contributed by `items[j]`.
     */
    // Feature: unified-composer-canvas, Property 1: composeScene Z-order
    it('output is the per-item concatenation in ascending index order; for i < j, every polyline from items[i] precedes every polyline from items[j]', () => {
        fc.assert(
            fc.property(arbScene, (scene) => {
                const out = composeScene(scene);

                // Independent computation of the per-item index ranges in
                // `out`. We count *retained* polylines (length ≥ 2) per item;
                // this matches composeScene's pruning rule.
                const ranges: Array<{
                    start: number;
                    end: number;
                    itemIdx: number;
                }> = [];
                let cursor = 0;
                for (let i = 0; i < scene.items.length; i++) {
                    const retained = scene.items[i]!.content.filter(
                        (p) => p.length >= 2,
                    );
                    ranges.push({
                        start: cursor,
                        end: cursor + retained.length,
                        itemIdx: i,
                    });
                    cursor += retained.length;
                }

                // Total length: sum of retained polyline counts.
                expect(out).toHaveLength(cursor);

                // Z-order invariant: for any pair i < j, items[i]'s output
                // range ends at-or-before items[j]'s output range begins.
                for (let i = 0; i < ranges.length; i++) {
                    for (let j = i + 1; j < ranges.length; j++) {
                        expect(ranges[i]!.end).toBeLessThanOrEqual(
                            ranges[j]!.start,
                        );
                    }
                }

                // Per-position structural check: each output polyline at
                // offset `range.start + k` corresponds to the item's k-th
                // retained polyline at the same length. (Affine correctness
                // is Property 2; here we only pin shape and ordering.)
                for (const range of ranges) {
                    const retained = scene.items[range.itemIdx]!.content.filter(
                        (p) => p.length >= 2,
                    );
                    for (let k = 0; k < retained.length; k++) {
                        const outPoly = out[range.start + k]!;
                        expect(outPoly).toHaveLength(retained[k]!.length);
                    }
                }
            }),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 2: composeScene affine correctness
// -----------------------------------------------------------------------------

describe('compose.ts — Property 2 (composeScene affine correctness)', () => {
    /**
     * **Validates: Requirements 1.3, 9.2**
     *
     * For any item with `transform = (x, y, sx, sy, θ)` and any local-frame
     * point `p`, the corresponding output point equals the closed-form
     * affine
     *
     *     out.x = cos(θ)·sx·p.x − sin(θ)·sy·p.y + x
     *     out.y = sin(θ)·sx·p.x + cos(θ)·sy·p.y + y
     *
     * within IEEE-754 round-off bounds. The reference here uses the same
     * arithmetic order as `compose.ts`, so the comparison is effectively
     * bit-identical; the tolerance is a small forward-compatibility cushion.
     */
    // Feature: unified-composer-canvas, Property 2: composeScene affine correctness
    it('each output point equals R(θ)·S(sx,sy)·p + (x,y) within IEEE-754 round-off', () => {
        fc.assert(
            fc.property(arbScene, (scene) => {
                const out = composeScene(scene);

                // Walk the Scene in the same order composeScene does, but
                // recompute the expected (x, y) independently of whichever
                // loop the implementation chose.
                let cursor = 0;
                for (let i = 0; i < scene.items.length; i++) {
                    const item = scene.items[i]!;
                    const { x, y, sx, sy, rotationRad } = item.transform;
                    const cos = Math.cos(rotationRad);
                    const sin = Math.sin(rotationRad);
                    for (const poly of item.content) {
                        if (poly.length < 2) continue;
                        const outPoly = out[cursor++]!;
                        expect(outPoly).toHaveLength(poly.length);
                        for (let k = 0; k < poly.length; k++) {
                            const p = poly[k]!;
                            const ex =
                                cos * sx * p.x - sin * sy * p.y + x;
                            const ey =
                                sin * sx * p.x + cos * sy * p.y + y;
                            expect(approxEqual(outPoly[k]!.x, ex)).toBe(true);
                            expect(approxEqual(outPoly[k]!.y, ey)).toBe(true);
                        }
                    }
                }
                expect(out).toHaveLength(cursor);
            }),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 3: composeScene determinism and purity
// -----------------------------------------------------------------------------

describe('compose.ts — Property 3 (composeScene determinism and purity)', () => {
    /**
     * **Validates: Requirements 10.1, 10.2**
     *
     * Three sub-claims, all on the same arbitrary Scene:
     *
     *   - PURITY:        the input Scene is not mutated by `composeScene`.
     *   - DETERMINISM:   a structurally-equal but distinct Scene (deep clone
     *                    via JSON round-trip) produces a structurally-equal
     *                    output.
     *   - NO INTERNAL STATE: a second call on the same reference also
     *                    returns a structurally-equal output (so successive
     *                    calls cannot drift due to hidden caches or globals).
     *
     * The `JSON.stringify` snapshot is the simplest input-mutation detector
     * for a fully JSON-serialisable Scene shape (Req 10.3) and is robust to
     * any in-place edit a buggy implementation could perform on items,
     * transforms, or polylines.
     */
    // Feature: unified-composer-canvas, Property 3: composeScene determinism and purity
    it('structurally equal Scenes produce structurally equal outputs; the input is not mutated', () => {
        fc.assert(
            fc.property(arbScene, (scene) => {
                // PURITY: snapshot the input via JSON, run composeScene,
                // assert the snapshot is unchanged.
                const snapshotBefore = JSON.stringify(scene);
                const out1 = composeScene(scene);
                const snapshotAfter = JSON.stringify(scene);
                expect(snapshotAfter).toBe(snapshotBefore);

                // DETERMINISM: a structurally-equal clone produces a
                // structurally-equal output.
                const cloned: Scene = JSON.parse(snapshotBefore);
                const out2 = composeScene(cloned);
                expect(out2).toEqual(out1);

                // NO INTERNAL STATE: a second call on the same reference
                // also returns a structurally-equal output.
                const out3 = composeScene(scene);
                expect(out3).toEqual(out1);
            }),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 4: composeScene non-degenerate bounding box
// -----------------------------------------------------------------------------

describe('compose.ts — Property 4 (composeScene non-degenerate bounding box)', () => {
    /**
     * **Validates: Requirements 9.7**
     *
     * When every item has ≥ 2 distinct content points (here: a non-collinear
     * triangle in local frame, the strongest reading of "distinct" that
     * survives any rotation) and `|sx|, |sy| > SCALE_MIN`, the bounding box
     * of `composeScene(scene)` has `width > 0` AND `height > 0`.
     *
     * Why a triangle and not just two distinct points: two points on a
     * single local-frame line can collapse to a width-zero (or height-zero)
     * axis-aligned bounding box under exactly the rotation that aligns the
     * line with a coordinate axis. Three non-collinear points have
     * non-zero area, and any non-degenerate affine (`|sx|·|sy| > 0`)
     * preserves that — the transformed bbox of a non-zero-area shape always
     * has both width > 0 AND height > 0.
     */
    // Feature: unified-composer-canvas, Property 4: composeScene non-degenerate bounding box
    it('when every item has ≥ 2 distinct content points and |sx|,|sy| > SCALE_MIN, the composed bounding box has width > 0 AND height > 0', () => {
        // Sanity: the strict-scale constraint actually exceeds SCALE_MIN.
        expect(SCALE_MIN).toBeLessThan(0.01);

        fc.assert(
            fc.property(arbNonDegenerateScene, (scene) => {
                const out = composeScene(scene);
                expect(out.length).toBeGreaterThan(0);

                let minX = Number.POSITIVE_INFINITY;
                let minY = Number.POSITIVE_INFINITY;
                let maxX = Number.NEGATIVE_INFINITY;
                let maxY = Number.NEGATIVE_INFINITY;
                for (const poly of out) {
                    for (const p of poly) {
                        if (p.x < minX) minX = p.x;
                        if (p.x > maxX) maxX = p.x;
                        if (p.y < minY) minY = p.y;
                        if (p.y > maxY) maxY = p.y;
                    }
                }
                expect(maxX - minX).toBeGreaterThan(0);
                expect(maxY - minY).toBeGreaterThan(0);
            }),
            NUM_RUNS,
        );
    });
});
