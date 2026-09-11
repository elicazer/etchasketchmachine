import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { Axis, JogDir } from '../codec/control';
import { BacklashWizard, type BacklashWizardProps } from './BacklashWizard';

/**
 * Unit tests for the backlash calibration wizard (Req 13.1–13.5, 13.8, 13.9,
 * 13.11).
 *
 * Rendered with Preact directly (no @testing-library dependency): each test
 * mounts the component into a jsdom container, drives the controls by
 * dispatching DOM events inside `act()` so effects flush, and asserts on the
 * emitted callbacks and the rendered DOM. Mirrors the pattern in
 * `TextPanel.test.tsx`.
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

function click(el: Element): void {
    act(() => {
        (el as HTMLElement).click();
    });
}

function setValue(el: HTMLInputElement, value: string): void {
    act(() => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Build a complete prop set, overriding only what a test cares about. */
function baseProps(
    overrides: Partial<BacklashWizardProps> = {},
): BacklashWizardProps {
    return {
        backlash: { x: 10, y: 20 },
        calibrationPerformed: true,
        calibrated: true,
        onJog: vi.fn<(axis: Axis, dir: JogDir) => void>(),
        onRecordBacklash: vi.fn<(axis: Axis, steps: number) => void>(),
        onManualEdit: vi.fn<(axis: Axis, steps: number) => void>(),
        ...overrides,
    };
}

describe('BacklashWizard — stored values (Req 13.8)', () => {
    it('renders the currently stored X and Y backlash values', () => {
        const root = mount(
            <BacklashWizard {...baseProps({ backlash: { x: 7, y: 42 } })} />,
        );
        expect(q(root, 'backlash-stored-x').textContent).toContain('7 steps');
        expect(q(root, 'backlash-stored-y').textContent).toContain('42 steps');
    });
});

describe('BacklashWizard — per-axis wizard flow (Req 13.1–13.4)', () => {
    it('advances forward → reverse-step → confirm and records the step count', () => {
        const onJog = vi.fn<(axis: Axis, dir: JogDir) => void>();
        const onRecordBacklash = vi.fn<(axis: Axis, steps: number) => void>();
        const root = mount(
            <BacklashWizard
                {...baseProps({ onJog, onRecordBacklash })}
            />,
        );

        // Start the X-axis wizard → forward establish-direction jog (Req 13.2).
        click(q(root, 'backlash-start-x'));
        expect(onJog).toHaveBeenCalledTimes(1);
        expect(onJog).toHaveBeenLastCalledWith(0, 1);
        expect(q(root, 'backlash-forward')).toBeTruthy();

        // Begin reverse stepping (Req 13.3).
        click(q(root, 'backlash-begin-reverse'));
        expect(q(root, 'backlash-reversing')).toBeTruthy();
        expect(q(root, 'backlash-reverse-count').textContent).toBe('0');

        // Reverse three single steps; each is a reverse jog (Req 13.3).
        click(q(root, 'backlash-step'));
        click(q(root, 'backlash-step'));
        click(q(root, 'backlash-step'));
        expect(q(root, 'backlash-reverse-count').textContent).toBe('3');

        // The three reverse steps must each be onJog(axis=0, dir=-1).
        const reverseCalls = onJog.mock.calls.filter((c) => c[1] === -1);
        expect(reverseCalls).toHaveLength(3);
        for (const c of reverseCalls) expect(c[0]).toBe(0);

        // Confirm motion → record the count as backlash (Req 13.4).
        click(q(root, 'backlash-confirm'));
        expect(onRecordBacklash).toHaveBeenCalledTimes(1);
        expect(onRecordBacklash).toHaveBeenLastCalledWith(0, 3);
        expect(q(root, 'backlash-recorded').textContent).toContain('3 steps');
    });

    it('records 0 steps when the stylus moves on the first reverse check', () => {
        const onRecordBacklash = vi.fn<(axis: Axis, steps: number) => void>();
        const root = mount(
            <BacklashWizard {...baseProps({ onRecordBacklash })} />,
        );

        click(q(root, 'backlash-start-y'));
        click(q(root, 'backlash-begin-reverse'));
        // Confirm immediately, before any reverse step.
        click(q(root, 'backlash-confirm'));

        expect(onRecordBacklash).toHaveBeenLastCalledWith(1, 0);
    });

    it('starts the Y wizard with a forward jog on the Y axis', () => {
        const onJog = vi.fn<(axis: Axis, dir: JogDir) => void>();
        const root = mount(<BacklashWizard {...baseProps({ onJog })} />);

        click(q(root, 'backlash-start-y'));
        expect(onJog).toHaveBeenLastCalledWith(1, 1);
    });
});

