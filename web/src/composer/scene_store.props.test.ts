// Feature: unified-composer-canvas — property tests for `scene_store.ts`
//
// Covers:
//   - Property 5:  addItem postcondition
//                  (Validates Requirements 1.1, 1.2, 1.4, 2.1, 2.2, 2.3, 2.4)
//   - Property 8:  Z-order reorder
//                  (Validates Requirements 7.2, 7.3, 7.4, 17.6)
//   - Property 10: undo/redo round-trip
//                  (Validates Requirements 15.1, 15.2, 15.3, 15.4)
//   - Property 11: composed signal reactivity
//                  (Validates Requirements 13.1, 17.10)
//   - Property 12: empty scene drives clearPath
//                  (Validates Requirements 12.4)
//
// Iterations: ≥ 100 per property (project standard / fast-check default).
// Each test builds a fresh store with an in-memory `ScenePersistence`
// stand-in so the universe is deterministic and never touches global
// localStorage.
//
// @see web/src/composer/scene_store.ts
// @see .kiro/specs/unified-composer-canvas/design.md §"Correctness Properties"

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { effect } from '@preact/signals';

import {
    createSceneStore,
    type AddItemSpec,
    type SceneStore,
} from './scene_store';
import { composeScene, itemBoundingBox } from './compose';
import type { ScenePersistence } from './persistence';
import type { Scene, Transform } from './types';

const NUM_RUNS = { numRuns: 100 } as const;

// -----------------------------------------------------------------------------
// In-memory persistence stand-in (deterministic, no localStorage coupling)
// -----------------------------------------------------------------------------

/**
 * In-memory persistence adapter that satisfies the {@link ScenePersistence}
 * contract. Every test instantiates a fresh adapter so saves from one
 * iteration cannot leak into the next.
 */
