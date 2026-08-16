"""The battle engine: phase machine, action application, battle loop.

Agents never mutate state. They pick from :func:`legal_actions` and hand the
choice to :meth:`Engine.apply`, which re-validates it. That is what makes the
"zero illegal actions" exit metric meaningful (§8 Stage A).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..effects.interpreter import Interpreter
from ..rng import Rng
from ..schema import Army, Layout
from . import attacks, measure, missions, movement, objectives, visibility
from .actions import Action
from .datacache import datasheet, unit_leadership
from .state import BATTLE_ROUNDS, PHASES, GameState, PlayerState, UnitState, new_unit_from_datasheet


@dataclass
class ApplyResult:
    ok: bool
    reason: str = ""
    events: List[Dict[str, Any]] = field(default_factory=list)


class Engine:
    """Owns the rules; owns no strategy."""

    def __init__(self, data, rng: Rng, log=None):
        self.data = data
        self.rng = rng
        self.interp = Interpreter(data.effects)
        self.log = log

    # ------------------------------------------------------------------
    # Setup
    # ------------------------------------------------------------------
    def new_battle(
        self,
        armies: List[Army],
        layout: Layout,
        battle_size: int = 1000,
        secondary_mode: str = "tactical",
    ) -> GameState:
        players = []
        for i, army in enumerate(armies):
            disposition = self.data.disposition_for(army)
            players.append(
                PlayerState(
                    index=i,
                    name=army.name,
                    faction=army.faction,
                    detachments=list(army.detachments),
                    disposition=disposition,
                    secondary_mode=secondary_mode,
                    cp=0,
                )
            )
        state = GameState(layout=layout, players=players, battle_size=battle_size)
        state.data = self.data

        # Attacker/Defender roll-off (Event sequence step 5).
        roll = [sum(self.rng.two_d6(note="attacker roll-off")) for _ in range(2)]
        while roll[0] == roll[1]:
            roll = [sum(self.rng.two_d6(note="attacker roll-off")) for _ in range(2)]
        state.attacker = 0 if roll[0] > roll[1] else 1
        players[state.attacker].attacker = True

        missions.assign_primaries(state, self.data)
        missions.init_secondaries(state, self.data, self.rng)

        for i, army in enumerate(armies):
            self._build_army(state, i, army)

        state.phase = "deployment"
        state.battle_round = 0
        state.active_player = 1 - state.attacker      # defender deploys first
        state.emit(
            "battle_start",
            attacker=state.attacker,
            dispositions=[p.disposition for p in players],
            primaries=[p.primary_mission for p in players],
        )
        return state

    def _build_army(self, state: GameState, owner: int, army: Army) -> None:
        for idx, entry in enumerate(army.units):
            ds = self.data.datasheets.get(entry.datasheet_id)
            if ds is None:
                state.emit("army_warning", player=owner, missing=entry.datasheet_id)
                continue
            # Roster keys are only unique within an army, so the battlefield id
            # is always namespaced by side.
            uid = f"p{owner}:{entry.key or idx}"
            unit = new_unit_from_datasheet(uid, owner, ds, entry.models)
            unit.warlord = entry.warlord
            unit.enhancement_id = entry.enhancement_id
            unit.innate_abilities = self.data.innate_abilities_for(ds)
            unit.in_reserves = False
            state.units[uid] = unit
        # Detachment rules, army rules and enhancements are effect records that
        # register themselves at battle start — no kernel branch per faction.
        for rid in self.data.always_on_records(army):
            state.active_effects.append(
                self.data.make_active(rid, owner, expiry="until_end_of_battle")
            )
        for entry in army.units:
            if entry.enhancement_id:
                uid = entry.key or ""
                bearer = state.units.get(uid)
                if bearer is None:
                    for u in state.units.values():
                        if u.owner == owner and u.datasheet_id == entry.datasheet_id:
                            bearer = u
                            break
                if bearer is not None:
                    state.active_effects.append(
                        self.data.make_active(
                            entry.enhancement_id, owner,
                            bearer_uid=bearer.uid, expiry="until_end_of_battle",
                        )
                    )

    # ------------------------------------------------------------------
    # Legal actions
    # ------------------------------------------------------------------
    def legal_actions(self, state: GameState, player: Optional[int] = None) -> List[Action]:
        from .legal import enumerate_actions

        return enumerate_actions(self, state, player if player is not None else state.active_player)

    def to_act(self, state: GameState) -> int:
        return state.active_player

    # ------------------------------------------------------------------
    # Apply
    # ------------------------------------------------------------------
    def apply(self, state: GameState, action: Action) -> ApplyResult:
        handler = getattr(self, f"_do_{action.kind}", None)
        if handler is None:
            return ApplyResult(False, f"unknown action {action.kind}")
        before = len(state.events)
        result = handler(state, action)
        if result.ok and self.log is not None:
            self.log.record_action(state, action, state.events[before:])
        return result

    # -- deployment ----------------------------------------------------
    def _do_deploy_unit(self, state, action) -> ApplyResult:
        unit = state.unit(action.params["unit"])
        if unit is None or unit.deployed:
            return ApplyResult(False, "unit unavailable")
        if unit.owner != state.active_player:
            return ApplyResult(False, "not this player's deployment slot")
        pos = tuple(action.params["pos"])
        ok, reason = self._place_unit(state, unit, pos)
        if not ok:
            return ApplyResult(False, reason)
        unit.deployed = True
        state.emit("deploy", unit=unit.uid, pos=[round(p, 2) for p in pos])
        self._advance_deployment(state)
        return ApplyResult(True)

    def _do_place_in_reserves(self, state, action) -> ApplyResult:
        unit = state.unit(action.params["unit"])
        if unit is None or unit.deployed:
            return ApplyResult(False, "unit unavailable")
        if unit.owner != state.active_player:
            return ApplyResult(False, "not this player's deployment slot")
        cap = state.battle_size // 2
        used = sum(
            self.data.points_of(state, u) for u in state.units.values()
            if u.owner == unit.owner and u.in_reserves
        )
        if used + self.data.points_of(state, unit) > cap:
            return ApplyResult(False, "Strategic Reserves may not exceed half the army's points")
        unit.in_reserves = True
        unit.deployed = True
        unit.reserves_kind = "deep_strike" if unit.has_ability("DEEP STRIKE") else "strategic"
        state.emit("reserves", unit=unit.uid)
        self._advance_deployment(state)
        return ApplyResult(True)

    def _place_unit(self, state, unit, pos: Tuple[float, float]) -> Tuple[bool, str]:
        from ..geometry import point_in_polygon

        zone_key = "attacker" if unit.owner == state.attacker else "defender"
        zones = state.layout.deployment_zones.get(zone_key, [])
        positions = _formation(pos, len(unit.models), unit.models[0].base.avg_radius if unit.models else 0.5)
        for m, p in zip(unit.models, positions):
            m.pos = p
        measure.bump_epoch()
        if zones and not unit.has_ability("INFILTRATORS"):
            for m in unit.alive_models:
                if not any(point_in_polygon(m.pos, poly) for poly in zones):
                    return False, "must be set up wholly within your deployment zone"
        others = [u for u in state.units.values()
                  if u is not unit and u.deployed and not u.in_reserves and not u.destroyed]
        if measure.any_base_overlap(unit, others) or measure.internal_overlap(unit):
            return False, "bases would overlap"
        if not measure.coherency_ok(unit):
            return False, "unit would not be in coherency"
        return True, ""

    def _advance_deployment(self, state) -> None:
        """Alternate deployment; when both sides are done, roll for first turn."""
        opponent = 1 - state.active_player
        if any(not u.deployed for u in state.units.values() if u.owner == opponent):
            state.active_player = opponent
        elif any(not u.deployed for u in state.units.values() if u.owner == state.active_player):
            pass
        else:
            self._start_battle(state)

    def _start_battle(self, state) -> None:
        roll = [sum(self.rng.two_d6(note="first turn")) for _ in range(2)]
        while roll[0] == roll[1]:
            roll = [sum(self.rng.two_d6(note="first turn")) for _ in range(2)]
        state.first_player = 0 if roll[0] > roll[1] else 1
        state.active_player = state.first_player
        state.battle_round = 1
        state.turn_index = 1
        state.phase = "command"
        state.emit("battle_round", round=1, first=state.first_player)
        self._begin_command(state)

    # -- phase flow ----------------------------------------------------
    def _do_end_phase(self, state, action) -> ApplyResult:
        self.advance_phase(state)
        return ApplyResult(True)

    def advance_phase(self, state) -> None:
        # 14.02.01: objective control is determined before other end-of-phase rules
        objectives.refresh_control(state)
        self.interp.expire(state, "end_of_phase")

        idx = PHASES.index(state.phase) if state.phase in PHASES else -1
        if idx < len(PHASES) - 1 and idx >= 0:
            state.phase = PHASES[idx + 1]
            state.emit("phase", phase=state.phase)
            if state.phase == "fight":
                self._stamp_fight_eligibility(state)
            return

        # end of turn
        missions.score_end_of_turn(state, self.data)
        self.interp.expire(state, "end_of_turn")
        self._end_turn_cleanup(state)

        if state.active_player == state.first_player:
            state.active_player = 1 - state.first_player
        else:
            if state.battle_round >= BATTLE_ROUNDS:
                self._finish(state)
                return
            state.battle_round += 1
            state.active_player = state.first_player
            state.emit("battle_round", round=state.battle_round)
        state.turn_index += 1
        state.phase = "command"
        self._begin_command(state)

    def _begin_command(self, state) -> None:
        state.emit("phase", phase="command")
        player = state.players[state.active_player]
        # Both players gain 1 CP each Command phase (08).
        for p in state.players:
            p.cp += 1
        self._battle_shock_tests(state)
        objectives.refresh_control(state)
        missions.score_command_phase(state, self.data)

    def _battle_shock_tests(self, state) -> None:
        for unit in state.units_of(state.active_player):
            needs = unit.below_half_strength() or unit.battle_shocked
            if not needs:
                unit.battle_shocked = False
                continue
            ld = unit_leadership(state, unit)
            mods = self.interp.unit_mods(state, unit)
            roll = sum(self.rng.two_d6(note=f"battle-shock {unit.name}"))
            passed = roll + mods.battle_shock_mod >= ld
            unit.battle_shocked = not passed
            state.emit(
                "battle_shock", unit=unit.uid, roll=roll, ld=ld, passed=passed
            )

    def _end_turn_cleanup(self, state) -> None:
        for unit in state.units.values():
            unit.moved = False
            unit.move_mode = ""
            unit.advanced_roll = 0
            unit.charged = False
            unit.charge_attempted = False
            unit.fought = False
            unit.shot = False
            unit.disembarked = False
            unit.set_up_this_turn = False
            unit.flags.pop("fights_first", None)
            unit.flags.pop("eligible_to_fight", None)
        state.clear_prefix("phase:")
        state.clear_prefix("turn:")

    def _stamp_fight_eligibility(self, state) -> None:
        for unit in state.units.values():
            if unit.destroyed or unit.in_reserves or unit.embarked_in:
                continue
            if measure.unit_engaged(state, unit):
                unit.flags["eligible_to_fight"] = True
            if unit.charged:
                unit.flags["fights_first"] = True

    def _finish(self, state) -> None:
        missions.score_end_of_battle(state, self.data)
        state.finished = True
        state.phase = "done"
        state.emit(
            "battle_end",
            vp=[p.vp for p in state.players],
            primary=[p.vp_primary for p in state.players],
            secondary=[p.vp_secondary for p in state.players],
        )

    # -- command -------------------------------------------------------
    def _do_issue_order(self, state, action) -> ApplyResult:
        from . import orders

        return orders.issue(self, state, action)

    # -- movement ------------------------------------------------------
    def _do_move_unit(self, state, action) -> ApplyResult:
        unit = state.unit(action.params["unit"])
        if unit is None or unit.owner != state.active_player:
            return ApplyResult(False, "not your unit")
        if state.phase != "movement":
            return ApplyResult(False, "not the Movement phase")
        mode = action.params.get("mode", "normal")
        if mode == "stationary":
            unit.moved = True
            unit.move_mode = "stationary"
            return ApplyResult(True)
        dest = tuple(action.params["dest"])
        ok, reason = movement.try_move(state, self.interp, unit, dest, mode, self.rng)
        return ApplyResult(ok, reason)

    def _do_arrive_from_reserves(self, state, action) -> ApplyResult:
        unit = state.unit(action.params["unit"])
        if unit is None or not unit.in_reserves or unit.owner != state.active_player:
            return ApplyResult(False, "unit not in reserves")
        if state.phase != "movement":
            return ApplyResult(False, "reserves arrive in your Movement phase")
        pos = tuple(action.params["pos"])
        deep = unit.reserves_kind == "deep_strike"
        ok, reason = movement.ingress_legal(state, unit, pos, deep)
        if not ok:
            return ApplyResult(False, reason)
        positions = _formation(pos, len(unit.models), unit.models[0].base.avg_radius)
        for m, p in zip(unit.models, positions):
            m.pos = p
        measure.bump_epoch()
        unit.in_reserves = False
        unit.set_up_this_turn = True
        unit.moved = True
        state.emit("arrive", unit=unit.uid, pos=[round(p, 2) for p in pos])
        return ApplyResult(True)

    # -- shooting ------------------------------------------------------
    def _do_shoot_unit(self, state, action) -> ApplyResult:
        from .shooting import resolve_unit_shooting

        unit = state.unit(action.params["unit"])
        target = state.unit(action.params["target"])
        if unit is None or target is None:
            return ApplyResult(False, "missing unit")
        if unit.owner != state.active_player or state.phase != "shooting":
            return ApplyResult(False, "not your Shooting phase")
        if unit.shot:
            return ApplyResult(False, "unit has already shot")
        ok, reason = can_shoot(self, state, unit, target)
        if not ok:
            return ApplyResult(False, reason)
        resolve_unit_shooting(self, state, unit, target)
        unit.shot = True
        return ApplyResult(True)

    # -- charge --------------------------------------------------------
    def _do_charge(self, state, action) -> ApplyResult:
        unit = state.unit(action.params["unit"])
        if unit is None or unit.owner != state.active_player or state.phase != "charge":
            return ApplyResult(False, "not your Charge phase")
        if unit.moved and unit.move_mode in ("advance", "fall_back"):
            return ApplyResult(False, "unit Advanced or Fell Back")
        if measure.unit_engaged(state, unit):
            return ApplyResult(False, "unit is already within Engagement Range")
        targets = [state.unit(t) for t in action.params["targets"]]
        targets = [t for t in targets if t is not None and not t.destroyed]
        if not targets:
            return ApplyResult(False, "no targets")
        for t in targets:
            if measure.unit_gap(unit, t) > 12.0:
                return ApplyResult(False, 'charge targets must be within 12"')
        rolled = movement.charge_roll(state, self.interp, unit, self.rng)
        needed = max(movement.charge_needed(unit, t) for t in targets)
        if rolled < needed:
            unit.charge_attempted = True
            state.emit("charge_failed", unit=unit.uid, rolled=rolled, needed=round(needed, 1))
            return ApplyResult(True, "charge failed")
        ok, reason = movement.try_charge(state, self.interp, unit, targets, float(rolled), self.rng)
        if ok:
            unit.flags["fights_first"] = True
        return ApplyResult(True, "" if ok else reason)

    # -- fight ---------------------------------------------------------
    def _do_fight(self, state, action) -> ApplyResult:
        from .fighting import resolve_unit_fight

        unit = state.unit(action.params["unit"])
        target = state.unit(action.params["target"])
        if unit is None or target is None:
            return ApplyResult(False, "missing unit")
        if state.phase != "fight":
            return ApplyResult(False, "not the Fight phase")
        if unit.fought:
            return ApplyResult(False, "unit has already fought")
        if not measure.units_engaged(unit, target):
            return ApplyResult(False, "target is not within Engagement Range")
        nxt = next_to_fight(state, unit.owner)
        if nxt is not None and nxt.uid != unit.uid:
            return ApplyResult(False, "another unit must be selected to fight first")
        resolve_unit_fight(self, state, unit, target)
        unit.fought = True
        return ApplyResult(True)

    # -- stratagems / actions ------------------------------------------
    def _do_use_stratagem(self, state, action) -> ApplyResult:
        from . import stratagems

        return stratagems.use(self, state, action)

    def _do_start_action(self, state, action) -> ApplyResult:
        from . import unit_actions

        return unit_actions.start(self, state, action)

    def _do_pass(self, state, action) -> ApplyResult:
        return ApplyResult(True)


# ----------------------------------------------------------------------
def can_shoot(engine, state, unit, target) -> Tuple[bool, str]:
    """Shooting eligibility + target validity (10, 06, 13). Memoised per epoch:
    the enumeration and the agent's scoring both ask the same question."""
    cache = measure.vis_cache()
    key = ("shoot", unit.uid, target.uid, unit.move_mode, unit.shot)
    hit = cache.get(key)
    if hit is not None:
        return hit
    value = _can_shoot_uncached(engine, state, unit, target)
    cache[key] = value
    return value


