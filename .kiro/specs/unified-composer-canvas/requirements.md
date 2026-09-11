# Requirements Document

## Introduction

Today the SPA's three input sources — image vectorisation, text-to-strokes, and freehand
drawing — live in mutually exclusive tabs (`tab-image` / `tab-text` / `tab-freehand`
in `web/src/ui/App.tsx`). Each panel calls `controller.setPolylines(polylines, opts)`,
which **replaces** the planned path. The canvas can therefore only show one input
source at a time, so the user cannot, for example, place an imported logo, a caption,
and a hand-drawn arrow on the same Etch-a-Sketch drawing.

This feature replaces that tab-switching model with a single shared **Composer Scene**:
a layered document of independently transformable items (image, text, freehand) that
the user composes Figma/Google-Docs-style on one canvas, then sends to the machine as
one continuous drawing. Two ancillary affordances support this workflow: a left-rail
Items List for selecting, reordering, and deleting items, and an animation-playback
preview that traces the composed path before sending.

The path pipeline downstream of this feature is unchanged. Each item still produces
`Polyline[]` (`web/src/types.ts`); the new composition step transforms each item's
polylines by its (translation, scale, rotation), concatenates them, and hands the
combined `Polyline[]` to the existing `controller.setPolylines` / `PathPlanner.plan`
/ `fitPolylinesToEnvelope` chain. Speed, draw controls, calibration, BLE/wifi
connect, and firmware are out of scope.

### Hard constraints inherited from the existing system

- The downstream pipeline consumes `Polyline = Point[]` with `Point = {x:number, y:number}`
  and is the same for every input source. The composition output MUST be a flat
  `Polyline[]` in the same untransformed-floats coordinate space the existing image /
  text / freehand panels already produce. The planner step-quantises and clamps.
- `fitPolylinesToEnvelope` scales the entire planner input as one bounding box into
  the machine envelope, so the composer's units only need to be self-consistent —
  absolute units (mm, px) do not matter, but relative sizing of items MUST be
  preserved through composition.
- The Etch-a-Sketch stylus cannot lift, so visible connector lines between items are
  inherent (already rendered distinctly by `Preview.tsx`). The composer MUST NOT
  pretend it can hide them; ordering/placement of items is the only lever the user
  has over connector cost.

## Glossary

- **Composer Scene** (or **Scene**): the ordered list of items the user is composing.
  The single source of truth for what will be drawn next.
- **Item**: one element on the Scene. Exactly one of: `Image_Item`, `Text_Item`,
  `Freehand_Item`. Each item carries its own source content and a Transform.
- **Image_Item**: an item whose content is the `Polyline[]` produced by the existing
  image vectoriser (cv2 sidecar OR browser-native generators) for an imported image
  file. Both vectorisation paths produce `Polyline[]` and either is a valid source.
- **Text_Item**: an item whose content is the `Polyline[]` produced by the existing
  text-to-strokes generator for a user-entered string + font/size.
- **Freehand_Item**: an item whose content is the `Polyline[]` captured by the
  existing freehand stroke recorder.
- **Local frame**: an item's content polylines as produced by its generator, before
  the item's Transform is applied. Origin is the item's own (0,0).
- **Transform**: the per-item affine `{ x, y, sx, sy, rotationRad }` applied to the
  item's local-frame polylines at composition time. `(x,y)` is translation in scene
  units; `(sx, sy)` is scale (defaults `1,1`); `rotationRad` is counter-clockwise
  rotation in radians about the item's local origin.
- **Selection**: at most one item is selected at a time. Selection drives the
  bounding-box overlay, drag handles, keyboard targeting, and Delete behaviour.
- **Z-order**: the index of an item in the Scene's item array. Lower index = drawn
  first (further back); higher index = drawn last (further forward) in the preview.
  Z-order also controls the order items are concatenated in the composed
  `Polyline[]` handed to the planner.
- **Composed Polylines**: the flat `Polyline[]` produced by applying every item's
  Transform to its local-frame content and concatenating in Z-order. This is what
  is passed to `controller.setPolylines`.
- **Composer**: the pure function `composeScene(scene) → Polyline[]` that produces
  the Composed Polylines. No DOM, no signals, no I/O.
- **Send to machine**: the existing `send-to-machine` action in `App.tsx` that
  calls `controller.draw()` after `setPolylines` has been populated.
