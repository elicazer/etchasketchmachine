/**
 * `BleSocket` — a {@link WireSocket} adapter over Web Bluetooth GATT.
 *
 * This is the browser BLE half of the transport seam (Design §2, §3.4). It
 * lets the entire `WireClient` state machine — per-session sequence counter,
 * inner CRC, credit-based flow control, bounded retransmission, reconnect
 * window, and typed-event decoding — run **unchanged** over BLE: `BleSocket`
 * presents the same `WireSocket` surface a browser `WebSocket` does, so the
 * only thing that differs between the BLE and WiFi builds is the
 * `SocketFactory`.
 *
 * The `WireSocket` contract is "complete frame in, complete frame out":
 * `WireClient` calls `send(frameBytes)` with a whole `Frame_Envelope` and
 * expects `onmessage({data: ArrayBuffer})` to deliver a whole frame. BLE
 * notifications/writes carry at most one negotiated-MTU payload, so `BleSocket`
 * bridges that gap with the pure {@link fragment}/{@link Reassembler} core
 * (`ble_chunk.ts`): it fragments on `send` and reassembles before firing
 * `onmessage`. The chunk header never escapes this layer — the bytes handed to
 * `WireClient` are byte-identical to what the SPA emitted (Req 5.1–5.3).
 *
 * All GATT access goes through the injected {@link BleGattDeps} so the socket
 * is unit-testable with a fake characteristic, exactly as `WireClient` is
 * tested with a fake socket. No part of this module touches a real radio.
 *
 * Error distinction (Req 3.6): a failure during discovery — `requestDevice`,
 * `gatt.connect`, `getPrimaryService`, `getCharacteristic`, or
 * `startNotifications`, i.e. anything thrown *before* `readyState` reaches
 * OPEN — is surfaced as a typed {@link BleDiscoveryError} via `onerror`
 * followed by `onclose`. Because that pair fires while `WireClient` is still
 * in its `connecting` state, `WireClient` rejects the `connect()` promise (a
 * *discovery* failure the user sees immediately) and never opens its reconnect
 * window. A drop *after* OPEN instead fires `onclose` only, which `WireClient`
 * maps to its reconnect window (a *disconnect*). The two are therefore
 * distinct both in the error type handed to `onerror` and, functionally, in
 * the `WireClient` path each takes.
 *
 * Reconnect-to-same-device (Req 12.5, Design §3.9): `WireClient` recreates the
 * socket through its `SocketFactory` on every reconnect attempt, so a fresh
 * `BleSocket` is constructed per attempt. To re-`gatt.connect()` the *same*
 * `BluetoothDevice` without popping a new chooser, the device reference is
 * retained in the {@link BleGattDeps} closure (see {@link defaultBleDeps}) —
 * which outlives any single socket — rather than in the socket instance. The
 * first `requestDevice()` prompts and caches; every later call (including the
 * reconnect attempts) returns the cached device, so the connect flow just
 * reconnects its GATT server with no user gesture.
 *
 * @see Design §3.4 (BleSocket), §3.6/§4.3 (chunking), §3.9 (reconnect), §4.5
 * @see Requirements 3.1, 3.2, 3.6, 5.1, 5.2, 5.4, 5.5, 12.5
 */

import {
    ChunkError,
    Reassembler,
    fragment,
} from './ble_chunk';
import type { WireSocket } from './wire_client';

// -----------------------------------------------------------------------------
// Shared GATT constants (must stay byte-identical with firmware ble_server.h)
// -----------------------------------------------------------------------------

/** 128-bit GATT service UUID advertised by the Controller (Design §4.5). */
export const ESK_BLE_SERVICE_UUID = '6b1d0001-5f8e-4b3a-9c2d-1e7a4f8b2c10';

/** RX characteristic — browser → controller frames (Write/WriteWithoutResponse). */
export const ESK_BLE_RX_CHAR_UUID = '6b1d0002-5f8e-4b3a-9c2d-1e7a4f8b2c10';

/** TX characteristic — controller → browser frames (Notify). */
export const ESK_BLE_TX_CHAR_UUID = '6b1d0003-5f8e-4b3a-9c2d-1e7a4f8b2c10';

/** Human-readable advertised device name (Req 2.2). */
export const ESK_BLE_DEVICE_NAME = 'EtchASketch';

// -----------------------------------------------------------------------------
// Error distinction (Req 3.6)
// -----------------------------------------------------------------------------

