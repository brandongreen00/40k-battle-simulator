"""Live game state.

The kernel owns the core rules' primitives only. It knows what a unit, a phase,
an attack and an objective are; it knows nothing about any faction's rules —
those arrive as :class:`sim2.schema.EffectRecord` data and are applied by the
interpreter (§2 decision 3).

State is cheaply clonable (``snapshot``/``restore``) because the search agent
needs it (§3.8).
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..geometry import BaseShape
from ..schema import Datasheet, Layout

PHASES = ["command", "movement", "shooting", "charge", "fight"]
BATTLE_ROUNDS = 5


@dataclass
class ModelState:
    id: str
    datasheet_id: str
    pos: Tuple[float, float]
    wounds: int
    max_wounds: int
    base: BaseShape
    height: float = 2.0
    z: float = 0.0
    alive: bool = True
    wargear: List[str] = field(default_factory=list)

    def clone(self) -> "ModelState":
        return ModelState(
            self.id, self.datasheet_id, self.pos, self.wounds, self.max_wounds,
            self.base, self.height, self.z, self.alive, list(self.wargear),
        )


@dataclass
class UnitState:
    uid: str
    owner: int
    datasheet_id: str
    name: str
    keywords: List[str] = field(default_factory=list)
    models: List[ModelState] = field(default_factory=list)
    starting_models: int = 0
    starting_wounds: int = 0

    # composition / attachments (core rules 19)
    attached_uids: List[str] = field(default_factory=list)   # leader datasheets merged in
    leader_of: str = ""
    warlord: bool = False
    enhancement_id: str = ""

    # per-turn state
    move_mode: str = ""          # "" | "stationary" | "normal" | "advance" | "fall_back"
    moved: bool = False
    advanced_roll: int = 0
    charged: bool = False
    charge_attempted: bool = False
    fought: bool = False
    shot: bool = False
    disembarked: bool = False
    set_up_this_turn: bool = False
    action: str = ""             # in-progress Action (16)
    action_started_round: int = 0

    # persistent state
    battle_shocked: bool = False
    in_reserves: bool = False
    reserves_kind: str = ""      # "strategic" | "deep_strike" | "aircraft"
    destroyed: bool = False
    embarked_in: str = ""
    transporting: List[str] = field(default_factory=list)
    orders: List[str] = field(default_factory=list)
    granted_abilities: List[str] = field(default_factory=list)
    innate_abilities: List[str] = field(default_factory=list)
    last_shot_round: int = -1
    deployed: bool = False
    flags: Dict[str, Any] = field(default_factory=dict)

    # -- derived ----------------------------------------------------------
    @property
    def alive_models(self) -> List[ModelState]:
        return [m for m in self.models if m.alive]

    @property
    def model_count(self) -> int:
        return len(self.alive_models)

    @property
    def abilities(self) -> List[str]:
        return list(self.innate_abilities) + list(self.granted_abilities)

    def has_ability(self, name: str) -> bool:
        n = name.upper()
        return any(a.upper() == n or a.upper().startswith(n + " ") for a in self.abilities)

    def ability_value(self, name: str, default: float = 0.0) -> float:
        n = name.upper()
        for a in self.abilities:
            au = a.upper()
            if au.startswith(n):
                tail = au[len(n):].strip().rstrip('"+')
                try:
                    return float(tail)
                except ValueError:
                    return default
        return default

    def has_keyword(self, kw: str) -> bool:
        k = kw.upper().replace("_", " ")
        return any(x.upper().replace("_", " ") == k for x in self.keywords)

    def below_half_strength(self) -> bool:
        """01.02.01 — starting strength halved, rounding up is NOT applied:
        a unit is below half strength when fewer than half its starting models
        remain (or, for single-model units, fewer than half its wounds)."""
        if self.starting_models > 1:
            return self.model_count * 2 < self.starting_models
        total = sum(m.wounds for m in self.alive_models)
        return total * 2 < self.starting_wounds

    def total_wounds(self) -> int:
        return sum(m.wounds for m in self.alive_models)

    def is_character(self) -> bool:
        return self.has_keyword("CHARACTER")

    def clone(self) -> "UnitState":
        u = copy.copy(self)
        u.models = [m.clone() for m in self.models]
        u.keywords = list(self.keywords)
        u.attached_uids = list(self.attached_uids)
        u.orders = list(self.orders)
        u.granted_abilities = list(self.granted_abilities)
        u.innate_abilities = list(self.innate_abilities)
        u.transporting = list(self.transporting)
        u.flags = dict(self.flags)
        return u


@dataclass
class PlayerState:
    index: int
    name: str = ""
    faction: str = ""
    detachments: List[str] = field(default_factory=list)
    disposition: str = ""
    primary_mission: str = ""
    cp: int = 0
    vp_primary: int = 0
    vp_secondary: int = 0
    vp_battle_ready: int = 0
    secondary_mode: str = "tactical"     # "tactical" | "fixed"
    secondary_hand: List[str] = field(default_factory=list)
    secondary_deck: List[str] = field(default_factory=list)
    secondary_discard: List[str] = field(default_factory=list)
    scored_this_round: int = 0
    attacker: bool = False
    army_state: Dict[str, Any] = field(default_factory=dict)
    mission_state: Dict[str, Any] = field(default_factory=dict)

    @property
    def vp(self) -> int:
        return self.vp_primary + self.vp_secondary + self.vp_battle_ready

    def clone(self) -> "PlayerState":
        p = copy.copy(self)
        p.detachments = list(self.detachments)
        p.secondary_hand = list(self.secondary_hand)
        p.secondary_deck = list(self.secondary_deck)
        p.secondary_discard = list(self.secondary_discard)
        p.army_state = copy.deepcopy(self.army_state)
        p.mission_state = copy.deepcopy(self.mission_state)
        return p


@dataclass
class ActiveEffect:
    """An effect record currently in force."""

    record_id: str
    source_player: int
    bearer_uid: str = ""
    target_uids: List[str] = field(default_factory=list)
    expiry: str = "until_end_of_phase"
    expires_round: int = 0
    expires_phase: str = ""
    expires_player: int = -1
    params: Dict[str, Any] = field(default_factory=dict)

    def clone(self) -> "ActiveEffect":
        e = copy.copy(self)
        e.target_uids = list(self.target_uids)
        e.params = dict(self.params)
        return e


@dataclass
class GameState:
    layout: Layout
    players: List[PlayerState]
    units: Dict[str, UnitState] = field(default_factory=dict)

    battle_round: int = 0
    phase: str = "deployment"
    step: str = "deploy"
    active_player: int = 0
    first_player: int = 0
    attacker: int = 0
    battle_size: int = 1000
    finished: bool = False

    active_effects: List[ActiveEffect] = field(default_factory=list)
    usage: Dict[str, int] = field(default_factory=dict)     # bookkeeping counters
    pending: Dict[str, Any] = field(default_factory=dict)   # mid-resolution context
    kills: List[Dict[str, Any]] = field(default_factory=list)
    events: List[Dict[str, Any]] = field(default_factory=list)
    turn_index: int = 0          # increments on every player turn

    # -- queries -----------------------------------------------------------
    def units_of(self, player: int, on_board: bool = True) -> List[UnitState]:
        out = []
        for u in self.units.values():
            if u.owner != player or u.destroyed:
                continue
            if on_board and (u.in_reserves or u.embarked_in or not u.models):
                continue
            out.append(u)
        return out

    def all_units(self, player: Optional[int] = None) -> List[UnitState]:
        return [
            u for u in self.units.values()
            if not u.destroyed and (player is None or u.owner == player)
        ]

    def enemy_of(self, player: int) -> int:
        return 1 - player

    def opponent_units(self, player: int) -> List[UnitState]:
        return self.units_of(self.enemy_of(player))

    def unit(self, uid: str) -> Optional[UnitState]:
        return self.units.get(uid)

    # -- bookkeeping -------------------------------------------------------
    def bump(self, key: str, n: int = 1) -> int:
        self.usage[key] = self.usage.get(key, 0) + n
        return self.usage[key]

    def count(self, key: str) -> int:
        return self.usage.get(key, 0)

    def clear_prefix(self, prefix: str) -> None:
        for k in [k for k in self.usage if k.startswith(prefix)]:
            del self.usage[k]

    def emit(self, kind: str, **data: Any) -> None:
        self.events.append({
            "round": self.battle_round,
            "phase": self.phase,
            "active": self.active_player,
            "kind": kind,
            **data,
        })

    # -- cloning (search agent) -------------------------------------------
    def snapshot(self) -> "GameState":
        s = copy.copy(self)
        s.players = [p.clone() for p in self.players]
        s.units = {k: u.clone() for k, u in self.units.items()}
        s.active_effects = [e.clone() for e in self.active_effects]
        s.usage = dict(self.usage)
        s.pending = copy.deepcopy(self.pending)
        s.kills = list(self.kills)
        s.events = []          # events are a log, not state the search needs
        return s


def new_unit_from_datasheet(
    uid: str,
    owner: int,
    ds: Datasheet,
    models: int,
    positions: Optional[List[Tuple[float, float]]] = None,
) -> UnitState:
    """Build a live unit. Multi-profile datasheets fill from the first profile
    outward (the printed composition order)."""
    profiles = ds.models or []
    unit = UnitState(
        uid=uid,
        owner=owner,
        datasheet_id=ds.id,
        name=ds.name,
        keywords=list(ds.keywords),
    )
    for i in range(models):
        prof = profiles[min(i, len(profiles) - 1)] if profiles else None
        if prof is None:
            continue
        # A multi-profile squad prints its leader model first; every other model
        # uses the last profile (the rank-and-file entry).
        if len(profiles) > 1:
            prof = profiles[0] if i == 0 else profiles[-1]
        pos = positions[i] if positions and i < len(positions) else (0.0, 0.0)
        unit.models.append(
            ModelState(
                id=f"{uid}~m{i}",
                datasheet_id=ds.id,
                pos=pos,
                wounds=prof.w,
                max_wounds=prof.w,
                base=prof.base,
                height=prof.height,
            )
        )
    unit.starting_models = len(unit.models)
    unit.starting_wounds = sum(m.max_wounds for m in unit.models)
    return unit
