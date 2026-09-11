/**
 * G-code emitter, formatter, parser, and AST → PlannedPath reconstructor.
 *
 * The textual form is canonical (Design §4.2):
 *
 *   - One `G1 X<steps> Y<steps> F<sps>` per polyline vertex.
 *   - Coordinates and feed rate are integers in motor steps and
 *     steps-per-second units.
 *   - Connector runs are delimited by `M3` (begin connector) and `M5`
 *     (end connector) lines so the stroke / connector split survives
 *     a round-trip through the textual form.
 *   - Programs always begin with `G90` (absolute mode) for clarity and
 *     end with `M2` (end of program).
 *   - Comments use `; <text>` style; they are emitted by callers when
 *     desired and are stripped by `parseGCode`.
 *
 * Continuity convention: in a `PlannedPath`, adjacent segments share an
 * endpoint (`segments[i].last === segments[i+1].first`). This shared
 * endpoint is emitted exactly once on the wire — at the end of segment
 * `i`. `toGCode` therefore emits every point of segment 0 and then, for
 * every subsequent segment, emits points `[1 .. end]` (skipping the
 * first point because it has already been written as the last point of
 * the previous segment).
 *
 * On parse, `fromGCode` reverses this: the first `G1` becomes the first
 * point of segment 0, subsequent `G1`s extend the current segment, and
 * `M3` / `M5` close the current segment and open a new one of the
 * opposite kind whose first point is implicitly the last point of the
 * previous segment.
 *
 * Round-trip: `fromGCode(toGCode(p))` reproduces `p` exactly because all
 * coordinates are integers; the 1-step tolerance of Req 5.6 / 14.6 is
 * vacuous.
 *
 * @see Design §4.2
 * @see Requirements 5.1, 5.6, 14.6
 */

import { FEED_SPS_MAX } from '../constants';
import type {
    GCodeLine,
    GCodeProgram,
    PlannedPath,
    PlannedSegment,
    SegmentKind,
} from '../types';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Discriminated reasons the G-code parser or reconstructor rejects its input.
 */
export type GCodeErrorKind =
    | 'parse'
    | 'shape'
    | 'unbalanced-marker'
    | 'no-points';

/** Typed error for `parseGCode` and `fromGCode`. */
export class GCodeError extends Error {
    public readonly kind: GCodeErrorKind;
    public readonly line?: number;

    constructor(kind: GCodeErrorKind, message: string, line?: number) {
        super(message);
        this.name = 'GCodeError';
        this.kind = kind;
        if (line !== undefined) this.line = line;
    }
}

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface ToGCodeOptions {
    /**
     * Feed rate in steps-per-second to attach to every emitted `G1`.
     * Defaults to {@link FEED_SPS_MAX}; callers wanting variable feed
     * rates per segment should post-process the returned program.
     */
    feedSps?: number;
}

// -----------------------------------------------------------------------------
// Emit
// -----------------------------------------------------------------------------

/**
 * Emit a `GCodeProgram` AST from a `PlannedPath`.
 *
 * The emitted program:
 *   - Starts with a single `G90` line (absolute coordinates).
 *   - Contains one `G1` per unique polyline vertex; the first vertex of
 *     each segment after the first is implicit (it equals the previous
 *     segment's last vertex, which was already emitted).
 *   - Wraps every connector segment with an `M3` … `M5` pair.
 *   - Ends with `M2`.
 *
 * Empty paths (no segments, or segments with no points) round-trip
 * trivially as `G90 / M2`.
 */
export function toGCode(
    path: PlannedPath,
    opts: ToGCodeOptions = {},
): GCodeProgram {
    const feedSps = opts.feedSps ?? FEED_SPS_MAX;
    const lines: GCodeLine[] = [{ op: 'G90' }];

    for (let i = 0; i < path.segments.length; i++) {
        const seg = path.segments[i]!;
        const isConnector = seg.kind === 'connector';

        if (isConnector) {
            lines.push({ op: 'M3' });
        }

        // For segment 0 emit every point. For subsequent segments,
        // skip the shared first point — it was already emitted as the
        // last point of the previous segment.
        const startIdx = i === 0 ? 0 : 1;
        for (let j = startIdx; j < seg.pointsSteps.length; j++) {
            const p = seg.pointsSteps[j]!;
            lines.push({
                op: 'G1',
                x: p.x,
                y: p.y,
                f: feedSps,
                kind: seg.kind,
            });
        }

        if (isConnector) {
            lines.push({ op: 'M5' });
        }
    }

    lines.push({ op: 'M2' });
    return { units: 'steps', origin: 'home', lines };
}