describe('BacklashWizard — re-run availability (Req 13.9)', () => {
    it('disables start buttons while a drawing is in progress', () => {
        const root = mount(
            <BacklashWizard {...baseProps({ drawingInProgress: true })} />,
        );
        expect(q<HTMLButtonElement>(root, 'backlash-start-x').disabled).toBe(
            true,
        );
        expect(q<HTMLButtonElement>(root, 'backlash-start-y').disabled).toBe(
            true,
        );
        expect(q(root, 'backlash-start-blocked')).toBeTruthy();
    });

    it('enables start buttons when no drawing is in progress', () => {
        const root = mount(<BacklashWizard {...baseProps()} />);
        expect(q<HTMLButtonElement>(root, 'backlash-start-x').disabled).toBe(
            false,
        );
        expect(q<HTMLButtonElement>(root, 'backlash-start-y').disabled).toBe(
            false,
        );
    });
});

describe('BacklashWizard — manual edit (Req 13.8)', () => {
    it('emits onManualEdit for an in-range integer', () => {
        const onManualEdit = vi.fn<(axis: Axis, steps: number) => void>();
        const root = mount(
            <BacklashWizard {...baseProps({ onManualEdit })} />,
        );

        setValue(q<HTMLInputElement>(root, 'backlash-edit-x'), '50');
        expect(onManualEdit).toHaveBeenLastCalledWith(0, 50);
        expect(root.querySelector('[data-testid="backlash-edit-error-x"]')).toBeNull();
    });

    it('accepts the inclusive bounds 0 and 200', () => {
        const onManualEdit = vi.fn<(axis: Axis, steps: number) => void>();
        const root = mount(
            <BacklashWizard {...baseProps({ onManualEdit })} />,
        );

        setValue(q<HTMLInputElement>(root, 'backlash-edit-x'), '0');
        expect(onManualEdit).toHaveBeenLastCalledWith(0, 0);

        setValue(q<HTMLInputElement>(root, 'backlash-edit-y'), '200');
        expect(onManualEdit).toHaveBeenLastCalledWith(1, 200);
    });

    it('rejects an out-of-range value and shows an error without emitting', () => {
        const onManualEdit = vi.fn<(axis: Axis, steps: number) => void>();
        const root = mount(
            <BacklashWizard {...baseProps({ onManualEdit })} />,
        );

        setValue(q<HTMLInputElement>(root, 'backlash-edit-x'), '201');
        expect(q(root, 'backlash-edit-error-x')).toBeTruthy();
        expect(onManualEdit).not.toHaveBeenCalled();
    });

    it('rejects a non-integer value and shows an error without emitting', () => {
        const onManualEdit = vi.fn<(axis: Axis, steps: number) => void>();
        const root = mount(
            <BacklashWizard {...baseProps({ onManualEdit })} />,
        );

        setValue(q<HTMLInputElement>(root, 'backlash-edit-y'), '3.5');
        expect(q(root, 'backlash-edit-error-y')).toBeTruthy();
        expect(onManualEdit).not.toHaveBeenCalled();
    });
});

describe('BacklashWizard — uncalibrated warning (Req 13.11)', () => {
    it('shows the warning when an axis is 0 and no calibration was performed', () => {
        const onProceedUncalibrated = vi.fn<() => void>();
        const onCancelUncalibrated = vi.fn<() => void>();
        const root = mount(
            <BacklashWizard
                {...baseProps({
                    backlash: { x: 0, y: 30 },
                    calibrationPerformed: false,
                    onProceedUncalibrated,
                    onCancelUncalibrated,
                })}
            />,
        );

        expect(q(root, 'backlash-warning')).toBeTruthy();

        click(q(root, 'backlash-warning-proceed'));
        expect(onProceedUncalibrated).toHaveBeenCalledTimes(1);

        click(q(root, 'backlash-warning-cancel'));
        expect(onCancelUncalibrated).toHaveBeenCalledTimes(1);
    });

    it('hides the warning when both axes have non-zero stored values', () => {
        const root = mount(
            <BacklashWizard
                {...baseProps({
                    backlash: { x: 5, y: 8 },
                    calibrationPerformed: false,
                })}
            />,
        );
        expect(
            root.querySelector('[data-testid="backlash-warning"]'),
        ).toBeNull();
    });

    it('hides the warning when a calibration was performed this installation', () => {
        const root = mount(
            <BacklashWizard
                {...baseProps({
                    backlash: { x: 0, y: 0 },
                    calibrationPerformed: true,
                })}
            />,
        );
        expect(
            root.querySelector('[data-testid="backlash-warning"]'),
        ).toBeNull();
    });
});
