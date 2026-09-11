/**
 * `machine_sim` — a pure backlash simulator that turns the IDEAL planned path
 * into the path the PHYSICAL Etch-a-Sketch actually traces.
 *
 * ## Why this exists
 *
 * The animated {@link Preview} renders the planner's ideal geometry, so it
 * always looks cleaner than the real device. The real device loses motion on
 * every direction reversal: gear lash plus play in the knobs means the stylus
 * stalls for some integer number of motor steps after each reversal before it
 * starts moving again (the same slack the firmware's `BacklashCompensator`
 * tries to pre-consume — see `firmware/src/backlash/backlash_compensator.h`).
 * When that slack is mis-calibrated or simply present, fine reversal-heavy
 * detail collapses and the drawing drifts — exactly the gap between the
 * on-screen preview and the disappointing physical result.
 *
 * This module models that slack as a classic per-axis backlash deadband and
 * replays the planned path through it, producing a {@link PlannedPath} of the
 * ACTUAL stylus positions. Feeding that back into the same {@link drawScene}
 * renderer gives a WYSIWYG "machine view": dial in your measured backlash and
 * the preview shows the real-device distortion before you ever send it.
 *
 * The model is intentionally simple and deterministic (no randomness): a per-
 * axis deadband of width `slack`. Moving in the same direction always moves the
 * stylus 1:1; reversing first eats up to `slack` commanded steps with NO stylus
 * motion (closing the gear gap), and only the remainder moves the stylus.
 */

import type { PlannedPath, PlannedSegment, Point } from '../types';

/** Per-axis uncompensated backlash slack, in integer motor steps. */
export interface BacklashSlack {
    x: number;
    y: number;
}

/**
 * Mutable per-axis deadband state. `lash` is how many steps of the `slack`-wide
 * gap are currently closed toward the POSITIVE direction (0 == fully engaged on
 * the negative side, `slack` == fully engaged on the positive side). `started`
 * gates the first move so it does not spuriously lose slack (see below).
 */
interface AxisState {
    lash: number;
    started: boolean;
}

/**
 * Apply a commanded delta `d` on one axis through its backlash deadband,
 * returning the ACTUAL stylus delta (which can be 0 while the gear gap closes).
 * Mutates `st`. A non-positive `slack` is a pass-through (no backlash).
 *
 * The FIRST nonzero move on an axis is treated as exact: the gear is assumed to
 * already be engaged on the side of first travel, so backlash only ever costs
 * on a subsequent direction REVERSAL — which is what the physical device does.
 */
function applyAxis(d: number, slack: number, st: AxisState): number {
    if (slack <= 0 || d === 0) return d;
    if (!st.started) {
        st.started = true;
        st.lash = d > 0 ? slack : 0; // engage on the side of first travel
        return d;
    }
    if (d > 0) {
        const take = Math.min(d, slack - st.lash); // close the gap: no motion
        st.lash += take;
        return d - take;
    }
    // d < 0
    const take = Math.min(-d, st.lash);
    st.lash -= take;
    return d + take;
}

/**
 * Replay an ideal {@link PlannedPath} through a per-axis backlash deadband and
 * return the path of ACTUAL stylus positions.
 *
 * The returned path mirrors the input's segment structure (same count, same
 * `kind`s, same point counts) so it drops straight into {@link drawScene}; only
 * the coordinates differ, shifted by the accumulated lash. Pure and
 * deterministic: identical input + slack yields identical output.
 *
 * The stylus is assumed to start coincident with the path's first commanded
 * point (the planner starts at home `(0,0)`), with both axes engaged on the
 * negative side (`lash = 0`) as they would be right after a home/reset move.
 */
export function simulateStylusTrace(
    path: PlannedPath,
    slack: BacklashSlack,
): PlannedPath {
    const sx: AxisState = { lash: 0, started: false };
    const sy: AxisState = { lash: 0, started: false };
    const slkX = Math.max(0, Math.floor(slack.x));
    const slkY = Math.max(0, Math.floor(slack.y));

    let cmd: Point | null = null; // last commanded point
    let act: Point = { x: 0, y: 0 }; // current actual stylus point

    const segments: PlannedSegment[] = path.segments.map((seg) => {
        const out: Point[] = [];
        for (const p of seg.pointsSteps) {
            if (cmd === null) {
                cmd = { x: p.x, y: p.y };
                act = { x: p.x, y: p.y };
                out.push({ x: act.x, y: act.y });
                continue;
            }
            const adx = applyAxis(p.x - cmd.x, slkX, sx);
            const ady = applyAxis(p.y - cmd.y, slkY, sy);
            act = { x: act.x + adx, y: act.y + ady };
            cmd = { x: p.x, y: p.y };
            out.push({ x: act.x, y: act.y });
        }
        return { kind: seg.kind, pointsSteps: out };
    });

    return { drawableSteps: path.drawableSteps, segments };
}

/**
 * Total length of all `connector` segments in the machine's Chebyshev step
 * metric — the pen-up travel a no-lift Etch-a-Sketch is forced to draw as
 * visible ink. This is the "exposed extra lines" cost; lower is cleaner.
 */
export function connectorTravelSteps(path: PlannedPath): number {
    let total = 0;
    for (const seg of path.segments) {
        if (seg.kind !== 'connector') continue;
        const pts = seg.pointsSteps;
        for (let k = 1; k < pts.length; k++) {
            const a = pts[k - 1]!;
            const b = pts[k]!;
            total += Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        }
    }
    return total;
}
