/**
 * Drawing_Command binary encoder/decoder.
 *
 * The wire format is a fixed 16-byte little-endian payload (Design §4.3):
 *
 * ```
 * Offset  Size  Field         Type
 * ------  ----  ------------  -----
 *   0      4   seq           u32
 *   4      2   dx_steps      i16
 *   6      2   dy_steps      i16
 *   8      2   feed_sps      u16
 *  10      2   flags         u16
 *  12      2   reserved      u16    (always zero)
 *  14      2   crc16_payload u16    CRC-16/CCITT over bytes [0..14)
 * ```
 *
 * Range validation matches what the firmware command parser enforces
 * (Req 6.7): feedSps ∈ [100, 1000], dx/dy ∈ [-32768, 32767], and
 * flags are restricted to the documented bits.
 *
 * @see Design §4.3
 * @see Requirements 6.7, 7.2, 7.8
 */

import {
    DRAWING_COMMAND_BYTES,
    DRAWING_COMMAND_DELTA_MAX,
    DRAWING_COMMAND_DELTA_MIN,
    DRAWING_COMMAND_FLAGS,
    DRAWING_COMMAND_FLAGS_MASK,
    FEED_SPS_MAX,
    FEED_SPS_MIN,
} from '../constants';
import { DrawingCommand } from '../types';
import { crc16ccitt } from './crc16';

const U32_MAX = 0xffff_ffff;

/**
 * Discriminated reasons a Drawing_Command codec call rejects its input.
 * Kept as a small enum-like union so callers can branch on `err.kind`
 * without parsing message strings.
 */
export type DrawingCommandErrorKind =
    | 'length'
    | 'crc'
    | 'range'
    | 'flags'
    | 'reserved';

/**
 * Typed error thrown by `encodeCommand`, `decodeCommand`, and
 * `splitMotion` for any validation failure.
 */
export class DrawingCommandError extends Error {
    public readonly kind: DrawingCommandErrorKind;

    constructor(kind: DrawingCommandErrorKind, message: string) {
        super(message);
        this.name = 'DrawingCommandError';
        this.kind = kind;
    }
}

// -----------------------------------------------------------------------------
// Internal validation helpers
// -----------------------------------------------------------------------------

function isI16(v: number): boolean {
    return (
        Number.isInteger(v) &&
        v >= DRAWING_COMMAND_DELTA_MIN &&
        v <= DRAWING_COMMAND_DELTA_MAX
    );
}

function isU16(v: number): boolean {
    return Number.isInteger(v) && v >= 0 && v <= 0xffff;
}

function isU32(v: number): boolean {
    return Number.isInteger(v) && v >= 0 && v <= U32_MAX;
}

function validateFeedSps(feedSps: number): void {
    if (
        !Number.isInteger(feedSps) ||
        feedSps < FEED_SPS_MIN ||
        feedSps > FEED_SPS_MAX
    ) {
        throw new DrawingCommandError(
            'range',
            `feedSps ${feedSps} out of range [${FEED_SPS_MIN}, ${FEED_SPS_MAX}]`,
        );
    }
}

