"""The attack sequence (core rules 04, 05).

Hit -> Wound -> Allocate -> Save -> Damage, with:

* unmodified 1 always fails and unmodified 6 is always a Critical, at both the
  Hit and the Wound roll;
* hit/wound modifiers clamped to +/-1 after summing (02.02);
* the 11th edition S-vs-T wound table (transcribed from the official PDF — the
  Wahapedia rendering strips numerals, trap §6.8);
* **Benefit of Cover worsens the attacker's BS/WS by 1** (11th edition made
  cover a hit-roll penalty, not a save bonus);
* allocation groups: the wounded group first, then non-CHARACTER groups, with
  CHARACTER groups last; [PRECISION] promotes a CHARACTER group;
* [DEVASTATING WOUNDS] converts a Critical Wound to mortal wounds capped at one
  model per critical;
* Feel No Pain, damage reduction, and Hazardous.

Every faction-specific modifier arrives through the interpreter — this module
contains no unit's rule.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..schema import WeaponProfile
from . import dice, measure, visibility
from .datacache import model_profile_for

#: S vs T -> wound roll needed (05.02). Transcribed from the official PDF.
def wound_target(strength: int, toughness: int) -> int:
    if strength >= toughness * 2:
        return 2
    if strength > toughness:
        return 3
    if strength == toughness:
        return 4
    if strength * 2 <= toughness:
        return 6
    return 5


@dataclass
class AttackContext:
    """The attack currently being resolved — what predicates read."""

    attacker_unit: Any
    target_unit: Any
    weapon: WeaponProfile
    distance: float = 0.0
    attacker_count: int = 1
    critical_hit: bool = False
    critical_wound: bool = False
    in_cover: bool = False
    plunging: bool = False
    phase: str = "shooting"


@dataclass
class AttackResult:
    attacks: int = 0
    hits: int = 0
    wounds: int = 0
    saves_failed: int = 0
    damage_dealt: int = 0
    models_slain: int = 0
    mortal_wounds: int = 0
    log: List[Dict[str, Any]] = field(default_factory=list)

    def merge(self, other: "AttackResult") -> "AttackResult":
        self.attacks += other.attacks
        self.hits += other.hits
        self.wounds += other.wounds
        self.saves_failed += other.saves_failed
        self.damage_dealt += other.damage_dealt
        self.models_slain += other.models_slain
        self.mortal_wounds += other.mortal_wounds
        self.log.extend(other.log)
        return self


def clamp_mod(v: int) -> int:
    return max(-1, min(1, v))


# --------------------------------------------------------------------------
def resolve_attack(
    state,
    rng,
    interp,
    attacker,
    target,
    weapon: WeaponProfile,
    phase: str = "shooting",
    attacker_count: Optional[int] = None,
) -> AttackResult:
    """Resolve one weapon's attacks from ``attacker`` into ``target``."""
    res = AttackResult()
    if not attacker.alive_models or not target.alive_models:
        return res

    distance = measure.unit_gap(attacker, target)
    bearers = (
        len(visibility.models_that_can_see(state, attacker, target))
        if weapon.kind == "ranged"
        else len(attacker.alive_models)
    )
    if attacker_count is not None:
        bearers = min(bearers, attacker_count)
    if bearers <= 0:
        return res

    ctx = AttackContext(
        attacker_unit=attacker,
        target_unit=target,
        weapon=weapon,
        distance=distance,
        attacker_count=bearers,
        phase=phase,
    )
    ctx.in_cover = (
        weapon.kind == "ranged" and visibility.has_benefit_of_cover(state, attacker, target)
    )
    ctx.plunging = weapon.kind == "ranged" and visibility.plunging_fire(state, attacker, target)

    mods = interp.attack_mods(state, ctx)
    if mods.deny_cover or mods.ignore_cover or weapon.has("IGNORES COVER"):
        ctx.in_cover = False

    abilities = {a.upper() for a in weapon.abilities} | set(mods.granted_weapon_abilities)

    def has(name: str) -> bool:
        n = name.upper()
        return any(a == n or a.startswith(n + " ") for a in abilities)

    def value_of(name: str, default: int = 0) -> int:
        n = name.upper()
        for a in abilities:
            if a.startswith(n):
                tail = a[len(n):].strip().rstrip("+")
                try:
                    return int(tail)
                except ValueError:
                    return default
        return default

    # -- number of attacks ------------------------------------------------
    per_model, _ = dice.parse(weapon.attacks).roll(rng, note=f"{weapon.name} attacks")
    per_model += mods.attacks_mod
    if has("RAPID FIRE") and weapon.kind == "ranged" and distance <= weapon.range_in / 2.0:
        per_model += value_of("RAPID FIRE", 1)
    if has("BLAST"):
        per_model += len(target.alive_models) // 5
    per_model = max(0, per_model)
    total_attacks = per_model * bearers
    res.attacks = total_attacks
    if total_attacks <= 0:
        return res

    # -- hit roll ----------------------------------------------------------
    skill = mods.skill_set if mods.skill_set is not None else weapon.skill
    hit_mod = mods.hit_mod
    if ctx.in_cover:
        hit_mod -= 1                     # 11e: cover worsens BS/WS
    if ctx.plunging and has("BLAST"):
        hit_mod += 1
    if mods.ignore_hit_modifiers:
        hit_mod = 0
    hit_mod += mods.skill_mod
    hit_mod = clamp_mod(hit_mod)
    crit_hit = mods.crit_hit

    torrent = has("TORRENT")
    if torrent:
        hits = total_attacks
        crits = 0
        rolls: List[int] = []
    else:
        rolls = rng.roll(total_attacks, 6, kind="hit", note=weapon.name)
        rolls = _reroll(rng, rolls, skill - hit_mod, mods.reroll_hits, "hit", weapon.name)
        crits = sum(1 for r in rolls if r >= crit_hit)
        hits = sum(1 for r in rolls if r != 1 and (r >= crit_hit or r + hit_mod >= skill))
    if has("SUSTAINED HITS"):
        hits += crits * value_of("SUSTAINED HITS", 1)
    res.hits = hits

    lethal = has("LETHAL HITS")
    auto_wounds = 0
    if lethal:
        auto_wounds = crits
        hits = max(0, hits - crits)

    # -- wound roll --------------------------------------------------------
    strength = mods.strength_set if mods.strength_set is not None else weapon.strength
    strength += mods.strength_mod
    if has("MELTA") and weapon.kind == "ranged" and distance <= weapon.range_in / 2.0:
        pass  # Melta adds damage, not strength — applied below
    toughness = _target_toughness(state, target)
    need = wound_target(strength, toughness)
    if has("LANCE") and attacker.charged:
        mods.wound_mod += 1
    wound_mod = clamp_mod(mods.wound_mod)
    crit_wound = mods.crit_wound
    anti = _anti_threshold(abilities, target)
    if anti:
        crit_wound = min(crit_wound, anti)

    wrolls = rng.roll(hits, 6, kind="wound", note=weapon.name)
    wrolls = _reroll(rng, wrolls, need - wound_mod, mods.reroll_wounds, "wound", weapon.name)
    wound_crits = sum(1 for r in wrolls if r >= crit_wound)
    wounds = sum(1 for r in wrolls if r != 1 and (r >= crit_wound or r + wound_mod >= need))
    wounds += auto_wounds
    res.wounds = wounds

    devastating = has("DEVASTATING WOUNDS")
    dev_crits = wound_crits if devastating else 0
    if devastating:
        wounds = max(0, wounds - dev_crits)

    # -- damage per successful wound ---------------------------------------
    ap = weapon.ap + mods.ap_delta
    ap = min(0, ap)
    dmg_expr = mods.damage_set or weapon.damage
    melta = value_of("MELTA", 0) if has("MELTA") and distance <= weapon.range_in / 2.0 else 0

    precision = has("PRECISION")
    groups = allocation_groups(state, target, precision)

    # saves + damage
    for _ in range(wounds):
        if not any(g["models"] for g in groups):
            break
        model, prof = _next_model(groups)
        if model is None:
            break
        save, inv = _best_save(state, target, model, prof, ap, mods)
        roll = rng.roll(1, 6, kind="save", note=target.name)[0]
        saved = roll != 1 and (roll >= save)
        res.saves_failed += 0 if saved else 1
        if saved:
            continue
        dmg = dice.roll(dmg_expr, rng, note=f"{weapon.name} damage") + melta + mods.damage_mod
        dmg = max(0, dmg - mods.damage_reduction)
        slain = _apply_damage(state, rng, interp, target, model, dmg, mods)
        res.damage_dealt += dmg
        res.models_slain += slain
        if slain:
            _prune(groups)

    # -- Devastating Wounds: mortal wounds, one model per critical ---------
    if dev_crits:
        for _ in range(dev_crits):
            mw = dice.roll(dmg_expr, rng, note="devastating wounds")
            res.mortal_wounds += mw
            res.models_slain += apply_mortal_wounds(state, rng, interp, target, mw, cap_one_model=True)

    # -- Hazardous (06.x): the bearer risks itself ------------------------
    if has("HAZARDOUS"):
        _hazard(state, rng, interp, attacker, bearers)

    if weapon.kind == "ranged":
        attacker.last_shot_round = state.battle_round

    res.log.append({
        "weapon": weapon.name,
        "attacker": attacker.uid,
        "target": target.uid,
        "attacks": res.attacks,
        "hits": res.hits,
        "wounds": res.wounds,
        "damage": res.damage_dealt,
        "slain": res.models_slain,
        "cover": ctx.in_cover,
        "mods": sorted(set(mods.sources)),
    })
    return res


