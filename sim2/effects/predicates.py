"""Predicate registry for the selector algebra (§3.3).

Predicates compose over keywords, distances (``within`` and ``wholly_within``
are DISTINCT), visibility (``visible`` vs ``fully_visible``), engagement,
objective range, embarked state, half strength, battle-shock, this-turn move
state, order state, and per-battle bookkeeping flags.

Anything not in this registry raises :class:`UnknownPredicate`. That is
deliberate: an unexpressible rule is a logged ontology-extension task, never a
silently-true or silently-false clause.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from .selectors import EvalContext, SelectorError


class UnknownPredicate(SelectorError):
    pass


Predicate = Callable[[Any, List[Any], EvalContext], bool]
REGISTRY: Dict[str, Predicate] = {}


def predicate(name: str) -> Callable[[Predicate], Predicate]:
    def deco(fn: Predicate) -> Predicate:
        REGISTRY[name] = fn
        return fn

    return deco


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _keywords(obj: Any) -> List[str]:
    kws = getattr(obj, "keywords", None) or []
    return [k.upper().replace("_", " ") for k in kws]


def _resolve_ref(ref: Any, ctx: EvalContext) -> Any:
    """Resolve a selector argument that names an actor ('bearer', 'target')."""
    if isinstance(ref, str):
        key = ref.strip().lower()
        if key in ("bearer", "self", "source"):
            return ctx.bearer
        if key in ("target", "target_unit"):
            return ctx.target_unit
        if key in ("attacker", "attacker_unit"):
            return ctx.attacker_unit
        if key in ctx.extra:
            return ctx.extra[key]
    return ref


def _units(ctx: EvalContext) -> List[Any]:
    st = ctx.state
    if st is None:
        return []
    return [u for u in st.units.values() if not u.destroyed]


def candidates_for_head(head: str, ctx: EvalContext) -> List[Any]:
    st = ctx.state
    if head in ("bearer", "self"):
        return [ctx.bearer] if ctx.bearer is not None else []
    if head == "target_unit":
        return [ctx.target_unit] if ctx.target_unit is not None else []
    if head in ("unit", "friendly_unit"):
        return [u for u in _units(ctx) if u.owner == ctx.player]
    if head == "enemy_unit":
        return [u for u in _units(ctx) if u.owner != ctx.player]
    if head == "any_unit":
        return _units(ctx)
    if head in ("model", "models"):
        out = []
        for u in _units(ctx):
            out.extend([m for m in u.models if m.alive])
        return out
    if head in ("weapon", "weapons", "weapon_named"):
        return list(ctx.extra.get("weapon_pool", []) or ([ctx.weapon] if ctx.weapon else []))
    if head == "attacks":
        return [ctx.attack] if ctx.attack is not None else []
    if head == "objective":
        return list(st.layout.objectives) if st is not None else []
    if head in ("abilities_named", "models_named"):
        return list(ctx.extra.get("named_pool", []))
    return []


def evaluate_atom(name: str, args: List[Any], obj: Any, ctx: EvalContext) -> bool:
    fn = REGISTRY.get(name.lower())
    if fn is not None:
        return fn(obj, args, ctx)
    # A bare atom that is not a registered flag is read as a KEYWORD test.
    # Keywords on datasheets are printed in caps; selector text mirrors that.
    if name.upper() == name or " " in name:
        return name.upper().replace("_", " ") in _keywords(obj)
    raise UnknownPredicate(f"unknown predicate {name!r}")


# --------------------------------------------------------------------------
# ownership / identity
# --------------------------------------------------------------------------
@predicate("from_my_army")
def _from_my_army(obj, args, ctx):
    return getattr(obj, "owner", None) == ctx.player


@predicate("friendly")
def _friendly(obj, args, ctx):
    return getattr(obj, "owner", None) == ctx.player


@predicate("enemy")
def _enemy(obj, args, ctx):
    owner = getattr(obj, "owner", None)
    return owner is not None and owner != ctx.player


@predicate("is_bearer")
def _is_bearer(obj, args, ctx):
    return ctx.bearer is not None and getattr(obj, "uid", None) == getattr(ctx.bearer, "uid", None)


@predicate("named")
def _named(obj, args, ctx):
    want = {str(a).lower() for a in args}
    return str(getattr(obj, "name", "")).lower() in want


@predicate("datasheet")
def _datasheet(obj, args, ctx):
    want = {str(a).lower() for a in args}
    return str(getattr(obj, "datasheet_id", "")).lower() in want


@predicate("has")
def _has(obj, args, ctx):
    """Unit has an ability (granted or innate) / weapon has a weapon ability."""
    want = str(args[0]).upper().replace("_", " ") if args else ""
    abilities = getattr(obj, "abilities", None)
    if abilities is None:
        abilities = getattr(obj, "granted_abilities", []) or []
    pool = [str(a).upper() for a in abilities]
    return any(p == want or p.startswith(want + " ") for p in pool)


# --------------------------------------------------------------------------
# distance / position
# --------------------------------------------------------------------------
def _min_gap(a: Any, b: Any, ctx: EvalContext) -> float:
    from ..kernel import measure

    return measure.unit_gap(a, b)


@predicate("within")
def _within(obj, args, ctx):
    if not args:
        return False
    d = float(args[0])
    other = _resolve_ref(args[1] if len(args) > 1 else "bearer", ctx)
    if other is None or obj is None:
        return False
    return _min_gap(obj, other, ctx) <= d


@predicate("wholly_within")
def _wholly_within(obj, args, ctx):
    """Every model of the unit within N" — distinct from ``within``."""
    from ..kernel import measure

    if not args:
        return False
    d = float(args[0])
    other = _resolve_ref(args[1] if len(args) > 1 else "bearer", ctx)
    if other is None or obj is None:
        return False
    return measure.unit_wholly_within(obj, other, d)


