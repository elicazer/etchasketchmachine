/**
 * Control message (CTL) encoder for the browser → controller channel.
 *
 * A CTL frame payload is a `u8 ctl_kind` discriminator followed by a
 * per-kind, little-endian field block (Design §4.6):
 *
 * ```
 * Offset  Size  Field        Type
 * ------  ----  ----------  -----
 *   0      1   ctl_kind     u8
 *   1     var  ctl_payload  bytes
 *
 * ctl_kind values and payloads:
 *   0x01 PAUSE         (no payload)
 *   0x02 RESUME        (no payload)
 *   0x03 CANCEL        (no payload)
 *   0x04 STOP          (no payload)
 *   0x05 JOG           { u8 axis, i8 dir, u16 steps }
 *   0x06 SET_HOME      (no payload)
 *   0x07 RE_HOME       (no payload)
 *   0x08 BEGIN_DRAW    { u32 total_segments, u32 total_steps }
 *   0x09 END_DRAW      (no payload)
 *   0x0A SPEED_PCT     { u8 pct }        // 25..100  (Req 9.7)
 *   0x0B SET_BACKLASH  { u16 x, u16 y }  // 0..200   (Req 13.8)
 *   0x0C MOTOR_TEST    (no payload)
 *   0x0D FAULT_RESET   (no payload)
 *   0x0E CAPTURE_BOTTOM_LEFT (no payload)  // Controller measures its own steps
 *   0x0F CAPTURE_TOP_RIGHT   (no payload)  // Controller measures its own steps
 * ```
 *
 * NOTE ON LAYOUT AUTHORITY
 * ------------------------
 * The task brief that scheduled this codec mentioned an alternate layout
 * (kinds `PAUSE=0..FAULT_RESET=12` and `SET_BACKLASH {u8 axis, u16 steps}`).
 * That conflicts with Design §4.6, which is the canonical, published wire
 * protocol and is already referenced by `firmware/src/protocol/frame.h`. The
 * firmware CTL parser (firmware task 4.4) will be built to §4.6, so this codec
 * follows §4.6 verbatim to keep the two ends byte-compatible for the
 * end-to-end integration (task 31.1). The discriminator is therefore
 * 1-indexed (`PAUSE = 0x01`) and `SET_BACKLASH` carries both per-axis values
 * `{ u16 x, u16 y }`.
 *
 * @see Design §4.6
 * @see Requirements 9.1–9.8, 10.3–10.5, 10.13, 12.4, 12.6, 13.8
 */

import {
    BACKLASH_STEPS_MAX,
    BACKLASH_STEPS_MIN,
    SPEED_PCT_MAX,
    SPEED_PCT_MIN,
} from '../constants';

/** Numeric CTL discriminator codes (Design §4.6). Wire-stable. */
export const CtlKind = Object.freeze({
    PAUSE: 0x01,
    RESUME: 0x02,
    CANCEL: 0x03,
    STOP: 0x04,
    JOG: 0x05,
    SET_HOME: 0x06,
    RE_HOME: 0x07,
    BEGIN_DRAW: 0x08,
    END_DRAW: 0x09,
    SPEED_PCT: 0x0a,
    SET_BACKLASH: 0x0b,
    MOTOR_TEST: 0x0c,
    FAULT_RESET: 0x0d,
    CAPTURE_BOTTOM_LEFT: 0x0e,
    CAPTURE_TOP_RIGHT: 0x0f,
} as const);

/** Union of the numeric CTL discriminator codes. */
export type CtlKind = (typeof CtlKind)[keyof typeof CtlKind];

/** Axis identifier on the wire: 0 = X, 1 = Y. */
export type Axis = 0 | 1;

/** Jog direction on the wire: +1 forward, -1 reverse (encoded as i8). */
export type JogDir = 1 | -1;

/**
 * Browser-side control message, mirroring the firmware CTL kinds. This is a
 * discriminated union on the string `kind`; {@link encodeControl} maps it to
 * the numeric {@link CtlKind} and the §4.6 field block.
 */
export type ControlMessage =
    | { kind: 'pause' }
    | { kind: 'resume' }
    | { kind: 'cancel' }
    | { kind: 'stop' }
    | { kind: 'jog'; axis: Axis; dir: JogDir; steps: number }
    | { kind: 'setHome' }
    | { kind: 'reHome' }
    | { kind: 'beginDraw'; totalSegments: number; totalSteps: number }
    | { kind: 'endDraw' }
    | { kind: 'speedPct'; pct: number }
    | { kind: 'setBacklash'; x: number; y: number }
    | { kind: 'motorTest' }
    | { kind: 'faultReset' }
    | { kind: 'captureBottomLeft' }
    | { kind: 'captureTopRight' };

/** Discriminated reasons {@link encodeControl} rejects its input. */
export type ControlErrorKind = 'range' | 'kind';

/** Typed error thrown by {@link encodeControl} for any validation failure. */
export class ControlError extends Error {
    public readonly kind: ControlErrorKind;

    constructor(kind: ControlErrorKind, message: string) {
        super(message);
        this.name = 'ControlError';
        this.kind = kind;
    }
}

