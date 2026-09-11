#!/usr/bin/env python3
"""Tuning harness: vectorize a source photo through the local CV service,
rasterize the returned polylines, and (optionally) score the result against a
target line-drawing (Engineezy's outcome). Saves a PNG for human review.

Usage:
    python compare.py SOURCE [TARGET] [--mode contour] [--tone-bands 3] \
        [--detail 0.5] [--contrast 1.0] [--threshold 0] [--run-spacing 8] \
        [--white-threshold 130] [--edge-paths true] [--draw-connectors] \
        [--hide-connectors] [--two-opt] [--out out.png]

Connector preview (`--draw-connectors`)
---------------------------------------
A real Etch-a-Sketch pen never lifts, so the straight pen-up move between one
stroke's exit endpoint and the next stroke's entry endpoint is drawn as a
visible line. With `--draw-connectors` those inter-stroke connector segments
are rendered in light gray so the saved PNG previews what the PHYSICAL machine
actually draws, and the total connector travel is computed in the machine's
Chebyshev metric (`sum of max(|dx|, |dy|)` across all inter-stroke gaps).

Honest machine-order preview
----------------------------
The AUTHORITATIVE draw-order stage is the WEB planner (`stitchPolylines` /
`nn_order.ts`), NOT this service: the web pipeline RE-ORDERS the polylines it
receives, so the service's `order_nearest_neighbor` output never reaches the
machine. To preview the real machine order this harness imports the SAME
deterministic 2-opt pass the web uses (mirrored in `vectorize.two_opt_order`)
and applies it client-side. `--two-opt` renders the 2-opt order (the real
"after" the machine will draw); without it the plain greedy-NN order ("before")
is rendered. Either way both connector-travel numbers are printed so the
reduction is quantified.

Hidden connector routing preview (`--hide-connectors`)
------------------------------------------------------
The OPT-IN connector router (`web/src/path/connector_router.ts`, mirrored offline
in `vectorize.route_connectors_over_ink`) re-routes each inter-stroke connector
OVER already-drawn ink and envelope edges so the covered (Hidden) portion is
invisible and only the residual gap (Exposed) shows. With `--hide-connectors`
this harness weaves connectors over the running ink and renders only the Exposed
legs in connector-gray (Hidden legs are drawn invisibly, exactly as the physical
machine hides travel over existing ink). It also prints the total Exposed travel
BEFORE hiding (every connector's full Chebyshev length, all visible) vs AFTER
hiding (only the residual gap that could not be covered), alongside the existing
greedy-vs-2-opt connector-travel numbers. This flag is additive: without it the
behavior is unchanged.

Prints: polyline count, total segment length (a proxy for step count), a
structural-similarity score vs the target (when given), and the total
connector travel before (greedy NN) vs after (2-opt).
"""
import argparse

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter

from vectorize import (
    DrawnInkIndex,
    route_connector,
    total_connector_travel_chebyshev,
    total_exposed_travel_chebyshev,
    two_opt_order,
    _walk_line_steps,
)

CV_URL = "http://127.0.0.1:8765/vectorize"

# Light-gray fill (in 8-bit "L" space) used for the pen-up connector preview —
# distinct from the black (0) strokes so the diagonal connector ink reads as
# the faint travel lines the physical machine actually draws.
CONNECTOR_GRAY = 180

# Pen home before the first stroke (pixel space). Matches the web planner's
# default home / start used for the connector-travel objective.
START = (0.0, 0.0)


def _round_pt(p):
    """Coerce a point to integer motor steps (half-up), matching vectorize._ipt."""
    return (int(np.floor(float(p[0]) + 0.5)), int(np.floor(float(p[1]) + 0.5)))


def _route_exposed_runs(result, ink):
    """Split a routed connector into its maximal Exposed step-runs.

    Faithful to the router's own per-connector accounting: a straight FALLBACK
    connector (``fell_back``) charges its full Chebyshev length as Exposed, so it
    is rendered in one run regardless of geometry. A genuinely routed connector
    is walked in integer motor steps (the same DDA the router's ``classify_route``
    uses) and each step charged Hidden (covered by the ink at routing time) or
    Exposed (a visible gap); consecutive Exposed steps are grouped into one
    polyline run, while Hidden steps end the current run so they later draw
    invisibly. Returns a list of point-lists (pixel space) ready to rasterize in
    connector-gray. The total rendered length thus equals ``exposed_travel``.
    """
    points = result.points
    if result.fell_back:
        # Whole connector is visible Exposed travel (matches exposed_travel).
        return [[(p[0], p[1]) for p in points]] if len(points) >= 2 else []

    runs = []
    current = None
    for i in range(len(points) - 1):
        a = (int(points[i][0]), int(points[i][1]))
        b = (int(points[i + 1][0]), int(points[i + 1][1]))
        if a == b:
            continue
        prev = None
        for step in _walk_line_steps(a, b):
            if prev is not None:
                if ink.is_hidden(prev, step):
                    if current is not None and len(current) >= 2:
                        runs.append(current)
                    current = None
                else:
                    if current is None:
                        current = [prev]
                    current.append(step)
            prev = step
    if current is not None and len(current) >= 2:
        runs.append(current)
    return runs


