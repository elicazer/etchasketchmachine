// Feature: unified-composer-canvas — property tests for `persistence.ts`
//
// Covers:
//   - Property 9:  Scene serialisation round-trip
//                  (Validates Requirements 10.3, 14.1, 14.2, 14.4)
//   - Property 16: Persistence size cap and storage-error safety
//                  (Validates Requirements 14.6, 14.7)
//   - Negative parse paths for Req 14.3 (malformed JSON, mismatched
//     schemaVersion, missing fields → all return `null` without throwing).
//
// Iterations: ≥ 100 per property (project standard / fast-check default).
// The persistence module is pure modulo the injected `storage` adapter; the
// tests exercise both an in-memory adapter (round-trip) and a throwing
// adapter (storage-error path) to keep the universe deterministic.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
    createLocalStoragePersistence,
    MAX_SNAPSHOT_BYTES,
    parseScene,
    serialiseScene,
    SNAPSHOT_TOO_LARGE_MESSAGE,
    type SnapshotSkipReason,
} from './persistence';
import type { Item, ItemId, Scene, Transform } from './types';
import type { Point, Polyline } from '../types';

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

const NUM_RUNS = { numRuns: 100 } as const;

/**
 * Finite scene-unit coordinates. Mapped through `+ 0` so `-0` is
 * canonicalised to `+0` — `JSON.stringify(-0) === "0"`, so a `-0` round-trip
 * is lossy and would spuriously fail structural equality (`Object.is(-0, 0)
 * === false`). The SceneStore mutators commit transforms via arithmetic
 * that produces canonical zeros, so this matches what `persistence.save`
 * actually sees in production.
 */
const arbCoord = fc
    .double({
        min: -1_000,
        max: 1_000,
        noNaN: true,
        noDefaultInfinity: true,
    })
    .map((v) => v + 0);

const arbPoint: fc.Arbitrary<Point> = fc.record({ x: arbCoord, y: arbCoord });

/**
 * A polyline of length ≥ 2 — matches what the SceneStore mutators would
 * commit (single-point polylines are pruned upstream by the planner).
 */
const arbPolyline: fc.Arbitrary<Polyline> = fc.array(arbPoint, {
    minLength: 2,
    maxLength: 8,
});

const arbContent: fc.Arbitrary<Polyline[]> = fc.array(arbPolyline, {
    minLength: 1,
    maxLength: 4,
});

/**
 * A `Transform` that satisfies the SceneStore's commit invariants:
 *   - `|sx|, |sy| ≥ SCALE_MIN` (clampScale)
 *   - `rotationRad ∈ [0, 2π)` (normaliseRotation)
 *
 * We don't include negative scales here because the round-trip property
 * does not depend on the sign of the scale, and keeping `sx, sy > 0`
 * exercises the common case the SceneStore actually persists.
 */
const arbTransform: fc.Arbitrary<Transform> = fc.record({
    x: arbCoord,
    y: arbCoord,
    sx: fc.double({
        min: 1e-3,
        max: 50,
        noNaN: true,
        noDefaultInfinity: true,
    }),
    sy: fc.double({
        min: 1e-3,
        max: 50,
        noNaN: true,
        noDefaultInfinity: true,
    }),
    rotationRad: fc
        .double({
            min: 0,
            max: Math.PI * 2 - 1e-9,
            noNaN: true,
            noDefaultInfinity: true,
        })
        .map((v) => v + 0),
});

const arbItemId: fc.Arbitrary<ItemId> = fc.string({
    minLength: 1,
    maxLength: 16,
});

const arbImageItem: fc.Arbitrary<Item> = fc.record({
    id: arbItemId,
    kind: fc.constant('image' as const),
    transform: arbTransform,
    content: arbContent,
    source: fc.record({
        filename: fc.string({ minLength: 1, maxLength: 32 }),
        sizeBytes: fc.integer({ min: 0, max: 10_000_000 }),
    }),
});

const arbTextItem: fc.Arbitrary<Item> = fc.record({
    id: arbItemId,
    kind: fc.constant('text' as const),
    transform: arbTransform,
    content: arbContent,
    source: fc.record({
        text: fc.string({ minLength: 0, maxLength: 32 }),
        fontName: fc.string({ minLength: 1, maxLength: 16 }),
        fontSizeMm: fc.double({
            min: 1,
            max: 100,
            noNaN: true,
            noDefaultInfinity: true,
        }),
        letterSpacingPct: fc
            .double({
                min: 0,
                max: 50,
                noNaN: true,
                noDefaultInfinity: true,
            })
            .map((v) => v + 0),
    }),
});

