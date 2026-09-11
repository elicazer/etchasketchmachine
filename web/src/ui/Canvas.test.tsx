import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

import {
    Canvas,
    CANVAS_ASPECT,
    MIN_CANVAS_WIDTH,
    findOutOfBoundsStepSegments,
    formatDuration,
    formatStepCount,
    isPointInStepBounds,
} from './Canvas';
import type { PlannedPath } from '../types';

/**
 * Unit tests for the static {@link Canvas} component (task 24.1).
 *
 * Covered:
 *   - the canvas element exists with the 152:105 aspect ratio and the
 *     ≥300 CSS px minimum width (Req 8.1)
 *   - the out-of-bounds warning appears iff the path has an OOB segment,
 *     and is absent for a fully in-bounds path (Req 8.6)
 *   - the estimated-time (mm:ss) and total-length (steps) readouts render
 *     the expected formatted values (Req 8.3, 14.5)
 *
 * jsdom has no real 2D context, so `getContext` is stubbed to return null:
 * the component's draw effect cleanly skips pixel work and we assert only on
 * the DOM and text outputs.
 */

beforeEach(() => {
    // No 2D context under jsdom — return null so the draw effect is a no-op
    // and we avoid "not implemented" canvas noise.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
    vi.restoreAllMocks();
});

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

