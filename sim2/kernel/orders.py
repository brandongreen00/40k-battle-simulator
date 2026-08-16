"""The Order subsystem (§3.6) — kernel service, data-defined orders.

The kernel owns the *mechanics* of issuing orders (who may issue, how many, to
whom, replacement, battle-shock interaction). Which orders exist and what they
do is data: every order is an ``EffectRecord`` of kind ``order``.

Rulings enforced here (Astra Militarum FAQ, read 11 Aug 2026 via the faction
page): the same Order does not stack; an Order is lost when its unit becomes
Battle-shocked; Battle-shocked units cannot be issued Orders.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from . import measure
from .actions import Action

DEFAULT_ORDER_RANGE = 6.0
DEFAULT_ORDERS_PER_ROUND = 1


def officers(state, player: int) -> List:
    return [
        u for u in state.units_of(player)
        if u.has_ability("VOICE OF COMMAND") and not u.battle_shocked
    ]


def orders_available(engine, state, officer) -> int:
    mods = engine.interp.unit_mods(state, officer)
    cap = int(officer.flags.get("orders_per_round", DEFAULT_ORDERS_PER_ROUND)) + mods.extra_orders
    used = state.count(f"turn:orders:{officer.uid}")
    return max(0, cap - used)


def order_range(engine, state, officer) -> float:
    return float(officer.flags.get("order_range", DEFAULT_ORDER_RANGE))


def eligible_recipients(engine, state, officer) -> List:
    rng_in = order_range(engine, state, officer)
    out = []
    for unit in state.units_of(officer.owner):
        if unit.battle_shocked or unit.uid == officer.uid:
            continue
        if not unit.has_keyword("REGIMENT"):
            continue
        if measure.unit_gap(officer, unit) > rng_in:
            continue
        out.append(unit)
    return out


def available_orders(engine, state, player: int) -> List:
    recs = [
        r for r in engine.data.effects.values()
        if r.kind == "order" and (not r.faction or r.faction == state.players[player].faction)
    ]
    detachments = set(state.players[player].detachments)
    return [r for r in recs if not r.detachment or r.detachment in detachments]


def legal_order_actions(engine, state, player: int) -> List[Action]:
    from .actions import order as mk

    out = []
    for officer in officers(state, player):
        if orders_available(engine, state, officer) <= 0:
            continue
        recipients = eligible_recipients(engine, state, officer)
        for rec in available_orders(engine, state, player):
            for unit in recipients:
                if rec.id in unit.orders:
                    continue          # the same Order does not stack (AM FAQ)
                out.append(mk(officer.uid, unit.uid, rec.id))
    return out


def issue(engine, state, action) -> "object":
    from .engine import ApplyResult

    officer = state.unit(action.params["officer"])
    unit = state.unit(action.params["unit"])
    rec = engine.data.effects.get(action.params["order"])
    if officer is None or unit is None or rec is None:
        return ApplyResult(False, "missing officer, unit or order")
    if state.phase != "command" and not officer.flags.get("reactive_orders"):
        return ApplyResult(False, "Orders are issued in your Command phase")
    if officer.owner != state.active_player:
        return ApplyResult(False, "not your officer")
    if orders_available(engine, state, officer) <= 0:
        return ApplyResult(False, "officer has no Orders left this battle round")
    if unit.battle_shocked:
        return ApplyResult(False, "Battle-shocked units cannot be issued Orders")
    if unit not in eligible_recipients(engine, state, officer):
        return ApplyResult(False, "unit is not an eligible recipient")
    if rec.id in unit.orders:
        return ApplyResult(False, "that Order is already in effect on the unit")

    # One order per unit at a time: a new order replaces the old.
    for old in list(unit.orders):
        _drop_order(state, unit, old)
    unit.orders.append(rec.id)
    state.active_effects.append(
        engine.data.make_active(
            rec.id, officer.owner, bearer_uid=officer.uid, targets=[unit.uid],
            expiry="until_start_of_next_command",
        )
    )
    state.bump(f"turn:orders:{officer.uid}")
    state.emit("order", officer=officer.uid, unit=unit.uid, order=rec.id, name=rec.name)
    return ApplyResult(True)


def _drop_order(state, unit, order_id: str) -> None:
    unit.orders = [o for o in unit.orders if o != order_id]
    state.active_effects = [
        e for e in state.active_effects
        if not (e.record_id == order_id and unit.uid in e.target_uids)
    ]


def clear_orders_on_battle_shock(state, unit) -> None:
    for oid in list(unit.orders):
        _drop_order(state, unit, oid)
