/**
 * `SceneStore` — the reactive single source of truth for the Composer.
 *
 * Wraps a `signal<Scene>` with:
 *
 *   - **Derived signals** for selection lookup, the composed flat
 *     `Polyline[]`, and undo/redo affordance flags.
 *   - **Mutators** that each commit at most one history entry: `addItem`,
 *     `removeItem`, `updateTransform`, `reorder`, `bringForward`,
 *     `sendBackward`, `select`, `clear`.
 *   - **Gesture lifecycle** that coalesces every mid-gesture
 *     `updateTransform` call into a single history entry committed on
 *     `endGesture`, with `cancelGesture` rolling back to the pre-gesture
 *     state without recording history (Req 15.4).
 *   - **Persistence on rest only**: a `@preact/signals` effect mirrors
 *     `scene.value` to disk via the injected `ScenePersistence`. While a
 *     gesture is in progress the write is suppressed; on `endGesture` the
 *     final post-gesture scene is persisted exactly once (Req 14.1).
 *   - **Bounded history**: `historyLimit` defaults to 50, with a hard
 *     minimum of 20 (Req 15.1).
 *
 * On every Transform commit the store applies `clampScale` and
 * `normaliseRotation` so the Transform invariants hold for every item at
 * every moment (Req 5.4, 6.2).
 *
 * The store has no dependency on `controller`, the planner, or any
 * rendering surface. `addItem` in particular MUST NOT call
 * `controller.setPolylines` — composition output is a pull on the
 * `composed` signal, not a push (Req 2.5, 11.3).
 *
 * @see .kiro/specs/unified-composer-canvas/design.md §"Components and Interfaces" #3
 * @see Requirements 1.1, 1.2, 1.4, 2.4, 2.5, 3.1, 3.2, 3.4, 3.6, 5.4, 6.2,
 *      7.1, 7.2, 7.3, 7.4, 11.2, 11.3, 11.4, 14.1, 14.5, 15.1, 15.2, 15.3,
 *      15.4, 15.5, 17.6, 17.10
 */

import {
    computed,
    effect,
    signal,
    type ReadonlySignal,
} from '@preact/signals';

import type { Polyline } from '../types';
import { composeScene } from './compose';
import { clampScale, normaliseRotation } from './gestures';
import {
    createLocalStoragePersistence,
    type ScenePersistence,
} from './persistence';
import {
    EMPTY_SCENE,
    makeIdentityTransform,
    type Freehand_Item,
    type Image_Item,
    type Item,
    type ItemId,
    type Scene,
    type Text_Item,
    type Transform,
} from './types';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface SceneStoreOptions {
    /**
     * Persistence adapter. Defaults to `createLocalStoragePersistence()`,
     * which auto-resolves the platform `localStorage`. Tests inject a
     * stand-in to control load/save behaviour.
     */
    persistence?: ScenePersistence;
    /**
     * Maximum history depth for undo/redo (Req 15.1). Defaults to 50.
     * Values below the project minimum (20) are clamped up so the store
     * always satisfies Req 15.1, regardless of misconfiguration.
     */
    historyLimit?: number;
    /**
     * Drawable envelope dimensions (in scene units; the same units the
     * `ComposerCanvas` uses for its `envelopeMm` viewBox). When supplied,
     * `addItem` computes a default Transform that centres the new item's
     * content bounding box on the envelope and uniformly scales it so the
     * longer side fits within ~70% of the corresponding envelope dimension.
     * This keeps imported geometry whose source coordinates dwarf the
     * envelope (e.g. a vectorised image at raw pixel scale) inside the
     * dashed envelope rectangle on first add. When omitted (the default,
     * matching tests that drive the store with synthetic content already
     * sized to the test envelope), `addItem` uses the identity Transform.
     */
    envelopeMm?: { w: number; h: number };
}

/**
 * Discriminated input for {@link SceneStore.addItem}. Each kind matches
 * the corresponding `Item` shape minus the auto-generated `id` and the
 * default `transform`, both of which the store fills in.
 */
export type AddItemSpec =
    | { kind: 'image'; content: Polyline[]; source: Image_Item['source'] }
    | { kind: 'text'; content: Polyline[]; source: Text_Item['source'] }
    | {
        kind: 'freehand';
        content: Polyline[];
        source: Freehand_Item['source'];
    };

/** The three gesture kinds the canvas surface can drive. */
export type GestureKind = 'move' | 'resize' | 'rotate';

