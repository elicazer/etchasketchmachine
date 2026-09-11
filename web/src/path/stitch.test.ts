import { describe, it, expect } from 'vitest';
import { stitchPolylines, totalConnectorLength, appendReturnToHome, appendEdgeReturnToHome } from './stitch';
import type { Polyline, PlannedSegment } from '../types';

/**
 * Unit tests for greedy nearest-neighbor polyline stitching.
 *
 * Property-based tests for the universal continuity invariant and the
 * "NN-with-flip ≤ identity" connector-length bound live in task 12.3.
 * These tests cover the deterministic behaviour, edge cases, and the
 * basic continuity invariant on small inputs.
 */

/**
 * Verify the continuity invariant: every adjacent segment pair shares
 * an endpoint, and no individual segment has zero length.
 */
function assertContiguous(segs: PlannedSegment[]): void {
    for (const s of segs) {
        expect(s.pointsSteps.length).toBeGreaterThanOrEqual(2);
        // No zero-length sub-segments inside a single segment.
        for (let i = 0; i < s.pointsSteps.length - 1; i++) {
            const a = s.pointsSteps[i]!;
            const b = s.pointsSteps[i + 1]!;
            expect(a.x === b.x && a.y === b.y).toBe(false);
        }
    }
    for (let i = 0; i < segs.length - 1; i++) {
        const last = segs[i]!.pointsSteps[segs[i]!.pointsSteps.length - 1]!;
        const next = segs[i + 1]!.pointsSteps[0]!;
        expect(next).toEqual(last);
    }
}

