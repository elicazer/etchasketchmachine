"""Tests for the pure vectorize pipeline on tiny synthetic fixtures.

These exercise the design's Correctness Properties:
  * Property 1 - JSON schema: polylines are [x,y] pairs within [0,w)x[0,h); w,h>0.
  * Property 2 - determinism: same bytes + params -> deeply-equal polylines.
  * Property 3 - non-degenerate bbox: a two-axis shape spans width>0 and height>0.
  * Property 4 - skeleton centerlines: a thick bar collapses to a single
    centerline-ish polyline (far fewer points than its filled pixel count).
  * Property 5 - bounded output + monotonic detail: lowering detail does not
    increase total vertex count.

Validates: Requirements 4.2, 1.3, 2.2, 3.3, 3.4, 4.1
"""

import numpy as np
import cv2

from vectorize import VectorizeParams, vectorize


# ---------------------------------------------------------------------------
# Synthetic fixtures (numpy -> PNG bytes via cv2.imencode).
# ---------------------------------------------------------------------------
def _encode_png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    assert ok, "cv2.imencode failed to produce PNG bytes"
    return buf.tobytes()


def _blank_white(h: int = 64, w: int = 64) -> np.ndarray:
    """All-white image (no dark regions)."""
    return np.full((h, w, 3), 255, dtype=np.uint8)


def _thick_plus(h: int = 64, w: int = 64, bar: int = 8) -> np.ndarray:
    """White background with a thick black plus sign (spans both axes)."""
    img = np.full((h, w, 3), 255, dtype=np.uint8)
    cy, cx = h // 2, w // 2
    half = bar // 2
    img[cy - half : cy + half, :, :] = 0  # horizontal bar
    img[:, cx - half : cx + half, :] = 0  # vertical bar
    return img


def _thick_l(h: int = 64, w: int = 64, bar: int = 8) -> np.ndarray:
    """White background with a thick black L shape (spans both axes)."""
    img = np.full((h, w, 3), 255, dtype=np.uint8)
    img[h - bar : h, :, :] = 0  # bottom horizontal bar
    img[:, 0:bar, :] = 0  # left vertical bar
    return img


def _params(**overrides) -> VectorizeParams:
    # Disable blur on tiny fixtures so thin features survive; no downscale.
    base = dict(blur_sigma=0.0, max_dim=1000, min_stroke_len=2.0, tone_bands=1)
    base.update(overrides)
    return VectorizeParams(**base)


# ---------------------------------------------------------------------------
# Property 4 - skeleton produces a single centerline-ish polyline.
# ---------------------------------------------------------------------------
def test_skeleton_of_thick_plus_is_centerline():
    img = _thick_plus()
    result = vectorize(_encode_png(img), _params(mode="skeleton"))

    polylines = result["polylines"]
    assert len(polylines) >= 1, "expected at least one skeleton polyline"

    # The plus has thousands of filled pixels; the simplified skeleton must
    # collapse to vastly fewer vertices (confident centerline, not a fill).
    total_vertices = sum(len(p) for p in polylines)
    filled_px = int((cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) < 128).sum())
    assert filled_px > 500
    assert total_vertices < filled_px / 10

    # The skeleton spine should track the bar centers (~mid rows/cols).
    xs = [pt[0] for p in polylines for pt in p]
    ys = [pt[1] for p in polylines for pt in p]
    # vertical bar spine near center x; horizontal bar spine near center y.
    assert min(xs) <= img.shape[1] // 2 <= max(xs)
    assert min(ys) <= img.shape[0] // 2 <= max(ys)


def test_skeleton_of_thick_l_traces_spine():
    img = _thick_l()
    result = vectorize(_encode_png(img), _params(mode="skeleton"))
    polylines = result["polylines"]
    assert len(polylines) >= 1

    # bbox of the skeleton should span most of both axes (L touches two edges).
    xs = [pt[0] for p in polylines for pt in p]
    ys = [pt[1] for p in polylines for pt in p]
    assert max(xs) - min(xs) > img.shape[1] // 2
    assert max(ys) - min(ys) > img.shape[0] // 2


# ---------------------------------------------------------------------------
# Property 2 - determinism.
# ---------------------------------------------------------------------------
def test_determinism_same_bytes_same_polylines():
    png = _encode_png(_thick_plus())
    params = _params(mode="both")
    a = vectorize(png, params)
    b = vectorize(png, params)
    assert a == b
    assert a["polylines"] == b["polylines"]


# ---------------------------------------------------------------------------
# Property 5 - bounded output; lowering detail does not increase vertex count.
# ---------------------------------------------------------------------------
def test_lowering_detail_does_not_increase_vertex_count():
    png = _encode_png(_thick_plus())

    high = vectorize(png, _params(mode="both", detail=1.0))
    low = vectorize(png, _params(mode="both", detail=0.0))

    high_vertices = sum(len(p) for p in high["polylines"])
    low_vertices = sum(len(p) for p in low["polylines"])

    assert high_vertices >= low_vertices


def test_fully_black_output_is_bounded():
    black = np.zeros((64, 64, 3), dtype=np.uint8)
    result = vectorize(_encode_png(black), _params(mode="both"))
    total_vertices = sum(len(p) for p in result["polylines"])
    # No pathological blow-up on a fully-black image.
    assert total_vertices < 64 * 64


# ---------------------------------------------------------------------------
# Property 3 - non-degenerate bbox for a two-axis shape.
# ---------------------------------------------------------------------------
def test_non_degenerate_bbox():
    result = vectorize(_encode_png(_thick_plus()), _params(mode="both"))
    pts = [pt for p in result["polylines"] for pt in p]
    assert pts, "expected non-empty polylines"
    xs = [pt[0] for pt in pts]
    ys = [pt[1] for pt in pts]
    assert max(xs) - min(xs) > 0
    assert max(ys) - min(ys) > 0


