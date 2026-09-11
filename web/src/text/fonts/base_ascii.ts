/**
 * Compact built-in single-line (stroke) vector font for printable ASCII.
 *
 * This is a Hershey-style single-stroke font: every glyph is one or more
 * open polylines drawn with a zero-width pen, exactly the geometry an
 * Etch-a-Sketch stylus can trace. Glyphs deliberately use straight-segment
 * approximations of curves so the data stays tiny (well under the 120 KB
 * SPA budget, Design §2.4.1) while remaining legible.
 *
 * Coordinate system (a "unit-em box"):
 *   - x increases to the right, y increases UP (matching the drawable-area
 *     convention where +Y is up, see `constants.ts`).
 *   - The baseline is at y = 0, capital letters span y ∈ [0, 12], so the
 *     cap height equals `FONT_UNITS_PER_EM`. This makes `fontSizeMm` map
 *     directly onto rendered capital-letter height (Req 3.3).
 *   - Lowercase x-height is 7, ascenders reach 12, descenders reach −4.
 *
 * The full Hershey set (hundreds of glyphs, Latin/Greek/symbol coverage)
 * can be dropped in later as additional `StrokeFont` records without any
 * API change — `Text_Renderer` only depends on the `StrokeFont` shape.
 *
 * @see Design §3.1.2 (Text_Renderer), §2.4.1 (bundle budget)
 * @see Requirements 3.1, 3.2
 */

import type { Polyline } from '../../types';

/**
 * Cap height of the base font, in design units. Capital letters span
 * `[0, FONT_UNITS_PER_EM]` vertically, so `fontSizeMm / FONT_UNITS_PER_EM`
 * is the millimetres-per-design-unit scale applied at render time.
 */
export const FONT_UNITS_PER_EM = 12;

/**
 * One glyph: a horizontal advance width (in design units) plus the list
 * of single-line strokes that draw it. An empty `strokes` array is a
 * valid glyph (e.g. the space character) that only advances the pen.
 */
export interface Glyph {
    /** Pen advance after this glyph, in design units (pre-scale). */
    advance: number;
    /** Single-line strokes in unit-em coordinates. */
    strokes: Polyline[];
}

/**
 * A selectable single-line stroke font: a name, the design-unit cap
 * height, and a codepoint→glyph dictionary. Codepoints with no entry are
 * "unsupported" for that font (surfaced via `render(...).missing`).
 */
export interface StrokeFont {
    name: string;
    unitsPerEm: number;
    glyphs: Record<number, Glyph>;
}

/**
 * Raw glyph data keyed by character for readability. Each stroke is a
 * flat list of `[x, y]` pairs. Compiled to `Glyph` records by
 * {@link buildBaseGlyphs}.
 */
type RawGlyph = { a: number; s: number[][][] };

