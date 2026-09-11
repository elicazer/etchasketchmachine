// Feature: unified-composer-canvas — Composer pipeline smoke tests.
//
// For each fixture Scene (image-only, text-only, freehand-only, and a mixed
// three-item scene with non-identity transforms) this file:
//
//   1. Builds the Scene via `createSceneStore` + `addItem` and (for the mixed
//      fixture) `updateTransform`, with an in-memory `ScenePersistence`
//      stand-in so no global `localStorage` traffic occurs.
//   2. Asserts that `composeScene(scene)` returns a `Polyline[]` whose
//      polyline count equals the sum of valid (≥ 2 point) content polylines
//      across items — composition transforms each polyline but never drops
//      one (Req 9.6).
//   3. Asserts that the bounding box of the composed output matches the
//      union of `itemBoundingBox(item)` over every item in the Scene — the
//      composed geometry "lands where the transforms predict" (Req 9.6,
//      13.1).
//   4. Pipes the composed polylines through `fitPolylinesToEnvelope`
//      (`web/src/path/scale.ts`) and `PathPlanner.plan`
//      (`web/src/path/planner.ts`), exactly like the App's Send handler
//      drives the controller — `flipY: true` and a fixed step envelope.
//   5. Pins the planner output by the REAL `totalStepCount` Chebyshev metric
//      (Req 13.1) — never by vertex count — and asserts at least one stroke
//      segment exists in the planned path (Req 9.6).
//
// _Requirements: 9.6, 13.1_
//
// @see web/src/composer/scene_store.ts
// @see web/src/composer/compose.ts
// @see web/src/path/scale.ts
// @see web/src/path/planner.ts
// @see web/src/ui/App.tsx (the Send handler whose pipeline this test mirrors)

import { describe, expect, it } from 'vitest';

import {
    createSceneStore,
    type AddItemSpec,
    type SceneStore,
} from './scene_store';
import { itemBoundingBox } from './compose';
import type { ScenePersistence } from './persistence';
import type { Scene } from './types';
import { PathPlanner, totalStepCount } from '../path/planner';
import { fitPolylinesToEnvelope } from '../path/scale';
import type { Polyline } from '../types';

// -----------------------------------------------------------------------------
// Test fixtures and helpers
// -----------------------------------------------------------------------------

/**
 * A representative measured Step_Envelope. Reflects the order of magnitude
 * the firmware DEFAULT_ENVELOPE delivers (~2 158 × 1 650 steps) but rounded
 * to a clean rectangle so the per-fixture step counts are easy to reason
 * about.
 */
const ENVELOPE_STEPS = { x: 20_000, y: 16_000 } as const;

/** Fresh in-memory `ScenePersistence` per fixture (no `localStorage` traffic). */
function makeMemoryPersistence(initial: Scene | null = null): ScenePersistence {
    let stored: Scene | null = initial;
    return {
        load(): Scene | null {
            return stored;
        },
        save(s: Scene): void {
            stored = s;
        },
        clear(): void {
            stored = null;
        },
    };
}

function makeStore(): SceneStore {
    return createSceneStore({ persistence: makeMemoryPersistence() });
}

/** A closed unit square. Five points, four edges — survives RDP intact. */
function buildSquare(side: number): Polyline {
    return [
        { x: 0, y: 0 },
        { x: side, y: 0 },
        { x: side, y: side },
        { x: 0, y: side },
        { x: 0, y: 0 },
    ];
}

function imageSpec(content: Polyline[], filename = 'fixture.png'): AddItemSpec {
    return {
        kind: 'image',
        content,
        source: { filename, sizeBytes: 4_096 },
    };
}

function textSpec(content: Polyline[], text = 'hi'): AddItemSpec {
    return {
        kind: 'text',
        content,
        source: {
            text,
            fontName: 'sans',
            fontSizeMm: 10,
            letterSpacingPct: 0,
        },
    };
}

function freehandSpec(content: Polyline[]): AddItemSpec {
    return {
        kind: 'freehand',
        content,
        source: { capturedAtMs: 0 },
    };
}

/** Number of valid (≥ 2 point) polylines across every item in the Scene. */
function totalContentPolylines(scene: Scene): number {
    let n = 0;
    for (const item of scene.items) {
        for (const poly of item.content) {
            if (poly.length >= 2) n++;
        }
    }
    return n;
}