@predicate("within_objective_range")
def _within_objective_range(obj, args, ctx):
    from ..kernel import objectives

    return objectives.unit_in_range_of_any_objective(ctx.state, obj)


@predicate("controls_objective")
def _controls_objective(obj, args, ctx):
    from ..kernel import objectives

    return objectives.unit_controls_an_objective(ctx.state, obj)


@predicate("visible")
def _visible(obj, args, ctx):
    from ..kernel import visibility

    other = _resolve_ref(args[0] if args else "bearer", ctx)
    if other is None:
        return False
    return visibility.unit_visible(ctx.state, other, obj)


@predicate("fully_visible")
def _fully_visible(obj, args, ctx):
    from ..kernel import visibility

    other = _resolve_ref(args[0] if args else "bearer", ctx)
    if other is None:
        return False
    return visibility.unit_fully_visible(ctx.state, other, obj)


@predicate("in_terrain_area")
def _in_terrain(obj, args, ctx):
    from ..kernel import visibility

    return visibility.unit_in_terrain_area(ctx.state, obj)


@predicate("engaged")
def _engaged(obj, args, ctx):
    from ..kernel import measure

    return measure.unit_engaged(ctx.state, obj)


@predicate("engaged_with")
def _engaged_with(obj, args, ctx):
    from ..kernel import measure

    other = _resolve_ref(args[0] if args else "bearer", ctx)
    return other is not None and measure.units_engaged(obj, other)


@predicate("on_battlefield")
def _on_battlefield(obj, args, ctx):
    return not getattr(obj, "in_reserves", False) and not getattr(obj, "destroyed", True)


# --------------------------------------------------------------------------
# unit state
# --------------------------------------------------------------------------
@predicate("battle_shocked")
def _battle_shocked(obj, args, ctx):
    return bool(getattr(obj, "battle_shocked", False))


@predicate("below_half_strength")
def _below_half(obj, args, ctx):
    return bool(obj.below_half_strength()) if hasattr(obj, "below_half_strength") else False


@predicate("embarked")
def _embarked(obj, args, ctx):
    return bool(getattr(obj, "embarked_in", ""))


@predicate("in_reserves")
def _in_reserves(obj, args, ctx):
    return bool(getattr(obj, "in_reserves", False))


@predicate("set_up_this_turn")
def _set_up_this_turn(obj, args, ctx):
    return bool(getattr(obj, "set_up_this_turn", False))


@predicate("moved_this_turn")
def _moved(obj, args, ctx):
    return bool(getattr(obj, "moved", False))


@predicate("advanced")
def _advanced(obj, args, ctx):
    return getattr(obj, "move_mode", "") == "advance"


@predicate("fell_back")
def _fell_back(obj, args, ctx):
    return getattr(obj, "move_mode", "") == "fall_back"


@predicate("remained_stationary")
def _remained(obj, args, ctx):
    return getattr(obj, "move_mode", "") in ("", "stationary")


@predicate("disembarked_this_turn")
def _disembarked(obj, args, ctx):
    return bool(getattr(obj, "disembarked", False))


@predicate("charged_this_turn")
def _charged(obj, args, ctx):
    return bool(getattr(obj, "charged", False))


@predicate("selected_to_shoot_this_phase")
def _shot(obj, args, ctx):
    return bool(getattr(obj, "shot", False))


@predicate("has_fought_this_phase")
def _fought(obj, args, ctx):
    return bool(getattr(obj, "fought", False))


@predicate("affected_by_order")
def _affected_by_order(obj, args, ctx):
    orders = getattr(obj, "orders", None) or []
    if not args:
        return bool(orders)
    want = str(args[0]).lower()
    return any(want in str(o).lower() for o in orders)


@predicate("targeted_by_current_attacker")
def _targeted(obj, args, ctx):
    tgt = ctx.target_unit
    return tgt is not None and getattr(obj, "uid", None) == getattr(tgt, "uid", None)


@predicate("is_warlord")
def _warlord(obj, args, ctx):
    return bool(getattr(obj, "warlord", False))


@predicate("starting_strength_at_least")
def _starting_strength(obj, args, ctx):
    n = int(args[0]) if args else 1
    return getattr(obj, "starting_models", 0) >= n


# --------------------------------------------------------------------------
# weapons / attacks
# --------------------------------------------------------------------------
@predicate("ranged")
def _ranged(obj, args, ctx):
    return getattr(obj, "kind", "") == "ranged"


@predicate("melee")
def _melee(obj, args, ctx):
    return getattr(obj, "kind", "") == "melee"


@predicate("weapon_name")
def _weapon_name(obj, args, ctx):
    want = {str(a).lower() for a in args}
    name = str(getattr(obj, "name", "")).lower()
    return name in want or any(name.startswith(w + " –") or name.startswith(w + " -") for w in want)


@predicate("on_critical_wound")
def _on_crit_wound(obj, args, ctx):
    return bool(ctx.extra.get("critical_wound", False))


@predicate("on_critical_hit")
def _on_crit_hit(obj, args, ctx):
    return bool(ctx.extra.get("critical_hit", False))


@predicate("phase")
def _phase(obj, args, ctx):
    st = ctx.state
    return st is not None and st.phase == str(args[0]).lower()


@predicate("always")
def _always(obj, args, ctx):
    return True


@predicate("never")
def _never(obj, args, ctx):
    return False
