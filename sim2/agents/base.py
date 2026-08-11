"""Agent interface.

An agent receives the legal-action enumeration and returns one of those
actions. It never constructs an action of its own and never mutates state —
that is what makes "zero illegal actions" a meaningful metric (§8).
"""

from __future__ import annotations

from typing import List, Optional

from ..kernel.actions import Action


class Player:
    name = "player"

    def choose(self, engine, state, player: int, actions: List[Action]) -> Action:
        raise NotImplementedError

    def observe(self, engine, state, action: Action, result) -> None:
        """Optional hook for learning agents."""


class RandomAgent(Player):
    """Uniform choice over legal actions — the baseline and the fuzzer."""

    name = "random"

    def __init__(self, rng):
        self.rng = rng

    def choose(self, engine, state, player: int, actions: List[Action]) -> Action:
        # Bias away from ending the phase immediately so games actually happen;
        # still uniform over the substantive options.
        substantive = [a for a in actions if a.kind != "end_phase"]
        if substantive and self.rng.randint(1, 100) <= 85:
            return self.rng.choice(substantive)
        return self.rng.choice(actions)
