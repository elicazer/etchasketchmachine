/**
 * `Path_Planner` — the deterministic core that composes the already-built
 * pure path-pipeline stages into a single continuous, machine-ready plan.
 *
 * This module owns ORCHESTRATION only. Every individual transform lives in
 * its own well-tested module and is reused verbatim:
 *
 *   1. Scale + clamp + step-convert  →  {@link scaleAndClamp} (`scale.ts`)
 *   2. RDP simplify                  →  {@link rdpSimplify}   (`rdp.ts`)
 *   3. NN stitch + connectors        →  {@link stitchPolylines} (`stitch.ts`)
 *   4. Auto-return to home           →  {@link appendReturnToHome} (`stitch.ts`)
 *   5. G-code emit / parse           →  {@link toGCodeProgram} / {@link fromGCodeProgram} (`gcode.ts`)
 *   6. Drawing_Command emit          →  {@link splitMotion}    (`drawing_command.ts`)
 *
 * The pipeline order matches Design §3.1.4 exactly. Note that
 * {@link scaleAndClamp} fuses steps 1 and 2 of the design (mm clamp and
 * mm→step conversion) and also applies the home offset, so the planner's
 * RDP tolerance ε is measured in motor steps as Requirement 5.4 specifies.
 *
 * ## Coordinate frame and the home offset
 *
 * `plan()` bakes `homeOffsetSteps` into every coordinate of the
 * `PlannedPath`, so the path is expressed in ABSOLUTE machine-step
 * coordinates and the stitch/auto-return both pivot around the home point
 * (Req 10.10). With the default home `(0, 0)` the path is therefore
 * home-relative: coordinates lie in `[0, drawableSteps]`, the stroke order
 * starts from `(0, 0)`, and the final auto-return connector ends at
 * `(0, 0)` — the invariants documented on {@link PlannedPath}.
 *
 * `toCommands(path, home)` reverses the offset: it threads the pen from
 * `home` and emits per-vertex DELTAS, so the running home-relative position
 * reconstructed from the command stream equals `plannerOutput - home`
 * (Property 3). Deltas are inherently offset-invariant, which is exactly
 * why the same command list draws the same shape from any declared home.
 *
 * @see Design §3.1.4 (planner), §4.2 (G-code), §4.3 (Drawing_Command)
 * @see Requirements 5.1–5.5, 10.7, 10.10, 14.1–14.3, 14.5–14.7
 */

import {
    DRAWABLE_MM,
    DRAWING_COMMAND_FLAGS,
    FEED_SPS_MAX,
    FULL_STEPS_PER_KNOB_REV,
    DEFAULT_MM_PER_REV_X,
    DEFAULT_MM_PER_REV_Y,
} from '../constants';
import {
    splitMotion,
} from '../codec/drawing_command';
import {
    toGCode as toGCodeProgram,
    fromGCode as fromGCodeProgram,
} from '../gcode/gcode';
import type {
    DrawingCommand,
    GCodeProgram,
    PlannedPath,
    PlannedSegment,
    Point,
    Polyline,
    SegmentKind,
} from '../types';
import { rdpSimplify } from './rdp';
import { fitPolylinesToEnvelope, scaleAndClamp } from './scale';
import {
    appendReturnToHome,
    appendEdgeReturnToHome,
    stitchPolylines,
    stitchPolylinesWithReport,
} from './stitch';
import type {
    ConnectorResult,
    RouterOptions,
} from './connector_router';

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

/**
 * The raw geometry handed to {@link PathPlanner.plan}.
 *
 * `polylines` are in millimetre space (the same 152 × 105 mm drawable area
 * the canvas previews), as produced by the Image_Processor, Text_Renderer,
 * or Freehand_Capture modules. Each polyline becomes a drawable `stroke`;
 * the planner synthesises the `connector` segments that join them.
 */
export interface PathInput {
    /** Source polylines in mm-space. Polylines with < 2 points are dropped during stitch. */
    polylines: Polyline[];
    /**
     * Optional, advisory per-polyline kind hints. Reserved for future use:
     * the current pipeline classifies every input polyline as a `stroke` and
     * derives `connector` segments structurally (travel between strokes and
     * the auto-return), so this field is not consumed today. It exists so
     * callers can attach intent without a breaking signature change.
     */
    kinds?: SegmentKind[];
}

