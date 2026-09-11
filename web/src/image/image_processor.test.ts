import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    traceContours,
    clampEdgeOptions,
    clampContrast,
    applyContrast,
    centerlineEdges,
    edgeFirstShade,
    toPolylines,
    nearestNeighborOrder,
    loadImageFile,
    loadOpenCv,
    configureOpenCv,
    getOpenCvUrl,
    DEFAULT_OPENCV_URL,
    NoEdgesFound,
    ImageLoadError,
    type DecodedImage,
    type EdgeOptions,
    type CannyAdapter,
    type OpenCvModule,
} from './image_processor';
import type { Point, Polyline } from '../types';

/**
 * Unit tests for the PURE pieces of the Image_Processor:
 *   - traceContours (binary edge bitmap → ordered polylines, Req 4.3/4.6)
 *   - clampEdgeOptions (threshold clamping/normalisation, Req 4.2)
 *   - toPolylines empty handling (NoEdgesFound, Req 4.8) via an injected
 *     fake Canny adapter (opencv.js cannot run under jsdom)
 *   - loadImageFile validation integration (Req 2.4/2.5)
 *   - the loadOpenCv URL-config seam (the WASM load itself is untested)
 *
 * The real Canny pipeline (runCanny / loadOpenCv DOM injection) is
 * WASM/DOM-dependent and intentionally left to manual/e2e testing.
 */

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

/**
 * Build a binary edge bitmap from a list of "###" rows where '#'
 * (any non-space) marks an edge pixel. All rows must be equal length.
 */
function bitmapFromRows(rows: string[]): {
    bitmap: Uint8Array;
    width: number;
    height: number;
} {
    const height = rows.length;
    const width = height > 0 ? rows[0].length : 0;
    const bitmap = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        const row = rows[y];
        expect(row.length).toBe(width);
        for (let x = 0; x < width; x++) {
            if (row[x] !== ' ' && row[x] !== '.') {
                bitmap[y * width + x] = 255;
            }
        }
    }
    return { bitmap, width, height };
}

const chebyshev = (a: Point, b: Point): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Assert the pixel-adjacency invariant (Req 4.6) over a single polyline. */
function expectChebyshevAdjacent(poly: Polyline): void {
    expect(poly.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < poly.length; i++) {
        expect(chebyshev(poly[i - 1], poly[i])).toBeLessThanOrEqual(1);
    }
}

/** Collect the set of "x,y" keys covered by all polylines. */
function coveredKeys(polys: Polyline[]): Set<string> {
    const s = new Set<string>();
    for (const poly of polys) {
        for (const p of poly) s.add(`${p.x},${p.y}`);
    }
    return s;
}

/** Collect the set of edge-pixel "x,y" keys in a bitmap. */
function edgeKeys(bitmap: Uint8Array, width: number, height: number): Set<string> {
    const s = new Set<string>();
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (bitmap[y * width + x] !== 0) s.add(`${x},${y}`);
        }
    }
    return s;
}

// -----------------------------------------------------------------------------
// traceContours (Req 4.3 / 4.6)
// -----------------------------------------------------------------------------