/** The discovery step that failed, for diagnostics and tests. */
export type BleDiscoveryStage =
    | 'requestDevice' // the Web Bluetooth chooser / device request
    | 'connect' // gatt.connect()
    | 'service' // getPrimaryService(SERVICE_UUID)
    | 'characteristic' // getCharacteristic(RX/TX)
    | 'notifications'; // txChar.startNotifications()

/**
 * A failure that occurs during BLE discovery — before the socket reaches the
 * OPEN state. This is the *discovery* error of Req 3.6, deliberately distinct
 * from a post-open *disconnect* (which carries no error and arrives only via
 * `onclose`). `BleSocket` hands an instance to `onerror` (then fires
 * `onclose`) when `requestDevice`/`connect`/service/characteristic discovery
 * or `startNotifications` throws, so `WireClient` rejects its in-flight
 * `connect()` rather than entering the reconnect window.
 */
export class BleDiscoveryError extends Error {
    /** Which discovery step failed. */
    public readonly stage: BleDiscoveryStage;
    /** The underlying error thrown by Web Bluetooth, if any. */
    public readonly cause?: unknown;

    constructor(stage: BleDiscoveryStage, message: string, cause?: unknown) {
        super(message);
        this.name = 'BleDiscoveryError';
        this.stage = stage;
        this.cause = cause;
    }
}

/**
 * Default chunk body size (bytes) used when fragmenting outbound frames.
 *
 * Web Bluetooth does not expose the negotiated ATT MTU to the page, and the
 * spec's safe floor is the default 23-byte MTU (20 usable after the 3-byte ATT
 * header). Reserving 1 byte for the chunk micro-header leaves 19 body bytes,
 * which every characteristic write is guaranteed to accept regardless of the
 * negotiated MTU. Deployments that negotiate a larger MTU can raise this via
 * {@link BleGattDeps.mtuPayload} for fewer chunks per frame (Req 8.4).
 */
export const DEFAULT_MTU_PAYLOAD = 19;

// -----------------------------------------------------------------------------
// Web Bluetooth structural seams (injectable, fake-able)
// -----------------------------------------------------------------------------

// The DOM lib shipped with this project does not include the Web Bluetooth
// typings, and the production code only needs a narrow slice of them. We model
// that slice structurally so the browser's real `BluetoothRemoteGATT*` objects
// satisfy it and tests can pass trivial fakes.

/** Minimal GATT characteristic surface used by {@link BleSocket}. */
export interface BleCharacteristicLike {
    /** Most recently notified value (set before `characteristicvaluechanged`). */
    readonly value?: DataView | null;
    startNotifications(): Promise<BleCharacteristicLike>;
    writeValueWithoutResponse(value: BufferSource): Promise<void>;
    /**
     * Acknowledged write: resolves only after the peripheral confirms receipt
     * at the ATT layer. Used instead of writeValueWithoutResponse to get real
     * backpressure so a burst of command chunks cannot overrun the controller's
     * RX path and drop frames (which stalled multi-command draws).
     */
    writeValueWithResponse(value: BufferSource): Promise<void>;
    addEventListener(
        type: 'characteristicvaluechanged',
        listener: (event: Event) => void,
    ): void;
    removeEventListener(
        type: 'characteristicvaluechanged',
        listener: (event: Event) => void,
    ): void;
}

/** Minimal GATT primary-service surface. */
export interface BleServiceLike {
    getCharacteristic(uuid: string): Promise<BleCharacteristicLike>;
}

/** Minimal GATT server surface. */
export interface BleGattServerLike {
    readonly connected: boolean;
    connect(): Promise<BleGattServerLike>;
    disconnect(): void;
    getPrimaryService(uuid: string): Promise<BleServiceLike>;
}

/** Minimal `BluetoothDevice` surface. */
export interface BleDeviceLike {
    readonly gatt?: BleGattServerLike;
    addEventListener(
        type: 'gattserverdisconnected',
        listener: (event: Event) => void,
    ): void;
    removeEventListener(
        type: 'gattserverdisconnected',
        listener: (event: Event) => void,
    ): void;
}

/**
 * Injected GATT dependencies. The sole production member is
 * {@link requestDevice}, which wraps the user-gesture-bound
 * `navigator.bluetooth.requestDevice(...)` chooser; `defaultBleDeps` supplies
 * the real implementation and tests supply a fake that resolves to a fake
 * device/characteristic pair.
 */
export interface BleGattDeps {
    /**
     * Present the Web Bluetooth chooser filtered to the Etch-a-Sketch service
     * UUID and resolve to the selected device (Req 2.1, 2.3, 3.1).
     */
    requestDevice(): Promise<BleDeviceLike>;
    /**
     * Max chunk body bytes per BLE write. Defaults to {@link DEFAULT_MTU_PAYLOAD}
     * when omitted.
     */
    mtuPayload?: number;
}

