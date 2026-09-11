/**
 * `nms` — a pure, self-contained reference thinning function that stands in
 * as the **testable** model of Requirement 4.3 ("reduce detected edges to
 * single-pixel-width contours using non-maximum suppression").
 *
 * ## Why this module exists
 *
 * In production, Req 4.3 is satisfied inside the Canny pipeline of
 * {@link ../image/image_processor.ts | Image_Processor}: the
 * non-maximum-suppression (NMS) step that yields single-pixel-wide edges is
 * performed by `opencv.js` (`cv.Canny`). That WASM module **cannot run under
 * jsdom / Vitest**, so the single-pixel-width guarantee of the production
 * raster path is exercised only via manual / e2e testing — it is not
 * unit-testable.
 *
 * To still get an *executable* property test for the single-pixel-width
 * guarantee of Req 4.3, this module implements a pure, deterministic
 * morphological **thinning** that reduces a binary image of "thick" edge
 * regions to single-pixel-wide skeletons. The skeleton this produces obeys
 * exactly the property Req 4.3 cares about — the output contains no 2×2
 * fully-set block (the standard, decidable formalisation of "single pixel
 * wide" for a skeleton) — so the property test below validates that
 * guarantee on real, runnable code.
 *
 * **Relationship to the production path:** this reference thinning and
 * `cv.Canny`'s internal NMS are two implementations of the same Req-4.3
 * contract ("edges become single-pixel-wide"). They are *not* wired
 * together: `image_processor.ts` is untouched and still uses `opencv.js`.
 * This module is the unit-testable reference; the WASM Canny path is the
 * production raster path documented as exercised by manual / e2e tests.
 *
 * ## Algorithm: Zhang–Suen thinning (with a component-preservation guard)
 *
 * The core is the canonical **Zhang–Suen** thinning algorithm (T. Y. Zhang
 * and C. Y. Suen, 1984). It is well-specified and deterministic: each pass
 * runs two sub-iterations, and passes repeat until a full pass deletes
 * nothing. A foreground pixel `P1` with its 8 neighbours labelled clockwise
 * from North
 *
 * ```
 *   P9 P2 P3
 *   P8 P1 P4
 *   P7 P6 P5
 * ```
 *
 * is flagged for deletion in a sub-iteration when all of:
 *   1. `2 ≤ B(P1) ≤ 6`            — `B` = number of set neighbours;
 *   2. `A(P1) = 1`               — `A` = number of `0→1` transitions in the
 *                                  ordered sequence `P2,P3,…,P9,P2`;
 *   3. (sub-iter 1) `P2·P4·P6 = 0` and `P4·P6·P8 = 0`;
 *      (sub-iter 2) `P2·P4·P8 = 0` and `P2·P6·P8 = 0`.
 *
 * All flagged pixels in a sub-iteration are removed simultaneously. Pixels
 * outside the image are treated as background (`0`).
 *
 * **Component-preservation guard.** Vanilla Zhang–Suen has one documented
 * defect relevant to us: it erases an isolated 2×2 square *completely*
 * (all four pixels are flagged in the same sub-iteration and removed at
 * once). A correct skeletonisation should never erase a whole connected
 * component. We therefore add a small, well-documented safeguard: before
 * committing a sub-iteration's deletions, any 8-connected component whose
 * pixels are *all* flagged keeps a single representative pixel (its
 * lowest raster index). This preserves topology (every input component
 * maps to a non-empty skeleton) without ever leaving a 2×2 block — the
 * retained pixel is, by construction, isolated. It keeps the
 * single-pixel-width guarantee intact while making the result a faithful,
 * homotopy-preserving skeleton.
 *
 * **Final 2×2-block cleanup.** Zhang–Suen (even with the guard above) can
 * leave residual 2×2 squares and 2-pixel-wide diagonal staircases as stable
 * terminal patterns: the four pixels of such a block are never all flagged in
 * the same sub-iteration, so neither the directional tests nor the guard
 * remove them. After thinning converges we therefore run a deterministic
 * cleanup ({@link removeFullBlocks}) that sweeps the bitmap and, while any
 * 2×2 fully-set block remains, clears exactly one pixel of it (the highest
 * raster index — the bottom-right). This only ever clears pixels (subset),
 * does nothing on an already-thin image (idempotence), and cannot empty a
 * component (a 2×2 block has four pixels; clearing one leaves three). The
 * thinning and cleanup are alternated to a joint fixed point, which is what
 * makes `thinToSinglePixel` idempotent.
 *
 * The module is pure: no DOM, no WASM, no globals. Bytes in, bytes out.
 *
 * @see ../image/image_processor.ts (production opencv.js Canny path)
 * @see Requirements 4.3
 * @see Design §3.1.1, Property 21
 */

