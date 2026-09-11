"""Pure image -> drawable-polyline vectorization pipeline (skeleton-primary).

This module is intentionally **pure**: it has NO FastAPI imports/types and no
network/DOM dependency, so it is directly unit-testable. The FastAPI endpoint
(Task 3) delegates to :func:`vectorize` and serializes the returned ``dict``.

The pipeline mirrors the reference (Engineezy-style) construction:

    decode -> downscale -> grayscale -> contrast/blur -> posterize tone bands
    -> skimage.morphology.skeletonize per dark region -> walk skeleton graph
    -> cv2.approxPolyDP smoothing -> drop short fragments -> findContours
    silhouette -> nearest-neighbor ordering -> pixel-space polylines.

Determinism (Property 2): every stage uses a fixed iteration order and no
randomness, so identical bytes + params yield deeply-equal ``polylines``.

Bounded / monotonic output (Property 5): ``detail`` maps to the approxPolyDP
epsilon and the effective ``min_stroke_len`` such that LOWERING ``detail``
yields a *larger* epsilon and a *larger* drop threshold -- so total vertex
count is non-increasing as detail decreases (never a blow-up).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Set, Tuple

import cv2
import numpy as np
from skimage.morphology import skeletonize

# A polyline is an ordered list of [x, y] pixel coordinates.
Point = List[float]
Polyline = List[Point]


@dataclass
class VectorizeParams:
    """Tunable parameters for the vectorize pipeline (documented defaults).

    Attributes:
        mode: ``"skeleton"`` (centerlines only), ``"contour"`` (silhouette
            only), ``"both"`` (skeleton centerlines + silhouette), or
            ``"hatch"`` (tonal serpentine fill — dense lines where dark,
            blank past the white threshold, plus an optional clean feature
            pass: skeleton centerlines + a smooth subject outline).
        detail: 0..1 quality lever. Maps to the approxPolyDP epsilon and the
            effective minimum stroke length. LOWER detail -> larger epsilon
            and larger drop threshold -> fewer vertices (Property 5).
        contrast: Multiplier applied around mid-gray (128); 1.0 is a no-op.
        threshold: Global dark/light split in 0..255. ``0`` selects Otsu auto.
        tone_bands: Number of nested dark bands to isolate (darkest first).
        blur_sigma: Gaussian blur sigma for denoise; ``0`` disables blur.
        max_dim: Longest-side cap after downscale (never upscales).
        min_stroke_len: Drop polylines shorter than this many pixels.
        run_spacing: Base fill-line spacing in px for ``hatch`` mode (the gap
            between serpentine scan rows at the LIGHTEST band). Smaller =
            denser = more steps. Per-band spacing scales this so the darkest
            band is tightest. Default ~6 at ``max_dim`` = 1000.
        white_threshold: In ``hatch`` mode, pixels with value >= this (0..255)
            are background and are NEVER filled (highlights stay blank). This is
            also the CEILING of the tonal-band range: the fillable range
            ``[0, white_threshold)`` is split into ``tone_bands`` nested masks,
            so raising it admits lighter mid-tones into the fill and lowering it
            blows more of the image out to white. Default 130: only tones darker
            than ~130/255 (hat, hair, eyebrows, deep shadows, gear gaps) get
            filled, while the neutral-gray studio background (~165) and bright
            skin (~200) stay blank — matching the reference's pure-white
            background. This remains the user's coverage lever: raise it to fill
            more mid-tones, lower it for a starker, sparser look.
        edge_paths: In ``hatch`` mode, when true add the clean feature pass
            (skeleton centerlines on the darkest bands + a smooth subject
            outline — eyebrows / gear / jaw / silhouette) on top of the fill.
        hatch_angle: Reserved for rotating the hatch field. Only ``0.0``
            (horizontal scan rows) is implemented; non-zero is future work and
            is treated as horizontal.
    """

    mode: str = "contour"
    detail: float = 0.5
    contrast: float = 1.0
    threshold: int = 0
    tone_bands: int = 4
    blur_sigma: float = 1.0
    max_dim: int = 1000
    min_stroke_len: float = 8.0
    run_spacing: float = 6.0
    white_threshold: int = 130
    edge_paths: bool = True
    hatch_angle: float = 0.0
    isolate_subject: bool = False
    local_contrast: float = 0.0


# Upper bound (px) on the approxPolyDP epsilon for the hatch FEATURE pass.
# The global detail->epsilon map yields ~12.75 px at detail=0.5 on a 1000-px
# image, which collapses smooth centerlines / outlines into jagged few-point
# zigzags. The feature pass clamps its epsilon to this ceiling so feature
# strokes stay smooth curves regardless of where the user parks the detail
# slider. Keep it small (~3 px): large enough to drop pixel-jitter, small
# enough to preserve curvature of eyebrows / jaw / gear / subject outline.
HATCH_FEATURE_EPSILON_MAX = 3.0

# Minimum retained feature-stroke length as a FRACTION of the image's larger
# dimension. Strokes shorter than this are speckle / triangle shards around the
# shirt and neck and are dropped entirely. 0.03 == 3% of the longer side
# (e.g. 30 px on a 1000-px image).
HATCH_FEATURE_MIN_LEN_FRAC = 0.03


# ---------------------------------------------------------------------------
# Dark-feature detail sub-pass (eyes / eyebrows / nostrils / lip line).
# ---------------------------------------------------------------------------
# The two primary feature contributions (darkest-band skeleton centerlines + a
# smooth full-dark silhouette outline) both gate on
# ``HATCH_FEATURE_MIN_LEN_FRAC`` (~3% of the larger dim, ~30 px). On a real
# portrait the eyes, nostrils, and lip line are SMALL but VERY DARK localized
# features that fall under that floor, so they vanish and the face reads as a
# blank silhouette. This sub-pass isolates only the darkest pixels and keeps
# their small, bounded contours so those features read as crisp strokes.

# Only pixels strictly darker than this absolute value (0..255) feed the detail
# pass. The darkest facial features (pupils / eye sockets / nostrils / lip line
# / deep shadow) live here; mid-tone skin and the studio background do not. The
# effective cutoff is ``min(HATCH_DETAIL_MAX_VALUE, otsu * 0.45)`` so a very
# dark image (low Otsu) tightens the cutoff instead of admitting half the face.
HATCH_DETAIL_MAX_VALUE = 60

# Minimum detail-stroke length as a FRACTION of the image's larger dimension.
# Smaller than ``HATCH_FEATURE_MIN_LEN_FRAC`` so small features (eyes ~10 px on
# a 1000-px image) survive, while sub-pixel speckle is still dropped.
HATCH_DETAIL_MIN_LEN_FRAC = 0.01

# Skip detail contours whose bounding box exceeds this fraction of EITHER image
# dimension. A contour that large is a hair/hat/shadow MASS already drawn by the
# fill + the other feature passes; admitting it here would double those strokes.
HATCH_DETAIL_MAX_BBOX_FRAC = 0.40

# In hatch mode, the largest horizontal gap — as a MULTIPLE of the band's scan-
# row spacing — that a serpentine ribbon will bridge with a pen-down connector
# between consecutive rows. Within a solid region the next row's entry sits
# nearly above the previous row's exit, so the connector is a short near-vertical
# segment that traces the shape edge (the Engineezy serpentine). A wider gap
# means the two runs belong to SEPARATE blobs with a highlight between them;
# bridging it would draw a visible line across blank screen, so the ribbon breaks
# there and the downstream connector router hides that travel instead. This is
# the core "few reversals -> survives backlash" lever: chaining runs into long
# ribbons (vs one polyline per run) is what keeps the physical draw clean.
HATCH_RIBBON_BRIDGE_FACTOR = 2.5

# Hard ceiling on the FRACTION of the image the hatch fill may ink, regardless
# of the (absolute) ``white_threshold``. A fixed absolute threshold inks every
# pixel darker than it, so a dark photo or a dark/busy BACKGROUND saturates the
# whole frame into a near-solid black square — unrecognizable AND a massive,
# slow, backlash-punishing path on the device. When more than this fraction of
# pixels would be fillable, the effective cutoff drops to the darkest-N% so the
# darkest content still fills but the mid/background tones are spared. This makes
# coverage (and machine time) bounded and exposure-robust instead of a blob.
HATCH_MAX_COVERAGE = 0.55

# Background separation (hatch). A studio portrait sits on a fairly UNIFORM
# backdrop — light (white sweep) or dark. The fill should shade the SUBJECT and
# leave the backdrop blank; otherwise a dark backdrop floods the frame. These
# tune a conservative, guarded detector that only fires when the image border is
# genuinely uniform, so images without a clear background (gradients, full-frame
# scenes) are left exactly as before.
#   * TOL: how close (0..255) a pixel must be to the border tone to count as
#     "background-coloured".
#   * UNIFORM_STD: max std-dev of the border ring for a background to be deemed
#     present at all (a noisy/varied border => no confident background).
#   * MIN_FRAC: the detected background must cover at least this fraction of the
#     frame, else it is treated as noise (no background).
HATCH_BG_TONE_TOL = 22
HATCH_BG_UNIFORM_STD = 30.0
HATCH_BG_MIN_FRAC = 0.15


# 8-connected neighbour offsets in a fixed (deterministic) order.
_NEIGHBOUR_OFFSETS: Tuple[Tuple[int, int], ...] = (
    (-1, -1),
    (0, -1),
    (1, -1),
    (-1, 0),
    (1, 0),
    (-1, 1),
    (0, 1),
    (1, 1),
)


# ---------------------------------------------------------------------------
# Detail -> budget mapping (Property 5: monotonic, non-increasing vertices).
# ---------------------------------------------------------------------------
def _detail_to_epsilon(detail: float) -> float:
    """Map ``detail`` in 0..1 to an approxPolyDP epsilon (pixels).

    Lower detail -> larger epsilon -> aggressively simplified contours.
    Range chosen so the slider has REAL authority on a portrait-sized image:
    at detail=1.0 every pixel-level wiggle survives (epsilon 0.5 px); at
    detail=0.0 contours collapse to their major beats (epsilon 25 px), which
    on a 1000-px-tall face means ~10-20 vertices for the silhouette and
    eliminates curvature noise entirely. Earlier the range was 1..5 px,
    which barely moved the step count on real input — the slider was
    effectively decorative.
    """
    d = max(0.0, min(1.0, float(detail)))
    return 0.5 + (1.0 - d) * 24.5  # detail=1 -> 0.5 px ; detail=0 -> 25.0 px


def _detail_to_min_stroke_len(detail: float, base_min_stroke_len: float) -> float:
    """Scale the base ``min_stroke_len`` up as ``detail`` drops.

    Lower detail -> larger drop threshold -> fewer surviving strokes. The
    range (1x..8x base) is wide enough to actually thin a real photo's
    contour set: at detail=0 we drop everything below 8x the base length,
    so the noise contours that bloat step count without contributing
    visible signal disappear.
    """
    d = max(0.0, min(1.0, float(detail)))
    base = max(0.0, float(base_min_stroke_len))
    return base * (1.0 + (1.0 - d) * 7.0)  # detail=1 -> base ; detail=0 -> 8*base


# ---------------------------------------------------------------------------
# Small geometry helpers.
# ---------------------------------------------------------------------------
def _polyline_length(poly: Sequence[Point]) -> float:
    """Total Euclidean length of a polyline (0 for <2 points)."""
    total = 0.0
    for i in range(1, len(poly)):
        dx = poly[i][0] - poly[i - 1][0]
        dy = poly[i][1] - poly[i - 1][1]
        total += float(np.hypot(dx, dy))
    return total


def _approx_poly_dp(chain: Sequence[Tuple[int, int]], epsilon: float, *, closed: bool) -> Polyline:
    """Run cv2.approxPolyDP on an (x, y) chain, returning [[x, y], ...]."""
    if len(chain) < 2:
        return [[int(p[0]), int(p[1])] for p in chain]
    pts = np.asarray(chain, dtype=np.int32).reshape(-1, 1, 2)
    approx = cv2.approxPolyDP(pts, float(epsilon), closed)
    return [[int(p[0][0]), int(p[0][1])] for p in approx]


# ---------------------------------------------------------------------------
# Decode / downscale / preprocess.
# ---------------------------------------------------------------------------
# --- Transparent line-art / logo handling -------------------------------------
# A PNG logo is often stored as a coloured (frequently WHITE) shape on a fully
# transparent background. IMREAD_COLOR silently drops alpha, leaving the shape on
# whatever RGB hides under the transparent pixels (usually black) — so the dark-
# ink pipeline reads the *background* as ink and traces the inner+outer edge of
# every stroke as separate nested contours (the "onion ring" artefact). When an
# image carries meaningful transparency, the alpha channel IS the drawing, so we
# convert it to a dark-ink-on-white-paper matte (opaque -> dark, transparent ->
# white) regardless of the stroke colour. This makes a white-on-transparent logo
# behave exactly like black-on-white line art for every downstream mode.
ALPHA_TRANSPARENT_MAX = 16  # alpha <= this counts as "transparent"
ALPHA_MATTE_MIN_TRANSPARENT_FRAC = 0.15  # min transparent area to treat as matte


def _composite_over_white(bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Alpha-composite a BGR image over a white paper background."""
    a = (alpha.astype(np.float32) / 255.0)[:, :, None]
    white = np.full_like(bgr, 255, dtype=np.float32)
    out = bgr.astype(np.float32) * a + white * (1.0 - a)
    return np.clip(out, 0, 255).astype(np.uint8)


def _decode(image_bytes: bytes) -> np.ndarray:
    """Decode raw image bytes to a BGR ndarray. Raises ValueError if undecodable.

    Alpha handling: an RGBA image with a substantial transparent area is treated
    as a line-art matte (opaque -> dark ink on white paper); an RGBA image that is
    largely opaque is composited over white. Non-alpha images are unchanged.
    """
    if not image_bytes:
        raise ValueError("empty image bytes")
    buf = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("could not decode image bytes")

    if img.ndim == 3 and img.shape[2] == 4:
        alpha = img[:, :, 3]
        bgr = img[:, :, :3]
        transparent_frac = float((alpha <= ALPHA_TRANSPARENT_MAX).mean())
        if transparent_frac >= ALPHA_MATTE_MIN_TRANSPARENT_FRAC:
            # Transparent-background logo/line-art: alpha is the drawing.
            matte = (255 - alpha).astype(np.uint8)
            return cv2.cvtColor(matte, cv2.COLOR_GRAY2BGR)
        return _composite_over_white(bgr, alpha)

    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return img