/**
 * Tuning knobs for {@link PathPlanner.plan}. Every field is optional and
 * falls back to a documented default.
 */
export interface PlanOptions {
    /**
     * RDP simplification tolerance in motor steps, in `[0.1, 5.0]`
     * (Req 5.4). Defaults to {@link DEFAULT_EPSILON}. Passed straight to
     * {@link rdpSimplify}, which range-validates it.
     */
    epsilon?: number;
    /** Calibrated mm per knob revolution, X axis. Defaults to {@link DEFAULT_MM_PER_REV_X}. */
    mmPerRevX?: number;
    /** Calibrated mm per knob revolution, Y axis. Defaults to {@link DEFAULT_MM_PER_REV_Y}. */
    mmPerRevY?: number;
    /**
     * Home position in motor steps, baked into every output coordinate so the
     * plan is expressed relative to a non-zero home (Req 10.10). Defaults to
     * `{ x: 0, y: 0 }`. Pass the SAME value to {@link PathPlanner.toCommands}
     * so the emitted deltas reconstruct home-relative positions.
     */
    homeOffsetSteps?: { x: number; y: number };
    /**
     * Feed rate in steps-per-second used by downstream emitters
     * (`toGCode` / `toCommands`). `plan()` does not embed a feed rate into the
     * geometric `PlannedPath`; this is carried for callers that thread one
     * value through the whole pipeline. Defaults to {@link FEED_SPS_MAX}.
     */
    feedSps?: number;
    /**
     * When set, fit the drawing into this measured Step_Envelope (step space)
     * instead of the mm gear-math path. The per-polyline stage uses
     * {@link fitPolylinesToEnvelope} (already integer step space) and skips
     * {@link scaleAndClamp} entirely, so `mmPerRevX/Y` and `DRAWABLE_MM` are
     * ignored for scaling; RDP still runs (ε in steps) and the resulting
     * `PlannedPath.drawableSteps` is the envelope itself.
     * @see Requirements 3.1, 3.2
     */
    envelopeSteps?: { x: number; y: number };
    /**
     * Fraction of the envelope to fill when fitting into {@link envelopeSteps},
     * in `(0, 1]`. 1.0 fills to the edges (the default); smaller values draw
     * the geometry proportionally smaller and centered. Surfaced as a "Scale"
     * control in the UI. Forwarded to {@link fitPolylinesToEnvelope} as its
     * `margin`; ignored on the mm gear-math path. Defaults to 1.0.
     */
    fillFraction?: number;
    /**
     * Flip the Y axis when fitting into {@link envelopeSteps} (screen-space
     * Y-down → envelope Y-up). Forwarded to {@link fitPolylinesToEnvelope};
     * ignored on the mm gear-math path (where the caller flips upstream via
     * `fitPolylinesToDrawable`). Defaults to false.
     */
    flipY?: boolean;
    /**
     * Whether to append the auto-return-to-home connector as the final segment
     * (Req 10.7, 14.7). Defaults to true to preserve existing behavior. Set
     * false to leave the stylus where the drawing ends instead of drawing a
     * connector line back to (0,0) — desirable on an Etch-a-Sketch where the
     * return travel is itself a visible line across the finished art and a
     * large open-loop move toward the mechanical corner.
     */
    returnToHome?: boolean;
    /**
     * When returning home in the envelope-fit branch, route via the envelope
     * EDGES (out to the nearest edge, then hug the perimeter to the home
     * corner) instead of cutting a straight diagonal across the finished
     * drawing. Only meaningful when {@link returnToHome} is true and
     * {@link envelopeSteps} is set. Defaults to false (straight-line return).
     */
    edgeReturn?: boolean;
    /**
     * Opt-in connector hiding (Req 7.3). Default `false` → the planned path is
     * byte-for-byte identical to today (Req 7.1, 7.2). When set, inter-stroke
     * connectors are routed over already-drawn ink and envelope edges to
     * minimize visible (Exposed) travel. This flag is fully independent of
     * {@link twoOpt} and every other plan option (Req 7.3): routing runs only
     * AFTER the final stroke order/orientation are decided (Req 7.5, 7.6), so
     * the `stroke` segments are unchanged either way.
     *
     * Only meaningful on the envelope-fit branch ({@link envelopeSteps} set):
     * the router needs the Step_Envelope to route over perimeter edges and to
     * enforce containment. On the mm gear-math branch the flag is ignored and
     * the off-mode accounting is reported.
     */
    connectorHiding?: boolean;
    /**
     * Router tuning forwarded to the stitcher/router when
     * {@link connectorHiding} is set (Req 8). Ignored otherwise.
     */
    routerOptions?: RouterOptions;
}