/**
 * Reactive Composer state. UI surfaces subscribe to the read-only signals
 * and call mutators / gesture methods; the store is the only place where
 * `Scene` is allowed to be mutated.
 */
export interface SceneStore {
    /** Live Scene. Subscribers re-render reactively. */
    readonly scene: ReadonlySignal<Scene>;
    /** Currently-selected item, or `null` when nothing is selected. */
    readonly selectedItem: ReadonlySignal<Item | null>;
    /**
     * `composeScene(scene.value)`, memoised by `@preact/signals` so it is
     * recomputed exactly when `scene.value` changes (Req 11.2, 13.1, 17.10).
     */
    readonly composed: ReadonlySignal<Polyline[]>;
    /** Whether `undo()` would do anything (Req 15.2). */
    readonly canUndo: ReadonlySignal<boolean>;
    /** Whether `redo()` would do anything (Req 15.3). */
    readonly canRedo: ReadonlySignal<boolean>;

    // --- mutators (each commits exactly one history entry on rest) ---

    addItem(spec: AddItemSpec): ItemId;
    removeItem(id: ItemId): void;
    updateTransform(id: ItemId, patch: Partial<Transform>): void;
    /**
     * Replace the `content` polylines of an existing item without
     * touching its id or transform. Commits a single history entry, so
     * the swap is undoable like any other mutation.
     *
     * Used by the post-commit re-edit path for every item kind: when the
     * user re-opens the relevant Add-* modal on an existing item to try
     * different settings, the new polylines land here. Preserving the
     * transform means a previously moved / scaled / rotated item keeps
     * its placement.
     *
     * The optional `source` argument lets the re-edit also swap the
     * item's source metadata in the SAME history entry — needed by the
     * text re-edit flow, where changing the words / font / size must also
     * update the items-list label (`Text: <text>`). When omitted, the
     * existing source is preserved (the image / freehand flows, where the
     * label is the filename / a static string and a re-edit is a content
     * tweak, not a re-import). The supplied `source` must match the
     * item's `kind`; the store does not change an item's kind. A no-op
     * when `id` does not match any item.
     */
    replaceContent(id: ItemId, content: Polyline[], source?: Item['source']): void;
    /** Move `id` to the supplied Z-order index, clamped to valid range. */
    reorder(id: ItemId, toIndex: number): void;
    /** Swap with the item one position higher in Z-order, if any (Req 7.2). */
    bringForward(id: ItemId): void;
    /** Swap with the item one position lower in Z-order, if any (Req 7.3). */
    sendBackward(id: ItemId): void;
    select(id: ItemId | null): void;
    /** Empty the Scene AND clear the persisted snapshot (Req 14.5). */
    clear(): void;

    // --- gesture lifecycle (Req 15.4) ---

    beginGesture(id: ItemId, kind: GestureKind): void;
    endGesture(): void;
    cancelGesture(): void;

    // --- history ---

