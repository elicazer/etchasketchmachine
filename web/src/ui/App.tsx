/**
 * `App` — the top-level application shell.
 *
 * Originally (task 24.1) this was a layout-only shell with placeholder slots,
 * then task 29.1 replaced the slots with the real input panels and canvas.
 * The unified-composer-canvas feature now restructures the Draw view around
 * the {@link SceneStore}: a left-rail {@link ItemsListPanel} (with the
 * {@link AddItemMenu} on top) replaces the mutually-exclusive image / text /
 * freehand tabs, and a {@link ComposerCanvas} replaces the central
 * {@link Canvas}. The preview transport ({@link AnimationPlayback}), the
 * machine drawing controls, the Send-to-machine cluster, and the static
 * {@link Preview} thumbnail now stack inside a single right-hand control
 * dock (Req 12.1, 12.2). The top app shell (logo, Setup tab, Connect button),
 * the drawing controls (E-STOP, Pause/Resume/Cancel, SPEED slider),
 * Calibration, Backlash, Diagnostics, and the `controller` / `stores` API
 * surfaces are all unchanged (Req 12.3, 16.2, 16.3).
 *
 * "Send to machine" handler (Req 9.4, 9.5):
 *   - When `store.composed.value.length === 0`, the planned path is cleared
 *     (`controller.clearPath()`) and no draw is initiated. This keeps the
 *     existing canvas/preview state consistent with an empty scene.
 *   - Otherwise the composed polylines flow through `controller.setPolylines`
 *     (with `flipY: true` so screen-space sources land the right way up on
 *     the physical machine) followed by `controller.draw()`. The handler
 *     issues exactly one `setPolylines` call per Send action (Req 9.4).
 *
 * The shell does NOT push intermediate composed polylines into
 * `controller.setPolylines` from any reactive effect; the only entry point is
 * the Send handler above (Req 11.3, 11.4). A single `effect` watches
 * `store.scene` for the items-length transition `positive → 0` and fires
 * `controller.clearPath()` so the canvas / preview remain consistent with
 * the existing controller contract when the user empties the scene
 * (Req 12.4).
 *
 * @see Design §3.1.6 (UI), §10.2 (SPA shell)
 * @see .kiro/specs/unified-composer-canvas/design.md §"Components and Interfaces"
 * @see Requirements 9.4, 9.5, 11.3, 11.4, 12.1, 12.2, 12.3, 12.4, 13.1, 13.3,
 *      16.1, 16.2, 16.3
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { computed, effect, type ReadonlySignal } from '@preact/signals';

import type { Controller } from '../app/controller';
import { DRAWABLE_MM } from '../constants';
import { totalStepCount } from '../path/planner';
import type { SceneStore } from '../composer/scene_store';
import type { ItemId } from '../composer/types';
import { Preview } from './Preview';
import { DrawingControls } from './DrawingControls';
import { CalibrationWizard } from './CalibrationWizard';
import { BacklashWizard } from './BacklashWizard';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { AddItemMenu } from './composer/AddItemMenu';
import { AnimationPlayback } from './composer/AnimationPlayback';
import { usePlayback } from './composer/use_playback';
import { ComposerCanvas } from './composer/ComposerCanvas';
import { ItemsListPanel } from './composer/ItemsListPanel';

// The Etch-a-Sketch frame photo, force-inlined as a base64 data URL so the
// single-file build embeds it directly (Design §10.2). Optimised WebP (~8 KB).
import etchPhoto from './assets/etch-a-sketch.webp?inline';

/**
 * Screen-window geometry of {@link etchPhoto}: the drawing area sits at these
 * inset percentages inside the photo (auto-detected from the asset). The frame
 * exposes them as CSS variables so the digital twin and the Setup position map
 * align exactly to the real "MAGIC SCREEN" window. Tweak here if the photo is
 * ever re-cropped.
 */
