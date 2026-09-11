import { describe, it, expect } from 'vitest';
import {
    thinToSinglePixel,
    isSinglePixelWide,
} from './nms';

/**
 * Unit tests for the pure reference thinning function {@link thinToSinglePixel}
 * and the {@link isSinglePixelWide} predicate.
 *
 * This module is the testable reference for the single-pixel-width guarantee
 * of Requirement 4.3 ("reduce detected edges to single-pixel-width contours
 * using non-maximum suppression"). The production raster path uses the
 * opencv.js Canny NMS, which cannot run under jsdom — see the docstring in
 * `nms.ts`. These examples pin down the documented behaviour; the universal
 * guarantee is covered by `nms.props.test.ts` (Property 21).
 */

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

/**
 * Build a binary bitmap from a list of equal-length rows where any
 * non-space, non-dot character marks a set pixel.
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
                bitmap[y * width + x] = 1;
            }
        }
    }
    return { bitmap, width, height };
}

/** Count set pixels in a bitmap. */
function countSet(bitmap: Uint8Array): number {
    let c = 0;
    for (const b of bitmap) if (b !== 0) c++;
    return c;
}

// -----------------------------------------------------------------------------
// thinToSinglePixel
// -----------------------------------------------------------------------------

describe('thinToSinglePixel', () => {
    it('thins a 3-pixel-thick horizontal bar to a single-pixel-wide line', () => {
        // A 3-row-thick, 9-column horizontal bar.
        const { bitmap, width, height } = bitmapFromRows([
            '.........',
            '.#######.',
            '.#######.',
            '.#######.',
            '.........',
        ]);

        const out = thinToSinglePixel(bitmap, width, height);

        // Single-pixel-width guarantee: no 2x2 fully-set block.
        expect(isSinglePixelWide(out, width, height)).toBe(true);

        // The skeleton is non-empty and collapses to (about) one row of pixels.
        expect(countSet(out)).toBeGreaterThan(0);
        // A 3-thick bar should thin to far fewer pixels than the original 21.
        expect(countSet(out)).toBeLessThan(countSet(bitmap));
    });

    it('thins a solid filled square to a skeleton with no 2x2 filled block', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '#######',
            '#######',
            '#######',
            '#######',
            '#######',
            '#######',
            '#######',
        ]);

        const out = thinToSinglePixel(bitmap, width, height);

        expect(isSinglePixelWide(out, width, height)).toBe(true);
        expect(countSet(out)).toBeGreaterThan(0);
        expect(countSet(out)).toBeLessThan(countSet(bitmap));
    });

    it('preserves an already-thin diagonal line', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '#......',
            '.#.....',
            '..#....',
            '...#...',
            '....#..',
            '.....#.',
            '......#',
        ]);

        const out = thinToSinglePixel(bitmap, width, height);

        // Already single-pixel-wide and topologically minimal: unchanged.
        expect(Array.from(out)).toEqual(Array.from(bitmap));
        expect(isSinglePixelWide(out, width, height)).toBe(true);
    });

    it('leaves an empty bitmap empty', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '.....',
            '.....',
            '.....',
        ]);

        const out = thinToSinglePixel(bitmap, width, height);

        expect(countSet(out)).toBe(0);
        expect(out.length).toBe(width * height);
        expect(isSinglePixelWide(out, width, height)).toBe(true);
    });

    it('keeps a single isolated 2x2 component non-empty (component guard)', () => {
        // Vanilla Zhang–Suen would erase this 2x2 square entirely; the
        // component-preservation guard keeps one representative pixel.
        const { bitmap, width, height } = bitmapFromRows([
            '....',
            '.##.',
            '.##.',
            '....',
        ]);

        const out = thinToSinglePixel(bitmap, width, height);

        expect(countSet(out)).toBeGreaterThanOrEqual(1);
        expect(isSinglePixelWide(out, width, height)).toBe(true);
    });

    it('returns an empty array for zero-area dimensions', () => {
        expect(thinToSinglePixel(new Uint8Array(0), 0, 0).length).toBe(0);
        expect(thinToSinglePixel(new Uint8Array(0), 5, 0).length).toBe(0);
    });

    it('throws on a bitmap shorter than width*height', () => {
        expect(() => thinToSinglePixel(new Uint8Array(3), 2, 2)).toThrow(
            RangeError,
        );
    });
});

// -----------------------------------------------------------------------------
// isSinglePixelWide
// -----------------------------------------------------------------------------

describe('isSinglePixelWide', () => {
    it('returns false when a 2x2 fully-set block is present', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '##.',
            '##.',
            '...',
        ]);
        expect(isSinglePixelWide(bitmap, width, height)).toBe(false);
    });

    it('returns true for a thin diagonal (no 2x2 block)', () => {
        const { bitmap, width, height } = bitmapFromRows([
            '#..',
            '.#.',
            '..#',
        ]);
        expect(isSinglePixelWide(bitmap, width, height)).toBe(true);
    });

    it('returns true for bitmaps too small to contain a 2x2 block', () => {
        const single = new Uint8Array([1]);
        expect(isSinglePixelWide(single, 1, 1)).toBe(true);
        const row = new Uint8Array([1, 1, 1]);
        expect(isSinglePixelWide(row, 3, 1)).toBe(true);
    });
});
