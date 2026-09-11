// Feature: unified-composer-canvas — performance benchmark harnesses.
//
// Two harnesses live in this file so a single test run reports both
// numbers side-by-side:
//
//   A) Translate-gesture loop (Req 11.1, 11.2)
//      Build a Scene of 10 items × 500 points (5 000 total points). Drive a
//      synthetic translate gesture: `beginGesture(id, 'move')`, then 200
//      sequential `updateTransform(id, { x, y })` calls (each simulates one
//      pointer-move event), then `endGesture()`. After every update we
//      read `store.composed.value` so the `composed` computed signal
//      materialises a fresh `Polyline[]` exactly once per pointer event,
//      satisfying Req 11.2 ("one composeScene call per pointer event").
//      Mean wall-clock per event MUST be ≤ 16 ms.
//
//   B) AnimationPlayback frame loop (Req 18.12)
//      Reuse the same flat 5 000-point composed `Polyline[]`. Simulate 60
//      frames of playback by calling `pointAtDistance` (the same internal
//      advance math `AnimationPlayback`'s rAF loop uses — see
//      `web/src/ui/composer/AnimationPlayback.tsx`) with monotonically
//      increasing path-distances spanning `[0, totalLength]`. Mean
//      wall-clock per frame MUST be ≤ 33 ms (≥ 30 fps).
//
// Skip behaviour:
//   The perf assertions are guarded behind `SKIP_PERF_BENCH=1` so CI
//   runners that don't expose `performance.now` reliably can opt out
//   without failing the suite. Local runs leave the env unset so the
//   harnesses execute and assert.
//
// _Requirements: 11.1, 11.2, 18.12_
//
// @see web/src/composer/scene_store.ts
// @see web/src/composer/compose.ts
// @see web/src/ui/composer/AnimationPlayback.tsx

import { describe, expect, it } from 'vitest';

import {
    createSceneStore,
    type AddItemSpec,
} from './scene_store';
import type { ScenePersistence } from './persistence';
import type { Scene } from './types';
import type { Polyline } from '../types';
import {
    pathLength,
    pointAtDistance,
} from '../ui/composer/AnimationPlayback';

// -----------------------------------------------------------------------------
// Skip gate — CI runners without a reliable high-resolution clock opt out.
// -----------------------------------------------------------------------------

/**
 * `true` when the harness should be skipped — either the runtime lacks a
 * reliable `performance.now` (e.g. some sandboxed CI environments) OR the
 * caller opted out via `SKIP_PERF_BENCH=1`. We touch `globalThis.process`
 * defensively so the test compiles and runs even where `process` is not in
 * the global type set (browsers, Cloudflare Workers, etc.).
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
// Helpers
// -----------------------------------------------------------------------------

function makeMemoryPersistence(initial: Scene | null = null): ScenePersistence {
    let stored: Scene | null = initial;
    return {
        load(): Scene | null {
            return stored;
        },
        save(s: Scene): void {
            stored = s;
        },
        clear(): void {
            stored = null;
        },
    };
}

/**
 * Build a `n`-point polyline shaped like a horizontally-translated sine
 * wave so each item contributes geometry that survives RDP simplification
 * and gives a non-zero path length to the animation harness.
 */
function buildPolyline(n: number, offset: number): Polyline {
    const out: Polyline = new Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / Math.max(1, n - 1);
        out[i] = {
            x: offset + t * 100,
            y: Math.sin(offset * 0.05 + t * Math.PI * 4) * 20,
        };
    }
    return out;
}

function imageSpec(content: Polyline[], filename: string): AddItemSpec {
    return {
        kind: 'image',
        content,
        source: { filename, sizeBytes: 4_096 },
    };
}

const ITEM_COUNT = 10;
const POINTS_PER_POLYLINE = 500;
// 10 × 500 = 5 000 points. The Req 11.1 benchmark scene size.
const TOTAL_POINTS = ITEM_COUNT * POINTS_PER_POLYLINE;

