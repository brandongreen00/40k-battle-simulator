"""Search agent: MCTS over the heuristic policy (§8 Stage C scaffold).

This is deliberately a *scaffold that runs*, not a tuned player. It performs
rollouts from cloned states using the heuristic as the rollout policy and picks
the action with the best average VP differential. Cheap state cloning is why
:meth:`GameState.snapshot` exists (§3.8).

Running it at competitive strength needs far more rollouts than an overnight
run affords; the deliverable here is that the interface and the search loop are
real and exercised by a test.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ..kernel.actions import Action
from ..rng import Rng
from .base import Player
from .heuristic import HeuristicAgent, Weights


@dataclass
class Node:
    visits: int = 0
    total: float = 0.0

    @property
    def mean(self) -> float:
        return self.total / self.visits if self.visits else 0.0


class SearchAgent(Player):
    name = "search"

    def __init__(self, rng: Rng, rollouts: int = 8, depth: int = 12,
                 weights: Optional[Weights] = None):
        self.rng = rng
        self.rollouts = rollouts
        self.depth = depth
        self.policy = HeuristicAgent(rng.spawn("rollout"), weights)

    def choose(self, engine, state, player: int, actions: List[Action]) -> Action:
        if len(actions) == 1:
            return actions[0]
        # Only the top-scoring handful are worth simulating; the heuristic's
        # ordering is the prior.
        ranked = sorted(
            actions, key=lambda a: -self.policy.score(engine, state, player, a)
        )[: min(6, len(actions))]
        stats: Dict[str, Node] = {a.key(): Node() for a in ranked}
        for i in range(self.rollouts):
            action = ranked[i % len(ranked)]
            value = self._rollout(engine, state, player, action)
            node = stats[action.key()]
            node.visits += 1
            node.total += value
        best = max(ranked, key=lambda a: stats[a.key()].mean)
        return best

    def _rollout(self, engine, state, player: int, action: Action) -> float:
        sim = state.snapshot()
        sim.data = state.data
        saved_log, engine.log = engine.log, None
        try:
            result = engine.apply(sim, action)
            if not result.ok:
                return -1e6
            for _ in range(self.depth):
                if sim.finished:
                    break
                acting = engine.to_act(sim)
                legal = engine.legal_actions(sim, acting)
                if not legal:
                    engine.advance_phase(sim)
                    continue
                engine.apply(sim, self.policy.choose(engine, sim, acting, legal))
        finally:
            engine.log = saved_log
        return float(sim.players[player].vp - sim.players[1 - player].vp)


def ucb(node: Node, parent_visits: int, c: float = 1.4) -> float:
    if node.visits == 0:
        return float("inf")
    return node.mean + c * math.sqrt(math.log(max(1, parent_visits)) / node.visits)
