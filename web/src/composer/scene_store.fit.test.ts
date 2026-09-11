// Feature: unified-composer-canvas — regression test for envelope-aware
// initial transform on `addItem`.
//
// Background (post-implementation regression): the SPA was reported as
// rendering imported images as "chaotic zigzag lines extending way beyond
// the dashed envelope rectangle". The cause is that imported images arrive
// with raw pixel-space coordinates (e.g. a 1000×1000 bbox) but the scene
// envelope is much smaller (≈ 152×105 mm). With the prior identity-only
// `addItem` placement, the transformed bbox dwarfed the envelope.
//
// Fix: when the SceneStore is constructed with an `envelopeMm` option,
// `addItem` computes a default Transform that centres the new item's
// content bounding box on the envelope and uniformly scales it to fit
// within ~70% of the corresponding envelope dimension. Tests that omit the
// option (the existing property tests, by design) keep the identity
// behaviour, so the prior contract is preserved.
//
// This file pins the new behaviour on a representative shape — a 1000×1000
// pixel-bbox image item added to a 152×105 mm envelope should be fully
// inside the envelope after `addItem`, with its transformed bbox centred.
//
// @see web/src/composer/scene_store.ts
// @see .kiro/specs/unified-composer-canvas/design.md §"Components and Interfaces" #3

import { describe, it, expect } from 'vitest';

import { createSceneStore } from './scene_store';
import { itemBoundingBox } from './compose';
import type { ScenePersistence } from './persistence';
import type { Scene } from './types';

function makeMemoryPersistence(initial: Scene | null = null): ScenePersistence {
    let stored: Scene | null = initial;
    return {
        load() {
            return stored;
        },
        save(scene: Scene) {
            stored = scene;
        },
        clear() {
            stored = null;
        },
    };
}

describe('scene_store — envelope-aware initial transform on addItem', () => {
    it('an item with a 1000×1000 bbox added to a 152×105 envelope ends up scaled and centred so its transformed bbox fits inside the envelope', () => {
        const envelopeMm = { w: 152, h: 105 };
        const store = createSceneStore({
            persistence: makeMemoryPersistence(),
            envelopeMm,
        });

        // Synthetic image-like item: a 1000×1000 pixel-space rectangle.
        const id = store.addItem({
            kind: 'image',
            content: [
                [
                    { x: 0, y: 0 },
                    { x: 1000, y: 0 },
                    { x: 1000, y: 1000 },
                    { x: 0, y: 1000 },
                    { x: 0, y: 0 },
                ],
            ],
            source: { filename: 'huge.png', sizeBytes: 1 },
        });

        const item = store.scene.value.items.find((it) => it.id === id);
        expect(item).toBeDefined();
        const bbox = itemBoundingBox(item!);

        // (1) the transformed bbox is fully inside the envelope.
        expect(bbox.minX).toBeGreaterThanOrEqual(0);
        expect(bbox.minY).toBeGreaterThanOrEqual(0);
        expect(bbox.maxX).toBeLessThanOrEqual(envelopeMm.w);
        expect(bbox.maxY).toBeLessThanOrEqual(envelopeMm.h);

        // (2) the transformed bbox is centred on the envelope (within
        //     IEEE-754 round-off; the helper centres exactly).
        const cx = (bbox.minX + bbox.maxX) / 2;
        const cy = (bbox.minY + bbox.maxY) / 2;
        expect(cx).toBeCloseTo(envelopeMm.w / 2, 6);
        expect(cy).toBeCloseTo(envelopeMm.h / 2, 6);

        // (3) the longer side fits within ~70% of the matching envelope
        //     dimension. The content is square (1000×1000), so the
        //     constraint is the shorter envelope axis (105 mm). The
        //     transformed side length should be 0.7 × 105 = 73.5 mm.
        const widthMm = bbox.maxX - bbox.minX;
        const heightMm = bbox.maxY - bbox.minY;
        expect(widthMm).toBeCloseTo(0.7 * envelopeMm.h, 6);
        expect(heightMm).toBeCloseTo(0.7 * envelopeMm.h, 6);
    });

    it('without an envelope option the initial transform is identity (preserves existing test contract)', () => {
        const store = createSceneStore({
            persistence: makeMemoryPersistence(),
        });

        const id = store.addItem({
            kind: 'image',
            content: [
                [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 10, y: 10 },
                ],
            ],
            source: { filename: 'small.png', sizeBytes: 1 },
        });

        const item = store.scene.value.items.find((it) => it.id === id)!;
        expect(item.transform).toEqual({
            x: 0,
            y: 0,
            sx: 1,
            sy: 1,
            rotationRad: 0,
        });
    });

    it('degenerate content (empty / zero-extent) falls back to identity', () => {
        const envelopeMm = { w: 152, h: 105 };
        const store = createSceneStore({
            persistence: makeMemoryPersistence(),
            envelopeMm,
        });

        // Single-point polyline: no extent on either axis.
        const id = store.addItem({
            kind: 'freehand',
            content: [
                [
                    { x: 0, y: 0 },
                    { x: 0, y: 0 },
                ],
            ],
            source: { capturedAtMs: 0 },
        });

        const item = store.scene.value.items.find((it) => it.id === id)!;
        expect(item.transform).toEqual({
            x: 0,
            y: 0,
            sx: 1,
            sy: 1,
            rotationRad: 0,
        });
    });
});