- **Items List**: a UI panel listing one row per item in the Scene, ordered with the
  topmost (highest Z-order) item at the top, matching the convention used by Figma
  and Photoshop. Supports row-level selection, drag-to-reorder, and per-row delete.
- **Animation playback**: a purely visual preview, run in the SPA, in which an
  animated indicator traces the Composed Polylines in order so the user can watch
  what the machine will draw before sending. Independent of the machine's real feed
  rate; transmits nothing to the controller.

## Requirements

### Requirement 1: Single shared canvas with multiple coexisting items

**User Story:** As a user composing a drawing, I want to place an image, a text block,
and a freehand sketch on the same canvas at the same time, so that I can hand the
machine one combined composition instead of choosing between sources.

#### Acceptance Criteria

1. THE Composer SHALL maintain one Composer Scene that holds zero or more items of
   any mix of types (Image_Item, Text_Item, Freehand_Item).
2. WHEN the user adds an item, THE Composer SHALL append the new item to the Scene
   without removing or modifying any existing item.
3. THE Canvas SHALL render every item in the Scene simultaneously, in Z-order, with
   each item's Transform applied.
4. WHILE the Scene contains at least one item, THE Canvas SHALL NOT enter a state in
   which adding a different-type item replaces the existing items.

### Requirement 2: Adding items from each input source

**User Story:** As a user, I still want the existing image / text / freehand input
flows, but each one should drop a new item onto the shared canvas instead of taking
over the canvas.

#### Acceptance Criteria

1. WHEN the user completes an image import (a file is selected and successfully
   vectorised), THE Composer SHALL add exactly one Image_Item to the Scene whose
   local-frame content is the `Polyline[]` produced by the existing image
   vectoriser.
2. WHEN the user commits a text entry, THE Composer SHALL add exactly one Text_Item
   to the Scene whose local-frame content is the `Polyline[]` produced by the
   existing text-to-strokes generator for the entered string and current font/size
   settings.
3. WHEN the user finishes a freehand drawing gesture session and commits it, THE
   Composer SHALL add exactly one Freehand_Item to the Scene whose local-frame
   content is the captured stroke `Polyline[]`.
4. WHEN a newly added item is added to the Scene, THE Composer SHALL place it at a
   default Transform that makes it visible inside the canvas viewport (non-zero
   scale, position within the visible bounds) and SHALL select it.
5. THE Composer SHALL NOT call `controller.setPolylines` with a single source's raw
   `Polyline[]` as a side effect of adding an item; the planner input SHALL be
   produced only by composition (Requirement 9).
6. IF image vectorisation fails, THEN THE Composer SHALL surface the error via the
   existing image-error channel and SHALL NOT add an item to the Scene.

### Requirement 3: Selection

**User Story:** As a user, I want to click on something I drew or imported and see
that it is selected, so I know which item my next action will affect.

#### Acceptance Criteria

1. WHEN the user clicks or taps within the bounding box of an item on the Canvas,
   THE Composer SHALL set that item as the selected item.
2. WHEN multiple items overlap at the click point, THE Composer SHALL select the
   topmost (highest Z-order) item under the cursor.
3. WHILE an item is selected, THE Canvas SHALL render a selection overlay around
   the item's bounding box that includes resize handles and a rotation handle.
4. WHEN the user clicks on empty canvas (no item under the cursor), THE Composer
   SHALL clear the current selection.
5. WHILE no item is selected, THE Canvas SHALL NOT render selection handles.
6. IF an item is removed from the Scene AND that item was the selected item, THEN
   THE Composer SHALL clear the selection.

### Requirement 4: Move items

**User Story:** As a user, I want to drag any item around the canvas to position it.

#### Acceptance Criteria

1. WHEN the user begins a drag (pointer-down) inside the bounding box of an item,
   THE Composer SHALL select that item and begin a move gesture on it.
2. WHILE a move gesture is active, THE Composer SHALL update the selected item's
   Transform `x` and `y` so the item follows the pointer at a 1:1 ratio in
   canvas-pixel space.
3. WHEN a move gesture ends (pointer-up or pointer-cancel), THE Composer SHALL
   commit the new `(x, y)` as the item's resting Transform.
4. WHILE a move gesture is active, THE Composer SHALL NOT modify any other item's
   Transform.

### Requirement 5: Resize and stretch items

**User Story:** As a user, I want to drag the corners or edges of a selected item to
make it bigger, smaller, or stretched.

#### Acceptance Criteria

