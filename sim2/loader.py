"""Loads the versioned data snapshot into typed objects.

The snapshot lives in ``data2/`` and is immutable at runtime. Nothing in the
kernel reaches past this index, so re-snapshotting the sources is a data
refresh, not a rebuild (§2 decision 9).
"""

from __future__ import annotations

import glob
import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .kernel.state import ActiveEffect
from .schema import (
    Army,
    Datasheet,
    Detachment,
    EffectRecord,
    GapRecord,
    Layout,
    MissionCard,
)

DATA_DIR = os.environ.get(
    "SIM2_DATA", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data2")
)

#: Rules the core rules grant to any model with the printed ability. Kept here
#: (not in the kernel) because they are data about ability NAMES, not rules.
CORE_ABILITY_NAMES = [
    "DEEP STRIKE", "INFILTRATORS", "SCOUTS", "LONE OPERATIVE", "STEALTH",
    "FIGHTS FIRST", "FEEL NO PAIN", "DEADLY DEMISE", "LEADER", "FIRING DECK",
    "VOICE OF COMMAND", "ASSIGNED AGENTS", "KILL TEAM",
]


@dataclass
class DataIndex:
    datasheets: Dict[str, Datasheet] = field(default_factory=dict)
    effects: Dict[str, EffectRecord] = field(default_factory=dict)
    detachments: Dict[str, Detachment] = field(default_factory=dict)
    layouts: Dict[str, Layout] = field(default_factory=dict)
    missions: Dict[str, MissionCard] = field(default_factory=dict)
    matrix: Dict[str, Dict[str, str]] = field(default_factory=dict)
    gaps: List[GapRecord] = field(default_factory=list)
    meta: Dict[str, Any] = field(default_factory=dict)
    armies: Dict[str, Army] = field(default_factory=dict)

    # -- lookups -----------------------------------------------------------
    def datasheets_of(self, faction: str, include_legends: bool = False) -> List[Datasheet]:
        return [
            d for d in self.datasheets.values()
            if d.faction == faction and (include_legends or not d.legends)
        ]

    def by_name(self, name: str) -> Optional[Datasheet]:
        low = name.strip().lower()
        for d in self.datasheets.values():
            if d.name.lower() == low:
                return d
        return None

    def detachment(self, did: str) -> Optional[Detachment]:
        return self.detachments.get(did)

    def disposition_for(self, army: Army) -> str:
        for did in army.detachments:
            det = self.detachments.get(did)
            if det and det.disposition:
                return det.disposition
        return ""

    def primary_for(self, own: str, opponent: str) -> str:
        row = self.matrix.get(_norm(own), {})
        return row.get(_norm(opponent), "")

    def mission_card(self, cid: str) -> Optional[MissionCard]:
        """Mission names are printed in caps on the layout pages and stored
        normalised as card ids, so the lookup accepts either form."""
        if not cid:
            return None
        return self.missions.get(cid) or self.missions.get(_norm(cid))

    def secondaries(self) -> List[MissionCard]:
        return [c for c in self.missions.values() if c.kind == "secondary"]

    def primaries(self) -> List[MissionCard]:
        return [c for c in self.missions.values() if c.kind == "primary"]

    def default_primary_block(self) -> Dict[str, Any]:
        """Fallback scoring for a primary whose card text is a logged GAP:
        the Take and Hold pattern (5 VP per objective, 15 VP per turn)."""
        return {"when": "end_of_turn", "rule": "control_objectives", "per": 5, "max": 15}

    def layouts_for(self, disp_a: str, disp_b: str) -> List[Layout]:
        a, b = _norm(disp_a), _norm(disp_b)
        out = [
            l for l in self.layouts.values()
            if {_norm(x) for x in l.dispositions} == {a, b}
        ]
        return sorted(out, key=lambda l: l.letter)

    # -- effects -----------------------------------------------------------
    def innate_abilities_for(self, ds: Datasheet) -> List[str]:
        """Core abilities printed on the datasheet (with their parameter)."""
        out: List[str] = []
        for name, text in ds.ability_text.items():
            upper = name.upper()
            for core in CORE_ABILITY_NAMES:
                if upper.startswith(core):
                    out.append(upper)
                    break
        return out

    def always_on_records(self, army: Army) -> List[str]:
        """Detachment rules and army rules that are in force all battle."""
        out = []
        for did in army.detachments:
            det = self.detachments.get(did)
            if not det:
                continue
            out.extend(det.rule_ids)
        for rid, rec in self.effects.items():
            if rec.kind == "army_rule" and rec.faction == army.faction:
                out.append(rid)
        return [r for r in out if r in self.effects]

    def make_active(
        self,
        record_id: str,
        player: int,
        bearer_uid: str = "",
        targets: Optional[List[str]] = None,
        expiry: str = "until_end_of_phase",
    ) -> ActiveEffect:
        return ActiveEffect(
            record_id=record_id,
            source_player=player,
            bearer_uid=bearer_uid,
            target_uids=list(targets or []),
            expiry=expiry,
        )

    def points_of(self, state, unit) -> int:
        ds = self.datasheets.get(unit.datasheet_id)
        if ds is None:
            return 0
        return ds.cost(unit.starting_models or len(unit.models)) or 0

    # -- reporting ---------------------------------------------------------
    def coverage(self) -> Dict[str, Any]:
        by_kind: Dict[str, Dict[str, int]] = {}
        for rec in self.effects.values():
            slot = by_kind.setdefault(rec.kind, {"total": 0, "bound": 0})
            slot["total"] += 1
            if rec.bound:
                slot["bound"] += 1
        return {
            "datasheets": len(self.datasheets),
            "effects": len(self.effects),
            "effects_by_kind": by_kind,
            "detachments": len(self.detachments),
            "layouts": len(self.layouts),
            "missions": len(self.missions),
            "gaps": len(self.gaps),
        }


def _norm(s: str) -> str:
    return (s or "").strip().lower().replace(" ", "_").replace("-", "_")


# --------------------------------------------------------------------------
def load(data_dir: str = DATA_DIR) -> DataIndex:
    idx = DataIndex()
    idx.meta = _read(os.path.join(data_dir, "meta.json"), {})

    for d in _read(os.path.join(data_dir, "datasheets.json"), []):
        ds = Datasheet.from_json(d)
        idx.datasheets[ds.id] = ds

    for d in _read(os.path.join(data_dir, "effects.json"), []):
        rec = EffectRecord.from_json(d)
        idx.effects[rec.id] = rec

    for d in _read(os.path.join(data_dir, "detachments.json"), []):
        det = Detachment.from_json(d)
        idx.detachments[det.id] = det

    for d in _read(os.path.join(data_dir, "missions.json"), []):
        card = MissionCard.from_json(d)
        idx.missions[card.id] = card

    matrix = _read(os.path.join(data_dir, "mission_matrix.json"), {})
    idx.matrix = {_norm(k): {_norm(k2): v2 for k2, v2 in v.items()} for k, v in matrix.items()}

    for path in sorted(glob.glob(os.path.join(data_dir, "layouts", "*.json"))):
        layout = Layout.from_json(_read(path, {}))
        idx.layouts[layout.id] = layout

    for path in sorted(glob.glob(os.path.join(data_dir, "armies", "*.json"))):
        army = Army.from_json(_read(path, {}))
        idx.armies[army.name] = army

    idx.gaps = [GapRecord(**g) for g in _read(os.path.join(data_dir, "gaps.json"), [])]

    from .kernel.datacache import set_default_data

    set_default_data(idx)
    return idx


def _read(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)
