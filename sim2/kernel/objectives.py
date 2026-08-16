"""Objective control (core rules 14).

An objective is either a 40mm marker (control range 3" horizontal / 5"
vertical) or — in 11th edition Event missions — a terrain area, in which case
the area itself is the objective and a unit controls it by being within it.

Control is determined at the end of every phase and turn, and **before** any
other end-of-phase rule (14.02.01). Battle-shocked models have OC '-'.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from ..geometry import base_within_polygon, dist

MARKER_RANGE = 3.0
MARKER_VERTICAL = 5.0


def _area_for(state, objective):
    if not objective.area_id:
        return None
    for area in state.layout.terrain:
        if area.id == objective.area_id:
            return area
    return None


def model_in_range(state, model, objective) -> bool:
    area = _area_for(state, objective)
    if area is not None:
        return base_within_polygon(model.pos, model.base.avg_radius, area.polygon)
    horizontal = dist(model.pos, objective.pos) - model.base.avg_radius
    return horizontal <= MARKER_RANGE and abs(model.z) <= MARKER_VERTICAL


def unit_in_range(state, unit, objective) -> bool:
    return any(model_in_range(state, m, objective) for m in unit.alive_models)


def unit_in_range_of_any_objective(state, unit) -> bool:
    return any(unit_in_range(state, unit, o) for o in state.layout.objectives)


def unit_oc(state, unit) -> int:
    """Objective Control total. Battle-shocked units contribute nothing."""
    if unit.battle_shocked:
        return 0
    from .datacache import model_profile_for

    total = 0
    for m in unit.alive_models:
        prof = model_profile_for(state, unit, m)
        oc = prof.oc if prof else 1
        total += max(0, oc + int(unit.flags.get("oc_modifier", 0)))
    return total


def control_of(state, objective) -> Optional[int]:
    """Which player controls this objective (highest OC total wins)."""
    totals = [0, 0]
    for unit in state.units.values():
        if unit.destroyed or unit.in_reserves or unit.embarked_in or not unit.alive_models:
            continue
        if unit_in_range(state, unit, objective):
            totals[unit.owner] += unit_oc(state, unit)
    if totals[0] == totals[1]:
        # Nobody has more OC: control persists (Secured / previously held).
        return state.pending.get("objective_control", {}).get(objective.id)
    return 0 if totals[0] > totals[1] else 1


def refresh_control(state) -> Dict[str, Optional[int]]:
    """Recompute and store control. Call at end of phase BEFORE other rules."""
    control = dict(state.pending.get("objective_control", {}))
    for obj in state.layout.objectives:
        holder = control_of(state, obj)
        secured_by = state.pending.get("secured", {}).get(obj.id)
        if holder is None and secured_by is not None:
            holder = secured_by
        control[obj.id] = holder
    state.pending["objective_control"] = control
    return control


def controlled_by(state, player: int) -> List[str]:
    control = state.pending.get("objective_control", {})
    return [oid for oid, holder in control.items() if holder == player]


def unit_controls_an_objective(state, unit) -> bool:
    control = state.pending.get("objective_control", {})
    for obj in state.layout.objectives:
        if control.get(obj.id) == unit.owner and unit_in_range(state, unit, obj):
            return True
    return False


def objective_by_id(state, oid: str):
    for o in state.layout.objectives:
        if o.id == oid:
            return o
    return None
