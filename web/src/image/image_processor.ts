/**
 * `Image_Processor` — raster image loading and Canny edge detection.
 *
 * This module turns an uploaded raster image (PNG / JPEG / BMP) into a set
 * of ordered {@link Polyline}s suitable for the path planner. The heavy
 * computer-vision work (Gaussian blur → Sobel → non-maximum suppression →
 * double-threshold hysteresis, i.e. Canny) runs in `opencv.js`, a large
 * WASM module that is **lazy-loaded on first image import only** so it never
 * bloats the always-resident SPA bundle (Design §2.4.1, §3.1.1).
 *
 * Architecture — the module is deliberately split into two halves:
 *
 *   • **Pure / testable** (no DOM, no WASM): format & size validation
 *     (delegated to {@link validateImageFile}), {@link clampEdgeOptions}
 *     threshold clamping, {@link traceContours} (binary edge bitmap →
 *     ordered polylines with the pixel-adjacency invariant of Req 4.6),
 *     {@link nearestNeighborOrder}, and the {@link NoEdgesFound} error.
 *
 *   • **WASM / DOM dependent** (cannot run under jsdom): the `<canvas>`
 *     decode path ({@link decodeRasterToImageData}), the {@link runCanny}
 *     adapter over `cv.Canny`, and the {@link loadOpenCv} script-injection
 *     loader. These are kept as thin, injectable seams so the pure core can
 *     be unit-tested in isolation and the WASM pieces can be stubbed.
 *
 * SVG is handled by a separate extractor (task 17.2) and is rejected here.
 * Nearest-neighbor contour ordering is finalised in task 17.3 — the
 * {@link nearestNeighborOrder} below is a minimal greedy version that 17.3
 * refines.
 *
 * @see Design §3.1.1, §2.4.1
 * @see Requirements 2.1, 2.4, 2.5, 2.6, 2.7, 4.1, 4.2, 4.3, 4.6, 4.8
 */

import type { Point, Polyline } from '../types';
import { validateImageFile } from '../validators';
import { orderPolylinesNearestNeighbor } from '../path/nn_order';

// -----------------------------------------------------------------------------
// Public data shapes (Design §3.1.1)
// -----------------------------------------------------------------------------

/**
 * A decoded raster image in RGBA8 form. `data` is row-major, 4 bytes per
 * pixel (R, G, B, A), length `width * height * 4` — the same layout as a
 * `CanvasRenderingContext2D` `ImageData`.
 */
export interface DecodedImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

/**
 * Tunable parameters for the Canny edge detector.
 *
 *   - `lowerThreshold` / `upperThreshold`: hysteresis thresholds in
 *     `[0, 255]` (Req 4.2). Values are clamped and normalised by
 *     {@link clampEdgeOptions} so `lower ≤ upper`.
 *   - `blurSigma`: standard deviation of the pre-blur Gaussian, in pixels.
 *     `0` disables the explicit pre-blur.
 */
export interface EdgeOptions {
    lowerThreshold: number;
    upperThreshold: number;
    blurSigma: number;
    /**
     * Contrast boost applied to the decoded image BEFORE edge detection, as a
     * multiplier around mid-gray (128). 1 = no change; >1 increases contrast,
     * which collapses subtle tonal gradients so Canny fires only on strong
     * boundaries — fewer, cleaner edges and far less detail to draw. Optional;
     * defaults to 1 (no boost) when omitted. Clamped to [1, 4].
     */
    contrast?: number;
    /**
     * Minimum traced-contour length (in points) to keep. Edge detection emits
     * a fringe of very short noise contours along thick/soft edges ("furry"
     * lines) that bloat the step count; contours below this are dropped as
     * noise. Optional; defaults to 1 (no filtering) so the pure tracing
     * contract is unchanged. The image UI passes a higher value to denoise.
     */
    minContourPoints?: number;
    /**
     * Tracing mode. `'edge'` (default) traces stroke outlines via {@link
     * sobelEdges}; `'centerline'` reduces strokes to their 1-pixel skeleton via
     * {@link centerlineEdges} so each stroke is drawn once down its middle —
     * far fewer steps on line art. An injected `deps.canny` adapter overrides
     * this. Defaults to `'edge'`.
     */
    mode?: 'edge' | 'centerline' | 'shaded';
    /**
     * Number of horizontal scan rows for `'shaded'` mode. More rows = finer
     * tone and more detail, but more steps / longer draw. Defaults to
     * {@link SHADE_ROWS_DEFAULT}. Clamped to [8, 400].
     */
    shadeRows?: number;
    /**
     * `'shaded'`-mode phase selector. `false`/absent → **Mode 1** (outline
     * only: silhouette + strongest internal contours as real curves — the
     * default that ships first); `true` → **Mode 2** (outline + sparse interior
     * hatch clipped to the large dark masses), which attaches in a later phase.
     * Mode 1 ignores this flag. Optional; defaults to `false` in
     * {@link clampEdgeOptions}.
     */
    shadeFill?: boolean;
}

/**
 * The `Image_Processor` surface from Design §3.1.1.
 */
export interface ImageProcessor {
    loadFile(file: File): Promise<DecodedImage>;
    toPolylines(img: DecodedImage, opts: EdgeOptions): Polyline[];
    nearestNeighborOrder(polys: Polyline[], from: Point): Polyline[];
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Thrown by {@link toPolylines} when edge detection yields no contours.
 * The UI surfaces this with a "tweak the threshold and retry" call to
 * action (Req 4.8).
 */
export class NoEdgesFound extends Error {
    constructor(
        message = 'No edges were found. Adjust the threshold values and try again.',
    ) {
        super(message);
        this.name = 'NoEdgesFound';
        // Restore the prototype chain for `instanceof` across transpile targets.
        Object.setPrototypeOf(this, NoEdgesFound.prototype);
    }
}

/**
 * Thrown by the loader when a file is rejected before decoding — an
 * unsupported format, an oversize file, or an SVG (which is handled by the
 * separate SVG extractor, task 17.2). Carries a user-facing message.
 */
export class ImageLoadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImageLoadError';
        Object.setPrototypeOf(this, ImageLoadError.prototype);
    }
}

/**
 * Thrown when a structurally-valid upload cannot be decoded — i.e. the
 * bytes are unreadable or corrupt (Req 2.7).
 */
