import { describe, it, expect } from 'vitest';
import { PathPlanner, totalStepCount, DEFAULT_EPSILON } from './planner';
import type { PathInput } from './planner';
import {
    DRAWABLE_MM,
    DRAWING_COMMAND_FLAGS,
    FULL_STEPS_PER_KNOB_REV,
} from '../constants';
import type { PlannedPath, PlannedSegment } from '../types';

/**
 * Unit tests for the Path_Planner orchestrator (Design §3.1.4).
 *
 * These pin down the pipeline composition (scale/clamp → step-convert →
 * RDP → NN stitch → auto-return), the continuity / final-connector / bounds
 * invariants on `PlannedPath`, and the `toCommands` / `estimateMillis` /
 * G-code-delegation contracts. The universal estimated-time property lives
 * in task 15.2.
 */

const { CONNECTOR, LAST_OF_BATCH } = DRAWING_COMMAND_FLAGS;

/**
 * Tests pin calibration to 100 mm/rev so the expected step counts are clean
 * integers (400/100 = 4 steps/mm), independent of the machine-specific default
 * baked into the constants.
 */
const CAL = { mmPerRevX: 100, mmPerRevY: 100 } as const;
const STEPS_PER_MM = FULL_STEPS_PER_KNOB_REV / CAL.mmPerRevX;

const DRAWABLE_STEPS = {
    w: Math.round((DRAWABLE_MM.w * FULL_STEPS_PER_KNOB_REV) / CAL.mmPerRevX),
    h: Math.round((DRAWABLE_MM.h * FULL_STEPS_PER_KNOB_REV) / CAL.mmPerRevY),
};