# --------------------------------------------------------------------------
def _reroll(rng, rolls: List[int], need: int, mode: str, kind: str, note: str) -> List[int]:
    if not mode or not rolls:
        return rolls
    out = []
    for r in rolls:
        if (mode == "ones" and r == 1) or (mode == "all" and r < need):
            out.append(rng.roll(1, 6, kind=kind + "_reroll", note=note)[0])
        else:
            out.append(r)
    return out


def _anti_threshold(abilities, target) -> Optional[int]:
    best = None
    for a in abilities:
        if not a.startswith("ANTI"):
            continue
        body = a[4:].strip().lstrip("-").strip()
        parts = body.split()
        if len(parts) < 2:
            continue
        keyword = " ".join(parts[:-1]).upper()
        try:
            threshold = int(parts[-1].rstrip("+"))
        except ValueError:
            continue
        if target.has_keyword(keyword):
            best = threshold if best is None else min(best, threshold)
    return best


def _target_toughness(state, target) -> int:
    """Attached units defend with the Bodyguard's Toughness (19.x); a Kill Team
    uses its majority Toughness (army rule, data-driven via keywords)."""
    counts: Dict[int, int] = {}
    for m in target.alive_models:
        prof = model_profile_for(state, target, m)
        if prof:
            counts[prof.t] = counts.get(prof.t, 0) + 1
    if not counts:
        return 4
    top = max(counts.values())
    tied = [t for t, c in counts.items() if c == top]
    return max(tied)


