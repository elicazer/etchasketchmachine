import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    BACKLASH_STEPS_MAX,
    BACKLASH_STEPS_MIN,
    SPEED_PCT_MAX,
    SPEED_PCT_MIN,
} from './constants';
import {
    FONT_SIZE_MM_MAX,
    FONT_SIZE_MM_MIN,
    IMAGE_MAX_BYTES,
    IMAGE_ROTATION_MAX_DEG,
    IMAGE_ROTATION_MIN_DEG,
    IMAGE_SCALE_MAX,
    IMAGE_SCALE_MIN,
    LETTER_SPACING_PCT_MAX,
    LETTER_SPACING_PCT_MIN,
    TEXT_MAX_LEN,
    WIFI_PASSWORD_MAX_LEN,
    WIFI_PASSWORD_MIN_LEN,
    WIFI_SSID_MAX_LEN,
    WIFI_SSID_MIN_LEN,
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
    type ValidationResult,
} from './validators';

/**
 * Property 27: Input validators (parameterized).
 *
 * Validates: Requirements 1.4, 2.1, 2.3, 2.4, 3.3, 3.6, 6.7, 9.7, 13.8
 *
 * For every validator we assert the boundary contract holds across the
 * whole input space: arbitrary in-range inputs are accepted (and the
 * canonicalised value is echoed), arbitrary out-of-range inputs are
 * rejected, non-finite numbers are rejected, and validators that demand
 * integers reject in-range non-integers. The bounds are imported from
 * the implementation modules (`validators.ts` / `constants.ts`) so this
 * test tracks the single source of truth rather than hardcoding limits.
 *
 * Note on Req 6.7: that requirement is the *firmware* command-parser
 * range check (Property 8). On the web side the analogous guards are the
 * speed / backlash / scale / rotation validators below; the firmware-side
 * counterpart is covered by firmware task 4.5.
 */

const NUM_RUNS = { numRuns: 500 } as const;
const FILE_RUNS = { numRuns: 200 } as const;

// -----------------------------------------------------------------------------
// Parameterised numeric validators
// -----------------------------------------------------------------------------

interface NumericSpec {
    name: string;
    fn: (n: number) => ValidationResult<number>;
    lo: number;
    hi: number;
    /** True if the validator additionally requires an integer value. */
    integer: boolean;
}

const REAL_SPECS: NumericSpec[] = [
    {
        name: 'validateImageScale',
        fn: validateImageScale,
        lo: IMAGE_SCALE_MIN,
        hi: IMAGE_SCALE_MAX,
        integer: false,
    },
    {
        name: 'validateFontSizeMm',
        fn: validateFontSizeMm,
        lo: FONT_SIZE_MM_MIN,
        hi: FONT_SIZE_MM_MAX,
        integer: false,
    },
    {
        name: 'validateLetterSpacingPct',
        fn: validateLetterSpacingPct,
        lo: LETTER_SPACING_PCT_MIN,
        hi: LETTER_SPACING_PCT_MAX,
        integer: false,
    },
];

const INTEGER_SPECS: NumericSpec[] = [
    {
        name: 'validateImageRotationDeg',
        fn: validateImageRotationDeg,
        lo: IMAGE_ROTATION_MIN_DEG,
        hi: IMAGE_ROTATION_MAX_DEG,
        integer: true,
    },
    {
        name: 'validateSpeedPct',
        fn: validateSpeedPct,
        lo: SPEED_PCT_MIN,
        hi: SPEED_PCT_MAX,
        integer: true,
    },
    {
        name: 'validateBacklashSteps',
        fn: validateBacklashSteps,
        lo: BACKLASH_STEPS_MIN,
        hi: BACKLASH_STEPS_MAX,
        integer: true,
    },
];

const ALL_NUMERIC_SPECS = [...REAL_SPECS, ...INTEGER_SPECS];

/** Non-finite numbers every numeric validator must reject. */
const arbNonFinite = fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
);

