"""Seeded RNG service (§3.1).

Every stochastic decision in the engine flows through one injected ``Rng``.
No module outside this file may import ``random`` or call ``random.random()``;
``tests_py/test_determinism.py`` asserts that with a source lint.

The generator is a self-contained SplitMix64 so results are reproducible across
Python versions (``random.Random`` does not guarantee cross-version streams).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Sequence, TypeVar

T = TypeVar("T")

_MASK = (1 << 64) - 1


@dataclass
class DiceRoll:
    """One recorded roll, replayed verbatim into the battle log."""

    kind: str
    faces: int
    results: List[int]
    note: str = ""

    def to_json(self) -> dict:
        d = {"kind": self.kind, "faces": self.faces, "results": self.results}
        if self.note:
            d["note"] = self.note
        return d


@dataclass
class Rng:
    """Deterministic RNG. Identical (seed, call sequence) => identical stream."""

    seed: int
    _state: int = field(init=False)
    calls: int = field(default=0, init=False)
    journal: List[DiceRoll] = field(default_factory=list, init=False)
    record: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self._state = self.seed & _MASK

    # -- primitive ---------------------------------------------------------
    def _next(self) -> int:
        self.calls += 1
        self._state = (self._state + 0x9E3779B97F4A7C15) & _MASK
        z = self._state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _MASK
        return z ^ (z >> 31)

    def random(self) -> float:
        """Uniform float in [0, 1)."""
        return (self._next() >> 11) / float(1 << 53)

    def randint(self, lo: int, hi: int) -> int:
        """Inclusive integer in [lo, hi]."""
        if hi < lo:
            raise ValueError(f"empty range [{lo},{hi}]")
        return lo + self._next() % (hi - lo + 1)

    # -- dice --------------------------------------------------------------
    def roll(self, count: int, faces: int = 6, kind: str = "d6", note: str = "") -> List[int]:
        results = [self.randint(1, faces) for _ in range(max(0, count))]
        if self.record:
            self.journal.append(DiceRoll(kind, faces, list(results), note))
        return results

    def d6(self, count: int = 1, kind: str = "d6", note: str = "") -> List[int]:
        return self.roll(count, 6, kind, note)

    def d3(self, count: int = 1, kind: str = "d3", note: str = "") -> List[int]:
        # A D3 is a D6 halved and rounded up (core rules 01.05) — rolling the
        # underlying D6 keeps the stream faithful to the tabletop.
        return [(v + 1) // 2 for v in self.roll(count, 6, kind, note)]

    def two_d6(self, kind: str = "2d6", note: str = "") -> List[int]:
        return self.roll(2, 6, kind, note)

    # -- choice ------------------------------------------------------------
    def choice(self, seq: Sequence[T]) -> T:
        if not seq:
            raise ValueError("choice from empty sequence")
        return seq[self.randint(0, len(seq) - 1)]

    def shuffled(self, seq: Sequence[T]) -> List[T]:
        items = list(seq)
        for i in range(len(items) - 1, 0, -1):
            j = self.randint(0, i)
            items[i], items[j] = items[j], items[i]
        return items

    def spawn(self, tag: str) -> "Rng":
        """A derived stream (deck shuffles etc.) that cannot disturb this one."""
        mixed = (self.seed ^ (hash_str(tag) * 0x9E3779B97F4A7C15)) & _MASK
        return Rng(mixed)


def hash_str(s: str) -> int:
    """Stable (non-salted) string hash — Python's ``hash`` is randomised."""
    h = 0xCBF29CE484222325
    for ch in s.encode("utf-8"):
        h = ((h ^ ch) * 0x100000001B3) & _MASK
    return h
