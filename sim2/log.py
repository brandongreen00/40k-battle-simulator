"""Battle log: compact, versioned JSON (§3.1).

This format is load-bearing — the entire Pages replay viewer (§11) is built on
replaying it, and the determinism test asserts byte-identical logs from an
identical (lists, layout, seed) triple.

Layout of a log::

    {
      "log_schema_version": "2.0.0",
      "meta":   {seed, layout, armies, dispositions, primaries, battle_size, ...},
      "frames": [ {t, round, phase, active, action, events, dice, board?} ... ],
      "result": {vp, winner, rounds, ...}
    }

Board snapshots are emitted at phase boundaries only (a full per-action board
would multiply the file size for no replay benefit).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

LOG_SCHEMA_VERSION = "2.0.0"


@dataclass
class BattleLog:
    seed: int
    meta: Dict[str, Any] = field(default_factory=dict)
    frames: List[Dict[str, Any]] = field(default_factory=list)
    result: Dict[str, Any] = field(default_factory=dict)
    _t: int = 0
    board_every_phase: bool = True
    _last_phase_key: str = ""

    # -- writing -----------------------------------------------------------
    def record_action(self, state, action, events: List[Dict[str, Any]]) -> None:
        self._t += 1
        frame: Dict[str, Any] = {
            "t": self._t,
            "round": state.battle_round,
            "phase": state.phase,
            "active": state.active_player,
            "action": action.to_json(),
            "events": events,
            "cp": [p.cp for p in state.players],
            "vp": [p.vp for p in state.players],
        }
        key = f"{state.battle_round}:{state.phase}:{state.active_player}"
        if self.board_every_phase and key != self._last_phase_key:
            frame["board"] = board_snapshot(state)
            self._last_phase_key = key
        self.frames.append(frame)

    def finish(self, state) -> None:
        self.frames.append({
            "t": self._t + 1,
            "round": state.battle_round,
            "phase": "done",
            "active": state.active_player,
            "action": {"kind": "battle_end", "params": {}},
            "events": [e for e in state.events if e.get("kind") == "battle_end"],
            "board": board_snapshot(state),
            "cp": [p.cp for p in state.players],
            "vp": [p.vp for p in state.players],
        })
        vp = [p.vp for p in state.players]
        self.result = {
            "vp": vp,
            "primary": [p.vp_primary for p in state.players],
            "secondary": [p.vp_secondary for p in state.players],
            "battle_ready": [p.vp_battle_ready for p in state.players],
            "winner": None if vp[0] == vp[1] else (0 if vp[0] > vp[1] else 1),
            "rounds": state.battle_round,
            "survivors": [
                len(state.units_of(0)), len(state.units_of(1)),
            ],
        }

    # -- io ----------------------------------------------------------------
    def to_json(self) -> Dict[str, Any]:
        return {
            "log_schema_version": LOG_SCHEMA_VERSION,
            "seed": self.seed,
            "meta": self.meta,
            "frames": self.frames,
            "result": self.result,
        }

    def write(self, path: str) -> str:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_json(), fh, separators=(",", ":"), sort_keys=True)
        return path


def board_snapshot(state) -> Dict[str, Any]:
    """Base-accurate positions — everything the replay viewer draws."""
    units = []
    for unit in state.units.values():
        if unit.destroyed or unit.in_reserves or unit.embarked_in:
            continue
        models = [
            {
                "x": round(m.pos[0], 2),
                "y": round(m.pos[1], 2),
                "r": round(m.base.avg_radius, 3),
                "w": m.wounds,
            }
            for m in unit.alive_models
        ]
        if not models:
            continue
        units.append({
            "uid": unit.uid,
            "owner": unit.owner,
            "name": unit.name,
            "models": models,
            "shocked": unit.battle_shocked,
        })
    return {
        "units": units,
        "objectives": {
            oid: holder
            for oid, holder in (state.pending.get("objective_control", {}) or {}).items()
        },
        "reserves": [
            {"uid": u.uid, "owner": u.owner, "name": u.name}
            for u in state.units.values() if u.in_reserves and not u.destroyed
        ],
    }


def layout_snapshot(layout) -> Dict[str, Any]:
    """Static battlefield geometry, stored once in ``meta``."""
    return {
        "id": layout.id,
        "width": layout.width,
        "height": layout.height,
        "terrain": [
            {"id": t.id, "category": t.category,
             "polygon": [[round(x, 2), round(y, 2)] for x, y in t.polygon]}
            for t in layout.terrain
        ],
        "objectives": [o.to_json() for o in layout.objectives],
        "deployment_zones": {
            k: [[[round(x, 2), round(y, 2)] for x, y in poly] for poly in v]
            for k, v in layout.deployment_zones.items()
        },
    }
