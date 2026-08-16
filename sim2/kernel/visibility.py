"""Terrain, visibility, cover and detection (core rules 06, 13, 22.05).

Implemented here:

* **Obscuring** — a terrain area containing light or dense features blocks line
  of sight drawn *across* it, unless one endpoint model is inside that area.
* **Solid** — dense features block line of sight to models within the same area
  when the sightline is at ground level (the <=3" band).
* **Benefit of Cover** — worsens the attacker's Ballistic/Weapon Skill by 1
  (11th edition makes cover a BS penalty, not a save bonus).
* **Hidden / Gone to Ground** — INFANTRY/BEASTS/SWARM in an area containing
  light or dense features that made no ranged attacks this or last turn are
  visible only within their detection range. Detection range is a **modifiable
  per-unit-pair quantity** (§3.5 #18), not a constant.
* **Plunging Fire** (22.05).

The 1mm-line rule is approximated by sampling silhouette points (see
``geometry.LOS_SAMPLES``); ``tests_py/test_geometry.py`` bounds the error.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from ..geometry import (
    base_within_polygon,
    dist,
    point_in_polygon,
    polygon_bounds,
    segment_crosses_polygon,
    silhouette_points,
)

HIDDEN_RANGE = 15.0
GONE_TO_GROUND_RANGE = 12.0
SOLID_GROUND_BAND = 3.0
PLUNGING_FIRE_HEIGHT = 6.0


# --------------------------------------------------------------------------
# terrain queries
#
# Which areas a model stands in is asked constantly (every sightline, every
# cover check). It only changes when models move, so it is memoised against
# the geometry epoch in :mod:`sim2.kernel.measure`. Sightlines then only test
# the areas whose bounding box the segment can actually reach.
# --------------------------------------------------------------------------
def _area_index(state):
    from . import measure

    cache = measure.vis_cache()
    idx = cache.get("__areas__")
    if idx is None:
        idx = [(a, polygon_bounds(a.polygon)) for a in state.layout.terrain]
        cache["__areas__"] = idx
    return idx


def areas_containing_model(state, model) -> List:
    from . import measure

    cache = measure.vis_cache()
    key = ("in", id(model))
    hit = cache.get(key)
    if hit is None:
        hit = [
            area for area, _ in _area_index(state)
            if base_within_polygon(model.pos, model.base.avg_radius, area.polygon)
        ]
        cache[key] = hit
    return hit


def unit_in_terrain_area(state, unit) -> bool:
    return any(areas_containing_model(state, m) for m in unit.alive_models)


def unit_wholly_in_area(state, unit, area) -> bool:
    return all(
        point_in_polygon(m.pos, area.polygon) for m in unit.alive_models
    ) and bool(unit.alive_models)


# --------------------------------------------------------------------------
# line of sight
# --------------------------------------------------------------------------
def point_los_blocked(state, a_pos, b_pos, a_model=None, b_model=None) -> bool:
    """Obscuring + Solid, evaluated for one sightline."""
    a_areas = {id(x) for x in areas_containing_model(state, a_model)} if a_model else set()
    b_areas = {id(x) for x in areas_containing_model(state, b_model)} if b_model else set()
    lo_x, hi_x = (a_pos[0], b_pos[0]) if a_pos[0] <= b_pos[0] else (b_pos[0], a_pos[0])
    lo_y, hi_y = (a_pos[1], b_pos[1]) if a_pos[1] <= b_pos[1] else (b_pos[1], a_pos[1])

    for area, (x0, y0, x1, y1) in _area_index(state):
        if not area.obscuring:
            continue
        if hi_x < x0 or lo_x > x1 or hi_y < y0 or lo_y > y1:
            continue                      # the sightline cannot reach this area
        a_in = id(area) in a_areas or point_in_polygon(a_pos, area.polygon)
        b_in = id(area) in b_areas or point_in_polygon(b_pos, area.polygon)
        if a_in and b_in:
            # Both inside the same area: Solid blocks dense features at the
            # ground band; otherwise models in one area see each other.
            if area.category == "dense":
                za = getattr(a_model, "z", 0.0) if a_model else 0.0
                zb = getattr(b_model, "z", 0.0) if b_model else 0.0
                if za <= SOLID_GROUND_BAND and zb <= SOLID_GROUND_BAND and dist(a_pos, b_pos) > 2.0:
                    return True
            continue
        if a_in or b_in:
            continue                      # a model in an area can see out, and be seen
        if segment_crosses_polygon(a_pos, b_pos, area.polygon):
            return True
    return False


#: Perimeter samples used only when the centre line is blocked. The full
#: silhouette sweep is quadratic in this number, so it stays small; the error
#: this introduces is bounded by ``tests_py/test_geometry.py``.
EDGE_SAMPLES = 4


def model_visible(state, watcher, target) -> bool:
    """Any part of the target visible to any part of the watcher (06.01)."""
    if not point_los_blocked(state, watcher.pos, target.pos, watcher, target):
        return True
    for a in silhouette_points(watcher.pos, watcher.base, EDGE_SAMPLES):
        for b in silhouette_points(target.pos, target.base, EDGE_SAMPLES):
            if not point_los_blocked(state, a, b, watcher, target):
                return True
    return False


def model_fully_visible(state, watcher, target) -> bool:
    """Every sampled silhouette point visible — a distinct state (06.x)."""
    for b in silhouette_points(target.pos, target.base, EDGE_SAMPLES):
        if point_los_blocked(state, watcher.pos, b, watcher, target):
            return False
    return True


def unit_visible(state, watcher_unit, target_unit) -> bool:
    from . import measure

    cache = measure.vis_cache()
    key = ("vis", watcher_unit.uid, target_unit.uid)
    hit = cache.get(key)
    if hit is not None:
        return hit
    value = _unit_visible_uncached(state, watcher_unit, target_unit)
    cache[key] = value
    return value


def _unit_visible_uncached(state, watcher_unit, target_unit) -> bool:
    from . import measure

    # Closest model pairs first: when a unit is visible at all it is almost
    # always visible along the shortest sightline, so this exits immediately.
    pairs = sorted(
        ((measure.model_gap(w, t), i, j, w, t)
         for i, w in enumerate(watcher_unit.alive_models)
         for j, t in enumerate(target_unit.alive_models)),
        key=lambda x: x[0],
    )
    for _, _, _, w, t in pairs:
        if model_visible(state, w, t):
            return True
    return False


def unit_fully_visible(state, watcher_unit, target_unit) -> bool:
    for t in target_unit.alive_models:
        if not any(model_fully_visible(state, w, t) for w in watcher_unit.alive_models):
            return False
    return bool(target_unit.alive_models)


def models_that_can_see(state, shooter_unit, target_unit) -> List:
    """Per-model visibility: only bearers with their own sightline may shoot."""
    return [
        w for w in shooter_unit.alive_models
        if any(model_visible(state, w, t) for t in target_unit.alive_models)
    ]


# --------------------------------------------------------------------------
# Hidden / Gone to Ground / detection
# --------------------------------------------------------------------------
def is_hidden(state, unit) -> bool:
    """INFANTRY/BEASTS/SWARM in an area with light or dense features that has
    made no ranged attacks this turn or last turn."""
    if not any(unit.has_keyword(k) for k in ("INFANTRY", "BEASTS", "SWARM")):
        return False
    if unit.flags.get("low_profile"):
        pass  # Low Profile: shooting does not break Hidden (data-granted)
    elif unit.last_shot_round >= state.battle_round - 1 and unit.last_shot_round >= 0:
        return False
    for m in unit.alive_models:
        areas = areas_containing_model(state, m)
        if not any(a.category in ("light", "dense") for a in areas):
            return False
    return bool(unit.alive_models)


def detection_range(state, watcher_unit, target_unit) -> float:
    """Modifiable per-unit-pair quantity (§3.5 #18)."""
    base = HIDDEN_RANGE
    if target_unit.flags.get("gone_to_ground"):
        base = GONE_TO_GROUND_RANGE
    bonus = 0.0
    bonus += float(target_unit.flags.get("detection_penalty", 0.0)) * -1
    bonus += float(watcher_unit.flags.get("detection_bonus", 0.0))
    if target_unit.flags.get("designated_by", -1) == watcher_unit.owner:
        bonus += float(state.players[watcher_unit.owner].army_state.get("designation_bonus", 0.0))
    return max(0.0, base + bonus)


def hidden_blocks_targeting(state, shooter_unit, target_unit) -> bool:
    from . import measure

    if not is_hidden(state, target_unit):
        return False
    rng = detection_range(state, shooter_unit, target_unit)
    return measure.unit_gap(shooter_unit, target_unit) > rng


# --------------------------------------------------------------------------
# cover
# --------------------------------------------------------------------------
def has_benefit_of_cover(state, shooter_unit, target_unit) -> bool:
    """INFANTRY/BEASTS/SWARM within a terrain area, or any unit not fully
    visible past an intervening feature or area."""
    if target_unit.flags.get("no_cover_from_effects"):
        return False
    if target_unit.flags.get("granted_cover"):
        return True
    infantry_like = any(target_unit.has_keyword(k) for k in ("INFANTRY", "BEASTS", "SWARM"))
    if infantry_like and unit_in_terrain_area(state, target_unit):
        return True
    if not unit_fully_visible(state, shooter_unit, target_unit):
        # not fully visible because terrain intervenes
        return _intervening_terrain(state, shooter_unit, target_unit)
    return False


def _intervening_terrain(state, shooter_unit, target_unit) -> bool:
    for w in shooter_unit.alive_models:
        for t in target_unit.alive_models:
            for area in state.layout.terrain:
                if area.category == "exposed":
                    continue
                if point_in_polygon(w.pos, area.polygon) or point_in_polygon(t.pos, area.polygon):
                    continue
                if segment_crosses_polygon(w.pos, t.pos, area.polygon):
                    return True
    return False


def plunging_fire(state, shooter_unit, target_unit) -> bool:
    """22.05 — every shooting model at least 6" above the target's level."""
    if not shooter_unit.alive_models or not target_unit.alive_models:
        return False
    lowest_shooter = min(m.z for m in shooter_unit.alive_models)
    highest_target = max(m.z for m in target_unit.alive_models)
    return lowest_shooter - highest_target >= PLUNGING_FIRE_HEIGHT