describe('stitchPolylines', () => {
    it('returns [] for an empty input', () => {
        expect(stitchPolylines([], {})).toEqual([]);
        expect(stitchPolylines([])).toEqual([]);
    });

    it('drops single-point polylines (no length to draw)', () => {
        const polys: Polyline[] = [[{ x: 5, y: 5 }]];
        expect(stitchPolylines(polys)).toEqual([]);
    });

    it('drops empty polylines and keeps polylines of length ≥ 2', () => {
        const polys: Polyline[] = [
            [],
            [{ x: 1, y: 1 }],
            [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
            ],
        ];
        const out = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        // No connector needed (start == polyline start), one stroke.
        expect(out).toHaveLength(1);
        expect(out[0]?.kind).toBe('stroke');
    });

    it('emits a single stroke (no connector) when the polyline starts at the pen position', () => {
        const polys: Polyline[] = [
            [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 5 },
            ],
        ];
        const out = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual({
            kind: 'stroke',
            pointsSteps: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 5 },
            ],
        });
    });

    it('emits one connector (home→entry) then the stroke for a single polyline away from home', () => {
        const polys: Polyline[] = [
            [
                { x: 50, y: 50 },
                { x: 60, y: 50 },
            ],
        ];
        const out = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({
            kind: 'connector',
            pointsSteps: [
                { x: 0, y: 0 },
                { x: 50, y: 50 },
            ],
        });
        expect(out[1]).toEqual({
            kind: 'stroke',
            pointsSteps: [
                { x: 50, y: 50 },
                { x: 60, y: 50 },
            ],
        });
        assertContiguous(out);
    });

    it('defaults the pen position to (0, 0) when no start is given', () => {
        const polys: Polyline[] = [
            [
                { x: 3, y: 4 },
                { x: 5, y: 4 },
            ],
        ];
        const withDefault = stitchPolylines(polys);
        const withExplicit = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        expect(withDefault).toEqual(withExplicit);
    });

    it('visits the nearer of two far-apart polylines first, with a connector between them, continuously', () => {
        const near: Polyline = [
            { x: 1, y: 0 },
            { x: 2, y: 0 },
        ];
        const far: Polyline = [
            { x: 100, y: 0 },
            { x: 110, y: 0 },
        ];
        // Pass `far` first to confirm ordering is by distance, not input order.
        const out = stitchPolylines([far, near], { start: { x: 0, y: 0 } });
        // Expected sequence:
        //   connector (0,0)->(1,0), stroke near (1->2),
        //   connector (2,0)->(100,0), stroke far (100->110)
        expect(out).toHaveLength(4);
        expect(out[0]?.kind).toBe('connector');
        expect(out[1]?.kind).toBe('stroke');
        expect(out[1]?.pointsSteps).toEqual(near);
        // A connector is inserted between the two polylines.
        expect(out[2]).toEqual({
            kind: 'connector',
            pointsSteps: [
                { x: 2, y: 0 },
                { x: 100, y: 0 },
            ],
        });
        expect(out[3]?.kind).toBe('stroke');
        expect(out[3]?.pointsSteps).toEqual(far);
        // Output is continuous: each seg.last === next seg.first.
        assertContiguous(out);
    });

    it('flips polyline direction so the connector attaches to its near end', () => {
        // Pen at origin; the polyline runs (10,0)->(11,0) so its start (10,0)
        // is the near end: no flip expected.
        const noFlip: Polyline = [
            { x: 10, y: 0 },
            { x: 11, y: 0 },
        ];
        // Same polyline but reversed in the input - now its FAR end (10,0)
        // is nearest the pen, so it must be reversed relative to input.
        const expectFlip: Polyline = [
            { x: 11, y: 0 },
            { x: 10, y: 0 },
        ];

        const out1 = stitchPolylines([noFlip], { start: { x: 0, y: 0 } });
        expect(out1[1]?.pointsSteps).toEqual([
            { x: 10, y: 0 },
            { x: 11, y: 0 },
        ]);

        const out2 = stitchPolylines([expectFlip], { start: { x: 0, y: 0 } });
        // The stroke segment is reversed relative to the input polyline so
        // the connector attaches to its near end (10,0).
        expect(out2[1]?.pointsSteps).toEqual(expectFlip.slice().reverse());
        expect(out2[1]?.pointsSteps).toEqual([
            { x: 10, y: 0 },
            { x: 11, y: 0 },
        ]);
        // The connector ends at the near end, not the far end.
        expect(out2[0]).toEqual({
            kind: 'connector',
            pointsSteps: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
            ],
        });
    });

    it('chooses orientation per polyline to minimise the connector hop', () => {
        // Two polylines on a horizontal line.
        // A runs from (10,0) to (20,0); B runs from (40,0) to (30,0).
        // Pen at origin: nearest endpoint is A's start (10,0), no flip.
        // Pen advances to (20,0); now B's nearest endpoint is its end (30,0),
        // which means we must flip B so the stroke runs (30,0)->(40,0).
        const A: Polyline = [
            { x: 10, y: 0 },
            { x: 20, y: 0 },
        ];
        const B: Polyline = [
            { x: 40, y: 0 },
            { x: 30, y: 0 },
        ];
        const out = stitchPolylines([A, B], { start: { x: 0, y: 0 } });

        // 4 segments: connector, stroke A, connector, stroke B (flipped).
        expect(out.map((s) => s.kind)).toEqual([
            'connector',
            'stroke',
            'connector',
            'stroke',
        ]);
        expect(out[1]?.pointsSteps).toEqual(A);
        expect(out[2]?.pointsSteps).toEqual([
            { x: 20, y: 0 },
            { x: 30, y: 0 },
        ]);
        expect(out[3]?.pointsSteps).toEqual([
            { x: 30, y: 0 },
            { x: 40, y: 0 },
        ]);
        assertContiguous(out);
    });

    it('omits the connector when the cursor already sits exactly on the next entry point', () => {
        // Polyline A ends at (10, 0); polyline B starts at (10, 0). The
        // greedy pick will choose B next (distance 0), and no connector
        // segment should be emitted between them.
        const A: Polyline = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
        ];
        const B: Polyline = [
            { x: 10, y: 0 },
            { x: 10, y: 5 },
        ];
        const out = stitchPolylines([A, B], { start: { x: 0, y: 0 } });
        expect(out.map((s) => s.kind)).toEqual(['stroke', 'stroke']);
        expect(out[0]?.pointsSteps).toEqual(A);
        expect(out[1]?.pointsSteps).toEqual(B);
        assertContiguous(out);
    });

    it('every polyline appears exactly once in the output', () => {
        const polys: Polyline[] = [
            [
                { x: 0, y: 10 },
                { x: 5, y: 10 },
            ],
            [
                { x: 30, y: 30 },
                { x: 30, y: 35 },
            ],
            [
                { x: 80, y: 5 },
                { x: 85, y: 5 },
            ],
        ];
        const out = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        const strokes = out.filter((s) => s.kind === 'stroke');
        expect(strokes).toHaveLength(polys.length);
        // Each input polyline should match one stroke either forward or reversed.
        const matched = new Array<boolean>(polys.length).fill(false);
        for (const stroke of strokes) {
            const idx = polys.findIndex((p, i) => {
                if (matched[i]) return false;
                const fwd = JSON.stringify(p) === JSON.stringify(stroke.pointsSteps);
                const rev =
                    JSON.stringify(p.slice().reverse()) ===
                    JSON.stringify(stroke.pointsSteps);
                return fwd || rev;
            });
            expect(idx).toBeGreaterThanOrEqual(0);
            matched[idx] = true;
        }
    });

    it('produces deterministic output for a given input order', () => {
        const polys: Polyline[] = [
            [
                { x: 10, y: 10 },
                { x: 20, y: 10 },
            ],
            [
                { x: 50, y: 0 },
                { x: 60, y: 0 },
            ],
            [
                { x: 0, y: 50 },
                { x: 5, y: 50 },
            ],
        ];
        const a = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        const b = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        expect(b).toEqual(a);
    });

    it('does NOT append an auto-return-to-home segment (that is task 12.2)', () => {
        const polys: Polyline[] = [
            [
                { x: 50, y: 50 },
                { x: 60, y: 50 },
            ],
        ];
        const out = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        const last = out[out.length - 1]!;
        const lastPoint = last.pointsSteps[last.pointsSteps.length - 1]!;
        // The path ends at the polyline's end, not at home.
        expect(lastPoint).toEqual({ x: 60, y: 50 });
    });

    it('preserves the continuity invariant across a 3+ polyline fixture', () => {
        const polys: Polyline[] = [
            [
                { x: 12, y: 7 },
                { x: 18, y: 9 },
                { x: 24, y: 11 },
            ],
            [
                { x: 40, y: 40 },
                { x: 45, y: 45 },
            ],
            [
                { x: 100, y: 20 },
                { x: 110, y: 25 },
                { x: 120, y: 30 },
            ],
            [
                { x: 5, y: 90 },
                { x: 7, y: 95 },
            ],
        ];
        const out = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        assertContiguous(out);
        // Connector count = number of strokes that did not start exactly
        // at the previous pen position. With these inputs every transition
        // requires a hop, so connectors === strokes.
        const strokes = out.filter((s) => s.kind === 'stroke').length;
        const connectors = out.filter((s) => s.kind === 'connector').length;
        expect(strokes).toBe(polys.length);
        expect(connectors).toBe(strokes);
    });
});

