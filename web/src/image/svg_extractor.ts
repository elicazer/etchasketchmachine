/**
 * `Svg_Extractor` — extract vector geometry from an SVG document directly,
 * without rasterization (Req 4.4).
 *
 * This is the SVG half of the `Image_Processor` (Design §3.1.1, task 17.2).
 * Where raster inputs go through the Canny / `opencv.js` pipeline in
 * {@link ./image_processor.ts}, SVG inputs are parsed as a DOM and walked
 * element-by-element so the original vector paths survive intact — the
 * stylus can trace them at full precision instead of chasing the staircase
 * of a rasterised bitmap.
 *
 * Supported geometry (Design §3.1.1):
 *
 *   - `<line>`      → its two endpoints (exact)
 *   - `<polyline>`  → its vertices (exact, open)
 *   - `<polygon>`   → its vertices closed back to the first (exact)
 *   - `<rect>`      → the four corners closed (exact); rounded corners
 *                     (`rx` / `ry`) are tessellated as elliptical arcs
 *   - `<circle>`    → a closed polyline tessellated from the analytic circle
 *   - `<ellipse>`   → a closed polyline tessellated from the analytic ellipse
 *   - `<path>`      → one polyline per subpath, with the `M L H V Z C S Q T A`
 *                     command subset; Bézier and arc segments are tessellated
 *
 * Every curve is tessellated with a **chord error ≤ 0.5 px** (Req 4.4): the
 * straight segments emitted never stray more than half a pixel from the true
 * analytic curve. Straight geometry (lines, polylines, polygons, sharp-corner
 * rects) round-trips **exactly** — the emitted vertices equal the input nodes.
 *
 * Unsupported elements — `<text>`, filters, gradients, images, and anything
 * else outside the supported set — are skipped rather than rasterised
 * (Req 4.5). Their local names are collected in {@link SvgExtractionResult.skipped}
 * so the UI can surface a "these elements were skipped" notification.
 *
 * The module is pure and DOM-light: it needs a `DOMParser` to turn SVG text
 * into a document (the browser and jsdom both provide one) but otherwise does
 * no canvas work, no WASM, and holds no global state — so it unit-tests
 * cleanly under Vitest's jsdom environment.
 *
 * Scope note: element-level `transform` attributes and CSS are intentionally
 * not applied — geometry is read in its own local coordinate space, matching
 * the Property 22 contract that emitted vertices equal the SVG node positions.
 *
 * @see Design §3.1.1, §7 (Property 22)
 * @see Requirements 4.4, 4.5
 */

import type { Point, Polyline } from '../types';

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

/**
 * Maximum distance (in user-space px) a tessellated chord is allowed to
 * deviate from the analytic curve it approximates (Req 4.4).
 */
export const DEFAULT_CHORD_ERROR = 0.5;

/** Result of {@link extractSvgPolylines}. */
export interface SvgExtractionResult {
    /** Extracted geometry, one polyline per drawable element / subpath. */
    polylines: Polyline[];
    /**
     * Sorted, de-duplicated local names of elements that were skipped
     * because they are not supported drawable geometry (Req 4.5).
     */
    skipped: string[];
}

/** Options for {@link extractSvgPolylines}. */
export interface ExtractSvgOptions {
    /** Curve tessellation tolerance in px; defaults to {@link DEFAULT_CHORD_ERROR}. */
    chordError?: number;
}

/** Element local names that carry drawable geometry we support. */
const SUPPORTED_GEOMETRY: ReadonlySet<string> = new Set([
    'path',
    'line',
    'polyline',
    'polygon',
    'rect',
    'circle',
    'ellipse',
]);

/**
 * Grouping / metadata containers we descend into but never draw. Their
 * presence is not "skipped geometry", so they are not reported.
 */
const STRUCTURAL: ReadonlySet<string> = new Set([
    'svg',
    'g',
    'switch',
    'title',
    'desc',
    'metadata',
    'style',
    'a',
]);

/**
 * Definition containers whose contents are templates, not rendered output.
 * We neither draw their children nor descend into them (and we do not flag
 * them as skipped, since nothing inside was meant to be drawn directly).
 */
