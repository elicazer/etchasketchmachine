/**
 * `controller` — the behavioural half of the SPA integration (task 29.1).
 *
 * Where {@link AppStores} holds the reactive state, this module connects that
 * state to the outside world. It owns:
 *
 *   1. **Inbound mapping.** Every {@link WireClient} event is subscribed once
 *      and folded into the stores (Design §3.1.5 event surface →
 *      §10.2 SPA state). `state`/`status` drive connection, drawing-execution
 *      state, position and progress; `progress` the percentage; `rssi` the
 *      signal read-out; `fault`/`stall` the diagnostics indicators; `home`
 *      (the HELLO frame) the calibration flag, current/last-known position and
 *      unclean-shutdown hint.
 *
 *   2. **Outbound callbacks.** The thin functions the UI panels call: planning
 *      input polylines into the planned-path store, streaming a drawing to the
 *      machine (subject to the calibration send-gate, Req 10.11), and the
 *      pause/resume/cancel/speed, jog/home, backlash, and diagnostics control
 *      messages — each mapped to a {@link WireClient.sendControl} call.
 *
 * The controller never imports any UI; it is pure state + transport so it can
 * be unit-tested with a fake socket exactly like the WireClient tests.
 *
 * @see Design §3.1.4 (planner), §3.1.5 (WireClient), §10.2 (SPA shell)
 * @see Requirements 8.x, 9.x, 10.x, 12.x, 13.x, 14.x
 */

import { effect } from '@preact/signals';
import type { Axis, JogDir as CtlJogDir } from '../codec/control';
import { PathPlanner, totalStepCount } from '../path/planner';
import { fitPolylinesToDrawable } from '../path/scale';
import { WireClient, type SocketFactory } from '../net/wire_client';
import type { Polyline } from '../types';
import type { AppStores, ConnectionStatus, DrawingExecState } from './stores';

// -----------------------------------------------------------------------------
// Controller-state code mapping (must match firmware StatusReporter::StatusState)
// -----------------------------------------------------------------------------

/**
 * Coarse controller-state codes carried in STATE / STATUS frames (offset 12).
 * Wire-stable; mirrors `firmware/src/diagnostics/status_reporter.h`.
 */
export const CONTROLLER_STATE = Object.freeze({
    IDLE: 0,
    DRAWING: 1,
    PAUSED: 2,
    FAULT: 3,
    STALL: 4,
} as const);

/**
 * Map a controller state code to the UI's drawing-execution state, or `null`
 * when the code should not move the execution state (fault/stall surface
 * through their own indicators and must not, for example, hide the pause
 * button mid-drawing).
 */
export function mapControllerState(code: number): DrawingExecState | null {
    switch (code) {
        case CONTROLLER_STATE.IDLE:
            return 'idle';
        case CONTROLLER_STATE.DRAWING:
            return 'drawing';
        case CONTROLLER_STATE.PAUSED:
            return 'paused';
        default:
            return null;
    }
}

/** Collapse the WireClient's 4-state connection onto the UI's 3-state trio. */
export function mapConnection(
    s: 'disconnected' | 'connecting' | 'connected' | 'reconnecting',
): ConnectionStatus {
    if (s === 'connected') return 'connected';
    if (s === 'disconnected') return 'disconnected';
    // 'connecting' and 'reconnecting' both read as "connecting" (Req 12.1).
    return 'connecting';
}

/** Map a CalibrationWizard axis label to the wire axis code. */
function axisCode(axis: 'x' | 'y'): Axis {
    return axis === 'x' ? 0 : 1;
}

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

/** Construction options for {@link createController}. */
export interface ControllerOptions {
    /** WebSocket URL of the controller. */
    url: string;
    /** Pre-built stores (defaults to a fresh {@link createStores}). */
    stores: AppStores;
    /** Pre-built WireClient (injectable for tests; defaults to a real one). */
    client?: WireClient;
    /**
     * Socket factory selecting the transport (BLE vs WebSocket). Handed to the
     * default {@link WireClient} so the same UI drives either transport
     * (Design §2, §3.5; Req 4.1, 4.2, 4.3, 4.4). Ignored when a pre-built
     * {@link ControllerOptions.client} is supplied.
     */
    socketFactory?: SocketFactory;
    /** Pre-built PathPlanner (injectable for tests). */
    planner?: PathPlanner;
}