export class ImageDecodeError extends Error {
    constructor(
        message = 'The image could not be processed. Please choose a different file.',
    ) {
        super(message);
        this.name = 'ImageDecodeError';
        Object.setPrototypeOf(this, ImageDecodeError.prototype);
    }
}

// -----------------------------------------------------------------------------
// EdgeOptions clamping (pure, Req 4.2)
// -----------------------------------------------------------------------------

/** Inclusive bounds on the Canny hysteresis thresholds (Req 4.2). */
export const THRESHOLD_MIN = 0;
export const THRESHOLD_MAX = 255;

/** Clamp a single threshold into `[0, 255]`, rounding to a whole value. */
function clampThreshold(v: number, fallback: number): number {
    if (!Number.isFinite(v)) return fallback;
    return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, Math.round(v)));
}

/**
 * Clamp and normalise {@link EdgeOptions}:
 *   - both thresholds are forced into `[0, 255]` and rounded;
 *   - if `lower > upper` the two are swapped so the result always
 *     satisfies `lower ≤ upper`;
 *   - `blurSigma` is forced to be a finite, non-negative number.
 *
 * Non-finite inputs fall back to sensible defaults (`0` lower, `255`
 * upper, `0` sigma) so a malformed slider value can never reach the
 * native Canny call.
 *
 * @see Requirements 4.2
 */
export function clampEdgeOptions(opts: EdgeOptions): EdgeOptions {
    let lower = clampThreshold(opts.lowerThreshold, THRESHOLD_MIN);
    let upper = clampThreshold(opts.upperThreshold, THRESHOLD_MAX);
    if (lower > upper) {
        const tmp = lower;
        lower = upper;
        upper = tmp;
    }
    const blurSigma =
        Number.isFinite(opts.blurSigma) && opts.blurSigma > 0
            ? opts.blurSigma
            : 0;
    const contrast = clampContrast(opts.contrast);
    const minContourPoints =
        Number.isFinite(opts.minContourPoints) &&
            (opts.minContourPoints as number) > 1
            ? Math.floor(opts.minContourPoints as number)
            : 1;
    return {
        lowerThreshold: lower,
        upperThreshold: upper,
        blurSigma,
        contrast,
        minContourPoints,
        mode:
            opts.mode === 'centerline'
                ? 'centerline'
                : opts.mode === 'shaded'
                    ? 'shaded'
                    : 'edge',
        shadeRows:
            Number.isFinite(opts.shadeRows) && (opts.shadeRows as number) > 0
                ? Math.min(400, Math.max(8, Math.floor(opts.shadeRows as number)))
                : SHADE_ROWS_DEFAULT,
        shadeFill: opts.shadeFill === true,
    };
}

/** Inclusive bounds on the pre-edge contrast multiplier. */
export const CONTRAST_MIN = 1;
export const CONTRAST_MAX = 4;

/**
 * Clamp the contrast multiplier into `[CONTRAST_MIN, CONTRAST_MAX]`. A missing
 * or non-finite value falls back to 1 (no contrast change).
 */
export function clampContrast(v: number | undefined): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) return CONTRAST_MIN;
    return Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, v));
}

/**
 * Return a new {@link DecodedImage} with a contrast boost applied around
 * mid-gray (128), per-channel on RGB (alpha untouched). `factor === 1` is a
 * no-op and returns the input unchanged. Pure and host-testable — the boost is
 * applied on the decoded RGBA buffer before grayscale/Canny so it improves edge
 * detection regardless of the (WASM) edge adapter.
 *
 *   out = clamp((in - 128) * factor + 128, 0, 255)
 */
export function applyContrast(img: DecodedImage, factor: number): DecodedImage {
    if (factor === 1) return img;
    const src = img.data;
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
        out[i] = (src[i]! - 128) * factor + 128;
        out[i + 1] = (src[i + 1]! - 128) * factor + 128;
        out[i + 2] = (src[i + 2]! - 128) * factor + 128;
        out[i + 3] = src[i + 3]!; // preserve alpha
    }
    return { width: img.width, height: img.height, data: out };
}

// -----------------------------------------------------------------------------
// Contour tracing (pure, Req 4.3 / 4.6)
// -----------------------------------------------------------------------------

/**
 * The eight neighbour offsets, orthogonal first then diagonal. The walk
 * prefers low-degree neighbours regardless of this order, but a stable
 * ordering keeps the output deterministic for a given bitmap.
 */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
    [0, -1], // N
    [1, 0], // E
    [0, 1], // S
    [-1, 0], // W
    [1, -1], // NE
    [1, 1], // SE
    [-1, 1], // SW
    [-1, -1], // NW
];

/**
 * Trace a binary edge bitmap into ordered polylines.
 *
 * The input is a row-major bitmap where any non-zero byte marks an edge
 * pixel. Output polylines walk along 8-connected runs of edge pixels so
 * that **every pair of consecutive points differs by Chebyshev distance
 * ≤ 1** (Req 4.6) — i.e. each step lands on an immediate neighbour.
 *
 * The walk:
 *   1. Collect every edge pixel.
 *   2. Start traces from endpoints (pixels with the fewest edge neighbours)
 *      first so thin single-pixel-width contours come out as one long
 *      polyline rather than two halves.
 *   3. From the current pixel, step to the unvisited neighbour with the
 *      fewest remaining unvisited neighbours (peeling branches/loops
 *      cleanly); stop when no unvisited neighbour remains.
 *   4. Repeat until every edge pixel has been visited, so the union of all
 *      emitted points covers the whole edge set.
 *
 * A pixel that is left isolated (no unvisited neighbour at the moment its
 * trace starts) is emitted as a degenerate two-point polyline `[p, p]` so
 * the "every polyline has ≥ 2 points" invariant (Design Property 20) holds
 * and the pixel is still covered.
 *
 * This function is pure and DOM/WASM-free: it is the unit-testable core of
 * Req 4.3 / 4.6.
 *
 * @param edgeBitmap Row-major bytes; non-zero = edge. Length must be at
 *                   least `width * height`.
 * @param width      Image width in pixels (> 0).
 * @param height     Image height in pixels (> 0).
 * @returns          Ordered polylines covering every edge pixel.
 */