const DEFS_CONTAINERS: ReadonlySet<string> = new Set([
    'defs',
    'symbol',
    'clippath',
    'mask',
    'marker',
    'pattern',
    'lineargradient',
    'radialgradient',
]);

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

/**
 * Parse an SVG document and extract its supported geometry as polylines.
 *
 * @param source SVG markup (parsed via `DOMParser` as `image/svg+xml`) or an
 *               already-parsed `Document`.
 * @param opts   Tessellation options.
 * @returns      The extracted {@link SvgExtractionResult}.
 */
export function extractSvgPolylines(
    source: string | Document,
    opts: ExtractSvgOptions = {},
): SvgExtractionResult {
    const tol =
        Number.isFinite(opts.chordError) && (opts.chordError as number) > 0
            ? (opts.chordError as number)
            : DEFAULT_CHORD_ERROR;

    const doc = typeof source === 'string' ? parseSvg(source) : source;
    const root = doc.documentElement as Element | null;

    const polylines: Polyline[] = [];
    const skipped = new Set<string>();

    if (root) {
        // A failed parse surfaces as a <parsererror> document in both jsdom
        // and browsers; there is no drawable geometry to recover.
        const rootName = localNameOf(root);
        if (rootName !== 'parsererror') {
            walk(root, tol, polylines, skipped);
        }
    }

    return {
        polylines,
        skipped: [...skipped].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    };
}

/** Parse SVG text into a `Document` using the ambient `DOMParser`. */
function parseSvg(text: string): Document {
    if (typeof DOMParser === 'undefined') {
        throw new Error('extractSvgPolylines: a DOMParser is required to parse SVG text.');
    }
    return new DOMParser().parseFromString(text, 'image/svg+xml');
}

/** The lower-cased local name of an element (namespace-agnostic). */
function localNameOf(el: Element): string {
    return (el.localName ?? el.tagName ?? '').toLowerCase();
}

// -----------------------------------------------------------------------------
// DOM walk
// -----------------------------------------------------------------------------

/**
 * Depth-first walk: extract supported geometry, descend through structural
 * containers, skip-and-report unsupported elements, and ignore definition
 * subtrees entirely.
 */
function walk(
    el: Element,
    tol: number,
    out: Polyline[],
    skipped: Set<string>,
): void {
    const name = localNameOf(el);

    if (DEFS_CONTAINERS.has(name)) {
        return; // template definitions: not drawn, not reported.
    }

    if (SUPPORTED_GEOMETRY.has(name)) {
        for (const poly of elementToPolylines(el, name, tol)) {
            if (poly.length >= 2) out.push(poly);
        }
        return; // geometry elements have no drawable element children.
    }

    if (STRUCTURAL.has(name)) {
        for (const child of elementChildren(el)) {
            walk(child, tol, out, skipped);
        }
        return;
    }

    // Anything else (text, image, foreignObject, filter primitives that
    // escaped <defs>, …) is unsupported: skip it and note it (Req 4.5).
    skipped.add(name);
}

/** The element children of `el` (skips text / comment nodes). */
function elementChildren(el: Element): Element[] {
    const out: Element[] = [];
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
        const node = kids[i];
        if (node.nodeType === 1 /* ELEMENT_NODE */) out.push(node as Element);
    }
    return out;
}

// -----------------------------------------------------------------------------
// Per-element extraction
// -----------------------------------------------------------------------------

/** Read a numeric attribute, falling back when absent / unparseable. */
function attrNum(el: Element, name: string, fallback: number): number {
    const raw = el.getAttribute(name);
    if (raw === null) return fallback;
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) ? v : fallback;
}

