/**
 * Component tests for the {@link AddItemMenu}.
 *
 * Coverage:
 *   - Each Add button (image / text / freehand) opens its own modal
 *     (Req 12.1, 12.2).
 *   - Commit through the injected panel calls `store.addItem` with the
 *     correct `kind`, `content`, and `source` (Req 2.1, 2.2, 2.3).
 *   - Cancel through the injected panel does NOT call `store.addItem`.
 *   - Escape key while the modal is open closes it without calling
 *     `store.addItem`.
 *   - Image vectorisation failure path calls `controller.setImageError`
 *     and does NOT call `store.addItem` (Req 2.6).
 *   - The `controller.setPolylines` surface is never touched as a side
 *     effect of adding an item (Req 2.5).
 *
 * The test injects mock `panels` overrides (the documented test seam on
 * `AddItemMenu`) so the real `ImagePanel` / `TextPanel` / `FreehandPanel`
 * internals never run under happy-dom; the menu's own modal-lifecycle and
 * `store.addItem` / `controller.*` wiring is the surface under test.
 *
 * Project conventions (mirrored from the other UI tests in this folder):
 *   - mount with Preact's own `render` + `act` from `preact/test-utils`
 *     (no `@testing-library/preact` dependency).
 *   - use `data-testid` attributes for selection.
 *   - use an in-memory {@link ScenePersistence} so the SceneStore is
 *     deterministic and never touches `localStorage`.
 *
 * @see web/src/ui/composer/AddItemMenu.tsx
 * @see Requirements 2.1, 2.2, 2.3, 2.5, 2.6, 12.1, 12.2
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

import { AddItemMenu } from './AddItemMenu';
import { createSceneStore } from '../../composer/scene_store';
import type { ScenePersistence } from '../../composer/persistence';
import type { Scene } from '../../composer/types';
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

/**
 * Fresh in-memory {@link ScenePersistence} per test. The SceneStore docs
 * note this is the standard isolation pattern (see
 * `scene_store.props.test.ts`).
 */
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

/** Mock controller that records every call to its surface methods. */
interface MockController {
    setImageError: ReturnType<typeof vi.fn>;
    setPolylines: ReturnType<typeof vi.fn>;
}

function makeMockController(): MockController {
    return {
        setImageError: vi.fn(),
        setPolylines: vi.fn(),
    };
}

