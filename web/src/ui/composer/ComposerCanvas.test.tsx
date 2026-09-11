/**
 * Component tests for the {@link ComposerCanvas}.
 *
 * Coverage:
 *   - Selection by click; topmost wins for overlapping items (Property 6 —
 *     hit-test selects the topmost item, validates Requirements 3.1, 3.2,
 *     3.4); empty-canvas click clears selection.
 *   - Pointer-drag dispatches translate (Req 4.1, 4.2); corner-drag
 *     dispatches resize with the opposite corner fixed (Req 5.1); rotation
 *     handle dispatches rotation (Req 6.1); Shift triggers aspect-lock
 *     (Req 5.3) and 15° snap (Req 6.3); Backspace/Delete removes the
 *     selected item (Req 7.1).
 *   - Keyboard: arrow / Shift+arrow translation (Req 8.1, 8.2),
 *     `+`/`-` scale (Req 8.3, 8.4), `[`/`]` rotation by 15° (Req 8.5, 8.6).
 *   - Selection overlay carries an accessible `aria-label` per item type
 *     (Req 8.7).
 *
 * The store is built with `createSceneStore` and seeded via an in-memory
 * persistence stand-in, so every test drives the canvas through the same
 * reactive signals the production app uses. Synthetic `Item`s are placed
 * into the seed Scene directly (rather than `addItem` + `updateTransform`
 * sequences) so the SceneStore's history starts in a known state.
 *
 * jsdom has no SVG layout engine and `getBoundingClientRect` returns a
 * zero-size box by default. We mock the SVG surface's bounding rect to
 * align with its viewBox so client-coord pointer events map deterministically
 * onto scene coordinates: `clientX = sceneX + margin`. `getScreenCTM` is
 * forced to `null` so the implementation's manual viewBox-mapping fallback
 * runs.
 *
 * Project test conventions (mirrored from `AddItemMenu.test.tsx` and
 * `ImagePanel.test.tsx`):
 *   - mount with Preact's `render` + `act` (no `@testing-library/preact`);
 *   - select via `data-testid` attributes;
 *   - in-memory `ScenePersistence` so the store never touches localStorage.
 *
 * @see web/src/ui/composer/ComposerCanvas.tsx
 * @see web/src/composer/scene_store.ts
 * @see Requirements 3.1, 3.2, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1, 6.3,
 *      7.1, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 * @see Property 6 (`design.md` §"Correctness Properties")
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerCanvas } from './ComposerCanvas';
import { createSceneStore } from '../../composer/scene_store';
import type { ScenePersistence } from '../../composer/persistence';
import type {
    Freehand_Item,
    Image_Item,
    Item,
    Scene,
    Text_Item,
    Transform,
} from '../../composer/types';
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
    vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// Geometry constants
// -----------------------------------------------------------------------------

/**
 * Test-wide envelope. Picked square so margin = `envW * 0.15 = 15` is
 * uniform on both axes; the resulting viewBox is `(-15, -15, 130, 130)`.
 */
const ENV = { w: 100, h: 100 } as const;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * In-memory persistence so the SceneStore never touches localStorage and
 * starts from the supplied seed Scene.
 */
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

/**
 * Mount `ComposerCanvas` against the supplied store and patch the SVG
 * surface so its layout-rect aligns with its viewBox (jsdom has no SVG
 * layout). After this returns, client-pointer coordinates map directly
 * onto scene coordinates via `clientX = sceneX + MARGIN`,
 * `clientY = sceneY + MARGIN`.
 */