    undo(): void;
    redo(): void;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Project floor on history depth (Req 15.1). */
const HISTORY_LIMIT_MIN = 20;
/** Default history depth. */
const HISTORY_LIMIT_DEFAULT = 50;

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/**
 * Build a fresh {@link SceneStore} seeded from the persisted snapshot (if
 * any) or the empty Scene. Every store instance is independent — useful
 * for tests that need a clean slate.
 *
 * The store registers a `@preact/signals` effect that mirrors live Scene
 * changes to the persistence adapter. The effect is cleaned up only when
 * the surrounding `@preact/signals` ownership scope is disposed; in
 * practice the SPA creates the store once at boot and keeps it for the
 * session, so the effect lives for the lifetime of the app.
 *
 * @param opts {@link SceneStoreOptions}
 */
export function createSceneStore(opts: SceneStoreOptions = {}): SceneStore {
    const persistence = opts.persistence ?? createLocalStoragePersistence();
    // Hard minimum keeps the store conformant with Req 15.1 even if a
    // caller passes a smaller value (or zero / negative by mistake).
    const historyLimit = Math.max(
        HISTORY_LIMIT_MIN,
        opts.historyLimit ?? HISTORY_LIMIT_DEFAULT,
    );
    const envelopeMm = opts.envelopeMm;

    // -------------------------------------------------------------------------
    // Live state
    // -------------------------------------------------------------------------

    const initial = normaliseScene(persistence.load() ?? EMPTY_SCENE);

    /** Live Scene signal — the single source of truth. */
    const scene = signal<Scene>(initial);

    /**
     * Bounded undo/redo history. `history[historyIndex]` is the current
     * Scene; entries before it are undoable past states, entries after it
     * are redoable future states. Plain array (not a signal) — only
     * `canUndo` / `canRedo` need to be reactive.
     */
    const history: Scene[] = [initial];
    let historyIndex = 0;

    const canUndo = signal<boolean>(false);
    const canRedo = signal<boolean>(false);

    /**
     * In-flight gesture state. `null` outside of a gesture. Plain variable
     * (not a signal) so the persistence effect, which subscribes only to
     * `scene.value`, does not re-fire on gesture start / end.
     */
    let gesture: {
        id: ItemId;
        kind: GestureKind;
        /** Scene reference at gesture-start; used for cancellation. */
        sceneAtStart: Scene;
        /** Pre-gesture Transform of the targeted item. */
        preTransform: Transform;
    } | null = null;

    /**
     * When true, the persistence effect skips its `save()` call. Set during
     * a gesture (mid-gesture states are not durable) and during
     * {@link cancelGesture} (the on-disk snapshot still matches the rolled-
     * back state, so no write is needed).
     */
    let suppressPersist = false;

    // -------------------------------------------------------------------------
    // Derived signals
    // -------------------------------------------------------------------------

    const selectedItem = computed<Item | null>(() => {
        const s = scene.value;
        if (s.selectedId === null) return null;
        for (let i = 0; i < s.items.length; i++) {
            if (s.items[i].id === s.selectedId) return s.items[i];
        }
        return null;
    });

    const composed = computed<Polyline[]>(() => composeScene(scene.value));

    // -------------------------------------------------------------------------
    // Persistence subscription (Req 14.1)
    // -------------------------------------------------------------------------

    // The first invocation of an `effect` body runs eagerly with the seeded
    // signal value. Skip it so the boot-time scene (which already came from
    // disk in the load() path) is not redundantly re-saved.
    let firstEffectRun = true;
    effect(() => {
        // Subscribe: re-run on every scene change.
        const current = scene.value;
        if (firstEffectRun) {
            firstEffectRun = false;
            return;
        }
        if (suppressPersist) {
            // Mid-gesture, mid-cancel, or mid-`clear()`. The non-gesture
            // commit paths arrange for a manual save / clear after the
            // suppression window closes.
            return;
        }
        persistence.save(current);
    });

    // -------------------------------------------------------------------------
    // History helpers
    // -------------------------------------------------------------------------

    function refreshHistoryFlags(): void {
        canUndo.value = historyIndex > 0;
        canRedo.value = historyIndex < history.length - 1;
    }

    /**
     * Append `next` as a new history entry, truncating any redoable
     * future, and enforce the bounded `historyLimit` by dropping the
     * oldest entries when the buffer overflows.
     */
    function pushHistory(next: Scene): void {
        if (historyIndex < history.length - 1) {
            history.length = historyIndex + 1;
        }
        history.push(next);
        if (history.length > historyLimit) {
            const drop = history.length - historyLimit;
            history.splice(0, drop);
        }
        historyIndex = history.length - 1;
        refreshHistoryFlags();
    }

    /**
     * Commit a new Scene as the live value AND record one history entry.
     * Used by every mutator that comes to rest (no gesture active).
     */
    function commit(next: Scene): void {
        scene.value = next;
        pushHistory(next);
    }

    // -------------------------------------------------------------------------
    // Mutators
    // -------------------------------------------------------------------------

    function addItem(spec: AddItemSpec): ItemId {
        // Default placement: identity transform (local origin, unit scale,
        // zero rotation). When the store was constructed with an
        // `envelopeMm` option (production, via `App.tsx`), compute a
        // fit-to-envelope transform from the spec's content bounding box
        // so imported geometry whose source coordinates dwarf the envelope
        // (e.g. a vectorised image at raw pixel scale) lands centred and
        // visible on first add. The store has no rendering / envelope
        // coupling beyond this opt-in option — tests that omit it keep
        // identity placement, matching the existing Property 5 contract.
        const id = generateItemId();
        const transform =
            envelopeMm !== undefined
                ? computeFitTransform(spec.content, envelopeMm)
                : makeIdentityTransform();

        let item: Item;
        switch (spec.kind) {
            case 'image':
                item = {
                    id,
                    kind: 'image',
                    transform,
                    content: spec.content,
                    source: spec.source,
                };
                break;
            case 'text':
                item = {
                    id,
                    kind: 'text',
                    transform,
                    content: spec.content,
                    source: spec.source,
                };
                break;
            case 'freehand':
                item = {
                    id,
                    kind: 'freehand',
                    transform,
                    content: spec.content,
                    source: spec.source,
                };
                break;
        }

        const cur = scene.value;
        // Append: last index is topmost (Req 1.3, 9.1). New item is selected
        // (Req 2.4).
        commit({
            schemaVersion: 1,
            items: [...cur.items, item],
            selectedId: id,
        });
        return id;
    }

    function removeItem(id: ItemId): void {
        const cur = scene.value;
        const idx = indexOfId(cur, id);
        if (idx === -1) return;
        const items = cur.items.slice();
        items.splice(idx, 1);
        // Per Req 3.6: if the removed item was selected, clear the selection.
        const selectedId = cur.selectedId === id ? null : cur.selectedId;
        commit({ schemaVersion: 1, items, selectedId });
    }

    function updateTransform(id: ItemId, patch: Partial<Transform>): void {
        const cur = scene.value;
        const idx = indexOfId(cur, id);
        if (idx === -1) return;
        const old = cur.items[idx].transform;
        const merged: Transform = {
            x: patch.x ?? old.x,
            y: patch.y ?? old.y,
            sx: patch.sx ?? old.sx,
            sy: patch.sy ?? old.sy,
            rotationRad: patch.rotationRad ?? old.rotationRad,
        };
        // Apply invariants (Req 5.4, 6.2) on every commit, mid-gesture or not.
        const newTransform = normaliseRotation(clampScale(merged));

        const items = cur.items.slice();
        items[idx] = { ...cur.items[idx], transform: newTransform };
        const next: Scene = {
            schemaVersion: 1,
            items,
            selectedId: cur.selectedId,
        };

        if (gesture !== null) {
            // Mid-gesture: update the live signal so the canvas re-renders,
            // but do NOT push a history entry. `endGesture` will coalesce
            // every mid-gesture update into a single entry (Req 15.4).
            scene.value = next;
        } else {
            commit(next);
        }
    }

    function replaceContent(
        id: ItemId,
        content: Polyline[],
        source?: Item['source'],
    ): void {
        // Post-commit re-edit path. Preserves id / transform so a
        // previously placed item keeps its position after a settings
        // tweak. The image / freehand flows call this with two args and
        // keep the original source; the text flow passes a third `source`
        // argument so the words / font / size change is reflected in the
        // items-list label, all in a single (undoable) history entry.
        const cur = scene.value;
        const idx = indexOfId(cur, id);
        if (idx === -1) return;
        const items = cur.items.slice();
        const next =
            source !== undefined
                ? ({ ...cur.items[idx], content, source } as Item)
                : ({ ...cur.items[idx], content } as Item);
        items[idx] = next;
        commit({
            schemaVersion: 1,
            items,
            selectedId: cur.selectedId,
        });
    }

    function reorder(id: ItemId, toIndex: number): void {
        const cur = scene.value;
        const fromIdx = indexOfId(cur, id);
        if (fromIdx === -1) return;
        const clamped = clampReorderIndex(toIndex, cur.items.length);
        if (clamped === fromIdx) return;
        const items = cur.items.slice();
        const [moved] = items.splice(fromIdx, 1);
        items.splice(clamped, 0, moved);
        commit({ schemaVersion: 1, items, selectedId: cur.selectedId });
    }

    function bringForward(id: ItemId): void {
        const cur = scene.value;
        const idx = indexOfId(cur, id);
        if (idx === -1) return;
        // Already topmost — Req 7.4 makes this a no-op.
        if (idx === cur.items.length - 1) return;
        const items = cur.items.slice();
        const a = items[idx];
        const b = items[idx + 1];
        items[idx] = b;
        items[idx + 1] = a;
        commit({ schemaVersion: 1, items, selectedId: cur.selectedId });
    }

    function sendBackward(id: ItemId): void {
        const cur = scene.value;
        const idx = indexOfId(cur, id);
        if (idx === -1) return;
        // Already bottommost — Req 7.4 makes this a no-op.
        if (idx === 0) return;
        const items = cur.items.slice();
        const a = items[idx];
        const b = items[idx - 1];
        items[idx] = b;
        items[idx - 1] = a;
        commit({ schemaVersion: 1, items, selectedId: cur.selectedId });
    }

    function select(id: ItemId | null): void {
        const cur = scene.value;
        if (cur.selectedId === id) return;
        // Defensive: ignore selection of a non-existent id.
        if (id !== null && indexOfId(cur, id) === -1) return;
        commit({
            schemaVersion: 1,
            items: cur.items,
            selectedId: id,
        });
    }

    function clear(): void {
        const cur = scene.value;
        const wasEmpty = cur.items.length === 0 && cur.selectedId === null;
        if (!wasEmpty) {
            // Suppress the persistence effect during this commit — the
            // canonical effect on disk is the `persistence.clear()` call
            // immediately below, not a `save()` of the empty Scene
            // (Req 14.5).
            suppressPersist = true;
            try {
                commit({
                    schemaVersion: 1,
                    items: [],
                    selectedId: null,
                });
            } finally {
                suppressPersist = false;
            }
        }
        // Always clear the persisted snapshot — Req 14.5 says "clear scene
        // empties the Scene AND the persisted snapshot in one step", even
        // when the in-memory Scene was already empty (e.g. user clicks
        // Clear after a fresh boot from a corrupted snapshot).
        persistence.clear();
    }

    // -------------------------------------------------------------------------
    // Gesture lifecycle (Req 15.4)
    // -------------------------------------------------------------------------

    function beginGesture(id: ItemId, kind: GestureKind): void {
        if (gesture !== null) {
            // Defensive: a new beginGesture before the previous endGesture
            // is a UI bug. Cancel the in-flight gesture so we don't leak
            // its pre-state, then start fresh.
            cancelGesture();
        }
        const cur = scene.value;
        const idx = indexOfId(cur, id);
        if (idx === -1) return;
        gesture = {
            id,
            kind,
            sceneAtStart: cur,
            preTransform: cur.items[idx].transform,
        };
        suppressPersist = true;
    }

    function endGesture(): void {
        if (gesture === null) return;
        const finalScene = scene.value;
        const startScene = gesture.sceneAtStart;
        gesture = null;
        suppressPersist = false;

        if (finalScene === startScene) {
            // No `updateTransform` calls happened during this gesture — a
            // pointer-down with no move. Nothing to commit, nothing to save.
            return;
        }
        // Coalesce every mid-gesture `updateTransform` into a single
        // history entry: the post-gesture Scene at rest (Req 15.4).
        pushHistory(finalScene);
        // Manual save: we suppressed the effect for every mid-gesture
        // update, so we own the on-rest persist call (Req 14.1).
        persistence.save(finalScene);
    }

    function cancelGesture(): void {
        if (gesture === null) return;
        const startScene = gesture.sceneAtStart;
        gesture = null;
        // Restore the pre-gesture state without recording history. Suppress
        // the persistence effect: the on-disk snapshot still matches
        // `startScene` (we suppressed during the gesture too), so a save
        // is not needed and would only race with a concurrent endGesture-
        // style commit on a different code path.
        suppressPersist = true;
        try {
            scene.value = startScene;
        } finally {
            suppressPersist = false;
        }
    }

    // -------------------------------------------------------------------------
    // History
    // -------------------------------------------------------------------------

    function undo(): void {
        // No-op when there is nothing to undo (Req 15.2 phrased as "if one
        // exists"). Keeps the contract that `undo()` is always safe to call.
        if (historyIndex <= 0) return;
        historyIndex -= 1;
        scene.value = history[historyIndex];
        refreshHistoryFlags();
    }

    function redo(): void {
        if (historyIndex >= history.length - 1) return;
        historyIndex += 1;
        scene.value = history[historyIndex];
        refreshHistoryFlags();
    }

    return {
        scene,
        selectedItem,
        composed,
        canUndo,
        canRedo,
        addItem,
        removeItem,
        updateTransform,
        replaceContent,
        reorder,
        bringForward,
        sendBackward,
        select,
        clear,
        beginGesture,
        endGesture,
        cancelGesture,
        undo,
        redo,
    };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Heal a freshly-loaded snapshot so the in-memory Transform invariants
 * always hold: clamp scale magnitudes and normalise rotations on every
 * item. The persistence layer is a structural shape gate, not a deep
 * validator — a snapshot with slightly off transforms (e.g. a stored
 * `rotationRad` of `7.0` rather than its `[0, 2π)` reduction) is healed
 * here rather than discarded.
 */
function normaliseScene(s: Scene): Scene {
    let dirty = false;
    const items: Item[] = new Array(s.items.length);
    for (let i = 0; i < s.items.length; i++) {
        const item = s.items[i];
        const fixed = normaliseRotation(clampScale(item.transform));
        if (fixed === item.transform) {
            items[i] = item;
        } else {
            items[i] = { ...item, transform: fixed };
            dirty = true;
        }
    }
    if (!dirty && s.schemaVersion === 1) return s;
    return { schemaVersion: 1, items, selectedId: s.selectedId };
}

/**
 * Generate a lightweight, monotonic-ish item id. Composed of the current
 * timestamp (base-36, lexicographically sortable across the same
 * millisecond) and 8 base-36 random characters for uniqueness within the
 * millisecond. Not cryptographically secure — ids are an in-app
 * correlation handle, not a credential.
 */
function generateItemId(): ItemId {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
    return `${ts}-${rand}`;
}

/** Linear scan for an item by id. Items lists are short (< ~50). */
function indexOfId(s: Scene, id: ItemId): number {
    for (let i = 0; i < s.items.length; i++) {
        if (s.items[i].id === id) return i;
    }
    return -1;
}

/**
 * Clamp a target `reorder` index into `[0, len - 1]`. Negative inputs
 * collapse to 0; out-of-range positive inputs collapse to the topmost
 * valid index. Fractional inputs are floored.
 */
function clampReorderIndex(i: number, len: number): number {
    if (len <= 0) return 0;
    if (!Number.isFinite(i)) return len - 1;
    const floored = Math.floor(i);
    if (floored < 0) return 0;
    if (floored >= len) return len - 1;
    return floored;
}

// -----------------------------------------------------------------------------
// Initial transform helpers
// -----------------------------------------------------------------------------

/**
 * Fraction of the envelope's smaller dimension the new item's longer side
 * is scaled to fit within. Picked at 70% so a freshly-added item sits
 * comfortably inside the dashed envelope rectangle with a visible margin
 * on every side, even at the corners after a small rotation.
 */
const FIT_MARGIN_FRAC = 0.7;

/**
 * Compute the default Transform applied to a newly-added item so its
 * content bbox is centred on the envelope and uniformly scaled to fit
 * within `FIT_MARGIN_FRAC` of the envelope. Pure: depends only on the
 * supplied content and envelope.
 *
 * Degenerate cases (empty content, single-point content, zero / non-finite
 * envelope) fall back to the identity transform — there is no meaningful
 * fit to compute, and the canvas already handles this gracefully (the
 * dashed envelope renders even if the item has nothing to draw).
 */
function computeFitTransform(
    content: Polyline[],
    envelopeMm: { w: number; h: number },
): Transform {
    const envW = envelopeMm.w;
    const envH = envelopeMm.h;
    if (!Number.isFinite(envW) || envW <= 0) return makeIdentityTransform();
    if (!Number.isFinite(envH) || envH <= 0) return makeIdentityTransform();

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (const poly of content) {
        for (const p of poly) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            count++;
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    if (count === 0) return makeIdentityTransform();

    const contentW = maxX - minX;
    const contentH = maxY - minY;
    // No meaningful extent on either axis — leave at identity so the user
    // can still see / select the item via the canvas's selection overlay.
    if (contentW <= 0 && contentH <= 0) return makeIdentityTransform();

    // Uniform scale so the longer side fits within FIT_MARGIN_FRAC of the
    // matching envelope dimension. Either dimension being zero means that
    // axis imposes no constraint, so use only the non-zero side.
    let scale = 1;
    if (contentW > 0 && contentH > 0) {
        scale = Math.min(
            (FIT_MARGIN_FRAC * envW) / contentW,
            (FIT_MARGIN_FRAC * envH) / contentH,
        );
    } else if (contentW > 0) {
        scale = (FIT_MARGIN_FRAC * envW) / contentW;
    } else {
        scale = (FIT_MARGIN_FRAC * envH) / contentH;
    }
    if (!Number.isFinite(scale) || scale <= 0) return makeIdentityTransform();

    // Centre the transformed bbox on the envelope: the transformed bbox
    // centre is `scale * (min + max) / 2 + (x | y)`, so to land at
    // `(envW/2, envH/2)` we need:
    //     x = envW/2 - scale * (minX + maxX) / 2
    //     y = envH/2 - scale * (minY + maxY) / 2
    const x = envW / 2 - (scale * (minX + maxX)) / 2;
    const y = envH / 2 - (scale * (minY + maxY)) / 2;
    return { x, y, sx: scale, sy: scale, rotationRad: 0 };
}