// -----------------------------------------------------------------------------
// Format
// -----------------------------------------------------------------------------

/**
 * Serialise a `GCodeProgram` AST to its canonical newline-separated
 * textual form.
 *
 * The output ends with a trailing newline so concatenation with another
 * program (and most editors) behaves naturally.
 */
export function formatGCode(prog: GCodeProgram): string {
    const out: string[] = [];
    for (const line of prog.lines) {
        out.push(formatLine(line));
    }
    return out.join('\n') + '\n';
}

function formatLine(line: GCodeLine): string {
    switch (line.op) {
        case 'G1':
            return `G1 X${line.x} Y${line.y} F${line.f}`;
        case 'G90':
            return 'G90';
        case 'G91':
            return 'G91';
        case 'M3':
            return 'M3';
        case 'M5':
            return 'M5';
        case 'M2':
            return 'M2';
        case 'comment':
            return `; ${line.text}`;
    }
}

// -----------------------------------------------------------------------------
// Parse
// -----------------------------------------------------------------------------

/**
 * Parse the canonical textual G-code form into a `GCodeProgram` AST.
 *
 * Blank lines and lines beginning with `;` (comments) are silently
 * stripped — this matches the Design §4.2 convention and lets callers
 * embed annotations without affecting downstream parsing. Every other
 * line is parsed strictly: any unrecognised opcode or token raises a
 * `GCodeError` with the offending 1-based line number.
 *
 * The parser is whitespace-tolerant within a line (any run of spaces or
 * tabs separates tokens) and case-sensitive on opcodes (`G1`, not `g1`)
 * to match the canonical form produced by {@link formatGCode}.
 */
export function parseGCode(text: string): GCodeProgram {
    const lines: GCodeLine[] = [];
    const rawLines = text.split(/\r?\n/);

    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i]!;
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        if (trimmed.startsWith(';')) continue;

        const tokens = trimmed.split(/[\s\t]+/);
        const op = tokens[0]!;

        switch (op) {
            case 'G90':
                expectNoArgs(op, tokens, i + 1);
                lines.push({ op: 'G90' });
                break;
            case 'G91':
                expectNoArgs(op, tokens, i + 1);
                lines.push({ op: 'G91' });
                break;
            case 'M3':
                expectNoArgs(op, tokens, i + 1);
                lines.push({ op: 'M3' });
                break;
            case 'M5':
                expectNoArgs(op, tokens, i + 1);
                lines.push({ op: 'M5' });
                break;
            case 'M2':
                expectNoArgs(op, tokens, i + 1);
                lines.push({ op: 'M2' });
                break;
            case 'G1':
                lines.push(parseG1(tokens, i + 1));
                break;
            default:
                throw new GCodeError(
                    'parse',
                    `unknown opcode "${op}"`,
                    i + 1,
                );
        }
    }

    return { units: 'steps', origin: 'home', lines };
}

function expectNoArgs(op: string, tokens: string[], lineNo: number): void {
    if (tokens.length !== 1) {
        throw new GCodeError(
            'parse',
            `${op} takes no arguments, got "${tokens.slice(1).join(' ')}"`,
            lineNo,
        );
    }
}

function parseG1(tokens: string[], lineNo: number): GCodeLine {
    let x: number | undefined;
    let y: number | undefined;
    let f: number | undefined;

    for (let k = 1; k < tokens.length; k++) {
        const tok = tokens[k]!;
        const prefix = tok.charAt(0);
        const rest = tok.slice(1);
        const value = Number.parseInt(rest, 10);
        if (!Number.isFinite(value) || rest.length === 0 ||
            !/^[-+]?\d+$/.test(rest)) {
            throw new GCodeError(
                'parse',
                `G1: token "${tok}" is not a signed integer`,
                lineNo,
            );
        }
        switch (prefix) {
            case 'X':
                x = value;
                break;
            case 'Y':
                y = value;
                break;
            case 'F':
                f = value;
                break;
            default:
                throw new GCodeError(
                    'parse',
                    `G1: unexpected token "${tok}" (expected X, Y, or F)`,
                    lineNo,
                );
        }
    }

    if (x === undefined || y === undefined || f === undefined) {
        throw new GCodeError(
            'parse',
            `G1 requires X, Y, and F (got ` +
            `X=${x ?? '∅'} Y=${y ?? '∅'} F=${f ?? '∅'})`,
            lineNo,
        );
    }

    // `kind` is restored by `fromGCode` from M3/M5 marker context; the
    // parser cannot determine it from a G1 in isolation, so we default
    // to 'stroke' here. Use of this default is harmless: anything that
    // round-trips through `fromGCode` will overwrite the field with the
    // marker-derived kind.
    return { op: 'G1', x, y, f, kind: 'stroke' };
}

