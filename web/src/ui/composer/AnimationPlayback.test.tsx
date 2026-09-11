/**
 * Tests for the on-canvas preview playback: the {@link usePlayback} engine
 * and the slim {@link AnimationPlayback} transport that renders it.
 *
 * ## What changed (unified-composer-canvas redesign)
 *
 * The old `AnimationPlayback` panel owned the rAF engine AND rendered a
 * CSS-hidden SVG indicator overlay docked beside the canvas. The redesign
 * splits that into:
 *
 *   - {@link usePlayback} — the pure playback engine (state machine, rAF
 *     loop, dual-readout derivations, auto-stop). The moving stylus is now
 *     exposed as `indicatorPoint` (a plain `Point | null`) and rendered ON
 *     the main {@link ComposerCanvas}, not here.
 *   - {@link AnimationPlayback} — a presentational transport bar
 *     (Play / Pause / Stop + speed slider + one dual-readout line) driven by
 *     a {@link UsePlaybackResult} the host supplies.
 *
 * These tests drive a small `Harness` component that wires `usePlayback` to
 * the transport exactly as `App.tsx` does, and additionally exposes the
 * engine's `indicatorPoint` / `revealFraction` outputs via hidden testid
 * spans so the determinism / dual-readout properties can be asserted
 * directly against the engine's outputs.
 *
 * Test seam: the engine drives its animation via `requestAnimationFrame` and
 * integrates frame-to-frame elapsed time. We replace `rAF` /
 * `cancelAnimationFrame` with a deterministic manual queue so the suite can
 * advance simulated time by invoking the scheduled callback with an explicit
 * timestamp.
 *
 * @see web/src/ui/composer/use_playback.ts
 * @see web/src/ui/composer/AnimationPlayback.tsx
 * @see Requirements 18.2, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11,
 *      18.13, 18.14
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { signal, type Signal } from '@preact/signals';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
    AnimationPlayback,
    SPEED_MAX,
    SPEED_MIN,
    clampSpeed,
    formatDuration,
    pathLength,
    pointAtDistance,
    usePlayback,
} from './AnimationPlayback';
import type { Polyline } from '../../types';

// -----------------------------------------------------------------------------
// requestAnimationFrame harness
// -----------------------------------------------------------------------------

let rafMap: Map<number, FrameRequestCallback>;
let nextRafId: number;
let container: HTMLDivElement;

/**
 * Default `baseUnitsPerSecond` baked into the engine. Mirrored here so the
 * analytic predictions in the property tests are independent of the source's
 * internal constant — but consistent with it.
 */
const BASE_UPS = 200;

beforeEach(() => {
    rafMap = new Map();
    nextRafId = 1;
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal(
        'requestAnimationFrame',
        (cb: FrameRequestCallback): number => {
            const id = nextRafId++;
            rafMap.set(id, cb);
            return id;
        },
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
        rafMap.delete(id);
    });
});

