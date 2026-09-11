import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
    DEFAULT_CV_SERVICE_URL,
    CvServiceUnavailable,
    vectorizeViaService,
    isServiceAvailable,
    type VectorizeParams,
} from './cv_service_client';
import { PathPlanner, totalStepCount } from '../path/planner';
import type { Polyline } from '../types';

/**
 * Unit + property tests for the CV-service web client. The network is fully
 * mocked (no real server) via an injectable `fetchImpl`.
 *
 * Coverage:
 *   - Property 6 (mapping fidelity): JSON number[][][] → Polyline[] preserves
 *     every coordinate, losing none and introducing none.
 *   - Property 7 (graceful fallback): fetch rejection, non-2xx, and malformed
 *     bodies each throw CvServiceUnavailable.
 *   - isServiceAvailable never throws and reports availability correctly.
 *   - A cost check: mapped polylines pass through the real PathPlanner.plan and
 *     totalStepCount yields a finite number.
 *
 * @see Design §"Correctness Properties" 6, 7, 8
 * Validates: Requirements 5.1, 5.4, 3.1, 6.1, 6.2
 */

// -----------------------------------------------------------------------------
// Mock helpers
// -----------------------------------------------------------------------------

/** A minimal `Response`-like object good enough for the client's needs. */
function jsonResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

/** A fetch impl that always resolves to the given response. */
function fetchReturning(res: Response): typeof fetch {
    return (async () => res) as unknown as typeof fetch;
}

/** A fetch impl that always rejects (simulates a network failure / service down). */
function fetchRejecting(message = 'network down'): typeof fetch {
    return (async () => {
        throw new TypeError(message);
    }) as unknown as typeof fetch;
}

const PARAMS: VectorizeParams = { mode: 'both', detail: 0.5, contrast: 1.0, toneBands: 2 };
const IMAGE = new Blob(['fake-image-bytes'], { type: 'image/png' });

// -----------------------------------------------------------------------------
// Property 6 — mapping fidelity
// -----------------------------------------------------------------------------

describe('vectorizeViaService — mapping fidelity (Property 6)', () => {
    it('maps a well-formed response to the structurally identical Polyline[]', async () => {
        const body = {
            width: 10,
            height: 10,
            polylines: [
                [[0, 0], [3, 4]],
                [[5, 5]],
            ],
        };
        const result = await vectorizeViaService(IMAGE, PARAMS, {
            fetchImpl: fetchReturning(jsonResponse(200, body)),
        });
        expect(result).toEqual([
            [{ x: 0, y: 0 }, { x: 3, y: 4 }],
            [{ x: 5, y: 5 }],
        ]);
    });

    it('preserves every coordinate exactly across arbitrary well-formed responses', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(
                    fc.array(
                        fc.tuple(
                            fc.integer({ min: 0, max: 999 }),
                            fc.integer({ min: 0, max: 999 }),
                        ),
                    ),
                ),
                async (polylines) => {
                    const body = { width: 1000, height: 1000, polylines };
                    const result = await vectorizeViaService(IMAGE, PARAMS, {
                        fetchImpl: fetchReturning(jsonResponse(200, body)),
                    });
                    // Same number of polylines, same number of points, same coords.
                    expect(result).toHaveLength(polylines.length);
                    for (let i = 0; i < polylines.length; i++) {
                        expect(result[i]).toHaveLength(polylines[i]!.length);
                        for (let j = 0; j < polylines[i]!.length; j++) {
                            expect(result[i]![j]).toEqual({
                                x: polylines[i]![j]![0],
                                y: polylines[i]![j]![1],
                            });
                        }
                    }
                },
            ),
        );
    });
});

// -----------------------------------------------------------------------------
// Property 7 — graceful fallback
// -----------------------------------------------------------------------------