/** Convert one supported geometry element into its polyline(s). */
function elementToPolylines(el: Element, name: string, tol: number): Polyline[] {
    switch (name) {
        case 'line': {
            const a: Point = { x: attrNum(el, 'x1', 0), y: attrNum(el, 'y1', 0) };
            const b: Point = { x: attrNum(el, 'x2', 0), y: attrNum(el, 'y2', 0) };
            return [[a, b]];
        }
        case 'polyline': {
            const pts = parsePoints(el.getAttribute('points'));
            return pts.length >= 2 ? [pts] : [];
        }
        case 'polygon': {
            const pts = parsePoints(el.getAttribute('points'));
            if (pts.length < 2) return [];
            return [closeRing(pts)];
        }
        case 'rect':
            return rectToPolylines(el, tol);
        case 'circle': {
            const cx = attrNum(el, 'cx', 0);
            const cy = attrNum(el, 'cy', 0);
            const r = attrNum(el, 'r', 0);
            if (!(r > 0)) return [];
            return [ellipsePolyline(cx, cy, r, r, tol)];
        }
        case 'ellipse': {
            const cx = attrNum(el, 'cx', 0);
            const cy = attrNum(el, 'cy', 0);
            const rx = attrNum(el, 'rx', 0);
            const ry = attrNum(el, 'ry', 0);
            if (!(rx > 0) || !(ry > 0)) return [];
            return [ellipsePolyline(cx, cy, rx, ry, tol)];
        }
        case 'path':
            return parsePath(el.getAttribute('d') ?? '', tol);
        default:
            return [];
    }
}

/** Append the first point to close a ring, unless it is already closed. */
function closeRing(pts: Point[]): Polyline {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first.x === last.x && first.y === last.y) return pts.slice();
    return [...pts, { x: first.x, y: first.y }];
}

/**
 * Parse an SVG `points` list ("x0,y0 x1,y1 …" — commas and/or whitespace
 * separate values) into points. A trailing lone coordinate is dropped.
 */
function parsePoints(raw: string | null): Point[] {
    if (!raw) return [];
    const nums = raw
        .split(/[\s,]+/)
        .filter((s) => s.length > 0)
        .map((s) => Number.parseFloat(s));
    const pts: Point[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
        const x = nums[i];
        const y = nums[i + 1];
        if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
    }
    return pts;
}

/**
 * `<rect>` → a closed polyline. Sharp rects give the four corners exactly;
 * a rect with `rx` / `ry` gets its corners tessellated as quarter-ellipses.
 */
function rectToPolylines(el: Element, tol: number): Polyline[] {
    const x = attrNum(el, 'x', 0);
    const y = attrNum(el, 'y', 0);
    const w = attrNum(el, 'width', 0);
    const h = attrNum(el, 'height', 0);
    if (!(w > 0) || !(h > 0)) return [];

    // Resolve corner radii per the SVG spec: each defaults to the other, and
    // both are clamped to half the corresponding side.
    const rxRaw = el.getAttribute('rx');
    const ryRaw = el.getAttribute('ry');
    let rx = rxRaw !== null ? Math.max(0, Number.parseFloat(rxRaw)) : NaN;
    let ry = ryRaw !== null ? Math.max(0, Number.parseFloat(ryRaw)) : NaN;
    if (!Number.isFinite(rx) && !Number.isFinite(ry)) {
        rx = 0;
        ry = 0;
    } else if (!Number.isFinite(rx)) {
        rx = ry;
    } else if (!Number.isFinite(ry)) {
        ry = rx;
    }
    rx = Math.min(rx, w / 2);
    ry = Math.min(ry, h / 2);

    if (!(rx > 0) || !(ry > 0)) {
        // Sharp corners: exact four-corner closed ring.
        return [
            [
                { x, y },
                { x: x + w, y },
                { x: x + w, y: y + h },
                { x, y: y + h },
                { x, y },
            ],
        ];
    }

    // Rounded corners: straight edges joined by tessellated quarter arcs.
    // Start at the top edge just past the top-left corner and go clockwise.
    const out: Point[] = [];
    out.push({ x: x + rx, y });
    out.push({ x: x + w - rx, y });
    appendEllipseArc(out, x + w - rx, y + ry, rx, ry, -Math.PI / 2, 0, tol);
    out.push({ x: x + w, y: y + h - ry });
    appendEllipseArc(out, x + w - rx, y + h - ry, rx, ry, 0, Math.PI / 2, tol);
    out.push({ x: x + rx, y: y + h });
    appendEllipseArc(out, x + rx, y + h - ry, rx, ry, Math.PI / 2, Math.PI, tol);
    out.push({ x, y: y + ry });
    appendEllipseArc(out, x + rx, y + ry, rx, ry, Math.PI, (3 * Math.PI) / 2, tol);
    out.push({ x: x + rx, y });
    return [out];
}

