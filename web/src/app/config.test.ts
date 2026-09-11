import { afterEach, describe, it, expect, vi } from 'vitest';
import {
    DEFAULT_CONTROLLER_HOST,
    WS_PATH,
    resolveControllerUrl,
    resolveCvServiceUrl,
    type DocumentLike,
    type LocationLike,
} from './config';
import { DEFAULT_CV_SERVICE_URL } from '../image/cv_service_client';

/**
 * Unit tests for {@link resolveControllerUrl} (task 29.1).
 *
 * Pure function over injected `location` / `document`, so every resolution
 * branch — query param, meta tag, same-origin, and the mDNS fallback — is
 * exercised without a real DOM.
 */

function loc(over: Partial<LocationLike> = {}): LocationLike {
    return {
        protocol: 'http:',
        host: 'etchasketch.local',
        search: '',
        ...over,
    };
}

function docWithMeta(content: string | null): DocumentLike {
    return {
        querySelector: () => ({ getAttribute: () => content }),
    };
}

describe('resolveControllerUrl — same-origin default (Design §2.4.4)', () => {
    it('defaults to ws://<host>:81/ws when served from a real controller host', () => {
        expect(resolveControllerUrl(loc({ host: 'etchasketch.local' }))).toBe(
            'ws://etchasketch.local:81/ws',
        );
    });

    it('swaps the served host port for the dedicated WS port', () => {
        expect(
            resolveControllerUrl(loc({ host: '192.168.4.1:8080' })),
        ).toBe('ws://192.168.4.1:81/ws');
    });

    it('uses wss when the page itself is served over https', () => {
        expect(
            resolveControllerUrl(
                loc({ protocol: 'https:', host: 'etchasketch.local' }),
            ),
        ).toBe('wss://etchasketch.local:81/ws');
    });
});

describe('resolveControllerUrl — mDNS fallback (Design §10.4)', () => {
    it('falls back to ws://etchasketch.local:81/ws for a localhost dev origin', () => {
        expect(resolveControllerUrl(loc({ host: 'localhost:5173' }))).toBe(
            `ws://${DEFAULT_CONTROLLER_HOST}:81${WS_PATH}`,
        );
    });

    it('falls back when there is no serving host at all (file://-style)', () => {
        expect(resolveControllerUrl(loc({ host: '' }))).toBe(
            'ws://etchasketch.local:81/ws',
        );
    });
});

describe('resolveControllerUrl — query-parameter override', () => {
    it('accepts a bare host and appends the ws scheme + path', () => {
        expect(
            resolveControllerUrl(
                loc({ host: 'localhost:5173', search: '?controller=10.0.0.5' }),
            ),
        ).toBe('ws://10.0.0.5/ws');
    });

    it('accepts a full ws:// URL verbatim', () => {
        expect(
            resolveControllerUrl(
                loc({ search: '?ws=ws://device.local:9000/ws' }),
            ),
        ).toBe('ws://device.local:9000/ws');
    });

    it('rewrites an http:// override to ws:// with the /ws path', () => {
        expect(
            resolveControllerUrl(loc({ search: '?controller=http://10.0.0.9' })),
        ).toBe('ws://10.0.0.9/ws');
    });

    it('prefers ?ws over ?controller', () => {
        expect(
            resolveControllerUrl(
                loc({ search: '?controller=10.0.0.5&ws=ws://override/ws' }),
            ),
        ).toBe('ws://override/ws');
    });
});

describe('resolveControllerUrl — meta-tag override', () => {
    it('uses the meta tag when no query parameter is present', () => {
        expect(
            resolveControllerUrl(
                loc({ host: 'localhost:5173' }),
                docWithMeta('192.168.1.50'),
            ),
        ).toBe('ws://192.168.1.50/ws');
    });

    it('ignores an empty meta tag and falls through to same-origin', () => {
        expect(
            resolveControllerUrl(
                loc({ host: 'etchasketch.local' }),
                docWithMeta(''),
            ),
        ).toBe('ws://etchasketch.local:81/ws');
    });
});

// -----------------------------------------------------------------------------
// resolveCvServiceUrl branches (image-tonal-hatching design)
// -----------------------------------------------------------------------------