def _downscale_to_max_dim(img: np.ndarray, max_dim: int) -> np.ndarray:
    """Downscale so the longest side <= max_dim. Never upscales; preserves aspect."""
    h, w = img.shape[:2]
    longest = max(h, w)
    if max_dim <= 0 or longest <= max_dim:
        return img
    scale = max_dim / float(longest)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)


def _to_grayscale(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def _apply_contrast(gray: np.ndarray, contrast: float) -> np.ndarray:
    if contrast == 1.0:
        return gray
    out = (gray.astype(np.float32) - 128.0) * float(contrast) + 128.0
    return np.clip(out, 0, 255).astype(np.uint8)


def _apply_blur(gray: np.ndarray, blur_sigma: float) -> np.ndarray:
    if blur_sigma and blur_sigma > 0:
        return cv2.GaussianBlur(gray, (0, 0), float(blur_sigma))
    return gray


# Tile grid for the CLAHE local-contrast pass. 8x8 tiles localise contrast to
# roughly face-feature scale on a portrait-sized image.
LOCAL_CONTRAST_TILE = 8
# Light post-CLAHE denoise sigma: CLAHE amplifies sensor/JPEG grit in otherwise
# flat tiles, so a sub-pixel Gaussian smooths that without losing the recovered
# feature edges.
LOCAL_CONTRAST_DENOISE_SIGMA = 0.6


def _apply_local_contrast(
    gray: np.ndarray,
    clip_limit: float,
    tile: int = LOCAL_CONTRAST_TILE,
    mask: Optional[np.ndarray] = None,
) -> np.ndarray:
    """Boost LOCAL contrast via CLAHE so subtle in-region detail survives.

    The rest of the pipeline is global (one Otsu band split, one percentile
    stretch, global-median Canny), so detail that lives as a subtle variation
    INSIDE a uniform light/dark area — a dark glossy mask's eye lenses / grille /
    seams, soft facial shadows — collapses into a single band and vanishes. CLAHE
    equalises contrast in local ``tile``x``tile`` cells, pulling those subtle
    variations apart so the downstream posterize resolves them into bands and the
    Canny feature pass catches their edges.

    When ``mask`` is supplied the boost is applied only inside it (the subject);
    pixels outside keep the original gray, so flat backgrounds are not amplified
    into grit. A light Gaussian denoise tames CLAHE's tile noise. ``clip_limit``
    <= 0 is a pass-through. Pure and deterministic (CLAHE is reproducible).
    """
    if clip_limit <= 0:
        return gray
    clahe = cv2.createCLAHE(clipLimit=float(clip_limit), tileGridSize=(tile, tile))
    enhanced = clahe.apply(gray)
    if LOCAL_CONTRAST_DENOISE_SIGMA > 0:
        enhanced = cv2.GaussianBlur(enhanced, (0, 0), LOCAL_CONTRAST_DENOISE_SIGMA)
    if mask is not None:
        return np.where(mask, enhanced, gray).astype(np.uint8)
    return enhanced


# ---------------------------------------------------------------------------
# Posterize into nested dark tone bands (darkest band first).
# ---------------------------------------------------------------------------
def posterize_to_tone_bands(gray: np.ndarray, tone_bands: int, threshold: int) -> List[np.ndarray]:
    """Split the dark range into ``tone_bands`` nested binary masks.

    When ``threshold == 0`` the global dark/light split is chosen by Otsu;
    otherwise the explicit ``threshold`` (0..255) is used. Returned masks are
    nested (``masks[0]`` darkest pixels only, ``masks[-1]`` the full dark
    region), darkest band first. Each mask is uint8 with 255 = dark.
    """
    bands = max(1, int(tone_bands))
    if threshold and threshold > 0:
        t = float(threshold)
    else:
        # THRESH_OTSU computes and returns the optimal global split value.
        t, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    t = max(1.0, min(255.0, float(t)))

    masks: List[np.ndarray] = []
    for i in range(bands):
        level = t * (i + 1) / bands  # smallest first -> darkest band first
        mask = (gray < level).astype(np.uint8) * 255
        masks.append(mask)
    return masks


# ---------------------------------------------------------------------------
# Skeleton graph walking (ordered pixel chains).
# ---------------------------------------------------------------------------
def walk_skeleton_graph(skel: np.ndarray) -> List[List[Tuple[int, int]]]:
    """Walk an 8-connected skeleton into ordered (x, y) pixel chains.

    Chains start at endpoints/junctions (degree != 2) and run along degree-2
    paths until reaching another endpoint/junction. Pure loops (all degree 2)
    are emitted afterwards. Iteration order is deterministic (row-major by
    (y, x) then the fixed neighbour-offset order), so the output is a pure
    function of the input skeleton (Property 2).
    """
    arr = np.asarray(skel)
    mask = arr.astype(bool)
    ys, xs = np.nonzero(mask)
    pts = {(int(x), int(y)) for x, y in zip(xs, ys)}
    if not pts:
        return []

    def neighbours(p: Tuple[int, int]) -> List[Tuple[int, int]]:
        x, y = p
        out = []
        for dx, dy in _NEIGHBOUR_OFFSETS:
            q = (x + dx, y + dy)
            if q in pts:
                out.append(q)
        return out

    # Deterministic node order: row-major (y, then x).
    nodes = sorted(pts, key=lambda p: (p[1], p[0]))
    degree = {p: len(neighbours(p)) for p in nodes}
    visited_edges: set = set()

    def edge_key(a: Tuple[int, int], b: Tuple[int, int]):
        return (a, b) if a <= b else (b, a)

    chains: List[List[Tuple[int, int]]] = []

    def walk_from(start: Tuple[int, int], first: Tuple[int, int]) -> List[Tuple[int, int]]:
        chain = [start, first]
        visited_edges.add(edge_key(start, first))
        prev, cur = start, first
        while degree[cur] == 2 and cur != start:
            nxt = None
            for q in neighbours(cur):
                if q != prev and edge_key(cur, q) not in visited_edges:
                    nxt = q
                    break
            if nxt is None:
                break
            visited_edges.add(edge_key(cur, nxt))
            chain.append(nxt)
            prev, cur = cur, nxt
        return chain

    # 1) Walk outward from endpoints and junctions.
    for s in nodes:
        if degree[s] == 2:
            continue
        for nb in neighbours(s):
            if edge_key(s, nb) in visited_edges:
                continue
            chains.append(walk_from(s, nb))

    # 2) Remaining edges form pure degree-2 loops.
    for s in nodes:
        for nb in neighbours(s):
            if edge_key(s, nb) in visited_edges:
                continue
            chains.append(walk_from(s, nb))

    return chains


def skeletonize_regions(
    masks: Sequence[np.ndarray],
    epsilon: float = 2.0,
    min_stroke_len: float = 8.0,
) -> List[Polyline]:
    """Skeletonize each dark mask into simplified centerline polylines.

    For each mask: skimage.morphology.skeletonize -> walk into ordered chains
    -> cv2.approxPolyDP (epsilon) -> drop chains shorter than ``min_stroke_len``.
    Returns pixel-space polylines (one confident centerline per stroke).
    """
    polylines: List[Polyline] = []
    for mask in masks:
        if mask is None or not np.any(mask):
            continue
        skel = skeletonize(mask.astype(bool))
        for chain in walk_skeleton_graph(skel):
            if len(chain) < 2:
                continue
            poly = _approx_poly_dp(chain, epsilon, closed=False)
            if _polyline_length(poly) >= min_stroke_len:
                polylines.append(poly)
    return polylines


# ---------------------------------------------------------------------------
# Line-art / logo outline tracing.
# ---------------------------------------------------------------------------
# A logo or line drawing wants ONE clean outline per shape, not the medial-axis
# skeleton (which scrambles rounded shapes — a mascot's face collapses into a
# jagged blob) and not a naive contour trace (which draws the inner AND outer
# edge of every thin stroke — the "onion ring" doubling). The winning recipe:
# trace CCOMP contours of the ink, keep EVERY outer contour, and keep an interior
# hole only when it is SMALL — a mascot's eyes, a letter's counter (the hole in
# O / R / A). A large interior contour is the inner edge of a thin outline stroke
# (the doubling) and is dropped. This yields crisp single-line letters plus a
# mascot with its eyes.
LINEART_INK_CUTOFF = 210  # gray < this = ink; generous so anti-aliased strokes survive
LINEART_HOLE_MAX_FRAC = 0.006  # keep holes smaller than this frac of image (eyes/counters)
LINEART_MIN_AREA_FRAC = 8e-5  # drop speck contours below this frac of image


def lineart_outline(
    gray: np.ndarray,
    epsilon: float,
    min_stroke_len: float,
    *,
    ink_cutoff: int = LINEART_INK_CUTOFF,
    hole_max_frac: float = LINEART_HOLE_MAX_FRAC,
) -> List[Polyline]:
    """Trace clean single-line outlines from a logo / line-art image.

    ``gray`` is the preprocessed grayscale (dark = ink). Returns one closed
    polyline per outer shape plus small interior holes (eyes / letter counters),
    dropping the large inner-edge contours that would double thin strokes.
    """
    h, w = gray.shape[:2]
    img_area = float(h * w)
    ink = (gray < int(ink_cutoff)).astype(np.uint8) * 255
    if not ink.any():
        return []
    # Stabilize thin / anti-aliased strokes so a hairline outline traces as one
    # solid boundary instead of fragmenting.
    ink = cv2.GaussianBlur(ink, (3, 3), 0)
    _, ink = cv2.threshold(ink, 90, 255, cv2.THRESH_BINARY)

    contours, hierarchy = cv2.findContours(ink, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]

    min_area = LINEART_MIN_AREA_FRAC * img_area
    hole_max_area = hole_max_frac * img_area
    polylines: List[Polyline] = []
    for i, contour in enumerate(contours):
        area = cv2.contourArea(contour)
        is_hole = hierarchy[i][3] != -1
        if is_hole:
            # Small hole = eye / letter counter (keep); large hole = inner edge of
            # a thin outline stroke, i.e. the doubling (drop).
            if area < min_area or area > hole_max_area:
                continue
        elif area < min_area and cv2.arcLength(contour, True) < min_stroke_len:
            continue
        chain = [(int(p[0][0]), int(p[0][1])) for p in contour]
        poly = _approx_poly_dp(chain, epsilon, closed=True)
        if len(poly) < 2:
            continue
        if poly[0] != poly[-1]:
            poly.append(list(poly[0]))  # close the loop for a pen-down return
        polylines.append(poly)
    return polylines


def _silhouette_contours(
    masks: Sequence[np.ndarray],
    epsilon: float,
    min_stroke_len: float,
    image_size: Tuple[int, int] | None = None,
) -> List[Polyline]:
    """Extract one clean closed contour per dark region (outer + real holes only).

    Strategy (the duplication-free fix):

    * Iterate the posterized dark masks darkest-first.
    * Use ``cv2.findContours(RETR_CCOMP)`` to get a 2-level hierarchy: outer
      contours of each connected component, plus that component's holes
      (genuine background islands inside the dark blob — eye sockets in hair,
      gaps in a moustache, etc.). RETR_CCOMP is chosen over RETR_LIST because
      LIST also returns the contour traced from the OPPOSITE SIDE of the same
      pixel boundary — the source of the "doubled outline" + tangled fill.
    * Drop noise: skip contours whose bounding-box diagonal is below
      ``min_stroke_len`` (already handled by ``_polyline_length``-after-
      simplify), AND skip closed contours whose enclosed *area* is below a
      small floor — those are the boundary traces of 1-2 px-thin features
      that read as visible doubled lines for almost no signal.
    * Drop **canvas-border artifacts**: when ``image_size`` is supplied, any
      contour whose bounding box covers >= 95% of the image dimensions is the
      whole-image rectangle (a frame around blank padding / a screenshot's
      uniform background), not real content. Vector-source PNGs (logos,
      screenshots) almost always trigger this when the threshold catches the
      page edge; without the gate, the planner draws an unwanted rectangle
      around the actual subject.

    This replaces the prior RETR_EXTERNAL-on-outer-mask version (no holes -> no
    interior detail) and the brief RETR_LIST experiment (every band traced
    twice -> tangled mess + 525k steps on a portrait).
    """
    polylines: List[Polyline] = []
    # An "ignore" floor for closed-contour enclosed area, in pixels^2. Tuned
    # so a single-pixel-wide stroke's boundary trace (whose enclosed area is
    # ~its length) survives only when that length is meaningful.
    min_closed_area = max(8.0, float(min_stroke_len) * float(min_stroke_len))
    # Border-rectangle filter: 95% of EITHER axis means the contour is hugging
    # the image edge — almost certainly a frame, not the subject. Tuned so a
    # subject that genuinely fills the canvas (e.g. a face zoomed in) still
    # passes; a 95% bbox on both axes is too aggressive only for content that
    # would already be off-canvas / clipped on the machine.
    border_frac = 0.95
    img_w, img_h = (image_size if image_size else (0, 0))
    for mask in masks:
        if mask is None or not np.any(mask):
            continue
        contours, _ = cv2.findContours(
            mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE
        )
        for c in contours:
            if len(c) < 4:
                continue
            # Bounding-box border filter — only when we know the image size.
            if img_w > 0 and img_h > 0:
                bx, by, bw, bh = cv2.boundingRect(c)
                if (
                    bw >= int(img_w * border_frac)
                    and bh >= int(img_h * border_frac)
                ):
                    # Whole-image rectangle: the canvas frame, not the subject.
                    continue
            # Closed-contour area gate: throws out doubled-outline noise from
            # very thin features without removing real shapes.
            area = float(cv2.contourArea(c))
            if area < min_closed_area:
                continue
            chain = [(int(p[0][0]), int(p[0][1])) for p in c]
            poly = _approx_poly_dp(chain, epsilon, closed=True)
            if _polyline_length(poly) >= min_stroke_len:
                polylines.append(poly)
    return polylines


# ---------------------------------------------------------------------------
# Tonal hatch fill — serpentine scan-fill whose density tracks local darkness.
# ---------------------------------------------------------------------------
def _scanline_runs(row: np.ndarray, min_run: int) -> List[Tuple[int, int]]:
    """Find contiguous spans where a 1-D mask row is set.

    Returns ``(x_start, x_end)`` inclusive pairs for every run of nonzero
    pixels at least ``min_run`` pixels wide. Pure / deterministic: scans the
    row left-to-right once. Runs shorter than ``min_run`` are dropped as noise.
    """
    runs: List[Tuple[int, int]] = []
    n = int(row.shape[0])
    x = 0
    while x < n:
        if row[x]:
            start = x
            while x < n and row[x]:
                x += 1
            end = x - 1  # inclusive
            if (end - start + 1) >= min_run:
                runs.append((start, end))
        else:
            x += 1
    return runs


def coverage_capped_threshold(
    gray: np.ndarray, requested: int, max_coverage: float = HATCH_MAX_COVERAGE
) -> int:
    """Lower a fill cutoff so no more than ``max_coverage`` of pixels are inked.

    The hatch fill inks every pixel darker than ``requested``. On a dark or
    dark-background image that floods the frame into a near-solid blob. This
    clamps the effective cutoff to the ``max_coverage`` darkness percentile when
    (and only when) the requested cutoff would exceed that coverage, so the
    darkest content still fills while mid-tones / background are spared. Returns
    ``requested`` unchanged when it already inks at or below the cap. Pure and
    deterministic (percentile of a fixed array).
    """
    req = int(max(1, min(255, requested)))
    cap = max(0.0, min(1.0, float(max_coverage)))
    total = int(gray.size)
    if total == 0 or cap >= 1.0:
        return req
    darker = int(np.count_nonzero(gray < req))
    if darker <= cap * total:
        return req
    # Too much would fill: drop to the darkest-cap% percentile value.
    cap_val = float(np.percentile(gray, cap * 100.0))
    return int(max(1, min(req, math.floor(cap_val))))


def detect_background_mask(gray: np.ndarray) -> Optional[np.ndarray]:
    """Detect a confident, uniform dominant background; return its boolean mask.

    A studio portrait's backdrop (light OR dark) reads as a roughly uniform tone
    that hugs the image border. This samples the border ring; if it is uniform
    enough (``HATCH_BG_UNIFORM_STD``) it takes the border's median as the
    background tone, marks every pixel within ``HATCH_BG_TONE_TOL`` of it, and
    keeps only the connected components that actually TOUCH the border — so a
    same-toned feature INSIDE the subject (e.g. a dark pupil on a dark backdrop)
    is NOT mistaken for background. Returns ``None`` (no masking) when the border
    is not uniform, nothing matches, or the detected region is too small
    (``HATCH_BG_MIN_FRAC``) — leaving non-portrait images unchanged.

    Pure and deterministic (median / connected components of a fixed array).
    """
    h, w = gray.shape[:2]
    if h < 4 or w < 4:
        return None
    border = np.concatenate(
        [gray[0, :], gray[-1, :], gray[:, 0], gray[:, -1]]
    ).astype(np.float32)
    if float(border.std()) > HATCH_BG_UNIFORM_STD:
        return None  # noisy/varied border -> no confident background

    bg = int(round(float(np.median(border))))
    bg_like = (np.abs(gray.astype(np.int16) - bg) <= HATCH_BG_TONE_TOL).astype(np.uint8)
    if not np.any(bg_like):
        return None

    _, labels = cv2.connectedComponents(bg_like, connectivity=8)
    border_labels: Set[int] = set()
    for arr in (labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]):
        border_labels.update(int(v) for v in np.unique(arr))
    border_labels.discard(0)  # 0 is the non-bg-like region
    if not border_labels:
        return None

    background = np.isin(labels, list(border_labels))
    if float(background.mean()) < HATCH_BG_MIN_FRAC:
        return None
    return background