function mount(store: ReturnType<typeof createSceneStore>): void {
    act(() => {
        render(<ComposerCanvas store={store} envelopeMm={ENV} />, container);
    });
    const svg = surface();
    // Stub the SVG's layout/CTM API so the manual `clientToScene` fallback
    // produces predictable scene coordinates. jsdom doesn't implement SVG
    // layout: `getBoundingClientRect` returns a 0×0 box (which the
    // implementation reads as "no layout, ignore the event") and
    // `getScreenCTM` is undefined entirely. We assign these directly
    // (rather than `vi.spyOn`) because spying on a missing method throws.
    //
    // The patched rect is anchored at `(0, 0)`. jsdom does not populate
    // `SVGSVGElement.viewBox.baseVal` from the rendered `viewBox`
    // attribute, so the implementation lands on its no-viewBox fallback
    // `{ x: clientX - rect.left, y: clientY - rect.top }` — i.e. scene
    // coordinates equal client coordinates one-to-one. See
    // `clientFromScene`.
    const stubRect = (): DOMRect =>
        ({
            left: 0,
            top: 0,
            right: 130,
            bottom: 130,
            width: 130,
            height: 130,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }) as DOMRect;
    Object.defineProperty(svg, 'getBoundingClientRect', {
        configurable: true,
        value: stubRect,
    });
    Object.defineProperty(svg, 'getScreenCTM', {
        configurable: true,
        value: () => null,
    });
}

function surface(): SVGSVGElement {
    const el = container.querySelector<SVGSVGElement>(
        '[data-testid="composer-canvas-surface"]',
    );
    if (el === null) throw new Error('canvas surface not found');
    return el;
}

function selectionGroup(): SVGElement | null {
    return container.querySelector<SVGElement>(
        '[data-testid="composer-canvas-selection"]',
    );
}

function handleEl(handle: string): SVGElement {
    const el = container.querySelector<SVGElement>(
        `[data-testid="composer-canvas-handle"][data-handle="${handle}"]`,
    );
    if (el === null) throw new Error(`handle not found: ${handle}`);
    return el;
}

/**
 * Convert a scene-units point into the client coordinates the SVG handler
 * expects.
 *
 * jsdom does not populate `SVGSVGElement.viewBox.baseVal` from the
 * `viewBox` attribute (it has no SVG layout engine). The implementation's
 * `clientToScene` falls through its CTM and viewBox-mapping branches and
 * lands on the no-viewBox fallback, which is `{ x: clientX - rect.left,
 * y: clientY - rect.top }`. With our patched rect anchored at `(0, 0)`
 * the mapping reduces to the identity: `clientX = sceneX`,
 * `clientY = sceneY`. (See {@link mount}.)
 */
function clientFromScene(p: { x: number; y: number }): {
    clientX: number;
    clientY: number;
} {
    return { clientX: p.x, clientY: p.y };
}

/**
 * jsdom does not implement pointer-event DOM properties (`onpointerdown`
 * et al. are not present on `Element`). Preact 10's prop-to-event-name
 * adapter detects this and falls back to registering the JSX
 * `onPointerDown={…}` handler under the original case-preserved event
 * name (`PointerDown`), instead of the lowercase form a real browser
 * would dispatch. Tests therefore dispatch under the same case-preserved
 * name so the listener actually fires. (Compare `FreehandPanel.tsx`,
 * which routes around this with imperative `addEventListener`.)
 */
const POINTER_EVENT_NAMES: Record<
    'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    string
> = {
    pointerdown: 'PointerDown',
    pointermove: 'PointerMove',
    pointerup: 'PointerUp',
    pointercancel: 'PointerCancel',
};

/**
 * Dispatch a synthetic pointer event. jsdom lacks a native `PointerEvent`
 * constructor, so we build a `MouseEvent` and tag on the `pointerId` field
 * the implementation reads. Mirrors the helper in `FreehandPanel.test.tsx`.
 */