// `WebSocket` readyState constants, mirrored so `WireClient`'s `readyState`
// checks (it compares against `1`/OPEN) behave identically.
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * Production {@link BleGattDeps} backed by `navigator.bluetooth`. The caller is
 * responsible for invoking the resulting socket's connect path from within a
 * user gesture, as Web Bluetooth requires.
 *
 * The selected {@link BleDeviceLike} is retained in this closure so that
 * `WireClient`'s reconnect path — which builds a fresh `BleSocket` through the
 * `SocketFactory` for each attempt — re-`gatt.connect()`s the *same* device
 * without prompting a new chooser (Req 12.5, Design §3.9). The first call
 * pops the chooser (a user gesture) and caches the device; subsequent calls
 * resolve immediately to the cached device. Only the initial selection needs a
 * user gesture; reconnecting an already-chosen device's GATT server does not.
 */
export function defaultBleDeps(): BleGattDeps {
    let cachedDevice: BleDeviceLike | null = null;
    return {
        requestDevice: async () => {
            if (cachedDevice) return cachedDevice;
            const device = await (
                navigator as unknown as {
                    bluetooth: {
                        requestDevice(options: unknown): Promise<BleDeviceLike>;
                    };
                }
            ).bluetooth.requestDevice({
                filters: [{ services: [ESK_BLE_SERVICE_UUID] }],
            });
            cachedDevice = device;
            return device;
        },
    };
}

// -----------------------------------------------------------------------------
// BleSocket
// -----------------------------------------------------------------------------

/**
 * A {@link WireSocket} that moves complete `Frame_Envelope`s over Web Bluetooth
 * GATT, chunking on send and reassembling on receive.
 *
 * Construction immediately kicks off the asynchronous connect flow (mirroring
 * how `new WebSocket(url)` begins connecting on construction). Because connect
 * yields to the event loop before completing, the `WireClient`'s synchronous
 * `onopen`/`onmessage`/… handler assignment runs first and reliably observes
 * the `onopen` callback.
 */
export class BleSocket implements WireSocket {
    binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
    readyState: number = CONNECTING;

    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;

    private readonly deps: BleGattDeps;
    private readonly mtuPayload: number;
    private readonly reassembler = new Reassembler();

    private device: BleDeviceLike | null = null;
    private rxChar: BleCharacteristicLike | null = null;
    private txChar: BleCharacteristicLike | null = null;

    /** Bound listener references so they can be detached on close. */
    private readonly onNotify = (event: Event): void =>
        this.handleNotification(event);
    private readonly onDisconnected = (): void => this.handleDisconnected();

    /**
     * Serialises outbound chunk writes so `writeValueWithoutResponse`s issued
     * by a single `send` (and across sends) preserve global frame ordering,
     * which the credit/ACK/RETX protocol assumes.
     */
    private writeChain: Promise<void> = Promise.resolve();

    constructor(deps: BleGattDeps) {
        this.deps = deps;
        this.mtuPayload = deps.mtuPayload ?? DEFAULT_MTU_PAYLOAD;
        // Begin connecting on the next microtask so the caller can attach
        // event handlers before `onopen` could fire.
        void this.connect();
    }