# GrabCut iteration count for subject isolation. 5 is the usual sweet spot:
# enough for the GMM/graph-cut to settle, cheap enough (~1s on a ~600px image).
SUBJECT_GRABCUT_ITERS = 5
# Border margin (fraction per side) of the GrabCut init rectangle. The subject is
# assumed roughly centred, so a 8% inset seeds "probable background" around the
# frame edge and "probable foreground" inside.
SUBJECT_RECT_MARGIN = 0.08
# Reject a subject mask that covers less/more than these fractions of the frame —
# those are GrabCut failures (caught nothing / caught everything), so we fall
# back to the unmasked behaviour instead of a garbage isolation.
SUBJECT_MIN_FRAC = 0.03
SUBJECT_MAX_FRAC = 0.97
# Morphological smoothing of the subject silhouette, as a FRACTION of the larger
# dimension. GrabCut returns a lumpy, serrated boundary (skin-vs-background is
# low-contrast along a neck / shoulder); the perimeter outline and the fill both
# terminate on that edge, so its ragged staircase reads as junk. An OPEN then
# CLOSE with this kernel rounds off protrusions and bays into a clean, intentional
# silhouette without moving the boundary meaningfully. ~0.03 == 18 px on a 600-px
# image. 0 disables.
SUBJECT_MASK_SMOOTH_FRAC = 0.03


def _smooth_silhouette(mask_u8: np.ndarray, frac: float, longest: float) -> np.ndarray:
    """OPEN-then-CLOSE a 0/255 silhouette to round off serrations and bays.

    The kernel side is ``frac * longest`` (the image's larger dimension), forced
    odd and floored at 3 px. OPEN erases thin protrusions / spikes; CLOSE fills
    thin notches / bays — together yielding a clean, intentional outline without
    displacing the boundary meaningfully. Returns a 0/255 ``uint8`` array;
    ``frac <= 0`` returns the input unchanged.
    """
    if frac <= 0:
        return mask_u8
    k = max(3, int(round(frac * longest)))
    if k % 2 == 0:
        k += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    out = cv2.morphologyEx(mask_u8, cv2.MORPH_OPEN, kernel)
    out = cv2.morphologyEx(out, cv2.MORPH_CLOSE, kernel)
    return out


