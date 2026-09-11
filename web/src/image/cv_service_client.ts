/**
 * Web client for the local Python CV sidecar service.
 *
 * The browser no longer runs computer vision. Instead it POSTs an image plus a
 * few parameters to a local FastAPI service (`tools/imagepath_service/`) running
 * real `cv2` + `scikit-image`, and receives ready-to-draw polylines as JSON in
 * image-pixel space. Those polylines feed the EXISTING, unchanged web pipeline
 * (`fitPolylinesToEnvelope` → `PathPlanner.plan` → `totalStepCount`).
 *
 * This module is intentionally tiny and dependency-free: it uses the platform
 * `fetch` (injectable for tests) and maps the JSON response to the existing
 * {@link Polyline} type. On any network failure, non-2xx status, or schema
 * mismatch it throws {@link CvServiceUnavailable} so the UI can fall back to the
 * browser-native generators.
 *
 * @see Design §"Components and Interfaces" → "New: web client"
 * @see Design §"Correctness Properties" 6 (mapping fidelity), 7 (fallback), 8 (cost)
 * @see Requirements 5.1, 5.4, 3.1, 6.1, 6.2
 */

import type { Polyline } from '../types';

/** Configurable service base URL (default http://localhost:8765). */
export const DEFAULT_CV_SERVICE_URL = 'http://localhost:8765';

/**
 * Parameters forwarded to `POST /vectorize`. Only the fields the web side
 * supports are sent; the service defaults the rest (blur_sigma, max_dim,
 * min_stroke_len, …). camelCase fields are mapped to the snake_case form-field
 * names the FastAPI endpoint reads.
 */
export interface VectorizeParams {
    /** Primary = skeleton/both; `lineart` = clean single-line outlines for logos / line art; `hatch` = tonal serpentine fill (portraits); `wave` = Engineezy continuous scanlines; `zigzag` = outline + straight-line fill. */
    mode: 'skeleton' | 'contour' | 'both' | 'lineart' | 'hatch' | 'wave' | 'zigzag';
    /** 0..1 → epsilon / min_stroke_len budget. */
    detail?: number;
    /** Contrast multiplier around mid-gray. */
    contrast?: number;
    /** 0 = auto (Otsu); else explicit 0..255. */
    threshold?: number;
    /** Small number of dark bands to isolate. */
    toneBands?: number;
    /** hatch: base fill-line spacing in px (smaller = denser = more steps). */
    runSpacing?: number;
    /** hatch: pixels >= this (0..255) are highlights and never filled. */
    whiteThreshold?: number;
    /** hatch: add a Canny edge pass (features/outline) on top of the fill. */
    edgePaths?: boolean;
    /** wave/hatch: isolate the subject from a busy background via GrabCut. */
    isolateSubject?: boolean;
    /** CLAHE clip limit; >0 boosts local contrast to recover in-region detail. */
    localContrast?: number;
}

/** Options shared by the service calls. `fetchImpl` is injectable for tests. */
export interface CvServiceOpts {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
}

/**
 * Raised when the local CV service is unreachable, returns an error status, or
 * returns a body that doesn't match the expected schema. Callers catch this to
 * fall back to the browser-native generators.
 */
export class CvServiceUnavailable extends Error {
    constructor(message = 'The local image service is unavailable.') {
        super(message);
        this.name = 'CvServiceUnavailable';
        // Restore the prototype chain for `instanceof` across transpile targets.
        Object.setPrototypeOf(this, CvServiceUnavailable.prototype);
    }
}

/** Shape of the `POST /vectorize` JSON response (image-pixel space). */
interface VectorizeResponse {
    width: number;
    height: number;
    polylines: number[][][];
}

/**
 * Build the multipart FormData for `POST /vectorize`. The image is sent as the
 * `file` field; supported params are mapped to the snake_case field names the
 * FastAPI endpoint reads. Unsupported fields are omitted so the service applies
 * its defaults.
 */