    /**
     * Connect flow (Design §3.4, Req 3.1, 3.2): request the device → connect
     * GATT → discover the primary service → resolve the RX/TX characteristics
     * → enable TX notifications and subscribe → transition to OPEN and fire
     * `onopen`.
     *
     * Every step here runs *before* `readyState` becomes OPEN, so any failure
     * is a **discovery** failure (Req 3.6): it is wrapped in a typed
     * {@link BleDiscoveryError} (identifying which step failed) and surfaced
     * via `onerror` then `onclose` by {@link fail}. Because this pair fires
     * while `WireClient` is still `connecting`, `WireClient` rejects its
     * `connect()` promise instead of opening the reconnect window — the
     * distinction from a post-open disconnect (handled by
     * {@link handleDisconnected}, `onclose` only) that Req 3.6 requires.
     *
     * `requestDevice` may resolve to a previously-selected device retained by
     * the deps closure, in which case this simply re-`gatt.connect()`s that
     * same device with no chooser prompt — the reconnect-to-same-device path
     * (Req 12.5).
     */
    private async connect(): Promise<void> {
        try {
            const device = await this.discover('requestDevice', () =>
                this.deps.requestDevice(),
            );
            this.device = device;
            device.addEventListener('gattserverdisconnected', this.onDisconnected);

            if (!device.gatt) {
                throw new BleDiscoveryError(
                    'connect',
                    'BleSocket: selected device exposes no GATT server',
                );
            }
            const gatt = device.gatt;
            const server = await this.discover('connect', () => gatt.connect());
            const service = await this.discover('service', () =>
                server.getPrimaryService(ESK_BLE_SERVICE_UUID),
            );
            const rxChar = await this.discover('characteristic', () =>
                service.getCharacteristic(ESK_BLE_RX_CHAR_UUID),
            );
            const txChar = await this.discover('characteristic', () =>
                service.getCharacteristic(ESK_BLE_TX_CHAR_UUID),
            );

            // Enable controller → browser notifications before declaring OPEN
            // so the HELLO the Controller sends on session establishment is not
            // missed (Req 3.2, 3.3).
            await this.discover('notifications', () => txChar.startNotifications());
            txChar.addEventListener('characteristicvaluechanged', this.onNotify);

            this.rxChar = rxChar;
            this.txChar = txChar;

            if (this.readyState !== CONNECTING) {
                // close() was called while connecting; honour the teardown.
                this.teardown();
                return;
            }
            this.readyState = OPEN;
            this.onopen?.({});
        } catch (err) {
            this.fail(err);
        }
    }

    /**
     * Run one discovery step, normalising any thrown error into a typed
     * {@link BleDiscoveryError} tagged with the step that failed (Req 3.6).
     */
    private async discover<T>(
        stage: BleDiscoveryStage,
        step: () => Promise<T>,
    ): Promise<T> {
        try {
            return await step();
        } catch (err) {
            if (err instanceof BleDiscoveryError) throw err;
            const detail = err instanceof Error ? err.message : String(err);
            throw new BleDiscoveryError(
                stage,
                `BleSocket: BLE discovery failed at ${stage}: ${detail}`,
                err,
            );
        }
    }

    /**
     * Send one complete `Frame_Envelope`. Fragments the frame into ordered
     * BLE chunks and writes each as a `writeValueWithoutResponse` on the RX
     * characteristic, preserving order via the internal write chain (Req 5.1,
     * 5.2, 5.4 — incremental streaming, never a bulk upload).
     */
    send(data: ArrayBufferView | ArrayBufferLike): void {
        if (this.readyState !== OPEN || !this.rxChar) {
            this.onerror?.(new Error('BleSocket.send: socket is not open'));
            return;
        }

        let chunks: Uint8Array[];
        try {
            chunks = fragment(toUint8Array(data), this.mtuPayload);
        } catch (err) {
            // A frame too large to chunk (>15 chunks) is an unrecoverable
            // transmit fault; the protocol never emits such frames.
            this.onerror?.(err);
            return;
        }

        const rxChar = this.rxChar;
        this.writeChain = this.writeChain.then(async () => {
            for (const chunk of chunks) {
                // Hand each write a standalone buffer copy so the BLE stack
                // never observes shared/aliased memory. Use an ACKNOWLEDGED
                // write (writeValueWithResponse) so each chunk resolves only
                // after the controller confirms receipt — this provides real
                // backpressure so a burst of command chunks cannot overrun the
                // controller's RX path and drop frames. (Fire-and-forget
                // writeValueWithoutResponse previously dropped chunks under a
                // multi-command burst, leaving a seq gap that stalled the draw.)
                await rxChar.writeValueWithResponse(copyBytes(chunk));
            }
        });
        // Surface async write failures (e.g. a drop mid-send) through onerror
        // without unhandled-rejection noise; swallow so the chain keeps going.
        this.writeChain.catch((err) => this.onerror?.(err));
    }

    /**
     * Priority send for URGENT control frames (STOP / PAUSE / CANCEL / RESUME).
     *
     * The normal {@link send} appends to a single serialised acknowledged-write
     * chain, so during a draw a STOP would queue BEHIND all the pending command
     * chunks and not transmit until they drain — the stop button would feel
     * dead. This bypasses that chain and writes the (small, ≤2-chunk) control
     * frame straight to the RX characteristic so it reaches the controller
     * immediately, ahead of the command backlog. Uses acknowledged writes for
     * delivery but does NOT block on the command chain.
     */
    sendPriority(data: ArrayBufferView | ArrayBufferLike): void {
        if (this.readyState !== OPEN || !this.rxChar) {
            this.onerror?.(new Error('BleSocket.sendPriority: socket is not open'));
            return;
        }
        let chunks: Uint8Array[];
        try {
            chunks = fragment(toUint8Array(data), this.mtuPayload);
        } catch (err) {
            this.onerror?.(err);
            return;
        }
        const rxChar = this.rxChar;
        // Fire immediately on its own micro-chain, independent of writeChain so
        // it is not blocked by queued command writes.
        void (async () => {
            try {
                for (const chunk of chunks) {
                    await rxChar.writeValueWithResponse(copyBytes(chunk));
                }
            } catch (err) {
                this.onerror?.(err);
            }
        })();
    }

