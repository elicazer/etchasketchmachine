/**
 * Property-based tests for the Text_Renderer module.
 *
 * Implements **Property 28: Unsupported codepoint highlight matches missing
 * set** (Design §7). For any (text, bundled-font) pair the `missing` array
 * returned by `render` is exactly the sorted, de-duplicated set of codepoints
 * in the text that the chosen font has no glyph for — with the newline
 * (U+000A) excluded because the renderer treats it as layout, not a glyph —
 * and the optional covering-font `suggestion` is a real, different bundled
 * font whose glyph table covers every missing codepoint.
 *
 * **Validates: Requirements 3.5**
 *
 * @see web/src/text/text_renderer.ts
 * @see Design §3.1.2, §7
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createTextRenderer, type StrokeFont } from './text_renderer';
import {
    FONT_SIZE_MM_MIN,
    FONT_SIZE_MM_MAX,
    LETTER_SPACING_PCT_MIN,
    LETTER_SPACING_PCT_MAX,
} from '../validators';

// -----------------------------------------------------------------------------
// Shared fixtures
//
// One renderer instance gives us the real bundled fonts. We read each font's
// `glyphs` dictionary directly as the INDEPENDENT ORACLE for which codepoints
// it can draw — the renderer must agree with that table exactly.
// -----------------------------------------------------------------------------

const renderer = createTextRenderer();
const fonts = renderer.fonts();
const fontNames = fonts.map((f) => f.name);
const fontByName = new Map<string, StrokeFont>(
    fonts.map((f) => [f.name, f] as const),
);

/** U+000A: render() treats a newline as a carriage-return + line-feed
 *  layout move, NOT a glyph, so it never appears in `missing`. */
const NEWLINE = 0x0a;

/** U+00B0 DEGREE SIGN — present only in "Simplex" of the bundled set, so it
 *  is supported or missing depending on the selected font. This is what
 *  exercises the font-dependent coverage + suggestion path. */
const DEGREE_SIGN = 0x00b0;

// -----------------------------------------------------------------------------
// Codepoint alphabet
//
// A union of three groups so generated strings mix supported and unsupported
// characters (plus newlines and repeats):
//   - SUPPORTED: printable ASCII the entire bundle covers (Req 3.2 baseline).
//   - FONT-DEPENDENT: the degree sign + the newline.
//   - GUARANTEED-UNSUPPORTED: emoji, CJK, Cyrillic, accented Latin and a
//     symbol — none of which any bundled font has a glyph for (the bundle is
//     printable ASCII plus Simplex's degree sign only).
//
// The oracle below reads the chosen font's `glyphs` directly, so correctness
// never depends on these labels being right — the pools only steer the
// generator toward interesting inputs.
// -----------------------------------------------------------------------------

const SUPPORTED_ASCII: number[] = [
    0x20, // space (a glyph with NO strokes)
    'A'.codePointAt(0)!,
    'B'.codePointAt(0)!,
    'M'.codePointAt(0)!,
    'a'.codePointAt(0)!,
    'b'.codePointAt(0)!,
    'z'.codePointAt(0)!,
    '0'.codePointAt(0)!,
    '5'.codePointAt(0)!,
    '9'.codePointAt(0)!,
    '!'.codePointAt(0)!,
    '?'.codePointAt(0)!,
    '.'.codePointAt(0)!,
    ','.codePointAt(0)!,
    '~'.codePointAt(0)!,
];

const GUARANTEED_UNSUPPORTED: number[] = [
    0x1f600, // 😀
    0x1f604, // 😄
    0x1f64f, // 🙏
    0x4e00, // 一
    0x4eba, // 人
    0x6c34, // 水
    0x0410, // А (Cyrillic)
    0x0411, // Б (Cyrillic)
    0x00e9, // é
    0x2603, // ☃
];

const ALPHABET: number[] = [
    ...SUPPORTED_ASCII,
    NEWLINE,
    DEGREE_SIGN,
    ...GUARANTEED_UNSUPPORTED,
];

// -----------------------------------------------------------------------------
// Oracle
// -----------------------------------------------------------------------------

/**
 * Independent oracle for `render(...).missing`: the sorted, de-duplicated
 * codepoints of `text` (iterated per Unicode codepoint, matching the
 * implementation's `for..of`) that have no glyph in `font.glyphs`, excluding
 * the newline U+000A which the renderer consumes as layout.
 */
function expectedMissing(text: string, font: StrokeFont): number[] {
    const set = new Set<number>();
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (cp === NEWLINE) continue; // layout, not a glyph
        if (font.glyphs[cp] === undefined) set.add(cp);
    }
    return [...set].sort((a, b) => a - b);
}

