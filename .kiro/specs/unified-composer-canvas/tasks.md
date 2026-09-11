# Implementation Plan: Unified Composer Canvas

## Overview

Build the Composer Scene from the bottom up: pure data layer first (`types.ts`),
then the pure logic that depends on it (`compose.ts`, `gestures.ts`,
`persistence.ts`) so every property can be exercised without a DOM. Wrap those
in a single reactive `SceneStore` that owns history, debounced persistence,
and the derived `composed` signal. Build the four UI components against the
store in parallel (`ComposerCanvas`, `ItemsListPanel`, `AddItemMenu`,
`AnimationPlayback`). Finally wire everything together in `App.tsx` and
`main.ts` so the existing `controller.setPolylines` / `PathPlanner.plan` /
`fitPolylinesToEnvelope` pipeline consumes `sceneStore.composed.value` instead
of any single panel's raw output. SVG-first render with a Canvas2D fallback
held in reserve. Firmware, wire codecs, and the Python sidecar are out of
scope.

## Tasks

- [x] 1. Define the Composer data model
  - Create `web/src/composer/types.ts` exporting `ItemId`, `Transform`,
    `BaseItem`, `Image_Item`, `Text_Item`, `Freehand_Item`, `Item`, `Scene`,
    plus the `EMPTY_SCENE` constant and `makeIdentityTransform()` helper.
  - Every shape MUST be JSON-serialisable (no Date, no Map, no functions).
  - `Scene.schemaVersion` is the literal `1`.
  - `items` ordering convention: `items[0]` is bottommost, `items[length-1]` is
    topmost (drawn last).
  - _Requirements: 9.1, 10.3, 14.1, 14.4_

- [x] 2. Implement the pure composition layer
  - [x] 2.1 Implement `composeScene` and the affine helpers
    - Create `web/src/composer/compose.ts` exporting `composeScene(scene)`,
      `applyTransform(t, p)`, `applyTransformToPolyline(t, poly)`, and
      `itemBoundingBox(item)`.
    - Affine: `T(p) = R(rotationRad) · S(sx, sy) · p + (x, y)`, expanded to
      `(cos·sx·p.x − sin·sy·p.y + x, sin·sx·p.x + cos·sy·p.y + y)`.
    - Skip any input polyline with fewer than two points (defensive — the
      planner would skip it anyway).
    - No DOM, no signals, no I/O, no globals; depends only on its argument.
    - _Requirements: 9.1, 9.2, 9.3, 9.6, 9.7, 10.1, 10.2_

  - [x] 2.2 Property-based tests for the pure composer
    - Create `web/src/composer/compose.props.test.ts` (fast-check, ≥ 100
      iterations per property). Each `it(...)` line is tagged
      `// Feature: unified-composer-canvas, Property N: <text>`.
    - **Property 1: composeScene Z-order** — output is the concatenation in
      ascending `items` index order; for any `i < j`, every polyline from
      `items[i]` precedes every polyline from `items[j]` in the output.
      Validates: Requirements 1.2, 1.3, 1.4, 9.1, 9.3.
    - **Property 2: composeScene affine correctness** — for any item and any
      local-frame point, the output equals the closed-form affine within
      IEEE-754 round-off. Validates: Requirements 1.3, 9.2.
    - **Property 3: composeScene determinism and purity** — structurally
      equal Scenes produce structurally equal outputs; the input is not
      mutated. Validates: Requirements 10.1, 10.2.
    - **Property 4: composeScene non-degenerate bounding box** — when every
      item has ≥ 2 distinct content points and `|sx|, |sy| > SCALE_MIN`, the
      composed bounding box has width > 0 AND height > 0. Validates:
      Requirements 9.7.
    - _Requirements: 9.1, 9.2, 9.3, 9.7, 10.1, 10.2_
    - _Properties: Property 1, Property 2, Property 3, Property 4_