# ---------------------------------------------------------------------------
# Property 1 - JSON schema / coordinate bounds.
# ---------------------------------------------------------------------------
def test_json_schema_and_coordinate_bounds():
    result = vectorize(_encode_png(_thick_plus()), _params(mode="both"))

    w, h = result["width"], result["height"]
    assert w > 0 and h > 0

    polylines = result["polylines"]
    assert isinstance(polylines, list)
    for poly in polylines:
        assert isinstance(poly, list)
        for pt in poly:
            assert isinstance(pt, list) and len(pt) == 2
            x, y = pt
            assert isinstance(x, int) and isinstance(y, int)
            assert 0 <= x < w
            assert 0 <= y < h


# ---------------------------------------------------------------------------
# Blank image -> empty polylines.
# ---------------------------------------------------------------------------
def test_blank_image_yields_empty_polylines():
    result = vectorize(_encode_png(_blank_white()), _params(mode="both"))
    assert result["polylines"] == []
    assert result["width"] > 0 and result["height"] > 0


# ---------------------------------------------------------------------------
# hatch mode — tonal serpentine fill (density tracks darkness).
# ---------------------------------------------------------------------------
def _horizontal_gradient(h: int = 120, w: int = 120) -> np.ndarray:
    """Dark on the left (0) ramping to white on the right (255)."""
    ramp = np.linspace(0, 255, w, dtype=np.uint8)
    gray = np.tile(ramp, (h, 1))
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def _hatch_params(**overrides) -> VectorizeParams:
    base = dict(
        mode="hatch",
        blur_sigma=0.0,
        max_dim=1000,
        min_stroke_len=2.0,
        tone_bands=3,
        run_spacing=4.0,
        edge_paths=False,  # isolate the fill for density assertions
    )
    base.update(overrides)
    return VectorizeParams(**base)


def _segment_count_in_x_range(polylines, x_lo, x_hi):
    """Count fill segments whose midpoint x falls in [x_lo, x_hi)."""
    count = 0
    for poly in polylines:
        if len(poly) < 2:
            continue
        mx = sum(pt[0] for pt in poly) / len(poly)
        if x_lo <= mx < x_hi:
            count += 1
    return count