const EAS_SCREEN_STYLE = {
    '--eas-photo': `url("${etchPhoto}")`,
    '--eas-screen-left': '15.4%',
    '--eas-screen-right': '15.2%',
    '--eas-screen-top': '18.1%',
    '--eas-screen-bottom': '22.0%',
} as unknown as preact.JSX.CSSProperties;

/** Top-level view: the everyday Draw screen vs the occasional Setup screen. */
type View = 'draw' | 'setup';

export interface AppProps {
    /** The wired controller (stores + transport + UI callbacks). */
    controller: Controller;
    /**
     * The Composer's reactive scene store. Single source of truth for items,
     * selection, history, and the derived `composed` polylines that the Send
     * handler hands to `controller.setPolylines` (Req 12.1, 12.2).
     */
    store: SceneStore;
}

/**
 * Render the application shell, mounting every panel and wiring it to the
 * controller and the SceneStore. State is read live from the controller's
 * signal stores and the scene store; reading `signal.value` during render
 * subscribes the shell to exactly those signals.
 */
export function App(props: AppProps): preact.JSX.Element {
    const { controller, store } = props;
    const { stores } = controller;
    const [view, setView] = useState<View>('draw');
    /**
     * When non-null, the AddItemMenu opens the matching Add-* modal in
     * re-edit mode for that item. Set by the items list's per-row edit
     * button (`onEditItem`); cleared by the menu via `onEditDone` once the
     * modal closes (commit / cancel / Escape / backdrop). The menu resolves
     * the item's kind (and, for text, its current source) from the store,
     * so the shell only needs to thread the id.
     *
     * Lives here in the shell — the only common ancestor of the items
     * list and the add menu — so the bridge between them is a single
     * piece of state rather than a separate imperative ref.
     */
    const [editingItemId, setEditingItemId] = useState<ItemId | null>(null);

    // Live store reads — each subscribes the shell to that signal.
    const path = stores.plannedPath.value;
    const feedSps = stores.feedSps.value;
    const connection = stores.connection.value;
    const drawingState = stores.drawingState.value;
    const connectionError = stores.connectionError.value;
    const notice = stores.notice.value;
    const calibrated = stores.calibrated.value;
    // Drawing requires an *effective* Step_Envelope, not a captured calibration
    // (Defect 2 fix, Req 2.8/3.5). `stores.envelope` carries the firmware-
    // authoritative effective envelope — the captured envelope when calibrated,
    // else the bounded DEFAULT_ENVELOPE — so the send-gate opens with the
    // default and an uncalibrated machine can still draw. `envelopeCalibrated`
    // is retained only to surface the recalibration prompt, never to gate.
    const envelope = stores.envelope.value;
    const lastKnown = stores.lastKnownPosition.value;
    const fault = stores.fault.value;
    const stall = stores.stall.value;

    // Live composed polylines drive the Send-button gate. We deliberately do
    // NOT pipe these through `controller.setPolylines` here: that side effect
    // is reserved for the Send handler so intermediate gesture states never
    // hit the planner (Req 11.3, 11.4).
    const composed = store.composed.value;
    const hasComposed = composed.length > 0;
    const drawingActive = drawingState === 'drawing' || drawingState === 'paused';
    const canDraw = hasComposed && !!envelope && !drawingActive;

    // Scene emptiness drives the on-canvas empty hint (rendered over the
    // stage, never inside a dock, so an empty scene never bloats the docks).
    const sceneEmpty = store.scene.value.items.length === 0;

    /**
     * Machine-side ETA in milliseconds, derived from the existing planner
     * pipeline (`stores.plannedPath` × `stores.feedSps`) — the same figure the
     * static `Preview` shows. Wrapped in `useMemo` so the `computed` signal
     * is constructed once per `stores` instance; the underlying signal
     * subscriptions inside `computed` keep the value live (Req 18.13).
     */
    const machineEtaMs: ReadonlySignal<number | null> = useMemo(
        () =>
            computed<number | null>(() => {
                const p = stores.plannedPath.value;
                const f = stores.feedSps.value;
                if (!p || p.segments.length === 0) return null;
                if (!Number.isFinite(f) || f <= 0) return null;
                return (totalStepCount(p) * 1000) / f;
            }),
        [stores],
    );

    /**
     * The shared preview-playback engine. A single hook instance drives BOTH
     * the on-canvas preview (the moving stylus + progressive reveal rendered
     * by {@link ComposerCanvas}) and the slim transport bar
     * ({@link AnimationPlayback}), which now lives at the TOP of the
     * right-hand control dock, so everything references one source of truth
     * (Req 18.x). The engine reads the same `store.composed` polylines
     * `Send to machine` transmits and the `machineEtaMs` derived above —
     * never the controller (Req 18.10).
     */
    const playback = usePlayback(store.composed, machineEtaMs);

    /**
     * Starting a preview clears the current selection so the edit handles
     * vanish cleanly while the stylus animates (the canvas also suppresses
     * the overlay when `preview.active`, but clearing the selection keeps the
     * items-list highlight and the canvas in agreement). Returning to the
     * stopped state leaves the (now empty) selection untouched.
     */
    useEffect(() => {
        if (playback.state !== 'stopped' && store.selectedItem.value !== null) {
            store.select(null);
        }
    }, [playback.state, store]);

    /**
     * Watch the scene's item count for the `positive → 0` transition and
     * clear the planner's path so the static canvas / preview state stays
     * consistent with the existing controller contract (Req 12.4). This is
     * the ONLY effect that touches the controller as a side effect of the
     * Composer's state — every `setPolylines` call still flows through the
     * Send handler below.
     */
    useEffect(() => {
        let prevLen = store.scene.value.items.length;
        const dispose = effect(() => {
            const len = store.scene.value.items.length;
            if (prevLen > 0 && len === 0) {
                controller.clearPath();
            }
            prevLen = len;
        });
        return dispose;
    }, [store, controller]);

    const connLabel =
        connection === 'connected'
            ? 'Connected'
            : connection === 'connecting'
                ? 'Connecting…'
                : 'Disconnected';

    const connectBtnLabel =
        connection === 'connected'
            ? 'Disconnect'
            : connection === 'connecting'
                ? 'Connecting…'
                : 'Connect';

    const onConnectClick = (): void => {
        if (connection === 'connected') {
            controller.disconnect();
        } else if (connection === 'disconnected') {
            // Connection failures surface through the connectionError signal
            // and the existing banner; swallow the promise rejection so it is
            // not unhandled.
            void controller.connect().catch(() => { });
        }
    };

    /**
     * Send the currently composed polylines to the machine. Exactly one
     * `setPolylines` call per activation (Req 9.4); when the scene is empty
     * we clear the planner path and skip `draw()` so an empty Send is a
     * no-op on the machine while still keeping the planner in sync.
     */
    const onSendToMachine = (): void => {
        if (store.composed.value.length === 0) {
            controller.clearPath();
            return;
        }
        // `flipY: true` matches the existing screen-space convention used by
        // the image / freehand inputs (the dominant source kinds). The text
        // generator already emits +Y up, but is consumed in the same scene
        // coordinate space and is flipped in concert with the rest. The
        // composed polylines are the single planner input from the Composer
        // (Req 9.5).
        controller.setPolylines(store.composed.value, { flipY: true });
        void controller.draw();
    };

    return (
        <div class="app" data-testid="app">
            <header class="app__header" data-testid="app-header">
                <h1 class="app__title">Etch-a-Sketch</h1>

                <nav class="app__nav" role="tablist" aria-label="Views">
                    <button
                        type="button"
                        role="tab"
                        data-testid="view-draw"
                        aria-selected={view === 'draw'}
                        onClick={() => setView('draw')}
                    >
                        Draw
                    </button>
                    <button
                        type="button"
                        role="tab"
                        data-testid="view-setup"
                        aria-selected={view === 'setup'}
                        onClick={() => setView('setup')}
                    >
                        Setup
                        {!calibrated && <span class="app__nav-dot" aria-hidden="true" />}
                    </button>
                </nav>

                <button
                    type="button"
                    class={`app__connect-btn app__connect-btn--${connection}`}
                    data-testid="app-connect"
                    disabled={connection === 'connecting'}
                    onClick={onConnectClick}
                >
                    {connectBtnLabel}
                </button>

                <span
                    class={`app__conn app__conn--${connection}`}
                    data-testid="app-conn"
                >
                    {connLabel}
                </span>
            </header>

            {/* Transport/connection error banner. Only rendered when a
                transport is unavailable (e.g. Web Bluetooth missing); in the
                normal case the shell is identical across transports
                (Req 4.3, 4.5, 4.6). */}
            {connectionError !== null && (
                <div
                    class="app__error"
                    role="alert"
                    data-testid="app-connection-error"
                >
                    {connectionError}
                </div>
            )}

            {/* Composer-persistence notice (Req 14.6, 14.7). Non-blocking:
                the in-memory Scene continues to function; the user can
                dismiss the notice by editing the Scene further (the next
                successful save clears it implicitly when the SceneStore's
                persistence layer succeeds — until then the banner remains
                so the user is aware their changes are not auto-saved). */}
            {notice !== null && (
                <div
                    class="app__notice"
                    role="status"
                    data-testid="app-notice"
                >
                    {notice}
                </div>
            )}

            {view === 'draw' ? (
                /* Studio stage: a full-bleed canvas surface with floating
                   glass docks layered over it. The stage is the canvas's
                   centring context (flex-centred so the white surface sits
                   dead-centre with even gutters — no letterbox void), while
                   the docks float above via absolute positioning. The canvas
                   is flanked by a tool dock (left) and a control dock
                   (right); there is no longer any floating top/bottom bar. */
                <main class="studio-stage" data-testid="app-canvas-area">
                    {/* The digital twin lives inside a photoreal Etch-a-Sketch
                        frame: the photo is the frame chrome, and the composer
                        canvas is inset precisely into the real "MAGIC SCREEN"
                        window so strokes appear to be drawn on the toy itself. */}
                    <div
                        class="eas-frame eas-frame--draw"
                        style={EAS_SCREEN_STYLE}
                        data-testid="eas-frame"
                    >
                        <ComposerCanvas
                            store={store}
                            envelopeMm={DRAWABLE_MM}
                            class="composer-canvas--framed"
                            preview={{
                                active: playback.active,
                                revealFraction: playback.revealFraction,
                                indicator: playback.indicatorPoint,
                            }}
                        />

                        {sceneEmpty && (
                            <p class="studio-empty-hint" aria-hidden="true">
                                Add an image, text, or a freehand drawing to
                                start composing
                            </p>
                        )}
                    </div>

                    {/* Left dock — tools (AddItemMenu) + the layers list. */}
                    <aside
                        class="studio-dock studio-dock--left"
                        aria-label="Tools and layers"
                    >
                        <ItemsListPanel
                            store={store}
                            addMenu={
                                <AddItemMenu
                                    store={store}
                                    controller={controller}
                                    editingItemId={editingItemId}
                                    onEditDone={() => setEditingItemId(null)}
                                />
                            }
                            onEditItem={(id) => setEditingItemId(id)}
                            class="studio-dock__panel"
                        />
                    </aside>

                    {/* Right dock — the control column. Top to bottom: the
                        preview transport, the machine controls (connection
                        status, position, STOP, speed), the Send-to-machine
                        cluster, and finally the static preview thumbnail
                        (only once a planned path exists). Carries the
                        `app-controls-slot` testid the integration tests look
                        for (relocated from the old bottom bar). */}
                    <aside
                        class="studio-dock studio-dock--right"
                        data-testid="app-controls-slot"
                        aria-label="Playback and machine controls"
                    >
                        <section class="dock-section" aria-label="Preview">
                            <h3 class="dock-section__title">Preview</h3>
                            <AnimationPlayback playback={playback} />
                        </section>

                        <section class="dock-section" aria-label="Machine">
                            <h3 class="dock-section__title">Machine</h3>
                            <DrawingControls
                            connection={connection}
                            drawingState={drawingState}
                            progressPct={stores.progressPct.value}
                            position={stores.position.value}
                            speedPct={stores.speedPct.value}
                            onPause={() => controller.pause()}
                            onResume={() => controller.resume()}
                            onCancel={() => controller.cancel()}
                            onStop={() => controller.stop()}
                            onSpeedChange={(pct) => controller.setSpeedPct(pct)}
                        />

                        <div class="studio-dock__send">
                            <button
                                type="button"
                                class="app__draw-button"
                                data-testid="send-to-machine"
                                disabled={!canDraw}
                                onClick={onSendToMachine}
                            >
                                Send to machine
                            </button>
                            <label
                                class="app__return-home"
                                data-testid="return-home-toggle"
                            >
                                <input
                                    type="checkbox"
                                    checked={stores.edgeReturnHome.value}
                                    onChange={(e) => {
                                        stores.edgeReturnHome.value = (
                                            e.currentTarget as HTMLInputElement
                                        ).checked;
                                    }}
                                />
                                Return to home along the edges when finished
                            </label>
                            {!envelope && hasComposed && (
                                <p
                                    class="app__draw-hint"
                                    data-testid="send-blocked-hint"
                                >
                                    Connect to the machine before drawing.
                                </p>
                            )}
                        </div>
                        </section>

                        {path !== null && (
                            <div
                                class="app__preview-slot"
                                data-testid="app-preview-slot"
                            >
                                <Preview
                                    path={path}
                                    feedSps={feedSps}
                                    hideControls={true}
                                    backlash={stores.backlash.value}
                                />
                            </div>
                        )}
                    </aside>
                </main>
            ) : (
                /* Setup view mirrors the Draw studio layout: the same
                   photoreal Etch-a-Sketch sits centre-stage (its screen now
                   shows a live machine-position map instead of the composer),
                   flanked by the setup controls — Calibration in the left
                   dock, Backlash + Diagnostics in the right dock. */
                <main
                    class="studio-stage studio-stage--setup-studio"
                    data-testid="app-setup"
                >
                    <div
                        class="eas-frame eas-frame--setup"
                        style={EAS_SCREEN_STYLE}
                        data-testid="eas-frame-setup"
                    >
                        <MachinePositionScreen
                            connection={connection}
                            position={stores.position.value}
                            envelope={stores.envelope.value}
                            calibrated={calibrated}
                            envelopeCalibrated={stores.envelopeCalibrated.value}
                        />
                    </div>

                    <aside
                        class="studio-dock studio-dock--left"
                        aria-label="Calibration"
                    >
                        <CalibrationWizard
                            calibrated={calibrated}
                            envelope={stores.envelope.value}
                            envelopeCalibrated={stores.envelopeCalibrated.value}
                            currentPosition={stores.position.value}
                            uncleanShutdown={stores.uncleanShutdown.value}
                            {...(lastKnown !== null
                                ? { lastKnownPosition: lastKnown }
                                : {})}
                            onJog={(axis, dir, steps) =>
                                controller.jog(axis, dir, steps)
                            }
                            onCaptureBottomLeft={() =>
                                controller.captureBottomLeft()
                            }
                            onCaptureTopRight={() =>
                                controller.captureTopRight()
                            }
                            onReHome={() => controller.reHome()}
                        />
                    </aside>

                    <aside
                        class="studio-dock studio-dock--right"
                        aria-label="Backlash and diagnostics"
                    >
                        <BacklashWizard
                            backlash={stores.backlash.value}
                            calibrationPerformed={
                                stores.backlashCalibrationPerformed.value
                            }
                            calibrated={calibrated}
                            drawingInProgress={drawingActive}
                            onJog={(axis, dir) => controller.jogAxis(axis, dir)}
                            onRecordBacklash={(axis, steps) =>
                                controller.recordBacklash(axis, steps)
                            }
                            onManualEdit={(axis, steps) =>
                                controller.manualEditBacklash(axis, steps)
                            }
                        />

                        <DiagnosticsPanel
                            connection={connection}
                            rssiDbm={stores.rssiDbm.value}
                            motorTestResult={stores.motorTestResult.value}
                            motorTestRunning={stores.motorTestRunning.value}
                            fault={fault}
                            stall={stall}
                            onMotorTest={() => controller.motorTest()}
                            onFaultReset={() => controller.faultReset()}
                        />
                    </aside>
                </main>
            )}
        </div>
    );
}