describe('traceContours', () => {
    it('returns [] for an all-zero bitmap', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '.....',
            '.....',
            '.....',
            '.....',
            '.....',
        ]);
        expect(traceContours(bitmap, width, height)).toEqual([]);
    });

    it('returns [] for zero-dimension images', () => {
        expect(traceContours(new Uint8Array(0), 0, 0)).toEqual([]);
        expect(traceContours(new Uint8Array(0), 5, 0)).toEqual([]);
    });

    it('traces a diagonal line as one Chebyshev-adjacent polyline covering all pixels', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '#....',
            '.#...',
            '..#..',
            '...#.',
            '....#',
        ]);
        const polys = traceContours(bitmap, width, height);
        expect(polys).toHaveLength(1);
        expectChebyshevAdjacent(polys[0]);
        // Covers every edge pixel.
        expect(coveredKeys(polys)).toEqual(edgeKeys(bitmap, width, height));
        // A diagonal of 5 pixels traces to exactly 5 points.
        expect(polys[0]).toHaveLength(5);
    });

    it('traces an L-shape as one polyline with all consecutive points adjacent', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '#....',
            '#....',
            '#....',
            '#....',
            '#####',
        ]);
        const polys = traceContours(bitmap, width, height);
        // The L is a single 8-connected run.
        expect(polys).toHaveLength(1);
        expectChebyshevAdjacent(polys[0]);
        expect(coveredKeys(polys)).toEqual(edgeKeys(bitmap, width, height));
    });

    it('traces a small closed loop covering every pixel with adjacency held', () => {
        // 4x4 hollow square border.
        const { bitmap, width, height } = bitmapFromRows([
            '####',
            '#..#',
            '#..#',
            '####',
        ]);
        const polys = traceContours(bitmap, width, height);
        // All polylines must satisfy adjacency and together cover the loop.
        for (const poly of polys) expectChebyshevAdjacent(poly);
        expect(coveredKeys(polys)).toEqual(edgeKeys(bitmap, width, height));
    });

    it('emits a degenerate two-point polyline for an isolated pixel', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '.....',
            '.....',
            '..#..',
            '.....',
            '.....',
        ]);
        const polys = traceContours(bitmap, width, height);
        expect(polys).toHaveLength(1);
        expect(polys[0]).toHaveLength(2);
        expect(polys[0][0]).toEqual({ x: 2, y: 2 });
        expect(polys[0][1]).toEqual({ x: 2, y: 2 });
        expectChebyshevAdjacent(polys[0]);
    });

    it('separates two disconnected contours and covers both', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '#......#',
            '#......#',
            '#......#',
        ]);
        const polys = traceContours(bitmap, width, height);
        expect(polys.length).toBeGreaterThanOrEqual(2);
        for (const poly of polys) expectChebyshevAdjacent(poly);
        expect(coveredKeys(polys)).toEqual(edgeKeys(bitmap, width, height));
    });

    it('throws on a bitmap shorter than width*height', () => {
        expect(() => traceContours(new Uint8Array(3), 5, 5)).toThrow(RangeError);
    });
});

// -----------------------------------------------------------------------------
// clampEdgeOptions (Req 4.2)
// -----------------------------------------------------------------------------

describe('clampEdgeOptions', () => {
    it('passes through in-range, ordered thresholds unchanged', () => {
        const opts: EdgeOptions = {
            lowerThreshold: 50,
            upperThreshold: 150,
            blurSigma: 1.4,
        };
        // contrast defaults to 1 (no boost) and minContourPoints to 1 (no
        // filtering) when omitted from the input; mode defaults to 'edge' and
        // shadeFill to false (Mode 1).
        expect(clampEdgeOptions(opts)).toEqual({
            ...opts,
            contrast: 1,
            minContourPoints: 1,
            mode: 'edge',
            shadeRows: 110,
            shadeFill: false,
        });
    });

    it('clamps thresholds below 0 up to 0', () => {
        const r = clampEdgeOptions({
            lowerThreshold: -20,
            upperThreshold: 100,
            blurSigma: 0,
        });
        expect(r.lowerThreshold).toBe(0);
        expect(r.upperThreshold).toBe(100);
    });

    it('clamps thresholds above 255 down to 255', () => {
        const r = clampEdgeOptions({
            lowerThreshold: 10,
            upperThreshold: 999,
            blurSigma: 0,
        });
        expect(r.lowerThreshold).toBe(10);
        expect(r.upperThreshold).toBe(255);
    });

    it('normalises lower > upper by swapping', () => {
        const r = clampEdgeOptions({
            lowerThreshold: 200,
            upperThreshold: 50,
            blurSigma: 0,
        });
        expect(r.lowerThreshold).toBe(50);
        expect(r.upperThreshold).toBe(200);
        expect(r.lowerThreshold).toBeLessThanOrEqual(r.upperThreshold);
    });

    it('rounds fractional thresholds to whole values', () => {
        const r = clampEdgeOptions({
            lowerThreshold: 10.6,
            upperThreshold: 100.4,
            blurSigma: 0,
        });
        expect(r.lowerThreshold).toBe(11);
        expect(r.upperThreshold).toBe(100);
    });

    it('falls back to defaults for non-finite thresholds and negative sigma', () => {
        const r = clampEdgeOptions({
            lowerThreshold: Number.NaN,
            upperThreshold: Number.POSITIVE_INFINITY,
            blurSigma: -3,
        });
        expect(r.lowerThreshold).toBe(0);
        expect(r.upperThreshold).toBe(255);
        expect(r.blurSigma).toBe(0);
    });
});

