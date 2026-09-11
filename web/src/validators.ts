/**
 * Parameterised input validators for user-facing form fields.
 *
 * Every validator returns a discriminated `ValidationResult<T>`:
 *   - `{ ok: true, value }` carries the canonicalised value (e.g. trimmed
 *     string, integer-coerced number) so callers do not need to repeat
 *     the same normalisation logic the validator already performed.
 *   - `{ ok: false, reason }` carries a short, human-readable message
 *     suitable for surfacing directly under a form control.
 *
 * Validators never throw. They are pure functions of their input and
 * are safe to call on every keystroke.
 *
 * Numeric bounds mirror the firmware-side range checks (Design §3.2.4,
 * §3.2.6) so the browser rejects invalid values before they ever hit
 * the wire. The matching constants live in `constants.ts` and are
 * imported here so there is exactly one source of truth.
 *
 * @see Requirements 1.4, 2.1, 2.3, 2.4, 3.3, 3.6, 9.7, 13.8
 */

import {
    BACKLASH_STEPS_MAX,
    BACKLASH_STEPS_MIN,
    SPEED_PCT_MAX,
    SPEED_PCT_MIN,
} from './constants';

// -----------------------------------------------------------------------------
// Result shape
// -----------------------------------------------------------------------------

/**
 * Discriminated result returned by every validator in this module.
 * The `value` field carries the canonicalised input (e.g. a trimmed
 * string or an integer-coerced number) so callers can use the result
 * directly without re-normalising.
 */
export type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; reason: string };

const ok = <T>(value: T): ValidationResult<T> => ({ ok: true, value });
const err = <T>(reason: string): ValidationResult<T> => ({ ok: false, reason });

// -----------------------------------------------------------------------------
// WiFi credentials (Req 1.4)
// -----------------------------------------------------------------------------

/** Inclusive bounds on the WiFi SSID length, in characters. */
export const WIFI_SSID_MIN_LEN = 1;
export const WIFI_SSID_MAX_LEN = 32;

/**
 * Inclusive bounds on the WPA-PSK passphrase length, in characters.
 * Matches IEEE 802.11i (8..63 ASCII characters; a 64-hex-char raw PSK
 * is out of scope for this UI).
 */
export const WIFI_PASSWORD_MIN_LEN = 8;
export const WIFI_PASSWORD_MAX_LEN = 63;

/**
 * Validate a WiFi SSID. The value is rejected if it is `null`/`undefined`,
 * if surrounding whitespace is present (a common copy-paste hazard that
 * 802.11 does not strip for you), or if its length falls outside
 * `[WIFI_SSID_MIN_LEN, WIFI_SSID_MAX_LEN]`.
 */
export function validateWifiSsid(s: string): ValidationResult<string> {
    if (typeof s !== 'string') {
        return err('SSID must be a string');
    }
    if (s.length === 0) {
        return err('SSID must not be empty');
    }
    if (s !== s.trim()) {
        return err('SSID must not have leading or trailing whitespace');
    }
    if (s.length < WIFI_SSID_MIN_LEN || s.length > WIFI_SSID_MAX_LEN) {
        return err(
            `SSID must be ${WIFI_SSID_MIN_LEN}–${WIFI_SSID_MAX_LEN} characters`,
        );
    }
    return ok(s);
}

/**
 * Validate a WPA-PSK passphrase. Open networks (no password) are out of
 * scope for this validator — the UI guards that path separately.
 */
export function validateWifiPassword(s: string): ValidationResult<string> {
    if (typeof s !== 'string') {
        return err('Password must be a string');
    }
    if (s.length < WIFI_PASSWORD_MIN_LEN || s.length > WIFI_PASSWORD_MAX_LEN) {
        return err(
            `Password must be ${WIFI_PASSWORD_MIN_LEN}–${WIFI_PASSWORD_MAX_LEN} characters`,
        );
    }
    return ok(s);
}

// -----------------------------------------------------------------------------
// Image upload (Req 2.1, 2.4)
// -----------------------------------------------------------------------------

/** Allowed image upload formats. The order is the public help-text order. */
export const IMAGE_ALLOWED_FORMATS = ['png', 'jpeg', 'bmp', 'svg'] as const;
export type ImageFormat = (typeof IMAGE_ALLOWED_FORMATS)[number];

/** Maximum image upload size, in bytes (10 MB, Req 2.4). */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Map of accepted MIME types to the canonical short format name used
 * throughout the SPA. `image/jpg` is technically non-standard but is
 * commonly emitted by older tooling, so it is normalised here.
 */