export function traceContours(
    edgeBitmap: Uint8Array,
    width: number,
    height: number,
): Polyline[] {
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
        throw new RangeError('traceContours: width and height must be integers');
    }
    if (width <= 0 || height <= 0) return [];

    const n = width * height;
    if (edgeBitmap.length < n) {
        throw new RangeError(
            `traceContours: bitmap length ${edgeBitmap.length} < width*height ${n}`,
        );
    }

    const visited = new Uint8Array(n);
    const isEdge = (idx: number): boolean => edgeBitmap[idx] !== 0;

    /** Edge neighbours of `idx`; when `unvisitedOnly`, skip already-walked. */
    const neighbors = (idx: number, unvisitedOnly: boolean): number[] => {
        const x = idx % width;
        const y = (idx - x) / width;
        const out: number[] = [];
        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const nIdx = ny * width + nx;
            if (!isEdge(nIdx)) continue;
            if (unvisitedOnly && visited[nIdx] !== 0) continue;
            out.push(nIdx);
        }
        return out;
    };

    const toPoint = (idx: number): Point => {
        const x = idx % width;
        return { x, y: (idx - x) / width };
    };

    // Collect edge pixels and order trace start points: lowest total edge
    // degree (endpoints) first, then by raster index for determinism.
    const edges: number[] = [];
    for (let i = 0; i < n; i++) {
        if (isEdge(i)) edges.push(i);
    }
    if (edges.length === 0) return [];

    // Precompute each edge pixel's total degree ONCE. The start-ordering sort
    // below must not call neighbors() inside its comparator: Array.sort invokes
    // the comparator O(n log n) times, so recomputing an 8-neighbour scan (plus
    // an array allocation) per comparison is ~tens of millions of synchronous
    // ops on a dense bitmap — enough to freeze the tab. A single O(n) degree
    // pass makes the comparator O(1).
    const degree = new Map<number, number>();
    for (const idx of edges) {
        degree.set(idx, neighbors(idx, false).length);
    }

    const starts = edges.slice().sort((a, b) => {
        const da = degree.get(a)!;
        const db = degree.get(b)!;
        if (da !== db) return da - db;
        return a - b;
    });

    const polylines: Polyline[] = [];
    for (const start of starts) {
        if (visited[start] !== 0) continue;

        const poly: Point[] = [];
        let cur = start;
        for (; ;) {
            visited[cur] = 1;
            poly.push(toPoint(cur));

            const candidates = neighbors(cur, true);
            if (candidates.length === 0) break;

            // Step to the candidate with the fewest unvisited neighbours so
            // that dead-ends and loop closures are consumed first.
            let best = candidates[0];
            let bestDeg = neighbors(best, true).length;
            for (let k = 1; k < candidates.length; k++) {
                const cand = candidates[k];
                const deg = neighbors(cand, true).length;
                if (deg < bestDeg) {
                    bestDeg = deg;
                    best = cand;
                }
            }
            cur = best;
        }

        if (poly.length === 1) {
            // Isolated / fully-surrounded-by-visited pixel: emit a degenerate
            // two-point polyline so the ≥2-point invariant holds.
            poly.push({ x: poly[0].x, y: poly[0].y });
        }
        polylines.push(poly);
    }

    return polylines;
}

// -----------------------------------------------------------------------------
// Nearest-neighbor contour ordering (task 17.3)
// -----------------------------------------------------------------------------

/**
 * Greedily order detected contour polylines to shorten the connector
 * travel between them, flipping a polyline end-for-end when its tail
 * endpoint is closer to the current pen position than its head (Req 4.7).
 *
 * This is a thin wrapper over the shared
 * {@link orderPolylinesNearestNeighbor} helper in `../path/nn_order`, which
 * is the single canonical implementation used by BOTH the Image_Processor
 * and the planner's stitch stage so the two never diverge. The shared
 * helper performs pure ordering only - it does NOT insert connector
 * segments; the planner's `stitchPolylines` weaves connectors in later.
 *
 * Drop semantics: empty polylines (`length < 1`) are dropped while
 * single-point polylines are kept, preserving the behaviour the
 * Image_Processor has always documented. (The stitch stage, in contrast,
 * passes a higher `minPoints` because a single-point stroke has no length
 * to draw.)
 *
 * @param polys Polylines to order (empty ones dropped). Not mutated.
 * @param from  Starting position; ordering begins from the polyline whose
 *              nearest endpoint is closest to this point.
 * @returns     A new array of polylines (each possibly reversed) in visit
 *              order, with no connector segments inserted.
 * @see Requirements 4.7
 */
export function nearestNeighborOrder(
    polys: Polyline[],
    from: Point,
): Polyline[] {
    return orderPolylinesNearestNeighbor(polys, from, { minPoints: 1 });
}

// -----------------------------------------------------------------------------
// Canny adapter + toPolylines (WASM seam, Req 4.1 / 4.3 / 4.8)
// -----------------------------------------------------------------------------

/**
 * Pure-JS Sobel edge detector — the DEFAULT edge adapter.
 *
 * Replaces the opencv.js (WASM) Canny path, which froze the tab: opencv.js is a
 * ~8 MB module whose instantiation compiles synchronously on the main thread,
 * blocking the event loop (so even a load timeout could not fire). A Sobel
 * gradient + threshold needs no download, runs in well under a frame, and
 * produces clean thin edges that are plenty for a single-line pen plotter.
 *
 * Pipeline: RGBA → luminance grayscale → 3x3 Sobel gradient magnitude →
 * threshold. The threshold reuses EdgeOptions.upperThreshold (0..255 on the
 * 8-bit luminance scale) so the existing "contrast"/threshold tuning still
 * applies. Output is a 0/255 byte-per-pixel edge bitmap, the same contract the
 * downstream {@link traceContours} expects.
 *
 * Pure and host-testable (no DOM, no WASM, no network).
 */