/**
 * The wired controller: the stores it owns, the transport it drives, and the
 * flat set of callbacks the UI invokes. Returned by {@link createController}.
 */
export interface Controller {
    readonly stores: AppStores;
    readonly client: WireClient;
    readonly planner: PathPlanner;
    readonly url: string;

    /** Open the WebSocket and resolve once connected. */
    connect(): Promise<void>;
    /** Tear down the connection (no reconnect). */
    disconnect(): void;

    // -- input pipeline --------------------------------------------------------
    /** Plan input polylines into the planned-path store (Canvas/Preview). */
    setPolylines(polylines: Polyline[], opts?: { flipY?: boolean }): void;
    /** Clear the planned path (e.g. on freehand clear). */
    clearPath(): void;
    /**
     * Stream the current planned path to the machine: BEGIN_DRAW → CMD stream →
     * END_DRAW. Subject to the calibration send-gate (Req 10.11). Resolves once
     * every command is acknowledged; rejects if blocked or a send fails.
     */
    draw(): Promise<void>;

    // -- drawing execution controls (Req 9.x) ---------------------------------
    pause(): void;
    resume(): void;
    cancel(): void;
    /** Emergency stop: halt motion + flush the buffer, available at any time. */
    stop(): void;
    setSpeedPct(pct: number): void;

    // -- calibration / homing (Req 10.x) --------------------------------------
    jog(axis: 'x' | 'y', dir: CtlJogDir, steps?: number): void;
    setHome(): void;
    reHome(): void;

    // -- visual corner calibration (Req 1.x, 2.x) -----------------------------
    /**
     * Capture the bottom-left corner: declares logical home `(0, 0)` and the
     * measurement baseline (CTL `captureBottomLeft`). Optimistically marks the
     * machine homed and clears any prior envelope (re-home clears the envelope,
     * Req 10.1); HELLO/STATUS reconcile authoritatively.
     */
    captureBottomLeft(): void;
    /**
     * Capture the top-right corner: the controller measures the travel envelope
     * from its own step counters (CTL `captureTopRight`). HELLO/STATUS carry the
     * resulting envelope + calibrated flag.
     */
    captureTopRight(): void;

    // -- backlash (Req 13.x) ---------------------------------------------------
    jogAxis(axis: Axis, dir: CtlJogDir, steps?: number): void;
    recordBacklash(axis: Axis, steps: number): void;
    manualEditBacklash(axis: Axis, steps: number): void;

    // -- diagnostics (Req 12.x) -----------------------------------------------
    motorTest(): void;
    faultReset(): void;

    // -- misc UI plumbing ------------------------------------------------------
    setImageError(message: string | null): void;
}

/** Home offset baked into the plan; the SPA always plans relative to (0,0). */
const HOME = { x: 0, y: 0 } as const;

/**
 * Build and wire a {@link Controller}. Subscribes the WireClient's event
 * surface to the stores and returns the callback bundle the UI binds to.
 */