1. WHEN the user drags a corner handle of the selection overlay, THE Composer SHALL
   update the selected item's Transform `sx` and `sy` so the item's rendered
   bounding box follows the handle in canvas-pixel space.
2. WHEN the user drags an edge handle (non-corner) of the selection overlay, THE
   Composer SHALL update only the scale factor on the axis the handle drives.
3. WHILE the user holds the Shift modifier during a corner-handle drag, THE
   Composer SHALL constrain `sx` and `sy` so the item's aspect ratio at the start
   of the gesture is preserved.
4. THE Composer SHALL enforce a minimum non-zero scale (`|sx| > 0` and `|sy| > 0`)
   on every item at all times so that no item can collapse to a degenerate single
   point or single line.
5. WHEN a resize gesture ends, THE Composer SHALL commit the resulting `(sx, sy)`
   as the item's resting Transform.

### Requirement 6: Rotate items

**User Story:** As a user, I want to rotate any item independently.

#### Acceptance Criteria

1. WHEN the user drags the rotation handle of the selection overlay, THE Composer
   SHALL update the selected item's Transform `rotationRad` so the item rotates
   counter-clockwise about its local origin to follow the pointer's angle.
2. THE Composer SHALL normalise `rotationRad` into the half-open interval
   `[0, 2π)` for storage so equivalent rotations have a single canonical value.
3. WHILE the user holds the Shift modifier during a rotation gesture, THE Composer
   SHALL snap `rotationRad` to the nearest 15° increment.
4. WHEN a rotation gesture ends, THE Composer SHALL commit the resulting
   `rotationRad` as the item's resting Transform.

### Requirement 7: Delete and Z-order controls

**User Story:** As a user, I want to remove items I no longer want, and to choose
which item is in front.

#### Acceptance Criteria

1. WHILE an item is selected, WHEN the user activates the delete control (a Delete
   button in the UI or the Backspace or Delete key while the canvas has focus),
   THE Composer SHALL remove that item from the Scene.
2. WHILE an item is selected, THE Composer SHALL expose a "Bring forward" action
   that swaps the item with the item one position higher in Z-order, if any.
3. WHILE an item is selected, THE Composer SHALL expose a "Send backward" action
   that swaps the item with the item one position lower in Z-order, if any.
4. WHEN the Scene has only one item or none, THE "Bring forward" and "Send
   backward" actions on the selected item SHALL be no-ops.

### Requirement 8: Keyboard accessibility

**User Story:** As a keyboard or assistive-tech user, I want to move, resize, and
remove items without dragging with a mouse.

#### Acceptance Criteria

1. WHILE the canvas has keyboard focus and an item is selected, WHEN the user
   presses an arrow key, THE Composer SHALL translate the selected item by 1
   scene unit in the corresponding direction.
2. WHILE the canvas has keyboard focus and an item is selected, WHEN the user
   presses an arrow key with the Shift modifier, THE Composer SHALL translate the
   selected item by 10 scene units in the corresponding direction.
3. WHILE the canvas has keyboard focus and an item is selected, WHEN the user
   presses `+` or `=`, THE Composer SHALL multiply both `sx` and `sy` by 1.1,
   subject to the minimum scale of Requirement 5.4.
4. WHILE the canvas has keyboard focus and an item is selected, WHEN the user
   presses `-`, THE Composer SHALL multiply both `sx` and `sy` by 1/1.1, subject
   to the minimum scale of Requirement 5.4.
5. WHILE the canvas has keyboard focus and an item is selected, WHEN the user
   presses `[`, THE Composer SHALL rotate the selected item by -15°.
6. WHILE the canvas has keyboard focus and an item is selected, WHEN the user
   presses `]`, THE Composer SHALL rotate the selected item by +15°.
7. WHILE an item is selected, THE selection overlay SHALL expose an accessible
   name describing the item type (for example "Image item", "Text item: Hello",
   "Freehand item") so screen readers can announce the selection.

### Requirement 9: Composition into the existing path pipeline

**User Story:** As a user, I want pressing "Send to machine" to draw exactly what I
composed — every item in the right place, at the right size, at the right angle —
as one combined drawing.

#### Acceptance Criteria

1. THE Composer SHALL expose a pure function `composeScene(scene)` that returns a
   flat `Polyline[]` by applying each item's Transform to its local-frame polylines
   and concatenating the results in Z-order (lowest index first).
