"""Effect interpreter: trigger bus + modifier stack (§3.3, §3.5).

The kernel asks this module two questions and never inspects a faction rule
itself:

* :meth:`Interpreter.attack_mods` — fold every in-force effect whose scope
  matches an attack being resolved into an :class:`AttackMods` bundle.
* :meth:`Interpreter.unit_mods` — the same for unit-level characteristics.

Effects arrive as data (:class:`sim2.schema.EffectRecord`). Adding a stratagem
or datasheet ability must never touch kernel source (§2 decision 3).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from ..schema import EffectPrimitive, EffectRecord
from .predicates import UnknownPredicate
from .selectors import EvalContext, Selector, SelectorError, parse_predicate, parse_selector

# Primitives whose scope is read against the ATTACKER's side of an attack.
OFFENSIVE_PRIMITIVES = {
    "modify_characteristic", "grant_weapon_ability", "dice_manipulation",
    "mortal_wounds", "enemy_debuff",
}
# Primitives whose scope is read against the DEFENDER's side.
DEFENSIVE_PRIMITIVES = {"defensive_intervention", "attack_interception", "damage_reduction"}

WEAPON_HEADS = {"weapon", "weapons", "weapon_named", "attacks"}
MODEL_HEADS = {"model", "models", "models_named"}


# --------------------------------------------------------------------------
@dataclass
class AttackMods:
    """Everything the attack sequence may need, already folded."""

    hit_mod: int = 0
    wound_mod: int = 0
    ap_delta: int = 0                 # negative = better AP for the attacker
    save_mod: int = 0
    save_cap: Optional[int] = None    # best save allowed, e.g. 3 for "not past 3+"
    invuln_set: Optional[int] = None
    fnp: Optional[int] = None
    strength_mod: int = 0
    strength_set: Optional[int] = None
    attacks_mod: int = 0
    damage_mod: int = 0
    damage_set: Optional[str] = None
    damage_reduction: int = 0
    skill_mod: int = 0
    skill_set: Optional[int] = None
    crit_hit: int = 6
    crit_wound: int = 6
    reroll_hits: str = ""             # "" | "ones" | "all"
    reroll_wounds: str = ""
    reroll_damage: str = ""
    granted_weapon_abilities: Set[str] = field(default_factory=set)
    ignore_hit_modifiers: bool = False
    ignore_cover: bool = False
    deny_cover: bool = False
    sources: List[str] = field(default_factory=list)

    def has_weapon_ability(self, name: str) -> bool:
        n = name.upper()
        return any(a == n or a.startswith(n + " ") for a in self.granted_weapon_abilities)

    def granted_value(self, name: str, default: int = 0) -> int:
        n = name.upper()
        for a in self.granted_weapon_abilities:
            if a.startswith(n):
                tail = a[len(n):].strip().rstrip("+")
                try:
                    return int(tail)
                except ValueError:
                    return default
        return default


@dataclass
class UnitMods:
    move_mod: float = 0.0
    move_multiplier: float = 1.0
    advance_mod: int = 0
    charge_mod: int = 0
    oc_mod: int = 0
    ld_mod: int = 0
    sv_mod: int = 0
    sv_cap: Optional[int] = None
    fnp: Optional[int] = None
    detection_bonus: float = 0.0
    granted_abilities: Set[str] = field(default_factory=set)
    battle_shock_mod: int = 0
    cannot_shoot: bool = False
    cannot_charge: bool = False
    cannot_be_overwatched: bool = False
    extra_orders: int = 0
    sources: List[str] = field(default_factory=list)

    def has(self, ability: str) -> bool:
        a = ability.upper()
        return any(x == a or x.startswith(a + " ") for x in self.granted_abilities)


# --------------------------------------------------------------------------
class Interpreter:
    def __init__(self, records: Dict[str, EffectRecord]):
        self.records = records
        self.unbound: Set[str] = set()
        self.errors: List[str] = []

    # -- record access ----------------------------------------------------
    def record(self, rid: str) -> Optional[EffectRecord]:
        return self.records.get(rid)

    # -- in-force effects --------------------------------------------------
    def in_force(self, state) -> List[Tuple[EffectRecord, Any]]:
        out = []
        for act in state.active_effects:
            rec = self.records.get(act.record_id)
            if rec is None:
                continue
            out.append((rec, act))
        return out

    # -- scope matching ----------------------------------------------------
    def _scope_matches(
        self,
        scope: str,
        ctx: EvalContext,
        subject_unit: Any,
        weapon: Any,
    ) -> bool:
        if not scope:
            return True
        try:
            sel: Selector = parse_selector(scope)
        except SelectorError as exc:
            self.errors.append(f"bad scope {scope!r}: {exc}")
            return False
        try:
            if sel.head in WEAPON_HEADS:
                if weapon is None:
                    return False
                if not sel.matches(weapon, ctx):
                    return False
                return True
            if sel.head in MODEL_HEADS:
                if subject_unit is None:
                    return False
                return any(sel.matches(m, ctx) for m in subject_unit.alive_models) or sel.matches(
                    subject_unit, ctx
                )
            if sel.head == "enemy_unit":
                # scope written from the effect owner's point of view
                return subject_unit is not None and subject_unit.owner != ctx.player and sel.matches(
                    subject_unit, ctx
                )
            return subject_unit is not None and sel.matches(subject_unit, ctx)
        except UnknownPredicate as exc:
            self.errors.append(str(exc))
            return False
        except SelectorError as exc:
            self.errors.append(str(exc))
            return False

    def _condition_ok(self, cond: str, ctx: EvalContext, subject: Any) -> bool:
        if not cond:
            return True
        try:
            return parse_predicate(cond).eval(subject, ctx)
        except (SelectorError, UnknownPredicate) as exc:
            self.errors.append(f"bad condition {cond!r}: {exc}")
            return False

    # -- folding -----------------------------------------------------------
    def attack_mods(self, state, attack_ctx) -> AttackMods:
        """Fold every matching effect for one attack (attacker + defender)."""
        mods = AttackMods()
        attacker = attack_ctx.attacker_unit
        target = attack_ctx.target_unit
        weapon = attack_ctx.weapon
        for rec, act in self.in_force(state):
            bearer = state.unit(act.bearer_uid) if act.bearer_uid else None
            ctx = EvalContext(
                state=state,
                player=act.source_player,
                bearer=bearer,
                target_unit=target,
                attacker_unit=attacker,
                weapon=weapon,
                attack=attack_ctx,
                extra={
                    "critical_hit": attack_ctx.critical_hit,
                    "critical_wound": attack_ctx.critical_wound,
                    "targets": act.target_uids,
                },
            )
            for prim in rec.effects:
                subject = self._subject_for(prim, attacker, target)
                if subject is None:
                    continue
                if act.target_uids and subject.uid not in act.target_uids:
                    # an effect applied to named units only affects those units
                    if not prim.get("aura"):
                        continue
                scope = prim.get("scope", "")
                if not self._scope_matches(scope, ctx, subject, weapon):
                    continue
                if not self._condition_ok(prim.get("condition", ""), ctx, subject):
                    continue
                self._apply_attack_primitive(prim, mods, rec)
        return mods

    def _subject_for(self, prim: EffectPrimitive, attacker, target):
        family = prim.primitive.split(".")[0]
        side = prim.get("side")
        if side == "attacker":
            return attacker
        if side in ("defender", "target"):
            return target
        if family in DEFENSIVE_PRIMITIVES:
            return target
        if family in OFFENSIVE_PRIMITIVES:
            return attacker
        return attacker

    def _apply_attack_primitive(self, prim: EffectPrimitive, mods: AttackMods, rec: EffectRecord) -> None:
        name = prim.primitive
        family, _, sub = name.partition(".")
        amount = prim.get("amount", 1)
        touched = True

        if family == "modify_characteristic":
            char = str(prim.get("characteristic", "")).lower()
            op = str(prim.get("op", "add")).lower()
            if char in ("bs", "ws", "skill"):
                if op == "set":
                    mods.skill_set = int(amount)
                else:
                    mods.skill_mod += int(amount) * (1 if op in ("improve", "add") else -1)
            elif char in ("s", "strength"):
                if op == "set":
                    mods.strength_set = int(amount)
                else:
                    mods.strength_mod += int(amount)
            elif char == "ap":
                # improve = better AP (more negative); worsen = towards 0
                mods.ap_delta += -int(amount) if op in ("improve", "add") else int(amount)
            elif char in ("d", "damage"):
                if op == "set":
                    mods.damage_set = str(amount)
                else:
                    mods.damage_mod += int(amount) * (1 if op in ("improve", "add") else -1)
            elif char in ("a", "attacks"):
                mods.attacks_mod += int(amount)
            elif char in ("sv", "save"):
                mods.save_mod += int(amount) * (1 if op in ("improve", "add") else -1)
                cap = prim.get("cap")
                if cap is not None:
                    mods.save_cap = int(str(cap).rstrip("+"))
            elif char in ("insv", "invuln"):
                mods.invuln_set = int(str(amount).rstrip("+"))
            else:
                touched = False

        elif family == "grant_weapon_ability":
            for ab in _as_list(prim.get("abilities", prim.get("ability"))):
                mods.granted_weapon_abilities.add(str(ab).upper().replace("_", " "))

        elif family == "dice_manipulation":
            kind = str(prim.get("roll", sub or "")).lower()
            if sub == "reroll" or prim.get("reroll"):
                what = str(prim.get("reroll", prim.get("rolls", "hit"))).lower()
                scope_of = "ones" if str(prim.get("values", "")) in ("1", "ones") else "all"
                if "hit" in what:
                    mods.reroll_hits = _stronger(mods.reroll_hits, scope_of)
                if "wound" in what:
                    mods.reroll_wounds = _stronger(mods.reroll_wounds, scope_of)
                if "damage" in what:
                    mods.reroll_damage = _stronger(mods.reroll_damage, scope_of)
            elif sub == "critical_threshold" or prim.get("critical"):
                which = str(prim.get("critical", "hit")).lower()
                val = int(prim.get("value", 5))
                if "hit" in which:
                    mods.crit_hit = min(mods.crit_hit, val)
                if "wound" in which:
                    mods.crit_wound = min(mods.crit_wound, val)
            elif sub == "modifier":
                which = str(prim.get("rolls", "hit")).lower()
                if "hit" in which:
                    mods.hit_mod += int(amount)
                if "wound" in which:
                    mods.wound_mod += int(amount)
            elif sub == "ignore_modifiers":
                mods.ignore_hit_modifiers = True
            else:
                touched = False

        elif family == "defensive_intervention":
            if sub in ("worsen_ap", "ap_worsen"):
                mods.ap_delta += int(amount)
            elif sub == "feel_no_pain":
                v = int(str(prim.get("value", amount)).rstrip("+"))
                mods.fnp = v if mods.fnp is None else min(mods.fnp, v)
            elif sub in ("toughness", "modify_toughness"):
                mods.wound_mod -= 0    # handled through characteristic path
            elif sub == "grant_cover":
                pass                   # cover is a unit flag, applied in unit_mods
            else:
                touched = False

        elif family == "damage_reduction":
            mods.damage_reduction += int(amount)

        elif family == "enemy_debuff":
            which = str(prim.get("rolls", prim.get("roll", ""))).lower()
            if "hit" in which:
                mods.hit_mod += int(prim.get("amount", -1))
            if "wound" in which:
                mods.wound_mod += int(prim.get("amount", -1))
            if str(prim.get("deny", "")) == "cover":
                mods.deny_cover = True

        else:
            touched = False

        if touched:
            mods.sources.append(rec.id)

    # -- unit level --------------------------------------------------------
    def unit_mods(self, state, unit) -> UnitMods:
        mods = UnitMods()
        for rec, act in self.in_force(state):
            bearer = state.unit(act.bearer_uid) if act.bearer_uid else None
            ctx = EvalContext(
                state=state,
                player=act.source_player,
                bearer=bearer,
                target_unit=unit,
                attacker_unit=unit,
                extra={"targets": act.target_uids},
            )
            for prim in rec.effects:
                if act.target_uids and unit.uid not in act.target_uids and not prim.get("aura"):
                    continue
                scope = prim.get("scope", "")
                if not self._scope_matches(scope, ctx, unit, None):
                    continue
                if not self._condition_ok(prim.get("condition", ""), ctx, unit):
                    continue
                self._apply_unit_primitive(prim, mods, rec)
        return mods

    def _apply_unit_primitive(self, prim: EffectPrimitive, mods: UnitMods, rec: EffectRecord) -> None:
        name = prim.primitive
        family, _, sub = name.partition(".")
        amount = prim.get("amount", 1)
        touched = True

        if family == "modify_characteristic":
            char = str(prim.get("characteristic", "")).lower()
            op = str(prim.get("op", "add")).lower()
            if char == "m":
                if op == "halve":
                    mods.move_multiplier *= 0.5
                else:
                    mods.move_mod += float(amount) * (1 if op in ("improve", "add") else -1)
            elif char == "oc":
                mods.oc_mod += int(amount)
            elif char == "ld":
                mods.ld_mod += int(amount) * (1 if op in ("improve", "add") else -1)
            elif char in ("sv", "save"):
                mods.sv_mod += int(amount) * (1 if op in ("improve", "add") else -1)
                cap = prim.get("cap")
                if cap is not None:
                    mods.sv_cap = int(str(cap).rstrip("+"))
            else:
                touched = False

        elif family == "grant_unit_ability":
            for ab in _as_list(prim.get("abilities", prim.get("ability"))):
                mods.granted_abilities.add(str(ab).upper().replace("_", " "))
            if prim.get("cannot_be_overwatched"):
                mods.cannot_be_overwatched = True

        elif family == "defensive_intervention" and sub == "feel_no_pain":
            v = int(str(prim.get("value", amount)).rstrip("+"))
            mods.fnp = v if mods.fnp is None else min(mods.fnp, v)

        elif family == "enemy_debuff":
            if str(prim.get("characteristic", "")).lower() == "m":
                if str(prim.get("op", "")) == "halve":
                    mods.move_multiplier *= 0.5
                else:
                    mods.move_mod += float(amount)
            if prim.get("charge_penalty"):
                mods.charge_mod += int(prim.get("charge_penalty"))
            if prim.get("battle_shock_modifier"):
                mods.battle_shock_mod += int(prim.get("battle_shock_modifier"))
            if prim.get("cannot_shoot"):
                mods.cannot_shoot = True

        elif family == "detection_modification":
            mods.detection_bonus += float(amount)

        elif family == "order_system" and sub == "extra_orders":
            mods.extra_orders += int(amount)

        else:
            touched = False

        if touched:
            mods.sources.append(rec.id)

    # -- lifecycle ---------------------------------------------------------
    def expire(self, state, when: str) -> None:
        """Drop duration-bound effects whose window has closed."""
        keep = []
        for act in state.active_effects:
            if _expired(act, state, when):
                state.emit("effect_expired", effect=act.record_id)
                continue
            keep.append(act)
        state.active_effects = keep

    def triggers(self, state, window: str, player: int) -> List[EffectRecord]:
        """Records whose trigger window is open now for ``player``."""
        out = []
        for rec in self.records.values():
            if rec.trigger_window != window:
                continue
            if rec.faction and rec.faction not in (state.players[player].faction, ""):
                continue
            out.append(rec)
        return out


def _as_list(v) -> List:
    if v is None:
        return []
    if isinstance(v, (list, tuple, set)):
        return list(v)
    return [v]


def _stronger(current: str, new: str) -> str:
    order = {"": 0, "ones": 1, "all": 2}
    return new if order.get(new, 0) > order.get(current, 0) else current


def _expired(act, state, when: str) -> bool:
    dur = act.expiry
    if dur == "until_end_of_battle" or dur.startswith("while") or dur == "persistent":
        return False
    if when == "end_of_phase" and dur == "until_end_of_phase":
        return True
    if when == "end_of_turn" and dur in ("until_end_of_phase", "until_end_of_turn"):
        return True
    if when == "end_of_battle_round" and dur == "until_end_of_battle_round":
        return True
    if dur.startswith("until_start_of_next"):
        return (
            when == "start_of_phase"
            and act.expires_phase == state.phase
            and (act.expires_player < 0 or act.expires_player == state.active_player)
            and state.turn_index > act.expires_round
        )
    if dur == "until_attacker_finishes_attacks" and when == "attacks_finished":
        return True
    return False