// -----------------------------------------------------------------------------
// Ellipse / arc tessellation
// -----------------------------------------------------------------------------

/** A point on the (optionally rotated) ellipse at parametric angle `t`. */
function ellipsePoint(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    phi: number,
    t: number,
): Point {
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    if (phi === 0) return { x: cx + ex, y: cy + ey };
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    return { x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos };
}

/**
 * Tessellate a full ellipse into a closed polyline within `tol` of the true
 * curve. Split into four quadrants first so the adaptive subdivision starts
 * from non-degenerate chords.
 */
function ellipsePolyline(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    tol: number,
): Polyline {
    const start = ellipsePoint(cx, cy, rx, ry, 0, 0);
    const out: Point[] = [start];
    const q = Math.PI / 2;
    for (let k = 0; k < 4; k++) {
        appendEllipseArc(out, cx, cy, rx, ry, k * q, (k + 1) * q, tol);
    }
    // Snap the closing vertex exactly onto the start so the ring is closed
    // (the analytic endpoint at 2π differs from the start only by a
    // floating-point epsilon in sin/cos).
    out[out.length - 1] = { x: start.x, y: start.y };
    return out;
}

/**
 * Adaptively append samples of the ellipse arc `(t0, t1]` to `out` so that
 * every emitted chord stays within `tol` of the analytic arc. The start
 * point (at `t0`) is assumed to already be the last entry of `out`.
 */
function appendEllipseArc(
    out: Point[],
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    t0: number,
    t1: number,
    tol: number,
    phi = 0,
): void {
    const recurse = (a: number, b: number, depth: number): void => {
        const pa = ellipsePoint(cx, cy, rx, ry, phi, a);
        const pb = ellipsePoint(cx, cy, rx, ry, phi, b);
        const m = (a + b) / 2;
        const pm = ellipsePoint(cx, cy, rx, ry, phi, m);
        // Sagitta: distance from the mid-arc point to the chord.
        if (depth >= 24 || distPointToSegment(pm, pa, pb) <= tol) {
            out.push(pb);
            return;
        }
        recurse(a, m, depth + 1);
        recurse(m, b, depth + 1);
    };
    recurse(t0, t1, 0);
}

// -----------------------------------------------------------------------------
// Bézier tessellation
// -----------------------------------------------------------------------------

/**
 * Adaptively append a cubic Bézier to `out` within `tol` of the curve. The
 * start point `p0` is assumed to already be the last entry of `out`.
 */
function appendCubic(
    out: Point[],
    p0: Point,
    p1: Point,
    p2: Point,
    p3: Point,
    tol: number,
): void {
    const recurse = (
        a: Point,
        b: Point,
        c: Point,
        d: Point,
        depth: number,
    ): void => {
        // de Casteljau split at t = 0.5: `abcd` is the *true* curve point at
        // the midpoint, the rest are the split control points.
        const ab = mid(a, b);
        const bc = mid(b, c);
        const cd = mid(c, d);
        const abc = mid(ab, bc);
        const bcd = mid(bc, cd);
        const abcd = mid(abc, bcd);

        // Flatness against the a→d chord *segment* (not the infinite line):
        //
        //   - the control-point terms are a rigorous upper bound on the chord
        //     error — every curve point B(t) is a convex combination of the
        //     control points, and distance to a segment is convex, so the
        //     curve never strays farther from the chord than its farthest
        //     control point does. Measuring against the finite segment (rather
        //     than the line) is what catches degenerate / cusp curves whose
        //     control points are collinear with the endpoints but pull the
        //     curve *past* a chord endpoint (a zero line-distance, large
        //     segment-distance case);
        //   - the midpoint sagitta directly samples the true curve, mirroring
        //     {@link appendEllipseArc}.
        const flat = Math.max(
            distPointToSegment(b, a, d),
            distPointToSegment(c, a, d),
            distPointToSegment(abcd, a, d),
        );
        if (depth >= 24 || flat <= tol) {
            out.push(d);
            return;
        }
        recurse(a, ab, abc, abcd, depth + 1);
        recurse(abcd, bcd, cd, d, depth + 1);
    };
    recurse(p0, p1, p2, p3, 0);
}

