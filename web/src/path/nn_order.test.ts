import { describe, it, expect } from 'vitest';
import {
    orderPolylinesNearestNeighbor,
    twoOptReorder,
    totalConnectorTravelChebyshev,
} from './nn_order';
import type { Point, Polyline } from '../types';

/**
 * Unit tests for the shared nearest-neighbor polyline ordering helper.
 *
 * This helper is the single canonical NN ordering used by BOTH the
 * Image_Processor's contour ordering (task 17.3) and the planner's stitch
 * stage. The tests below cover the core behaviours required by Req 4.7:
 *   - travel-minimising visit order (nearer endpoint first)
 *   - per-polyline flip selection (reverse when the tail is the near end)
 *   - deterministic tie-breaking
 *   - PURE ordering: no connector segments are inserted, every input
 *     polyline appears exactly once, oriented copies (inputs unmutated)
 *   - the `minPoints` drop threshold
 */

/** Total straight-line connector travel for a given visit order. */
function connectorTravel(start: Point, ordered: Polyline[]): number {
    let total = 0;
    let cursor = start;
    for (const poly of ordered) {
        const head = poly[0]!;
        total += Math.hypot(head.x - cursor.x, head.y - cursor.y);
        cursor = poly[poly.length - 1]!;
    }
    return total;
}

