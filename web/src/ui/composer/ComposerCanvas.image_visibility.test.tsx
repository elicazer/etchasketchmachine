/**
 * Regression test for the "added image does not appear on the composer
 * canvas" bug (even though text added through the same path is visible).
 *
 * End-to-end repro: drive the IMAGE commit path through the real
 * {@link AddItemMenu} modal into a real {@link createSceneStore} built with
 * the *production* `envelopeMm` option (App.tsx constructs the store with
 * `envelopeMm: DRAWABLE_MM`), committing a realistic PIXEL-space polyline
 * set (a ~698×738 bounding box with several multi-point polylines, like the
 * CV service's contour output). Then render the {@link ComposerCanvas}
 * against the same store and assert the image is actually drawable.
 *
 * Hypotheses checked (see task notes):
 *   1. Fit-transform / envelope mismatch → item placed off the canvas
 *      viewBox. Verified by `itemBoundingBox` landing inside the envelope.
 *   2. Commit wiring → verified by the item reaching `store.scene`.
 *   4. compose skipping <2-point polylines → verified `composed` is
 *      non-empty.
 *
 * The remaining failure mode is rendering: the content `<polyline>` stroke
 * width is authored in the item's LOCAL (pre-transform) units, so it is
 * multiplied by the item's transform scale. A pixel-space image is fit to
 * the envelope by heavily *down*-scaling it (≈0.1×), which collapses the
 * rendered stroke to a sub-pixel hairline — present in the DOM and inside
 * the envelope, but invisible. Text is authored small and is *up*-scaled by
 * the same fit transform, so its stroke is fat and clearly visible, masking
 * the bug.
 *
 * @see web/src/ui/composer/ComposerCanvas.tsx
 * @see web/src/composer/scene_store.ts (computeFitTransform)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerCanvas } from './ComposerCanvas';
import { AddItemMenu } from './AddItemMenu';
import { createSceneStore } from '../../composer/scene_store';
import { itemBoundingBox } from '../../composer/compose';
import { DRAWABLE_MM } from '../../constants';
import type { ScenePersistence } from '../../composer/persistence';
import type { Image_Item, Scene } from '../../composer/types';
import type { Polyline } from '../../types';

// -----------------------------------------------------------------------------
// Harness
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

function clickByTestId(testid: string): void {
    const el = q(testid);
    if (el === null) throw new Error(`element not found: ${testid}`);
    act(() => {
        el.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
}

// -----------------------------------------------------------------------------
// Realistic CV-service-shaped image polylines: a ~698×738 px bounding box
// with several multi-point polylines (≥2 points each, so composeScene keeps
// them).
// -----------------------------------------------------------------------------

const IMAGE_W = 698;
const IMAGE_H = 738;

function makeImagePolylines(): Polyline[] {
    const polys: Polyline[] = [];
    // Outer contour (closed rectangle around the full pixel bbox).
    polys.push([
        { x: 0, y: 0 },
        { x: IMAGE_W, y: 0 },
        { x: IMAGE_W, y: IMAGE_H },
        { x: 0, y: IMAGE_H },
        { x: 0, y: 0 },
    ]);
    // A handful of interior zigzag contours spanning the bbox.
    for (let r = 1; r <= 8; r++) {
        const y = (IMAGE_H * r) / 9;
        const line: Polyline = [];
        for (let c = 0; c <= 15; c++) {
            const x = (IMAGE_W * c) / 15;
            line.push({ x, y: y + (c % 2 === 0 ? 0 : 12) });
        }
        polys.push(line);
    }
    return polys;
}

const IMAGE_SOURCE: Image_Item['source'] = {
    filename: 'portrait.png',
    sizeBytes: 204_800,
};

/**
 * Injectable image panel that commits the supplied pixel-space polylines.
 * Mirrors the production commit shape (`onCommit(polylines, source)`),
 * which routes through `store.addItem({ kind: 'image', ... })`.
 */
function makeImageCommitPanel(polylines: Polyline[]) {
    return function MockImagePanel(props: {
        onCommit: (polylines: Polyline[], source: Image_Item['source']) => void;
        onCancel: () => void;
    }) {
        return (
            <div data-testid="mock-image-body">
                <button
                    type="button"
                    data-testid="mock-image-commit"
                    onClick={() => props.onCommit(polylines, IMAGE_SOURCE)}
                >
                    commit
                </button>
            </div>
        );
    };
}

// -----------------------------------------------------------------------------
// Rendering helpers
// -----------------------------------------------------------------------------