function dispatchPointer(
    target: Element,
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    opts: {
        scene?: { x: number; y: number };
        client?: { clientX: number; clientY: number };
        shiftKey?: boolean;
        button?: number;
        pointerId?: number;
    },
): void {
    const { clientX, clientY } =
        opts.client ?? clientFromScene(opts.scene ?? { x: 0, y: 0 });
    const evt = new MouseEvent(POINTER_EVENT_NAMES[type], {
        bubbles: true,
        cancelable: true,
        button: opts.button ?? 0,
        clientX,
        clientY,
        shiftKey: opts.shiftKey ?? false,
    }) as MouseEvent & { pointerId?: number };
    evt.pointerId = opts.pointerId ?? 1;
    act(() => {
        target.dispatchEvent(evt);
    });
}

function dispatchKey(
    key: string,
    opts: { shiftKey?: boolean } = {},
): void {
    const svg = surface();
    const evt = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        shiftKey: opts.shiftKey ?? false,
    });
    act(() => {
        svg.dispatchEvent(evt);
    });
}

// -----------------------------------------------------------------------------
// Synthetic items
// -----------------------------------------------------------------------------

const IDENTITY: Transform = { x: 0, y: 0, sx: 1, sy: 1, rotationRad: 0 };

/** Square content polyline centred on `(0, 0)` with half-extent `r`. */
function squareContent(r: number): Polyline[] {
    return [
        [
            { x: -r, y: -r },
            { x: r, y: -r },
            { x: r, y: r },
            { x: -r, y: r },
            { x: -r, y: -r },
        ],
    ];
}

/** Rectangle content polyline centred on `(0, 0)` with half-extents `(rx, ry)`. */
function rectContent(rx: number, ry: number): Polyline[] {
    return [
        [
            { x: -rx, y: -ry },
            { x: rx, y: -ry },
            { x: rx, y: ry },
            { x: -rx, y: ry },
            { x: -rx, y: -ry },
        ],
    ];
}

function imageItem(
    id: string,
    transform: Transform,
    content: Polyline[],
    filename = 'logo.png',
): Image_Item {
    return {
        id,
        kind: 'image',
        transform,
        content,
        source: { filename, sizeBytes: 1024 },
    };
}

function textItem(
    id: string,
    transform: Transform,
    content: Polyline[],
    text = 'Hello',
): Text_Item {
    return {
        id,
        kind: 'text',
        transform,
        content,
        source: { text, fontName: 'sans', fontSizeMm: 10, letterSpacingPct: 0 },
    };
}

function freehandItem(
    id: string,
    transform: Transform,
    content: Polyline[],
): Freehand_Item {
    return {
        id,
        kind: 'freehand',
        transform,
        content,
        source: { capturedAtMs: 1_700_000_000_000 },
    };
}

