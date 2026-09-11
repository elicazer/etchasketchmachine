/**
 * Phase-2 regression tests for the post-placement "edit image settings"
 * (re-vectorize) affordance in the studio left dock.
 *
 * The unified-composer-canvas refactor hid the image tracing controls
 * behind a one-shot modal, so the only way back into them is the per-row
 * "✎" edit button (`data-testid="items-list-edit"`) on image rows. These
 * tests pin that the button is still rendered and that the App-style
 * bridge (`onEditImage` → parent `editImageId` → `AddItemMenu` edit mode →
 * `store.replaceContent`) is wired end-to-end.
 *
 * Test A drives the panel directly to confirm the button's presence and
 * click semantics. Test B replicates `App.tsx`'s exact state bridge
 * (a parent-owned `editingImageId`) across `ItemsListPanel` + `AddItemMenu`
 * and uses the *real* `DefaultImagePanel`, preloaded from the session image
 * cache with an SVG file, so the commit routes through the production
 * `onCommitWithFile` → `replaceContent` path (NOT a fresh `addItem`).
 *
 * @see web/src/ui/composer/ItemsListPanel.tsx
 * @see web/src/ui/composer/AddItemMenu.tsx
 * @see web/src/ui/App.tsx (the editingImageId bridge)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';

import { ItemsListPanel } from './ItemsListPanel';
import { AddItemMenu } from './AddItemMenu';
import { createSceneStore } from '../../composer/scene_store';
import {
    imageSourceCache,
    setImageFile,
} from '../../composer/image_source_cache';
import type { ScenePersistence } from '../../composer/persistence';
import type { ItemId, Scene } from '../../composer/types';
import type { Polyline } from '../../types';
import { createTextRenderer } from '../../text/text_renderer';

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    imageSourceCache.clear();
});

afterEach(() => {
    act(() => {
        render(null, container);
    });
    container.remove();
    imageSourceCache.clear();
    vi.restoreAllMocks();
});

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

function q(testid: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

function qAll(testid: string): HTMLElement[] {
    return Array.from(
        container.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`),
    );
}

function clickByTestId(testid: string): void {
    const el = q(testid);
    if (el === null) throw new Error(`element not found: ${testid}`);
    act(() => {
        el.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
}

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

const IMAGE_SOURCE = { filename: 'logo.png', sizeBytes: 4096 } as const;
const TEXT_SOURCE = {
    text: 'hello',
    fontName: 'sans',
    fontSizeMm: 10,
    letterSpacingPct: 0,
} as const;

/** Minimal valid SVG yielding at least one polyline through the extractor. */
function makeSvgFile(): File {
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
        '<polyline points="0,0 100,0 100,100 0,100"/></svg>';
    const f = new File([svg], 'logo.svg', { type: 'image/svg+xml' });
    // jsdom/undici's `new Response(file).text()` fallback stringifies the
    // File rather than reading its bytes, so give the File a real `text()`
    // (which the panel prefers when present) to mirror a real browser.
    Object.defineProperty(f, 'text', {
        value: () => Promise.resolve(svg),
        configurable: true,
    });
    return f;
}

// -----------------------------------------------------------------------------
// Test A — the edit button itself
// -----------------------------------------------------------------------------

describe('ItemsListPanel — per-row edit affordance', () => {
    it('renders the "✎" edit button on every row (with a per-kind tooltip) only when onEditItem is provided', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        store.addItem({ kind: 'image', content: [], source: IMAGE_SOURCE });
        store.addItem({ kind: 'text', content: [], source: TEXT_SOURCE });

        // Without onEditItem: no edit buttons at all.
        act(() => {
            render(<ItemsListPanel store={store} />, container);
        });
        expect(qAll('items-list-edit')).toHaveLength(0);

        // With onEditItem: one edit button per row (image AND text), each
        // with a per-kind discoverability tooltip/title.
        act(() => {
            render(
                <ItemsListPanel store={store} onEditItem={() => { }} />,
                container,
            );
        });
        const editButtons = qAll('items-list-edit');
        expect(editButtons).toHaveLength(2);
        // List renders topmost-first: items=[image, text] → list=[text, image].
        const titles = editButtons.map((b) => b.getAttribute('title'));
        expect(titles).toContain('Edit image settings');
        expect(titles).toContain('Edit text');
        // The image row keeps its original label verbatim.
        const imageBtn = editButtons.find(
            (b) => b.getAttribute('title') === 'Edit image settings',
        );
        expect(imageBtn).toBeDefined();
        expect(imageBtn!.getAttribute('aria-label')).toBe(
            'Edit image settings',
        );
    });

    it('clicking the edit button calls onEditItem(id) and does NOT select the row', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const imageId = store.addItem({
            kind: 'image',
            content: [],
            source: IMAGE_SOURCE,
        });
        // Clear the auto-selection that addItem applies so we can prove the
        // edit click does not (re)select.
        store.select(null);
        expect(store.scene.value.selectedId).toBeNull();

        const onEditItem = vi.fn();
        act(() => {
            render(
                <ItemsListPanel store={store} onEditItem={onEditItem} />,
                container,
            );
        });

        clickByTestId('items-list-edit');

        expect(onEditItem).toHaveBeenCalledTimes(1);
        expect(onEditItem).toHaveBeenCalledWith(imageId);
        // stopPropagation: the row's own select handler must not fire.
        expect(store.scene.value.selectedId).toBeNull();
    });
});

