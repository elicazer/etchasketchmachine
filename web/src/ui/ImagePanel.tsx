/**
 * `ImagePanel` — the image-import side panel of the SPA.
 *
 * Deliberately minimal: the user picks a file and the app does the rest. There
 * are no scale / rotation / position / threshold knobs — an imported image is
 * turned into line art with sensible automatic defaults and auto-fitted to the
 * drawable area by the controller (see `fitPolylinesToDrawable`). Because an
 * Etch-a-Sketch can only draw a continuous line, a raster photo is reduced to
 * its edges automatically; the user never configures that.
 *
 *   - Accepts PNG / JPEG / BMP / SVG; rejects anything else with a clear
 *     message (Req 2.5), oversize files (Req 2.6), and unreadable bytes
 *     (Req 2.7).
 *   - Raster files run through the (lazy-loaded) edge detector with fixed
 *     default thresholds; SVG files are extracted as vectors directly.
 *
 * @see Design §3.1.1
 * @see Requirements 2.1, 2.2, 2.5, 2.6, 2.7, 4.8
 */

import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import type { Polyline } from '../types';
import { SHADE_ROWS_DEFAULT } from '../image/image_processor';
import { extractSvgPolylines } from '../image/svg_extractor';
import {
    vectorizeViaService,
    CvServiceUnavailable,
} from '../image/cv_service_client';
import { resolveCvServiceUrl } from '../app/config';
import { validateImageFile, IMAGE_ALLOWED_FORMATS } from '../validators';

/**
 * Image tracing styles — every one routes through the local CV sidecar.
 * `'portrait'` tonal serpentine fill (photos), `'wave'` Engineezy continuous
 * scanlines, `'zigzag'` outline + straight-line fill, `'logo'` clean single-
 * line outlines for logos / line art.
 */
type Style = 'logo' | 'portrait' | 'wave' | 'zigzag';

/**
 * Banner shown when the CV-service style is selected but the local Python
 * sidecar isn't reachable. The app falls back to browser tracing so the user
 * still gets a (degraded) result.
 */
const CV_SERVICE_DOWN_MESSAGE =
    'Image service not running. Start tools/imagepath_service/run.sh, then retry.';

/**
 * Map the shading-detail slider (40..200 rows) onto the hatch `run_spacing`
 * (px between serpentine fill lines at the lightest band). MORE detail → a
 * SMALLER spacing → denser fill → more steps. Range 11px (sparsest) .. 6px
 * (densest).
 *
 * Shifted sparser than the original 9px..4px range for the PHYSICAL device:
 * on the real screen, knob resolution + backlash blur or skip 4–6px-spaced
 * lines, so the densest end now bottoms out at 6px (still resolvable) and the
 * default sits sparser. The Detail slider still lets the user push denser.
 */
function shadeRowsToRunSpacing(shadeRows: number): number {
    const clamped = Math.max(40, Math.min(200, shadeRows));
    const frac = (clamped - 40) / (200 - 40); // 0 at 40 rows, 1 at 200 rows
    return 11 - frac * 5; // 11px → 6px as detail rises
}

/**
 * Default contrast (1.0 = no boost) applied before the tonal CV styles
 * vectorize. Higher values crush mid-tones toward a cleaner silhouette; the
 * slider lets the user dial up to 4.0×.
 */
const DEFAULT_CONTRAST = 1;

/** User-facing message for an unreadable / corrupt upload (Req 2.7). */
const CORRUPT_MESSAGE =
    'That image could not be read. Try a different file.';

/**
 * Default "Detail boost" (CLAHE clip limit) for the tonal CV styles. 3.5 is the
 * point where local-contrast recovery of in-region detail (eyes/grille on a dark
 * mask, soft shadows) becomes clearly visible without the grit that sets in
 * higher up (~5+). Lower values (~2) sit in a dead zone — they flatten
 * large-scale tone before edge recovery kicks in. 0 disables it.
 */
const DETAIL_BOOST_DEFAULT = 3.5;
const DETAIL_BOOST_MAX = 6;

export interface ImagePanelProps {
    /** Called with the produced polylines whenever an image is imported. */
    onPolylines?: (polylines: Polyline[]) => void;
    /** Called with the current error message, or `null` when cleared. */
    onError?: (message: string | null) => void;
    /**
     * When supplied, the panel mounts as if the user just picked this
     * file: it runs through the existing `handleFile` pipeline once on
     * first render so the tracing controls (mode / contrast / shading
     * detail) appear and `onPolylines` fires with the initial trace.
     *
     * Used by the post-commit "edit settings" path: when the Add-image
     * modal re-opens on an existing image item, the original `File` is
     * looked up in the session-scoped image source cache and passed in
     * here so the user can re-vectorise without re-picking the file.
     * Omitted in the normal "add" flow; tests that don't drive a file
     * input continue to work unchanged.
     */
    initialFile?: File;
}

