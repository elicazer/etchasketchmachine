/**
 * Composer Scene persistence — JSON (de)serialisation and a localStorage
 * adapter with a soft size cap and storage-error safety.
 *
 * This module owns:
 *   - the on-disk JSON shape (a `Scene` value verbatim, gated by
 *     `schemaVersion`);
 *   - the schema-version gate on parse;
 *   - throw-safety: every public entry point either returns a value or
 *     surfaces the error via the optional `onTooLarge` callback. Nothing
 *     escapes to the caller (Req 14.3, 14.7).
 *
 * It does NOT own *when* to save — that decision lives in `scene_store.ts`,
 * which only persists when no gesture is active (Req 14.1).
 *
 * @see .kiro/specs/unified-composer-canvas/design.md §"Components and Interfaces" #4
 * @see Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7
 */

import type { Scene } from './types';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Soft cap on serialised snapshot size in bytes (≈ 2 MB). Saves whose JSON
 * length would exceed this are skipped; the in-memory Scene is unaffected
 * (Req 14.6).
 *
 * Chosen well below typical per-origin localStorage quotas (~5 MB on most
 * browsers) so an attempted write that fits this cap is unlikely to trip a
 * quota error in practice. The storage-error path (Req 14.7) catches the
 * quota case if it does.
 */
export const MAX_SNAPSHOT_BYTES = 2_000_000;

/**
 * User-facing notice text, used by both the size-cap path (Req 14.6) and
 * the storage-error path (Req 14.7). The SceneStore wires this to a
 * non-blocking notice surface.
 */
export const SNAPSHOT_TOO_LARGE_MESSAGE =
    'Scene too large to auto-save — use Export to keep it, or remove items';

/** Default localStorage key. Namespaced and version-suffixed (Req 14.1). */
const DEFAULT_KEY = 'eas:composer:scene:v1';

/** Default and currently-only supported on-disk schema version (Req 14.1). */
const DEFAULT_SCHEMA_VERSION = 1 as const;

// -----------------------------------------------------------------------------
// Public interface
// -----------------------------------------------------------------------------

/**
 * Adapter contract for Scene persistence. The default implementation is
 * `createLocalStoragePersistence`; tests can inject in-memory or throwing
 * stand-ins.
 */
export interface ScenePersistence {
    /**
     * Load the persisted Scene, if any.
     *
     * Returns `null` when:
     *   - storage is unavailable (no global `localStorage`, or access
     *     throws — e.g. private-browsing mode);
     *   - the key is missing;
     *   - the stored value fails `parseScene` (malformed JSON or
     *     mismatched `schemaVersion`).
     *
     * Never throws (Req 14.3).
     */
    load(): Scene | null;

    /**
     * Persist a Scene. May be a no-op when:
     *   - the serialised payload exceeds `maxBytes` (Req 14.6); OR
     *   - the underlying storage throws (quota / disabled, Req 14.7).
     *
     * In either skip case, `onTooLarge` (if supplied) is invoked with a
     * machine-readable reason and the user-facing message. Never throws.
     */
    save(scene: Scene): void;

    /**
     * Remove the persisted snapshot. Never throws (Req 14.5, 14.7).
     */
    clear(): void;
}

/**
 * Reason passed to the `onTooLarge` callback so the caller can distinguish
 * a deliberate skip from an underlying I/O failure.
 *
 *   - `'too-large'`: the serialised snapshot exceeds `maxBytes`; no write
 *     was attempted (Req 14.6).
 *   - `'storage-error'`: the underlying `localStorage.setItem` threw — most
 *     commonly a quota error, but also fires on disabled / private-browsing
 *     storage (Req 14.7).
 */
export type SnapshotSkipReason = 'too-large' | 'storage-error';