- [x] 3. Implement gesture math helpers
  - [x] 3.1 Translate, resize, rotate, clamp, normalise
    - Create `web/src/composer/gestures.ts` exporting `moveTransform`,
      `resizeFromCorner`, `resizeFromEdge`, `rotateToPointer`, `clampScale`,
      `normaliseRotation`, and the `SCALE_MIN` constant.
    - Pure — no DOM, no signals. Inputs are scene-unit numbers and the
      gesture-start `Transform` / bounding box; outputs are new `Transform`
      values.
    - `clampScale` enforces `|sx|, |sy| ≥ SCALE_MIN` (suggested `1e-3`).
    - `normaliseRotation` returns `rotationRad` in `[0, 2π)`.
    - `rotateToPointer(..., snap15deg=true)` rounds to the nearest `π/12`.
    - `resizeFromCorner` keeps the opposite corner of `bbox0` fixed; with
      `aspectLock`, preserves `t0.sx / t0.sy`.
    - _Requirements: 4.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3_

  - [x] 3.2 Property-based tests for gesture math
    - Create `web/src/composer/gestures.props.test.ts` (fast-check, ≥ 100
      iterations). Tag each `it(...)` with
      `// Feature: unified-composer-canvas, Property 7: <text>`.
    - **Property 7: transform laws (move / resize / rotate)** — translate
      shifts only `(x, y)`; corner-resize keeps the opposite corner fixed and
      under `aspectLock` preserves the starting aspect ratio; every resize
      output (post-`clampScale`) satisfies `|sx|, |sy| ≥ SCALE_MIN`;
      `rotateToPointer` returns `rotationRad ∈ [0, 2π)` equal to
      `atan2(p − pivot)` mod 2π, snapping to multiples of `π/12` when
      `snap15deg=true`.
    - Validates: Requirements 4.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 8.1,
      8.2, 8.3, 8.4, 8.5, 8.6.
    - _Requirements: 4.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
    - _Properties: Property 7_