/**
 * Reduce a binary bitmap of "thick" edge regions to single-pixel-wide
 * skeletons using Zhang–Suen thinning (with the component-preservation
 * guard described in the module docstring).
 *
 * Input is a row-major bitmap where any **non-zero** byte marks a set
 * (foreground / edge) pixel. Output is a fresh row-major `Uint8Array` of the
 * same length using the canonical encoding `1` = set, `0` = clear.
 *
 * Guarantees on the output (validated by `nms.props.test.ts`, Req 4.3):
 *   - **Single-pixel-width:** contains no 2×2 fully-set block, i.e.
 *     {@link isSinglePixelWide} returns `true`.
 *   - **Subset:** every set pixel was set in the input (thinning only ever
 *     removes pixels, never adds them).
 *   - **Idempotent:** re-thinning the output reproduces it exactly (the
 *     skeleton is a fixed point).
 *   - **Component-preserving:** a non-empty input yields a non-empty output
 *     (no connected component is erased entirely).
 *
 * @param bitmap Row-major bytes; non-zero = set. Length must be ≥ `width*height`.
 * @param width  Image width in pixels (integer ≥ 0).
 * @param height Image height in pixels (integer ≥ 0).
 * @returns      A new `Uint8Array` (length `width*height`) of `0`/`1` bytes.
 * @throws {RangeError} if `width`/`height` are not non-negative integers, or
 *                      if `bitmap` is shorter than `width*height`.
 */
