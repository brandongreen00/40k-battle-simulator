"""Geometry: base-to-base distance, engagement cylinder, coherency, LoS bounds."""

import math

from sim2.geometry import (
    BaseShape,
    base_within_polygon,
    base_wholly_within_polygon,
    point_in_polygon,
    segment_crosses_polygon,
    silhouette_points,
)
from sim2.kernel import measure
from sim2.kernel.state import ModelState, UnitState


def mk_model(x, y, mm=32, z=0.0, uid="m"):
    return ModelState(uid, "ds", (x, y), 1, 1, BaseShape.circle_mm(mm), z=z)


def mk_unit(positions, owner=0, uid="u", mm=32):
    u = UnitState(uid=uid, owner=owner, datasheet_id="ds", name="unit")
    u.models = [mk_model(x, y, mm, uid=f"{uid}~{i}") for i, (x, y) in enumerate(positions)]
    u.starting_models = len(u.models)
    u.starting_wounds = len(u.models)
    return u


def test_base_to_base_distance():
    """Two 32mm bases 2" apart centre-to-centre are ~0.74" apart, not 2"."""
    a, b = mk_model(0, 0), mk_model(2, 0)
    assert abs(measure.model_gap(a, b) - 0.7402) < 0.01


def test_engagement_range_is_a_cylinder():
    a = mk_unit([(0, 0)])
    # 2" horizontal gap is inside Engagement Range...
    b = mk_unit([(2.5, 0)], owner=1, uid="v")
    assert measure.units_engaged(a, b)
    # ...but not once the vertical separation passes 5"
    b.models[0].z = 6.0
    assert not measure.units_engaged(a, b)
    b.models[0].z = 4.0
    assert measure.units_engaged(a, b)


def test_coherency_two_neighbours_at_seven_models():
    line = [(i * 1.5, 0) for i in range(6)]
    assert measure.coherency_ok(mk_unit(line))
    # a 7th model makes the two-neighbour rule bite on the end models
    seven = mk_unit([(i * 1.9, 0) for i in range(7)])
    assert not measure.coherency_ok(seven)
    tight = mk_unit([(i * 0.9, 0) for i in range(7)])
    assert measure.coherency_ok(tight)


def test_coherency_spread_limit():
    spread = mk_unit([(0, 0), (1, 0), (12, 0)])
    assert not measure.coherency_ok(spread)


def test_within_vs_wholly_within_are_distinct():
    square = [(0, 0), (10, 0), (10, 10), (0, 10)]
    centre, radius = (0.2, 5.0), 0.63
    assert base_within_polygon(centre, radius, square)
    assert not base_wholly_within_polygon(centre, radius, square)
    assert base_wholly_within_polygon((5, 5), radius, square)


def test_bases_may_touch_but_not_stack():
    a, b = mk_model(0, 0), mk_model(1.26, 0)      # 32mm bases just touching
    assert not measure.internal_overlap(mk_unit([(0, 0), (1.26, 0)]))
    close = mk_unit([(0, 0), (0.5, 0)])
    assert measure.internal_overlap(close)


def test_los_sampling_error_bound():
    """The silhouette sampling must not claim visibility the exact geometry
    denies by more than the sample spacing allows.

    A blocker wider than the sampling chord can never be tunnelled through: for
    every sampled endpoint pair, if the exact segment between the base centres
    is blocked and the blocker spans more than the base diameter, the sampled
    pairs are blocked too.
    """
    blocker = [(4.0, -6.0), (6.0, -6.0), (6.0, 6.0), (4.0, 6.0)]
    a, b = (0.0, 0.0), (10.0, 0.0)
    shape = BaseShape.circle_mm(32)
    for pa in silhouette_points(a, shape):
        for pb in silhouette_points(b, shape):
            assert segment_crosses_polygon(pa, pb, blocker)


def test_point_in_polygon_basic():
    square = [(0, 0), (4, 0), (4, 4), (0, 4)]
    assert point_in_polygon((2, 2), square)
    assert not point_in_polygon((5, 2), square)
