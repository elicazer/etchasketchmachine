/**
 * Tests for the backlash machine simulator (`machine_sim.ts`).
 *
 * The simulator models the per-axis gear-lash deadband that distorts the
 * physical Etch-a-Sketch trace versus the planner's ideal geometry. These
 * tests pin the deadband semantics (monotonic moves are 1:1, reversals lose up
 * to `slack` steps), structural preservation, determinism, and the
 * connector-travel readout.
 */

import { describe, it, expect } from 'vitest';
import type { PlannedPath } from '../types';
import { simulateStylusTrace, connectorTravelSteps } from './machine_sim';

function path(segments: PlannedPath['segments']): PlannedPath {
    return { drawableSteps: { w: 100, h: 100 }, segments };
}

describe('simulateStylusTrace', () => {
    it('is a pass-through when slack is zero', () => {
        const p = path([
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
        ]);
        const sim = simulateStylusTrace(p, { x: 0, y: 0 });
        expect(sim.segments[0]!.pointsSteps).toEqual(p.segments[0]!.pointsSteps);
    });

    it('moves 1:1 while direction is monotonic on an axis', () => {
        // Pure rightward motion never reverses, so backlash never engages.
        const p = path([
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 12, y: 0 }] },
        ]);
        const sim = simulateStylusTrace(p, { x: 4, y: 4 });
        expect(sim.segments[0]!.pointsSteps).toEqual([
            { x: 0, y: 0 },
            { x: 5, y: 0 },
            { x: 12, y: 0 },
        ]);
    });

    it('loses up to `slack` steps on a direction reversal', () => {
        // Go +10 on X (engages lash to the + side), then command -10 back.
        // The first `slack` (=3) reverse steps only close the gap (no motion),
        // so the stylus ends at 10 - (10 - 3) = 3 instead of the commanded 0.
        const p = path([
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }] },
        ]);
        const sim = simulateStylusTrace(p, { x: 3, y: 0 });
        const out = sim.segments[0]!.pointsSteps;
        expect(out[1]).toEqual({ x: 10, y: 0 }); // forward move is exact
        expect(out[2]).toEqual({ x: 3, y: 0 }); // reversal undershoots by slack
    });

    it('preserves segment structure (count, kinds, point counts)', () => {
        const p = path([
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 8, y: 4 }] },
            { kind: 'connector', pointsSteps: [{ x: 8, y: 4 }, { x: 2, y: 9 }, { x: 0, y: 0 }] },
        ]);
        const sim = simulateStylusTrace(p, { x: 2, y: 2 });
        expect(sim.segments).toHaveLength(2);
        expect(sim.segments[0]!.kind).toBe('stroke');
        expect(sim.segments[1]!.kind).toBe('connector');
        expect(sim.segments[0]!.pointsSteps).toHaveLength(2);
        expect(sim.segments[1]!.pointsSteps).toHaveLength(3);
        expect(sim.drawableSteps).toEqual(p.drawableSteps);
    });

    it('is deterministic', () => {
        const p = path([
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 10, y: 6 }, { x: 3, y: 6 }, { x: 3, y: 1 }] },
        ]);
        const a = simulateStylusTrace(p, { x: 2, y: 2 });
        const b = simulateStylusTrace(p, { x: 2, y: 2 });
        expect(a).toEqual(b);
    });

    it('treats axes independently', () => {
        // Reverse only on Y; X has no reversal so X stays exact.
        const p = path([
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }] },
        ]);
        const sim = simulateStylusTrace(p, { x: 4, y: 4 });
        const out = sim.segments[0]!.pointsSteps;
        expect(out[2]!.x).toBe(10); // X monotonic up → exact
        expect(out[2]!.y).toBe(4); // Y reversed by 5, slack 4 → ends at 5-(5-4)=4
    });
});

describe('connectorTravelSteps', () => {
    it('sums only connector segments in Chebyshev steps', () => {
        const p = path([
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 20, y: 0 }] }, // ignored
            { kind: 'connector', pointsSteps: [{ x: 20, y: 0 }, { x: 20, y: 7 }, { x: 30, y: 7 }] },
        ]);
        // 7 (vertical) + 10 (horizontal) = 17
        expect(connectorTravelSteps(p)).toBe(17);
    });

    it('is zero when there are no connectors', () => {
        const p = path([
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
        ]);
        expect(connectorTravelSteps(p)).toBe(0);
    });
});