/**
 * Aggregated connector-hiding observability, surfaced from
 * {@link PathPlanner.planWithReport} (Req 9).
 *
 * The report aggregates the inter-stroke `connector` segments woven by the
 * stitcher/router. All travel figures are in the machine's Chebyshev step
 * metric (Req 9.4), and the three classification counts always sum to
 * {@link ConnectorHidingReport.connectorCount} (Req 9.3). The
 * auto-return-to-home connector appended by the unchanged home-return mechanism
 * ({@link appendReturnToHome} / {@link appendEdgeReturnToHome}) is not part of
 * this report.
 */
export interface ConnectorHidingReport {
    /** Σ per-connector Hidden_Travel over all connectors (Chebyshev). Req 9.1. */
    totalHiddenTravel: number;
    /** Σ per-connector Exposed_Travel over all connectors (Chebyshev). Req 9.1. */
    totalExposedTravel: number;
    /** Connectors whose Exposed_Travel == 0 (Req 9.2, 9.3). */
    fullyHiddenCount: number;
    /** Connectors with both Hidden_Travel > 0 and Exposed_Travel > 0 (Req 9.2, 9.3). */
    partiallyHiddenCount: number;
    /** Connectors whose Hidden_Travel == 0 (Req 9.2, 9.3). */
    notHiddenCount: number;
    /** Total connectors aggregated; == sum of the three counts (Req 9.3). */
    connectorCount: number;
}

/** Default RDP tolerance (steps) when {@link PlanOptions.epsilon} is omitted. */
export const DEFAULT_EPSILON = 1.0;

/**
 * The straight-fallback {@link ConnectorResult} accounting for a connector
 * segment when connector hiding is off (Req 9.5): the segment's full Chebyshev
 * length is charged as Exposed_Travel, Hidden_Travel is 0, and it is classified
 * as not hidden. Pure function of the segment.
 */
function offModeConnectorResult(seg: PlannedSegment): ConnectorResult {
    let len = 0;
    const pts = seg.pointsSteps;
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        len += Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    return {
        segment: seg,
        hiddenTravel: 0,
        exposedTravel: len,
        totalTravel: len,
        fellBack: true,
        rejected: false,
    };
}

/**
 * Off-mode accounting (Req 9.5): one {@link ConnectorResult} per `connector`
 * segment in `stitched`, each fully Exposed. `stitched` is the stitched path
 * BEFORE the auto-return-to-home connector is appended, so the report covers
 * exactly the woven inter-stroke connectors.
 */
function offModeConnectorResults(stitched: PlannedSegment[]): ConnectorResult[] {
    const results: ConnectorResult[] = [];
    for (const seg of stitched) {
        if (seg.kind === 'connector') results.push(offModeConnectorResult(seg));
    }
    return results;
}

/**
 * Fold per-connector {@link ConnectorResult}s into a {@link ConnectorHidingReport}
 * (Req 9.1–9.4). Sums Hidden/Exposed travel and classifies each connector as
 * fully hidden (exposed == 0), not hidden (hidden == 0), or partially hidden
 * (both > 0); the three counts always sum to the connector total.
 */