// -----------------------------------------------------------------------------
// toPolylines (Req 4.1 / 4.8) via injected fake Canny
// -----------------------------------------------------------------------------

describe('toPolylines', () => {
    const img2x2: DecodedImage = {
        width: 5,
        height: 5,
        data: new Uint8ClampedArray(5 * 5 * 4),
    };
    const opts: EdgeOptions = {
        lowerThreshold: 50,
        upperThreshold: 150,
        blurSigma: 0,
    };

    it('throws NoEdgesFound when the edge bitmap is empty', () => {
        const emptyCanny: CannyAdapter = (img) =>
            new Uint8Array(img.width * img.height);
        expect(() => toPolylines(img2x2, opts, { canny: emptyCanny })).toThrow(
            NoEdgesFound,
        );
    });

    it('returns Chebyshev-adjacent polylines from a non-empty edge bitmap', () => {
        const diagonalCanny: CannyAdapter = (img) => {
            const b = new Uint8Array(img.width * img.height);
            for (let i = 0; i < Math.min(img.width, img.height); i++) {
                b[i * img.width + i] = 255;
            }
            return b;
        };
        const polys = toPolylines(img2x2, opts, { canny: diagonalCanny });
        expect(polys.length).toBeGreaterThan(0);
        for (const poly of polys) expectChebyshevAdjacent(poly);
    });

    it('passes clamped thresholds to the canny adapter', () => {
        let seen: EdgeOptions | null = null;
        const recordingCanny: CannyAdapter = (img, o) => {
            seen = o;
            const b = new Uint8Array(img.width * img.height);
            b[0] = 255;
            return b;
        };
        toPolylines(
            img2x2,
            { lowerThreshold: 300, upperThreshold: -10, blurSigma: -1 },
            { canny: recordingCanny },
        );
        expect(seen).not.toBeNull();
        // -10 → 0 (clamped), 300 → 255 (clamped); swapped so lower ≤ upper.
        expect(seen!.lowerThreshold).toBe(0);
        expect(seen!.upperThreshold).toBe(255);
        expect(seen!.blurSigma).toBe(0);
    });
});

// -----------------------------------------------------------------------------
// nearestNeighborOrder (Req 4.7, minimal greedy version)
// -----------------------------------------------------------------------------

describe('nearestNeighborOrder', () => {
    it('orders polylines starting from the nearest endpoint', () => {
        const far: Polyline = [
            { x: 100, y: 100 },
            { x: 101, y: 100 },
        ];
        const near: Polyline = [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
        ];
        const ordered = nearestNeighborOrder([far, near], { x: 0, y: 0 });
        expect(ordered[0]).toEqual(near);
        expect(ordered[1]).toEqual(far);
    });

    it('flips a polyline when its tail is closer than its head', () => {
        const poly: Polyline = [
            { x: 10, y: 0 },
            { x: 1, y: 0 },
        ];
        const ordered = nearestNeighborOrder([poly], { x: 0, y: 0 });
        // Tail (1,0) is closer to origin, so the polyline is reversed.
        expect(ordered[0][0]).toEqual({ x: 1, y: 0 });
        expect(ordered[0][1]).toEqual({ x: 10, y: 0 });
    });

    it('drops empty polylines and preserves the rest', () => {
        const a: Polyline = [
            { x: 5, y: 5 },
            { x: 6, y: 5 },
        ];
        const ordered = nearestNeighborOrder([[], a], { x: 0, y: 0 });
        expect(ordered).toHaveLength(1);
        expect(ordered[0]).toEqual(a);
    });
});

// -----------------------------------------------------------------------------
// loadImageFile validation integration (Req 2.4 / 2.5)
// -----------------------------------------------------------------------------

