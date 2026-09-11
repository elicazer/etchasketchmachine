/**
 * `TextPanel` — the text-input UI panel (Req 3.1–3.6).
 *
 * Responsibilities:
 *   - capture 1–200 characters of text (Req 3.1, validated by `validateText`);
 *   - let the user pick one of the ≥ 5 bundled single-line stroke fonts
 *     exposed by `Text_Renderer.fonts()` (Req 3.2);
 *   - expose font-size (5–100 mm) and letter-spacing (0–200 %) controls
 *     (Req 3.3, validated by `validateFontSizeMm` / `validateLetterSpacingPct`);
 *   - re-run `Text_Renderer.render` on every parameter change and emit the
 *     resulting positioned polylines upward through `onPolylinesChange`
 *     so the App/Canvas can repaint the live preview (Req 3.4);
 *   - highlight codepoints the chosen font cannot draw and surface the
 *     renderer's suggested covering font (Req 3.5);
 *   - disable the draw action while the text is empty or whitespace-only
 *     and show a "text required" hint (Req 3.6).
 *
 * The panel owns *only* the text-input controls. It does not paint the
 * canvas itself — that is the job of App/Canvas, which receives the
 * preview polylines through `onPolylinesChange` and the committed
 * polylines through `onDraw`.
 *
 * The renderer is injectable (`renderer` prop) so hosts and tests can
 * supply a stub; it defaults to a fresh `createTextRenderer()`.
 *
 * @see Design §3.1.2, §3.1.6
 * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Polyline } from '../types';
import { SPEED_PCT_MIN, SPEED_PCT_MAX } from '../constants';
import {
    FONT_SIZE_MM_MAX,
    FONT_SIZE_MM_MIN,
    LETTER_SPACING_PCT_MAX,
    LETTER_SPACING_PCT_MIN,
    TEXT_MAX_LEN,
    validateFontSizeMm,
    validateLetterSpacingPct,
    validateText,
} from '../validators';
import {
    createTextRenderer,
    type RenderResult,
    type TextRenderer,
} from '../text/text_renderer';

/** Props accepted by {@link TextPanel}. */
export interface TextPanelProps {
    /**
     * Stroke-font renderer to shape the text. Defaults to a fresh
     * `createTextRenderer()`; injectable for hosts and tests.
     */
    renderer?: TextRenderer;
    /**
     * Called with the live preview polylines on every parameter change.
     * Receives an empty array while the text input is invalid
     * (empty/whitespace-only or out-of-range parameters) so the canvas
     * clears its preview (Req 3.4, 3.6).
     */
    onPolylinesChange?: (polylines: Polyline[]) => void;
    /** Optional initial text (defaults to empty). */
    initialText?: string;
    /** Optional initial font name (defaults to the first bundled font). */
    initialFontName?: string;
    /** Optional initial font size in mm (defaults to 20). */
    initialFontSizeMm?: number;
    /** Optional initial letter spacing in % (defaults to 0). */
    initialLetterSpacingPct?: number;
    /**
     * Current draw speed as a percent in [25, 100]. When provided, the panel
     * renders a draw-speed slider so the user can set the pace BEFORE starting
     * a draw (rather than only via the mid-draw control at the bottom of the
     * page). Mirrors the `speedPct` store / SPEED_PCT control.
     */
    speedPct?: number;
    /** Called when the user changes the draw-speed slider (percent in [25,100]). */
    onSpeedChange?: (pct: number) => void;
    /**
     * Current drawing scale as a percent in [10, 100]: how much of the envelope
     * the fitted text fills. When provided, the panel renders a scale slider so
     * the user can size the text on the page. Mirrors the `scalePct` store.
     */
    scalePct?: number;
    /** Called when the user changes the scale slider (percent in [10,100]). */
    onScaleChange?: (pct: number) => void;
}

/** Empty render result used whenever the current inputs are invalid. */
const EMPTY_RESULT: RenderResult = { polylines: [], missing: [] };

