/**
 * `image_source_cache` — session-scoped store mapping `ItemId` → original
 * `File` for image items, so the user can re-open the import modal on an
 * existing image item and re-vectorise it with different settings.
 *
 * Why this exists. Before the unified-composer-canvas refactor the
 * `ImagePanel` lived inline in the side rail with all of its tuning knobs
 * (mode / contrast / shading detail) always visible, so changing a knob
 * re-traced the same in-memory `File` automatically. Now the panel is
 * hidden inside a one-shot modal and the resulting `Image_Item` only
 * persists the polylines plus filename / sizeBytes — there is no
 * persisted handle to the original bytes, so a user who wants to "tweak
 * the image until it looks right" was stuck.
 *
 * Trade-off. We deliberately do NOT add a `file: File` field to
 * `Image_Item.source`: that would break the persisted Scene shape (a
 * `File` is not JSON-serialisable; persistence asserts items are plain
 * data). Instead we keep the `File` reference in this side store, scoped
 * to the current page session. On reload the cache is empty; the
 * polylines still load from the SceneStore so the drawing is intact, and
 * the user just can't re-edit settings without re-importing.
 *
 * This module is intentionally tiny: a module-singleton `Map`, three
 * pure helpers (`set` / `get` / `delete`). No reactivity, no imports
 * beyond the `ItemId` type — the cache is read at modal-open time only.
 *
 * @see web/src/ui/composer/AddItemMenu.tsx (writes on commit, reads on edit)
 * @see web/src/ui/composer/ItemsListPanel.tsx (per-row "edit" trigger)
 * @see web/src/composer/scene_store.ts (`replaceContent` mutator)
 */

import type { ItemId } from './types';

/**
 * Module-singleton mapping. Exported only so dedicated tests may reset it
 * between cases; production code should always go through the helpers
 * below for symmetry.
 */
export const imageSourceCache = new Map<ItemId, File>();

/**
 * Record the original `File` that produced an image item. Called from
 * `AddItemMenu` immediately after `store.addItem` returns the new id so
 * the cache write happens in the same tick as the item creation.
 */
export function setImageFile(id: ItemId, file: File): void {
    imageSourceCache.set(id, file);
}

/**
 * Look up the cached `File` for an image item, or `undefined` when the
 * cache has no entry (fresh page reload, or the item was created before
 * this cache existed).
 */
export function getImageFile(id: ItemId): File | undefined {
    return imageSourceCache.get(id);
}

/**
 * Drop the cache entry for an item. Called from the per-item delete path
 * so removed items do not leak `File` references for the lifetime of the
 * tab. A no-op when no entry exists.
 */
export function deleteImageFile(id: ItemId): void {
    imageSourceCache.delete(id);
}
