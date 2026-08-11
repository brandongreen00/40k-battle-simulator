"""Legal-action enumeration (§8 Stage A).

The engine *offers* every legal option; agents only ever choose. Anything an
agent can construct itself would let it construct an illegal one.

One honest approximation: model positions are continuous, so "every legal
destination" is uncountable. Movement and placement are enumerated over a
candidate lattice (goal-directed samples at ``MOVE_SAMPLES`` resolution). The
engine still *validates* any continuous destination an agent proposes, so a
search or RL agent may propose off-lattice moves; the enumeration is a
representative finite cover, and that is stated rather than hidden.
"""

from __future__ import annotations

import math
from typing import List, Optional, Tuple

from ..geometry import dist, point_in_polygon
from . import measure, movement, objectives, orders, stratagems, unit_actions, visibility
from .actions import Action, arrive, charge, deploy, end_phase, fight, move, reserves, shoot

MOVE_SAMPLES = 8            # directions sampled per unit per move mode
DEPLOY_SAMPLES = 24


def enumerate_actions(engine, state, player: int) -> List[Action]:
    if state.finished:
        return []
    if state.phase == "deployment":
        return _deployment_actions(engine, state, player)
    acts: List[Action] = []
    if state.phase == "command":
        acts += orders.legal_order_actions(engine, state, player)
    elif state.phase == "movement":
        acts += _movement_actions(engine, state, player)
    elif state.phase == "shooting":
        acts += _shooting_actions(engine, state, player)
        acts += unit_actions.legal_action_actions(engine, state, player)
    elif state.phase == "charge":
        acts += _charge_actions(engine, state, player)
    elif state.phase == "fight":
        acts += _fight_actions(engine, state, player)
    acts += stratagems.legal_stratagem_actions(engine, state, player)
    acts.append(end_phase())
    return acts


# --------------------------------------------------------------------------
def _deployment_actions(engine, state, player: int) -> List[Action]:
    out: List[Action] = []
    pending = [u for u in state.units.values() if u.owner == player and not u.deployed]
    if not pending:
        return out
    unit = pending[0]
    zone_key = "attacker" if player == state.attacker else "defender"
    zones = state.layout.deployment_zones.get(zone_key, [])
    for pos in _zone_samples(state, zones, DEPLOY_SAMPLES):
        if _deployment_legal(engine, state, unit, pos):
            out.append(deploy(unit.uid, pos))
    out.append(reserves(unit.uid))
    return out


def _deployment_legal(engine, state, unit, pos) -> bool:
    """Dry-run the placement so the enumeration only ever offers legal drops."""
    before = [m.pos for m in unit.models]
    try:
        ok, _ = engine._place_unit(state, unit, pos)
    finally:
        for m, p in zip(unit.models, before):
            m.pos = p
        measure.bump_epoch()
    return ok