describe('loadImageFile', () => {
    const makeFile = (name: string, type: string, sizeBytes: number): File =>
        new File([new Uint8Array(sizeBytes)], name, { type });

    it('rejects an unsupported format (gif) with ImageLoadError', async () => {
        const gif = makeFile('anim.gif', 'image/gif', 1024);
        await expect(loadImageFile(gif)).rejects.toBeInstanceOf(ImageLoadError);
    });

    it('rejects an oversize file with ImageLoadError', async () => {
        const huge = makeFile('huge.png', 'image/png', 10 * 1024 * 1024 + 1);
        await expect(loadImageFile(huge)).rejects.toBeInstanceOf(ImageLoadError);
    });

    it('rejects SVG (handled by the SVG extractor in task 17.2)', async () => {
        const svg = makeFile('icon.svg', 'image/svg+xml', 256);
        await expect(loadImageFile(svg)).rejects.toBeInstanceOf(ImageLoadError);
    });

    it('decodes a valid raster file via an injected decoder', async () => {
        const png = makeFile('foo.png', 'image/png', 1024);
        const fakeImageData = {
            width: 2,
            height: 2,
            data: new Uint8ClampedArray(2 * 2 * 4),
            colorSpace: 'srgb',
        } as unknown as ImageData;
        const fakeDecode = async (): Promise<ImageData> => fakeImageData;
        const decoded = await loadImageFile(png, { decode: fakeDecode });
        expect(decoded.width).toBe(2);
        expect(decoded.height).toBe(2);
        expect(decoded.data).toHaveLength(2 * 2 * 4);
    });
});

// -----------------------------------------------------------------------------
// loadOpenCv URL-config seam (the WASM load itself is untested)
// -----------------------------------------------------------------------------