2. WHEN composing an item, THE Composer SHALL transform every point in the item's
   local-frame polylines by the affine `T(p) = R(rotationRad) · S(sx, sy) · p +
   (x, y)` so position, scale, and rotation all take effect.
3. WHEN the Scene is empty, `composeScene` SHALL return an empty array.
4. WHEN the user activates "Send to machine", THE Composer SHALL call
   `controller.setPolylines(composeScene(scene), opts)` exactly once with the
   currently composed polylines and SHALL then trigger the existing
   `controller.draw()` path.
5. WHILE the Scene is non-empty, THE composed polylines SHALL be the only source
   of the planner's input from the Composer.
6. THE existing `fitPolylinesToEnvelope` and `PathPlanner.plan` stages SHALL
   continue to consume the composed polylines without modification.
7. WHEN every item's content polyline is non-empty (length ≥ 2 points), THE
   composed `Polyline[]` SHALL have a non-degenerate bounding box (width > 0 AND
   height > 0).

### Requirement 10: Determinism and purity of composition

**User Story:** As a maintainer, I want composition to be a pure, testable
transformation so the same Scene always produces the same drawing.

#### Acceptance Criteria

1. THE `composeScene` function SHALL be a pure function of its input Scene with
   no DOM access, no signal reads, no network calls, and no global state.
2. WHEN `composeScene` is invoked twice with structurally equal inputs, THE two
   outputs SHALL be structurally equal.
3. THE Composer Scene SHALL be JSON-serialisable so a Scene can be snapshotted
   and replayed in tests.
4. THE Composer SHALL have unit tests that exercise an empty Scene, a single-item
   Scene of each item type, a multi-item Scene with non-identity translation,
   non-unit scale, and non-zero rotation, and the Z-order ordering invariant of
   Requirement 9.1.

### Requirement 11: Performance during interaction

**User Story:** As a user dragging items, I want the canvas to feel smooth.

#### Acceptance Criteria

1. WHILE a move, resize, or rotate gesture is active on a Scene of up to 10 items
   whose total point count is up to 5,000 points, THE Canvas SHALL render each
   pointer-event update with an average frame interval of 16ms or less on a
   current desktop browser.
2. WHILE a gesture is active, THE Composer SHALL invoke `composeScene` at most
   once per pointer event.
3. WHILE a gesture is active, THE Composer SHALL NOT push intermediate composed
   polylines into `controller.setPolylines`.
4. WHEN a gesture ends, THE Composer MAY recompute the composed polylines once
   for any preview readouts that depend on the planner output.

### Requirement 12: Migration from the tab-per-input UX

**User Story:** As a returning user familiar with the old tabs, I want it to be
clear how the new model relates to what I knew before.

#### Acceptance Criteria

1. THE Draw view SHALL replace the mutually-exclusive `tab-image` / `tab-text` /
   `tab-freehand` tab nav with a control that exposes ADD actions for each input
   source ("Add image", "Add text", "Add freehand").
2. WHEN the user activates an ADD action, THE Composer SHALL open the input UI
   that source needs to gather its input (file picker, text entry, freehand
   stroke capture); on commit, the result SHALL be added as a new item per
   Requirement 2.
3. THE existing `controller.setPolylines` API signature SHALL NOT be changed.
4. WHEN the Scene becomes empty (e.g. all items deleted), THE Composer SHALL
   invoke `controller.clearPath` so the canvas and preview state remain
   consistent with the existing controller contract.

### Requirement 13: Connector cost and step-budget surfacing

**User Story:** As a user composing many items, I want feedback on how the
composition will affect drawing time so I can rearrange before sending.

#### Acceptance Criteria

1. WHEN the Scene changes (item added, removed, transformed, or reordered) AND no
   gesture is active, THE Composer SHALL recompute the composed polylines and
   update the preview's total-step-count readout via the existing planner output.
2. THE Canvas SHALL render inter-item connector segments using the existing
   distinct connector style so the user can see where the stylus will travel
   between items.
3. THE Composer SHALL NOT attempt to lift the pen between items; the existing
   single-continuous-stroke model is preserved.

### Requirement 14: Persistence across reloads

**User Story:** As a user who accidentally refreshes the browser mid-composition,
I want my Scene back so I do not have to redo it.

#### Acceptance Criteria

1. WHEN the Scene changes AND no gesture is active, THE Composer SHALL persist a
   JSON snapshot of the Scene to `localStorage` under a stable, namespaced key.