const arbFreehandItem: fc.Arbitrary<Item> = fc.record({
    id: arbItemId,
    kind: fc.constant('freehand' as const),
    transform: arbTransform,
    content: arbContent,
    source: fc.record({
        capturedAtMs: fc.integer({ min: 0, max: 10_000_000_000 }),
    }),
});

const arbItem: fc.Arbitrary<Item> = fc.oneof(
    arbImageItem,
    arbTextItem,
    arbFreehandItem,
);

/**
 * Generates a Scene that mixes image, text, and freehand items with varied
 * transforms. `selectedId` is either `null` or one of the actually-present
 * item ids (matching what the SceneStore would commit).
 */
const arbScene: fc.Arbitrary<Scene> = fc
    .array(arbItem, { minLength: 0, maxLength: 6 })
    .chain((items) => {
        if (items.length === 0) {
            return fc.constant({
                schemaVersion: 1 as const,
                items: [] as Item[],
                selectedId: null as ItemId | null,
            });
        }
        return fc
            .option(fc.integer({ min: 0, max: items.length - 1 }), {
                nil: null,
            })
            .map((idxOrNull) => ({
                schemaVersion: 1 as const,
                items,
                selectedId:
                    idxOrNull === null ? null : items[idxOrNull]!.id,
            }));
    });

// -----------------------------------------------------------------------------
// Test storage adapters
// -----------------------------------------------------------------------------

interface MemoryStorageProbe {
    adapter: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    readonly writes: number;
    readonly removals: number;
    get(key: string): string | null;
}

function makeMemoryStorage(): MemoryStorageProbe {
    const map = new Map<string, string>();
    let writes = 0;
    let removals = 0;
    return {
        adapter: {
            getItem(key: string): string | null {
                return map.get(key) ?? null;
            },
            setItem(key: string, value: string): void {
                writes += 1;
                map.set(key, value);
            },
            removeItem(key: string): void {
                removals += 1;
                map.delete(key);
            },
        },
        get writes() {
            return writes;
        },
        get removals() {
            return removals;
        },
        get(key: string): string | null {
            return map.get(key) ?? null;
        },
    };
}

interface ThrowingStorageProbe {
    adapter: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    readonly setCalls: number;
}

function makeThrowingStorage(): ThrowingStorageProbe {
    let setCalls = 0;
    return {
        adapter: {
            getItem(_key: string): string | null {
                return null;
            },
            setItem(_key: string, _value: string): void {
                setCalls += 1;
                throw new Error('quota exceeded');
            },
            removeItem(_key: string): void {
                /* no-op */
            },
        },
        get setCalls() {
            return setCalls;
        },
    };
}

// -----------------------------------------------------------------------------
// Property 9: Scene serialisation round-trip
// -----------------------------------------------------------------------------

