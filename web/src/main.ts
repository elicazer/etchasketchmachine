/**
 * Entry point for the Etch-a-Sketch SPA (task 29.1).
 *
 * This module is the single composition root that wires the already-built
 * pieces into a running application:
 *
 *   1. resolve the controller WebSocket URL (same-origin by default, with an
 *      `etchasketch.local` mDNS fallback for externally-hosted SPAs — §10.4),
 *   2. build the reactive signal {@link createStores stores},
 *   3. build the {@link createController controller}, which constructs a
 *      {@link WireClient}, subscribes its event surface to the stores, and
 *      exposes the UI callback bundle, and
 *   4. mount the {@link App} shell into `#app`.
 *
 * The shell renders in the disconnected state and stays there until the user
 * clicks the Connect button in the header — the BLE/WS connection is no
 * longer opened automatically on page load.
 *
 * Crucially, this file imports **no** image-processing code. The opencv.js WASM
 * module is large and is lazy-loaded by `image_processor.ts` only on the first
 * raster import (Design §2.4.1); `ImagePanel` already pulls `image_processor`
 * through the bundler's static graph, but the opencv.js module itself is loaded
 * at runtime via a `<script>` injection (`loadOpenCv`) and is deliberately NOT
 * a package dependency, so it never lands in the always-resident SPA bundle.
 *
 * The file is `.ts` (not `.tsx`) — the HTML references `/src/main.ts` — so the
 * shell is mounted with Preact's `h()` rather than JSX.
 *
 * @see Design §2.4.1 (lazy opencv.js), §10.2 (single-file build)
 */

import { h, render } from 'preact';

import './ui/styles.css';
import { App } from './ui/App';
import { createStores } from './app/stores';
import { createController, type Controller } from './app/controller';
import {
    makeSocketFactory,
    resolveControllerUrl,
    TransportUnavailableError,
} from './app/config';
import { WireClient } from './net/wire_client';
import type { SocketFactory } from './net/wire_client';
import { createSceneStore, type SceneStore } from './composer/scene_store';
import { createLocalStoragePersistence } from './composer/persistence';
import { DRAWABLE_MM } from './constants';

/** Options for {@link bootstrap}; every field has a production-safe default. */
export interface BootstrapOptions {
    /** Override the resolved controller URL (tests / external hosting). */
    url?: string;
    /** Inject a pre-built WireClient (tests pass a fake-socket client). */
    client?: WireClient;
    /**
     * Inject a pre-built {@link SceneStore} (tests). The default builds one
     * around `createLocalStoragePersistence` whose `onTooLarge` callback
     * routes through `stores.notice` so the SPA can surface a non-blocking
     * banner when a snapshot would exceed the size cap or localStorage
     * throws (Req 14.6, 14.7).
     */
    sceneStore?: SceneStore;
    /**
     * Retained for backward compatibility. Auto-connect was removed: the app
     * now boots in the disconnected state and only connects when the user
     * clicks the Connect button. This option is ignored.
     */
    autoConnect?: boolean;
}

/**
 * Boot the SPA into the given root element. Returns the wired controller so a
 * host (or a test) can inspect / tear it down. Extracted from the module
 * side-effect so it is unit-testable without touching the real DOM bootstrap.
 */
export function bootstrap(root: Element, opts: BootstrapOptions = {}): Controller {
    const url = opts.url ?? resolveControllerUrl(window.location, document);
    const stores = createStores();

    // Select the transport at the single config point (Design §3.5, Req 4.4).
    // `makeSocketFactory` throws a `TransportUnavailableError` when the
    // configured transport is unavailable in this browser (e.g. Web Bluetooth
    // missing on Safari/Firefox). Surface that to the user through the
    // connection-error signal rather than crashing silently (Req 4.5, 4.6);
    // the Connect button in the header will simply have nothing to talk to.
    let socketFactory: SocketFactory | undefined;
    let transportError: TransportUnavailableError | null = null;
    if (!opts.client) {
        try {
            socketFactory = makeSocketFactory();
        } catch (err) {
            if (err instanceof TransportUnavailableError) {
                transportError = err;
            } else {
                throw err;
            }
        }
    }
    if (transportError) {
        stores.connectionError.value = transportError.message;
    }

    const controller = createController({
        url,
        stores,
        ...(opts.client ? { client: opts.client } : {}),
        ...(socketFactory ? { socketFactory } : {}),
    });

    // Build the Composer SceneStore once and route persistence notices
    // through `stores.notice`. The persistence adapter never throws — every
    // failure (size cap exceeded, quota error, disabled storage) folds back
    // into the notice channel so the SPA can render a transient banner
    // without crashing or blocking edits (Req 14.6, 14.7).
    const sceneStore =
        opts.sceneStore ??
        createSceneStore({
            persistence: createLocalStoragePersistence({
                onTooLarge: (_reason, message) => {
                    stores.notice.value = message;
                },
            }),
            // Pass the drawable envelope so newly-added items (especially
            // imported images at raw pixel scale) land centred and scaled
            // to fit the dashed envelope rectangle on first add.
            envelopeMm: { w: DRAWABLE_MM.w, h: DRAWABLE_MM.h },
        });

    render(h(App, { controller, store: sceneStore }), root);

    return controller;
}

// Side-effecting bootstrap: only runs in a browser with the mount point present
// (guarded so importing this module under a test collector is inert).
if (typeof document !== 'undefined') {
    const root = document.getElementById('app');
    if (root) {
        bootstrap(root);
    }
}
