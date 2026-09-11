import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    BleSocket,
    BleDiscoveryError,
    defaultBleDeps,
    ESK_BLE_SERVICE_UUID,
    ESK_BLE_RX_CHAR_UUID,
    ESK_BLE_TX_CHAR_UUID,
    type BleGattDeps,
    type BleDeviceLike,
    type BleGattServerLike,
    type BleServiceLike,
    type BleCharacteristicLike,
} from './ble_socket';
import { fragment, reassemble } from './ble_chunk';

/**
 * Unit tests for {@link BleSocket} (Design §3.4, §7.2).
 *
 * Everything runs against a fake Web Bluetooth GATT stack (device → server →
 * service → RX/TX characteristics) injected through {@link BleGattDeps},
 * mirroring how `WireClient` is tested with a fake socket. No real radio is
 * touched. The fakes record the order of discovery calls, capture outbound
 * `writeValueWithoutResponse` chunks, and expose triggers to simulate inbound
 * TX notifications and a `gattserverdisconnected` drop.
 *
 * `BleSocket.connect()` is kicked off asynchronously from the constructor, so
 * tests await the `onopen` callback (or a microtask flush) before asserting.
 */

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/** Drain the microtask queue so the async connect()/write-chain settles. */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Fake GATT characteristic: records writes and replays notifications. */
class FakeCharacteristic implements BleCharacteristicLike {
    value: DataView | null = null;
    writes: Uint8Array[] = [];
    private listener: ((event: Event) => void) | null = null;

    constructor(
        private readonly log: string[],
        private readonly label: string,
        private readonly behaviour: {
            startNotificationsThrows?: boolean | undefined;
        } = {},
    ) { }

    async startNotifications(): Promise<BleCharacteristicLike> {
        this.log.push(`startNotifications:${this.label}`);
        if (this.behaviour.startNotificationsThrows) {
            throw new Error('startNotifications boom');
        }
        return this;
    }

    async writeValueWithoutResponse(value: BufferSource): Promise<void> {
        this.recordWrite(value);
    }

    async writeValueWithResponse(value: BufferSource): Promise<void> {
        this.recordWrite(value);
    }

    private recordWrite(value: BufferSource): void {
        const bytes = ArrayBuffer.isView(value)
            ? new Uint8Array(
                value.buffer,
                value.byteOffset,
                value.byteLength,
            ).slice()
            : new Uint8Array(value as ArrayBuffer).slice();
        this.writes.push(bytes);
    }

    addEventListener(
        _type: 'characteristicvaluechanged',
        listener: (event: Event) => void,
    ): void {
        this.log.push(`subscribe:${this.label}`);
        this.listener = listener;
    }

    removeEventListener(): void {
        this.listener = null;
    }

    /** Simulate one inbound notification carrying `chunk` on this char. */
    simulateNotification(chunk: Uint8Array): void {
        this.value = new DataView(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength,
        );
        // BleSocket only reads `event.target`, so a structural stand-in is
        // sufficient and avoids jsdom Event.target being read-only/null.
        this.listener?.({ target: this } as unknown as Event);
    }
}

/** Fake primary service that hands back the RX/TX characteristics by UUID. */
class FakeService implements BleServiceLike {
    constructor(
        private readonly log: string[],
        private readonly rxChar: FakeCharacteristic,
        private readonly txChar: FakeCharacteristic,
        private readonly behaviour: {
            getCharacteristicThrows?: boolean | undefined;
        } = {},
    ) { }

    async getCharacteristic(uuid: string): Promise<BleCharacteristicLike> {
        this.log.push(`getCharacteristic:${uuid}`);
        if (this.behaviour.getCharacteristicThrows) {
            throw new Error('getCharacteristic boom');
        }
        if (uuid === ESK_BLE_RX_CHAR_UUID) return this.rxChar;
        if (uuid === ESK_BLE_TX_CHAR_UUID) return this.txChar;
        throw new Error(`unexpected characteristic uuid ${uuid}`);
    }
}

/** Fake GATT server. */
class FakeServer implements BleGattServerLike {
    connected = false;

    constructor(
        private readonly log: string[],
        private readonly service: FakeService,
    ) { }

