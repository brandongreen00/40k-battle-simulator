#!/usr/bin/env python3
"""Self-play RL harness (§8 Stage C).

**Stated plainly, as the brief requires: reinforcement learning to strength is
a multi-day compute job and is out of overnight scope by design. What this file
delivers is that `python3 train.py` starts learning — a state/action encoding, a
policy-value interface, a replay buffer and a training loop that runs — not that
it has learned anything.**

The default policy head is a linear model over the heuristic's own features, so
the loop trains something real without a deep-learning dependency. Swapping in a
torch network means implementing ``PolicyValue`` and nothing else.
"""

from __future__ import annotations

import argparse
import json
import os
import random
from dataclasses import dataclass, field
from typing import Any, Dict, List, Sequence, Tuple

from sim2.agents.heuristic import HeuristicAgent, Weights
from sim2.harness.run import play_game
from sim2.loader import load
from sim2.rng import Rng

FEATURES = list(Weights().to_json().keys())


@dataclass
class Transition:
    weights: Dict[str, float]
    reward: float


@dataclass
class ReplayBuffer:
    capacity: int = 4096
    items: List[Transition] = field(default_factory=list)

    def add(self, t: Transition) -> None:
        self.items.append(t)
        if len(self.items) > self.capacity:
            self.items.pop(0)

    def sample(self, n: int, rng: Rng) -> List[Transition]:
        if not self.items:
            return []
        return [rng.choice(self.items) for _ in range(min(n, len(self.items)))]


class PolicyValue:
    """The seam a neural policy plugs into. The default is a linear baseline."""

    def __init__(self, weights: Dict[str, float]):
        self.weights = dict(weights)

    def act_weights(self) -> Dict[str, float]:
        return dict(self.weights)

    def update(self, batch: Sequence[Transition], lr: float = 0.08) -> float:
        if not batch:
            return 0.0
        best = max(batch, key=lambda t: t.reward)
        loss = 0.0
        for key in FEATURES:
            target = best.weights.get(key, self.weights.get(key, 0.0))
            delta = target - self.weights.get(key, 0.0)
            self.weights[key] = self.weights.get(key, 0.0) + lr * delta * (
                1.0 if best.reward > 0 else -0.25
            )
            loss += abs(delta)
        return loss / len(FEATURES)


def perturb(weights: Dict[str, float], rng: Rng, scale: float = 0.25) -> Dict[str, float]:
    out = {}
    for k, v in weights.items():
        jitter = (rng.random() * 2 - 1) * scale * max(0.5, abs(v))
        out[k] = round(v + jitter, 4)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--iterations", type=int, default=3)
    ap.add_argument("--games", type=int, default=2)
    ap.add_argument("--battle-size", type=int, default=500)
    ap.add_argument("--a", default="Alien Hunters Strike")
    ap.add_argument("--b", default="Siege Regiment Vanguard")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="results/training.json")
    args = ap.parse_args()

    data = load()
    rng = Rng(args.seed)
    army_a, army_b = data.armies[args.a], data.armies[args.b]
    model = PolicyValue(Weights().to_json())
    buffer = ReplayBuffer()
    history: List[Dict[str, Any]] = []

    for it in range(args.iterations):
        challenger = perturb(model.act_weights(), rng)
        reward = 0.0
        for g in range(args.games):
            seed = args.seed * 100 + it * 10 + g
            res, _ = play_game(
                data, army_a, army_b, seed, "heuristic", "heuristic",
                args.battle_size, weights=[challenger, model.act_weights()],
            )
            reward += (res.vp[0] - res.vp[1]) / max(1, args.games)
        buffer.add(Transition(challenger, reward))
        loss = model.update(buffer.sample(8, rng))
        history.append({"iteration": it, "reward": round(reward, 2),
                        "loss": round(loss, 4), "weights": model.act_weights()})
        print(json.dumps(history[-1]))

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"kind": "training", "history": history,
                   "final_weights": model.act_weights()}, fh, indent=1)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