def _can_shoot_uncached(engine, state, unit, target) -> Tuple[bool, str]:
    if unit.battle_shocked and False:
        return False, "battle-shocked"
    if unit.move_mode == "fall_back":
        return False, "unit Fell Back"
    if unit.move_mode == "advance" and not unit.has_ability("ASSAULT"):
        # only [ASSAULT] weapons may fire; handled per weapon in shooting.py
        pass
    if target.destroyed or target.in_reserves or target.embarked_in:
        return False, "target unavailable"
    if target.owner == unit.owner:
        return False, "cannot target your own unit"
    engaged_with_target = measure.units_engaged(unit, target)
    if measure.unit_engaged(state, unit) and not engaged_with_target:
        monster_vehicle = unit.has_keyword("MONSTER") or unit.has_keyword("VEHICLE")
        if not monster_vehicle:
            return False, "unit is engaged; it may only shoot the unit it is engaged with"
    if not engaged_with_target:
        if visibility.hidden_blocks_targeting(state, unit, target):
            return False, "target is Hidden beyond its detection range"
        if not visibility.unit_visible(state, unit, target):
            return False, "no line of sight"
    return True, ""


def next_to_fight(state, player: int) -> Optional[UnitState]:
    """The unit this player must activate next.

    Fights First units go before the rest (12.x). Activation alternates between
    players at the table; this engine gives the whole Fight phase to the active
    player and enforces the priority *within* each army — recorded as a
    simplification in STATUS.md.
    """
    for unit in fight_order(state):
        if unit.owner == player:
            return unit
    return None


def fight_order(state) -> List[UnitState]:
    """Fights First combats first, then alternating from the non-active player."""
    eligible = [
        u for u in state.units.values()
        if not u.destroyed and not u.fought and not u.in_reserves and not u.embarked_in
        and (measure.unit_engaged(state, u) or u.flags.get("eligible_to_fight"))
        and u.alive_models
    ]
    ff = [u for u in eligible if u.flags.get("fights_first") or u.has_ability("FIGHTS FIRST")]
    rest = [u for u in eligible if u not in ff]
    if ff:
        active_first = [u for u in ff if u.owner == state.active_player]
        other = [u for u in ff if u.owner != state.active_player]
        return active_first + other + rest
    return rest


def _formation(anchor: Tuple[float, float], count: int, radius: float) -> List[Tuple[float, float]]:
    """A simple coherent block used for placement; positions are continuous."""
    spacing = max(0.1, radius * 2.05)
    per_row = max(1, int(round(count ** 0.5)))
    out = []
    for i in range(count):
        row, col = divmod(i, per_row)
        out.append((anchor[0] + col * spacing, anchor[1] + row * spacing))
    return out
