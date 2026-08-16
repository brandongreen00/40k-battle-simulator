"""Shooting phase resolution (10).

A unit's shooting fires every eligible weapon its models carry, resolved
sequentially — casualties from one weapon are removed before the next fires.
Shooting types are distinct modes: Normal (10.04), Assault (10.05),
Close-Quarters (10.06), Indirect (10.07), Snap Shooting (15.09).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from ..schema import WeaponProfile
from . import attacks, measure, visibility
from .datacache import datasheet


def weapons_of(state, unit) -> List[Tuple[WeaponProfile, int]]:
    """(weapon, number of models that may fire it) for every model's datasheet."""
    counts: Dict[str, int] = {}
    for m in unit.alive_models:
        counts[m.datasheet_id] = counts.get(m.datasheet_id, 0) + 1
    out: List[Tuple[WeaponProfile, int]] = []
    for ds_id, n in counts.items():
        ds = datasheet(state, ds_id)
        if ds is None:
            continue
        for w in ds.weapons:
            out.append((w, n))
    return out


def eligible_ranged(state, unit, target, weapon: WeaponProfile) -> Tuple[bool, str]:
    if weapon.kind != "ranged":
        return False, "melee weapon"
    distance = measure.unit_gap(unit, target)
    if distance > weapon.range_in and not weapon.has("INDIRECT FIRE"):
        return False, "out of range"
    if unit.move_mode == "advance" and not weapon.has("ASSAULT"):
        return False, "unit Advanced; only [ASSAULT] weapons may shoot"
    engaged = measure.unit_engaged(state, unit)
    if engaged:
        engaged_with_target = measure.units_engaged(unit, target)
        if not engaged_with_target:
            return False, "engaged; may only shoot the engaging unit"
        if not (weapon.has("PISTOL") or weapon.has("CLOSE-QUARTERS")):
            if not (unit.has_keyword("MONSTER") or unit.has_keyword("VEHICLE")):
                return False, "engaged; only [CLOSE-QUARTERS] weapons may fire"
    if weapon.has("ONE SHOT") and unit.flags.get(f"one_shot:{weapon.name}"):
        return False, "[ONE SHOT] already fired"
    return True, ""


def fire_plan(state, unit, target) -> List[Tuple[WeaponProfile, int]]:
    plan = []
    seen_profiles = set()
    for weapon, carriers in weapons_of(state, unit):
        ok, _ = eligible_ranged(state, unit, target, weapon)
        if not ok:
            continue
        # multi-profile weapons fire ONE profile: take the first eligible one
        base_name = weapon.profile_of or weapon.name.split(" – ")[0].split(" - ")[0]
        if base_name in seen_profiles:
            continue
        seen_profiles.add(base_name)
        plan.append((weapon, carriers))
    return plan


def resolve_unit_shooting(engine, state, unit, target) -> Dict[str, Any]:
    """Fire every eligible weapon at ``target``, sequentially."""
    summary = {"unit": unit.uid, "target": target.uid, "weapons": [], "slain": 0}
    for weapon, carriers in fire_plan(state, unit, target):
        if target.destroyed or not target.alive_models:
            break
        indirect = weapon.has("INDIRECT FIRE") and not visibility.unit_visible(state, unit, target)
        res = attacks.resolve_attack(
            state, engine.rng, engine.interp, unit, target, weapon,
            phase="shooting", attacker_count=carriers,
        )
        if weapon.has("ONE SHOT"):
            unit.flags[f"one_shot:{weapon.name}"] = True
        summary["weapons"].append({
            "name": weapon.name, "carriers": carriers, "indirect": indirect,
            "hits": res.hits, "wounds": res.wounds, "slain": res.models_slain,
            "damage": res.damage_dealt,
        })
        summary["slain"] += res.models_slain
    state.emit("shoot", **summary)
    return summary