describe('Property 27: numeric input validators (parameterized)', () => {
    // -- Real-valued validators ----------------------------------------------
    for (const spec of REAL_SPECS) {
        describe(spec.name, () => {
            it('accepts every finite value in [lo, hi] and echoes it', () => {
                fc.assert(
                    fc.property(
                        fc.double({
                            min: spec.lo,
                            max: spec.hi,
                            noNaN: true,
                            noDefaultInfinity: true,
                        }),
                        (n) => {
                            const r = spec.fn(n);
                            expect(r.ok).toBe(true);
                            if (r.ok) expect(r.value).toBe(n);
                        },
                    ),
                    NUM_RUNS,
                );
            });

            it('rejects every value strictly below lo', () => {
                fc.assert(
                    fc.property(
                        fc
                            .double({
                                min: spec.lo - 1000,
                                max: spec.lo,
                                maxExcluded: true,
                                noNaN: true,
                                noDefaultInfinity: true,
                            })
                            // Guard against the signed-zero edge: fast-check can
                            // emit -0 for a range whose excluded max is 0, but
                            // -0 === 0 is the in-range lower bound, not "below lo".
                            .filter((n) => n < spec.lo),
                        (n) => {
                            expect(spec.fn(n).ok).toBe(false);
                        },
                    ),
                    NUM_RUNS,
                );
            });

            it('rejects every value strictly above hi', () => {
                fc.assert(
                    fc.property(
                        fc.double({
                            min: spec.hi,
                            max: spec.hi + 1000,
                            minExcluded: true,
                            noNaN: true,
                            noDefaultInfinity: true,
                        }),
                        (n) => {
                            expect(spec.fn(n).ok).toBe(false);
                        },
                    ),
                    NUM_RUNS,
                );
            });
        });
    }

    // -- Integer-valued validators -------------------------------------------
    for (const spec of INTEGER_SPECS) {
        describe(spec.name, () => {
            it('accepts every integer in [lo, hi] and echoes it', () => {
                fc.assert(
                    fc.property(
                        fc.integer({ min: spec.lo, max: spec.hi }),
                        (n) => {
                            const r = spec.fn(n);
                            expect(r.ok).toBe(true);
                            if (r.ok) expect(r.value).toBe(n);
                        },
                    ),
                    NUM_RUNS,
                );
            });

            it('rejects every integer below lo', () => {
                fc.assert(
                    fc.property(
                        fc.integer({ min: spec.lo - 100000, max: spec.lo - 1 }),
                        (n) => {
                            expect(spec.fn(n).ok).toBe(false);
                        },
                    ),
                    NUM_RUNS,
                );
            });

            it('rejects every integer above hi', () => {
                fc.assert(
                    fc.property(
                        fc.integer({ min: spec.hi + 1, max: spec.hi + 100000 }),
                        (n) => {
                            expect(spec.fn(n).ok).toBe(false);
                        },
                    ),
                    NUM_RUNS,
                );
            });

            it('rejects in-range non-integer finite values', () => {
                fc.assert(
                    fc.property(
                        fc
                            .double({
                                min: spec.lo,
                                max: spec.hi,
                                noNaN: true,
                                noDefaultInfinity: true,
                            })
                            .filter(
                                (x) =>
                                    Number.isFinite(x) && !Number.isInteger(x),
                            ),
                        (n) => {
                            expect(spec.fn(n).ok).toBe(false);
                        },
                    ),
                    NUM_RUNS,
                );
            });
        });
    }

    // -- Non-finite rejection (applies to every numeric validator) ------------
    for (const spec of ALL_NUMERIC_SPECS) {
        it(`${spec.name} rejects non-finite (NaN, ±Infinity) inputs`, () => {
            fc.assert(
                fc.property(arbNonFinite, (n) => {
                    expect(spec.fn(n).ok).toBe(false);
                }),
                NUM_RUNS,
            );
        });
    }
});

// -----------------------------------------------------------------------------
// WiFi credentials (Req 1.4)
// -----------------------------------------------------------------------------

/**
 * A printable string with no leading/trailing whitespace. `fc.string`'s
 * default alphabet (printable ASCII) can include spaces in the middle,
 * which the SSID validator tolerates; we only need the edges clean.
 */
const arbTrimmedString = (minLength: number, maxLength: number) =>
    fc
        .string({ minLength, maxLength })
        .filter((s) => s.length >= minLength && s === s.trim());

