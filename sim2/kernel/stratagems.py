"""Stratagem economy (15) — limits in the kernel, cards in the data.

Enforced: CP cost (modifiable by effects — §3.5 #16), the same Stratagem once
per phase per player (15.01), one Stratagem per unit per phase unless the card
says otherwise, per-battle / per-round limits, mutual-exclusion groups, and
restriction overrides.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from ..schema import EffectRecord
from . import measure
from .actions import Action

PHASE_WINDOWS = {
    "any": None,
    "command": "command",
    "movement": "movement",
    "shooting": "shooting",
    "charge": "charge",
    "fight": "fight",
}


def cost_of(engine, state, rec: EffectRecord, player: int) -> int:
    """CP cost after modification (Fleetmaster-class discounts are data)."""
    base = rec.cost_cp
    discount = int(state.players[player].army_state.get(f"strat_discount:{rec.id}", 0))
    return max(0, base - discount)


def window_open(state, rec: EffectRecord, player: int) -> bool:
    win = rec.trigger_window or "any"
    if win in ("any", "passive"):
        return True
    if win.startswith("own_"):
        return state.active_player == player and state.phase == win[4:].replace("_phase", "")
    if win.startswith("opponent_"):
        return state.active_player != player and state.phase == win[9:].replace("_phase", "")
    if win.endswith("_phase"):
        return state.phase == win[:-6]
    if win in PHASE_WINDOWS:
        return PHASE_WINDOWS[win] is None or state.phase == PHASE_WINDOWS[win]
    return False


def limits_ok(state, rec: EffectRecord, player: int, unit) -> Tuple[bool, str]:
    lim = rec.usage_limits
    overrides = set(lim.overrides or [])
    if "once_per_phase" not in overrides:
        if state.count(f"phase:strat:{player}:{rec.id}") >= 1:
            return False, "that Stratagem has already been used this phase"
    if "one_per_unit" not in overrides and unit is not None:
        if state.count(f"phase:unitstrat:{unit.uid}") >= 1:
            return False, "that unit has already been affected by a Stratagem this phase"
    if lim.per_battle is not None and state.count(f"battle:strat:{player}:{rec.id}") >= lim.per_battle:
        return False, "per-battle limit reached"
    if lim.per_battle_round is not None and (
        state.count(f"round:strat:{player}:{rec.id}") >= lim.per_battle_round
    ):
        return False, "per-battle-round limit reached"
    for other in lim.mutually_exclusive_with or []:
        if state.count(f"battle:strat:{player}:{other}") > 0:
            return False, f"mutually exclusive with {other}"
    return True, ""


def usable(engine, state, player: int) -> List[EffectRecord]:
    detachments = set(state.players[player].detachments)
    out = []
    for rec in engine.data.effects.values():
        if rec.kind != "stratagem":
            continue
        if not rec.bound:
            # Ingested but not yet expressible in the effect vocabulary: playing
            # it would spend CP for nothing. It stays in the data (and in the
            # coverage report) rather than being offered as a legal play.
            continue
        if rec.detachment and rec.detachment not in detachments:
            continue
        if rec.faction and rec.faction != state.players[player].faction:
            continue
        if not window_open(state, rec, player):
            continue
        if cost_of(engine, state, rec, player) > state.players[player].cp:
            continue
        out.append(rec)
    return out


def legal_stratagem_actions(engine, state, player: int, max_options: int = 24) -> List[Action]:
    from .actions import stratagem as mk

    out: List[Action] = []
    for rec in usable(engine, state, player):
        targets = _candidate_units(engine, state, rec, player)
        if not targets:
            if not rec.targets:
                ok, _ = limits_ok(state, rec, player, None)
                if ok:
                    out.append(mk(rec.id))
            continue
        for unit in targets[:4]:
            if unit.battle_shocked and rec.trigger_actor == "friendly":
                # Battle-shocked units cannot be affected by your Stratagems (08).
                continue
            ok, _ = limits_ok(state, rec, player, unit)
            if ok:
                out.append(mk(rec.id, unit.uid))
        if len(out) >= max_options:
            break
    return out


def _candidate_units(engine, state, rec: EffectRecord, player: int) -> List:
    from ..effects.selectors import EvalContext, parse_selector, SelectorError

    if not rec.targets:
        return []
    try:
        sel = parse_selector(rec.targets[0].selector)
    except SelectorError:
        return []
    ctx = EvalContext(state=state, player=player)
    try:
        return [u for u in sel.select(ctx) if hasattr(u, "uid")]
    except Exception:
        return []


def use(engine, state, action) -> "object":
    from .engine import ApplyResult

    rec = engine.data.effects.get(action.params.get("stratagem", ""))
    if rec is None or rec.kind != "stratagem":
        return ApplyResult(False, "unknown Stratagem")
    player = state.pending.get("stratagem_player", state.active_player)
    unit = state.unit(action.params.get("unit", "")) if action.params.get("unit") else None
    if unit is not None and unit.owner != player and rec.trigger_actor == "friendly":
        return ApplyResult(False, "that unit is not from your army")
    if not window_open(state, rec, player):
        return ApplyResult(False, "not a legal window for that Stratagem")
    cost = cost_of(engine, state, rec, player)
    if state.players[player].cp < cost:
        return ApplyResult(False, "not enough CP")
    ok, reason = limits_ok(state, rec, player, unit)
    if not ok:
        return ApplyResult(False, reason)
    if unit is not None and unit.battle_shocked and rec.trigger_actor == "friendly":
        return ApplyResult(False, "Battle-shocked units cannot be targeted by your Stratagems")

    state.players[player].cp -= cost
    state.bump(f"phase:strat:{player}:{rec.id}")
    state.bump(f"round:strat:{player}:{rec.id}")
    state.bump(f"battle:strat:{player}:{rec.id}")
    if unit is not None:
        state.bump(f"phase:unitstrat:{unit.uid}")
    state.active_effects.append(
        engine.data.make_active(
            rec.id, player,
            bearer_uid=unit.uid if unit else "",
            targets=[unit.uid] if unit else [],
            expiry=rec.duration,
        )
    )
    state.emit("stratagem", player=player, stratagem=rec.id, name=rec.name,
               cp=cost, unit=unit.uid if unit else "", bound=rec.bound)
    return ApplyResult(True)