describe('persistence — Property 9 (Scene serialisation round-trip)', () => {
    // Feature: unified-composer-canvas, Property 9: parseScene(serialiseScene(s)) is structurally equal to s
    it('parseScene(serialiseScene(s)) is structurally equal to s for any Scene', () => {
        fc.assert(
            fc.property(arbScene, (scene) => {
                const raw = serialiseScene(scene);
                const restored = parseScene(raw);

                expect(restored).not.toBeNull();
                // Deep structural equality covers items order, transforms,
                // content polylines, source metadata, selectedId, and
                // schemaVersion (Req 14.4).
                expect(restored).toEqual(scene);

                // Spot-check the per-field assertions called out in the
                // property description so a regression that flattens
                // structural equality (e.g. lossy serialisation) cannot
                // sneak past `toEqual`.
                expect(restored!.schemaVersion).toBe(1);
                expect(restored!.items.length).toBe(scene.items.length);
                expect(restored!.selectedId).toBe(scene.selectedId);
                for (let i = 0; i < scene.items.length; i++) {
                    expect(restored!.items[i]!.id).toBe(scene.items[i]!.id);
                    expect(restored!.items[i]!.kind).toBe(
                        scene.items[i]!.kind,
                    );
                    expect(restored!.items[i]!.transform).toEqual(
                        scene.items[i]!.transform,
                    );
                    expect(restored!.items[i]!.content).toEqual(
                        scene.items[i]!.content,
                    );
                    // `source` shape varies by kind — `toEqual` on the
                    // whole item already covers it, but assert presence so
                    // the failure mode is obvious if it goes missing.
                    expect(
                        (restored!.items[i] as { source: unknown }).source,
                    ).toEqual(
                        (scene.items[i] as { source: unknown }).source,
                    );
                }
            }),
            NUM_RUNS,
        );
    });

    // Feature: unified-composer-canvas, Property 9: round-trip via the localStorage adapter (save → load) preserves the Scene
    it('round-trip via the in-memory localStorage adapter preserves the Scene', () => {
        fc.assert(
            fc.property(arbScene, (scene) => {
                const storage = makeMemoryStorage();
                const persistence = createLocalStoragePersistence({
                    storage: storage.adapter,
                });

                persistence.save(scene);
                const restored = persistence.load();

                expect(restored).toEqual(scene);
                expect(storage.writes).toBe(1);
            }),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 16: Persistence size cap and storage-error safety
// -----------------------------------------------------------------------------

describe('persistence — Property 16 (size cap and storage-error safety)', () => {
    // Feature: unified-composer-canvas, Property 16: oversized payload ⇒ no write, onTooLarge('too-large', ...)
    it('skips the write and fires onTooLarge("too-large") when the serialised payload exceeds maxBytes', () => {
        fc.assert(
            fc.property(
                arbScene,
                // A small cap (1..64) lets us exercise both branches —
                // some Scenes will fit, most will exceed — without
                // building 2 MB payloads. (Even EMPTY_SCENE serialises
                // to ~48 chars, so a cap of 32 reliably triggers the
                // size-cap path; 64 catches the in-bounds branch too.)
                fc.integer({ min: 1, max: 64 }),
                (scene, maxBytes) => {
                    const storage = makeMemoryStorage();
                    const calls: Array<{
                        reason: SnapshotSkipReason;
                        message: string;
                    }> = [];
                    const persistence = createLocalStoragePersistence({
                        storage: storage.adapter,
                        maxBytes,
                        onTooLarge: (reason, message) =>
                            calls.push({ reason, message }),
                    });

                    const payloadLen = serialiseScene(scene).length;

                    expect(() => persistence.save(scene)).not.toThrow();

                    if (payloadLen > maxBytes) {
                        // Size-cap path (Req 14.6): no write, exactly one
                        // notice, with the documented reason and message.
                        expect(storage.writes).toBe(0);
                        expect(calls.length).toBe(1);
                        expect(calls[0]!.reason).toBe('too-large');
                        expect(calls[0]!.message).toBe(
                            SNAPSHOT_TOO_LARGE_MESSAGE,
                        );
                    } else {
                        // In-bounds path: exactly one write, no notice.
                        expect(storage.writes).toBe(1);
                        expect(calls.length).toBe(0);
                    }
                },
            ),
            NUM_RUNS,
        );
    });

    // Feature: unified-composer-canvas, Property 16: throwing storage ⇒ no exception escapes, onTooLarge('storage-error', ...)
    it('catches storage exceptions, fires onTooLarge("storage-error"), and never lets the error escape', () => {
        fc.assert(
            fc.property(arbScene, (scene) => {
                const storage = makeThrowingStorage();
                const calls: Array<{
                    reason: SnapshotSkipReason;
                    message: string;
                }> = [];
                const persistence = createLocalStoragePersistence({
                    storage: storage.adapter,
                    // Use the default maxBytes so the cap path is NOT
                    // what triggers the skip — only the throw is.
                    onTooLarge: (reason, message) =>
                        calls.push({ reason, message }),
                });

                expect(() => persistence.save(scene)).not.toThrow();

                // The adapter was given the chance to write (so we know
                // the storage-error path, not the size-cap path, is what
                // suppressed the persist).
                expect(storage.setCalls).toBe(1);
                expect(calls.length).toBe(1);
                expect(calls[0]!.reason).toBe('storage-error');
                expect(calls[0]!.message).toBe(SNAPSHOT_TOO_LARGE_MESSAGE);
            }),
            NUM_RUNS,
        );
    });

    // Feature: unified-composer-canvas, Property 16: MAX_SNAPSHOT_BYTES is the documented default
    it('exposes a MAX_SNAPSHOT_BYTES default near the documented ≈ 2 MB cap', () => {
        // Sanity-check the constant — the design pins it at ≈ 2 MB and
        // the SceneStore relies on the default if no explicit cap is
        // passed.
        expect(MAX_SNAPSHOT_BYTES).toBeGreaterThanOrEqual(1_000_000);
        expect(MAX_SNAPSHOT_BYTES).toBeLessThanOrEqual(5_000_000);
    });
});

// -----------------------------------------------------------------------------
// Negative parse paths (Req 14.3)
// -----------------------------------------------------------------------------

describe('persistence — Req 14.3 (negative parse paths return null without throwing)', () => {
    // Feature: unified-composer-canvas, Req 14.3: malformed JSON → null, no throw
    it('returns null for malformed JSON inputs without throwing', () => {
        // Generate strings, keep only those that JSON.parse rejects — a
        // direct way to exercise the malformed-JSON branch without
        // hand-crafting a corpus.
        const arbMalformed = fc
            .string({ minLength: 0, maxLength: 64 })
            .filter((s) => {
                try {
                    JSON.parse(s);
                    return false;
                } catch {
                    return true;
                }
            });

        fc.assert(
            fc.property(arbMalformed, (raw) => {
                let threw = false;
                let result: unknown;
                try {
                    result = parseScene(raw);
                } catch {
                    threw = true;
                }
                expect(threw).toBe(false);
                expect(result).toBeNull();
            }),
            NUM_RUNS,
        );

        // Also pin a small set of well-known malformed examples — these
        // would be vanishingly unlikely to be produced by `fc.string`
        // and document the contract on the canonical failure shapes.
        const examples = [
            '',
            '{',
            '}',
            'not json',
            '{"unterminated":',
            '{ "key": value }',
        ];
        for (const raw of examples) {
            expect(() => parseScene(raw)).not.toThrow();
            expect(parseScene(raw)).toBeNull();
        }
    });

    // Feature: unified-composer-canvas, Req 14.3: mismatched schemaVersion → null, no throw
    it('returns null for snapshots whose schemaVersion does not match the expected version', () => {
        const arbBadVersion = fc.oneof(
            fc.integer({ min: 2, max: 1_000 }),
            fc.integer({ min: -1_000, max: 0 }),
            fc.constant('1' as unknown as number),
            fc.constant(null as unknown as number),
            fc.constant(undefined as unknown as number),
        );

        fc.assert(
            fc.property(arbScene, arbBadVersion, (scene, badVersion) => {
                const raw = JSON.stringify({
                    ...scene,
                    schemaVersion: badVersion,
                });
                let threw = false;
                let result: unknown;
                try {
                    result = parseScene(raw);
                } catch {
                    threw = true;
                }
                expect(threw).toBe(false);
                expect(result).toBeNull();
            }),
            NUM_RUNS,
        );
    });

    // Feature: unified-composer-canvas, Req 14.3: missing required fields → null, no throw
    it('returns null when the parsed object is missing required fields', () => {
        // Each example omits exactly one of schemaVersion / items /
        // selectedId, or has a structurally wrong type for one of them.
        const examples: unknown[] = [
            // Missing schemaVersion
            { items: [], selectedId: null },
            // Missing items
            { schemaVersion: 1, selectedId: null },
            // Missing selectedId
            { schemaVersion: 1, items: [] },
            // items is not an array
            { schemaVersion: 1, items: 'nope', selectedId: null },
            { schemaVersion: 1, items: 42, selectedId: null },
            { schemaVersion: 1, items: { 0: 'x' }, selectedId: null },
            // selectedId is structurally wrong (must be string or null)
            { schemaVersion: 1, items: [], selectedId: 7 },
            { schemaVersion: 1, items: [], selectedId: { id: 'x' } },
            // Top-level not a plain object
            'a string',
            42,
            null,
            true,
            [1, 2, 3],
        ];

        for (const candidate of examples) {
            const raw = JSON.stringify(candidate);
            expect(() => parseScene(raw)).not.toThrow();
            expect(parseScene(raw)).toBeNull();
        }
    });

    // Feature: unified-composer-canvas, Req 14.3: load() returns null on malformed snapshot
    it('createLocalStoragePersistence.load() returns null when the stored snapshot is malformed', () => {
        const storage = makeMemoryStorage();
        // Pre-seed the storage with garbage under the default key.
        storage.adapter.setItem(
            'eas:composer:scene:v1',
            '{ this is not valid json',
        );
        const persistence = createLocalStoragePersistence({
            storage: storage.adapter,
        });
        expect(persistence.load()).toBeNull();
    });
});
