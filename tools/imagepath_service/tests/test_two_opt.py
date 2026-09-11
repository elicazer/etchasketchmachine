"""Tests for the deterministic 2-opt connector-travel reduction pass.

The pass mirrors ``twoOptReorder`` in ``web/src/path/nn_order.ts`` and is the
client-side preview the tuning harness uses to reflect the real machine order
(the WEB planner is the authoritative draw-order stage). These tests pin down:

  * Reduction: total Chebyshev connector travel after 2-opt <= before
    (greedy NN), on a synthetic set of scattered strokes.
  * Determinism (Property 2): identical inputs -> identical output, no
    randomness.
  * Stroke set preserved: the same strokes and geometry survive — only their
    order and per-stroke orientation may change; none are merged or dropped.
"""

import random

from vectorize import (
    order_nearest_neighbor,
    total_connector_travel_chebyshev,
    two_opt_order,
)


def _scattered_strokes(n: int, seed: int, span: int = 1000):
    """Build ``n`` short two-point strokes at deterministic random positions."""
    rng = random.Random(seed)
    polys = []
    for _ in range(n):
        x0, y0 = rng.randint(0, span), rng.randint(0, span)
        x1, y1 = rng.randint(0, span), rng.randint(0, span)
        polys.append([[x0, y0], [x1, y1]])
    return polys


def _endpoint_multiset(polys):
    """Canonical multiset of each stroke's unordered endpoint pair.

    Orientation- and order-independent, so it is invariant under the 2-opt
    moves (reorder + per-stroke flip) but sensitive to any merge/drop/geometry
    change.
    """
    return sorted(
        tuple(sorted((tuple(p[0]), tuple(p[-1])))) for p in polys
    )


def test_two_opt_reduces_or_preserves_connector_travel():
    polys = _scattered_strokes(60, seed=7)
    greedy = order_nearest_neighbor(polys, (0.0, 0.0))
    refined = two_opt_order(greedy, (0.0, 0.0))

    before = total_connector_travel_chebyshev(greedy, (0.0, 0.0))
    after = total_connector_travel_chebyshev(refined, (0.0, 0.0))
    assert after <= before


def test_two_opt_strictly_reduces_on_an_adversarial_order():
    # A deliberately bad order (greedy alone leaves long back-and-forth hops):
    # four strokes whose naive sequence zig-zags across the field.
    polys = [
        [[0, 0], [10, 0]],
        [[0, 500], [10, 500]],
        [[20, 0], [30, 0]],
        [[20, 500], [30, 500]],
    ]
    refined = two_opt_order(polys, (0.0, 0.0))
    before = total_connector_travel_chebyshev(polys, (0.0, 0.0))
    after = total_connector_travel_chebyshev(refined, (0.0, 0.0))
    assert after < before


def test_two_opt_is_deterministic():
    polys = _scattered_strokes(40, seed=11)
    greedy = order_nearest_neighbor(polys, (0.0, 0.0))
    a = two_opt_order(greedy, (0.0, 0.0))
    b = two_opt_order(greedy, (0.0, 0.0))
    assert a == b


def test_two_opt_preserves_the_stroke_set():
    polys = _scattered_strokes(50, seed=3)
    greedy = order_nearest_neighbor(polys, (0.0, 0.0))
    refined = two_opt_order(greedy, (0.0, 0.0))

    # Same number of strokes — none merged or dropped.
    assert len(refined) == len(greedy)
    # Same strokes and geometry (order/orientation aside).
    assert _endpoint_multiset(refined) == _endpoint_multiset(greedy)


def test_two_opt_handles_trivial_inputs():
    assert two_opt_order([], (0.0, 0.0)) == []
    single = [[[5, 5], [9, 9]]]
    assert two_opt_order(single, (0.0, 0.0)) == single
    # Input is not mutated (a copy is returned).
    assert two_opt_order(single, (0.0, 0.0)) is not single