// -----------------------------------------------------------------------------
// Benchmarks
// -----------------------------------------------------------------------------

describe('Composer perf benchmarks', () => {
    // --- Harness A — Req 11.1, 11.2 -----------------------------------------
    benchIt(
        'translate-gesture loop: 200 pointer events × composeScene mean ≤ 16 ms (Req 11.1, 11.2)',
        () => {
            const store = createSceneStore({
                persistence: makeMemoryPersistence(),
            });

            // 10 items × 500 points = 5 000 total points (Req 11.1 scene size).
            const ids: string[] = [];
            for (let i = 0; i < ITEM_COUNT; i++) {
                ids.push(
                    store.addItem(
                        imageSpec(
                            [buildPolyline(POINTS_PER_POLYLINE, i * 10)],
                            `bench-${i}.png`,
                        ),
                    ),
                );
            }

            // Sanity: composed materialises with the expected polyline count
            // before we begin timing — anything else means the scene wasn't
            // built correctly and the benchmark would measure noise.
            expect(store.composed.value.length).toBe(ITEM_COUNT);
            expect(
                store.composed.value.reduce((acc, p) => acc + p.length, 0),
            ).toBe(TOTAL_POINTS);

            const targetId = ids[0]!;

            const N = 200;
            store.beginGesture(targetId, 'move');

            const t0 = performance.now();
            for (let i = 0; i < N; i++) {
                // Simulate a single pointer-move event: update the live
                // transform with a fresh `(x, y)` and force the `composed`
                // computed signal to materialise (Req 11.2 — one
                // composeScene call per pointer event).
                store.updateTransform(targetId, {
                    x: i * 0.5,
                    y: i * 0.25,
                });
                const composed = store.composed.value;
                if (composed.length === 0) {
                    throw new Error('composed went empty during gesture');
                }
            }
            const t1 = performance.now();
            store.endGesture();

            const elapsedMs = t1 - t0;
            const meanMsPerEvent = elapsedMs / N;
            // eslint-disable-next-line no-console
            console.log(
                `[perf] translate-gesture: ${N} events in ${elapsedMs.toFixed(2)} ms total, ` +
                `mean ${meanMsPerEvent.toFixed(3)} ms/event (cap 16 ms)`,
            );

            expect(meanMsPerEvent).toBeLessThanOrEqual(16);
        },
    );

    // --- Harness B — Req 18.12 ---------------------------------------------
    benchIt(
        'AnimationPlayback frame loop: 60 frames × pointAtDistance mean ≤ 33 ms (Req 18.12)',
        () => {
            // Same 10 × 500-point composed Polyline[] the gesture harness
            // exercises, built directly so the animation benchmark is
            // independent of the SceneStore.
            const composed: Polyline[] = new Array(ITEM_COUNT);
            for (let i = 0; i < ITEM_COUNT; i++) {
                composed[i] = buildPolyline(POINTS_PER_POLYLINE, i * 10);
            }

            const total = pathLength(composed);
            expect(total).toBeGreaterThan(0);

            const FRAMES = 60;

            const t0 = performance.now();
            for (let f = 0; f < FRAMES; f++) {
                // Walk monotonically from 0 → totalLength so each frame
                // searches further into the polyline list — the worst-case
                // shape of the indicator's per-frame cost.
                const s = (f / Math.max(1, FRAMES - 1)) * total;
                const p = pointAtDistance(composed, s);
                if (p === null) {
                    throw new Error('pointAtDistance returned null mid-bench');
                }
            }
            const t1 = performance.now();

            const elapsedMs = t1 - t0;
            const meanMsPerFrame = elapsedMs / FRAMES;
            // eslint-disable-next-line no-console
            console.log(
                `[perf] animation frame: ${FRAMES} frames in ${elapsedMs.toFixed(2)} ms total, ` +
                `mean ${meanMsPerFrame.toFixed(3)} ms/frame (cap 33 ms ≈ 30 fps)`,
            );

            expect(meanMsPerFrame).toBeLessThanOrEqual(33);
        },
    );
});
