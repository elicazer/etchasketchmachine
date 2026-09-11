import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'preact';

/**
 * Unit tests for the simplified {@link ImagePanel}.
 *
 * The panel is a file picker: pick an image/SVG and it is traced by the local
 * CV sidecar with automatic defaults. Every style routes through the service —
 * there is no browser-tracing fallback. Coverage:
 *   - unsupported format is rejected with a message and emits nothing (Req 2.5);
 *   - oversize files are rejected (Req 2.6);
 *   - a corrupt upload the service rejects surfaces an error (Req 2.7);
 *   - a valid raster traces via the CV service and emits its polylines;
 *   - when the CV service is down, a banner is shown and nothing is emitted.
 *
 * `../image/image_processor` is mocked so the test never touches the real
 * canvas decode path or lazily-loads opencv.js under jsdom.
 */

vi.mock('../image/image_processor', () => ({
    SHADE_ROWS_DEFAULT: 110,
}));

vi.mock('../image/cv_service_client', () => {
    class CvServiceUnavailable extends Error {
        constructor(message = 'The local image service is unavailable.') {
            super(message);
            this.name = 'CvServiceUnavailable';
        }
    }
    return {
        CvServiceUnavailable,
        vectorizeViaService: vi.fn(),
        DEFAULT_CV_SERVICE_URL: 'http://localhost:8765',
    };
});

import { ImagePanel } from './ImagePanel';
import {
    vectorizeViaService,
    CvServiceUnavailable,
} from '../image/cv_service_client';

let container: HTMLDivElement;

beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    render(null, container);
    container.remove();
});

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function q(testid: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testid}"]`);
}

function input(testid: string): HTMLInputElement {
    const el = q(testid);
    if (!el) throw new Error(`missing input: ${testid}`);
    return el as HTMLInputElement;
}

function selectFile(file: File): void {
    const el = input('image-file');
    Object.defineProperty(el, 'files', { value: [file], configurable: true });
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fileWithSize(name: string, type: string, size: number): File {
    const f = new File(['x'], name, { type });
    Object.defineProperty(f, 'size', { value: size, configurable: true });
    return f;
}

describe('ImagePanel', () => {
    it('rejects an unsupported format and emits nothing (Req 2.5)', async () => {
        const onPolylines = vi.fn();
        const onError = vi.fn();
        render(<ImagePanel onPolylines={onPolylines} onError={onError} />, container);

        selectFile(new File(['gif87a'], 'evil.gif', { type: 'image/gif' }));
        await flush();

        const errEl = q('file-error');
        expect(errEl).not.toBeNull();
        expect(errEl?.textContent).toMatch(/unsupported format/i);
        expect(onPolylines).not.toHaveBeenCalled();
        expect(vectorizeViaService).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(
            expect.stringMatching(/unsupported format/i),
        );
    });

    it('rejects an oversize file (Req 2.6)', async () => {
        const onPolylines = vi.fn();
        render(<ImagePanel onPolylines={onPolylines} />, container);

        selectFile(fileWithSize('huge.png', 'image/png', 11 * 1024 * 1024));
        await flush();

        const errEl = q('file-error');
        expect(errEl).not.toBeNull();
        expect(errEl?.textContent).toMatch(/10 MB limit/i);
        expect(onPolylines).not.toHaveBeenCalled();
        expect(vectorizeViaService).not.toHaveBeenCalled();
    });

    it('uses the CV service by default and emits its polylines', async () => {
        const cvPolys = [[{ x: 2, y: 3 }, { x: 9, y: 9 }]];
        vi.mocked(vectorizeViaService).mockResolvedValueOnce(cvPolys);

        const onPolylines = vi.fn();
        render(<ImagePanel onPolylines={onPolylines} />, container);

        selectFile(new File(['pngbytes'], 'pic.png', { type: 'image/png' }));
        await flush();

        expect(vectorizeViaService).toHaveBeenCalledTimes(1);
        // The File (a Blob) is passed straight to the client with the tonal-hatch
        // portrait defaults (mode 'hatch' + edge passes) — the default style.
        const [imgArg, paramsArg] = vi.mocked(vectorizeViaService).mock.calls[0]!;
        expect(imgArg).toBeInstanceOf(Blob);
        expect(paramsArg.mode).toBe('hatch');
        expect(paramsArg.edgePaths).toBe(true);
        // Detail-boost (local contrast) is on by default for the tonal styles.
        expect(paramsArg.localContrast).toBeGreaterThan(0);
        expect(onPolylines).toHaveBeenLastCalledWith(cvPolys);
        expect(q('file-error')).toBeNull();
    });

    it('traces a logo with the single-line lineart style', async () => {
        vi.mocked(vectorizeViaService).mockResolvedValue([]);

        render(<ImagePanel onPolylines={vi.fn()} />, container);
        // First import so the Style selector renders.
        selectFile(new File(['pngbytes'], 'first.png', { type: 'image/png' }));
        await flush();

        const select = input('image-mode-select') as unknown as HTMLSelectElement;
        select.value = 'logo';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();

        const lastParams = vi.mocked(vectorizeViaService).mock.calls.at(-1)![1];
        expect(lastParams.mode).toBe('lineart');
    });

    it('surfaces an error when the service rejects a corrupt upload (Req 2.7)', async () => {
        vi.mocked(vectorizeViaService).mockRejectedValueOnce(new Error('boom'));

        const onPolylines = vi.fn();
        render(<ImagePanel onPolylines={onPolylines} />, container);

        selectFile(new File(['notreallypng'], 'pic.png', { type: 'image/png' }));
        await flush();

        const errEl = q('file-error');
        expect(errEl).not.toBeNull();
        expect(errEl?.textContent ?? '').toMatch(/boom|could not be read/i);
        expect(onPolylines).not.toHaveBeenCalled();
    });

    it('shows a banner and emits nothing when the CV service is down (Req 5.1)', async () => {
        vi.mocked(vectorizeViaService).mockRejectedValueOnce(
            new CvServiceUnavailable(),
        );

        const onPolylines = vi.fn();
        render(<ImagePanel onPolylines={onPolylines} />, container);

        selectFile(new File(['pngbytes'], 'pic.png', { type: 'image/png' }));
        await flush();

        // Banner is shown prompting the user to start the local service...
        const errEl = q('file-error');
        expect(errEl).not.toBeNull();
        expect(errEl?.textContent).toMatch(/image service not running/i);
        // ...and, with no browser fallback, nothing is emitted.
        expect(onPolylines).not.toHaveBeenCalled();
    });
});
