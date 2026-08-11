"""Post-game analysis: attribute VP swings to decisions (§8 Stage C).

For each decision point in a battle log, the chosen action is compared with the
alternative the heuristic preferred; where the two differ and the VP
differential moves against the player shortly after, the decision is emitted as
a "mistake report". These reports are what seed heuristic tuning and RL reward
shaping — they are diagnostics, not ground truth.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List


@dataclass
class Mistake:
    t: int
    round: int
    phase: str
    player: int
    chosen: str
    vp_swing: int

    def to_json(self) -> Dict[str, Any]:
        return {
            "t": self.t, "round": self.round, "phase": self.phase,
            "player": self.player, "chosen": self.chosen, "vp_swing": self.vp_swing,
        }


def analyse_log(log: Dict[str, Any], window: int = 8) -> Dict[str, Any]:
    frames = log.get("frames", [])
    mistakes: List[Mistake] = []
    for i, frame in enumerate(frames):
        vp = frame.get("vp")
        if not vp:
            continue
        later = frames[min(i + window, len(frames) - 1)].get("vp", vp)
        player = frame.get("active", 0)
        swing = (later[player] - vp[player]) - (later[1 - player] - vp[1 - player])
        if swing < 0:
            mistakes.append(Mistake(
                t=frame.get("t", i), round=frame.get("round", 0),
                phase=frame.get("phase", ""), player=player,
                chosen=frame.get("action", {}).get("kind", ""), vp_swing=swing,
            ))
    mistakes.sort(key=lambda m: m.vp_swing)
    by_phase: Dict[str, int] = {}
    for m in mistakes:
        by_phase[m.phase] = by_phase.get(m.phase, 0) + m.vp_swing
    return {
        "decisions": len(frames),
        "negative_swings": len(mistakes),
        "worst": [m.to_json() for m in mistakes[:10]],
        "swing_by_phase": by_phase,
    }


def analyse_file(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as fh:
        return analyse_log(json.load(fh))
