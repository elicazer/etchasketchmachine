import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DrawingControls } from './DrawingControls';
import type {
    ConnectionStatus,
    DrawingControlsProps,
    DrawingExecState,
} from './DrawingControls';
import { SPEED_PCT_MAX, SPEED_PCT_MIN } from '../constants';

/**
 * Unit tests for the drawing-execution control panel (Req 9.1–9.8, 12.1).
 *
 * Rendered with Preact directly (no @testing-library dependency): each test
 * mounts the component into a jsdom container, drives the inputs by
 * dispatching DOM events inside `act()` so effects flush, and asserts on the
 * fired callbacks and the rendered DOM. Mirrors the approach used by the
 * other UI panel tests (e.g. TextPanel.test.tsx).
 */

let containers: HTMLDivElement[] = [];

afterEach(() => {
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

/** Query for an element that may legitimately be absent. */
function maybe<T extends Element = HTMLElement>(
    root: ParentNode,
    testId: string,
): T | null {
    return root.querySelector(`[data-testid="${testId}"]`);
}

/** Sensible default props; individual tests override what they exercise. */
function baseProps(
    overrides: Partial<DrawingControlsProps> = {},
): DrawingControlsProps {
    return {
        connection: 'connected',
        drawingState: 'drawing',
        progressPct: 0,
        position: { x: 0, y: 0 },
        speedPct: 100,
        ...overrides,
    };
}

/** Set an input value and dispatch the given event inside act(). */
function setValue(
    el: HTMLInputElement,
    value: string,
    evt = 'input',
): void {
    act(() => {
        el.value = value;
        el.dispatchEvent(new Event(evt, { bubbles: true }));
    });
}

describe('DrawingControls — control visibility by state (Req 9.1, 9.3, 9.5, 9.6)', () => {
    it('shows Pause (not Resume) and Cancel while drawing', () => {
        const root = mount(<DrawingControls {...baseProps({ drawingState: 'drawing' })} />);

        expect(maybe(root, 'pause-button')).toBeTruthy();
        expect(maybe(root, 'resume-button')).toBeNull();
        expect(maybe(root, 'cancel-button')).toBeTruthy();
    });

    it('shows Resume (not Pause) and Cancel while paused', () => {
        const root = mount(<DrawingControls {...baseProps({ drawingState: 'paused' })} />);

        expect(maybe(root, 'resume-button')).toBeTruthy();
        expect(maybe(root, 'pause-button')).toBeNull();
        expect(maybe(root, 'cancel-button')).toBeTruthy();
    });

    it('hides Pause/Resume/Cancel while idle', () => {
        const root = mount(<DrawingControls {...baseProps({ drawingState: 'idle' })} />);

        expect(maybe(root, 'pause-button')).toBeNull();
        expect(maybe(root, 'resume-button')).toBeNull();
        expect(maybe(root, 'cancel-button')).toBeNull();
    });

    it.each<DrawingExecState>(['completing', 'cancelled', 'error'])(
        'hides all execution controls in terminal state %s',
        (drawingState) => {
            const root = mount(<DrawingControls {...baseProps({ drawingState })} />);

            expect(maybe(root, 'pause-button')).toBeNull();
            expect(maybe(root, 'resume-button')).toBeNull();
            expect(maybe(root, 'cancel-button')).toBeNull();
            expect(maybe(root, 'speed-slider')).toBeNull();
        },
    );
});

describe('DrawingControls — control callbacks (Req 9.2, 9.4, 9.5)', () => {
    it('fires onPause when Pause is clicked while drawing', () => {
        const onPause = vi.fn();
        const root = mount(
            <DrawingControls {...baseProps({ drawingState: 'drawing', onPause })} />,
        );

        act(() => q<HTMLButtonElement>(root, 'pause-button').click());

        expect(onPause).toHaveBeenCalledTimes(1);
    });

    it('fires onResume when Resume is clicked while paused', () => {
        const onResume = vi.fn();
        const root = mount(
            <DrawingControls {...baseProps({ drawingState: 'paused', onResume })} />,
        );

        act(() => q<HTMLButtonElement>(root, 'resume-button').click());

        expect(onResume).toHaveBeenCalledTimes(1);
    });

    it('fires onCancel when Cancel is clicked while drawing', () => {
        const onCancel = vi.fn();
        const root = mount(
            <DrawingControls {...baseProps({ drawingState: 'drawing', onCancel })} />,
        );

        act(() => q<HTMLButtonElement>(root, 'cancel-button').click());

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('fires onCancel when Cancel is clicked while paused', () => {
        const onCancel = vi.fn();
        const root = mount(
            <DrawingControls {...baseProps({ drawingState: 'paused', onCancel })} />,
        );

        act(() => q<HTMLButtonElement>(root, 'cancel-button').click());

        expect(onCancel).toHaveBeenCalledTimes(1);
    });
});

describe('DrawingControls — speed slider (Req 9.7, 9.8)', () => {
    it('constrains the slider to [25, 100] in 1% increments', () => {
        const root = mount(<DrawingControls {...baseProps()} />);
        const slider = q<HTMLInputElement>(root, 'speed-slider');

        expect(slider.type).toBe('range');
        expect(slider.min).toBe(String(SPEED_PCT_MIN));
        expect(slider.max).toBe(String(SPEED_PCT_MAX));
        expect(slider.step).toBe('1');
    });

    it('emits onSpeedChange with the accepted integer value', () => {
        const onSpeedChange = vi.fn<(pct: number) => void>();
        const root = mount(<DrawingControls {...baseProps({ onSpeedChange })} />);

        setValue(q<HTMLInputElement>(root, 'speed-slider'), '60');

        expect(onSpeedChange).toHaveBeenCalledWith(60);
    });

    it('reflects the current speed in the read-out', () => {
        const root = mount(<DrawingControls {...baseProps({ speedPct: 42 })} />);
        expect(q(root, 'speed-value').textContent).toContain('42');
    });

    it('never emits an out-of-range speed (slider clamps to the [25,100] bounds)', () => {
        const onSpeedChange = vi.fn<(pct: number) => void>();
        const root = mount(<DrawingControls {...baseProps({ onSpeedChange })} />);

        // The range input clamps a below-floor value to its min before the
        // handler sees it, so the callback only ever receives valid values.
        setValue(q<HTMLInputElement>(root, 'speed-slider'), '10');

        for (const call of onSpeedChange.mock.calls) {
            expect(call[0]).toBeGreaterThanOrEqual(SPEED_PCT_MIN);
            expect(call[0]).toBeLessThanOrEqual(SPEED_PCT_MAX);
        }
        // And the value delivered is the clamped boundary, never the raw 10.
        expect(onSpeedChange).toHaveBeenCalledWith(SPEED_PCT_MIN);
    });

    it('rejects a non-integer speed without emitting (validateSpeedPct guard)', () => {
        const onSpeedChange = vi.fn<(pct: number) => void>();
        const root = mount(<DrawingControls {...baseProps({ onSpeedChange })} />);

        // jsdom preserves the non-integer value rather than snapping to step,
        // so the validateSpeedPct guard is what blocks the emission here.
        setValue(q<HTMLInputElement>(root, 'speed-slider'), '50.5');

        expect(onSpeedChange).not.toHaveBeenCalled();
    });

    it('is visible when idle (so users can set speed before drawing starts)', () => {
        const root = mount(<DrawingControls {...baseProps({ drawingState: 'idle' })} />);
        expect(maybe(root, 'speed-slider')).toBeTruthy();
    });
});

describe('DrawingControls — progress display (Req 7.4, 10.9)', () => {
    it('renders percent complete and current position in steps', () => {
        const root = mount(
            <DrawingControls
                {...baseProps({ progressPct: 37, position: { x: 1234, y: -56 } })}
            />,
        );

        expect(q(root, 'progress-percent').textContent).toContain('37%');
        const pos = q(root, 'position').textContent ?? '';
        expect(pos).toContain('1234');
        expect(pos).toContain('-56');
    });

    it('clamps and rounds an out-of-range percent for display', () => {
        const root = mount(
            <DrawingControls {...baseProps({ progressPct: 142.6 })} />,
        );
        expect(q(root, 'progress-percent').textContent).toContain('100%');
    });

    it('updates the progress read-out when props change', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        containers.push(container);

        act(() => render(<DrawingControls {...baseProps({ progressPct: 10 })} />, container));
        expect(q(container, 'progress-percent').textContent).toContain('10%');

        act(() => render(<DrawingControls {...baseProps({ progressPct: 80 })} />, container));
        expect(q(container, 'progress-percent').textContent).toContain('80%');
    });
});

describe('DrawingControls — connection indicator (Req 12.1)', () => {
    const cases: { status: ConnectionStatus; label: string }[] = [
        { status: 'connected', label: 'Connected' },
        { status: 'disconnected', label: 'Disconnected' },
        { status: 'connecting', label: 'Connecting' },
    ];

    it.each(cases)(
        'reflects the $status state with a matching label and class',
        ({ status, label }) => {
            const root = mount(
                <DrawingControls {...baseProps({ connection: status })} />,
            );
            const indicator = q(root, 'connection-status');

            expect(indicator.getAttribute('data-status')).toBe(status);
            expect(indicator.className).toContain(
                `drawing-controls__connection--${status}`,
            );
            expect(q(root, 'connection-label').textContent).toContain(label);
        },
    );

    it('reflects a prop change immediately on re-render', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        containers.push(container);

        act(() =>
            render(
                <DrawingControls {...baseProps({ connection: 'connecting' })} />,
                container,
            ),
        );
        expect(q(container, 'connection-status').getAttribute('data-status')).toBe(
            'connecting',
        );

        act(() =>
            render(
                <DrawingControls {...baseProps({ connection: 'connected' })} />,
                container,
            ),
        );
        expect(q(container, 'connection-status').getAttribute('data-status')).toBe(
            'connected',
        );
    });
});
