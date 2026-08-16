"""Dice expressions ("2", "D6", "2D6", "D3+1", "D6+3")."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Tuple

EXPR_RE = re.compile(r"^\s*(?:(\d*)[dD](\d+))?\s*([+-]\s*\d+)?\s*$")


@dataclass(frozen=True)
class DiceExpr:
    count: int = 0
    faces: int = 0
    flat: int = 0

    @property
    def is_random(self) -> bool:
        return self.count > 0 and self.faces > 0

    def average(self) -> float:
        if not self.is_random:
            return float(self.flat)
        return self.count * (self.faces + 1) / 2.0 + self.flat

    def maximum(self) -> int:
        return self.count * self.faces + self.flat

    def roll(self, rng, note: str = "") -> Tuple[int, List[int]]:
        if not self.is_random:
            return self.flat, []
        rolls = rng.roll(self.count, self.faces, kind=f"{self.count}d{self.faces}", note=note)
        return sum(rolls) + self.flat, rolls


def parse(expr: str) -> DiceExpr:
    s = str(expr).strip().replace(" ", "")
    if not s:
        return DiceExpr(flat=0)
    if s.isdigit():
        return DiceExpr(flat=int(s))
    m = EXPR_RE.match(s)
    if not m:
        # e.g. "D6+D3" or unparseable text — fall back to a flat 1 and let the
        # ingester log a GAP rather than silently inventing a distribution.
        return DiceExpr(flat=1)
    count_s, faces_s, flat_s = m.groups()
    faces = int(faces_s) if faces_s else 0
    count = int(count_s) if count_s else (1 if faces else 0)
    flat = int(flat_s.replace(" ", "")) if flat_s else 0
    return DiceExpr(count, faces, flat)


def average(expr: str) -> float:
    return parse(expr).average()


def roll(expr: str, rng, note: str = "") -> int:
    return parse(expr).roll(rng, note)[0]
