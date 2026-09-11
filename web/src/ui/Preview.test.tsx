import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import {
    Preview,
    clampRate,
    drawScene,
    PREVIEW_RATE_MIN,
    PREVIEW_RATE_MAX,
} from './Preview';
import type { PlannedPath } from '../types';

/**
 * Unit tests for the animated {@link Preview} component (task 24.2).
 *
 * These cover:
 *   - the playback-rate control exists and is constrained to [0.25, 4]
 *   - play/pause toggling flips component state
 *   - progress advances as animation-frame time is advanced
 *   - connectors are visually distinguished from strokes (via drawScene)
 *   - empty / no-path is handled gracefully
 *
 * Canvas pixels are NOT asserted (jsdom has no 2D context); assertions are on
 * DOM state, the progress readout, and the pure drawScene routine driving a
 * stubbed 2D context.
 */

// --- requestAnimationFrame harness -----------------------------------------
// The component drives its animation with requestAnimationFrame and integrates
// the per-frame delta time. We replace rAF with a manual queue so the test can
// advance "time" deterministically by invoking the scheduled callback with an
// explicit timestamp.

let rafMap: Map<number, FrameRequestCallback>;
let nextRafId: number;

beforeEach(() => {
    rafMap = new Map();
    nextRafId = 1;
    // jsdom has no real 2D context; return null so the component's draw effect
    // cleanly skips rendering instead of logging "not implemented" noise.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        const id = nextRafId++;
        rafMap.set(id, cb);
        return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        rafMap.delete(id);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Invoke the oldest pending animation-frame callback with timestamp `ts`. */
function flushFrame(ts: number): void {
    const first = rafMap.entries().next();
    if (first.done) throw new Error('no animation frame scheduled');
    const [id, cb] = first.value;
    rafMap.delete(id);
    act(() => {
        cb(ts);
    });
}

/** Mount a component into a fresh container attached to the document. */
function mount(node: preact.ComponentChild): { container: HTMLDivElement } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
        render(node, container);
    });
    return { container };
}

function unmount(container: HTMLElement): void {
    act(() => {
        render(null, container);
    });
    container.remove();
}

function $(container: HTMLElement, testid: string): HTMLElement {
    const el = container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
    if (!el) throw new Error(`missing element: ${testid}`);
    return el;
}

// --- fixtures ---------------------------------------------------------------

/**
 * Fixture path: one 100-step stroke + one 100-step connector = 200 steps.
 * With feedSps = 1000 the real-time duration is 1000 * 200 / 1000 = 200 ms,
 * so at rate = 1 the playback duration is exactly 200 ms.
 */
function fixturePath(): PlannedPath {
    return {
        drawableSteps: { w: 608, h: 420 },
        segments: [
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
            {
                kind: 'connector',
                pointsSteps: [{ x: 100, y: 0 }, { x: 100, y: 100 }],
            },
        ],
    };
}

describe('clampRate', () => {
    it('clamps below the minimum up to 0.25', () => {
        expect(clampRate(0.1)).toBe(PREVIEW_RATE_MIN);
        expect(clampRate(0)).toBe(PREVIEW_RATE_MIN);
        expect(clampRate(-5)).toBe(PREVIEW_RATE_MIN);
    });
    it('clamps above the maximum down to 4', () => {
        expect(clampRate(4.1)).toBe(PREVIEW_RATE_MAX);
        expect(clampRate(100)).toBe(PREVIEW_RATE_MAX);
    });
    it('passes through in-range values', () => {
        expect(clampRate(0.25)).toBe(0.25);
        expect(clampRate(1)).toBe(1);
        expect(clampRate(2.5)).toBe(2.5);
        expect(clampRate(4)).toBe(4);
    });
    it('falls back to 1 for non-finite input', () => {
        expect(clampRate(NaN)).toBe(1);
        expect(clampRate(Infinity)).toBe(1);
        expect(clampRate(-Infinity)).toBe(1);
    });
});