export function sobelEdges(img: DecodedImage, opts: EdgeOptions): Uint8Array {
    const { width: w, height: h, data } = img;
    const n = w * h;

    // 1. Grayscale (Rec. 601 luma).
    const gray = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        gray[i] = (data[o]! * 299 + data[o + 1]! * 587 + data[o + 2]! * 114) / 1000;
    }

    // 2. Sobel magnitude + threshold. Border pixels are treated as non-edge.
    const out = new Uint8Array(n);
    // Threshold on the gradient magnitude; derive from the upper Canny
    // threshold so existing tuning carries over. Clamp to a sane floor.
    const threshold = Math.max(16, opts.upperThreshold);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const tl = gray[i - w - 1]!;
            const tc = gray[i - w]!;
            const tr = gray[i - w + 1]!;
            const ml = gray[i - 1]!;
            const mr = gray[i + 1]!;
            const bl = gray[i + w - 1]!;
            const bc = gray[i + w]!;
            const br = gray[i + w + 1]!;
            const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
            const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
            // |gx| + |gy| approximates the magnitude cheaply and adequately.
            const mag = Math.abs(gx) + Math.abs(gy);
            out[i] = mag >= threshold ? 255 : 0;
        }
    }
    return out;
}

/**
 * Centerline (skeleton) edge adapter — reduces dark strokes to their 1-pixel
 * centerline instead of tracing their outline.
 *
 * Edge detectors (Sobel/Canny) trace the BOUNDARY of every stroke, so a thick
 * line becomes two parallel contours plus end caps — drawn twice, with lots of
 * connector travel between the many fragments. For a pen plotter the right
 * model is the CENTERLINE: each stroke becomes a single line down its middle,
 * drawn once, the way a person would draw it. That can cut the step count by
 * ~10x on line art.
 *
 * Pipeline:
 *   1. Grayscale (Rec. 601 luma).
 *   2. Binarize: pixels darker than a threshold are "ink" (foreground). The
 *      threshold derives from EdgeOptions.upperThreshold so existing tuning
 *      carries over; default ~128.
 *   3. Zhang-Suen thinning: iteratively peel foreground pixels off region
 *      boundaries until only the 1-pixel-wide skeleton remains, preserving
 *      connectivity.
 *
 * Output is a 0/255 byte-per-pixel skeleton bitmap, the same contract
 * {@link traceContours} consumes. Pure and host-testable (no DOM/WASM/network).
 *
 * Cost note: thinning is iterative (multiple full-image passes until stable),
 * O(passes * w * h). Bounded here by MAX_THINNING_ITERATIONS so a pathological
 * input cannot loop unbounded; the upstream MAX_DECODE_DIMENSION cap keeps w*h
 * reasonable.
 */
export const MAX_THINNING_ITERATIONS = 100;

export function centerlineEdges(
    img: DecodedImage,
    opts: EdgeOptions,
): Uint8Array {
    const { width: w, height: h, data } = img;
    const n = w * h;

    // 1+2. Grayscale then binarize. Foreground (ink) = 1, background = 0.
    // "Ink" is DARK, so a pixel is foreground when its luma is below the
    // threshold. Derive the cutoff from upperThreshold (clamped to a usable
    // mid range) so the existing contrast control still has an effect.
    const cutoff = Math.min(220, Math.max(40, opts.upperThreshold));
    // `cur` holds the working bitmap (1 = foreground). Border pixels are forced
    // to background so neighbour reads in thinning never go out of bounds.
    const cur = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const o = i * 4;
            const luma =
                (data[o]! * 299 + data[o + 1]! * 587 + data[o + 2]! * 114) /
                1000;
            cur[i] = luma < cutoff ? 1 : 0;
        }
    }

    // 3. Zhang-Suen thinning. Two sub-iterations per pass; stop when a full
    // pass removes nothing (stable skeleton) or the iteration cap is hit.
    const toRemove: number[] = [];
    for (let iter = 0; iter < MAX_THINNING_ITERATIONS; iter++) {
        let removedAny = false;

        for (let step = 0; step < 2; step++) {
            toRemove.length = 0;
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (cur[i] === 0) continue;

                    // 8 neighbours, clockwise from North (p2..p9).
                    const p2 = cur[i - w]!;
                    const p3 = cur[i - w + 1]!;
                    const p4 = cur[i + 1]!;
                    const p5 = cur[i + w + 1]!;
                    const p6 = cur[i + w]!;
                    const p7 = cur[i + w - 1]!;
                    const p8 = cur[i - 1]!;
                    const p9 = cur[i - w - 1]!;

                    // B(p1): number of foreground neighbours.
                    const b =
                        p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
                    if (b < 2 || b > 6) continue;

                    // A(p1): number of 0→1 transitions in the ordered sequence
                    // p2,p3,...,p9,p2.
                    const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
                    let a = 0;
                    for (let k = 0; k < 8; k++) {
                        if (seq[k] === 0 && seq[k + 1] === 1) a++;
                    }
                    if (a !== 1) continue;

                    if (step === 0) {
                        // Sub-iteration 1 conditions.
                        if (p2 * p4 * p6 !== 0) continue;
                        if (p4 * p6 * p8 !== 0) continue;
                    } else {
                        // Sub-iteration 2 conditions.
                        if (p2 * p4 * p8 !== 0) continue;
                        if (p2 * p6 * p8 !== 0) continue;
                    }

                    toRemove.push(i);
                }
            }

            if (toRemove.length > 0) {
                removedAny = true;
                for (const idx of toRemove) cur[idx] = 0;
            }
        }

        if (!removedAny) break;
    }

    // Expand the 1/0 skeleton to the 0/255 edge-bitmap contract.
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = cur[i] ? 255 : 0;
    return out;
}

// -----------------------------------------------------------------------------
// Edge-first silhouette generator (the new "shaded" mode — Mode 1: outline only)
// -----------------------------------------------------------------------------

/**
 * Standard deviation (in pixels) of the light Gaussian pre-blur applied before
 * edge detection in {@link edgeFirstShade}. Just enough to suppress skin/paper
 * texture and sensor noise so the high-threshold Sobel fires on real boundaries
 * (silhouette, eyebrows, jaw, hairline) rather than a furry fringe. Internal,
 * tunable constant (mirrors the `HATCH_*` style).
 */
export const OUTLINE_BLUR_SIGMA = 1.2;

/**
 * Gradient-magnitude threshold (on the `|gx| + |gy|` scale that
 * {@link sobelEdges} uses, passed through as `EdgeOptions.upperThreshold`) for
 * the outline pass. Deliberately HIGH so only the silhouette and the strongest
 * internal contours survive; soft tonal gradients fall below it and are dropped
 * (they would otherwise produce a furry, high-step trace). Internal, tunable.
 */
export const OUTLINE_EDGE_THRESHOLD = 120;

