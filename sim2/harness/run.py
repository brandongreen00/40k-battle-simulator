"""Running battles: one game, batches, and the artifact contract (§11).

Every executor (CLI, GitHub Actions, a local GPU box) emits the same versioned
JSON, so the Pages app never needs to know where a run happened.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..agents.base import Player, RandomAgent
from ..agents.heuristic import HeuristicAgent
from ..kernel.engine import Engine
from ..kernel.state import GameState
from ..log import BattleLog, layout_snapshot
from ..loader import DataIndex, load
from ..rng import Rng

RESULT_SCHEMA_VERSION = "2.0.0"
MAX_ACTIONS = 6000


@dataclass
class GameResult:
    seed: int
    vp: List[int]
    winner: Optional[int]
    rounds: int
    actions: int
    rejected: int
    layout: str
    armies: List[str]
    dispositions: List[str]
    primaries: List[str]
    duration_s: float
    log_path: str = ""

    def to_json(self) -> Dict[str, Any]:
        return {
            "seed": self.seed, "vp": self.vp, "winner": self.winner, "rounds": self.rounds,
            "actions": self.actions, "rejected": self.rejected, "layout": self.layout,
            "armies": self.armies, "dispositions": self.dispositions,
            "primaries": self.primaries, "duration_s": round(self.duration_s, 3),
            "log": self.log_path,
        }


def make_agent(kind: str, rng: Rng, weights: Optional[Dict[str, float]] = None) -> Player:
    if kind == "random":
        return RandomAgent(rng)
    if kind == "heuristic":
        from ..agents.heuristic import Weights

        return HeuristicAgent(rng, Weights.from_json(weights or {}))
    if kind == "search":
        from ..agents.search import SearchAgent

        return SearchAgent(rng)
    raise ValueError(f"unknown agent {kind!r}")


def pick_layout(data: DataIndex, army_a, army_b, seed: int, letter: str = ""):
    disp_a = data.disposition_for(army_a)
    disp_b = data.disposition_for(army_b)
    options = data.layouts_for(disp_a, disp_b)
    if not options:
        options = sorted(data.layouts.values(), key=lambda l: l.id)
    if letter:
        chosen = [l for l in options if l.letter == letter] or options
    else:
        chosen = options
    return chosen[seed % len(chosen)]


def play_game(
    data: DataIndex,
    army_a,
    army_b,
    seed: int,
    agent_a: str = "heuristic",
    agent_b: str = "heuristic",
    battle_size: int = 1000,
    layout=None,
    write_log: str = "",
    weights: Optional[List[Dict[str, float]]] = None,
) -> Tuple[GameResult, BattleLog]:
    started = time.time()
    rng = Rng(seed)
    layout = layout or pick_layout(data, army_a, army_b, seed)
    log = BattleLog(seed=seed)
    engine = Engine(data, rng, log)
    state = engine.new_battle([army_a, army_b], layout, battle_size)

    weights = weights or [{}, {}]
    agents = [
        make_agent(agent_a, rng.spawn("agent0"), weights[0]),
        make_agent(agent_b, rng.spawn("agent1"), weights[1]),
    ]
    log.meta = {
        "layout": layout_snapshot(layout),
        "armies": [army_a.name, army_b.name],
        "factions": [army_a.faction, army_b.faction],
        "dispositions": [p.disposition for p in state.players],
        "primaries": [p.primary_mission for p in state.players],
        "battle_size": battle_size,
        "agents": [agent_a, agent_b],
        "data_version": data.meta.get("retrieved", ""),
    }

    actions = 0
    rejected = 0
    while not state.finished and actions < MAX_ACTIONS:
        player = engine.to_act(state)
        legal = engine.legal_actions(state, player)
        if not legal:
            engine.advance_phase(state)
            continue
        choice = agents[player].choose(engine, state, player, legal)
        result = engine.apply(state, choice)
        actions += 1
        if not result.ok:
            rejected += 1
            # An agent may only pick from the enumeration, so a rejection is an
            # engine bug: fail loudly rather than silently continuing.
            state.emit("rejected", action=choice.kind, reason=result.reason)
            engine.apply(state, legal[-1])   # end_phase is always last
    log.finish(state)

    path = ""
    if write_log:
        path = log.write(write_log)

    res = GameResult(
        seed=seed,
        vp=[p.vp for p in state.players],
        winner=log.result.get("winner"),
        rounds=state.battle_round,
        actions=actions,
        rejected=rejected,
        layout=layout.id,
        armies=[army_a.name, army_b.name],
        dispositions=[p.disposition for p in state.players],
        primaries=[p.primary_mission for p in state.players],
        duration_s=time.time() - started,
        log_path=path,
    )
    return res, log


def run_batch(
    data: DataIndex,
    army_a,
    army_b,
    games: int,
    seed: int = 1,
    agent_a: str = "heuristic",
    agent_b: str = "heuristic",
    battle_size: int = 1000,
    out_dir: str = "results",
    keep_logs: int = 3,
) -> Dict[str, Any]:
    os.makedirs(out_dir, exist_ok=True)
    results: List[GameResult] = []
    logs_written = 0
    for i in range(games):
        game_seed = seed + i
        log_path = ""
        if logs_written < keep_logs:
            log_path = os.path.join(out_dir, "logs", f"battle_{game_seed}.json")
            logs_written += 1
        res, _ = play_game(
            data, army_a, army_b, game_seed, agent_a, agent_b, battle_size,
            write_log=log_path,
        )
        results.append(res)

    wins = [sum(1 for r in results if r.winner == i) for i in (0, 1)]
    draws = sum(1 for r in results if r.winner is None)
    summary = {
        "result_schema_version": RESULT_SCHEMA_VERSION,
        "kind": "batch",
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "config": {
            "armies": [army_a.name, army_b.name],
            "agents": [agent_a, agent_b],
            "battle_size": battle_size,
            "games": games,
            "seed": seed,
        },
        "totals": {
            "wins": wins,
            "draws": draws,
            "win_rate": [round(w / max(1, games), 4) for w in wins],
            "avg_vp": [
                round(sum(r.vp[i] for r in results) / max(1, games), 2) for i in (0, 1)
            ],
            "avg_rounds": round(sum(r.rounds for r in results) / max(1, games), 2),
            "rejected_actions": sum(r.rejected for r in results),
            "avg_duration_s": round(sum(r.duration_s for r in results) / max(1, games), 3),
        },
        "games": [r.to_json() for r in results],
    }
    with open(os.path.join(out_dir, "batch.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=1)
    return summary