describe('Property 27: validateWifiSsid (Req 1.4)', () => {
    it('accepts trimmed strings of length [1, 32] and echoes them', () => {
        fc.assert(
            fc.property(
                arbTrimmedString(WIFI_SSID_MIN_LEN, WIFI_SSID_MAX_LEN),
                (s) => {
                    const r = validateWifiSsid(s);
                    expect(r.ok).toBe(true);
                    if (r.ok) expect(r.value).toBe(s);
                },
            ),
            NUM_RUNS,
        );
    });

    it('rejects the empty string', () => {
        expect(validateWifiSsid('').ok).toBe(false);
    });

    it('rejects strings longer than 32 chars (no edge whitespace)', () => {
        fc.assert(
            fc.property(
                arbTrimmedString(WIFI_SSID_MAX_LEN + 1, WIFI_SSID_MAX_LEN + 80),
                (s) => {
                    expect(validateWifiSsid(s).ok).toBe(false);
                },
            ),
            NUM_RUNS,
        );
    });

    it('rejects strings with leading/trailing whitespace', () => {
        const arbSurrounded = fc
            .tuple(
                fc.nat({ max: 3 }),
                arbTrimmedString(1, WIFI_SSID_MAX_LEN - 1),
                fc.nat({ max: 3 }),
            )
            .filter(([lead, , trail]) => lead + trail >= 1)
            .map(
                ([lead, core, trail]) =>
                    ' '.repeat(lead) + core + ' '.repeat(trail),
            );
        fc.assert(
            fc.property(arbSurrounded, (s) => {
                expect(validateWifiSsid(s).ok).toBe(false);
            }),
            NUM_RUNS,
        );
    });
});