export function thinToSinglePixel(
    bitmap: Uint8Array,
    width: number,
    height: number,
): Uint8Array {
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
        throw new RangeError(
            'thinToSinglePixel: width and height must be integers',
        );
    }
    if (width < 0 || height < 0) {
        throw new RangeError(
            'thinToSinglePixel: width and height must be non-negative',
        );
    }

    const n = width * height;
    if (n === 0) return new Uint8Array(0);
    if (bitmap.length < n) {
        throw new RangeError(
            `thinToSinglePixel: bitmap length ${bitmap.length} < width*height ${n}`,
        );
    }

    // Canonicalise to 0/1 in a private working buffer.
    const img = new Uint8Array(n);
    for (let i = 0; i < n; i++) img[i] = bitmap[i] !== 0 ? 1 : 0;

    // Neighbour read with out-of-bounds treated as background.
    const get = (x: number, y: number): number => {
        if (x < 0 || x >= width || y < 0 || y >= height) return 0;
        return img[y * width + x];
    };

    /**
     * One Zhang–Suen sub-iteration. `step` selects the directional test
     * pair (1 or 2). Returns the number of pixels actually deleted.
     */
    const subIteration = (step: 1 | 2): number => {
        const flagged: number[] = [];

        for (let idx = 0; idx < n; idx++) {
            if (img[idx] === 0) continue;
            const x = idx % width;
            const y = (idx - x) / width;

            const p2 = get(x, y - 1); // N
            const p3 = get(x + 1, y - 1); // NE
            const p4 = get(x + 1, y); // E
            const p5 = get(x + 1, y + 1); // SE
            const p6 = get(x, y + 1); // S
            const p7 = get(x - 1, y + 1); // SW
            const p8 = get(x - 1, y); // W
            const p9 = get(x - 1, y - 1); // NW

            const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (b < 2 || b > 6) continue;

            // A(P1): 0→1 transitions around the ordered ring.
            const ring = [p2, p3, p4, p5, p6, p7, p8, p9];
            let a = 0;
            for (let k = 0; k < 8; k++) {
                if (ring[k] === 0 && ring[(k + 1) % 8] === 1) a++;
            }
            if (a !== 1) continue;

            if (step === 1) {
                if (p2 * p4 * p6 !== 0) continue;
                if (p4 * p6 * p8 !== 0) continue;
            } else {
                if (p2 * p4 * p8 !== 0) continue;
                if (p2 * p6 * p8 !== 0) continue;
            }

            flagged.push(idx);
        }

        if (flagged.length === 0) return 0;

        const toDelete = applyComponentGuard(img, flagged, width, height);
        for (const idx of toDelete) img[idx] = 0;
        return toDelete.length;
    };

    // Repeat the Zhang–Suen pass to convergence, then run the deterministic
    // 2×2-block cleanup. The cleanup can, in principle, unlock further
    // Zhang–Suen deletions, so we alternate the two until *neither* changes
    // anything. The fixed point reached here is what guarantees idempotence:
    // when this loop exits, a full Zhang–Suen pass deletes nothing AND no 2×2
    // fully-set block remains, so re-running `thinToSinglePixel` on the output
    // is a no-op.
    for (; ;) {
        // Zhang–Suen to convergence.
        for (; ;) {
            let changed = 0;
            changed += subIteration(1);
            changed += subIteration(2);
            if (changed === 0) break;
        }
        // Deterministic post-condition enforcement.
        const removed = removeFullBlocks(img, width, height);
        if (removed === 0) break;
    }

    return img;
}

/**
 * Deterministic final cleanup that guarantees the Property-21 post-condition:
 * the bitmap contains **no 2×2 fully-set block**. Zhang–Suen thinning can
 * leave residual 2×2 squares and 2-pixel-wide diagonal staircases as stable
 * terminal patterns that its component-preservation guard does not catch
 * (the four pixels of a block are not all flagged in the same sub-iteration),
 * so this pass closes that gap.
 *
 * While any 2×2 fully-set block exists, exactly one of its four pixels is
 * cleared — deterministically the **highest raster index** of the four, i.e.
 * the bottom-right pixel `(x+1, y+1)`. The bitmap is swept in raster order
 * repeatedly until a full sweep finds no fully-set block.
 *
 * Why this is safe with respect to the other three properties:
 *   - **Subset:** it only ever clears pixels, never sets them.
 *   - **Idempotence:** on an input that already has no 2×2 block it clears
 *     nothing and returns `0`, so it is inert on an already-thin image.
 *   - **Non-emptiness:** a fully-set block has four set pixels; clearing one
 *     leaves three, so removing a block can never empty the component that
 *     contained it (a lone 2×2 square reduces to a 3-pixel L, which has no
 *     2×2 block and is non-empty).
 *
 * Termination is guaranteed: every cleared pixel strictly decreases the set
 * count, and clearing a pixel can never create a new fully-set block.
 *
 * @param img    Row-major 0/1 working buffer, mutated in place.
 * @param width  Image width in pixels.
 * @param height Image height in pixels.
 * @returns      The total number of pixels cleared (0 if already clean).
 */
function removeFullBlocks(
    img: Uint8Array,
    width: number,
    height: number,
): number {
    let totalRemoved = 0;
    for (; ;) {
        let removedThisSweep = 0;
        for (let y = 0; y + 1 < height; y++) {
            for (let x = 0; x + 1 < width; x++) {
                const topLeft = y * width + x;
                const topRight = topLeft + 1;
                const bottomLeft = topLeft + width;
                const bottomRight = bottomLeft + 1;
                if (
                    img[topLeft] !== 0 &&
                    img[topRight] !== 0 &&
                    img[bottomLeft] !== 0 &&
                    img[bottomRight] !== 0
                ) {
                    // Clear the highest raster index of the four.
                    img[bottomRight] = 0;
                    removedThisSweep++;
                }
            }
        }
        totalRemoved += removedThisSweep;
        if (removedThisSweep === 0) break;
    }
    return totalRemoved;
}

