import { describe, it, expect } from 'vitest';
import {
    WireClient,
    type WireSocket,
    type TimerApi,
    type HomeEvent,
} from './wire_client';
import { FrameType, encodeFrame } from '../codec/frame';

/**
 * Cross-language golden-bytes fixture for the HELLO envelope layout (Task 11.1).
 *
 * Feature: visual-corner-calibration, Property 4
 *
 * Property 4: Envelope round-trips through NVM and HELLO unchanged
 * (cross-language decode side).
 *
 * This pins the §4.8 HELLO payload layout as a SINGLE SOURCE OF TRUTH shared
 * between the firmware serialiser and this TS decoder. The 40-byte
 * {@link GOLDEN_HELLO} array below is byte-identical to the `kGoldenHello`
 * fixture asserted on the firmware side in:
 *
 *     firmware/tests/test_hello_crosscheck/test_hello_crosscheck.cpp
 *
 * The firmware test proves `serializeHello(fixture)` produces exactly these
 * bytes; this test proves the same bytes decode through `WireClient.onHello`
 * (offsets 32/36 + flags@28 bit2) to the expected envelope {x:12345, y:67890}
 * with envelopeCalibrated=true. If either side changes the HELLO offsets the
 * two golden arrays diverge and one suite fails the build — the layouts can
 * never silently drift apart.
 *
 * Validates: Requirements 8.1, 8.3, 11.1.
 *
 * Fixture: firmware_version=0x00010002, max_sps=1000, backlash=0,
 * mm_per_rev=0, logical_pos=0, flags=0x05 (calibrated|envelope-calibrated),
 * buffer_capacity=32, envelope_x_steps=12345, envelope_y_steps=67890.
 */
const GOLDEN_HELLO = new Uint8Array([
    0x02, 0x00, 0x01, 0x00, //  0  u32  firmware_version = 0x00010002
    0xe8, 0x03,             //  4  u16  max_sps          = 1000
    0x00, 0x00,             //  6  u16  reserved         = 0
    0x00, 0x00,             //  8  u16  backlash_x        = 0
    0x00, 0x00,             // 10  u16  backlash_y        = 0
    0x00, 0x00, 0x00, 0x00, // 12  f32  mm_per_rev_x      = 0.0
    0x00, 0x00, 0x00, 0x00, // 16  f32  mm_per_rev_y      = 0.0
    0x00, 0x00, 0x00, 0x00, // 20  i32  logical_x_steps   = 0
    0x00, 0x00, 0x00, 0x00, // 24  i32  logical_y_steps   = 0
    0x05,                   // 28  u8   flags = CALIBRATED|ENVELOPE_CALIBRATED
    0x00,                   // 29  u8   reserved          = 0
    0x20, 0x00,             // 30  u16  buffer_capacity   = 32
    0x39, 0x30, 0x00, 0x00, // 32  u32  envelope_x_steps  = 12345 (0x3039)
    0x32, 0x09, 0x01, 0x00, // 36  u32  envelope_y_steps  = 67890 (0x10932)
]);

// -----------------------------------------------------------------------------
// Minimal fake socket + clock (the wire client only needs to be driven open and
// fed one inbound HELLO frame for this decode cross-check).
// -----------------------------------------------------------------------------

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
        /* not exercised here */
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

const noopTimers: TimerApi = {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
};

describe('HELLO envelope cross-check (firmware ↔ web golden bytes)', () => {
    it('decodes the shared golden HELLO bytes to envelope {12345, 67890}', async () => {
        const sockets: FakeSocket[] = [];
        const client = new WireClient({
            socketFactory: () => {
                const s = new FakeSocket();
                sockets.push(s);
                return s;
            },
            timers: noopTimers,
        });

        const connectP = client.connect('ws://device.local/ws');
        sockets[0].fireOpen();
        await connectP;

        const homeEvents: HomeEvent[] = [];
        client.on('home', (e) => homeEvents.push(e));

        // Feed the SAME golden 40 bytes the firmware serialiser produces.
        sockets[0].fireMessage(encodeFrame(FrameType.HELLO, GOLDEN_HELLO));

        expect(homeEvents).toHaveLength(1);
        const home = homeEvents[0];
        expect(home.envelope).toEqual({ x: 12345, y: 67890 });
        expect(home.envelopeCalibrated).toBe(true);
        expect(home.calibrated).toBe(true);
        expect(home.firmwareVersion).toBe(0x00010002);

        // The send-gate flag follows the decoded envelope-calibrated bit.
        expect(client.isEnvelopeCalibrated()).toBe(true);
    });
});
