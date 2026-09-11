/**
 * `ItemsListPanel` — left-rail vertical list of items in the Composer Scene.
 *
 * Displays one row per item in topmost-first order: the underlying Scene's
 * `items` array is rendered reversed, so `items[items.length - 1]` (the
 * topmost item, drawn last on the canvas) appears at the top of the list,
 * matching the Figma / Photoshop convention (Req 17.1).
 *
 * Per-row label format (Req 17.2), truncated to exactly 32 characters with a
 * single-character ellipsis (`"…"`) when the unrestricted label would exceed
 * 32 chars (Req 17.3, Property 13):
 *
 *   - `Image_Item`    → `"Image: <source.filename>"`
 *   - `Text_Item`     → `"Text: <source.text>"`
 *   - `Freehand_Item` → `"Freehand stroke"`
 *
 * Row interactions:
 *
 *   - **Click row** → `store.select(id)` (Req 17.4); the selected row is
 *     rendered in a visually distinct state (Req 17.5).
 *   - **Drag-to-reorder**: while a drag gesture is in flight, a drop indicator
 *     shows where the dragged row would land. The Scene is NOT mutated until
 *     the user drops (Req 17.7); on drop, `store.reorder(id, sceneIndex)` is
 *     called once (Req 17.6). The list is rendered in reverse Z-order, so a
 *     drop at *list* index `k` corresponds to *scene* index
 *     `(items.length - 1) - k` after splice-removal of the dragged row
 *     (matching `SceneStore.reorder`'s splice semantics).
 *   - **Per-row delete button** → `store.removeItem(id)` (Req 17.8, 7.1).
 *
 * Empty-state (`scene.items.length === 0`): renders the literal placeholder
 * "No items yet — add an image, text, or a freehand drawing to get started"
 * and zero rows (Req 17.9).
 *
 * Reactivity: the component reads `store.scene.value` and
 * `store.selectedItem.value` inline during render, so `@preact/signals`
 * automatically subscribes the component and re-renders within the same cycle
 * as any other surface that mutates the Scene (Req 17.10). No manual
 * subscribe/unsubscribe wiring.
 *
 * Renders the optional `addMenu` slot above the list (Req 12.1, 12.2 — the
 * Add-Item menu lives there, but this component does not depend on its
 * shape).
 *
 * Drag-and-drop is built on the HTML5 native API (`draggable` + the
 * `dragstart` / `dragover` / `drop` / `dragend` event suite). The drop target
 * lives on the row that the pointer is currently over: the row's bounding-box
 * vertical midpoint splits "drop above this row" from "drop below this row",
 * which together with a tail sentinel covers every gap position in the list.
 *
 * @see Requirements 7.1, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8,
 *      17.9, 17.10
 * @see Property 13 (label format and truncation)
 */

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';

import type { SceneStore } from '../../composer/scene_store';
import { deleteImageFile } from '../../composer/image_source_cache';
import type { Item, ItemId } from '../../composer/types';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Maximum rendered label length, per Req 17.3 / Property 13. */
const MAX_LABEL_LEN = 32;

/** The single-character ellipsis appended to truncated labels (Req 17.3). */
const ELLIPSIS = '…';

/** Empty-state placeholder text (Req 17.9). Verbatim from the requirement. */
const EMPTY_PLACEHOLDER =
    'No items yet — add an image, text, or a freehand drawing to get started';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface ItemsListPanelProps {
    /** The reactive Composer store. */
    store: SceneStore;
    /** Slot for the AddItemMenu (rendered above the list, Req 12.1). */
    addMenu?: JSX.Element;
    /** Optional extra class on the panel root. */
    class?: string;
    /**
     * Per-row "edit" trigger for ALL item kinds. When supplied, an "✎"
     * button is rendered before the delete button on every row (image,
     * text, freehand); clicking it calls `onEditItem(id)` (with
     * `stopPropagation`, so the row's own select handler does not fire).
     * The parent handles the actual modal-opening side; the panel itself
     * stays presentational.
     *
     * This is the universal re-edit affordance: the unified-composer-
     * canvas refactor hid every input panel behind a one-shot modal, so
     * the only way back into an item's settings (image tracing controls,
     * text words / font / size, or a fresh freehand redraw) is a
     * dedicated re-edit button on the existing row. Renamed from the
     * image-only `onEditImage` so text and freehand items are editable
     * too; the per-row button label reflects the item kind.
     */
    onEditItem?: (id: ItemId) => void;
}

/** Per-kind label for the re-edit button's `title` / `aria-label`. */
const EDIT_LABELS: Record<Item['kind'], string> = {
    // Kept verbatim from the image-only era so the existing affordance and
    // its discoverability tooltip read identically.
    image: 'Edit image settings',
    text: 'Edit text',
    freehand: 'Edit freehand',
};

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