const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;

function assertU16(v: number, field: string): void {
    if (!Number.isInteger(v) || v < 0 || v > U16_MAX) {
        throw new ControlError('range', `${field} ${v} is not a valid u16`);
    }
}

function assertU32(v: number, field: string): void {
    if (!Number.isInteger(v) || v < 0 || v > U32_MAX) {
        throw new ControlError('range', `${field} ${v} is not a valid u32`);
    }
}

/**
 * Serialise a {@link ControlMessage} to its CTL payload bytes (the
 * `ctl_kind` discriminator plus the per-kind little-endian block). The
 * result is the *payload* only; the caller wraps it in a CTL frame via
 * `encodeFrame(FrameType.CTL, payload)`.
 *
 * Throws {@link ControlError} on out-of-range fields (`'range'`) or an
 * unrecognised message (`'kind'`).
 */
export function encodeControl(ctl: ControlMessage): Uint8Array {
    switch (ctl.kind) {
        case 'pause':
            return Uint8Array.of(CtlKind.PAUSE);
        case 'resume':
            return Uint8Array.of(CtlKind.RESUME);
        case 'cancel':
            return Uint8Array.of(CtlKind.CANCEL);
        case 'stop':
            return Uint8Array.of(CtlKind.STOP);
        case 'setHome':
            return Uint8Array.of(CtlKind.SET_HOME);
        case 'reHome':
            return Uint8Array.of(CtlKind.RE_HOME);
        case 'endDraw':
            return Uint8Array.of(CtlKind.END_DRAW);
        case 'motorTest':
            return Uint8Array.of(CtlKind.MOTOR_TEST);
        case 'faultReset':
            return Uint8Array.of(CtlKind.FAULT_RESET);
        case 'captureBottomLeft':
            return Uint8Array.of(CtlKind.CAPTURE_BOTTOM_LEFT);
        case 'captureTopRight':
            return Uint8Array.of(CtlKind.CAPTURE_TOP_RIGHT);

        case 'jog': {
            if (ctl.axis !== 0 && ctl.axis !== 1) {
                throw new ControlError(
                    'range',
                    `jog axis ${ctl.axis} must be 0 (X) or 1 (Y)`,
                );
            }
            if (ctl.dir !== 1 && ctl.dir !== -1) {
                throw new ControlError(
                    'range',
                    `jog dir ${ctl.dir} must be +1 or -1`,
                );
            }
            assertU16(ctl.steps, 'jog steps');
            // { u8 kind, u8 axis, i8 dir, u16 steps } => 5 bytes
            const buf = new Uint8Array(5);
            const view = new DataView(buf.buffer);
            view.setUint8(0, CtlKind.JOG);
            view.setUint8(1, ctl.axis);
            view.setInt8(2, ctl.dir);
            view.setUint16(3, ctl.steps, true);
            return buf;
        }

        case 'beginDraw': {
            assertU32(ctl.totalSegments, 'beginDraw totalSegments');
            assertU32(ctl.totalSteps, 'beginDraw totalSteps');
            // { u8 kind, u32 total_segments, u32 total_steps } => 9 bytes
            const buf = new Uint8Array(9);
            const view = new DataView(buf.buffer);
            view.setUint8(0, CtlKind.BEGIN_DRAW);
            view.setUint32(1, ctl.totalSegments, true);
            view.setUint32(5, ctl.totalSteps, true);
            return buf;
        }

        case 'speedPct': {
            if (
                !Number.isInteger(ctl.pct) ||
                ctl.pct < SPEED_PCT_MIN ||
                ctl.pct > SPEED_PCT_MAX
            ) {
                throw new ControlError(
                    'range',
                    `speedPct ${ctl.pct} out of range [${SPEED_PCT_MIN}, ${SPEED_PCT_MAX}]`,
                );
            }
            // { u8 kind, u8 pct } => 2 bytes
            return Uint8Array.of(CtlKind.SPEED_PCT, ctl.pct);
        }

        case 'setBacklash': {
            for (const [label, v] of [
                ['setBacklash x', ctl.x],
                ['setBacklash y', ctl.y],
            ] as const) {
                if (
                    !Number.isInteger(v) ||
                    v < BACKLASH_STEPS_MIN ||
                    v > BACKLASH_STEPS_MAX
                ) {
                    throw new ControlError(
                        'range',
                        `${label} ${v} out of range [${BACKLASH_STEPS_MIN}, ${BACKLASH_STEPS_MAX}]`,
                    );
                }
            }
            // { u8 kind, u16 x, u16 y } => 5 bytes
            const buf = new Uint8Array(5);
            const view = new DataView(buf.buffer);
            view.setUint8(0, CtlKind.SET_BACKLASH);
            view.setUint16(1, ctl.x, true);
            view.setUint16(3, ctl.y, true);
            return buf;
        }

        default: {
            // Exhaustiveness guard: if a new ControlMessage variant is added
            // without a case here, TypeScript flags this as a type error.
            const _exhaustive: never = ctl;
            throw new ControlError(
                'kind',
                `unknown control message: ${JSON.stringify(_exhaustive)}`,
            );
        }
    }
}
