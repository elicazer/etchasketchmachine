/**
 * `WifiSetup` — the Access-Point-mode WiFi configuration page (Req 1.3–1.5, 1.7).
 *
 * When the controller cannot reach the stored network it falls back to AP mode
 * and broadcasts `EtchSketch_<MAC4>` (Req 1.3). A user joins that network and
 * loads this page to hand the controller its real WiFi credentials. The page:
 *
 *   - captures an SSID (1–32 chars) and a WPA-PSK passphrase (8–63 chars),
 *     validated client-side with `validateWifiSsid` / `validateWifiPassword`
 *     so an obviously-bad value never hits the wire (Req 1.4);
 *   - on submit, POSTs the credentials to `/api/wifi` via
 *     `submitWifiCredentials`, which the firmware persists before restarting
 *     the STA association (Req 1.5);
 *   - on success, shows the assigned IP address and the mDNS hostname
 *     (`etchasketch.local`) returned by the controller so the user knows where
 *     to reconnect once it joins their network (Req 1.7);
 *   - on failure, surfaces the validation or server error message inline.
 *
 * This is a standalone AP-mode page: it is not wired into the connected-mode
 * `App` shell. The network call is injectable (`submit` prop) so tests can
 * supply a stub without touching the global `fetch`.
 *
 * @see Design §3.2.2 (HTTP surface), §6.2 (WiFi recovery)
 * @see Requirements 1.3, 1.4, 1.5, 1.7
 */

import { useState } from 'preact/hooks';
import {
    WIFI_PASSWORD_MAX_LEN,
    WIFI_SSID_MAX_LEN,
    validateWifiPassword,
    validateWifiSsid,
} from '../validators';
import {
    submitWifiCredentials,
    type WifiSetupResult,
} from '../net/wifi_setup';

/** Injectable credential-submission function (defaults to the real helper). */
export type WifiSubmitFn = (creds: {
    ssid: string;
    password: string;
}) => Promise<WifiSetupResult>;

/** Props accepted by {@link WifiSetup}. */
export interface WifiSetupProps {
    /**
     * Credential-submission function. Defaults to {@link submitWifiCredentials}
     * (which POSTs to `/api/wifi`); injectable so tests and hosts can stub the
     * transport.
     */
    submit?: WifiSubmitFn;
    /** Optional AP SSID to display in the header (e.g. `EtchSketch_ABCD`). */
    apSsid?: string;
    /** Optional initial SSID value (defaults to empty). */
    initialSsid?: string;
}

/** Submission lifecycle state for the form. */
type Phase = 'idle' | 'submitting' | 'success' | 'error';

/**
 * Render the AP-mode WiFi configuration page. All state is local; the only
 * side effect is the injected `submit` call on a valid submission.
 */
export function WifiSetup(props: WifiSetupProps) {
    const submit = props.submit ?? submitWifiCredentials;

    const [ssid, setSsid] = useState(props.initialSsid ?? '');
    const [password, setPassword] = useState('');
    const [phase, setPhase] = useState<Phase>('idle');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [result, setResult] = useState<{ ip: string; hostname: string } | null>(
        null,
    );

    const ssidValidation = validateWifiSsid(ssid);
    const passwordValidation = validateWifiPassword(password);
    const formValid = ssidValidation.ok && passwordValidation.ok;
    const submitting = phase === 'submitting';

    function handleSsid(e: Event): void {
        setSsid((e.currentTarget as HTMLInputElement).value);
        if (phase !== 'idle') {
            setPhase('idle');
            setErrorMsg(null);
        }
    }

    function handlePassword(e: Event): void {
        setPassword((e.currentTarget as HTMLInputElement).value);
        if (phase !== 'idle') {
            setPhase('idle');
            setErrorMsg(null);
        }
    }

    async function handleSubmit(e: Event): Promise<void> {
        e.preventDefault();
        if (submitting) return;

        // Re-validate client-side so an invalid value never POSTs (Req 1.4).
        const s = validateWifiSsid(ssid);
        if (!s.ok) {
            setPhase('error');
            setErrorMsg(s.reason);
            return;
        }
        const p = validateWifiPassword(password);
        if (!p.ok) {
            setPhase('error');
            setErrorMsg(p.reason);
            return;
        }

        setPhase('submitting');
        setErrorMsg(null);

        const res = await submit({ ssid: s.value, password: p.value });
        if (res.ok) {
            setResult({ ip: res.ip, hostname: res.hostname });
            setPhase('success');
        } else {
            setErrorMsg(res.error);
            setPhase('error');
        }
    }

    // Success view: show the assigned address so the user can reconnect (Req 1.7).
    if (phase === 'success' && result !== null) {
        return (
            <section class="wifi-setup" aria-label="WiFi setup complete">
                <h1 class="wifi-setup__title">Connected</h1>
                <p class="wifi-setup__success" data-testid="wifi-success">
                    Credentials saved. The controller is joining your network.
                </p>
                <dl class="wifi-setup__details">
                    <dt>IP address</dt>
                    <dd data-testid="wifi-ip">{result.ip}</dd>
                    <dt>Hostname</dt>
                    <dd data-testid="wifi-hostname">{result.hostname}</dd>
                </dl>
                <p class="wifi-setup__reconnect">
                    Reconnect to your network, then browse to{' '}
                    <a href={`http://${result.hostname}/`}>
                        http://{result.hostname}/
                    </a>{' '}
                    or <span data-testid="wifi-ip-url">http://{result.ip}/</span>.
                </p>
            </section>
        );
    }

    return (
        <section class="wifi-setup" aria-label="WiFi setup">
            <h1 class="wifi-setup__title">WiFi setup</h1>
            {props.apSsid && (
                <p class="wifi-setup__ap" data-testid="wifi-ap-ssid">
                    Connected to {props.apSsid}
                </p>
            )}
            <p class="wifi-setup__intro">
                Enter the credentials for the WiFi network the controller should
                join.
            </p>

            <form class="wifi-setup__form" onSubmit={handleSubmit} noValidate>
                <div class="wifi-setup__field">
                    <label class="wifi-setup__label" for="wifi-ssid">
                        Network name (SSID)
                    </label>
                    <input
                        id="wifi-ssid"
                        data-testid="wifi-ssid"
                        class="wifi-setup__input"
                        type="text"
                        autoComplete="off"
                        maxLength={WIFI_SSID_MAX_LEN}
                        value={ssid}
                        placeholder="MyNetwork"
                        disabled={submitting}
                        onInput={handleSsid}
                    />
                </div>

                <div class="wifi-setup__field">
                    <label class="wifi-setup__label" for="wifi-password">
                        Password
                    </label>
                    <input
                        id="wifi-password"
                        data-testid="wifi-password"
                        class="wifi-setup__input"
                        type="password"
                        autoComplete="off"
                        maxLength={WIFI_PASSWORD_MAX_LEN}
                        value={password}
                        placeholder="8–63 characters"
                        disabled={submitting}
                        onInput={handlePassword}
                    />
                </div>

                {phase === 'error' && errorMsg !== null && (
                    <p
                        class="wifi-setup__error"
                        data-testid="wifi-error"
                        role="alert"
                    >
                        {errorMsg}
                    </p>
                )}

                <button
                    type="submit"
                    data-testid="wifi-submit"
                    class="wifi-setup__submit"
                    disabled={!formValid || submitting}
                >
                    {submitting ? 'Saving…' : 'Save and connect'}
                </button>
            </form>
        </section>
    );
}

export default WifiSetup;