export function createController(opts: ControllerOptions): Controller {
    const { url, stores } = opts;
    const client =
        opts.client ??
        new WireClient(
            opts.socketFactory ? { socketFactory: opts.socketFactory } : {},
        );
    const planner = opts.planner ?? new PathPlanner();

    // ---- inbound: WireClient events → stores --------------------------------

    client.on('state', (e) => {
        if (e.kind === 'connection') {
            stores.connection.value = mapConnection(e.connection);
            return;
        }
        if (e.kind === 'controller') {
            const next = mapControllerState(e.controller);
            if (next !== null) stores.drawingState.value = next;
            return;
        }
        // kind === 'status': a full periodic telemetry frame.
        const next = mapControllerState(e.controller);
        if (next !== null) stores.drawingState.value = next;
        stores.position.value = { x: e.position.x, y: e.position.y };
        stores.progressPct.value = e.pctComplete;
        stores.calibrated.value = e.calibrated;
        // STATUS flags bit2 (Req 8.2, 8.4): fold the envelope-calibrated
        // Drawing_Gate predicate so the UI stays in sync between HELLO frames.
        stores.envelopeCalibrated.value = e.envelopeCalibrated;
    });

    client.on('progress', (e) => {
        stores.progressPct.value = e.pct;
    });

    client.on('rssi', (e) => {
        stores.rssiDbm.value = e.rssiDbm;
    });

    client.on('fault', (e) => {
        if (e.kind === 'homeRequired') {
            // The controller refused to draw uncalibrated: reflect the gate.
            stores.calibrated.value = false;
            stores.drawingState.value = 'error';
            return;
        }
        // fault / unrecoverableTx / connTimeout all light the fault indicator.
        stores.fault.value =
            e.kind === 'fault'
                ? { active: true, driver: e.axis === 1 ? 'Y' : 'X' }
                : { active: true };
        stores.drawingState.value = 'error';
    });

    client.on('stall', (e) => {
        stores.stall.value = { active: true, axis: e.axis === 1 ? 'y' : 'x' };
    });

    client.on('home', (e) => {
        // HELLO frame: calibration flag, current position, unclean hint.
        stores.calibrated.value = e.calibrated;
        stores.position.value = { x: e.position.x, y: e.position.y };
        stores.uncleanShutdown.value = e.unclean;
        stores.lastKnownPosition.value = e.unclean
            ? { x: e.position.x, y: e.position.y }
            : null;
        // Envelope fields (Design §"Defect 2 — Web side", Req 2.5/2.8): the
        // HELLO payload is firmware-authoritative and now carries the EFFECTIVE
        // Step_Envelope — the captured envelope when calibrated, else the baked-in
        // DEFAULT_ENVELOPE. Fold it into `stores.envelope` unconditionally so the
        // plan/draw path has a bounded envelope even uncalibrated; a degenerate
        // (non-positive) envelope still maps to null. `stores.envelopeCalibrated`
        // tracks ONLY whether a captured calibration exists, keeping the
        // recalibration wizard reachable (Req 2.8).
        stores.envelope.value =
            e.envelope.x > 0 && e.envelope.y > 0
                ? { x: e.envelope.x, y: e.envelope.y }
                : null;
        stores.envelopeCalibrated.value = e.envelopeCalibrated;
    });

    // ---- outbound: UI callbacks → transport ---------------------------------

    // Retain the most recent raw input so the planned path can be rebuilt when
    // the calibration state changes (e.g. an envelope is captured after the
    // geometry was imported). `plan()` selects the envelope-fit branch when an
    // envelope is supplied and bypasses the mm gear-math; otherwise it fits
    // into the mm drawable area as before.
    let lastInput: { polylines: Polyline[]; flipY: boolean } | null = null;

    /**
     * Build the planned path from the retained input and the current envelope.
     *
     * Envelope-fit branch (Design §"Defect 2 — Web side", Req 2.5/3.6): whenever
     * an effective Step_Envelope is present (`stores.envelope` — captured when
     * calibrated, else the firmware DEFAULT_ENVELOPE), the raw source polylines
     * are handed to `plan({ envelopeSteps, flipY })`, which fits them directly
     * into step space via `fitPolylinesToEnvelope` (no mm→steps scaling). This is
     * no longer gated on `envelopeCalibrated`, so an uncalibrated machine still
     * plans within the bounded default envelope. The screen-space Y flip is
     * forwarded to the planner rather than pre-applied via
     * `fitPolylinesToDrawable`.
     *
     * mm branch (fallback): only when no effective envelope is known do we keep
     * the legacy flow — `fitPolylinesToDrawable` (which applies the Y flip) then
     * mm gear-math.
     */
    function rebuildPlan(): void {
        if (lastInput === null) {
            stores.plannedPath.value = null;
            return;
        }
        const { polylines, flipY } = lastInput;
        const envelope = stores.envelope.value;
        if (envelope) {
            stores.plannedPath.value = planner.plan(
                { polylines },
                {
                    feedSps: stores.feedSps.value,
                    homeOffsetSteps: { ...HOME },
                    envelopeSteps: { x: envelope.x, y: envelope.y },
                    fillFraction: Math.max(
                        0.1,
                        Math.min(1, stores.scalePct.value / 100),
                    ),
                    flipY,
                    // Return home after the drawing, routed along the envelope
                    // edges so the return line hugs the border instead of
                    // crossing the art. Toggleable via the UI; when off, the
                    // pen is left where the drawing ends.
                    returnToHome: stores.edgeReturnHome.value,
                    edgeReturn: true,
                    // Hide inter-stroke travel by routing connectors over
                    // already-drawn ink + the envelope border (the router falls
                    // back to a straight connector whenever it can't strictly
                    // reduce visible ink, so this never makes the drawing worse).
                    // This is what keeps the connecting lines discreet on the
                    // physical, no-pen-lift machine.
                    connectorHiding: true,
                },
            );
            return;
        }
        // No effective envelope: legacy mm fit (the Y flip is applied here).
        const fitted = fitPolylinesToDrawable(polylines, { flipY });
        stores.plannedPath.value = planner.plan(
            { polylines: fitted },
            { feedSps: stores.feedSps.value, homeOffsetSteps: { ...HOME } },
        );
    }

    // Re-plan whenever the envelope or its calibrated flag changes so a drawing
    // imported before calibration is automatically re-fitted into the measured
    // envelope once both corners are captured (re-plan on envelope change is
    // acceptable and keeps the planned path authoritative).
    effect(() => {
        // Touch the dependencies so the effect re-runs on change.
        void stores.envelope.value;
        void stores.envelopeCalibrated.value;
        void stores.scalePct.value;
        void stores.edgeReturnHome.value;
        rebuildPlan();
    });

    function setPolylines(polylines: Polyline[], opts?: { flipY?: boolean }): void {
        if (polylines.length === 0) {
            lastInput = null;
            stores.plannedPath.value = null;
            return;
        }
        // Auto-fit the imported geometry so the user never has to fiddle with
        // scale/position controls. Screen-space sources (image/SVG/freehand)
        // flip Y; text is already authored +Y up and must not flip. The actual
        // fit (envelope-fit vs mm) is chosen in `rebuildPlan`.
        lastInput = { polylines, flipY: opts?.flipY ?? false };
        rebuildPlan();
    }

    function clearPath(): void {
        lastInput = null;
        stores.plannedPath.value = null;
    }

    async function draw(): Promise<void> {
        // Drawing_Gate (Defect 2 fix, Req 2.8/3.5): a drawing may be streamed
        // once an *effective* Step_Envelope is known — the captured envelope
        // when calibrated, else the firmware-authoritative DEFAULT_ENVELOPE
        // folded into `stores.envelope`. We no longer gate on a captured
        // calibration, so an uncalibrated machine draws within the bounded
        // default. The genuine invalid-envelope case still surfaces through the
        // firmware NACK→`envelopeRequired` fault mirror in the WireClient.
        const path = stores.plannedPath.value;
        if (!stores.envelope.value || !path || path.segments.length === 0) return;

        const feedSps = stores.feedSps.value;
        const commands = planner.toCommands(path, { ...HOME }, feedSps);
        if (commands.length === 0) return;

        const totalSteps = totalStepCount(path);

        // BEGIN_DRAW is itself send-gated on calibration (Req 10.11); if it
        // rejects, no command is ever queued.
        await client.sendControl({
            kind: 'beginDraw',
            totalSegments: path.segments.length,
            totalSteps,
        });
        stores.drawingState.value = 'drawing';

        // Queue every command; the WireClient's credit-based flow control
        // releases them as buffer slots free up. Each promise resolves on ACK.
        const acks = commands.map((cmd) => client.sendCommand(cmd));
        await Promise.all(acks);

        await client.sendControl({ kind: 'endDraw' });
    }

    function pause(): void {
        void client.sendControl({ kind: 'pause' });
    }
    function resume(): void {
        void client.sendControl({ kind: 'resume' });
    }
    function cancel(): void {
        void client.sendControl({ kind: 'cancel' });
        stores.drawingState.value = 'cancelled';
    }
    /**
     * Emergency stop (Req 9.x STOP): immediately halt motion and discard the
     * command buffer on the controller. Unlike {@link cancel}, this is always
     * available (not gated on drawing state) so the user can halt a runaway at
     * any time, and it is sent ahead of any pending queued sends. NOTE: this is
     * a best-effort software stop bounded by BLE latency and link health — it
     * is NOT a substitute for cutting motor power at the hardware level.
     */
    function stop(): void {
        void client.sendControl({ kind: 'stop' });
        stores.drawingState.value = 'cancelled';
    }
    function setSpeedPct(pct: number): void {
        stores.speedPct.value = pct;
        void client.sendControl({ kind: 'speedPct', pct });
    }

    function jogAxis(axis: Axis, dir: CtlJogDir, steps = 1): void {
        const n = Math.max(1, Math.min(0xffff, Math.round(steps)));
        void client.sendControl({ kind: 'jog', axis, dir, steps: n });
    }
    function jog(axis: 'x' | 'y', dir: CtlJogDir, steps = 1): void {
        jogAxis(axisCode(axis), dir, steps);
    }
    function setHome(): void {
        void client.sendControl({ kind: 'setHome' });
        // Optimistically reflect the home declaration; the next STATUS/HELLO
        // frame is authoritative.
        stores.calibrated.value = true;
        stores.position.value = { x: 0, y: 0 };
        stores.uncleanShutdown.value = false;
        stores.lastKnownPosition.value = null;
    }
    function reHome(): void {
        void client.sendControl({ kind: 'reHome' });
        stores.calibrated.value = false;
    }

    /**
     * Capture the bottom-left corner (Req 1.x, 10.1). Sends CTL
     * `captureBottomLeft`, then optimistically reflects the new state: home is
     * declared (`calibrated = true`, position zeroed) and any prior envelope is
     * cleared — re-homing invalidates the previous Step_Envelope (Req 10.1), so
     * the Drawing_Gate closes until the top-right corner is re-captured. The
     * next HELLO/STATUS frame is authoritative and reconciles these values.
     */
    function captureBottomLeft(): void {
        void client.sendControl({ kind: 'captureBottomLeft' });
        stores.calibrated.value = true;
        stores.position.value = { x: 0, y: 0 };
        stores.uncleanShutdown.value = false;
        stores.lastKnownPosition.value = null;
        stores.envelope.value = null;
        stores.envelopeCalibrated.value = false;
    }

    /**
     * Capture the top-right corner (Req 1.x, 2.x). Sends CTL `captureTopRight`;
     * the controller measures the travel envelope from its own step counters
     * and reports the result (and the envelope-calibrated flag) on the next
     * HELLO/STATUS frame, which the inbound folds apply. No optimistic envelope
     * is set here — a measured envelope is the controller's authority.
     */
    function captureTopRight(): void {
        void client.sendControl({ kind: 'captureTopRight' });
    }

    /** Send the current backlash pair with one axis overridden, and store it. */
    function sendBacklash(axis: Axis, steps: number): void {
        const current = stores.backlash.value;
        const next =
            axis === 0 ? { x: steps, y: current.y } : { x: current.x, y: steps };
        stores.backlash.value = next;
        stores.backlashCalibrationPerformed.value = true;
        void client.sendControl({ kind: 'setBacklash', x: next.x, y: next.y });
    }
    function recordBacklash(axis: Axis, steps: number): void {
        sendBacklash(axis, steps);
    }
    function manualEditBacklash(axis: Axis, steps: number): void {
        sendBacklash(axis, steps);
    }

    function motorTest(): void {
        stores.motorTestRunning.value = true;
        void client.sendControl({ kind: 'motorTest' });
    }
    function faultReset(): void {
        void client.sendControl({ kind: 'faultReset' });
        stores.fault.value = { active: false };
        stores.stall.value = { active: false };
    }

    function setImageError(message: string | null): void {
        stores.imageError.value = message;
    }

    return {
        stores,
        client,
        planner,
        url,
        connect: () => client.connect(url),
        disconnect: () => client.close(),
        setPolylines,
        clearPath,
        draw,
        pause,
        resume,
        cancel,
        stop,
        setSpeedPct,
        jog,
        setHome,
        reHome,
        captureBottomLeft,
        captureTopRight,
        jogAxis,
        recordBacklash,
        manualEditBacklash,
        motorTest,
        faultReset,
        setImageError,
    };
}
