/**
 * Focused unit test for the {@link flipY} helper used by the text-commit
 * path in {@link AddItemMenu}.
 *
 * Issue 8 (Draw view cleanup): {@link Text_Renderer} emits polylines in +Y
 * up (mm convention) while every other Scene item kind and the
 * {@link ComposerCanvas} SVG live in +Y down (screen convention). Without
 * a flip, text items render upside down on the canvas. This test pins the
 * exact behavior at the Scene boundary: a polyline `[(0,0), (10,5)]` must
 * land in the Item's `content` as `[(0,0), (10,-5)]`.
 *
 * Lives next to `AddItemMenu.test.tsx` per the Issue 8 instructions.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { ComponentType } from 'preact';

import { AddItemMenu, flipY } from './AddItemMenu';
import type { AddItemPanelProps } from './AddItemMenu';
import { createSceneStore } from '../../composer/scene_store';
import type { ScenePersistence } from '../../composer/persistence';
import type { Scene, Text_Item } from '../../composer/types';
import type { Polyline } from '../../types';

// -----------------------------------------------------------------------------
// Pure-helper tests
// -----------------------------------------------------------------------------

describe('flipY', () => {
    it('negates Y on every point and leaves X untouched', () => {
        const input: Polyline[] = [[
            { x: 0, y: 0 },
            { x: 10, y: 5 },
        ]];
        const result = flipY(input);
        expect(result).toEqual([[
            { x: 0, y: -0 },
            { x: 10, y: -5 },
        ]]);
    });

    it('returns fresh arrays — does not mutate the input', () => {
        const input: Polyline[] = [[{ x: 1, y: 2 }]];
        const before = JSON.stringify(input);
        flipY(input);
        expect(JSON.stringify(input)).toBe(before);
    });

    it('handles an empty polyline list and empty polylines', () => {
        expect(flipY([])).toEqual([]);
        expect(flipY([[]])).toEqual([[]]);
    });
});

// -----------------------------------------------------------------------------
// End-to-end through the text-commit path
// -----------------------------------------------------------------------------

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

const TEXT_SOURCE: Text_Item['source'] = {
    text: 'Hi',
    fontName: 'Hershey Simplex',
    fontSizeMm: 12,
    letterSpacingPct: 0,
};

/**
 * Build a minimal mock text panel that fires `onCommit` with the supplied
 * `(polylines, source)` when its `mock-text-commit` button is clicked.
 */
function makeMockTextPanel(
    polylines: Polyline[],
): ComponentType<AddItemPanelProps<Text_Item['source']>> {
    return (props) => (
        <div data-testid="mock-text-body">
            <button
                type="button"
                data-testid="mock-text-commit"
                onClick={() => props.onCommit(polylines, TEXT_SOURCE)}
            >
                commit
            </button>
        </div>
    );
}

describe('AddItemMenu text-commit path applies flipY before store.addItem', () => {
    it('a [{x:0,y:0},{x:10,y:5}] polyline lands as [{x:0,y:0},{x:10,y:-5}] in the resulting Item content', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const store = createSceneStore({
            persistence: makeMemoryPersistence(),
        });
        const addItemSpy = vi.spyOn(store, 'addItem');

        const inputPolylines: Polyline[] = [[
            { x: 0, y: 0 },
            { x: 10, y: 5 },
        ]];

        const panels = { text: makeMockTextPanel(inputPolylines) };
        try {
            act(() => {
                render(
                    <AddItemMenu store={store} panels={panels} />,
                    container,
                );
            });
            act(() => {
                container
                    .querySelector<HTMLButtonElement>(
                        '[data-testid="add-item-text"]',
                    )!
                    .click();
            });
            act(() => {
                container
                    .querySelector<HTMLButtonElement>(
                        '[data-testid="mock-text-commit"]',
                    )!
                    .click();
            });

            expect(addItemSpy).toHaveBeenCalledTimes(1);
            const arg = addItemSpy.mock.calls[0][0];
            expect(arg.kind).toBe('text');
            expect(arg.content).toEqual([[
                { x: 0, y: -0 },
                { x: 10, y: -5 },
            ]]);
        } finally {
            act(() => render(null, container));
            container.remove();
        }
    });
});