/**
 * Minimum size, as a traced contour's bounding-box DIAGONAL in pixels, for a
 * contour to be kept by {@link dropSmallComponents}. Contours whose bbox
 * diagonal is below this are tiny texture specks / noise islands and are
 * dropped. The diagonal (rather than width×height area) is used deliberately so
 * a long, thin, axis-aligned contour — whose bbox area can be ~0 — is NOT
 * discarded. Internal, tunable constant.
 */
export const MIN_COMPONENT_AREA = 12;

/**
 * Light separable Gaussian blur over a decoded RGBA image.
 *
 * Builds a 1-D Gaussian kernel of radius `ceil(3·sigma)` and convolves the RGB
 * channels horizontally then vertically (edges clamped). Alpha is passed
 * through unchanged. `sigma <= 0` is a no-op and returns the input image. Pure
 * and host-testable (no DOM/WASM/network) — used by {@link edgeFirstShade} to
 * denoise before high-threshold Sobel.
 */
export function gaussianBlur(img: DecodedImage, sigma: number): DecodedImage {
    if (!(sigma > 0)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;

    // 1-D normalised Gaussian kernel.
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const size = radius * 2 + 1;
    const kernel = new Float64Array(size);
    const s2 = 2 * sigma * sigma;
    let ksum = 0;
    for (let k = -radius; k <= radius; k++) {
        const v = Math.exp(-(k * k) / s2);
        kernel[k + radius] = v;
        ksum += v;
    }
    for (let k = 0; k < size; k++) kernel[k]! /= ksum;

    // Horizontal pass → float RGB temp buffer (3 channels, alpha handled later).
    const tmp = new Float64Array(n * 3);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            for (let k = -radius; k <= radius; k++) {
                let xx = x + k;
                if (xx < 0) xx = 0;
                else if (xx >= w) xx = w - 1;
                const wk = kernel[k + radius]!;
                const o = (row + xx) * 4;
                r += data[o]! * wk;
                g += data[o + 1]! * wk;
                b += data[o + 2]! * wk;
            }
            const t = (row + x) * 3;
            tmp[t] = r;
            tmp[t + 1] = g;
            tmp[t + 2] = b;
        }
    }

    // Vertical pass → output RGBA buffer (alpha copied from the source).
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            for (let k = -radius; k <= radius; k++) {
                let yy = y + k;
                if (yy < 0) yy = 0;
                else if (yy >= h) yy = h - 1;
                const wk = kernel[k + radius]!;
                const t = (yy * w + x) * 3;
                r += tmp[t]! * wk;
                g += tmp[t + 1]! * wk;
                b += tmp[t + 2]! * wk;
            }
            const o = (y * w + x) * 4;
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
            out[o + 3] = data[o + 3]!;
        }
    }

    return { width: w, height: h, data: out };
}

/**
 * Drop traced contours that are too small to be meaningful structure.
 *
 * Each contour's bounding-box DIAGONAL (`sqrt(Δx² + Δy²)`) is compared to
 * `minArea`; contours below it are removed as texture specks / noise islands
 * that the short-length (`minContourPoints`) filter alone misses. The diagonal
 * is used rather than width×height so a long thin axis-aligned contour (bbox
 * area ≈ 0) is preserved. `minArea <= 0` is a no-op. Empty polylines are
 * dropped. Pure; input is not mutated.
 */
export function dropSmallComponents(
    polys: Polyline[],
    minArea: number,
): Polyline[] {
    if (!(minArea > 0)) return polys;
    return polys.filter((p) => {
        if (p.length === 0) return false;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const pt of p) {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
        }
        const dx = maxX - minX;
        const dy = maxY - minY;
        return Math.sqrt(dx * dx + dy * dy) >= minArea;
    });
}

/**
 * Order contour polylines into one connected route for draw continuity.
 *
 * Thin wrapper over the shared {@link orderPolylinesNearestNeighbor} (pure
 * endpoint-nearest chaining with end-for-end flips), starting from `from`. For
 * Mode 1 the blank-space transit penalty described in the design is a no-op —
 * plain nearest-neighbor ordering is acceptable here; the hook can be layered
 * on in the Mode 2 phase. Pure; input is not mutated.
 */
export function orderForContinuity(polys: Polyline[], from: Point): Polyline[] {
    return orderPolylinesNearestNeighbor(polys, from);
}

/**
 * Edge-first "shaded" generator — **Mode 1 (outline only)**.
 *
 * Replaces the raster-scan tone models (`hatchShade`) with a line-portrait
 * construction: draw the subject's silhouette and strongest internal contours
 * as real curves. Tone in Mode 1 is conveyed purely by WHICH contours survive a
 * high edge threshold, exactly like a pen portrait — there is no raster sweep
 * across the image, so large light backgrounds cost ≈ 0 and the machine's real
 * Chebyshev cost (`Σ max(|Δx|,|Δy|)`) is dominated by contour arc length plus
 * minimized transit.
 *
 * Pipeline (all pure — no DOM/WASM/network, Req 6.1):
 *   1. `gaussianBlur(img, OUTLINE_BLUR_SIGMA)` — light denoise.
 *   2. `sobelEdges` at a HIGH `OUTLINE_EDGE_THRESHOLD` so only the silhouette +
 *      strong internal contours survive (soft tonal gradients drop out).
 *   3. `traceContours` → ordered polylines (8-connected tracer).
 *   4. `dropSmallComponents(MIN_COMPONENT_AREA)` removes tiny texture specks,
 *      then the existing short-contour `minContourPoints` filter drops the
 *      fringe (reusing the same approach as {@link toPolylines}).
 *   5. `orderForContinuity` chains the kept contours into one route.
 *
 * RDP simplification is deliberately NOT run here — it runs later in the
 * planner (step space), as it does for `edge`/`centerline`. Returns `[]` for a
 * degenerate image (`w < 2 || h < 2`) or when no contour survives, so the
 * `toPolylines` `shaded` branch can raise {@link NoEdgesFound} (Req 4.8).
 *
 * Coordinates are source pixel space (x in `[0,w)`, y in `[0,h)`), matching the
 * contour tracer, so the existing fit/scale pipeline handles the rest.
 *
 * @see Requirements 1.1, 1.3, 2.1, 3.4, 4.1, 6.1
 */