/** The set of distinct codepoints that actually occur in `text`. */
function codepointsOf(text: string): Set<number> {
    const set = new Set<number>();
    for (const ch of text) set.add(ch.codePointAt(0)!);
    return set;
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/** Pick a bundled font by name (drives the font-dependent coverage). */
const arbFontName: fc.Arbitrary<string> = fc.constantFrom(...fontNames);

/** Strings over the mixed alphabet, including the empty string and repeats. */
const arbText: fc.Arbitrary<string> = fc
    .array(fc.constantFrom(...ALPHABET), { minLength: 0, maxLength: 30 })
    .map((cps) => cps.map((c) => String.fromCodePoint(c)).join(''));

/** Font size within the valid inclusive range [5, 100] mm. */
const arbFontSizeMm: fc.Arbitrary<number> = fc.double({
    min: FONT_SIZE_MM_MIN,
    max: FONT_SIZE_MM_MAX,
    noNaN: true,
});

/** Letter spacing within the valid inclusive range [0, 200] %. */
const arbLetterSpacingPct: fc.Arbitrary<number> = fc.double({
    min: LETTER_SPACING_PCT_MIN,
    max: LETTER_SPACING_PCT_MAX,
    noNaN: true,
});

// -----------------------------------------------------------------------------
// Property 28
// -----------------------------------------------------------------------------

describe('Text_Renderer — Property 28 (unsupported codepoint highlight)', () => {
    /**
     * **Validates: Requirements 3.5**
     *
     * For an arbitrary text string, a selected bundled font, and valid size /
     * spacing, `render(text, opts)` satisfies all of:
     *
     *   1. EXACT MATCH — `missing` equals the set of distinct codepoints in
     *      `text` with no glyph in the chosen font (newline excluded).
     *   2. SORTED + DEDUPED — `missing` is strictly increasing.
     *   3. SUBSET OF INPUT — every codepoint in `missing` occurs in `text`.
     *   4. SUGGESTION VALIDITY — a defined `suggestion` is a different,
     *      real bundled font whose glyphs cover every missing codepoint; an
     *      empty `missing` implies no `suggestion`.
     *   5. NO-MISSING ⇒ RENDERED — with `missing` empty, text containing at
     *      least one supported stroke-bearing glyph yields non-empty
     *      `polylines`.
     */
    it('reports exactly the unsupported codepoints, sorted/deduped, with a valid suggestion', () => {
        fc.assert(
            fc.property(
                arbFontName,
                arbText,
                arbFontSizeMm,
                arbLetterSpacingPct,
                (fontName, text, fontSizeMm, letterSpacingPct) => {
                    const font = fontByName.get(fontName)!;
                    const result = renderer.render(text, {
                        fontName,
                        fontSizeMm,
                        letterSpacingPct,
                    });

                    // (1) EXACT MATCH against the independent glyph-table oracle.
                    // expectedMissing returns sorted+deduped, so array equality
                    // here also pins down ordering and de-duplication.
                    const oracle = expectedMissing(text, font);
                    expect(result.missing).toEqual(oracle);
                    expect(new Set(result.missing)).toEqual(new Set(oracle));

                    // (2) SORTED + DEDUPED: strictly increasing => sorted asc
                    // with no duplicates.
                    for (let i = 1; i < result.missing.length; i++) {
                        expect(result.missing[i]!).toBeGreaterThan(
                            result.missing[i - 1]!,
                        );
                    }

                    // (3) SUBSET OF INPUT: every reported codepoint occurs in
                    // the text and is genuinely absent from the font.
                    const present = codepointsOf(text);
                    for (const cp of result.missing) {
                        expect(present.has(cp)).toBe(true);
                        expect(font.glyphs[cp]).toBeUndefined();
                        expect(cp).not.toBe(NEWLINE);
                    }

                    // (4) SUGGESTION VALIDITY.
                    if (result.missing.length === 0) {
                        expect(result.suggestion).toBeUndefined();
                    } else if (result.suggestion !== undefined) {
                        const suggested = fontByName.get(result.suggestion);
                        expect(suggested).toBeDefined();
                        expect(result.suggestion).not.toBe(fontName);
                        for (const cp of result.missing) {
                            expect(suggested!.glyphs[cp]).toBeDefined();
                        }
                    }

                    // (5) NO-MISSING ⇒ RENDERED. If nothing is missing and the
                    // text contains at least one supported glyph that actually
                    // has strokes, the renderer must emit some polylines.
                    if (result.missing.length === 0) {
                        let hasInkGlyph = false;
                        for (const ch of text) {
                            const cp = ch.codePointAt(0)!;
                            if (cp === NEWLINE) continue;
                            const g = font.glyphs[cp];
                            if (g !== undefined && g.strokes.length > 0) {
                                hasInkGlyph = true;
                                break;
                            }
                        }
                        if (hasInkGlyph) {
                            expect(result.polylines.length).toBeGreaterThan(0);
                        }
                    }
                },
            ),
            { numRuns: 300 },
        );
    });
});
