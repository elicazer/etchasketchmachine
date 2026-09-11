import { describe, it, expect } from 'vitest';
import { createTextRenderer, type TextOptions } from './text_renderer';

/**
 * Unit tests for the Text_Renderer module.
 *
 * Cover Requirements 3.1 (single-line stroke rendering), 3.2 (≥5 fonts),
 * 3.3 (font size 5–100 mm, letter spacing 0–200 %), and 3.5 (unsupported
 * codepoint detection + covering-font suggestion). The exhaustive
 * "missing matches the unsupported set" property is task 18.2.
 */

const cp = (ch: string) => ch.codePointAt(0)!;

/** Axis-aligned bounding box over a flat list of polylines. */
function bbox(polylines: { x: number; y: number }[][]) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pl of polylines) {
        for (const p of pl) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

const baseOpts: TextOptions = {
    fontName: 'Simplex',
    fontSizeMm: 12,
    letterSpacingPct: 0,
};

describe('fonts()', () => {
    it('returns at least 5 fonts with distinct names', () => {
        const renderer = createTextRenderer();
        const fonts = renderer.fonts();
        expect(fonts.length).toBeGreaterThanOrEqual(5);
        const names = fonts.map((f) => f.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('every bundled font covers printable ASCII 0x20–0x7E', () => {
        const renderer = createTextRenderer();
        for (const font of renderer.fonts()) {
            for (let c = 0x20; c <= 0x7e; c++) {
                expect(
                    font.glyphs[c],
                    `font ${font.name} missing U+${c.toString(16)}`,
                ).toBeDefined();
            }
        }
    });
});

describe('render() layout', () => {
    it('returns non-empty strokes and offsets the second glyph to the right', () => {
        const renderer = createTextRenderer();
        const font = renderer.fonts().find((f) => f.name === 'Simplex')!;
        const aGlyph = font.glyphs[cp('A')]!;
        const aStrokeCount = aGlyph.strokes.length;

        const { polylines } = renderer.render('AB', baseOpts);
        expect(polylines.length).toBeGreaterThan(0);
        // 'A' contributes its strokes first, then 'B'.
        expect(polylines.length).toBe(
            aStrokeCount + font.glyphs[cp('B')]!.strokes.length,
        );

        const aStrokes = polylines.slice(0, aStrokeCount);
        const bStrokes = polylines.slice(aStrokeCount);

        const scale = baseOpts.fontSizeMm / font.unitsPerEm; // = 1
        const expectedOffset = aGlyph.advance * scale; // spacing 0%

        const dx = bbox(bStrokes).minX - bbox(aStrokes).minX;
        expect(dx).toBeCloseTo(expectedOffset, 5);
    });

    it('letter spacing increases horizontal extent (0% vs 200%)', () => {
        const renderer = createTextRenderer();
        const narrow = renderer.render('AB', { ...baseOpts, letterSpacingPct: 0 });
        const wide = renderer.render('AB', { ...baseOpts, letterSpacingPct: 200 });
        expect(bbox(wide.polylines).w).toBeGreaterThan(bbox(narrow.polylines).w);
    });

    it('font size scales geometry linearly (2x size -> ~2x bbox height)', () => {
        const renderer = createTextRenderer();
        const small = renderer.render('A', { ...baseOpts, fontSizeMm: 20 });
        const large = renderer.render('A', { ...baseOpts, fontSizeMm: 40 });
        const ratio = bbox(large.polylines).h / bbox(small.polylines).h;
        expect(ratio).toBeCloseTo(2, 5);
    });

    it('applies the position offset to every emitted point', () => {
        const renderer = createTextRenderer();
        const atOrigin = renderer.render('A', baseOpts);
        const shifted = renderer.render('A', {
            ...baseOpts,
            position: { x: 50, y: 30 },
        });
        const a = bbox(atOrigin.polylines);
        const b = bbox(shifted.polylines);
        expect(b.minX - a.minX).toBeCloseTo(50, 5);
        expect(b.minY - a.minY).toBeCloseTo(30, 5);
    });

    it('renders text with no missing codepoints for plain ASCII', () => {
        const renderer = createTextRenderer();
        const { missing, suggestion } = renderer.render('Hello, World!', baseOpts);
        expect(missing).toEqual([]);
        expect(suggestion).toBeUndefined();
    });
});

describe('render() missing codepoints and suggestions', () => {
    it('reports an unsupported emoji codepoint in missing', () => {
        const renderer = createTextRenderer();
        const { missing } = renderer.render('A\u{1F600}B', baseOpts);
        expect(missing).toContain(0x1f600);
    });

    it('suggests a bundled font that covers the missing codepoints', () => {
        const renderer = createTextRenderer();
        // The degree sign (U+00B0) exists only in "Simplex". Rendering it
        // with "Mono" yields a missing codepoint and a covering suggestion.
        const result = renderer.render('\u00B0', {
            fontName: 'Mono',
            fontSizeMm: 12,
            letterSpacingPct: 0,
        });
        expect(result.missing).toEqual([0x00b0]);
        expect(result.suggestion).toBe('Simplex');
    });

    it('omits a suggestion when no bundled font covers the missing set', () => {
        const renderer = createTextRenderer();
        const result = renderer.render('\u{1F600}', baseOpts);
        expect(result.missing).toEqual([0x1f600]);
        expect(result.suggestion).toBeUndefined();
    });
});

describe('render() option validation', () => {
    it('throws RangeError when fontSizeMm is below 5 or above 100', () => {
        const renderer = createTextRenderer();
        expect(() => renderer.render('A', { ...baseOpts, fontSizeMm: 4 })).toThrow(
            RangeError,
        );
        expect(() =>
            renderer.render('A', { ...baseOpts, fontSizeMm: 101 }),
        ).toThrow(RangeError);
    });

    it('accepts the inclusive font-size bounds 5 and 100', () => {
        const renderer = createTextRenderer();
        expect(() => renderer.render('A', { ...baseOpts, fontSizeMm: 5 })).not.toThrow();
        expect(() =>
            renderer.render('A', { ...baseOpts, fontSizeMm: 100 }),
        ).not.toThrow();
    });

    it('throws RangeError when letterSpacingPct is below 0 or above 200', () => {
        const renderer = createTextRenderer();
        expect(() =>
            renderer.render('A', { ...baseOpts, letterSpacingPct: -1 }),
        ).toThrow(RangeError);
        expect(() =>
            renderer.render('A', { ...baseOpts, letterSpacingPct: 201 }),
        ).toThrow(RangeError);
    });

    it('throws RangeError for an unknown font name', () => {
        const renderer = createTextRenderer();
        expect(() =>
            renderer.render('A', { ...baseOpts, fontName: 'NoSuchFont' }),
        ).toThrow(RangeError);
    });
});

describe('render() newlines', () => {
    it('moves subsequent lines downward (+Y up convention)', () => {
        const renderer = createTextRenderer();
        const single = renderer.render('A', baseOpts);
        const twoLines = renderer.render('A\nA', baseOpts);
        // The second line sits below the first, so the overall bbox extends
        // further down (smaller minY) than a single line.
        expect(bbox(twoLines.polylines).minY).toBeLessThan(
            bbox(single.polylines).minY,
        );
    });
});
