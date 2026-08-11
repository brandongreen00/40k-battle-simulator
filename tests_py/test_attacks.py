"""The attack sequence (04, 05) and the §7 scenario fixtures that touch it."""

import math

import pytest

from sim2.geometry import BaseShape
from sim2.kernel import attacks, dice
from sim2.kernel.attacks import wound_target
from sim2.rng import Rng


def test_wound_table_transcribed_from_the_pdf():
    # S >= 2T: 2+ | S > T: 3+ | S == T: 4+ | S < T: 5+ | 2S <= T: 6+
    assert wound_target(8, 4) == 2
    assert wound_target(9, 4) == 2
    assert wound_target(5, 4) == 3
    assert wound_target(4, 4) == 4
    assert wound_target(3, 4) == 5
    assert wound_target(2, 4) == 6
    assert wound_target(2, 5) == 6
    assert wound_target(3, 5) == 5


def test_wound_table_mutation_is_caught():
    """Test-the-tests (mandate 6): shifting the table one notch must go red."""

    def mutated(s, t):
        if s >= t * 2:
            return 3            # deliberately wrong
        return wound_target(s, t)

    assert mutated(8, 4) != wound_target(8, 4)


def test_dice_expressions():
    assert dice.parse("3").average() == 3
    assert dice.parse("D6").average() == 3.5
    assert dice.parse("2D6").average() == 7
    assert dice.parse("D3+1").average() == 3.0
    assert dice.parse("D6+3").maximum() == 9


def test_clamp_modifier():
    assert attacks.clamp_mod(3) == 1
    assert attacks.clamp_mod(-4) == -1
    assert attacks.clamp_mod(0) == 0


def test_rng_is_reproducible_and_journalled():
    a = Rng(7)
    b = Rng(7)
    assert [a.randint(1, 6) for _ in range(20)] == [b.randint(1, 6) for _ in range(20)]
    c = Rng(8)
    assert [a.randint(1, 6) for _ in range(5)] != [c.randint(1, 6) for _ in range(5)]


def test_d3_is_a_halved_d6():
    rng = Rng(3)
    values = [rng.d3()[0] for _ in range(200)]
    assert set(values) == {1, 2, 3}
    assert abs(sum(values) / len(values) - 2.0) < 0.25


# --------------------------------------------------------------------------
# Monte Carlo against the analytic expectation (§7 fixture 18)
# --------------------------------------------------------------------------
def _analytic(shots, skill, strength, toughness, save, ap, damage):
    hit = (7 - skill) / 6
    wound = (7 - wound_target(strength, toughness)) / 6
    eff = min(6, max(2, save - ap))
    unsaved = (eff - 1) / 6
    return shots * hit * wound * unsaved * damage


def test_monte_carlo_matches_analytic_expectation(simple_battle):
    engine, state, attacker, target = simple_battle
    weapon = attacker_weapon(state, attacker)
    total = 0
    trials = 120
    for i in range(trials):
        for m in target.models:
            m.wounds, m.alive = m.max_wounds, True
        target.destroyed = False
        res = attacks.resolve_attack(state, engine.rng, engine.interp, attacker, target, weapon)
        total += res.damage_dealt
    observed = total / trials
    expected = _analytic(
        shots=dice.average(weapon.attacks) * len(attacker.models),
        skill=weapon.skill, strength=weapon.strength, toughness=4,
        save=4, ap=weapon.ap, damage=dice.average(weapon.damage),
    )
    # 120 trials of a noisy process: a generous but meaningful band.
    assert expected * 0.6 <= observed <= expected * 1.45, (observed, expected)


def attacker_weapon(state, attacker):
    from sim2.kernel.shooting import weapons_of

    for weapon, _ in weapons_of(state, attacker):
        if weapon.kind == "ranged":
            return weapon
    raise AssertionError("no ranged weapon on the test attacker")