/** Assert adjacent segments share an endpoint and no sub-segment is zero-length. */
function assertContiguous(segs: PlannedSegment[]): void {
    for (const s of segs) {
        expect(s.pointsSteps.length).toBeGreaterThanOrEqual(2);
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

describe('PathPlanner.plan', () => {
    const planner = new PathPlanner();

    // Two disjoint polylines in mm-space, neither touching home.
    const input: PathInput = {
        polylines: [
            [
                { x: 10, y: 10 },
                { x: 20, y: 10 },
            ],
            [
                { x: 100, y: 50 },
                { x: 110, y: 50 },
            ],
        ],
    };

    it('produces a single continuous path (contiguity invariant holds)', () => {
        const path = planner.plan(input);
        expect(path.segments.length).toBeGreaterThan(0);
        assertContiguous(path.segments);
    });

    it('ends with a connector segment terminating at home (0, 0)', () => {
        const path = planner.plan(input);
        const last = path.segments[path.segments.length - 1]!;
        expect(last.kind).toBe('connector');
        const end = last.pointsSteps[last.pointsSteps.length - 1]!;
        expect(end).toEqual({ x: 0, y: 0 });
    });

    it('emits only integer coordinates within drawableSteps', () => {
        const path = planner.plan(input, { ...CAL });
        expect(path.drawableSteps).toEqual(DRAWABLE_STEPS);
        for (const seg of path.segments) {
            for (const p of seg.pointsSteps) {
                expect(Number.isInteger(p.x)).toBe(true);
                expect(Number.isInteger(p.y)).toBe(true);
                expect(p.x).toBeGreaterThanOrEqual(0);
                expect(p.y).toBeGreaterThanOrEqual(0);
                expect(p.x).toBeLessThanOrEqual(path.drawableSteps.w);
                expect(p.y).toBeLessThanOrEqual(path.drawableSteps.h);
            }
        }
    });

    it('scales mm → steps and clamps out-of-bounds points to the boundary', () => {
        const path = planner.plan({
            polylines: [
                [
                    // In-bounds: 10 mm → 40 steps, 20 mm → 80 steps.
                    { x: 10, y: 20 },
                    // Far out of bounds on both axes → clamped to the corner.
                    { x: 9999, y: 9999 },
                ],
            ],
        }, { ...CAL });
        // First real stroke begins after the leading home→entry connector.
        const stroke = path.segments.find((s) => s.kind === 'stroke')!;
        expect(stroke.pointsSteps[0]).toEqual({ x: 10 * STEPS_PER_MM, y: 20 * STEPS_PER_MM });
        const clamped = stroke.pointsSteps[stroke.pointsSteps.length - 1]!;
        expect(clamped).toEqual({ x: DRAWABLE_STEPS.w, y: DRAWABLE_STEPS.h });
    });

    it('applies RDP simplification using the supplied epsilon', () => {
        // A collinear run of points collapses to its endpoints under RDP.
        const collinear: PathInput = {
            polylines: [
                [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 20, y: 0 },
                    { x: 30, y: 0 },
                ],
            ],
        };
        const path = planner.plan(collinear, { epsilon: 1.0, ...CAL });
        const stroke = path.segments.find((s) => s.kind === 'stroke')!;
        // The three interior collinear points reduce to first + last.
        expect(stroke.pointsSteps).toEqual([
            { x: 0, y: 0 },
            { x: 30 * STEPS_PER_MM, y: 0 },
        ]);
    });

    it('rejects an out-of-range epsilon (delegated to rdpSimplify)', () => {
        expect(() => planner.plan(input, { epsilon: 10 })).toThrow(RangeError);
        expect(() => planner.plan(input, { epsilon: 0 })).toThrow(RangeError);
    });

    it('defaults epsilon to DEFAULT_EPSILON when omitted', () => {
        const withDefault = planner.plan(input);
        const withExplicit = planner.plan(input, { epsilon: DEFAULT_EPSILON });
        expect(withDefault).toEqual(withExplicit);
    });

    it('is deterministic for a given input', () => {
        expect(planner.plan(input)).toEqual(planner.plan(input));
    });

    it('handles empty input as just the (suppressed) auto-return — no segments', () => {
        const path = planner.plan({ polylines: [] }, { ...CAL });
        // Nothing to stitch and nothing to return from → empty path.
        expect(path.segments).toEqual([]);
        expect(path.drawableSteps).toEqual(DRAWABLE_STEPS);
    });

    it('honours a non-zero home offset by baking it into coordinates', () => {
        const home = { x: 5, y: 7 };
        const path = planner.plan(
            { polylines: [[{ x: 10, y: 20 }, { x: 30, y: 20 }]] },
            { homeOffsetSteps: home, ...CAL },
        );
        // The path stitches from and auto-returns to the offset home.
        const last = path.segments[path.segments.length - 1]!;
        expect(last.kind).toBe('connector');
        expect(last.pointsSteps[last.pointsSteps.length - 1]).toEqual(home);
        const stroke = path.segments.find((s) => s.kind === 'stroke')!;
        // 10 mm → 40 steps + home.x; 20 mm → 80 steps + home.y.
        expect(stroke.pointsSteps[0]).toEqual({
            x: 10 * STEPS_PER_MM + home.x,
            y: 20 * STEPS_PER_MM + home.y,
        });
    });
});

describe('PathPlanner.plan envelope-fit path', () => {
    const planner = new PathPlanner();

    // A measured Step_Envelope (step space), deliberately non-square so the
    // X/Y bounds are distinguishable.
    const ENV = { x: 800, y: 500 } as const;

    // Two disjoint polylines in (arbitrary) source space.
    const input: PathInput = {
        polylines: [
            [
                { x: 10, y: 10 },
                { x: 20, y: 10 },
                { x: 20, y: 30 },
            ],
            [
                { x: 100, y: 50 },
                { x: 140, y: 90 },
            ],
        ],
    };

    it('keeps every coordinate within the envelope [0,env.x] × [0,env.y]', () => {
        const path = planner.plan(input, { envelopeSteps: ENV });
        expect(path.segments.length).toBeGreaterThan(0);
        for (const seg of path.segments) {
            for (const p of seg.pointsSteps) {
                expect(Number.isInteger(p.x)).toBe(true);
                expect(Number.isInteger(p.y)).toBe(true);
                expect(p.x).toBeGreaterThanOrEqual(0);
                expect(p.y).toBeGreaterThanOrEqual(0);
                expect(p.x).toBeLessThanOrEqual(ENV.x);
                expect(p.y).toBeLessThanOrEqual(ENV.y);
            }
        }
    });

    it('reports drawableSteps equal to the envelope (w == env.x, h == env.y)', () => {
        const path = planner.plan(input, { envelopeSteps: ENV });
        expect(path.drawableSteps).toEqual({ w: ENV.x, h: ENV.y });
    });

    it('does NOT consult mmPerRev — absurd mmPerRevX/Y is ignored on the envelope path', () => {
        const withAbsurdCal = planner.plan(input, {
            envelopeSteps: ENV,
            mmPerRevX: 1e9,
            mmPerRevY: 0.0001,
        });
        const withoutCal = planner.plan(input, { envelopeSteps: ENV });
        // The envelope branch bypasses the mm gear-math entirely, so the
        // calibration values cannot change the result.
        expect(withAbsurdCal).toEqual(withoutCal);
        // And drawableSteps stays the envelope, never the mm-derived size.
        expect(withAbsurdCal.drawableSteps).toEqual({ w: ENV.x, h: ENV.y });
    });

    it('handles a degenerate single-point polyline without crashing and stays in bounds', () => {
        const degenerate: PathInput = {
            polylines: [[{ x: 42, y: 42 }]],
        };
        const path = planner.plan(degenerate, { envelopeSteps: ENV });
        // A lone point can't form a drawable stroke (stitch drops <2-point
        // polylines), so the path is empty — but it must not throw and the
        // envelope is still reported.
        expect(Array.isArray(path.segments)).toBe(true);
        expect(path.drawableSteps).toEqual({ w: ENV.x, h: ENV.y });
        for (const seg of path.segments) {
            for (const p of seg.pointsSteps) {
                expect(p.x).toBeGreaterThanOrEqual(0);
                expect(p.y).toBeGreaterThanOrEqual(0);
                expect(p.x).toBeLessThanOrEqual(ENV.x);
                expect(p.y).toBeLessThanOrEqual(ENV.y);
            }
        }
    });

    it('handles a zero-extent polyline (all points coincident) within bounds', () => {
        const zeroExtent: PathInput = {
            polylines: [
                [
                    { x: 7, y: 7 },
                    { x: 7, y: 7 },
                    { x: 7, y: 7 },
                ],
            ],
        };
        const path = planner.plan(zeroExtent, { envelopeSteps: ENV });
        expect(path.drawableSteps).toEqual({ w: ENV.x, h: ENV.y });
        for (const seg of path.segments) {
            for (const p of seg.pointsSteps) {
                expect(p.x).toBeGreaterThanOrEqual(0);
                expect(p.y).toBeGreaterThanOrEqual(0);
                expect(p.x).toBeLessThanOrEqual(ENV.x);
                expect(p.y).toBeLessThanOrEqual(ENV.y);
            }
        }
    });
});

describe('PathPlanner.toCommands', () => {
    const planner = new PathPlanner();
    const home = { x: 0, y: 0 };

    // A hand-built continuous path: stroke then auto-return connector.
    const path: PlannedPath = {
        drawableSteps: DRAWABLE_STEPS,
        segments: [
            {
                kind: 'stroke',
                pointsSteps: [
                    { x: 0, y: 0 },
                    { x: 40, y: 0 },
                    { x: 40, y: 30 },
                ],
            },
            {
                kind: 'connector',
                pointsSteps: [
                    { x: 40, y: 30 },
                    { x: 0, y: 0 },
                ],
            },
        ],
    };

    it('assigns monotonically increasing sequence numbers from 0', () => {
        const cmds = planner.toCommands(path, home, 500);
        expect(cmds.map((c) => c.seq)).toEqual([0, 1, 2]);
    });

    it('sets LAST_OF_BATCH only on the final command', () => {
        const cmds = planner.toCommands(path, home, 500);
        for (let i = 0; i < cmds.length - 1; i++) {
            expect(cmds[i]!.flags & LAST_OF_BATCH).toBe(0);
        }
        expect(cmds[cmds.length - 1]!.flags & LAST_OF_BATCH).toBe(LAST_OF_BATCH);
    });

    it('tags connector motions with the CONNECTOR flag and strokes without it', () => {
        const cmds = planner.toCommands(path, home, 500);
        // First two commands come from the stroke segment.
        expect(cmds[0]!.flags & CONNECTOR).toBe(0);
        expect(cmds[1]!.flags & CONNECTOR).toBe(0);
        // Final command is the auto-return connector.
        expect(cmds[2]!.flags & CONNECTOR).toBe(CONNECTOR);
    });

    it('emits per-vertex deltas relative to the running pen position', () => {
        const cmds = planner.toCommands(path, home, 500);
        expect(cmds[0]).toMatchObject({ dxSteps: 40, dySteps: 0, feedSps: 500 });
        expect(cmds[1]).toMatchObject({ dxSteps: 0, dySteps: 30, feedSps: 500 });
        expect(cmds[2]).toMatchObject({ dxSteps: -40, dySteps: -30, feedSps: 500 });
    });

    it('reconstructs home-relative positions equal to plannerOutput minus home (Property 3)', () => {
        const offsetHome = { x: 100, y: 50 };
        const offsetPath: PlannedPath = {
            drawableSteps: DRAWABLE_STEPS,
            segments: [
                {
                    kind: 'stroke',
                    pointsSteps: [
                        { x: 100, y: 50 }, // == home
                        { x: 140, y: 50 },
                        { x: 140, y: 80 },
                    ],
                },
                {
                    kind: 'connector',
                    pointsSteps: [
                        { x: 140, y: 80 },
                        { x: 100, y: 50 }, // back to home
                    ],
                },
            ],
        };
        const cmds = planner.toCommands(offsetPath, offsetHome, 500);
        // Replay deltas from (0,0): the trajectory must equal absolute coords minus home.
        let x = 0;
        let y = 0;
        const replay = [{ x, y }];
        for (const c of cmds) {
            x += c.dxSteps;
            y += c.dySteps;
            replay.push({ x, y });
        }
        expect(replay).toEqual([
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 40, y: 30 },
            { x: 0, y: 0 },
        ]);
    });

    it('skips the leading home→firstPoint hop when the path starts at home', () => {
        const cmds = planner.toCommands(path, home, 500);
        // Path[0][0] is exactly home, so no zero-length command is emitted.
        expect(cmds.every((c) => c.dxSteps !== 0 || c.dySteps !== 0)).toBe(true);
    });

    it('splits motions exceeding the i16 wire limit while keeping seq monotonic', () => {
        const bigPath: PlannedPath = {
            drawableSteps: { w: 100000, h: 100000 },
            segments: [
                {
                    kind: 'stroke',
                    pointsSteps: [
                        { x: 0, y: 0 },
                        { x: 70000, y: 0 },
                    ],
                },
                {
                    kind: 'connector',
                    pointsSteps: [
                        { x: 70000, y: 0 },
                        { x: 0, y: 0 },
                    ],
                },
            ],
        };
        const cmds = planner.toCommands(bigPath, home, 500);
        // 70000 / 32767 → 3 chunks per motion, two motions → 6 commands.
        expect(cmds).toHaveLength(6);
        // Sequence numbers are 0..5 with no gaps or repeats.
        expect(cmds.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5]);
        // The stroke's chunks sum to +70000 dx; the connector's to -70000.
        const strokeDx = cmds.slice(0, 3).reduce((s, c) => s + c.dxSteps, 0);
        const connectorDx = cmds.slice(3).reduce((s, c) => s + c.dxSteps, 0);
        expect(strokeDx).toBe(70000);
        expect(connectorDx).toBe(-70000);
        // CONNECTOR flag only on the connector chunks; LAST_OF_BATCH only at the end.
        expect(cmds.slice(0, 3).every((c) => (c.flags & CONNECTOR) === 0)).toBe(true);
        expect(cmds.slice(3).every((c) => (c.flags & CONNECTOR) === CONNECTOR)).toBe(true);
        expect(cmds.filter((c) => c.flags & LAST_OF_BATCH)).toHaveLength(1);
        expect(cmds[cmds.length - 1]!.flags & LAST_OF_BATCH).toBe(LAST_OF_BATCH);
    });

    it('returns [] for an empty path', () => {
        const empty: PlannedPath = { drawableSteps: DRAWABLE_STEPS, segments: [] };
        expect(planner.toCommands(empty, home, 500)).toEqual([]);
    });

    it('round-trips through the Drawing_Command codec (valid encodings)', () => {
        // Every emitted command must be a valid wire payload: seq monotonic,
        // deltas within i16, feed in range. We assert it indirectly via the
        // structural fields here; the codec round-trip property is task 10.2.
        const cmds = planner.toCommands(path, home, 1000);
        for (const c of cmds) {
            expect(Number.isInteger(c.seq)).toBe(true);
            expect(Math.abs(c.dxSteps)).toBeLessThanOrEqual(32767);
            expect(Math.abs(c.dySteps)).toBeLessThanOrEqual(32767);
            expect(c.feedSps).toBe(1000);
        }
    });
});

