"""Cross-implementation parity fixture for the hidden-connector router.

OPTIONAL / DESCOPED (spec task 15.3). The web planner
(``web/src/path/connector_router.ts``) is the authoritative source of truth;
``vectorize.route_connector`` / ``route_connectors_over_ink`` are a pure Python
mirror used by the offline tuning harness (``compare.py``). This file pins the
two implementations together so the mirror cannot silently drift from the web
router's Exposed_Travel accounting (Req 1.1, 10.4).

How the EXPECTED_* constants were produced
-------------------------------------------
Each fixture below was run through the WEB router (``routeConnector`` for the
per-connector cases, ``stitchPolylinesWithReport`` for the woven-total case) and
the resulting Exposed_Travel — the visible residual a no-pen-lift Etch-a-Sketch
still draws between strokes — was recorded as the EXPECTED constant. The web
router is deterministic and pure (Req 3.1), so for these fixed inputs it always
yields exactly these values. The assertions then confirm the Python mirror
reproduces the same Exposed_Travel total, point-for-point, for identical inputs.

The fixtures are deliberately small and hand-reasoned so the expected values are
self-evident:

  * ``A`` collinear ink fully covering the gap  -> Exposed_Travel 0 (fully hidden)
  * ``B`` endpoints on the envelope edge        -> Exposed_Travel 0 (edge-hugged)
  * ``C`` empty ink set                          -> straight fallback, fully exposed
  * ``D`` ink covering only the middle of the gap-> Exposed_Travel = the two end gaps
  * ``E`` woven total over an ordered stroke list-> sum of per-connector Exposed

Inputs use integer motor-step coordinates and the inclusive Step_Envelope
``(env_x, env_y)`` exactly as the web router does, so "same inputs" is literal.
"""

from vectorize import (
    DrawnInkIndex,
    route_connector,
    total_exposed_travel_chebyshev,
)

# Shared inclusive Step_Envelope [0,100] x [0,100] for the single-connector cases.
ENV = (100, 100)


def _route(exit_pt, entry, inks, env=ENV):
    """Build a DrawnInkIndex from ``inks`` (a list of polylines) and route one
    connector from ``exit_pt`` to ``entry`` over it, mirroring the web router's
    incremental weave for a single gap."""
    ink = DrawnInkIndex(env)
    for poly in inks:
        ink.add(poly)
    return route_connector(exit_pt, entry, ink, env)


# -- Fixture A: collinear ink covering the gap -> fully hidden -----------------
# A horizontal groove spans y=50 across the whole width; the connector runs
# along it, so every step lands in existing ink and nothing is visible.
# Web router output: exposed=0, total=100, pts=[[10,50],[0,50],[90,50]].
EXPECTED_A_EXPOSED = 0


def test_parity_collinear_ink_fully_hides_connector():
    r = _route((10, 50), (90, 50), [[[0, 50], [100, 50]]])
    assert r.exposed_travel == EXPECTED_A_EXPOSED
    # Conservation (Req 10.4) and the web router's exact routed polyline.
    assert r.hidden_travel + r.exposed_travel == r.total_travel
    assert r.points == [[10, 50], [0, 50], [90, 50]]
    assert r.fell_back is False


# -- Fixture B: endpoints on the envelope edge -> edge-hugged, fully hidden ----
# Both endpoints sit on the left perimeter (x=0), which the router treats as
# zero-Exposed routable ink (Req 1.4), so the straight edge run is invisible.
# A single unrelated interior stroke is present only so the ink set is non-empty
# (an empty set short-circuits to the straight fallback per Req 6.3).
# Web router output: exposed=0, total=80, pts=[[0,10],[0,90]].
EXPECTED_B_EXPOSED = 0


def test_parity_envelope_edge_hug_fully_hides_connector():
    r = _route((0, 10), (0, 90), [[[50, 50], [60, 50]]])
    assert r.exposed_travel == EXPECTED_B_EXPOSED
    assert r.hidden_travel + r.exposed_travel == r.total_travel
    assert r.points == [[0, 10], [0, 90]]
    assert r.fell_back is False


# -- Fixture C: empty ink -> straight fallback, fully exposed ------------------
# No ink drawn yet, so the router emits the straight 2-point connector and
# charges its full Chebyshev length (max(|dx|,|dy|) = max(30,70) = 70) as
# Exposed_Travel. Web router output: exposed=70, total=70, fellBack=true.
EXPECTED_C_EXPOSED = 70


def test_parity_empty_ink_falls_back_to_straight_connector():
    r = _route((10, 10), (40, 80), [])
    assert r.exposed_travel == EXPECTED_C_EXPOSED
    assert r.hidden_travel == 0
    assert r.total_travel == EXPECTED_C_EXPOSED
    assert r.points == [[10, 10], [40, 80]]
    assert r.fell_back is True


# -- Fixture D: ink covers only the middle of the gap -> partial hide ----------
# The groove spans x=20..60 on y=50; the connector hides the covered middle and
# leaves the two uncovered end gaps (x 10->20 and 60->90) visible: 10 + 30 = 40.
# Web router output: exposed=40, hidden=40, total=80,
# pts=[[10,50],[20,50],[60,50],[90,50]].
EXPECTED_D_EXPOSED = 40


def test_parity_partial_cover_exposes_only_the_uncovered_gaps():
    r = _route((10, 50), (90, 50), [[[20, 50], [60, 50]]])
    assert r.exposed_travel == EXPECTED_D_EXPOSED
    assert r.hidden_travel == 40
    assert r.hidden_travel + r.exposed_travel == r.total_travel
    assert r.points == [[10, 50], [20, 50], [60, 50], [90, 50]]
    assert r.fell_back is False


# -- Fixture E: woven total over an ordered stroke list ------------------------
# Two short strokes on y=50 with a gap between them, woven from home (0,0):
#   * connector 1: (0,0) -> (10,50) routed over an empty index -> straight,
#     fully exposed: max(10,50) = 50.
#   * connector 2: (30,50) -> (70,50); the only prior ink (connector 1 + stroke 1)
#     does not bridge the gap, so it falls back to straight: 40 exposed.
# Total Exposed_Travel = 50 + 40 = 90. The web stitcher
# (stitchPolylinesWithReport with connectorHiding) produces the same total for
# the same already-ordered input.
ORDERED_STROKES = [
    [[10, 50], [30, 50]],
    [[70, 50], [90, 50]],
]
EXPECTED_E_TOTAL_EXPOSED = 90.0


def test_parity_woven_total_exposed_travel_matches_web():
    total = total_exposed_travel_chebyshev(ORDERED_STROKES, ENV, (0.0, 0.0))
    assert total == EXPECTED_E_TOTAL_EXPOSED