// -----------------------------------------------------------------------------
// Reconstruct
// -----------------------------------------------------------------------------

/**
 * Reconstruct a `PlannedPath` from a parsed `GCodeProgram`.
 *
 * The reconstructor mirrors the emitter's continuity convention:
 *   - The first `G1` in the program becomes the first point of the
 *     first segment, whose `kind` is `stroke` unless the first
 *     non-`G90` line is `M3` (in which case the first segment is a
 *     connector).
 *   - Each subsequent `G1` extends the currently open segment.
 *   - `M3` closes the current segment and opens a new connector
 *     segment whose first point is the last point of the closed
 *     segment.
 *   - `M5` closes the connector segment and opens a new stroke
 *     segment whose first point is the last point of the closed
 *     connector.
 *   - Empty segments produced by adjacent markers (e.g. `M3 M5` with
 *     no intervening `G1`) are dropped silently — there is nothing to
 *     emit on the wire for them anyway.
 *
 * Throws `GCodeError(kind: 'unbalanced-marker' | 'shape')` when the
 * input violates these rules (e.g. `M5` without a preceding `M3`,
 * `M3` while already in a connector run).
 *
 * `drawableSteps` is not encoded in the textual form; it is restored
 * to `{ w: 0, h: 0 }`. Callers that need the original drawable rectangle
 * should track it alongside the program, or use `fromGCode(toGCode(p))`
 * only for round-trip equivalence checks (where `drawableSteps` is
 * compared separately).
 */
export function fromGCode(prog: GCodeProgram): PlannedPath {
    const segments: PlannedSegment[] = [];
    let current: PlannedSegment | null = null;
    let kind: SegmentKind = 'stroke';

    const closeCurrent = (): { x: number; y: number } | null => {
        if (current === null) return null;
        const last =
            current.pointsSteps.length > 0
                ? current.pointsSteps[current.pointsSteps.length - 1]!
                : null;
        // Drop empty / single-point segments — they encode nothing
        // useful and would violate the planner invariant
        // `pointsSteps.length >= 2` if kept.
        if (current.pointsSteps.length >= 2) {
            segments.push(current);
        }
        current = null;
        return last;
    };

    for (let i = 0; i < prog.lines.length; i++) {
        const line = prog.lines[i]!;
        switch (line.op) {
            case 'G1': {
                if (current === null) {
                    current = { kind, pointsSteps: [] };
                }
                current.pointsSteps.push({ x: line.x, y: line.y });
                break;
            }
            case 'M3': {
                if (kind === 'connector') {
                    throw new GCodeError(
                        'unbalanced-marker',
                        'M3 encountered while already in a connector run',
                    );
                }
                const seam = closeCurrent();
                kind = 'connector';
                current = { kind, pointsSteps: [] };
                if (seam !== null) {
                    current.pointsSteps.push({ x: seam.x, y: seam.y });
                }
                break;
            }
            case 'M5': {
                if (kind !== 'connector') {
                    throw new GCodeError(
                        'unbalanced-marker',
                        'M5 encountered without a matching M3',
                    );
                }
                const seam = closeCurrent();
                kind = 'stroke';
                if (seam !== null) {
                    current = { kind, pointsSteps: [{ x: seam.x, y: seam.y }] };
                }
                break;
            }
            case 'G90':
            case 'G91':
            case 'M2':
            case 'comment':
                // Mode and end-of-program markers do not contribute
                // points; comments are pure annotation.
                break;
        }
    }

    if (kind === 'connector') {
        throw new GCodeError(
            'unbalanced-marker',
            'program ended while still in a connector run (missing M5)',
        );
    }

    closeCurrent();

    return {
        drawableSteps: { w: 0, h: 0 },
        segments,
    };
}
