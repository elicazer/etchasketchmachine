import { describe, it, expect } from 'vitest';
import {
    DrawingCommandError,
    decodeCommand,
    encodeCommand,
    splitMotion,
} from './drawing_command';
import { crc16ccitt } from './crc16';
import {
    DRAWING_COMMAND_BYTES,
    DRAWING_COMMAND_DELTA_MAX,
    DRAWING_COMMAND_DELTA_MIN,
    DRAWING_COMMAND_FLAGS,
} from '../constants';
import type { DrawingCommand } from '../types';

/**
 * Unit tests for the Drawing_Command binary codec (Design §4.3).
 *
 * Property-based round-trip coverage lives in task 10.2; here we focus on
 * concrete examples that pin down the exact byte layout, error reporting,
 * and motion-splitting invariants.
 */

describe('encodeCommand / decodeCommand', () => {
    it('round-trips all fields exactly', () => {
        const cmd: DrawingCommand = {
            seq: 0xdeadbeef,
            dxSteps: -12345,
            dySteps: 6789,
            feedSps: 750,
            flags: DRAWING_COMMAND_FLAGS.CONNECTOR,
        };
        const decoded = decodeCommand(encodeCommand(cmd));
        expect(decoded.seq).toBe(cmd.seq);
        expect(decoded.dxSteps).toBe(cmd.dxSteps);
        expect(decoded.dySteps).toBe(cmd.dySteps);
        expect(decoded.feedSps).toBe(cmd.feedSps);
        expect(decoded.flags).toBe(cmd.flags);
        expect(decoded.crc16).toBeGreaterThanOrEqual(0);
        expect(decoded.crc16).toBeLessThanOrEqual(0xffff);
    });

    it('round-trips i16 boundary deltas', () => {
        const cmd: DrawingCommand = {
            seq: 0,
            dxSteps: DRAWING_COMMAND_DELTA_MIN,
            dySteps: DRAWING_COMMAND_DELTA_MAX,
            feedSps: 100,
            flags:
                DRAWING_COMMAND_FLAGS.CONNECTOR |
                DRAWING_COMMAND_FLAGS.LAST_OF_BATCH,
        };
        const decoded = decodeCommand(encodeCommand(cmd));
        expect(decoded.dxSteps).toBe(DRAWING_COMMAND_DELTA_MIN);
        expect(decoded.dySteps).toBe(DRAWING_COMMAND_DELTA_MAX);
        expect(decoded.flags).toBe(
            DRAWING_COMMAND_FLAGS.CONNECTOR |
            DRAWING_COMMAND_FLAGS.LAST_OF_BATCH,
        );
    });

    it('emits the expected 16-byte little-endian layout', () => {
        // Hand-crafted payload: every field has a distinct value so byte
        // offsets and endianness are unambiguous.
        const cmd: DrawingCommand = {
            seq: 0x01020304,
            dxSteps: 0x1122,
            dySteps: -1, // 0xFFFF in two's complement
            feedSps: 0x0258, // 600
            flags: DRAWING_COMMAND_FLAGS.LAST_OF_BATCH, // 0x0002
        };
        const buf = encodeCommand(cmd);
        expect(buf.length).toBe(DRAWING_COMMAND_BYTES);

        // seq (u32 LE) at offset 0
        expect(buf[0]).toBe(0x04);
        expect(buf[1]).toBe(0x03);
        expect(buf[2]).toBe(0x02);
        expect(buf[3]).toBe(0x01);
        // dxSteps (i16 LE) at offset 4
        expect(buf[4]).toBe(0x22);
        expect(buf[5]).toBe(0x11);
        // dySteps (i16 LE = -1) at offset 6
        expect(buf[6]).toBe(0xff);
        expect(buf[7]).toBe(0xff);
        // feedSps (u16 LE = 600) at offset 8
        expect(buf[8]).toBe(0x58);
        expect(buf[9]).toBe(0x02);
        // flags (u16 LE) at offset 10
        expect(buf[10]).toBe(0x02);
        expect(buf[11]).toBe(0x00);
        // reserved (u16 LE = 0) at offset 12
        expect(buf[12]).toBe(0x00);
        expect(buf[13]).toBe(0x00);
        // crc16 (u16 LE) at offset 14 — must equal CCITT over bytes [0..14)
        const expectedCrc = crc16ccitt(buf.subarray(0, 14));
        expect(buf[14]).toBe(expectedCrc & 0xff);
        expect(buf[15]).toBe((expectedCrc >> 8) & 0xff);
    });

    it('throws DrawingCommandError on bad CRC', () => {
        const cmd: DrawingCommand = {
            seq: 42,
            dxSteps: 100,
            dySteps: 200,
            feedSps: 500,
            flags: 0,
        };
        const buf = encodeCommand(cmd);
        // Flip a bit in the CRC suffix.
        buf[14] ^= 0x01;

        try {
            decodeCommand(buf);
            throw new Error('expected decodeCommand to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(DrawingCommandError);
            expect((err as DrawingCommandError).kind).toBe('crc');
        }
    });

    it('throws DrawingCommandError on length != 16', () => {
        for (const len of [0, 1, 8, 15, 17, 32]) {
            try {
                decodeCommand(new Uint8Array(len));
                throw new Error(`expected throw for length ${len}`);
            } catch (err) {
                expect(err).toBeInstanceOf(DrawingCommandError);
                expect((err as DrawingCommandError).kind).toBe('length');
            }
        }
    });

    it('rejects feedSps outside [100, 1000]', () => {
        const base: DrawingCommand = {
            seq: 0,
            dxSteps: 0,
            dySteps: 0,
            feedSps: 100,
            flags: 0,
        };
        for (const bad of [99, 1001, 0, -1, 2000]) {
            try {
                encodeCommand({ ...base, feedSps: bad });
                throw new Error(`expected throw for feedSps=${bad}`);
            } catch (err) {
                expect(err).toBeInstanceOf(DrawingCommandError);
                expect((err as DrawingCommandError).kind).toBe('range');
            }
        }
    });

    it('rejects flags with reserved bits set', () => {
        const base: DrawingCommand = {
            seq: 0,
            dxSteps: 0,
            dySteps: 0,
            feedSps: 100,
            flags: 0,
        };
        for (const bad of [0b100, 0b1000, 0xffff, 0x8000]) {
            try {
                encodeCommand({ ...base, flags: bad });
                throw new Error(`expected throw for flags=${bad}`);
            } catch (err) {
                expect(err).toBeInstanceOf(DrawingCommandError);
                expect((err as DrawingCommandError).kind).toBe('flags');
            }
        }
    });

    it('rejects dx/dy outside i16 range from encodeCommand', () => {
        const base: DrawingCommand = {
            seq: 0,
            dxSteps: 0,
            dySteps: 0,
            feedSps: 100,
            flags: 0,
        };
        const invalid = [
            DRAWING_COMMAND_DELTA_MAX + 1,
            DRAWING_COMMAND_DELTA_MIN - 1,
            100_000,
            -100_000,
        ];
        for (const v of invalid) {
            try {
                encodeCommand({ ...base, dxSteps: v });
                throw new Error(`expected throw for dxSteps=${v}`);
            } catch (err) {
                expect(err).toBeInstanceOf(DrawingCommandError);
                expect((err as DrawingCommandError).kind).toBe('range');
            }
            try {
                encodeCommand({ ...base, dySteps: v });
                throw new Error(`expected throw for dySteps=${v}`);
            } catch (err) {
                expect(err).toBeInstanceOf(DrawingCommandError);
                expect((err as DrawingCommandError).kind).toBe('range');
            }
        }
    });
});

describe('splitMotion', () => {
    it('returns a single command when the motion already fits', () => {
        const cmds = splitMotion(7, 100, -200, 500, 0);
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).toMatchObject({
            seq: 7,
            dxSteps: 100,
            dySteps: -200,
            feedSps: 500,
            flags: 0,
        });
    });

    it('splits dx > 32767 into chunks whose summed deltas equal the original', () => {
        const dx = 100_000;
        const dy = 0;
        const seqStart = 42;
        const cmds = splitMotion(seqStart, dx, dy, 800, 0);
        expect(cmds.length).toBeGreaterThan(1);

        let sumDx = 0;
        let sumDy = 0;
        for (const cmd of cmds) {
            sumDx += cmd.dxSteps;
            sumDy += cmd.dySteps;
            expect(cmd.dxSteps).toBeGreaterThanOrEqual(DRAWING_COMMAND_DELTA_MIN);
            expect(cmd.dxSteps).toBeLessThanOrEqual(DRAWING_COMMAND_DELTA_MAX);
            expect(cmd.dySteps).toBeGreaterThanOrEqual(DRAWING_COMMAND_DELTA_MIN);
            expect(cmd.dySteps).toBeLessThanOrEqual(DRAWING_COMMAND_DELTA_MAX);
            expect(cmd.feedSps).toBe(800);
        }
        expect(sumDx).toBe(dx);
        expect(sumDy).toBe(dy);

        // Sequence numbers monotonically increase from seqStart.
        cmds.forEach((cmd, i) => {
            expect(cmd.seq).toBe(seqStart + i);
        });
    });

    it('splits motions exceeding i16 in both axes (negative direction)', () => {
        const dx = -80_000;
        const dy = -50_000;
        const cmds = splitMotion(0, dx, dy, 500, 0);
        expect(cmds.length).toBeGreaterThan(1);

        let sumDx = 0;
        let sumDy = 0;
        for (const cmd of cmds) {
            sumDx += cmd.dxSteps;
            sumDy += cmd.dySteps;
            expect(Math.abs(cmd.dxSteps)).toBeLessThanOrEqual(
                DRAWING_COMMAND_DELTA_MAX,
            );
            expect(Math.abs(cmd.dySteps)).toBeLessThanOrEqual(
                DRAWING_COMMAND_DELTA_MAX,
            );
        }
        expect(sumDx).toBe(dx);
        expect(sumDy).toBe(dy);
    });

    it('only the final emitted command keeps LAST_OF_BATCH when set', () => {
        const cmds = splitMotion(
            0,
            100_000,
            0,
            500,
            DRAWING_COMMAND_FLAGS.LAST_OF_BATCH |
            DRAWING_COMMAND_FLAGS.CONNECTOR,
        );
        expect(cmds.length).toBeGreaterThan(1);

        // Connector flag (and any non-LAST flags) propagate to every chunk.
        // LAST_OF_BATCH is cleared on every chunk except the final one.
        cmds.forEach((cmd, i) => {
            const isLast = i === cmds.length - 1;
            expect(cmd.flags & DRAWING_COMMAND_FLAGS.CONNECTOR).toBe(
                DRAWING_COMMAND_FLAGS.CONNECTOR,
            );
            const lastBit = cmd.flags & DRAWING_COMMAND_FLAGS.LAST_OF_BATCH;
            if (isLast) {
                expect(lastBit).toBe(DRAWING_COMMAND_FLAGS.LAST_OF_BATCH);
            } else {
                expect(lastBit).toBe(0);
            }
        });
    });

    it('does not set LAST_OF_BATCH on any command when input lacks it', () => {
        const cmds = splitMotion(
            0,
            100_000,
            0,
            500,
            DRAWING_COMMAND_FLAGS.CONNECTOR,
        );
        for (const cmd of cmds) {
            expect(cmd.flags & DRAWING_COMMAND_FLAGS.LAST_OF_BATCH).toBe(0);
        }
    });

    it('rejects feedSps outside [100, 1000]', () => {
        for (const bad of [99, 1001]) {
            try {
                splitMotion(0, 100, 0, bad, 0);
                throw new Error(`expected throw for feedSps=${bad}`);
            } catch (err) {
                expect(err).toBeInstanceOf(DrawingCommandError);
                expect((err as DrawingCommandError).kind).toBe('range');
            }
        }
    });

    it('rejects flags with reserved bits set', () => {
        try {
            splitMotion(0, 100, 0, 500, 0b100);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(DrawingCommandError);
            expect((err as DrawingCommandError).kind).toBe('flags');
        }
    });

    it('emitted commands all encode/decode round-trip', () => {
        // Sanity check: splits are not just structurally valid, they also
        // pass the codec round-trip.
        const cmds = splitMotion(
            10,
            123_456,
            -98_765,
            450,
            DRAWING_COMMAND_FLAGS.LAST_OF_BATCH,
        );
        for (const cmd of cmds) {
            const decoded = decodeCommand(encodeCommand(cmd));
            expect(decoded.seq).toBe(cmd.seq);
            expect(decoded.dxSteps).toBe(cmd.dxSteps);
            expect(decoded.dySteps).toBe(cmd.dySteps);
            expect(decoded.feedSps).toBe(cmd.feedSps);
            expect(decoded.flags).toBe(cmd.flags);
        }
    });
});