def detect_subject_mask(img_bgr: np.ndarray) -> Optional[np.ndarray]:
    """Isolate the main (roughly centred) subject from a busy background.

    Uses GrabCut seeded with a centred rectangle, then keeps the largest
    connected foreground component and fills its interior holes — so a light
    subject on a cluttered dark background (the hard case for tonal fills) is
    reduced to a clean subject mask, leaving the surround blank. Returns ``None``
    when GrabCut is unavailable/fails or the result is implausibly small/large
    (``SUBJECT_MIN_FRAC`` / ``SUBJECT_MAX_FRAC``), so callers fall back to the
    normal whole-frame behaviour.

    Deterministic: GrabCut's rect-init EM is reproducible for fixed input + iters.
    """
    if img_bgr.ndim != 3 or img_bgr.shape[2] != 3:
        return None
    h, w = img_bgr.shape[:2]
    if h < 16 or w < 16:
        return None

    mx = max(1, int(round(w * SUBJECT_RECT_MARGIN)))
    my = max(1, int(round(h * SUBJECT_RECT_MARGIN)))
    rect = (mx, my, w - 2 * mx, h - 2 * my)

    mask = np.zeros((h, w), np.uint8)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(
            img_bgr, mask, rect, bgd, fgd, SUBJECT_GRABCUT_ITERS, cv2.GC_INIT_WITH_RECT
        )
    except cv2.error:
        return None

    fg = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.uint8)
    if not np.any(fg):
        return None

    num, labels, stats, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
    if num <= 1:
        return None
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    subject = (labels == largest).astype(np.uint8) * 255

    # Fill interior holes so dark internal features (eyes, gaps) stay part of the
    # subject rather than punching background-coloured holes through it.
    contours, _ = cv2.findContours(subject, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(subject)
    cv2.drawContours(filled, contours, -1, 255, thickness=cv2.FILLED)

    # Smooth the lumpy GrabCut silhouette so the downstream perimeter + fill
    # boundary is a clean curve instead of a serrated staircase.
    filled = _smooth_silhouette(filled, SUBJECT_MASK_SMOOTH_FRAC, float(max(h, w)))

    out = filled > 0

    frac = float(out.mean())
    if frac < SUBJECT_MIN_FRAC or frac > SUBJECT_MAX_FRAC:
        return None
    return out


def normalize_within_mask(
    gray: np.ndarray, mask: np.ndarray, lo_pct: float = 5.0, hi_pct: float = 95.0
) -> np.ndarray:
    """Percentile contrast-stretch ``gray`` using only the masked region.

    A uniform-coloured subject (e.g. a white 3D print) has almost no absolute
    tonal range, so a tonal fill would read as a flat blank. Stretching the
    subject's own ``lo_pct``..``hi_pct`` percentile band across the full 0..255
    range makes its subtle shading (eye sockets, crevices, shadow) separate so
    the fill can render real form. Pixels outside the mask are stretched by the
    same transform (harmless — they are not drawn). Returns a uint8 copy; the
    input is not mutated. Falls back to the input when the mask is empty or flat.
    """
    if not np.any(mask):
        return gray
    vals = gray[mask].astype(np.float32)
    lo = float(np.percentile(vals, lo_pct))
    hi = float(np.percentile(vals, hi_pct))
    if hi - lo < 1.0:
        return gray
    stretched = (gray.astype(np.float32) - lo) * (255.0 / (hi - lo))
    return np.clip(stretched, 0, 255).astype(np.uint8)


def _serpentine_ribbons(
    band: np.ndarray, step: int, min_run: int, max_bridge: float
) -> List[Polyline]:
    """Chain a band's scan-row runs into long vertical serpentine ribbons.

    Classic boustrophedon cell-decomposition: scan the band at ``step``-spaced
    rows, then walk each unused run DOWNWARD, attaching the run in the next row
    whose x-interval overlaps (or is within ``max_bridge`` px of) the current
    one. Each such vertical strip becomes ONE continuous polyline whose runs
    alternate direction (entering from the side nearest the previous exit), so
    the pen sweeps down the shape with only gentle end-of-row reversals rather
    than one isolated stroke per run. Fewer strokes + fewer reversals is exactly
    what survives the knobs' backlash on the physical device.

    Deterministic: rows scanned top-to-bottom, runs left-to-right, continuation
    ties broken by (largest overlap, then leftmost run), so identical input
    yields identical ribbons.
    """
    h = band.shape[0]
    ys = list(range(0, h, step))
    rows: List[List[Tuple[int, int]]] = [_scanline_runs(band[y], min_run) for y in ys]
    used: List[List[bool]] = [[False] * len(r) for r in rows]

    ribbons: List[Polyline] = []
    for r0 in range(len(rows)):
        for i0 in range(len(rows[r0])):
            if used[r0][i0]:
                continue
            # Walk one vertical strip downward, run by run.
            chain: List[Tuple[int, int, int]] = []  # (row_index, x0, x1)
            r, i = r0, i0
            while True:
                used[r][i] = True
                cx0, cx1 = rows[r][i]
                chain.append((r, cx0, cx1))
                if r + 1 >= len(rows):
                    break
                best_key: Optional[Tuple[int, int]] = None
                best_j = -1
                for j, (nx0, nx1) in enumerate(rows[r + 1]):
                    if used[r + 1][j]:
                        continue
                    overlap = min(cx1, nx1) - max(cx0, nx0)  # >=0 means touching
                    if overlap >= -max_bridge:
                        key = (-overlap, nx0)  # most overlap first, then leftmost
                        if best_key is None or key < best_key:
                            best_key, best_j = key, j
                if best_j < 0:
                    break
                r, i = r + 1, best_j

            # Emit the strip as a serpentine ribbon: orient each run so its entry
            # is the endpoint nearest the previous run's exit.
            poly: Polyline = []
            prev_exit_x: Optional[int] = None
            for (rr, x0, x1) in chain:
                y = ys[rr]
                if prev_exit_x is None or abs(x0 - prev_exit_x) <= abs(x1 - prev_exit_x):
                    a, b = x0, x1
                else:
                    a, b = x1, x0
                poly.append([int(a), int(y)])
                poly.append([int(b), int(y)])
                prev_exit_x = b
            if len(poly) >= 2:
                ribbons.append(poly)
    return ribbons


def hatch_fill(
    gray: np.ndarray,
    params: VectorizeParams,
    foreground: Optional[np.ndarray] = None,
) -> List[Polyline]:
    """Tonal serpentine fill: dense lines where dark, blank where light.

    The fillable region is everything darker than ``white_threshold`` (pixels
    >= that value are highlights and are never touched). The fillable range is
    posterized into ``tone_bands`` nested dark masks (darkest first) via
    :func:`posterize_to_tone_bands`. For band ``k`` (0 = darkest) the scan-row
    spacing is::

        spacing_k = run_spacing * (tone_bands / (k + 1))

    so the DARKEST band gets the TIGHTEST spacing (densest lines) and lighter
    bands are progressively sparser — line density therefore tracks local
    darkness, which is the tonal illusion.

    Each band is swept with horizontal scan rows at its spacing. On every row
    the contiguous runs where the mask is set become individual horizontal
    polyline segments (``x_start..x_end`` at that ``y``). Row direction
    alternates (left→right, then right→left) so consecutive runs chain into a
    boustrophedon that minimizes pen travel; each run is still emitted as a
    separate polyline so the downstream ``merge_endpoints`` /
    ``order_nearest_neighbor`` passes can stitch and order them. Runs are not
    joined across gaps.

    Only horizontal scanning (``hatch_angle == 0``) is implemented; a non-zero
    ``hatch_angle`` is reserved for future work and is treated as horizontal.

    Deterministic: fixed band order, fixed row order, no randomness.
    """
    h, w = gray.shape[:2]
    if w < 2 or h < 2:
        return []

    # Foreground gate: an explicit subject mask (from GrabCut isolation) when
    # supplied; otherwise exclude a confident uniform backdrop (light OR dark
    # studio background) so the fill shades the SUBJECT rather than flooding the
    # surround; otherwise the whole frame (behaviour unchanged for plain images).
    if foreground is None:
        background = detect_background_mask(gray)
        foreground = (
            ~background
            if background is not None
            else np.ones(gray.shape[:2], dtype=bool)
        )
    if not np.any(foreground):
        return []

    # Adaptive fill cutoff measured over the FOREGROUND only (so a dark or bright
    # backdrop can't skew the subject's tonal cutoff), then coverage-capped so the
    # fill can never saturate into a solid blob (see HATCH_MAX_COVERAGE).
    requested = int(max(0, min(255, params.white_threshold)))
    white = coverage_capped_threshold(gray[foreground], requested)
    # Fillable: strictly darker than the (capped) cutoff AND inside the subject.
    fillable = (gray < white) & foreground
    if not np.any(fillable):
        return []

    bands = max(1, int(params.tone_bands))
    base_spacing = max(1.0, float(params.run_spacing))
    # Minimum run width (px) — drop sub-pixel speckle that reads as noise.
    min_run = 3

    # Nested dark masks (darkest first). The band range CEILING is the white
    # threshold (or the explicit ``threshold`` when the user set one), not the
    # Otsu split — otherwise the lightest band stops at Otsu's mid-gray and
    # mid-tone facial shadows between Otsu and ``white_threshold`` would never
    # be filled (the "too much face left blank" defect). Using ``white`` as the
    # ceiling makes ``white_threshold`` the genuine fill-coverage lever: the
    # lightest band reaches exactly the fillable cutoff. Every band is still
    # intersected with ``fillable`` so highlights past the threshold stay blank.
    band_ceiling = int(params.threshold) if (params.threshold and params.threshold > 0) else white
    masks = posterize_to_tone_bands(gray, bands, band_ceiling)

    polylines: List[Polyline] = []
    for k, mask in enumerate(masks):
        if mask is None:
            continue
        band = (mask > 0) & fillable
        if not np.any(band):
            continue
        spacing = base_spacing * (bands / float(k + 1))
        step = max(1, int(round(spacing)))

        # Largest horizontal gap we bridge with a pen-down connector between one
        # scan row's run and the next (see HATCH_RIBBON_BRIDGE_FACTOR).
        max_bridge = HATCH_RIBBON_BRIDGE_FACTOR * float(step)

        # Chain this band's runs into long vertical serpentine ribbons rather
        # than emitting one polyline per run. Long ribbons mean few direction
        # reversals, which is what survives the knobs' backlash on the device.
        polylines.extend(_serpentine_ribbons(band, step, min_run, max_bridge))

    return polylines


# Fraction of the row pitch used as the MAXIMUM half-amplitude of a fully-dark
# wave. Kept BELOW 0.5 so even a black region's wave stays inside its own lane
# and never merges with the neighbouring row — that separation is what keeps the
# lines distinct on the physical device. (The earlier 0.9 let dark waves overlap
# into a solid black smear, which is exactly what blobbed on the machine.)
WAVE_MAX_AMPLITUDE_FRAC = 0.4

# Wavelength of the horizontal wiggle as a MULTIPLE of the row pitch. ~4x makes
# each wave a long, gentle undulation rather than a tight squiggle — the smooth
# horizontal-line look of the reference. CRITICAL for the machine: the knobs'
# backlash cannot reproduce high-frequency wiggles (wavelength ~ pitch), so they
# smeared into a dark blob; a long wavelength is a slow, faithfully-drawn line.
WAVE_WAVELENGTH_FRAC = 3.5

# Darkness floor (0..1). Pixels lighter than this break the line, so light areas
# keep real WHITE GAPS (the tone you read as "lighter") and the background stays
# blank. Raised so mid-light skin/areas drop out instead of every row being inked
# — sparser output that both matches the reference and survives the machine's
# tendency to thicken every line.
WAVE_DARK_FLOOR = 0.26

# Wave FEATURE pass: clean edge strokes (eyes, lip line, nostrils, jaw, neck)
# drawn over the tonal waves so features read as DEFINITION instead of melting
# into solid tonal bands (the "dark eyes look like sunglasses" defect). Only
# edges at least this fraction of the larger image dimension survive, so the
# pass keeps the few strong, recognisable feature curves and drops the speckle
# that made the old serpentine feature pass look chaotic.
WAVE_FEATURE_MIN_LEN_FRAC = 0.05
# approxPolyDP epsilon (px) for feature strokes — small, to keep curves smooth.
WAVE_FEATURE_EPSILON = 2.0
# Gaussian sigma applied BEFORE the feature-pass Canny. The tonal fill wants the
# detail-boosted (CLAHE) gray, but running Canny on it turns fine texture — beard
# stubble, gear teeth, fabric weave — into a mass of tiny tangled edges. Blurring
# first removes that high-frequency texture while the structural edges (eye
# outlines, jaw, gear rim, hat brim, mask seams) survive, so the feature pass
# stays a clean line drawing instead of a scribble.
WAVE_FEATURE_PRE_BLUR = 2.0


def wave_scanline_fill(
    gray: np.ndarray,
    params: VectorizeParams,
    foreground: Optional[np.ndarray] = None,
    waveform: str = "sine",
) -> List[Polyline]:
    """Engineezy-style continuous horizontal scanlines, modulated by tone.

    ``waveform`` selects the per-row oscillation: ``"sine"`` (smooth waves) or
    ``"triangle"`` (straight zig-zag — back-and-forth diagonals, which the
    machine draws faithfully at constant velocity and which survives backlash
    better than curves).

    Instead of inking only dark *runs* (the serpentine :func:`hatch_fill`), this
    sweeps the subject with evenly-spaced horizontal rows and draws each row as
    ONE continuous wavy line whose vertical amplitude grows with local darkness:
    black areas oscillate hard (reading as a near-filled dark band), light areas
    stay nearly flat (reading light), highlights/background drop out to blank.

    Because each row is a single long stroke (chained boustrophedon by the
    downstream ordering), the path has very few direction reversals — it is
    FAST and survives backlash — while the amplitude modulation carries true
    tonal DETAIL, which is the look the reference portrait has.

    Subject gating: a confident uniform background (see
    :func:`detect_background_mask`) is excluded so the surround stays blank; the
    per-row darkness is then taken from the image directly. Pixels below
    :data:`WAVE_DARK_FLOOR` darkness (bright highlights / blank) break the line
    so they are left white rather than covered in flat rules.

    Deterministic: fixed row/column iteration, no randomness.
    """
    h, w = gray.shape[:2]
    if w < 2 or h < 2:
        return []

    pitch = max(2, int(round(max(1.0, float(params.run_spacing)))))
    amp = WAVE_MAX_AMPLITUDE_FRAC * pitch
    wavelength = max(2.0, WAVE_WAVELENGTH_FRAC * pitch)

    # Foreground gate: an explicit subject mask (from GrabCut isolation) when
    # supplied, else a confident uniform background is excluded, else whole frame.
    if foreground is None:
        background = detect_background_mask(gray)
        foreground = (
            ~background if background is not None else np.ones((h, w), dtype=bool)
        )
    if not np.any(foreground):
        return []

    # Darkness in 0..1 (0 = white, 1 = black).
    dark = (255.0 - gray.astype(np.float32)) / 255.0
    two_pi = 2.0 * math.pi

    polylines: List[Polyline] = []
    flip = False
    for y0 in range(pitch // 2 + 1, h, pitch):
        xs = range(w - 1, -1, -1) if flip else range(0, w)
        current: Polyline = []
        for x in xs:
            d = float(dark[y0, x])
            if not foreground[y0, x] or d < WAVE_DARK_FLOOR:
                if len(current) >= 2:
                    polylines.append(current)
                current = []
                continue
            # Amplitude scales with darkness; phase tracks absolute x so adjacent
            # rows stay vertically aligned (the woven look).
            if waveform == "triangle":
                frac = (x / wavelength) % 1.0
                osc = 1.0 - 4.0 * abs(frac - 0.5)  # -1..1 straight zig-zag
            else:
                osc = math.sin(two_pi * x / wavelength)
            yy = y0 + amp * d * osc
            yi = int(round(min(h - 1, max(0, yy))))
            current.append([int(x), yi])
        if len(current) >= 2:
            polylines.append(current)
        flip = not flip

    return polylines


# De-speckle kernel for the vstep fill's tone-band masks, as a FRACTION of the
# image's larger dimension. Before a band is rastered into scan runs, a
# morphological OPEN with this kernel erases isolated dark specks — the sparse,
# high-frequency noise that a bright / low-contrast region (a lit cheek, studio
# grain, stubble) posterizes into, especially after the local-contrast boost.
# Solid shaded regions are larger than the kernel and survive intact, so tonal
# MODELING is preserved while the speckle the machine thickens into isolated
# noise blobs is removed. ~0.008 == 5 px on a 600-px image. 0 disables.
VSTEP_DESPECKLE_FRAC = 0.008

# Minimum retained fill-ribbon length as a FRACTION of the image's larger
# dimension. After row chaining a genuinely-shaded blob is ONE long serpentine
# ribbon; an orphan run that never chained (a stray dark fleck in a light
# region) is a tiny 2-point stub. Ribbons shorter than this are dropped so the
# fill carries only coherent tone, not scattered dashes. ~0.03 == 18 px on a
# 600-px image. 0 disables.
VSTEP_MIN_RUN_LEN_FRAC = 0.03


# Focal dark blob rescue: the de-speckle OPEN + orphan-stub filter cannot tell
# a noise fleck from an EYE — both are small dark blobs, and on a portrait the
# eyes / nostrils / lip line are exactly de-speckle-kernel-sized, so the crisp
# fill erased them and faces came out blank. A blob is FOCAL (worth keeping)
# when it is dark RELATIVE TO ITS LOCAL SURROUNDINGS — an eye is a hard dark
# spot on bright skin, while posterize static sits in a region that is murky
# overall. Focal pixels are restored after de-speckle and their ribbons are
# exempt from the orphan-stub filter.
#
# Window (fraction of the larger dim) for the local-mean the salience is
# measured against — comfortably larger than an eye so the blob does not
# dominate its own neighborhood average.
FOCAL_LOCAL_MEAN_FRAC = 0.05
# How many gray levels darker than the local mean a pixel must be to count as
# salient. High enough that soft shading gradients do not qualify.
FOCAL_SALIENCE_LEVELS = 30.0
# Focal blob size gates as a fraction of the larger dimension (bbox diagonal).
# The floor is what separates an eye from a noise fleck — both are small dark
# salient blobs, so SIZE is the only honest gate: a lone posterize speck is
# ~1-2% of the image, while an eye merges with its brow / socket shadow into a
# salient component several times that. The ceiling only guards against huge
# diffuse salient regions (texture fields) — it must stay comfortably above
# feature scale, because an eye-plus-brow or a wide-but-thin lip line lands
# around 0.1-0.2 of the image dimension.
FOCAL_MIN_DIAG_FRAC = 0.025
FOCAL_MAX_DIAG_FRAC = 0.25


def _focal_dark_blob_mask(
    gray: np.ndarray, foreground: np.ndarray, longest: float
) -> np.ndarray:
    """Mask of small, locally-salient dark blobs (eyes / nostrils / lip line).

    Salience is ``local_mean - gray >= FOCAL_SALIENCE_LEVELS`` within the
    foreground; connected components are then gated to the
    ``FOCAL_MIN_DIAG_FRAC``..``FOCAL_MAX_DIAG_FRAC`` bbox-diagonal range so
    speckle stays dropped and large shaded masses stay untouched.
    Deterministic; returns an all-False mask when nothing qualifies.
    """
    k = max(3, int(round(FOCAL_LOCAL_MEAN_FRAC * longest)))
    if k % 2 == 0:
        k += 1
    local_mean = cv2.blur(gray.astype(np.float32), (k, k))
    salient = (local_mean - gray.astype(np.float32)) >= FOCAL_SALIENCE_LEVELS
    salient &= foreground

    focal = np.zeros(gray.shape[:2], dtype=bool)
    if not np.any(salient):
        return focal
    n, labels, stats, _ = cv2.connectedComponentsWithStats(
        salient.astype(np.uint8), connectivity=8
    )
    min_diag = FOCAL_MIN_DIAG_FRAC * longest
    max_diag = FOCAL_MAX_DIAG_FRAC * longest
    for lbl in range(1, n):
        bw = float(stats[lbl, cv2.CC_STAT_WIDTH])
        bh = float(stats[lbl, cv2.CC_STAT_HEIGHT])
        diag = float(np.hypot(bw, bh))
        if min_diag <= diag <= max_diag:
            focal |= labels == lbl
    return focal


def _despeckle_mask(band: np.ndarray, frac: float, longest: float) -> np.ndarray:
    """Morphological OPEN a boolean band mask to drop specks below ``frac`` size.

    The kernel side is ``frac * longest`` (the image's larger dimension), forced
    odd and floored at 3 px so it is always a valid centered structuring element.
    Returns the opened mask as a boolean array; ``frac <= 0`` is a no-op.
    """
    if frac <= 0:
        return band
    k = max(3, int(round(frac * longest)))
    if k % 2 == 0:
        k += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    opened = cv2.morphologyEx(band.astype(np.uint8), cv2.MORPH_OPEN, kernel)
    return opened > 0


def vstep_serpentine_fill(
    gray: np.ndarray,
    params: VectorizeParams,
    foreground: Optional[np.ndarray] = None,
) -> List[Polyline]:
    """Vertical-step boustrophedon raster fill — DISCRETE connectors.

    Chains horizontal scan runs into a continuous raster, but the move between
    rows is a short VERTICAL step at the run end (then a brief horizontal entry
    that stays inside the next run) rather than a long diagonal jump. So the
    connectors read as part of the raster — discreet on the no-pen-lift machine —
    instead of slashing across the fill (the original serpentine's diagonals) or
    being left as many exposed inter-stroke hops (one-segment-per-run). It also
    roughly halves the stroke count, which further cuts the planner's connectors.

    Density tracks darkness via the nested tone bands (darker pixels are covered
    by more bands). A new ribbon starts whenever the next row has no run that
    overlaps the current one (a genuine gap). Deterministic.
    """
    h, w = gray.shape[:2]
    if w < 2 or h < 2:
        return []
    if foreground is None:
        background = detect_background_mask(gray)
        foreground = (
            ~background if background is not None else np.ones((h, w), dtype=bool)
        )
    if not np.any(foreground):
        return []

    requested = int(max(0, min(255, params.white_threshold)))
    white = coverage_capped_threshold(gray[foreground], requested)
    band_ceiling = (
        int(params.threshold) if (params.threshold and params.threshold > 0) else white
    )
    bands = max(1, int(params.tone_bands))
    masks = posterize_to_tone_bands(gray, bands, band_ceiling)
    base_spacing = max(1.0, float(params.run_spacing))
    min_run = 3
    longest = float(max(w, h, 1))

    # Small locally-salient dark blobs (eyes / nostrils / lip line) that the
    # de-speckle + orphan filters would otherwise erase as noise.
    focal = _focal_dark_blob_mask(gray, foreground, longest)

    polylines: List[Polyline] = []
    for k, mask in enumerate(masks):
        if mask is None:
            continue
        band = (mask > 0) & foreground
        # De-speckle: erase isolated dark flecks so a bright / noisy region does
        # not raster into scattered stub runs (the "static" that survives as
        # machine noise); solid shaded regions are larger than the kernel and
        # stay intact, preserving tonal modeling. Focal blobs are restored —
        # an eye is the same size as a speck, but it is salient against its
        # surroundings and the face is unreadable without it.
        raw_band = band
        band = _despeckle_mask(band, VSTEP_DESPECKLE_FRAC, longest)
        band |= raw_band & focal
        if not np.any(band):
            continue
        step = max(1, int(round(base_spacing * (bands / float(k + 1)))))
        ys = list(range(0, h, step))
        rows = [_scanline_runs(band[y], min_run) for y in ys]
        used = [[False] * len(r) for r in rows]

        for r0 in range(len(rows)):
            for i0 in range(len(rows[r0])):
                if used[r0][i0]:
                    continue
                poly: Polyline = []
                r, i = r0, i0
                prev_exit: Optional[int] = None
                cur_lo = cur_hi = 0
                while True:
                    used[r][i] = True
                    x0, x1 = rows[r][i]
                    y = ys[r]
                    if prev_exit is None:
                        poly.append([int(x0), int(y)])
                        poly.append([int(x1), int(y)])
                        prev_exit = x1
                    else:
                        # Enter at the point of this run nearest the previous
                        # exit; the connector is a vertical step then a short
                        # in-run horizontal entry (no diagonal jump).
                        ent = min(max(prev_exit, x0), x1)
                        far = x1 if (ent - x0) <= (x1 - ent) else x0
                        poly.append([int(prev_exit), int(y)])  # vertical step
                        poly.append([int(ent), int(y)])  # short horizontal entry
                        poly.append([int(far), int(y)])
                        prev_exit = far
                    cur_lo, cur_hi = min(x0, x1), max(x0, x1)

                    if r + 1 >= len(rows):
                        break
                    best_j, best_ov = -1, -1
                    for j, (nx0, nx1) in enumerate(rows[r + 1]):
                        if used[r + 1][j]:
                            continue
                        ov = min(cur_hi, nx1) - max(cur_lo, nx0)
                        if ov >= 0 and ov > best_ov:
                            best_ov, best_j = ov, j
                    if best_j < 0:
                        break
                    r, i = r + 1, best_j

                if len(poly) >= 2:
                    polylines.append(poly)

    # Drop orphan stub ribbons: a coherent shaded blob chains into one long
    # serpentine, so anything shorter than VSTEP_MIN_RUN_LEN_FRAC of the larger
    # dimension is a stray fleck the fill is better off without. Ribbons that
    # touch a focal blob are exempt — an eye's fill IS a short ribbon.
    min_ribbon_len = VSTEP_MIN_RUN_LEN_FRAC * longest
    if min_ribbon_len > 0:
        polylines = [
            poly
            for poly in polylines
            if _polyline_length(poly) >= min_ribbon_len
            or _polyline_touches_mask(poly, focal)
        ]
    return polylines


def _polyline_touches_mask(poly: Polyline, mask: np.ndarray) -> bool:
    """True when any vertex of ``poly`` lies on a True pixel of ``mask``."""
    if not np.any(mask):
        return False
    h, w = mask.shape[:2]
    for x, y in poly:
        xi, yi = int(x), int(y)
        if 0 <= xi < w and 0 <= yi < h and mask[yi, xi]:
            return True
    return False


def mask_perimeter(
    foreground: Optional[np.ndarray], epsilon: float = WAVE_FEATURE_EPSILON
) -> List[Polyline]:
    """Trace a clean closed PERIMETER outline around the subject mask.

    For the zig-zag "outline + fill" look: the external contour(s) of the
    subject foreground become smooth closed polylines that frame the fill. Tiny
    fragments (< 1% of the mask's bbox diagonal) are dropped as noise. Returns
    an empty list when there is no mask. Deterministic.
    """
    if foreground is None or not np.any(foreground):
        return []
    m = foreground.astype(np.uint8) * 255
    # Smooth the silhouette so the perimeter is a clean, intentional outline
    # rather than the pixel-ragged GrabCut mask edge: close small notches, blur,
    # re-threshold.
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m = cv2.GaussianBlur(m, (0, 0), 2.0)
    m = (m > 127).astype(np.uint8) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return []
    h, w = foreground.shape[:2]
    min_len = 0.05 * float(max(w, h))
    polylines: List[Polyline] = []
    for c in contours:
        if len(c) < 4:
            continue
        chain = [(int(p[0][0]), int(p[0][1])) for p in c]
        poly = _approx_poly_dp(chain, epsilon, closed=True)
        if _polyline_length(poly) >= min_len:
            polylines.append(poly)
    return polylines


def wave_feature_paths(
    gray: np.ndarray,
    foreground: Optional[np.ndarray],
    image_size: Tuple[int, int],
) -> List[Polyline]:
    """Clean feature-edge strokes to DEFINE eyes / lips / nostrils / jaw / neck.

    The tonal wave fill alone melts dark, low-contrast features into solid bands
    (dark eye sockets + brows read as "sunglasses"; the lip line and jaw/neck
    boundary vanish). This pass runs Canny within the subject, traces the edge
    contours, smooths them (``WAVE_FEATURE_EPSILON``) and keeps only those at
    least ``WAVE_FEATURE_MIN_LEN_FRAC`` of the larger dimension — so the few
    strong, recognisable feature curves survive while speckle is dropped. Drawn
    over the waves, these give the portrait its definition.

    Auto Canny thresholds are derived from the foreground median (the standard
    0.66x / 1.33x band), so exposure does not need hand-tuning. Restricting the
    edges to ``foreground`` keeps background clutter out. Deterministic.
    """
    img_w, img_h = image_size
    if img_w < 2 or img_h < 2:
        return []
    fg = foreground if foreground is not None else np.ones(gray.shape[:2], dtype=bool)
    if not np.any(fg):
        return []

    # Denoise before edge detection so fine texture (stubble, gear teeth, weave)
    # does not become a tangle of tiny edges; structural edges survive.
    feat_gray = (
        cv2.GaussianBlur(gray, (0, 0), WAVE_FEATURE_PRE_BLUR)
        if WAVE_FEATURE_PRE_BLUR > 0
        else gray
    )
    median = float(np.median(feat_gray[fg]))
    lo = int(max(0.0, 0.66 * median))
    hi = int(min(255.0, 1.33 * median))
    edges = cv2.Canny(feat_gray, lo, hi)
    edges = cv2.bitwise_and(edges, edges, mask=fg.astype(np.uint8))
    # Close 1-px gaps so a feature outline traces as one continuous contour.
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    min_len = WAVE_FEATURE_MIN_LEN_FRAC * float(max(img_w, img_h, 1))
    polylines: List[Polyline] = []
    for c in contours:
        if len(c) < 2:
            continue
        chain = [(int(p[0][0]), int(p[0][1])) for p in c]
        poly = _approx_poly_dp(chain, WAVE_FEATURE_EPSILON, closed=False)
        if _polyline_length(poly) >= min_len:
            polylines.append(poly)
    return polylines


def _dark_feature_detail_paths(
    gray: np.ndarray,
    epsilon: float,
    image_size: Tuple[int, int],
) -> List[Polyline]:
    """Capture small, very-dark features (eyes / brows / nostrils / lip line).

    The primary feature contributions gate on ``HATCH_FEATURE_MIN_LEN_FRAC``
    (~3% of the larger dim), which is larger than a portrait's eyes / nostrils
    — so those features get dropped and the face reads as a blank silhouette.
    This sub-pass isolates ONLY the darkest pixels and keeps their small,
    bounded contours so the features survive as crisp strokes.

    Steps (deterministic):

    1. Threshold the gray at a LOW absolute cutoff —
       ``min(HATCH_DETAIL_MAX_VALUE, otsu * 0.45)`` — so only the very darkest
       features (pupils, eye sockets, nostrils, lip line, deep shadow) pass.
    2. ``cv2.findContours(RETR_CCOMP, CHAIN_APPROX_NONE)`` on that dark mask,
       simplified with the small clamped feature epsilon.
    3. Keep a contour only when its bounding-box diagonal is at least
       ``HATCH_DETAIL_MIN_LEN_FRAC`` of the larger dim (so eyes survive but
       sub-pixel speckle is dropped) AND its bbox does NOT exceed
       ``HATCH_DETAIL_MAX_BBOX_FRAC`` of either axis (those large blobs are the
       hair / hat / shadow masses already drawn by the fill + other passes —
       skipping them avoids doubling).

    Yields small closed loops around eyes / nostrils and short strokes for
    brows / lip line. No randomness; fixed contour iteration order.
    """
    img_w, img_h = image_size
    if img_w < 2 or img_h < 2:
        return []

    # Otsu split (purely to adapt the cutoff downward on already-dark images).
    otsu, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    cutoff = min(float(HATCH_DETAIL_MAX_VALUE), float(otsu) * 0.45)
    cutoff = max(1.0, cutoff)

    dark_mask = (gray < cutoff).astype(np.uint8) * 255
    if not np.any(dark_mask):
        return []

    longest = float(max(img_w, img_h, 1))
    min_diag = HATCH_DETAIL_MIN_LEN_FRAC * longest
    max_bw = HATCH_DETAIL_MAX_BBOX_FRAC * float(img_w)
    max_bh = HATCH_DETAIL_MAX_BBOX_FRAC * float(img_h)

    polylines: List[Polyline] = []
    contours, _ = cv2.findContours(
        dark_mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE
    )
    for c in contours:
        if len(c) < 2:
            continue
        bx, by, bw, bh = cv2.boundingRect(c)
        diag = float(np.hypot(bw, bh))
        # Too small -> speckle/noise; too large -> a mass already drawn.
        if diag < min_diag:
            continue
        if bw > max_bw or bh > max_bh:
            continue
        chain = [(int(p[0][0]), int(p[0][1])) for p in c]
        poly = _approx_poly_dp(chain, epsilon, closed=True)
        if len(poly) >= 2:
            polylines.append(poly)
    return polylines


def hatch_feature_paths(
    gray: np.ndarray,
    params: VectorizeParams,
    epsilon: float,
    min_stroke_len: float,
    image_size: Tuple[int, int] | None = None,
) -> List[Polyline]:
    """Clean single-stroke FEATURE pass for hatch mode (centerlines + outline).

    Replaces the old Canny-edge pass, whose Canny -> findContours -> approxPolyDP
    chain produced jagged triangular shards and double-walled noise around the
    face, neck, and shirt. The reference (Engineezy) feature lines are single
    confident *centerlines*, not edge loops, so this pass produces exactly that:

    1. **Feature strokes via skeleton centerlines.** Reuses
       :func:`posterize_to_tone_bands` + :func:`skeletonize_regions` on the
       DARKEST 1-2 tone bands only (eyebrows, hair clumps, gear spokes, jaw
       shadow) — the same machinery the ``skeleton`` mode uses, which yields one
       smooth centerline per dark feature instead of an edge loop around it.
    2. **Smooth subject outline.** Adds the outer silhouette via
       :func:`_silhouette_contours` on the FULL dark mask (the lightest / last
       posterize band = the whole dark region), keeping the existing 95%-bbox
       border-rectangle filter so a page frame is never drawn.
    3. **Dark-feature detail strokes.** Adds small, very-dark features (eyes,
       eyebrows, nostrils, lip line) via :func:`_dark_feature_detail_paths`,
       which thresholds at a low absolute value and keeps only small, bounded
       contours. Without this the face reads as a blank silhouette because
       those features fall under the ~3% min-length floor of passes 1-2.

    Smoothness (Defect 1 fix): the approxPolyDP epsilon is CLAMPED to at most
    :data:`HATCH_FEATURE_EPSILON_MAX` (~3 px). The global detail->epsilon map
    (~12.75 px at detail=0.5) is what collapsed smooth curves into angular
    polygons; the clamp keeps eyebrows / jaw / gear / outline curved no matter
    where the detail slider sits.

    Shard kill: every retained feature stroke must be at least
    :data:`HATCH_FEATURE_MIN_LEN_FRAC` of the image's larger dimension (~3%),
    so speckle / triangle noise around the shirt and neck disappears.

    Deterministic: fixed band order, deterministic skeleton walk + contour
    trace, no randomness.
    """
    h, w = gray.shape[:2]
    if w < 2 or h < 2:
        return []

    img_w, img_h = (image_size if image_size else (w, h))

    # Clamp epsilon so feature curves stay smooth regardless of the detail
    # slider (the jaggedness came from epsilon ~12 px at detail 0.5).
    feat_eps = min(float(epsilon), HATCH_FEATURE_EPSILON_MAX)

    # Drop tiny shards: require ~3% of the larger dimension of stroke length.
    longest = float(max(img_w, img_h, 1))
    feat_min_len = max(float(min_stroke_len), HATCH_FEATURE_MIN_LEN_FRAC * longest)

    bands = posterize_to_tone_bands(gray, params.tone_bands, params.threshold)
    if not bands:
        return []

    polylines: List[Polyline] = []

    # 1) Centerlines on the DARKEST 1-2 bands only. When there are multiple
    # bands, reserve the full last band for the outline below and skeletonize
    # at most the darkest two of the remaining bands; with a single band there
    # is only the full dark region, so skeletonize that.
    if len(bands) == 1:
        dark_bands = bands[:1]
    else:
        dark_bands = bands[: min(2, len(bands) - 1)]
    polylines.extend(skeletonize_regions(dark_bands, feat_eps, feat_min_len))

    # 2) Smooth subject outline from the FULL dark region (last band), with the
    # small clamped epsilon so the silhouette stays a smooth curve rather than
    # an angular polygon. The 95%-bbox border filter lives in
    # _silhouette_contours and is preserved via image_size.
    full_dark = bands[-1]
    polylines.extend(
        _silhouette_contours([full_dark], feat_eps, feat_min_len, image_size=(img_w, img_h))
    )

    # 3) Dark-feature detail strokes (eyes / eyebrows / nostrils / lip line).
    # These small, very-dark features fall under the ~3% min-length floor of the
    # two passes above, so they would otherwise vanish into a blank-faced
    # silhouette. The detail pass isolates only the darkest pixels and keeps
    # their small, bounded contours. It runs on a much darker threshold than the
    # band skeleton (limited overlap), and downstream merge_endpoints stitches
    # any near-coincident endpoints, so no extra dedup is needed here.
    polylines.extend(
        _dark_feature_detail_paths(gray, feat_eps, image_size=(img_w, img_h))
    )

    return polylines


# ---------------------------------------------------------------------------
# Endpoint splicing — kill visible disconnects between near-touching polylines.
# ---------------------------------------------------------------------------
def merge_endpoints(polys: Sequence[Polyline], snap_radius: float = 3.0) -> List[Polyline]:
    """Splice polylines whose endpoints are within ``snap_radius`` pixels.

    `findContours` on a posterized mask, plus skeleton walking, both produce
    polylines that almost meet but stop a pixel or two short — visible on
    screen as "disconnects" and paid for by the planner as connector segments
    between them. This pass greedily concatenates polylines whose head/tail
    endpoints are within ``snap_radius`` of another polyline's head/tail,
    flipping orientation as needed so the chain remains a single ordered run.

    Closed contours (head == tail within the snap radius) are NOT merged with
    others through that endpoint, since their two endpoints already coincide.

    Pure; input is not mutated. Deterministic: scans by ascending input index.
    """
    if not polys:
        return []
    chains: List[List[List[int]]] = [[list(p) for p in poly] for poly in polys]
    r2 = float(snap_radius) * float(snap_radius)

    def near(a: Sequence[float], b: Sequence[float]) -> bool:
        dx = float(a[0]) - float(b[0])
        dy = float(a[1]) - float(b[1])
        return dx * dx + dy * dy <= r2

    # Repeatedly find a mergeable pair and splice them. Bounded by len(chains).
    changed = True
    while changed:
        changed = False
        n = len(chains)
        for i in range(n):
            ci = chains[i]
            if len(ci) < 2:
                continue
            i_head, i_tail = ci[0], ci[-1]
            i_closed = near(i_head, i_tail)
            best_j = -1
            best_op = ""
            for j in range(i + 1, n):
                cj = chains[j]
                if len(cj) < 2:
                    continue
                j_head, j_tail = cj[0], cj[-1]
                j_closed = near(j_head, j_tail)
                if i_closed or j_closed:
                    continue
                if near(i_tail, j_head):
                    best_j, best_op = j, "tail-head"
                    break
                if near(i_tail, j_tail):
                    best_j, best_op = j, "tail-tail"
                    break
                if near(i_head, j_head):
                    best_j, best_op = j, "head-head"
                    break
                if near(i_head, j_tail):
                    best_j, best_op = j, "head-tail"
                    break
            if best_j == -1:
                continue
            cj = chains[best_j]
            if best_op == "tail-head":
                merged = ci + cj[1:]
            elif best_op == "tail-tail":
                merged = ci + list(reversed(cj))[1:]
            elif best_op == "head-head":
                merged = list(reversed(ci)) + cj[1:]
            else:  # head-tail
                merged = cj + ci[1:]
            chains[i] = merged
            del chains[best_j]
            changed = True
            break

    return [list(c) for c in chains if len(c) >= 2]


# ---------------------------------------------------------------------------
# Nearest-neighbor ordering (mirrors web/src/path/nn_order.ts semantics).
# ---------------------------------------------------------------------------
def order_nearest_neighbor(polys: Sequence[Polyline], start: Tuple[float, float] = (0.0, 0.0)) -> List[Polyline]:
    """Greedily order polylines by nearest endpoint, flipping when the tail is nearer.

    Mirrors ``orderPolylinesNearestNeighbor`` in ``web/src/path/nn_order.ts``:
    starting from ``start``, repeatedly pick the unused polyline whose nearest
    endpoint (head or tail) is closest to the cursor, orient it so that
    endpoint is first (reversing when the tail is nearer), then advance the
    cursor to its far endpoint. Ties are broken by earlier index, then forward
    orientation before reversed (strict-less comparison), so the result is a
    pure function of the inputs and ``start``. Input polylines are not mutated.
    """
    usable: List[Polyline] = [list(p) for p in polys if len(p) >= 1]
    if not usable:
        return []

    used = [False] * len(usable)
    ordered: List[Polyline] = []
    cx, cy = float(start[0]), float(start[1])

    def dist_sq(ax: float, ay: float, bx: float, by: float) -> float:
        dx = ax - bx
        dy = ay - by
        return dx * dx + dy * dy

    for _ in range(len(usable)):
        best_idx = -1
        best_reversed = False
        best = float("inf")
        for i, poly in enumerate(usable):
            if used[i]:
                continue
            head = poly[0]
            tail = poly[-1]
            d_head = dist_sq(cx, cy, head[0], head[1])
            if d_head < best:  # strict-less keeps earliest index / forward
                best = d_head
                best_idx = i
                best_reversed = False
            d_tail = dist_sq(cx, cy, tail[0], tail[1])
            if d_tail < best:
                best = d_tail
                best_idx = i
                best_reversed = True

        used[best_idx] = True
        chosen = usable[best_idx]
        oriented = list(reversed(chosen)) if best_reversed else chosen
        ordered.append(oriented)
        cx, cy = oriented[-1][0], oriented[-1][1]

    return ordered


# ---------------------------------------------------------------------------
# 2-opt connector-travel reduction (mirrors web/src/path/nn_order.ts).
# ---------------------------------------------------------------------------
# Hard cap on 2-opt passes. Each pass is O(n^2) endpoint comparisons, so the
# whole refinement is bounded by MAX_2OPT_PASSES * n^2. For the hatch fill's
# worst case (~1000 strokes) that is at most 8 * 1000^2 / 2 ~= 4M cheap integer
# comparisons — well under a second. A pass with no improvement breaks early.
MAX_2OPT_PASSES = 8


def _chebyshev(ax: float, ay: float, bx: float, by: float) -> float:
    """Chebyshev (max-axis) distance — the machine's real per-move step count."""
    return max(abs(ax - bx), abs(ay - by))


def total_connector_travel_chebyshev(
    ordered: Sequence[Polyline], start: Tuple[float, float] = (0.0, 0.0)
) -> float:
    """Total pen-up connector travel in the machine's Chebyshev step metric.

    Sums the hop from ``start`` to the first stroke's entry endpoint plus every
    ``exit -> next-entry`` gap between consecutive strokes. The return-to-home
    hop is NOT counted (it is appended downstream and is independent of the
    inter-stroke order). This mirrors the connector cost the web planner's
    ``totalStepCount`` charges for connector segments and is the objective
    :func:`two_opt_order` minimizes — the visible diagonal "connector" ink a
    no-pen-lift Etch-a-Sketch lays down between strokes.
    """
    total = 0.0
    cx, cy = float(start[0]), float(start[1])
    for poly in ordered:
        if not poly:
            continue
        total += _chebyshev(cx, cy, poly[0][0], poly[0][1])
        cx, cy = poly[-1][0], poly[-1][1]
    return total


def two_opt_order(
    ordered: Sequence[Polyline], start: Tuple[float, float] = (0.0, 0.0)
) -> List[Polyline]:
    """Deterministic 2-opt refinement of an ordered, oriented polyline list.

    Mirrors ``twoOptReorder`` in ``web/src/path/nn_order.ts`` exactly so the
    harness preview reflects the real machine order (the web planner is the
    authoritative draw-order stage; the Python service order does not reach the
    machine). Reduces total Chebyshev connector travel (see
    :func:`total_connector_travel_chebyshev`).

    The only move is "reverse the sub-sequence ``[i..j]``", flipping each stroke
    in that block end-for-end. Because the Chebyshev metric is symmetric, every
    connector cost interior to the block is preserved, so the move changes only
    the two boundary connectors (the classic 2-opt edge swap). The degenerate
    ``i == j`` case reverses a single stroke — a pure head/tail orientation
    flip — so individual reorientation is covered by the same loop.

    Determinism: the ``(i, j)`` scan order is fixed (ascending ``i`` then ``j``)
    and moves are applied only on a strictly-negative cost change, which both
    guarantees termination and makes the result a pure function of the inputs
    and ``start``. The pass count is additionally capped at
    :data:`MAX_2OPT_PASSES`. Input polylines are never mutated (copies returned).
    """
    route: List[Polyline] = [list(p) for p in ordered]
    n = len(route)
    if n < 2:
        return route

    sx, sy = float(start[0]), float(start[1])

    for _ in range(MAX_2OPT_PASSES):
        improved = False
        for i in range(n):
            for j in range(i, n):
                if i == 0:
                    lx, ly = sx, sy
                else:
                    le = route[i - 1][-1]
                    lx, ly = le[0], le[1]

                first_entry = route[i][0]
                first_exit = route[i][-1]
                last_entry = route[j][0]
                last_exit = route[j][-1]
                has_right = (j + 1) < n
                if has_right:
                    rn = route[j + 1][0]
                    rx, ry = rn[0], rn[1]

                old_cost = _chebyshev(lx, ly, first_entry[0], first_entry[1])
                if has_right:
                    old_cost += _chebyshev(last_exit[0], last_exit[1], rx, ry)

                # After reverse+flip: new first stroke is old j flipped
                # (entry = its old exit), new last stroke is old i flipped
                # (exit = its old entry).
                new_cost = _chebyshev(lx, ly, last_exit[0], last_exit[1])
                if has_right:
                    new_cost += _chebyshev(first_entry[0], first_entry[1], rx, ry)

                if new_cost < old_cost:
                    block = [list(reversed(route[k])) for k in range(i, j + 1)]
                    block.reverse()
                    route[i : j + 1] = block
                    improved = True
        if not improved:
            break

    return route


# ---------------------------------------------------------------------------
# Top-level pipeline.
# ---------------------------------------------------------------------------
def vectorize(image_bytes: bytes, params: VectorizeParams) -> dict:
    """Run the full skeleton-primary pipeline: image bytes + params -> polylines.

    Returns ``{"width": int, "height": int, "polylines": [[[x, y], ...], ...]}``
    in image-pixel space. Never crashes on a blank/flat image: degenerate
    dimensions or "no strokes survive" both yield ``polylines: []``.

    Raises:
        ValueError: if ``image_bytes`` cannot be decoded.
    """
    img = _decode(image_bytes)
    img = _downscale_to_max_dim(img, params.max_dim)
    h, w = img.shape[:2]

    # Degenerate-dimension guard: never return a degenerate buffer.
    if min(w, h) < 2:
        return {"width": int(w), "height": int(h), "polylines": []}

    gray = _to_grayscale(img)
    gray = _apply_contrast(gray, params.contrast)
    gray = _apply_blur(gray, params.blur_sigma)

    epsilon = _detail_to_epsilon(params.detail)
    min_len = _detail_to_min_stroke_len(params.detail, params.min_stroke_len)

    mode = (params.mode or "both").lower()
    polylines: List[Polyline] = []

    # Subject isolation (opt-in, for the tonal fill modes): pull a roughly-centred
    # subject off a busy background via GrabCut, then contrast-stretch its own
    # tonal range so a uniform subject (e.g. a white print) still shows form. The
    # resulting subject mask becomes the fill's foreground; the surround stays
    # blank. Falls back silently when isolation fails or the mode does not use it.
    subject: Optional[np.ndarray] = None
    if params.isolate_subject and mode in ("wave", "zigzag", "hatch"):
        subject = detect_subject_mask(img)
        if subject is not None:
            gray = normalize_within_mask(gray, subject)

    # Local detail recovery: boost local contrast (subject-only when a subject
    # mask exists) so subtle in-region detail — a dark mask's eyes/grille, soft
    # shadows — survives the global posterize + Canny stages instead of being
    # crushed into a solid fill. Feeds every mode's fill + feature passes.
    if params.local_contrast > 0:
        gray = _apply_local_contrast(gray, params.local_contrast, mask=subject)

    if mode == "zigzag":
        # Perimeter + fill: a clean outline around the subject (and feature
        # outlines), with a STRAIGHT-LINE serpentine (boustrophedon) tonal fill
        # bounded inside it — straight horizontal sweeps that zig-zag at the
        # turns, density tracking darkness. Visibly distinct from the wavy Wave,
        # and the straight sweeps are what the machine draws cleanest.
        polylines.extend(mask_perimeter(subject))
        if params.edge_paths:
            polylines.extend(wave_feature_paths(gray, subject, image_size=(w, h)))
        polylines.extend(vstep_serpentine_fill(gray, params, foreground=subject))
    elif mode == "wave":
        # Engineezy-style continuous horizontal scanlines, wave-modulated by tone
        # (one long stroke per row -> fast, few reversals, tonal detail).
        polylines.extend(wave_scanline_fill(gray, params, foreground=subject))
        # Clean feature-edge pass on top so eyes/lips/jaw/neck read as definition
        # rather than melting into the tonal bands.
        if params.edge_paths:
            polylines.extend(
                wave_feature_paths(gray, subject, image_size=(w, h))
            )
    elif mode == "hatch":
        # Tonal serpentine fill + clean centerline/outline feature pass.
        polylines.extend(hatch_fill(gray, params, foreground=subject))
        if params.edge_paths:
            polylines.extend(
                hatch_feature_paths(gray, params, epsilon, min_len, image_size=(w, h))
            )
    elif mode == "lineart":
        # Logo / line-art: one clean outline per shape (letters + mascot), with
        # small holes (eyes / letter counters) kept and thin-stroke inner-edge
        # doublings dropped. Pairs with the alpha-matte decode so a white-on-
        # transparent logo is traced as dark ink on white paper.
        polylines.extend(lineart_outline(gray, epsilon, min_len))
    else:
        masks = posterize_to_tone_bands(gray, params.tone_bands, params.threshold)

        if mode in ("skeleton", "both"):
            polylines.extend(skeletonize_regions(masks, epsilon, min_len))

        if mode in ("contour", "both") and masks:
            polylines.extend(_silhouette_contours(masks, epsilon, min_len, image_size=(w, h)))

    if not polylines:
        return {"width": int(w), "height": int(h), "polylines": []}

    polylines = merge_endpoints(polylines, snap_radius=8.0)

    ordered = order_nearest_neighbor(polylines, start=(0.0, 0.0))

    # Normalize every coordinate to a native int (JSON-serializable, pixel space).
    out_polylines = [[[int(pt[0]), int(pt[1])] for pt in poly] for poly in ordered]

    return {"width": int(w), "height": int(h), "polylines": out_polylines}


# ===========================================================================
# OPTIONAL / DESCOPED offline harness — hidden-connector-routing mirror.
# ---------------------------------------------------------------------------
# This section is an ADDITIVE, pure mirror of the authoritative web router in
# ``web/src/path/connector_router.ts`` (+ the incremental weave in
# ``web/src/path/stitch.ts``). The WEB planner is the source of truth that
# reaches the machine; this Python copy exists only so the offline tuning
# harness (compare.py) can preview Hidden_Travel vs Exposed_Travel on a PNG.
#
# Nothing above this line calls into it, so importing it never alters the
# existing vectorize() / ordering behavior.
#
# It mirrors, step for step:
#   * the Hidden/Exposed overlap CLASSIFICATION (collinear-and-contained within
#     1 integer step of a Drawn_Ink piece or an inclusive Step_Envelope edge),
#   * the CHEBYSHEV accounting (hidden + exposed == total, each step counted
#     once),
#   * the SNAP-and-TRAVERSE candidate generation (approach -> traverse ->
#     depart, snap targets from local ink endpoints + nearest envelope-edge
#     points, geometric radius growth, candidate cap),
#   * the DETERMINISTIC tie-break (minimize Exposed, then total Chebyshev, then
#     lexicographically smallest ordered point sequence).
#
# Coordinates are integer motor steps; inputs are coerced with the same
# half-up rounding JavaScript's ``Math.round`` uses, so the two implementations
# agree step-for-step (cross-check fixture is spec task 15.3).
#
# @see Requirements 1.1, 1.5, 10.4
# ===========================================================================

# Documented router defaults (mirror connector_router.ts).
DEFAULT_MAX_CANDIDATES = 32          # max candidate routes per connector (Req 8.2)
DEFAULT_MAX_POINTS = 1000            # hard cap on points in a routed connector (Req 2.2, 2.7)
DEFAULT_EXPECTED_SEGMENTS = 1024     # assumed segment count for default grid cell size

# Floating-point slack absorbing sqrt/division rounding when comparing against
# the integer-step tolerances; coordinates are integers so this only guards the
# exact ``== tolerance`` boundary.
_GEOM_EPS = 1e-9
# Perpendicular-distance tolerance, in integer steps, for a leg to lie "on" ink.
_HIDDEN_PERP_TOLERANCE = 1
# Along-segment containment slack (strict 0): a step past an ink piece's extent
# is not hidden by it, so a partly-covered leg splits exactly at the boundary.
_HIDDEN_PROJ_TOLERANCE = 0

# A point in integer motor steps, kept as a hashable tuple internally.
IPoint = Tuple[int, int]
# An ink sub-segment: the ordered endpoint pair of one inter-vertex move.
InkSegment = Tuple[IPoint, IPoint]


def _js_round(v: float) -> int:
    """Round half UP toward +inf, matching JavaScript's ``Math.round``.

    Python's built-in ``round`` is banker's rounding (half to even), which
    disagrees with the web router on ``*.5`` boundaries; mirroring Math.round
    keeps the integer-step DDA walk identical across the two implementations.
    """
    return int(math.floor(v + 0.5))


def _ipt(p: Sequence[float]) -> IPoint:
    """Coerce a point to integer motor steps (half-up), as the web router assumes."""
    return (_js_round(float(p[0])), _js_round(float(p[1])))


def _cheb(a: IPoint, b: IPoint) -> int:
    """Chebyshev distance ``max(|dx|, |dy|)`` — the per-move step count (Req 1.1)."""
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]))


