/**
 * `AddItemMenu` — three buttons (Add image / Add text / Add freehand) that
 * open the existing input panels (`ImagePanel`, `TextPanel`, `FreehandPanel`)
 * inside a modal/popover. On commit, each flow pushes a new item into the
 * SceneStore via `store.addItem(...)`; the modal closes. Cancel (X button,
 * footer button, Escape key, or backdrop click) closes without calling
 * `addItem`.
 *
 * The three input panels are reused as-is via the `panels` prop:
 *
 *   - `panels.image | text | freehand` — optional component overrides for
 *     test injection. Each override accepts `{ onCommit, onCancel }` and
 *     drives the modal host directly. When a kind is not overridden, the
 *     real `ImagePanel` / `TextPanel` / `FreehandPanel` is wrapped so its
 *     existing callback shape (`onPolylines`, `onPolylinesChange`,
 *     `onSend`) maps to the host's `onCommit` (Req 12.2, 16.4).
 *
 * Per-flow commit semantics (Req 2.1, 2.2, 2.3, 2.4, 2.5):
 *
 *   - **Image**: a "Add to scene" button in the modal footer commits the
 *     latest vectorised polylines and the captured file metadata
 *     (`filename`, `sizeBytes`) into `store.addItem({ kind: 'image', ... })`.
 *     The wrapper feature-detects the panel's file input via a single
 *     `change` listener on the wrapper container, so the metadata is
 *     captured without modifying `ImagePanel`'s public prop signature.
 *   - **Text**: live preview inside the modal via
 *     `TextPanel.onPolylinesChange`. The footer "Add to scene" button
 *     reads the current text / font / size / spacing state directly from
 *     the panel's existing `data-testid`-tagged DOM controls and commits a
 *     `text` item.
 *   - **Freehand**: the existing `FreehandPanel.onSend` callback commits a
 *     `freehand` item with `capturedAtMs: Date.now()`.
 *
 * Image vectorisation failure is forwarded to the existing
 * `controller.setImageError` channel and DOES NOT call `addItem` (Req 2.6).
 *
 * The component never calls `controller.setPolylines`, `controller.draw`, or
 * any other path-pipeline method as a side effect of adding an item; the
 * planner sees the new item only when the user activates "Send to machine"
 * (Req 2.5, 11.3).
 *
 * @see .kiro/specs/unified-composer-canvas/design.md §"Components and Interfaces" #7
 * @see Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 12.1, 12.2, 16.4
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentType, JSX } from 'preact';

import type { Polyline } from '../../types';
import type { SceneStore } from '../../composer/scene_store';
import {
    getImageFile,
    setImageFile,
} from '../../composer/image_source_cache';
import type {
    Freehand_Item,
    Image_Item,
    ItemId,
    Text_Item,
} from '../../composer/types';
import { ImagePanel } from '../ImagePanel';
import { TextPanel } from '../TextPanel';
import { FreehandPanel } from '../FreehandPanel';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * Narrow surface of the controller this menu depends on. The menu only
 * needs the image-error channel; demanding less than the full
 * {@link Controller} keeps tests cheap to set up.
 */
export interface AddItemMenuController {
    setImageError(message: string | null): void;
}

/**
 * Common props for an injected/default panel component. The modal host
 * supplies these; the panel calls `onCommit` exactly once when the user
 * accepts a result, or `onCancel` if they back out from inside the panel.
 *
 * The host also closes the modal on Escape / backdrop click / its own
 * Cancel button without consulting the panel.
 */
export interface AddItemPanelProps<S> {
    /** Commit the result. The host calls `addItem` and closes the modal. */
    onCommit: (polylines: Polyline[], source: S) => void;
    /** Cancel without committing. The host closes the modal. */
    onCancel: () => void;
}

/** Override-component shape exposed to tests via the `panels` prop. */
export interface AddItemPanelOverrides {
    image?: ComponentType<AddItemPanelProps<Image_Item['source']>>;
    text?: ComponentType<AddItemPanelProps<Text_Item['source']>>;
    freehand?: ComponentType<AddItemPanelProps<Freehand_Item['source']>>;
}

