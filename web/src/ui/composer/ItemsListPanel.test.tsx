/**
 * Component tests for the {@link ItemsListPanel}.
 *
 * Coverage:
 *   - **Property 13** (label format / truncation / DOM order, Req 17.1,
 *     17.2, 17.3): every rendered row label starts with `"Image: "` /
 *     `"Text: "` / equals `"Freehand stroke"`; rendered labels are at most
 *     32 characters and end in a single `"…"` exactly when the
 *     unrestricted label would exceed 32; rendered DOM order is the
 *     `scene.items` array reversed (topmost on top).
 *   - Empty-state placeholder render (Req 17.9).
 *   - Click-to-select calls `store.select(id)` (Req 17.4).
 *   - Drag-to-reorder mutates the Scene only on drop, never during the
 *     in-flight drag (Req 17.6, 17.7).
 *   - Per-row delete calls `store.removeItem(id)` (Req 17.8).
 *   - Reactivity: a non-list mutation (`store.addItem`) updates the
 *     rendered rows in the same render cycle (Req 17.10).
 *
 * Project conventions (mirrored from `AddItemMenu.test.tsx`):
 *   - Mount with Preact's own `render` plus `act` from
 *     `preact/test-utils`; no `@testing-library/preact` dependency.
 *   - Use `data-testid` attributes for selection.
 *   - Build a real {@link SceneStore} via `createSceneStore`, paired with
 *     an in-memory `ScenePersistence` so tests are isolated and never
 *     touch `localStorage`.
 *
 * @see web/src/ui/composer/ItemsListPanel.tsx
 * @see Requirements 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import fc from 'fast-check';

import { ItemsListPanel } from './ItemsListPanel';
import {
    createSceneStore,
    type AddItemSpec,
    type SceneStore,
} from '../../composer/scene_store';
import type { ScenePersistence } from '../../composer/persistence';
import type { ItemId, Scene } from '../../composer/types';
import type { Polyline } from '../../types';

// -----------------------------------------------------------------------------
// Test harness
// -----------------------------------------------------------------------------

let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    act(() => {
        render(null, container);
    });
    container.remove();
});

/** Fresh in-memory `ScenePersistence` per test (no `localStorage` traffic). */
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

const TRIANGLE: Polyline = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
];

function imageSpec(filename: string, sizeBytes = 1234): AddItemSpec {
    return {
        kind: 'image',
        content: [TRIANGLE],
        source: { filename, sizeBytes },
    };
}
function textSpec(text: string): AddItemSpec {
    return {
        kind: 'text',
        content: [TRIANGLE],
        source: {
            text,
            fontName: 'sans',
            fontSizeMm: 10,
            letterSpacingPct: 0,
        },
    };
}
function freehandSpec(): AddItemSpec {
    return {
        kind: 'freehand',
        content: [TRIANGLE],
        source: { capturedAtMs: 1700000000000 },
    };
}

function mountPanel(store: SceneStore): void {
    act(() => {
        render(<ItemsListPanel store={store} />, container);
    });
}

function rows(): HTMLElement[] {
    return Array.from(
        container.querySelectorAll<HTMLElement>(
            '[data-testid="items-list-row"]',
        ),
    );
}

function labelTextOf(row: HTMLElement): string {
    const span = row.querySelector<HTMLElement>(
        '[data-testid="items-list-label"]',
    );
    if (span === null) throw new Error('row missing label span');
    // Use textContent rather than innerHTML so the assertion runs on the
    // real rendered string, including the single-character ellipsis.
    return span.textContent ?? '';
}