function buildFormData(image: Blob, params: VectorizeParams): FormData {
    const form = new FormData();
    form.append('file', image);
    form.append('mode', params.mode);
    if (params.detail !== undefined) form.append('detail', String(params.detail));
    if (params.contrast !== undefined) form.append('contrast', String(params.contrast));
    if (params.threshold !== undefined) form.append('threshold', String(params.threshold));
    if (params.toneBands !== undefined) form.append('tone_bands', String(params.toneBands));
    if (params.runSpacing !== undefined) form.append('run_spacing', String(params.runSpacing));
    if (params.whiteThreshold !== undefined)
        form.append('white_threshold', String(params.whiteThreshold));
    if (params.edgePaths !== undefined) form.append('edge_paths', String(params.edgePaths));
    if (params.isolateSubject !== undefined)
        form.append('isolate_subject', String(params.isolateSubject));
    if (params.localContrast !== undefined)
        form.append('local_contrast', String(params.localContrast));
    return form;
}

/**
 * Validate a parsed body against the expected {@link VectorizeResponse} schema
 * and map `polylines: number[][][]` → {@link Polyline}[] (`{x,y}[][]`),
 * preserving every coordinate exactly.
 *
 * @throws {CvServiceUnavailable} if the body is missing `polylines`, it isn't
 *         an array, or any point isn't a numeric `[x, y]` pair.
 */
function mapResponse(body: unknown): Polyline[] {
    if (typeof body !== 'object' || body === null) {
        throw new CvServiceUnavailable('Malformed response from image service.');
    }
    const polylines = (body as { polylines?: unknown }).polylines;
    if (!Array.isArray(polylines)) {
        throw new CvServiceUnavailable('Malformed response: polylines missing or not an array.');
    }

    const result: Polyline[] = [];
    for (const poly of polylines) {
        if (!Array.isArray(poly)) {
            throw new CvServiceUnavailable('Malformed response: polyline is not an array.');
        }
        const mapped: Polyline = [];
        for (const pt of poly) {
            if (
                !Array.isArray(pt) ||
                pt.length < 2 ||
                typeof pt[0] !== 'number' ||
                typeof pt[1] !== 'number' ||
                !Number.isFinite(pt[0]) ||
                !Number.isFinite(pt[1])
            ) {
                throw new CvServiceUnavailable('Malformed response: point is not a numeric [x, y] pair.');
            }
            mapped.push({ x: pt[0], y: pt[1] });
        }
        result.push(mapped);
    }
    return result;
}

/**
 * POST an image to the local CV sidecar and map the JSON response to the
 * existing {@link Polyline}[] type (image-pixel space). The result feeds the
 * existing `fitPolylinesToEnvelope` → `PathPlanner.plan` pipeline directly.
 *
 * @throws {CvServiceUnavailable} on fetch rejection, non-2xx status, or a body
 *         that doesn't match the expected schema.
 */
export async function vectorizeViaService(
    image: Blob,
    params: VectorizeParams,
    opts?: CvServiceOpts,
): Promise<Polyline[]> {
    const baseUrl = opts?.baseUrl ?? DEFAULT_CV_SERVICE_URL;
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const form = buildFormData(image, params);

    let res: Response;
    try {
        res = await fetchImpl(`${baseUrl}/vectorize`, { method: 'POST', body: form });
    } catch (err) {
        throw new CvServiceUnavailable(
            `Could not reach the image service: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!res.ok) {
        throw new CvServiceUnavailable(`Image service returned HTTP ${res.status}.`);
    }

    let body: unknown;
    try {
        body = await res.json();
    } catch {
        throw new CvServiceUnavailable('Image service returned an unreadable body.');
    }

    return mapResponse(body);
}

/**
 * Lightweight reachability probe against `GET /health`. Returns true iff the
 * response is 2xx and the body's `status` is `"ok"`. Never throws — any failure
 * resolves to false so callers can treat it as "service down".
 */
export async function isServiceAvailable(opts?: CvServiceOpts): Promise<boolean> {
    const baseUrl = opts?.baseUrl ?? DEFAULT_CV_SERVICE_URL;
    const fetchImpl = opts?.fetchImpl ?? fetch;

    try {
        const res = await fetchImpl(`${baseUrl}/health`, { method: 'GET' });
        if (!res.ok) return false;
        const body = (await res.json()) as { status?: unknown };
        return body?.status === 'ok';
    } catch {
        return false;
    }
}
