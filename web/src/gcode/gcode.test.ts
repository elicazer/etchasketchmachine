import { describe, it, expect } from 'vitest';
import {
    GCodeError,
    formatGCode,
    fromGCode,
    parseGCode,
    toGCode,
} from './gcode';
import { FEED_SPS_MAX } from '../constants';
import type { GCodeProgram, PlannedPath } from '../types';

/**
 * Unit tests for the canonical G-code emitter, formatter, parser, and
 * AST → PlannedPath reconstructor (Design §4.2). Property-based
 * round-trip coverage lives in task 14.2; these tests pin down the
 * exact textual form, marker semantics, and round-trip on a hand-crafted
 * fixture with mixed stroke and connector segments.
 */

// A reusable fixture: stroke -> connector -> stroke -> connector (auto-home).
// Adjacent segments share an endpoint per the PlannedPath continuity invariant.
const fixturePath: PlannedPath = {
    drawableSteps: { w: 0, h: 0 },
    segments: [
        {
            kind: 'stroke',
            pointsSteps: [
                { x: 10, y: 20 },
                { x: 50, y: 80 },
                { x: 100, y: 30 },
            ],
        },
        {
            kind: 'connector',
            pointsSteps: [
                { x: 100, y: 30 },
                { x: 200, y: 200 },
            ],
        },
        {
            kind: 'stroke',
            pointsSteps: [
                { x: 200, y: 200 },
                { x: 250, y: 250 },
                { x: 300, y: 100 },
            ],
        },
        {
            kind: 'connector',
            pointsSteps: [
                { x: 300, y: 100 },
                { x: 0, y: 0 },
            ],
        },
    ],
};

describe('toGCode', () => {
    it('emits G90 then G1 X.. Y.. F.. lines and ends with M2', () => {
        const path: PlannedPath = {
            drawableSteps: { w: 0, h: 0 },
            segments: [
                {
                    kind: 'stroke',
                    pointsSteps: [
                        { x: 0, y: 0 },
                        { x: 10, y: 5 },
                        { x: 20, y: 10 },
                    ],
                },
            ],
        };
        const prog = toGCode(path);
        expect(prog.units).toBe('steps');
        expect(prog.origin).toBe('home');

        // Header is G90 (absolute mode).
        expect(prog.lines[0]).toEqual({ op: 'G90' });

        // Three points => three G1 lines, all at the default feed rate.
        expect(prog.lines[1]).toEqual({
            op: 'G1',
            x: 0,
            y: 0,
            f: FEED_SPS_MAX,
            kind: 'stroke',
        });
        expect(prog.lines[2]).toEqual({
            op: 'G1',
            x: 10,
            y: 5,
            f: FEED_SPS_MAX,
            kind: 'stroke',
        });
        expect(prog.lines[3]).toEqual({
            op: 'G1',
            x: 20,
            y: 10,
            f: FEED_SPS_MAX,
            kind: 'stroke',
        });

        // Footer is M2 (end of program).
        expect(prog.lines[prog.lines.length - 1]).toEqual({ op: 'M2' });
    });

    it('honours the feedSps option on every G1', () => {
        const path: PlannedPath = {
            drawableSteps: { w: 0, h: 0 },
            segments: [
                {
                    kind: 'stroke',
                    pointsSteps: [
                        { x: 0, y: 0 },
                        { x: 1, y: 1 },
                    ],
                },
            ],
        };
        const prog = toGCode(path, { feedSps: 250 });
        const g1Lines = prog.lines.filter((l) => l.op === 'G1');
        expect(g1Lines).toHaveLength(2);
        for (const line of g1Lines) {
            if (line.op === 'G1') expect(line.f).toBe(250);
        }
    });

    it('surrounds connector segments with M3 and M5 markers', () => {
        const prog = toGCode(fixturePath);
        const ops = prog.lines.map((l) => l.op);

        // Two connector segments => two M3/M5 pairs.
        expect(ops.filter((o) => o === 'M3')).toHaveLength(2);
        expect(ops.filter((o) => o === 'M5')).toHaveLength(2);

        // Every M3 has a matching M5 later in the program.
        for (let i = 0; i < ops.length; i++) {
            if (ops[i] === 'M3') {
                const close = ops.indexOf('M5', i);
                expect(close).toBeGreaterThan(i);
            }
        }
    });

    it('emits points between M3 and M5 and tags them kind: connector', () => {
        const path: PlannedPath = {
            drawableSteps: { w: 0, h: 0 },
            segments: [
                {
                    kind: 'stroke',
                    pointsSteps: [
                        { x: 0, y: 0 },
                        { x: 10, y: 10 },
                    ],
                },
                {
                    kind: 'connector',
                    pointsSteps: [
                        { x: 10, y: 10 },
                        { x: 50, y: 50 },
                    ],
                },
            ],
        };
        const prog = toGCode(path);
        const m3 = prog.lines.findIndex((l) => l.op === 'M3');
        const m5 = prog.lines.findIndex((l) => l.op === 'M5');
        expect(m3).toBeGreaterThan(0);
        expect(m5).toBeGreaterThan(m3);

        // Exactly one G1 between the M3 and M5: the second point of the
        // connector segment. Its first point is the seam shared with the
        // previous stroke segment, already emitted as the last G1 before M3.
        const between = prog.lines.slice(m3 + 1, m5);
        expect(between).toHaveLength(1);
        const only = between[0]!;
        if (only.op === 'G1') {
            expect(only).toEqual({
                op: 'G1',
                x: 50,
                y: 50,
                f: FEED_SPS_MAX,
                kind: 'connector',
            });
        } else {
            throw new Error(`expected a G1 between M3/M5, got ${only.op}`);
        }
    });

    it('skips the shared seam point of every segment after the first', () => {
        const prog = toGCode(fixturePath);
        const g1s = prog.lines.filter(
            (l): l is Extract<typeof l, { op: 'G1' }> => l.op === 'G1',
        );

        // Point counts per segment: 3 + 2 + 3 + 2 = 10. Seams between
        // adjacent segments are emitted exactly once each, so the total
        // number of G1 lines equals the unique-vertex count, which is
        // 10 - 3 (shared seams) = 7.
        expect(g1s).toHaveLength(7);

        const xs = g1s.map((g) => g.x);
        const ys = g1s.map((g) => g.y);
        expect(xs).toEqual([10, 50, 100, 200, 250, 300, 0]);
        expect(ys).toEqual([20, 80, 30, 200, 250, 100, 0]);
    });

    it('handles an empty path as G90 / M2', () => {
        const prog = toGCode({
            drawableSteps: { w: 0, h: 0 },
            segments: [],
        });
        expect(prog.lines).toEqual([{ op: 'G90' }, { op: 'M2' }]);
    });
});

