/**
 * `config` — runtime configuration for the SPA shell (task 29.1).
 *
 * The only configurable knob today is the controller's WebSocket URL. The SPA
 * is normally served *by* the controller (embedded in firmware PROGMEM,
 * Design §2.4.4), so the same-origin `ws://<host>/ws` is the right default.
 * When the SPA is instead hosted externally (Design §10.4, Fallback B) the
 * page has no controller host of its own, so it falls back to the mDNS name
 * `etchasketch.local`.
 *
 * Resolution order (first match wins):
 *   1. an explicit `?controller=<host>` / `?ws=<url>` query parameter,
 *   2. a `<meta name="esk-controller-url" content="…">` tag (lets the firmware
 *      stamp the address into the served HTML),
 *   3. same-origin `ws(s)://<location.host>/ws` when served over http(s) from
 *      a real host,
 *   4. the `ws://etchasketch.local/ws` mDNS fallback.
 *
 * @see Design §2.4.1, §10.2, §10.4
 * @see Requirements 1.2 (SPA hosting), 7.1 (WebSocket transport)
 */

import { BleSocket, defaultBleDeps } from '../net/ble_socket';
import type { SocketFactory, WireSocket } from '../net/wire_client';
import { DEFAULT_CV_SERVICE_URL } from '../image/cv_service_client';

/** mDNS fallback used when the page is not served from a controller host. */
export const DEFAULT_CONTROLLER_HOST = 'etchasketch.local';

/** WebSocket path the controller serves the binary protocol on (Design §4.5). */
export const WS_PATH = '/ws';

/**
 * Dedicated TCP port the firmware's WebSocket server listens on. HTTP (the SPA
 * + REST) owns port 80; the realtime binary channel runs on 81 so the two do
 * not have to be multiplexed on one socket. Must match `ws_net::WS_PORT` in
 * firmware/src/protocol/ws_server.cpp.
 */
export const WS_PORT = 81;

/** A minimal view of the bits of `location` this resolver reads. */
export interface LocationLike {
    protocol: string;
    host: string;
    search: string;
}

/** A minimal view of the bits of `document` this resolver reads. */
export interface DocumentLike {
    querySelector(selectors: string): { getAttribute(name: string): string | null } | null;
}

/** True for hosts that mean "no real controller origin" (dev/test/file). */
function isPlaceholderHost(host: string): boolean {
    if (host === '') return true;
    const name = host.split(':')[0]!.toLowerCase();
    return (
        name === 'localhost' ||
        name === '127.0.0.1' ||
        name === '0.0.0.0' ||
        name === '::1'
    );
}

