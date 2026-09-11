/**
 * Property-based tests for auto-return-to-home connector construction.
 *
 * Implements **Property 12: Auto-return ends at home** (Design §7).
 *
 * **Validates: Requirements 10.7, 14.7**
 *
 * The Etch-a-Sketch stylus cannot lift, so after every drawing the planned
 * path must travel back to the Home_Position `(0, 0)` so the next drawing
 * starts from a known origin. That return travel is unavoidable motion (it
 * leaves a visible line on the physical device), so it is tagged
 * `kind: 'connector'` (Req 10.7, 14.7).
 *
 * The auto-return surface under test is `appendReturnToHome`, applied to a
 * freshly stitched path (`stitchPolylines`). Together they are the web-side
 * "plan with auto-return" step (the full `Path_Planner.plan` orchestrator —
 * task 15.1 — wires these in order). This file asserts the universal laws:
 *
 *   1. ENDS AT HOME (Req 10.7, 14.7)   – for ANY non-empty input the final
 *                                        emitted segment's last point is
 *                                        exactly `(0, 0)`, regardless of where
 *                                        drawing started.
 *   2. CONTINUITY (Req 14.1)           – the appended return connector preserves
 *                                        the single-continuous-stroke invariant:
 *                                        adjacent segments share an endpoint.
 *   3. RETURN IS A CONNECTOR (Req 14.7) – when the drawing content does not
 *                                        already terminate at home (the normal
 *                                        case), the final emitted segment is
 *                                        `kind: 'connector'`.
 *
 * Edge cases (degenerate inputs) are covered explicitly: an empty polyline
 * list draws nothing (the pen never leaves home), and a single polyline still
 * ends at home via a return connector.
 *
 * Why the "final segment is a connector" claim is scoped to content-away-from-
 * home: `appendReturnToHome` deliberately suppresses a *zero-length* connector
 * when the stitched path already ends exactly at `(0, 0)` (adding one would
 * violate the no-zero-length-segment invariant on `PlannedSegment`). In that
 * measure-zero coincidence the path still ends at home, just via the trailing
 * stroke rather than a redundant connector — so the always-true invariant is
 * "ends at home", asserted over the fully arbitrary input space, while
 * "the return hop is a connector" is asserted over the space where a hop is
 * actually required. This keeps both claims strong and faithful to Req 10.7 /
 * 14.7 without asserting an impossible zero-length connector.
 *
 * @see web/src/path/stitch.ts (appendReturnToHome)
 * @see Design §3.1.4 (path pipeline), §4.1 (PlannedPath invariants), §7 (Property 12)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { stitchPolylines, appendReturnToHome } from './stitch';
import type { Point, Polyline, PlannedSegment } from '../types';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const HOME: Point = { x: 0, y: 0 };

const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

const firstPt = (s: PlannedSegment): Point => s.pointsSteps[0]!;

const lastPt = (s: PlannedSegment): Point =>
    s.pointsSteps[s.pointsSteps.length - 1]!;

/** Last point of the whole path (the planned final stylus position). */
const pathEnd = (segs: PlannedSegment[]): Point => lastPt(segs[segs.length - 1]!);

/**
 * Collapse runs of identical consecutive points. The real pipeline runs
 * scale → step-quantise → RDP-simplify before stitching, all of which leave
 * polylines with no zero-length sub-segments, so a faithful generator mirrors
 * that well-formed input space. Collapsing a degenerate `[A, A]` to `[A]` also
 * exercises the <2-point drop path inside the stitcher.
 */
function dedupeConsecutive(poly: Polyline): Polyline {
    const out: Point[] = [];
    for (const p of poly) {
        const prev = out[out.length - 1];
        if (prev === undefined || prev.x !== p.x || prev.y !== p.y) {
            out.push({ x: p.x, y: p.y });
        }
    }
    return out;
}

/** Compose the web-side "plan with auto-return" step from its two parts. */
function planWithAutoReturn(
    polys: Polyline[],
    start: Point,
): PlannedSegment[] {
    return appendReturnToHome(stitchPolylines(polys, { start }), HOME);
}

// -----------------------------------------------------------------------------
// Generators — constrained to the documented input space.
// -----------------------------------------------------------------------------

const arbCoord: fc.Arbitrary<number> = fc.integer({ min: -500, max: 500 });

const arbPoint: fc.Arbitrary<Point> = fc.record({ x: arbCoord, y: arbCoord });

/** A polyline of 0..6 integer points; lengths 0/1 exercise the drop path. */
const arbPolyline: fc.Arbitrary<Polyline> = fc
    .array(arbPoint, { minLength: 0, maxLength: 6 })
    .map(dedupeConsecutive);

/** 0..8 polylines: the input to a single plan. */
const arbPolylines: fc.Arbitrary<Polyline[]> = fc.array(arbPolyline, {
    minLength: 0,
    maxLength: 8,
});

/** Arbitrary initial pen position; auto-return must still finish at (0,0). */
const arbStart: fc.Arbitrary<Point> = arbPoint;

/**
 * Drawing content guaranteed to lie strictly away from home: every coordinate
 * is ≥ 1, so no polyline endpoint can equal `(0, 0)` and the stitched path can
 * never coincidentally terminate at home. This is the input space in which a
 * return hop is always required — exactly where Req 14.7 says that hop must be
 * rendered as a `connector`.
 */