def _walk_line_steps(a: IPoint, b: IPoint):
    """Yield the integer motor-step positions along ``a -> b`` (integer DDA).

    Yields ``chebyshev(a, b) + 1`` points starting exactly at ``a`` and ending
    exactly at ``b``; a zero-length move yields the single point ``a``. Mirrors
    ``walkLineSteps`` in connector_router.ts, so a diagonal move registers in
    every cell its groove physically crosses.
    """
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    n = max(abs(dx), abs(dy))
    if n == 0:
        yield (a[0], a[1])
        return
    for i in range(n + 1):
        yield (a[0] + _js_round(dx * i / n), a[1] + _js_round(dy * i / n))


def _leg_covered_by_segment(
    a: IPoint,
    b: IPoint,
    seg: InkSegment,
    perp_tol: float,
    proj_tol: float,
) -> bool:
    """True iff leg ``[a, b]`` is collinear with and contained within ``seg`` (Req 10.1).

    Two tolerances apply: ``perp_tol`` bounds the perpendicular distance of each
    endpoint to ``seg``'s infinite line (the "collinear within 1 step" bound),
    and ``proj_tol`` is slack on the along-segment projection (containment),
    strict (0) by default so a partly-covered leg splits exactly at the ink
    boundary (Req 10.3). Because both quantities are affine along the straight
    leg, checking the two endpoints proves the condition for every interior
    point. Mirrors ``legCoveredBySegment``.
    """
    (sax, say), (sbx, sby) = seg
    vx = sbx - sax
    vy = sby - say
    len2 = vx * vx + vy * vy

    if len2 == 0:
        # Degenerate ink "piece" is a single point; covers only points on top.
        return _cheb(a, (sax, say)) <= perp_tol and _cheb(b, (sax, say)) <= perp_tol

    length = math.sqrt(len2)

    # Perpendicular distance of each endpoint to the infinite line of ``seg``.
    perp_a = abs((a[0] - sax) * vy - (a[1] - say) * vx) / length
    perp_b = abs((b[0] - sax) * vy - (b[1] - say) * vx) / length
    if perp_a > perp_tol + _GEOM_EPS or perp_b > perp_tol + _GEOM_EPS:
        return False

    # Projection along ``seg``'s direction; the piece spans [0, length].
    proj_a = ((a[0] - sax) * vx + (a[1] - say) * vy) / length
    proj_b = ((b[0] - sax) * vx + (b[1] - say) * vy) / length
    if proj_a < -proj_tol - _GEOM_EPS or proj_a > length + proj_tol + _GEOM_EPS:
        return False
    if proj_b < -proj_tol - _GEOM_EPS or proj_b > length + proj_tol + _GEOM_EPS:
        return False

    return True