describe('orderPolylinesNearestNeighbor', () => {
    it('returns [] for an empty input', () => {
        expect(orderPolylinesNearestNeighbor([], { x: 0, y: 0 })).toEqual([]);
    });

    it('orders by nearest endpoint, visiting the closer polyline first', () => {
        const far: Polyline = [
            { x: 100, y: 100 },
            { x: 101, y: 100 },
        ];
        const near: Polyline = [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
        ];
        // Pass far first to prove ordering is by distance, not input order.
        const ordered = orderPolylinesNearestNeighbor([far, near], {
            x: 0,
            y: 0,
        });
        expect(ordered[0]).toEqual(near);
        expect(ordered[1]).toEqual(far);
    });

    it('flips a polyline when its tail is the nearer entry point', () => {
        const poly: Polyline = [
            { x: 10, y: 0 },
            { x: 1, y: 0 },
        ];
        const ordered = orderPolylinesNearestNeighbor([poly], { x: 0, y: 0 });
        // Tail (1,0) is closer to origin, so the polyline is reversed so the
        // pen enters at the near end.
        expect(ordered[0]).toEqual([
            { x: 1, y: 0 },
            { x: 10, y: 0 },
        ]);
    });

    it('chooses orientation per polyline to minimise the hop, advancing the cursor', () => {
        // A runs (10,0)->(20,0); B runs (40,0)->(30,0).
        // From origin: A's head (10,0) is nearest, no flip → exit at (20,0).
        // From (20,0): B's tail (30,0) is nearest, flip B → (30,0)->(40,0).
        const A: Polyline = [
            { x: 10, y: 0 },
            { x: 20, y: 0 },
        ];
        const B: Polyline = [
            { x: 40, y: 0 },
            { x: 30, y: 0 },
        ];
        const ordered = orderPolylinesNearestNeighbor([A, B], { x: 0, y: 0 });
        expect(ordered[0]).toEqual(A);
        expect(ordered[1]).toEqual([
            { x: 30, y: 0 },
            { x: 40, y: 0 },
        ]);
    });

    it('produces an order whose travel is no worse than the input order', () => {
        const start: Point = { x: 0, y: 0 };
        const polys: Polyline[] = [
            [
                { x: 90, y: 0 },
                { x: 100, y: 0 },
            ],
            [
                { x: 5, y: 0 },
                { x: 10, y: 0 },
            ],
            [
                { x: 50, y: 0 },
                { x: 55, y: 0 },
            ],
        ];
        const ordered = orderPolylinesNearestNeighbor(polys, start);
        // Greedy NN should beat the (deliberately bad) input order here.
        expect(connectorTravel(start, ordered)).toBeLessThan(
            connectorTravel(start, polys),
        );
    });

    it('inserts NO connector segments (pure ordering)', () => {
        const polys: Polyline[] = [
            [
                { x: 50, y: 50 },
                { x: 60, y: 50 },
            ],
            [
                { x: 0, y: 0 },
                { x: 5, y: 5 },
            ],
        ];
        const ordered = orderPolylinesNearestNeighbor(polys, { x: 0, y: 0 });
        // Output count equals the number of surviving input polylines: no
        // extra connector entries are woven in.
        expect(ordered).toHaveLength(polys.length);
        // Each output is a reordering/reversal of an input polyline, never a
        // synthetic 2-point hop between two different polylines' endpoints.
        const inputKeys = polys.map((p) => JSON.stringify(p));
        const revKeys = polys.map((p) => JSON.stringify(p.slice().reverse()));
        for (const poly of ordered) {
            const key = JSON.stringify(poly);
            expect(inputKeys.includes(key) || revKeys.includes(key)).toBe(true);
        }
    });

    it('includes every input polyline exactly once', () => {
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
        const ordered = orderPolylinesNearestNeighbor(polys, { x: 0, y: 0 });
        expect(ordered).toHaveLength(polys.length);
        const matched = new Array<boolean>(polys.length).fill(false);
        for (const poly of ordered) {
            const idx = polys.findIndex((p, i) => {
                if (matched[i]) return false;
                const fwd = JSON.stringify(p) === JSON.stringify(poly);
                const rev =
                    JSON.stringify(p.slice().reverse()) ===
                    JSON.stringify(poly);
                return fwd || rev;
            });
            expect(idx).toBeGreaterThanOrEqual(0);
            matched[idx] = true;
        }
        expect(matched.every(Boolean)).toBe(true);
    });

    it('is deterministic for a given input and start', () => {
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
        const a = orderPolylinesNearestNeighbor(polys, { x: 0, y: 0 });
        const b = orderPolylinesNearestNeighbor(polys, { x: 0, y: 0 });
        expect(b).toEqual(a);
    });

    it('breaks ties by earlier index, then forward orientation', () => {
        // Two polylines whose nearest endpoints are equidistant from origin.
        // first's head and second's head are both at distance 10. The
        // earlier index (first) must win, in forward orientation.
        const first: Polyline = [
            { x: 10, y: 0 },
            { x: 11, y: 0 },
        ];
        const second: Polyline = [
            { x: 0, y: 10 },
            { x: 0, y: 11 },
        ];
        const ordered = orderPolylinesNearestNeighbor([first, second], {
            x: 0,
            y: 0,
        });
        expect(ordered[0]).toEqual(first);
    });

    it('does not mutate the input polylines', () => {
        const poly: Polyline = [
            { x: 10, y: 0 },
            { x: 1, y: 0 },
        ];
        const snapshot = JSON.stringify(poly);
        orderPolylinesNearestNeighbor([poly], { x: 0, y: 0 });
        expect(JSON.stringify(poly)).toBe(snapshot);
    });

    it('drops empty polylines but keeps single-point ones by default (minPoints=1)', () => {
        const a: Polyline = [
            { x: 5, y: 5 },
            { x: 6, y: 5 },
        ];
        const single: Polyline = [{ x: 1, y: 1 }];
        const ordered = orderPolylinesNearestNeighbor([[], single, a], {
            x: 0,
            y: 0,
        });
        // Empty dropped; single-point kept; a kept → 2 survivors.
        expect(ordered).toHaveLength(2);
    });

    it('drops polylines shorter than an explicit minPoints threshold', () => {
        const single: Polyline = [{ x: 1, y: 1 }];
        const pair: Polyline = [
            { x: 5, y: 5 },
            { x: 6, y: 5 },
        ];
        const ordered = orderPolylinesNearestNeighbor(
            [single, pair],
            { x: 0, y: 0 },
            { minPoints: 2 },
        );
        expect(ordered).toHaveLength(1);
        expect(ordered[0]).toEqual(pair);
    });
});

