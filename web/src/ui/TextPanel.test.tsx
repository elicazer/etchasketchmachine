import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { Polyline } from '../types';
import { TextPanel } from './TextPanel';
import {
    createTextRenderer,
    type RenderResult,
    type TextRenderer,
} from '../text/text_renderer';

/**
 * Unit tests for the text input panel (Req 3.1–3.6).
 *
 * Rendered with Preact directly (no @testing-library dependency): each test
 * mounts the component into a jsdom container, drives the inputs by
 * dispatching DOM events inside `act()` so effects flush, and asserts on the
 * emitted preview polylines and the rendered DOM.
 */

let containers: HTMLDivElement[] = [];

afterEach(() => {
    // Unmount every container so effects/listeners are torn down between tests.
    for (const c of containers) {
        act(() => render(null, c));
        c.remove();
    }
    containers = [];
});

function mount(jsx: preact.ComponentChild): HTMLDivElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);
    act(() => {
        render(jsx as preact.VNode, container);
    });
    return container;
}

function q<T extends Element = HTMLElement>(
    root: ParentNode,
    testId: string,
): T {
    const el = root.querySelector(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing [data-testid="${testId}"]`);
    return el as T;
}

/** Set an input/select value and dispatch the given event inside act(). */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, evt = 'input'): void {
    act(() => {
        el.value = value;
        el.dispatchEvent(new Event(evt, { bubbles: true }));
    });
}

describe('TextPanel — empty/whitespace handling (Req 3.6)', () => {
    it('shows the text-required hint and emits no polylines when empty', () => {
        const onPolylinesChange = vi.fn<(p: Polyline[]) => void>();
        const root = mount(
            <TextPanel onPolylinesChange={onPolylinesChange} />,
        );

        expect(q(root, 'text-required')).toBeTruthy();

        // Every emission so far is an empty preview.
        expect(onPolylinesChange).toHaveBeenCalled();
        for (const call of onPolylinesChange.mock.calls) {
            expect(call[0]).toHaveLength(0);
        }
    });

    it('emits no polylines for whitespace-only text', () => {
        const onPolylinesChange = vi.fn<(p: Polyline[]) => void>();
        const root = mount(
            <TextPanel onPolylinesChange={onPolylinesChange} />,
        );

        setValue(q<HTMLInputElement>(root, 'text-input'), '   \t');

        expect(q(root, 'text-required')).toBeTruthy();
        for (const call of onPolylinesChange.mock.calls) {
            expect(call[0]).toHaveLength(0);
        }
    });
});

describe('TextPanel — valid text emits polylines (Req 3.1, 3.4)', () => {
    it('emits non-empty polylines live for valid text', () => {
        const onPolylinesChange = vi.fn<(p: Polyline[]) => void>();
        const root = mount(
            <TextPanel onPolylinesChange={onPolylinesChange} />,
        );

        setValue(q<HTMLInputElement>(root, 'text-input'), 'Hi');

        const last = onPolylinesChange.mock.calls.at(-1)?.[0] ?? [];
        expect(last.length).toBeGreaterThan(0);
        // The text-required hint clears once valid text is present.
        expect(
            root.querySelector('[data-testid="text-required"]'),
        ).toBeNull();
    });
});

describe('TextPanel — live re-render on parameter change (Req 3.3, 3.4)', () => {
    it('re-emits polylines when font size changes', () => {
        const onPolylinesChange = vi.fn<(p: Polyline[]) => void>();
        const root = mount(
            <TextPanel
                onPolylinesChange={onPolylinesChange}
                initialText="Hi"
                initialFontSizeMm={20}
            />,
        );

        const before = onPolylinesChange.mock.calls.at(-1)![0];
        const beforeJson = JSON.stringify(before);

        setValue(q<HTMLInputElement>(root, 'font-size'), '40');

        const after = onPolylinesChange.mock.calls.at(-1)![0];
        // A new emission occurred and the geometry actually changed (scaled).
        expect(JSON.stringify(after)).not.toEqual(beforeJson);
        expect(q(root, 'font-size-value').textContent).toContain('40');
    });

    it('re-emits polylines when letter spacing changes', () => {
        const onPolylinesChange = vi.fn<(p: Polyline[]) => void>();
        const root = mount(
            <TextPanel
                onPolylinesChange={onPolylinesChange}
                initialText="Hi"
                initialLetterSpacingPct={0}
            />,
        );

        const before = JSON.stringify(onPolylinesChange.mock.calls.at(-1)![0]);

        setValue(q<HTMLInputElement>(root, 'letter-spacing'), '150');

        const after = JSON.stringify(onPolylinesChange.mock.calls.at(-1)![0]);
        expect(after).not.toEqual(before);
        expect(q(root, 'letter-spacing-value').textContent).toContain('150');
    });

    it('re-shapes when the font selection changes', () => {
        const onPolylinesChange = vi.fn<(p: Polyline[]) => void>();
        const root = mount(
            <TextPanel
                onPolylinesChange={onPolylinesChange}
                initialText="Hi"
                initialFontName="Simplex"
            />,
        );
        const before = JSON.stringify(onPolylinesChange.mock.calls.at(-1)![0]);

        setValue(q<HTMLSelectElement>(root, 'font-select'), 'Mono', 'change');

        const after = JSON.stringify(onPolylinesChange.mock.calls.at(-1)![0]);
        expect(after).not.toEqual(before);
    });
});

describe('TextPanel — unsupported character highlighting (Req 3.5)', () => {
    it('highlights missing codepoints and surfaces the suggested font', () => {
        // The degree sign U+00B0 exists only in "Simplex", not "Mono", so
        // shaping "5°" with "Mono" yields a real missing set + suggestion.
        const root = mount(
            <TextPanel initialText={'5\u00b0'} initialFontName="Mono" />,
        );

        const chars = q(root, 'text-highlight').querySelectorAll(
            '[data-missing]',
        );
        expect(chars).toHaveLength(2);
        expect(chars[0]!.getAttribute('data-missing')).toBe('false'); // "5"
        expect(chars[1]!.getAttribute('data-missing')).toBe('true'); //  "°"

        const warning = q(root, 'text-warning');
        expect(warning.textContent).toContain('Simplex');
        expect(q(root, 'suggestion-apply')).toBeTruthy();
    });

    it('applies the suggested font when the suggestion button is clicked', () => {
        const root = mount(
            <TextPanel initialText={'5\u00b0'} initialFontName="Mono" />,
        );

        act(() => {
            q<HTMLButtonElement>(root, 'suggestion-apply').click();
        });

        // Simplex covers the degree sign, so the warning clears.
        expect(q<HTMLSelectElement>(root, 'font-select').value).toBe('Simplex');
        expect(root.querySelector('[data-testid="text-warning"]')).toBeNull();
        expect(
            q(root, 'text-highlight')
                .querySelector('[data-missing="true"]'),
        ).toBeNull();
    });

    it('honors an injected renderer stub for a known missing set + suggestion', () => {
        const stub: TextRenderer = {
            fonts: () => createTextRenderer().fonts(),
            render: (): RenderResult => ({
                polylines: [
                    [
                        { x: 0, y: 0 },
                        { x: 1, y: 1 },
                    ],
                ],
                missing: [0x2603], // SNOWMAN, deliberately absent
                suggestion: 'Script',
            }),
        };
        const root = mount(
            <TextPanel renderer={stub} initialText={'a\u2603'} />,
        );

        const chars = q(root, 'text-highlight').querySelectorAll(
            '[data-missing]',
        );
        expect(chars[1]!.getAttribute('data-missing')).toBe('true');
        expect(q(root, 'text-warning').textContent).toContain('Script');
    });
});

describe('TextPanel — font selector coverage (Req 3.2)', () => {
    it('lists at least 5 stroke fonts', () => {
        const root = mount(<TextPanel />);
        const options = q(root, 'font-select').querySelectorAll('option');
        expect(options.length).toBeGreaterThanOrEqual(5);
    });
});