- [x] 4. Implement persistence with size cap and storage-error safety
  - [x] 4.1 Serialise / parse / localStorage adapter
    - Create `web/src/composer/persistence.ts` exporting the
      `ScenePersistence` interface, `createLocalStoragePersistence(opts)`,
      `serialiseScene(scene)`, `parseScene(raw)`, `MAX_SNAPSHOT_BYTES`
      (≈ `2_000_000`), and `SNAPSHOT_TOO_LARGE_MESSAGE` ("Scene too large to
      auto-save — use Export to keep it, or remove items").
    - Default key: `eas:composer:scene:v1`. Default `schemaVersion`: `1`.
    - `parseScene` returns `null` for malformed JSON OR a `schemaVersion`
      mismatch — never throws to the caller.
    - `save(scene)` measures `serialiseScene(scene).length`; if it would
      exceed `maxBytes`, skip the write and call
      `onTooLarge('too-large', SNAPSHOT_TOO_LARGE_MESSAGE)`.
    - Wrap the actual `localStorage.setItem` in try/catch; on any throw, call
      `onTooLarge('storage-error', SNAPSHOT_TOO_LARGE_MESSAGE)` and return
      without rethrowing.
    - `load()` returns `null` when storage is unavailable, the key is missing,
      or `parseScene` returns `null`.
    - `clear()` removes the key (try/catch, no rethrow).
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_

  - [x] 4.2 Property-based tests for persistence
    - Create `web/src/composer/persistence.props.test.ts` (fast-check, ≥ 100
      iterations). Tag each `it(...)` with the corresponding feature/property
      comment.
    - **Property 9: Scene serialisation round-trip** — for any Scene produced
      by mutators (image, text, freehand items mixed; varied transforms),
      `parseScene(serialiseScene(s))` is structurally equal to `s` (same
      items in the same order, same transforms, same content polylines, same
      `source` metadata, same `selectedId`, same `schemaVersion`). Validates:
      Requirements 10.3, 14.1, 14.2, 14.4.
    - **Property 16: Persistence size cap and storage-error safety** — if
      the serialised length exceeds `MAX_SNAPSHOT_BYTES`, no write happens
      and `onTooLarge('too-large', SNAPSHOT_TOO_LARGE_MESSAGE)` fires; if the
      injected storage throws, no write happens, no exception escapes, and
      `onTooLarge('storage-error', SNAPSHOT_TOO_LARGE_MESSAGE)` fires.
      Validates: Requirements 14.6, 14.7.
    - Cover negative parse paths for Req 14.3: malformed JSON, mismatched
      `schemaVersion`, missing fields → all return `null` without throwing.
    - _Requirements: 10.3, 14.1, 14.2, 14.3, 14.4, 14.6, 14.7_
    - _Properties: Property 9, Property 16_

- [x] 5. Implement the reactive SceneStore
  - [x] 5.1 Store, signals, mutators, gestures, history, persistence
    - Create `web/src/composer/scene_store.ts` exporting the `SceneStore`
      interface, `SceneStoreOptions`, and `createSceneStore(opts)`.
    - Internal state: `signal<Scene>(initial)`, where `initial` is
      `persistence.load() ?? EMPTY_SCENE`.
    - Derived signals: `selectedItem` (lookup by `selectedId`), `composed`
      (`computed(() => composeScene(scene.value))`), `canUndo`, `canRedo`.
    - Mutators MUST commit at most one history entry each:
      `addItem` (generates a ULID-style id, places the new item at a default
      Transform that is visible inside the envelope and selects it),
      `removeItem` (clears `selectedId` if the removed item was selected,
      Req 3.6), `updateTransform` (patches), `reorder` (clamped index),
      `bringForward`, `sendBackward`, `select`, `clear` (empties the Scene
      AND calls `persistence.clear()` per Req 14.5).
    - Gesture lifecycle: `beginGesture(id, kind)` snapshots the pre-gesture
      Transform; subsequent `updateTransform` calls coalesce into ONE history
      entry committed on `endGesture()`. `cancelGesture()` restores the
      pre-gesture Transform without recording history.
    - Persist on rest only: subscribe to `scene` changes via `effect`; while
      a gesture is active, suppress the write; on `endGesture` (or any
      non-gesture mutation), call `persistence.save(scene.value)` (debounce
      OK, not required).
    - History bound: `historyLimit` default 50, minimum supported ≥ 20
      (Req 15.1).
    - `undo()` / `redo()` no-op when `canUndo`/`canRedo` is false.
    - `addItem` MUST NOT call `controller.setPolylines` as a side effect
      (Req 2.5).
    - On every Transform commit: clamp via `clampScale` and normalise via
      `normaliseRotation` so invariants always hold.
    - _Requirements: 1.1, 1.2, 1.4, 2.4, 2.5, 3.1, 3.2, 3.4, 3.6, 5.4, 6.2, 7.1, 7.2, 7.3, 7.4, 11.2, 11.3, 11.4, 14.1, 14.5, 15.1, 15.2, 15.3, 15.4, 15.5, 17.6, 17.10_

  - [x] 5.2 Property-based tests for the store
    - Create `web/src/composer/scene_store.props.test.ts` (fast-check, ≥ 100
      iterations). Each `it(...)` line tagged with
      `// Feature: unified-composer-canvas, Property N: <text>`.
    - **Property 5: addItem postcondition** — after any `addItem`,
      `items.length` increases by exactly 1; the final item has the supplied
      kind and content; every previously-existing item is unchanged at its
      prior index; `selectedId` equals the new id; the new item's
      transformed bounding box intersects the supplied envelope. Validates:
      Requirements 1.1, 1.2, 1.4, 2.1, 2.2, 2.3, 2.4.
    - **Property 8: Z-order reorder** — `reorder(id, k)` places `id` at
      index `k` and preserves the relative order of the rest; `bringForward`
      on the topmost item is a no-op; `sendBackward` on the bottom item is a
      no-op. Validates: Requirements 7.2, 7.3, 7.4, 17.6.
    - **Property 10: undo/redo round-trip** — for any sequence of edits
      (gestures count as one edit each), applying all then undoing all
      returns the starting Scene; redoing all returns the ending Scene; the
      history honours `historyLimit ≥ 20`. Use fast-check `commands` /
      state-machine combinators. Validates: Requirements 15.1, 15.2, 15.3,
      15.4.
    - **Property 11: composed signal reactivity** — after any sequence of
      mutations that ends with no gesture in progress, `composed.value`
      equals `composeScene(scene.value)`. Validates: Requirements 13.1,
      17.10.
    - **Property 12: empty scene drives clearPath** — the store exposes the
      transition `items.length: positive → 0`; record those transitions on a
      mock controller and assert `clearPath` is called at least once and
      `setPolylines` is NOT called with a non-empty array between the
      transition and the next `addItem`. Validates: Requirements 12.4.
    - _Requirements: 1.1, 1.2, 1.4, 2.1, 2.2, 2.3, 2.4, 7.2, 7.3, 7.4, 12.4, 13.1, 15.1, 15.2, 15.3, 15.4, 17.6, 17.10_
    - _Properties: Property 5, Property 8, Property 10, Property 11, Property 12_

- [x] 6. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Build the Composer canvas surface
  - [x] 7.1 Implement `ComposerCanvas`
    - Create `web/src/ui/composer/ComposerCanvas.tsx` exporting
      `ComposerCanvasProps` and `ComposerCanvas`.
    - SVG-first: one `<g transform="translate(x,y) rotate(deg) scale(sx,sy)">`
      per item, polylines as `<polyline>` children, items emitted in `Scene`
      array order so the topmost item is the last DOM child (Req 1.3).
    - Render the dashed drawable-envelope rectangle inside the same SVG so
      the user sees the digital twin (Req 13.2).
    - Render the selection overlay only when `store.selectedItem.value` is
      non-null: 8 resize handles + 1 rotation handle around the item's
      transformed bounding box, with an `aria-label` describing the item type
      (Req 8.7).
    - Pointer-event routing through `gestures.ts`: pointer-down on a handle
      starts a resize/rotate gesture; pointer-down inside an item's bounding
      box starts a move gesture (Req 4.1) and selects the topmost item under
      the pointer (Req 3.1, 3.2); pointer-down on empty canvas clears
      selection (Req 3.4); Shift modifier triggers aspect-lock for corner
      resizes (Req 5.3) and 15° snap for rotation (Req 6.3); each gesture
      brackets its `updateTransform` calls with `beginGesture` /
      `endGesture`.
    - Keyboard accessibility on a `tabindex=0` SVG root: arrow keys move
      ±1 unit (±10 with Shift), `+`/`=` and `-` scale by `1.1` and `1/1.1`,
      `[` and `]` rotate by ±15° (Req 8.1–8.6).
    - Canvas2D fallback: keep the SVG render path the default; a behind-feature
      flag (`?renderer=canvas2d` URL param) routes to a `<canvas>` element
      that re-projects polylines per frame using `applyTransformToPolyline`.
      Used only if the Wave-4 perf benchmark fails on a target browser.
    - _Requirements: 1.3, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.5, 6.1, 6.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 13.2_

  - [x] 7.2 Component tests for `ComposerCanvas`
    - Create `web/src/ui/composer/ComposerCanvas.test.tsx` (Preact +
      happy-dom). Tag PBT-style cases with
      `// Feature: unified-composer-canvas, Property 6: <text>` where
      applicable.
    - Selection by click; topmost wins for overlapping items
      (**Property 6: hit-test selects the topmost item**, validates
      Requirements 3.1, 3.2, 3.4); empty-canvas click clears selection.
    - Pointer-drag dispatches translate; corner-drag dispatches resize with
      the opposite corner fixed; rotation handle dispatches rotation; Shift
      triggers aspect-lock and 15° snap; Backspace/Delete removes the
      selected item (Req 7.1).
    - Keyboard tests: arrow / Shift+arrow translation, `+/-` scale, `[/]`
      rotation by 15°.
    - Selection overlay carries an accessible `aria-label` per item type
      (Req 8.7).
    - _Requirements: 3.1, 3.2, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1, 6.3, 7.1, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_
    - _Properties: Property 6_

- [x] 8. Build the Items List panel
  - [x] 8.1 Implement `ItemsListPanel`
    - Create `web/src/ui/composer/ItemsListPanel.tsx` exporting
      `ItemsListPanelProps` and `ItemsListPanel`.
    - Display rows from `[...store.scene.value.items].reverse()` so the
      topmost item appears at the top of the list (Req 17.1).
    - Per-row label (Req 17.2):
      `Image: <source.filename>`, `Text: <source.text>`, or
      `Freehand stroke`. Truncate to 32 chars with a single-character
      ellipsis (`"…"`) when the unrestricted label would exceed 32 chars
      (Req 17.3).
    - Click row → `store.select(id)` (Req 17.4); selected row is visually
      distinct (Req 17.5).
    - Drag-to-reorder: track a drop indicator while the gesture is in flight
      and DO NOT mutate the Scene until pointer-up (Req 17.7); on drop, call
      `store.reorder(id, toIndex)` (Req 17.6).
    - Per-row delete button → `store.removeItem(id)` (Req 17.8).
    - Empty-state: render `"No items yet — add an image, text, or a freehand
      drawing to get started"` and zero rows when the Scene is empty
      (Req 17.9).
    - The component reads `store.scene` and `store.selectedItem` reactively;
      no manual subscription/unsubscription (Req 17.10).
    - Renders the optional `addMenu` slot above the list.
    - _Requirements: 7.1, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10_

  - [x] 8.2 Component tests for `ItemsListPanel`
    - Create `web/src/ui/composer/ItemsListPanel.test.tsx` (Preact +
      happy-dom). Tag the label/order test with
      `// Feature: unified-composer-canvas, Property 13: <text>`.
    - **Property 13: items list label format and truncation** — labels start
      with `"Image: "` / `"Text: "` / are exactly `"Freehand stroke"`; any
      label rendered to the DOM has length ≤ 32 and ends in `"…"` exactly
      when the unrestricted label would exceed 32; the rendered DOM order is
      `scene.items` reversed. Validates: Requirements 17.1, 17.2, 17.3.
    - Empty-state placeholder render (Req 17.9).
    - Click-to-select calls `store.select(id)` (Req 17.4).
    - Drag-to-reorder mutates the scene only on drop, not during drag
      (Req 17.6, 17.7).
    - Per-row delete calls `store.removeItem(id)` (Req 17.8).
    - Reactivity check: mutating the store via a non-list path (e.g.
      `store.addItem` from a stub canvas) updates the rendered rows in the
      same render cycle (Req 17.10).
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10_
    - _Properties: Property 13_

- [x] 9. Build the Add-Item menu and adapt input panels
  - [x] 9.1 Implement `AddItemMenu`
    - Create `web/src/ui/composer/AddItemMenu.tsx` exporting
      `AddItemMenuProps` and `AddItemMenu`.
    - Three buttons: "Add image", "Add text", "Add freehand". Each toggles
      its own popover/modal hosting the existing input panel (`ImagePanel`,
      `TextPanel`, `FreehandPanel`) supplied via the `panels` prop (default
      = real components).
    - Image flow: on the panel's vectorisation result, call
      `store.addItem({ kind: 'image', content: polylines, source: { filename, sizeBytes } })`
      then close the modal (Req 2.1).
    - Text flow: live preview inside the modal; the modal's "Add to scene"
      button calls
      `store.addItem({ kind: 'text', content: polylines, source: { text, fontName, fontSizeMm, letterSpacingPct } })`
      and closes (Req 2.2).
    - Freehand flow: on the panel's commit callback, call
      `store.addItem({ kind: 'freehand', content: polylines, source: { capturedAtMs: Date.now() } })`
      and close (Req 2.3).
    - Modal cancel button or Escape closes without calling `addItem`.
    - Image vectorisation failure surfaces via the existing
      `controller.setImageError` channel and DOES NOT call `addItem`
      (Req 2.6).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 12.1, 12.2, 16.4_

  - [x] 9.2 Adapt `ImagePanel`, `TextPanel`, `FreehandPanel` for popover hosting
    - In `web/src/ui/ImagePanel.tsx`, `web/src/ui/TextPanel.tsx`,
      `web/src/ui/FreehandPanel.tsx`: keep the public prop signatures stable.
    - Remove the in-panel "Send to machine" affordances that called
      `controller.setPolylines` directly so commits flow only through the
      popover host (Req 2.5, 16.4).
    - The commit callbacks (`onPolylines`, `onPolylinesChange` +
      "Add to scene", `onSend`) are unchanged in shape; only the
      `AddItemMenu` host's reaction changes — it pushes into
      `store.addItem` instead of `controller.setPolylines`.
    - Update the existing tests
      (`ImagePanel.test.tsx` / `TextPanel.test.tsx` / `FreehandPanel.test.tsx`)
      so they no longer assert on the removed direct-Send affordances.
    - _Requirements: 2.5, 12.3, 16.4_

  - [x] 9.3 Component tests for `AddItemMenu`
    - Create `web/src/ui/composer/AddItemMenu.test.tsx` (Preact +
      happy-dom).
    - Each Add button opens its modal; commit calls `store.addItem` with the
      right `kind`, `content`, and `source` (Req 2.1, 2.2, 2.3).
    - Modal cancel does not call `store.addItem`.
    - Image vectorisation failure path calls `controller.setImageError` and
      does NOT call `store.addItem` (Req 2.6).
    - "Send to machine" controller surface is never touched as a side effect
      of adding an item (Req 2.5).
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 12.1, 12.2_

- [x] 10. Build the Animation Playback panel
  - [x] 10.1 Implement `AnimationPlayback`
    - Create `web/src/ui/composer/AnimationPlayback.tsx` exporting
      `AnimationPlaybackProps`, `PlaybackState`, and `AnimationPlayback`.
    - Reads `composed: ReadonlySignal<Polyline[]>` (the same flat polylines
      `controller.setPolylines` consumes) and
      `machineEtaMs: ReadonlySignal<number | null>` (mirrors the existing
      static-Preview ETA from `PathPlanner` step-count + feed rate).
    - Transport: Play / Pause / Stop. State machine
      `'stopped' | 'playing' | 'paused'`. Pause preserves the playback
      position (Req 18.7); Stop drops to `'stopped'` and removes the
      indicator (Req 18.8).
    - Speed slider labelled "Preview speed", range `[0.25, 8]`, default 1.
      Changes take effect within 100 ms of the change by reading from a
      ref inside the rAF loop (Req 18.5).
    - Indicator: rAF loop integrates
      `dt × speed × baseUnitsPerSecond` along the composed path; render an
      animated marker on a transparent overlay above the static preview
      (Req 18.3).
    - Disabled when `composed.value.length === 0`; pressing Play in that
      state is a no-op and renders no indicator (Req 18.4).
    - Auto-stop on scene change: `effect(() => composed.value)` resets to
      `'stopped'` and position 0 whenever `composed` changes while playing or
      paused (Req 18.9).
    - Dual-readout above the transport: **"Preview duration"** =
      `pathLength(composed.value) / (baseUnitsPerSecond × speed)`,
      **"Machine ETA: real draw time"** = `machineEtaMs.value` formatted with
      the existing `formatDuration` helper. The Machine ETA readout is a pure
      function of `machineEtaMs` only and MUST NOT change in response to the
      Preview-speed slider; the Preview-duration readout MUST update when
      either `composed` or speed changes (Req 18.13, 18.14).
    - MUST NOT import `controller`. MUST NOT call any controller method
      (Req 18.10).
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11, 18.12, 18.13, 18.14_

  - [x] 10.2 Component tests for `AnimationPlayback`
    - Create `web/src/ui/composer/AnimationPlayback.test.tsx` (Preact +
      happy-dom + a fake-timers / fake-rAF harness). Tag the determinism and
      dual-readout cases with
      `// Feature: unified-composer-canvas, Property N: <text>`.
    - Play / Pause / Stop transitions and Pause-resume position preservation
      (Req 18.6, 18.7, 18.8).
    - Empty-scene Play is a no-op and renders no indicator (Req 18.4).
    - Speed slider range `[0.25, 8]` and a change while playing affects the
      indicator within 100 ms simulated (Req 18.5).
    - Scene change during playback auto-stops and resets position to 0
      (Req 18.9).
    - The component never imports or calls any `controller` method
      (Req 18.10).
    - **Property 14: AnimationPlayback determinism** — for any composed
      polylines, any speed in `[0.25, 8]`, two runs starting at `t = 0` and
      observing identical `(P, s, totalElapsed)` produce identical sampled
      indicator positions; pause+resume produces a position trajectory equal
      to a continuous run time-shifted by the pause Δ. Validates:
      Requirements 18.2, 18.7, 18.11.
    - **Property 15: AnimationPlayback dual-readout independence** — the
      Machine ETA readout is byte-for-byte identical across all
      Preview-speed values; the Preview duration readout changes monotonically
      with speed. Validates: Requirements 18.13, 18.14.
    - _Requirements: 18.2, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11, 18.13, 18.14_
    - _Properties: Property 14, Property 15_

- [x] 11. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Wire the Composer into the Draw view
  - [x] 12.1 Restructure `App.tsx` around the SceneStore
    - In `web/src/ui/App.tsx`, accept `store: SceneStore` as a prop.
    - Replace the `tab-image` / `tab-text` / `tab-freehand` aside nav with
      `<ItemsListPanel store={store} addMenu={<AddItemMenu store={store} controller={controller} />} />`
      (Req 12.1, 12.2).
    - Replace the central `<Canvas …/>` with
      `<ComposerCanvas store={store} envelopeMm={...} />`. Keep the existing
      `<Preview …/>` slot as-is. Position
      `<AnimationPlayback composed={store.composed} machineEtaMs={...} />`
      bottom-right inside the existing `app__canvas-area`.
    - "Send to machine" handler:
      `if (store.composed.value.length === 0) { controller.clearPath(); return; }`
      `controller.setPolylines(store.composed.value, opts);`
      `controller.draw();`
      Exactly one `setPolylines` call per Send action (Req 9.4, 9.5).
    - Subscribe to `store.scene` via `effect`: when `items.length` transitions
      from positive to zero, call `controller.clearPath()` (Req 12.4).
    - Suppress intermediate composed polylines during gestures: do NOT call
      `controller.setPolylines` from any reactive effect — only from the
      Send handler (Req 11.3).
    - Top app shell (logo, Setup tab, Connect button), the bottom drawing
      controls (E-STOP, Pause/Resume/Cancel, SPEED slider), Calibration,
      Backlash, Diagnostics, and `controller`/`stores` API surfaces are
      unchanged (Req 12.3, 16.2, 16.3).
    - _Requirements: 9.4, 9.5, 11.3, 11.4, 12.1, 12.2, 12.3, 12.4, 13.1, 13.3, 16.1, 16.2, 16.3_

  - [x] 12.2 Instantiate the SceneStore in `main.ts`
    - In `web/src/main.ts`, build the store once with
      `createSceneStore({ persistence: createLocalStoragePersistence({ onTooLarge: (_, msg) => stores.notice.value = msg }) })`
      and pass it to `<App store={store} controller={controller} />`.
    - The non-blocking notice surface SHOULD reuse an existing toast/banner
      signal in `web/src/app/stores.ts` if present; otherwise add a minimal
      `notice` signal.
    - _Requirements: 14.1, 14.2, 14.6, 14.7, 16.1, 16.2_

  - [x] 12.3 Pipeline smoke + performance benchmarks
    - Add `web/src/composer/pipeline.smoke.test.ts`: build four fixture
      scenes (image-only, text-only, freehand-only, mixed-three-items with
      non-identity transforms); for each, assert
      `composeScene(scene)` shape (item polyline counts, post-transform
      bounding boxes) and pipe the composed polylines through
      `fitPolylinesToEnvelope` + `PathPlanner.plan`; pin
      `totalStepCount(plan) > 0` and assert it never uses vertex count as a
      proxy (Req 9.6, 13.1).
    - Add `web/src/composer/perf.bench.test.ts`: build a Scene of 10 items
      × 500 points (5 000 total points); simulate 200 sequential pointer-move
      events that drive a translate gesture (one `composeScene` call per
      event per Req 11.2); assert mean wall-clock per event ≤ 16 ms on the
      benchmark host (Req 11.1, 11.2). A second harness in the same file
      drives `AnimationPlayback` for 2 s of simulated playback over the same
      composed polylines and asserts mean frame interval ≤ 33 ms
      (≥ 30 fps, Req 18.12).
    - Skip the perf assertions on CI runners that don't expose
      `performance.now` reliably; gate behind an env flag.
    - _Requirements: 9.6, 11.1, 11.2, 11.3, 11.4, 13.1, 18.12_

- [x] 13. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- All machine-cost assertions reuse `PathPlanner.plan` and
  `totalStepCount` as the metric, never vertex count. The composer's only job
  is to feed `Polyline[]` into the same untransformed-floats coordinate space
  the existing image/text/freehand panels already produce.
- Render strategy: SVG-first (`<g transform=…>` per item) keeps affine math at
  the renderer layer and gives free DOM hit-testing. The Canvas2D fallback is
  held in reserve behind a URL flag and is only adopted if the Wave-4
  benchmark fails on a target browser. `composeScene` and the SceneStore are
  unchanged across the two render paths.
- The Python sidecar (`tools/imagepath_service`) and the firmware are
  explicitly out of scope. `controller.setPolylines`, `controller.clearPath`,
  `controller.draw`, `PathPlanner.plan`, `fitPolylinesToEnvelope`, and the
  wire codecs are reused as-is and their public signatures DO NOT change
  (Req 16.1, 16.2, 16.3).
- Tasks marked with `*` are optional test sub-tasks and can be skipped for a
  faster MVP; core implementation tasks are never optional.
- Property tests use `fast-check` with the project standard ≥ 100 iterations
  per property and tag each `it(...)` line
  `// Feature: unified-composer-canvas, Property N: <text>` to mirror the
  format established by the `image-tonal-hatching` tests.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "4.2", "5.1"] },
    { "id": 3, "tasks": ["5.2", "7.1", "8.1", "9.1", "9.2", "10.1"] },
    { "id": 4, "tasks": ["7.2", "8.2", "9.3", "10.2", "12.1", "12.2"] },
    { "id": 5, "tasks": ["12.3"] }
  ]
}
```