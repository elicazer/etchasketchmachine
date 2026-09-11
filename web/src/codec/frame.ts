/**
 * WebSocket binary frame envelope encoder/decoder.
 *
 * Every message between the browser SPA and the controller is a binary
 * WebSocket frame consisting of a fixed 4-byte envelope header followed by
 * a typed payload (Design §4.5):
 *
 * ```
 * Offset  Size  Field     Type   Notes
 * ------  ----  --------  -----  -------------------------------------
 *   0      1   version   u8     current = 0x01
 *   1      1   type      u8     see FrameType
 *   2      2   length    u16    little-endian, payload length in bytes
 *   4    var   payload   bytes  per-type layout
 * ```
 *
 * This module owns only the envelope and the fixed-size control-frame
 * payloads (ACK / NACK / RETX_REQUEST / CREDIT / STATE / ERROR). The
 * variable-length payloads (CMD, CTL, STATUS, HELLO, PROGRESS) are carried
 * through the envelope as opaque `Uint8Array`s; their structured codecs live
 * elsewhere (Drawing_Command in `drawing_command.ts`, the rest land with the
 * WireClient in task 10.4).
 *
 * The inner CRC of a CMD payload is deliberately independent of this
 * envelope: it covers only the 16-byte command body so it survives any
 * framing change (Design §4.5, Req 7.8).
 *
 * @see Requirements 7.1
 * @see Design §4.5
 */

/** Current envelope version byte. Decoders reject any other value. */
export const FRAME_VERSION = 0x01;

/** Byte length of the fixed envelope header preceding every payload. */
export const FRAME_HEADER_BYTES = 4;

/** Maximum payload byte length encodable in the u16 `length` field. */
export const FRAME_MAX_PAYLOAD = 0xffff;

/**
 * Frame type codes (Design §4.5).
 *
 * Modelled as a frozen const object plus a derived union type rather than a
 * TypeScript `enum` so the values tree-shake cleanly and survive
 * `isolatedModules` without runtime enum scaffolding.
 */
export const FrameType = Object.freeze({
    CMD: 0x01,
    CTL: 0x02,
    ACK: 0x10,
    NACK: 0x11,
    RETX_REQUEST: 0x12,
    STATUS: 0x20,
    CREDIT: 0x21,
    HELLO: 0x22,
    STATE: 0x30,
    ERROR: 0x31,
    PROGRESS: 0x32,
} as const);

/** Union of the numeric frame-type codes. */
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** Set of all valid type codes, used by {@link isKnownFrameType}. */
const KNOWN_FRAME_TYPES: ReadonlySet<number> = new Set(
    Object.values(FrameType),
);

/**
 * Discriminated reasons the frame codec rejects its input.
 *   - `length`    payload exceeds u16, or buffer too short for the header,
 *                 or a fixed-size payload has the wrong byte length
 *   - `version`   envelope version byte is not {@link FRAME_VERSION}
 *   - `type`      type byte is not a known {@link FrameType}
 *   - `truncated` declared payload length does not match available bytes
 */
export type FrameErrorKind = 'length' | 'version' | 'type' | 'truncated';

/** Typed error thrown by every encode/decode entry point in this module. */
export class FrameError extends Error {
    public readonly kind: FrameErrorKind;

    constructor(kind: FrameErrorKind, message: string) {
        super(message);
        this.name = 'FrameError';
        this.kind = kind;
    }
}

/** Narrowing guard: true when `t` is a defined frame type code. */
export function isKnownFrameType(t: number): t is FrameType {
    return KNOWN_FRAME_TYPES.has(t);
}

// -----------------------------------------------------------------------------
// Envelope
// -----------------------------------------------------------------------------

/**
 * Prepend the 4-byte envelope header to `payload` and return a freshly
 * allocated frame buffer.
 *
 * Throws `FrameError('length')` when the payload exceeds the u16 length
 * field (> 0xffff bytes).
 */
