"""Command-line harness: ``python3 -m sim2.cli <command>``."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List

from .harness.run import play_game, run_batch
from .loader import load


def _armies(data, names: List[str]):
    out = []
    for n in names:
        if n in data.armies:
            out.append(data.armies[n])
            continue
        match = [a for a in data.armies.values() if a.name.lower().startswith(n.lower())]
        if not match:
            raise SystemExit(f"unknown army {n!r}; have: {sorted(data.armies)}")
        out.append(match[0])
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="sim2")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("play", help="play one game and write its battle log")
    p.add_argument("--a", required=True)
    p.add_argument("--b", required=True)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--agent-a", default="heuristic")
    p.add_argument("--agent-b", default="heuristic")
    p.add_argument("--battle-size", type=int, default=1000)
    p.add_argument("--out", default="results/logs/battle.json")

    b = sub.add_parser("batch", help="play N games and write a results summary")
    b.add_argument("--a", required=True)
    b.add_argument("--b", required=True)
    b.add_argument("--games", type=int, default=20)
    b.add_argument("--seed", type=int, default=1)
    b.add_argument("--agent-a", default="heuristic")
    b.add_argument("--agent-b", default="heuristic")
    b.add_argument("--battle-size", type=int, default=1000)
    b.add_argument("--out", default="results")

    o = sub.add_parser("optimize", help="search army lists against a fixed opponent")
    o.add_argument("--faction", required=True)
    o.add_argument("--detachment", default="")
    o.add_argument("--vs", required=True)
    o.add_argument("--candidates", type=int, default=20)
    o.add_argument("--games", type=int, default=4)
    o.add_argument("--seed", type=int, default=1)
    o.add_argument("--battle-size", type=int, default=1000)
    o.add_argument("--out", default="results")

    sub.add_parser("data", help="print snapshot coverage")
    sub.add_parser("armies", help="list available armies")

    args = ap.parse_args(argv)
    data = load()

    if args.cmd == "data":
        print(json.dumps(data.coverage(), indent=1))
        return 0
    if args.cmd == "armies":
        for name, army in sorted(data.armies.items()):
            print(f"{army.name:34s} {army.faction:3s} {army.points:5d}pts "
                  f"{len(army.units)} units  [{data.disposition_for(army)}]")
        return 0
    if args.cmd == "play":
        a, b = _armies(data, [args.a, args.b])
        res, _ = play_game(data, a, b, args.seed, args.agent_a, args.agent_b,
                           args.battle_size, write_log=args.out)
        print(json.dumps(res.to_json(), indent=1))
        return 0
    if args.cmd == "batch":
        a, b = _armies(data, [args.a, args.b])
        summary = run_batch(data, a, b, args.games, args.seed, args.agent_a,
                            args.agent_b, args.battle_size, args.out)
        print(json.dumps(summary["totals"], indent=1))
        return 0
    if args.cmd == "optimize":
        from .harness.optimizer import run_optimizer

        opponent = _armies(data, [args.vs])[0]
        summary = run_optimizer(data, args.faction, args.detachment, opponent,
                                args.candidates, args.games, args.seed,
                                args.battle_size, args.out)
        print(json.dumps(summary["leaderboard"][:5], indent=1))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