const MIME_TO_FORMAT: Record<string, ImageFormat> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/bmp': 'bmp',
    'image/x-bmp': 'bmp',
    'image/svg+xml': 'svg',
};

/**
 * Map of accepted file-extension strings (lowercased, no leading dot)
 * to the canonical short format name. We accept either a matching MIME
 * or a matching extension because some browsers omit the MIME on drag
 * and drop and some hosts return generic `application/octet-stream`.
 */
const EXT_TO_FORMAT: Record<string, ImageFormat> = {
    png: 'png',
    jpg: 'jpeg',
    jpeg: 'jpeg',
    bmp: 'bmp',
    svg: 'svg',
};

/** Lowercase the file extension (without leading dot), or `''` if none. */
function fileExt(name: string): string {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) return '';
    return name.slice(dot + 1).toLowerCase();
}

/**
 * Validate an uploaded `File`. Checks both the MIME type and the file
 * extension against the allow-list, and rejects files exceeding
 * `IMAGE_MAX_BYTES`. On success, returns a small structured record so
 * the caller can dispatch on the canonical format without reparsing
 * the MIME or the filename.
 */
export function validateImageFile(
    file: File,
): ValidationResult<{ format: ImageFormat; size: number; name: string }> {
    if (file == null) {
        return err('No file provided');
    }
    const size = typeof file.size === 'number' ? file.size : NaN;
    if (!Number.isFinite(size) || size < 0) {
        return err('File size could not be determined');
    }
    if (size > IMAGE_MAX_BYTES) {
        const limitMb = (IMAGE_MAX_BYTES / (1024 * 1024)).toFixed(0);
        return err(`File exceeds ${limitMb} MB limit`);
    }
    if (size === 0) {
        return err('File is empty');
    }

    const mime = (file.type || '').toLowerCase();
    const ext = fileExt(file.name || '');
    const fromMime = MIME_TO_FORMAT[mime];
    const fromExt = EXT_TO_FORMAT[ext];
    const format = fromMime ?? fromExt;

    if (format === undefined) {
        return err(
            `Unsupported format. Allowed: ${IMAGE_ALLOWED_FORMATS.join(', ')}`,
        );
    }

    // If both are present, they must agree. This catches mis-named files
    // (e.g., a JPEG saved with a .png extension) early.
    if (fromMime !== undefined && fromExt !== undefined && fromMime !== fromExt) {
        return err(
            `File extension .${ext} does not match MIME type ${mime}`,
        );
    }

    return ok({ format, size, name: file.name });
}

// -----------------------------------------------------------------------------
// Image transform (Req 2.3)
// -----------------------------------------------------------------------------

/**
 * Inclusive bounds on the image scale multiplier. The 0.10..5.00 range
 * matches the user-facing 10%..500% scale slider from Req 2.3.
 */
export const IMAGE_SCALE_MIN = 0.1;
export const IMAGE_SCALE_MAX = 5.0;

/**
 * Validate an image scale multiplier. The slider exposes values as a
 * fraction (0.10..5.00); the percentage form is derived in the UI
 * layer.
 */
export function validateImageScale(n: number): ValidationResult<number> {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        return err('Scale must be a finite number');
    }
    if (n < IMAGE_SCALE_MIN || n > IMAGE_SCALE_MAX) {
        return err(
            `Scale must be between ${IMAGE_SCALE_MIN.toFixed(2)} and ${IMAGE_SCALE_MAX.toFixed(2)}`,
        );
    }
    return ok(n);
}

/**
 * Inclusive bounds on the image rotation, in whole degrees.
 * 360° is rejected because it is the same orientation as 0° and the
 * UI normalises to a half-open `[0, 360)` range.
 */
export const IMAGE_ROTATION_MIN_DEG = 0;
export const IMAGE_ROTATION_MAX_DEG = 359;

/**
 * Validate an image rotation in whole degrees in `[0, 359]`.
 * Non-integer values are rejected so the wire-form rotation (which is
 * an integer step in the UI) cannot drift out of sync with the
 * preview.
 */
