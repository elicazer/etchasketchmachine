import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { FreehandPanel } from './FreehandPanel';
import type { Polyline } from '../types';

/**
 * Component tests for the freehand drawing panel (Req 11.1–11.7).
 *
 * jsdom has no real pointer pipeline, so we dispatch synthetic pointer
 * events on the drawing surface and assert on the resulting DOM / callback
 * behaviour. The smoothing, <3-point discard, and undo/clear semantics are
 * owned by FreehandCapture (covered by its own unit + property tests); here
 * we verify the panel wires those behaviours up correctly.
 *
 * @testing-library/preact is not a project dependency, so we mount with
 * Preact's own `render` + `act` from `preact/test-utils`.
 */

let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    // Unmount and clean up between tests.
    act(() => {
        render(null, container);
    });
    container.remove();
});

/** The SVG drawing surface element rendered by the panel. */
function surface(): SVGSVGElement {
    const el = container.querySelector<SVGSVGElement>('[data-testid="freehand-surface"]');
    if (el === null) throw new Error('drawing surface not found');
    return el;
}

function button(testid: string): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
    if (el === null) throw new Error(`button ${testid} not found`);
    return el;
}

/** Number of committed strokes the panel currently reports. */
function strokeCount(): number {
    const el = container.querySelector('[data-testid="freehand-stroke-count"]');
    return Number(el?.textContent ?? 'NaN');
}

/** Number of committed stroke polylines actually rendered in the SVG. */
function renderedStrokes(): number {
    return container.querySelectorAll('[data-testid="freehand-stroke"]').length;
}

/**
 * Dispatch a pointer event of `type` at client coordinates `(x, y)` on the
 * surface. jsdom lacks a PointerEvent constructor, so we synthesize a
 * MouseEvent and tag on the pointer fields the handler reads.
 */
function dispatchPointer(
    target: Element,
    type: string,
    x: number,
    y: number,
    timeStamp = 0,
): void {
    const evt = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
    }) as MouseEvent & {
        pointerId?: number;
    };
    evt.pointerId = 1;
    // No coalesced events in jsdom; the panel feature-detects
    // getCoalescedEvents (typeof === 'function') and falls back to the single
    // event, so we deliberately leave it unset here.
    // jsdom's Event.timeStamp is read-only and ~0; override for deterministic
    // sample timings.
    Object.defineProperty(evt, 'timeStamp', { value: timeStamp, configurable: true });
    target.dispatchEvent(evt);
}

/**
 * Drive a full pointerdown -> pointermove* -> pointerup gesture across the
 * given points. The first point is the down, intermediate points are moves,
 * and the last point is the up.
 */
function drawStroke(points: { x: number; y: number }[]): void {
    const svg = surface();
    act(() => {
        dispatchPointer(svg, 'pointerdown', points[0]!.x, points[0]!.y, 0);
    });
    for (let i = 1; i < points.length - 1; i++) {
        act(() => {
            dispatchPointer(svg, 'pointermove', points[i]!.x, points[i]!.y, i * 16);
        });
    }
    const last = points[points.length - 1]!;
    act(() => {
        dispatchPointer(svg, 'pointerup', last.x, last.y, points.length * 16);
    });
}

describe('FreehandPanel', () => {
    it('renders a drawing surface and the control buttons', () => {
        act(() => {
            render(<FreehandPanel onSend={() => { }} />, container);
        });
        expect(surface()).toBeTruthy();
        expect(button('freehand-undo')).toBeTruthy();
        expect(button('freehand-clear')).toBeTruthy();
        expect(button('freehand-send')).toBeTruthy();
        expect(strokeCount()).toBe(0);
    });

    it('adds a stroke from a pointerdown -> move* -> up sequence (≥3 points)', () => {
        act(() => {
            render(<FreehandPanel onSend={() => { }} />, container);
        });
        // down + 2 moves + up = 4 captured points (≥ 3 → committed).
        drawStroke([
            { x: 0, y: 0 },
            { x: 10, y: 5 },
            { x: 20, y: 0 },
            { x: 30, y: 8 },
        ]);
        expect(strokeCount()).toBe(1);
        expect(renderedStrokes()).toBe(1);
    });

    it('discards a stroke with fewer than 3 captured points (Req 11.6)', () => {
        act(() => {
            render(<FreehandPanel onSend={() => { }} />, container);
        });
        // down + up only = 2 captured points (< 3 → discarded).
        drawStroke([
            { x: 1, y: 1 },
            { x: 2, y: 2 },
        ]);
        expect(strokeCount()).toBe(0);
        expect(renderedStrokes()).toBe(0);
    });

    it('undo removes the most recently drawn stroke (Req 11.4)', () => {
        act(() => {
            render(<FreehandPanel onSend={() => { }} />, container);
        });
        drawStroke([
            { x: 0, y: 0 },
            { x: 10, y: 5 },
            { x: 20, y: 0 },
        ]);
        drawStroke([
            { x: 30, y: 0 },
            { x: 40, y: 5 },
            { x: 50, y: 0 },
        ]);
        expect(strokeCount()).toBe(2);

        act(() => {
            button('freehand-undo').click();
        });
        expect(strokeCount()).toBe(1);
        expect(renderedStrokes()).toBe(1);
    });

    it('clear empties all strokes from the canvas (Req 11.5)', () => {
        act(() => {
            render(<FreehandPanel onSend={() => { }} />, container);
        });
        for (let i = 0; i < 3; i++) {
            drawStroke([
                { x: i * 10, y: 0 },
                { x: i * 10 + 5, y: 5 },
                { x: i * 10 + 10, y: 0 },
            ]);
        }
        expect(strokeCount()).toBe(3);

        act(() => {
            button('freehand-clear').click();
        });
        expect(strokeCount()).toBe(0);
        expect(renderedStrokes()).toBe(0);
    });

    it('"add to scene" invokes onSend with the captured polylines (Req 11.7)', () => {
        const onSend = vi.fn<(polylines: Polyline[]) => void>();
        act(() => {
            render(<FreehandPanel onSend={onSend} />, container);
        });
        drawStroke([
            { x: 0, y: 0 },
            { x: 10, y: 5 },
            { x: 20, y: 0 },
        ]);
        drawStroke([
            { x: 30, y: 0 },
            { x: 40, y: 5 },
            { x: 50, y: 0 },
        ]);

        act(() => {
            button('freehand-send').click();
        });

        expect(onSend).toHaveBeenCalledTimes(1);
        const arg = onSend.mock.calls[0]![0];
        // Two committed strokes handed upward.
        expect(arg).toHaveLength(2);
        // Each stroke is a non-trivial polyline of points.
        for (const poly of arg) {
            expect(poly.length).toBeGreaterThanOrEqual(3);
            for (const pt of poly) {
                expect(typeof pt.x).toBe('number');
                expect(typeof pt.y).toBe('number');
            }
        }
    });

    it('disables undo/send until at least one stroke exists', () => {
        act(() => {
            render(<FreehandPanel onSend={() => { }} />, container);
        });
        expect(button('freehand-undo').disabled).toBe(true);
        expect(button('freehand-send').disabled).toBe(true);

        drawStroke([
            { x: 0, y: 0 },
            { x: 10, y: 5 },
            { x: 20, y: 0 },
        ]);

        expect(button('freehand-undo').disabled).toBe(false);
        expect(button('freehand-send').disabled).toBe(false);
    });
});
