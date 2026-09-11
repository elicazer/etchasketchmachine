import { describe, it, expect } from 'vitest';
import {
    validateBacklashSteps,
    validateFontSizeMm,
    validateImageFile,
    validateImageRotationDeg,
    validateImageScale,
    validateLetterSpacingPct,
    validateSpeedPct,
    validateText,
    validateWifiPassword,
    validateWifiSsid,
} from './validators';

/**
 * Unit tests for the parameterised input validators. Each validator
 * gets at least one accepting case and one rejecting case so the
 * happy/sad paths are both exercised; property-based coverage of the
 * full input space is in the companion task 20.2.
 */

/**
 * Build a minimal `File`-shaped value for tests. Vitest runs under
 * jsdom which provides a real `File` constructor, but we still wrap
 * it here so individual tests stay readable.
 */
function makeFile(opts: {
    name: string;
    type: string;
    sizeBytes: number;
}): File {
    // Construct a Blob of the requested size out of a single repeated byte;
    // jsdom honours Blob.size based on the data we hand it.
    const data = new Uint8Array(opts.sizeBytes);
    return new File([data], opts.name, { type: opts.type });
}

describe('validateWifiSsid', () => {
    it('accepts a normal SSID', () => {
        expect(validateWifiSsid('home-network')).toEqual({
            ok: true,
            value: 'home-network',
        });
    });

    it('accepts a 32-character SSID at the upper bound', () => {
        const ssid = 'x'.repeat(32);
        expect(validateWifiSsid(ssid)).toEqual({ ok: true, value: ssid });
    });

    it('rejects an empty SSID', () => {
        const r = validateWifiSsid('');
        expect(r.ok).toBe(false);
    });

    it('rejects an SSID longer than 32 chars', () => {
        const r = validateWifiSsid('x'.repeat(33));
        expect(r.ok).toBe(false);
    });

    it('rejects an SSID with surrounding whitespace', () => {
        const r = validateWifiSsid(' home ');
        expect(r.ok).toBe(false);
    });
});

describe('validateWifiPassword', () => {
    it('accepts an 8-character password at the lower bound', () => {
        expect(validateWifiPassword('12345678')).toEqual({
            ok: true,
            value: '12345678',
        });
    });

    it('accepts a 63-character password at the upper bound', () => {
        const pw = 'a'.repeat(63);
        expect(validateWifiPassword(pw)).toEqual({ ok: true, value: pw });
    });

    it('rejects a too-short password', () => {
        const r = validateWifiPassword('short');
        expect(r.ok).toBe(false);
    });

    it('rejects a 64-character password (one past the upper bound)', () => {
        const r = validateWifiPassword('a'.repeat(64));
        expect(r.ok).toBe(false);
    });
});

describe('validateImageFile', () => {
    it('accepts a small PNG by MIME type', () => {
        const f = makeFile({
            name: 'foo.png',
            type: 'image/png',
            sizeBytes: 1024,
        });
        const r = validateImageFile(f);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.format).toBe('png');
    });

    it('accepts an SVG by MIME type', () => {
        const f = makeFile({
            name: 'icon.svg',
            type: 'image/svg+xml',
            sizeBytes: 256,
        });
        const r = validateImageFile(f);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.format).toBe('svg');
    });

    it('accepts a JPEG when only the extension is present', () => {
        // Simulate a browser that reported a generic MIME but a clear ext.
        const f = makeFile({
            name: 'photo.jpg',
            type: 'application/octet-stream',
            sizeBytes: 2048,
        });
        const r = validateImageFile(f);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.format).toBe('jpeg');
    });

    it('rejects a file exceeding the 10 MB limit', () => {
        const f = makeFile({
            name: 'huge.png',
            type: 'image/png',
            sizeBytes: 10 * 1024 * 1024 + 1,
        });
        const r = validateImageFile(f);
        expect(r.ok).toBe(false);
    });

    it('rejects an unsupported format (gif)', () => {
        const f = makeFile({
            name: 'anim.gif',
            type: 'image/gif',
            sizeBytes: 1024,
        });
        const r = validateImageFile(f);
        expect(r.ok).toBe(false);
    });

    it('rejects an empty file', () => {
        const f = makeFile({
            name: 'empty.png',
            type: 'image/png',
            sizeBytes: 0,
        });
        const r = validateImageFile(f);
        expect(r.ok).toBe(false);
    });

    it('rejects a mismatched MIME and extension', () => {
        const f = makeFile({
            name: 'foo.png',
            type: 'image/jpeg',
            sizeBytes: 512,
        });
        const r = validateImageFile(f);
        expect(r.ok).toBe(false);
    });
});