export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
    if (payload.length > FRAME_MAX_PAYLOAD) {
        throw new FrameError(
            'length',
            `payload length ${payload.length} exceeds max ${FRAME_MAX_PAYLOAD}`,
        );
    }

    const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
    const view = new DataView(frame.buffer);
    view.setUint8(0, FRAME_VERSION);
    view.setUint8(1, type);
    view.setUint16(2, payload.length, true);
    frame.set(payload, FRAME_HEADER_BYTES);
    return frame;
}

/**
 * Parse a binary frame's envelope.
 *
 * Validates, in order: buffer large enough for the header, envelope version,
 * known type code, and that the declared payload length matches the bytes
 * actually present. The returned `payload` is a zero-copy subarray view over
 * the input.
 *
 * Throws `FrameError` with the corresponding `kind` on any violation.
 */
export function decodeFrame(bytes: Uint8Array): {
    type: FrameType;
    payload: Uint8Array;
} {
    if (bytes.length < FRAME_HEADER_BYTES) {
        throw new FrameError(
            'length',
            `frame too short: got ${bytes.length} bytes, need at least ${FRAME_HEADER_BYTES}`,
        );
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(0);
    if (version !== FRAME_VERSION) {
        throw new FrameError(
            'version',
            `unsupported frame version 0x${version.toString(16)}, expected 0x${FRAME_VERSION.toString(16)}`,
        );
    }

    const type = view.getUint8(1);
    if (!isKnownFrameType(type)) {
        throw new FrameError(
            'type',
            `unknown frame type 0x${type.toString(16)}`,
        );
    }

    const declaredLength = view.getUint16(2, true);
    const availableLength = bytes.length - FRAME_HEADER_BYTES;
    if (declaredLength !== availableLength) {
        throw new FrameError(
            'truncated',
            `declared payload length ${declaredLength} != available ${availableLength}`,
        );
    }

    const payload = bytes.subarray(
        FRAME_HEADER_BYTES,
        FRAME_HEADER_BYTES + declaredLength,
    );
    return { type, payload };
}

// -----------------------------------------------------------------------------
// Fixed-size control-frame payloads (Design §4.5)
//
// These mirror the per-type payload layouts so callers branch on the decoded
// struct instead of hand-rolling DataView offsets. All multi-byte fields are
// little-endian. Decoders reject payloads whose length differs from the
// documented fixed size with FrameError('length').
// -----------------------------------------------------------------------------

/** Byte length of an ACK payload. */
export const ACK_PAYLOAD_BYTES = 4;
/** Byte length of a NACK payload. */
export const NACK_PAYLOAD_BYTES = 5;
/** Byte length of a RETX_REQUEST payload. */
export const RETX_REQUEST_PAYLOAD_BYTES = 4;
/** Byte length of a CREDIT payload. */
export const CREDIT_PAYLOAD_BYTES = 1;
/** Byte length of a STATE payload. */
export const STATE_PAYLOAD_BYTES = 1;
/** Byte length of an ERROR payload. */
export const ERROR_PAYLOAD_BYTES = 4;

/** ACK payload: acknowledges receipt of a command sequence number. */
export interface AckPayload {
    seq: number;
}

/** NACK payload: rejects a command with a reason code (see §4.5). */
export interface NackPayload {
    seq: number;
    reason: number;
}

/** RETX_REQUEST payload: requests retransmission of a sequence number. */
export interface RetxRequestPayload {
    seq: number;
}

/** CREDIT payload: grants `n` additional command buffer slots. */
export interface CreditPayload {
    n: number;
}

/** STATE payload: a single controller state code (see §4.7). */
export interface StatePayload {
    stateCode: number;
}

/** ERROR payload: structured fault report (kinds/axes per §4.5). */
export interface ErrorPayload {
    kind: number;
    axis: number;
    detail: number;
}

function expectPayloadLength(
    bytes: Uint8Array,
    expected: number,
    label: string,
): void {
    if (bytes.length !== expected) {
        throw new FrameError(
            'length',
            `${label} payload expected ${expected} bytes, got ${bytes.length}`,
        );
    }
}

/** Encode an ACK payload (`{ u32 seq }`, 4 bytes, little-endian). */
export function encodeAckPayload(p: AckPayload): Uint8Array {
    const buf = new Uint8Array(ACK_PAYLOAD_BYTES);
    new DataView(buf.buffer).setUint32(0, p.seq, true);
    return buf;
}

/** Decode an ACK payload. Throws `FrameError('length')` on wrong size. */
export function decodeAckPayload(bytes: Uint8Array): AckPayload {
    expectPayloadLength(bytes, ACK_PAYLOAD_BYTES, 'ACK');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { seq: view.getUint32(0, true) };
}

/** Encode a NACK payload (`{ u32 seq, u8 reason }`, 5 bytes). */
export function encodeNackPayload(p: NackPayload): Uint8Array {
    const buf = new Uint8Array(NACK_PAYLOAD_BYTES);
    const view = new DataView(buf.buffer);
    view.setUint32(0, p.seq, true);
    view.setUint8(4, p.reason);
    return buf;
}

/** Decode a NACK payload. Throws `FrameError('length')` on wrong size. */
export function decodeNackPayload(bytes: Uint8Array): NackPayload {
    expectPayloadLength(bytes, NACK_PAYLOAD_BYTES, 'NACK');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { seq: view.getUint32(0, true), reason: view.getUint8(4) };
}

/** Encode a RETX_REQUEST payload (`{ u32 seq }`, 4 bytes). */
export function encodeRetxRequestPayload(p: RetxRequestPayload): Uint8Array {
    const buf = new Uint8Array(RETX_REQUEST_PAYLOAD_BYTES);
    new DataView(buf.buffer).setUint32(0, p.seq, true);
    return buf;
}

/** Decode a RETX_REQUEST payload. Throws `FrameError('length')` on wrong size. */
export function decodeRetxRequestPayload(bytes: Uint8Array): RetxRequestPayload {
    expectPayloadLength(bytes, RETX_REQUEST_PAYLOAD_BYTES, 'RETX_REQUEST');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { seq: view.getUint32(0, true) };
}

/** Encode a CREDIT payload (`{ u8 n }`, 1 byte). */
export function encodeCreditPayload(p: CreditPayload): Uint8Array {
    const buf = new Uint8Array(CREDIT_PAYLOAD_BYTES);
    new DataView(buf.buffer).setUint8(0, p.n);
    return buf;
}

/** Decode a CREDIT payload. Throws `FrameError('length')` on wrong size. */
export function decodeCreditPayload(bytes: Uint8Array): CreditPayload {
    expectPayloadLength(bytes, CREDIT_PAYLOAD_BYTES, 'CREDIT');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { n: view.getUint8(0) };
}

/** Encode a STATE payload (`{ u8 state_code }`, 1 byte). */
export function encodeStatePayload(p: StatePayload): Uint8Array {
    const buf = new Uint8Array(STATE_PAYLOAD_BYTES);
    new DataView(buf.buffer).setUint8(0, p.stateCode);
    return buf;
}

/** Decode a STATE payload. Throws `FrameError('length')` on wrong size. */
export function decodeStatePayload(bytes: Uint8Array): StatePayload {
    expectPayloadLength(bytes, STATE_PAYLOAD_BYTES, 'STATE');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { stateCode: view.getUint8(0) };
}

/** Encode an ERROR payload (`{ u8 kind, u8 axis, u16 detail }`, 4 bytes). */
export function encodeErrorPayload(p: ErrorPayload): Uint8Array {
    const buf = new Uint8Array(ERROR_PAYLOAD_BYTES);
    const view = new DataView(buf.buffer);
    view.setUint8(0, p.kind);
    view.setUint8(1, p.axis);
    view.setUint16(2, p.detail, true);
    return buf;
}

/** Decode an ERROR payload. Throws `FrameError('length')` on wrong size. */
export function decodeErrorPayload(bytes: Uint8Array): ErrorPayload {
    expectPayloadLength(bytes, ERROR_PAYLOAD_BYTES, 'ERROR');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        kind: view.getUint8(0),
        axis: view.getUint8(1),
        detail: view.getUint16(2, true),
    };
}
