#!/usr/bin/env python3
"""Determinism lint (§3.1): all randomness must flow through the RNG service.

Fails the build if anything under ``sim2/`` imports ``random`` or calls
``random.random()`` / ``time.time()``-seeded randomness outside ``sim2/rng.py``.
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "sim2")
ALLOWED = {os.path.join(TARGET, "rng.py")}
PATTERNS = [
    (re.compile(r"^\s*import\s+random\b", re.M), "imports the random module"),
    (re.compile(r"^\s*from\s+random\s+import", re.M), "imports from the random module"),
    (re.compile(r"\brandom\.(random|randint|choice|shuffle|uniform)\s*\(", re.M),
     "calls the random module directly"),
    (re.compile(r"\bnumpy\.random\b|\bnp\.random\b", re.M), "uses numpy.random"),
]


def main() -> int:
    problems = []
    for root, _dirs, files in os.walk(TARGET):
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            if path in ALLOWED:
                continue
            src = open(path, encoding="utf-8").read()
            for pattern, why in PATTERNS:
                for m in pattern.finditer(src):
                    line = src[: m.start()].count("\n") + 1
                    problems.append(f"{os.path.relpath(path, ROOT)}:{line}: {why}")
    for p in problems:
        print(p, file=sys.stderr)
    if problems:
        print(f"\n{len(problems)} determinism violation(s): route randomness through sim2.rng.Rng",
              file=sys.stderr)
        return 1
    print("determinism lint clean: randomness is confined to sim2/rng.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
