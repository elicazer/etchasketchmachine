import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

import { App } from './App';
import { createStores, type AppStores } from '../app/stores';
import { createController, type Controller } from '../app/controller';
import { WireClient, type WireSocket, type TimerApi } from '../net/wire_client';
import { FrameType, encodeFrame } from '../codec/frame';
import { createSceneStore, type SceneStore } from '../composer/scene_store';
import type { ScenePersistence } from '../composer/persistence';
import type { Polyline } from '../types';
import type { Scene } from '../composer/types';

/**
 * Integration tests for the {@link App} shell after the
 * unified-composer-canvas restructure (task 12.1).
 *
 * The shell now mounts:
 *   - the {@link ItemsListPanel} + {@link AddItemMenu} on the left rail
 *     (replacing the legacy `tab-image` / `tab-text` / `tab-freehand` aside);
 *   - the {@link ComposerCanvas} in the centre (replacing the static
 *     {@link Canvas});
 *   - the static {@link Preview} slot, unchanged;
 *   - the bottom-right {@link AnimationPlayback}.
 *
 * The Send-to-machine handler now gates on `store.composed.value.length` and
 * only fires `controller.setPolylines` + `controller.draw` from inside the
 * click handler — never from a reactive effect (Req 11.3, 11.4).
 *
 * jsdom has no 2D canvas context, so getContext is stubbed; the
 * persistence layer is replaced by an in-memory adapter so tests do not
 * touch real `localStorage`.
 */

const WS_OPEN = 1;

class FakeSocket implements WireSocket {
    binaryType: 'blob' | 'arraybuffer' = 'blob';
    readyState = 0;
    sent: Uint8Array[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;

    send(): void {
        /* not asserted here */
    }
    close(): void {
        this.readyState = 3;
    }
    fireOpen(): void {
        this.readyState = WS_OPEN;
        this.onopen?.({});
    }
    fireMessage(bytes: Uint8Array): void {
        this.onmessage?.({ data: bytes });
    }
}

const noopTimers: TimerApi = { setTimeout: () => 0, clearTimeout: () => { } };

interface Harness {
    controller: Controller;
    stores: AppStores;
    sockets: FakeSocket[];
    store: SceneStore;
}

/** In-memory scene persistence so the SceneStore never reads/writes real localStorage. */
function makeMemoryPersistence(): ScenePersistence {
    let snapshot: Scene | null = null;
    return {
        load: () => snapshot,
        save: (s) => {
            snapshot = s;
        },
        clear: () => {
            snapshot = null;
        },
    };
}

function makeHarness(): Harness {
    const sockets: FakeSocket[] = [];
    const client = new WireClient({
        socketFactory: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
        timers: noopTimers,
    });
    const stores = createStores();
    const controller = createController({
        url: 'ws://device.local/ws',
        stores,
        client,
    });
    const store = createSceneStore({
        persistence: makeMemoryPersistence(),
    });
    return { controller, stores, sockets, store };
}

/** Build a §4.8 HELLO payload (40 bytes, envelope fields @32/@36). */
function helloPayload(flags: number, envelopeX = 0, envelopeY = 0): Uint8Array {
    const buf = new Uint8Array(40);
    const v = new DataView(buf.buffer);
    v.setUint32(0, 1, true);
    v.setUint16(4, 1000, true);
    v.setInt32(20, 0, true);
    v.setInt32(24, 0, true);
    v.setUint8(28, flags);
    v.setUint16(30, 32, true);
    v.setUint32(32, envelopeX, true);
    v.setUint32(36, envelopeY, true);
    return buf;
}

const square: Polyline = [
    { x: 10, y: 10 },
    { x: 40, y: 10 },
    { x: 40, y: 40 },
    { x: 10, y: 40 },
    { x: 10, y: 10 },
];

/** Drop a freehand item into the SceneStore so `composed.value.length > 0`. */
function seedSceneWithSquare(store: SceneStore): void {
    act(() => {
        store.addItem({
            kind: 'freehand',
            content: [square],
            source: { capturedAtMs: 0 },
        });
    });
}

let containers: HTMLDivElement[] = [];

beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
    for (const c of containers) {
        act(() => render(null, c));
        c.remove();
    }
    containers = [];
    vi.restoreAllMocks();
});

function mount(controller: Controller, store: SceneStore): HTMLDivElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);
    act(() => {
        render(<App controller={controller} store={store} />, container);
    });
    return container;
}