export function ImagePanel(props: ImagePanelProps): JSX.Element {
    const { onPolylines, onError, initialFile } = props;

    const [fileName, setFileName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Contrast boost applied before edge detection. Higher = less detail.
    const [contrast, setContrast] = useState(DEFAULT_CONTRAST);
    // Tracing style. Default to "Portrait" — the tonal serpentine hatch fill
    // (Engineezy look). It chains scan rows into long continuous ribbons with
    // few direction reversals, so the PHYSICAL device reproduces it cleanly
    // instead of the scribble that disconnected outline/AI strokes produce once
    // the knobs' backlash drifts the hidden travel into exposed ink.
    const [mode, setMode] = useState<Style>('portrait');
    // Row count for the tonal fill styles (detail vs. draw time).
    const [shadeRows, setShadeRows] = useState(SHADE_ROWS_DEFAULT);
    // Local-contrast (CLAHE) boost for the tonal CV styles: recovers subtle
    // in-region detail (a dark mask's eyes/grille, soft shadows) that the global
    // banding would otherwise crush into a solid fill. 0 = off. Default on.
    const [detailBoost, setDetailBoost] = useState(DETAIL_BOOST_DEFAULT);
    // Retain the last raster file so changing a control re-traces it.
    const [lastRaster, setLastRaster] = useState<File | null>(null);

    function report(message: string | null): void {
        setError(message);
        onError?.(message);
    }

    async function handleFile(file: File | null): Promise<void> {
        report(null);
        if (!file) return;
        setFileName(file.name);

        const result = validateImageFile(file);
        if (!result.ok) {
            report(result.reason); // unsupported format / oversize
            return;
        }

        setBusy(true);
        try {
            if (result.value.format === 'svg') {
                await handleSvg(file);
            } else {
                await handleRaster(file);
            }
        } finally {
            setBusy(false);
        }
    }

    async function handleSvg(file: File): Promise<void> {
        try {
            const text =
                typeof file.text === 'function'
                    ? await file.text()
                    : await new Response(file).text();
            const { polylines } = extractSvgPolylines(text);
            if (polylines.length === 0) {
                report('No drawable shapes were found in that SVG.');
                return;
            }
            onPolylines?.(polylines);
        } catch {
            report(CORRUPT_MESSAGE);
        }
    }

    async function handleRaster(file: File): Promise<void> {
        setLastRaster(file);
        await traceViaCvService(file, {
            contrast,
            shadeRows,
            detailBoost,
            style: mode,
        });
    }

    /**
     * Send the retained raster to the local CV sidecar. On success, feed the
     * pixel-space polylines straight into `onPolylines` (the controller fits
     * them to the drawable envelope). When the service is unreachable, surface
     * a clear banner prompting the user to start the local service.
     */
    async function traceViaCvService(
        file: File,
        o: {
            contrast: number;
            shadeRows: number;
            detailBoost: number;
            style: Style;
        },
    ): Promise<void> {
        const baseUrl = resolveCvServiceUrl(window.location);
        try {
            // A File is a Blob, so it can be POSTed directly.
            const params =
                o.style === 'zigzag'
                    ? {
                        // Perimeter + fill: a clean subject outline and feature
                        // edges, with a STRAIGHT zig-zag tonal fill bounded
                        // inside it (machine-friendly diagonals).
                        mode: 'zigzag' as const,
                        runSpacing: shadeRowsToRunSpacing(o.shadeRows),
                        contrast: o.contrast,
                        isolateSubject: true,
                        // Recover subtle in-region detail (mask eyes/grille,
                        // soft shadows) the global banding would crush.
                        localContrast: o.detailBoost,
                        // Fill coverage. The dataclass default (130) only inks
                        // genuinely dark tones, which on a light/mid subject (a
                        // grey jet, a white print) leaves the fill skeletal. 160
                        // admits mid-tones so the subject reads FULL — and the
                        // machine thickens every line, so a fuller digital fill
                        // is what lands as a complete drawing on the screen.
                        whiteThreshold: 160,
                    }
                    : o.style === 'wave'
                    ? {
                        // Engineezy continuous-line look: full-width horizontal
                        // scan rows whose wave amplitude tracks local darkness.
                        // One long stroke per row → fast + few reversals, with
                        // tonal detail. The Detail slider drives row spacing.
                        mode: 'wave' as const,
                        runSpacing: shadeRowsToRunSpacing(o.shadeRows),
                        contrast: o.contrast,
                        localContrast: o.detailBoost,
                        // Pull the subject off a busy background (GrabCut) and
                        // stretch its tonal range, so a light subject on a
                        // cluttered scene still reads. Falls back to the whole
                        // frame when isolation is not confident.
                        isolateSubject: true,
                    }
                    : o.style === 'logo'
                    ? {
                        // Line-art / logo: ONE clean outline per shape — crisp
                        // letters WITH their counters (O/R holes) plus a mascot
                        // WITH its eyes, and no doubled inner+outer stroke edges.
                        // Pairs with the alpha-matte decode so a white-on-
                        // transparent logo is traced as dark ink on white paper.
                        mode: 'lineart' as const,
                        detail: 0.65,
                    }
                    : {
                        // Tonal hatch fill — the Engineezy portrait look:
                        // dense serpentine lines where dark, blank
                        // highlights, plus a Canny edge pass for features.
                        // The Detail slider drives line spacing (more
                        // detail = smaller spacing = denser).
                        mode: 'hatch' as const,
                        runSpacing: shadeRowsToRunSpacing(o.shadeRows),
                        // 3 tonal bands (was 4): fewer, cleaner tonal layers
                        // so the physical device resolves each band distinctly
                        // instead of smearing four near-identical densities.
                        toneBands: 3,
                        // Pin to the service default (130): only genuinely dark
                        // tones (hat, hair, eyebrows, deep shadows, gear gaps)
                        // fill; the neutral-gray studio backdrop (~165) and
                        // bright skin (~200) stay blank — matching the
                        // reference's pure-white background.
                        whiteThreshold: 130,
                        edgePaths: true,
                        contrast: o.contrast,
                        localContrast: o.detailBoost,
                        // Isolate the subject from a busy background so the fill
                        // shades it, not the surround (falls back when unsure).
                        isolateSubject: true,
                    };
            const polys = await vectorizeViaService(file, params, { baseUrl });
            onPolylines?.(polys);
        } catch (err) {
            if (err instanceof CvServiceUnavailable) {
                report(CV_SERVICE_DOWN_MESSAGE);
                return;
            }
            const message =
                err instanceof Error && err.message ? err.message : CORRUPT_MESSAGE;
            report(message);
        }
    }

    /**
     * Re-trace the retained raster file when a tracing control changes. Pass
     * the current control values (callers supply the just-changed value since
     * the corresponding state update is async).
     */
    async function reprocessRaster(o: {
        contrast: number;
        mode: Style;
        shadeRows: number;
        detailBoost: number;
    }): Promise<void> {
        if (!lastRaster) return;
        setBusy(true);
        report(null);
        try {
            await traceViaCvService(lastRaster, {
                contrast: o.contrast,
                shadeRows: o.shadeRows,
                detailBoost: o.detailBoost,
                style: o.mode,
            });
        } finally {
            setBusy(false);
        }
    }

    function onFileChange(ev: JSX.TargetedEvent<HTMLInputElement>): void {
        const input = ev.currentTarget;
        const file = input.files && input.files.length > 0 ? input.files[0] : null;
        void handleFile(file ?? null);
    }

    /**
     * Edit-mode bootstrap: when the panel is mounted with an `initialFile`
     * (the post-commit "edit settings" path opened from the items list),
     * run the file through the existing pipeline once on first render so
     * the user sees the tracing controls populated and the initial trace
     * fires through `onPolylines`. Subsequent re-traces flow through the
     * normal control-change handlers (`reprocessRaster`).
     *
     * Empty dep array — we want this to fire exactly once even if a
     * parent re-renders the modal contents. Dropping `initialFile` from
     * deps is intentional; the file is captured as a snapshot at modal
     * open time and never expected to change for the lifetime of the
     * panel mount. A new edit session unmounts and remounts the panel.
     */
    useEffect(() => {
        if (initialFile !== undefined) {
            void handleFile(initialFile);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const acceptAttr = IMAGE_ALLOWED_FORMATS.map((f) =>
        f === 'jpeg' ? '.jpg,.jpeg' : `.${f}`,
    ).join(',');

    return (
        <section class="image-panel" aria-label="Import image">
            <h2>Import image</h2>

            <label class="image-panel__drop">
                <input
                    type="file"
                    data-testid="image-file"
                    accept={acceptAttr}
                    onChange={onFileChange}
                />
                <span>{busy ? 'Processing…' : 'Choose an image or SVG'}</span>
            </label>

            <p class="hint">PNG, JPEG, BMP or SVG · up to 10 MB · fitted automatically</p>

            {lastRaster !== null && mode !== 'logo' && (
                <div class="image-panel__contrast" data-testid="image-contrast">
                    <label for="image-contrast-range">
                        Detail (contrast): {contrast.toFixed(1)}×
                    </label>
                    <input
                        id="image-contrast-range"
                        type="range"
                        min={1}
                        max={4}
                        step={0.5}
                        value={contrast}
                        disabled={busy}
                        onInput={(e) => {
                            const v = Number(
                                (e.currentTarget as HTMLInputElement).value,
                            );
                            setContrast(v);
                            void reprocessRaster({
                                contrast: v,
                                mode,
                                shadeRows,
                                detailBoost,
                            });
                        }}
                    />
                    <span class="hint">
                        Higher contrast = fewer lines / less detail.
                    </span>
                </div>
            )}

            {lastRaster !== null && (
                <div class="image-panel__mode" data-testid="image-mode">
                    <label for="image-mode-select">Style</label>
                    <select
                        id="image-mode-select"
                        data-testid="image-mode-select"
                        value={mode}
                        disabled={busy}
                        onChange={(e) => {
                            const next = (e.currentTarget as HTMLSelectElement)
                                .value as Style;
                            setMode(next);
                            void reprocessRaster({
                                contrast,
                                mode: next,
                                shadeRows,
                                detailBoost,
                            });
                        }}
                    >
                        <option value="portrait">Portrait — serpentine fill (best for photos)</option>
                        <option value="wave">Wave lines — Engineezy style (clean background)</option>
                        <option value="zigzag">Zigzag — outline + straight-line fill</option>
                        <option value="logo">Logo / line art — single-line outlines</option>
                    </select>
                    <span class="hint">
                        Portrait, Wave and Zigzag shade photos with continuous
                        lines the machine draws cleanly. Logo traces a clean
                        single-line outline — pick it for logos and line art.
                    </span>
                </div>
            )}

            {lastRaster !== null && mode !== 'logo' && (
                <div class="image-panel__shade" data-testid="image-shade">
                    <label for="image-shade-range">
                        Detail: {shadeRows} lines
                    </label>
                    <input
                        id="image-shade-range"
                        type="range"
                        min={40}
                        max={200}
                        step={10}
                        value={shadeRows}
                        disabled={busy}
                        onInput={(e) => {
                            const v = Number(
                                (e.currentTarget as HTMLInputElement).value,
                            );
                            setShadeRows(v);
                            void reprocessRaster({
                                contrast,
                                mode,
                                shadeRows: v,
                                detailBoost,
                            });
                        }}
                    />
                    <span class="hint">
                        More detail = more contours/curves, but longer to draw.
                    </span>
                </div>
            )}

            {lastRaster !== null && mode !== 'logo' && (
                    <div
                        class="image-panel__detail-boost"
                        data-testid="image-detail-boost"
                    >
                        <label for="image-detail-boost-range">
                            Detail boost: {detailBoost.toFixed(1)}
                            {detailBoost === 0 ? ' (off)' : ''}
                        </label>
                        <input
                            id="image-detail-boost-range"
                            type="range"
                            min={0}
                            max={DETAIL_BOOST_MAX}
                            step={0.5}
                            value={detailBoost}
                            disabled={busy}
                            onInput={(e) => {
                                const v = Number(
                                    (e.currentTarget as HTMLInputElement).value,
                                );
                                setDetailBoost(v);
                                void reprocessRaster({
                                    contrast,
                                    mode,
                                    shadeRows,
                                    detailBoost: v,
                                });
                            }}
                        />
                        <span class="hint">
                            Recovers shadows &amp; small details inside dark/flat
                            areas (e.g. a mask's eyes, grille). Higher = more
                            detail; too high can look gritty.
                        </span>
                    </div>
                )}

            {fileName !== null && error === null ? (
                <p class="filename" data-testid="file-name">
                    {fileName}
                </p>
            ) : null}
            {error !== null ? (
                <p class="error" role="alert" data-testid="file-error">
                    {error}
                </p>
            ) : null}
        </section>
    );
}

export default ImagePanel;