/** Number of segments in the plan whose `kind === 'stroke'`. */
function strokeSegmentCount(plan: ReturnType<PathPlanner['plan']>): number {
    let n = 0;
    for (const seg of plan.segments) {
        if (seg.kind === 'stroke') n++;
    }
    return n;
}

interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

function bboxOfPolylines(polylines: Polyline[]): BBox | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    for (const poly of polylines) {
        if (poly.length < 2) continue;
        for (const p of poly) {
            any = true;
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    if (!any) return null;
    return { minX, minY, maxX, maxY };
}

function unionItemBoxes(scene: Scene): BBox | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    for (const item of scene.items) {
        const hasContent = item.content.some((poly) => poly.length >= 2);
        if (!hasContent) continue;
        const b = itemBoundingBox(item);
        any = true;
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
    }
    if (!any) return null;
    return { minX, minY, maxX, maxY };
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function buildImageOnlyScene(): SceneStore {
    const store = makeStore();
    store.addItem(imageSpec([buildSquare(20)]));
    return store;
}

function buildTextOnlyScene(): SceneStore {
    const store = makeStore();
    store.addItem(
        textSpec(
            [
                [
                    { x: 0, y: 0 },
                    { x: 30, y: 0 },
                    { x: 30, y: 10 },
                    { x: 0, y: 10 },
                    { x: 0, y: 0 },
                ],
                [
                    { x: 0, y: 5 },
                    { x: 30, y: 5 },
                ],
            ],
            'hello',
        ),
    );
    return store;
}

function buildFreehandOnlyScene(): SceneStore {
    const store = makeStore();
    const trace: Polyline = new Array(51);
    for (let i = 0; i <= 50; i++) {
        trace[i] = { x: i, y: Math.sin(i / 5) * 5 };
    }
    store.addItem(freehandSpec([trace]));
    return store;
}

/**
 * Three items with deliberately non-identity transforms exercising
 * translate + scale, translate + rotate, and translate + scale + rotate
 * paths through `composeScene`.
 */
function buildMixedScene(): SceneStore {
    const store = makeStore();

    const imgId = store.addItem(imageSpec([buildSquare(20)], 'mixed-image.png'));
    store.updateTransform(imgId, { x: 50, y: 30, sx: 2, sy: 2 });

    const txtId = store.addItem(
        textSpec(
            [
                [
                    { x: 0, y: 0 },
                    { x: 30, y: 0 },
                    { x: 30, y: 10 },
                    { x: 0, y: 10 },
                    { x: 0, y: 0 },
                ],
            ],
            'mixed-text',
        ),
    );
    store.updateTransform(txtId, { x: -10, y: 5, rotationRad: Math.PI / 4 });

    const fhId = store.addItem(
        freehandSpec([
            [
                { x: 0, y: 0 },
                { x: 10, y: 5 },
                { x: 20, y: 0 },
                { x: 30, y: 5 },
                { x: 40, y: 0 },
            ],
        ]),
    );
    store.updateTransform(fhId, {
        x: 0,
        y: -20,
        sx: 1.5,
        sy: 0.5,
        rotationRad: Math.PI / 6,
    });

    return store;
}

// -----------------------------------------------------------------------------
// Pipeline driver — mirrors the App's Send handler
// -----------------------------------------------------------------------------

const planner = new PathPlanner();

interface PipelineResult {
    composed: Polyline[];
    fitted: { x: number; y: number }[][];
    plan: ReturnType<PathPlanner['plan']>;
}

function runPipeline(store: SceneStore): PipelineResult {
    // Same access path the App's Send handler takes:
    //   `store.composed.value` → `controller.setPolylines(..., { flipY: true })`
    //   → internally `planner.plan({ polylines }, { envelopeSteps, flipY })`
    // which itself runs `fitPolylinesToEnvelope`. We additionally call
    // `fitPolylinesToEnvelope` here so the test can assert directly on the
    // fit step's polyline-count preservation, exactly like the conceptual
    // pipeline described in the spec.
    const composed = store.composed.value;
    const fitted = fitPolylinesToEnvelope(composed, ENVELOPE_STEPS, {
        flipY: true,
    });
    const plan = planner.plan(
        { polylines: composed },
        {
            envelopeSteps: ENVELOPE_STEPS,
            flipY: true,
            fillFraction: 1.0,
        },
    );
    return { composed, fitted, plan };
}

// -----------------------------------------------------------------------------
// Per-fixture assertion battery
// -----------------------------------------------------------------------------

function assertFixturePipeline(
    label: string,
    store: SceneStore,
    expectedItems: number,
): void {
    const scene = store.scene.value;
    expect(scene.items.length, `${label}: scene item count`).toBe(expectedItems);

    const expectedPolyCount = totalContentPolylines(scene);
    expect(
        expectedPolyCount,
        `${label}: fixture must contribute ≥ 1 valid polyline`,
    ).toBeGreaterThan(0);

    const { composed, fitted, plan } = runPipeline(store);

    // (1) `composeScene(scene)` returns a Polyline[].
    expect(Array.isArray(composed), `${label}: composed is array`).toBe(true);

    // (2) Polyline counts are preserved through composition — every valid
    //     content polyline becomes exactly one composed polyline.
    expect(
        composed.length,
        `${label}: composed polyline count matches valid input polylines`,
    ).toBe(expectedPolyCount);
    for (const poly of composed) {
        expect(
            poly.length,
            `${label}: every composed polyline has ≥ 2 points`,
        ).toBeGreaterThanOrEqual(2);
    }

    // (3) Bounding boxes of the composed output match the per-item transform
    //     predictions — composeScene and itemBoundingBox share the same
    //     affine math, so the union of item bboxes == bbox of composed.
    const composedBox = bboxOfPolylines(composed);
    const predictedBox = unionItemBoxes(scene);
    expect(composedBox, `${label}: composed bbox is non-empty`).not.toBeNull();
    expect(predictedBox, `${label}: predicted bbox is non-empty`).not.toBeNull();
    if (composedBox && predictedBox) {
        expect(composedBox.minX).toBeCloseTo(predictedBox.minX, 6);
        expect(composedBox.minY).toBeCloseTo(predictedBox.minY, 6);
        expect(composedBox.maxX).toBeCloseTo(predictedBox.maxX, 6);
        expect(composedBox.maxY).toBeCloseTo(predictedBox.maxY, 6);
    }

    // (4) `fitPolylinesToEnvelope` preserves polyline count: every composed
    //     polyline maps to exactly one fitted polyline.
    expect(
        fitted.length,
        `${label}: fitPolylinesToEnvelope preserves polyline count`,
    ).toBe(composed.length);
    for (const poly of fitted) {
        for (const p of poly) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(ENVELOPE_STEPS.x);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(ENVELOPE_STEPS.y);
        }
    }

    // (5) Planner output: real Chebyshev step count is the only cost metric
    //     used (Req 13.1). A non-empty plan must have a non-zero step count
    //     and at least one stroke segment for the user-content motion.
    const stepCount = totalStepCount(plan);
    expect(
        stepCount,
        `${label}: totalStepCount(plan) > 0 (Chebyshev metric, never vertex count)`,
    ).toBeGreaterThan(0);
    expect(
        strokeSegmentCount(plan),
        `${label}: plan has ≥ 1 stroke segment`,
    ).toBeGreaterThanOrEqual(1);
    expect(
        plan.drawableSteps,
        `${label}: drawableSteps reflects supplied envelope`,
    ).toEqual({ w: ENVELOPE_STEPS.x, h: ENVELOPE_STEPS.y });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('Composer → planner pipeline smoke (Req 9.6, 13.1)', () => {
    it('image-only scene composes and plans into a non-empty path', () => {
        assertFixturePipeline('image-only', buildImageOnlyScene(), 1);
    });

    it('text-only scene composes and plans into a non-empty path', () => {
        assertFixturePipeline('text-only', buildTextOnlyScene(), 1);
    });

    it('freehand-only scene composes and plans into a non-empty path', () => {
        assertFixturePipeline('freehand-only', buildFreehandOnlyScene(), 1);
    });

    it('mixed three-item scene with non-identity transforms composes and plans correctly', () => {
        assertFixturePipeline('mixed', buildMixedScene(), 3);
    });
});