describe('Preview rate control', () => {
    it('renders a playback-rate slider constrained to [0.25, 4]', () => {
        const { container } = mount(<Preview path={fixturePath()} feedSps={1000} />);
        const rate = $(container, 'preview-rate') as HTMLInputElement;
        expect(rate.type).toBe('range');
        expect(rate.min).toBe(String(PREVIEW_RATE_MIN));
        expect(rate.max).toBe(String(PREVIEW_RATE_MAX));
        expect(parseFloat(rate.step)).toBeGreaterThan(0);
        unmount(container);
    });

    it('reflects rate changes from the slider', () => {
        const { container } = mount(<Preview path={fixturePath()} feedSps={1000} />);
        const rate = $(container, 'preview-rate') as HTMLInputElement;
        act(() => {
            rate.value = '2';
            rate.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect($(container, 'preview-rate-value').textContent).toContain('2.00');
        unmount(container);
    });

    it('clamps an initialRate outside the supported range', () => {
        const { container } = mount(
            <Preview path={fixturePath()} feedSps={1000} initialRate={99} />,
        );
        const rate = $(container, 'preview-rate') as HTMLInputElement;
        expect(parseFloat(rate.value)).toBe(PREVIEW_RATE_MAX);
        unmount(container);
    });
});

describe('Preview play/pause', () => {
    it('toggles the transport state when the play button is clicked', () => {
        const { container } = mount(<Preview path={fixturePath()} feedSps={1000} />);
        const btn = $(container, 'preview-playpause') as HTMLButtonElement;

        expect(btn.textContent).toBe('Play');
        expect(btn.getAttribute('aria-pressed')).toBe('false');

        act(() => btn.click());
        expect(btn.textContent).toBe('Pause');
        expect(btn.getAttribute('aria-pressed')).toBe('true');

        act(() => btn.click());
        expect(btn.textContent).toBe('Play');
        expect(btn.getAttribute('aria-pressed')).toBe('false');

        unmount(container);
    });
});

describe('Preview progress', () => {
    it('advances progress as animation-frame time is advanced', () => {
        const { container } = mount(<Preview path={fixturePath()} feedSps={1000} />);
        const btn = $(container, 'preview-playpause') as HTMLButtonElement;
        const progress = $(container, 'preview-progress');

        expect(progress.textContent).toBe('0%');

        act(() => btn.click()); // start playing → schedules first frame

        flushFrame(0); // establishes the time origin; progress stays at 0%
        expect(progress.textContent).toBe('0%');

        // Real-time = 200 ms at feedSps=1000, rate=1 → playback = 200 ms.
        flushFrame(100); // +100 ms → 50%
        expect(progress.textContent).toBe('50%');

        flushFrame(200); // +100 ms → 100% and playback stops
        expect(progress.textContent).toBe('100%');
        expect(btn.textContent).toBe('Play');

        unmount(container);
    });

    it('restart resets progress to 0%', () => {
        const { container } = mount(<Preview path={fixturePath()} feedSps={1000} />);
        const btn = $(container, 'preview-playpause') as HTMLButtonElement;
        const restart = $(container, 'preview-restart') as HTMLButtonElement;
        const progress = $(container, 'preview-progress');

        act(() => btn.click());
        flushFrame(0);
        flushFrame(100);
        expect(progress.textContent).toBe('50%');

        act(() => restart.click());
        expect(progress.textContent).toBe('0%');

        unmount(container);
    });

    it('honors the playback rate: 2x covers the path in half the frame-time', () => {
        const { container } = mount(
            <Preview path={fixturePath()} feedSps={1000} initialRate={2} />,
        );
        const btn = $(container, 'preview-playpause') as HTMLButtonElement;
        const progress = $(container, 'preview-progress');

        act(() => btn.click());
        flushFrame(0);
        // playback = 200 ms / 2 = 100 ms → 100 ms of frame-time completes it.
        flushFrame(100);
        expect(progress.textContent).toBe('100%');

        unmount(container);
    });
});

describe('Preview empty state', () => {
    it('renders a placeholder and disables controls with no path', () => {
        const { container } = mount(<Preview path={null} />);
        expect(container.querySelector('[data-testid="preview-empty"]')).not.toBeNull();
        expect(
            ($(container, 'preview-playpause') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(($(container, 'preview-rate') as HTMLInputElement).disabled).toBe(
            true,
        );
        unmount(container);
    });

    it('treats a path with no drawable motion as empty', () => {
        const emptyPath: PlannedPath = {
            drawableSteps: { w: 608, h: 420 },
            segments: [],
        };
        const { container } = mount(<Preview path={emptyPath} feedSps={1000} />);
        expect(container.querySelector('[data-testid="preview-empty"]')).not.toBeNull();
        unmount(container);
    });
});

describe('drawScene connector vs stroke distinction', () => {
    /** A minimal stub recording the 2D-context calls drawScene makes. */
    function makeCtxStub() {
        const calls: { strokeStyles: string[]; dashes: number[][] } = {
            strokeStyles: [],
            dashes: [],
        };
        const ctx = {
            _strokeStyle: '#000',
            _lineDash: [] as number[],
            set strokeStyle(v: string) {
                this._strokeStyle = v;
            },
            get strokeStyle() {
                return this._strokeStyle;
            },
            fillStyle: '#000',
            lineWidth: 1,
            clearRect() { },
            fillRect() { },
            beginPath() { },
            moveTo() { },
            lineTo() { },
            arc() { },
            fill() { },
            setLineDash(d: number[]) {
                this._lineDash = d;
            },
            stroke() {
                calls.strokeStyles.push(this._strokeStyle);
                calls.dashes.push([...this._lineDash]);
            },
        };
        return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
    }

    it('strokes solid and connectors dashed when fully revealed', () => {
        const { ctx, calls } = makeCtxStub();
        drawScene(ctx, fixturePath(), 1, 456, 315);

        // Two segments → two stroke() calls (stroke then connector).
        expect(calls.strokeStyles.length).toBe(2);
        // First segment is a stroke: solid (empty dash).
        expect(calls.dashes[0]).toEqual([]);
        // Second segment is a connector: dashed (non-empty dash) and lighter.
        expect(calls.dashes[1]!.length).toBeGreaterThan(0);
        expect(calls.strokeStyles[0]).not.toBe(calls.strokeStyles[1]);
    });
});
