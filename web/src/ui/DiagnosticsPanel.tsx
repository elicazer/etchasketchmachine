/**
 * `DiagnosticsPanel` — the system status & diagnostics UI panel (Req 12.1–12.6).
 *
 * Responsibilities:
 *   - surface the controller connection status with a color-coded indicator
 *     and an accessible text label, reflecting prop changes immediately so a
 *     host that pushes updates within 2 s satisfies Req 12.1;
 *   - display the WiFi signal strength (RSSI) in dBm, or a dash when no
 *     reading is available (the host refreshes it every 5 s while connected,
 *     Req 12.2);
 *   - offer a motor-test action and render the per-axis pass/fail outcome,
 *     plus an in-progress indicator while a test is running (Req 12.4);
 *   - show a fault indicator naming the offending driver together with a
 *     reset control when a Motor_Driver fault has been reported (Req 12.5,
 *     12.6);
 *   - show a stall notification identifying the stalled axis (Req 12.3).
 *
 * This is a *presentational / control* component: it owns no transport state
 * of its own. Every value it shows arrives through props and every action it
 * triggers is delegated to a callback prop. The live wiring to `WireClient`
 * (subscribing to `state` / `rssi` / `fault` / `stall` events and issuing the
 * `MOTOR_TEST` / `FAULT_RESET` controls) is performed by the App shell in a
 * later task; keeping the panel prop-driven makes it trivially testable and
 * keeps the network concerns out of the view.
 *
 * @see Design §3.1.6 (Diagnostics panel), §3.2.8 (Fault & Stall)
 * @see Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */

/** Connection lifecycle state shown by the indicator (Req 12.1). */
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

/** Per-axis outcome of a motor test run (Req 12.4). */
export interface MotorTestResult {
    /** Whether the X_Motor completed the test without stall or fault. */
    xPass: boolean;
    /** Whether the Y_Motor completed the test without stall or fault. */
    yPass: boolean;
}

/** Reported A4988 Motor_Driver fault condition (Req 12.5, 12.6). */
export interface FaultState {
    /** Whether a fault is currently latched. */
    active: boolean;
    /** Which driver triggered the fault (e.g. "X" or "Y"); optional. */
    driver?: string;
}

/** Reported motor stall condition (Req 12.3). */
export interface StallState {
    /** Whether a stall is currently latched. */
    active: boolean;
    /** Which axis stalled; optional when not yet known. */
    axis?: 'x' | 'y';
}

/** Props accepted by {@link DiagnosticsPanel}. */
export interface DiagnosticsPanelProps {
    /** Current controller connection status (Req 12.1). */
    connection: ConnectionStatus;
    /** Latest WiFi RSSI in dBm, or `null` when unavailable (Req 12.2). */
    rssiDbm: number | null;
    /** Latest per-axis motor-test result, or `null` if none yet (Req 12.4). */
    motorTestResult: MotorTestResult | null;
    /** Whether a motor test is currently in progress (Req 12.4). */
    motorTestRunning?: boolean;
    /** Current fault condition (Req 12.5, 12.6). */
    fault: FaultState;
    /** Current stall condition (Req 12.3). */
    stall: StallState;
    /** Invoked when the user starts the motor test (Req 12.4). */
    onMotorTest?: () => void;
    /** Invoked when the user activates the fault reset control (Req 12.6). */
    onFaultReset?: () => void;
}

/** Human-readable label for each connection status (Req 12.1). */
const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    connecting: 'Connecting…',
};

/** Per-axis pass/fail cell for the motor-test result (Req 12.4). */
function AxisResult(props: { axis: 'X' | 'Y'; pass: boolean }) {
    const { axis, pass } = props;
    const testId = `motor-test-${axis.toLowerCase()}`;
    return (
        <li
            class={
                pass
                    ? 'diagnostics__axis diagnostics__axis--pass'
                    : 'diagnostics__axis diagnostics__axis--fail'
            }
            data-testid={testId}
            data-result={pass ? 'pass' : 'fail'}
        >
            <span class="diagnostics__axis-name">{axis}</span>
            <span class="diagnostics__axis-status">
                {pass ? 'Pass' : 'Fail'}
            </span>
        </li>
    );
}

