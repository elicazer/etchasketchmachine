import { describe, it, expect } from 'vitest';
import { crc16ccitt } from './crc16';

/**
 * Unit tests for CRC-16/CCITT-FALSE.
 *
 * These check well-known reference vectors for the CRC-16/CCITT-FALSE
 * variant (poly 0x1021, init 0xFFFF, no reflection, no final XOR), the
 * exact parameterization required by Design §4.3 for Drawing_Command
 * payload integrity.
 */

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crc16ccitt', () => {
    it('returns the init value 0xFFFF for empty input', () => {
        expect(crc16ccitt(new Uint8Array())).toBe(0xffff);
    });

    it("computes 0x29B1 for the canonical '123456789' check vector", () => {
        // 0x29B1 is the documented check value for CRC-16/CCITT-FALSE
        // across most CRC catalogues (e.g., the reveng catalogue).
        expect(crc16ccitt(ascii('123456789'))).toBe(0x29b1);
    });

    it("computes 0xB915 for single byte 'A'", () => {
        expect(crc16ccitt(ascii('A'))).toBe(0xb915);
    });

    it('computes 0xE1F0 for a single zero byte', () => {
        expect(crc16ccitt(new Uint8Array([0x00]))).toBe(0xe1f0);
    });

    it('computes 0xFF00 for a single 0xFF byte', () => {
        expect(crc16ccitt(new Uint8Array([0xff]))).toBe(0xff00);
    });

    it('returns a 16-bit value for arbitrary input', () => {
        const result = crc16ccitt(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(0xffff);
        expect(Number.isInteger(result)).toBe(true);
    });

    it('produces different CRCs for different inputs of the same length', () => {
        const a = crc16ccitt(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
        const b = crc16ccitt(new Uint8Array([0x04, 0x03, 0x02, 0x01]));
        expect(a).not.toBe(b);
    });
});