/** Parse the uniform-ish scale out of a `translate(..) rotate(..) scale(sx sy)`. */
function parseScale(transformAttr: string): { sx: number; sy: number } {
    const m = /scale\(\s*([-\d.eE]+)(?:[ ,]+([-\d.eE]+))?\s*\)/.exec(transformAttr);
    if (m === null) return { sx: 1, sy: 1 };
    const sx = Number(m[1]);
    const sy = m[2] !== undefined ? Number(m[2]) : sx;
    return { sx, sy };
}

function attr(el: Element, ...names: string[]): string | null {
    for (const n of names) {
        const v = el.getAttribute(n);
        if (v !== null) return v;
    }
    return null;
}

/**
 * Effective on-screen stroke width of a content polyline in viewBox units.
 * When `vector-effect: non-scaling-stroke` is set the stroke is constant
 * regardless of the item transform; otherwise it is multiplied by the
 * item's transform scale (the bug).
 */
function effectiveStroke(poly: SVGPolylineElement, itemScale: number): number {
    const sw = Number(attr(poly, 'stroke-width', 'strokeWidth'));
    const ve = attr(poly, 'vector-effect', 'vectorEffect');
    return ve === 'non-scaling-stroke' ? sw : sw * Math.abs(itemScale);
}

// -----------------------------------------------------------------------------
// Test
// -----------------------------------------------------------------------------

describe('ComposerCanvas — added image is visible (regression)', () => {
    it('an image committed at raw pixel scale lands inside the envelope AND renders with a visible (non-hairline) stroke', () => {
        const store = createSceneStore({
            persistence: makeMemoryPersistence(),
            // Production wiring: App.tsx builds the store with the drawable
            // envelope so pixel-space imports are fit-to-envelope on add.
            envelopeMm: { w: DRAWABLE_MM.w, h: DRAWABLE_MM.h },
        });

        const polylines = makeImagePolylines();

        // --- Drive the IMAGE commit path end-to-end through the modal. ---
        act(() => {
            render(
                <AddItemMenu
                    store={store}
                    panels={{ image: makeImageCommitPanel(polylines) }}
                />,
                container,
            );
        });
        clickByTestId('add-item-image');
        clickByTestId('mock-image-commit');

        // (1) The new image item is in the scene.
        const items = store.scene.value.items;
        expect(items).toHaveLength(1);
        expect(items[0].kind).toBe('image');

        // (4) composeScene output is non-empty (no <2-point drops swallowed
        //     the whole image).
        expect(store.composed.value.length).toBeGreaterThan(0);

        // (1, hypothesis) The fit transform placed the transformed bbox
        //     fully INSIDE the drawable envelope — it is NOT off-canvas.
        const bbox = itemBoundingBox(items[0]);
        expect(bbox.minX).toBeGreaterThanOrEqual(0);
        expect(bbox.minY).toBeGreaterThanOrEqual(0);
        expect(bbox.maxX).toBeLessThanOrEqual(DRAWABLE_MM.w);
        expect(bbox.maxY).toBeLessThanOrEqual(DRAWABLE_MM.h);

        // --- Render the canvas against the same store. ---
        act(() => {
            render(null, container);
        });
        act(() => {
            render(
                <ComposerCanvas store={store} envelopeMm={DRAWABLE_MM} />,
                container,
            );
        });

        const g = container.querySelector<SVGGElement>(
            'g[data-kind="image"]',
        );
        expect(g).not.toBeNull();
        const { sx } = parseScale(g!.getAttribute('transform') ?? '');
        // Sanity: the pixel-space image really is heavily down-scaled to fit.
        expect(sx).toBeLessThan(0.3);

        const polys = Array.from(
            g!.querySelectorAll<SVGPolylineElement>('polyline'),
        );
        expect(polys.length).toBeGreaterThan(0);

        // Reference: the dashed envelope rectangle's stroke width is the
        // "visible at this zoom" yardstick. The image's content lines sit in
        // the same viewBox, so a line < 1/4 of the envelope stroke is a
        // sub-pixel hairline — present but invisible (the reported bug).
        const envelope = q('composer-canvas-envelope');
        const envelopeStroke = Number(
            attr(envelope!, 'stroke-width', 'strokeWidth'),
        );
        const minVisible = envelopeStroke / 4;

        for (const poly of polys) {
            const eff = effectiveStroke(poly, sx);
            expect(eff).toBeGreaterThanOrEqual(minVisible);
        }
    });
});