describe('totalConnectorLength', () => {
    it('is zero when there are no connectors', () => {
        const segs: PlannedSegment[] = [
            {
                kind: 'stroke',
                pointsSteps: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                ],
            },
        ];
        expect(totalConnectorLength(segs)).toBe(0);
        expect(totalConnectorLength([])).toBe(0);
    });

    it('sums the Euclidean lengths of connector segments only', () => {
        const polys: Polyline[] = [
            [
                { x: 3, y: 4 },
                { x: 13, y: 4 },
            ],
        ];
        // connector home->(3,4) has length 5 (3-4-5 triangle); stroke ignored.
        const out = stitchPolylines(polys, { start: { x: 0, y: 0 } });
        expect(totalConnectorLength(out)).toBeCloseTo(5, 10);
    });

    it('adds up multiple connector hops', () => {
        const A: Polyline = [
            { x: 0, y: 0 },
            { x: 0, y: 3 }, // pen ends at (0,3)
        ];
        const B: Polyline = [
            { x: 4, y: 3 }, // connector (0,3)->(4,3) length 4
            { x: 4, y: 6 },
        ];
        const out = stitchPolylines([A, B], { start: { x: 0, y: 0 } });
        // Only one connector hop (A starts at home so no leading connector).
        expect(totalConnectorLength(out)).toBeCloseTo(4, 10);
    });
});

