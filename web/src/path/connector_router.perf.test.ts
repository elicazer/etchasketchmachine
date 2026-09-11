// Feature: hidden-connector-routing — performance harness (Req 8.1).
//
// PERFORMANCE TEST — long-running; excluded from fast watch runs.
//
// Goal (Req 8.1): routing connectors for a path of up to 1000 strokes MUST
// complete within 5 seconds. This harness builds a synthetic 1000-stroke
// drawing, plans it with connector hiding ENABLED on the envelope-fit branch
// (the only branch the router runs on), measures the wall-clock around the
// single `planWithReport` call, and asserts the 5 s ceiling.
//
// Why a routing time budget is set below 5 s:
//   Routing 1000 strokes is genuinely expensive — evaluating up to 32 candidate
//   routes per connector and classifying each against the accumulated ink. With
//   no budget the work runs for tens of seconds, so the router is designed to
//   stop routing once its `timeBudgetMs` is reached and emit straight
//   connectors for any unprocessed gaps, still returning a complete plan
//   (Req 8.4). That budget is the mechanism by which Req 8.1 is met. The budget
//   is checked BETWEEN connectors, and the deterministic stroke ordering
//   (nearest-neighbour + 2-opt) and incremental ink-index construction run
//   OUTSIDE the routing budget, so the end-to-end wall-clock is the routing
//   budget plus that overhead. We therefore set the routing budget to
//   `ROUTING_BUDGET_MS` (< 5 s) so the whole planning call — overhead included —
//   provably finishes under the Req 8.1 5-second ceiling, with headroom to
//   spare on slower CI hardware. The default budget is exercised by normal use;
//   the per-connector candidate cap and budget cutoff are covered by the
//   dedicated budget tests (task 12.4).
//
// Exclusion convention (mirrors `web/src/composer/perf.bench.test.ts`):
//   - The test name is tagged `[perf]` so it is easy to grep/filter out of a
//     fast watch loop (e.g. `vitest -t '\[perf\]'` to run only perf tests, or a
//     negative `-t` filter to skip them).
//   - The assertion is additionally guarded behind `SKIP_PERF_BENCH=1` so CI
//     runners without a reliable high-resolution clock can opt out without
//     failing the suite. Local runs leave the env unset so it executes.
//
// _Requirements: 8.1_
//
// @see web/src/path/planner.ts (PathPlanner.planWithReport, connectorHiding)
// @see web/src/path/connector_router.ts (routeConnector, DEFAULT_TIME_BUDGET_MS)

import { describe, expect, it } from 'vitest';

import { PathPlanner } from './planner';
import type { Polyline } from '../types';

// -----------------------------------------------------------------------------
// Skip gate — CI runners without a reliable high-resolution clock opt out.
// -----------------------------------------------------------------------------

/**
 * `true` when the harness should be skipped — either the runtime lacks a
 * reliable `performance.now` (e.g. some sandboxed CI environments) OR the
 * caller opted out via `SKIP_PERF_BENCH=1`. `globalThis.process` is touched
 * defensively so the test compiles and runs even where `process` is not in the
 * global type set.
 */
const SKIP_PERF_BENCH: boolean = (() => {
    if (
        typeof performance === 'undefined' ||
        typeof performance.now !== 'function'
    ) {
        return true;
    }
    const proc = (
        globalThis as {
            process?: { env?: Record<string, string | undefined> };
        }
    ).process;
    return proc?.env?.['SKIP_PERF_BENCH'] === '1';
})();

const benchIt = SKIP_PERF_BENCH ? it.skip : it;

// -----------------------------------------------------------------------------
// Synthetic 1000-stroke input
// -----------------------------------------------------------------------------

/** Number of strokes in the synthetic path (Req 8.1 budget is "up to 1000"). */
const STROKE_COUNT = 1000;
/** Strokes per row in the grid layout. */
const COLS = 40;
/** Step pitch between adjacent strokes on the grid (source space). */
const PITCH = 10;
/** Inclusive integer step envelope the drawing is fit into. */
const ENVELOPE = { x: 800, y: 600 };
/** The Req 8.1 ceiling, in milliseconds — the value the test asserts against. */
const BUDGET_MS = 5000;
/**
 * Routing time budget handed to the router (ms). Set below {@link BUDGET_MS} so
 * the end-to-end plan — routing budget plus the stroke-ordering and ink-index
 * overhead that runs outside the budget — finishes comfortably under the Req
 * 8.1 5-second ceiling, even on slower hardware. See the file header.
 */
const ROUTING_BUDGET_MS = 4000;

/**
 * Build a deterministic grid of `STROKE_COUNT` small multi-point strokes.
 *
 * Each stroke is a short L-shaped 3-point polyline. Laying them on a regular
 * grid produces many near-collinear neighbours, which is exactly the workload
 * the router has to classify against (snap-to-ink + overlap queries), so the
 * timing reflects real hiding work rather than a trivial empty-ink fast path.
 * The layout is fully deterministic (no randomness) so the harness is stable.
 */
function buildSyntheticStrokes(): Polyline[] {
    const polylines: Polyline[] = [];
    for (let i = 0; i < STROKE_COUNT; i++) {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x0 = col * PITCH;
        const y0 = row * PITCH;
        polylines.push([
            { x: x0, y: y0 },
            { x: x0 + PITCH - 2, y: y0 },
            { x: x0 + PITCH - 2, y: y0 + PITCH - 6 },
        ]);
    }
    return polylines;
}

// -----------------------------------------------------------------------------
// Harness — Req 8.1
// -----------------------------------------------------------------------------

describe('Connector router perf [perf]', () => {
    benchIt(
        '[perf] routes a 1000-stroke path with hiding enabled in under 5 s',
        () => {
            const planner = new PathPlanner();
            const polylines = buildSyntheticStrokes();
            expect(polylines).toHaveLength(STROKE_COUNT);

            const t0 = performance.now();
            const planned = planner.planWithReport(
                { polylines },
                {
                    envelopeSteps: ENVELOPE,
                    connectorHiding: true,
                    routerOptions: { timeBudgetMs: ROUTING_BUDGET_MS },
                },
            );
            const t1 = performance.now();

            const elapsedMs = t1 - t0;

            // eslint-disable-next-line no-console
            console.log(
                `[perf] connector-router: ${STROKE_COUNT} strokes routed in ` +
                `${elapsedMs.toFixed(1)} ms (ceiling ${BUDGET_MS} ms, ` +
                `routing budget ${ROUTING_BUDGET_MS} ms); ` +
                `${planned.connectorHiding.connectorCount} connectors, ` +
                `hidden=${planned.connectorHiding.totalHiddenTravel} ` +
                `exposed=${planned.connectorHiding.totalExposedTravel}`,
            );

            // The plan must be complete and the report aggregated: one connector
            // per inter-stroke gap, and the three classification counts sum to
            // the connector total (a complete plan was returned, Req 8.4).
            expect(planned.segments.length).toBeGreaterThan(0);
            const report = planned.connectorHiding;
            expect(report.connectorCount).toBeGreaterThan(0);
            expect(
                report.fullyHiddenCount +
                report.partiallyHiddenCount +
                report.notHiddenCount,
            ).toBe(report.connectorCount);

            // Req 8.1: the whole 1000-stroke hiding plan completes within 5 s.
            expect(elapsedMs).toBeLessThan(BUDGET_MS);
        },
    );
});