describe('twoOptReorder (Chebyshev connector-travel reduction)', () => {
    /** Build n short two-point strokes at deterministic positions. */
    function scatteredStrokes(n: number, seed: number): Polyline[] {
        // Tiny deterministic LCG — no randomness leaks into the pass itself.
        let s = seed >>> 0;
        const next = (): number => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 0xffffffff;
        };
        const polys: Polyline[] = [];
        for (let i = 0; i < n; i++) {
            polys.push([
                { x: Math.round(next() * 1000), y: Math.round(next() * 1000) },
                { x: Math.round(next() * 1000), y: Math.round(next() * 1000) },
            ]);
        }
        return polys;
    }

    it('reduces or preserves total Chebyshev connector travel vs plain greedy NN', () => {
        const start: Point = { x: 0, y: 0 };
        const polys = scatteredStrokes(60, 7);
        const greedy = orderPolylinesNearestNeighbor(polys, start);
        const refined = orderPolylinesNearestNeighbor(polys, start, { twoOpt: true });

        const before = totalConnectorTravelChebyshev(greedy, start);
        const after = totalConnectorTravelChebyshev(refined, start);
        expect(after).toBeLessThanOrEqual(before);
    });

    it('strictly reduces travel on an adversarial zig-zag order', () => {
        const start: Point = { x: 0, y: 0 };
        // Naive order zig-zags top↔bottom; 2-opt should group same-row strokes.
        const polys: Polyline[] = [
            [{ x: 0, y: 0 }, { x: 10, y: 0 }],
            [{ x: 0, y: 500 }, { x: 10, y: 500 }],
            [{ x: 20, y: 0 }, { x: 30, y: 0 }],
            [{ x: 20, y: 500 }, { x: 30, y: 500 }],
        ];
        const before = totalConnectorTravelChebyshev(polys, start);
        const after = totalConnectorTravelChebyshev(twoOptReorder(polys, start), start);
        expect(after).toBeLessThan(before);
    });

    it('is deterministic', () => {
        const start: Point = { x: 0, y: 0 };
        const greedy = orderPolylinesNearestNeighbor(scatteredStrokes(40, 11), start);
        const a = twoOptReorder(greedy, start);
        const b = twoOptReorder(greedy, start);
        expect(b).toEqual(a);
    });

    it('preserves the stroke set and geometry (order/orientation only)', () => {
        const start: Point = { x: 0, y: 0 };
        const polys = scatteredStrokes(50, 3);
        const greedy = orderPolylinesNearestNeighbor(polys, start);
        const refined = twoOptReorder(greedy, start);

        const key = (ps: Polyline[]): string[] =>
            ps
                .map((p) => {
                    const a = p[0]!;
                    const b = p[p.length - 1]!;
                    // Orientation-independent endpoint-pair key.
                    const e1 = `${a.x},${a.y}`;
                    const e2 = `${b.x},${b.y}`;
                    return e1 <= e2 ? `${e1}|${e2}` : `${e2}|${e1}`;
                })
                .sort();
        expect(refined).toHaveLength(greedy.length);
        expect(key(refined)).toEqual(key(greedy));
    });

    it('does not mutate the input and is a no-op for < 2 strokes', () => {
        const start: Point = { x: 0, y: 0 };
        const single: Polyline[] = [[{ x: 5, y: 5 }, { x: 9, y: 9 }]];
        const snapshot = JSON.stringify(single);
        const out = twoOptReorder(single, start);
        expect(JSON.stringify(single)).toBe(snapshot); // input untouched
        expect(out).toEqual(single);
        expect(out).not.toBe(single);
        expect(twoOptReorder([], start)).toEqual([]);
    });
});
