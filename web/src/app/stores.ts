/**
 * `stores` — the application's reactive state, expressed as `@preact/signals`.
 *
 * Task 29.1 wires the already-built pieces (UI panels, the {@link WireClient},
 * and the {@link PathPlanner}) into a single running SPA. This module owns the
 * *state* half of that wiring: every value the UI reflects lives here as a
 * signal, so a single `signal.value = …` assignment from a WireClient event
 * handler (see `controller.ts`) re-renders exactly the components that read it.
 *
 * The store is a plain bag of independent signals rather than one big object
 * signal: fine-grained signals keep re-renders surgical (a position update does
 * not re-run the diagnostics panel) and keep `exactOptionalPropertyTypes`
 * happy (optional fields like a fault's driver are modelled with explicit
 * `| null` sentinels rather than `undefined`).
 *
 * The small value types here are intentionally structurally identical to the
 * prop types the individual panels already declare (e.g. `DrawingControls`'s
 * `ConnectionStatus` / `DrawingExecState`, `DiagnosticsPanel`'s `FaultState`),
 * so a store value drops straight into a panel prop with no adaptor.
 *
 * @see Design §10.2 (web build / SPA shell), §3.1.5 (WireClient)
 * @see Requirements 8.x, 9.x, 10.x, 12.x, 13.x
 */

import { signal, type Signal } from '@preact/signals';
import { FEED_SPS_MAX } from '../constants';
import type { PlannedPath } from '../types';

// -----------------------------------------------------------------------------
// Value types (structurally aligned with the panel prop types)
// -----------------------------------------------------------------------------

/** Connection-level status shown by the indicators (Req 12.1). */
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

/** Drawing-execution state governing control visibility (Req 9.1, 9.3, 9.5). */
export type DrawingExecState =
    | 'idle'
    | 'drawing'
    | 'paused'
    | 'completing'
    | 'cancelled'
    | 'error';

/** A logical stylus position in integer motor steps relative to home. */
export interface PositionSteps {
    x: number;
    y: number;
}

/** Per-axis stored backlash, in full motor steps (Req 13.8). */
export interface BacklashValues {
    x: number;
    y: number;
}

/** Reported A4988 driver fault condition (Req 12.5, 12.6). */
export interface FaultState {
    active: boolean;
    /** Which driver triggered the fault (e.g. "X"/"Y"); omitted when unknown. */
    driver?: string;
}

/** Reported motor stall condition (Req 12.3). */
export interface StallState {
    active: boolean;
    /** Which axis stalled; omitted when not yet known. */
    axis?: 'x' | 'y';
}

/** Per-axis outcome of a motor-test run (Req 12.4). */
export interface MotorTestResult {
    xPass: boolean;
    yPass: boolean;
}

/**
 * A measured travel envelope in motor steps (Envelope_X_Steps / Envelope_Y_Steps).
 *
 * Structurally identical to the `StepEnvelope` produced by `path/scale.ts`
 * (task 7.2). It is defined locally here rather than imported so the store has
 * no dependency on the scaling module — keeping the single store import graph
 * flat and avoiding a build-order coupling while 7.2 lands concurrently. The
 * two definitions are intentionally compatible (`{ x: number; y: number }`).
 *
 * @see Requirements 8.3
 */
export interface StepEnvelope {
    x: number;
    y: number;
}

// -----------------------------------------------------------------------------
// The store
// -----------------------------------------------------------------------------

/**
 * The full set of reactive stores. Created once per app instance by
 * {@link createStores} and threaded into both the controller (which writes
 * them from WireClient events) and the {@link App} shell (which reads them).
 */