def weave_hidden_for_render(polys, env, start=START):
    """Weave hidden connectors over the running ink for rendering.

    Mirrors ``vectorize.route_connectors_over_ink`` (same incremental ink index,
    same per-gap ``route_connector`` call, same commit order) but additionally
    captures, for each connector, the Exposed step-runs to draw in connector-gray
    using the ink committed at routing time. Returns the list of Exposed-run
    polylines (pixel space); Hidden travel is intentionally omitted so it renders
    invisibly.
    """
    env_t = (int(env[0]), int(env[1]))
    ink = DrawnInkIndex(env_t)
    exposed_runs = []
    cursor = _round_pt(start)
    for poly in polys:
        if len(poly) < 1:
            continue
        seg_start = _round_pt(poly[0])
        seg_end = _round_pt(poly[-1])
        if seg_start != cursor:
            result = route_connector(cursor, seg_start, ink, env_t)
            exposed_runs.extend(_route_exposed_runs(result, ink))
            ink.add(result.points)
        ink.add(poly)
        cursor = seg_end
    return exposed_runs


def vectorize(path, mode, tone_bands, detail, contrast, threshold,
              run_spacing=None, white_threshold=None, edge_paths=None):
    with open(path, "rb") as f:
        files = {"file": f}
        data = {
            "mode": mode,
            "detail": str(detail),
            "contrast": str(contrast),
            "tone_bands": str(tone_bands),
        }
        if threshold and float(threshold) > 0:
            data["threshold"] = str(threshold)
        if run_spacing is not None:
            data["run_spacing"] = str(run_spacing)
        if white_threshold is not None:
            data["white_threshold"] = str(white_threshold)
        if edge_paths is not None:
            data["edge_paths"] = "true" if edge_paths else "false"
        r = requests.post(CV_URL, files=files, data=data, timeout=120)
    r.raise_for_status()
    return r.json()


def rasterize(resp, order=None, out_w=512, draw_connectors=False,
              exposed_runs=None):
    """Rasterize polylines to an "L" image.

    Strokes are drawn black. When ``draw_connectors`` is set, the pen-up
    connector segments (``start -> first entry`` and every ``exit -> next
    entry``) are first drawn in light gray underneath the strokes, previewing
    the visible travel ink of a no-pen-lift machine.

    When ``exposed_runs`` is provided (``--hide-connectors`` mode) those
    precomputed Exposed connector legs are drawn in connector-gray instead; the
    Hidden legs are omitted entirely so they render invisibly, exactly as the
    router hides travel over already-drawn ink.

    ``order`` overrides ``resp["polylines"]`` so a re-ordered (e.g. 2-opt)
    sequence can be previewed; the geometry is identical, only the visit order
    and per-stroke orientation differ.
    """
    w, h = resp["width"], resp["height"]
    polys = order if order is not None else resp["polylines"]
    scale = out_w / w
    out_h = max(1, int(round(h * scale)))
    img = Image.new("L", (out_w, out_h), 255)
    d = ImageDraw.Draw(img)

    # Pass 1: connector travel (light gray), beneath the strokes.
    if exposed_runs is not None:
        # Hidden-routing preview: only the Exposed (visible) legs are inked;
        # Hidden legs are omitted so they read as invisible.
        for run in exposed_runs:
            if len(run) < 2:
                continue
            pts = [(p[0] * scale, p[1] * scale) for p in run]
            d.line(pts, fill=CONNECTOR_GRAY, width=1)
    elif draw_connectors:
        cx, cy = START
        for poly in polys:
            if len(poly) < 1:
                continue
            entry = poly[0]
            d.line(
                [(cx * scale, cy * scale), (entry[0] * scale, entry[1] * scale)],
                fill=CONNECTOR_GRAY,
                width=1,
            )
            cx, cy = poly[-1][0], poly[-1][1]

    # Pass 2: strokes (black) on top.
    total_len = 0.0
    for poly in polys:
        if len(poly) < 2:
            continue
        pts = [(p[0] * scale, p[1] * scale) for p in poly]
        d.line(pts, fill=0, width=1)
        for a, b in zip(pts, pts[1:]):
            total_len += ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5
    return img, total_len, len(polys)


def edge_map(gray_img, size=256):
    g = gray_img.convert("L").resize((size, size))
    e = g.filter(ImageFilter.FIND_EDGES)
    a = np.asarray(e)
    return a > 40  # boolean edge mask