/**
 * Adaptively append a quadratic Bézier to `out` within `tol` of the curve.
 * The start point `p0` is assumed to already be the last entry of `out`.
 */
function appendQuadratic(
    out: Point[],
    p0: Point,
    p1: Point,
    p2: Point,
    tol: number,
): void {
    const recurse = (a: Point, b: Point, c: Point, depth: number): void => {
        const ab = mid(a, b);
        const bc = mid(b, c);
        const abc = mid(ab, bc); // true curve point at t = 0.5
        // Flatness against the a→c chord *segment*: the control point bounds
        // the chord error (convexity), and `abc` samples the true midpoint —
        // measuring against the finite segment catches collinear-control cusp
        // curves that overshoot a chord endpoint (cf. {@link appendCubic}).
        const flat = Math.max(
            distPointToSegment(b, a, c),
            distPointToSegment(abc, a, c),
        );
        if (depth >= 24 || flat <= tol) {
            out.push(c);
            return;
        }
        recurse(a, ab, abc, depth + 1);
        recurse(abc, bc, c, depth + 1);
    };
    recurse(p0, p1, p2, 0);
}

const mid = (a: Point, b: Point): Point => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
});

// -----------------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------------

/** Distance from `p` to the finite segment `a`→`b` (projection clamped). */
function distPointToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
}

// -----------------------------------------------------------------------------
// Path data parsing (M L H V Z C S Q T A, absolute + relative)
// -----------------------------------------------------------------------------

/**
 * Parse an SVG path `d` string into one polyline per subpath, tessellating
 * curve and arc segments within `tol`.
 */