const arbAwayCoord: fc.Arbitrary<number> = fc.integer({ min: 1, max: 500 });

const arbAwayPoint: fc.Arbitrary<Point> = fc.record({
    x: arbAwayCoord,
    y: arbAwayCoord,
});

const arbAwayPolyline: fc.Arbitrary<Polyline> = fc
    .array(arbAwayPoint, { minLength: 2, maxLength: 6 })
    .map(dedupeConsecutive);

/** ≥ 1 away-from-home polyline so the plan always has content to return from. */
const arbAwayPolylines: fc.Arbitrary<Polyline[]> = fc.array(arbAwayPolyline, {
    minLength: 1,
    maxLength: 8,
});

const NUM_RUNS = 300;

// -----------------------------------------------------------------------------
// Property 12 — Auto-return ends at home
// -----------------------------------------------------------------------------

describe('appendReturnToHome — Property 12 (auto-return ends at home)', () => {
    /**
     * **Validates: Requirements 10.7, 14.7**
     *
     * ENDS AT HOME. For any arbitrary set of polylines and any starting pen
     * position, the planned path (once non-empty) finishes with its last point
     * exactly at home `(0, 0)`. This is the universal invariant of auto-return:
     * wherever the content ends, the path is brought back to the origin.
     */
    it('ends at home: the final point is exactly (0,0) for any non-empty input, regardless of start', () => {
        fc.assert(
            fc.property(arbPolylines, arbStart, (polys, start) => {
                const path = planWithAutoReturn(polys, start);
                // An all-empty/short input draws nothing; the pen never leaves
                // home, so there is no final segment to inspect (covered by the
                // degenerate-input test below).
                fc.pre(path.length > 0);
                expect(pathEnd(path)).toEqual(HOME);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 14.1, 14.7**
     *
     * CONTINUITY. Appending the return connector preserves the single-
     * continuous-stroke invariant: every adjacent segment pair shares an
     * endpoint, so the whole path — content plus return hop — is one
     * uninterrupted stroke ending at home.
     */
    it('continuity: adjacent segments share an endpoint after the return connector is appended', () => {
        fc.assert(
            fc.property(arbPolylines, arbStart, (polys, start) => {
                const path = planWithAutoReturn(polys, start);
                for (let i = 0; i < path.length - 1; i++) {
                    expect(lastPt(path[i]!)).toEqual(firstPt(path[i + 1]!));
                }
                // Each segment is itself non-degenerate (≥ 2 distinct points).
                for (const s of path) {
                    expect(s.pointsSteps.length).toBeGreaterThanOrEqual(2);
                    expect(samePoint(firstPt(s), lastPt(s))).toBe(false);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 10.7, 14.7**
     *
     * RETURN IS A CONNECTOR. When the drawing content does not already
     * terminate at home (the normal case — here forced by content with all
     * coordinates ≥ 1), the final emitted segment is a `kind: 'connector'`
     * whose last point is `(0, 0)`. This is the auto-return hop that renders
     * the unavoidable travel back to the origin as a visible connector line.
     */
    it('return is a connector ending at home: final segment is a connector to (0,0) for content away from home', () => {
        fc.assert(
            fc.property(arbAwayPolylines, arbStart, (polys, start) => {
                const path = planWithAutoReturn(polys, start);
                expect(path.length).toBeGreaterThan(0);

                const finalSeg = path[path.length - 1]!;
                expect(finalSeg.kind).toBe('connector');
                expect(lastPt(finalSeg)).toEqual(HOME);

                // The return connector is a non-degenerate two-point hop whose
                // first point is the content's end (continuity into the hop).
                expect(finalSeg.pointsSteps.length).toBe(2);
                expect(samePoint(firstPt(finalSeg), lastPt(finalSeg))).toBe(
                    false,
                );
            }),
            { numRuns: NUM_RUNS },
        );
    });

    /**
     * **Validates: Requirements 10.7, 14.7**
     *
     * DEGENERATE INPUTS. The two boundary shapes the task calls out:
     *   - an empty polyline list draws nothing, so the pen never leaves home
     *     and the plan is empty (vacuously "at home"); and
     *   - a single away-from-home polyline still finishes with a return
     *     connector to `(0, 0)`.
     */
    it('degenerate inputs still end at home (empty list draws nothing; single polyline returns home)', () => {
        // Empty input: nothing to draw, pen stays at home, empty plan.
        expect(planWithAutoReturn([], HOME)).toEqual([]);
        expect(planWithAutoReturn([], { x: 17, y: 42 })).toEqual([]);

        // Inputs whose only polylines are too short to draw also yield nothing.
        expect(planWithAutoReturn([[], [{ x: 5, y: 5 }]], HOME)).toEqual([]);

        // A single away-from-home polyline always returns home via a connector,
        // from any starting pen position.
        fc.assert(
            fc.property(arbAwayPolyline, arbStart, (poly, start) => {
                const path = planWithAutoReturn([poly], start);
                expect(path.length).toBeGreaterThan(0);
                const finalSeg = path[path.length - 1]!;
                expect(finalSeg.kind).toBe('connector');
                expect(pathEnd(path)).toEqual(HOME);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
