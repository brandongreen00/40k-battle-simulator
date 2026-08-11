"""Missions, Force Dispositions and scoring (§5).

Each player's primary mission is read off the disposition matrix: a player
finds the **opponent's** disposition symbol on their own Force Disposition
card, so the matrix is asymmetric and the two players usually score different
primaries in the same game.

Scoring blocks are data (``MissionCard.scoring``); this module implements the
generic evaluators those blocks name. A card whose exact text is not in the
snapshot scores through its recorded fallback and is listed in ``data2/gaps.json``
— never silently zero, never invented.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import objectives, unit_actions

PRIMARY_CAP = 45
SECONDARY_CAP = 45
BATTLE_READY_VP = 10
PER_ROUND_CAP = 15


# --------------------------------------------------------------------------
def assign_primaries(state, data) -> None:
    for i, player in enumerate(state.players):
        opponent = state.players[1 - i].disposition
        mission = data.primary_for(player.disposition, opponent)
        player.primary_mission = mission or ""
        if not mission:
            state.emit("gap", what="primary_mission",
                       detail=f"{player.disposition} vs {opponent}")


def init_secondaries(state, data, rng) -> None:
    for player in state.players:
        deck = [c.id for c in data.secondaries()]
        if player.secondary_mode == "fixed":
            fixed = [c.id for c in data.secondaries() if c.fixed_capable]
            player.secondary_hand = fixed[:2]
            player.secondary_deck = []
        else:
            player.secondary_deck = rng.spawn(f"secondaries{player.index}").shuffled(deck)
            player.secondary_hand = []


def draw_secondaries(state, data, player_index: int, count: int = 2) -> None:
    player = state.players[player_index]
    if player.secondary_mode == "fixed":
        return
    for _ in range(count):
        if not player.secondary_deck:
            player.secondary_deck = list(player.secondary_discard)
            player.secondary_discard = []
        if player.secondary_deck:
            player.secondary_hand.append(player.secondary_deck.pop(0))


# --------------------------------------------------------------------------
# scoring hooks
# --------------------------------------------------------------------------
def score_command_phase(state, data) -> None:
    player = state.players[state.active_player]
    draw_secondaries(state, data, state.active_player)
    _score_primary(state, data, when="command_phase")


def score_end_of_turn(state, data) -> None:
    unit_actions.resolve_completions(state)
    objectives.refresh_control(state)
    _score_primary(state, data, when="end_of_turn")
    _score_secondaries(state, data)
    state.players[state.active_player].scored_this_round = 0


def score_end_of_battle(state, data) -> None:
    for i in range(2):
        state.active_player = i
        _score_primary(state, data, when="end_of_battle")
    _award_battle_ready(state)


def _award_battle_ready(state) -> None:
    for player in state.players:
        # Battle Ready is a list-construction award (configurable, §5.1).
        player.vp_battle_ready = BATTLE_READY_VP


def _score_primary(state, data, when: str) -> None:
    idx = state.active_player
    player = state.players[idx]
    card = data.mission_card(player.primary_mission)
    if card is None:
        return
    blocks = [b for b in card.scoring if b.get("when", "end_of_turn") == when]
    if not blocks and when == "end_of_turn":
        blocks = [dict(data.default_primary_block())]
    gained = 0
    for block in blocks:
        if state.battle_round < int(block.get("from_round", 1)):
            continue
        gained += _evaluate_block(state, idx, block)
    if gained <= 0:
        return
    cap_left = max(0, PER_ROUND_CAP - player.scored_this_round)
    gained = min(gained, cap_left)
    gained = min(gained, PRIMARY_CAP - player.vp_primary)
    if gained <= 0:
        return
    player.vp_primary += gained
    player.scored_this_round += gained
    state.emit("vp", player=idx, vp_kind="primary", card=card.id, vp=gained)


def _evaluate_block(state, player_index: int, block: Dict[str, Any]) -> int:
    rule = block.get("rule", "control_objectives")
    per = int(block.get("per", 5))
    cap = int(block.get("max", PER_ROUND_CAP))
    fn = EVALUATORS.get(rule)
    if fn is None:
        return 0
    return min(cap, fn(state, player_index, block) * per)


# -- generic evaluators -----------------------------------------------------
def _ev_control_objectives(state, idx: int, block) -> int:
    kinds = block.get("kinds")
    held = objectives.controlled_by(state, idx)
    if not kinds:
        return len(held)
    ids = {o.id for o in state.layout.objectives if o.kind in kinds}
    return len([h for h in held if h in ids])


def _ev_control_at_least(state, idx: int, block) -> int:
    """A threshold clause pays once: "you control two or more objectives"."""
    need = int(block.get("count", 1))
    return 1 if len(objectives.controlled_by(state, idx)) >= need else 0


def _ev_control_more(state, idx: int, block) -> int:
    mine = len(objectives.controlled_by(state, idx))
    theirs = len(objectives.controlled_by(state, 1 - idx))
    return 1 if mine > theirs else 0


def _ev_control_enemy_home(state, idx: int, block) -> int:
    held = set(objectives.controlled_by(state, idx))
    return len([
        o for o in state.layout.objectives
        if o.kind == "home" and o.owner is not None and o.owner != idx and o.id in held
    ])


def _ev_units_in_enemy_half(state, idx: int, block) -> int:
    from . import measure

    n = 0
    mid = state.layout.height / 2.0
    enemy_top = state.attacker != idx
    for unit in state.units_of(idx):
        cx, cy = measure.unit_centroid(unit)
        if (cy > mid) == enemy_top:
            n += 1
    return min(n, int(block.get("count_max", 3)))


def _ev_enemy_units_destroyed(state, idx: int, block) -> int:
    return len([k for k in state.kills if k["owner"] != idx])


def _ev_enemy_units_destroyed_this_turn(state, idx: int, block) -> int:
    return len([
        k for k in state.kills
        if k["owner"] != idx and k["round"] == state.battle_round
    ])


def _ev_actions_completed(state, idx: int, block) -> int:
    return state.count(f"battle:actions:{idx}")


EVALUATORS = {
    "control_objectives": _ev_control_objectives,
    "control_at_least": _ev_control_at_least,
    "control_more_objectives": _ev_control_more,
    "control_enemy_home": _ev_control_enemy_home,
    "units_in_enemy_half": _ev_units_in_enemy_half,
    "enemy_units_destroyed": _ev_enemy_units_destroyed,
    "enemy_units_destroyed_this_turn": _ev_enemy_units_destroyed_this_turn,
    "actions_completed": _ev_actions_completed,
}


# -- secondaries ------------------------------------------------------------
def _score_secondaries(state, data) -> None:
    idx = state.active_player
    player = state.players[idx]
    keep: List[str] = []
    for cid in player.secondary_hand:
        card = data.mission_card(cid)
        if card is None:
            continue
        gained = 0
        for block in card.scoring:
            gained += _evaluate_block(state, idx, block)
        if gained > 0:
            gained = min(gained, SECONDARY_CAP - player.vp_secondary)
            if gained > 0:
                player.vp_secondary += gained
                state.emit("vp", player=idx, vp_kind="secondary", card=cid, vp=gained)
            player.secondary_discard.append(cid)
        else:
            keep.append(cid)
    player.secondary_hand = keep