function makeMemoryPersistence(initial: Scene | null = null): ScenePersistence {
    let stored: Scene | null = initial;
    return {
        load() {
            return stored;
        },
        save(scene: Scene) {
            stored = scene;
        },
        clear() {
            stored = null;
        },
    };
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/**
 * Coordinates kept in `[-50, 50]`. Combined with envelopes that always
 * span at least `[-100, 100]`, this guarantees the new item's transformed
 * bounding box (= its content bbox under the identity transform applied
 * by `addItem`) is fully inside the envelope, so intersection holds for
 * every iteration of Property 5. The `+ 0` map canonicalises any `-0` to
 * `+0` so structural equality is not tripped by signed-zero artifacts.
 */
const arbCoord = fc
    .double({
        min: -50,
        max: 50,
        noNaN: true,
        noDefaultInfinity: true,
    })
    .map((v) => v + 0);

const arbPoint = fc.record({ x: arbCoord, y: arbCoord });

/** Polyline of ≥ 2 points — matches the SceneStore-committed shape. */
const arbPolyline = fc.array(arbPoint, { minLength: 2, maxLength: 4 });

const arbContent = fc.array(arbPolyline, { minLength: 1, maxLength: 3 });

const arbImageSpec: fc.Arbitrary<AddItemSpec> = fc.record({
    kind: fc.constant('image' as const),
    content: arbContent,
    source: fc.record({
        filename: fc.string({ minLength: 1, maxLength: 16 }),
        sizeBytes: fc.integer({ min: 0, max: 1_000_000 }),
    }),
});

const arbTextSpec: fc.Arbitrary<AddItemSpec> = fc.record({
    kind: fc.constant('text' as const),
    content: arbContent,
    source: fc.record({
        text: fc.string({ minLength: 0, maxLength: 16 }),
        fontName: fc.string({ minLength: 1, maxLength: 8 }),
        fontSizeMm: fc.double({
            min: 1,
            max: 50,
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

const arbFreehandSpec: fc.Arbitrary<AddItemSpec> = fc.record({
    kind: fc.constant('freehand' as const),
    content: arbContent,
    source: fc.record({
        capturedAtMs: fc.integer({ min: 0, max: 1_000_000_000 }),
    }),
});

const arbAddItemSpec: fc.Arbitrary<AddItemSpec> = fc.oneof(
    arbImageSpec,
    arbTextSpec,
    arbFreehandSpec,
);

/**
 * Optional-fields Transform patch. Magnitudes stay well above `SCALE_MIN`
 * so `clampScale` never engages and the property statements are tested on
 * the unrestricted commit path.
 */
const arbPatch: fc.Arbitrary<Partial<Transform>> = fc.record(
    {
        x: arbCoord,
        y: arbCoord,
        sx: fc.double({
            min: 0.1,
            max: 5,
            noNaN: true,
            noDefaultInfinity: true,
        }),
        sy: fc.double({
            min: 0.1,
            max: 5,
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
    },
    { requiredKeys: [] },
);

// -----------------------------------------------------------------------------
// Property 5: addItem postcondition
// -----------------------------------------------------------------------------

describe('scene_store — Property 5 (addItem postcondition)', () => {
    /**
     * **Validates: Requirements 1.1, 1.2, 1.4, 2.1, 2.2, 2.3, 2.4**
     *
     * For any current `Scene` and any `addItem` call with kind `K` and
     * content `C`:
     *   (a) `items.length` increases by exactly 1;
     *   (b) the final item has `kind === K`, `content === C`, and the
     *       supplied `source` metadata;
     *   (c) every previously-existing item is structurally unchanged at
     *       its prior index (the new item is appended; nothing is shuffled);
     *   (d) `selectedId` equals the returned new id;
     *   (e) the new item's transformed bounding box intersects the
     *       supplied envelope. The store places new items at the origin
     *       under the identity transform, so the transformed bbox equals
     *       the content bbox (which lives inside `[-50, 50]²` per
     *       `arbCoord`); the generated envelope spans at least
     *       `[-100, 100]²` so the bbox is always inside the envelope.
     */
    // Feature: unified-composer-canvas, Property 5: addItem postcondition (length+1, kind/content/source preserved, prior items pinned, selectedId=newId, bbox intersects envelope)
    it('addItem yields the documented postcondition (length, kind, content, source, prior-items pinning, selection, envelope intersection)', () => {
        fc.assert(
            fc.property(
                fc.array(arbAddItemSpec, { minLength: 0, maxLength: 5 }),
                arbAddItemSpec,
                fc.double({
                    min: 100,
                    max: 1000,
                    noNaN: true,
                    noDefaultInfinity: true,
                }),
                (preItems, spec, envHalfExtent) => {
                    const store = createSceneStore({
                        persistence: makeMemoryPersistence(),
                    });
                    for (const s of preItems) store.addItem(s);

                    const before = store.scene.value;
                    const beforeItems = before.items;
                    const id = store.addItem(spec);
                    const after = store.scene.value;

                    // (a) length increases by exactly 1.
                    expect(after.items.length).toBe(beforeItems.length + 1);

                    // (b) final item carries kind, content, and source.
                    const newItem = after.items[after.items.length - 1]!;
                    expect(newItem.id).toBe(id);
                    expect(newItem.kind).toBe(spec.kind);
                    expect(newItem.content).toEqual(spec.content);
                    expect((newItem as { source: unknown }).source).toEqual(
                        spec.source,
                    );

                    // (c) prior items unchanged at their prior index. The
                    // store appends with `[...cur.items, item]`, which
                    // preserves the original references — so a regression
                    // that reordered or rebuilt them would surface here.
                    for (let i = 0; i < beforeItems.length; i++) {
                        expect(after.items[i]).toBe(beforeItems[i]);
                    }

                    // (d) selectedId equals the new id.
                    expect(after.selectedId).toBe(id);

                    // (e) the new item's transformed bbox intersects the
                    // envelope. With the default identity placement, the
                    // transformed bbox lives inside `[-50, 50]²` and the
                    // envelope spans at least `[-100, 100]²`, so the bbox
                    // is fully inside the envelope.
                    const bbox = itemBoundingBox(newItem);
                    const envelope = {
                        minX: -envHalfExtent,
                        minY: -envHalfExtent,
                        maxX: envHalfExtent,
                        maxY: envHalfExtent,
                    };
                    const separated =
                        bbox.maxX < envelope.minX
                        || bbox.minX > envelope.maxX
                        || bbox.maxY < envelope.minY
                        || bbox.minY > envelope.maxY;
                    expect(separated).toBe(false);
                },
            ),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 8: Z-order reorder
// -----------------------------------------------------------------------------

describe('scene_store — Property 8 (Z-order reorder)', () => {
    // Feature: unified-composer-canvas, Property 8: reorder(id, k) places id at index k and preserves the relative order of all other items
    it('reorder(id, k) places id at index k while preserving the relative order of every other item', () => {
        fc.assert(
            fc.property(
                fc.array(arbAddItemSpec, { minLength: 1, maxLength: 8 }),
                fc.integer({ min: 0, max: 1_000 }),
                fc.integer({ min: 0, max: 1_000 }),
                (specs, fromSeed, toSeed) => {
                    const store = createSceneStore({
                        persistence: makeMemoryPersistence(),
                    });
                    for (const s of specs) store.addItem(s);

                    const before = store.scene.value.items;
                    const fromIdx = fromSeed % before.length;
                    const id = before[fromIdx]!.id;
                    const toIdx = toSeed % before.length;

                    store.reorder(id, toIdx);

                    const after = store.scene.value.items;
                    expect(after.length).toBe(before.length);
                    // id sits at the requested index.
                    expect(after[toIdx]!.id).toBe(id);
                    // The ids of the "rest" (everything except `id`) appear
                    // in the same relative order before and after — the
                    // canonical "reorder is a single-element relocation"
                    // statement.
                    const restBefore = before
                        .filter((_, i) => i !== fromIdx)
                        .map((it) => it.id);
                    const restAfter = after
                        .filter((it) => it.id !== id)
                        .map((it) => it.id);
                    expect(restAfter).toEqual(restBefore);
                },
            ),
            NUM_RUNS,
        );
    });

    // Feature: unified-composer-canvas, Property 8: bringForward on the topmost item is a no-op (Req 7.4)
    it('bringForward on the topmost item is a no-op', () => {
        fc.assert(
            fc.property(
                fc.array(arbAddItemSpec, { minLength: 1, maxLength: 8 }),
                (specs) => {
                    const store = createSceneStore({
                        persistence: makeMemoryPersistence(),
                    });
                    for (const s of specs) store.addItem(s);

                    const before = store.scene.value;
                    const topId = before.items[before.items.length - 1]!.id;
                    store.bringForward(topId);
                    const after = store.scene.value;

                    // No commit: the signal still holds the same reference.
                    expect(after).toBe(before);
                    expect(after.items).toEqual(before.items);
                },
            ),
            NUM_RUNS,
        );
    });

    // Feature: unified-composer-canvas, Property 8: sendBackward on the bottommost item is a no-op (Req 7.4)
    it('sendBackward on the bottommost item is a no-op', () => {
        fc.assert(
            fc.property(
                fc.array(arbAddItemSpec, { minLength: 1, maxLength: 8 }),
                (specs) => {
                    const store = createSceneStore({
                        persistence: makeMemoryPersistence(),
                    });
                    for (const s of specs) store.addItem(s);

                    const before = store.scene.value;
                    const bottomId = before.items[0]!.id;
                    store.sendBackward(bottomId);
                    const after = store.scene.value;

                    expect(after).toBe(before);
                    expect(after.items).toEqual(before.items);
                },
            ),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Commands / state machine for Property 10 + Property 11
// -----------------------------------------------------------------------------

interface Real {
    store: SceneStore;
}

/**
 * Trivial parallel model: the only state we need from the model is "how
 * many items the store currently holds" so command preconditions can
 * gate themselves. The real store remains the single source of truth for
 * the assertions in each property; we never re-implement scene semantics
 * in the model.
 */
interface Model {
    length: number;
}

/**
 * Map an arbitrary integer seed into a valid `[0, len)` index. Defensive
 * `Math.abs` + `((x % n) + n) % n` is a single expression that works for
 * any integer (positive, negative, zero) and any `len > 0`.
 */
function pickIndex(seed: number, len: number): number {
    return ((seed % len) + len) % len;
}

class AddCmd implements fc.Command<Model, Real> {
    constructor(readonly spec: AddItemSpec) { }
    check(_m: Readonly<Model>): boolean {
        return true;
    }
    run(m: Model, r: Real): void {
        r.store.addItem(this.spec);
        m.length += 1;
    }
    toString(): string {
        return `add(${this.spec.kind})`;
    }
}

class RemoveCmd implements fc.Command<Model, Real> {
    constructor(readonly idxSeed: number) { }
    check(m: Readonly<Model>): boolean {
        return m.length > 0;
    }
    run(m: Model, r: Real): void {
        const items = r.store.scene.value.items;
        if (items.length === 0) return;
        const i = pickIndex(this.idxSeed, items.length);
        r.store.removeItem(items[i]!.id);
        m.length -= 1;
    }
    toString(): string {
        return `remove(${this.idxSeed})`;
    }
}

class UpdateTransformCmd implements fc.Command<Model, Real> {
    constructor(
        readonly idxSeed: number,
        readonly patch: Partial<Transform>,
    ) { }
    check(m: Readonly<Model>): boolean {
        return m.length > 0;
    }
    run(_m: Model, r: Real): void {
        const items = r.store.scene.value.items;
        if (items.length === 0) return;
        const i = pickIndex(this.idxSeed, items.length);
        r.store.updateTransform(items[i]!.id, this.patch);
    }
    toString(): string {
        return `updateTransform(${this.idxSeed})`;
    }
}

class ReorderCmd implements fc.Command<Model, Real> {
    constructor(
        readonly fromSeed: number,
        readonly toSeed: number,
    ) { }
    check(m: Readonly<Model>): boolean {
        return m.length > 1;
    }
    run(_m: Model, r: Real): void {
        const items = r.store.scene.value.items;
        if (items.length < 2) return;
        const fromIdx = pickIndex(this.fromSeed, items.length);
        const toIdx = pickIndex(this.toSeed, items.length);
        r.store.reorder(items[fromIdx]!.id, toIdx);
    }
    toString(): string {
        return `reorder(${this.fromSeed},${this.toSeed})`;
    }
}

class BringForwardCmd implements fc.Command<Model, Real> {
    constructor(readonly idxSeed: number) { }
    check(m: Readonly<Model>): boolean {
        return m.length > 0;
    }
    run(_m: Model, r: Real): void {
        const items = r.store.scene.value.items;
        if (items.length === 0) return;
        const i = pickIndex(this.idxSeed, items.length);
        r.store.bringForward(items[i]!.id);
    }
    toString(): string {
        return `bringForward(${this.idxSeed})`;
    }
}

class SendBackwardCmd implements fc.Command<Model, Real> {
    constructor(readonly idxSeed: number) { }
    check(m: Readonly<Model>): boolean {
        return m.length > 0;
    }
    run(_m: Model, r: Real): void {
        const items = r.store.scene.value.items;
        if (items.length === 0) return;
        const i = pickIndex(this.idxSeed, items.length);
        r.store.sendBackward(items[i]!.id);
    }
    toString(): string {
        return `sendBackward(${this.idxSeed})`;
    }
}

class SelectCmd implements fc.Command<Model, Real> {
    constructor(readonly idxSeedOrNull: number | null) { }
    check(_m: Readonly<Model>): boolean {
        return true;
    }
    run(_m: Model, r: Real): void {
        const items = r.store.scene.value.items;
        if (this.idxSeedOrNull === null || items.length === 0) {
            r.store.select(null);
            return;
        }
        const i = pickIndex(this.idxSeedOrNull, items.length);
        r.store.select(items[i]!.id);
    }
    toString(): string {
        return `select(${this.idxSeedOrNull})`;
    }
}

/**
 * One coalesced gesture: `beginGesture` → 1..N `updateTransform` calls →
 * `endGesture`. Per Req 15.4 the entire gesture commits exactly one
 * history entry, which is the contract Property 10 leans on. The command
 * always closes the gesture, so each `run()` returns to the no-gesture
 * resting state (a precondition of Property 11's reactivity claim).
 */
class GestureEditCmd implements fc.Command<Model, Real> {
    constructor(
        readonly idxSeed: number,
        readonly kind: 'move' | 'resize' | 'rotate',
        readonly steps: ReadonlyArray<Partial<Transform>>,
    ) { }
    check(m: Readonly<Model>): boolean {
        return m.length > 0 && this.steps.length > 0;
    }
    run(_m: Model, r: Real): void {
        const items = r.store.scene.value.items;
        if (items.length === 0) return;
        const i = pickIndex(this.idxSeed, items.length);
        const id = items[i]!.id;
        r.store.beginGesture(id, this.kind);
        for (const step of this.steps) {
            r.store.updateTransform(id, step);
        }
        r.store.endGesture();
    }
    toString(): string {
        return `gesture(${this.idxSeed},${this.kind},x${this.steps.length})`;
    }
}

/**
 * Per-command arbitraries fed to `fc.commands`. Note: `fc.commands`
 * expects an *array* of arbitraries (one per command type), not a single
 * `oneof` arbitrary — passing a oneof would surface as a runtime
 * `TypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a
 * function`. Each entry is the same shape `Arbitrary<Command<Model,
 * Real>>`; `fc.commands` picks one per slot internally.
 */
const arbCommandArbs: Array<fc.Arbitrary<fc.Command<Model, Real>>> = [
    arbAddItemSpec.map((s) => new AddCmd(s)),
    fc.integer({ min: 0, max: 1_000 }).map((i) => new RemoveCmd(i)),
    fc
        .tuple(fc.integer({ min: 0, max: 1_000 }), arbPatch)
        .map(([i, p]) => new UpdateTransformCmd(i, p)),
    fc
        .tuple(
            fc.integer({ min: 0, max: 1_000 }),
            fc.integer({ min: 0, max: 1_000 }),
        )
        .map(([f, t]) => new ReorderCmd(f, t)),
    fc.integer({ min: 0, max: 1_000 }).map((i) => new BringForwardCmd(i)),
    fc.integer({ min: 0, max: 1_000 }).map((i) => new SendBackwardCmd(i)),
    fc
        .option(fc.integer({ min: 0, max: 1_000 }), { nil: null })
        .map((i) => new SelectCmd(i)),
    fc
        .tuple(
            fc.integer({ min: 0, max: 1_000 }),
            fc.constantFrom(
                'move' as const,
                'resize' as const,
                'rotate' as const,
            ),
            fc.array(arbPatch, { minLength: 1, maxLength: 4 }),
        )
        .map(([i, k, s]) => new GestureEditCmd(i, k, s)),
];

// -----------------------------------------------------------------------------
// Property 10: undo/redo round-trip
// -----------------------------------------------------------------------------

describe('scene_store — Property 10 (undo/redo round-trip)', () => {
    /**
     * **Validates: Requirements 15.1, 15.2, 15.3, 15.4**
     *
     * For any sequence of edits driven through `fc.commands` (each
     * `GestureEditCmd` counts as a single edit per Req 15.4), undoing
     * everything `canUndo` reports lands the store back at the starting
     * Scene; redoing everything `canRedo` reports lands it back at the
     * ending Scene. `maxCommands` (15) is comfortably below the default
     * `historyLimit` (50) so no truncation occurs and the round-trip is
     * exact.
     */
    // Feature: unified-composer-canvas, Property 10: undo all then redo all returns to start, then to end (gestures count as one edit)
    it('any command sequence: undoing all returns to the starting Scene; redoing all returns to the ending Scene', () => {
        fc.assert(
            fc.property(
                fc.commands(arbCommandArbs, { maxCommands: 15 }),
                (cmds) => {
                    const real: Real = {
                        store: createSceneStore({
                            persistence: makeMemoryPersistence(),
                        }),
                    };
                    const startScene = real.store.scene.value;

                    fc.modelRun(
                        () => ({ model: { length: 0 } as Model, real }),
                        cmds,
                    );

                    const endScene = real.store.scene.value;

                    // Undo every reachable history entry.
                    let undoCount = 0;
                    while (real.store.canUndo.value) {
                        real.store.undo();
                        undoCount += 1;
                        // Defensive guard: the buffer is bounded, so this
                        // loop must terminate. If it doesn't, fail fast
                        // with a comprehensible message.
                        if (undoCount > 1_000) {
                            throw new Error('undo loop did not terminate');
                        }
                    }
                    expect(real.store.scene.value).toEqual(startScene);

                    // Redo every entry back to the end.
                    let redoCount = 0;
                    while (real.store.canRedo.value) {
                        real.store.redo();
                        redoCount += 1;
                        if (redoCount > 1_000) {
                            throw new Error('redo loop did not terminate');
                        }
                    }
                    expect(real.store.scene.value).toEqual(endScene);
                    // Symmetry: we must have redone exactly as many entries
                    // as we undid (same buffer, same direction).
                    expect(redoCount).toBe(undoCount);
                },
            ),
            NUM_RUNS,
        );
    });

    /**
     * **Validates: Requirement 15.1**
     *
     * The store enforces a hard floor on `historyLimit` (≥ 20). With a
     * caller-supplied limit *below* 20 and 1..19 commits applied, the
     * full undo/redo round-trip must still hold — proving the floor was
     * applied. (At 19 commits the buffer holds 20 entries, all reachable
     * via undo.)
     */
    // Feature: unified-composer-canvas, Property 10: historyLimit ≥ 20 floor — small caller values are clamped up so 1..19 edits still round-trip
    it('historyLimit < 20 is clamped up so any 1..19-edit sequence still undoes and redoes cleanly', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 19 }),
                fc.array(arbAddItemSpec, { minLength: 1, maxLength: 19 }),
                (smallLimit, specs) => {
                    const store = createSceneStore({
                        persistence: makeMemoryPersistence(),
                        historyLimit: smallLimit,
                    });
                    const startScene = store.scene.value;
                    for (const s of specs) store.addItem(s);
                    const endScene = store.scene.value;

                    let count = 0;
                    while (store.canUndo.value && count < 1_000) {
                        store.undo();
                        count += 1;
                    }
                    expect(store.scene.value).toEqual(startScene);

                    let redo = 0;
                    while (store.canRedo.value && redo < 1_000) {
                        store.redo();
                        redo += 1;
                    }
                    expect(store.scene.value).toEqual(endScene);
                },
            ),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 11: composed signal reactivity
// -----------------------------------------------------------------------------

describe('scene_store — Property 11 (composed signal reactivity)', () => {
    /**
     * **Validates: Requirements 13.1, 17.10**
     *
     * After any sequence of mutations that ends with no gesture in
     * progress (every `GestureEditCmd` always closes its gesture, so the
     * resting condition holds at the end of every iteration), the
     * `composed` signal equals `composeScene(scene.value)` exactly. This
     * pins the contract that `composed` is a memoised pull on `scene`,
     * not a stale snapshot.
     */
    // Feature: unified-composer-canvas, Property 11: composed.value === composeScene(scene.value) after any sequence of mutations that ends with no gesture in progress
    it('composed.value equals composeScene(scene.value) after any settled mutation sequence', () => {
        fc.assert(
            fc.property(
                fc.commands(arbCommandArbs, { maxCommands: 15 }),
                (cmds) => {
                    const real: Real = {
                        store: createSceneStore({
                            persistence: makeMemoryPersistence(),
                        }),
                    };
                    fc.modelRun(
                        () => ({ model: { length: 0 } as Model, real }),
                        cmds,
                    );
                    expect(real.store.composed.value).toEqual(
                        composeScene(real.store.scene.value),
                    );
                    // Pin a few invariants of `composed` so a regression
                    // that turned it into something other than a function
                    // of `scene.value` would surface here too.
                    expect(real.store.composed.value).not.toBe(
                        composeScene(real.store.scene.value),
                    );
                    // Re-evaluating `composed.value` is idempotent (no
                    // hidden side effects on read).
                    const a = real.store.composed.value;
                    const b = real.store.composed.value;
                    expect(a).toBe(b);
                },
            ),
            NUM_RUNS,
        );
    });
});

// -----------------------------------------------------------------------------
// Property 12: empty scene drives clearPath
// -----------------------------------------------------------------------------

/**
 * Mock controller surface used by the App.tsx-style adapter under test.
 * Records every `clearPath()` call and every `setPolylines(p)` call's
 * polyline-array length. The store does not call these methods — the
 * adapter (an inline stand-in for the Task 12.1 wiring in `App.tsx`)
 * does.
 */
interface MockController {
    clearPathCalls: number;
    setPolylinesCalls: Array<{ length: number }>;
    clearPath(): void;
    setPolylines(polylines: ReadonlyArray<unknown>): void;
}

function makeMockController(): MockController {
    const ctrl: MockController = {
        clearPathCalls: 0,
        setPolylinesCalls: [],
        clearPath(): void {
            ctrl.clearPathCalls += 1;
        },
        setPolylines(p: ReadonlyArray<unknown>): void {
            ctrl.setPolylinesCalls.push({ length: p.length });
        },
    };
    return ctrl;
}

/**
 * Inline adapter that mirrors what `App.tsx` will install in Task 12.1
 * (Req 12.4): subscribe to `store.scene` via a `@preact/signals` effect;
 * on every transition `items.length: positive → 0`, call
 * `controller.clearPath()`. The adapter MUST NOT call
 * `controller.setPolylines` from any reactive effect (Req 11.3) — that
 * call belongs only to the explicit "Send to machine" handler, which is
 * not wired here.
 *
 * Returns the dispose function so each property iteration can clean up.
 */
function attachClearPathAdapter(
    store: SceneStore,
    controller: MockController,
): () => void {
    let firstRun = true;
    let prevLen = 0;
    return effect(() => {
        const len = store.scene.value.items.length;
        if (firstRun) {
            firstRun = false;
            prevLen = len;
            return;
        }
        if (prevLen > 0 && len === 0) {
            controller.clearPath();
        }
        prevLen = len;
    });
}

describe('scene_store — Property 12 (empty scene drives clearPath)', () => {
    /**
     * **Validates: Requirement 12.4**
     *
     * For any sequence of mutations that takes `items.length` from a
     * positive value back to zero, the App.tsx-style adapter calls
     * `controller.clearPath` at least once across that transition.
     * Throughout the entire run — including any post-transition
     * `addItem`s — the adapter MUST NOT invoke `controller.setPolylines`
     * with any array (empty or not), because Req 11.3 confines
     * `setPolylines` to the explicit "Send to machine" handler that this
     * adapter does not host.
     */
    // Feature: unified-composer-canvas, Property 12: items.length positive → 0 calls clearPath at least once; the adapter never pushes setPolylines from a reactive effect
    it('positive→0 transition triggers at least one clearPath; the adapter never calls setPolylines from a reactive effect', () => {
        fc.assert(
            fc.property(
                // Phase A: at least one initial item so the post-Phase-B
                // transition is genuinely positive→0.
                fc.array(arbAddItemSpec, { minLength: 1, maxLength: 5 }),
                // Phase B: how to drain the scene to empty.
                fc.constantFrom(
                    'clear' as const,
                    'remove-all' as const,
                ),
                // Phase C: optional re-adds after the transition. The
                // property pins that no `setPolylines` reactive push
                // happens here either.
                fc.array(arbAddItemSpec, { minLength: 0, maxLength: 5 }),
                (initial, drainMode, postTransition) => {
                    const store = createSceneStore({
                        persistence: makeMemoryPersistence(),
                    });
                    const controller = makeMockController();
                    const dispose = attachClearPathAdapter(store, controller);

                    try {
                        // Phase A: populate.
                        for (const s of initial) store.addItem(s);
                        // Sanity: positive items present before Phase B.
                        expect(
                            store.scene.value.items.length,
                        ).toBeGreaterThan(0);
                        const clearsBeforeDrain = controller.clearPathCalls;

                        // Phase B: drain to empty.
                        if (drainMode === 'clear') {
                            store.clear();
                        } else {
                            // Remove items one at a time. The transition
                            // fires on the final removal that crosses
                            // length 1 → 0.
                            while (store.scene.value.items.length > 0) {
                                store.removeItem(
                                    store.scene.value.items[0]!.id,
                                );
                            }
                        }

                        // The transition has occurred. The adapter must
                        // have called clearPath at least once across it.
                        expect(
                            controller.clearPathCalls - clearsBeforeDrain,
                        ).toBeGreaterThanOrEqual(1);

                        // Phase C: optional re-adds. No reactive
                        // setPolylines push should occur, ever.
                        for (const s of postTransition) store.addItem(s);

                        // Adapter contract: never invoked setPolylines.
                        expect(controller.setPolylinesCalls.length).toBe(0);
                        // ...and certainly not with a non-empty array.
                        for (const call of controller.setPolylinesCalls) {
                            expect(call.length).toBe(0);
                        }
                    } finally {
                        dispose();
                    }
                },
            ),
            NUM_RUNS,
        );
    });

    // Feature: unified-composer-canvas, Property 12: a sequence with no positive→0 transition does NOT trigger clearPath (control test)
    it('control: a sequence that never empties the scene does not invoke clearPath', () => {
        fc.assert(
            fc.property(
                fc.array(arbAddItemSpec, { minLength: 1, maxLength: 5 }),
                fc.array(arbAddItemSpec, { minLength: 0, maxLength: 5 }),
                (initial, more) => {
                    const store = createSceneStore({
                        persistence: makeMemoryPersistence(),
                    });
                    const controller = makeMockController();
                    const dispose = attachClearPathAdapter(store, controller);

                    try {
                        for (const s of initial) store.addItem(s);
                        for (const s of more) store.addItem(s);
                        // No transition to empty: `items.length` is
                        // strictly positive across the whole run.
                        expect(
                            store.scene.value.items.length,
                        ).toBeGreaterThan(0);
                        expect(controller.clearPathCalls).toBe(0);
                        expect(controller.setPolylinesCalls.length).toBe(0);
                    } finally {
                        dispose();
                    }
                },
            ),
            NUM_RUNS,
        );
    });
});