export interface AddItemMenuProps {
    /** Reactive Composer store. Required: every commit goes through here. */
    store: SceneStore;
    /**
     * Image-error channel (Req 2.6). Optional so tests that override the
     * `panels.image` component need not supply a controller.
     */
    controller?: AddItemMenuController;
    /** Optional component overrides for test injection. */
    panels?: AddItemPanelOverrides;
    /** Optional extra class on the menu root. */
    class?: string;
    /**
     * When non-null, drives the modal into "edit" mode for that item.
     * The menu looks the item up in {@link store} to discover its kind
     * and (for text) its current source, then opens the matching Add-*
     * modal seeded for a re-edit:
     *
     *   - **image**: the Add-image modal opens preloaded with the item's
     *     original `File` (from the session image source cache) and a
     *     commit routes through `store.replaceContent(id, polylines)`.
     *   - **text**: the Add-text modal opens pre-filled with the item's
     *     current text / font / size / spacing and a commit routes through
     *     `store.replaceContent(id, flipY(polylines), source)` so the
     *     words / font and the items-list label both update.
     *   - **freehand**: the Add-freehand modal opens for a fresh redraw
     *     (existing strokes are NOT seeded — see the wrapper note) and a
     *     commit routes through `store.replaceContent(id, polylines)`.
     *
     * Generalised from the image-only `editImageId`: the parent (App.tsx)
     * owns this state and resets it via {@link onEditDone} when the modal
     * closes. A single parent-owned id (rather than an id + kind tuple)
     * keeps the bridge minimal — the menu already holds `store`, so it
     * resolves the kind / source itself.
     */
    editingItemId?: ItemId | null;
    /**
     * Called by the menu when an in-progress edit session ends — commit,
     * cancel, Escape, or backdrop click. The parent should clear its
     * `editingItemId` state in response. Always paired with
     * {@link editingItemId}; ignored when `editingItemId` is null/undefined.
     */
    onEditDone?: () => void;
}

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

/**
 * Which panel is currently open in the modal, if any.
 *
 * Each variant carries an optional `editingId`: when present the modal is
 * in re-edit mode for an existing item — commit routes through
 * `store.replaceContent` instead of `store.addItem`, preserving the item's
 * id and transform. The image variant additionally preloads the item's
 * original `File` from the session cache; the text variant carries the
 * item's current `source` so the panel can pre-fill its fields.
 */
type OpenKind =
    | null
    | { kind: 'image'; editingId?: ItemId }
    | { kind: 'text'; editingId?: ItemId; initialSource?: Text_Item['source'] }
    | { kind: 'freehand'; editingId?: ItemId };

// -----------------------------------------------------------------------------
// Coordinate helpers
// -----------------------------------------------------------------------------

/**
 * Negate Y on every point of every polyline. Used by the text-commit path
 * to convert {@link Text_Renderer} output (+Y up, mm convention) into the
 * +Y down screen convention that the rest of the Scene (image / freehand
 * items, ComposerCanvas SVG) lives in. Pure: returns fresh arrays and
 * does not mutate the inputs.
 *
 * Exported for the dedicated unit test next to this file.
 */
export function flipY(polylines: Polyline[]): Polyline[] {
    return polylines.map((poly) => poly.map((p) => ({ x: p.x, y: -p.y })));
}

// -----------------------------------------------------------------------------
// Modal frame
// -----------------------------------------------------------------------------

interface ModalProps {
    title: string;
    /**
     * Called when the user closes the modal without committing: Escape
     * key, the modal's X button, the footer Cancel button, or a click on
     * the backdrop.
     */
    onClose: () => void;
    children: JSX.Element | JSX.Element[];
}

/**
 * Lightweight modal frame. No portals — the modal renders inside the
 * AddItemMenu's own DOM subtree, which is sufficient for the SPA's flat
 * layout (the modal is positioned via fixed positioning in CSS).
 *
 * Closes on:
 *   - Escape keydown anywhere on the document.
 *   - Click on the backdrop (outside the content box).
 *   - Click on the explicit close button in the header.
 */