// -----------------------------------------------------------------------------
// Test B — full App-style bridge into edit mode and replaceContent commit
// -----------------------------------------------------------------------------

/**
 * Replica of App.tsx's editingItemId bridge: the shell owns the id and
 * threads it into AddItemMenu's `editingItemId`, while ItemsListPanel's
 * `onEditItem` sets it. This is the wiring the studio rewrite must keep.
 */
function StudioEditBridge(props: {
    store: ReturnType<typeof createSceneStore>;
}): preact.JSX.Element {
    const { store } = props;
    const [editingItemId, setEditingItemId] = useState<ItemId | null>(null);
    return (
        <ItemsListPanel
            store={store}
            addMenu={
                <AddItemMenu
                    store={store}
                    editingItemId={editingItemId}
                    onEditDone={() => setEditingItemId(null)}
                />
            }
            onEditItem={(id) => setEditingItemId(id)}
        />
    );
}

describe('studio edit bridge — re-vectorize commits via replaceContent', () => {
    it('clicking ✎ opens the Add-image modal in edit mode preloaded with the cached file, and "Save changes" routes through store.replaceContent (preserving id + transform)', async () => {
        const store = createSceneStore({
            persistence: makeMemoryPersistence(),
            envelopeMm: { w: 152, h: 105 },
        });

        // Seed an existing image item plus its cached source File, exactly
        // as the add-commit path would have on first import.
        const imageId = store.addItem({
            kind: 'image',
            content: [
                [
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                ],
            ],
            source: IMAGE_SOURCE,
        });
        setImageFile(imageId, makeSvgFile());

        const transformBefore = store.scene.value.items[0].transform;
        const contentBefore = store.scene.value.items[0].content;

        const replaceSpy = vi.spyOn(store, 'replaceContent');
        const addSpy = vi.spyOn(store, 'addItem');

        act(() => {
            render(<StudioEditBridge store={store} />, container);
        });

        // No modal until the edit button is clicked.
        expect(q('add-item-modal')).toBeNull();

        clickByTestId('items-list-edit');

        // Modal opens in EDIT mode: titled "Edit image settings".
        const modal = q('add-item-modal');
        expect(modal).not.toBeNull();
        expect(modal!.getAttribute('aria-label')).toBe('Edit image settings');

        // The preloaded SVG file auto-traces on mount; let the async pipeline
        // settle so the commit button enables and the edit label appears.
        await flush();

        const commit = q('add-item-commit') as HTMLButtonElement | null;
        expect(commit).not.toBeNull();
        // Edit mode labels the commit button "Save changes" (vs "Add to scene").
        expect(commit!.textContent).toContain('Save changes');
        expect(commit!.disabled).toBe(false);

        clickByTestId('add-item-commit');

        // Routed through replaceContent on the SAME id — NOT a fresh addItem.
        expect(replaceSpy).toHaveBeenCalledTimes(1);
        expect(replaceSpy.mock.calls[0][0]).toBe(imageId);
        expect(addSpy).not.toHaveBeenCalled();

        // Still exactly one item, same id, transform preserved, content swapped.
        const items = store.scene.value.items;
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe(imageId);
        expect(items[0].transform).toEqual(transformBefore);
        expect(items[0].content).not.toBe(contentBefore);
        expect(items[0].content.length).toBeGreaterThan(0);

        // Modal closes after a successful edit commit.
        expect(q('add-item-modal')).toBeNull();
    });
});

// -----------------------------------------------------------------------------
// Test C — universal re-edit: TEXT row
// -----------------------------------------------------------------------------

