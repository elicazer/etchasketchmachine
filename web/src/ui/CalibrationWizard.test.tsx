import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { Point } from '../types';
import {
    CalibrationWizard,
    type CalibrationWizardProps,
    type JogAxis,
    type JogDir,
} from './CalibrationWizard';

/**
 * Unit tests for the calibration / homing wizard (Req 10.1–10.5, 10.9, 10.11–10.13).
 *
 * Rendered with Preact directly (no @testing-library dependency): each test
 * mounts the component into a jsdom container, clicks controls inside `act()`
 * so effects flush, and asserts on the fired callbacks and rendered DOM. The
 * component is purely prop-driven, so these tests drive it the same way the
 * app shell will once the WireClient wiring lands.
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

function q<T extends Element = HTMLElement>(root: ParentNode, testId: string): T {
    const el = root.querySelector(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing [data-testid="${testId}"]`);
    return el as T;
}

function click(el: Element): void {
    act(() => {
        (el as HTMLElement).click();
    });
}

/**
 * Build a full set of props with sensible defaults so each test only has to
 * override the fields it cares about. `exactOptionalPropertyTypes` is on, so
 * the optional `lastKnownPosition` is only ever set to a concrete `Point`
 * (never `undefined`); tests that need it absent simply omit the override.
 */
function makeProps(
    over: Partial<CalibrationWizardProps> = {},
): CalibrationWizardProps {
    return {
        calibrated: true,
        envelope: null,
        envelopeCalibrated: false,
        currentPosition: { x: 0, y: 0 },
        uncleanShutdown: false,
        onJog: vi.fn<(axis: JogAxis, dir: JogDir, steps: number) => void>(),
        onCaptureBottomLeft: vi.fn<() => void>(),
        onCaptureTopRight: vi.fn<() => void>(),
        ...over,
    };
}

describe('CalibrationWizard — manual jog controls (Req 10.3)', () => {
    it('fires onJog with the correct axis, direction, and default step size', () => {
        const onJog = vi.fn<(axis: JogAxis, dir: JogDir, steps: number) => void>();
        const root = mount(
            <CalibrationWizard {...makeProps({ onJog, calibrated: false })} />,
        );

        click(q(root, 'jog-x-plus'));
        click(q(root, 'jog-x-minus'));
        click(q(root, 'jog-y-plus'));
        click(q(root, 'jog-y-minus'));

        // Default jog distance is the "Medium (40)" preset.
        expect(onJog.mock.calls).toEqual([
            ['x', 1, 40],
            ['x', -1, 40],
            ['y', 1, 40],
            ['y', -1, 40],
        ]);
    });

    it('uses the selected step size for subsequent jogs', () => {
        const onJog = vi.fn<(axis: JogAxis, dir: JogDir, steps: number) => void>();
        const root = mount(<CalibrationWizard {...makeProps({ onJog })} />);

        const select = q(root, 'jog-step-select') as HTMLSelectElement;
        act(() => {
            select.value = '1';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });

        click(q(root, 'jog-x-plus'));
        expect(onJog).toHaveBeenCalledTimes(1);
        expect(onJog).toHaveBeenLastCalledWith('x', 1, 1);
    });
});

describe('CalibrationWizard — corner capture controls (Req 1.1, 10.1)', () => {
    it('fires onCaptureBottomLeft when Capture bottom-left is clicked', () => {
        const onCaptureBottomLeft = vi.fn<() => void>();
        const root = mount(
            <CalibrationWizard
                {...makeProps({ onCaptureBottomLeft, calibrated: false })}
            />,
        );

        click(q(root, 'capture-bottom-left'));
        expect(onCaptureBottomLeft).toHaveBeenCalledTimes(1);
    });

    it('fires onCaptureTopRight when Capture top-right is clicked (home set)', () => {
        const onCaptureTopRight = vi.fn<() => void>();
        const root = mount(
            <CalibrationWizard {...makeProps({ onCaptureTopRight })} />,
        );

        click(q(root, 'capture-top-right'));
        expect(onCaptureTopRight).toHaveBeenCalledTimes(1);
    });
});

describe('CalibrationWizard — uncalibrated notice (Req 1.1, 10.11)', () => {
    it('shows the bottom-left capture step while uncalibrated', () => {
        const root = mount(
            <CalibrationWizard {...makeProps({ calibrated: false })} />,
        );

        expect(q(root, 'calib-state-uncalibrated')).toBeTruthy();
        expect(q(root, 'drawing-blocked-notice').textContent).toMatch(
            /blocked until calibration is complete/i,
        );
    });

    it('advances to the home-set step once calibrated', () => {
        const root = mount(
            <CalibrationWizard {...makeProps({ calibrated: true })} />,
        );

        expect(
            root.querySelector('[data-testid="calib-state-uncalibrated"]'),
        ).toBeNull();
        expect(q(root, 'calib-state-home-set')).toBeTruthy();
    });
});

