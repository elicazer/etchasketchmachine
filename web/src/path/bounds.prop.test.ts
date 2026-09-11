import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    isPointInBoundsMm,
    findOutOfBoundsSegments,
    findOutOfBoundsSegmentsForPolylines,
} from './bounds';
import { DRAWABLE_MM } from '../constants';
import type { Point, Polyline } from '../types';

/**
 * Property 25: Out-of-bounds detection.
 *
 * Validates: Requirements 8.6
 *
 * The drawable area is the closed rectangle
 * `[0, DRAWABLE_MM.w] × [0, DRAWABLE_MM.h]` mm. A polyline segment is
 * "out of bounds" (and thus preview-highlighted) iff at least one of its
 * two endpoints lies outside that rectangle. Boundary points count as
 * in-bounds.
 *
 * These properties pin down `isPointInBoundsMm`, `findOutOfBoundsSegments`,
 * and the multi-polyline helper `findOutOfBoundsSegmentsForPolylines`:
 *
 *   1. SOUNDNESS       — every reported segment really has an OOB endpoint.
 *   2. COMPLETENESS     — every segment with an OOB endpoint is reported.
 *   3. CLEAN POLYLINES  — fully in-bounds polylines report nothing.
 *   4. BOUNDARY         — points on the rectangle edges/corners are in-bounds.
 *   5. POINT PREDICATE  — isPointInBoundsMm matches its closed-rectangle def.
 *   6. MULTI-POLYLINE   — the array helper is the order-preserving flatten of
 *                         the per-polyline result with `polyIndex` attached.
 */

const { w, h } = DRAWABLE_MM;

const NUM_RUNS = { numRuns: 500 } as const;

// Generators ------------------------------------------------------------------

/**
 * A coordinate generator whose range deliberately straddles the drawable
 * rectangle on both axes so a healthy mix of in- and out-of-bounds points
 * (including some near the edges) gets produced.
 */
const arbX = fc.double({ min: -50, max: 250, noNaN: true, noDefaultInfinity: true });
const arbY = fc.double({ min: -50, max: 200, noNaN: true, noDefaultInfinity: true });

const arbPoint: fc.Arbitrary<Point> = fc.record({ x: arbX, y: arbY });

/** Polylines may be empty or singletons (no segments) up through long runs. */
const arbPolyline: fc.Arbitrary<Polyline> = fc.array(arbPoint, {
    minLength: 0,
    maxLength: 24,
});

/** A point guaranteed to lie strictly inside the drawable rectangle. */
const arbInBoundsPoint: fc.Arbitrary<Point> = fc.record({
    x: fc.double({ min: 0, max: w, noNaN: true, noDefaultInfinity: true }),
    y: fc.double({ min: 0, max: h, noNaN: true, noDefaultInfinity: true }),
});

const arbInBoundsPolyline: fc.Arbitrary<Polyline> = fc.array(arbInBoundsPoint, {
    minLength: 0,
    maxLength: 24,
});

/** A point that lies exactly on one of the rectangle's edges or corners. */
const arbBoundaryPoint: fc.Arbitrary<Point> = fc.oneof(
    // left / right edges: x pinned to {0, w}, y anywhere on [0, h]
    fc.record({
        x: fc.constantFrom(0, w),
        y: fc.double({ min: 0, max: h, noNaN: true, noDefaultInfinity: true }),
    }),
    // bottom / top edges: y pinned to {0, h}, x anywhere on [0, w]
    fc.record({
        x: fc.double({ min: 0, max: w, noNaN: true, noDefaultInfinity: true }),
        y: fc.constantFrom(0, h),
    }),
);

const arbBoundaryPolyline: fc.Arbitrary<Polyline> = fc.array(arbBoundaryPoint, {
    minLength: 0,
    maxLength: 24,
});

const arbPolylines: fc.Arbitrary<Polyline[]> = fc.array(arbPolyline, {
    minLength: 0,
    maxLength: 6,
});