// Authored at a 0..8-ish width / 0..12 height grid. Curves are polygonal
// approximations — good enough for a knob-driven stylus and very compact.
const RAW: Record<string, RawGlyph> = {
    ' ': { a: 7, s: [] },
    '!': { a: 3, s: [[[1, 12], [1, 3]], [[1, 1], [1, 0]]] },
    '"': { a: 4, s: [[[1, 12], [1, 9]], [[3, 12], [3, 9]]] },
    '#': { a: 8, s: [[[2, 12], [1, 0]], [[5, 12], [4, 0]], [[0, 8], [6, 8]], [[0, 4], [6, 4]]] },
    $: { a: 7, s: [[[5, 9], [3, 10], [1, 9], [1, 7], [5, 5], [5, 3], [3, 2], [1, 3]], [[3, 12], [3, 0]]] },
    '%': {
        a: 8,
        s: [
            [[0, 0], [6, 12]],
            [[1, 12], [2, 12], [2, 10], [1, 10], [1, 12]],
            [[4, 2], [5, 2], [5, 0], [4, 0], [4, 2]],
        ],
    },
    '&': { a: 8, s: [[[6, 0], [2, 7], [1, 9], [2, 11], [4, 11], [5, 9], [1, 3], [1, 1], [3, 0], [5, 2], [6, 4]]] },
    "'": { a: 2, s: [[[1, 12], [1, 9]]] },
    '(': { a: 4, s: [[[3, 12], [1, 9], [1, 3], [3, 0]]] },
    ')': { a: 4, s: [[[1, 12], [3, 9], [3, 3], [1, 0]]] },
    '*': { a: 6, s: [[[3, 10], [3, 4]], [[1, 9], [5, 5]], [[5, 9], [1, 5]]] },
    '+': { a: 8, s: [[[3, 9], [3, 3]], [[0, 6], [6, 6]]] },
    ',': { a: 3, s: [[[2, 1], [1, -2]]] },
    '-': { a: 8, s: [[[1, 6], [5, 6]]] },
    '.': { a: 3, s: [[[1, 1], [1, 0]]] },
    '/': { a: 6, s: [[[0, 0], [5, 12]]] },
    '0': { a: 8, s: [[[2, 0], [0, 2], [0, 10], [2, 12], [4, 12], [6, 10], [6, 2], [4, 0], [2, 0]]] },
    '1': { a: 8, s: [[[1, 10], [3, 12], [3, 0]], [[1, 0], [5, 0]]] },
    '2': { a: 8, s: [[[0, 10], [2, 12], [4, 12], [6, 10], [6, 8], [0, 0], [6, 0]]] },
    '3': { a: 8, s: [[[0, 12], [6, 12], [3, 7], [5, 7], [6, 5], [6, 2], [4, 0], [2, 0], [0, 2]]] },
    '4': { a: 8, s: [[[4, 0], [4, 12], [0, 4], [6, 4]]] },
    '5': { a: 8, s: [[[6, 12], [1, 12], [0, 7], [2, 8], [4, 8], [6, 6], [6, 2], [4, 0], [2, 0], [0, 2]]] },
    '6': { a: 8, s: [[[6, 10], [4, 12], [2, 12], [0, 10], [0, 2], [2, 0], [4, 0], [6, 2], [6, 5], [4, 7], [2, 7], [0, 5]]] },
    '7': { a: 8, s: [[[0, 12], [6, 12], [2, 0]]] },
    '8': {
        a: 8,
        s: [[[2, 6], [0, 8], [0, 10], [2, 12], [4, 12], [6, 10], [6, 8], [4, 6], [2, 6], [0, 4], [0, 2], [2, 0], [4, 0], [6, 2], [6, 4], [4, 6]]],
    },
    '9': { a: 8, s: [[[0, 2], [2, 0], [4, 0], [6, 2], [6, 10], [4, 12], [2, 12], [0, 10], [0, 7], [2, 5], [4, 5], [6, 7]]] },
    ':': { a: 3, s: [[[1, 7], [1, 6]], [[1, 2], [1, 1]]] },
    ';': { a: 3, s: [[[1, 7], [1, 6]], [[2, 2], [1, -1]]] },
    '<': { a: 8, s: [[[5, 10], [1, 6], [5, 2]]] },
    '=': { a: 8, s: [[[1, 8], [5, 8]], [[1, 4], [5, 4]]] },
    '>': { a: 8, s: [[[1, 10], [5, 6], [1, 2]]] },
    '?': { a: 7, s: [[[0, 10], [2, 12], [4, 12], [6, 10], [6, 8], [3, 5], [3, 3]], [[3, 1], [3, 0]]] },
    '@': {
        a: 9,
        s: [[[5, 4], [4, 5], [3, 4], [3, 3], [4, 2], [5, 3], [5, 5], [4, 6], [2, 6], [1, 4], [1, 2], [3, 0], [5, 0], [7, 2], [7, 8], [5, 10], [2, 10], [0, 8], [0, 4], [2, 0]]],
    },
    A: { a: 8, s: [[[0, 0], [3, 12], [6, 0]], [[1, 4], [5, 4]]] },
    B: { a: 8, s: [[[0, 0], [0, 12]], [[0, 12], [4, 12], [6, 10], [6, 8], [4, 6], [0, 6]], [[0, 6], [4, 6], [6, 4], [6, 2], [4, 0], [0, 0]]] },
    C: { a: 8, s: [[[6, 9], [5, 11], [3, 12], [2, 12], [0, 10], [0, 2], [2, 0], [3, 0], [5, 1], [6, 3]]] },
    D: { a: 8, s: [[[0, 0], [0, 12], [3, 12], [5, 10], [6, 8], [6, 4], [5, 2], [3, 0], [0, 0]]] },
    E: { a: 8, s: [[[6, 12], [0, 12], [0, 0], [6, 0]], [[0, 6], [4, 6]]] },
    F: { a: 8, s: [[[6, 12], [0, 12], [0, 0]], [[0, 6], [4, 6]]] },
    G: { a: 8, s: [[[6, 9], [5, 11], [3, 12], [2, 12], [0, 10], [0, 2], [2, 0], [4, 0], [6, 2], [6, 5], [4, 5]]] },
    H: { a: 8, s: [[[0, 0], [0, 12]], [[6, 0], [6, 12]], [[0, 6], [6, 6]]] },
    I: { a: 5, s: [[[0, 0], [4, 0]], [[2, 0], [2, 12]], [[0, 12], [4, 12]]] },
    J: { a: 8, s: [[[5, 12], [5, 2], [3, 0], [1, 0], [0, 2], [0, 3]]] },
    K: { a: 8, s: [[[0, 0], [0, 12]], [[6, 12], [0, 6]], [[2, 8], [6, 0]]] },
    L: { a: 8, s: [[[0, 12], [0, 0], [6, 0]]] },
    M: { a: 10, s: [[[0, 0], [0, 12], [4, 6], [8, 12], [8, 0]]] },
    N: { a: 8, s: [[[0, 0], [0, 12], [6, 0], [6, 12]]] },
    O: { a: 8, s: [[[2, 0], [0, 2], [0, 10], [2, 12], [4, 12], [6, 10], [6, 2], [4, 0], [2, 0]]] },
    P: { a: 8, s: [[[0, 0], [0, 12], [4, 12], [6, 10], [6, 8], [4, 6], [0, 6]]] },
    Q: { a: 8, s: [[[2, 0], [0, 2], [0, 10], [2, 12], [4, 12], [6, 10], [6, 2], [4, 0], [2, 0]], [[3, 3], [6, -1]]] },
    R: { a: 8, s: [[[0, 0], [0, 12], [4, 12], [6, 10], [6, 8], [4, 6], [0, 6]], [[3, 6], [6, 0]]] },
    S: { a: 8, s: [[[6, 10], [4, 12], [2, 12], [0, 10], [0, 8], [2, 6], [4, 6], [6, 4], [6, 2], [4, 0], [2, 0], [0, 2]]] },
    T: { a: 8, s: [[[0, 12], [6, 12]], [[3, 12], [3, 0]]] },
    U: { a: 8, s: [[[0, 12], [0, 2], [2, 0], [4, 0], [6, 2], [6, 12]]] },
    V: { a: 8, s: [[[0, 12], [3, 0], [6, 12]]] },
    W: { a: 10, s: [[[0, 12], [2, 0], [4, 8], [6, 0], [8, 12]]] },
    X: { a: 8, s: [[[0, 0], [6, 12]], [[0, 12], [6, 0]]] },
    Y: { a: 8, s: [[[0, 12], [3, 6], [6, 12]], [[3, 6], [3, 0]]] },
    Z: { a: 8, s: [[[0, 12], [6, 12], [0, 0], [6, 0]]] },
    '[': { a: 4, s: [[[3, 12], [1, 12], [1, 0], [3, 0]]] },
    '\\': { a: 6, s: [[[0, 12], [5, 0]]] },
    ']': { a: 4, s: [[[1, 12], [3, 12], [3, 0], [1, 0]]] },
    '^': { a: 8, s: [[[1, 9], [3, 12], [5, 9]]] },
    _: { a: 8, s: [[[0, -2], [6, -2]]] },
    '`': { a: 3, s: [[[1, 12], [2, 10]]] },
    a: { a: 7, s: [[[5, 7], [5, 0]], [[5, 5], [4, 7], [2, 7], [0, 5], [0, 2], [2, 0], [4, 0], [5, 2]]] },
    b: { a: 7, s: [[[0, 12], [0, 0]], [[0, 2], [2, 0], [4, 0], [5, 2], [5, 5], [4, 7], [2, 7], [0, 5]]] },
    c: { a: 7, s: [[[5, 5], [4, 7], [2, 7], [0, 5], [0, 2], [2, 0], [4, 0], [5, 2]]] },
    d: { a: 7, s: [[[5, 12], [5, 0]], [[5, 5], [4, 7], [2, 7], [0, 5], [0, 2], [2, 0], [4, 0], [5, 2]]] },
    e: { a: 7, s: [[[0, 4], [5, 4], [5, 5], [4, 7], [2, 7], [0, 5], [0, 2], [2, 0], [4, 0], [5, 1]]] },
    f: { a: 6, s: [[[4, 11], [3, 12], [2, 12], [1, 11], [1, 0]], [[0, 7], [3, 7]]] },
    g: { a: 7, s: [[[5, 7], [5, -2], [4, -4], [2, -4], [1, -3]], [[5, 5], [4, 7], [2, 7], [0, 5], [0, 2], [2, 0], [4, 0], [5, 2]]] },
    h: { a: 7, s: [[[0, 12], [0, 0]], [[0, 5], [2, 7], [4, 7], [5, 5], [5, 0]]] },
    i: { a: 3, s: [[[1, 7], [1, 0]], [[1, 9], [1, 10]]] },
    j: { a: 4, s: [[[2, 7], [2, -2], [1, -4], [0, -3]], [[2, 9], [2, 10]]] },
    k: { a: 7, s: [[[0, 12], [0, 0]], [[4, 7], [0, 3]], [[1, 4], [5, 0]]] },
    l: { a: 3, s: [[[1, 12], [1, 0]]] },
    m: { a: 9, s: [[[0, 7], [0, 0]], [[0, 6], [1, 7], [3, 7], [4, 6], [4, 0]], [[4, 6], [5, 7], [7, 7], [8, 6], [8, 0]]] },
    n: { a: 7, s: [[[0, 7], [0, 0]], [[0, 5], [2, 7], [4, 7], [5, 5], [5, 0]]] },
    o: { a: 7, s: [[[2, 7], [0, 5], [0, 2], [2, 0], [4, 0], [5, 2], [5, 5], [3, 7], [2, 7]]] },
    p: { a: 7, s: [[[0, -4], [0, 7]], [[0, 5], [2, 7], [4, 7], [5, 5], [5, 2], [4, 0], [2, 0], [0, 2]]] },
    q: { a: 7, s: [[[5, -4], [5, 7]], [[5, 5], [3, 7], [1, 7], [0, 5], [0, 2], [1, 0], [3, 0], [5, 2]]] },
    r: { a: 5, s: [[[0, 7], [0, 0]], [[0, 5], [2, 7], [4, 7]]] },
    s: { a: 6, s: [[[5, 6], [4, 7], [1, 7], [0, 6], [0, 5], [1, 4], [4, 4], [5, 3], [5, 1], [4, 0], [1, 0], [0, 1]]] },
    t: { a: 5, s: [[[1, 12], [1, 1], [2, 0], [3, 0]], [[0, 7], [3, 7]]] },
    u: { a: 7, s: [[[0, 7], [0, 2], [2, 0], [4, 0], [5, 2]], [[5, 7], [5, 0]]] },
    v: { a: 7, s: [[[0, 7], [3, 0], [6, 7]]] },
    w: { a: 9, s: [[[0, 7], [1, 0], [4, 5], [7, 0], [8, 7]]] },
    x: { a: 6, s: [[[0, 7], [5, 0]], [[0, 0], [5, 7]]] },
    y: { a: 7, s: [[[0, 7], [3, 1]], [[6, 7], [2, -4]]] },
    z: { a: 6, s: [[[0, 7], [5, 7], [0, 0], [5, 0]]] },
    '{': { a: 5, s: [[[4, 12], [2, 11], [2, 7], [1, 6], [2, 5], [2, 1], [4, 0]]] },
    '|': { a: 3, s: [[[1, 12], [1, -2]]] },
    '}': { a: 5, s: [[[1, 12], [3, 11], [3, 7], [4, 6], [3, 5], [3, 1], [1, 0]]] },
    '~': { a: 8, s: [[[0, 6], [1, 7], [3, 7], [3, 5], [5, 5], [6, 6]]] },
};

/** Convert a raw `[x, y][][]` stroke list into typed `Polyline[]`. */
function toStrokes(raw: number[][][]): Polyline[] {
    return raw.map((stroke) =>
        stroke.map(([x, y]) => ({ x: x as number, y: y as number })),
    );
}

/**
 * Build the base ASCII glyph dictionary (codepoint → `Glyph`) covering
 * the printable range 0x20–0x7E. Each call returns a fresh, independent
 * object tree so callers (font transforms) can mutate freely.
 */
export function buildBaseGlyphs(): Record<number, Glyph> {
    const out: Record<number, Glyph> = {};
    for (const [ch, raw] of Object.entries(RAW)) {
        const cp = ch.codePointAt(0)!;
        out[cp] = { advance: raw.a, strokes: toStrokes(raw.s) };
    }
    return out;
}