describe('resolveCvServiceUrl — default + ?cv= override', () => {
    it('defaults to DEFAULT_CV_SERVICE_URL when no ?cv= param is present', () => {
        expect(resolveCvServiceUrl(loc())).toBe(DEFAULT_CV_SERVICE_URL);
        expect(resolveCvServiceUrl(loc({ host: 'localhost:5173' }))).toBe(
            DEFAULT_CV_SERVICE_URL,
        );
    });

    it('uses a ?cv= override verbatim', () => {
        expect(
            resolveCvServiceUrl(loc({ search: '?cv=http://localhost:9000' })),
        ).toBe('http://localhost:9000');
    });

    it('strips a trailing slash from the override', () => {
        expect(
            resolveCvServiceUrl(loc({ search: '?cv=http://192.168.1.7:8765/' })),
        ).toBe('http://192.168.1.7:8765');
    });

    it('ignores a blank ?cv= override and falls back to the default', () => {
        expect(resolveCvServiceUrl(loc({ search: '?cv=' }))).toBe(
            DEFAULT_CV_SERVICE_URL,
        );
        expect(resolveCvServiceUrl(loc({ search: '?cv=%20%20' }))).toBe(
            DEFAULT_CV_SERVICE_URL,
        );
    });
});

// -----------------------------------------------------------------------------
// makeSocketFactory branches (Design §7.2; Req 4.4, 4.5, 4.6)
// -----------------------------------------------------------------------------

/**
 * `TRANSPORT` is resolved once at module-load time from
 * `import.meta.env.VITE_ESK_TRANSPORT`, so each branch is exercised by stubbing
 * the env var, re-evaluating the module via `vi.resetModules()` + a dynamic
 * import, and stubbing the browser-capability globals (`navigator.bluetooth`,
 * `WebSocket`) the factory probes. Importing `./config` and `../net/ble_socket`
 * after the same `resetModules()` keeps them in one fresh module graph, so the
 * `BleSocket` the factory constructs is `instanceof` the one we import here.
 */

/** A no-op `navigator.bluetooth` whose `requestDevice` never settles, so the
 * `BleSocket` connect flow kicked off in its constructor stays harmlessly
 * pending (no async rejection noise) — the factory only needs to construct it. */
function installBluetooth(): void {
    Object.defineProperty(navigator, 'bluetooth', {
        value: { requestDevice: () => new Promise<never>(() => { }) },
        configurable: true,
        writable: true,
    });
}

function removeBluetooth(): void {
    if ('bluetooth' in navigator) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (navigator as any).bluetooth;
    }
}

/** Re-evaluate `./config` (and a matching `../net/ble_socket`) with the given
 * `VITE_ESK_TRANSPORT` value; `undefined` simulates the common unset build. */
async function loadConfig(transport: 'ble' | 'websocket' | undefined): Promise<{
    config: typeof import('./config');
    ble: typeof import('../net/ble_socket');
}> {
    vi.resetModules();
    vi.stubEnv('VITE_ESK_TRANSPORT', transport as string);
    const config = await import('./config');
    const ble = await import('../net/ble_socket');
    return { config, ble };
}

describe('makeSocketFactory — transport selection (Design §3.5, §7.2)', () => {
    afterEach(() => {
        removeBluetooth();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('BLE selected with navigator.bluetooth present returns a BleSocket factory (Req 4.4)', async () => {
        installBluetooth();
        const { config, ble } = await loadConfig('ble');

        const factory = config.makeSocketFactory();
        const socket = factory('ws://ignored/ws');

        expect(socket).toBeInstanceOf(ble.BleSocket);
        // The chosen socket honours the WireSocket surface WireClient drives.
        expect(typeof (socket as { close: unknown }).close).toBe('function');
    });

    it('defaults to BLE when VITE_ESK_TRANSPORT is unset (Req 4.4)', async () => {
        installBluetooth();
        const { config, ble } = await loadConfig(undefined);

        expect(config.TRANSPORT).toBe('ble');
        const socket = config.makeSocketFactory()('ws://ignored/ws');
        expect(socket).toBeInstanceOf(ble.BleSocket);
    });

    it('BLE selected without navigator.bluetooth throws TransportUnavailableError with no fallback (Req 4.5, 4.6)', async () => {
        removeBluetooth();
        const { config } = await loadConfig('ble');

        let thrown: unknown;
        try {
            config.makeSocketFactory();
        } catch (err) {
            thrown = err;
        }

        // It throws rather than silently falling back to a WebSocket factory.
        expect(thrown).toBeInstanceOf(config.TransportUnavailableError);
        const error = thrown as InstanceType<typeof config.TransportUnavailableError>;
        expect(error.transport).toBe('ble');
        // Guidance names the supported browsers and points at the WiFi build.
        expect(error.message).toMatch(/Chrome or Edge/);
        expect(error.message).toMatch(/WiFi build/);
    });

    it('WebSocket selected returns a WebSocket factory (Req 4.4)', async () => {
        class FakeWebSocket {
            constructor(public readonly url: string) { }
        }
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const { config } = await loadConfig('websocket');

        expect(config.TRANSPORT).toBe('websocket');
        const factory = config.makeSocketFactory();
        const socket = factory('ws://device.local:81/ws');

        expect(socket).toBeInstanceOf(FakeWebSocket);
        expect((socket as unknown as FakeWebSocket).url).toBe('ws://device.local:81/ws');
    });
});