export function edgeFirstShade(
    img: DecodedImage,
    opts: EdgeOptions,
): Polyline[] {
    const { width: w, height: h } = img;
    if (w < 2 || h < 2) return [];

    // 1. Light blur to suppress skin/paper texture before edge detection.
    const blurred = gaussianBlur(img, OUTLINE_BLUR_SIGMA);

    // 2. High-threshold Sobel → silhouette + strongest internal contours only.
    const bitmap = sobelEdges(blurred, {
        ...opts,
        upperThreshold: OUTLINE_EDGE_THRESHOLD,
    });

    // 3. Trace the strong-contour bitmap into ordered polylines.
    const contours = traceContours(bitmap, w, h);

    // 4a. Drop tiny connected components (texture specks) by bbox diagonal.
    const big = dropSmallComponents(contours, MIN_COMPONENT_AREA);

    // 4b. Existing short-contour fringe filter (same approach as toPolylines).
    const minPts = opts.minContourPoints ?? 1;
    const kept = minPts > 1 ? big.filter((p) => p.length >= minPts) : big;

    if (kept.length === 0) return [];

    // 5. Order the kept contours into one connected route for continuity.
    return orderForContinuity(kept, { x: 0, y: 0 });
}


/**
 * A function that produces a binary edge bitmap from a decoded image.
 * Non-zero bytes mark edge pixels; length is `img.width * img.height`. The
 * default adapter is the pure-JS {@link sobelEdges}; tests inject a fake.
 */
export type CannyAdapter = (img: DecodedImage, opts: EdgeOptions) => Uint8Array;



/** Optional dependency overrides for {@link toPolylines} (the WASM seam). */
export interface ToPolylinesDeps {
    /** Edge-detection adapter; defaults to the loaded `opencv.js` Canny. */
    canny?: CannyAdapter;
}

/**
 * Convert a decoded raster image to ordered polylines via Canny edge
 * detection followed by {@link traceContours}.
 *
 * The edge-detection step is supplied by `deps.canny` (defaulting to the
 * loaded `opencv.js` module). This indirection keeps the WASM dependency
 * out of the pure tracing core and lets tests drive the empty-contour and
 * polyline-shape branches with a hand-built bitmap.
 *
 * @throws {@link NoEdgesFound} when no contours are detected (Req 4.8).
 * @see Requirements 4.1, 4.3, 4.6, 4.8
 */
export function toPolylines(
    img: DecodedImage,
    opts: EdgeOptions,
    deps: ToPolylinesDeps = {},
): Polyline[] {
    const clamped = clampEdgeOptions(opts);
    // Boost contrast before edge detection so subtle gradients collapse and
    // edges only fire on strong boundaries — fewer, cleaner, more drawable
    // edges. A factor of 1 is a no-op.
    const prepared = applyContrast(img, clamped.contrast ?? CONTRAST_MIN);

    // 'shaded' mode produces polylines DIRECTLY via the edge-first generator
    // (silhouette + strongest internal contours as real curves — Mode 1),
    // bypassing the generic edge-bitmap + contour-trace path used by
    // 'edge'/'centerline'. This is the photo/portrait mode. An injected
    // deps.canny does not apply here.
    if (clamped.mode === 'shaded' && !deps.canny) {
        const shaded = edgeFirstShade(prepared, clamped);
        if (shaded.length === 0) {
            throw new NoEdgesFound();
        }
        return shaded;
    }

    // Select the edge stage: an injected adapter wins; otherwise pick by mode.
    // 'centerline' skeletonises strokes (one line down the middle) for far
    // fewer steps on line art; 'edge' (default) traces stroke outlines.
    const canny =
        deps.canny ??
        (clamped.mode === 'centerline' ? centerlineEdges : sobelEdges);
    const bitmap = canny(prepared, clamped);
    const traced = traceContours(bitmap, prepared.width, prepared.height);
    // Edge detection traces the OUTLINE of each stroke plus a fringe of tiny
    // noise contours along thick/soft edges — visible as "furry" lines and a
    // huge point/step count. Drop contours shorter than minContourPoints as
    // fuzz. Defaults to 1 (no filtering) so the pure contract is unchanged for
    // existing callers/tests; the image UI passes a higher value to denoise.
    const minPts = clamped.minContourPoints ?? 1;
    const polylines =
        minPts > 1 ? traced.filter((p) => p.length >= minPts) : traced;
    if (polylines.length === 0) {
        throw new NoEdgesFound();
    }
    return polylines;
}

// -----------------------------------------------------------------------------
// opencv.js types + Canny pipeline (WASM-dependent, untested at runtime)
// -----------------------------------------------------------------------------

/** Minimal structural type for the bits of an `opencv.js` Mat we touch. */
interface OpenCvMat {
    data: Uint8Array;
    delete(): void;
}

/**
 * Minimal structural type for the `opencv.js` module global (`cv`). Only the
 * handful of entry points used by {@link runCanny} are declared.
 */
export interface OpenCvModule {
    Mat: new () => OpenCvMat;
    Size: new (w: number, h: number) => unknown;
    matFromImageData(data: ImageData): OpenCvMat;
    cvtColor(src: OpenCvMat, dst: OpenCvMat, code: number): void;
    GaussianBlur(
        src: OpenCvMat,
        dst: OpenCvMat,
        ksize: unknown,
        sigmaX: number,
    ): void;
    Canny(src: OpenCvMat, dst: OpenCvMat, t1: number, t2: number): void;
    COLOR_RGBA2GRAY: number;
    onRuntimeInitialized?: () => void;
}

/**
 * Run Gaussian blur → grayscale → Canny on a decoded image using a loaded
 * `opencv.js` module, returning a single-channel binary edge bitmap
 * (`0` / `255`, non-zero = edge).
 *
 * WASM-dependent: not unit-tested (jsdom has no real canvas/WASM). Kept as a
 * thin adapter so manual/e2e testing covers the small remaining surface.
 *
 * @see Requirements 4.1, 4.3
 */
