import { describe, it, expect } from 'vitest';
import {
    FRAME_HEADER_BYTES,
    FRAME_VERSION,
    FrameError,
    FrameType,
    decodeAckPayload,
    decodeCreditPayload,
    decodeErrorPayload,
    decodeFrame,
    decodeNackPayload,
    decodeRetxRequestPayload,
    decodeStatePayload,
    encodeAckPayload,
    encodeCreditPayload,
    encodeErrorPayload,
    encodeFrame,
    encodeNackPayload,
    encodeRetxRequestPayload,
    encodeStatePayload,
    isKnownFrameType,
} from './frame';

/**
 * Unit tests for the WebSocket frame envelope codec (Design §4.5).
 *
 * Covers envelope round-trips for every frame type, the four documented
 * decode-rejection paths, the type guard, and the fixed-size control payload
 * codecs at their boundary values.
 */

const ALL_FRAME_TYPES = Object.values(FrameType) as FrameType[];

const U8_MAX = 0xff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;

describe('encodeFrame / decodeFrame envelope', () => {
    it('round-trips every frame type with a representative payload', () => {
        ALL_FRAME_TYPES.forEach((type, i) => {
            // A distinct, type-dependent payload so a mis-routed type or
            // length would surface as a mismatch.
            const payload = new Uint8Array(i + 1).map((_, j) => (i * 7 + j) & 0xff);
            const frame = encodeFrame(type, payload);

            // Header: version, type, little-endian length.
            expect(frame[0]).toBe(FRAME_VERSION);
            expect(frame[1]).toBe(type);
            expect(frame[2]).toBe(payload.length & 0xff);
            expect(frame[3]).toBe((payload.length >> 8) & 0xff);

            const decoded = decodeFrame(frame);
            expect(decoded.type).toBe(type);
            expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
        });
    });

    it('round-trips an empty payload', () => {
        const frame = encodeFrame(FrameType.STATE, new Uint8Array(0));
        expect(frame.length).toBe(FRAME_HEADER_BYTES);
        const decoded = decodeFrame(frame);
        expect(decoded.type).toBe(FrameType.STATE);
        expect(decoded.payload.length).toBe(0);
    });

    it('treats STATUS / HELLO / PROGRESS payloads as opaque round-trip bytes', () => {
        for (const type of [
            FrameType.STATUS,
            FrameType.HELLO,
            FrameType.PROGRESS,
        ]) {
            const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
            const decoded = decodeFrame(encodeFrame(type, payload));
            expect(decoded.type).toBe(type);
            expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
        }
    });

    it('returns a zero-copy subarray view over the input', () => {
        const payload = new Uint8Array([10, 20, 30, 40]);
        const frame = encodeFrame(FrameType.CMD, payload);
        const decoded = decodeFrame(frame);
        // Mutating the decoded view must mutate the original frame buffer.
        decoded.payload[0] = 99;
        expect(frame[FRAME_HEADER_BYTES]).toBe(99);
    });

    it('throws FrameError(length) when payload exceeds u16', () => {
        const tooBig = new Uint8Array(0x1_0000); // 65536 > 0xffff
        try {
            encodeFrame(FrameType.CMD, tooBig);
            throw new Error('expected encodeFrame to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(FrameError);
            expect((err as FrameError).kind).toBe('length');
        }
    });

    it('rejects a frame shorter than the header (length)', () => {
        for (const len of [0, 1, 2, 3]) {
            try {
                decodeFrame(new Uint8Array(len));
                throw new Error(`expected throw for length ${len}`);
            } catch (err) {
                expect(err).toBeInstanceOf(FrameError);
                expect((err as FrameError).kind).toBe('length');
            }
        }
    });

    it('rejects a frame with version != 1', () => {
        const frame = encodeFrame(FrameType.ACK, new Uint8Array([1, 2, 3, 4]));
        frame[0] = 0x02;
        try {
            decodeFrame(frame);
            throw new Error('expected throw for bad version');
        } catch (err) {
            expect(err).toBeInstanceOf(FrameError);
            expect((err as FrameError).kind).toBe('version');
        }
    });

    it('rejects a frame with an unknown type code', () => {
        const frame = encodeFrame(FrameType.ACK, new Uint8Array([1, 2, 3, 4]));
        frame[1] = 0x99; // not a known type
        try {
            decodeFrame(frame);
            throw new Error('expected throw for unknown type');
        } catch (err) {
            expect(err).toBeInstanceOf(FrameError);
            expect((err as FrameError).kind).toBe('type');
        }
    });

    it('rejects a frame whose declared length mismatches available bytes (truncated)', () => {
        const frame = encodeFrame(
            FrameType.PROGRESS,
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        );
        // Declared length says 8 but we drop the final byte.
        const truncated = frame.subarray(0, frame.length - 1);
        try {
            decodeFrame(truncated);
            throw new Error('expected throw for truncated payload');
        } catch (err) {
            expect(err).toBeInstanceOf(FrameError);
            expect((err as FrameError).kind).toBe('truncated');
        }

        // Also reject the over-long case: declared length less than available.
        const overlong = new Uint8Array(frame.length + 1);
        overlong.set(frame);
        try {
            decodeFrame(overlong);
            throw new Error('expected throw for overlong payload');
        } catch (err) {
            expect(err).toBeInstanceOf(FrameError);
            expect((err as FrameError).kind).toBe('truncated');
        }
    });
});

describe('isKnownFrameType', () => {
    it('is true for every defined type code', () => {
        for (const type of ALL_FRAME_TYPES) {
            expect(isKnownFrameType(type)).toBe(true);
        }
    });

    it('is false for undefined codes', () => {
        for (const bad of [0x00, 0x03, 0x13, 0x99, 0xff, -1, 256]) {
            expect(isKnownFrameType(bad)).toBe(false);
        }
    });
});

describe('fixed-size control payload codecs', () => {
    it('ACK round-trips with u32 boundary values', () => {
        for (const seq of [0, 1, 0x1234_5678, U32_MAX]) {
            expect(decodeAckPayload(encodeAckPayload({ seq }))).toEqual({ seq });
        }
    });

    it('NACK round-trips with u32 seq and u8 reason boundaries', () => {
        for (const seq of [0, U32_MAX]) {
            for (const reason of [0, 0x05, U8_MAX]) {
                expect(
                    decodeNackPayload(encodeNackPayload({ seq, reason })),
                ).toEqual({ seq, reason });
            }
        }
    });

    it('RETX_REQUEST round-trips with u32 boundary values', () => {
        for (const seq of [0, 42, U32_MAX]) {
            expect(
                decodeRetxRequestPayload(encodeRetxRequestPayload({ seq })),
            ).toEqual({ seq });
        }
    });

    it('CREDIT round-trips with u8 boundary values', () => {
        for (const n of [0, 1, 32, U8_MAX]) {
            expect(decodeCreditPayload(encodeCreditPayload({ n }))).toEqual({
                n,
            });
        }
    });

    it('STATE round-trips with u8 boundary values', () => {
        for (const stateCode of [0, 5, U8_MAX]) {
            expect(
                decodeStatePayload(encodeStatePayload({ stateCode })),
            ).toEqual({ stateCode });
        }
    });

    it('ERROR round-trips with u8/u8/u16 boundary values', () => {
        for (const kind of [0, U8_MAX]) {
            for (const axis of [0, 1, U8_MAX]) {
                for (const detail of [0, 0x1234, U16_MAX]) {
                    expect(
                        decodeErrorPayload(
                            encodeErrorPayload({ kind, axis, detail }),
                        ),
                    ).toEqual({ kind, axis, detail });
                }
            }
        }
    });

    it('payload decoders reject wrong-sized buffers', () => {
        const cases: Array<[(b: Uint8Array) => unknown, number]> = [
            [decodeAckPayload, 4],
            [decodeNackPayload, 5],
            [decodeRetxRequestPayload, 4],
            [decodeCreditPayload, 1],
            [decodeStatePayload, 1],
            [decodeErrorPayload, 4],
        ];
        for (const [decode, expected] of cases) {
            for (const len of [expected - 1, expected + 1]) {
                if (len < 0) continue;
                try {
                    decode(new Uint8Array(len));
                    throw new Error(`expected throw for length ${len}`);
                } catch (err) {
                    expect(err).toBeInstanceOf(FrameError);
                    expect((err as FrameError).kind).toBe('length');
                }
            }
        }
    });
});

describe('exact byte layout', () => {
    it('produces the documented ACK frame layout', () => {
        // ACK seq = 0x01020304 -> little-endian 04 03 02 01.
        const payload = encodeAckPayload({ seq: 0x01020304 });
        const frame = encodeFrame(FrameType.ACK, payload);

        expect(Array.from(frame)).toEqual([
            FRAME_VERSION, // 0x01 version
            FrameType.ACK, // 0x10 type
            0x04, // length low byte (4)
            0x00, // length high byte
            0x04, // seq byte 0 (LE)
            0x03, // seq byte 1
            0x02, // seq byte 2
            0x01, // seq byte 3
        ]);

        const decoded = decodeFrame(frame);
        expect(decoded.type).toBe(FrameType.ACK);
        expect(decodeAckPayload(decoded.payload)).toEqual({ seq: 0x01020304 });
    });
});
