import { describe, it, expect, vi } from 'vitest';
import {
    submitWifiCredentials,
    WIFI_SETUP_ENDPOINT,
} from './wifi_setup';

/**
 * Unit tests for {@link submitWifiCredentials} (Req 1.5, 1.7).
 *
 * A fake `fetch` is injected so the helper's request shaping and response
 * normalisation are exercised with no real network. We assert:
 *   - a 2xx `{ ip, hostname }` body resolves to a success result and the
 *     request POSTs JSON to `/api/wifi` (Req 1.5, 1.7);
 *   - a non-2xx body surfaces the firmware's `{ error }` message;
 *   - a network rejection and a malformed/empty success body both resolve to
 *     a failure result instead of throwing.
 */

/** Build a `Response`-like stub with a JSON body and status. */
function jsonResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

describe('submitWifiCredentials — request shaping (Req 1.5)', () => {
    it('POSTs JSON credentials to /api/wifi', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () =>
            jsonResponse(200, { ip: '192.168.1.50', hostname: 'etchasketch.local' }),
        );

        await submitWifiCredentials(
            { ssid: 'home-net', password: 'hunter22!' },
            fetchFn,
        );

        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0]!;
        expect(url).toBe(WIFI_SETUP_ENDPOINT);
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['Content-Type']).toBe(
            'application/json',
        );
        expect(JSON.parse(init?.body as string)).toEqual({
            ssid: 'home-net',
            password: 'hunter22!',
        });
    });
});

describe('submitWifiCredentials — success (Req 1.7)', () => {
    it('returns the assigned IP and hostname from the response body', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () =>
            jsonResponse(200, {
                version: '0.1.0',
                ip: '192.168.1.50',
                rssi: -47,
                hostname: 'etchasketch.local',
                calibrated: false,
            }),
        );

        const res = await submitWifiCredentials(
            { ssid: 'home-net', password: 'hunter22!' },
            fetchFn,
        );

        expect(res).toEqual({
            ok: true,
            ip: '192.168.1.50',
            hostname: 'etchasketch.local',
        });
    });

    it('fails when a 2xx body is missing ip/hostname', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () =>
            jsonResponse(200, { version: '0.1.0' }),
        );

        const res = await submitWifiCredentials(
            { ssid: 'home-net', password: 'hunter22!' },
            fetchFn,
        );

        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/did not report its address/i);
    });
});

describe('submitWifiCredentials — failure paths (Req 1.4, 1.5)', () => {
    it('surfaces the firmware error message on a 400', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () =>
            jsonResponse(400, {
                error: 'credentials failed validation (ssid 1-32, password 8-63 chars)',
            }),
        );

        const res = await submitWifiCredentials(
            { ssid: 'home-net', password: 'short' },
            fetchFn,
        );

        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/credentials failed validation/i);
    });

    it('falls back to the status code when the error body has no message', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(409, {}));

        const res = await submitWifiCredentials(
            { ssid: 'home-net', password: 'hunter22!' },
            fetchFn,
        );

        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/409/);
    });

    it('returns a failure (does not throw) when fetch rejects', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => {
            throw new Error('network down');
        });

        const res = await submitWifiCredentials(
            { ssid: 'home-net', password: 'hunter22!' },
            fetchFn,
        );

        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/could not reach the controller/i);
    });

    it('returns a failure when a success body is not valid JSON', async () => {
        const fetchFn = vi.fn<typeof fetch>(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    json: () => Promise.reject(new Error('not json')),
                }) as unknown as Response,
        );

        const res = await submitWifiCredentials(
            { ssid: 'home-net', password: 'hunter22!' },
            fetchFn,
        );

        expect(res.ok).toBe(false);
    });
});