/**
 * In-flight drag state.
 *
 * `gap` is the *list*-coordinate (reversed Z-order) gap-index where the
 * dragged row would land if the user released right now. Range `[0, items
 * .length]`: `gap = 0` is "above the topmost row", `gap = items.length` is
 * "below the bottommost row". When the user is hovering the top half of the
 * row at list index `k`, `gap = k`; the bottom half maps to `gap = k + 1`.
 *
 * The Scene is not mutated until pointer-up (Req 17.7); this state drives
 * only the visual drop indicator.
 */
interface DragState {
    id: ItemId;
    gap: number;
}

// -----------------------------------------------------------------------------
// Label formatting (exported for testability)
// -----------------------------------------------------------------------------

/** Unrestricted label for an Item — pre-truncation. */
function unrestrictedLabel(item: Item): string {
    switch (item.kind) {
        case 'image':
            return `Image: ${item.source.filename}`;
        case 'text':
            return `Text: ${item.source.text}`;
        case 'freehand':
            return 'Freehand stroke';
    }
}

/**
 * Compute the label rendered for a row: at most `MAX_LABEL_LEN` characters.
 *
 * When the unrestricted label would exceed 32 chars, the result has length
 * exactly 32 and ends in a single `'…'` character. Otherwise the label is
 * returned unchanged (Req 17.3, Property 13).
 */
