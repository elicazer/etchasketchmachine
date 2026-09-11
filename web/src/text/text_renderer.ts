/**
 * `Text_Renderer` — shapes a string into positioned single-line stroke
 * polylines using bundled Hershey-style fonts.
 *
 * Responsibilities (Design §3.1.2, Req 3.1–3.6):
 *   - expose ≥ 5 selectable single-line stroke fonts (Req 3.2);
 *   - shape text into positioned glyph polylines honouring font size
 *     (5–100 mm cap height) and letter spacing (0–200 % of glyph width)
 *     (Req 3.3);
 *   - report codepoints the selected font cannot draw, and suggest another
 *     bundled font that covers all of them when one exists (Req 3.5).
 *
 * The renderer is pure: same inputs → same outputs, no DOM, no globals.
 * Output polylines are in millimetre space with +Y up, consistent with the
 * drawable-area convention used by the rest of the path pipeline. Callers
 * feed these straight into `Path_Planner.plan` (scale/clamp → steps).
 *
 * @see Design §3.1.2
 * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import type { Point, Polyline } from '../types';
import {
    FONT_SIZE_MM_MAX,
    FONT_SIZE_MM_MIN,
    LETTER_SPACING_PCT_MAX,
    LETTER_SPACING_PCT_MIN,
} from '../validators';
import { buildBundledFonts, type StrokeFont } from './fonts/fonts';

/**
 * Vertical distance between successive text baselines, expressed in
 * em multiples (cap heights). A newline moves the pen down by this much.
 */
export const LINE_HEIGHT_EM = 1.2;

/**
 * Options controlling a single `render` call.
 *
 * `fontSizeMm` is the rendered capital-letter height in millimetres and
 * must lie in `[5, 100]`. `letterSpacingPct` adds inter-glyph space as a
 * percentage of each glyph's advance and must lie in `[0, 200]`.
 * `position` shifts the whole result; it defaults to the origin `(0, 0)`.
 */
export interface TextOptions {
    fontName: string;
    fontSizeMm: number;
    letterSpacingPct: number;
    position?: Point;
}

/** Result of shaping a string: positioned strokes plus coverage info. */
export interface RenderResult {
    /** All glyph strokes, positioned in millimetre space (+Y up). */
    polylines: Polyline[];
    /** Sorted, de-duplicated codepoints with no glyph in the chosen font. */
    missing: number[];
    /** A bundled font covering every missing codepoint, if one exists. */
    suggestion?: string;
}

/** Public interface (mirrors Design §3.1.2). */
export interface TextRenderer {
    fonts(): StrokeFont[];
    render(text: string, opts: TextOptions): RenderResult;
}

/**
 * Create a `Text_Renderer` backed by the bundled stroke fonts.
 *
 * The font set is built once per renderer instance. Construction is cheap
 * (a handful of small geometry transforms over an ASCII glyph table), so
 * tests and UI panels can freely create their own instances.
 */
export function createTextRenderer(): TextRenderer {
    const fontList = buildBundledFonts();
    const byName = new Map<string, StrokeFont>();
    for (const f of fontList) byName.set(f.name, f);

    return {
        fonts(): StrokeFont[] {
            return fontList;
        },
        render(text: string, opts: TextOptions): RenderResult {
            return renderText(fontList, byName, text, opts);
        },
    };
}

// -----------------------------------------------------------------------------
// Core shaping
// -----------------------------------------------------------------------------

function renderText(
    fontList: StrokeFont[],
    byName: Map<string, StrokeFont>,
    text: string,
    opts: TextOptions,
): RenderResult {
    validateOptions(opts);

    const font = byName.get(opts.fontName);
    if (font === undefined) {
        throw new RangeError(
            `Unknown font "${opts.fontName}". Available: ${fontList
                .map((f) => f.name)
                .join(', ')}`,
        );
    }

    // Design units → mm. Cap height spans `unitsPerEm` design units and
    // should equal `fontSizeMm`, so scale = fontSizeMm / unitsPerEm.
    const scale = opts.fontSizeMm / font.unitsPerEm;
    const spacingFactor = 1 + opts.letterSpacingPct / 100;
    const originX = opts.position?.x ?? 0;
    const originY = opts.position?.y ?? 0;
    const lineStepMm = LINE_HEIGHT_EM * opts.fontSizeMm;

    const polylines: Polyline[] = [];
    const missingSet = new Set<number>();

    let penX = originX;
    let penY = originY;

    // Iterate by Unicode codepoint so astral characters (e.g. emoji) are
    // handled as single units and correctly reported as missing.
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;

        if (cp === 0x0a) {
            // Newline: carriage return + line feed downward (+Y up → subtract).
            penX = originX;
            penY -= lineStepMm;
            continue;
        }

        const glyph = font.glyphs[cp];
        if (glyph === undefined) {
            missingSet.add(cp);
            // Advance by the font's space width so layout stays stable even
            // when a glyph is missing; use the space glyph advance if present.
            const fallback = font.glyphs[0x20];
            const advanceUnits = fallback?.advance ?? font.unitsPerEm * 0.5;
            penX += advanceUnits * scale * spacingFactor;
            continue;
        }

        for (const stroke of glyph.strokes) {
            const positioned: Point[] = stroke.map((p) => ({
                x: penX + p.x * scale,
                y: penY + p.y * scale,
            }));
            polylines.push(positioned);
        }

        penX += glyph.advance * scale * spacingFactor;
    }

    const missing = [...missingSet].sort((a, b) => a - b);
    const result: RenderResult = { polylines, missing };

    if (missing.length > 0) {
        const suggestion = findCoveringFont(fontList, opts.fontName, missing);
        if (suggestion !== undefined) result.suggestion = suggestion;
    }

    return result;
}

/**
 * Find a bundled font (other than `currentFont`) whose glyph table covers
 * every codepoint in `missing`. Returns the first such font in bundle
 * order, or `undefined` if none covers them all.
 */
function findCoveringFont(
    fontList: StrokeFont[],
    currentFont: string,
    missing: number[],
): string | undefined {
    for (const f of fontList) {
        if (f.name === currentFont) continue;
        if (missing.every((cp) => f.glyphs[cp] !== undefined)) {
            return f.name;
        }
    }
    return undefined;
}

/**
 * Validate render options, mirroring the bounds in `validators.ts` so the
 * renderer rejects out-of-range geometry before producing strokes.
 * Throws `RangeError` on violation (Req 3.3).
 */
function validateOptions(opts: TextOptions): void {
    const { fontSizeMm, letterSpacingPct } = opts;
    if (
        typeof fontSizeMm !== 'number' ||
        !Number.isFinite(fontSizeMm) ||
        fontSizeMm < FONT_SIZE_MM_MIN ||
        fontSizeMm > FONT_SIZE_MM_MAX
    ) {
        throw new RangeError(
            `fontSizeMm must be in [${FONT_SIZE_MM_MIN}, ${FONT_SIZE_MM_MAX}] mm, got ${fontSizeMm}`,
        );
    }
    if (
        typeof letterSpacingPct !== 'number' ||
        !Number.isFinite(letterSpacingPct) ||
        letterSpacingPct < LETTER_SPACING_PCT_MIN ||
        letterSpacingPct > LETTER_SPACING_PCT_MAX
    ) {
        throw new RangeError(
            `letterSpacingPct must be in [${LETTER_SPACING_PCT_MIN}, ${LETTER_SPACING_PCT_MAX}] %, got ${letterSpacingPct}`,
        );
    }
}

export type { StrokeFont } from './fonts/fonts';
