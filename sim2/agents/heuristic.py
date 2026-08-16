"""Heuristic agent: a transparent, competent baseline (§8 Stage A).

Every action is scored by an explicit, inspectable evaluation — expected damage
traded, objective control, threat exposure, mission progress. The weights are
data (:class:`Weights`), which is what makes this both tunable by the optimizer
and a sane prior for the search and RL agents.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..kernel import attacks, dice, measure, objectives, visibility
from ..kernel.actions import Action
from ..kernel.datacache import datasheet, model_profile_for
from .base import Player


@dataclass
class Weights:
    objective_control: float = 12.0
    damage_dealt: float = 1.0
    overkill_penalty: float = 0.6
    threat_exposure: float = 0.35
    charge_value: float = 0.9
    deploy_forward: float = 0.6
    reserve_fraction: float = 0.0
    stratagem_bias: float = 0.4
    order_bias: float = 3.0
    action_bias: float = 2.0

    def to_json(self) -> Dict[str, float]:
        return asdict(self)

    @staticmethod
    def from_json(d: Dict[str, float]) -> "Weights":
        return Weights(**{k: float(v) for k, v in (d or {}).items() if k in Weights().to_json()})


class HeuristicAgent(Player):
    name = "heuristic"

    def __init__(self, rng, weights: Optional[Weights] = None):
        self.rng = rng
        self.w = weights or Weights()

    # ------------------------------------------------------------------
    def choose(self, engine, state, player: int, actions: List[Action]) -> Action:
        best: Optional[Tuple[float, Action]] = None
        for action in actions:
            score = self.score(engine, state, player, action)
            if best is None or score > best[0]:
                best = (score, action)
        return best[1] if best else actions[0]

    # ------------------------------------------------------------------
    def score(self, engine, state, player: int, action: Action) -> float:
        kind = action.kind
        fn = getattr(self, f"_score_{kind}", None)
        if fn is None:
            return 0.0
        try:
            return fn(engine, state, player, action)
        except Exception:
            return -1e6      # never let a scoring bug pick an action blindly

    # -- deployment ----------------------------------------------------
    def _score_deploy_unit(self, engine, state, player, action) -> float:
        pos = tuple(action.params["pos"])
        unit = state.unit(action.params["unit"])
        score = 0.0
        for obj in state.layout.objectives:
            d = math.hypot(pos[0] - obj.pos[0], pos[1] - obj.pos[1])
            score += self.w.objective_control / max(4.0, d)
        # push shooty units forward a little, slow units less
        score += self.w.deploy_forward * (1.0 if unit and unit.model_count > 3 else 0.5)
        return score

    def _score_place_in_reserves(self, engine, state, player, action) -> float:
        return self.w.reserve_fraction

    # -- movement ------------------------------------------------------
    def _score_move_unit(self, engine, state, player, action) -> float:
        unit = state.unit(action.params["unit"])
        if unit is None:
            return -1e6
        dest = tuple(action.params["dest"])
        mode = action.params.get("mode", "normal")
        score = 0.0
        for obj in state.layout.objectives:
            d = math.hypot(dest[0] - obj.pos[0], dest[1] - obj.pos[1])
            holder = state.pending.get("objective_control", {}).get(obj.id)
            weight = self.w.objective_control * (1.4 if holder != player else 0.8)
            score += weight / max(3.0, d)
        # closing to a useful shooting band is worth something
        enemies = state.opponent_units(player)
        if enemies:
            nearest = min(math.hypot(dest[0] - measure.unit_centroid(e)[0],
                                     dest[1] - measure.unit_centroid(e)[1]) for e in enemies)
            score += 4.0 / max(6.0, nearest)
            score -= self.w.threat_exposure * (1.0 if nearest < 9.0 else 0.0)
        if mode == "advance":
            score -= 1.5          # advancing usually costs the unit its shooting
        if mode == "stationary":
            score -= 0.5
        return score

    def _score_arrive_from_reserves(self, engine, state, player, action) -> float:
        return 6.0 + self._score_deploy_unit(engine, state, player, action) * 0.5

    # -- shooting ------------------------------------------------------
    def _score_shoot_unit(self, engine, state, player, action) -> float:
        unit = state.unit(action.params["unit"])
        target = state.unit(action.params["target"])
        if unit is None or target is None:
            return -1e6
        ev = expected_damage(state, unit, target)
        value = unit_value(state, target)
        capped = min(ev, target.total_wounds())      # overkill is wasted fire
        score = self.w.damage_dealt * capped * (value / max(1.0, target.starting_wounds))
        score -= self.w.overkill_penalty * max(0.0, ev - target.total_wounds()) * 0.1
        if objectives.unit_controls_an_objective(state, target):
            score += 3.0
        if target.is_character():
            score += 2.0
        return score

    # -- charge / fight -------------------------------------------------
    def _score_charge(self, engine, state, player, action) -> float:
        unit = state.unit(action.params["unit"])
        targets = [state.unit(t) for t in action.params["targets"]]
        targets = [t for t in targets if t]
        if unit is None or not targets:
            return -1e6
        target = targets[0]
        need = max(0.0, measure.unit_gap(unit, target) - measure.ENGAGEMENT_HORIZONTAL)
        p = charge_probability(need)
        gain = expected_damage(state, unit, target, melee=True)
        risk = expected_damage(state, target, unit, melee=True)
        return self.w.charge_value * p * (gain - 0.6 * risk)

    def _score_fight(self, engine, state, player, action) -> float:
        unit = state.unit(action.params["unit"])
        target = state.unit(action.params["target"])
        if unit is None or target is None:
            return -1e6
        return 20.0 + expected_damage(state, unit, target, melee=True)

    # -- command / stratagems ------------------------------------------
    def _score_issue_order(self, engine, state, player, action) -> float:
        return self.w.order_bias

    def _score_use_stratagem(self, engine, state, player, action) -> float:
        from ..kernel import stratagems

        rec = engine.data.effects.get(action.params.get("stratagem", ""))
        if rec is None or not rec.bound:
            return -1.0       # never spend CP on a card with no in-game effect
        return self.w.stratagem_bias * (2.0 if rec.cost_cp <= 1 else 1.0)

    def _score_start_action(self, engine, state, player, action) -> float:
        return self.w.action_bias

    def _score_end_phase(self, engine, state, player, action) -> float:
        return 0.05           # only when nothing else scores

    def _score_pass(self, engine, state, player, action) -> float:
        return 0.0


# --------------------------------------------------------------------------
# Analytic evaluation (mirrors the attack sequence without rolling dice)
# --------------------------------------------------------------------------
def charge_probability(needed: float) -> float:
    if needed <= 2:
        return 1.0
    n = math.ceil(needed)
    if n > 12:
        return 0.0
    ways = sum(1 for a in range(1, 7) for b in range(1, 7) if a + b >= n and not (a == 1 and b == 1))
    return ways / 36.0


def expected_damage(state, attacker, target, melee: bool = False) -> float:
    """Analytic hit -> wound -> save -> damage expectation (memoised per epoch)."""
    cache = measure.vis_cache()
    key = ("ev", attacker.uid, target.uid, melee)
    hit = cache.get(key)
    if hit is not None:
        return hit
    value = _expected_damage_uncached(state, attacker, target, melee)
    cache[key] = value
    return value


def _expected_damage_uncached(state, attacker, target, melee: bool = False) -> float:
    if not attacker.alive_models or not target.alive_models:
        return 0.0
    from ..kernel.shooting import weapons_of

    prof = model_profile_for(state, target, target.alive_models[0])
    t_t = prof.t if prof else 4
    t_sv = prof.sv if prof else 4
    t_inv = prof.invuln if prof else None
    distance = measure.unit_gap(attacker, target)
    total = 0.0
    for weapon, carriers in weapons_of(state, attacker):
        if melee != (weapon.kind == "melee"):
            continue
        if weapon.kind == "ranged" and distance > weapon.range_in:
            continue
        shots = dice.average(weapon.attacks) * carriers
        if weapon.has("RAPID FIRE") and distance <= weapon.range_in / 2:
            shots += weapon.ability_value("RAPID FIRE", 1) * carriers
        hit = 1.0 if weapon.has("TORRENT") else max(0.0, (7 - weapon.skill) / 6.0)
        need = attacks.wound_target(weapon.strength, t_t)
        wound = max(0.0, (7 - need) / 6.0)
        save = weapon.ap and t_sv - weapon.ap or t_sv
        if t_inv:
            save = min(save, t_inv)
        save = min(7, max(2, save))
        unsaved = max(0.0, (save - 1) / 6.0)
        dmg = dice.average(weapon.damage)
        total += shots * hit * wound * unsaved * dmg
    return total


def unit_value(state, unit) -> float:
    ds = datasheet(state, unit.datasheet_id)
    if ds is None or not ds.points:
        return float(unit.starting_wounds or 1)
    return float(min(t.points for t in ds.points))
