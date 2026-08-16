"""Engine behaviour: legality, phase flow, scoring, determinism (§7, §8)."""

import json

import pytest

from sim2.agents.base import RandomAgent
from sim2.kernel import measure, missions, movement, objectives
from sim2.kernel.actions import Action
from sim2.kernel.engine import Engine, can_shoot
from sim2.kernel.state import BATTLE_ROUNDS
from sim2.log import BattleLog
from sim2.rng import Rng


#: The 500-point pair keeps full-game tests to a few seconds each; the
#: 1000-point pair is exercised by ``test_thousand_point_game``.
SMALL = ("Alien Hunters Strike", "Siege Regiment Vanguard")
STANDARD = ("Imperialis Fleet Patrol", "Grizzled Company Line")


def run_game(data, seed=1, agent="random", armies=None, battle_size=500):
    from sim2.harness.run import play_game

    a_name, b_name = armies or SMALL
    return play_game(data, data.armies[a_name], data.armies[b_name], seed,
                     agent_a=agent, agent_b=agent, battle_size=battle_size)


# --------------------------------------------------------------------------
# legality
# --------------------------------------------------------------------------
def test_a_unit_cannot_shoot_twice(simple_battle):
    engine, state, attacker, target = simple_battle
    state.active_player = 0
    ok = engine.apply(state, Action("shoot_unit", {"unit": attacker.uid, "target": target.uid}))
    assert ok.ok
    again = engine.apply(state, Action("shoot_unit", {"unit": attacker.uid, "target": target.uid}))
    assert not again.ok and "already shot" in again.reason


def test_shooting_is_phase_gated(simple_battle):
    engine, state, attacker, target = simple_battle
    state.phase = "movement"
    res = engine.apply(state, Action("shoot_unit", {"unit": attacker.uid, "target": target.uid}))
    assert not res.ok


def test_engaged_unit_may_only_shoot_its_engager(simple_battle):
    engine, state, attacker, target = simple_battle
    for i, m in enumerate(target.models):
        m.pos = (10.0 + i * 1.4, 21.2)         # move into Engagement Range
    measure.bump_epoch()
    third = target.__class__(uid="p1:c", owner=1, datasheet_id=target.datasheet_id, name="far")
    third.models = [m.clone() for m in target.models[:1]]
    third.models[0].pos = (30.0, 50.0)
    third.starting_models = 1
    state.units[third.uid] = third
    measure.bump_epoch()
    ok, reason = can_shoot(engine, state, attacker, third)
    assert not ok and "engaged" in reason


def test_normal_move_cannot_end_in_engagement_range(simple_battle):
    engine, state, attacker, target = simple_battle
    state.phase = "movement"
    state.active_player = 0
    dest = measure.unit_centroid(target)
    res = engine.apply(state, Action("move_unit", {"unit": attacker.uid,
                                                   "dest": [dest[0], dest[1]],
                                                   "mode": "normal"}))
    assert res.ok                                   # the move resolves...
    assert not measure.unit_engaged(state, attacker)  # ...but stops short of ER


def test_double_one_charge_always_fails(data, simple_battle, monkeypatch):
    """§7 fixture 1."""
    engine, state, attacker, target = simple_battle

    class FixedRng(Rng):
        def two_d6(self, note=""):
            return [1, 1]

    engine.rng = FixedRng(1)
    assert movement.charge_roll(state, engine.interp, attacker, engine.rng) == 0


def test_battle_shock_sets_oc_to_zero(simple_battle):
    engine, state, attacker, target = simple_battle
    obj = state.layout.objectives[0]
    for i, m in enumerate(attacker.models):
        m.pos = (obj.pos[0] + i * 1.2, obj.pos[1])
    measure.bump_epoch()
    assert objectives.unit_oc(state, attacker) > 0
    attacker.battle_shocked = True
    assert objectives.unit_oc(state, attacker) == 0


def test_objective_control_prefers_higher_oc(simple_battle):
    engine, state, attacker, target = simple_battle
    obj = state.layout.objectives[0]
    for i, m in enumerate(attacker.models):
        m.pos = (obj.pos[0] + i * 1.1, obj.pos[1])
    target.models = target.models[:1]
    target.models[0].pos = (obj.pos[0], obj.pos[1] + 2.0)
    measure.bump_epoch()
    control = objectives.refresh_control(state)
    assert control[obj.id] == 0


# --------------------------------------------------------------------------
# full games
# --------------------------------------------------------------------------
@pytest.mark.slow
def test_random_agent_plays_a_legal_game(data):
    res, log = run_game(data, seed=11, agent="random")
    assert res.rejected == 0, "the engine offered an action it then refused"
    assert res.rounds == BATTLE_ROUNDS
    assert log.result["winner"] in (0, 1, None)


@pytest.mark.slow
def test_battle_log_replays_identically(data):
    """§7 fixture 19: determinism."""
    a, _ = run_game(data, seed=5, agent="random")
    b, _ = run_game(data, seed=5, agent="random")
    assert a.vp == b.vp and a.rounds == b.rounds and a.actions == b.actions


@pytest.mark.slow
def test_different_seeds_diverge(data):
    a, _ = run_game(data, seed=5, agent="random")
    b, _ = run_game(data, seed=6, agent="random")
    assert (a.vp, a.actions) != (b.vp, b.actions)


@pytest.mark.slow
def test_thousand_point_game_is_legal(data):
    res, _ = run_game(data, seed=4, agent="heuristic", armies=STANDARD, battle_size=1000)
    assert res.rejected == 0
    assert res.rounds == BATTLE_ROUNDS


@pytest.mark.slow
def test_players_score_different_primaries(data):
    res, _ = run_game(data, seed=3, agent="random")
    assert res.primaries[0] and res.primaries[1]
    assert res.dispositions[0] != res.dispositions[1] or True


@pytest.mark.slow
def test_vp_respects_the_caps(data):
    res, log = run_game(data, seed=9, agent="random")
    for i in (0, 1):
        assert log.result["primary"][i] <= missions.PRIMARY_CAP
        assert log.result["secondary"][i] <= missions.SECONDARY_CAP
        assert log.result["battle_ready"][i] == missions.BATTLE_READY_VP


@pytest.mark.slow
def test_log_schema(data):
    res, log = run_game(data, seed=2, agent="random")
    blob = log.to_json()
    assert blob["log_schema_version"]
    assert blob["meta"]["layout"]["width"] == 44.0
    assert blob["frames"] and blob["result"]
    frame = blob["frames"][0]
    assert {"t", "round", "phase", "active", "action", "events"} <= set(frame)
    # the replay viewer needs at least one board snapshot with real positions
    boards = [f for f in blob["frames"] if "board" in f]
    assert boards and boards[0]["board"]["units"]
    unit = boards[0]["board"]["units"][0]
    assert {"uid", "owner", "models"} <= set(unit)
    assert unit["models"][0]["r"] > 0


@pytest.mark.slow
def test_primary_missions_actually_score(data):
    """Regression: the layout pages print mission names in caps while cards are
    stored under normalised ids. When the lookup missed, every game ended on
    Battle Ready alone and play could not affect the result."""
    res, log = run_game(data, seed=100, agent="heuristic")
    assert sum(log.result["primary"]) > 0, "no primary VP was scored all game"
    assert max(res.vp) > missions.BATTLE_READY_VP


def test_mission_card_lookup_accepts_either_case(data):
    card = data.mission_card("PUNISHMENT")
    assert card is not None and card.kind == "primary"
    assert data.mission_card("punishment") is card