describe('loadOpenCv (URL-config seam)', () => {
    it('defaults to the documented opencv.js URL', () => {
        configureOpenCv({ url: DEFAULT_OPENCV_URL });
        expect(getOpenCvUrl()).toBe(DEFAULT_OPENCV_URL);
    });

    it('uses a configured URL and resolves the injected module', async () => {
        const fakeCv = { Canny: () => { } } as unknown as OpenCvModule;
        let injectedUrl = '';
        const mod = await loadOpenCv({
            url: 'https://example.test/opencv.js',
            inject: async (url) => {
                injectedUrl = url;
            },
            getCv: () => fakeCv,
        });
        expect(injectedUrl).toBe('https://example.test/opencv.js');
        expect(mod).toBe(fakeCv);
        // Reset cached module so later tests/usages re-load cleanly.
        configureOpenCv({ url: DEFAULT_OPENCV_URL });
    });

    it('rejects when the cv global is missing after injection', async () => {
        configureOpenCv({ url: DEFAULT_OPENCV_URL });
        await expect(
            loadOpenCv({
                inject: async () => { },
                getCv: () => undefined,
            }),
        ).rejects.toThrow(/cv` global/);
        configureOpenCv({ url: DEFAULT_OPENCV_URL });
    });
});

describe('clampContrast', () => {
    it('defaults a missing/non-finite value to 1 (no boost)', () => {
        expect(clampContrast(undefined)).toBe(1);
        expect(clampContrast(NaN)).toBe(1);
        expect(clampContrast(Infinity)).toBe(1);
    });
    it('clamps into [1, 4]', () => {
        expect(clampContrast(0.5)).toBe(1);
        expect(clampContrast(2)).toBe(2);
        expect(clampContrast(10)).toBe(4);
    });
});

describe('applyContrast', () => {
    function img1px(r: number, g: number, b: number, a = 255): DecodedImage {
        return { width: 1, height: 1, data: new Uint8ClampedArray([r, g, b, a]) };
    }

    it('is a no-op at factor 1 (returns the same reference)', () => {
        const img = img1px(10, 20, 30);
        expect(applyContrast(img, 1)).toBe(img);
    });

    it('pushes values away from mid-gray (128) and preserves alpha', () => {
        // 200 is above mid-gray; doubling contrast pushes it higher (clamped).
        // 50 is below mid-gray; doubling pushes it lower.
        const out = applyContrast(img1px(200, 50, 128, 222), 2);
        // (200-128)*2+128 = 272 -> clamped 255
        expect(out.data[0]).toBe(255);
        // (50-128)*2+128 = -28 -> clamped 0
        expect(out.data[1]).toBe(0);
        // mid-gray stays put: (128-128)*2+128 = 128
        expect(out.data[2]).toBe(128);
        // alpha untouched
        expect(out.data[3]).toBe(222);
    });

    it('does not mutate the input', () => {
        const img = img1px(200, 50, 100);
        const before = Array.from(img.data);
        applyContrast(img, 3);
        expect(Array.from(img.data)).toEqual(before);
    });
});

describe('clampEdgeOptions — contrast field', () => {
    it('clamps and defaults the contrast field', () => {
        expect(
            clampEdgeOptions({
                lowerThreshold: 10,
                upperThreshold: 20,
                blurSigma: 1,
            }).contrast,
        ).toBe(1);
        expect(
            clampEdgeOptions({
                lowerThreshold: 10,
                upperThreshold: 20,
                blurSigma: 1,
                contrast: 9,
            }).contrast,
        ).toBe(4);
    });
});

describe('centerlineEdges (Zhang-Suen thinning)', () => {
    const opts: EdgeOptions = {
        lowerThreshold: 50,
        upperThreshold: 150,
        blurSigma: 0,
    };

    /** Build a WxH RGBA image where `dark(x,y)` decides ink (black) vs white. */
    function makeImg(
        w: number,
        h: number,
        dark: (x: number, y: number) => boolean,
    ): DecodedImage {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const o = (y * w + x) * 4;
                const v = dark(x, y) ? 0 : 255;
                data[o] = v;
                data[o + 1] = v;
                data[o + 2] = v;
                data[o + 3] = 255;
            }
        }
        return { width: w, height: h, data };
    }

    it('thins a thick horizontal bar to a thin centerline', () => {
        // A 12-wide, 5-tall black bar (rows 3..7) inside a 12x12 white image.
        const w = 12;
        const h = 12;
        const img = makeImg(w, h, (x, y) => y >= 3 && y <= 7 && x >= 1 && x <= 10);

        // Filled bar = 5 rows (3..7) x 10 cols (1..10) = 50 foreground pixels.
        const before = 50;

        const skel = centerlineEdges(img, opts);
        let after = 0;
        for (let i = 0; i < skel.length; i++) if (skel[i] !== 0) after++;

        // The skeleton is far sparser than the filled bar (one row, not five).
        expect(after).toBeGreaterThan(0);
        expect(after).toBeLessThan(before / 2);
    });

    it('returns an all-background image as empty (no skeleton)', () => {
        const img = makeImg(8, 8, () => false);
        const skel = centerlineEdges(img, opts);
        expect(skel.every((v) => v === 0)).toBe(true);
    });

    it('produces a 0/255 bitmap of the right length', () => {
        const img = makeImg(6, 6, (x) => x === 3);
        const skel = centerlineEdges(img, opts);
        expect(skel.length).toBe(36);
        for (const v of skel) expect(v === 0 || v === 255).toBe(true);
    });
});

describe('toPolylines — centerline mode', () => {
    it('selects the centerline adapter when mode is centerline', () => {
        // A thick vertical bar: edge mode would trace both sides (2 contours);
        // centerline collapses it toward a single line.
        const w = 10;
        const h = 16;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const o = (y * w + x) * 4;
                const dark = x >= 3 && x <= 6 && y >= 1 && y <= 14;
                const v = dark ? 0 : 255;
                data[o] = v;
                data[o + 1] = v;
                data[o + 2] = v;
                data[o + 3] = 255;
            }
        }
        const img: DecodedImage = { width: w, height: h, data };

        const edgePts = toPolylines(img, {
            lowerThreshold: 50,
            upperThreshold: 150,
            blurSigma: 0,
            mode: 'edge',
        }).reduce((a, p) => a + p.length, 0);

        const centerPts = toPolylines(img, {
            lowerThreshold: 50,
            upperThreshold: 150,
            blurSigma: 0,
            mode: 'centerline',
        }).reduce((a, p) => a + p.length, 0);

        // Centerline yields strictly fewer points than the doubled outline.
        expect(centerPts).toBeLessThan(edgePts);
    });
});

// -----------------------------------------------------------------------------
// edgeFirstShade — Mode 1 (outline only)
//
// The new `shaded` generator draws the subject's silhouette + strongest
// internal contours as real curves (no raster sweep). Tests use the machine's
// REAL Chebyshev cost (`Σ max(|Δx|,|Δy|)`, mirroring `totalStepCount` in
// `path/planner.ts`) — never vertex count — for any cost assertion.
// -----------------------------------------------------------------------------

describe('edgeFirstShade (Mode 1 outline)', () => {
    /** Build a WxH RGBA image where `dark(x,y)` decides black (ink) vs white. */
    function makeImg(
        w: number,
        h: number,
        dark: (x: number, y: number) => boolean,
    ): DecodedImage {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const o = (y * w + x) * 4;
                const v = dark(x, y) ? 0 : 255;
                data[o] = v;
                data[o + 1] = v;
                data[o + 2] = v;
                data[o + 3] = 255;
            }
        }
        return { width: w, height: h, data };
    }

    /** A filled dark disk on a white background (portrait-like silhouette). */
    function diskImg(w: number, h: number, cx: number, cy: number, r: number) {
        return makeImg(w, h, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
    }

    /** Bounding box of a set of polylines. */
    function bboxOf(polys: Polyline[]): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const poly of polys) {
            for (const p of poly) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            }
        }
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    }

    /**
     * Local Chebyshev-cost helper mirroring `totalStepCount` in
     * `web/src/path/planner.ts`: `Σ over consecutive (a,b) of
     * max(|b.x-a.x|, |b.y-a.y|)` summed over every polyline. This is the
     * machine's REAL step metric — NOT vertex count.
     */
    function chebyshevCost(polys: Polyline[]): number {
        let total = 0;
        for (const poly of polys) {
            for (let i = 1; i < poly.length; i++) {
                const a = poly[i - 1];
                const b = poly[i];
                total += Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
            }
        }
        return total;
    }

    const baseOpts: EdgeOptions = {
        lowerThreshold: 50,
        upperThreshold: 150,
        blurSigma: 0,
        mode: 'shaded',
    };

    // --- Example: non-degenerate bounding box (Req 4.1) ----------------------
    it('produces a non-degenerate bounding box for a portrait-like fixture (Req 4.1)', () => {
        const img = diskImg(48, 48, 24, 24, 18);
        const out = edgeFirstShade(img, baseOpts);
        expect(out.length).toBeGreaterThan(0);
        const bbox = bboxOf(out);
        expect(bbox.width).toBeGreaterThan(0);
        expect(bbox.height).toBeGreaterThan(0);
    });

    // --- PBT: determinism (Req 3.4) ------------------------------------------
    // Feature: image-tonal-hatching, Property 8: For any image and options, two
    // runs of edgeFirstShade SHALL produce deeply-equal Polyline[] output.
    it('is deterministic: same input + options → deeply-equal output (Req 3.4)', () => {
        fc.assert(
            fc.property(
                // Small random grayscale images with a guaranteed dark core so
                // some contours usually survive (determinism must hold either
                // way — empty vs non-empty are both deterministic).
                fc.integer({ min: 16, max: 32 }),
                fc.integer({ min: 16, max: 32 }),
                fc.array(fc.integer({ min: 0, max: 255 }), {
                    minLength: 32 * 32,
                    maxLength: 32 * 32,
                }),
                (w, h, noise) => {
                    const img = makeImg(w, h, () => false);
                    // Stamp pseudo-random darkness from the noise array, plus a
                    // dark rectangle so strong edges exist.
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const o = (y * w + x) * 4;
                            const inBlob =
                                x >= 4 && x <= w - 5 && y >= 4 && y <= h - 5;
                            const v = inBlob
                                ? 0
                                : noise[(y * w + x) % noise.length]!;
                            img.data[o] = v;
                            img.data[o + 1] = v;
                            img.data[o + 2] = v;
                            img.data[o + 3] = 255;
                        }
                    }
                    const a = edgeFirstShade(img, baseOpts);
                    const b = edgeFirstShade(img, baseOpts);
                    expect(a).toEqual(b);
                },
            ),
            { numRuns: 100 },
        );
    });

    // --- Example: light-region / empty handling (Req 2.1) --------------------
    it('returns [] for a uniform/near-blank image (no surviving contours) (Req 2.1)', () => {
        const blank = makeImg(32, 32, () => false);
        expect(edgeFirstShade(blank, baseOpts)).toEqual([]);
    });

    it('toPolylines shaded-mode throws NoEdgesFound on a blank image (Req 2.1)', () => {
        const blank = makeImg(32, 32, () => false);
        expect(() => toPolylines(blank, baseOpts)).toThrow(NoEdgesFound);
    });

    // --- PBT: monotonic REAL cost vs. detail (Req 3.1) -----------------------
    // Feature: image-tonal-hatching, Property 5: For any fixed image, lowering
    // the shading-detail budget SHALL not increase the total Chebyshev cost.
    //
    // The lever that exists in Mode 1 is `minContourPoints`: raising it filters
    // more aggressively (fewer/shorter contours survive), so it is the
    // "lower detail" setting. We assert cost(moreFiltering) <= cost(lessFiltering)
    // on a fixture with a long silhouette plus several short strokes whose point
    // counts straddle the filter thresholds.
    it('does not increase REAL Chebyshev cost as detail is lowered (Req 3.1)', () => {
        // Fixture: a dark disk (long contour) plus three diagonal strokes of
        // increasing length scattered around it. Built once; reused per run.
        const W = 70;
        const H = 70;
        const strokes: Array<[number, number, number]> = [
            [50, 5, 14],
            [5, 50, 20],
            [50, 50, 26],
        ];
        const isStroke = (x: number, y: number): boolean =>
            strokes.some(([x0, y0, len]) => {
                for (let t = 0; t < len; t++) {
                    if (x === x0 + t && y === y0 + t) return true;
                }
                return false;
            });
        const img = makeImg(
            W,
            H,
            (x, y) => (x - 22) ** 2 + (y - 22) ** 2 <= 14 * 14 || isStroke(x, y),
        );

        fc.assert(
            fc.property(
                // Two detail levels; `more` >= `less` filtering.
                fc.integer({ min: 2, max: 260 }),
                fc.integer({ min: 2, max: 260 }),
                (a, b) => {
                    const lessFiltering = Math.min(a, b); // higher detail
                    const moreFiltering = Math.max(a, b); // lower detail
                    const costLess = chebyshevCost(
                        edgeFirstShade(img, {
                            ...baseOpts,
                            minContourPoints: lessFiltering,
                        }),
                    );
                    const costMore = chebyshevCost(
                        edgeFirstShade(img, {
                            ...baseOpts,
                            minContourPoints: moreFiltering,
                        }),
                    );
                    expect(costMore).toBeLessThanOrEqual(costLess);
                },
            ),
            { numRuns: 100 },
        );
    });

    // --- Example: recognizable silhouette (Req 1.3) --------------------------
    it('captures the silhouette: a contour bbox spans most of a dark blob (Req 1.3)', () => {
        const W = 48;
        const H = 48;
        const cx = 24;
        const cy = 24;
        const r = 18;
        const img = diskImg(W, H, cx, cy, r);
        const out = edgeFirstShade(img, baseOpts);
        expect(out.length).toBeGreaterThan(0);

        // The blob spans roughly [cx-r, cx+r] x [cy-r, cy+r] (diameter 2r).
        const diameter = 2 * r;
        // At least one contour must individually span a large fraction of the
        // blob on BOTH axes (the silhouette is captured as a single curve).
        const spanned = out.some((poly) => {
            const bb = bboxOf([poly]);
            return (
                bb.width >= diameter * 0.7 && bb.height >= diameter * 0.7
            );
        });
        expect(spanned).toBe(true);
    });

    // --- Example: wiring (Req 5.2) -------------------------------------------
    it('toPolylines shaded-mode routes to edgeFirstShade (non-empty, no throw) (Req 5.2)', () => {
        const img = diskImg(48, 48, 24, 24, 18);
        const viaToPolylines = toPolylines(img, baseOpts);
        expect(viaToPolylines.length).toBeGreaterThan(0);
        // The routed output equals the direct generator output (same pipeline;
        // contrast defaults to 1 so applyContrast is a no-op here).
        const direct = edgeFirstShade(img, clampEdgeOptions(baseOpts));
        expect(viaToPolylines).toEqual(direct);
    });
});