describe('vectorizeViaService — graceful fallback (Property 7)', () => {
    it('throws CvServiceUnavailable on fetch rejection', async () => {
        await expect(
            vectorizeViaService(IMAGE, PARAMS, { fetchImpl: fetchRejecting() }),
        ).rejects.toBeInstanceOf(CvServiceUnavailable);
    });

    it('throws CvServiceUnavailable on a 400 response', async () => {
        await expect(
            vectorizeViaService(IMAGE, PARAMS, {
                fetchImpl: fetchReturning(jsonResponse(400, { error: 'bad image' })),
            }),
        ).rejects.toBeInstanceOf(CvServiceUnavailable);
    });

    it('throws CvServiceUnavailable on a 500 response', async () => {
        await expect(
            vectorizeViaService(IMAGE, PARAMS, {
                fetchImpl: fetchReturning(jsonResponse(500, {})),
            }),
        ).rejects.toBeInstanceOf(CvServiceUnavailable);
    });

    it('throws CvServiceUnavailable when polylines is missing', async () => {
        await expect(
            vectorizeViaService(IMAGE, PARAMS, {
                fetchImpl: fetchReturning(jsonResponse(200, { width: 10, height: 10 })),
            }),
        ).rejects.toBeInstanceOf(CvServiceUnavailable);
    });

    it('throws CvServiceUnavailable when polylines is not an array', async () => {
        await expect(
            vectorizeViaService(IMAGE, PARAMS, {
                fetchImpl: fetchReturning(jsonResponse(200, { polylines: 'nope' })),
            }),
        ).rejects.toBeInstanceOf(CvServiceUnavailable);
    });

    it('throws CvServiceUnavailable when a point is not an [x, y] pair', async () => {
        await expect(
            vectorizeViaService(IMAGE, PARAMS, {
                fetchImpl: fetchReturning(
                    jsonResponse(200, { polylines: [[[0, 0], [1]]] }),
                ),
            }),
        ).rejects.toBeInstanceOf(CvServiceUnavailable);
    });

    it('throws CvServiceUnavailable when a coordinate is non-numeric', async () => {
        await expect(
            vectorizeViaService(IMAGE, PARAMS, {
                fetchImpl: fetchReturning(
                    jsonResponse(200, { polylines: [[['a', 'b']]] }),
                ),
            }),
        ).rejects.toBeInstanceOf(CvServiceUnavailable);
    });
});

// -----------------------------------------------------------------------------
// FormData field names
// -----------------------------------------------------------------------------