describe('formatGCode', () => {
    it('produces the canonical textual form, newline-separated', () => {
        const prog: GCodeProgram = {
            units: 'steps',
            origin: 'home',
            lines: [
                { op: 'G90' },
                { op: 'G1', x: 0, y: 0, f: 1000, kind: 'stroke' },
                { op: 'G1', x: 10, y: 20, f: 1000, kind: 'stroke' },
                { op: 'M3' },
                { op: 'G1', x: 100, y: 200, f: 500, kind: 'connector' },
                { op: 'M5' },
                { op: 'M2' },
            ],
        };
        const text = formatGCode(prog);
        expect(text).toBe(
            [
                'G90',
                'G1 X0 Y0 F1000',
                'G1 X10 Y20 F1000',
                'M3',
                'G1 X100 Y200 F500',
                'M5',
                'M2',
                '',
            ].join('\n'),
        );
    });

    it('serialises comments with a leading "; " and supports negative coordinates', () => {
        const prog: GCodeProgram = {
            units: 'steps',
            origin: 'home',
            lines: [
                { op: 'comment', text: 'planner output' },
                { op: 'G90' },
                { op: 'G1', x: -10, y: -20, f: 100, kind: 'stroke' },
                { op: 'M2' },
            ],
        };
        expect(formatGCode(prog)).toBe(
            '; planner output\nG90\nG1 X-10 Y-20 F100\nM2\n',
        );
    });
});