function aggregateConnectorReport(
    connectors: ConnectorResult[],
): ConnectorHidingReport {
    let totalHiddenTravel = 0;
    let totalExposedTravel = 0;
    let fullyHiddenCount = 0;
    let partiallyHiddenCount = 0;
    let notHiddenCount = 0;

    for (const c of connectors) {
        totalHiddenTravel += c.hiddenTravel;
        totalExposedTravel += c.exposedTravel;
        if (c.exposedTravel === 0) {
            fullyHiddenCount += 1;
        } else if (c.hiddenTravel === 0) {
            notHiddenCount += 1;
        } else {
            partiallyHiddenCount += 1;
        }
    }

    return {
        totalHiddenTravel,
        totalExposedTravel,
        fullyHiddenCount,
        partiallyHiddenCount,
        notHiddenCount,
        connectorCount: connectors.length,
    };
}

// -----------------------------------------------------------------------------
// Planner
// -----------------------------------------------------------------------------

/**
 * Deterministic path planner implementing the Design §3.1.4 interface.
 *
 * Stateless apart from a default feed rate used by {@link toGCode} and
 * {@link toCommands} when the caller does not override it. The same instance
 * can be reused across drawings.
 */
export class PathPlanner {
    private readonly defaultFeedSps: number;

    /**
     * @param opts.feedSps Default feed rate (sps) for `toGCode` / `toCommands`.
     *                     Defaults to {@link FEED_SPS_MAX}.
     */
    constructor(opts: { feedSps?: number } = {}) {
        this.defaultFeedSps = opts.feedSps ?? FEED_SPS_MAX;
    }

    /**
     * Run the full pipeline: scale/clamp → step-convert → RDP simplify →
     * NN stitch (with connectors) → auto-return to home.
     *
     * @returns A single continuous `PlannedPath` in absolute machine steps.
     *          With the default home `(0, 0)` the result satisfies the
     *          {@link PlannedPath} invariants: contiguous segments, every
     *          coordinate an integer within `drawableSteps`, and a final
     *          `connector` segment ending at `(0, 0)`.
     */
    plan(input: PathInput, opts: PlanOptions = {}): PlannedPath {
        // The path is the source of truth; the per-connector report is computed
        // alongside but discarded here so `plan()` stays byte-for-byte identical
        // to before this feature existed when `connectorHiding` is off (Req 7.1).
        return this.planInternal(input, opts).path;
    }

    /**
     * Like {@link plan}, but also returns the aggregated
     * {@link ConnectorHidingReport} for connector-travel observability (Req 9).
     *
     * The returned object is the same `PlannedPath` {@link plan} produces, with
     * an added `connectorHiding` field. When `connectorHiding` is off the report
     * still reflects the off-mode accounting — every connector's full Chebyshev
     * length is Exposed_Travel, `totalHiddenTravel == 0`, and every connector is
     * classified not hidden (Req 9.5).
     */
    planWithReport(
        input: PathInput,
        opts: PlanOptions = {},
    ): PlannedPath & { connectorHiding: ConnectorHidingReport } {
        const { path, connectors } = this.planInternal(input, opts);
        return { ...path, connectorHiding: aggregateConnectorReport(connectors) };
    }

