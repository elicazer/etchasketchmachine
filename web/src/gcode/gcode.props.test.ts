import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatGCode, fromGCode, parseGCode, toGCode } from './gcode';
import type { GCodeProgram, PlannedPath, PlannedSegment, SegmentKind } from '../types';

/**
 * Property-based tests for the G-code program round-trip (Property 2).
 *
 * Validates: Requirements 5.1, 5.6, 14.6
 *
 * @see Design §4.2, §7 Property 2
 *
 * Four angles on the same property, for every generated valid
 * `PlannedPath` `p`:
 *
 *   1. AST round-trip (Req 5.6, 14.6)
 *        `fromGCode(toGCode(p)).segments` deep-equals `p.segments`.
 *        `drawableSteps` is not encoded in the textual form, so the
 *        generator and the comparison both pin it to `{ w: 0, h: 0 }`.
 *
 *   2. Text round-trip (Req 5.6, 14.6)
 *        `fromGCode(parseGCode(formatGCode(toGCode(p)))).segments`
 *        deep-equals `p.segments` — the realistic on-disk / on-wire
 *        path a caller experiences.
 *
 *   3. Integer coordinates (Req 5.1)
 *        every `G1` line emitted by `toGCode(p)` carries integer
 *        `x`, `y`, and `f` (no floats on the wire).
 *
 *   4. Continuity preserved (Req 14.6)
 *        in the reconstructed path, `segments[i].last === segments[i+1].first`.
 */

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

const COORD_MIN = -5_000;
const COORD_MAX = 5_000;

const coord = fc.integer({ min: COORD_MIN, max: COORD_MAX });
const pointArb = fc.record({ x: coord, y: coord });
const kindArb: fc.Arbitrary<SegmentKind> = fc.constantFrom<SegmentKind>(
    'stroke',
    'connector',
);

type Pt = { x: number; y: number };

/**
 * Replace any vertex that equals its predecessor with a nudged copy so
 * that no two CONSECUTIVE vertices in the chain are identical. This
 * mirrors the planner invariant "no zero-length sub-segments" and keeps
 * the round-trip deep-equality meaningful (the emitter/parser pair would
 * otherwise legitimately preserve duplicate points, but generating them
 * adds no coverage). The nudge stays within `[COORD_MIN, COORD_MAX]` and
 * keeps coordinates integral.
 */
function dedupeConsecutive(points: Pt[]): Pt[] {
    const out: Pt[] = [points[0]!];
    for (let i = 1; i < points.length; i++) {
        const prev = out[out.length - 1]!;
        let p = points[i]!;
        if (p.x === prev.x && p.y === prev.y) {
            const nudged = p.x < COORD_MAX ? p.x + 1 : p.x - 1;
            p = { x: nudged, y: p.y };
        }
        out.push(p);
    }
    return out;
}

/**
 * Generates a VALID `PlannedPath` satisfying the planner continuity
 * invariants:
 *
 *   - 1..6 segments, each with >= 2 integer-coordinate points.
 *   - Continuity seam: `segments[i].last === segments[i+1].first`.
 *   - No two consecutive identical points within a segment.
 *
 * Construction: generate one continuous chain of distinct-consecutive
 * vertices, then split it into segments. Segment `i` covers a contiguous
 * slice of the chain, and the shared boundary vertex is the last point of
 * segment `i` AND the first point of segment `i+1` — so continuity holds
 * by construction and the shared seam is a single object value.
 *
 * Why kinds STRICTLY ALTERNATE: the canonical textual form delimits
 * connector runs with `M3` / `M5` markers but emits NO boundary token
 * between two adjacent same-kind segments. `fromGCode` only opens a new
 * segment on a marker, so two consecutive `stroke` (or two consecutive
 * `connector`) segments round-trip as a SINGLE merged segment, which
 * would break deep equality. The planner's real output alternates kinds
 * (every connector sits between strokes, and vice versa), so the
 * generator mirrors that invariant by alternating from a random starting
 * kind. This is a deliberate modeling choice, not a workaround for a bug.
 */