describe('parseGCode', () => {
    it('round-trips formatGCode for a hand-constructed mixed program', () => {
        const prog: GCodeProgram = {
            units: 'steps',
            origin: 'home',
            lines: [
                { op: 'G90' },
                { op: 'G1', x: 0, y: 0, f: 1000, kind: 'stroke' },
                { op: 'G1', x: 10, y: 20, f: 1000, kind: 'stroke' },
                { op: 'M3' },
                { op: 'G1', x: 50, y: 50, f: 750, kind: 'connector' },
                { op: 'M5' },
                { op: 'G1', x: 60, y: 70, f: 1000, kind: 'stroke' },
                { op: 'M2' },
            ],
        };
        const text = formatGCode(prog);
        const parsed = parseGCode(text);

        // The parser cannot recover G1 `kind` from a single line in
        // isolation (it is restored by `fromGCode` from M3/M5 context),
        // so the parsed AST tags every G1 as 'stroke' by default.
        // Re-format both and compare textually so that the comparison
        // ignores the `kind` field.
        expect(formatGCode(parsed)).toBe(text);
        expect(parsed.units).toBe('steps');
        expect(parsed.origin).toBe('home');
    });

    it('strips blank lines and ; comments', () => {
        const text = [
            '; header comment',
            '',
            'G90',
            '   ',
            '; before motion',
            'G1 X1 Y2 F100',
            'M2',
            '',
        ].join('\n');
        const parsed = parseGCode(text);
        expect(parsed.lines).toEqual([
            { op: 'G90' },
            { op: 'G1', x: 1, y: 2, f: 100, kind: 'stroke' },
            { op: 'M2' },
        ]);
    });

    it('rejects unknown opcodes with a 1-based line number', () => {
        const text = 'G90\nG2 X1 Y2 F100\nM2\n';
        try {
            parseGCode(text);
            throw new Error('expected parseGCode to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(GCodeError);
            const e = err as GCodeError;
            expect(e.kind).toBe('parse');
            expect(e.line).toBe(2);
        }
    });

    it('rejects G1 missing X, Y, or F', () => {
        for (const bad of [
            'G90\nG1 X1 Y2\nM2\n',
            'G90\nG1 X1 F100\nM2\n',
            'G90\nG1 Y2 F100\nM2\n',
        ]) {
            try {
                parseGCode(bad);
                throw new Error(`expected throw for ${bad}`);
            } catch (err) {
                expect(err).toBeInstanceOf(GCodeError);
                expect((err as GCodeError).kind).toBe('parse');
            }
        }
    });

    it('rejects G1 with non-integer coordinate values', () => {
        try {
            parseGCode('G90\nG1 X1.5 Y2 F100\nM2\n');
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(GCodeError);
            expect((err as GCodeError).kind).toBe('parse');
        }
    });
});

describe('fromGCode / round-trip', () => {
    it('fromGCode(toGCode(path)) deep-equals the fixture path', () => {
        const reconstructed = fromGCode(toGCode(fixturePath));
        expect(reconstructed).toEqual(fixturePath);
    });

    it('round-trips a path whose first segment is a connector', () => {
        const path: PlannedPath = {
            drawableSteps: { w: 0, h: 0 },
            segments: [
                {
                    kind: 'connector',
                    pointsSteps: [
                        { x: 5, y: 5 },
                        { x: 10, y: 10 },
                    ],
                },
                {
                    kind: 'stroke',
                    pointsSteps: [
                        { x: 10, y: 10 },
                        { x: 20, y: 20 },
                    ],
                },
            ],
        };
        expect(fromGCode(toGCode(path))).toEqual(path);
    });

    it('round-trips two consecutive connector segments', () => {
        const path: PlannedPath = {
            drawableSteps: { w: 0, h: 0 },
            segments: [
                {
                    kind: 'stroke',
                    pointsSteps: [
                        { x: 0, y: 0 },
                        { x: 10, y: 10 },
                    ],
                },
                {
                    kind: 'connector',
                    pointsSteps: [
                        { x: 10, y: 10 },
                        { x: 20, y: 20 },
                    ],
                },
                {
                    kind: 'connector',
                    pointsSteps: [
                        { x: 20, y: 20 },
                        { x: 30, y: 30 },
                    ],
                },
            ],
        };
        expect(fromGCode(toGCode(path))).toEqual(path);
    });

    it('survives format -> parse -> reconstruct in addition to AST round-trip', () => {
        const prog = toGCode(fixturePath);
        const text = formatGCode(prog);
        const parsed = parseGCode(text);
        // Re-tag G1 kinds via M3/M5 markers in fromGCode.
        const reconstructed = fromGCode(parsed);
        expect(reconstructed).toEqual(fixturePath);
    });

    it('rejects an unbalanced M5 without a matching M3', () => {
        const prog: GCodeProgram = {
            units: 'steps',
            origin: 'home',
            lines: [
                { op: 'G90' },
                { op: 'G1', x: 0, y: 0, f: 100, kind: 'stroke' },
                { op: 'M5' },
                { op: 'M2' },
            ],
        };
        try {
            fromGCode(prog);
            throw new Error('expected fromGCode to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(GCodeError);
            expect((err as GCodeError).kind).toBe('unbalanced-marker');
        }
    });

    it('rejects an unbalanced M3 (program ends without M5)', () => {
        const prog: GCodeProgram = {
            units: 'steps',
            origin: 'home',
            lines: [
                { op: 'G90' },
                { op: 'G1', x: 0, y: 0, f: 100, kind: 'stroke' },
                { op: 'M3' },
                { op: 'G1', x: 10, y: 10, f: 100, kind: 'connector' },
                { op: 'M2' },
            ],
        };
        try {
            fromGCode(prog);
            throw new Error('expected fromGCode to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(GCodeError);
            expect((err as GCodeError).kind).toBe('unbalanced-marker');
        }
    });

    it('rejects a nested M3 (M3 while already in connector run)', () => {
        const prog: GCodeProgram = {
            units: 'steps',
            origin: 'home',
            lines: [
                { op: 'G90' },
                { op: 'G1', x: 0, y: 0, f: 100, kind: 'stroke' },
                { op: 'M3' },
                { op: 'G1', x: 5, y: 5, f: 100, kind: 'connector' },
                { op: 'M3' },
                { op: 'G1', x: 10, y: 10, f: 100, kind: 'connector' },
                { op: 'M5' },
                { op: 'M2' },
            ],
        };
        try {
            fromGCode(prog);
            throw new Error('expected fromGCode to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(GCodeError);
            expect((err as GCodeError).kind).toBe('unbalanced-marker');
        }
    });
});