/**
 * Render the diagnostics & status panel. Purely driven by props; the only
 * outputs are the `onMotorTest` and `onFaultReset` callbacks.
 */
export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
    const {
        connection,
        rssiDbm,
        motorTestResult,
        fault,
        stall,
        onMotorTest,
        onFaultReset,
    } = props;
    const motorTestRunning = props.motorTestRunning ?? false;

    function handleMotorTest(): void {
        if (motorTestRunning) return;
        onMotorTest?.();
    }

    function handleFaultReset(): void {
        onFaultReset?.();
    }

    return (
        <section class="diagnostics" aria-label="System status and diagnostics">
            {/* Connection status — color-coded indicator + text (Req 12.1). */}
            <div class="diagnostics__row diagnostics__connection">
                <span
                    class={`diagnostics__indicator diagnostics__indicator--${connection}`}
                    data-testid="connection-indicator"
                    data-status={connection}
                    aria-hidden="true"
                />
                <span
                    class="diagnostics__connection-label"
                    data-testid="connection-label"
                    role="status"
                    aria-live="polite"
                >
                    {CONNECTION_LABEL[connection]}
                </span>
            </div>

            {/* WiFi signal strength in dBm (Req 12.2). */}
            <div class="diagnostics__row diagnostics__rssi">
                <span class="diagnostics__label">Signal</span>
                <span class="diagnostics__rssi-value" data-testid="rssi-value">
                    {rssiDbm === null ? '—' : `${rssiDbm} dBm`}
                </span>
            </div>

            {/* Motor test action + per-axis result (Req 12.4). */}
            <div class="diagnostics__row diagnostics__motor-test">
                <button
                    type="button"
                    class="diagnostics__motor-test-button"
                    data-testid="motor-test-button"
                    disabled={motorTestRunning}
                    onClick={handleMotorTest}
                >
                    Run motor test
                </button>
                {motorTestRunning && (
                    <span
                        class="diagnostics__motor-test-running"
                        data-testid="motor-test-running"
                        role="status"
                        aria-live="polite"
                    >
                        Testing…
                    </span>
                )}
                {!motorTestRunning && motorTestResult !== null && (
                    <ul
                        class="diagnostics__motor-test-result"
                        data-testid="motor-test-result"
                    >
                        <AxisResult axis="X" pass={motorTestResult.xPass} />
                        <AxisResult axis="Y" pass={motorTestResult.yPass} />
                    </ul>
                )}
            </div>

            {/* Fault indicator + reset control (Req 12.5, 12.6). */}
            {fault.active && (
                <div
                    class="diagnostics__row diagnostics__fault"
                    data-testid="fault-indicator"
                    role="alert"
                >
                    <span class="diagnostics__fault-message">
                        {fault.driver
                            ? `Motor driver fault (${fault.driver})`
                            : 'Motor driver fault'}
                    </span>
                    <button
                        type="button"
                        class="diagnostics__fault-reset"
                        data-testid="fault-reset-button"
                        onClick={handleFaultReset}
                    >
                        Reset fault
                    </button>
                </div>
            )}

            {/* Stall notification with axis identification (Req 12.3). */}
            {stall.active && (
                <div
                    class="diagnostics__row diagnostics__stall"
                    data-testid="stall-indicator"
                    role="alert"
                >
                    <span class="diagnostics__stall-message">
                        {stall.axis
                            ? `Motor stall detected on ${stall.axis.toUpperCase()} axis`
                            : 'Motor stall detected'}
                    </span>
                </div>
            )}
        </section>
    );
}

export default DiagnosticsPanel;