export function runCanny(
    img: DecodedImage,
    opts: EdgeOptions,
    cv: OpenCvModule,
): Uint8Array {
    const imageData = new ImageData(
        new Uint8ClampedArray(img.data),
        img.width,
        img.height,
    );
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    let blurred: OpenCvMat | null = null;
    try {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        let input = gray;
        if (opts.blurSigma > 0) {
            blurred = new cv.Mat();
            // ksize (0,0) lets OpenCV derive the kernel from sigma.
            cv.GaussianBlur(gray, blurred, new cv.Size(0, 0), opts.blurSigma);
            input = blurred;
        }
        cv.Canny(input, edges, opts.lowerThreshold, opts.upperThreshold);
        // Copy out of WASM memory before freeing the Mats.
        return new Uint8Array(edges.data);
    } finally {
        src.delete();
        gray.delete();
        edges.delete();
        if (blurred) blurred.delete();
    }
}

// -----------------------------------------------------------------------------
// Lazy opencv.js loader (WASM/DOM-dependent, configurable URL seam)
// -----------------------------------------------------------------------------

/**
 * Default CDN location of `opencv.js`. Overridable via {@link configureOpenCv}
 * (or per-call) so a self-hosted copy — or a test stub — can be used instead.
 * `opencv.js` is loaded at runtime and is deliberately NOT a package.json
 * dependency, so it never inflates the always-resident bundle (Design §2.4.1).
 */
export const DEFAULT_OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';

/** Injectable hooks for {@link loadOpenCv}, used to stub the loader in tests. */
export interface LoadOpenCvOptions {
    /** Override the script URL for this call. */
    url?: string;
    /**
     * Inject the script and resolve once the runtime is initialised. The
     * default performs real `<script>` injection and waits for
     * `cv.onRuntimeInitialized`.
     */
    inject?: (url: string) => Promise<void>;
    /** Read the `cv` global after {@link LoadOpenCvOptions.inject} resolves. */
    getCv?: () => OpenCvModule | undefined;
}

let configuredUrl = DEFAULT_OPENCV_URL;
let cachedModule: OpenCvModule | null = null;
let pendingLoad: Promise<OpenCvModule> | null = null;

/**
 * Override the `opencv.js` URL and clear any cached load. Useful for
 * self-hosting the WASM module (Design §10.4) or stubbing it in tests.
 */
export function configureOpenCv(opts: { url?: string }): void {
    if (typeof opts.url === 'string' && opts.url.length > 0) {
        configuredUrl = opts.url;
    }
    cachedModule = null;
    pendingLoad = null;
}

/** The currently-configured `opencv.js` URL. */
export function getOpenCvUrl(): string {
    return configuredUrl;
}

/**
 * The loaded `opencv.js` module, or throw if {@link loadOpenCv} has not yet
 * resolved. Used by the default Canny adapter.
 */
export function getLoadedOpenCv(): OpenCvModule {
    if (cachedModule === null) {
        throw new Error(
            'opencv.js is not loaded yet; call loadOpenCv() before edge detection.',
        );
    }
    return cachedModule;
}

/**
 * Lazily load `opencv.js`, caching the resolved module so subsequent calls
 * are cheap. The first call injects the script (or runs the supplied
 * {@link LoadOpenCvOptions.inject}) and resolves once the WASM runtime is
 * ready; concurrent callers share the single in-flight promise.
 *
 * The actual DOM script injection is WASM/DOM-dependent and is not exercised
 * under jsdom; the URL-configuration and caching seam is unit-tested via the
 * injectable `inject` / `getCv` hooks.
 *
 * @see Design §2.4.1, §3.1.1
 */
export function loadOpenCv(options: LoadOpenCvOptions = {}): Promise<OpenCvModule> {
    if (cachedModule !== null) {
        return Promise.resolve(cachedModule);
    }
    if (pendingLoad !== null) {
        return pendingLoad;
    }

    const url = options.url ?? configuredUrl;
    const inject = options.inject ?? defaultInjectOpenCv;
    const getCv = options.getCv ?? defaultGetCvGlobal;

    pendingLoad = inject(url)
        .then(() => {
            const mod = getCv();
            if (!mod) {
                throw new Error(
                    'opencv.js script loaded but the `cv` global was not found.',
                );
            }
            cachedModule = mod;
            return mod;
        })
        .catch((err: unknown) => {
            // Allow a later retry after a failed load.
            pendingLoad = null;
            throw err;
        });

    return pendingLoad;
}

/**
 * Default script injector: appends a `<script>` for `opencv.js` and resolves
 * when `cv.onRuntimeInitialized` fires. Guards on `document` so importing this
 * module under a non-DOM runtime (e.g. a Node test collector) does not throw.
 */
function defaultInjectOpenCv(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (typeof document === 'undefined') {
            reject(new Error('opencv.js requires a DOM environment to load.'));
            return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => {
            const mod = defaultGetCvGlobal();
            if (mod && typeof mod === 'object') {
                // opencv.js sets `cv` early but the WASM runtime initialises
                // asynchronously; wait for the runtime hook when present.
                if (typeof mod.onRuntimeInitialized === 'function') {
                    resolve();
                } else {
                    mod.onRuntimeInitialized = () => resolve();
                }
            } else {
                resolve();
            }
        };
        script.onerror = () =>
            reject(new Error(`Failed to load opencv.js from ${url}`));
        document.head.appendChild(script);
    });
}

/** Read the `cv` global installed by the opencv.js script. */
function defaultGetCvGlobal(): OpenCvModule | undefined {
    const g = globalThis as unknown as { cv?: OpenCvModule };
    return g.cv;
}

// -----------------------------------------------------------------------------
// Raster decode (DOM-dependent, untested at runtime)
// -----------------------------------------------------------------------------

/**
 * Maximum width/height (px) the decoder downscales a raster image to before
 * edge detection. A full-resolution photo (e.g. 4000x3000) produces an enormous
 * edge bitmap, tens of thousands of traced polyline points, and an unstreamable
 * command count — which manifests as an endless "Processing…" with no error.
 * Capping the longest side keeps Canny + traceContours fast and the resulting
 * outline well within the machine's drawable envelope (a few thousand steps per
 * axis), while preserving aspect ratio. Small images are never upscaled.
 */
export const MAX_DECODE_DIMENSION = 1000;

/**
 * Default minimum contour length (points) the image UI uses to drop noise
 * fringe from edge traces. Tuned so real strokes survive while the short
 * "furry" fragments along thick edges are discarded.
 */
export const MIN_CONTOUR_POINTS = 8;

/** Default number of horizontal scan rows for serpentine shading. */
export const SHADE_ROWS_DEFAULT = 110;

