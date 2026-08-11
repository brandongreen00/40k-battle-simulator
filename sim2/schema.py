"""Versioned data records (§3.2).

Every record carries provenance. Rules records carry the faction pack version;
points records carry the MFM version. Records are immutable after ingestion —
a correction is a NEW record whose ``supersedes`` points at the old id.

A missing value is never invented: it is a ``GapRecord`` in ``data2/gaps.json``
(autonomy mandate 3).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional

from .geometry import BaseShape

SCHEMA_VERSION = "2.0.0"


# --------------------------------------------------------------------------
@dataclass
class Provenance:
    source: str
    pack_version: str = ""
    mfm_version: str = ""
    retrieved: str = ""
    note: str = ""

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v}

    @staticmethod
    def from_json(d: Optional[dict]) -> "Provenance":
        d = d or {}
        return Provenance(
            source=d.get("source", "unknown"),
            pack_version=d.get("pack_version", ""),
            mfm_version=d.get("mfm_version", ""),
            retrieved=d.get("retrieved", ""),
            note=d.get("note", ""),
        )


@dataclass
class GapRecord:
    """A value that source did not provide. Logged, never guessed."""

    id: str
    what: str
    why: str
    attempted: List[str] = field(default_factory=list)
    estimate: Optional[str] = None
    basis: Optional[str] = None

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


# --------------------------------------------------------------------------
# Datasheets
# --------------------------------------------------------------------------
@dataclass
class WeaponProfile:
    name: str
    kind: str                      # "ranged" | "melee"
    attacks: str                   # dice expression, e.g. "2", "D6", "D6+3"
    skill: int                     # BS / WS as an N+ target (7 = cannot hit)
    strength: int
    ap: int                        # stored <= 0
    damage: str                    # dice expression
    range_in: float = 0.0          # 0 for melee
    abilities: List[str] = field(default_factory=list)  # normalised, e.g. "RAPID FIRE 1"
    profile_of: str = ""           # parent weapon for multi-profile weapons

    def has(self, ability: str) -> bool:
        a = ability.upper()
        return any(x.upper() == a or x.upper().startswith(a + " ") for x in self.abilities)

    def ability_value(self, ability: str, default: int = 0) -> int:
        a = ability.upper()
        for x in self.abilities:
            xu = x.upper()
            if xu.startswith(a):
                tail = xu[len(a):].strip().rstrip("+")
                try:
                    return int(tail)
                except ValueError:
                    return default
        return default

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v not in ("", 0, [], None) or k in ("ap", "skill")}

    @staticmethod
    def from_json(d: dict) -> "WeaponProfile":
        return WeaponProfile(
            name=d["name"],
            kind=d.get("kind", "ranged"),
            attacks=str(d.get("attacks", "1")),
            skill=int(d.get("skill", 4)),
            strength=int(d.get("strength", 4)),
            ap=int(d.get("ap", 0)),
            damage=str(d.get("damage", "1")),
            range_in=float(d.get("range_in", 0)),
            abilities=list(d.get("abilities", [])),
            profile_of=d.get("profile_of", ""),
        )


@dataclass
class ModelProfile:
    name: str
    m: float
    t: int
    sv: int
    w: int
    ld: int
    oc: int
    invuln: Optional[int] = None
    base: BaseShape = field(default_factory=BaseShape)
    height: float = 2.0            # height band, inches (5" vertical terms)
    bracket_from: Optional[int] = None   # damaged-bracket lower bound (wounds)
    bracket_to: Optional[int] = None

    def to_json(self) -> dict:
        d = asdict(self)
        d["base"] = self.base.to_json()
        return {k: v for k, v in d.items() if v is not None}

    @staticmethod
    def from_json(d: dict) -> "ModelProfile":
        return ModelProfile(
            name=d.get("name", "model"),
            m=float(d.get("m", 6)),
            t=int(d.get("t", 4)),
            sv=int(d.get("sv", 4)),
            w=int(d.get("w", 1)),
            ld=int(d.get("ld", 7)),
            oc=int(d.get("oc", 1)),
            invuln=d.get("invuln"),
            base=BaseShape.from_json(d.get("base", {})),
            height=float(d.get("height", 2.0)),
            bracket_from=d.get("bracket_from"),
            bracket_to=d.get("bracket_to"),
        )


@dataclass
class PointsTier:
    """Per-copy points (trap §6.6 escalating squadron costs, §6.5 dual column)."""

    models: int
    points: int
    copy_from: int = 1             # applies to your Nth+ copy of the datasheet
    copy_to: int = 99
    column: str = "army_faction"   # "army_faction" | "assigned_agent"

    def to_json(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_json(d: dict) -> "PointsTier":
        return PointsTier(
            models=int(d.get("models", 1)),
            points=int(d.get("points", 0)),
            copy_from=int(d.get("copy_from", 1)),
            copy_to=int(d.get("copy_to", 99)),
            column=d.get("column", "army_faction"),
        )


@dataclass
class Datasheet:
    id: str
    name: str
    faction: str                   # "IA" | "AM"
    role: str = ""
    models: List[ModelProfile] = field(default_factory=list)
    weapons: List[WeaponProfile] = field(default_factory=list)
    keywords: List[str] = field(default_factory=list)
    ability_ids: List[str] = field(default_factory=list)
    ability_text: Dict[str, str] = field(default_factory=dict)
    unit_sizes: List[int] = field(default_factory=lambda: [1])
    points: List[PointsTier] = field(default_factory=list)
    transport_capacity: int = 0
    transport_text: str = ""
    legends: bool = False
    led_by: List[str] = field(default_factory=list)
    default_loadout: Dict[str, int] = field(default_factory=dict)
    provenance: Provenance = field(default_factory=lambda: Provenance("unknown"))

    # -- helpers -----------------------------------------------------------
    def has_keyword(self, kw: str) -> bool:
        k = kw.upper().replace("_", " ")
        return any(x.upper() == k for x in self.keywords)

    def primary_model(self) -> ModelProfile:
        return self.models[0] if self.models else ModelProfile("model", 6, 4, 4, 1, 7, 1)

    def cost(self, models: int, copy_index: int = 1, column: str = "army_faction") -> Optional[int]:
        best: Optional[int] = None
        for t in self.points:
            if t.column != column:
                continue
            if not (t.copy_from <= copy_index <= t.copy_to):
                continue
            if t.models == models:
                return t.points
            if t.models <= models and (best is None or t.models > best):
                best = t.points
        return best

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "faction": self.faction,
            "role": self.role,
            "models": [m.to_json() for m in self.models],
            "weapons": [w.to_json() for w in self.weapons],
            "keywords": self.keywords,
            "ability_ids": self.ability_ids,
            "ability_text": self.ability_text,
            "unit_sizes": self.unit_sizes,
            "points": [p.to_json() for p in self.points],
            "transport_capacity": self.transport_capacity,
            "transport_text": self.transport_text,
            "legends": self.legends,
            "led_by": self.led_by,
            "default_loadout": self.default_loadout,
            "provenance": self.provenance.to_json(),
        }

    @staticmethod
    def from_json(d: dict) -> "Datasheet":
        return Datasheet(
            id=d["id"],
            name=d["name"],
            faction=d.get("faction", ""),
            role=d.get("role", ""),
            models=[ModelProfile.from_json(m) for m in d.get("models", [])],
            weapons=[WeaponProfile.from_json(w) for w in d.get("weapons", [])],
            keywords=list(d.get("keywords", [])),
            ability_ids=list(d.get("ability_ids", [])),
            ability_text=dict(d.get("ability_text", {})),
            unit_sizes=list(d.get("unit_sizes", [1])) or [1],
            points=[PointsTier.from_json(p) for p in d.get("points", [])],
            transport_capacity=int(d.get("transport_capacity", 0)),
            transport_text=d.get("transport_text", ""),
            legends=bool(d.get("legends", False)),
            led_by=list(d.get("led_by", [])),
            default_loadout=dict(d.get("default_loadout", {})),
            provenance=Provenance.from_json(d.get("provenance")),
        )


# --------------------------------------------------------------------------
# Effect records (§3.3)
# --------------------------------------------------------------------------
@dataclass
class TargetSpec:
    selector: str
    count: str = "1"               # "1" | "up_to N" | "any_number"

    def to_json(self) -> dict:
        return asdict(self)


@dataclass
class EffectPrimitive:
    """One entry of the ordered ``effects`` list."""

    primitive: str
    params: Dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        return self.params.get(key, default)

    def to_json(self) -> dict:
        return {"primitive": self.primitive, **self.params}

    @staticmethod
    def from_json(d: dict) -> "EffectPrimitive":
        params = {k: v for k, v in d.items() if k != "primitive"}
        return EffectPrimitive(d["primitive"], params)


@dataclass
class UsageLimits:
    per_battle: Optional[int] = None
    per_battle_round: Optional[int] = None
    per_phase: Optional[int] = None
    per_turn: Optional[int] = None
    mutually_exclusive_with: List[str] = field(default_factory=list)
    overrides: List[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v}

    @staticmethod
    def from_json(d: Optional[dict]) -> "UsageLimits":
        d = d or {}
        return UsageLimits(
            per_battle=d.get("per_battle"),
            per_battle_round=d.get("per_battle_round"),
            per_phase=d.get("per_phase"),
            per_turn=d.get("per_turn"),
            mutually_exclusive_with=list(d.get("mutually_exclusive_with", [])),
            overrides=list(d.get("overrides", [])),
        )


@dataclass
class EffectRecord:
    """The single shape every faction rule is expressed in (§3.3).

    Adding a stratagem, enhancement, order, or datasheet ability is a data edit.
    Hardcoding one into kernel source is a design violation (§2 decision 3).
    """

    id: str
    kind: str
    name: str
    cost_cp: int = 0
    cost_points: int = 0
    cost_dp: int = 0
    category: str = ""
    trigger_window: str = "passive"
    trigger_condition: str = ""
    trigger_actor: str = "friendly"
    targets: List[TargetSpec] = field(default_factory=list)
    effects: List[EffectPrimitive] = field(default_factory=list)
    duration: str = "until_end_of_phase"
    usage_limits: UsageLimits = field(default_factory=UsageLimits)
    restrictions: List[str] = field(default_factory=list)
    text: str = ""
    detachment: str = ""
    faction: str = ""
    provenance: Provenance = field(default_factory=lambda: Provenance("unknown"))

    @property
    def bound(self) -> bool:
        """False => text-only (ingested, not yet expressible). Never silent."""
        return bool(self.effects)

    def to_json(self) -> dict:
        d = {
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "category": self.category,
            "trigger": {
                "window": self.trigger_window,
                "condition": self.trigger_condition,
                "actor": self.trigger_actor,
            },
            "target": [t.to_json() for t in self.targets],
            "effects": [e.to_json() for e in self.effects],
            "duration": self.duration,
            "usage_limits": self.usage_limits.to_json(),
            "restrictions": self.restrictions,
            "text": self.text,
            "detachment": self.detachment,
            "faction": self.faction,
            "provenance": self.provenance.to_json(),
        }
        cost = {}
        if self.cost_cp:
            cost["cp"] = self.cost_cp
        if self.cost_points:
            cost["points"] = self.cost_points
        if self.cost_dp:
            cost["dp"] = self.cost_dp
        if cost:
            d["cost"] = cost
        return d

    @staticmethod
    def from_json(d: dict) -> "EffectRecord":
        trig = d.get("trigger", {}) or {}
        cost = d.get("cost", {}) or {}
        return EffectRecord(
            id=d["id"],
            kind=d.get("kind", "datasheet_ability"),
            name=d.get("name", d["id"]),
            cost_cp=int(cost.get("cp", 0) or 0),
            cost_points=int(cost.get("points", 0) or 0),
            cost_dp=int(cost.get("dp", 0) or 0),
            category=d.get("category", ""),
            trigger_window=trig.get("window", "passive"),
            trigger_condition=trig.get("condition", ""),
            trigger_actor=trig.get("actor", "friendly"),
            targets=[TargetSpec(t["selector"], str(t.get("count", "1"))) for t in d.get("target", [])],
            effects=[EffectPrimitive.from_json(e) for e in d.get("effects", [])],
            duration=d.get("duration", "until_end_of_phase"),
            usage_limits=UsageLimits.from_json(d.get("usage_limits")),
            restrictions=list(d.get("restrictions", [])),
            text=d.get("text", ""),
            detachment=d.get("detachment", ""),
            faction=d.get("faction", ""),
            provenance=Provenance.from_json(d.get("provenance")),
        )


@dataclass
class Detachment:
    id: str
    name: str
    faction: str
    disposition: str               # Force Disposition (feeds the primary matrix)
    dp: int
    rule_ids: List[str] = field(default_factory=list)
    stratagem_ids: List[str] = field(default_factory=list)
    enhancement_ids: List[str] = field(default_factory=list)
    exclusion_tags: List[str] = field(default_factory=list)   # RECON, ABHUMAN
    provenance: Provenance = field(default_factory=lambda: Provenance("unknown"))

    def to_json(self) -> dict:
        d = asdict(self)
        d["provenance"] = self.provenance.to_json()
        return d

    @staticmethod
    def from_json(d: dict) -> "Detachment":
        return Detachment(
            id=d["id"],
            name=d["name"],
            faction=d.get("faction", ""),
            disposition=d.get("disposition", ""),
            dp=int(d.get("dp", 0)),
            rule_ids=list(d.get("rule_ids", [])),
            stratagem_ids=list(d.get("stratagem_ids", [])),
            enhancement_ids=list(d.get("enhancement_ids", [])),
            exclusion_tags=list(d.get("exclusion_tags", [])),
            provenance=Provenance.from_json(d.get("provenance")),
        )


# --------------------------------------------------------------------------
# Armies
# --------------------------------------------------------------------------
@dataclass
class ArmyUnit:
    datasheet_id: str
    models: int = 1
    enhancement_id: str = ""
    warlord: bool = False
    attached_to: str = ""          # roster key of the bodyguard unit (Leader)
    key: str = ""

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v not in ("", False)}

    @staticmethod
    def from_json(d: dict) -> "ArmyUnit":
        return ArmyUnit(
            datasheet_id=d["datasheet_id"],
            models=int(d.get("models", 1)),
            enhancement_id=d.get("enhancement_id", ""),
            warlord=bool(d.get("warlord", False)),
            attached_to=d.get("attached_to", ""),
            key=d.get("key", ""),
        )


@dataclass
class Army:
    name: str
    faction: str
    detachments: List[str] = field(default_factory=list)
    units: List[ArmyUnit] = field(default_factory=list)
    battle_size: int = 1000
    points: int = 0
    notes: List[str] = field(default_factory=list)

    @property
    def detachment(self) -> str:
        return self.detachments[0] if self.detachments else ""

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "faction": self.faction,
            "detachments": self.detachments,
            "units": [u.to_json() for u in self.units],
            "battle_size": self.battle_size,
            "points": self.points,
            "notes": self.notes,
        }

    @staticmethod
    def from_json(d: dict) -> "Army":
        return Army(
            name=d["name"],
            faction=d.get("faction", ""),
            detachments=list(d.get("detachments", [])) or ([d["detachment"]] if d.get("detachment") else []),
            units=[ArmyUnit.from_json(u) for u in d.get("units", [])],
            battle_size=int(d.get("battle_size", 1000)),
            points=int(d.get("points", 0)),
            notes=list(d.get("notes", [])),
        )


# --------------------------------------------------------------------------
# Battlefield
# --------------------------------------------------------------------------
@dataclass
class TerrainArea:
    id: str
    polygon: List[tuple]
    category: str = "light"        # "exposed" | "light" | "dense"
    height: float = 5.0
    group: str = ""

    @property
    def obscuring(self) -> bool:
        # An area containing light or dense features is Obscuring (13.x).
        return self.category in ("light", "dense")

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "polygon": [[round(x, 3), round(y, 3)] for x, y in self.polygon],
            "category": self.category,
            "height": self.height,
            "group": self.group,
        }

    @staticmethod
    def from_json(d: dict) -> "TerrainArea":
        return TerrainArea(
            id=d["id"],
            polygon=[(float(p[0]), float(p[1])) for p in d["polygon"]],
            category=d.get("category", "light"),
            height=float(d.get("height", 5.0)),
            group=d.get("group", ""),
        )


@dataclass
class Objective:
    id: str
    pos: tuple
    kind: str = "central"          # "home" | "central" | "expansion"
    owner: Optional[int] = None    # for home objectives
    area_id: str = ""              # terrain objectives: the area IS the objective

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "pos": [round(self.pos[0], 3), round(self.pos[1], 3)],
            "kind": self.kind,
            "owner": self.owner,
            "area_id": self.area_id,
        }

    @staticmethod
    def from_json(d: dict) -> "Objective":
        return Objective(
            id=d["id"],
            pos=(float(d["pos"][0]), float(d["pos"][1])),
            kind=d.get("kind", "central"),
            owner=d.get("owner"),
            area_id=d.get("area_id", ""),
        )


@dataclass
class Layout:
    id: str
    width: float = 44.0
    height: float = 60.0
    dispositions: List[str] = field(default_factory=list)   # [player0, player1]
    letter: str = "a"
    terrain: List[TerrainArea] = field(default_factory=list)
    objectives: List[Objective] = field(default_factory=list)
    deployment_zones: Dict[str, List[List[tuple]]] = field(default_factory=dict)
    provenance: Provenance = field(default_factory=lambda: Provenance("unknown"))

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "width": self.width,
            "height": self.height,
            "dispositions": self.dispositions,
            "letter": self.letter,
            "terrain": [t.to_json() for t in self.terrain],
            "objectives": [o.to_json() for o in self.objectives],
            "deployment_zones": {
                k: [[[round(x, 3), round(y, 3)] for x, y in poly] for poly in v]
                for k, v in self.deployment_zones.items()
            },
            "provenance": self.provenance.to_json(),
        }

    @staticmethod
    def from_json(d: dict) -> "Layout":
        return Layout(
            id=d["id"],
            width=float(d.get("width", 44)),
            height=float(d.get("height", 60)),
            dispositions=list(d.get("dispositions", [])),
            letter=d.get("letter", "a"),
            terrain=[TerrainArea.from_json(t) for t in d.get("terrain", [])],
            objectives=[Objective.from_json(o) for o in d.get("objectives", [])],
            deployment_zones={
                k: [[(float(p[0]), float(p[1])) for p in poly] for poly in v]
                for k, v in d.get("deployment_zones", {}).items()
            },
            provenance=Provenance.from_json(d.get("provenance")),
        )


@dataclass
class MissionCard:
    id: str
    name: str
    kind: str                      # "primary" | "secondary"
    disposition: str = ""
    text: str = ""
    fixed_capable: bool = False
    scoring: List[Dict[str, Any]] = field(default_factory=list)
    provenance: Provenance = field(default_factory=lambda: Provenance("unknown"))

    def to_json(self) -> dict:
        d = asdict(self)
        d["provenance"] = self.provenance.to_json()
        return d

    @staticmethod
    def from_json(d: dict) -> "MissionCard":
        return MissionCard(
            id=d["id"],
            name=d["name"],
            kind=d.get("kind", "primary"),
            disposition=d.get("disposition", ""),
            text=d.get("text", ""),
            fixed_capable=bool(d.get("fixed_capable", False)),
            scoring=list(d.get("scoring", [])),
            provenance=Provenance.from_json(d.get("provenance")),
        )