export interface CreateLocalStoragePersistenceOptions {
    /** localStorage key. Defaults to `'eas:composer:scene:v1'`. */
    key?: string;
    /** Schema version expected on load. Defaults to `1`. */
    schemaVersion?: 1;
    /**
     * Soft maximum serialised snapshot size in bytes. Saves whose JSON
     * length would exceed this are skipped (Req 14.6). Defaults to
     * `MAX_SNAPSHOT_BYTES`.
     */
    maxBytes?: number;
    /**
     * Called when a save is skipped because the serialised payload would
     * exceed `maxBytes`, OR when the underlying storage throws (Req 14.6,
     * 14.7). The in-memory Scene is unaffected in either case.
     */
    onTooLarge?: (reason: SnapshotSkipReason, message: string) => void;
    /**
     * Storage backend. Defaults to the global `localStorage` if available.
     * Test injection point: pass an in-memory or throwing stand-in.
     */
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

// -----------------------------------------------------------------------------
// Pure (de)serialisation
// -----------------------------------------------------------------------------

/**
 * Serialise a Scene to its on-disk JSON form. Pure.
 *
 * The Scene is JSON-serialisable by construction (every shape in `types.ts`
 * is plain data — no `Date`, `Map`, `Set`, functions, or class instances)
 * so this is a thin wrapper around `JSON.stringify`. Kept as a named export
 * so the SceneStore measures the same string the storage adapter writes
 * (Req 14.6).
 */
export function serialiseScene(scene: Scene): string {
    return JSON.stringify(scene);
}

/**
 * Parse a raw JSON string back into a Scene.
 *
 * Returns `null` for any of:
 *   - malformed JSON (parse threw);
 *   - the parsed value is not a plain object;
 *   - the parsed value is missing `schemaVersion`, `items`, or
 *     `selectedId`;
 *   - `schemaVersion` does not match `expectedSchemaVersion`;
 *   - `items` is not an array.
 *
 * Never throws to the caller (Req 14.3).
 *
 * This is a structural shape gate, not a deep validator: individual item
 * fields are not checked. The SceneStore is responsible for normalising
 * any restored Scene (e.g. clamping scales, normalising rotations) on its
 * way into the live signal — so a "valid-shape but slightly off" snapshot
 * is healed rather than rejected, while a wrong-version or syntactically
 * broken snapshot is discarded (Req 14.3).
 */
export function parseScene(
    raw: string,
    expectedSchemaVersion: 1 = DEFAULT_SCHEMA_VERSION,
): Scene | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }

    const candidate = parsed as Record<string, unknown>;

    if (candidate['schemaVersion'] !== expectedSchemaVersion) {
        return null;
    }
    if (!Array.isArray(candidate['items'])) {
        return null;
    }
    if (!('selectedId' in candidate)) {
        return null;
    }
    const selectedId = candidate['selectedId'];
    if (selectedId !== null && typeof selectedId !== 'string') {
        return null;
    }

    return candidate as unknown as Scene;
}

// -----------------------------------------------------------------------------
// localStorage adapter
// -----------------------------------------------------------------------------

/**
 * Build a `ScenePersistence` backed by `localStorage` (or a supplied
 * `storage` stand-in for tests).
 *
 * All three operations are throw-safe: any error from the underlying
 * storage is caught. `save` reports the failure via `onTooLarge` so the
 * SceneStore can surface a non-blocking notice; `load` and `clear`
 * silently return / no-op (Req 14.3, 14.5, 14.7).
 *
 * @see Requirements 14.1, 14.2, 14.3, 14.5, 14.6, 14.7
 */
export function createLocalStoragePersistence(
    opts: CreateLocalStoragePersistenceOptions = {},
): ScenePersistence {
    const key = opts.key ?? DEFAULT_KEY;
    const schemaVersion: 1 = opts.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
    const maxBytes = opts.maxBytes ?? MAX_SNAPSHOT_BYTES;
    const onTooLarge = opts.onTooLarge;
    const storage = opts.storage ?? resolveDefaultStorage();

    return {
        load(): Scene | null {
            if (storage === null) {
                return null;
            }
            let raw: string | null;
            try {
                raw = storage.getItem(key);
            } catch {
                return null;
            }
            if (raw === null) {
                return null;
            }
            return parseScene(raw, schemaVersion);
        },

        save(scene: Scene): void {
            if (storage === null) {
                // No backing store available (SSR, locked-down browser).
                // Treat as a storage-error so the caller can surface the
                // same notice as a quota failure (Req 14.7).
                onTooLarge?.('storage-error', SNAPSHOT_TOO_LARGE_MESSAGE);
                return;
            }
            const payload = serialiseScene(scene);
            if (payload.length > maxBytes) {
                onTooLarge?.('too-large', SNAPSHOT_TOO_LARGE_MESSAGE);
                return;
            }
            try {
                storage.setItem(key, payload);
            } catch {
                onTooLarge?.('storage-error', SNAPSHOT_TOO_LARGE_MESSAGE);
            }
        },

        clear(): void {
            if (storage === null) {
                return;
            }
            try {
                storage.removeItem(key);
            } catch {
                // Swallow — clear is best-effort (Req 14.7).
            }
        },
    };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/**
 * Resolve the platform's default `localStorage`, returning `null` if it is
 * not available (SSR, sandboxed iframes, hardened privacy settings). Some
 * browsers throw on the property access itself, not on first use, so the
 * lookup is guarded.
 */
function resolveDefaultStorage(): Pick<
    Storage,
    'getItem' | 'setItem' | 'removeItem'
> | null {
    try {
        if (typeof globalThis === 'undefined') {
            return null;
        }
        const ls = (globalThis as { localStorage?: Storage }).localStorage;
        return ls ?? null;
    } catch {
        return null;
    }
}