function $(container: HTMLElement, testid: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

function must(container: HTMLElement, testid: string): HTMLElement {
    const el = $(container, testid);
    if (!el) throw new Error(`missing element: ${testid}`);
    return el;
}

// --- fixtures ---------------------------------------------------------------

/**
 * In-bounds fixture: one 100-step stroke + one 100-step connector = 200 steps,
 * every coordinate inside the 608×420 step rectangle. With feedSps = 1000 the
 * estimated time is 1000 * 200 / 1000 = 200 ms → "0:00" rounded.
 */
function inBoundsPath(): PlannedPath {
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

/**
 * Out-of-bounds fixture: a stroke, a connector, and a stroke that leaves the
 * drawable rectangle (x = 700 > 608). Total steps:
 *   stroke   (0,0)->(100,0)      = 100
 *   connector(100,0)->(100,100)  = 100
 *   stroke   (100,100)->(700,100)= 600   (the OOB segment)
 * = 800 steps. With feedSps = 1000 the estimate is 800 ms → "0:01".
 */
function oobPath(): PlannedPath {
    return {
        drawableSteps: { w: 608, h: 420 },
        segments: [
            { kind: 'stroke', pointsSteps: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
            {
                kind: 'connector',
                pointsSteps: [{ x: 100, y: 0 }, { x: 100, y: 100 }],
            },
            {
                kind: 'stroke',
                pointsSteps: [{ x: 100, y: 100 }, { x: 700, y: 100 }],
            },
        ],
    };
}

// --- pure helpers -----------------------------------------------------------

describe('formatDuration', () => {
    it('formats sub-minute durations as m:ss', () => {
        expect(formatDuration(0)).toBe('0:00');
        expect(formatDuration(800)).toBe('0:01');
        expect(formatDuration(59_400)).toBe('0:59');
    });
    it('formats multi-minute durations as m:ss', () => {
        expect(formatDuration(60_000)).toBe('1:00');
        expect(formatDuration(125_000)).toBe('2:05');
    });
    it('treats negative / non-finite durations as 0:00', () => {
        expect(formatDuration(-5)).toBe('0:00');
        expect(formatDuration(Number.NaN)).toBe('0:00');
        expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
    });
});

describe('formatStepCount', () => {
    it('renders a thousands-separated step count', () => {
        expect(formatStepCount(0)).toBe('0 steps');
        expect(formatStepCount(200)).toBe('200 steps');
        expect(formatStepCount(12_345)).toBe('12,345 steps');
    });
    it('floors non-finite / negative input to 0', () => {
        expect(formatStepCount(Number.NaN)).toBe('0 steps');
        expect(formatStepCount(-10)).toBe('0 steps');
    });
});

describe('isPointInStepBounds', () => {
    it('treats the closed rectangle (including the boundary) as in-bounds', () => {
        expect(isPointInStepBounds({ x: 0, y: 0 }, 608, 420)).toBe(true);
        expect(isPointInStepBounds({ x: 608, y: 420 }, 608, 420)).toBe(true);
    });
    it('flags points outside the rectangle', () => {
        expect(isPointInStepBounds({ x: -1, y: 0 }, 608, 420)).toBe(false);
        expect(isPointInStepBounds({ x: 609, y: 0 }, 608, 420)).toBe(false);
        expect(isPointInStepBounds({ x: 0, y: 421 }, 608, 420)).toBe(false);
    });
});

describe('findOutOfBoundsStepSegments', () => {
    it('finds nothing for a fully in-bounds path', () => {
        expect(findOutOfBoundsStepSegments(inBoundsPath())).toEqual([]);
    });
    it('locates the single OOB sub-segment in the fixture', () => {
        const oob = findOutOfBoundsStepSegments(oobPath());
        expect(oob).toHaveLength(1);
        expect(oob[0]!.segIndex).toBe(2);
        expect(oob[0]!.to).toEqual({ x: 700, y: 100 });
    });
});

// --- component --------------------------------------------------------------

describe('Canvas component', () => {
    it('renders a canvas with the 152:105 aspect ratio and ≥300px min width (Req 8.1)', () => {
        const { container } = mount(<Canvas path={inBoundsPath()} />);
        try {
            const surface = must(
                container,
                'canvas-surface',
            ) as HTMLCanvasElement;
            expect(surface.tagName).toBe('CANVAS');
            // Aspect ratio set via inline style.
            expect(surface.style.aspectRatio.replace(/\s+/g, '')).toBe(
                CANVAS_ASPECT.replace(/\s+/g, ''),
            );
            // Minimum CSS width is enforced (Req 8.1).
            expect(surface.style.minWidth).toBe(`${MIN_CANVAS_WIDTH}px`);
            // Backing store keeps the physical aspect ratio.
            expect(surface.width / surface.height).toBeCloseTo(152 / 105, 1);
        } finally {
            unmount(container);
        }
    });

    it('never sizes the canvas below the 300px minimum even when asked smaller', () => {
        const { container } = mount(
            <Canvas path={inBoundsPath()} widthCss={120} />,
        );
        try {
            const surface = must(
                container,
                'canvas-surface',
            ) as HTMLCanvasElement;
            // Backing width is clamped up to the 300px floor.
            expect(surface.width).toBeGreaterThanOrEqual(MIN_CANVAS_WIDTH);
            expect(surface.style.minWidth).toBe(`${MIN_CANVAS_WIDTH}px`);
        } finally {
            unmount(container);
        }
    });

    it('shows the estimated time and total length readouts (Req 8.3, 14.5)', () => {
        const { container } = mount(
            <Canvas path={inBoundsPath()} feedSps={1000} />,
        );
        try {
            // 200 steps total → "200 steps".
            expect(must(container, 'canvas-length').textContent).toContain(
                '200 steps',
            );
            // 200 ms → rounds to 0 s → "0:00".
            expect(must(container, 'canvas-time').textContent).toContain(
                '0:00',
            );
        } finally {
            unmount(container);
        }
    });

    it('reflects the feed rate in the estimated time (Req 8.3)', () => {
        // 200 steps at 50 sps → 4000 ms → "0:04".
        const { container } = mount(
            <Canvas path={inBoundsPath()} feedSps={50} />,
        );
        try {
            expect(must(container, 'canvas-time').textContent).toContain(
                '0:04',
            );
        } finally {
            unmount(container);
        }
    });

    it('does NOT show the out-of-bounds warning for an in-bounds path (Req 8.6)', () => {
        const { container } = mount(<Canvas path={inBoundsPath()} />);
        try {
            expect($(container, 'canvas-oob-warning')).toBeNull();
        } finally {
            unmount(container);
        }
    });

    it('shows the out-of-bounds warning when a segment leaves the drawable area (Req 8.6)', () => {
        const { container } = mount(
            <Canvas path={oobPath()} feedSps={1000} />,
        );
        try {
            const warning = must(container, 'canvas-oob-warning');
            expect(warning.textContent).toMatch(/exceeds the drawable area/i);
            // It is announced as an alert for assistive tech.
            expect(warning.getAttribute('role')).toBe('alert');
            // 800 steps total → "800 steps".
            expect(must(container, 'canvas-length').textContent).toContain(
                '800 steps',
            );
        } finally {
            unmount(container);
        }
    });

    it('raises the OOB warning from mm-space source polylines too (Req 8.6)', () => {
        // Path itself is in-bounds, but the pre-clamp mm polyline left the
        // 152×105 mm drawable rectangle (x = 200 > 152).
        const { container } = mount(
            <Canvas
                path={inBoundsPath()}
                polylinesMm={[[{ x: 10, y: 10 }, { x: 200, y: 10 }]]}
            />,
        );
        try {
            expect($(container, 'canvas-oob-warning')).not.toBeNull();
        } finally {
            unmount(container);
        }
    });

    it('renders a graceful empty state with no path', () => {
        const { container } = mount(<Canvas path={null} />);
        try {
            // Canvas element still present (so layout is stable)...
            expect($(container, 'canvas-surface')).not.toBeNull();
            // ...with the empty-state hint and dash readouts.
            expect($(container, 'canvas-empty')).not.toBeNull();
            expect(must(container, 'canvas-time').textContent).toContain('—');
            expect(must(container, 'canvas-length').textContent).toContain('—');
            // No spurious OOB warning when there is no path.
            expect($(container, 'canvas-oob-warning')).toBeNull();
        } finally {
            unmount(container);
        }
    });
});