const plannedPathArb: fc.Arbitrary<PlannedPath> = fc
    .tuple(
        kindArb,
        // Per-segment count of ADDITIONAL vertices beyond the segment's
        // first (shared seam) point — 1..5, so each segment has 2..6 points.
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 6 }),
        // A pool of points long enough to cover the chain; we slice the
        // exact amount we need after computing the total.
        fc.array(pointArb, { minLength: 2, maxLength: 64 }),
    )
    .map(([firstKind, extras, pool]) => {
        // Total distinct vertices in the continuous chain: one start
        // vertex plus the sum of per-segment additional vertices.
        const total = 1 + extras.reduce((a, b) => a + b, 0);

        // Ensure the pool is long enough by repeating it deterministically.
        const raw: Pt[] = [];
        for (let i = 0; i < total; i++) {
            raw.push(pool[i % pool.length]!);
        }
        const chain = dedupeConsecutive(raw);

        const segments: PlannedSegment[] = [];
        let offset = 0;
        let kind: SegmentKind = firstKind;
        for (const extra of extras) {
            // Segment spans chain[offset .. offset + extra] inclusive:
            // (extra + 1) points, sharing chain[offset] with the previous
            // segment's last point.
            const pointsSteps = chain.slice(offset, offset + extra + 1);
            segments.push({ kind, pointsSteps });
            offset += extra;
            kind = kind === 'stroke' ? 'connector' : 'stroke';
        }

        return { drawableSteps: { w: 0, h: 0 }, segments };
    });

// numRuns ~300 to exercise a wide variety of shapes, kinds, and lengths.
const NUM_RUNS = 300;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isContinuous(path: PlannedPath): boolean {
    for (let i = 0; i + 1 < path.segments.length; i++) {
        const a = path.segments[i]!.pointsSteps;
        const b = path.segments[i + 1]!.pointsSteps;
        const last = a[a.length - 1]!;
        const first = b[0]!;
        if (last.x !== first.x || last.y !== first.y) return false;
    }
    return true;
}

function g1Lines(prog: GCodeProgram) {
    return prog.lines.filter(
        (l): l is Extract<GCodeProgram['lines'][number], { op: 'G1' }> =>
            l.op === 'G1',
    );
}

// -----------------------------------------------------------------------------
// Properties
// -----------------------------------------------------------------------------

describe('G-code program round-trip (Property 2)', () => {
    it('AST round-trip: fromGCode(toGCode(p)).segments deep-equals p.segments', () => {
        // Validates: Requirements 5.6, 14.6
        fc.assert(
            fc.property(plannedPathArb, (path) => {
                const reconstructed = fromGCode(toGCode(path));
                expect(reconstructed.segments).toEqual(path.segments);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('Text round-trip: fromGCode(parseGCode(formatGCode(toGCode(p)))).segments deep-equals p.segments', () => {
        // Validates: Requirements 5.6, 14.6
        fc.assert(
            fc.property(plannedPathArb, (path) => {
                const text = formatGCode(toGCode(path));
                const reconstructed = fromGCode(parseGCode(text));
                expect(reconstructed.segments).toEqual(path.segments);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('Integer coordinates: every emitted G1 has integer x, y, f', () => {
        // Validates: Requirements 5.1
        fc.assert(
            fc.property(plannedPathArb, (path) => {
                for (const line of g1Lines(toGCode(path))) {
                    expect(Number.isInteger(line.x)).toBe(true);
                    expect(Number.isInteger(line.y)).toBe(true);
                    expect(Number.isInteger(line.f)).toBe(true);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('Continuity preserved: reconstructed segments[i].last === segments[i+1].first', () => {
        // Validates: Requirements 14.6
        fc.assert(
            fc.property(plannedPathArb, (path) => {
                const reconstructed = fromGCode(toGCode(path));
                expect(isContinuous(reconstructed)).toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