describe('validateImageScale', () => {
    it('accepts 1.0', () => {
        expect(validateImageScale(1.0)).toEqual({ ok: true, value: 1.0 });
    });

    it('accepts the 0.10 lower bound', () => {
        expect(validateImageScale(0.1)).toEqual({ ok: true, value: 0.1 });
    });

    it('accepts the 5.00 upper bound', () => {
        expect(validateImageScale(5.0)).toEqual({ ok: true, value: 5.0 });
    });

    it('rejects 0.05 (below the 0.10 lower bound)', () => {
        const r = validateImageScale(0.05);
        expect(r.ok).toBe(false);
    });

    it('rejects NaN', () => {
        const r = validateImageScale(Number.NaN);
        expect(r.ok).toBe(false);
    });

    it('rejects Infinity', () => {
        const r = validateImageScale(Number.POSITIVE_INFINITY);
        expect(r.ok).toBe(false);
    });
});

describe('validateImageRotationDeg', () => {
    it('accepts 0', () => {
        expect(validateImageRotationDeg(0)).toEqual({ ok: true, value: 0 });
    });

    it('accepts 359', () => {
        expect(validateImageRotationDeg(359)).toEqual({ ok: true, value: 359 });
    });

    it('rejects 360 (one past the upper bound)', () => {
        const r = validateImageRotationDeg(360);
        expect(r.ok).toBe(false);
    });

    it('rejects negative rotations', () => {
        const r = validateImageRotationDeg(-1);
        expect(r.ok).toBe(false);
    });

    it('rejects fractional rotations', () => {
        const r = validateImageRotationDeg(45.5);
        expect(r.ok).toBe(false);
    });
});

describe('validateText', () => {
    it('accepts a normal sentence', () => {
        expect(validateText('hello world')).toEqual({
            ok: true,
            value: 'hello world',
        });
    });

    it('accepts a 200-character string at the upper bound', () => {
        const s = 'a'.repeat(200);
        expect(validateText(s)).toEqual({ ok: true, value: s });
    });

    it('rejects an empty string', () => {
        const r = validateText('');
        expect(r.ok).toBe(false);
    });

    it('rejects whitespace-only input', () => {
        const r = validateText('   \t\n');
        expect(r.ok).toBe(false);
    });

    it('rejects a 201-character string', () => {
        const r = validateText('a'.repeat(201));
        expect(r.ok).toBe(false);
    });
});

describe('validateFontSizeMm', () => {
    it('accepts the 5 mm lower bound', () => {
        expect(validateFontSizeMm(5)).toEqual({ ok: true, value: 5 });
    });

    it('accepts the 100 mm upper bound', () => {
        expect(validateFontSizeMm(100)).toEqual({ ok: true, value: 100 });
    });

    it('rejects 4.9 (below the lower bound)', () => {
        const r = validateFontSizeMm(4.9);
        expect(r.ok).toBe(false);
    });

    it('rejects NaN', () => {
        const r = validateFontSizeMm(Number.NaN);
        expect(r.ok).toBe(false);
    });
});

describe('validateLetterSpacingPct', () => {
    it('accepts 0%', () => {
        expect(validateLetterSpacingPct(0)).toEqual({ ok: true, value: 0 });
    });

    it('accepts 200%', () => {
        expect(validateLetterSpacingPct(200)).toEqual({ ok: true, value: 200 });
    });

    it('rejects -1', () => {
        const r = validateLetterSpacingPct(-1);
        expect(r.ok).toBe(false);
    });

    it('rejects 201', () => {
        const r = validateLetterSpacingPct(201);
        expect(r.ok).toBe(false);
    });
});

describe('validateSpeedPct', () => {
    it('accepts the 25% lower bound', () => {
        expect(validateSpeedPct(25)).toEqual({ ok: true, value: 25 });
    });

    it('accepts the 100% upper bound', () => {
        expect(validateSpeedPct(100)).toEqual({ ok: true, value: 100 });
    });

    it('rejects 24 (one below the lower bound)', () => {
        const r = validateSpeedPct(24);
        expect(r.ok).toBe(false);
    });

    it('rejects 101 (one above the upper bound)', () => {
        const r = validateSpeedPct(101);
        expect(r.ok).toBe(false);
    });

    it('rejects fractional speeds', () => {
        const r = validateSpeedPct(50.5);
        expect(r.ok).toBe(false);
    });
});

describe('validateBacklashSteps', () => {
    it('accepts 0 (default uncalibrated value)', () => {
        expect(validateBacklashSteps(0)).toEqual({ ok: true, value: 0 });
    });

    it('accepts the 200 upper bound', () => {
        expect(validateBacklashSteps(200)).toEqual({ ok: true, value: 200 });
    });

    it('rejects -1', () => {
        const r = validateBacklashSteps(-1);
        expect(r.ok).toBe(false);
    });

    it('rejects 201 (one above the upper bound)', () => {
        const r = validateBacklashSteps(201);
        expect(r.ok).toBe(false);
    });

    it('rejects fractional step counts', () => {
        const r = validateBacklashSteps(2.5);
        expect(r.ok).toBe(false);
    });
});