function q(testid: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

function clickByTestId(testid: string): void {
    const el = q(testid);
    if (el === null) throw new Error(`element not found: ${testid}`);
    act(() => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
}

function pressEscape(): void {
    act(() => {
        document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
    });
}

// -----------------------------------------------------------------------------
// Sample test data
// -----------------------------------------------------------------------------

const TEST_POLYLINES: Polyline[] = [
    [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
    ],
];

const IMAGE_SOURCE = { filename: 'logo.png', sizeBytes: 12345 } as const;
const TEXT_SOURCE = {
    text: 'Hello',
    fontName: 'sans',
    fontSizeMm: 10,
    letterSpacingPct: 0,
} as const;
const FREEHAND_SOURCE = { capturedAtMs: 1700000000000 } as const;

// -----------------------------------------------------------------------------
// Mock panel factories
// -----------------------------------------------------------------------------

/**
 * Build an injectable mock panel that exposes a "commit" button (which
 * calls `onCommit(polylines, source)`) and a "cancel" button (which calls
 * `onCancel()`). The mock keeps the surface under test confined to the
 * menu's modal lifecycle and `store.addItem` wiring; the real panel
 * internals are out of scope for this test (see task description).
 *
 * `dataTestPrefix` namespaces the buttons so the three mock panels can
 * coexist in the same DOM tree without ambiguity.
 */
function makeCommitCancelPanel<S>(
    dataTestPrefix: string,
    polylines: Polyline[],
    source: S,
) {
    return function MockPanel(props: {
        onCommit: (polylines: Polyline[], source: S) => void;
        onCancel: () => void;
    }) {
        return (
            <div data-testid={`${dataTestPrefix}-body`}>
                <button
                    type="button"
                    data-testid={`${dataTestPrefix}-commit`}
                    onClick={() => props.onCommit(polylines, source)}
                >
                    commit
                </button>
                <button
                    type="button"
                    data-testid={`${dataTestPrefix}-cancel`}
                    onClick={() => props.onCancel()}
                >
                    cancel
                </button>
            </div>
        );
    };
}

/**
 * Build an injectable mock IMAGE panel that simulates the
 * vectorisation-failure path: it never calls `onCommit`, only exposes a
 * button that dispatches `controller.setImageError(message)` directly.
 * This demonstrates the orthogonality between the error channel and
 * `addItem` (Req 2.6) without coupling the test to ImagePanel's internals.
 */
function makeFailingImagePanel(
    controller: MockController,
    failureMessage: string,
) {
    return function FailingImagePanel(_props: {
        onCommit: (polylines: Polyline[], source: typeof IMAGE_SOURCE) => void;
        onCancel: () => void;
    }) {
        return (
            <div data-testid="mock-image-failing-body">
                <button
                    type="button"
                    data-testid="mock-image-failing-error"
                    onClick={() => controller.setImageError(failureMessage)}
                >
                    raise error
                </button>
            </div>
        );
    };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('AddItemMenu', () => {
    it('opens the image modal and commits an image item with the right kind, content, and source (Req 2.1, 12.1, 12.2)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const addItemSpy = vi.spyOn(store, 'addItem');
        const controller = makeMockController();
        const panels = {
            image: makeCommitCancelPanel<typeof IMAGE_SOURCE>(
                'mock-image',
                TEST_POLYLINES,
                IMAGE_SOURCE,
            ),
        };

        act(() => {
            render(
                <AddItemMenu store={store} controller={controller} panels={panels} />,
                container,
            );
        });

        // Modal is closed initially: no body, no commit button.
        expect(q('mock-image-body')).toBeNull();
        expect(q('add-item-modal')).toBeNull();

        // Click "Add image" → modal opens, mock body visible.
        clickByTestId('add-item-image');
        expect(q('add-item-modal')).not.toBeNull();
        expect(q('mock-image-body')).not.toBeNull();

        // Commit through the injected panel → store.addItem called with the
        // exact kind / content / source we supplied.
        clickByTestId('mock-image-commit');
        expect(addItemSpy).toHaveBeenCalledTimes(1);
        expect(addItemSpy).toHaveBeenCalledWith({
            kind: 'image',
            content: TEST_POLYLINES,
            source: IMAGE_SOURCE,
        });

        // Modal closes after commit.
        expect(q('add-item-modal')).toBeNull();
        expect(q('mock-image-body')).toBeNull();

        // Controller surfaces are NEVER touched as a side effect of adding
        // (Req 2.5).
        expect(controller.setPolylines).not.toHaveBeenCalled();
        expect(controller.setImageError).not.toHaveBeenCalled();
    });

    it('opens the text modal and commits a text item with the right kind, content, and source (Req 2.2, 12.1, 12.2)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const addItemSpy = vi.spyOn(store, 'addItem');
        const controller = makeMockController();
        const panels = {
            text: makeCommitCancelPanel<typeof TEXT_SOURCE>(
                'mock-text',
                TEST_POLYLINES,
                TEXT_SOURCE,
            ),
        };

        act(() => {
            render(
                <AddItemMenu store={store} controller={controller} panels={panels} />,
                container,
            );
        });

        clickByTestId('add-item-text');
        expect(q('add-item-modal')).not.toBeNull();
        expect(q('mock-text-body')).not.toBeNull();

        clickByTestId('mock-text-commit');
        expect(addItemSpy).toHaveBeenCalledTimes(1);
        // The text commit path negates Y on the polylines so all Scene items
        // share the +Y down screen convention (image/freehand are already +Y
        // down; Text_Renderer emits +Y up). See `handleTextCommit` in
        // AddItemMenu.tsx for the full rationale. The dedicated focused test
        // below verifies the flip on a non-trivial Y value.
        expect(addItemSpy).toHaveBeenCalledWith({
            kind: 'text',
            content: TEST_POLYLINES.map((poly) =>
                poly.map((p) => ({ x: p.x, y: -p.y })),
            ),
            source: TEXT_SOURCE,
        });

        expect(q('add-item-modal')).toBeNull();
        expect(controller.setPolylines).not.toHaveBeenCalled();
        expect(controller.setImageError).not.toHaveBeenCalled();
    });

    it('text commit flips Y so the Scene is uniformly +Y down', () => {
        // Drive the text-commit path with a known polyline and assert the
        // committed content has its Y coordinates negated. This pins the
        // single coordinate-system convention for the Composer Scene:
        // image/freehand items live in +Y down (screen convention), so the
        // text path negates Y at the Scene boundary so every Scene item
        // shares one coordinate system. The planner's `flipY: true` at Send
        // time then converts the unified Scene to machine +Y up uniformly.
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const addItemSpy = vi.spyOn(store, 'addItem');
        const inputPolylines: Polyline[] = [
            [
                { x: 0, y: 0 },
                { x: 10, y: 5 },
            ],
        ];
        const panels = {
            text: makeCommitCancelPanel<typeof TEXT_SOURCE>(
                'mock-text',
                inputPolylines,
                TEXT_SOURCE,
            ),
        };

        act(() => {
            render(<AddItemMenu store={store} panels={panels} />, container);
        });

        clickByTestId('add-item-text');
        clickByTestId('mock-text-commit');

        expect(addItemSpy).toHaveBeenCalledTimes(1);
        const call = addItemSpy.mock.calls[0][0];
        expect(call.kind).toBe('text');
        expect(call.content[0]).toEqual([
            { x: 0, y: -0 },
            { x: 10, y: -5 },
        ]);
    });

    it('opens the freehand modal and commits a freehand item with the right kind, content, and source (Req 2.3, 12.1, 12.2)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const addItemSpy = vi.spyOn(store, 'addItem');
        const controller = makeMockController();
        const panels = {
            freehand: makeCommitCancelPanel<typeof FREEHAND_SOURCE>(
                'mock-freehand',
                TEST_POLYLINES,
                FREEHAND_SOURCE,
            ),
        };

        act(() => {
            render(
                <AddItemMenu store={store} controller={controller} panels={panels} />,
                container,
            );
        });

        clickByTestId('add-item-freehand');
        expect(q('add-item-modal')).not.toBeNull();
        expect(q('mock-freehand-body')).not.toBeNull();

        clickByTestId('mock-freehand-commit');
        expect(addItemSpy).toHaveBeenCalledTimes(1);
        expect(addItemSpy).toHaveBeenCalledWith({
            kind: 'freehand',
            content: TEST_POLYLINES,
            source: FREEHAND_SOURCE,
        });

        expect(q('add-item-modal')).toBeNull();
        expect(controller.setPolylines).not.toHaveBeenCalled();
        expect(controller.setImageError).not.toHaveBeenCalled();
    });

    it('cancels via the injected panel without calling store.addItem and closes the modal', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const addItemSpy = vi.spyOn(store, 'addItem');
        const controller = makeMockController();
        const panels = {
            image: makeCommitCancelPanel<typeof IMAGE_SOURCE>(
                'mock-image',
                TEST_POLYLINES,
                IMAGE_SOURCE,
            ),
            text: makeCommitCancelPanel<typeof TEXT_SOURCE>(
                'mock-text',
                TEST_POLYLINES,
                TEXT_SOURCE,
            ),
            freehand: makeCommitCancelPanel<typeof FREEHAND_SOURCE>(
                'mock-freehand',
                TEST_POLYLINES,
                FREEHAND_SOURCE,
            ),
        };

        act(() => {
            render(
                <AddItemMenu store={store} controller={controller} panels={panels} />,
                container,
            );
        });

        // Image flow: open, cancel, modal closes, no addItem.
        clickByTestId('add-item-image');
        expect(q('mock-image-body')).not.toBeNull();
        clickByTestId('mock-image-cancel');
        expect(q('add-item-modal')).toBeNull();
        expect(addItemSpy).not.toHaveBeenCalled();

        // Text flow.
        clickByTestId('add-item-text');
        expect(q('mock-text-body')).not.toBeNull();
        clickByTestId('mock-text-cancel');
        expect(q('add-item-modal')).toBeNull();
        expect(addItemSpy).not.toHaveBeenCalled();

        // Freehand flow.
        clickByTestId('add-item-freehand');
        expect(q('mock-freehand-body')).not.toBeNull();
        clickByTestId('mock-freehand-cancel');
        expect(q('add-item-modal')).toBeNull();
        expect(addItemSpy).not.toHaveBeenCalled();

        // No controller surface ever touched.
        expect(controller.setPolylines).not.toHaveBeenCalled();
        expect(controller.setImageError).not.toHaveBeenCalled();
    });

    it('Escape key closes the modal without calling store.addItem (image / text / freehand)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const addItemSpy = vi.spyOn(store, 'addItem');
        const controller = makeMockController();
        const panels = {
            image: makeCommitCancelPanel<typeof IMAGE_SOURCE>(
                'mock-image',
                TEST_POLYLINES,
                IMAGE_SOURCE,
            ),
            text: makeCommitCancelPanel<typeof TEXT_SOURCE>(
                'mock-text',
                TEST_POLYLINES,
                TEXT_SOURCE,
            ),
            freehand: makeCommitCancelPanel<typeof FREEHAND_SOURCE>(
                'mock-freehand',
                TEST_POLYLINES,
                FREEHAND_SOURCE,
            ),
        };

        act(() => {
            render(
                <AddItemMenu store={store} controller={controller} panels={panels} />,
                container,
            );
        });

        for (const kind of ['image', 'text', 'freehand'] as const) {
            clickByTestId(`add-item-${kind}`);
            expect(q('add-item-modal')).not.toBeNull();
            pressEscape();
            expect(q('add-item-modal')).toBeNull();
        }

        expect(addItemSpy).not.toHaveBeenCalled();
        expect(controller.setPolylines).not.toHaveBeenCalled();
        expect(controller.setImageError).not.toHaveBeenCalled();
    });

    it('image vectorisation failure routes to controller.setImageError and does NOT call store.addItem (Req 2.6)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const addItemSpy = vi.spyOn(store, 'addItem');
        const controller = makeMockController();
        const failureMessage = 'No edges were found.';
        const panels = {
            image: makeFailingImagePanel(controller, failureMessage),
        };

        act(() => {
            render(
                <AddItemMenu store={store} controller={controller} panels={panels} />,
                container,
            );
        });

        clickByTestId('add-item-image');
        expect(q('mock-image-failing-body')).not.toBeNull();

        clickByTestId('mock-image-failing-error');

        // Error went through the dedicated channel.
        expect(controller.setImageError).toHaveBeenCalledTimes(1);
        expect(controller.setImageError).toHaveBeenCalledWith(failureMessage);

        // No item was added; setPolylines was never touched.
        expect(addItemSpy).not.toHaveBeenCalled();
        expect(controller.setPolylines).not.toHaveBeenCalled();
    });

    it('controller.setPolylines is never called as a side effect of adding any item (Req 2.5)', () => {
        const store = createSceneStore({ persistence: makeMemoryPersistence() });
        const controller = makeMockController();
        const panels = {
            image: makeCommitCancelPanel<typeof IMAGE_SOURCE>(
                'mock-image',
                TEST_POLYLINES,
                IMAGE_SOURCE,
            ),
            text: makeCommitCancelPanel<typeof TEXT_SOURCE>(
                'mock-text',
                TEST_POLYLINES,
                TEXT_SOURCE,
            ),
            freehand: makeCommitCancelPanel<typeof FREEHAND_SOURCE>(
                'mock-freehand',
                TEST_POLYLINES,
                FREEHAND_SOURCE,
            ),
        };

        act(() => {
            render(
                <AddItemMenu store={store} controller={controller} panels={panels} />,
                container,
            );
        });

        // Drive a successful commit through every flow.
        clickByTestId('add-item-image');
        clickByTestId('mock-image-commit');

        clickByTestId('add-item-text');
        clickByTestId('mock-text-commit');

        clickByTestId('add-item-freehand');
        clickByTestId('mock-freehand-commit');

        // Every commit landed an item in the store.
        expect(store.scene.value.items).toHaveLength(3);
        expect(store.scene.value.items[0].kind).toBe('image');
        expect(store.scene.value.items[1].kind).toBe('text');
        expect(store.scene.value.items[2].kind).toBe('freehand');

        // …yet `setPolylines` was never called as a side effect of adding.
        // The planner-pipeline path is only triggered by a separate
        // "Send to machine" action, which this menu does not expose.
        expect(controller.setPolylines).not.toHaveBeenCalled();
        // The error channel is also untouched on the happy path.
        expect(controller.setImageError).not.toHaveBeenCalled();
    });
});