/**
 * Component-preservation guard. Given the current `img` (0/1) and the list
 * of `flagged` pixel indices a Zhang–Suen sub-iteration wants to delete,
 * return the indices that may *actually* be deleted: for any 8-connected
 * component whose pixels are **all** flagged, one representative pixel (the
 * lowest raster index) is retained so the component is never erased whole.
 *
 * This is what stops vanilla Zhang–Suen from deleting an isolated 2×2 square
 * down to nothing; the retained pixel is isolated, so no 2×2 block survives.
 */
function applyComponentGuard(
    img: Uint8Array,
    flagged: number[],
    width: number,
    height: number,
): number[] {
    const n = width * height;
    const flaggedSet = new Set(flagged);
    const visited = new Uint8Array(n);
    const retained = new Set<number>();

    for (let start = 0; start < n; start++) {
        if (img[start] === 0 || visited[start] !== 0) continue;

        // 8-connected flood fill of this component.
        const component: number[] = [];
        const stack = [start];
        visited[start] = 1;
        while (stack.length > 0) {
            const cur = stack.pop() as number;
            component.push(cur);
            const cx = cur % width;
            const cy = (cur - cx) / width;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const nIdx = ny * width + nx;
                    if (img[nIdx] === 0 || visited[nIdx] !== 0) continue;
                    visited[nIdx] = 1;
                    stack.push(nIdx);
                }
            }
        }

        // If the entire component is flagged, keep its lowest-index pixel.
        const allFlagged = component.every((idx) => flaggedSet.has(idx));
        if (allFlagged) {
            let keep = component[0];
            for (const idx of component) if (idx < keep) keep = idx;
            retained.add(keep);
        }
    }

    if (retained.size === 0) return flagged;
    return flagged.filter((idx) => !retained.has(idx));
}

/**
 * Decide whether a binary bitmap is "single pixel wide" in the precise,
 * decidable sense used by Req 4.3 / Property 21: it contains **no 2×2
 * fully-set block**. Formally, there is no `(x, y)` for which all four of
 * `(x,y)`, `(x+1,y)`, `(x,y+1)`, `(x+1,y+1)` are set.
 *
 * Any non-zero byte counts as set. Bitmaps narrower or shorter than 2 px
 * trivially contain no 2×2 block and return `true`.
 *
 * @param bitmap Row-major bytes; non-zero = set. Length must be ≥ `width*height`.
 * @param width  Image width in pixels (integer ≥ 0).
 * @param height Image height in pixels (integer ≥ 0).
 * @returns      `true` iff there is no 2×2 fully-set block.
 * @throws {RangeError} on non-integer/negative dimensions or a short bitmap.
 */
export function isSinglePixelWide(
    bitmap: Uint8Array,
    width: number,
    height: number,
): boolean {
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
        throw new RangeError(
            'isSinglePixelWide: width and height must be integers',
        );
    }
    if (width < 0 || height < 0) {
        throw new RangeError(
            'isSinglePixelWide: width and height must be non-negative',
        );
    }
    const n = width * height;
    if (bitmap.length < n) {
        throw new RangeError(
            `isSinglePixelWide: bitmap length ${bitmap.length} < width*height ${n}`,
        );
    }

    const set = (x: number, y: number): boolean =>
        bitmap[y * width + x] !== 0;

    for (let y = 0; y + 1 < height; y++) {
        for (let x = 0; x + 1 < width; x++) {
            if (
                set(x, y) &&
                set(x + 1, y) &&
                set(x, y + 1) &&
                set(x + 1, y + 1)
            ) {
                return false;
            }
        }
    }
    return true;
}