function parsePath(d: string, tol: number): Polyline[] {
    const tokens = tokenizePath(d);
    if (tokens.length === 0) return [];

    const polylines: Polyline[] = [];
    let current: Point[] | null = null;

    // Pen + subpath state.
    let cx = 0;
    let cy = 0;
    let startX = 0;
    let startY = 0;
    // Reflection control points for S/T smoothing.
    let prevCubicCtrl: Point | null = null;
    let prevQuadCtrl: Point | null = null;
    let prevCmd = '';

    let i = 0;
    const next = (): number => tokens[i++] as number;

    const flush = (): void => {
        if (current && current.length >= 2) polylines.push(current);
        current = null;
    };

    while (i < tokens.length) {
        const tok = tokens[i];
        if (typeof tok !== 'string') {
            // A stray number with no command: stop parsing defensively.
            break;
        }
        const cmd = tok;
        i++;
        const rel = cmd === cmd.toLowerCase();
        const C = cmd.toUpperCase();

        switch (C) {
            case 'M': {
                let x = next();
                let y = next();
                if (rel) {
                    x += cx;
                    y += cy;
                }
                flush();
                cx = x;
                cy = y;
                startX = x;
                startY = y;
                current = [{ x, y }];
                // Subsequent implicit pairs after an M are treated as L.
                while (typeof tokens[i] === 'number') {
                    let lx = next();
                    let ly = next();
                    if (rel) {
                        lx += cx;
                        ly += cy;
                    }
                    cx = lx;
                    cy = ly;
                    current.push({ x: cx, y: cy });
                }
                prevCubicCtrl = null;
                prevQuadCtrl = null;
                break;
            }
            case 'L': {
                if (!current) current = [{ x: cx, y: cy }];
                while (typeof tokens[i] === 'number') {
                    let x = next();
                    let y = next();
                    if (rel) {
                        x += cx;
                        y += cy;
                    }
                    cx = x;
                    cy = y;
                    current.push({ x: cx, y: cy });
                }
                prevCubicCtrl = null;
                prevQuadCtrl = null;
                break;
            }
            case 'H': {
                if (!current) current = [{ x: cx, y: cy }];
                while (typeof tokens[i] === 'number') {
                    let x = next();
                    if (rel) x += cx;
                    cx = x;
                    current.push({ x: cx, y: cy });
                }
                prevCubicCtrl = null;
                prevQuadCtrl = null;
                break;
            }
            case 'V': {
                if (!current) current = [{ x: cx, y: cy }];
                while (typeof tokens[i] === 'number') {
                    let y = next();
                    if (rel) y += cy;
                    cy = y;
                    current.push({ x: cx, y: cy });
                }
                prevCubicCtrl = null;
                prevQuadCtrl = null;
                break;
            }
            case 'C': {
                if (!current) current = [{ x: cx, y: cy }];
                while (typeof tokens[i] === 'number') {
                    let x1 = next();
                    let y1 = next();
                    let x2 = next();
                    let y2 = next();
                    let x = next();
                    let y = next();
                    if (rel) {
                        x1 += cx;
                        y1 += cy;
                        x2 += cx;
                        y2 += cy;
                        x += cx;
                        y += cy;
                    }
                    const p0 = { x: cx, y: cy };
                    appendCubic(current, p0, { x: x1, y: y1 }, { x: x2, y: y2 }, { x, y }, tol);
                    prevCubicCtrl = { x: x2, y: y2 };
                    prevQuadCtrl = null;
                    cx = x;
                    cy = y;
                }
                break;
            }
            case 'S': {
                if (!current) current = [{ x: cx, y: cy }];
                while (typeof tokens[i] === 'number') {
                    let x2 = next();
                    let y2 = next();
                    let x = next();
                    let y = next();
                    if (rel) {
                        x2 += cx;
                        y2 += cy;
                        x += cx;
                        y += cy;
                    }
                    // First control = reflection of the previous cubic control
                    // about the current point, when the last command was C/S.
                    const reflect =
                        prevCubicCtrl && (prevCmd === 'C' || prevCmd === 'S')
                            ? { x: 2 * cx - prevCubicCtrl.x, y: 2 * cy - prevCubicCtrl.y }
                            : { x: cx, y: cy };
                    const p0 = { x: cx, y: cy };
                    appendCubic(current, p0, reflect, { x: x2, y: y2 }, { x, y }, tol);
                    prevCubicCtrl = { x: x2, y: y2 };
                    prevQuadCtrl = null;
                    cx = x;
                    cy = y;
                    prevCmd = 'S';
                }
                break;
            }
            case 'Q': {
                if (!current) current = [{ x: cx, y: cy }];
                while (typeof tokens[i] === 'number') {
                    let x1 = next();
                    let y1 = next();
                    let x = next();
                    let y = next();
                    if (rel) {
                        x1 += cx;
                        y1 += cy;
                        x += cx;
                        y += cy;
                    }
                    const p0 = { x: cx, y: cy };
                    appendQuadratic(current, p0, { x: x1, y: y1 }, { x, y }, tol);
                    prevQuadCtrl = { x: x1, y: y1 };
                    prevCubicCtrl = null;
                    cx = x;
                    cy = y;
                }
                break;
            }
            case 'T': {
                if (!current) current = [{ x: cx, y: cy }];
                while (typeof tokens[i] === 'number') {
                    let x = next();
                    let y = next();
                    if (rel) {
                        x += cx;
                        y += cy;
                    }
                    const ctrl: Point =
                        prevQuadCtrl && (prevCmd === 'Q' || prevCmd === 'T')
                            ? { x: 2 * cx - prevQuadCtrl.x, y: 2 * cy - prevQuadCtrl.y }
                            : { x: cx, y: cy };
                    const p0 = { x: cx, y: cy };
                    appendQuadratic(current, p0, ctrl, { x, y }, tol);
                    prevQuadCtrl = ctrl;
                    prevCubicCtrl = null;
                    cx = x;
                    cy = y;
                    prevCmd = 'T';
                }
                break;
            }
            case 'A': {
                if (!current) current = [{ x: cx, y: cy }];
                while (typeof tokens[i] === 'number') {
                    const rxA = next();
                    const ryA = next();
                    const xRot = next();
                    const largeArc = next();
                    const sweep = next();
                    let x = next();
                    let y = next();
                    if (rel) {
                        x += cx;
                        y += cy;
                    }
                    appendArc(
                        current,
                        cx,
                        cy,
                        rxA,
                        ryA,
                        (xRot * Math.PI) / 180,
                        largeArc !== 0,
                        sweep !== 0,
                        x,
                        y,
                        tol,
                    );
                    cx = x;
                    cy = y;
                    prevCubicCtrl = null;
                    prevQuadCtrl = null;
                }
                break;
            }
            case 'Z': {
                if (current) {
                    current.push({ x: startX, y: startY });
                    cx = startX;
                    cy = startY;
                    flush();
                }
                prevCubicCtrl = null;
                prevQuadCtrl = null;
                break;
            }
            default:
                // Unknown command: stop defensively.
                i = tokens.length;
                break;
        }
        prevCmd = C;
    }

    flush();
    return polylines;
}