    /**
     * Shared implementation behind {@link plan} and {@link planWithReport}.
     * Produces the `PlannedPath` and the per-connector {@link ConnectorResult}
     * list. The path geometry is identical whether or not the caller asks for
     * the report, and is byte-for-byte unchanged from the pre-feature behavior
     * whenever `connectorHiding` is not set (Req 7.1, 7.2).
     */
    private planInternal(
        input: PathInput,
        opts: PlanOptions,
    ): { path: PlannedPath; connectors: ConnectorResult[] } {
        const mmPerRevX = opts.mmPerRevX ?? DEFAULT_MM_PER_REV_X;
        const mmPerRevY = opts.mmPerRevY ?? DEFAULT_MM_PER_REV_Y;
        const epsilon = opts.epsilon ?? DEFAULT_EPSILON;
        const home = opts.homeOffsetSteps ?? { x: 0, y: 0 };
        const returnToHome = opts.returnToHome ?? true;

        // Envelope-fit branch (Req 3.1, 3.2): when a measured Step_Envelope is
        // supplied we fit directly into step space and bypass the mm gear-math
        // entirely — no mmPerRev, no DRAWABLE_MM, no scaleAndClamp. The fitted
        // polylines are already integer step coordinates, so RDP (ε in steps)
        // runs on them as-is and drawableSteps is the envelope itself.
        if (opts.envelopeSteps) {
            const env = opts.envelopeSteps;
            const fitted = fitPolylinesToEnvelope(input.polylines, env, {
                flipY: opts.flipY ?? false,
                ...(opts.fillFraction !== undefined
                    ? { margin: opts.fillFraction }
                    : {}),
            });
            const simplified = fitted.map((poly) => rdpSimplify(poly, epsilon));

            // Connector hiding is opt-in (Req 7.1–7.3) and only meaningful here,
            // where the Step_Envelope is available for edge routing/containment.
            // When off, run the original straight-connector stitch verbatim so
            // the output is byte-for-byte identical (Req 7.2); the off-mode
            // report is derived from the woven straight connectors (Req 9.5).
            let stitched: PlannedSegment[];
            let connectors: ConnectorResult[];
            if (opts.connectorHiding) {
                const woven = stitchPolylinesWithReport(simplified, {
                    start: home,
                    twoOpt: true,
                    connectorHiding: true,
                    env,
                    ...(opts.routerOptions !== undefined
                        ? { routerOptions: opts.routerOptions }
                        : {}),
                });
                stitched = woven.segments;
                connectors = woven.connectors;
            } else {
                stitched = stitchPolylines(simplified, { start: home, twoOpt: true });
                connectors = offModeConnectorResults(stitched);
            }

            // The return-to-home connector is appended by the unchanged
            // home-return mechanism and is not part of the hiding report.
            const segments = !returnToHome
                ? stitched
                : opts.edgeReturn
                    ? appendEdgeReturnToHome(stitched, env, home)
                    : appendReturnToHome(stitched, home);

            return {
                path: {
                    drawableSteps: { w: env.x, h: env.y },
                    segments,
                },
                connectors,
            };
        }

        // 1+2. Scale into mm, clamp to the drawable area, convert to integer
        //      motor steps, and apply the home offset — all in scaleAndClamp.
        // 3.   Simplify each stepped polyline with RDP (ε in motor steps).
        const simplified: Polyline[] = input.polylines.map((poly) => {
            const stepped = scaleAndClamp(poly, {
                mmPerRevX,
                mmPerRevY,
                homeOffsetSteps: home,
            });
            return rdpSimplify(stepped, epsilon);
        });

        // 4. Order strokes nearest-neighbor from home, refine with a 2-opt
        //    travel-reduction pass (minimizes Chebyshev connector travel — the
        //    visible diagonal "connector" ink on a no-pen-lift Etch-a-Sketch),
        //    and weave connectors, yielding one contiguous PlannedSegment[].
        // Connector hiding is not supported on the mm gear-math branch (no
        // Step_Envelope to route over), so the off-mode report is always used.
        const stitched = stitchPolylines(simplified, { start: home, twoOpt: true });

        // 5. Append the auto-return connector back to home (Req 10.7, 14.7),
        //    unless the caller opted out via returnToHome:false.
        const segments = returnToHome
            ? appendReturnToHome(stitched, home)
            : stitched;

        return {
            path: {
                drawableSteps: {
                    w: Math.round((DRAWABLE_MM.w * FULL_STEPS_PER_KNOB_REV) / mmPerRevX),
                    h: Math.round((DRAWABLE_MM.h * FULL_STEPS_PER_KNOB_REV) / mmPerRevY),
                },
                segments,
            },
            connectors: offModeConnectorResults(stitched),
        };
    }

    /**
     * Emit the canonical G-code program for a planned path. Delegates to
     * `gcode.ts`; the feed rate defaults to the planner's configured feed.
     */
    toGCode(path: PlannedPath): GCodeProgram {
        return toGCodeProgram(path, { feedSps: this.defaultFeedSps });
    }

    /**
     * Reconstruct a planned path from a parsed G-code program. Delegates to
     * `gcode.ts`. Note that `drawableSteps` is not carried in the textual
     * form and is restored to `{ w: 0, h: 0 }` (see `fromGCode`).
     */
    fromGCode(prog: GCodeProgram): PlannedPath {
        return fromGCodeProgram(prog);
    }

