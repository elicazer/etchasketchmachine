/**
 * Focused regression test for `SceneStore.replaceContent`.
 *
 * `replaceContent` is the post-commit "re-vectorize" path: when a user
 * re-opens the Add-image modal on an existing image item to try a
 * different tracing mode / contrast / shading detail, the resulting
 * polylines land here instead of `addItem`. The test pins the three
 * properties the rest of the UI relies on:
 *
 *   1. The item's id, transform, and source metadata are preserved —
 *      `replaceContent` swaps only `content`. The placement the user
 *      established before the re-edit must survive (Req: image edit flow
 *      regression fix).
 *   2. The new `content` is the array passed in; the old polylines are
 *      gone from the live Scene.
 *   3. The mutation is a single history entry: `canUndo` flips to true
 *      and `undo()` restores the prior content.
 *
 * @see web/src/composer/scene_store.ts (`replaceContent` mutator)
 * @see web/src/ui/composer/AddItemMenu.tsx (calls `replaceContent` on
 *      commit when re-opened in edit mode)
 */

import { describe, it, expect } from 'vitest';

import { createSceneStore } from './scene_store';
import type { ScenePersistence } from './persistence';
import type { Scene } from './types';
import type { Polyline } from '../types';

function makeMemoryPersistence(): ScenePersistence {
    let stored: Scene | null = null;
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

const ORIGINAL: Polyline[] = [
    [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
    ],
];

const REPLACEMENT: Polyline[] = [
    [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
    ],
    [
        { x: 20, y: 20 },
        { x: 25, y: 25 },
    ],
];

describe('scene_store — replaceContent', () => {
    it('swaps content while preserving id, transform, and source; is undoable', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });

        const id = store.addItem({
            kind: 'image',
            content: ORIGINAL,
            source: { filename: 'logo.png', sizeBytes: 4321 },
        });

        // Move the item so we can verify the transform survives the swap.
        // (`updateTransform` clamps and normalises; the resulting transform
        // is the canonical fact the test asserts against.)
        store.updateTransform(id, { x: 12.5, y: 7.25, sx: 1.5, sy: 1.5, rotationRad: 1.0 });

        const before = store.scene.value.items.find((it) => it.id === id);
        expect(before).toBeDefined();
        const transformBefore = before!.transform;
        const sourceBefore = (before as { source: { filename: string; sizeBytes: number } }).source;
        const contentBefore = before!.content;

        // Sanity: addItem started with the polylines we passed.
        expect(contentBefore).toEqual(ORIGINAL);

        // The replacement also re-trips canUndo, but for a clean assertion
        // confirm the post-replace state directly.
        store.replaceContent(id, REPLACEMENT);

        const after = store.scene.value.items.find((it) => it.id === id);
        expect(after).toBeDefined();

        // (1) id, transform, source are unchanged.
        expect(after!.id).toBe(id);
        expect(after!.transform).toEqual(transformBefore);
        expect(after!.kind).toBe('image');
        expect((after as { source: { filename: string; sizeBytes: number } }).source).toEqual(sourceBefore);

        // (2) content is the replacement.
        expect(after!.content).toBe(REPLACEMENT);
        expect(after!.content).not.toEqual(ORIGINAL);

        // (3) the mutation is undoable; undo restores the prior content
        // while still preserving id / transform / source (since those
        // didn't change in the prior history entry either).
        expect(store.canUndo.value).toBe(true);
        store.undo();
        const undone = store.scene.value.items.find((it) => it.id === id);
        expect(undone).toBeDefined();
        expect(undone!.content).toEqual(ORIGINAL);
        expect(undone!.transform).toEqual(transformBefore);
        expect((undone as { source: { filename: string; sizeBytes: number } }).source).toEqual(sourceBefore);
    });

    it('also swaps source when the optional third argument is supplied (text re-edit path), preserving id + transform in one undoable entry', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });

        const id = store.addItem({
            kind: 'text',
            content: ORIGINAL,
            source: {
                text: 'hello',
                fontName: 'sans',
                fontSizeMm: 10,
                letterSpacingPct: 0,
            },
        });
        store.updateTransform(id, { x: 3, y: 4, sx: 1.25, sy: 1.25 });
        const transformBefore = store.scene.value.items.find(
            (it) => it.id === id,
        )!.transform;

        const newSource = {
            text: 'world',
            fontName: 'serif',
            fontSizeMm: 14,
            letterSpacingPct: 5,
        };
        store.replaceContent(id, REPLACEMENT, newSource);

        const after = store.scene.value.items.find((it) => it.id === id)!;
        // id + transform preserved.
        expect(after.id).toBe(id);
        expect(after.transform).toEqual(transformBefore);
        // content + source both swapped.
        expect(after.content).toBe(REPLACEMENT);
        expect((after as { source: typeof newSource }).source).toEqual(
            newSource,
        );

        // Single undoable entry: undo restores BOTH the old content and the
        // old source.
        expect(store.canUndo.value).toBe(true);
        store.undo();
        const undone = store.scene.value.items.find((it) => it.id === id)!;
        expect(undone.content).toEqual(ORIGINAL);
        expect(
            (undone as { source: { text: string } }).source.text,
        ).toBe('hello');
    });

    it('is a no-op when the id does not match any item', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const id = store.addItem({
            kind: 'image',
            content: ORIGINAL,
            source: { filename: 'logo.png', sizeBytes: 1 },
        });
        const sceneBefore = store.scene.value;
        const canUndoBefore = store.canUndo.value;

        store.replaceContent('does-not-exist', REPLACEMENT);

        // No-op: identity-equal Scene reference, no new history entry.
        expect(store.scene.value).toBe(sceneBefore);
        expect(store.canUndo.value).toBe(canUndoBefore);
        // Original content still intact.
        const item = store.scene.value.items.find((it) => it.id === id);
        expect(item!.content).toEqual(ORIGINAL);
    });
});
