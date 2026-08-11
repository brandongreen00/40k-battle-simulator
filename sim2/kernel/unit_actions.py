"""Actions (core rules 16).

Marker-based primary missions run through Actions, so this subsystem is
scoring-critical. An Action record carries Starts / Units / Use Limit /
Completes / Effect; eligibility exclusions are enforced here.
"""

from __future__ import annotations

from typing import List, Optional

from . import measure, objectives
from .actions import Action


def eligible(state, unit) -> bool:
    """16.x eligibility exclusions."""
    if unit.destroyed or unit.in_reserves or unit.embarked_in:
        return False
    if unit.battle_shocked:
        return False
    if unit.action:
        return False                       # one action at a time
    if unit.move_mode in ("advance", "fall_back"):
        return False
    if measure.unit_engaged(state, unit) and not unit.has_keyword("TITANIC"):
        return False
    from .objectives import unit_oc

    if unit_oc(state, unit) <= 0:
        return False
    return True


def legal_action_actions(engine, state, player: int) -> List[Action]:
    from .actions import start_action as mk

    out = []
    for rec in engine.data.effects.values():
        if rec.kind != "mission_rule" or not rec.text.lower().startswith("action"):
            continue
        for unit in state.units_of(player):
            if eligible(state, unit):
                out.append(mk(unit.uid, rec.id))
    return out


def start(engine, state, action) -> "object":
    from .engine import ApplyResult

    unit = state.unit(action.params["unit"])
    if unit is None or unit.owner != state.active_player:
        return ApplyResult(False, "not your unit")
    if not eligible(state, unit):
        return ApplyResult(False, "unit cannot start an Action")
    unit.action = action.params["action"]
    unit.action_started_round = state.battle_round
    # Starting an Action removes shoot and charge eligibility (16.x).
    unit.shot = True
    unit.charge_attempted = True
    state.emit("action_started", unit=unit.uid, action=unit.action)
    return ApplyResult(True)


def resolve_completions(state) -> List[str]:
    """Actions complete at the end of the player's turn unless voided."""
    completed = []
    for unit in state.units.values():
        if not unit.action or unit.owner != state.active_player:
            continue
        if unit.destroyed or unit.in_reserves:
            unit.action = ""
            continue
        if unit.moved and unit.move_mode not in ("", "stationary"):
            unit.action = ""           # moving voids completion
            state.emit("action_failed", unit=unit.uid)
            continue
        completed.append(unit.action)
        state.emit("action_completed", unit=unit.uid, action=unit.action)
        unit.action = ""
    return completed