class DrawnInkIndex:
    """Spatial occupancy structure over Drawn_Ink for bounded overlap queries.

    Backed by a uniform grid (cell size ~ envelope / sqrt(N)) keyed by integer
    cell, so per-connector queries touch O(local) ink rather than all of it,
    keeping total routing cost ~linear in stroke count (Req 8.1, 8.2). The four
    inclusive Step_Envelope perimeter edges are held as implicit ink and
    consulted alongside the grid, so a border-hugging route reads as routable
    Hidden_Travel even before any stroke is drawn near it (Req 1.4, 4.1).

    Pure mirror of the ``DrawnInkIndex`` class in connector_router.ts.
    """

    def __init__(self, env: Tuple[int, int], cell_size: Optional[float] = None) -> None:
        self.env: IPoint = (int(env[0]), int(env[1]))
        max_dim = max(self.env[0], self.env[1], 1)
        if cell_size is None or not math.isfinite(cell_size):
            chosen = _js_round(max_dim / math.sqrt(DEFAULT_EXPECTED_SEGMENTS))
        else:
            chosen = _js_round(cell_size)
        self.cell_size = max(1, chosen)
        self.cells: Dict[IPoint, List[InkSegment]] = {}
        self.endpoint_cells: Dict[IPoint, List[IPoint]] = {}
        self.ink_segment_count = 0
        ex, ey = self.env
        # Inclusive perimeter: left, right, bottom, top (treated as zero-Exposed ink).
        self.envelope_edges: Tuple[InkSegment, ...] = (
            ((0, 0), (0, ey)),
            ((ex, 0), (ex, ey)),
            ((0, 0), (ex, 0)),
            ((0, ey), (ex, ey)),
        )

    def _cell_of(self, p: IPoint) -> IPoint:
        return (math.floor(p[0] / self.cell_size), math.floor(p[1] / self.cell_size))

    def add(self, points: Sequence[Sequence[float]]) -> None:
        """Insert every inter-vertex sub-segment of an emitted polyline (Req 1.3).

        Each adjacent vertex pair becomes one ``InkSegment``, registered in every
        grid cell its groove crosses (via the integer DDA walk, so diagonal ink
        lands in all crossed cells). Both endpoints are also stored in their
        cell's endpoint bucket for ``nearby_endpoints``.
        """
        pts = [_ipt(p) for p in points]
        for i in range(len(pts) - 1):
            a = pts[i]
            b = pts[i + 1]
            ink: InkSegment = (a, b)
            self.ink_segment_count += 1
            seen: Set[IPoint] = set()
            for step in _walk_line_steps(a, b):
                c = self._cell_of(step)
                if c in seen:
                    continue
                seen.add(c)
                self.cells.setdefault(c, []).append(ink)
            self._add_endpoint(a)
            self._add_endpoint(b)

    def _add_endpoint(self, p: IPoint) -> None:
        self.endpoint_cells.setdefault(self._cell_of(p), []).append((p[0], p[1]))

    def nearby_endpoints(self, p: IPoint, radius: float) -> List[IPoint]:
        """Drawn-ink endpoints within ``radius`` (Chebyshev) of ``p`` (Req 8.2).

        Only cells overlapping ``[p +/- radius]`` are scanned; the result is
        deduplicated and sorted lexicographically (x before y) so the order is
        independent of insertion order (Req 3.4).
        """
        r = max(0, radius)
        cx_min = math.floor((p[0] - r) / self.cell_size)
        cx_max = math.floor((p[0] + r) / self.cell_size)
        cy_min = math.floor((p[1] - r) / self.cell_size)
        cy_max = math.floor((p[1] + r) / self.cell_size)

        seen: Set[IPoint] = set()
        out: List[IPoint] = []
        for cy in range(cy_min, cy_max + 1):
            for cx in range(cx_min, cx_max + 1):
                bucket = self.endpoint_cells.get((cx, cy))
                if not bucket:
                    continue
                for e in bucket:
                    if _cheb(p, e) > r:
                        continue
                    if e in seen:
                        continue
                    seen.add(e)
                    out.append((e[0], e[1]))
        out.sort(key=lambda q: (q[0], q[1]))
        return out

    def covering_segments(self, p: IPoint) -> List[InkSegment]:
        """Ink pieces local to ``p`` (its cell + 8 neighbours) plus any inclusive
        envelope edge within 1 integer step of ``p`` (Req 1.4). Precise
        collinear-and-contained checking is done by ``is_hidden``."""
        cx, cy = self._cell_of(p)
        seen: Set[InkSegment] = set()
        out: List[InkSegment] = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                bucket = self.cells.get((cx + dx, cy + dy))
                if not bucket:
                    continue
                for ink in bucket:
                    if ink in seen:
                        continue
                    seen.add(ink)
                    out.append(ink)
        for edge in self._nearby_envelope_edges(p):
            out.append(edge)
        return out

    def _nearby_envelope_edges(self, p: IPoint) -> List[InkSegment]:
        left, right, bottom, top = self.envelope_edges
        out: List[InkSegment] = []
        if abs(p[0] - 0) <= 1:
            out.append(left)
        if abs(p[0] - self.env[0]) <= 1:
            out.append(right)
        if abs(p[1] - 0) <= 1:
            out.append(bottom)
        if abs(p[1] - self.env[1]) <= 1:
            out.append(top)
        return out

    def is_empty(self) -> bool:
        """True iff no Drawn_Ink sub-segment has been added (envelope edges excluded)."""
        return self.ink_segment_count == 0

    def is_hidden(self, a: IPoint, b: IPoint) -> bool:
        """True iff ``[a, b]`` is collinear-and-contained in some ink piece within
        1 step (Req 1.1, 10.1). Consults ink/edges local to BOTH endpoints,
        deduplicated, so a bounded local scan answers per-step coverage probes."""
        seen: Set[InkSegment] = set()
        for seg in self.covering_segments(a):
            seen.add(seg)
        for seg in self.covering_segments(b):
            seen.add(seg)
        for seg in seen:
            if _leg_covered_by_segment(a, b, seg, _HIDDEN_PERP_TOLERANCE, _HIDDEN_PROJ_TOLERANCE):
                return True
        return False