    /**
     * Convert a planned path into a flat `DrawingCommand[]` ready for the
     * WireClient.
     *
     * Walks the continuous path vertex by vertex, starting the pen at
     * `home`, and emits one logical motion per inter-vertex delta. Each
     * motion is run through {@link splitMotion} so deltas exceeding the i16
     * wire limit fan out into several consecutive commands whose
     * concatenation reproduces the motion exactly (Req 7.8). Sequence
     * numbers are monotonic across the entire program. Connector motions
     * carry the `CONNECTOR` flag; the final command of the whole program
     * carries `LAST_OF_BATCH`.
     *
     * Zero-length motions (including the initial `home → firstPoint` hop when
     * the path already starts at home) are skipped — they would encode no
     * motion and violate the segment invariants.
     *
     * @param path    The planned path (typically from {@link plan}).
     * @param home    Pen position before the first command, in the same step
     *                frame as `path`. Pass the `homeOffsetSteps` used in
     *                `plan` so the reconstructed positions are home-relative.
     * @param feedSps Feed rate (sps) stamped on every command. Defaults to
     *                the planner's configured feed.
     */
    toCommands(
        path: PlannedPath,
        home: { x: number; y: number },
        feedSps: number = this.defaultFeedSps,
    ): DrawingCommand[] {
        const { CONNECTOR, LAST_OF_BATCH } = DRAWING_COMMAND_FLAGS;

        const commands: DrawingCommand[] = [];
        let prev: Point = { x: home.x, y: home.y };
        let seq = 0;

        for (let i = 0; i < path.segments.length; i++) {
            const seg = path.segments[i]!;
            const isConnector = seg.kind === 'connector';
            const baseFlags = isConnector ? CONNECTOR : 0;

            // Adjacent segments share their seam vertex (seg[i].last ==
            // seg[i+1].first), so for every segment after the first the
            // shared first point is already the current pen position. Skip
            // it to avoid emitting a duplicate zero-length motion.
            const startIdx = i === 0 ? 0 : 1;
            for (let j = startIdx; j < seg.pointsSteps.length; j++) {
                const v = seg.pointsSteps[j]!;
                const dx = v.x - prev.x;
                const dy = v.y - prev.y;
                prev = v;
                if (dx === 0 && dy === 0) continue;

                const sub = splitMotion(seq, dx, dy, feedSps, baseFlags);
                seq += sub.length;
                for (const c of sub) commands.push(c);
            }
        }

        // Mark the final command of the whole program as the batch terminator.
        if (commands.length > 0) {
            const last = commands[commands.length - 1]!;
            last.flags |= LAST_OF_BATCH;
        }

        return commands;
    }

    /**
     * Headline drawing-time estimate in milliseconds (Req 14.5): total ISR
     * steps divided by feed rate.
     *
     * Per-segment step count uses the Bresenham step count
     * `max(|dx|, |dy|)` for each inter-vertex move — the exact number of
     * timer-ISR steps the firmware emits for that move — summed over every
     * segment (strokes and connectors alike, since connector travel is real
     * motion). The finer per-step ramp integration belongs to the preview
     * timing path ({@link import('./ramp')}); this is the simple
     * `total_steps / feed_sps` model.
     *
     * @throws `RangeError` if `feedSps` is not a positive finite number.
     */
    estimateMillis(path: PlannedPath, feedSps: number): number {
        if (!Number.isFinite(feedSps) || feedSps <= 0) {
            throw new RangeError(
                `estimateMillis: feedSps must be a positive finite number, got ${feedSps}`,
            );
        }

        return (totalStepCount(path) * 1000) / feedSps;
    }
}

/**
 * Total ISR-step count of a planned path: `Σ max(|dx|, |dy|)` over every
 * inter-vertex move in every segment. Exposed for the UI's "total path
 * length in steps" readout (Req 8.3, 14.5) and reused by
 * {@link PathPlanner.estimateMillis}.
 */
export function totalStepCount(path: PlannedPath): number {
    let total = 0;
    for (const seg of path.segments) {
        const pts = seg.pointsSteps;
        for (let k = 0; k < pts.length - 1; k++) {
            const a = pts[k]!;
            const b = pts[k + 1]!;
            total += Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        }
    }
    return total;
}