describe('PathPlanner.estimateMillis', () => {
    const planner = new PathPlanner();

    it('equals total Bresenham steps / feedSps * 1000 for a known fixture', () => {
        const path: PlannedPath = {
            drawableSteps: DRAWABLE_STEPS,
            segments: [
                {
                    kind: 'stroke',
                    pointsSteps: [
                        { x: 0, y: 0 },
                        { x: 10, y: 0 }, // 10 steps
                        { x: 10, y: 10 }, // 10 steps
                    ],
                },
                {
                    kind: 'connector',
                    pointsSteps: [
                        { x: 10, y: 10 },
                        { x: 0, y: 0 }, // max(10,10) = 10 steps
                    ],
                },
            ],
        };
        // Total = 10 + 10 + 10 = 30 steps.
        expect(totalStepCount(path)).toBe(30);
        expect(planner.estimateMillis(path, 100)).toBe((30 * 1000) / 100);
        expect(planner.estimateMillis(path, 100)).toBe(300);
    });

    it('uses max(|dx|, |dy|) per move (diagonal counts once, not twice)', () => {
        const path: PlannedPath = {
            drawableSteps: DRAWABLE_STEPS,
            segments: [
                {
                    kind: 'stroke',
                    pointsSteps: [
                        { x: 0, y: 0 },
                        { x: 30, y: 40 }, // max(30,40) = 40 steps
                    ],
                },
            ],
        };
        expect(totalStepCount(path)).toBe(40);
        expect(planner.estimateMillis(path, 200)).toBe((40 * 1000) / 200);
    });

    it('is zero for an empty path', () => {
        const empty: PlannedPath = { drawableSteps: DRAWABLE_STEPS, segments: [] };
        expect(planner.estimateMillis(empty, 500)).toBe(0);
    });

    it('rejects a non-positive feed rate', () => {
        const empty: PlannedPath = { drawableSteps: DRAWABLE_STEPS, segments: [] };
        expect(() => planner.estimateMillis(empty, 0)).toThrow(RangeError);
        expect(() => planner.estimateMillis(empty, -5)).toThrow(RangeError);
    });
});

describe('PathPlanner G-code delegation', () => {
    const planner = new PathPlanner();

    it('round-trips a planned path through toGCode / fromGCode (segments preserved)', () => {
        const path = planner.plan({
            polylines: [
                [
                    { x: 10, y: 10 },
                    { x: 20, y: 15 },
                    { x: 30, y: 10 },
                ],
                [
                    { x: 100, y: 50 },
                    { x: 110, y: 55 },
                ],
            ],
        });
        const reconstructed = planner.fromGCode(planner.toGCode(path));
        // drawableSteps is not carried in the textual form (reset to 0,0),
        // so compare the segment geometry, which must round-trip exactly.
        expect(reconstructed.segments).toEqual(path.segments);
    });

    it('toGCode stamps the planner default feed rate on every G1', () => {
        const planner250 = new PathPlanner({ feedSps: 250 });
        const path = planner250.plan({
            polylines: [[{ x: 10, y: 10 }, { x: 20, y: 10 }]],
        });
        const prog = planner250.toGCode(path);
        const g1s = prog.lines.filter((l) => l.op === 'G1');
        expect(g1s.length).toBeGreaterThan(0);
        for (const l of g1s) {
            if (l.op === 'G1') expect(l.f).toBe(250);
        }
    });
});