describe('studio edit bridge — text re-edit commits via replaceContent (content + source)', () => {
    it('clicking ✎ on a text row opens the Add-text modal pre-filled; changing the words and committing routes through replaceContent (preserving id + transform, updating the source/label)', async () => {
        // A real bundled font name so the real TextPanel renders polylines
        // (an unknown font would yield an empty result and disable commit).
        const fontName = createTextRenderer().fonts()[0].name;

        const store = createSceneStore({
            persistence: makeMemoryPersistence(),
            envelopeMm: { w: 152, h: 105 },
        });

        const textId = store.addItem({
            kind: 'text',
            content: [
                [
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                ],
            ],
            source: { text: 'hello', fontName, fontSizeMm: 20, letterSpacingPct: 0 },
        });
        // Move it so we can prove the transform survives the re-edit.
        store.updateTransform(textId, { x: 12, y: 8 });
        const transformBefore = store.scene.value.items[0].transform;

        const replaceSpy = vi.spyOn(store, 'replaceContent');
        const addSpy = vi.spyOn(store, 'addItem');

        act(() => {
            render(<StudioEditBridge store={store} />, container);
        });

        // Only one item → one edit button (the text row).
        clickByTestId('items-list-edit');

        // Modal opens in EDIT mode for text.
        const modal = q('add-item-modal');
        expect(modal).not.toBeNull();
        expect(modal!.getAttribute('aria-label')).toBe('Edit text');

        // Pre-filled with the item's current text.
        const input = q('text-input') as HTMLInputElement | null;
        expect(input).not.toBeNull();
        expect(input!.value).toBe('hello');

        await flush();

        const commit = q('add-item-commit') as HTMLButtonElement | null;
        expect(commit).not.toBeNull();
        // Edit mode labels the commit button "Save changes".
        expect(commit!.textContent).toContain('Save changes');
        expect(commit!.disabled).toBe(false);

        // Change the words.
        act(() => {
            input!.value = 'world';
            input!.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await flush();

        clickByTestId('add-item-commit');

        // Routed through replaceContent with the SAME id and a NEW source.
        expect(replaceSpy).toHaveBeenCalledTimes(1);
        expect(replaceSpy.mock.calls[0][0]).toBe(textId);
        const newSource = replaceSpy.mock.calls[0][2] as
            | { text: string }
            | undefined;
        expect(newSource).toBeDefined();
        expect(newSource!.text).toBe('world');
        expect(addSpy).not.toHaveBeenCalled();

        // Still one item, same id, transform preserved, source/label updated.
        const items = store.scene.value.items;
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe(textId);
        expect(items[0].transform).toEqual(transformBefore);
        expect((items[0] as { source: { text: string } }).source.text).toBe(
            'world',
        );

        expect(q('add-item-modal')).toBeNull();
    });
});

// -----------------------------------------------------------------------------
// Test D — universal re-edit: FREEHAND row
// -----------------------------------------------------------------------------

/** Override freehand panel that commits a fixed redraw on click. */
const FREEHAND_REDRAW: Polyline[] = [
    [
        { x: 0, y: 0 },
        { x: 9, y: 9 },
        { x: 18, y: 0 },
    ],
];

function FreehandRedrawOverride(props: {
    onCommit: (polylines: Polyline[], source: { capturedAtMs: number }) => void;
    onCancel: () => void;
}): preact.JSX.Element {
    return (
        <button
            type="button"
            data-testid="fh-redraw-commit"
            onClick={() => props.onCommit(FREEHAND_REDRAW, { capturedAtMs: 2 })}
        >
            redraw
        </button>
    );
}

describe('studio edit bridge — freehand re-edit commits via replaceContent', () => {
    it('clicking ✎ on a freehand row opens the Add-freehand modal in edit mode; committing a redraw replaces content while preserving id + transform', () => {
        const store = createSceneStore({
            persistence: makeMemoryPersistence(),
            envelopeMm: { w: 152, h: 105 },
        });

        const fhId = store.addItem({
            kind: 'freehand',
            content: [
                [
                    { x: 0, y: 0 },
                    { x: 2, y: 2 },
                ],
            ],
            source: { capturedAtMs: 1 },
        });
        store.updateTransform(fhId, { x: 10, y: 5 });
        const transformBefore = store.scene.value.items[0].transform;

        const replaceSpy = vi.spyOn(store, 'replaceContent');
        const addSpy = vi.spyOn(store, 'addItem');

        // A bridge that injects the freehand override panel (so we can drive
        // the commit without simulating a full pointer-drawn stroke) while
        // still exercising the real editingItemId → edit-mode wiring.
        function Bridge(): preact.JSX.Element {
            const [editingItemId, setEditingItemId] = useState<ItemId | null>(
                null,
            );
            return (
                <ItemsListPanel
                    store={store}
                    addMenu={
                        <AddItemMenu
                            store={store}
                            editingItemId={editingItemId}
                            onEditDone={() => setEditingItemId(null)}
                            panels={{ freehand: FreehandRedrawOverride }}
                        />
                    }
                    onEditItem={(id) => setEditingItemId(id)}
                />
            );
        }

        act(() => {
            render(<Bridge />, container);
        });

        clickByTestId('items-list-edit');

        const modal = q('add-item-modal');
        expect(modal).not.toBeNull();
        expect(modal!.getAttribute('aria-label')).toBe('Edit freehand');

        clickByTestId('fh-redraw-commit');

        // Routed through replaceContent (two-arg form — freehand source is
        // not label-bearing, so it is preserved) on the SAME id.
        expect(replaceSpy).toHaveBeenCalledTimes(1);
        expect(replaceSpy.mock.calls[0][0]).toBe(fhId);
        expect(replaceSpy.mock.calls[0][1]).toBe(FREEHAND_REDRAW);
        expect(replaceSpy.mock.calls[0][2]).toBeUndefined();
        expect(addSpy).not.toHaveBeenCalled();

        const items = store.scene.value.items;
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe(fhId);
        expect(items[0].transform).toEqual(transformBefore);
        expect(items[0].content).toBe(FREEHAND_REDRAW);

        expect(q('add-item-modal')).toBeNull();
    });
});