def _zone_samples(state, zones, n: int) -> List[Tuple[float, float]]:
    pts: List[Tuple[float, float]] = []
    if not zones:
        return pts
    for poly in zones:
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        cols = max(2, int(math.sqrt(n)))
        rows = max(2, n // cols)
        for i in range(cols):
            for j in range(rows):
                x = x0 + (x1 - x0) * (i + 0.5) / cols
                y = y0 + (y1 - y0) * (j + 0.5) / rows
                if point_in_polygon((x, y), poly):
                    pts.append((round(x, 2), round(y, 2)))
    return pts[:n * 2]


# --------------------------------------------------------------------------
def _movement_actions(engine, state, player: int) -> List[Action]:
    out: List[Action] = []
    for unit in state.units_of(player):
        if unit.moved:
            continue
        engaged = measure.unit_engaged(state, unit)
        centroid = measure.unit_centroid(unit)
        modes = ["stationary"]
        if engaged:
            modes.append("fall_back")
        else:
            modes += ["normal", "advance"]
        for mode in modes:
            if mode == "stationary":
                out.append(move(unit.uid, centroid, "stationary"))
                continue
            budget = movement.move_budget(state, engine.interp, unit, "normal").total
            for dest in _move_targets(state, unit, centroid, budget):
                if mode == "fall_back" and not _fall_back_possible(state, unit, dest, budget):
                    # A Fall Back that cannot leave Engagement Range is not a
                    # legal move, so it is never offered.
                    continue
                out.append(move(unit.uid, dest, mode))
    for unit in state.units.values():
        if unit.owner != player or not unit.in_reserves:
            continue
        for pos in _reserve_spots(state, unit):
            out.append(arrive(unit.uid, pos))
    return out


def _fall_back_possible(state, unit, dest, budget: float) -> bool:
    from ..geometry import step_towards

    centroid = measure.unit_centroid(unit)
    target = step_towards(centroid, dest, budget)
    delta = (target[0] - centroid[0], target[1] - centroid[1])
    before = [m.pos for m in unit.models]
    ok = movement._furthest_legal(state, unit, delta, "fall_back", before) > 0.0
    for m, p in zip(unit.models, before):
        m.pos = p
    measure.bump_epoch()
    return ok


def _move_targets(state, unit, centroid, budget: float) -> List[Tuple[float, float]]:
    """Goal-directed candidates: objectives, enemies, cover, and a compass fan."""
    out: List[Tuple[float, float]] = []
    for obj in state.layout.objectives:
        out.append(_towards(centroid, obj.pos, budget))
    for enemy in state.opponent_units(unit.owner)[:4]:
        out.append(_towards(centroid, measure.unit_centroid(enemy), budget))
    for i in range(MOVE_SAMPLES):
        ang = 2 * math.pi * i / MOVE_SAMPLES
        out.append((centroid[0] + math.cos(ang) * budget, centroid[1] + math.sin(ang) * budget))
    clamped = []
    for p in out:
        x = min(max(p[0], 1.0), state.layout.width - 1.0)
        y = min(max(p[1], 1.0), state.layout.height - 1.0)
        clamped.append((round(x, 2), round(y, 2)))
    seen = set()
    uniq = []
    for p in clamped:
        if p in seen:
            continue
        seen.add(p)
        uniq.append(p)
    return uniq


def _towards(a, b, budget: float) -> Tuple[float, float]:
    d = dist(a, b)
    if d <= budget or d < 1e-9:
        return (b[0], b[1])
    t = budget / d
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def _reserve_spots(state, unit) -> List[Tuple[float, float]]:
    spots = []
    deep = unit.reserves_kind == "deep_strike"
    for obj in state.layout.objectives:
        for r in (9.0, 12.0):
            for i in range(6):
                ang = 2 * math.pi * i / 6
                p = (obj.pos[0] + math.cos(ang) * r, obj.pos[1] + math.sin(ang) * r)
                ok, _ = movement.ingress_legal(state, unit, p, deep)
                if ok:
                    spots.append((round(p[0], 2), round(p[1], 2)))
    return spots[:8]


# --------------------------------------------------------------------------
def _shooting_actions(engine, state, player: int) -> List[Action]:
    from .engine import can_shoot
    from .shooting import fire_plan

    out = []
    for unit in state.units_of(player):
        if unit.shot:
            continue
        for target in state.opponent_units(player):
            ok, _ = can_shoot(engine, state, unit, target)
            if not ok:
                continue
            if not fire_plan(state, unit, target):
                continue
            out.append(shoot(unit.uid, target.uid))
    return out


def _charge_actions(engine, state, player: int) -> List[Action]:
    out = []
    for unit in state.units_of(player):
        if unit.charge_attempted or unit.move_mode in ("advance", "fall_back"):
            continue
        if measure.unit_engaged(state, unit):
            continue
        for target in state.opponent_units(player):
            gap = measure.unit_gap(unit, target)
            if gap <= 12.0:
                out.append(charge(unit.uid, [target.uid]))
    return out


def _fight_actions(engine, state, player: int) -> List[Action]:
    from .engine import next_to_fight

    unit = next_to_fight(state, player)
    if unit is None:
        return []
    return [fight(unit.uid, target.uid) for target in measure.engaged_enemies(state, unit)]