function validateFlags(flags: number): void {
    if (!isU16(flags)) {
        throw new DrawingCommandError(
            'flags',
            `flags ${flags} is not a valid u16`,
        );
    }
    if ((flags & ~DRAWING_COMMAND_FLAGS_MASK) !== 0) {
        throw new DrawingCommandError(
            'flags',
            `flags 0x${flags.toString(16)} sets reserved bits outside mask 0x${DRAWING_COMMAND_FLAGS_MASK.toString(16)}`,
        );
    }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Serialise a Drawing_Command to its 16-byte little-endian wire form.
 *
 * Computes CRC-16/CCITT over bytes [0..14) and writes it at offset 14.
 * The reserved u16 at offset 12 is always written as zero.
 *
 * Throws `DrawingCommandError` on out-of-range fields. The caller must
 * have already split any motion whose dx/dy exceeds the i16 range
 * (see `splitMotion`).
 */
export function encodeCommand(cmd: DrawingCommand): Uint8Array {
    if (!isU32(cmd.seq)) {
        throw new DrawingCommandError(
            'range',
            `seq ${cmd.seq} is not a valid u32`,
        );
    }
    if (!isI16(cmd.dxSteps)) {
        throw new DrawingCommandError(
            'range',
            `dxSteps ${cmd.dxSteps} out of i16 range [${DRAWING_COMMAND_DELTA_MIN}, ${DRAWING_COMMAND_DELTA_MAX}]`,
        );
    }
    if (!isI16(cmd.dySteps)) {
        throw new DrawingCommandError(
            'range',
            `dySteps ${cmd.dySteps} out of i16 range [${DRAWING_COMMAND_DELTA_MIN}, ${DRAWING_COMMAND_DELTA_MAX}]`,
        );
    }
    validateFeedSps(cmd.feedSps);
    validateFlags(cmd.flags);

    const buf = new Uint8Array(DRAWING_COMMAND_BYTES);
    const view = new DataView(buf.buffer);
    view.setUint32(0, cmd.seq, true);
    view.setInt16(4, cmd.dxSteps, true);
    view.setInt16(6, cmd.dySteps, true);
    view.setUint16(8, cmd.feedSps, true);
    view.setUint16(10, cmd.flags, true);
    view.setUint16(12, 0, true); // reserved, always zero
    const crc = crc16ccitt(buf.subarray(0, 14));
    view.setUint16(14, crc, true);
    return buf;
}

/**
 * Parse a 16-byte Drawing_Command wire payload.
 *
 * Validates payload length and recomputes CRC-16/CCITT over bytes
 * [0..14), comparing against the transmitted CRC at offset 14.
 *
 * Throws `DrawingCommandError` (kind `'length'` or `'crc'`) on
 * mismatch. The returned command's `crc16` field is set to the
 * validated CRC value.
 *
 * Range and flag checks are intentionally NOT performed here; they
 * belong to the firmware command parser (Req 6.7) and to the producer
 * via `encodeCommand`. Decode is strictly a wire-format check so the
 * round-trip property (Req 7.8) is total.
 */
export function decodeCommand(bytes: Uint8Array): DrawingCommand {
    if (bytes.length !== DRAWING_COMMAND_BYTES) {
        throw new DrawingCommandError(
            'length',
            `expected ${DRAWING_COMMAND_BYTES} bytes, got ${bytes.length}`,
        );
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seq = view.getUint32(0, true);
    const dxSteps = view.getInt16(4, true);
    const dySteps = view.getInt16(6, true);
    const feedSps = view.getUint16(8, true);
    const flags = view.getUint16(10, true);
    const crc16 = view.getUint16(14, true);

    const expectedCrc = crc16ccitt(bytes.subarray(0, 14));
    if (crc16 !== expectedCrc) {
        throw new DrawingCommandError(
            'crc',
            `CRC mismatch: payload says 0x${crc16
                .toString(16)
                .padStart(4, '0')}, computed 0x${expectedCrc
                    .toString(16)
                    .padStart(4, '0')}`,
        );
    }

    return { seq, dxSteps, dySteps, feedSps, flags, crc16 };
}

/**
 * Split a logical motion whose dx/dy may exceed the wire's i16 limit
 * into a sequence of consecutive Drawing_Commands whose concatenated
 * deltas reproduce the original (dx, dy) exactly.
 *
 * Each emitted command:
 *   - has |dxSteps|, |dySteps| ≤ 32767, comfortably within i16
 *   - shares the same feedSps as the input
 *   - is collinear with the original motion (proportional shares
 *     computed via cumulative-rounding so total error is zero)
 *   - gets its own monotonically increasing `seq` starting at `seqStart`
 *
 * The `LAST_OF_BATCH` flag (bit 1) is preserved only on the *final*
 * emitted command; intermediate commands clear it. Other documented
 * flags (currently just `CONNECTOR`) are propagated to every command
 * because each sub-command has the same kind as the original motion.
 *
 * Throws `DrawingCommandError` on invalid feedSps or flags. Non-finite
 * or non-integer dx/dy are also rejected.
 *
 * @see Requirements 7.2, 7.8 (round-trip preserved at the command-list level)
 */
export function splitMotion(
    seqStart: number,
    dx: number,
    dy: number,
    feedSps: number,
    flags: number,
): DrawingCommand[] {
    if (!isU32(seqStart)) {
        throw new DrawingCommandError(
            'range',
            `seqStart ${seqStart} is not a valid u32`,
        );
    }
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) {
        throw new DrawingCommandError(
            'range',
            `dx and dy must be integers, got dx=${dx} dy=${dy}`,
        );
    }
    validateFeedSps(feedSps);
    validateFlags(flags);

    // Determine N: the smallest number of equal-share splits such that
    // every chunk's |delta| ≤ DELTA_MAX (32767), which keeps each chunk
    // strictly within i16 range. Single-command pass-through when the
    // logical motion already fits.
    let n = 1;
    if (dx > DRAWING_COMMAND_DELTA_MAX || dx < DRAWING_COMMAND_DELTA_MIN) {
        n = Math.max(n, Math.ceil(Math.abs(dx) / DRAWING_COMMAND_DELTA_MAX));
    }
    if (dy > DRAWING_COMMAND_DELTA_MAX || dy < DRAWING_COMMAND_DELTA_MIN) {
        n = Math.max(n, Math.ceil(Math.abs(dy) / DRAWING_COMMAND_DELTA_MAX));
    }

    const wasLastOfBatch =
        (flags & DRAWING_COMMAND_FLAGS.LAST_OF_BATCH) !== 0;
    const flagsWithoutLast = flags & ~DRAWING_COMMAND_FLAGS.LAST_OF_BATCH;

    const commands: DrawingCommand[] = [];
    let prevCumX = 0;
    let prevCumY = 0;

    for (let i = 1; i <= n; i++) {
        // Cumulative rounding makes the running total snap to the exact
        // (dx, dy) endpoint at i = N regardless of how the proportional
        // shares round individually.
        const cumX = Math.round((i / n) * dx);
        const cumY = Math.round((i / n) * dy);
        const dxi = cumX - prevCumX;
        const dyi = cumY - prevCumY;
        prevCumX = cumX;
        prevCumY = cumY;

        // Defensive: guarantee chunks are within i16. With the N chosen
        // above this is mathematically true, but we re-check so a bug in
        // the loop math surfaces immediately rather than silently emitting
        // an invalid command.
        if (!isI16(dxi) || !isI16(dyi)) {
            throw new DrawingCommandError(
                'range',
                `internal: split chunk ${i}/${n} produced (${dxi}, ${dyi}) outside i16 range`,
            );
        }

        const isLast = i === n;
        const cmdFlags =
            isLast && wasLastOfBatch ? flags : flagsWithoutLast;

        commands.push({
            seq: seqStart + i - 1,
            dxSteps: dxi,
            dySteps: dyi,
            feedSps,
            flags: cmdFlags,
        });
    }

    return commands;
}