/**
 * Tokenize a path `d` string into an alternating-ish stream of command
 * letters (strings) and numbers. Whitespace and commas separate tokens;
 * numbers may be signed and use scientific notation.
 */
function tokenizePath(d: string): Array<string | number> {
    const out: Array<string | number> = [];
    const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(d)) !== null) {
        if (m[1] !== undefined) {
            out.push(m[1]);
        } else if (m[2] !== undefined) {
            const v = Number.parseFloat(m[2]);
            if (Number.isFinite(v)) out.push(v);
        }
    }
    return out;
}

/**
 * Convert an SVG elliptical-arc command (endpoint parameterization) to a
 * center parameterization and append its tessellation to `out`. The start
 * point `(x0, y0)` is assumed to already be the last entry of `out`.
 *
 * Implements the conversion from the SVG 1.1 spec, Appendix F.6.
 */
function appendArc(
    out: Point[],
    x0: number,
    y0: number,
    rx: number,
    ry: number,
    phi: number,
    largeArc: boolean,
    sweep: boolean,
    x: number,
    y: number,
    tol: number,
): void {
    // Degenerate radii ⇒ straight line (per spec).
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
        if (!(x0 === x && y0 === y)) out.push({ x, y });
        return;
    }

    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    // Step 1: compute (x1', y1').
    const dx2 = (x0 - x) / 2;
    const dy2 = (y0 - y) / 2;
    const x1p = cosPhi * dx2 + sinPhi * dy2;
    const y1p = -sinPhi * dx2 + cosPhi * dy2;

    // Correct out-of-range radii.
    let rx2 = rx * rx;
    let ry2 = ry * ry;
    const lambda = (x1p * x1p) / rx2 + (y1p * y1p) / ry2;
    if (lambda > 1) {
        const s = Math.sqrt(lambda);
        rx *= s;
        ry *= s;
        rx2 = rx * rx;
        ry2 = ry * ry;
    }

    // Step 2: compute (cx', cy').
    let sign = largeArc !== sweep ? 1 : -1;
    let num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
    const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
    let coef = den === 0 ? 0 : sign * Math.sqrt(Math.max(0, num / den));
    const cxp = (coef * (rx * y1p)) / ry;
    const cyp = (coef * -(ry * x1p)) / rx;

    // Step 3: compute (cx, cy) from (cx', cy').
    const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

    // Step 4: compute start angle and sweep angle.
    const ux = (x1p - cxp) / rx;
    const uy = (y1p - cyp) / ry;
    const vx = (-x1p - cxp) / rx;
    const vy = (-y1p - cyp) / ry;

    const angle = (uxv: number, uyv: number, vxv: number, vyv: number): number => {
        const dot = uxv * vxv + uyv * vyv;
        const len = Math.hypot(uxv, uyv) * Math.hypot(vxv, vyv);
        let a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
        if (uxv * vyv - uyv * vxv < 0) a = -a;
        return a;
    };

    const theta0 = angle(1, 0, ux, uy);
    let dTheta = angle(ux, uy, vx, vy);
    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
    else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

    // Tessellate the center-parameterized arc.
    appendEllipseArc(out, cx, cy, rx, ry, theta0, theta0 + dTheta, tol, phi);
    // Snap the final point to the exact requested endpoint.
    const lastIdx = out.length - 1;
    out[lastIdx] = { x, y };
}