@dataclass
class RouteClassification:
    """Hidden vs Exposed travel breakdown of a route, in Chebyshev steps."""

    hidden_travel: int
    exposed_travel: int
    total_travel: int


def classify_route(points: Sequence[IPoint], ink: DrawnInkIndex) -> RouteClassification:
    """Charge each integer step of a route as Hidden_Travel or Exposed_Travel.

    Walks the route's adjacent legs in integer motor steps and charges each step
    as Hidden (it lands on a Drawn_Ink piece or envelope edge) or Exposed (a gap
    not coverable by existing ink), splitting each leg at the integer step where
    coverage changes (Req 10.1, 10.3). Every integer step is counted in exactly
    one category, so ``hidden_travel + exposed_travel == total_travel`` (the
    route's full Chebyshev length) exactly (Req 10.4). An unhideable Hidden leg
    is, step by step, simply found uncovered and charged as Exposed while the
    route is retained (Req 10.2). Pure mirror of ``classifyRoute``.
    """
    hidden_travel = 0
    exposed_travel = 0
    total_travel = 0

    for i in range(len(points) - 1):
        a = points[i]
        b = points[i + 1]
        leg_len = _cheb(a, b)
        total_travel += leg_len
        if leg_len == 0:
            continue
        prev: Optional[IPoint] = None
        for step in _walk_line_steps(a, b):
            if prev is not None:
                if ink.is_hidden(prev, step):
                    hidden_travel += 1
                else:
                    exposed_travel += 1
            prev = step

    return RouteClassification(hidden_travel, exposed_travel, total_travel)


