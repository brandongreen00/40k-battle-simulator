"""Measurement primitives: engagement, coherency, unit-to-unit distance.

Core rules 03.04 (Engagement Range) is a *cylinder*: 2" horizontally AND 5"
vertically. Coherency (03.x) is 2" horizontal / 5" vertical to one other model,
and every model within 9" horizontal / 5" vertical of every other model; units
of 7+ models need two neighbours.
"""

from __future__ import annotations

from typing import Iterable, List, Optional, Tuple

from ..geometry import bases_overlap, dist, gap

ENGAGEMENT_HORIZONTAL = 2.0
ENGAGEMENT_VERTICAL = 5.0
COHERENCY_NEIGHBOUR = 2.0
COHERENCY_SPREAD = 9.0
COHERENCY_VERTICAL = 5.0


# --------------------------------------------------------------------------
# Geometry cache. Unit-to-unit distance is the hottest call in the engine
# (every enumeration, every heuristic score). Positions only change when the
# engine moves something, so results are memoised against an epoch counter
# that every mutation bumps. This is a cache, not an approximation: the values
# are identical to the uncached ones.
# --------------------------------------------------------------------------
_EPOCH = [0]
_GAP_CACHE: dict = {}
_VIS_CACHE: dict = {}


def bump_epoch() -> None:
    _EPOCH[0] += 1
    _GAP_CACHE.clear()
    _VIS_CACHE.clear()


def epoch() -> int:
    return _EPOCH[0]


def vis_cache() -> dict:
    return _VIS_CACHE


def model_gap(a, b) -> float:
    return gap(a.pos, a.base.avg_radius, b.pos, b.base.avg_radius)


def model_gap_3d(a, b) -> Tuple[float, float]:
    """(horizontal base-to-base gap, vertical separation)."""
    return model_gap(a, b), abs(a.z - b.z)


def unit_gap(a, b) -> float:
    """Closest base-to-base horizontal distance between two units."""
    key = (getattr(a, "uid", id(a)), getattr(b, "uid", id(b)))
    hit = _GAP_CACHE.get(key)
    if hit is not None:
        return hit
    value = _unit_gap_uncached(a, b)
    _GAP_CACHE[key] = value
    return value


def _unit_gap_uncached(a, b) -> float:
    am = getattr(a, "models", None)
    bm = getattr(b, "models", None)
    if am is None or bm is None:
        # allow measuring a unit against a bare point (objectives)
        return _gap_to_point(a, b)
    best = float("inf")
    for x in a.alive_models:
        for y in b.alive_models:
            d = model_gap(x, y)
            if d < best:
                best = d
                if best <= 0:
                    return 0.0
    return best


def _gap_to_point(a, b) -> float:
    pos = getattr(b, "pos", b)
    if not isinstance(pos, (tuple, list)):
        return float("inf")
    models = getattr(a, "models", None)
    if models is None:
        return dist(getattr(a, "pos", (0, 0)), tuple(pos))
    best = float("inf")
    for m in a.alive_models:
        best = min(best, max(0.0, dist(m.pos, tuple(pos)) - m.base.avg_radius))
    return best


def unit_wholly_within(a, b, d: float) -> bool:
    """Every model of ``a`` within ``d`` of ``b`` — distinct from ``within``."""
    models = getattr(a, "alive_models", [])
    if not models:
        return False
    for m in models:
        if _model_to_unit_gap(m, b) > d:
            return False
    return True


def _model_to_unit_gap(m, b) -> float:
    bm = getattr(b, "alive_models", None)
    if bm is None:
        pos = getattr(b, "pos", b)
        return max(0.0, dist(m.pos, tuple(pos)) - m.base.avg_radius)
    return min((model_gap(m, y) for y in bm), default=float("inf"))


def units_engaged(a, b) -> bool:
    """Engagement Range cylinder: 2" horizontal AND 5" vertical (03.04)."""
    for x in a.alive_models:
        for y in b.alive_models:
            h, v = model_gap_3d(x, y)
            if h <= ENGAGEMENT_HORIZONTAL and v <= ENGAGEMENT_VERTICAL:
                return True
    return False


def unit_engaged(state, unit) -> bool:
    if unit is None or unit.destroyed or unit.in_reserves or unit.embarked_in:
        return False
    for other in state.units.values():
        if other.destroyed or other.owner == unit.owner or other.in_reserves or other.embarked_in:
            continue
        if units_engaged(unit, other):
            return True
    return False


def engaged_enemies(state, unit) -> List:
    out = []
    for other in state.units.values():
        if other.destroyed or other.owner == unit.owner or other.in_reserves or other.embarked_in:
            continue
        if units_engaged(unit, other):
            out.append(other)
    return out


def within_engagement_of_any_enemy(state, unit, positions=None) -> bool:
    return unit_engaged(state, unit)


def coherency_ok(unit) -> bool:
    """2"/5" to a neighbour (two neighbours at 7+ models) and 9"/5" spread."""
    models = unit.alive_models
    n = len(models)
    if n <= 1:
        return True
    need = 2 if n >= 7 else 1
    for i, m in enumerate(models):
        neighbours = 0
        for j, o in enumerate(models):
            if i == j:
                continue
            h, v = model_gap_3d(m, o)
            if h <= COHERENCY_NEIGHBOUR and v <= COHERENCY_VERTICAL:
                neighbours += 1
            if h > COHERENCY_SPREAD or v > COHERENCY_VERTICAL:
                return False
        if neighbours < need:
            return False
    return True


def unit_centroid(unit) -> Tuple[float, float]:
    models = unit.alive_models
    if not models:
        return (0.0, 0.0)
    return (
        sum(m.pos[0] for m in models) / len(models),
        sum(m.pos[1] for m in models) / len(models),
    )


def any_base_overlap(unit, others: Iterable) -> bool:
    """Bases may touch, never stack."""
    for m in unit.alive_models:
        for o in others:
            if o is unit:
                continue
            for om in o.alive_models:
                if bases_overlap(m.pos, m.base, om.pos, om.base):
                    return True
    return False


def internal_overlap(unit) -> bool:
    models = unit.alive_models
    for i, m in enumerate(models):
        for o in models[i + 1:]:
            if bases_overlap(m.pos, m.base, o.pos, o.base):
                return True
    return False