function clickRow(row: HTMLElement): void {
    act(() => {
        row.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
}

function clickDeleteOnRow(row: HTMLElement): void {
    const btn = row.querySelector<HTMLElement>(
        '[data-testid="items-list-delete"]',
    );
    if (btn === null) throw new Error('row missing delete button');
    act(() => {
        btn.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
}

/**
 * Build a synthetic drag-style event with a structural `dataTransfer` and
 * an optional `clientY`.
 *
 * jsdom does not implement a writable `DataTransfer`, so the panel's
 * handlers (which read/write `dataTransfer.effectAllowed` /
 * `dataTransfer.dropEffect` and call `setData`) need a stand-in object to
 * keep the happy-path code from throwing under the test environment.
 *
 * The synthetic Event bubbles and is cancelable so `preventDefault()`
 * inside `onRowDragOver` / `onDrop` is observable, which is required to
 * gate the drop event in real browsers.
 */
function makeDragEvent(type: string, init: { clientY?: number } = {}): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const dt = {
        effectAllowed: 'none',
        dropEffect: 'none',
        setData(_format: string, _data: string) {
            /* no-op — the panel never reads it back */
        },
        getData(_format: string) {
            return '';
        },
    };
    Object.defineProperty(e, 'dataTransfer', { value: dt });
    if (init.clientY !== undefined) {
        Object.defineProperty(e, 'clientY', {
            value: init.clientY,
            configurable: true,
        });
    }
    return e;
}

function dispatch(target: EventTarget, event: Event): void {
    act(() => {
        target.dispatchEvent(event);
    });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('ItemsListPanel', () => {
    it('renders the empty-state placeholder and zero rows when the Scene has no items (Req 17.9)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        mountPanel(store);

        const empty = container.querySelector<HTMLElement>(
            '[data-testid="items-list-empty"]',
        );
        expect(empty).not.toBeNull();
        expect(empty?.textContent ?? '').toBe(
            'No items yet — add an image, text, or a freehand drawing to get started',
        );
        // No list, no rows.
        expect(
            container.querySelector('[data-testid="items-list"]'),
        ).toBeNull();
        expect(rows()).toHaveLength(0);
    });

    // Feature: unified-composer-canvas, Property 13: items list label format and truncation
    it('Property 13: rendered labels match the format/truncation contract and DOM order is scene.items reversed (Req 17.1, 17.2, 17.3)', () => {
        const MAX = 32;

        // Generators for each item kind. We oversample around the 32-char
        // boundary on filename / text so the truncation branch is hit
        // frequently.
        const filenameArb = fc.oneof(
            fc.string({ minLength: 0, maxLength: 5 }),
            fc.string({ minLength: 20, maxLength: 30 }),
            fc.string({ minLength: 31, maxLength: 80 }),
        );
        const textArb = fc.oneof(
            fc.string({ minLength: 0, maxLength: 5 }),
            fc.string({ minLength: 20, maxLength: 30 }),
            fc.string({ minLength: 31, maxLength: 80 }),
        );

        const itemSpecArb = fc.oneof(
            filenameArb.map((filename): AddItemSpec => imageSpec(filename)),
            textArb.map((text): AddItemSpec => textSpec(text)),
            fc.constant<AddItemSpec>(freehandSpec()),
        );

        // Unrestricted label that the panel would compute pre-truncation.
        function unrestricted(spec: AddItemSpec): string {
            switch (spec.kind) {
                case 'image':
                    return `Image: ${spec.source.filename}`;
                case 'text':
                    return `Text: ${spec.source.text}`;
                case 'freehand':
                    return 'Freehand stroke';
            }
        }

        fc.assert(
            fc.property(
                fc.array(itemSpecArb, { minLength: 1, maxLength: 8 }),
                (specs) => {
                    const store = createSceneStore({
                        persistence: makeMemoryPersistence(),
                    });
                    for (const spec of specs) store.addItem(spec);

                    // Re-mount on each iteration so we exercise the render
                    // path freshly — and clean up before next iteration.
                    const localContainer = document.createElement('div');
                    document.body.appendChild(localContainer);
                    try {
                        act(() => {
                            render(
                                <ItemsListPanel store={store} />,
                                localContainer,
                            );
                        });

                        const renderedRows = Array.from(
                            localContainer.querySelectorAll<HTMLElement>(
                                '[data-testid="items-list-row"]',
                            ),
                        );

                        // Row count matches scene size.
                        const sceneItems = store.scene.value.items;
                        expect(renderedRows.length).toBe(sceneItems.length);

                        // DOM order is `scene.items` reversed.
                        for (let listIdx = 0; listIdx < renderedRows.length; listIdx++) {
                            const sceneIdx =
                                sceneItems.length - 1 - listIdx;
                            const row = renderedRows[listIdx];
                            const item = sceneItems[sceneIdx];
                            expect(
                                row.getAttribute('data-item-id'),
                            ).toBe(item.id);
                        }

                        // Per-row label contract.
                        for (let listIdx = 0; listIdx < renderedRows.length; listIdx++) {
                            const sceneIdx =
                                sceneItems.length - 1 - listIdx;
                            const item = sceneItems[sceneIdx];
                            const rendered = labelTextOf(
                                renderedRows[listIdx],
                            );

                            // The kind-specific spec mirrors the item we
                            // pushed in, so the unrestricted label is
                            // reconstructible from the corresponding spec.
                            const spec = specs[sceneIdx];
                            const full = unrestricted(spec);

                            // Format: starts with the kind prefix or is
                            // exactly the freehand literal.
                            if (item.kind === 'image') {
                                expect(rendered.startsWith('Image: '))
                                    .toBe(true);
                            } else if (item.kind === 'text') {
                                expect(rendered.startsWith('Text: '))
                                    .toBe(true);
                            } else {
                                expect(rendered).toBe('Freehand stroke');
                            }

                            // Length cap.
                            expect(rendered.length).toBeLessThanOrEqual(MAX);

                            // Ellipsis condition is iff:
                            const shouldTruncate = full.length > MAX;
                            const endsWithEllipsis = rendered.endsWith('…');
                            expect(endsWithEllipsis).toBe(shouldTruncate);

                            if (shouldTruncate) {
                                // Exactly one ellipsis at the end and the
                                // truncation is the prefix of `full`.
                                expect(rendered.length).toBe(MAX);
                                expect(rendered.slice(0, MAX - 1)).toBe(
                                    full.slice(0, MAX - 1),
                                );
                            } else {
                                // Untruncated labels are returned verbatim.
                                expect(rendered).toBe(full);
                            }
                        }
                    } finally {
                        act(() => {
                            render(null, localContainer);
                        });
                        localContainer.remove();
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it('clicking a row calls store.select(id) (Req 17.4)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const idA = store.addItem(imageSpec('a.png'));
        const idB = store.addItem(textSpec('hello'));
        const idC = store.addItem(freehandSpec());

        // After addItem, the most-recent item is selected. Reset selection
        // so the click path is the one under test.
        store.select(null);

        const selectSpy = vi.spyOn(store, 'select');
        mountPanel(store);

        // List is reversed: row 0 = topmost = id C, row 1 = B, row 2 = A.
        const renderedRows = rows();
        expect(renderedRows).toHaveLength(3);
        expect(renderedRows[0].getAttribute('data-item-id')).toBe(idC);
        expect(renderedRows[1].getAttribute('data-item-id')).toBe(idB);
        expect(renderedRows[2].getAttribute('data-item-id')).toBe(idA);

        clickRow(renderedRows[1]);

        expect(selectSpy).toHaveBeenCalledTimes(1);
        expect(selectSpy).toHaveBeenCalledWith(idB);
        expect(store.scene.value.selectedId).toBe(idB);

        // Selected row is rendered in a visually-distinct state (Req 17.5).
        const updatedRows = rows();
        expect(updatedRows[1].getAttribute('data-selected')).toBe('true');
        expect(updatedRows[0].getAttribute('data-selected')).toBe('false');
        expect(updatedRows[2].getAttribute('data-selected')).toBe('false');
    });

    it('per-row delete button calls store.removeItem(id) and does not bubble into the row click (Req 17.8, 17.4)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const idA = store.addItem(imageSpec('a.png'));
        const idB = store.addItem(textSpec('hello'));
        const idC = store.addItem(freehandSpec());
        store.select(null);

        const removeSpy = vi.spyOn(store, 'removeItem');
        const selectSpy = vi.spyOn(store, 'select');

        mountPanel(store);

        // Delete row 1 (= B in the list-reversed order).
        const renderedRows = rows();
        expect(renderedRows[1].getAttribute('data-item-id')).toBe(idB);
        clickDeleteOnRow(renderedRows[1]);

        expect(removeSpy).toHaveBeenCalledTimes(1);
        expect(removeSpy).toHaveBeenCalledWith(idB);

        // The delete button stops propagation, so the row's onClick
        // (which would call `store.select`) MUST NOT have fired.
        expect(selectSpy).not.toHaveBeenCalled();

        // The Scene now has two items, no selected id.
        expect(store.scene.value.items.map((i) => i.id)).toEqual([idA, idC]);

        // Re-render reflects the removal.
        const remaining = rows();
        expect(remaining).toHaveLength(2);
        expect(remaining[0].getAttribute('data-item-id')).toBe(idC);
        expect(remaining[1].getAttribute('data-item-id')).toBe(idA);
    });

    it('drag-to-reorder leaves the Scene unchanged during the drag and mutates only on drop (Req 17.6, 17.7)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const idA = store.addItem(imageSpec('a.png')); // bottom (index 0)
        const idB = store.addItem(textSpec('hello'));  // middle (index 1)
        const idC = store.addItem(freehandSpec());     // top    (index 2)
        store.select(null);

        const reorderSpy = vi.spyOn(store, 'reorder');
        mountPanel(store);

        // Snapshot the initial scene + items array (object identity).
        const sceneBefore = store.scene.value;
        const itemsBefore = sceneBefore.items;
        expect(itemsBefore.map((i) => i.id)).toEqual([idA, idB, idC]);

        // Rows in list order: [C (top, list 0), B (list 1), A (bottom, list 2)].
        const initialRows = rows();
        const rowA = initialRows.find(
            (r) => r.getAttribute('data-item-id') === idA,
        )!;
        const rowC = initialRows.find(
            (r) => r.getAttribute('data-item-id') === idC,
        )!;

        // -------------------------------------------------------------------
        // Phase 1: dragstart on row A — the bottommost item. Picks up the
        // drag; no Scene mutation expected.
        // -------------------------------------------------------------------
        dispatch(rowA, makeDragEvent('dragstart'));
        expect(reorderSpy).not.toHaveBeenCalled();
        expect(store.scene.value).toBe(sceneBefore);
        expect(store.scene.value.items).toBe(itemsBefore);

        // -------------------------------------------------------------------
        // Phase 2: dragover on row C (the top of the list). With jsdom's
        // zero-height bounding boxes the panel treats the pointer as being
        // on the top half, so this requests gap = 0 (above the topmost row).
        // -------------------------------------------------------------------
        const dragOver = makeDragEvent('dragover', { clientY: 0 });
        dispatch(rowC, dragOver);
        // preventDefault must have been called so the browser would
        // accept the eventual drop.
        expect(dragOver.defaultPrevented).toBe(true);
        // STILL no Scene mutation while in flight (Req 17.7).
        expect(reorderSpy).not.toHaveBeenCalled();
        expect(store.scene.value).toBe(sceneBefore);
        expect(store.scene.value.items).toBe(itemsBefore);

        // -------------------------------------------------------------------
        // Phase 3: drop on row C. The panel translates the list-coordinate
        // gap into the scene-coordinate target index expected by
        // `store.reorder`. With A as the source (sceneIdx=0, listIdx=2)
        // and gap=0 (above the top), A should land at the top of the
        // Z-order — scene index 2.
        // -------------------------------------------------------------------
        const dropEvt = makeDragEvent('drop');
        dispatch(rowC, dropEvt);
        expect(dropEvt.defaultPrevented).toBe(true);

        expect(reorderSpy).toHaveBeenCalledTimes(1);
        const [calledId, calledIndex] = reorderSpy.mock.calls[0];
        expect(calledId).toBe(idA);
        expect(calledIndex).toBe(2);

        // The Scene is now [B, C, A] — A is topmost.
        expect(store.scene.value.items.map((i) => i.id)).toEqual([
            idB,
            idC,
            idA,
        ]);
    });

    it('reactivity: a non-list mutation (store.addItem) updates the rendered rows in the same render cycle (Req 17.10)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        mountPanel(store);

        // Initially: empty placeholder, zero rows.
        expect(
            container.querySelector('[data-testid="items-list-empty"]'),
        ).not.toBeNull();
        expect(rows()).toHaveLength(0);

        // Mutate via a non-list path.
        let idA: ItemId = '';
        act(() => {
            idA = store.addItem(imageSpec('logo.png'));
        });

        // Empty placeholder is gone; the new row is rendered with the
        // expected label and id — no manual subscribe needed.
        expect(
            container.querySelector('[data-testid="items-list-empty"]'),
        ).toBeNull();
        const after1 = rows();
        expect(after1).toHaveLength(1);
        expect(after1[0].getAttribute('data-item-id')).toBe(idA);
        expect(labelTextOf(after1[0])).toBe('Image: logo.png');

        // A second non-list mutation also flows through.
        let idB: ItemId = '';
        act(() => {
            idB = store.addItem(textSpec('hi'));
        });
        const after2 = rows();
        expect(after2).toHaveLength(2);
        // Reversed order: most recent = topmost = list index 0.
        expect(after2[0].getAttribute('data-item-id')).toBe(idB);
        expect(after2[1].getAttribute('data-item-id')).toBe(idA);
        expect(labelTextOf(after2[0])).toBe('Text: hi');
    });
});
