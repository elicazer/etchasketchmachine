/**
 * `wifi_setup` — the one-shot REST helper used by the AP-mode configuration
 * page to submit WiFi credentials to the controller (Req 1.4, 1.5, 1.7).
 *
 * Unlike the binary WebSocket transport in `wire_client.ts`, credential
 * submission is a plain `POST /api/wifi` against the controller's HTTP server
 * while it is in Access Point fallback (Design §3.2.2). On success the firmware
 * persists the credentials, restarts the STA association, and answers with the
 * same `/api/info` snapshot it serves elsewhere — so the response body carries
 * the assigned IP address and the mDNS hostname (`etchasketch.local`) the user
 * needs in order to find the controller again once it joins their network
 * (Req 1.7). On failure it answers with a non-2xx status and a small
 * `{ "error": "..." }` body that we surface verbatim.
 *
 * The helper is deliberately tiny and dependency-free: it uses the global
 * `fetch`, posts JSON, and normalises every outcome (HTTP error, malformed
 * body, network/abort failure) into a single discriminated `WifiSetupResult`
 * so callers never have to `try/catch` or branch on `Response.ok` themselves.
 *
 * @see Design §3.2.2 (HTTP surface), §6.2 (WiFi recovery)
 * @see Requirements 1.4, 1.5, 1.7
 */

/** Request body posted to `POST /api/wifi`. */
export interface WifiCredentials {
    /** Target network SSID (1–32 chars; validated by the caller). */
    ssid: string;
    /** WPA-PSK passphrase (8–63 chars; validated by the caller). */
    password: string;
}

/**
 * Successful submission. `ip` and `hostname` come straight from the
 * controller's `/api/info` snapshot returned by `POST /api/wifi` and are
 * shown to the user so they can reconnect once STA association completes
 * (Req 1.7).
 */
export interface WifiSetupSuccess {
    ok: true;
    /** Assigned IPv4 address reported by the controller (Req 1.7). */
    ip: string;
    /** mDNS hostname reported by the controller, e.g. `etchasketch.local`. */
    hostname: string;
}

/** Failed submission, carrying a human-readable reason for the UI. */
export interface WifiSetupFailure {
    ok: false;
    /** Short, user-facing description of why the submission failed. */
    error: string;
}

/** Discriminated outcome of {@link submitWifiCredentials}. */
export type WifiSetupResult = WifiSetupSuccess | WifiSetupFailure;

/** Path of the credential-submission endpoint (Design §3.2.2). */
export const WIFI_SETUP_ENDPOINT = '/api/wifi';

/**
 * Shape of the `/api/info`-style body the firmware returns on success
 * (Design §3.2.2). Only `ip` and `hostname` are consumed here; the other
 * fields are accepted and ignored so the contract can grow without breaking
 * this helper.
 */
interface WifiInfoBody {
    ip?: unknown;
    hostname?: unknown;
}

/** Shape of the error body the firmware returns on a 4xx/5xx (Design §3.2.2). */
interface WifiErrorBody {
    error?: unknown;
}

/** Narrow an unknown JSON value to a non-empty string, else `undefined`. */
function asNonEmptyString(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Submit WiFi credentials to the controller's AP-mode config endpoint.
 *
 * Posts `{ ssid, password }` as JSON to {@link WIFI_SETUP_ENDPOINT} and
 * normalises the result:
 *   - `2xx` with an `{ ip, hostname }` body  → `{ ok: true, ip, hostname }`
 *   - `2xx` with a body missing those fields → `{ ok: false, error }`
 *   - non-`2xx`                              → `{ ok: false, error }` using the
 *     response's `{ error }` field when present, else the status line
 *   - network failure / abort / non-JSON     → `{ ok: false, error }`
 *
 * The helper never throws; every failure path resolves to a
 * {@link WifiSetupFailure}.
 *
 * @param creds   The credentials to submit (caller validates lengths first).
 * @param fetchFn Injectable `fetch` implementation (defaults to the global),
 *                so tests can supply a stub without monkey-patching globals.
 */
export async function submitWifiCredentials(
    creds: WifiCredentials,
    fetchFn: typeof fetch = globalThis.fetch,
): Promise<WifiSetupResult> {
    let response: Response;
    try {
        response = await fetchFn(WIFI_SETUP_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ssid: creds.ssid,
                password: creds.password,
            }),
        });
    } catch {
        // DNS failure, connection reset, abort, etc. The AP link is local and
        // short, so the most likely cause is the controller already flipping
        // to STA mode after accepting the credentials.
        return {
            ok: false,
            error: 'Could not reach the controller. Check the connection and try again.',
        };
    }

    // Parse the JSON body defensively: a malformed or empty body must not throw.
    let body: unknown = undefined;
    try {
        body = await response.json();
    } catch {
        body = undefined;
    }

    if (!response.ok) {
        const errBody = (body ?? {}) as WifiErrorBody;
        const message =
            asNonEmptyString(errBody.error) ??
            `Request failed (${response.status})`;
        return { ok: false, error: message };
    }

    const info = (body ?? {}) as WifiInfoBody;
    const ip = asNonEmptyString(info.ip);
    const hostname = asNonEmptyString(info.hostname);
    if (ip === undefined || hostname === undefined) {
        return {
            ok: false,
            error: 'Credentials accepted but the controller did not report its address.',
        };
    }

    return { ok: true, ip, hostname };
}
