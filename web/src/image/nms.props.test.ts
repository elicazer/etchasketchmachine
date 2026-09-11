/**
 * Property-based tests for the reference thinning function.
 *
 * Implements **Property 21: Non-maximum suppression yields single-pixel-width
 * contours** (Design §7):
 *
 *   "For any binary edge image, the output of non-maximum suppression
 *    contains no 2×2 sub-region in which all four pixels are set."
 *
 * **Validates: Requirements 4.3**
 *
 * ## Why a reference thinning function (not opencv.js)
 *
 * Req 4.3 ("reduce detected edges to single-pixel-width contours using
 * non-maximum suppression") is implemented in production by `cv.Canny`'s
 * internal NMS inside {@link ../image/image_processor.ts | Image_Processor}.
 * `opencv.js` is a WASM module that **cannot run under jsdom / Vitest**, so
 * the production path's single-pixel-width guarantee is verified by manual /
 * e2e testing only.
 *
 * To make the *property* of Req 4.3 executable under Vitest, we property-test
 * a pure, deterministic reference thinning ({@link thinToSinglePixel}, a
 * Zhang–Suen skeletoniser) that delivers the same Req-4.3 contract: its
 * output is single-pixel-wide (no 2×2 fully-set block). The four properties
 * below pin that contract down across arbitrary binary images, including
 * inputs deliberately biased toward thick blobs so the thinning has real
 * work to do. See `nms.ts` for the full production-path relationship.
 *
 * @see ../image/nms.ts
 * @see Design §7, Property 21
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { thinToSinglePixel, isSinglePixelWide } from './nms';

// -----------------------------------------------------------------------------
// Generators
//
// `arbBinaryEdgeImage` (Design §7 generator table, Property 21) yields small
// binary bitmaps. We combine two flavours so the thinning is exercised on
// both sparse noise and genuinely thick regions:
//   - random per-pixel noise (each pixel set with probability ~1/2);
//   - unions of filled rectangles ("blobs"), which are thick by construction
//     and force the thinning to actually peel pixels.
// -----------------------------------------------------------------------------

interface BinaryImage {
    bitmap: Uint8Array;
    width: number;
    height: number;
}

const arbDim = fc.integer({ min: 1, max: 16 });

/** Random per-pixel noise image of the given dimensions. */
const arbNoiseImage: fc.Arbitrary<BinaryImage> = fc
    .record({ width: arbDim, height: arbDim })
    .chain(({ width, height }) =>
        fc
            .array(fc.boolean(), {
                minLength: width * height,
                maxLength: width * height,
            })
            .map((bits) => {
                const bitmap = new Uint8Array(width * height);
                for (let i = 0; i < bitmap.length; i++) {
                    bitmap[i] = bits[i] ? 1 : 0;
                }
                return { bitmap, width, height };
            }),
    );

/**
 * Image built from the union of a few axis-aligned filled rectangles. These
 * are "thick" blobs (often containing many 2×2 blocks) so the thinning has
 * non-trivial work and the single-pixel-width guarantee is meaningfully
 * tested rather than holding vacuously.
 */
const arbBlobImage: fc.Arbitrary<BinaryImage> = fc
    .record({ width: arbDim, height: arbDim })
    .chain(({ width, height }) => {
        const arbRect = fc.record({
            x0: fc.integer({ min: 0, max: width - 1 }),
            y0: fc.integer({ min: 0, max: height - 1 }),
            w: fc.integer({ min: 1, max: width }),
            h: fc.integer({ min: 1, max: height }),
        });
        return fc
            .array(arbRect, { minLength: 1, maxLength: 4 })
            .map((rects) => {
                const bitmap = new Uint8Array(width * height);
                for (const r of rects) {
                    const xEnd = Math.min(width, r.x0 + r.w);
                    const yEnd = Math.min(height, r.y0 + r.h);
                    for (let y = r.y0; y < yEnd; y++) {
                        for (let x = r.x0; x < xEnd; x++) {
                            bitmap[y * width + x] = 1;
                        }
                    }
                }
                return { bitmap, width, height };
            });
    });

/** The Property 21 generator: a mix of noise and thick-blob images. */
const arbBinaryEdgeImage: fc.Arbitrary<BinaryImage> = fc.oneof(
    arbNoiseImage,
    arbBlobImage,
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const countSet = (bitmap: Uint8Array): number => {
    let c = 0;
    for (const b of bitmap) if (b !== 0) c++;
    return c;
};

const NUM_RUNS = 200;

// -----------------------------------------------------------------------------
// Property 21
// -----------------------------------------------------------------------------

describe('Property 21 — NMS yields single-pixel-width contours (Req 4.3)', () => {
    /**
     * **Validates: Requirements 4.3**
     *
     * SINGLE-PIXEL-WIDTH (the property itself). For every generated binary
     * image, `thinToSinglePixel` produces an output containing **no 2×2
     * fully-set block** — the decidable formalisation of "single pixel wide"
     * that Req 4.3's NMS guarantees.
     */
    it('output contains no 2x2 fully-set block', () => {
        fc.assert(
            fc.property(arbBinaryEdgeImage, ({ bitmap, width, height }) => {
                const out = thinToSinglePixel(bitmap, width, height);
                expect(isSinglePixelWide(out, width, height)).toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 4.3**
     *
     * SUBSET. Thinning only ever removes pixels, never adds them: every set
     * pixel in the output was set in the input. (A reduction to single-pixel
     * width must not invent edges.)
     */
    it('output is a subset of the input (thinning never adds pixels)', () => {
        fc.assert(
            fc.property(arbBinaryEdgeImage, ({ bitmap, width, height }) => {
                const out = thinToSinglePixel(bitmap, width, height);
                for (let i = 0; i < out.length; i++) {
                    if (out[i] !== 0) {
                        expect(bitmap[i]).not.toBe(0);
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 4.3**
     *
     * IDEMPOTENCE. The skeleton is a fixed point: re-thinning the output
     * reproduces it exactly. A genuine single-pixel-width result has nothing
     * left to thin.
     */
    it('is idempotent: thinning the output reproduces it', () => {
        fc.assert(
            fc.property(arbBinaryEdgeImage, ({ bitmap, width, height }) => {
                const out = thinToSinglePixel(bitmap, width, height);
                const again = thinToSinglePixel(out, width, height);
                expect(Array.from(again)).toEqual(Array.from(out));
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 4.3**
     *
     * PRESERVES NON-EMPTINESS. A non-empty input yields a non-empty output —
     * reducing edges to single-pixel width must not erase every contour.
     */
    it('preserves non-emptiness (non-empty input ⇒ non-empty output)', () => {
        fc.assert(
            fc.property(arbBinaryEdgeImage, ({ bitmap, width, height }) => {
                const out = thinToSinglePixel(bitmap, width, height);
                if (countSet(bitmap) > 0) {
                    expect(countSet(out)).toBeGreaterThan(0);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