describe('Property 27: validateWifiPassword (Req 1.4)', () => {
    it('accepts strings of length [8, 63] and echoes them', () => {
        fc.assert(
            fc.property(
                fc.string({
                    minLength: WIFI_PASSWORD_MIN_LEN,
                    maxLength: WIFI_PASSWORD_MAX_LEN,
                }),
                (s) => {
                    const r = validateWifiPassword(s);
                    expect(r.ok).toBe(true);
                    if (r.ok) expect(r.value).toBe(s);
                },
            ),
            NUM_RUNS,
        );
    });

    it('rejects strings shorter than 8 chars', () => {
        fc.assert(
            fc.property(
                fc.string({ maxLength: WIFI_PASSWORD_MIN_LEN - 1 }),
                (s) => {
                    expect(validateWifiPassword(s).ok).toBe(false);
                },
            ),
            NUM_RUNS,
        );
    });

    it('rejects strings longer than 63 chars', () => {
        fc.assert(
            fc.property(
                fc.string({
                    minLength: WIFI_PASSWORD_MAX_LEN + 1,
                    maxLength: WIFI_PASSWORD_MAX_LEN + 80,
                }),
                (s) => {
                    expect(validateWifiPassword(s).ok).toBe(false);
                },
            ),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Text (Req 3.6)
// -----------------------------------------------------------------------------

describe('Property 27: validateText (Req 3.6)', () => {
    it('accepts non-empty (post-trim) strings of length [1, 200]', () => {
        fc.assert(
            fc.property(
                fc
                    .string({ minLength: 1, maxLength: TEXT_MAX_LEN })
                    .filter((s) => s.trim().length > 0),
                (s) => {
                    const r = validateText(s);
                    expect(r.ok).toBe(true);
                    if (r.ok) expect(r.value).toBe(s);
                },
            ),
            NUM_RUNS,
        );
    });

    it('rejects empty / whitespace-only input', () => {
        fc.assert(
            fc.property(
                fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), {
                    minLength: 0,
                    maxLength: 16,
                }),
                (s) => {
                    expect(validateText(s).ok).toBe(false);
                },
            ),
            NUM_RUNS,
        );
    });

    it('rejects content longer than 200 chars', () => {
        // Use a non-whitespace alphabet so the only failure reason is length.
        const arbLong = fc.stringOf(
            fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
            { minLength: TEXT_MAX_LEN + 1, maxLength: TEXT_MAX_LEN + 100 },
        );
        fc.assert(
            fc.property(arbLong, (s) => {
                expect(validateText(s).ok).toBe(false);
            }),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Image file (Req 2.1, 2.4)
// -----------------------------------------------------------------------------

/**
 * Minimal File-shaped value. `validateImageFile` only reads `.size`,
 * `.name`, and `.type`, so an object literal exercises every branch of
 * the size/format logic without allocating large buffers (which is the
 * only practical way to probe the 10 MB boundary).
 */
function fileLike(size: number, name: string, type: string): File {
    return { size, name, type } as unknown as File;
}

/** name/type pairs whose MIME and extension both resolve to a supported,
 *  consistent format (or where only one is present and resolves). */
const arbValidFormat = fc.constantFrom(
    { name: 'image.png', type: 'image/png' },
    { name: 'image.PNG', type: 'image/png' },
    { name: 'photo.jpg', type: 'image/jpeg' },
    { name: 'photo.jpeg', type: 'image/jpeg' },
    { name: 'photo.jpg', type: 'image/jpg' },
    { name: 'pic.bmp', type: 'image/bmp' },
    { name: 'pic.bmp', type: 'image/x-bmp' },
    { name: 'icon.svg', type: 'image/svg+xml' },
    // Extension-only: browser omitted or returned a generic MIME.
    { name: 'image.png', type: '' },
    { name: 'photo.jpeg', type: 'application/octet-stream' },
    { name: 'icon.svg', type: '' },
);

/** name/type pairs that resolve to no supported format at all. */
const arbUnsupportedFormat = fc.constantFrom(
    { name: 'anim.gif', type: 'image/gif' },
    { name: 'doc.txt', type: 'text/plain' },
    { name: 'doc.pdf', type: 'application/pdf' },
    { name: 'photo.webp', type: 'image/webp' },
    { name: 'noextension', type: '' },
    { name: 'archive.zip', type: 'application/zip' },
);

/** Supported on both sides but MIME and extension disagree (inconsistent). */
const arbMismatchedFormat = fc.constantFrom(
    { name: 'foo.png', type: 'image/jpeg' },
    { name: 'foo.jpg', type: 'image/png' },
    { name: 'foo.bmp', type: 'image/svg+xml' },
);

describe('Property 27: validateImageFile (Req 2.1, 2.4)', () => {
    it('accepts files ≤ 10 MB with a supported, consistent format', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: IMAGE_MAX_BYTES }),
                arbValidFormat,
                (size, fmt) => {
                    const r = validateImageFile(
                        fileLike(size, fmt.name, fmt.type),
                    );
                    expect(r.ok).toBe(true);
                    if (r.ok) {
                        expect(r.value.size).toBe(size);
                        expect(r.value.name).toBe(fmt.name);
                    }
                },
            ),
            FILE_RUNS,
        );
    });

    it('rejects files larger than 10 MB even with a valid format', () => {
        fc.assert(
            fc.property(
                fc.integer({
                    min: IMAGE_MAX_BYTES + 1,
                    max: IMAGE_MAX_BYTES + 5_000_000,
                }),
                arbValidFormat,
                (size, fmt) => {
                    expect(
                        validateImageFile(fileLike(size, fmt.name, fmt.type))
                            .ok,
                    ).toBe(false);
                },
            ),
            FILE_RUNS,
        );
    });

    it('rejects unsupported formats even when within the size limit', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: IMAGE_MAX_BYTES }),
                arbUnsupportedFormat,
                (size, fmt) => {
                    expect(
                        validateImageFile(fileLike(size, fmt.name, fmt.type))
                            .ok,
                    ).toBe(false);
                },
            ),
            FILE_RUNS,
        );
    });

    it('rejects inconsistent MIME/extension pairs', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: IMAGE_MAX_BYTES }),
                arbMismatchedFormat,
                (size, fmt) => {
                    expect(
                        validateImageFile(fileLike(size, fmt.name, fmt.type))
                            .ok,
                    ).toBe(false);
                },
            ),
            FILE_RUNS,
        );
    });

    // A couple of smoke cases against the real jsdom/Node `File` constructor
    // to confirm the validator works on genuine File objects, not just the
    // structural stand-in used above.
    it('smoke: accepts a real small PNG File', () => {
        const f = new File([new Uint8Array(1024)], 'real.png', {
            type: 'image/png',
        });
        const r = validateImageFile(f);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.format).toBe('png');
    });

    it('smoke: rejects a real GIF File', () => {
        const f = new File([new Uint8Array(1024)], 'real.gif', {
            type: 'image/gif',
        });
        expect(validateImageFile(f).ok).toBe(false);
    });

    it('smoke: rejects a real empty File', () => {
        const f = new File([], 'empty.png', { type: 'image/png' });
        expect(validateImageFile(f).ok).toBe(false);
    });
});