describe('CalibrationWizard — distinct guided states (Req 4.5, 8.5)', () => {
    it('uncalibrated: shows the uncalibrated indicator, offers bottom-left capture, and disables top-right', () => {
        const root = mount(
            <CalibrationWizard
                {...makeProps({ calibrated: false, envelopeCalibrated: false })}
            />,
        );

        expect(q(root, 'calib-state-uncalibrated')).toBeTruthy();
        expect(
            root.querySelector('[data-testid="calib-state-home-set"]'),
        ).toBeNull();
        expect(
            root.querySelector('[data-testid="calib-state-envelope-captured"]'),
        ).toBeNull();

        expect(q(root, 'capture-bottom-left')).toBeTruthy();
        expect(
            (q(root, 'capture-top-right') as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    it('home-set: shows the home-set indicator, enables top-right, and clicking it fires onCaptureTopRight', () => {
        const onCaptureTopRight = vi.fn<() => void>();
        const root = mount(
            <CalibrationWizard
                {...makeProps({
                    calibrated: true,
                    envelopeCalibrated: false,
                    onCaptureTopRight,
                })}
            />,
        );

        expect(q(root, 'calib-state-home-set')).toBeTruthy();
        expect(
            root.querySelector('[data-testid="calib-state-uncalibrated"]'),
        ).toBeNull();
        expect(
            root.querySelector('[data-testid="calib-state-envelope-captured"]'),
        ).toBeNull();

        const topRight = q(root, 'capture-top-right') as HTMLButtonElement;
        expect(topRight.disabled).toBe(false);

        click(topRight);
        expect(onCaptureTopRight).toHaveBeenCalledTimes(1);
    });

    it('envelope-captured: shows the complete indicator with the measured envelope dimensions', () => {
        const root = mount(
            <CalibrationWizard
                {...makeProps({
                    calibrated: true,
                    envelopeCalibrated: true,
                    envelope: { x: 3200, y: 2400 },
                })}
            />,
        );

        expect(q(root, 'calib-state-envelope-captured')).toBeTruthy();
        expect(
            root.querySelector('[data-testid="calib-state-uncalibrated"]'),
        ).toBeNull();
        expect(
            root.querySelector('[data-testid="calib-state-home-set"]'),
        ).toBeNull();

        const complete = q(root, 'calibration-complete').textContent ?? '';
        expect(complete).toMatch(/calibration complete/i);
        expect(complete).toContain('3200');
        expect(complete).toContain('2400');
    });

    it('capture-bottom-left fires onCaptureBottomLeft as the re-capture/re-home action once home is set', () => {
        const onCaptureBottomLeft = vi.fn<() => void>();
        const root = mount(
            <CalibrationWizard
                {...makeProps({ calibrated: true, onCaptureBottomLeft })}
            />,
        );

        click(q(root, 'capture-bottom-left'));
        expect(onCaptureBottomLeft).toHaveBeenCalledTimes(1);
    });
});

describe('CalibrationWizard — current position readout (Req 10.9)', () => {
    it('renders the current position in steps from props', () => {
        const currentPosition: Point = { x: 123, y: -45 };
        const root = mount(
            <CalibrationWizard {...makeProps({ currentPosition })} />,
        );

        expect(q(root, 'position-x').textContent).toContain('123');
        expect(q(root, 'position-y').textContent).toContain('-45');
        expect(q(root, 'current-position').textContent).toContain(
            'steps from home',
        );
    });

    it('reflects updated position props on re-render', () => {
        const root = mount(
            <CalibrationWizard
                {...makeProps({ currentPosition: { x: 1, y: 2 } })}
            />,
        );
        expect(q(root, 'position-x').textContent).toContain('1');

        act(() => {
            render(
                <CalibrationWizard
                    {...makeProps({ currentPosition: { x: 9, y: 8 } })}
                />,
                root,
            );
        });
        expect(q(root, 'position-x').textContent).toContain('9');
        expect(q(root, 'position-y').textContent).toContain('8');
    });
});

describe('CalibrationWizard — unclean shutdown recovery (Req 10.12)', () => {
    it('shows the last known position hint only when uncleanShutdown is true', () => {
        const root = mount(
            <CalibrationWizard
                {...makeProps({
                    uncleanShutdown: true,
                    lastKnownPosition: { x: 200, y: 150 },
                })}
            />,
        );

        expect(q(root, 'unclean-shutdown-hint')).toBeTruthy();
        const hint = q(root, 'last-known-position').textContent ?? '';
        expect(hint).toContain('200');
        expect(hint).toContain('150');
    });

    it('hides the unclean-shutdown hint when uncleanShutdown is false', () => {
        const root = mount(
            <CalibrationWizard {...makeProps({ uncleanShutdown: false })} />,
        );

        expect(
            root.querySelector('[data-testid="unclean-shutdown-hint"]'),
        ).toBeNull();
    });

    it('renders gracefully when the hint position is absent', () => {
        const root = mount(
            <CalibrationWizard {...makeProps({ uncleanShutdown: true })} />,
        );

        expect(q(root, 'unclean-shutdown-hint')).toBeTruthy();
        expect(q(root, 'last-known-position').textContent).toMatch(
            /unavailable/i,
        );
    });
});
