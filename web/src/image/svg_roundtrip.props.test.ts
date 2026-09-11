/**
 * Property-based tests for SVG vector extraction — the DOM-walking,
 * tessellating half of the `Image_Processor` in
 * {@link ./svg_extractor.ts | svg_extractor.ts}.
 *
 * Implements **Property 22: SVG path round-trip** (Design §7):
 *
 *   *For any* SVG geometry built from the supported subset, parsing the
 *   document into polylines extracts the vectors **directly, without
 *   rasterization** (Req 4.4), so:
 *
 *     - straight geometry round-trips EXACTLY — the extracted vertices equal
 *       the input node positions (`<line>`, `<polyline>`, `<polygon>`, and a
 *       sharp-cornered `<rect>`);
 *     - curve geometry is tessellated within a CHORD ERROR ≤ 0.5 px of the
 *       analytic curve (`<circle>`, `<ellipse>`, and cubic / quadratic
 *       `<path>` segments): every emitted vertex lies on the curve and the
 *       straight chords between them never stray more than 0.5 px from it;
 *     - unsupported elements (`<text>`, filters, gradients, …) are SKIPPED,
 *       not rasterized, and reported — a document mixing a `<text>` with a
 *       supported element yields only the supported geometry (Req 4.5).
 *
 * The "no rasterization" guarantee (Req 4.4) is what makes exact round-trip
 * possible: a rasteriser would quantise vertices to a pixel grid and could
 * never reproduce an arbitrary float coordinate. Asserting exact equality for
 * straight geometry is therefore a direct, observable proxy for "extracted
 * directly without rasterization".
 *
 * **Validates: Requirements 4.4, 4.5**
 *
 * @see web/src/image/svg_extractor.ts
 * @see Design §3.1.1, §7 (Property 22)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    extractSvgPolylines,
    DEFAULT_CHORD_ERROR,
} from './svg_extractor';
import type { Point, Polyline } from '../types';

// -----------------------------------------------------------------------------
// Generators
//
// Coordinates are bounded, finite, and given limited fractional precision so
// the generated SVG attribute strings parse back to the exact same float the
// generator produced (no decimal round-trip surprises). `noNaN` + bounded
// ranges keep every value finite. We keep magnitudes modest so adaptive
// tessellation of curves stays fast.
// -----------------------------------------------------------------------------

/** A finite coordinate in a modest range, quantised to 0.01 so it serialises
 * and parses back exactly. */
const arbCoord: fc.Arbitrary<number> = fc
    .integer({ min: -50_000, max: 50_000 })
    .map((n) => n / 100);

/** A strictly-positive radius / dimension, quantised like {@link arbCoord}. */
const arbPositive: fc.Arbitrary<number> = fc
    .integer({ min: 50, max: 50_000 })
    .map((n) => n / 100);

const arbPoint: fc.Arbitrary<Point> = fc.record({ x: arbCoord, y: arbCoord });

/** Format a number the way our generated SVG attributes will carry it. */
const fmt = (n: number): string => String(n);

const ptsAttr = (pts: Point[]): string =>
    pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');

// -----------------------------------------------------------------------------
// Geometry helpers (independent oracles)
// -----------------------------------------------------------------------------

/** Perpendicular distance from `p` to the finite segment `a`→`b`. */
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

/** Minimum distance from `p` to a polyline treated as a polygonal curve. */
function distPointToPolyline(p: Point, poly: Polyline): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < poly.length; i++) {
        const d = distPointToSegment(p, poly[i - 1]!, poly[i]!);
        if (d < best) best = d;
    }
    return best;
}

/**
 * Assert a tessellated polyline approximates an analytic curve within
 * `tol`, by two-way Hausdorff-style sampling:
 *
 *   (a) every TESSELLATION VERTEX lies within `tol` of the analytic curve;
 *   (b) the polyline stays within `tol` of the curve BETWEEN samples — we
 *       densely sample the analytic curve and require each sample to be
 *       within `tol` of the polyline.
 *
 * `samplePt(t)` must return the analytic point for `t ∈ [0, 1]`.
 */