function $(root: ParentNode, testId: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function must(root: ParentNode, testId: string): HTMLElement {
    const el = $(root, testId);
    if (!el) throw new Error(`missing [data-testid="${testId}"]`);
    return el;
}

describe('App shell — mounts the major panels', () => {
    it('renders the header, canvas area, controls slot, items list, composer canvas, and hides the static preview until a path exists', () => {
        const h = makeHarness();
        const root = mount(h.controller, h.store);

        expect($(root, 'app-header')).not.toBeNull();
        expect($(root, 'app-canvas-area')).not.toBeNull();
        expect($(root, 'app-controls-slot')).not.toBeNull();

        // Composer-side: the items list + add menu replace the old tab nav.
        expect($(root, 'items-list-panel')).not.toBeNull();
        expect($(root, 'add-item-menu')).not.toBeNull();
        expect($(root, 'add-item-image')).not.toBeNull();
        expect($(root, 'add-item-text')).not.toBeNull();
        expect($(root, 'add-item-freehand')).not.toBeNull();

        // ComposerCanvas + AnimationPlayback mount on the default Draw view.
        // The static Preview slot only renders once the user actually has a
        // planned path; on first load (path === null) it is intentionally
        // hidden so the canvas area isn't dominated by an empty placeholder.
        expect($(root, 'composer-canvas')).not.toBeNull();
        expect($(root, 'preview')).toBeNull();
        expect($(root, 'app-preview-slot')).toBeNull();
        expect($(root, 'animation-playback')).not.toBeNull();
        expect($(root, 'connection-status')).not.toBeNull(); // DrawingControls

        // Calibration + diagnostics live under the Setup view.
        act(() => must(root, 'view-setup').click());
        expect($(root, 'calibration-wizard')).not.toBeNull();
        expect($(root, 'motor-test-button')).not.toBeNull(); // DiagnosticsPanel
    });

    it('opens the Add-image modal when its button is clicked', () => {
        const h = makeHarness();
        const root = mount(h.controller, h.store);

        // No modal at boot.
        expect($(root, 'add-item-modal')).toBeNull();

        act(() => must(root, 'add-item-image').click());
        expect($(root, 'add-item-modal')).not.toBeNull();
    });
});

describe('App shell — effective-envelope draw-gate (Req 2.8, 3.5)', () => {
    it('disables "Send to machine" until a HELLO advertises an effective envelope, with composed polylines present', () => {
        const h = makeHarness();
        // The SceneStore is the source of truth for composed polylines now.
        seedSceneWithSquare(h.store);
        const root = mount(h.controller, h.store);

        const sendBtn = must(root, 'send-to-machine') as HTMLButtonElement;
        expect(sendBtn.disabled).toBe(true);
        expect($(root, 'send-blocked-hint')).not.toBeNull();

        // Connect and deliver a HELLO that advertises the firmware-authoritative
        // effective envelope. flags bit0 (home) + bit2 (envelope) = 0x05 with a
        // measured envelope opens the draw-gate.
        act(() => {
            void h.controller.connect();
            h.sockets[0].fireOpen();
            h.sockets[0].fireMessage(
                encodeFrame(FrameType.HELLO, helloPayload(0x05, 20000, 16000)),
            );
        });

        expect(h.stores.calibrated.value).toBe(true);
        expect(h.stores.envelopeCalibrated.value).toBe(true);
        const sendBtnAfter = must(root, 'send-to-machine') as HTMLButtonElement;
        expect(sendBtnAfter.disabled).toBe(false);
        expect($(root, 'send-blocked-hint')).toBeNull();
    });

    it('enables "Send to machine" with the default envelope even when uncalibrated', () => {
        const h = makeHarness();
        seedSceneWithSquare(h.store);
        const root = mount(h.controller, h.store);

        const sendBtn = must(root, 'send-to-machine') as HTMLButtonElement;
        expect(sendBtn.disabled).toBe(true);

        // Uncalibrated machine (flags = 0x00) that still advertises the bounded
        // DEFAULT_ENVELOPE: the draw-gate opens, recalibration stays reachable.
        act(() => {
            void h.controller.connect();
            h.sockets[0].fireOpen();
            h.sockets[0].fireMessage(
                encodeFrame(FrameType.HELLO, helloPayload(0x00, 2158, 1650)),
            );
        });

        expect(h.stores.envelopeCalibrated.value).toBe(false);
        expect(h.stores.envelope.value).toEqual({ x: 2158, y: 1650 });
        const sendBtnAfter = must(root, 'send-to-machine') as HTMLButtonElement;
        expect(sendBtnAfter.disabled).toBe(false);
        expect($(root, 'send-blocked-hint')).toBeNull();
    });

    it('keeps "Send to machine" disabled when the scene is empty even with an envelope captured', () => {
        const h = makeHarness();
        const root = mount(h.controller, h.store);

        // Capture an envelope so the only thing gating Send is the empty scene.
        act(() => {
            void h.controller.connect();
            h.sockets[0].fireOpen();
            h.sockets[0].fireMessage(
                encodeFrame(FrameType.HELLO, helloPayload(0x05, 20000, 16000)),
            );
        });

        const sendBtn = must(root, 'send-to-machine') as HTMLButtonElement;
        expect(sendBtn.disabled).toBe(true);
    });
});

describe('App shell — Send handler (Req 9.4, 9.5, 12.4)', () => {
    it('calls controller.setPolylines once with the composed polylines and then draw()', () => {
        const h = makeHarness();
        seedSceneWithSquare(h.store);

        const setSpy = vi.spyOn(h.controller, 'setPolylines');
        const drawSpy = vi
            .spyOn(h.controller, 'draw')
            .mockResolvedValue(undefined);

        const root = mount(h.controller, h.store);

        // Open the draw-gate.
        act(() => {
            void h.controller.connect();
            h.sockets[0].fireOpen();
            h.sockets[0].fireMessage(
                encodeFrame(FrameType.HELLO, helloPayload(0x05, 20000, 16000)),
            );
        });

        const sendBtn = must(root, 'send-to-machine') as HTMLButtonElement;
        expect(sendBtn.disabled).toBe(false);

        act(() => sendBtn.click());

        expect(setSpy).toHaveBeenCalledTimes(1);
        const [polysArg, optsArg] = setSpy.mock.calls[0]!;
        // Composed polylines = composeScene(scene); for an identity-transform
        // freehand item we expect the same point count as the input.
        expect(Array.isArray(polysArg)).toBe(true);
        expect(polysArg.length).toBe(1);
        expect(polysArg[0]).toHaveLength(square.length);
        expect(optsArg).toEqual({ flipY: true });
        expect(drawSpy).toHaveBeenCalledTimes(1);
    });

    it('clears the planner path and skips draw() when the scene is emptied', () => {
        const h = makeHarness();
        const clearSpy = vi.spyOn(h.controller, 'clearPath');
        const setSpy = vi.spyOn(h.controller, 'setPolylines');
        const drawSpy = vi
            .spyOn(h.controller, 'draw')
            .mockResolvedValue(undefined);

        // Seed and then drain the scene so the items-length transition fires
        // exactly once on its way to zero.
        seedSceneWithSquare(h.store);
        const itemId = h.store.scene.value.items[0]!.id;

        mount(h.controller, h.store);

        // The transition `positive → 0` fires `controller.clearPath` once
        // (Req 12.4) and never routes the empty scene through `setPolylines`
        // or `draw` (Req 9.4, 11.3).
        act(() => h.store.removeItem(itemId));
        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(setSpy).not.toHaveBeenCalled();
        expect(drawSpy).not.toHaveBeenCalled();
    });

    it('does NOT call controller.setPolylines from any reactive effect on add or transform (Req 11.3)', () => {
        const h = makeHarness();
        const setSpy = vi.spyOn(h.controller, 'setPolylines');

        mount(h.controller, h.store);

        // Add an item — composes into the planner-bound signal but must NOT
        // be pushed through `setPolylines` until the user activates Send.
        seedSceneWithSquare(h.store);
        // Mutate the transform — same expectation.
        const id = h.store.scene.value.items[0]!.id;
        act(() => h.store.updateTransform(id, { x: 5 }));

        expect(setSpy).not.toHaveBeenCalled();
    });
});

describe('App shell — header Connect button (manual connect)', () => {
    it('shows "Connect" when disconnected, drives the controller, and reflects connecting/connected', () => {
        const h = makeHarness();
        const root = mount(h.controller, h.store);

        // Disconnected at boot: the button reads "Connect" and is enabled.
        const btn = must(root, 'app-connect') as HTMLButtonElement;
        expect(btn.textContent).toBe('Connect');
        expect(btn.disabled).toBe(false);

        // Clicking the button opens the connection. The controller transitions
        // through connecting → connected as the fake socket comes up.
        act(() => btn.click());
        const btnConnecting = must(root, 'app-connect') as HTMLButtonElement;
        expect(btnConnecting.textContent).toBe('Connecting…');
        expect(btnConnecting.disabled).toBe(true);

        act(() => h.sockets[0].fireOpen());
        const btnConnected = must(root, 'app-connect') as HTMLButtonElement;
        expect(btnConnected.textContent).toBe('Disconnect');
        expect(btnConnected.disabled).toBe(false);
        expect(h.stores.connection.value).toBe('connected');
    });
});

describe('App shell — persistence notice surface (Req 14.6, 14.7)', () => {
    it('renders a non-blocking banner when stores.notice is set', () => {
        const h = makeHarness();
        const root = mount(h.controller, h.store);

        expect($(root, 'app-notice')).toBeNull();

        act(() => {
            h.stores.notice.value = 'Scene too large to auto-save';
        });

        const banner = $(root, 'app-notice');
        expect(banner).not.toBeNull();
        expect(banner?.textContent).toMatch(/auto-save/i);
    });
});
