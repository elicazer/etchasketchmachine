import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import {
    DiagnosticsPanel,
    type ConnectionStatus,
    type DiagnosticsPanelProps,
} from './DiagnosticsPanel';

/**
 * Unit tests for the diagnostics & status panel (Req 12.1–12.6).
 *
 * Rendered with Preact directly (no @testing-library dependency): each test
 * mounts the component into a jsdom container inside `act()` so effects flush,
 * then asserts on the rendered DOM and the callbacks fired by user actions.
 */

let containers: HTMLDivElement[] = [];

afterEach(() => {
    // Unmount every container so listeners are torn down between tests.
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

/** Build a fully-populated, "all clear" set of props; tests override fields. */
function baseProps(): DiagnosticsPanelProps {
    return {
        connection: 'connected',
        rssiDbm: -55,
        motorTestResult: null,
        fault: { active: false },
        stall: { active: false },
    };
}

describe('DiagnosticsPanel — connection indicator (Req 12.1)', () => {
    const cases: ReadonlyArray<[ConnectionStatus, string]> = [
        ['connected', 'Connected'],
        ['disconnected', 'Disconnected'],
        ['connecting', 'Connecting…'],
    ];

    for (const [status, label] of cases) {
        it(`reflects the "${status}" state with the right label and class`, () => {
            const root = mount(
                <DiagnosticsPanel {...baseProps()} connection={status} />,
            );

            const indicator = q(root, 'connection-indicator');
            expect(indicator.getAttribute('data-status')).toBe(status);
            expect(indicator.className).toContain(
                `diagnostics__indicator--${status}`,
            );
            expect(q(root, 'connection-label').textContent).toBe(label);
        });
    }

    it('updates the indicator immediately when the connection prop changes', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        containers.push(container);

        act(() => {
            render(
                <DiagnosticsPanel {...baseProps()} connection="connecting" />,
                container,
            );
        });
        expect(
            q(container, 'connection-indicator').getAttribute('data-status'),
        ).toBe('connecting');

        // Re-render with a new status; the view reflects it on the next paint.
        act(() => {
            render(
                <DiagnosticsPanel {...baseProps()} connection="connected" />,
                container,
            );
        });
        expect(
            q(container, 'connection-indicator').getAttribute('data-status'),
        ).toBe('connected');
        expect(q(container, 'connection-label').textContent).toBe('Connected');
    });
});

describe('DiagnosticsPanel — RSSI display (Req 12.2)', () => {
    it('renders the RSSI value with a dBm unit', () => {
        const root = mount(<DiagnosticsPanel {...baseProps()} rssiDbm={-42} />);
        expect(q(root, 'rssi-value').textContent).toBe('-42 dBm');
    });

    it('shows a dash when the RSSI reading is null', () => {
        const root = mount(<DiagnosticsPanel {...baseProps()} rssiDbm={null} />);
        expect(q(root, 'rssi-value').textContent).toBe('—');
    });
});

describe('DiagnosticsPanel — motor test (Req 12.4)', () => {
    it('fires onMotorTest when the button is clicked', () => {
        const onMotorTest = vi.fn<() => void>();
        const root = mount(
            <DiagnosticsPanel {...baseProps()} onMotorTest={onMotorTest} />,
        );

        act(() => {
            q<HTMLButtonElement>(root, 'motor-test-button').click();
        });
        expect(onMotorTest).toHaveBeenCalledTimes(1);
    });

    it('renders per-axis pass/fail from a result prop', () => {
        const root = mount(
            <DiagnosticsPanel
                {...baseProps()}
                motorTestResult={{ xPass: true, yPass: false }}
            />,
        );

        const x = q(root, 'motor-test-x');
        const y = q(root, 'motor-test-y');
        expect(x.getAttribute('data-result')).toBe('pass');
        expect(x.textContent).toContain('Pass');
        expect(y.getAttribute('data-result')).toBe('fail');
        expect(y.textContent).toContain('Fail');
    });

    it('shows an in-progress indicator and disables the button while running', () => {
        const onMotorTest = vi.fn<() => void>();
        const root = mount(
            <DiagnosticsPanel
                {...baseProps()}
                motorTestRunning
                onMotorTest={onMotorTest}
            />,
        );

        expect(q(root, 'motor-test-running')).toBeTruthy();
        const button = q<HTMLButtonElement>(root, 'motor-test-button');
        expect(button.disabled).toBe(true);

        // A disabled button must not fire the callback even if clicked.
        act(() => {
            button.click();
        });
        expect(onMotorTest).not.toHaveBeenCalled();
    });

    it('hides the result while a new test is running', () => {
        const root = mount(
            <DiagnosticsPanel
                {...baseProps()}
                motorTestRunning
                motorTestResult={{ xPass: true, yPass: true }}
            />,
        );
        expect(root.querySelector('[data-testid="motor-test-result"]')).toBeNull();
    });
});

describe('DiagnosticsPanel — fault indicator (Req 12.5, 12.6)', () => {
    it('hides the fault indicator when no fault is active', () => {
        const root = mount(<DiagnosticsPanel {...baseProps()} />);
        expect(root.querySelector('[data-testid="fault-indicator"]')).toBeNull();
    });

    it('shows the fault with the offending driver when active', () => {
        const root = mount(
            <DiagnosticsPanel
                {...baseProps()}
                fault={{ active: true, driver: 'X' }}
            />,
        );
        const indicator = q(root, 'fault-indicator');
        expect(indicator.textContent).toContain('X');
        expect(q(root, 'fault-reset-button')).toBeTruthy();
    });

    it('fires onFaultReset when the reset control is activated', () => {
        const onFaultReset = vi.fn<() => void>();
        const root = mount(
            <DiagnosticsPanel
                {...baseProps()}
                fault={{ active: true, driver: 'Y' }}
                onFaultReset={onFaultReset}
            />,
        );

        act(() => {
            q<HTMLButtonElement>(root, 'fault-reset-button').click();
        });
        expect(onFaultReset).toHaveBeenCalledTimes(1);
    });
});

describe('DiagnosticsPanel — stall notification (Req 12.3)', () => {
    it('hides the stall notification when no stall is active', () => {
        const root = mount(<DiagnosticsPanel {...baseProps()} />);
        expect(root.querySelector('[data-testid="stall-indicator"]')).toBeNull();
    });

    it('shows which axis stalled when active', () => {
        const root = mount(
            <DiagnosticsPanel
                {...baseProps()}
                stall={{ active: true, axis: 'y' }}
            />,
        );
        expect(q(root, 'stall-indicator').textContent).toContain('Y');
    });
});