def allocation_groups(state, target, precision: bool = False) -> List[Dict[str, Any]]:
    """11e allocation groups: wounded group first, CHARACTER groups last unless
    the attack has [PRECISION]."""
    chars: List[Dict[str, Any]] = []
    bodies: List[Any] = []
    for m in target.alive_models:
        prof = model_profile_for(state, target, m)
        is_char = False
        ds_kw = []
        from .datacache import datasheet

        ds = datasheet(state, m.datasheet_id)
        if ds:
            ds_kw = [k.upper() for k in ds.keywords]
            is_char = "CHARACTER" in ds_kw and len(target.alive_models) > 1
        if is_char:
            chars.append({"models": [m], "character": True})
        else:
            bodies.append(m)
    groups: List[Dict[str, Any]] = []
    if bodies:
        wounded = [m for m in bodies if m.wounds < m.max_wounds]
        healthy = [m for m in bodies if m.wounds >= m.max_wounds]
        if wounded:
            groups.append({"models": wounded, "character": False})
        if healthy:
            groups.append({"models": healthy, "character": False})
    if precision:
        groups = chars + groups
    else:
        groups = groups + chars
    if not groups and target.alive_models:
        groups = [{"models": list(target.alive_models), "character": False}]
    return groups


def _next_model(groups) -> Tuple[Any, Any]:
    for g in groups:
        for m in g["models"]:
            if m.alive:
                return m, None
    return None, None