def iou(a, b):
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter) / float(union) if union else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("target", nargs="?", default=None,
                    help="optional reference line-drawing for the IoU score")
    ap.add_argument("--mode", default="contour")
    ap.add_argument("--tone-bands", type=int, default=3)
    ap.add_argument("--detail", type=float, default=0.5)
    ap.add_argument("--contrast", type=float, default=1.0)
    ap.add_argument("--threshold", type=float, default=0)
    ap.add_argument("--run-spacing", type=float, default=None,
                    help="hatch: base fill-line spacing in px (smaller = denser)")
    ap.add_argument("--white-threshold", type=int, default=None,
                    help="hatch: pixels >= this (0..255) are never filled")
    ap.add_argument("--edge-paths", default=None,
                    help="hatch: 'true'/'false' — add the Canny edge pass")
    ap.add_argument("--draw-connectors", action="store_true",
                    help="draw the pen-up connector travel (light gray) the "
                         "physical machine actually inks, and report total "
                         "Chebyshev connector travel before vs after 2-opt")
    ap.add_argument("--hide-connectors", action="store_true",
                    help="route connectors over already-drawn ink: render only "
                         "the Exposed legs in connector-gray (Hidden legs are "
                         "invisible) and report total Exposed travel before vs "
                         "after hiding")
    ap.add_argument("--two-opt", action="store_true",
                    help="render the 2-opt-refined order (the real machine "
                         "order) instead of the plain greedy-NN order")
    ap.add_argument("--out", default="/tmp/compare.png")
    args = ap.parse_args()

    edge_paths = None
    if args.edge_paths is not None:
        edge_paths = str(args.edge_paths).strip().lower() in ("true", "1", "yes", "on")

    resp = vectorize(args.source, args.mode, args.tone_bands,
                     args.detail, args.contrast, args.threshold,
                     run_spacing=args.run_spacing,
                     white_threshold=args.white_threshold,
                     edge_paths=edge_paths)

    # The service returns greedy-NN-ordered polylines (the "before" order). The
    # web planner — the authoritative stage that actually reaches the machine —
    # additionally runs the deterministic 2-opt pass mirrored here, giving the
    # "after" order. Measure connector travel for both so the reduction is
    # quantified, and render whichever order was requested.
    greedy_order = resp["polylines"]
    two_opt = two_opt_order(greedy_order, START)
    travel_before = total_connector_travel_chebyshev(greedy_order, START)
    travel_after = total_connector_travel_chebyshev(two_opt, START)

    render_order = two_opt if args.two_opt else greedy_order

    # Hidden-routing preview: weave connectors over the running ink so only the
    # Exposed (visible) legs are rendered, and quantify Exposed travel before vs
    # after hiding. The inclusive integer Step_Envelope spans the raster bounds.
    exposed_runs = None
    exposed_before = exposed_after = None
    if args.hide_connectors:
        env = (int(round(resp["width"])), int(round(resp["height"])))
        exposed_runs = weave_hidden_for_render(render_order, env, START)
        # Before hiding every connector's full Chebyshev length is visible; after
        # hiding only the residual (uncoverable) gap remains Exposed.
        exposed_before = total_connector_travel_chebyshev(render_order, START)
        exposed_after = total_exposed_travel_chebyshev(render_order, env, START)

    ours, total_len, npolys = rasterize(
        resp, order=render_order, draw_connectors=args.draw_connectors,
        exposed_runs=exposed_runs,
    )

    score = None
    if args.target is not None:
        target = Image.open(args.target).convert("L")
        score = iou(edge_map(ours), edge_map(target))
        # Side-by-side: ours | target, matched heights.
        H = 512
        o = ours.resize((int(ours.width * H / ours.height), H))
        t = target.resize((int(target.width * H / target.height), H))
        combo = Image.new("L", (o.width + t.width + 10, H), 200)
        combo.paste(o, (0, 0))
        combo.paste(t, (o.width + 10, 0))
        combo.save(args.out)
    else:
        # No target: save the (connector-annotated) preview of our order alone.
        ours.save(args.out)

    print(f"mode={args.mode} tone_bands={args.tone_bands} detail={args.detail} "
          f"contrast={args.contrast} threshold={args.threshold} "
          f"run_spacing={args.run_spacing} white_threshold={args.white_threshold} "
          f"edge_paths={edge_paths}")
    rendered = "2-opt (after)" if args.two_opt else "greedy-NN (before)"
    iou_str = f"  edge_IoU_vs_target={score:.4f}" if score is not None else ""
    print(f"  polylines={npolys}  total_seg_len(px@512)={total_len:.0f}{iou_str}")
    if args.draw_connectors:
        reduction = travel_before - travel_after
        pct = (100.0 * reduction / travel_before) if travel_before else 0.0
        print(f"  connector_travel(chebyshev,px)  before(greedy-NN)={travel_before:.0f}  "
              f"after(2-opt)={travel_after:.0f}  reduction={reduction:.0f} ({pct:.1f}%)")
        print(f"  rendered order = {rendered}")
    if args.hide_connectors:
        hidden = exposed_before - exposed_after
        hpct = (100.0 * hidden / exposed_before) if exposed_before else 0.0
        print(f"  exposed_travel(chebyshev,px)  before(hiding-off)={exposed_before:.0f}  "
              f"after(hiding-on)={exposed_after:.0f}  hidden={hidden:.0f} ({hpct:.1f}%)")
        print(f"  rendered order = {rendered} (Exposed legs only; Hidden legs invisible)")
    print(f"  saved -> {args.out}")


if __name__ == "__main__":
    main()