/**
 * Render the text input panel. All state is local; the only outputs are
 * the `onPolylinesChange` (live preview) and `onDraw` (commit) callbacks.
 */
export function TextPanel(props: TextPanelProps) {
    const renderer = useMemo(
        () => props.renderer ?? createTextRenderer(),
        [props.renderer],
    );
    const fonts = useMemo(() => renderer.fonts(), [renderer]);

    const [text, setText] = useState(props.initialText ?? '');
    const [fontName, setFontName] = useState(
        props.initialFontName ?? fonts[0]?.name ?? '',
    );
    const [fontSizeMm, setFontSizeMm] = useState(props.initialFontSizeMm ?? 20);
    const [letterSpacingPct, setLetterSpacingPct] = useState(
        props.initialLetterSpacingPct ?? 0,
    );

    const textValidation = validateText(text);
    const textValid = textValidation.ok;

    // Re-shape the text on every parameter change. Stays pure — invalid
    // inputs collapse to an empty result instead of throwing (Req 3.4).
    const result = useMemo<RenderResult>(() => {
        if (!validateText(text).ok) return EMPTY_RESULT;
        if (!validateFontSizeMm(fontSizeMm).ok) return EMPTY_RESULT;
        if (!validateLetterSpacingPct(letterSpacingPct).ok) return EMPTY_RESULT;
        try {
            return renderer.render(text, {
                fontName,
                fontSizeMm,
                letterSpacingPct,
            });
        } catch {
            // Unknown font or other renderer rejection: treat as no output.
            return EMPTY_RESULT;
        }
    }, [renderer, text, fontName, fontSizeMm, letterSpacingPct]);

    // Emit preview polylines upward whenever the shaped result changes.
    // The callback is held in a ref so a parent re-render that only changes
    // the callback identity does not re-fire the emission (Req 3.4).
    const onChangeRef = useRef(props.onPolylinesChange);
    onChangeRef.current = props.onPolylinesChange;
    useEffect(() => {
        onChangeRef.current?.(result.polylines);
    }, [result]);

    const missingSet = useMemo(
        () => new Set(result.missing),
        [result],
    );
    const hasMissing = result.missing.length > 0;

    function handleText(e: Event): void {
        setText((e.currentTarget as HTMLInputElement).value);
    }

    function handleFont(e: Event): void {
        setFontName((e.currentTarget as HTMLSelectElement).value);
    }

    function handleFontSize(e: Event): void {
        const n = Number((e.currentTarget as HTMLInputElement).value);
        const v = validateFontSizeMm(n);
        if (v.ok) setFontSizeMm(v.value);
    }

    function handleLetterSpacing(e: Event): void {
        const n = Number((e.currentTarget as HTMLInputElement).value);
        const v = validateLetterSpacingPct(n);
        if (v.ok) setLetterSpacingPct(v.value);
    }

    return (
        <section class="text-panel" aria-label="Text input">
            <div class="text-panel__field">
                <label class="text-panel__label" for="text-panel-input">
                    Text
                </label>
                <input
                    id="text-panel-input"
                    data-testid="text-input"
                    class="text-panel__text"
                    type="text"
                    maxLength={TEXT_MAX_LEN}
                    value={text}
                    placeholder="Type text to draw"
                    onInput={handleText}
                />
            </div>

            {/* Per-character preview that highlights unsupported codepoints. */}
            <div
                class="text-panel__highlight"
                data-testid="text-highlight"
                aria-hidden="true"
            >
                {[...text].map((ch, i) => {
                    const cp = ch.codePointAt(0) ?? 0;
                    const isMissing = missingSet.has(cp);
                    return (
                        <span
                            // eslint-disable-next-line react/no-array-index-key
                            key={`${i}-${cp}`}
                            class={
                                isMissing
                                    ? 'text-panel__char text-panel__char--missing'
                                    : 'text-panel__char'
                            }
                            data-missing={isMissing ? 'true' : 'false'}
                        >
                            {ch}
                        </span>
                    );
                })}
            </div>

            <div class="text-panel__field">
                <label class="text-panel__label" for="text-panel-font">
                    Font
                </label>
                <select
                    id="text-panel-font"
                    data-testid="font-select"
                    class="text-panel__font"
                    value={fontName}
                    onInput={handleFont}
                    onChange={handleFont}
                >
                    {fonts.map((f) => (
                        <option key={f.name} value={f.name}>
                            {f.name}
                        </option>
                    ))}
                </select>
            </div>

            <div class="text-panel__field">
                <label class="text-panel__label" for="text-panel-size">
                    Font size (mm)
                </label>
                <input
                    id="text-panel-size"
                    data-testid="font-size"
                    class="text-panel__size"
                    type="range"
                    min={FONT_SIZE_MM_MIN}
                    max={FONT_SIZE_MM_MAX}
                    step={1}
                    value={fontSizeMm}
                    onInput={handleFontSize}
                />
                <output data-testid="font-size-value">{fontSizeMm} mm</output>
            </div>

            <div class="text-panel__field">
                <label class="text-panel__label" for="text-panel-spacing">
                    Letter spacing (%)
                </label>
                <input
                    id="text-panel-spacing"
                    data-testid="letter-spacing"
                    class="text-panel__spacing"
                    type="range"
                    min={LETTER_SPACING_PCT_MIN}
                    max={LETTER_SPACING_PCT_MAX}
                    step={1}
                    value={letterSpacingPct}
                    onInput={handleLetterSpacing}
                />
                <output data-testid="letter-spacing-value">
                    {letterSpacingPct}%
                </output>
            </div>

            {/* Drawing scale: how much of the machine's drawable envelope the
                text fills. Lower = smaller text on the page. Only rendered when
                the host wires scale state in. */}
            {props.scalePct !== undefined && props.onScaleChange && (
                <div class="text-panel__field">
                    <label class="text-panel__label" for="text-panel-scale">
                        Scale (%)
                    </label>
                    <input
                        id="text-panel-scale"
                        data-testid="draw-scale"
                        class="text-panel__scale"
                        type="range"
                        min={10}
                        max={100}
                        step={1}
                        value={props.scalePct}
                        onInput={(e) =>
                            props.onScaleChange?.(
                                Number(
                                    (e.currentTarget as HTMLInputElement).value,
                                ),
                            )
                        }
                    />
                    <output data-testid="draw-scale-value">
                        {props.scalePct}%
                    </output>
                </div>
            )}

            {/* Draw speed (set before drawing starts). Mirrors the SPEED_PCT
                control; lower is slower/gentler on the machine. Only rendered
                when the host wires speed state in. */}
            {props.speedPct !== undefined && props.onSpeedChange && (
                <div class="text-panel__field">
                    <label class="text-panel__label" for="text-panel-speed">
                        Draw speed (%)
                    </label>
                    <input
                        id="text-panel-speed"
                        data-testid="draw-speed"
                        class="text-panel__speed"
                        type="range"
                        min={SPEED_PCT_MIN}
                        max={SPEED_PCT_MAX}
                        step={1}
                        value={props.speedPct}
                        onInput={(e) =>
                            props.onSpeedChange?.(
                                Number(
                                    (e.currentTarget as HTMLInputElement).value,
                                ),
                            )
                        }
                    />
                    <output data-testid="draw-speed-value">
                        {props.speedPct}%
                    </output>
                </div>
            )}

            {!textValid && (
                <p class="text-panel__hint" data-testid="text-required">
                    Text input is required.
                </p>
            )}

            {hasMissing && (
                <p class="text-panel__warning" data-testid="text-warning">
                    {result.suggestion
                        ? `Some characters aren't in "${fontName}". Try "${result.suggestion}".`
                        : `Some characters aren't available in "${fontName}".`}
                    {result.suggestion && (
                        <button
                            type="button"
                            data-testid="suggestion-apply"
                            class="text-panel__suggestion"
                            onClick={() => setFontName(result.suggestion!)}
                        >
                            Use "{result.suggestion}"
                        </button>
                    )}
                </p>
            )}
        </section>
    );
}

export default TextPanel;