def _prune(groups) -> None:
    for g in groups:
        g["models"] = [m for m in g["models"] if m.alive]


def _best_save(state, target, model, prof, ap: int, mods) -> Tuple[int, Optional[int]]:
    profile = prof or model_profile_for(state, target, model)
    armour = (profile.sv if profile else 4) - ap          # ap is <= 0
    armour -= mods.save_mod
    if mods.save_cap is not None:
        armour = max(armour, mods.save_cap)
    invuln = mods.invuln_set if mods.invuln_set is not None else (profile.invuln if profile else None)
    if invuln is not None:
        return (min(armour, invuln), invuln)
    return (armour, None)


def _apply_damage(state, rng, interp, target, model, dmg: int, mods) -> int:
    """Damage never spills between models (05.x)."""
    if dmg <= 0:
        return 0
    fnp = mods.fnp
    if fnp is None:
        umods = interp.unit_mods(state, target)
        fnp = umods.fnp
        if fnp is None and target.has_ability("FEEL NO PAIN"):
            fnp = int(target.ability_value("FEEL NO PAIN", 7))
    if fnp:
        ignored = sum(1 for r in rng.roll(dmg, 6, kind="fnp", note=target.name) if r >= fnp)
        dmg -= ignored
    if dmg <= 0:
        return 0
    model.wounds -= dmg
    if model.wounds <= 0:
        model.wounds = 0
        model.alive = False
        _check_destroyed(state, target)
        return 1
    return 0


def apply_mortal_wounds(state, rng, interp, target, mw: int, cap_one_model: bool = False) -> int:
    slain = 0
    remaining = mw
    umods = interp.unit_mods(state, target)
    fnp = umods.fnp
    if fnp is None and target.has_ability("FEEL NO PAIN"):
        fnp = int(target.ability_value("FEEL NO PAIN", 7))
    for model in list(target.alive_models):
        if remaining <= 0:
            break
        take = remaining
        if fnp:
            take -= sum(1 for r in rng.roll(take, 6, kind="fnp", note="mortal") if r >= fnp)
        if take <= 0:
            break
        applied = min(take, model.wounds)
        model.wounds -= applied
        remaining -= applied
        if model.wounds <= 0:
            model.alive = False
            slain += 1
        if cap_one_model:
            break
    _check_destroyed(state, target)
    return slain


def _hazard(state, rng, interp, unit, bearers: int) -> None:
    """Hazard rolls fail on 1-2; a failure destroys a model (3 MW for a pure
    MONSTER/VEHICLE unit)."""
    rolls = rng.roll(1, 6, kind="hazard", note=unit.name)
    if rolls and rolls[0] <= 2:
        pure_mv = all(
            unit.has_keyword("MONSTER") or unit.has_keyword("VEHICLE") for _ in [0]
        )
        apply_mortal_wounds(state, rng, interp, unit, 3 if pure_mv else 1)
        state.emit("hazard", unit=unit.uid)


def _check_destroyed(state, unit) -> None:
    measure.bump_epoch()
    if not unit.alive_models and not unit.destroyed:
        unit.destroyed = True
        state.kills.append({
            "unit": unit.uid,
            "owner": unit.owner,
            "round": state.battle_round,
            "name": unit.name,
            "character": unit.is_character(),
        })
        state.emit("unit_destroyed", unit=unit.uid, owner=unit.owner, name=unit.name)