export interface AppStores {
    /** The planned path driving the Canvas/Preview (Req 8.1, 8.2). */
    plannedPath: Signal<PlannedPath | null>;
    /** Connection-level status (Req 12.1). */
    connection: Signal<ConnectionStatus>;
    /** Drawing-execution state (Req 9.x). */
    drawingState: Signal<DrawingExecState>;
    /** Percent complete in `[0, 100]` (Req 7.4). */
    progressPct: Signal<number>;
    /** Current stylus position in steps relative to home (Req 10.9). */
    position: Signal<PositionSteps>;
    /** Latest WiFi RSSI in dBm, or `null` when unavailable (Req 12.2). */
    rssiDbm: Signal<number | null>;
    /** Current fault condition (Req 12.5, 12.6). */
    fault: Signal<FaultState>;
    /** Current stall condition (Req 12.3). */
    stall: Signal<StallState>;
    /** Whether the controller's position is calibrated (Req 10.11). */
    calibrated: Signal<boolean>;
    /**
     * Measured travel envelope in motor steps, or `null` when no valid
     * Step_Envelope has been captured (Req 8.3). Distinct from {@link calibrated}
     * (home set): an envelope exists only after both corners are captured.
     */
    envelope: Signal<StepEnvelope | null>;
    /**
     * Whether a valid Step_Envelope is calibrated — the Drawing_Gate predicate.
     * Distinct from {@link calibrated} (home set) so the UI can show which
     * calibration step remains (Req 4.5, 8.5).
     */
    envelopeCalibrated: Signal<boolean>;
    /** Whether the firmware reported an unclean shutdown on boot (Req 10.12). */
    uncleanShutdown: Signal<boolean>;
    /** Last known position retained as a hint after unclean shutdown (Req 10.12). */
    lastKnownPosition: Signal<PositionSteps | null>;
    /** Currently stored per-axis backlash values (Req 13.8). */
    backlash: Signal<BacklashValues>;
    /** Whether a backlash calibration has been performed (Req 13.11). */
    backlashCalibrationPerformed: Signal<boolean>;
    /** Current speed-percent in `[25, 100]` (Req 9.7). */
    speedPct: Signal<number>;
    /** Whether a motor test is currently running (Req 12.4). */
    motorTestRunning: Signal<boolean>;
    /** Latest motor-test result, or `null` if none yet (Req 12.4). */
    motorTestResult: Signal<MotorTestResult | null>;
    /** Feed rate (steps/second) used for time estimates / command emission. */
    feedSps: Signal<number>;
    /**
     * Drawing scale as a percent in [10, 100]: the fraction of the (effective)
     * envelope the fitted drawing fills. 100 fills to the edges; lower draws
     * proportionally smaller and centered. Threaded into the planner's
     * envelope-fit as `fillFraction`.
     */
    scalePct: Signal<number>;
    /**
     * Whether to return the pen to home (0,0) after a drawing, routed via the
     * envelope edges so the return line hugs the border instead of cutting
     * across the finished art. When false the pen is left where the drawing
     * ends (no return travel at all).
     */
    edgeReturnHome: Signal<boolean>;
    /** Latest image-import error message, or `null` when cleared (Req 2.x). */
    imageError: Signal<string | null>;
    /**
     * Latest transport/connection error message, or `null` when none. Set when
     * the configured transport is unavailable in this browser (e.g. Web
     * Bluetooth missing) so the shell can surface it instead of failing
     * silently (Req 4.5, 4.6).
     */
    connectionError: Signal<string | null>;
    /**
     * Non-blocking notice surfaced by the SceneStore's persistence layer
     * (Req 14.6, 14.7). The Composer's persistence adapter writes here when a
     * snapshot would exceed the soft size cap or `localStorage` throws so the
     * shell can render a transient banner without crashing or blocking the
     * user. `null` means no notice is currently displayed.
     */
    notice: Signal<string | null>;
}

/**
 * Build a fresh set of stores seeded with safe initial values: disconnected,
 * idle, uncalibrated, no path, zero backlash, full feed rate. Every field is
 * an independent signal so updates stay surgical.
 */
export function createStores(): AppStores {
    return {
        plannedPath: signal<PlannedPath | null>(null),
        connection: signal<ConnectionStatus>('disconnected'),
        drawingState: signal<DrawingExecState>('idle'),
        progressPct: signal(0),
        position: signal<PositionSteps>({ x: 0, y: 0 }),
        rssiDbm: signal<number | null>(null),
        fault: signal<FaultState>({ active: false }),
        stall: signal<StallState>({ active: false }),
        calibrated: signal(false),
        envelope: signal<StepEnvelope | null>(null),
        envelopeCalibrated: signal(false),
        uncleanShutdown: signal(false),
        lastKnownPosition: signal<PositionSteps | null>(null),
        backlash: signal<BacklashValues>({ x: 0, y: 0 }),
        backlashCalibrationPerformed: signal(false),
        // Default draw speed 50% (SPEED_PCT_MAX is 100). The machine is brisk at
        // 100%, so we start gentler; the user can raise it via the speed slider.
        speedPct: signal(50),
        motorTestRunning: signal(false),
        motorTestResult: signal<MotorTestResult | null>(null),
        feedSps: signal(FEED_SPS_MAX),
        // Default drawing scale 80% (of the effective envelope). Below 100% so
        // the fitted drawing keeps a margin from the physical edges (gentler on
        // the mechanical stops); the user can resize via the scale slider.
        scalePct: signal(80),
        // Return to home after a drawing, routed along the envelope edges so the
        // return line stays on the border rather than crossing the art. On by
        // default; the pen cannot lift, so this is the least-intrusive return.
        edgeReturnHome: signal(true),
        imageError: signal<string | null>(null),
        connectionError: signal<string | null>(null),
        notice: signal<string | null>(null),
    };
}
