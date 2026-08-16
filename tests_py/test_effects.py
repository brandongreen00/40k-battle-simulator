"""Selector algebra, the effect interpreter, and the Order subsystem."""

import pytest

from sim2.effects.interpreter import Interpreter
from sim2.effects.predicates import UnknownPredicate
from sim2.effects.selectors import EvalContext, SelectorError, parse_selector
from sim2.kernel import measure
from sim2.kernel.attacks import AttackContext
from sim2.schema import EffectPrimitive, EffectRecord, TargetSpec


def ctx_for(state, player=0, **kw):
    return EvalContext(state=state, player=player, **kw)


def test_selector_parses_keyword_algebra():
    sel = parse_selector("unit(DEATHWATCH & INFANTRY & !engaged & from_my_army)")
    assert sel.head == "unit"


def test_selector_rejects_unknown_head():
    with pytest.raises(SelectorError):
        parse_selector("spaceship(FAST)")


def test_selector_keyword_matching(simple_battle):
    engine, state, attacker, target = simple_battle
    sel = parse_selector("unit(INFANTRY & from_my_army)")
    ctx = ctx_for(state, 0)
    picked = sel.select(ctx)
    assert attacker in picked and target not in picked


def test_selector_enemy_and_distance(simple_battle):
    engine, state, attacker, target = simple_battle
    ctx = ctx_for(state, 0, bearer=attacker)
    near = parse_selector('enemy_unit(within(14", bearer))').select(ctx)
    far = parse_selector('enemy_unit(within(4", bearer))').select(ctx)
    assert target in near
    assert far == []


def test_within_and_wholly_within_differ(simple_battle):
    engine, state, attacker, target = simple_battle
    # spread the target so only part of it is close
    target.models[-1].pos = (40.0, 55.0)
    measure.bump_epoch()
    ctx = ctx_for(state, 0, bearer=attacker)
    assert target in parse_selector('enemy_unit(within(14", bearer))').select(ctx)
    assert target not in parse_selector('enemy_unit(wholly_within(14", bearer))').select(ctx)


def test_unknown_predicate_is_loud_not_silent():
    from sim2.effects.predicates import evaluate_atom

    with pytest.raises(UnknownPredicate):
        evaluate_atom("wibbles", [], object(), EvalContext(state=None))


# --------------------------------------------------------------------------
def make_record(rid, primitive, **params):
    return EffectRecord(
        id=rid, kind="stratagem", name=rid,
        targets=[TargetSpec("unit(from_my_army)")],
        effects=[EffectPrimitive(primitive, params)],
        duration="until_end_of_phase",
    )


def test_interpreter_folds_ap_worsening(simple_battle):
    engine, state, attacker, target = simple_battle
    rec = make_record("test.armour_of_contempt", "defensive_intervention.worsen_ap",
                      amount=1, scope="unit(from_my_army)")
    engine.interp.records[rec.id] = rec
    state.active_effects.append(
        engine.data.make_active(rec.id, target.owner, targets=[target.uid])
    )
    weapon = [w for w in engine.data.datasheets[attacker.datasheet_id].weapons
              if w.kind == "ranged"][0]
    actx = AttackContext(attacker_unit=attacker, target_unit=target, weapon=weapon)
    mods = engine.interp.attack_mods(state, actx)
    assert mods.ap_delta == 1               # AP worsened toward 0 for the attacker


def test_interpreter_grants_weapon_abilities(simple_battle):
    engine, state, attacker, target = simple_battle
    rec = make_record("test.lethal", "grant_weapon_ability",
                      abilities=["LETHAL HITS"], scope="unit(from_my_army)")
    engine.interp.records[rec.id] = rec
    state.active_effects.append(
        engine.data.make_active(rec.id, attacker.owner, targets=[attacker.uid])
    )
    weapon = [w for w in engine.data.datasheets[attacker.datasheet_id].weapons
              if w.kind == "ranged"][0]
    mods = engine.interp.attack_mods(
        state, AttackContext(attacker_unit=attacker, target_unit=target, weapon=weapon)
    )
    assert mods.has_weapon_ability("LETHAL HITS")


def test_take_cover_caps_the_save(data):
    """Order semantics fixture (§7 #14): Take Cover! cannot pass 3+."""
    rec = data.effects.get("am.voice_of_command.take_cover")
    assert rec is not None, "the six core Orders must be in the snapshot"
    prim = rec.effects[0]
    assert prim.get("characteristic") == "sv"
    assert str(prim.get("cap")) == "3+"
    assert "3+" in rec.text


def test_all_six_orders_are_bound(data):
    orders = [r for r in data.effects.values() if r.kind == "order"]
    assert len(orders) == 6
    assert all(r.bound for r in orders)
    names = {r.name for r in orders}
    assert "Take Aim!" in names and "Move! Move! Move!" in names


def test_effect_records_carry_provenance(data):
    for rec in list(data.effects.values())[:50]:
        assert rec.provenance.source, rec.id
        assert rec.provenance.retrieved, rec.id