/**
 * Compute the target (width, height) for a source image, scaled down so the
 * longest side is at most MAX_DECODE_DIMENSION, preserving aspect ratio. Never
 * upscales. Returns integer dimensions >= 1.
 */
function fitDecodeSize(
    srcW: number,
    srcH: number,
): { width: number; height: number } {
    const longest = Math.max(srcW, srcH);
    if (longest <= MAX_DECODE_DIMENSION || longest === 0) {
        return { width: srcW, height: srcH };
    }
    const s = MAX_DECODE_DIMENSION / longest;
    return {
        width: Math.max(1, Math.round(srcW * s)),
        height: Math.max(1, Math.round(srcH * s)),
    };
}

/**
 * Decode an image `File` to `ImageData` using `createImageBitmap` (preferred)
 * or an `<img>` + `<canvas>` fallback. DOM-dependent; guarded so the module
 * imports cleanly outside a browser. Throws on unreadable/corrupt bytes.
 *
 * The source is downscaled to at most {@link MAX_DECODE_DIMENSION} on its
 * longest side before returning, so downstream edge detection stays fast and
 * bounded regardless of the original photo resolution.
 */
async function decodeRasterToImageData(file: File): Promise<ImageData> {
    if (typeof document === 'undefined') {
        throw new ImageDecodeError(
            'Image decoding requires a browser environment.',
        );
    }

    const canvas = document.createElement('canvas');
    const draw = (
        width: number,
        height: number,
        paint: (ctx: CanvasRenderingContext2D) => void,
    ): ImageData => {
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new ImageDecodeError();
        paint(ctx);
        return ctx.getImageData(0, 0, width, height);
    };

    if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file);
        try {
            const { width, height } = fitDecodeSize(
                bitmap.width,
                bitmap.height,
            );
            // drawImage scales the source into the (possibly smaller) canvas.
            return draw(width, height, (ctx) =>
                ctx.drawImage(bitmap, 0, 0, width, height),
            );
        } finally {
            bitmap.close();
        }
    }

    // Fallback: object URL + <img>.
    const url = URL.createObjectURL(file);
    try {
        const img = await loadHtmlImage(url);
        const { width, height } = fitDecodeSize(
            img.naturalWidth,
            img.naturalHeight,
        );
        return draw(width, height, (ctx) =>
            ctx.drawImage(img, 0, 0, width, height),
        );
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** Resolve an `<img>` once loaded, rejecting on decode error. */
function loadHtmlImage(url: string): Promise<HTMLImageElement> {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new ImageDecodeError());
        img.src = url;
    });
}

// -----------------------------------------------------------------------------
// loadImageFile (validation + decode entry point)
// -----------------------------------------------------------------------------

/** Optional dependency overrides for {@link loadImageFile}. */
export interface LoadImageDeps {
    /** Override the raster decoder (e.g. to test the success path off-DOM). */
    decode?: (file: File) => Promise<ImageData>;
}

/**
 * Validate and decode a raster image `File` into a {@link DecodedImage}.
 *
 * Validation (format ∈ {png, jpeg, bmp}, size ≤ 10 MB) runs first via
 * {@link validateImageFile}; SVG is rejected here because vector extraction
 * is owned by task 17.2. Only after validation does the (DOM-dependent)
 * decode run, so the cheap rejection paths need no browser.
 *
 * @throws {@link ImageLoadError} for unsupported formats, oversize files,
 *         or SVG input (Req 2.4, 2.5, 2.6).
 * @throws {@link ImageDecodeError} when the bytes cannot be decoded (Req 2.7).
 */
export async function loadImageFile(
    file: File,
    deps: LoadImageDeps = {},
): Promise<DecodedImage> {
    const result = validateImageFile(file);
    if (!result.ok) {
        throw new ImageLoadError(result.reason);
    }
    if (result.value.format === 'svg') {
        throw new ImageLoadError(
            'SVG files are handled by the SVG path extractor, not the raster loader.',
        );
    }

    const decode = deps.decode ?? decodeRasterToImageData;
    let imageData: ImageData;
    try {
        imageData = await decode(file);
    } catch (err) {
        if (err instanceof ImageDecodeError) throw err;
        throw new ImageDecodeError();
    }

    return {
        width: imageData.width,
        height: imageData.height,
        data: imageData.data,
    };
}

// -----------------------------------------------------------------------------
// ImageProcessor implementation
// -----------------------------------------------------------------------------

/** Construction options for {@link RasterImageProcessor}. */
export interface RasterImageProcessorOptions {
    /** Override the edge-detection adapter (defaults to loaded opencv.js). */
    canny?: CannyAdapter;
    /** Disable the fire-and-forget lazy opencv.js prefetch on `loadFile`. */
    autoLoadOpenCv?: boolean;
}

/**
 * Default {@link ImageProcessor} implementation. Wires the validation/decode
 * loader, the Canny → contour-trace pipeline, and the greedy nearest-neighbor
 * ordering together. On first `loadFile`, it kicks off the lazy `opencv.js`
 * download (fire-and-forget) so the WASM module is ready by the time the user
 * tweaks thresholds.
 */
export class RasterImageProcessor implements ImageProcessor {
    private readonly canny: CannyAdapter | undefined;
    private readonly autoLoadOpenCv: boolean;
    private openCvKicked = false;

    constructor(opts: RasterImageProcessorOptions = {}) {
        this.canny = opts.canny;
        this.autoLoadOpenCv = opts.autoLoadOpenCv ?? true;
    }

    async loadFile(file: File): Promise<DecodedImage> {
        const img = await loadImageFile(file);
        // Lazy-load opencv.js on first successful import (Design §2.4.1).
        if (this.autoLoadOpenCv && !this.openCvKicked) {
            this.openCvKicked = true;
            void loadOpenCv().catch(() => {
                // Swallowed here; surfaced to the user on toPolylines().
            });
        }
        return img;
    }

    toPolylines(img: DecodedImage, opts: EdgeOptions): Polyline[] {
        const deps: ToPolylinesDeps = this.canny ? { canny: this.canny } : {};
        return toPolylines(img, opts, deps);
    }

    nearestNeighborOrder(polys: Polyline[], from: Point): Polyline[] {
        return nearestNeighborOrder(polys, from);
    }
}