export function rowLabel(item: Item): string {
    const full = unrestrictedLabel(item);
    if (full.length <= MAX_LABEL_LEN) return full;
    return full.slice(0, MAX_LABEL_LEN - 1) + ELLIPSIS;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function ItemsListPanel(props: ItemsListPanelProps): JSX.Element {
    const { store, addMenu, class: className, onEditItem } = props;
    const [drag, setDrag] = useState<DragState | null>(null);

    // Reactive reads. Inline `.value` access registers the component as a
    // subscriber on these signals — when the Scene or the selected item
    // changes (from any source: this panel, the canvas, a keyboard
    // shortcut, undo/redo, persistence restore), Preact re-renders us in
    // the same cycle (Req 17.10).
    const scene = store.scene.value;
    const selected = store.selectedItem.value;
    const items = scene.items;
    const len = items.length;

    // List = items reversed, so list index 0 is the topmost item (Req 17.1).
    const reversed: Item[] = [];
    for (let i = len - 1; i >= 0; i--) reversed.push(items[i]);

    // -------------------------------------------------------------------------
    // Row-level event handlers
    // -------------------------------------------------------------------------

    const onRowClick = (id: ItemId): void => {
        store.select(id);
    };

    const onDeleteClick = (e: MouseEvent, id: ItemId): void => {
        // Don't let the click bubble up into the row (which would re-select
        // the item we are about to remove).
        e.stopPropagation();
        // Drop the cached image File too so removed items don't leak the
        // original bytes for the lifetime of the tab. A no-op for non-
        // image items (the cache uses the item id as the key, so missing
        // entries are silently ignored).
        deleteImageFile(id);
        store.removeItem(id);
    };

    const onEditClick = (e: MouseEvent, id: ItemId): void => {
        // Same stopPropagation pattern as delete: don't re-select the row
        // when the inner button takes the click.
        e.stopPropagation();
        onEditItem?.(id);
    };

    const onDragStart = (
        e: DragEvent,
        id: ItemId,
        listIndex: number,
    ): void => {
        // Some browsers require a `setData` call for the drag to actually
        // begin. The payload is the item id; we read the live drag state
        // from React state instead, so the dataTransfer is mostly a token.
        if (e.dataTransfer !== null) {
            try {
                e.dataTransfer.setData('text/plain', id);
            } catch {
                // jsdom and some test harnesses throw on setData; non-fatal,
                // we never read this value back.
            }
            e.dataTransfer.effectAllowed = 'move';
        }
        // Initial gap = the dragged row's own list position. This is a
        // no-op landing spot, so a drag with no movement is harmless.
        setDrag({ id, gap: listIndex });
    };

    const onRowDragOver = (e: DragEvent, listIndex: number): void => {
        if (drag === null) return;
        // Required to allow drop. Without this, the eventual `drop` event
        // never fires.
        e.preventDefault();
        if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';

        const target = e.currentTarget as HTMLElement | null;
        if (target === null) return;
        const rect = target.getBoundingClientRect();
        // jsdom layouts often report a zero-height rect; default to the
        // top-half "before this row" semantics so the indicator still
        // renders during tests.
        const before =
            rect.height === 0
                ? true
                : e.clientY < rect.top + rect.height / 2;
        const gap = before ? listIndex : listIndex + 1;
        if (drag.gap !== gap) setDrag({ id: drag.id, gap });
    };

    const onTailDragOver = (e: DragEvent): void => {
        if (drag === null) return;
        e.preventDefault();
        if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
        if (drag.gap !== len) setDrag({ id: drag.id, gap: len });
    };

    const onDrop = (e: DragEvent): void => {
        if (drag === null) return;
        e.preventDefault();
        commitDrop();
    };

    const commitDrop = (): void => {
        if (drag === null) return;

        // The user dropped — translate the list-coordinate `gap` into the
        // scene-coordinate target index expected by `store.reorder`.
        //
        // `store.reorder(id, k)` does `items.splice(fromIdx, 1)` then
        // `items.splice(k, 0, moved)`, so `k` is an index into the array
        // *after* removing the dragged item. We do the same translation in
        // list space.

        if (len > 0) {
            // Look up the dragged item's current scene index live (the
            // Scene may have changed mid-drag from another surface).
            let sourceSceneIdx = -1;
            for (let i = 0; i < len; i++) {
                if (items[i].id === drag.id) {
                    sourceSceneIdx = i;
                    break;
                }
            }
            if (sourceSceneIdx !== -1) {
                const sourceListIdx = len - 1 - sourceSceneIdx;
                const gap = drag.gap;
                // After removing the dragged row, every gap that was
                // strictly below the source slides up by 1.
                const gapAdjusted = gap <= sourceListIdx ? gap : gap - 1;
                if (gapAdjusted !== sourceListIdx) {
                    const sceneIndex = len - 1 - gapAdjusted;
                    store.reorder(drag.id, sceneIndex);
                }
            }
        }

        setDrag(null);
    };

    const onDragEnd = (): void => {
        // Cancellations and aborts (Esc, dropped outside the list, dragged
        // off-window): clear drag state without mutating the Scene.
        setDrag(null);
    };

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    return (
        <aside
            class={`items-list-panel${className !== undefined ? ` ${className}` : ''}`}
            data-testid="items-list-panel"
            aria-label="Items list"
        >
            {addMenu !== undefined && (
                <div
                    class="items-list-panel__add-menu"
                    data-testid="items-list-add-menu"
                >
                    {addMenu}
                </div>
            )}

            {len === 0 ? (
                <p
                    class="items-list-panel__empty"
                    data-testid="items-list-empty"
                >
                    {EMPTY_PLACEHOLDER}
                </p>
            ) : (
                <ul
                    class="items-list-panel__list"
                    data-testid="items-list"
                    role="list"
                    onDrop={onDrop}
                    onDragEnd={onDragEnd}
                >
                    {reversed.map((item, listIndex) => {
                        const isSelected =
                            selected !== null && selected.id === item.id;
                        const isDragging =
                            drag !== null && drag.id === item.id;
                        const dropBefore =
                            drag !== null && drag.gap === listIndex;
                        const cls = [
                            'items-list-panel__row',
                            isSelected && 'items-list-panel__row--selected',
                            isDragging && 'items-list-panel__row--dragging',
                            dropBefore &&
                            'items-list-panel__row--drop-before',
                        ]
                            .filter(Boolean)
                            .join(' ');
                        return (
                            <li
                                key={item.id}
                                class={cls}
                                data-testid="items-list-row"
                                data-item-id={item.id}
                                data-selected={isSelected ? 'true' : 'false'}
                                aria-selected={isSelected}
                                draggable
                                onDragStart={(e) =>
                                    onDragStart(
                                        e as DragEvent,
                                        item.id,
                                        listIndex,
                                    )
                                }
                                onDragOver={(e) =>
                                    onRowDragOver(
                                        e as DragEvent,
                                        listIndex,
                                    )
                                }
                                onClick={() => onRowClick(item.id)}
                            >
                                <span
                                    class="items-list-panel__label"
                                    data-testid="items-list-label"
                                >
                                    {rowLabel(item)}
                                </span>
                                {onEditItem !== undefined && (
                                    <button
                                        type="button"
                                        class="items-list-panel__edit"
                                        data-testid="items-list-edit"
                                        aria-label={EDIT_LABELS[item.kind]}
                                        title={EDIT_LABELS[item.kind]}
                                        onClick={(e) =>
                                            onEditClick(
                                                e as MouseEvent,
                                                item.id,
                                            )
                                        }
                                    >
                                        ✎
                                    </button>
                                )}
                                <button
                                    type="button"
                                    class="items-list-panel__delete"
                                    data-testid="items-list-delete"
                                    aria-label="Delete item"
                                    onClick={(e) =>
                                        onDeleteClick(
                                            e as MouseEvent,
                                            item.id,
                                        )
                                    }
                                >
                                    ×
                                </button>
                            </li>
                        );
                    })}
                    {/* Tail sentinel: catches drops below the bottommost
                        row, i.e. gap === len. Always rendered while the
                        list is non-empty so the cursor has a target there
                        regardless of layout details. */}
                    <li
                        class={`items-list-panel__tail${drag !== null && drag.gap === len
                            ? ' items-list-panel__tail--drop-here'
                            : ''
                            }`}
                        data-testid="items-list-tail"
                        aria-hidden="true"
                        onDragOver={(e) => onTailDragOver(e as DragEvent)}
                    />
                </ul>
            )}
        </aside>
    );
}

export default ItemsListPanel;
