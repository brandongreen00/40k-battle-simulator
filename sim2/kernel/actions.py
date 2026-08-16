"""The action vocabulary agents choose from.

An ``Action`` is plain data so it round-trips through the battle log and a
replay reproduces the game exactly (§3.1).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict


@dataclass(frozen=True)
class Action:
    kind: str
    params: Dict[str, Any] = field(default_factory=dict)
    label: str = ""

    def to_json(self) -> dict:
        d = {"kind": self.kind, "params": self.params}
        if self.label:
            d["label"] = self.label
        return d

    @staticmethod
    def from_json(d: dict) -> "Action":
        return Action(d["kind"], dict(d.get("params", {})), d.get("label", ""))

    def key(self) -> str:
        parts = [self.kind]
        for k in sorted(self.params):
            parts.append(f"{k}={self.params[k]}")
        return "|".join(parts)


def deploy(unit: str, pos) -> Action:
    return Action("deploy_unit", {"unit": unit, "pos": [round(pos[0], 3), round(pos[1], 3)]},
                  f"deploy {unit}")


def reserves(unit: str) -> Action:
    return Action("place_in_reserves", {"unit": unit}, f"reserves {unit}")


def move(unit: str, dest, mode: str = "normal") -> Action:
    return Action("move_unit",
                  {"unit": unit, "dest": [round(dest[0], 3), round(dest[1], 3)], "mode": mode},
                  f"{mode} {unit}")


def arrive(unit: str, pos) -> Action:
    return Action("arrive_from_reserves",
                  {"unit": unit, "pos": [round(pos[0], 3), round(pos[1], 3)]}, f"arrive {unit}")


def shoot(unit: str, target: str) -> Action:
    return Action("shoot_unit", {"unit": unit, "target": target}, f"shoot {unit}->{target}")


def charge(unit: str, targets) -> Action:
    return Action("charge", {"unit": unit, "targets": list(targets)}, f"charge {unit}")


def fight(unit: str, target: str) -> Action:
    return Action("fight", {"unit": unit, "target": target}, f"fight {unit}->{target}")


def stratagem(sid: str, unit: str = "", target: str = "") -> Action:
    return Action("use_stratagem", {"stratagem": sid, "unit": unit, "target": target}, sid)


def order(officer: str, unit: str, oid: str) -> Action:
    return Action("issue_order", {"officer": officer, "unit": unit, "order": oid}, oid)


def start_action(unit: str, aid: str, objective: str = "") -> Action:
    return Action("start_action", {"unit": unit, "action": aid, "objective": objective}, aid)


def end_phase() -> Action:
    return Action("end_phase", {}, "end phase")


def passing() -> Action:
    return Action("pass", {}, "pass")