export function validateImageRotationDeg(n: number): ValidationResult<number> {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        return err('Rotation must be a finite number');
    }
    if (!Number.isInteger(n)) {
        return err('Rotation must be a whole number of degrees');
    }
    if (n < IMAGE_ROTATION_MIN_DEG || n > IMAGE_ROTATION_MAX_DEG) {
        return err(
            `Rotation must be between ${IMAGE_ROTATION_MIN_DEG}° and ${IMAGE_ROTATION_MAX_DEG}°`,
        );
    }
    return ok(n);
}

// -----------------------------------------------------------------------------
// Text (Req 3.1, 3.3, 3.6)
// -----------------------------------------------------------------------------

/** Inclusive bounds on the text input length (post-trim) in characters. */
export const TEXT_MIN_LEN = 1;
export const TEXT_MAX_LEN = 200;

/**
 * Validate a text input. The result's `value` is the original string
 * unchanged so trailing whitespace inside the text (e.g. between
 * words) is preserved; the trim is only used to detect "effectively
 * empty" inputs.
 */
export function validateText(s: string): ValidationResult<string> {
    if (typeof s !== 'string') {
        return err('Text must be a string');
    }
    if (s.trim().length === 0) {
        return err('Text must not be empty');
    }
    if (s.length > TEXT_MAX_LEN) {
        return err(`Text must be at most ${TEXT_MAX_LEN} characters`);
    }
    if (s.length < TEXT_MIN_LEN) {
        return err(`Text must be at least ${TEXT_MIN_LEN} character`);
    }
    return ok(s);
}

/** Inclusive bounds on the rendered character height, in millimetres. */
export const FONT_SIZE_MM_MIN = 5;
export const FONT_SIZE_MM_MAX = 100;

/** Validate a font size in millimetres (Req 3.3). */
export function validateFontSizeMm(n: number): ValidationResult<number> {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        return err('Font size must be a finite number');
    }
    if (n < FONT_SIZE_MM_MIN || n > FONT_SIZE_MM_MAX) {
        return err(
            `Font size must be between ${FONT_SIZE_MM_MIN} mm and ${FONT_SIZE_MM_MAX} mm`,
        );
    }
    return ok(n);
}

/**
 * Inclusive bounds on letter spacing, expressed as a percentage of
 * glyph width (0% = touching, 200% = double-width gaps).
 */
export const LETTER_SPACING_PCT_MIN = 0;
export const LETTER_SPACING_PCT_MAX = 200;

/** Validate a letter-spacing percentage (Req 3.3). */
export function validateLetterSpacingPct(n: number): ValidationResult<number> {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        return err('Letter spacing must be a finite number');
    }
    if (n < LETTER_SPACING_PCT_MIN || n > LETTER_SPACING_PCT_MAX) {
        return err(
            `Letter spacing must be between ${LETTER_SPACING_PCT_MIN}% and ${LETTER_SPACING_PCT_MAX}%`,
        );
    }
    return ok(n);
}

// -----------------------------------------------------------------------------
// Speed slider (Req 9.7)
// -----------------------------------------------------------------------------

/**
 * Validate the drawing-speed percentage. The slider exposes integer
 * 1% increments in `[SPEED_PCT_MIN, SPEED_PCT_MAX]`; values from
 * outside that range or non-integers are rejected here so the firmware
 * never receives a malformed `SPEED_PCT` control message.
 */
export function validateSpeedPct(n: number): ValidationResult<number> {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        return err('Speed must be a finite number');
    }
    if (!Number.isInteger(n)) {
        return err('Speed must be a whole percentage');
    }
    if (n < SPEED_PCT_MIN || n > SPEED_PCT_MAX) {
        return err(
            `Speed must be between ${SPEED_PCT_MIN}% and ${SPEED_PCT_MAX}%`,
        );
    }
    return ok(n);
}

// -----------------------------------------------------------------------------
// Backlash edit (Req 13.8)
// -----------------------------------------------------------------------------

/**
 * Validate a manually-edited backlash value, in full motor steps.
 * Mirrors the firmware command-parser range check on `SET_BACKLASH`
 * (`0..200`), with non-integer values rejected up front because the
 * wire field is an integer step count.
 */
export function validateBacklashSteps(n: number): ValidationResult<number> {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        return err('Backlash must be a finite number');
    }
    if (!Number.isInteger(n)) {
        return err('Backlash must be a whole number of steps');
    }
    if (n < BACKLASH_STEPS_MIN || n > BACKLASH_STEPS_MAX) {
        return err(
            `Backlash must be between ${BACKLASH_STEPS_MIN} and ${BACKLASH_STEPS_MAX} steps`,
        );
    }
    return ok(n);
}