function makeStoreWithItems(items: Item[], selectedId: string | null = null) {
    const seed: Scene = { schemaVersion: 1, items, selectedId };
    return createSceneStore({ persistence: makeMemoryPersistence(seed) });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('ComposerCanvas — selection by click', () => {
    it(
        // Feature: unified-composer-canvas, Property 6: hit-test selects the topmost item
        'selects the topmost (highest-index) item under the pointer when items overlap (Property 6, Req 3.1, 3.2)',
        () => {
            // Two items both centred at (50, 50) with half-extent 10; the
            // text item is on top because it occupies the higher index.
            const bottom = imageItem(
                'id-bottom',
                { ...IDENTITY, x: 50, y: 50 },
                squareContent(10),
            );
            const top = textItem(
                'id-top',
                { ...IDENTITY, x: 50, y: 50 },
                squareContent(10),
            );
            const store = makeStoreWithItems([bottom, top]);
            mount(store);

            // Click in the overlap region — both bboxes contain (50, 50).
            dispatchPointer(surface(), 'pointerdown', { scene: { x: 50, y: 50 } });
            dispatchPointer(surface(), 'pointerup', { scene: { x: 50, y: 50 } });

            expect(store.scene.value.selectedId).toBe('id-top');
        },
    );

    it('clicking on a single item selects it (Req 3.1)', () => {
        const item = imageItem(
            'only',
            { ...IDENTITY, x: 50, y: 50 },
            squareContent(10),
        );
        const store = makeStoreWithItems([item]);
        mount(store);

        dispatchPointer(surface(), 'pointerdown', { scene: { x: 50, y: 50 } });
        dispatchPointer(surface(), 'pointerup', { scene: { x: 50, y: 50 } });

        expect(store.scene.value.selectedId).toBe('only');
    });

    it('clicking on empty canvas clears the selection (Req 3.4)', () => {
        const item = imageItem(
            'one',
            { ...IDENTITY, x: 50, y: 50 },
            squareContent(5),
        );
        const store = makeStoreWithItems([item], 'one');
        mount(store);

        // Sanity: the seed selection landed in the live signal.
        expect(store.scene.value.selectedId).toBe('one');

        // Click well outside the item's bbox (which is (45,45)..(55,55)).
        dispatchPointer(surface(), 'pointerdown', { scene: { x: 5, y: 5 } });
        dispatchPointer(surface(), 'pointerup', { scene: { x: 5, y: 5 } });

        expect(store.scene.value.selectedId).toBeNull();
    });

    it('clicking on empty canvas with no selection is a no-op', () => {
        const item = imageItem(
            'a',
            { ...IDENTITY, x: 50, y: 50 },
            squareContent(5),
        );
        const store = makeStoreWithItems([item], null);
        mount(store);

        dispatchPointer(surface(), 'pointerdown', { scene: { x: 5, y: 5 } });
        dispatchPointer(surface(), 'pointerup', { scene: { x: 5, y: 5 } });

        expect(store.scene.value.selectedId).toBeNull();
    });
});

describe('ComposerCanvas — pointer translate gesture', () => {
    it('pointer-drag inside an item translates it (Req 4.1, 4.2)', () => {
        const item = imageItem(
            'mover',
            { ...IDENTITY, x: 50, y: 50 },
            squareContent(10),
        );
        const store = makeStoreWithItems([item]);
        mount(store);

        // Pointer-down inside the item starts a move gesture.
        dispatchPointer(surface(), 'pointerdown', { scene: { x: 50, y: 50 } });
        // Pointer-move to a new scene position.
        dispatchPointer(surface(), 'pointermove', { scene: { x: 70, y: 60 } });
        dispatchPointer(surface(), 'pointerup', { scene: { x: 70, y: 60 } });

        const moved = store.scene.value.items.find((it) => it.id === 'mover');
        if (moved === undefined) throw new Error('item lost');
        // The translate should be: t0.x + (70 - 50) = 70, t0.y + (60 - 50) = 60.
        expect(moved.transform.x).toBeCloseTo(70, 6);
        expect(moved.transform.y).toBeCloseTo(60, 6);
        // Scale and rotation are unchanged by a move gesture (Property 7).
        expect(moved.transform.sx).toBeCloseTo(1, 6);
        expect(moved.transform.sy).toBeCloseTo(1, 6);
        expect(moved.transform.rotationRad).toBeCloseTo(0, 6);
    });
});

describe('ComposerCanvas — corner resize gesture', () => {
    it('drag from BR corner scales with the opposite corner (TL) fixed (Req 5.1)', () => {
        // Item placed at origin so its bbox is (0,0)..(10,10) for clean math.
        const item = imageItem(
            'sizable',
            { x: 5, y: 5, sx: 1, sy: 1, rotationRad: 0 },
            rectContent(5, 5),
        );
        const store = makeStoreWithItems([item], 'sizable');
        mount(store);

        // bbox0 = (0, 0)..(10, 10); BR corner is at (10, 10) — drag it to (20, 30).
        dispatchPointer(handleEl('br'), 'pointerdown', {
            scene: { x: 10, y: 10 },
        });
        dispatchPointer(surface(), 'pointermove', { scene: { x: 20, y: 30 } });
        dispatchPointer(surface(), 'pointerup', { scene: { x: 20, y: 30 } });

        const sized = store.scene.value.items[0];
        // Pivot (TL) at scene (0, 0) should remain fixed; bbox now spans
        // (0, 0)..(20, 30). Width/height ratios drive sx=2, sy=3.
        expect(sized.transform.sx).toBeCloseTo(2, 6);
        expect(sized.transform.sy).toBeCloseTo(3, 6);
        // Translation is rebalanced so the TL pivot at (0, 0) stays fixed:
        // for an item with content centred on (0, 0), x = pivot + half-width-new = 10,
        // y = pivot + half-height-new = 15.
        expect(sized.transform.x).toBeCloseTo(10, 6);
        expect(sized.transform.y).toBeCloseTo(15, 6);
        // Rotation untouched.
        expect(sized.transform.rotationRad).toBeCloseTo(0, 6);
    });

    it('Shift held during corner drag aspect-locks the gesture (Req 5.3)', () => {
        // Asymmetric content so an unlocked drag would change the aspect.
        const item = imageItem(
            'aspect',
            { x: 5, y: 10, sx: 1, sy: 1, rotationRad: 0 },
            rectContent(5, 10),
        );
        const store = makeStoreWithItems([item], 'aspect');
        mount(store);

        // bbox0 = (0, 0)..(10, 20); BR corner at (10, 20). Drag to (20, 30):
        //   rX = (20 - 0) / (1 * 10) = 2
        //   rY = (30 - 0) / (1 * 20) = 1.5
        // Aspect-lock takes the dominant ratio (max abs) and applies it to both
        // axes, so rX = rY = 2 → sx = 2, sy = 2; the aspect ratio sx/sy is 1,
        // which equals t0.sx/t0.sy = 1.
        dispatchPointer(handleEl('br'), 'pointerdown', {
            scene: { x: 10, y: 20 },
            shiftKey: true,
        });
        dispatchPointer(surface(), 'pointermove', {
            scene: { x: 20, y: 30 },
            shiftKey: true,
        });
        dispatchPointer(surface(), 'pointerup', {
            scene: { x: 20, y: 30 },
            shiftKey: true,
        });

        const sized = store.scene.value.items[0];
        // The starting aspect ratio is preserved.
        expect(sized.transform.sx / sized.transform.sy).toBeCloseTo(
            1, // 1 / 1
            6,
        );
        // Both axes scaled by the dominant ratio (2x).
        expect(sized.transform.sx).toBeCloseTo(2, 6);
        expect(sized.transform.sy).toBeCloseTo(2, 6);
    });
});

describe('ComposerCanvas — rotation gesture', () => {
    it('drag rotation handle rotates the item to the pointer angle (Req 6.1)', () => {
        // Item centred at (5, 5) with bbox (0, 0)..(10, 10). Pivot is (5, 5).
        const item = imageItem(
            'spinner',
            { x: 5, y: 5, sx: 1, sy: 1, rotationRad: 0 },
            rectContent(5, 5),
        );
        const store = makeStoreWithItems([item], 'spinner');
        mount(store);

        // Pointerdown on rotation handle at scene (5, 0) — directly above the
        // pivot (5, 5) — angle = atan2(0 - 5, 5 - 5) = -π/2; normalised into
        // [0, 2π) gives 3π/2.
        dispatchPointer(handleEl('rot'), 'pointerdown', {
            scene: { x: 5, y: 0 },
        });
        // Move pointer directly to the right of the pivot — angle 0.
        dispatchPointer(surface(), 'pointermove', { scene: { x: 15, y: 5 } });
        dispatchPointer(surface(), 'pointerup', { scene: { x: 15, y: 5 } });

        const rotated = store.scene.value.items[0];
        expect(rotated.transform.rotationRad).toBeCloseTo(0, 6);
    });

    it('rotation snaps to the nearest 15° increment by default; Shift releases the snap (Req 6.3)', () => {
        const item = imageItem(
            'snap',
            { x: 5, y: 5, sx: 1, sy: 1, rotationRad: 0 },
            rectContent(5, 5),
        );
        const store = makeStoreWithItems([item], 'snap');
        mount(store);

        // Rotation snaps by default (no modifier): the unsnapped angle for
        // pointer (9, 10) about pivot (5, 5) is ≈ 51.3°, which rounds to
        // the nearest 15° → 45° = π/4.
        dispatchPointer(handleEl('rot'), 'pointerdown', {
            scene: { x: 9, y: 10 },
        });
        dispatchPointer(surface(), 'pointerup', {
            scene: { x: 9, y: 10 },
        });

        const snapped = store.scene.value.items[0];
        expect(snapped.transform.rotationRad).toBeCloseTo(Math.PI / 4, 6);

        // Holding Shift releases the snap: the same gesture lands on the raw
        // atan2 angle (≈ 0.8961 rad) instead of being rounded to 15°.
        store.updateTransform('snap', { rotationRad: 0 });
        dispatchPointer(handleEl('rot'), 'pointerdown', {
            scene: { x: 9, y: 10 },
            shiftKey: true,
        });
        dispatchPointer(surface(), 'pointerup', {
            scene: { x: 9, y: 10 },
            shiftKey: true,
        });
        const free = store.scene.value.items[0];
        const expected = Math.atan2(10 - 5, 9 - 5);
        expect(free.transform.rotationRad).toBeCloseTo(expected, 6);
    });
});

describe('ComposerCanvas — Backspace / Delete', () => {
    it('Backspace removes the selected item (Req 7.1)', () => {
        const a = imageItem(
            'a',
            { ...IDENTITY, x: 30, y: 30 },
            squareContent(5),
        );
        const b = imageItem(
            'b',
            { ...IDENTITY, x: 70, y: 70 },
            squareContent(5),
        );
        const store = makeStoreWithItems([a, b], 'a');
        mount(store);

        dispatchKey('Backspace');

        expect(store.scene.value.items.map((it) => it.id)).toEqual(['b']);
        expect(store.scene.value.selectedId).toBeNull();
    });

    it('Delete removes the selected item (Req 7.1, 3.6)', () => {
        const a = imageItem(
            'a',
            { ...IDENTITY, x: 30, y: 30 },
            squareContent(5),
        );
        const b = imageItem(
            'b',
            { ...IDENTITY, x: 70, y: 70 },
            squareContent(5),
        );
        const store = makeStoreWithItems([a, b], 'b');
        mount(store);

        dispatchKey('Delete');

        expect(store.scene.value.items.map((it) => it.id)).toEqual(['a']);
        // Selection clears since the removed item was selected (Req 3.6).
        expect(store.scene.value.selectedId).toBeNull();
    });
});

describe('ComposerCanvas — keyboard transforms', () => {
    function seedSelected(): ReturnType<typeof createSceneStore> {
        const item = imageItem(
            'k',
            { x: 50, y: 50, sx: 2, sy: 4, rotationRad: 0 },
            squareContent(5),
        );
        const store = makeStoreWithItems([item], 'k');
        mount(store);
        return store;
    }

    it('arrow keys translate by 1 scene unit (Req 8.1)', () => {
        const store = seedSelected();
        dispatchKey('ArrowRight');
        dispatchKey('ArrowDown');
        const t = store.scene.value.items[0].transform;
        expect(t.x).toBeCloseTo(51, 6);
        expect(t.y).toBeCloseTo(51, 6);
    });

    it('Shift+arrow translates by 10 scene units (Req 8.2)', () => {
        const store = seedSelected();
        dispatchKey('ArrowLeft', { shiftKey: true });
        dispatchKey('ArrowUp', { shiftKey: true });
        const t = store.scene.value.items[0].transform;
        expect(t.x).toBeCloseTo(40, 6);
        expect(t.y).toBeCloseTo(40, 6);
    });

    it('`+` / `=` multiplies sx and sy by 1.1 (Req 8.3)', () => {
        const store = seedSelected();
        dispatchKey('+');
        const t = store.scene.value.items[0].transform;
        expect(t.sx).toBeCloseTo(2 * 1.1, 6);
        expect(t.sy).toBeCloseTo(4 * 1.1, 6);
    });

    it('`-` divides sx and sy by 1.1 (Req 8.4)', () => {
        const store = seedSelected();
        dispatchKey('-');
        const t = store.scene.value.items[0].transform;
        expect(t.sx).toBeCloseTo(2 / 1.1, 6);
        expect(t.sy).toBeCloseTo(4 / 1.1, 6);
    });

    it('`[` rotates by -15°, `]` rotates by +15° (Req 8.5, 8.6)', () => {
        const store = seedSelected();
        dispatchKey(']');
        // 0 + π/12 = π/12 (in [0, 2π)).
        expect(store.scene.value.items[0].transform.rotationRad).toBeCloseTo(
            Math.PI / 12,
            6,
        );
        dispatchKey('[');
        // π/12 - π/12 = 0.
        expect(store.scene.value.items[0].transform.rotationRad).toBeCloseTo(
            0,
            6,
        );
        dispatchKey('[');
        // 0 - π/12 normalised into [0, 2π) is 2π - π/12 = 23π/12.
        expect(store.scene.value.items[0].transform.rotationRad).toBeCloseTo(
            (23 * Math.PI) / 12,
            6,
        );
    });
});

describe('ComposerCanvas — selection overlay accessibility', () => {
    it('renders no selection overlay when nothing is selected (Req 3.5)', () => {
        const item = imageItem(
            'a',
            { ...IDENTITY, x: 50, y: 50 },
            squareContent(5),
        );
        const store = makeStoreWithItems([item], null);
        mount(store);

        expect(selectionGroup()).toBeNull();
    });

    it('image item exposes "Image item" as the overlay aria-label (Req 8.7)', () => {
        const item = imageItem(
            'a',
            { ...IDENTITY, x: 50, y: 50 },
            squareContent(5),
        );
        const store = makeStoreWithItems([item], 'a');
        mount(store);

        const overlay = selectionGroup();
        expect(overlay).not.toBeNull();
        expect(overlay?.getAttribute('aria-label')).toBe('Image item');
    });

    it('text item exposes "Text item: <text>" as the overlay aria-label (Req 8.7)', () => {
        const item = textItem(
            'a',
            { ...IDENTITY, x: 50, y: 50 },
            squareContent(5),
            'Hello world',
        );
        const store = makeStoreWithItems([item], 'a');
        mount(store);

        const overlay = selectionGroup();
        expect(overlay).not.toBeNull();
        expect(overlay?.getAttribute('aria-label')).toBe('Text item: Hello world');
    });

    it('freehand item exposes "Freehand item" as the overlay aria-label (Req 8.7)', () => {
        const item = freehandItem(
            'a',
            { ...IDENTITY, x: 50, y: 50 },
            squareContent(5),
        );
        const store = makeStoreWithItems([item], 'a');
        mount(store);

        const overlay = selectionGroup();
        expect(overlay).not.toBeNull();
        expect(overlay?.getAttribute('aria-label')).toBe('Freehand item');
    });

    it('selection overlay renders eight resize handles plus one rotation handle', () => {
        const item = imageItem(
            'a',
            { ...IDENTITY, x: 50, y: 50 },
            squareContent(5),
        );
        const store = makeStoreWithItems([item], 'a');
        mount(store);

        const handles = container.querySelectorAll(
            '[data-testid="composer-canvas-handle"]',
        );
        // 8 resize + 1 rotation = 9 total.
        expect(handles).toHaveLength(9);
        expect(handleEl('rot')).not.toBeNull();
        for (const k of ['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br']) {
            expect(handleEl(k)).not.toBeNull();
        }
    });
});
