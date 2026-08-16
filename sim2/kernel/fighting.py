"""Fight phase resolution (12).

Each model fights with exactly ONE melee weapon (04.x); bearers of the best
profile against this target swing first, the remainder use the next-best.
Pile In precedes the attacks and Consolidation follows (12.03 / 12.08).
"""

from __future__ import annotations

from typing import Dict, List, Tuple

from ..schema import WeaponProfile
from . import attacks, dice, measure, movement
from .datacache import datasheet


def melee_weapons(state, unit) -> List[Tuple[WeaponProfile, int]]:
    counts: Dict[str, int] = {}
    for m in unit.alive_models:
        counts[m.datasheet_id] = counts.get(m.datasheet_id, 0) + 1
    out = []
    for ds_id, n in counts.items():
        ds = datasheet(state, ds_id)
        if ds is None:
            continue
        for w in ds.weapons:
            if w.kind == "melee":
                out.append((w, n))
    return out


def _mini_ev(weapon: WeaponProfile, target_t: int, target_sv: int) -> float:
    """A local deterministic ranking so each model picks its best swing.
    (The kernel cannot import the AI's evaluator — that would be a cycle.)"""
    hit = max(0.0, (7 - weapon.skill) / 6.0)
    need = attacks.wound_target(weapon.strength, target_t)
    wound = max(0.0, (7 - need) / 6.0)
    save = min(6, max(2, target_sv - weapon.ap))
    unsaved = max(0.0, 1.0 - (7 - save) / 6.0)
    return dice.average(weapon.attacks) * hit * wound * unsaved * dice.average(weapon.damage)


def fight_plan(state, unit, target) -> List[Tuple[WeaponProfile, int]]:
    """Assign each model one melee weapon, best profile first."""
    from .datacache import model_profile_for

    prof = model_profile_for(state, target, target.alive_models[0]) if target.alive_models else None
    t_t = prof.t if prof else 4
    t_sv = prof.sv if prof else 4
    weapons = melee_weapons(state, unit)
    if not weapons:
        return []
    ranked = sorted(weapons, key=lambda wc: -_mini_ev(wc[0], t_t, t_sv))
    plan: List[Tuple[WeaponProfile, int]] = []
    assigned: Dict[str, int] = {}
    for weapon, carriers in ranked:
        ds_models = sum(1 for m in unit.alive_models if m.datasheet_id == _ds_of(state, weapon, unit))
        key = weapon.profile_of or weapon.name.split(" – ")[0]
        used = assigned.get(key, 0)
        if used:
            continue
        assigned[key] = carriers
        plan.append((weapon, carriers))
        break                       # one melee weapon per model (04.x)
    extra = [wc for wc in weapons if wc[0].has("EXTRA ATTACKS")]
    plan.extend(extra)
    return plan


def _ds_of(state, weapon, unit) -> str:
    for m in unit.alive_models:
        ds = datasheet(state, m.datasheet_id)
        if ds and any(w.name == weapon.name for w in ds.weapons):
            return m.datasheet_id
    return unit.datasheet_id


def resolve_unit_fight(engine, state, unit, target) -> Dict:
    movement.pile_in(state, unit)
    summary = {"unit": unit.uid, "target": target.uid, "weapons": [], "slain": 0}
    for weapon, carriers in fight_plan(state, unit, target):
        if target.destroyed or not target.alive_models:
            break
        if not measure.units_engaged(unit, target):
            break
        res = attacks.resolve_attack(
            state, engine.rng, engine.interp, unit, target, weapon,
            phase="fight", attacker_count=carriers,
        )
        summary["weapons"].append({
            "name": weapon.name, "hits": res.hits, "wounds": res.wounds,
            "slain": res.models_slain, "damage": res.damage_dealt,
        })
        summary["slain"] += res.models_slain
    movement.consolidate(state, unit, "engaging")
    state.emit("fight", **summary)
    return summary