export default App;

/** Props for {@link MachinePositionScreen}. */
interface MachinePositionScreenProps {
    connection: string;
    position: { x: number; y: number };
    envelope: { x: number; y: number } | null;
    calibrated: boolean;
    envelopeCalibrated: boolean;
}

/**
 * The live machine-position map shown inside the Etch-a-Sketch screen on the
 * Setup view. Plots the current stylus position as a crosshair + dot within the
 * drawable envelope, so jogging during calibration visibly moves the pen on the
 * on-screen twin. Machine Y is up; SVG Y is down, so the vertical axis is
 * inverted. With no envelope captured (or while disconnected) it falls back to
 * a centred, dimmed state and prompts the user to connect.
 */
function MachinePositionScreen(
    props: MachinePositionScreenProps,
): preact.JSX.Element {
    const { connection, position, envelope, calibrated, envelopeCalibrated } =
        props;

    const hasEnv = !!envelope && envelope.x > 0 && envelope.y > 0;
    const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
    const fx = hasEnv ? clamp01(position.x / envelope!.x) : 0.5;
    const fy = hasEnv ? clamp01(position.y / envelope!.y) : 0.5;

    // Plot box, in the SVG's 100×71 user space (≈ the screen's 1.41 aspect).
    const W = 100;
    const H = 71;
    const PAD = 6;
    const cx = PAD + fx * (W - 2 * PAD);
    const cy = PAD + (1 - fy) * (H - 2 * PAD); // invert: machine Y up

    const live = connection === 'connected';

    return (
        <div
            class={`eas-screen${live ? '' : ' eas-screen--idle'}`}
            data-testid="setup-machine-screen"
        >
            <svg
                class="eas-screen__map"
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label="Machine stylus position within the drawable envelope"
            >
                <rect
                    class="eas-screen__envelope"
                    x={PAD}
                    y={PAD}
                    width={W - 2 * PAD}
                    height={H - 2 * PAD}
                    rx={2.5}
                />
                <line
                    class="eas-screen__crosshair"
                    x1={cx}
                    y1={PAD}
                    x2={cx}
                    y2={H - PAD}
                />
                <line
                    class="eas-screen__crosshair"
                    x1={PAD}
                    y1={cy}
                    x2={W - PAD}
                    y2={cy}
                />
                <circle class="eas-screen__dot" cx={cx} cy={cy} r={2.6} />
            </svg>

            <div class="eas-screen__readout">
                <span class="eas-screen__coords">
                    X {Math.round(position.x)} · Y {Math.round(position.y)}
                </span>
                <span
                    class={`eas-screen__chip eas-screen__chip--${calibrated ? 'ok' : 'warn'
                        }`}
                >
                    {calibrated ? 'Home set' : 'No home'}
                </span>
                <span
                    class={`eas-screen__chip eas-screen__chip--${envelopeCalibrated ? 'ok' : 'warn'
                        }`}
                >
                    {envelopeCalibrated ? 'Envelope set' : 'No envelope'}
                </span>
            </div>

            {!live && (
                <p class="eas-screen__hint">Connect to see live position</p>
            )}
        </div>
    );
}