    /** Deliberately close the connection: disconnect GATT and report `onclose`. */
    close(_code?: number, _reason?: string): void {
        if (this.readyState === CLOSED || this.readyState === CLOSING) return;
        this.readyState = CLOSING;
        this.teardown();
        this.readyState = CLOSED;
        // Mirror WebSocket: a deliberate close (even one issued mid-connect)
        // still fires onclose; the connect() path observes CLOSING and bails.
        this.onclose?.({});
    }

    // -------------------------------------------------------------------------
    // Inbound notifications
    // -------------------------------------------------------------------------

    /**
     * Handle one TX notification: copy the chunk out of the (reused) GATT
     * buffer, feed it to the reassembler, and on a completed frame fire
     * `onmessage` with the exact `Frame_Envelope` bytes (Req 5.3). An
     * unrecoverable reassembly failure is reported via `onerror` so the
     * `WireClient` treats it as a transmit fault and retransmits (Req 5.5).
     */
    private handleNotification(event: Event): void {
        const target = event.target as BleCharacteristicLike | null;
        const view = target?.value;
        if (!view) return;
        const chunk = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();

        let frame: Uint8Array | null;
        try {
            frame = this.reassembler.push(chunk);
        } catch (err) {
            if (err instanceof ChunkError) {
                this.onerror?.(err);
                return;
            }
            throw err;
        }
        if (frame === null) return;

        // Deliver a standalone ArrayBuffer holding exactly the frame bytes.
        const buffer = frame.buffer.slice(
            frame.byteOffset,
            frame.byteOffset + frame.byteLength,
        );
        this.onmessage?.({ data: buffer });
    }

    // -------------------------------------------------------------------------
    // Lifecycle teardown
    // -------------------------------------------------------------------------

    /**
     * A post-open GATT drop: surface as `onclose` *without* an `onerror`
     * (Req 3.6, 12.5 seam). Because the socket is already OPEN, `WireClient`
     * is in its `connected` state, so this bare `onclose` drives its reconnect
     * window — `WireClient` then rebuilds a socket through the `SocketFactory`,
     * whose deps reconnect the same retained `BluetoothDevice` (Req 12.5).
     * This is the *disconnect* half of the Req 3.6 distinction; the *discovery*
     * half is {@link fail}, which fires `onerror` before `onclose` while still
     * pre-open.
     */
    private handleDisconnected(): void {
        if (this.readyState === CLOSED || this.readyState === CLOSING) return;
        this.readyState = CLOSED;
        this.detachListeners();
        this.onclose?.({});
    }

    /**
     * A failure before OPEN — a **discovery** failure (Req 3.6). Reports the
     * (typed {@link BleDiscoveryError}) via `onerror` then `onclose`. The
     * `onerror` carrying a `BleDiscoveryError`, paired with `WireClient` still
     * being in its `connecting` state, is what distinguishes this from a
     * post-open disconnect: `WireClient` rejects the in-flight `connect()`
     * promise rather than opening its reconnect window.
     */
    private fail(err: unknown): void {
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        this.teardown();
        this.onerror?.(err);
        this.onclose?.({});
    }

    /** Detach listeners and disconnect the GATT server if still connected. */
    private teardown(): void {
        this.detachListeners();
        try {
            if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        } catch {
            /* ignore disconnect errors during teardown */
        }
    }

    private detachListeners(): void {
        this.txChar?.removeEventListener(
            'characteristicvaluechanged',
            this.onNotify,
        );
        this.device?.removeEventListener(
            'gattserverdisconnected',
            this.onDisconnected,
        );
        this.reassembler.reset();
    }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Normalise a `send` payload to a `Uint8Array` view (no copy). */
function toUint8Array(data: ArrayBufferView | ArrayBufferLike): Uint8Array {
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data as ArrayBufferLike);
}

/** Copy a chunk into a fresh, exactly-sized buffer for a BLE write. */
function copyBytes(bytes: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
}