// Reference predicate (independent of the implementation under test).
const inBounds = (p: Point): boolean =>
    p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;

// Properties ------------------------------------------------------------------

describe('Property 25: Out-of-bounds detection', () => {
    it('1. SOUNDNESS: every reported segment has at least one OOB endpoint', () => {
        fc.assert(
            fc.property(arbPolyline, (poly) => {
                const oob = findOutOfBoundsSegments(poly);
                for (const seg of oob) {
                    expect(!inBounds(seg.from) || !inBounds(seg.to)).toBe(true);
                }
            }),
            NUM_RUNS,
        );
    });

    it('2. COMPLETENESS: reported index set equals the independently computed OOB index set', () => {
        fc.assert(
            fc.property(arbPolyline, (poly) => {
                // Independent scan of consecutive pairs.
                const expected = new Set<number>();
                for (let i = 0; i < poly.length - 1; i++) {
                    if (!inBounds(poly[i]!) || !inBounds(poly[i + 1]!)) {
                        expected.add(i);
                    }
                }

                const oob = findOutOfBoundsSegments(poly);
                const actual = new Set(oob.map((s) => s.index));

                // Same membership.
                expect(actual).toEqual(expected);

                // Every reported index is a valid segment index in [0, n-2],
                // and the from/to references match the polyline endpoints.
                for (const s of oob) {
                    expect(s.index).toBeGreaterThanOrEqual(0);
                    expect(s.index).toBeLessThanOrEqual(poly.length - 2);
                    expect(s.from).toEqual(poly[s.index]!);
                    expect(s.to).toEqual(poly[s.index + 1]!);
                }
            }),
            NUM_RUNS,
        );
    });

    it('3. CLEAN POLYLINES: a fully in-bounds polyline reports no OOB segments', () => {
        fc.assert(
            fc.property(arbInBoundsPolyline, (poly) => {
                expect(findOutOfBoundsSegments(poly)).toEqual([]);
            }),
            NUM_RUNS,
        );
    });

    it('4. BOUNDARY INCLUSION: polylines of only boundary/corner points report nothing', () => {
        fc.assert(
            fc.property(arbBoundaryPolyline, (poly) => {
                expect(findOutOfBoundsSegments(poly)).toEqual([]);
            }),
            NUM_RUNS,
        );
    });

    it('5. POINT PREDICATE: isPointInBoundsMm agrees with the closed-rectangle definition', () => {
        fc.assert(
            fc.property(arbPoint, (p) => {
                expect(isPointInBoundsMm(p)).toBe(
                    p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h,
                );
            }),
            NUM_RUNS,
        );
    });

    it('6. MULTI-POLYLINE: helper is the order-preserving flatten with polyIndex attached', () => {
        fc.assert(
            fc.property(arbPolylines, (polys) => {
                const combined = findOutOfBoundsSegmentsForPolylines(polys);

                // Build the expected flatten from per-polyline results.
                const expected = polys.flatMap((poly, polyIndex) =>
                    findOutOfBoundsSegments(poly).map((s) => ({
                        polyIndex,
                        index: s.index,
                        from: s.from,
                        to: s.to,
                    })),
                );

                expect(combined).toEqual(expected);

                // polyIndex values are non-decreasing (order preserved across
                // polylines) and each one maps back to the right polyline.
                for (let i = 1; i < combined.length; i++) {
                    expect(combined[i]!.polyIndex).toBeGreaterThanOrEqual(
                        combined[i - 1]!.polyIndex,
                    );
                }
                for (const seg of combined) {
                    const poly = polys[seg.polyIndex]!;
                    expect(seg.from).toEqual(poly[seg.index]!);
                    expect(seg.to).toEqual(poly[seg.index + 1]!);
                    expect(!inBounds(seg.from) || !inBounds(seg.to)).toBe(true);
                }
            }),
            NUM_RUNS,
        );
    });
});