describe('appendReturnToHome', () => {
    it('returns an empty input unchanged (nothing to return from)', () => {
        const empty: PlannedSegment[] = [];
        const out = appendReturnToHome(empty);
        expect(out).toEqual([]);
        // The same reference is returned for the empty case.
        expect(out).toBe(empty);
    });

    it('appends a trailing connector [end, (0,0)] when the path ends away from home', () => {
        const segments: PlannedSegment[] = [
            {
                kind: 'stroke',
                pointsSteps: [
                    { x: 0, y: 0 },
                    { x: 60, y: 50 },
                ],
            },
        ];
        const out = appendReturnToHome(segments);
        expect(out).toHaveLength(2);
        expect(out[1]).toEqual({
            kind: 'connector',
            pointsSteps: [
                { x: 60, y: 50 },
                { x: 0, y: 0 },
            ],
        });
        // The whole path remains contiguous and ends at home.
        assertContiguous(out);
        const last = out[out.length - 1]!;
        expect(last.pointsSteps[last.pointsSteps.length - 1]).toEqual({ x: 0, y: 0 });
    });

    it('leaves a path already ending at home unchanged (no zero-length connector)', () => {
        const segments: PlannedSegment[] = [
            {
                kind: 'stroke',
                pointsSteps: [
                    { x: 10, y: 10 },
                    { x: 0, y: 0 },
                ],
            },
        ];
        const out = appendReturnToHome(segments);
        expect(out).toBe(segments);
        expect(out).toHaveLength(1);
    });

    it('preserves continuity: appended connector.first === previous segment.last', () => {
        const segments: PlannedSegment[] = [
            {
                kind: 'connector',
                pointsSteps: [
                    { x: 0, y: 0 },
                    { x: 30, y: 40 },
                ],
            },
            {
                kind: 'stroke',
                pointsSteps: [
                    { x: 30, y: 40 },
                    { x: 80, y: 20 },
                ],
            },
        ];
        const out = appendReturnToHome(segments);
        expect(out).toHaveLength(3);
        const prevLast = segments[segments.length - 1]!.pointsSteps;
        const connectorFirst = out[out.length - 1]!.pointsSteps[0]!;
        expect(connectorFirst).toEqual(prevLast[prevLast.length - 1]);
        assertContiguous(out);
    });

    it('honors a custom home point', () => {
        const segments: PlannedSegment[] = [
            {
                kind: 'stroke',
                pointsSteps: [
                    { x: 5, y: 5 },
                    { x: 25, y: 15 },
                ],
            },
        ];
        const home = { x: 7, y: 3 };
        const out = appendReturnToHome(segments, home);
        expect(out).toHaveLength(2);
        expect(out[1]).toEqual({
            kind: 'connector',
            pointsSteps: [
                { x: 25, y: 15 },
                { x: 7, y: 3 },
            ],
        });
        // A path already ending at the custom home is left unchanged.
        const atHome: PlannedSegment[] = [
            {
                kind: 'stroke',
                pointsSteps: [
                    { x: 0, y: 0 },
                    { x: 7, y: 3 },
                ],
            },
        ];
        expect(appendReturnToHome(atHome, home)).toBe(atHome);
    });

    it('does not mutate the input array', () => {
        const segments: PlannedSegment[] = [
            {
                kind: 'stroke',
                pointsSteps: [
                    { x: 0, y: 0 },
                    { x: 40, y: 40 },
                ],
            },
        ];
        const before = JSON.parse(JSON.stringify(segments));
        const lengthBefore = segments.length;
        const out = appendReturnToHome(segments);
        // Input array length and contents are untouched; a new array is returned.
        expect(segments.length).toBe(lengthBefore);
        expect(segments).toEqual(before);
        expect(out).not.toBe(segments);
    });
});

describe('appendEdgeReturnToHome', () => {
    const env = { x: 1000, y: 800 };

    function strokeEndingAt(x: number, y: number): PlannedSegment[] {
        return [{ kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x, y }] }];
    }

    it('returns empty input unchanged', () => {
        expect(appendEdgeReturnToHome([], env)).toEqual([]);
    });

    it('suppresses a return when already at home (0,0)', () => {
        const segs = strokeEndingAt(0, 0);
        expect(appendEdgeReturnToHome(segs, env)).toBe(segs);
    });

    it('appends a connector whose final point is home (0,0)', () => {
        const out = appendEdgeReturnToHome(strokeEndingAt(600, 500), env);
        const ret = out[out.length - 1]!;
        expect(ret.kind).toBe('connector');
        const last = ret.pointsSteps[ret.pointsSteps.length - 1]!;
        expect(last).toEqual({ x: 0, y: 0 });
    });

    it('routes only along axis-aligned edges (each leg changes one axis)', () => {
        // End nearest the bottom edge: down to bottom, then left to home.
        const out = appendEdgeReturnToHome(strokeEndingAt(600, 100), env);
        const pts = out[out.length - 1]!.pointsSteps;
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1]!;
            const b = pts[i]!;
            const movesX = a.x !== b.x;
            const movesY = a.y !== b.y;
            // Exactly one axis changes per leg (perimeter hugging).
            expect(movesX !== movesY).toBe(true);
        }
    });

    it('keeps every return waypoint on the envelope boundary', () => {
        // End near the top edge.
        const out = appendEdgeReturnToHome(strokeEndingAt(300, 750), env);
        const pts = out[out.length - 1]!.pointsSteps;
        // Every point after the first (the drawing's end) lies on an edge.
        for (let i = 1; i < pts.length; i++) {
            const p = pts[i]!;
            const onEdge =
                p.x === 0 || p.x === env.x || p.y === 0 || p.y === env.y;
            expect(onEdge).toBe(true);
        }
    });

    it('does not mutate the input array', () => {
        const segs = strokeEndingAt(600, 500);
        const before = JSON.parse(JSON.stringify(segs));
        const out = appendEdgeReturnToHome(segs, env);
        expect(segs).toEqual(before);
        expect(out).not.toBe(segs);
    });
});
