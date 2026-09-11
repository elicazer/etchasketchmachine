import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { WifiSetup, type WifiSubmitFn } from './WifiSetup';
import type { WifiSetupResult } from '../net/wifi_setup';

/**
 * Unit tests for the AP-mode WiFi configuration page (Req 1.3–1.5, 1.7).
 *
 * Rendered with Preact directly (no @testing-library): each test mounts into a
 * jsdom container inside `act()` so effects flush, then drives the form and
 * asserts on the rendered DOM. The credential-submission transport is injected
 * as a stub (`submit` prop) so no real `fetch` is touched; one test additionally
 * verifies the default path POSTs through a mocked global `fetch`.
 */

let containers: HTMLDivElement[] = [];

afterEach(() => {
    for (const c of containers) {
        act(() => render(null, c));
        c.remove();
    }
    containers = [];
    vi.restoreAllMocks();
});

function mount(jsx: preact.ComponentChild): HTMLDivElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);
    act(() => {
        render(jsx as preact.VNode, container);
    });
    return container;
}

function q<T extends Element = HTMLElement>(root: ParentNode, testId: string): T {
    const el = root.querySelector(`[data-testid="${testId}"]`);
    if (el === null) throw new Error(`missing [data-testid="${testId}"]`);
    return el as T;
}

/** Set an input's value and fire preact's `onInput`. */
function setValue(el: HTMLInputElement, value: string): void {
    el.value = value;
    act(() => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Flush pending microtasks so an awaited submit settles. */
async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('WifiSetup — client-side validation (Req 1.4)', () => {
    it('keeps submit disabled and does not POST for an invalid SSID/password', () => {
        const submit = vi.fn<WifiSubmitFn>();
        const root = mount(<WifiSetup submit={submit} />);

        const button = q<HTMLButtonElement>(root, 'wifi-submit');
        // Empty form: button disabled.
        expect(button.disabled).toBe(true);

        // Valid SSID but too-short password keeps it disabled.
        setValue(q<HTMLInputElement>(root, 'wifi-ssid'), 'home-net');
        setValue(q<HTMLInputElement>(root, 'wifi-password'), 'short');
        expect(q<HTMLButtonElement>(root, 'wifi-submit').disabled).toBe(true);

        expect(submit).not.toHaveBeenCalled();
    });

    it('does not POST when a submit is forced with an out-of-range password', async () => {
        const submit = vi.fn<WifiSubmitFn>();
        const root = mount(<WifiSetup submit={submit} />);

        setValue(q<HTMLInputElement>(root, 'wifi-ssid'), 'home-net');
        setValue(q<HTMLInputElement>(root, 'wifi-password'), 'short');

        // Submit the form directly (bypassing the disabled button) to confirm
        // the handler re-validates and refuses to call the transport.
        act(() => {
            (root.querySelector('form') as HTMLFormElement).dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true }),
            );
        });
        await flush();

        expect(submit).not.toHaveBeenCalled();
        expect(q(root, 'wifi-error').textContent).toMatch(/password/i);
    });
});

describe('WifiSetup — successful submission (Req 1.5, 1.7)', () => {
    it('POSTs valid credentials and renders the returned IP and hostname', async () => {
        const submit = vi.fn<WifiSubmitFn>(async () => ({
            ok: true,
            ip: '192.168.1.50',
            hostname: 'etchasketch.local',
        }));
        const root = mount(<WifiSetup submit={submit} />);

        setValue(q<HTMLInputElement>(root, 'wifi-ssid'), 'home-net');
        setValue(q<HTMLInputElement>(root, 'wifi-password'), 'hunter22!');

        act(() => {
            q<HTMLButtonElement>(root, 'wifi-submit').click();
        });
        await flush();

        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit).toHaveBeenCalledWith({
            ssid: 'home-net',
            password: 'hunter22!',
        });

        expect(q(root, 'wifi-success')).toBeTruthy();
        expect(q(root, 'wifi-ip').textContent).toBe('192.168.1.50');
        expect(q(root, 'wifi-hostname').textContent).toBe('etchasketch.local');
    });
});

describe('WifiSetup — failure response (Req 1.4, 1.5)', () => {
    it('surfaces the server error message and stays on the form', async () => {
        const result: WifiSetupResult = {
            ok: false,
            error: 'credentials failed validation (ssid 1-32, password 8-63 chars)',
        };
        const submit = vi.fn<WifiSubmitFn>(async () => result);
        const root = mount(<WifiSetup submit={submit} />);

        setValue(q<HTMLInputElement>(root, 'wifi-ssid'), 'home-net');
        setValue(q<HTMLInputElement>(root, 'wifi-password'), 'hunter22!');

        act(() => {
            q<HTMLButtonElement>(root, 'wifi-submit').click();
        });
        await flush();

        expect(submit).toHaveBeenCalledTimes(1);
        expect(q(root, 'wifi-error').textContent).toMatch(/failed validation/i);
        // Still on the form: the success view is not shown.
        expect(root.querySelector('[data-testid="wifi-success"]')).toBeNull();
    });
});

describe('WifiSetup — default transport (Req 1.5)', () => {
    it('uses the real helper (POST /api/wifi) when no submit prop is given', async () => {
        const fetchMock = vi.fn<typeof fetch>(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    json: () =>
                        Promise.resolve({
                            ip: '10.0.0.7',
                            hostname: 'etchasketch.local',
                        }),
                }) as unknown as Response,
        );
        vi.stubGlobal('fetch', fetchMock);

        const root = mount(<WifiSetup />);
        setValue(q<HTMLInputElement>(root, 'wifi-ssid'), 'home-net');
        setValue(q<HTMLInputElement>(root, 'wifi-password'), 'hunter22!');

        act(() => {
            q<HTMLButtonElement>(root, 'wifi-submit').click();
        });
        await flush();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]![0]).toBe('/api/wifi');
        expect(q(root, 'wifi-ip').textContent).toBe('10.0.0.7');
    });
});