@dataclass
class ConnectorResult:
    """Per-connector outcome, mirroring ``ConnectorResult`` in connector_router.ts."""

    points: List[List[int]]      # the emitted connector polyline (>=2 points)
    hidden_travel: int           # Chebyshev steps overlapping ink/edges (invisible)
    exposed_travel: int          # Chebyshev steps NOT overlapping ink (visible)
    total_travel: int            # == hidden_travel + exposed_travel exactly
    fell_back: bool              # True when the straight 2-point fallback was emitted
    rejected: bool               # True when a route was computed but rejected by a guard


def _collapse_consecutive(points: Sequence[IPoint]) -> List[IPoint]:
    """Collapse runs of consecutive identical points to one, preserving first/last (Req 2.4)."""
    out: List[IPoint] = []
    for p in points:
        if not out or out[-1] != p:
            out.append((p[0], p[1]))
    return out


def _candidate_key(points: Sequence[IPoint]) -> str:
    """Stable signature of a candidate route, to dedup identical sequences (Req 8.2)."""
    return ";".join(f"{p[0]},{p[1]}" for p in points)


def _compare_point_sequence(a: Sequence[IPoint], b: Sequence[IPoint]) -> int:
    """Lexicographic comparison of two ordered point sequences (x before y), a
    shorter prefix sorting smaller (Req 3.3). Returns <0, 0, or >0."""
    n = min(len(a), len(b))
    for i in range(n):
        if a[i][0] != b[i][0]:
            return a[i][0] - b[i][0]
        if a[i][1] != b[i][1]:
            return a[i][1] - b[i][1]
    return len(a) - len(b)


@dataclass
class _Candidate:
    points: List[IPoint]
    exposed: int
    total: int


def _is_better_candidate(cand: _Candidate, best: _Candidate) -> bool:
    """Strict three-key ordering selecting the winner (Req 1.5, 3.3, 5.3): smaller
    Exposed wins; tie -> smaller total Chebyshev; tie -> lexicographically
    smallest point sequence. A total order, so no tie is left unresolved."""
    if cand.exposed != best.exposed:
        return cand.exposed < best.exposed
    if cand.total != best.total:
        return cand.total < best.total
    return _compare_point_sequence(cand.points, best.points) < 0


def _clamp_int(v: float, lo: int, hi: int) -> int:
    """Clamp ``v`` to the inclusive integer range ``[lo, hi]`` (half-up rounding)."""
    r = _js_round(v)
    if r < lo:
        return lo
    if r > hi:
        return hi
    return r


def _nearest_points_on_envelope_edges(p: IPoint, env: IPoint) -> List[IPoint]:
    """Nearest integer point on each of the four inclusive envelope edges to ``p``,
    clamped into the envelope, so a route can hug the perimeter as zero-Exposed
    Hidden_Travel (Req 1.4). Mirrors ``nearestPointsOnEnvelopeEdges``."""
    cx = _clamp_int(p[0], 0, env[0])
    cy = _clamp_int(p[1], 0, env[1])
    return [
        (0, cy),         # left edge   x = 0
        (env[0], cy),    # right edge  x = env.x
        (cx, 0),         # bottom edge y = 0
        (cx, env[1]),    # top edge    y = env.y
    ]


def _snap_targets(ink: DrawnInkIndex, p: IPoint, env: IPoint, radius: float) -> List[IPoint]:
    """Snap targets for one connector endpoint at ``radius``: local Drawn_Ink
    endpoints plus the nearest point on each envelope edge, deduplicated and
    sorted lexicographically so generation order is deterministic (Req 3.1,
    3.4). Mirrors ``snapTargets``."""
    seen: Set[IPoint] = set()
    out: List[IPoint] = []

    def push(q: IPoint) -> None:
        if q in seen:
            return
        seen.add(q)
        out.append((q[0], q[1]))

    for e in ink.nearby_endpoints(p, radius):
        push(e)
    for e in _nearest_points_on_envelope_edges(p, env):
        push(e)

    out.sort(key=lambda q: (q[0], q[1]))
    return out


def _is_route_contained(points: Sequence[IPoint], env: IPoint) -> bool:
    """True iff every route point and every traversed integer step lies within the
    inclusive envelope ``[0,env.x] x [0,env.y]`` (Req 4.1, 4.2, 4.3)."""

    def inside(q: IPoint) -> bool:
        return 0 <= q[0] <= env[0] and 0 <= q[1] <= env[1]

    for i in range(len(points) - 1):
        for step in _walk_line_steps(points[i], points[i + 1]):
            if not inside(step):
                return False
    for p in points:
        if not inside(p):
            return False
    return True


def _straight_fallback(
    exit_pt: IPoint, entry: IPoint, total: int, rejected: bool = False
) -> ConnectorResult:
    """Build the straight 2-point connector ``[exit, entry]`` and its accounting.

    Always a valid, envelope-safe fallback whose full Chebyshev length is
    Exposed_Travel (Req 5.1, 6.1). ``fell_back`` is always set; ``rejected`` is
    set additionally when a computed route failed a structural/containment guard
    (Req 2.7, 4.4) rather than merely failing to improve. Mirrors
    ``straightFallback``."""
    return ConnectorResult(
        points=[[exit_pt[0], exit_pt[1]], [entry[0], entry[1]]],
        hidden_travel=0,
        exposed_travel=total,
        total_travel=total,
        fell_back=True,
        rejected=rejected,
    )


def _apply_guards(
    candidate_points: Sequence[IPoint],
    exit_pt: IPoint,
    entry: IPoint,
    ink: DrawnInkIndex,
    env: IPoint,
    straight_len: int,
    max_points: int,
) -> ConnectorResult:
    """Apply the per-connector guard suite in order, degrading to the straight
    2-point fallback on any failure (Req 2.x, 4.x, 5.2). Mirrors ``applyGuards``:

      1. Collapse consecutive duplicate points, preserving first/last (Req 2.4).
      2. Require ``2 <= points <= max_points`` after collapse (Req 2.7).
      3. Require every adjacent pair to differ in >= 1 coordinate (Req 2.3).
      4. Require first point == exit and last == entry exactly (Req 2.1, 6.5).
      5. Require every point and every traversed step inside the envelope (Req 4).
      6. Require ``exposed_travel < straight_len`` strictly (Req 5.2, 6.2).
    """
    points = _collapse_consecutive(candidate_points)

    if len(points) < 2 or len(points) > max_points:
        return _straight_fallback(exit_pt, entry, straight_len, True)

    for i in range(len(points) - 1):
        if points[i] == points[i + 1]:
            return _straight_fallback(exit_pt, entry, straight_len, True)

    if points[0] != exit_pt or points[-1] != entry:
        return _straight_fallback(exit_pt, entry, straight_len, True)

    if not _is_route_contained(points, env):
        return _straight_fallback(exit_pt, entry, straight_len, True)

    cls = classify_route(points, ink)
    if not (cls.exposed_travel < straight_len):
        return _straight_fallback(exit_pt, entry, straight_len)

    return ConnectorResult(
        points=[[p[0], p[1]] for p in points],
        hidden_travel=cls.hidden_travel,
        exposed_travel=cls.exposed_travel,
        total_travel=cls.total_travel,
        fell_back=False,
        rejected=False,
    )


def route_connector(
    exit_pt: Sequence[float],
    entry: Sequence[float],
    ink: DrawnInkIndex,
    env: Tuple[int, int],
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
    max_points: int = DEFAULT_MAX_POINTS,
) -> ConnectorResult:
    """Route a single connector from ``exit_pt`` to ``entry`` over Drawn_Ink.

    Pure: depends only on its arguments (Req 3.1). Returns the best routed
    connector whose Exposed_Travel is STRICTLY less than the straight 2-point
    connector's Chebyshev length; otherwise the straight 2-point fallback
    (Req 1.6, 5.2, 6.1). Always begins at ``exit_pt`` and ends at ``entry``
    (Req 2.1, 6.5).

    Builds *approach -> traverse -> depart* candidates
    ``exit -> sExit -> sEntry -> entry`` from snap targets (local ink endpoints
    + nearest envelope-edge points), growing the snap radius geometrically until
    a strictly-improving route is found or the per-connector candidate cap is
    reached (Req 8.2, 8.3). Each candidate is scored by ``classify_route`` and
    the winner chosen by the deterministic three-key order. Pure mirror of
    ``routeConnector``.
    """
    e_exit = _ipt(exit_pt)
    e_entry = _ipt(entry)
    env_t: IPoint = (int(env[0]), int(env[1]))
    straight_len = _cheb(e_exit, e_entry)

    # No ink drawn yet (i == 0): skip the hiding search, emit straight (Req 6.3).
    if ink.is_empty():
        return _straight_fallback(e_exit, e_entry, straight_len)

    max_candidates = max(1, int(max_candidates))
    max_points = max(2, int(max_points))
    max_dim = max(env_t[0], env_t[1], 1)

    evaluated = 0
    best: Optional[_Candidate] = None
    seen_candidates: Set[str] = set()

    R = 1
    while True:
        a_targets = _snap_targets(ink, e_exit, env_t, R)
        b_targets = _snap_targets(ink, e_entry, env_t, R)

        cap_reached = False
        for s_exit in a_targets:
            if cap_reached:
                break
            for s_entry in b_targets:
                points = _collapse_consecutive([e_exit, s_exit, s_entry, e_entry])
                if len(points) < 2:
                    continue
                key = _candidate_key(points)
                if key in seen_candidates:
                    continue
                if evaluated >= max_candidates:
                    cap_reached = True
                    break
                seen_candidates.add(key)
                evaluated += 1
                cls = classify_route(points, ink)
                cand = _Candidate(points, cls.exposed_travel, cls.total_travel)
                if best is None or _is_better_candidate(cand, best):
                    best = cand

        if cap_reached or evaluated >= max_candidates:
            break
        if R >= max_dim:
            break
        R *= 2

    if best is not None and best.exposed < straight_len:
        return _apply_guards(best.points, e_exit, e_entry, ink, env_t, straight_len, max_points)

    return _straight_fallback(e_exit, e_entry, straight_len)


def route_connectors_over_ink(
    ordered: Sequence[Polyline],
    env: Tuple[int, int],
    start: Tuple[float, float] = (0.0, 0.0),
) -> List[ConnectorResult]:
    """Weave hidden connectors over already-drawn ink for an ordered stroke list.

    Mirrors the opt-in weave in ``stitchPolylines`` / ``weaveWithRouter``: walks
    the already-ordered, already-oriented strokes front to back, maintaining a
    :class:`DrawnInkIndex` of everything emitted so far. For each gap between the
    running pen position and the next stroke's entry point it routes a connector
    against the ink committed so far, then commits both the routed connector and
    the stroke to the index before advancing — so connector index ``i`` only ever
    hides over ink at indices ``< i`` (Req 1.3). A zero-length gap (entry already
    at the cursor) emits no connector, matching the straight-connector branch.

    Pure and deterministic (Req 3.1): no randomness, wall-clock, or external
    mutable state. Returns one :class:`ConnectorResult` per emitted connector.

    Args:
        ordered: strokes after the final NN + 2-opt order/orientation (Req 7.5/7.6).
        env: inclusive integer Step_Envelope ``(env_x, env_y)``.
        start: the pen's home/start position.
    """
    env_t: IPoint = (int(env[0]), int(env[1]))
    ink = DrawnInkIndex(env_t)
    connectors: List[ConnectorResult] = []
    cursor: IPoint = _ipt(start)

    for poly in ordered:
        if len(poly) < 1:
            continue
        seg_start = _ipt(poly[0])
        seg_end = _ipt(poly[-1])

        # Emit a connector only when the pen actually has to move.
        if seg_start != cursor:
            result = route_connector(cursor, seg_start, ink, env_t)
            connectors.append(result)
            # Commit the routed connector so later connectors can hide over it.
            ink.add(result.points)

        # Commit the stroke to the index before the next gap is routed.
        ink.add(poly)
        cursor = seg_end

    return connectors


def total_exposed_travel_chebyshev(
    ordered: Sequence[Polyline],
    env: Tuple[int, int],
    start: Tuple[float, float] = (0.0, 0.0),
) -> float:
    """Total VISIBLE connector travel after hiding over ink, in Chebyshev steps.

    Runs :func:`route_connectors_over_ink` and sums every connector's
    ``exposed_travel`` (Req 10.4) — the residual gap NOT coverable by existing
    ink, i.e. the visible diagonal "connector" ink a no-pen-lift Etch-a-Sketch
    still lays down between strokes after routing. This is the hidden-routing
    analogue of :func:`total_connector_travel_chebyshev` (which charges every
    connector's full Chebyshev length); the difference between the two is the
    travel the router managed to hide.
    """
    connectors = route_connectors_over_ink(ordered, env, start)
    return float(sum(c.exposed_travel for c in connectors))
