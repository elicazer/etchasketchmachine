/**
 * Shared geometry, G-code AST, and wire-format data types for the
 * Etch-a-Sketch SPA.
 *
 * These shapes are the public contract between the path pipeline
 * (image / text / freehand → planner → G-code → Drawing_Commands)
 * and the WireClient.
 *
 * Shapes are intentionally small and JSON-serialisable so they can be
 * fed straight into property tests (fast-check) and snapshot tooling.
 *
 * @see Design §4.1 (geometry), §4.2 (G-code AST), §4.3 (wire format)
 * @see Requirements 5.2, 5.3, 6.3, 14.1
 */

// -----------------------------------------------------------------------------
// Geometry (§4.1)
// -----------------------------------------------------------------------------

/**
 * A 2-D point in floating-point space. Used while the path is still being
 * scaled, simplified, and stitched in the browser. Step-quantised points
 * appear later as the integer-valued `pointsSteps` on `PlannedSegment`.
 */
export type Point = { x: number; y: number };

/**
 * A connected sequence of points. Any polyline retained by the planner
 * has at least two points; single-point or empty polylines are dropped
 * upstream.
 */
export type Polyline = Point[];

/**
 * Distinguishes user-content motion from unavoidable inter-contour travel.
 * The Etch-a-Sketch stylus cannot lift, so connectors produce visible lines
 * on the physical drawing and are rendered with a distinct style in preview.
 *
 * @see Requirements 14.1, 14.4
 */
export type SegmentKind = 'stroke' | 'connector';

/**
 * One contiguous run of motion in the planned path, in integer motor-step
 * coordinates relative to home (0,0). Adjacent segments share an endpoint
 * so the whole `PlannedPath` is a single continuous stroke.
 *
 * Invariants (enforced by the planner, asserted by property tests):
 *   - `pointsSteps.length >= 2`
 *   - all coordinates are integers in `[0, drawableSteps.{w,h}]`
 *   - no zero-length sub-segments (no two consecutive identical points)
 */
export interface PlannedSegment {
    kind: SegmentKind;
    pointsSteps: { x: number; y: number }[];
}

/**
 * The full planned drawing as a single continuous stroke.
 *
 * Invariants:
 *   - `segments[i].pointsSteps.last == segments[i+1].pointsSteps.first`
 *     (segments are joined endpoint-to-endpoint, Req 14.1)
 *   - the final segment is `kind: 'connector'` and ends at `(0, 0)`
 *     (auto-return to home, Req 10.7, 14.7)
 */
export interface PlannedPath {
    /** Drawable area expressed in integer motor steps. */
    drawableSteps: { w: number; h: number };
    segments: PlannedSegment[];
}

// -----------------------------------------------------------------------------
// G-code AST (§4.2)
// -----------------------------------------------------------------------------

/**
 * Single line of the canonical G-code representation. Coordinates and feed
 * rate are integers in motor-step / steps-per-second units (no floats on
 * the wire). Connector runs are delimited by `M3`/`M5` markers so the
 * stroke/connector split survives a round-trip through the textual form.
 *
 * @see Requirements 5.1, 5.6, 14.6
 */
export type GCodeLine =
    | { op: 'G1'; x: number; y: number; f: number; kind: SegmentKind }
    | { op: 'G90' }
    | { op: 'G91' }
    | { op: 'M3' } // begin connector run
    | { op: 'M5' } // end connector run
    | { op: 'M2' } // end of program
    | { op: 'comment'; text: string };

/**
 * Whole G-code program. Units and origin are fixed by this system —
 * coordinates are integer motor steps measured from the home position.
 */
export interface GCodeProgram {
    units: 'steps';
    origin: 'home';
    lines: GCodeLine[];
}

// -----------------------------------------------------------------------------
// Drawing_Command wire format (§4.3)
// -----------------------------------------------------------------------------

/**
 * A single Drawing_Command as a structured object before/after binary
 * serialisation. The wire form is a fixed 16-byte little-endian payload;
 * see `web/src/codec/drawing_command.ts` (task 10.1) for the codec.
 *
 * Field ranges (validated by the firmware command parser, Req 6.7):
 *   - `seq`: u32, monotonic per session
 *   - `dxSteps`, `dySteps`: i16, range `[-32768, 32767]`
 *   - `feedSps`: u16, range `[100, 1000]`
 *   - `flags`: u16, only bits 0 (connector) and 1 (last-of-batch) defined;
 *     all other bits MUST be zero
 *
 * The `crc16` field, when present, holds the CRC-16/CCITT computed over
 * the canonical 14-byte prefix of the encoded payload. It is filled in by
 * the codec and re-validated on receipt.
 *
 * @see Design §4.3
 * @see Requirements 6.7, 7.2, 7.8
 */
export interface DrawingCommand {
    seq: number;
    dxSteps: number;
    dySteps: number;
    feedSps: number;
    flags: number;
    /** Set by the codec; reserved bytes on the wire are always zero. */
    crc16?: number;
}