    async connect(): Promise<BleGattServerLike> {
        this.log.push('connect');
        this.connected = true;
        return this;
    }

    disconnect(): void {
        this.log.push('disconnect');
        this.connected = false;
    }

    async getPrimaryService(uuid: string): Promise<BleServiceLike> {
        this.log.push(`getPrimaryService:${uuid}`);
        return this.service;
    }
}

/** Fake `BluetoothDevice` exposing a `gattserverdisconnected` trigger. */
class FakeDevice implements BleDeviceLike {
    private disconnectListener: ((event: Event) => void) | null = null;

    constructor(public readonly gatt: FakeServer) { }

    addEventListener(
        _type: 'gattserverdisconnected',
        listener: (event: Event) => void,
    ): void {
        this.disconnectListener = listener;
    }

    removeEventListener(): void {
        this.disconnectListener = null;
    }

    /** Simulate a post-open GATT drop. */
    simulateDisconnect(): void {
        this.gatt.connected = false;
        this.disconnectListener?.({} as Event);
    }
}

interface Harness {
    deps: BleGattDeps;
    device: FakeDevice;
    rxChar: FakeCharacteristic;
    txChar: FakeCharacteristic;
    log: string[];
    requestDeviceCalls: number;
}

function makeHarness(
    opts: {
        mtuPayload?: number;
        requestDeviceThrows?: boolean;
        getCharacteristicThrows?: boolean;
        startNotificationsThrows?: boolean;
    } = {},
): Harness {
    const log: string[] = [];
    const rxChar = new FakeCharacteristic(log, 'RX');
    const txChar = new FakeCharacteristic(log, 'TX', {
        startNotificationsThrows: opts.startNotificationsThrows,
    });
    const service = new FakeService(log, rxChar, txChar, {
        getCharacteristicThrows: opts.getCharacteristicThrows,
    });
    const server = new FakeServer(log, service);
    const device = new FakeDevice(server);

    const harness: Harness = {
        deps: {
            ...(opts.mtuPayload !== undefined ? { mtuPayload: opts.mtuPayload } : {}),
            requestDevice: async () => {
                harness.requestDeviceCalls++;
                log.push('requestDevice');
                if (opts.requestDeviceThrows) {
                    throw new Error('requestDevice boom');
                }
                return device;
            },
        },
        device,
        rxChar,
        txChar,
        log,
        requestDeviceCalls: 0,
    };
    return harness;
}

