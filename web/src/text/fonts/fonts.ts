/**
 * Bundled single-line stroke fonts.
 *
 * We ship one compact, hand-authored Hershey-style ASCII base
 * (`base_ascii.ts`) and derive five DISTINCT, selectable fonts from it via
 * deterministic geometry transforms. Every derived font is still a pure
 * single-line (stroke) font — the transforms only move/round existing
 * stroke points, they never add fills — so the output stays drawable by a
 * pen that cannot lift (Req 3.1, 3.2).
 *
 * The five fonts:
 *   1. `Simplex`   — the base font, unmodified (plus a couple of extended
 *                    glyphs so the missing-codepoint suggestion path has
 *                    real coverage differences to work with).
 *   2. `Slant`     — italic shear (x' = x + k·y).
 *   3. `Script`    — corners rounded with one Chaikin corner-cutting pass.
 *   4. `SmallCaps` — lowercase letters replaced by scaled-down capitals.
 *   5. `Mono`      — fixed advance width with ink centred in the cell.
 *
 * Because the renderer only depends on the `StrokeFont` shape, the full
 * Hershey set (or any other single-line font) can be added later as more
 * `StrokeFont` records with no API change (Design §3.1.2).
 *
 * @see Design §3.1.2
 * @see Requirements 3.1, 3.2, 3.5
 */

import type { Point, Polyline } from '../../types';
import {
    buildBaseGlyphs,
    FONT_UNITS_PER_EM,
    type Glyph,
    type StrokeFont,
} from './base_ascii';

// -----------------------------------------------------------------------------
// Small geometry helpers (pure; operate on fresh copies)
// -----------------------------------------------------------------------------

/** Deep-copy a glyph dictionary so transforms never alias the base data. */
function cloneGlyphs(src: Record<number, Glyph>): Record<number, Glyph> {
    const out: Record<number, Glyph> = {};
    for (const [cp, g] of Object.entries(src)) {
        out[Number(cp)] = {
            advance: g.advance,
            strokes: g.strokes.map((s) => s.map((p) => ({ x: p.x, y: p.y }))),
        };
    }
    return out;
}

/** Apply a point→point map to every stroke point of every glyph. */
function mapPoints(
    glyphs: Record<number, Glyph>,
    fn: (p: Point, g: Glyph) => Point,
): Record<number, Glyph> {
    for (const g of Object.values(glyphs)) {
        g.strokes = g.strokes.map((s) => s.map((p) => fn(p, g)));
    }
    return glyphs;
}

// -----------------------------------------------------------------------------
// Transform: Slant (italic shear)
// -----------------------------------------------------------------------------

const SLANT_SHEAR = 0.25;

function makeSlant(base: Record<number, Glyph>): Record<number, Glyph> {
    return mapPoints(cloneGlyphs(base), (p) => ({
        x: p.x + SLANT_SHEAR * p.y,
        y: p.y,
    }));
}

// -----------------------------------------------------------------------------
// Transform: Script (one Chaikin corner-cutting pass, endpoints preserved)
// -----------------------------------------------------------------------------

/**
 * One iteration of Chaikin's corner-cutting on an open polyline, keeping
 * the first and last points fixed. Straight 2-point strokes are returned
 * unchanged. Produces visibly rounded joints — genuinely different glyph
 * geometry while remaining a single open stroke.
 */