function assertWithinChordError(
    poly: Polyline,
    samplePt: (t: number) => Point,
    tol: number,
    samples = 2000,
): void {
    // Dense analytic sampling of the true curve.
    const curve: Point[] = [];
    for (let k = 0; k <= samples; k++) {
        curve.push(samplePt(k / samples));
    }

    // (a) Every tessellation vertex is on the curve (within tol).
    for (const v of poly) {
        const d = distPointToPolyline(v, curve);
        expect(d).toBeLessThanOrEqual(tol + 1e-6);
    }

    // (b) The curve is covered by the polyline (within tol): no part of the
    //     analytic curve drifts further than tol from the emitted chords.
    for (const c of curve) {
        const d = distPointToPolyline(c, poly);
        expect(d).toBeLessThanOrEqual(tol + 1e-6);
    }
}

const TOL = DEFAULT_CHORD_ERROR;

// -----------------------------------------------------------------------------
// Property 22 — straight geometry round-trips EXACTLY (no rasterization)
// -----------------------------------------------------------------------------

describe('Svg_Extractor — Property 22: straight geometry round-trips exactly (Req 4.4)', () => {
    /**
     * **Validates: Requirements 4.4**
     *
     * A `<polyline>` extracts to exactly its input vertices: same count,
     * same coordinates, in order. Exact equality is only achievable without
     * rasterization.
     */
    it('extracts <polyline> as exactly its input points', () => {
        fc.assert(
            fc.property(
                fc.array(arbPoint, { minLength: 2, maxLength: 20 }),
                (pts) => {
                    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><polyline points="${ptsAttr(
                        pts,
                    )}"/></svg>`;
                    const { polylines, skipped } = extractSvgPolylines(svg);
                    expect(skipped).toEqual([]);
                    expect(polylines).toHaveLength(1);
                    expect(polylines[0]).toEqual(pts);
                },
            ),
            { numRuns: 200 },
        );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * A `<polygon>` extracts to its input vertices CLOSED back to the first
     * point (one extra vertex equal to the start).
     */
    it('extracts <polygon> as its input points closed back to the start', () => {
        fc.assert(
            fc.property(
                fc.array(arbPoint, { minLength: 2, maxLength: 20 }),
                (pts) => {
                    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><polygon points="${ptsAttr(
                        pts,
                    )}"/></svg>`;
                    const { polylines, skipped } = extractSvgPolylines(svg);
                    expect(skipped).toEqual([]);
                    expect(polylines).toHaveLength(1);

                    const got = polylines[0]!;
                    const first = pts[0]!;
                    const last = pts[pts.length - 1]!;
                    const alreadyClosed = first.x === last.x && first.y === last.y;
                    const expected = alreadyClosed ? pts : [...pts, { ...first }];
                    expect(got).toEqual(expected);
                    // The ring closes: first vertex equals last vertex.
                    expect(got[got.length - 1]).toEqual(got[0]);
                },
            ),
            { numRuns: 200 },
        );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * A `<line>` extracts to exactly its two endpoints.
     */
    it('extracts <line> as exactly its two endpoints', () => {
        fc.assert(
            fc.property(arbPoint, arbPoint, (a, b) => {
                const svg = `<svg xmlns="http://www.w3.org/2000/svg"><line x1="${fmt(
                    a.x,
                )}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}"/></svg>`;
                const { polylines, skipped } = extractSvgPolylines(svg);
                expect(skipped).toEqual([]);
                expect(polylines).toHaveLength(1);
                expect(polylines[0]).toEqual([a, b]);
            }),
            { numRuns: 200 },
        );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * A sharp-cornered `<rect>` (no rx/ry) extracts to its four corners,
     * closed — exact, no rasterization.
     */
    it('extracts a sharp <rect> as its 4 corners, closed', () => {
        fc.assert(
            fc.property(arbCoord, arbCoord, arbPositive, arbPositive, (x, y, w, h) => {
                const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect x="${fmt(
                    x,
                )}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"/></svg>`;
                const { polylines, skipped } = extractSvgPolylines(svg);
                expect(skipped).toEqual([]);
                expect(polylines).toHaveLength(1);
                expect(polylines[0]).toEqual([
                    { x, y },
                    { x: x + w, y },
                    { x: x + w, y: y + h },
                    { x, y: y + h },
                    { x, y },
                ]);
            }),
            { numRuns: 200 },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 22 — curve geometry is tessellated within chord error ≤ 0.5 px
// -----------------------------------------------------------------------------

describe('Svg_Extractor — Property 22: curves tessellate within 0.5 px chord error (Req 4.4)', () => {
    /**
     * **Validates: Requirements 4.4**
     *
     * A `<circle>` tessellates to a closed polyline that stays within 0.5 px
     * of the analytic circle, both at its vertices and between them.
     */
    it('tessellates <circle> within chord error of the analytic circle', () => {
        fc.assert(
            fc.property(arbCoord, arbCoord, arbPositive, (cx, cy, r) => {
                const svg = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="${fmt(
                    cx,
                )}" cy="${fmt(cy)}" r="${fmt(r)}"/></svg>`;
                const { polylines, skipped } = extractSvgPolylines(svg);
                expect(skipped).toEqual([]);
                expect(polylines).toHaveLength(1);

                const poly = polylines[0]!;
                // Closed ring.
                expect(poly[poly.length - 1]).toEqual(poly[0]);
                assertWithinChordError(
                    poly,
                    (t) => ({
                        x: cx + r * Math.cos(2 * Math.PI * t),
                        y: cy + r * Math.sin(2 * Math.PI * t),
                    }),
                    TOL,
                );
            }),
            { numRuns: 60 },
        );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * An `<ellipse>` tessellates within 0.5 px of the analytic ellipse.
     */
    it('tessellates <ellipse> within chord error of the analytic ellipse', () => {
        fc.assert(
            fc.property(
                arbCoord,
                arbCoord,
                arbPositive,
                arbPositive,
                (cx, cy, rx, ry) => {
                    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><ellipse cx="${fmt(
                        cx,
                    )}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}"/></svg>`;
                    const { polylines, skipped } = extractSvgPolylines(svg);
                    expect(skipped).toEqual([]);
                    expect(polylines).toHaveLength(1);

                    const poly = polylines[0]!;
                    expect(poly[poly.length - 1]).toEqual(poly[0]);
                    assertWithinChordError(
                        poly,
                        (t) => ({
                            x: cx + rx * Math.cos(2 * Math.PI * t),
                            y: cy + ry * Math.sin(2 * Math.PI * t),
                        }),
                        TOL,
                    );
                },
            ),
            { numRuns: 60 },
        );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * A cubic Bézier `<path>` (`M … C …`) tessellates within 0.5 px of the
     * analytic cubic. Endpoints of the tessellation match the path's node
     * positions exactly (start = M point, end = C endpoint).
     */
    it('tessellates a cubic <path> within chord error and pins its endpoints', () => {
        fc.assert(
            fc.property(
                arbPoint,
                arbPoint,
                arbPoint,
                arbPoint,
                (p0, p1, p2, p3) => {
                    const d = `M ${fmt(p0.x)} ${fmt(p0.y)} C ${fmt(p1.x)} ${fmt(
                        p1.y,
                    )} ${fmt(p2.x)} ${fmt(p2.y)} ${fmt(p3.x)} ${fmt(p3.y)}`;
                    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`;
                    const { polylines, skipped } = extractSvgPolylines(svg);
                    expect(skipped).toEqual([]);
                    expect(polylines).toHaveLength(1);

                    const poly = polylines[0]!;
                    // Node positions are exact (no rasterization).
                    expect(poly[0]).toEqual(p0);
                    expect(poly[poly.length - 1]).toEqual(p3);

                    const cubic = (t: number): Point => {
                        const u = 1 - t;
                        const b0 = u * u * u;
                        const b1 = 3 * u * u * t;
                        const b2 = 3 * u * t * t;
                        const b3 = t * t * t;
                        return {
                            x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
                            y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
                        };
                    };
                    assertWithinChordError(poly, cubic, TOL);
                },
            ),
            { numRuns: 60 },
        );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * A quadratic Bézier `<path>` (`M … Q …`) tessellates within 0.5 px of
     * the analytic quadratic, with exact endpoints.
     */
    it('tessellates a quadratic <path> within chord error and pins its endpoints', () => {
        fc.assert(
            fc.property(arbPoint, arbPoint, arbPoint, (p0, p1, p2) => {
                const d = `M ${fmt(p0.x)} ${fmt(p0.y)} Q ${fmt(p1.x)} ${fmt(
                    p1.y,
                )} ${fmt(p2.x)} ${fmt(p2.y)}`;
                const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`;
                const { polylines, skipped } = extractSvgPolylines(svg);
                expect(skipped).toEqual([]);
                expect(polylines).toHaveLength(1);

                const poly = polylines[0]!;
                expect(poly[0]).toEqual(p0);
                expect(poly[poly.length - 1]).toEqual(p2);

                const quad = (t: number): Point => {
                    const u = 1 - t;
                    const b0 = u * u;
                    const b1 = 2 * u * t;
                    const b2 = t * t;
                    return {
                        x: b0 * p0.x + b1 * p1.x + b2 * p2.x,
                        y: b0 * p0.y + b1 * p1.y + b2 * p2.y,
                    };
                };
                assertWithinChordError(poly, quad, TOL);
            }),
            { numRuns: 60 },
        );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * Regression: degenerate / cusp Bézier curves whose control point(s) are
     * COLLINEAR with the endpoints. Here the perpendicular distance of the
     * control point to the *infinite* chord line is ~0, yet the curve still
     * bulges past a chord endpoint and the single chord deviates > 0.5 px.
     * These exact counterexamples were surfaced by the property tests above;
     * we pin them so the adaptive subdivision never regresses to a
     * line-distance flatness test again.
     */
    it.each([
        // [p0, p1 (control), p2] — quadratic cusp, control collinear on the y axis.
        [
            { x: 0, y: 0 },
            { x: 0, y: -1.02 },
            { x: 0, y: -0.01 },
        ],
        [
            { x: -1.01, y: 0 },
            { x: 0, y: 0 },
            { x: -1.02, y: 0 },
        ],
        [
            { x: 0, y: 0 },
            { x: 0, y: 1.02 },
            { x: 0, y: 0.01 },
        ],
    ])(
        'tessellates a collinear-control quadratic cusp within chord error (%#)',
        (p0, p1, p2) => {
            const d = `M ${fmt(p0.x)} ${fmt(p0.y)} Q ${fmt(p1.x)} ${fmt(
                p1.y,
            )} ${fmt(p2.x)} ${fmt(p2.y)}`;
            const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`;
            const { polylines } = extractSvgPolylines(svg);
            expect(polylines).toHaveLength(1);

            const poly = polylines[0]!;
            expect(poly[0]).toEqual(p0);
            expect(poly[poly.length - 1]).toEqual(p2);

            const quad = (t: number): Point => {
                const u = 1 - t;
                const b0 = u * u;
                const b1 = 2 * u * t;
                const b2 = t * t;
                return {
                    x: b0 * p0.x + b1 * p1.x + b2 * p2.x,
                    y: b0 * p0.y + b1 * p1.y + b2 * p2.y,
                };
            };
            assertWithinChordError(poly, quad, TOL);
        },
    );

    /**
     * **Validates: Requirements 4.4**
     *
     * Regression: a cubic whose control points are collinear with the
     * endpoints but pull the curve past a chord endpoint (cusp). Same defect
     * class as the quadratic regression above.
     */
    it('tessellates a collinear-control cubic cusp within chord error', () => {
        const p0: Point = { x: 0, y: 0 };
        const p1: Point = { x: 0, y: -1.02 };
        const p2: Point = { x: 0, y: 1.02 };
        const p3: Point = { x: 0, y: -0.01 };
        const d = `M ${fmt(p0.x)} ${fmt(p0.y)} C ${fmt(p1.x)} ${fmt(p1.y)} ${fmt(
            p2.x,
        )} ${fmt(p2.y)} ${fmt(p3.x)} ${fmt(p3.y)}`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`;
        const { polylines } = extractSvgPolylines(svg);
        expect(polylines).toHaveLength(1);

        const poly = polylines[0]!;
        expect(poly[0]).toEqual(p0);
        expect(poly[poly.length - 1]).toEqual(p3);

        const cubic = (t: number): Point => {
            const u = 1 - t;
            const b0 = u * u * u;
            const b1 = 3 * u * u * t;
            const b2 = 3 * u * t * t;
            const b3 = t * t * t;
            return {
                x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
                y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
            };
        };
        assertWithinChordError(poly, cubic, TOL);
    });
});

// -----------------------------------------------------------------------------
// Property 22 — straight <path> segments round-trip exactly
// -----------------------------------------------------------------------------

describe('Svg_Extractor — Property 22: straight <path> nodes round-trip exactly (Req 4.4)', () => {
    /**
     * **Validates: Requirements 4.4**
     *
     * An `M L L … ` path of straight segments extracts to exactly the listed
     * node positions, in order — no extra tessellation vertices, no
     * rasterization.
     */
    it('extracts an M/L straight <path> as exactly its node positions', () => {
        fc.assert(
            fc.property(
                fc.array(arbPoint, { minLength: 2, maxLength: 15 }),
                (pts) => {
                    const head = `M ${fmt(pts[0]!.x)} ${fmt(pts[0]!.y)}`;
                    const rest = pts
                        .slice(1)
                        .map((p) => `L ${fmt(p.x)} ${fmt(p.y)}`)
                        .join(' ');
                    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${head} ${rest}"/></svg>`;
                    const { polylines, skipped } = extractSvgPolylines(svg);
                    expect(skipped).toEqual([]);
                    expect(polylines).toHaveLength(1);
                    expect(polylines[0]).toEqual(pts);
                },
            ),
            { numRuns: 150 },
        );
    });
});

// -----------------------------------------------------------------------------
// Property 22 — unsupported elements are skipped, not rasterized (Req 4.5)
// -----------------------------------------------------------------------------

describe('Svg_Extractor — Property 22: unsupported elements are skipped, not rasterized (Req 4.5)', () => {
    /**
     * **Validates: Requirements 4.5**
     *
     * A document containing a `<text>` element plus a supported `<line>`
     * yields ONLY the supported geometry, and reports `text` as skipped. The
     * text is never turned into pixels / outlines (no rasterization).
     */
    it('skips <text> alongside a supported element and yields only the supported geometry', () => {
        fc.assert(
            fc.property(
                arbPoint,
                arbPoint,
                fc.string({ maxLength: 12 }),
                (a, b, label) => {
                    // Strip characters that would break out of the attribute /
                    // text context so the generated SVG always parses.
                    const safe = label.replace(/[<>&"]/g, '');
                    const svg =
                        `<svg xmlns="http://www.w3.org/2000/svg">` +
                        `<text x="${fmt(a.x)}" y="${fmt(a.y)}">${safe}</text>` +
                        `<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(
                            b.x,
                        )}" y2="${fmt(b.y)}"/>` +
                        `</svg>`;
                    const { polylines, skipped } = extractSvgPolylines(svg);

                    // Only the <line> survives, exactly.
                    expect(polylines).toHaveLength(1);
                    expect(polylines[0]).toEqual([a, b]);
                    // <text> is reported as skipped (Req 4.5).
                    expect(skipped).toContain('text');
                },
            ),
            { numRuns: 150 },
        );
    });

    /**
     * **Validates: Requirements 4.5**
     *
     * Filter / gradient definition machinery does not contribute geometry and
     * does not get rasterized: a `<defs>` block with a `<filter>` and a
     * `<linearGradient>` alongside a supported `<polyline>` yields only the
     * polyline. (Definition containers are not themselves "skipped geometry",
     * so the supported element is the sole output.)
     */
    it('does not rasterize filter/gradient defs; only supported geometry is emitted', () => {
        fc.assert(
            fc.property(
                fc.array(arbPoint, { minLength: 2, maxLength: 10 }),
                (pts) => {
                    const svg =
                        `<svg xmlns="http://www.w3.org/2000/svg">` +
                        `<defs>` +
                        `<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>` +
                        `<linearGradient id="g"><stop offset="0"/><stop offset="1"/></linearGradient>` +
                        `</defs>` +
                        `<polyline points="${ptsAttr(pts)}"/>` +
                        `</svg>`;
                    const { polylines } = extractSvgPolylines(svg);
                    expect(polylines).toHaveLength(1);
                    expect(polylines[0]).toEqual(pts);
                },
            ),
            { numRuns: 100 },
        );
    });
});