/** Construct a socket, capture its callbacks, and await `onopen`. */
async function openSocket(deps: BleGattDeps): Promise<{
    socket: BleSocket;
    opens: number;
    errors: unknown[];
    closes: number;
    messages: ArrayBuffer[];
}> {
    const capture = {
        socket: null as unknown as BleSocket,
        opens: 0,
        errors: [] as unknown[],
        closes: 0,
        messages: [] as ArrayBuffer[],
    };
    const socket = new BleSocket(deps);
    capture.socket = socket;
    socket.onopen = () => {
        capture.opens++;
    };
    socket.onerror = (e) => {
        capture.errors.push(e);
    };
    socket.onclose = () => {
        capture.closes++;
    };
    socket.onmessage = (ev) => {
        capture.messages.push(ev.data as ArrayBuffer);
    };
    await flush();
    return capture;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('BleSocket connect flow (Req 3.1, 3.2)', () => {
    it('discovers in order, enables notifications before OPEN, then fires onopen', async () => {
        const h = makeHarness();
        const cap = await openSocket(h.deps);

        expect(cap.socket.readyState).toBe(1); // OPEN
        expect(cap.opens).toBe(1);
        expect(cap.errors).toHaveLength(0);

        // Full discovery ordering: requestDevice → connect → service →
        // getCharacteristic(RX) → getCharacteristic(TX) → startNotifications →
        // subscribe(characteristicvaluechanged). onopen is appended by the
        // capture handler only after readyState becomes OPEN.
        expect(h.log).toEqual([
            'requestDevice',
            'connect',
            `getPrimaryService:${ESK_BLE_SERVICE_UUID}`,
            `getCharacteristic:${ESK_BLE_RX_CHAR_UUID}`,
            `getCharacteristic:${ESK_BLE_TX_CHAR_UUID}`,
            'startNotifications:TX',
            'subscribe:TX',
        ]);
    });

    it('enables TX notifications strictly before transitioning to OPEN', async () => {
        const h = makeHarness();
        const order: string[] = [];

        const socket = new BleSocket(h.deps);
        // Re-wrap startNotifications to record relative to onopen.
        const realStart = h.txChar.startNotifications.bind(h.txChar);
        h.txChar.startNotifications = async () => {
            order.push('startNotifications');
            return realStart();
        };
        socket.onopen = () => order.push('onopen');
        await flush();

        expect(order).toEqual(['startNotifications', 'onopen']);
    });
});

describe('BleSocket.send fragments to writeValueWithoutResponse (Req 5.1, 5.2)', () => {
    it('splits a frame into one chunk per fragment and preserves bytes', async () => {
        const mtuPayload = 4;
        const h = makeHarness({ mtuPayload });
        const cap = await openSocket(h.deps);

        // 10 bytes with a 4-byte body forces ceil(10/4) = 3 chunks.
        const frame = new Uint8Array([
            0x01, 0x20, 0x06, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        ]);
        cap.socket.send(frame);
        await flush();

        const expectedChunks = fragment(frame, mtuPayload);
        expect(h.rxChar.writes).toHaveLength(expectedChunks.length);
        expect(h.rxChar.writes.length).toBe(3);

        // Each write equals the corresponding fragment chunk...
        h.rxChar.writes.forEach((written, i) => {
            expect(Array.from(written)).toEqual(Array.from(expectedChunks[i]));
        });
        // ...and reassembling the written chunks reproduces the frame exactly.
        expect(Array.from(reassemble(h.rxChar.writes))).toEqual(
            Array.from(frame),
        );
        expect(cap.errors).toHaveLength(0);
    });

    it('writes a single chunk when the frame fits one MTU payload', async () => {
        const h = makeHarness({ mtuPayload: 19 });
        const cap = await openSocket(h.deps);

        const frame = new Uint8Array([0x01, 0x10, 0x02, 0x00, 0x07, 0x09]);
        cap.socket.send(frame);
        await flush();

        expect(h.rxChar.writes).toHaveLength(1);
        expect(Array.from(reassemble(h.rxChar.writes))).toEqual(
            Array.from(frame),
        );
    });
});

describe('BleSocket.sendPriority (urgent control frames)', () => {
    it('transmits the frame chunks immediately (used for STOP/pause/cancel)', async () => {
        const h = makeHarness({ mtuPayload: 19 });
        const cap = await openSocket(h.deps);

        // A small control-sized frame (single chunk).
        const frame = new Uint8Array([0x01, 0x02, 0x01, 0x00, 0x04]);
        cap.socket.sendPriority!(frame);
        await flush();

        expect(h.rxChar.writes.length).toBeGreaterThanOrEqual(1);
        expect(Array.from(reassemble(h.rxChar.writes))).toEqual(
            Array.from(frame),
        );
        expect(cap.errors).toHaveLength(0);
    });
});

describe('BleSocket inbound notifications reassemble (Req 5.3)', () => {
    it('reassembles ordered chunks into onmessage({data}) with exact bytes', async () => {
        const mtuPayload = 4;
        const h = makeHarness({ mtuPayload });
        const cap = await openSocket(h.deps);

        const frame = new Uint8Array([
            0x01, 0x22, 0x08, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
            0x88,
        ]);
        const chunks = fragment(frame, mtuPayload);
        expect(chunks.length).toBeGreaterThan(1);

        // Deliver all but the last chunk: no frame yet.
        for (let i = 0; i < chunks.length - 1; i++) {
            h.txChar.simulateNotification(chunks[i]);
        }
        expect(cap.messages).toHaveLength(0);

        // Final chunk completes the frame.
        h.txChar.simulateNotification(chunks[chunks.length - 1]);
        expect(cap.messages).toHaveLength(1);
        expect(Array.from(new Uint8Array(cap.messages[0]))).toEqual(
            Array.from(frame),
        );
        expect(cap.errors).toHaveLength(0);
    });

    it('delivers a single-chunk frame in one notification', async () => {
        const h = makeHarness();
        const cap = await openSocket(h.deps);

        const frame = new Uint8Array([0x01, 0x30, 0x01, 0x00, 0x02]);
        const [chunk] = fragment(frame, 19);
        h.txChar.simulateNotification(chunk);

        expect(cap.messages).toHaveLength(1);
        expect(Array.from(new Uint8Array(cap.messages[0]))).toEqual(
            Array.from(frame),
        );
    });
});

describe('BleSocket error distinction (Req 3.6)', () => {
    it('surfaces a discovery failure as BleDiscoveryError on onerror + onclose, never OPEN', async () => {
        const h = makeHarness({ requestDeviceThrows: true });
        const cap = await openSocket(h.deps);

        expect(cap.opens).toBe(0);
        expect(cap.socket.readyState).toBe(3); // CLOSED, never OPEN
        expect(cap.errors).toHaveLength(1);
        expect(cap.errors[0]).toBeInstanceOf(BleDiscoveryError);
        expect((cap.errors[0] as BleDiscoveryError).stage).toBe('requestDevice');
        expect(cap.closes).toBe(1);
    });

    it('tags a getCharacteristic discovery failure with the characteristic stage', async () => {
        const h = makeHarness({ getCharacteristicThrows: true });
        const cap = await openSocket(h.deps);

        expect(cap.opens).toBe(0);
        expect(cap.errors).toHaveLength(1);
        expect(cap.errors[0]).toBeInstanceOf(BleDiscoveryError);
        expect((cap.errors[0] as BleDiscoveryError).stage).toBe(
            'characteristic',
        );
        expect(cap.closes).toBe(1);
    });

    it('tags a startNotifications discovery failure with the notifications stage', async () => {
        const h = makeHarness({ startNotificationsThrows: true });
        const cap = await openSocket(h.deps);

        expect(cap.opens).toBe(0);
        expect(cap.errors).toHaveLength(1);
        expect((cap.errors[0] as BleDiscoveryError).stage).toBe('notifications');
        expect(cap.closes).toBe(1);
    });

    it('routes a post-open disconnect through onclose only, with no onerror', async () => {
        const h = makeHarness();
        const cap = await openSocket(h.deps);
        expect(cap.opens).toBe(1);
        expect(cap.socket.readyState).toBe(1); // OPEN

        h.device.simulateDisconnect();

        expect(cap.closes).toBe(1);
        expect(cap.errors).toHaveLength(0); // disconnect carries no error
        expect(cap.socket.readyState).toBe(3); // CLOSED
    });
});

describe('BleSocket reconnect-to-same-device (Req 12.5)', () => {
    afterEach(() => {
        delete (navigator as unknown as { bluetooth?: unknown }).bluetooth;
        vi.restoreAllMocks();
    });

    it('reuses the cached device so navigator.bluetooth.requestDevice is called once across sockets', async () => {
        // Build one fake device the chooser resolves to.
        const log: string[] = [];
        const rxChar = new FakeCharacteristic(log, 'RX');
        const txChar = new FakeCharacteristic(log, 'TX');
        const service = new FakeService(log, rxChar, txChar);
        const server = new FakeServer(log, service);
        const device = new FakeDevice(server);

        const requestDevice = vi.fn(async () => device as BleDeviceLike);
        (navigator as unknown as { bluetooth: unknown }).bluetooth = {
            requestDevice,
        };

        // A single deps closure is shared across reconnect attempts (the
        // SocketFactory builds a fresh BleSocket per attempt, but the deps —
        // and thus the cached device — outlive any one socket).
        const deps = defaultBleDeps();

        const first = await openSocket(deps);
        expect(first.opens).toBe(1);

        // Simulate WireClient rebuilding the socket on reconnect.
        const second = await openSocket(deps);
        expect(second.opens).toBe(1);

        const third = await openSocket(deps);
        expect(third.opens).toBe(1);

        // The underlying chooser only popped once; every later connect reused
        // the retained device.
        expect(requestDevice).toHaveBeenCalledTimes(1);
    });
});