afterEach(() => {
    if (container.isConnected) {
        act(() => render(null, container));
        container.remove();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Invoke the oldest pending animation-frame callback with timestamp `ts`. */
function flushFrame(ts: number): void {
    const first = rafMap.entries().next();
    if (first.done) {
        throw new Error('no animation frame scheduled');
    }
    const [id, cb] = first.value;
    rafMap.delete(id);
    act(() => {
        cb(ts);
    });
}

/** Reset the harness mid-test so a fast-check iteration starts clean. */
function resetHarness(): void {
    if (container?.isConnected) {
        act(() => render(null, container));
        container.remove();
    }
    rafMap = new Map();
    nextRafId = 1;
    container = document.createElement('div');
    document.body.appendChild(container);
}

// -----------------------------------------------------------------------------
// Harness component — wires usePlayback to the transport, the way App does,
// and exposes the engine's indicator outputs for assertion.
// -----------------------------------------------------------------------------

function Harness(props: {
    composed: Signal<Polyline[]>;
    machineEtaMs: Signal<number | null>;
    initialSpeed?: number;
}): preact.JSX.Element {
    const playback = usePlayback(
        props.composed,
        props.machineEtaMs,
        props.initialSpeed !== undefined
            ? { initialSpeed: props.initialSpeed }
            : undefined,
    );
    const ind = playback.indicatorPoint;
    return (
        <div>
            <AnimationPlayback playback={playback} />
            <span data-testid="hk-ind-x">{ind ? String(ind.x) : ''}</span>
            <span data-testid="hk-ind-y">{ind ? String(ind.y) : ''}</span>
            <span data-testid="hk-reveal">{String(playback.revealFraction)}</span>
            <span data-testid="hk-active">{String(playback.active)}</span>
        </div>
    );
}

// -----------------------------------------------------------------------------
// Local DOM helpers
// -----------------------------------------------------------------------------

function q(testid: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

function qRequired(testid: string): HTMLElement {
    const el = q(testid);
    if (el === null) throw new Error(`element not found: ${testid}`);
    return el;
}

/** Read the engine's indicator point (via the harness spans) or `null`. */
function indicatorPos(): { x: number; y: number } | null {
    const xEl = q('hk-ind-x');
    const yEl = q('hk-ind-y');
    if (xEl === null || (xEl.textContent ?? '') === '') return null;
    return {
        x: parseFloat(xEl.textContent ?? '0'),
        y: parseFloat(yEl?.textContent ?? '0'),
    };
}

function clickByTestId(testid: string): void {
    const el = qRequired(testid);
    act(() => {
        el.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
}

function clickPlay(): void {
    clickByTestId('animation-playback-play');
}
function clickPause(): void {
    clickByTestId('animation-playback-pause');
}
function clickStop(): void {
    clickByTestId('animation-playback-stop');
}

/** Drive the speed slider with an `input` event the way a real drag would. */
function setSpeed(v: number): void {
    const el = qRequired('animation-playback-speed') as HTMLInputElement;
    act(() => {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Mount the Harness into the current container. */
function mount(props: {
    composed: Signal<Polyline[]>;
    machineEtaMs: Signal<number | null>;
    initialSpeed?: number;
}): void {
    act(() => {
        render(
            props.initialSpeed !== undefined ? (
                <Harness
                    composed={props.composed}
                    machineEtaMs={props.machineEtaMs}
                    initialSpeed={props.initialSpeed}
                />
            ) : (
                <Harness
                    composed={props.composed}
                    machineEtaMs={props.machineEtaMs}
                />
            ),
            container,
        );
    });
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/** A horizontal segment of `length` units along the x-axis. */
function lineFixture(length = 1000): Polyline[] {
    return [
        [
            { x: 0, y: 0 },
            { x: length, y: 0 },
        ],
    ];
}

// -----------------------------------------------------------------------------
// Transport state machine (Req 18.6, 18.7, 18.8)
// -----------------------------------------------------------------------------

describe('playback transport (Req 18.6, 18.7, 18.8)', () => {
    it('Stopped → Playing → Paused → Playing → Stopped, and Pause preserves position (Req 18.7, 18.8)', () => {
        const composed = signal<Polyline[]>(lineFixture(1000));
        const machineEtaMs = signal<number | null>(12_345);
        mount({ composed, machineEtaMs });

        // Initial: stopped, no indicator, controls reflect the state.
        expect(qRequired('animation-playback').dataset.state).toBe('stopped');
        expect(indicatorPos()).toBeNull();
        expect((qRequired('animation-playback-pause') as HTMLButtonElement).disabled).toBe(true);
        expect((qRequired('animation-playback-stop') as HTMLButtonElement).disabled).toBe(true);

        // Play: state advances to 'playing' and a frame is scheduled.
        clickPlay();
        expect(qRequired('animation-playback').dataset.state).toBe('playing');

        flushFrame(0); // primer (establishes time origin)
        flushFrame(100); // dt = 100 ms at speed = 1, baseUps = 200 → +20 units
        const posBeforePause = indicatorPos();
        expect(posBeforePause).not.toBeNull();
        expect(posBeforePause!.x).toBeCloseTo(20, 6);

        // Pause: state freezes, indicator stays put, no rAF in flight.
        clickPause();
        expect(qRequired('animation-playback').dataset.state).toBe('paused');
        expect(indicatorPos()!.x).toBeCloseTo(20, 6);
        expect(rafMap.size).toBe(0);

        // Resume: position picks up where it left off (Req 18.7).
        clickPlay();
        expect(qRequired('animation-playback').dataset.state).toBe('playing');

        flushFrame(500); // primer after resume
        flushFrame(550); // +50 ms at speed = 1 → +10 units → 30 total
        expect(indicatorPos()!.x).toBeCloseTo(30, 6);

        // Stop: indicator disappears, position resets, state is 'stopped'
        // (Req 18.8). Subsequent Play starts from 0.
        clickStop();
        expect(qRequired('animation-playback').dataset.state).toBe('stopped');
        expect(indicatorPos()).toBeNull();

        clickPlay();
        flushFrame(1000); // primer after Stop+Play
        flushFrame(1050); // +50 ms → +10 units from origin (== 10)
        expect(indicatorPos()!.x).toBeCloseTo(10, 6);
    });

    it('exposes `active` true while playing/paused and false when stopped', () => {
        const composed = signal<Polyline[]>(lineFixture(1000));
        const machineEtaMs = signal<number | null>(null);
        mount({ composed, machineEtaMs });

        expect(qRequired('hk-active').textContent).toBe('false');
        clickPlay();
        expect(qRequired('hk-active').textContent).toBe('true');
        clickPause();
        expect(qRequired('hk-active').textContent).toBe('true');
        clickStop();
        expect(qRequired('hk-active').textContent).toBe('false');
    });
});

// -----------------------------------------------------------------------------
// Empty-scene Play (Req 18.4)
// -----------------------------------------------------------------------------

describe('playback empty-scene Play (Req 18.4)', () => {
    it('Play with no composed polylines is a no-op and renders no indicator', () => {
        const composed = signal<Polyline[]>([]);
        const machineEtaMs = signal<number | null>(null);
        mount({ composed, machineEtaMs });

        // Transport disabled while disabled === true.
        expect((qRequired('animation-playback-play') as HTMLButtonElement).disabled).toBe(true);

        // Click Play anyway — the engine's play() is a no-op with no path.
        clickPlay();
        expect(qRequired('animation-playback').dataset.state).toBe('stopped');
        expect(indicatorPos()).toBeNull();
        expect(rafMap.size).toBe(0);

        // The Preview readout is the explicit "—" sentinel when empty.
        expect(
            qRequired('animation-playback-preview-duration-value').textContent,
        ).toBe('—');
    });

    it('a polyline with only a single point is still treated as empty', () => {
        const composed = signal<Polyline[]>([[{ x: 0, y: 0 }]]);
        const machineEtaMs = signal<number | null>(null);
        mount({ composed, machineEtaMs });

        // pathLength is 0 → disabled, even though composed.length > 0.
        expect((qRequired('animation-playback-play') as HTMLButtonElement).disabled).toBe(true);
        clickPlay();
        expect(qRequired('animation-playback').dataset.state).toBe('stopped');
        expect(indicatorPos()).toBeNull();
        expect(rafMap.size).toBe(0);
    });
});

// -----------------------------------------------------------------------------
// Speed slider range and within-100-ms effect (Req 18.5)
// -----------------------------------------------------------------------------

describe('playback speed slider (Req 18.5)', () => {
    it('the speed slider has range [0.25, 8] (Req 18.5) and is labelled "Preview speed"', () => {
        const composed = signal<Polyline[]>(lineFixture(1000));
        const machineEtaMs = signal<number | null>(null);
        mount({ composed, machineEtaMs });

        const slider = qRequired('animation-playback-speed') as HTMLInputElement;
        expect(slider.type).toBe('range');
        expect(parseFloat(slider.min)).toBe(0.25);
        expect(parseFloat(slider.max)).toBe(8);
        expect(SPEED_MIN).toBe(0.25);
        expect(SPEED_MAX).toBe(8);
        expect(slider.getAttribute('aria-label')).toBe('Preview speed');
    });

    it('a speed change while playing affects the indicator within 100 ms simulated', () => {
        const composed = signal<Polyline[]>(lineFixture(10_000));
        const machineEtaMs = signal<number | null>(null);
        mount({ composed, machineEtaMs });

        clickPlay();
        flushFrame(0); // primer
        flushFrame(100); // 100 ms at speed = 1 → +20 units
        const posAt100 = indicatorPos()!.x;
        expect(posAt100).toBeCloseTo(20, 6);

        // Slider changes mid-playback. Speed change is applied to a ref
        // synchronously; the next rAF tick reads the new speed.
        setSpeed(2);

        // Within 100 ms of the change, advance at the NEW speed:
        // dt = 100 ms at speed = 2, baseUps = 200 → +40 units.
        flushFrame(200);
        const posAt200 = indicatorPos()!.x;
        expect(posAt200 - posAt100).toBeCloseTo(40, 6);
    });

    it('clamps a value above SPEED_MAX (and below SPEED_MIN) to the supported range', () => {
        const composed = signal<Polyline[]>(lineFixture(10_000));
        const machineEtaMs = signal<number | null>(null);
        mount({ composed, machineEtaMs });

        setSpeed(99);
        const slider = qRequired('animation-playback-speed') as HTMLInputElement;
        expect(parseFloat(slider.value)).toBe(SPEED_MAX);

        setSpeed(0);
        expect(parseFloat(slider.value)).toBe(SPEED_MIN);
    });
});

// -----------------------------------------------------------------------------
// Scene change auto-stop (Req 18.9)
// -----------------------------------------------------------------------------

describe('playback auto-stop on scene change (Req 18.9)', () => {
    it('mutating composed during playback resets state to stopped and position to 0', () => {
        const composed = signal<Polyline[]>(lineFixture(1000));
        const machineEtaMs = signal<number | null>(null);
        mount({ composed, machineEtaMs });

        clickPlay();
        flushFrame(0);
        flushFrame(100);
        expect(indicatorPos()!.x).toBeCloseTo(20, 6);

        // Replace `composed` — auto-stop fires synchronously through the
        // signal effect; rAF queue is cleared.
        act(() => {
            composed.value = lineFixture(2000);
        });

        expect(qRequired('animation-playback').dataset.state).toBe('stopped');
        expect(indicatorPos()).toBeNull();
        expect(rafMap.size).toBe(0);

        // Resuming starts from position 0 again, not 20.
        clickPlay();
        flushFrame(500); // primer
        flushFrame(600); // +100 ms at speed 1 → +20 units (from 0)
        expect(indicatorPos()!.x).toBeCloseTo(20, 6);
    });

    it('mutating composed while paused also drops to stopped and clears the indicator', () => {
        const composed = signal<Polyline[]>(lineFixture(1000));
        const machineEtaMs = signal<number | null>(null);
        mount({ composed, machineEtaMs });

        clickPlay();
        flushFrame(0);
        flushFrame(100);
        clickPause();
        expect(qRequired('animation-playback').dataset.state).toBe('paused');

        act(() => {
            composed.value = lineFixture(500);
        });

        expect(qRequired('animation-playback').dataset.state).toBe('stopped');
        expect(indicatorPos()).toBeNull();
    });
});

// -----------------------------------------------------------------------------
// No controller import (Req 18.10) — static source-text guard
// -----------------------------------------------------------------------------

describe('playback never imports the controller (Req 18.10)', () => {
    it('neither the transport nor the engine source imports or calls a controller method', () => {
        for (const rel of [
            'src/ui/composer/AnimationPlayback.tsx',
            'src/ui/composer/use_playback.ts',
        ]) {
            const sourcePath = path.resolve(process.cwd(), rel);
            const source = readFileSync(sourcePath, 'utf8');
            // Strip block and line comments so doc-comments referring to
            // `controller` do not trip the guards.
            const code = source
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/.*$/gm, '');

            expect(code).not.toMatch(
                /import[\s\S]*?from\s+['"][^'"]*\bcontroller(?:[./][^'"]*)?['"]/,
            );
            expect(code).not.toMatch(/\bsetPolylines\b/);
            expect(code).not.toMatch(/\bclearPath\b/);
            expect(code).not.toMatch(/controller\s*\.\s*(?:setPolylines|clearPath|draw|setImageError)/);
        }
    });
});

// -----------------------------------------------------------------------------
// Pure-helper unit tests (kept from the original suite)
// -----------------------------------------------------------------------------

describe('pure helpers', () => {
    it('pathLength sums segment lengths and ignores < 2-point polylines', () => {
        expect(pathLength([])).toBe(0);
        expect(pathLength([[{ x: 0, y: 0 }]])).toBe(0);
        expect(
            pathLength([
                [
                    { x: 0, y: 0 },
                    { x: 3, y: 4 },
                ],
            ]),
        ).toBeCloseTo(5, 9);
        expect(
            pathLength([
                [
                    { x: 0, y: 0 },
                    { x: 3, y: 0 },
                ],
                [
                    { x: 0, y: 0 },
                    { x: 0, y: 4 },
                ],
            ]),
        ).toBeCloseTo(7, 9);
    });

    it('pointAtDistance walks polylines in order and clamps to [0, total]', () => {
        const poly: Polyline[] = [
            [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
            ],
        ];
        expect(pointAtDistance(poly, 0)).toEqual({ x: 0, y: 0 });
        const mid = pointAtDistance(poly, 5);
        expect(mid!.x).toBeCloseTo(5, 9);
        expect(mid!.y).toBeCloseTo(0, 9);
        // Beyond total clamps to the last valid point.
        const end = pointAtDistance(poly, 1000);
        expect(end!.x).toBeCloseTo(10, 9);
        // Empty / single-point inputs yield null.
        expect(pointAtDistance([], 1)).toBeNull();
        expect(pointAtDistance([[{ x: 1, y: 2 }]], 1)).toBeNull();
    });

    it('formatDuration renders m:ss with zero-padding and a 0:00 floor', () => {
        expect(formatDuration(0)).toBe('0:00');
        expect(formatDuration(-5)).toBe('0:00');
        expect(formatDuration(Number.NaN)).toBe('0:00');
        expect(formatDuration(1_000)).toBe('0:01');
        expect(formatDuration(65_000)).toBe('1:05');
        expect(formatDuration(600_000)).toBe('10:00');
    });

    it('clampSpeed clamps into [SPEED_MIN, SPEED_MAX] and maps NaN to 1', () => {
        expect(clampSpeed(Number.NaN)).toBe(1);
        expect(clampSpeed(0)).toBe(SPEED_MIN);
        expect(clampSpeed(99)).toBe(SPEED_MAX);
        expect(clampSpeed(2)).toBe(2);
    });
});

// -----------------------------------------------------------------------------
// Property 14: playback determinism (Req 18.2, 18.7, 18.11)
// -----------------------------------------------------------------------------

const arbPoint = fc
    .record({
        x: fc.double({
            min: 0,
            max: 10_000,
            noNaN: true,
            noDefaultInfinity: true,
        }),
        y: fc.double({
            min: 0,
            max: 10_000,
            noNaN: true,
            noDefaultInfinity: true,
        }),
    })
    .map((p) => ({ x: p.x + 0, y: p.y + 0 })); // canonicalise -0

const arbPolyline = fc.array(arbPoint, { minLength: 2, maxLength: 5 });

const arbPolylines = fc
    .array(arbPolyline, { minLength: 1, maxLength: 3 })
    .map((arr) => arr.filter((p) => p.length >= 2));

const arbSpeed = fc.double({
    min: SPEED_MIN,
    max: SPEED_MAX,
    noNaN: true,
    noDefaultInfinity: true,
});

const arbDt = fc.integer({ min: 16, max: 200 });

describe('playback Property 14 (Req 18.2, 18.7, 18.11)', () => {
    it(
        // Feature: unified-composer-canvas, Property 14: identical (P, s, totalElapsed) inputs produce identical sampled indicator positions across two independent runs
        'Feature: unified-composer-canvas, Property 14: identical (P, s, totalElapsed) inputs produce identical sampled indicator positions across two independent runs',
        () => {
            fc.assert(
                fc.property(
                    arbPolylines,
                    arbSpeed,
                    fc.array(arbDt, { minLength: 1, maxLength: 4 }),
                    (polylines, speed, dts) => {
                        const total = pathLength(polylines);
                        fc.pre(total > 0);
                        const totalElapsedMs = dts.reduce((a, b) => a + b, 0);
                        const expected =
                            (totalElapsedMs / 1000) * speed * BASE_UPS;
                        fc.pre(expected < total - 1);

                        // -------- Run A --------
                        resetHarness();
                        const composedA = signal<Polyline[]>(polylines);
                        const etaA = signal<number | null>(null);
                        mount({
                            composed: composedA,
                            machineEtaMs: etaA,
                            initialSpeed: speed,
                        });
                        clickPlay();
                        flushFrame(0);
                        let tA = 0;
                        for (const dt of dts) {
                            tA += dt;
                            flushFrame(tA);
                        }
                        const posA = indicatorPos();

                        // -------- Run B (fresh component instance) --------
                        resetHarness();
                        const composedB = signal<Polyline[]>(polylines);
                        const etaB = signal<number | null>(null);
                        mount({
                            composed: composedB,
                            machineEtaMs: etaB,
                            initialSpeed: speed,
                        });
                        clickPlay();
                        flushFrame(0);
                        let tB = 0;
                        for (const dt of dts) {
                            tB += dt;
                            flushFrame(tB);
                        }
                        const posB = indicatorPos();

                        expect(posA).not.toBeNull();
                        expect(posB).not.toBeNull();
                        expect(posA!.x).toBeCloseTo(posB!.x, 6);
                        expect(posA!.y).toBeCloseTo(posB!.y, 6);

                        const predicted = pointAtDistance(polylines, expected);
                        expect(predicted).not.toBeNull();
                        expect(posA!.x).toBeCloseTo(predicted!.x, 4);
                        expect(posA!.y).toBeCloseTo(predicted!.y, 4);
                    },
                ),
                { numRuns: 30 },
            );
        },
    );

    it(
        // Feature: unified-composer-canvas, Property 14: pause+resume produces a position trajectory equal to a continuous run time-shifted by the pause Δ
        'Feature: unified-composer-canvas, Property 14: pause+resume produces a position trajectory equal to a continuous run time-shifted by the pause Δ',
        () => {
            fc.assert(
                fc.property(
                    arbPolylines,
                    arbSpeed,
                    fc.integer({ min: 50, max: 200 }), // playback time before pause
                    fc.integer({ min: 50, max: 1000 }), // pause Δ (no frames during this gap)
                    fc.integer({ min: 50, max: 200 }), // playback time after resume
                    (polylines, speed, beforePauseMs, deltaMs, afterResumeMs) => {
                        const total = pathLength(polylines);
                        fc.pre(total > 0);
                        const totalAdvance =
                            ((beforePauseMs + afterResumeMs) / 1000) *
                            speed *
                            BASE_UPS;
                        fc.pre(totalAdvance < total - 1);

                        // -------- Continuous run --------
                        resetHarness();
                        const composedC = signal<Polyline[]>(polylines);
                        const etaC = signal<number | null>(null);
                        mount({
                            composed: composedC,
                            machineEtaMs: etaC,
                            initialSpeed: speed,
                        });
                        clickPlay();
                        flushFrame(0);
                        flushFrame(beforePauseMs);
                        flushFrame(beforePauseMs + afterResumeMs);
                        const continuousPos = indicatorPos();
                        expect(continuousPos).not.toBeNull();

                        // -------- Pause/resume run, time-shifted by Δ --------
                        resetHarness();
                        const composedP = signal<Polyline[]>(polylines);
                        const etaP = signal<number | null>(null);
                        mount({
                            composed: composedP,
                            machineEtaMs: etaP,
                            initialSpeed: speed,
                        });
                        clickPlay();
                        flushFrame(0);
                        flushFrame(beforePauseMs);
                        clickPause();
                        clickPlay();
                        const resumeStart = beforePauseMs + deltaMs;
                        flushFrame(resumeStart);
                        flushFrame(resumeStart + afterResumeMs);
                        const pauseResumePos = indicatorPos();
                        expect(pauseResumePos).not.toBeNull();

                        expect(pauseResumePos!.x).toBeCloseTo(
                            continuousPos!.x,
                            4,
                        );
                        expect(pauseResumePos!.y).toBeCloseTo(
                            continuousPos!.y,
                            4,
                        );
                    },
                ),
                { numRuns: 25 },
            );
        },
    );
});

// -----------------------------------------------------------------------------
// Property 15: dual-readout independence (Req 18.13, 18.14)
// -----------------------------------------------------------------------------

describe('playback Property 15 (Req 18.13, 18.14)', () => {
    it(
        // Feature: unified-composer-canvas, Property 15: the Machine ETA readout is byte-for-byte identical across all Preview-speed values
        'Feature: unified-composer-canvas, Property 15: the Machine ETA readout is byte-for-byte identical across all Preview-speed values',
        () => {
            fc.assert(
                fc.property(
                    arbPolylines,
                    fc.integer({ min: 1, max: 600_000 }), // machine ETA in ms
                    fc.array(arbSpeed, { minLength: 2, maxLength: 6 }),
                    (polylines, etaMs, speeds) => {
                        const total = pathLength(polylines);
                        fc.pre(total > 0);

                        resetHarness();
                        const composed = signal<Polyline[]>(polylines);
                        const machineEtaMs = signal<number | null>(etaMs);
                        mount({
                            composed,
                            machineEtaMs,
                            initialSpeed: speeds[0],
                        });

                        const initialEta = qRequired(
                            'animation-playback-machine-eta-value',
                        ).textContent;
                        expect(initialEta).not.toBe('—');
                        expect(initialEta).toBe(formatDuration(etaMs));

                        for (const s of speeds) {
                            setSpeed(s);
                            const eta = qRequired(
                                'animation-playback-machine-eta-value',
                            ).textContent;
                            expect(eta).toBe(initialEta);
                        }
                    },
                ),
                { numRuns: 30 },
            );
        },
    );

    it(
        // Feature: unified-composer-canvas, Property 15: the Preview duration readout changes monotonically with speed
        'Feature: unified-composer-canvas, Property 15: the Preview duration readout changes monotonically with speed',
        () => {
            const longPath: Polyline[] = [
                [
                    { x: 0, y: 0 },
                    { x: 100_000, y: 0 },
                ],
            ];
            const speeds = [0.25, 0.5, 1, 2, 4, 8] as const;

            resetHarness();
            const composed = signal<Polyline[]>(longPath);
            const machineEtaMs = signal<number | null>(null);
            mount({ composed, machineEtaMs, initialSpeed: speeds[0] });

            const durations: string[] = [];
            for (const s of speeds) {
                setSpeed(s);
                const text = qRequired(
                    'animation-playback-preview-duration-value',
                ).textContent ?? '';
                durations.push(text);
                const expectedMs =
                    (pathLength(longPath) / (BASE_UPS * s)) * 1000;
                expect(text).toBe(formatDuration(expectedMs));
            }

            const seconds = durations.map((t) => {
                const [m, s] = t.split(':').map((p) => parseInt(p, 10));
                return m * 60 + s;
            });
            for (let i = 1; i < seconds.length; i++) {
                expect(seconds[i]).toBeLessThan(seconds[i - 1]);
            }
        },
    );

    it('the dual-readout line shows both a Preview and a Machine ETA segment', () => {
        const composed = signal<Polyline[]>(lineFixture(1000));
        const machineEtaMs = signal<number | null>(60_000);
        mount({ composed, machineEtaMs });

        const preview = q('animation-playback-preview-duration');
        const eta = q('animation-playback-machine-eta');
        expect(preview).not.toBeNull();
        expect(eta).not.toBeNull();
        expect(preview!.textContent).toContain('Preview');
        expect(eta!.textContent).toContain('Machine ETA');
        // Machine ETA value reflects the signal (60s → "1:00").
        expect(
            qRequired('animation-playback-machine-eta-value').textContent,
        ).toBe('1:00');
    });
});
