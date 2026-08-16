"""Movement (core rules 03, 09, 11, 20, 21).

Positions are continuous. A unit move is a rigid translate of every model
(coherency-preserving by construction) followed by per-model legality checks:
board bounds, base overlap (bases may touch, never stack), coherency, and the
phase's engagement constraints.

Move types are distinct *modes* with their own eligibility and after-clauses:
Remain Stationary (09.04), Normal (09.05), Advance (09.06), Fall Back (09.07,
with Ordered Retreat vs Desperate Escape).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Tuple

from ..geometry import clamp_to_board, dist, norm, step_towards
from . import measure
from .datacache import unit_move

MoveResult = Tuple[bool, str]


@dataclass
class MoveBudget:
    base: float
    advance_roll: int = 0
    total: float = 0.0
    mode: str = "normal"


def move_budget(state, interp, unit, mode: str, rng=None) -> MoveBudget:
    mods = interp.unit_mods(state, unit)
    base = (unit_move(state, unit) + mods.move_mod) * mods.move_multiplier
    base = max(0.0, base)
    b = MoveBudget(base=base, total=base, mode=mode)
    if mode == "advance":
        roll = rng.roll(1, 6, kind="advance", note=unit.name)[0] if rng else 0
        roll += mods.advance_mod
        b.advance_roll = roll
        b.total = base + max(0, roll)
    elif mode == "stationary":
        b.total = 0.0
    return b


def translate_unit(unit, delta: Tuple[float, float], layout) -> None:
    for m in unit.alive_models:
        p = (m.pos[0] + delta[0], m.pos[1] + delta[1])
        m.pos = clamp_to_board(p, layout.width, layout.height, m.base.avg_radius)
    measure.bump_epoch()


def unit_move_distance(unit, delta: Tuple[float, float]) -> float:
    return math.hypot(delta[0], delta[1])


def try_move(
    state,
    interp,
    unit,
    dest: Tuple[float, float],
    mode: str,
    rng=None,
    budget: Optional[MoveBudget] = None,
) -> MoveResult:
    """Move a unit so its centroid heads toward ``dest``. Returns (ok, reason)."""
    if unit.moved:
        return False, "unit has already moved this turn"
    if unit.embarked_in:
        return False, "unit is embarked"
    if unit.in_reserves:
        return False, "unit is in reserves"

    engaged = measure.unit_engaged(state, unit)
    if mode in ("normal", "advance") and engaged:
        return False, "unit is within Engagement Range (must Fall Back or Remain Stationary)"
    if mode == "fall_back" and not engaged:
        return False, "unit is not within Engagement Range"

    b = budget or move_budget(state, interp, unit, mode, rng)
    centroid = measure.unit_centroid(unit)
    target = step_towards(centroid, dest, b.total)
    delta = (target[0] - centroid[0], target[1] - centroid[1])
    before = [m.pos for m in unit.models]

    # A move action means "move toward this point as far as this unit legally
    # can", which is what a player does at the table: they slide the unit up
    # until something stops it. The engine resolves the furthest legal end
    # position by backing off along the path, so a legal action can never be
    # rejected for ending somewhere illegal (§ legal.py).
    ok_fraction = _furthest_legal(state, unit, delta, mode, before)
    if ok_fraction <= 0.0:
        for m, p in zip(unit.models, before):
            m.pos = p
        if mode == "fall_back":
            return False, "no legal Fall Back move leaves Engagement Range"
        unit.moved = True
        unit.move_mode = "stationary"
        state.emit("move_blocked", unit=unit.uid, mode=mode)
        return True, "no legal ground gained; the unit Remained Stationary"

    applied = (delta[0] * ok_fraction, delta[1] * ok_fraction)
    for m, p in zip(unit.models, before):
        m.pos = p
    translate_unit(unit, applied, state.layout)
    travelled = unit_move_distance(unit, applied)

    unit.moved = True
    unit.move_mode = mode
    unit.advanced_roll = b.advance_roll
    if mode == "fall_back":
        _desperate_escape(state, rng, interp, unit)
    state.emit("move", unit=unit.uid, mode=mode, distance=round(travelled, 2))
    return True, ""


def _furthest_legal(state, unit, delta, mode: str, before) -> float:
    """Binary-search the largest fraction of ``delta`` that ends legally."""
    lo, hi = 0.0, 1.0
    if _legal_at(state, unit, delta, mode, before):
        return 1.0
    for _ in range(7):
        mid = (lo + hi) / 2.0
        step = (delta[0] * mid, delta[1] * mid)
        if _legal_at(state, unit, step, mode, before):
            lo = mid
        else:
            hi = mid
    return lo


def _legal_at(state, unit, delta, mode: str, before) -> bool:
    for m, p in zip(unit.models, before):
        m.pos = p
    measure.bump_epoch()
    translate_unit(unit, delta, state.layout)
    others = [u for u in state.units.values()
              if u is not unit and not u.destroyed and not u.in_reserves and not u.embarked_in]
    ok = True
    if measure.any_base_overlap(unit, others) or measure.internal_overlap(unit):
        ok = False
    elif not measure.coherency_ok(unit):
        ok = False
    elif mode in ("normal", "advance") and measure.unit_engaged(state, unit):
        # a Normal or Advance move may not END within Engagement Range (09.05)
        ok = False
    elif mode == "fall_back" and measure.unit_engaged(state, unit):
        ok = False
    for m, p in zip(unit.models, before):
        m.pos = p
    measure.bump_epoch()
    return ok


def _desperate_escape(state, rng, interp, unit) -> None:
    """09.07.01 — a Battle-shocked unit (or one otherwise required to) taking a
    Fall Back move rolls Desperate Escape: 1-2 destroys a model."""
    if not unit.battle_shocked:
        return
    from .attacks import _check_destroyed

    losses = 0
    for model in list(unit.alive_models):
        roll = rng.roll(1, 6, kind="desperate_escape", note=unit.name)[0] if rng else 6
        if roll <= 2:
            model.alive = False
            model.wounds = 0
            losses += 1
    if losses:
        state.emit("desperate_escape", unit=unit.uid, losses=losses)
        _check_destroyed(state, unit)


# --------------------------------------------------------------------------
# Charges (11)
# --------------------------------------------------------------------------
def charge_roll(state, interp, unit, rng) -> int:
    """11e rolls the 2D6 FIRST; targets are selected afterwards."""
    rolls = rng.two_d6(note=f"charge {unit.name}")
    total = sum(rolls)
    if rolls == [1, 1]:
        state.emit("charge_auto_fail", unit=unit.uid)
        return 0                      # double 1 always fails (rules appendix)
    mods = interp.unit_mods(state, unit)
    return max(0, total + mods.charge_mod)


def try_charge(state, interp, unit, targets, distance: float, rng) -> MoveResult:
    """Move into Engagement Range of every declared target within ``distance``."""
    if not targets:
        return False, "no charge targets"
    if unit.charge_attempted:
        return False, "unit already declared a charge this phase"
    unit.charge_attempted = True

    start = measure.unit_centroid(unit)
    best: Optional[Tuple[float, Tuple[float, float]]] = None
    for tgt in targets:
        aim = measure.unit_centroid(tgt)
        direction = norm((aim[0] - start[0], aim[1] - start[1]))
        for frac in [i / 20.0 for i in range(1, 21)]:
            for spread in (0.0, 0.4, -0.4, 0.8, -0.8):
                ang = math.atan2(direction[1], direction[0]) + spread
                step = distance * frac
                cand = (start[0] + math.cos(ang) * step, start[1] + math.sin(ang) * step)
                score = _charge_score(state, unit, cand, targets)
                if score is None:
                    continue
                if best is None or score < best[0]:
                    best = (score, cand)
    if best is None:
        return False, "no legal charge move reaches every target"

    delta = (best[1][0] - start[0], best[1][1] - start[1])
    if unit_move_distance(unit, delta) > distance + 1e-6:
        return False, "charge distance insufficient"
    translate_unit(unit, delta, state.layout)
    unit.charged = True
    unit.moved = True
    state.emit("charge", unit=unit.uid, targets=[t.uid for t in targets], distance=round(distance, 1))
    return True, ""


def _charge_score(state, unit, cand: Tuple[float, float], targets) -> Optional[float]:
    """Simulate the translate; return a cost if legal, else None."""
    start = measure.unit_centroid(unit)
    delta = (cand[0] - start[0], cand[1] - start[1])
    before = [m.pos for m in unit.models]
    translate_unit(unit, delta, state.layout)
    ok = True
    try:
        for tgt in targets:
            if not measure.units_engaged(unit, tgt):
                ok = False
                break
        if ok:
            others = [u for u in state.units.values()
                      if u is not unit and not u.destroyed and not u.in_reserves and not u.embarked_in]
            if measure.any_base_overlap(unit, others) or measure.internal_overlap(unit):
                ok = False
            elif not measure.coherency_ok(unit):
                ok = False
            else:
                # must not end within Engagement Range of a non-target enemy
                tgt_ids = {t.uid for t in targets}
                for other in others:
                    if other.owner == unit.owner or other.uid in tgt_ids:
                        continue
                    if measure.units_engaged(unit, other):
                        ok = False
                        break
        cost = math.hypot(delta[0], delta[1]) if ok else None
    finally:
        for m, p in zip(unit.models, before):
            m.pos = p
    return cost


def charge_needed(unit, target) -> float:
    """The roll a charge needs: the full gap (11e measures to Engagement Range)."""
    return max(0.0, measure.unit_gap(unit, target) - measure.ENGAGEMENT_HORIZONTAL)


# --------------------------------------------------------------------------
# Fight-phase moves (12)
# --------------------------------------------------------------------------
def pile_in(state, unit, inches: float = 3.0) -> None:
    _fight_move(state, unit, inches, must_end_engaged=True)


def consolidate(state, unit, mode: str = "engaging", inches: float = 3.0) -> None:
    _fight_move(state, unit, inches, must_end_engaged=(mode == "engaging"))


def _fight_move(state, unit, inches: float, must_end_engaged: bool) -> None:
    enemies = [u for u in state.units.values()
               if u.owner != unit.owner and not u.destroyed and not u.in_reserves and u.alive_models]
    if not enemies:
        return
    nearest = min(enemies, key=lambda e: measure.unit_gap(unit, e))
    start = measure.unit_centroid(unit)
    aim = measure.unit_centroid(nearest)
    gap = measure.unit_gap(unit, nearest)
    if gap <= 0:
        return
    step = min(inches, gap)
    dest = step_towards(start, aim, step)
    delta = (dest[0] - start[0], dest[1] - start[1])
    before = [m.pos for m in unit.models]
    translate_unit(unit, delta, state.layout)
    others = [u for u in state.units.values()
              if u is not unit and not u.destroyed and not u.in_reserves and not u.embarked_in]
    bad = measure.any_base_overlap(unit, others) or measure.internal_overlap(unit)
    if must_end_engaged and not measure.unit_engaged(state, unit):
        bad = bad or gap > inches
    if bad:
        for m, p in zip(unit.models, before):
            m.pos = p


# --------------------------------------------------------------------------
# Reserves / ingress (20)
# --------------------------------------------------------------------------
DEEP_STRIKE_CLEARANCE = 8.0          # 11e: more than 8" horizontally from enemies
INGRESS_EDGE = 6.0


def ingress_legal(state, unit, pos: Tuple[float, float], deep_strike: bool) -> MoveResult:
    layout = state.layout
    if state.battle_round < 2:
        return False, "reserves cannot arrive before battle round 2"
    radius = unit.models[0].base.avg_radius if unit.models else 0.5
    if not (radius <= pos[0] <= layout.width - radius and radius <= pos[1] <= layout.height - radius):
        return False, "off the battlefield"
    if not deep_strike:
        edge = min(pos[0], pos[1], layout.width - pos[0], layout.height - pos[1])
        if edge > INGRESS_EDGE:
            return False, 'Strategic Reserves must arrive wholly within 6" of a battlefield edge'
    for other in state.units.values():
        if other.owner == unit.owner or other.destroyed or other.in_reserves or other.embarked_in:
            continue
        for m in other.alive_models:
            if dist(pos, m.pos) - m.base.avg_radius - radius <= DEEP_STRIKE_CLEARANCE:
                return False, 'must be set up more than 8" horizontally from enemy models'
    if state.battle_round < 3:
        zones = state.layout.deployment_zones
        enemy_zone = zones.get("attacker" if unit.owner != state.attacker else "defender", [])
        from ..geometry import point_in_polygon

        for poly in enemy_zone:
            if point_in_polygon(pos, poly):
                return False, "cannot arrive in the opponent's deployment zone before round 3"
    return True, ""