def test_hatch_gradient_is_denser_on_the_dark_side():
    """A dark→light gradient yields more fill on the dark side than the light."""
    img = _horizontal_gradient()
    result = vectorize(_encode_png(img), _hatch_params())
    w = result["width"]
    polylines = result["polylines"]
    assert polylines, "expected hatch fill polylines on a gradient"

    # Sample total horizontal fill LENGTH in the dark third vs the light third.
    # Length is the robust measure (merge_endpoints stitches runs into chains,
    # so raw segment counts can be misleading; covered pixels are not).
    def fill_length_in_band(x_lo, x_hi):
        total = 0.0
        for poly in polylines:
            for a, b in zip(poly, poly[1:]):
                # horizontal fill segments only
                if a[1] == b[1]:
                    xa = min(a[0], b[0])
                    xb = max(a[0], b[0])
                    lo = max(xa, x_lo)
                    hi = min(xb, x_hi)
                    if hi > lo:
                        total += hi - lo
        return total

    dark = fill_length_in_band(0, w // 3)
    light = fill_length_in_band(2 * w // 3, w)
    assert dark > light, f"expected denser dark fill: dark={dark} light={light}"


def test_hatch_pure_white_yields_no_fill():
    """A pure-white image is all highlights → no fill polylines."""
    result = vectorize(_encode_png(_blank_white()), _hatch_params())
    assert result["polylines"] == []
    assert result["width"] > 0 and result["height"] > 0


def test_hatch_is_deterministic():
    """Same bytes + params → identical hatch output (Property 2)."""
    png = _encode_png(_horizontal_gradient())
    params = _hatch_params(edge_paths=True)
    a = vectorize(png, params)
    b = vectorize(png, params)
    assert a == b
    assert a["polylines"] == b["polylines"]


def test_coverage_cap_lowers_cutoff_only_when_oversaturated():
    """The coverage cap drops the cutoff iff too much would be inked."""
    from vectorize import coverage_capped_threshold

    # A mostly-DARK image: 90% of pixels at value 40 (well under any sane
    # white threshold) — a fixed cutoff of 130 would ink ~90% (a blob).
    dark = np.full((100, 100), 40, dtype=np.uint8)
    dark[:10, :] = 230  # 10% bright highlights
    capped = coverage_capped_threshold(dark, 130, max_coverage=0.55)
    assert capped < 130, "expected the cutoff to drop on an over-dark image"
    # After capping, no more than ~55% of pixels are fillable.
    assert np.count_nonzero(dark < capped) <= 0.55 * dark.size + 1

    # A balanced image where the requested cutoff inks under the cap is left
    # untouched.
    light = np.full((100, 100), 200, dtype=np.uint8)
    light[:20, :] = 50  # only 20% dark
    assert coverage_capped_threshold(light, 130, max_coverage=0.55) == 130


def test_hatch_dark_image_does_not_saturate_to_blob():
    """A mostly-dark photo fills a BOUNDED fraction, not a solid square."""
    # 85% dark, 15% bright — the failure case that produced the black blob.
    img = np.full((120, 120), 35, dtype=np.uint8)
    img[:18, :] = 240
    bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    result = vectorize(_encode_png(bgr), _hatch_params(white_threshold=130))
    w, h = result["width"], result["height"]
    # Sum inked horizontal run length; it must stay well under a full fill.
    inked = 0.0
    for poly in result["polylines"]:
        for a, b in zip(poly, poly[1:]):
            if a[1] == b[1]:
                inked += abs(b[0] - a[0])
    # A solid fill at the densest band would approach rows*width; assert the
    # coverage cap keeps inked length far below the full-frame area proxy.
    assert inked < 0.85 * w * h, "fill saturated — coverage cap did not engage"


def test_hatch_excludes_uniform_dark_background():
    """A subject on a uniform DARK backdrop hatches the subject, not the surround."""
    # Uniform dark background (30) with a bright face disk (200) that has a small
    # dark feature (10) inside it. Without separation the dark backdrop floods the
    # frame; with separation only the in-subject dark feature inks.
    img = np.full((160, 160), 30, dtype=np.uint8)
    cv2.circle(img, (80, 80), 50, 200, -1)  # bright subject
    cv2.circle(img, (80, 80), 8, 10, -1)  # dark feature inside the subject
    bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    result = vectorize(_encode_png(bgr), _hatch_params(white_threshold=130))
    polys = result["polylines"]

    def inked_near(cx, cy, r):
        for poly in polys:
            for pt in poly:
                if abs(pt[0] - cx) <= r and abs(pt[1] - cy) <= r:
                    return True
        return False

    # Background corners must stay blank …
    assert not inked_near(5, 5, 12)
    assert not inked_near(155, 155, 12)
    # … and the subject's dark feature near the centre must be inked.
    assert inked_near(80, 80, 18)


def test_detect_background_mask_skips_nonuniform_border():
    """A non-uniform border (e.g. a gradient) yields no background mask."""
    from vectorize import detect_background_mask

    ramp = np.tile(np.linspace(0, 255, 100, dtype=np.uint8), (100, 1))
    assert detect_background_mask(ramp) is None


# ---------------------------------------------------------------------------
# Local contrast (CLAHE) — recover subtle in-region detail.
# ---------------------------------------------------------------------------
def _dark_region_with_subtle_feature(size: int = 200) -> np.ndarray:
    """A uniform dark field (value 60) with a slightly-lighter inner box (80).

    Models a dark glossy mask whose internal detail is a SUBTLE local variation —
    the case the global pipeline crushes. Includes mild noise so CLAHE has
    realistic texture to work on without being a perfectly flat synthetic.
    """
    rng = np.random.RandomState(0)
    img = np.full((size, size), 60, dtype=np.uint8)
    img[60:140, 60:140] = 80  # subtle internal feature (+20 only)
    noise = rng.randint(-3, 4, (size, size)).astype(np.int16)
    return np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def test_local_contrast_off_is_passthrough():
    """clip_limit <= 0 returns the input unchanged."""
    from vectorize import _apply_local_contrast

    g = _dark_region_with_subtle_feature()
    out = _apply_local_contrast(g, 0.0)
    assert np.array_equal(out, g)


def test_local_contrast_amplifies_subtle_internal_edges():
    """CLAHE amplifies a faint internal edge (the mask grille/seam case).

    CLAHE works on LOCAL contrast — it pulls subtle internal edges/texture apart
    so the Canny feature pass catches them, which is precisely how a dark mask's
    grille and seam lines get recovered.
    """
    from vectorize import _apply_local_contrast

    rng = np.random.RandomState(0)
    img = np.full((160, 160), 50, dtype=np.uint8)
    img[:, 78:82] = 66  # a faint vertical bar (+16) — a subtle internal edge
    img = np.clip(
        img.astype(np.int16) + rng.randint(-2, 3, img.shape), 0, 255
    ).astype(np.uint8)

    def edge_energy(arr):
        gx = cv2.Sobel(arr.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)
        return float(np.abs(gx).mean())

    assert edge_energy(_apply_local_contrast(img, 3.0)) > edge_energy(img)


def test_local_contrast_is_deterministic():
    from vectorize import _apply_local_contrast

    g = _dark_region_with_subtle_feature()
    assert np.array_equal(_apply_local_contrast(g, 3.0), _apply_local_contrast(g, 3.0))


def test_local_contrast_mask_only_leaves_outside_untouched():
    """With a mask, pixels outside it are byte-identical to the input."""
    from vectorize import _apply_local_contrast

    g = _dark_region_with_subtle_feature()
    mask = np.zeros(g.shape, dtype=bool)
    mask[50:150, 50:150] = True
    out = _apply_local_contrast(g, 3.0, mask=mask)
    assert np.array_equal(out[~mask], g[~mask])


def test_local_contrast_recovers_more_detail_through_vectorize():
    """End to end: a dark feature yields more strokes WITH the boost than without."""
    img = cv2.cvtColor(_dark_region_with_subtle_feature(), cv2.COLOR_GRAY2BGR)
    base = dict(
        mode="zigzag",
        run_spacing=8.0,
        white_threshold=160,
        tone_bands=4,
        blur_sigma=0.0,
        max_dim=1000,
    )
    off = vectorize(_encode_png(img), VectorizeParams(local_contrast=0.0, **base))
    on = vectorize(_encode_png(img), VectorizeParams(local_contrast=3.0, **base))

    def detail(res):
        return sum(len(p) for p in res["polylines"])

    assert detail(on) > detail(off)


# ---------------------------------------------------------------------------
# wave mode — continuous horizontal scanlines, amplitude-modulated by tone.
# ---------------------------------------------------------------------------
def _vertical_gradient(h: int = 150, w: int = 150) -> np.ndarray:
    """Dark (0) at the TOP ramping to white (255) at the bottom."""
    col = np.linspace(0, 255, h, dtype=np.uint8).reshape(-1, 1)
    gray = np.tile(col, (1, w))
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def _wave_params(**overrides) -> VectorizeParams:
    base = dict(mode="wave", run_spacing=6.0, blur_sigma=0.0, max_dim=1000)
    base.update(overrides)
    return VectorizeParams(**base)


def test_wave_pure_white_yields_no_fill():
    """A pure-white image has no tone above the floor → nothing drawn."""
    result = vectorize(_encode_png(_blank_white()), _wave_params())
    assert result["polylines"] == []


def test_wave_is_deterministic():
    """Same bytes + params → identical wave output (Property 2)."""
    png = _encode_png(_vertical_gradient())
    a = vectorize(png, _wave_params())
    b = vectorize(png, _wave_params())
    assert a == b


def test_wave_darker_rows_oscillate_more():
    """Darker rows produce larger vertical wave spread than lighter rows."""
    result = vectorize(_encode_png(_vertical_gradient()), _wave_params())
    polys = result["polylines"]
    assert polys, "expected wave scanlines on a gradient"
    height = result["height"]

    def vspread(poly):
        ys = [pt[1] for pt in poly]
        return max(ys) - min(ys)

    def center_y(poly):
        return sum(pt[1] for pt in poly) / len(poly)

    top = [vspread(p) for p in polys if center_y(p) < height * 0.33]
    mid = [vspread(p) for p in polys if height * 0.40 < center_y(p) < height * 0.66]
    assert top and mid
    # The dark top rows must wave harder (more vertical spread) than mid-tones.
    assert max(top) > max(mid)


def test_detect_subject_mask_isolates_centered_blob_on_busy_background():
    """GrabCut isolation keeps a centred subject and drops a busy surround."""
    from vectorize import detect_subject_mask

    rng = np.random.RandomState(0)
    # Busy, varied dark-ish background (non-uniform → background detector can't
    # help; GrabCut must).
    img = (rng.randint(0, 80, (180, 180, 3))).astype(np.uint8)
    # A solid bright centred subject.
    cv2.rectangle(img, (55, 45), (125, 150), (235, 235, 235), -1)
    mask = detect_subject_mask(img)
    assert mask is not None
    # The subject centre is foreground; the corners are not.
    assert bool(mask[95, 90])
    assert not bool(mask[3, 3])
    assert not bool(mask[176, 176])


def test_normalize_within_mask_stretches_subject_range():
    """A low-contrast subject is stretched toward the full 0..255 range."""
    from vectorize import normalize_within_mask

    gray = np.full((50, 50), 200, dtype=np.uint8)  # uniform bright
    gray[20:30, 20:30] = 180  # subtle darker patch
    mask = np.zeros((50, 50), dtype=bool)
    mask[10:40, 10:40] = True
    out = normalize_within_mask(gray, mask)
    # The subject's 200-vs-180 spread must widen after stretching.
    assert int(out.max()) - int(out.min()) > 20


def test_wave_isolation_falls_back_when_no_subject():
    """A flat image yields no confident subject → isolation is a no-op."""
    result = vectorize(
        _encode_png(_vertical_gradient()), _wave_params(isolate_subject=True)
    )
    # Still produces wave scanlines (did not crash / blank out on fallback).
    assert result["polylines"]


def test_wave_feature_paths_captures_strong_edges():
    """The feature pass traces strong feature edges (definition over the tone)."""
    from vectorize import wave_feature_paths, _polyline_length

    img = np.full((200, 200), 240, dtype=np.uint8)
    cv2.rectangle(img, (60, 60), (140, 140), 20, 3)  # strong dark outline
    fg = np.ones((200, 200), dtype=bool)
    polys = wave_feature_paths(img, fg, (200, 200))
    assert polys, "expected feature strokes on a strong edge"
    # The square perimeter (~320 px) should be substantially captured.
    assert sum(_polyline_length(p) for p in polys) > 150


def test_wave_feature_paths_quiet_on_flat_image():
    """A flat image has no edges → no feature strokes (no speckle)."""
    from vectorize import wave_feature_paths

    flat = np.full((120, 120), 200, dtype=np.uint8)
    assert wave_feature_paths(flat, None, (120, 120)) == []


def test_mask_perimeter_traces_a_closed_outline():
    """The perimeter is a closed-ish outline framing the subject mask."""
    from vectorize import mask_perimeter

    mask = np.zeros((200, 200), dtype=bool)
    mask[50:150, 60:140] = True  # a solid rectangular subject
    polys = mask_perimeter(mask)
    assert polys, "expected a perimeter outline"
    # The largest outline should roughly enclose the rectangle (perimeter ~360).
    longest = max(polys, key=lambda p: len(p))
    xs = [pt[0] for pt in longest]
    ys = [pt[1] for pt in longest]
    assert min(xs) < 80 and max(xs) > 120  # spans the rectangle width
    assert min(ys) < 70 and max(ys) > 130  # spans the rectangle height


def test_zigzag_mode_outputs_perimeter_plus_fill():
    """Zigzag mode runs end to end and produces strokes (perimeter + fill)."""
    img = np.full((160, 160, 3), 200, dtype=np.uint8)
    cv2.rectangle(img, (50, 40), (110, 130), (40, 40, 40), -1)
    params = VectorizeParams(
        mode="zigzag", run_spacing=8.0, blur_sigma=0.0, max_dim=1000
    )
    result = vectorize(_encode_png(img), params)
    assert result["polylines"]


def test_wave_rows_are_few_continuous_strokes():
    """Each row is one long stroke → far fewer polylines than a fragmented fill."""
    result = vectorize(_encode_png(_vertical_gradient(h=200, w=200)), _wave_params())
    polys = result["polylines"]
    # A 200px image at pitch 6 has ~33 rows; continuous rows keep the stroke
    # count on that order, not hundreds of fragments.
    assert 0 < len(polys) <= 80


def test_hatch_white_threshold_respected():
    """Raising white_threshold makes MORE of the image fillable (more fill)."""
    img = _horizontal_gradient()
    png = _encode_png(img)

    low = vectorize(png, _hatch_params(white_threshold=100))
    high = vectorize(png, _hatch_params(white_threshold=200))

    def total_len(res):
        return sum(_polyline_length_local(p) for p in res["polylines"])

    # A higher white threshold admits more (lighter) pixels into the fillable
    # region, so total fill length must not decrease — and here strictly grows.
    assert total_len(high) > total_len(low)


def _polyline_length_local(poly):
    total = 0.0
    for a, b in zip(poly, poly[1:]):
        total += ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5
    return total


def test_hatch_json_schema_and_bounds():
    """hatch output obeys the same JSON schema / coordinate bounds (Property 1)."""
    result = vectorize(_encode_png(_horizontal_gradient()), _hatch_params(edge_paths=True))
    w, h = result["width"], result["height"]
    assert w > 0 and h > 0
    for poly in result["polylines"]:
        assert isinstance(poly, list)
        for pt in poly:
            assert isinstance(pt, list) and len(pt) == 2
            x, y = pt
            assert isinstance(x, int) and isinstance(y, int)
            assert 0 <= x < w
            assert 0 <= y < h


# ---------------------------------------------------------------------------
# hatch feature pass — smooth centerline strokes, not jagged shards.
# ---------------------------------------------------------------------------
def _filled_circle(size: int = 256, radius: int = 80) -> np.ndarray:
    """White image with a solid black disk centered — a smooth curved edge."""
    img = np.full((size, size, 3), 255, dtype=np.uint8)
    cv2.circle(img, (size // 2, size // 2), radius, (0, 0, 0), -1)
    return img


def test_hatch_feature_pass_is_smooth_not_shards():
    """The feature pass must produce smooth centerline-ish strokes, not shards.

    Old behavior (Canny -> findContours -> approxPolyDP at the detail-derived
    epsilon ~12 px) collapsed features into jagged few-point triangles. The new
    pass (skeleton centerlines + a small-epsilon smooth outline) keeps curves
    smooth: the longest feature polyline must have FEW vertices relative to its
    pixel length — i.e. it is a confident simplified stroke, not a dense jagged
    trace, and not a 3-point triangle either.
    """
    from vectorize import hatch_feature_paths, HATCH_FEATURE_EPSILON_MAX

    assert HATCH_FEATURE_EPSILON_MAX <= 3.0, "feature epsilon clamp must stay small"

    img = _thick_plus(h=200, w=200, bar=24)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]

    params = _hatch_params(tone_bands=4, edge_paths=True)
    # epsilon arg is intentionally a large (detail-derived) value to prove the
    # feature pass clamps it to the small HATCH_FEATURE_EPSILON_MAX.
    polys = hatch_feature_paths(gray, params, epsilon=12.75, min_stroke_len=2.0,
                                image_size=(w, h))
    assert polys, "expected at least one feature polyline"

    longest = max(polys, key=lambda p: _polyline_length_local(p))
    length = _polyline_length_local(longest)
    verts = len(longest)

    # Smoothness pin: a jagged Canny-shard trace would carry roughly one vertex
    # every few pixels (verts ~ length / 3). A clean simplified stroke carries
    # far fewer. Require at least ~10 px of stroke per retained vertex.
    assert length > 0
    assert verts >= 2
    assert verts < length / 10.0, (
        f"feature polyline looks jagged: {verts} vertices over {length:.0f}px "
        f"(expected a smooth simplified stroke, not shards)"
    )


def test_hatch_feature_pass_is_deterministic():
    """Same bytes + params → identical feature-pass output (Property 2)."""
    img = _thick_l(h=200, w=200, bar=24)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    from vectorize import hatch_feature_paths

    params = _hatch_params(tone_bands=4, edge_paths=True)
    a = hatch_feature_paths(gray, params, epsilon=12.75, min_stroke_len=2.0,
                            image_size=(w, h))
    b = hatch_feature_paths(gray, params, epsilon=12.75, min_stroke_len=2.0,
                            image_size=(w, h))
    assert a == b


# ---------------------------------------------------------------------------
# hatch dark-feature detail pass — small very-dark features must survive.
# ---------------------------------------------------------------------------
def _face_like(size: int = 400) -> tuple:
    """Light-gray oval 'face' on white with two small BLACK 'eyes' and a black
    'mouth' bar. Returns (image, eye_centers, mouth_center) for localization.

    The eyes/mouth are SMALL but VERY DARK — exactly the features the ~3%
    min-length feature floor drops, so they exercise the detail sub-pass.
    """
    img = np.full((size, size, 3), 255, dtype=np.uint8)
    cx, cy = size // 2, size // 2
    # Light-gray oval face (value ~190 — lighter than white_threshold=130's
    # fill range so the face body itself reads as a blank silhouette).
    cv2.ellipse(img, (cx, cy), (size // 4, size // 3), 0, 0, 360, (190, 190, 190), -1)

    eye_dx = size // 10
    eye_y = cy - size // 12
    eye_r = max(4, size // 40)  # small (~10 px on a 400-px image)
    left_eye = (cx - eye_dx, eye_y)
    right_eye = (cx + eye_dx, eye_y)
    cv2.circle(img, left_eye, eye_r, (0, 0, 0), -1)
    cv2.circle(img, right_eye, eye_r, (0, 0, 0), -1)

    mouth_y = cy + size // 6
    mouth_half_w = size // 12
    mouth_half_h = max(2, size // 80)
    cv2.rectangle(
        img,
        (cx - mouth_half_w, mouth_y - mouth_half_h),
        (cx + mouth_half_w, mouth_y + mouth_half_h),
        (0, 0, 0),
        -1,
    )
    mouth_center = (cx, mouth_y)
    return img, [left_eye, right_eye], mouth_center


def _poly_bbox_center(poly):
    xs = [pt[0] for pt in poly]
    ys = [pt[1] for pt in poly]
    return ((min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0)


def _has_stroke_near(polylines, target, tol):
    tx, ty = target
    for poly in polylines:
        if len(poly) < 2:
            continue
        bx, by = _poly_bbox_center(poly)
        if abs(bx - tx) <= tol and abs(by - ty) <= tol:
            return True
    return False


def test_hatch_detail_pass_keeps_small_dark_face_features():
    """The dark-feature detail pass must localize strokes at the eyes/mouth.

    These small, very-dark features fall under the ~3% feature min-length floor,
    so without the detail sub-pass the face reads as a blank silhouette. Assert
    the feature pass produces strokes whose bounding boxes sit near each eye and
    the mouth.
    """
    from vectorize import hatch_feature_paths

    img, eye_centers, mouth_center = _face_like(size=400)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]

    params = _hatch_params(tone_bands=4, white_threshold=130, edge_paths=True)
    polys = hatch_feature_paths(gray, params, epsilon=12.75, min_stroke_len=8.0,
                                image_size=(w, h))
    assert polys, "expected feature polylines for a face-like fixture"

    tol = max(w, h) * 0.08  # localize within 8% of the larger dim
    for eye in eye_centers:
        assert _has_stroke_near(polys, eye, tol), (
            f"no feature stroke localized near eye {eye}; small dark features "
            f"were dropped"
        )
    assert _has_stroke_near(polys, mouth_center, tol), (
        f"no feature stroke localized near mouth {mouth_center}"
    )


def test_hatch_detail_pass_isolated_localizes_features():
    """The detail sub-pass on its own localizes near the eyes and mouth."""
    from vectorize import _dark_feature_detail_paths
    from vectorize import HATCH_FEATURE_EPSILON_MAX

    img, eye_centers, mouth_center = _face_like(size=400)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]

    polys = _dark_feature_detail_paths(gray, HATCH_FEATURE_EPSILON_MAX,
                                       image_size=(w, h))
    assert polys, "expected detail strokes for the small dark features"

    tol = max(w, h) * 0.08
    for eye in eye_centers:
        assert _has_stroke_near(polys, eye, tol)
    assert _has_stroke_near(polys, mouth_center, tol)


def test_hatch_detail_pass_white_yields_no_detail():
    """A pure-white image has no dark features → no detail strokes."""
    from vectorize import _dark_feature_detail_paths
    from vectorize import HATCH_FEATURE_EPSILON_MAX

    white = np.full((200, 200, 3), 255, dtype=np.uint8)
    gray = cv2.cvtColor(white, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    polys = _dark_feature_detail_paths(gray, HATCH_FEATURE_EPSILON_MAX,
                                       image_size=(w, h))
    assert polys == []


def test_hatch_detail_pass_is_deterministic():
    """Same bytes + params → identical detail-pass output (Property 2)."""
    from vectorize import _dark_feature_detail_paths
    from vectorize import HATCH_FEATURE_EPSILON_MAX

    img, _, _ = _face_like(size=400)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    a = _dark_feature_detail_paths(gray, HATCH_FEATURE_EPSILON_MAX, image_size=(w, h))
    b = _dark_feature_detail_paths(gray, HATCH_FEATURE_EPSILON_MAX, image_size=(w, h))
    assert a == b


# ---------------------------------------------------------------------------
# De-speckle + orphan-stub filtering in the vstep fill, and subject-mask
# silhouette smoothing. These keep the "detailed but crisp" fill: tonal
# modeling survives while the sparse high-frequency noise (specks a bright,
# low-contrast region posterizes into) and the ragged GrabCut boundary — both
# of which the physical machine thickens into junk — are removed.
# ---------------------------------------------------------------------------
def test_despeckle_mask_removes_small_speck_keeps_block():
    """OPEN erases an isolated speck but leaves a solid block essentially whole."""
    from vectorize import _despeckle_mask

    band = np.zeros((200, 200), dtype=bool)
    band[40:140, 40:140] = True  # large solid region (survives)
    band[10, 180] = True  # 1-px isolated speck (removed)
    band[12, 178:181] = True  # tiny 3-px fleck (removed)
    out = _despeckle_mask(band, 0.008, 200.0)
    assert not bool(out[10, 180]), "isolated speck should be opened away"
    assert not bool(out[12, 179]), "tiny fleck should be opened away"
    # The solid block core is preserved (open with a small kernel barely erodes).
    assert bool(out[90, 90])
    assert out[40:140, 40:140].mean() > 0.9


def test_despeckle_mask_frac_zero_is_noop():
    """frac <= 0 returns the mask untouched."""
    from vectorize import _despeckle_mask

    band = np.zeros((32, 32), dtype=bool)
    band[5, 5] = True
    out = _despeckle_mask(band, 0.0, 32.0)
    assert bool(out[5, 5])
    assert np.array_equal(out, band)


def test_vstep_fill_drops_isolated_specks_keeps_solid_shading():
    """A lone dark speck yields no fill ribbon; a solid dark block does — and
    every surviving ribbon clears the min-length floor (no orphan stubs)."""
    from vectorize import (
        vstep_serpentine_fill,
        _polyline_length,
        VSTEP_MIN_RUN_LEN_FRAC,
    )

    params = VectorizeParams(mode="zigzag", run_spacing=6.0, white_threshold=200)

    speck = np.full((200, 200), 240, dtype=np.uint8)
    speck[8:11, 170:173] = 10  # a single tiny dark fleck in a light field
    fg = np.ones((200, 200), dtype=bool)
    assert vstep_serpentine_fill(speck, params, foreground=fg) == []

    block = np.full((200, 200), 240, dtype=np.uint8)
    block[50:150, 50:150] = 10  # solid dark region → real shading
    ribbons = vstep_serpentine_fill(block, params, foreground=fg)
    assert ribbons, "a solid dark region must still produce fill ribbons"
    floor = VSTEP_MIN_RUN_LEN_FRAC * 200.0
    assert all(_polyline_length(r) >= floor for r in ribbons)


def test_vstep_fill_despeckle_is_deterministic():
    """Same input → identical fill (Property 2) through the new de-speckle path."""
    from vectorize import vstep_serpentine_fill

    params = VectorizeParams(mode="zigzag", run_spacing=6.0, white_threshold=200)
    gray = np.full((160, 160), 235, dtype=np.uint8)
    gray[40:120, 40:120] = 15
    fg = np.ones((160, 160), dtype=bool)
    a = vstep_serpentine_fill(gray, params, foreground=fg)
    b = vstep_serpentine_fill(gray, params, foreground=fg)
    assert a == b


def test_smooth_silhouette_reduces_boundary_roughness():
    """OPEN+CLOSE on a serrated silhouette shortens its contour perimeter while
    keeping the core area (a cleaner outline, same subject)."""
    from vectorize import _smooth_silhouette

    mask = np.zeros((200, 200), dtype=np.uint8)
    mask[60:160, 40:160] = 255  # solid body
    for x in range(40, 160, 6):  # comb of teeth on the top edge (serration)
        mask[45:60, x : x + 3] = 255

    def perim(m):
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        return max((cv2.arcLength(c, True) for c in cs), default=0.0)

    smoothed = _smooth_silhouette(mask, 0.03, 200.0)
    assert perim(smoothed) < perim(mask), "serrations should shorten the outline"
    # Core of the body is retained.
    assert smoothed[110, 100] == 255
    assert smoothed[60:160, 40:160].mean() > 0.9 * 255


def test_smooth_silhouette_frac_zero_is_noop():
    """frac <= 0 returns the silhouette untouched."""
    from vectorize import _smooth_silhouette

    mask = np.zeros((40, 40), dtype=np.uint8)
    mask[10:30, 10:30] = 255
    out = _smooth_silhouette(mask, 0.0, 40.0)
    assert np.array_equal(out, mask)


def test_focal_dark_blob_mask_keeps_feature_drops_speck():
    """A feature-scale locally-dark blob is focal; a lone tiny speck is not."""
    from vectorize import _focal_dark_blob_mask

    gray = np.full((400, 400), 220, dtype=np.uint8)
    gray[100:112, 100:112] = 40  # eye-scale blob (diag ~17px = 4% -> focal)
    gray[300:303, 300:303] = 40  # tiny speck (diag ~4px = 1% -> noise)
    fg = np.ones((400, 400), dtype=bool)
    focal = _focal_dark_blob_mask(gray, fg, 400.0)
    assert bool(focal[106, 106]), "eye-scale salient blob should be focal"
    assert not bool(focal[301, 301]), "a lone speck must stay non-focal"


def test_focal_dark_blob_mask_ignores_large_mass_interior():
    """A huge dark mass is not focal: its interior dominates its own local mean
    (not salient) and its bbox exceeds the ceiling. It never needed rescue —
    de-speckle keeps solid regions intact."""
    from vectorize import _focal_dark_blob_mask

    gray = np.full((400, 400), 220, dtype=np.uint8)
    gray[50:350, 50:350] = 30  # hair/hat-scale mass
    fg = np.ones((400, 400), dtype=bool)
    focal = _focal_dark_blob_mask(gray, fg, 400.0)
    assert not bool(focal[200, 200]), "large-mass interior must not be focal"


def test_vstep_fill_keeps_thin_dark_feature():
    """A thin lip-line-scale dark bar (narrower than the de-speckle kernel but
    focal-salient) keeps its fill; a lone speck still yields nothing."""
    from vectorize import vstep_serpentine_fill

    params = VectorizeParams(mode="zigzag", run_spacing=6.0, white_threshold=200)
    fg = np.ones((1000, 1000), dtype=bool)

    # 8px tall x 30px wide bar: the 9px de-speckle OPEN erases it outright
    # (min dimension below kernel), but it is exactly an eye / lip line.
    bar = np.full((1000, 1000), 235, dtype=np.uint8)
    bar[496:504, 485:515] = 20
    ribbons = vstep_serpentine_fill(bar, params, foreground=fg)
    near = [
        p
        for p in ribbons
        if any(480 <= x <= 520 and 490 <= y <= 510 for x, y in p)
    ]
    assert near, "a focal thin dark feature must keep fill ink"

    speck = np.full((1000, 1000), 235, dtype=np.uint8)
    speck[500:503, 500:503] = 20
    assert vstep_serpentine_fill(speck, params, foreground=fg) == []


def test_focal_rescue_is_deterministic():
    """Same input -> identical fill through the focal-rescue path."""
    from vectorize import vstep_serpentine_fill

    params = VectorizeParams(mode="zigzag", run_spacing=6.0, white_threshold=200)
    gray = np.full((1000, 1000), 235, dtype=np.uint8)
    gray[496:504, 485:515] = 20
    fg = np.ones((1000, 1000), dtype=bool)
    a = vstep_serpentine_fill(gray, params, foreground=fg)
    b = vstep_serpentine_fill(gray, params, foreground=fg)
    assert a == b


def test_polyline_touches_mask():
    """Vertex-on-mask membership, with out-of-bounds vertices ignored."""
    from vectorize import _polyline_touches_mask

    mask = np.zeros((50, 50), dtype=bool)
    mask[20:30, 20:30] = True
    assert _polyline_touches_mask([[0, 0], [25, 25]], mask)
    assert not _polyline_touches_mask([[0, 0], [10, 10]], mask)
    assert not _polyline_touches_mask([[-5, -5], [60, 60]], mask)
    assert not _polyline_touches_mask([[0, 0]], np.zeros((50, 50), dtype=bool))


# ---------------------------------------------------------------------------
# Transparent line-art / logo decode (white-on-transparent -> dark-ink matte).
# ---------------------------------------------------------------------------
def _encode_png_rgba(img: np.ndarray) -> bytes:
    """Encode a 4-channel BGRA ndarray to PNG bytes (alpha preserved)."""
    assert img.shape[2] == 4, "expected BGRA"
    ok, buf = cv2.imencode(".png", img)
    assert ok, "cv2.imencode failed to produce RGBA PNG bytes"
    return buf.tobytes()


def _white_plus_on_transparent(h: int = 64, w: int = 64, bar: int = 8) -> np.ndarray:
    """WHITE plus stroke, fully transparent everywhere else (BGRA).

    Mirrors a logo asset: the colour channels are white and the alpha channel is
    the only place the shape lives — the exact case that produced the onion-ring
    artefact when alpha was dropped.
    """
    bgra = np.zeros((h, w, 4), dtype=np.uint8)
    cy, cx = h // 2, w // 2
    half = bar // 2
    plus = np.zeros((h, w), dtype=bool)
    plus[cy - half : cy + half, :] = True
    plus[:, cx - half : cx + half] = True
    bgra[plus, :3] = 255  # white ink
    bgra[plus, 3] = 255  # opaque only on the stroke
    return bgra


def test_decode_white_on_transparent_becomes_dark_ink_matte():
    """_decode must invert alpha: opaque stroke -> dark, transparent -> white."""
    from vectorize import _decode

    bgra = _white_plus_on_transparent()
    decoded = _decode(_encode_png_rgba(bgra))
    gray = cv2.cvtColor(decoded, cv2.COLOR_BGR2GRAY)
    stroke = bgra[:, :, 3] > 128
    assert gray[stroke].mean() < 40, "opaque ink should decode dark"
    assert gray[~stroke].mean() > 200, "transparent area should decode as white paper"


def test_white_on_transparent_logo_skeletonizes_cleanly():
    """The onion-ring regression: a white-on-transparent shape must yield a small
    set of centerline strokes, not the doubled inner+outer nested contours that
    resulted from reading the transparent background as ink."""
    bgra = _white_plus_on_transparent()
    result = vectorize(_encode_png_rgba(bgra), _params(mode="skeleton"))
    polylines = result["polylines"]
    assert polylines, "white-on-transparent logo produced no strokes"
    # A plus is two crossing centerlines; allow a little fragmentation but reject
    # the many-nested-contour explosion the bug produced.
    assert len(polylines) <= 6, f"expected few centerlines, got {len(polylines)}"


def test_fully_opaque_rgba_is_composited_not_matted():
    """A fully-opaque RGBA image keeps its colour content (dark plus stays ink),
    rather than being force-inverted through the alpha-matte branch."""
    plus_bgr = _thick_plus()
    bgra = np.dstack([plus_bgr, np.full(plus_bgr.shape[:2], 255, np.uint8)])
    result = vectorize(_encode_png_rgba(bgra), _params(mode="skeleton"))
    assert result["polylines"], "opaque dark plus should still produce strokes"


# ---------------------------------------------------------------------------
# lineart mode — single-line outlines for logos: outer outline + SMALL holes
# (eyes / counters) kept, large inner-edge doublings dropped.
# ---------------------------------------------------------------------------
def _disk_with_small_hole(size: int = 400) -> np.ndarray:
    """Black filled disk on white with a tiny inner hole (an 'eye')."""
    img = np.full((size, size, 3), 255, dtype=np.uint8)
    c = size // 2
    cv2.circle(img, (c, c), size // 3, (0, 0, 0), thickness=-1)  # solid disk
    cv2.circle(img, (c, c), size // 40, (255, 255, 255), thickness=-1)  # small hole
    return img


def test_lineart_keeps_outer_outline_and_small_hole():
    """The mascot-eye case: a solid shape with a tiny hole yields the outer
    outline plus the small hole (both closed), not a scrambled skeleton."""
    result = vectorize(_encode_png(_disk_with_small_hole()), _params(mode="lineart"))
    polylines = result["polylines"]
    assert len(polylines) >= 2, "expected outer outline + the small hole"
    # Every lineart stroke is a closed loop (returns to its start).
    for poly in polylines:
        assert poly[0] == poly[-1], "lineart outlines must be closed loops"


def test_lineart_drops_thin_stroke_inner_edge_no_doubling():
    """A thin ring (hollow letter O) must trace as essentially ONE outline, not
    the doubled inner+outer edges that produced the onion-ring artefact."""
    size = 400
    img = np.full((size, size, 3), 255, dtype=np.uint8)
    c = size // 2
    cv2.circle(img, (c, c), size // 3, (0, 0, 0), thickness=6)  # thin ring
    result = vectorize(_encode_png(img), _params(mode="lineart"))
    # The large interior hole (inner edge of the thin ring) is dropped, so the
    # ring collapses to a single outer outline rather than two concentric loops.
    assert 1 <= len(result["polylines"]) <= 2, (
        f"thin ring should not double into many loops, got {len(result['polylines'])}"
    )