describe('vectorizeViaService — request shape', () => {
    it('POSTs to ${baseUrl}/vectorize with the expected FormData field names', async () => {
        let capturedUrl = '';
        let capturedBody: FormData | undefined;
        const spyFetch = (async (url: string, init?: RequestInit) => {
            capturedUrl = url;
            capturedBody = init?.body as FormData;
            return jsonResponse(200, { width: 1, height: 1, polylines: [] });
        }) as unknown as typeof fetch;

        await vectorizeViaService(IMAGE, PARAMS, {
            baseUrl: 'http://localhost:9999',
            fetchImpl: spyFetch,
        });

        expect(capturedUrl).toBe('http://localhost:9999/vectorize');
        expect(capturedBody).toBeInstanceOf(FormData);
        // Field names must match the FastAPI endpoint (file, mode, detail,
        // contrast, threshold, tone_bands — camelCase toneBands → tone_bands).
        expect(capturedBody!.get('file')).toBeInstanceOf(Blob);
        expect(capturedBody!.get('mode')).toBe('both');
        expect(capturedBody!.get('detail')).toBe('0.5');
        expect(capturedBody!.get('contrast')).toBe('1');
        expect(capturedBody!.get('tone_bands')).toBe('2');
        // threshold was not supplied → not sent (service defaults it).
        expect(capturedBody!.has('threshold')).toBe(false);
    });

    it('maps hatch params (runSpacing/whiteThreshold/edgePaths) to snake_case fields', async () => {
        let capturedBody: FormData | undefined;
        const spyFetch = (async (_url: string, init?: RequestInit) => {
            capturedBody = init?.body as FormData;
            return jsonResponse(200, { width: 1, height: 1, polylines: [] });
        }) as unknown as typeof fetch;

        await vectorizeViaService(
            IMAGE,
            { mode: 'hatch', runSpacing: 5, whiteThreshold: 230, edgePaths: true },
            { fetchImpl: spyFetch },
        );

        expect(capturedBody!.get('mode')).toBe('hatch');
        expect(capturedBody!.get('run_spacing')).toBe('5');
        expect(capturedBody!.get('white_threshold')).toBe('230');
        expect(capturedBody!.get('edge_paths')).toBe('true');
    });

    it('maps localContrast to the local_contrast field', async () => {
        let capturedBody: FormData | undefined;
        const spyFetch = (async (_url: string, init?: RequestInit) => {
            capturedBody = init?.body as FormData;
            return jsonResponse(200, { width: 1, height: 1, polylines: [] });
        }) as unknown as typeof fetch;

        await vectorizeViaService(
            IMAGE,
            { mode: 'zigzag', localContrast: 2.5 },
            { fetchImpl: spyFetch },
        );

        expect(capturedBody!.get('local_contrast')).toBe('2.5');
    });

    it('defaults to DEFAULT_CV_SERVICE_URL when no baseUrl is given', async () => {
        let capturedUrl = '';
        const spyFetch = (async (url: string) => {
            capturedUrl = url;
            return jsonResponse(200, { width: 1, height: 1, polylines: [] });
        }) as unknown as typeof fetch;

        await vectorizeViaService(IMAGE, { mode: 'skeleton' }, { fetchImpl: spyFetch });
        expect(capturedUrl).toBe(`${DEFAULT_CV_SERVICE_URL}/vectorize`);
    });
});

// -----------------------------------------------------------------------------
// isServiceAvailable
// -----------------------------------------------------------------------------

describe('isServiceAvailable', () => {
    it('returns true on a 200 {status:"ok"} response', async () => {
        const ok = await isServiceAvailable({
            fetchImpl: fetchReturning(
                jsonResponse(200, { status: 'ok', version: '1', cv2: '4.13' }),
            ),
        });
        expect(ok).toBe(true);
    });

    it('returns false on a non-2xx response (never throws)', async () => {
        const ok = await isServiceAvailable({
            fetchImpl: fetchReturning(jsonResponse(503, {})),
        });
        expect(ok).toBe(false);
    });

    it('returns false when status is not "ok"', async () => {
        const ok = await isServiceAvailable({
            fetchImpl: fetchReturning(jsonResponse(200, { status: 'degraded' })),
        });
        expect(ok).toBe(false);
    });

    it('returns false on fetch rejection (never throws)', async () => {
        const ok = await isServiceAvailable({ fetchImpl: fetchRejecting() });
        expect(ok).toBe(false);
    });
});

// -----------------------------------------------------------------------------
// Cost check on the real Chebyshev metric (Property 8 wiring)
// -----------------------------------------------------------------------------

describe('mapped polylines feed the real PathPlanner cost metric', () => {
    it('totalStepCount of the planned path is a finite number', async () => {
        const body = {
            width: 100,
            height: 100,
            polylines: [
                [[0, 0], [40, 0], [40, 30]],
                [[10, 10], [50, 60]],
            ],
        };
        const mapped: Polyline[] = await vectorizeViaService(IMAGE, PARAMS, {
            fetchImpl: fetchReturning(jsonResponse(200, body)),
        });

        const planner = new PathPlanner();
        const path = planner.plan(
            { polylines: mapped },
            { envelopeSteps: { x: 1640, y: 1220 } },
        );
        const steps = totalStepCount(path);
        expect(Number.isFinite(steps)).toBe(true);
        expect(steps).toBeGreaterThan(0);
    });
});