function Modal(props: ModalProps): JSX.Element {
    const { title, onClose, children } = props;

    // Escape closes — Req 2.6 / task description ("Modal cancel button or
    // Escape closes without calling addItem"). Capture-phase so a focused
    // input inside the modal cannot eat the key.
    useEffect(() => {
        const handler = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        // `window` in the SPA, but use `document` for jsdom compatibility.
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    return (
        <div
            class="add-item-modal"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            data-testid="add-item-modal"
        >
            <div
                class="add-item-modal__backdrop"
                data-testid="add-item-modal-backdrop"
                onClick={onClose}
            />
            <div
                class="add-item-modal__content"
                data-testid="add-item-modal-content"
                // Stop clicks inside the content from bubbling to the
                // backdrop (which would close the modal).
                onClick={(e) => e.stopPropagation()}
            >
                <header class="add-item-modal__header">
                    <h3 class="add-item-modal__title">{title}</h3>
                    <button
                        type="button"
                        class="add-item-modal__close"
                        data-testid="add-item-modal-close"
                        aria-label="Close"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </header>
                {children}
            </div>
        </div>
    );
}

// -----------------------------------------------------------------------------
// Default image panel wrapper
// -----------------------------------------------------------------------------

interface DefaultImagePanelProps extends AddItemPanelProps<Image_Item['source']> {
    /** Image-error channel; absent → no-op error reporting. */
    controller?: AddItemMenuController;
    /**
     * When supplied, the underlying ImagePanel mounts as if this file
     * was just picked: the file flows through the existing pipeline
     * once on first render so the user can immediately tweak controls.
     * Used by the "edit settings" path.
     */
    initialFile?: File;
    /**
     * Called immediately before {@link AddItemPanelProps.onCommit} (and
     * with the same polylines / source) when the wrapper has captured
     * the user-picked `File` for this session. The host uses this to
     * write into the session image source cache so the same item can be
     * re-edited later. Optional: when absent (the override path used by
     * tests), the wrapper falls back to the standard `onCommit`.
     */
    onCommitWithFile?: (
        polylines: Polyline[],
        source: Image_Item['source'],
        file: File | null,
    ) => void;
}

/**
 * Default wrapper around the existing {@link ImagePanel}.
 *
 * Tracks the latest vectorised polylines emitted by `onPolylines` plus the
 * filename and byte-size of the most recent file the user picked, then
 * commits both via the host's `onCommit` when the footer "Add to scene"
 * button is activated. Errors flow through `controller.setImageError`
 * unchanged from the existing standalone-tab wiring (Req 2.6).
 *
 * File metadata is captured by attaching one `change` listener to the
 * wrapping container — the listener fires on the panel's existing
 * `<input type="file">` without requiring any change to `ImagePanel`'s
 * public props (Req 16.4).
 */
function DefaultImagePanel(props: DefaultImagePanelProps): JSX.Element {
    const { onCommit, onCancel, controller, initialFile, onCommitWithFile } = props;

    const [polylines, setPolylines] = useState<Polyline[] | null>(null);
    /**
     * Holds the most recent file's metadata. The ref pattern keeps capture
     * synchronous with the `change` event, so when the panel's
     * `onPolylines` fires shortly afterward the metadata is already
     * available without forcing a re-render.
     *
     * When the panel was opened in edit mode with an `initialFile`, that
     * file's metadata seeds the ref so a commit-without-re-pick still
     * lands the right `source` payload.
     */
    const lastFileRef = useRef<Image_Item['source']>(
        initialFile !== undefined
            ? { filename: initialFile.name, sizeBytes: initialFile.size }
            : { filename: '', sizeBytes: 0 },
    );
    /**
     * Latest actual `File` object the user picked (or the initialFile in
     * edit mode). Stored alongside the metadata so the host can write it
     * into the session image source cache on commit, enabling future
     * re-edit sessions to resume with the same bytes. We never persist
     * this — it's a session-only side store, not a Scene field.
     */
    const lastFileObjectRef = useRef<File | null>(initialFile ?? null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = containerRef.current;
        if (el === null) return;
        const handler = (e: Event): void => {
            const t = e.target;
            if (
                t instanceof HTMLInputElement &&
                t.type === 'file' &&
                t.files !== null &&
                t.files.length > 0
            ) {
                const f = t.files[0];
                lastFileRef.current = {
                    filename: f.name,
                    sizeBytes: f.size,
                };
                lastFileObjectRef.current = f;
            }
        };
        el.addEventListener('change', handler);
        return () => el.removeEventListener('change', handler);
    }, []);

    const canCommit = polylines !== null && polylines.length > 0;

    const commit = useCallback((): void => {
        if (polylines === null || polylines.length === 0) return;
        if (onCommitWithFile !== undefined) {
            onCommitWithFile(
                polylines,
                lastFileRef.current,
                lastFileObjectRef.current,
            );
            return;
        }
        onCommit(polylines, lastFileRef.current);
    }, [polylines, onCommit, onCommitWithFile]);

    const reportError = useCallback(
        (message: string | null): void => {
            controller?.setImageError(message);
        },
        [controller],
    );

    return (
        <div
            ref={containerRef}
            class="add-item-modal__body"
            data-testid="add-item-image-body"
        >
            <ImagePanel
                onPolylines={setPolylines}
                onError={reportError}
                {...(initialFile !== undefined ? { initialFile } : {})}
            />
            <footer class="add-item-modal__footer">
                <button
                    type="button"
                    class="add-item-modal__cancel"
                    data-testid="add-item-cancel"
                    onClick={onCancel}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    class="add-item-modal__commit"
                    data-testid="add-item-commit"
                    disabled={!canCommit}
                    onClick={commit}
                >
                    {initialFile !== undefined ? 'Save changes' : 'Add to scene'}
                </button>
            </footer>
        </div>
    );
}

// -----------------------------------------------------------------------------
// Default text panel wrapper
// -----------------------------------------------------------------------------

/**
 * Default wrapper around the existing {@link TextPanel}.
 *
 * Tracks the latest preview polylines via `onPolylinesChange` and reads
 * the current text / font / size / spacing values from the panel's
 * existing `data-testid`-tagged DOM controls at commit time. This avoids
 * lifting the panel's internal state into a new prop API; per task 9.2 the
 * panel's public props are unchanged in this task.
 *
 * In re-edit mode the host supplies `initialSource` (the item's current
 * text / font / size / spacing). The wrapper threads those into TextPanel's
 * existing `initial*` props so the modal opens pre-filled, and the footer
 * commit button reads "Save changes" instead of "Add to scene".
 */
function DefaultTextPanel(
    props: AddItemPanelProps<Text_Item['source']> & {
        initialSource?: Text_Item['source'];
    },
): JSX.Element {
    const { onCommit, onCancel, initialSource } = props;

    const [polylines, setPolylines] = useState<Polyline[]>([]);
    const containerRef = useRef<HTMLDivElement>(null);

    const canCommit = polylines.length > 0;

    const commit = useCallback((): void => {
        if (polylines.length === 0) return;
        const el = containerRef.current;
        if (el === null) return;
        const textEl = el.querySelector<HTMLInputElement>(
            '[data-testid="text-input"]',
        );
        const fontEl = el.querySelector<HTMLSelectElement>(
            '[data-testid="font-select"]',
        );
        const sizeEl = el.querySelector<HTMLInputElement>(
            '[data-testid="font-size"]',
        );
        const spacingEl = el.querySelector<HTMLInputElement>(
            '[data-testid="letter-spacing"]',
        );
        const text = textEl?.value ?? '';
        const fontName = fontEl?.value ?? '';
        const fontSizeMm = Number(sizeEl?.value ?? '');
        const letterSpacingPct = Number(spacingEl?.value ?? '');
        const source: Text_Item['source'] = {
            text,
            fontName,
            fontSizeMm: Number.isFinite(fontSizeMm) ? fontSizeMm : 0,
            letterSpacingPct: Number.isFinite(letterSpacingPct)
                ? letterSpacingPct
                : 0,
        };
        onCommit(polylines, source);
    }, [polylines, onCommit]);

    return (
        <div
            ref={containerRef}
            class="add-item-modal__body"
            data-testid="add-item-text-body"
        >
            <TextPanel
                onPolylinesChange={setPolylines}
                {...(initialSource !== undefined
                    ? {
                        initialText: initialSource.text,
                        initialFontName: initialSource.fontName,
                        initialFontSizeMm: initialSource.fontSizeMm,
                        initialLetterSpacingPct:
                            initialSource.letterSpacingPct,
                    }
                    : {})}
            />
            <footer class="add-item-modal__footer">
                <button
                    type="button"
                    class="add-item-modal__cancel"
                    data-testid="add-item-cancel"
                    onClick={onCancel}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    class="add-item-modal__commit"
                    data-testid="add-item-commit"
                    disabled={!canCommit}
                    onClick={commit}
                >
                    {initialSource !== undefined ? 'Save changes' : 'Add to scene'}
                </button>
            </footer>
        </div>
    );
}

// -----------------------------------------------------------------------------
// Default freehand panel wrapper
// -----------------------------------------------------------------------------

/**
 * Default wrapper around the existing {@link FreehandPanel}.
 *
 * The freehand panel already exposes its own "Add to scene" button which
 * fires `onSend(polylines)`. The wrapper maps that callback into the
 * modal-host `onCommit` shape, attaching `capturedAtMs: Date.now()` as the
 * source metadata. A footer Cancel button is provided so the keyboard /
 * pointer affordances match the other two flows.
 *
 * Re-edit limitation: in edit mode the surface opens BLANK rather than
 * seeded with the item's existing strokes — {@link FreehandPanel} owns its
 * capture buffer internally and has no public "load these strokes" prop,
 * and re-deriving an editable capture from already-smoothed polylines is
 * out of scope. A commit therefore REPLACES the item's content with a
 * fresh drawing while preserving its id / transform (via
 * `store.replaceContent`). This is the documented, smallest-correct
 * behaviour for freehand re-edit.
 */
function DefaultFreehandPanel(
    props: AddItemPanelProps<Freehand_Item['source']>,
): JSX.Element {
    const { onCommit, onCancel } = props;

    const handleSend = useCallback(
        (polylines: Polyline[]): void => {
            if (polylines.length === 0) return;
            onCommit(polylines, { capturedAtMs: Date.now() });
        },
        [onCommit],
    );

    return (
        <div class="add-item-modal__body" data-testid="add-item-freehand-body">
            <FreehandPanel onSend={handleSend} />
            <footer class="add-item-modal__footer">
                <button
                    type="button"
                    class="add-item-modal__cancel"
                    data-testid="add-item-cancel"
                    onClick={onCancel}
                >
                    Cancel
                </button>
            </footer>
        </div>
    );
}

// -----------------------------------------------------------------------------
// AddItemMenu
// -----------------------------------------------------------------------------

/**
 * Render the three add-item buttons. Each button toggles its own modal
 * with the corresponding input panel. Commit and cancel are wired through
 * the modal so the SceneStore is the only consumer of the result, and
 * `controller.setPolylines` is never touched as a side effect of adding
 * an item (Req 2.5).
 */
export function AddItemMenu(props: AddItemMenuProps): JSX.Element {
    const { store, controller, panels, class: className, editingItemId, onEditDone } = props;
    const [open, setOpen] = useState<OpenKind>(null);

    /**
     * External "open in edit mode" trigger. The parent (App.tsx) passes a
     * non-null `editingItemId` when the user clicks a per-row edit button
     * in ItemsListPanel; on transition to non-null we look the item up in
     * the store to discover its kind (and, for text, its current source)
     * and open the matching modal in edit mode. On transition back to null
     * (after a commit / cancel / close) we make sure no stale modal is
     * left behind.
     */
    useEffect(() => {
        if (editingItemId !== null && editingItemId !== undefined) {
            const item = store.scene.value.items.find(
                (it) => it.id === editingItemId,
            );
            if (item === undefined) return;
            if (item.kind === 'image') {
                setOpen({ kind: 'image', editingId: editingItemId });
            } else if (item.kind === 'text') {
                setOpen({
                    kind: 'text',
                    editingId: editingItemId,
                    initialSource: item.source,
                });
            } else {
                setOpen({ kind: 'freehand', editingId: editingItemId });
            }
        } else if (
            open !== null &&
            open.editingId !== undefined
        ) {
            // Parent cleared edit mode while an edit modal was open: close
            // it so the UI does not lock the user inside a stale session.
            setOpen(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editingItemId]);

    /**
     * Centralised close: resets the modal state and notifies the parent
     * so it can clear its `editingItemId` even if the close path was a
     * cancel / Escape / backdrop click rather than a commit.
     */
    const close = useCallback(() => {
        setOpen(null);
        onEditDone?.();
    }, [onEditDone]);

    const handleImageCommit = useCallback(
        (polylines: Polyline[], source: Image_Item['source']): void => {
            // Override path (test fixtures inject a custom panel that calls
            // `onCommit` directly without a File): keep the simpler addItem
            // flow, no cache write — overrides have always been opt-in for
            // tests, and the production cache is irrelevant when the panel
            // internals are stubbed.
            store.addItem({ kind: 'image', content: polylines, source });
            setOpen(null);
            onEditDone?.();
        },
        [store, onEditDone],
    );

    /**
     * The default-panel commit path: receives the polylines, the source
     * metadata, AND the actual `File` the user picked (when one was
     * captured). Branches on whether we're editing or adding:
     *
     *   - In edit mode: `replaceContent` swaps the polylines on the
     *     existing item, preserving id / transform / source. The file
     *     reference (which may have changed if the user re-picked a
     *     different file) updates the cache so subsequent edit sessions
     *     pick up the latest bytes. The persisted source metadata is
     *     unchanged because the items-list label should match the
     *     original filename — re-picking is a tweak, not a re-import.
     *   - In add mode: `addItem` creates a new item, then we write the
     *     File into the cache keyed by the freshly minted id.
     */
    const handleImageCommitWithFile = useCallback(
        (
            polylines: Polyline[],
            source: Image_Item['source'],
            file: File | null,
        ): void => {
            const editingId =
                open !== null && open.kind === 'image'
                    ? open.editingId
                    : undefined;
            if (editingId !== undefined) {
                store.replaceContent(editingId, polylines);
                if (file !== null) {
                    setImageFile(editingId, file);
                }
            } else {
                const newId = store.addItem({
                    kind: 'image',
                    content: polylines,
                    source,
                });
                if (file !== null) {
                    setImageFile(newId, file);
                }
            }
            setOpen(null);
            onEditDone?.();
        },
        [store, open, onEditDone],
    );

    const handleTextCommit = useCallback(
        (polylines: Polyline[], source: Text_Item['source']): void => {
            // Text_Renderer emits polylines in +Y up (mm convention), but image/freehand
            // items and the ComposerCanvas SVG live in +Y down (screen convention). Negate
            // Y here so every Scene item shares one coordinate system; `controller.setPolylines`
            // at Send time applies the single +Y down → machine +Y up flip uniformly.
            const editingId =
                open !== null && open.kind === 'text'
                    ? open.editingId
                    : undefined;
            if (editingId !== undefined) {
                // Re-edit: swap content AND source so the words / font / size
                // change is reflected in the items-list label, preserving id
                // + transform in a single history entry.
                store.replaceContent(editingId, flipY(polylines), source);
            } else {
                store.addItem({ kind: 'text', content: flipY(polylines), source });
            }
            setOpen(null);
            onEditDone?.();
        },
        [store, open, onEditDone],
    );

    const handleFreehandCommit = useCallback(
        (polylines: Polyline[], source: Freehand_Item['source']): void => {
            const editingId =
                open !== null && open.kind === 'freehand'
                    ? open.editingId
                    : undefined;
            if (editingId !== undefined) {
                // Re-edit: replace the content with the fresh redraw,
                // preserving id + transform. The freehand source is just a
                // capture timestamp and never shows in the label, so we
                // leave it untouched.
                store.replaceContent(editingId, polylines);
            } else {
                store.addItem({ kind: 'freehand', content: polylines, source });
            }
            setOpen(null);
            onEditDone?.();
        },
        [store, open, onEditDone],
    );

    // Resolve the panel components: an explicit override wins, otherwise
    // fall back to the default real-component wrapper. Resolution happens
    // per-render so a parent may swap overrides at any time.
    const ImageOverride = panels?.image;
    const TextOverride = panels?.text;
    const FreehandOverride = panels?.freehand;

    /**
     * Edit-mode bootstrap data, recomputed every render. When `open` is
     * the image kind WITH an `editingId`, look up the originally imported
     * `File` from the session cache; an absent entry (typical after a
     * page reload, since the cache is session-scoped) leaves the panel
     * in normal "pick a file" mode so the user can re-pick the same file
     * — a manageable fallback rather than a hard failure.
     */
    const editingImageFile =
        open !== null && open.kind === 'image' && open.editingId !== undefined
            ? getImageFile(open.editingId)
            : undefined;

    const isImageEditMode =
        open !== null && open.kind === 'image' && open.editingId !== undefined;

    const isTextEditMode =
        open !== null && open.kind === 'text' && open.editingId !== undefined;

    const textInitialSource =
        open !== null && open.kind === 'text' ? open.initialSource : undefined;

    const isFreehandEditMode =
        open !== null && open.kind === 'freehand' && open.editingId !== undefined;

    return (
        <div
            class={`add-item-menu${className !== undefined ? ` ${className}` : ''}`}
            data-testid="add-item-menu"
        >
            <button
                type="button"
                class="add-item-menu__button add-item-menu__button--image"
                data-testid="add-item-image"
                onClick={() => setOpen({ kind: 'image' })}
            >
                Add image
            </button>
            <button
                type="button"
                class="add-item-menu__button add-item-menu__button--text"
                data-testid="add-item-text"
                onClick={() => setOpen({ kind: 'text' })}
            >
                Add text
            </button>
            <button
                type="button"
                class="add-item-menu__button add-item-menu__button--freehand"
                data-testid="add-item-freehand"
                onClick={() => setOpen({ kind: 'freehand' })}
            >
                Add freehand
            </button>

            {open !== null && open.kind === 'image' && (
                <Modal
                    title={isImageEditMode ? 'Edit image settings' : 'Add image'}
                    onClose={close}
                >
                    {ImageOverride !== undefined ? (
                        <ImageOverride
                            onCommit={handleImageCommit}
                            onCancel={close}
                        />
                    ) : (
                        <DefaultImagePanel
                            onCommit={handleImageCommit}
                            onCommitWithFile={handleImageCommitWithFile}
                            onCancel={close}
                            {...(controller !== undefined
                                ? { controller }
                                : {})}
                            {...(editingImageFile !== undefined
                                ? { initialFile: editingImageFile }
                                : {})}
                        />
                    )}
                </Modal>
            )}

            {open !== null && open.kind === 'text' && (
                <Modal
                    title={isTextEditMode ? 'Edit text' : 'Add text'}
                    onClose={close}
                >
                    {TextOverride !== undefined ? (
                        <TextOverride
                            onCommit={handleTextCommit}
                            onCancel={close}
                        />
                    ) : (
                        <DefaultTextPanel
                            onCommit={handleTextCommit}
                            onCancel={close}
                            {...(textInitialSource !== undefined
                                ? { initialSource: textInitialSource }
                                : {})}
                        />
                    )}
                </Modal>
            )}

            {open !== null && open.kind === 'freehand' && (
                <Modal
                    title={isFreehandEditMode ? 'Edit freehand' : 'Add freehand'}
                    onClose={close}
                >
                    {FreehandOverride !== undefined ? (
                        <FreehandOverride
                            onCommit={handleFreehandCommit}
                            onCancel={close}
                        />
                    ) : (
                        <DefaultFreehandPanel
                            onCommit={handleFreehandCommit}
                            onCancel={close}
                        />
                    )}
                </Modal>
            )}
        </div>
    );
}

export default AddItemMenu;