/** Normalise a user-supplied controller value into a full `ws(s)://…/ws` URL. */
function normaliseControllerValue(value: string, secure: boolean): string {
    const trimmed = value.trim();
    if (trimmed === '') return '';
    // Already a ws(s):// URL — take it verbatim.
    if (/^wss?:\/\//i.test(trimmed)) return trimmed;
    // An http(s):// URL — swap the scheme for ws(s) and append the path.
    if (/^https?:\/\//i.test(trimmed)) {
        const u = trimmed.replace(/^http/i, 'ws');
        return u.endsWith(WS_PATH) ? u : `${u.replace(/\/$/, '')}${WS_PATH}`;
    }
    // A bare host[:port] — pick the scheme from the page's security context.
    const scheme = secure ? 'wss' : 'ws';
    return `${scheme}://${trimmed}${WS_PATH}`;
}

/**
 * Resolve the controller WebSocket URL from (in priority order) a query
 * parameter, a meta tag, the serving origin, or the mDNS fallback.
 *
 * Pure with respect to its injected `location` / `document`, so tests can
 * drive every branch without a real DOM.
 */
export function resolveControllerUrl(
    location: LocationLike,
    doc?: DocumentLike,
): string {
    const secure = location.protocol === 'https:';

    // 1. Query parameter override (?ws=… wins over ?controller=…).
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('ws') ?? params.get('controller');
    if (fromQuery) {
        const url = normaliseControllerValue(fromQuery, secure);
        if (url) return url;
    }

    // 2. Meta-tag override stamped into the served HTML.
    const meta = doc?.querySelector('meta[name="esk-controller-url"]');
    const fromMeta = meta?.getAttribute('content') ?? null;
    if (fromMeta) {
        const url = normaliseControllerValue(fromMeta, secure);
        if (url) return url;
    }

    // 3. Same-origin: the controller is serving us (Design §2.4.4). HTTP is on
    //    port 80 but the WebSocket server listens on WS_PORT (81), so swap the
    //    host's port for WS_PORT rather than reusing location.host verbatim.
    if (!isPlaceholderHost(location.host)) {
        const scheme = secure ? 'wss' : 'ws';
        const hostname = location.host.split(':')[0]!;
        return `${scheme}://${hostname}:${WS_PORT}${WS_PATH}`;
    }

    // 4. mDNS fallback for externally-hosted SPAs (Design §10.4).
    return `ws://${DEFAULT_CONTROLLER_HOST}:${WS_PORT}${WS_PATH}`;
}

/**
 * Resolve the local CV sidecar service base URL.
 *
 * The image→path CV service is a developer/desktop tool that runs on the user's
 * own machine (see the image-tonal-hatching design). It defaults to
 * {@link DEFAULT_CV_SERVICE_URL} (`http://localhost:8765`) but can be pointed at
 * a different host/port with a `?cv=<url>` query parameter — mirroring how
 * {@link resolveControllerUrl} accepts a `?controller=` / `?ws=` override.
 *
 * Pure with respect to its injected `location`, so tests can drive every branch
 * without a real DOM. A blank/whitespace-only override is ignored and the
 * default is used.
 */
export function resolveCvServiceUrl(location: LocationLike): string {
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('cv');
    if (fromQuery) {
        const trimmed = fromQuery.trim().replace(/\/$/, '');
        if (trimmed !== '') return trimmed;
    }
    return DEFAULT_CV_SERVICE_URL;
}

// -----------------------------------------------------------------------------
// Transport selection (single config point) — Design §3.5
// -----------------------------------------------------------------------------

/**
 * The build-time transport selection. Resolved once from the
 * `VITE_ESK_TRANSPORT` Vite env constant and defaulting to BLE — the new
 * primary transport (Design §3.5, Req 4.4). A WiFi (WebSocket) image is
 * produced by building with `VITE_ESK_TRANSPORT=websocket`.
 *
 * `VITE_ESK_TRANSPORT` is typed as `'ble' | 'websocket' | undefined` via
 * `src/vite-env.d.ts`; an unset value (the common case) resolves to `'ble'`
 * here, so the default build is deterministically a BLE image.
 */
export const TRANSPORT: 'ble' | 'websocket' =
    import.meta.env.VITE_ESK_TRANSPORT ?? 'ble';

/**
 * Raised when the transport chosen at the single config point is not available
 * in the current browser at runtime. The {@link transport} field names the
 * unavailable transport so the connection layer can report it without silently
 * falling back to the other transport (Req 4.5, 4.6).
 *
 * @see Design §3.5
 * @see Requirements 4.5, 4.6
 */
export class TransportUnavailableError extends Error {
    /** The configured-but-unavailable transport, e.g. `'ble'`. */
    public readonly transport: 'ble' | 'websocket';

    constructor(transport: 'ble' | 'websocket', message: string) {
        super(message);
        this.name = 'TransportUnavailableError';
        this.transport = transport;
    }
}

/**
 * Build the {@link SocketFactory} for the configured transport (Design §3.5,
 * Req 4.4). This is the single point where the BLE vs WebSocket implementation
 * is chosen; `WireClient` and the entire UI are otherwise transport-agnostic.
 *
 * There is **no silent fallback**: when the configured transport is
 * unavailable at runtime, this throws a {@link TransportUnavailableError}
 * naming the unavailable transport rather than quietly switching to the other
 * transport (Req 4.6). For BLE specifically, a browser without Web Bluetooth
 * (Safari/Firefox) is told that BLE requires Chrome or Edge and that the WiFi
 * build is the alternative (Req 4.5).
 *
 * @throws {TransportUnavailableError} when the configured transport is
 *   unavailable in the current browser.
 */
export function makeSocketFactory(): SocketFactory {
    if (TRANSPORT === 'ble') {
        if (!('bluetooth' in navigator)) {
            throw new TransportUnavailableError(
                'ble',
                'Bluetooth requires Chrome or Edge. Use the WiFi build for Safari/Firefox.',
            );
        }
        return (_url) => new BleSocket(defaultBleDeps());
    }
    return (url) => new WebSocket(url) as unknown as WireSocket;
}