2. WHEN the SPA boots, IF a persisted Scene snapshot exists AND parses
   successfully, THEN THE Composer SHALL restore the Scene from that snapshot.
3. IF the persisted snapshot fails to parse OR references an unsupported schema
   version, THEN THE Composer SHALL discard the snapshot, start with an empty
   Scene, and SHALL NOT raise an error to the user.
4. WHERE a Scene contains an Image_Item, THE persisted snapshot SHALL include the
   vectorised `Polyline[]` and source-file metadata (filename and size) so the
   item's geometry can be restored without re-running the vectoriser.
5. THE Composer SHALL expose a "Clear scene" action that empties the Scene and
   the persisted snapshot in one step.
6. THE Composer SHALL enforce a soft maximum of 2,000,000 bytes (≈ 2 MB) on the
   serialised snapshot size before writing to `localStorage`. WHEN a save would
   exceed this limit, THE Composer SHALL skip persisting that snapshot, surface
   a non-blocking notice ("Scene too large to auto-save — use Export to keep it,
   or remove items"), AND SHALL keep the in-memory Scene fully functional.
7. IF the underlying persistence layer throws (quota exceeded, storage
   disabled, private-browsing mode, or any other I/O error), THEN THE Composer
   SHALL catch the error, treat the save as a no-op, surface the same
   non-blocking notice as 14.6, AND SHALL NOT crash, lose in-memory Scene
   state, or block the user from continuing to edit.

### Requirement 15: Undo and redo

**User Story:** As a user composing iteratively, I want to undo a mistake.

#### Acceptance Criteria

1. THE Composer SHALL maintain a bounded history of Scene states sufficient to
   support at least 20 undo steps.
2. WHEN the user activates the undo control (a UI button or `Ctrl+Z` / `Cmd+Z`
   while the canvas has focus), THE Composer SHALL revert the Scene to the
   previous history entry, if one exists.
3. WHEN the user activates the redo control (a UI button, `Ctrl+Shift+Z` /
   `Cmd+Shift+Z`, or `Ctrl+Y`), THE Composer SHALL restore the next history
   entry, if one exists.
4. THE Composer SHALL record one history entry per user-initiated change that
   comes to rest (a single completed drag SHALL produce one entry, not one
   entry per pointer-move event).
5. WHILE a drawing is in progress on the machine (`drawingState` is `drawing` or
   `paused`), THE Composer SHALL still permit Scene edits and undo/redo, AND
   those edits SHALL NOT affect the in-flight planned path.

### Requirement 16: Scope boundaries

**User Story:** As a maintainer, I want a clear fence around what this feature is
and is not changing.

#### Acceptance Criteria

1. THE feature SHALL be confined to the web SPA (`web/src/**`); no firmware
   change and no wire-protocol change.
2. THE existing speed slider, draw controls, calibration, backlash wizard,
   diagnostics panel, and connect/disconnect button SHALL retain their current
   behaviour, AND their public APIs SHALL NOT be changed by this feature.
3. THE existing planner (`web/src/path/planner.ts`), `fitPolylinesToEnvelope`,
   G-code emitter, and Drawing_Command codec SHALL be reused as-is.
4. WHERE existing image-vectorisation, text-to-strokes, and freehand-capture
   modules are reusable as content sources for items, THE Composer SHALL reuse
   them rather than reimplement them.

### Requirement 17: Items List panel

**User Story:** As a user composing a Scene with several items, I want a panel that
lists every item with a recognisable label, so that I can find, select, reorder,
and delete items without hunting for them on the canvas.

#### Acceptance Criteria

1. THE Items_List SHALL display one row for each item in the Scene, ordered with
   the topmost item (highest Z-order) at the top of the list and the bottommost
   item (lowest Z-order) at the bottom, matching the Figma and Photoshop
   convention.
2. THE Items_List SHALL render each row with a type indicator and a short label
   identifying the item, using the format "Image: <source filename>" for an
   Image_Item, "Text: <entered string>" for a Text_Item, and "Freehand stroke"
   for a Freehand_Item.
3. IF a row label would exceed 32 characters, THEN THE Items_List SHALL truncate
   the label to 32 characters and append a single-character ellipsis.
4. WHEN the user clicks or taps a row in the Items_List, THE Composer SHALL set
   that row's item as the selected item per Requirement 3.
5. WHILE an item is selected, THE Items_List SHALL render that item's row in a
   visually distinct selected state AND SHALL render every other row in an
   unselected state.
6. WHEN the user completes a drag-to-reorder gesture on a row in the Items_List
   (pointer-up over a different list position than the drag-start position), THE
   Composer SHALL move that row's item to the dropped Z-order position in the
   Scene, consistent with the Z-order semantics of Requirement 7.
7. WHILE a drag-to-reorder gesture is in progress, THE Items_List SHALL display
   a drop-position indicator showing where the row would land if released, AND
   THE Composer SHALL NOT mutate the Scene's Z-order until the gesture completes.
8. THE Items_List SHALL expose a per-row delete affordance that, when activated,
   removes that row's item from the Scene per Requirement 7.1.
9. WHILE the Scene contains zero items, THE Items_List SHALL render the
   placeholder text "No items yet — add an image, text, or a freehand drawing to
   get started" AND SHALL NOT render any item row.
10. WHEN the Scene changes (item added, removed, transformed, or reordered from
    any source, including direct canvas interaction), THE Items_List SHALL update
    its rows to reflect the current Scene within the same render cycle as the
    Canvas.

### Requirement 18: Animation playback preview

**User Story:** As a user about to send a composition to the machine, I want to
play an animation that traces the composed path on screen, so that I can see what
the machine will do before committing to the physical draw.

#### Acceptance Criteria

1. THE Draw view SHALL expose a play-animation control alongside the existing
   "Send to machine" control.
2. WHEN the user activates the play-animation control AND the Scene contains at
   least one item, THE Composer SHALL begin animation playback that visually
   traces the Composed Polylines (per Requirement 9) in order, from the first
   point of the first polyline to the last point of the last polyline, including
   inter-item connector segments.
3. WHILE animation playback is active or paused, THE Canvas SHALL render an
   animated indicator marking the virtual stylus position along the composed
   path, visually distinguishable from the static preview rendering.
4. IF the Scene is empty AND the user activates the play-animation control,
   THEN THE Composer SHALL keep playback inactive AND SHALL NOT render an
   animation indicator.
5. THE Composer SHALL expose a speed control for animation playback that selects
   a playback rate within a bounded range whose minimum is 0.25× and whose
   maximum is 8× a default rate, AND changes to the speed control during
   playback SHALL take effect within 100 ms of the change. The control SHALL be
   labelled "Preview speed" so it is unambiguous that this rate is a UI-only
   playback rate, not the machine's drawing speed.
6. WHILE animation playback is active, THE Composer SHALL expose a pause control
   AND a stop control.
7. WHEN the user activates the pause control during playback, THE Composer SHALL
   freeze the indicator at its current position along the composed path AND SHALL
   preserve the playback position so that a subsequent activation of the
   play-animation control resumes playback from that position.
8. WHEN the user activates the stop control, THE Composer SHALL terminate
   playback, remove the animation indicator, AND restore the static unanimated
   preview rendering.
9. WHEN the Scene changes (item added, removed, transformed, or reordered) AND
   animation playback is active or paused, THE Composer SHALL stop playback and
   reset to the start state (no indicator, static preview), regardless of whether
   the user activated the stop control.
10. THE animation playback SHALL NOT invoke `controller.setPolylines`,
    `controller.draw`, or any other controller method that transmits data to the
    machine; playback SHALL remain confined to the SPA's rendering layer.
11. WHEN animation playback is invoked twice with structurally equal Scenes and
    identical speed settings, THE sequence of indicator positions emitted over
    playback time SHALL be identical between the two invocations.
12. WHILE animation playback is active on a Scene of up to 10 items whose total
    point count is up to 5,000 points, THE Canvas SHALL render the animation
    indicator at an average frame rate of at least 30 frames per second on a
    current desktop browser, independently of Requirement 11.
13. THE Animation Playback panel SHALL display two distinct readouts side-by-side
    so the user cannot confuse the visual preview with the physical draw timing:
    a "Preview duration" derived from the current "Preview speed" multiplier and
    the path length, AND a "Machine ETA" derived from the existing
    `PathPlanner` step-count + feed-rate estimate (the same figure shown by the
    static Preview today, Requirement 13.1). The "Machine ETA" SHALL be
    labelled to make clear it is the real-machine estimate and is NOT affected
    by the "Preview speed" control.
14. WHEN the user changes the "Preview speed" control, THE "Machine ETA"
    readout SHALL NOT change in response, AND ONLY the "Preview duration"
    readout SHALL update to reflect the new playback rate.