function chaikinOnce(stroke: Polyline): Polyline {
    if (stroke.length < 3) return stroke.map((p) => ({ x: p.x, y: p.y }));
    const out: Point[] = [{ x: stroke[0]!.x, y: stroke[0]!.y }];
    for (let i = 0; i < stroke.length - 1; i++) {
        const a = stroke[i]!;
        const b = stroke[i + 1]!;
        out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
        out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    const last = stroke[stroke.length - 1]!;
    out.push({ x: last.x, y: last.y });
    return out;
}

function makeScript(base: Record<number, Glyph>): Record<number, Glyph> {
    const g = cloneGlyphs(base);
    for (const glyph of Object.values(g)) {
        glyph.strokes = glyph.strokes.map(chaikinOnce);
    }
    return g;
}

// -----------------------------------------------------------------------------
// Transform: SmallCaps (lowercase → scaled capitals)
// -----------------------------------------------------------------------------

const SMALL_CAPS_SCALE = 0.72;
const LOWER_A = 'a'.codePointAt(0)!;
const LOWER_Z = 'z'.codePointAt(0)!;
const UPPER_A = 'A'.codePointAt(0)!;

function makeSmallCaps(base: Record<number, Glyph>): Record<number, Glyph> {
    const g = cloneGlyphs(base);
    for (let cp = LOWER_A; cp <= LOWER_Z; cp++) {
        const cap = base[cp - LOWER_A + UPPER_A];
        if (cap === undefined) continue;
        g[cp] = {
            advance: cap.advance * SMALL_CAPS_SCALE,
            strokes: cap.strokes.map((s) =>
                s.map((p) => ({
                    x: p.x * SMALL_CAPS_SCALE,
                    y: p.y * SMALL_CAPS_SCALE,
                })),
            ),
        };
    }
    return g;
}

// -----------------------------------------------------------------------------
// Transform: Mono (fixed advance, ink centred in the cell)
// -----------------------------------------------------------------------------

const MONO_ADVANCE = 9;

function makeMono(base: Record<number, Glyph>): Record<number, Glyph> {
    const g = cloneGlyphs(base);
    for (const glyph of Object.values(g)) {
        if (glyph.strokes.length > 0) {
            let minX = Infinity;
            let maxX = -Infinity;
            for (const s of glyph.strokes) {
                for (const p of s) {
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                }
            }
            const shift = MONO_ADVANCE / 2 - (minX + maxX) / 2;
            glyph.strokes = glyph.strokes.map((s) =>
                s.map((p) => ({ x: p.x + shift, y: p.y })),
            );
        }
        glyph.advance = MONO_ADVANCE;
    }
    return g;
}

// -----------------------------------------------------------------------------
// Transform: Outline (single-line centerline → closed double-line contour)
//
// Each open single-stroke is converted into a closed loop that traces BOTH
// sides of the stroke (offset by ±halfWidth along the per-vertex miter normal)
// joined by butt caps at each end. The result reads as "double-lined" /
// bubble-letter text — two parallel lines per stroke — while remaining a set of
// polylines a non-lifting pen can draw. An optional Chaikin pass rounds the
// joints so the letters look smooth rather than boxy.
// -----------------------------------------------------------------------------

/** Drop consecutive duplicate points so normals are well-defined. */
function dedupePoints(stroke: Polyline): Point[] {
    const out: Point[] = [];
    for (const p of stroke) {
        const last = out[out.length - 1];
        if (last === undefined || last.x !== p.x || last.y !== p.y) {
            out.push({ x: p.x, y: p.y });
        }
    }
    return out;
}

/** Maximum miter extension (in halfWidth units) before a sharp join is clamped. */
const MITER_LIMIT = 2.2;

/**
 * Convert one open centerline stroke into a closed outline loop of total width
 * `2 * halfWidth`. Degenerate strokes (0/1 distinct points) become a small
 * diamond so dots like the one over "i" still read as ink.
 */
function strokeToOutline(stroke: Polyline, halfWidth: number): Polyline {
    const pts = dedupePoints(stroke);
    if (pts.length === 0) return [];
    if (pts.length === 1) {
        const p = pts[0]!;
        const w = halfWidth;
        return [
            { x: p.x - w, y: p.y },
            { x: p.x, y: p.y + w },
            { x: p.x + w, y: p.y },
            { x: p.x, y: p.y - w },
            { x: p.x - w, y: p.y },
        ];
    }

    const n = pts.length;
    // Left-hand unit normal of each segment: rotate the direction +90°.
    const segNormal: Point[] = [];
    for (let i = 0; i < n - 1; i++) {
        const dx = pts[i + 1]!.x - pts[i]!.x;
        const dy = pts[i + 1]!.y - pts[i]!.y;
        const len = Math.hypot(dx, dy) || 1;
        segNormal.push({ x: -dy / len, y: dx / len });
    }

    const left: Point[] = [];
    const right: Point[] = [];
    for (let i = 0; i < n; i++) {
        let nx: number;
        let ny: number;
        if (i === 0) {
            nx = segNormal[0]!.x;
            ny = segNormal[0]!.y;
        } else if (i === n - 1) {
            nx = segNormal[n - 2]!.x;
            ny = segNormal[n - 2]!.y;
        } else {
            // Miter normal = normalised sum of the two adjacent segment
            // normals, scaled by 1/cos(halfAngle) so the offset lines stay
            // parallel through the joint (clamped to avoid spikes at sharp
            // corners).
            let ax = segNormal[i - 1]!.x + segNormal[i]!.x;
            let ay = segNormal[i - 1]!.y + segNormal[i]!.y;
            const al = Math.hypot(ax, ay);
            if (al < 1e-6) {
                nx = segNormal[i]!.x;
                ny = segNormal[i]!.y;
            } else {
                ax /= al;
                ay /= al;
                const cos = ax * segNormal[i]!.x + ay * segNormal[i]!.y;
                const scale = cos > 1e-3 ? Math.min(1 / cos, MITER_LIMIT) : 1;
                nx = ax * scale;
                ny = ay * scale;
            }
        }
        left.push({ x: pts[i]!.x + nx * halfWidth, y: pts[i]!.y + ny * halfWidth });
        right.push({ x: pts[i]!.x - nx * halfWidth, y: pts[i]!.y - ny * halfWidth });
    }

    // Closed loop: down the left side, butt cap, back up the right side, close.
    const loop: Point[] = [];
    for (const p of left) loop.push(p);
    for (let i = n - 1; i >= 0; i--) loop.push(right[i]!);
    loop.push({ x: left[0]!.x, y: left[0]!.y });
    return loop;
}

/**
 * Build an outline (double-line) font from the base: every glyph stroke is
 * replaced by its closed outline contour. When `smooth` is set, one Chaikin
 * pass rounds the joints so the letters read smoothly rather than boxy.
 */
function makeOutline(
    base: Record<number, Glyph>,
    halfWidth: number,
    smooth: boolean,
): Record<number, Glyph> {
    const g = cloneGlyphs(base);
    for (const glyph of Object.values(g)) {
        glyph.strokes = glyph.strokes.map((s) => {
            const outline = strokeToOutline(s, halfWidth);
            return smooth ? chaikinOnce(outline) : outline;
        });
    }
    return g;
}

// -----------------------------------------------------------------------------
// Extended glyphs (used to give the fonts genuinely different codepoint
// coverage so the missing-codepoint suggestion path in Req 3.5 is real).
// -----------------------------------------------------------------------------

/** U+00B0 DEGREE SIGN as a small single-stroke ring near cap height. */
const DEGREE_SIGN = 0x00b0;
const DEGREE_GLYPH: Glyph = {
    advance: 5,
    strokes: [
        [
            { x: 2, y: 12 },
            { x: 1, y: 11 },
            { x: 1, y: 10 },
            { x: 2, y: 9 },
            { x: 3, y: 9 },
            { x: 4, y: 10 },
            { x: 4, y: 11 },
            { x: 3, y: 12 },
            { x: 2, y: 12 },
        ],
    ],
};

// -----------------------------------------------------------------------------
// Font registry
// -----------------------------------------------------------------------------

/**
 * Build all bundled fonts fresh. Returns independent objects on every call
 * so a caller mutating one font's glyph table cannot corrupt the shared
 * base data or other fonts.
 */
export function buildBundledFonts(): StrokeFont[] {
    const base = buildBaseGlyphs();

    // Simplex carries the extended DEGREE glyph; the other fonts do not,
    // which is what lets render() suggest "Simplex" when text containing a
    // degree sign is shaped with, say, "Mono" (Req 3.5).
    const simplexGlyphs = cloneGlyphs(base);
    simplexGlyphs[DEGREE_SIGN] = {
        advance: DEGREE_GLYPH.advance,
        strokes: DEGREE_GLYPH.strokes.map((s) => s.map((p) => ({ ...p }))),
    };

    return [
        // Showcase first (becomes the default): smooth double-line letters.
        { name: 'Outline', unitsPerEm: FONT_UNITS_PER_EM, glyphs: makeOutline(base, 0.55, true) },
        { name: 'Outline Bold', unitsPerEm: FONT_UNITS_PER_EM, glyphs: makeOutline(base, 0.95, true) },
        { name: 'Simplex', unitsPerEm: FONT_UNITS_PER_EM, glyphs: simplexGlyphs },
        { name: 'Slant', unitsPerEm: FONT_UNITS_PER_EM, glyphs: makeSlant(base) },
        { name: 'Script', unitsPerEm: FONT_UNITS_PER_EM, glyphs: makeScript(base) },
        {
            name: 'SmallCaps',
            unitsPerEm: FONT_UNITS_PER_EM,
            glyphs: makeSmallCaps(base),
        },
        { name: 'Mono', unitsPerEm: FONT_UNITS_PER_EM, glyphs: makeMono(base) },
    ];
}

export type { StrokeFont, Glyph } from './base_ascii';
