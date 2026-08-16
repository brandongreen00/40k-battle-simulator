"""Access to the immutable data snapshot from inside the kernel.

The kernel never imports faction content; it asks the loaded
:class:`sim2.loader.DataIndex` for the datasheet / effect record behind an id.
The index is attached to the state (``state.data``) at battle construction; a
module-level fallback keeps helper functions usable in unit tests.
"""

from __future__ import annotations

from typing import Any, Optional

from ..schema import Datasheet, EffectRecord, ModelProfile

_FALLBACK: Any = None


def set_default_data(index: Any) -> None:
    global _FALLBACK
    _FALLBACK = index


def get_data(state: Any = None) -> Any:
    if state is not None:
        idx = getattr(state, "data", None)
        if idx is not None:
            return idx
    return _FALLBACK


def datasheet(state: Any, ds_id: str) -> Optional[Datasheet]:
    idx = get_data(state)
    return idx.datasheets.get(ds_id) if idx else None


def effect(state: Any, eff_id: str) -> Optional[EffectRecord]:
    idx = get_data(state)
    return idx.effects.get(eff_id) if idx else None


def model_profile_for(state: Any, unit: Any, model: Any) -> Optional[ModelProfile]:
    """The profile for one model, honouring damaged brackets (trap §6.7).

    A model whose datasheet prints wound brackets uses the bracket matching its
    CURRENT remaining wounds.
    """
    ds = datasheet(state, getattr(model, "datasheet_id", "") or unit.datasheet_id)
    if ds is None or not ds.models:
        return None
    bracketed = [p for p in ds.models if p.bracket_from is not None or p.bracket_to is not None]
    if bracketed:
        for prof in bracketed:
            lo = prof.bracket_from if prof.bracket_from is not None else 0
            hi = prof.bracket_to if prof.bracket_to is not None else 10 ** 6
            if lo <= model.wounds <= hi:
                return prof
    if len(ds.models) == 1:
        return ds.models[0]
    # Multi-profile squads: match the model's max wounds back to its profile.
    for prof in ds.models:
        if prof.w == model.max_wounds:
            return prof
    return ds.models[0]


def unit_move(state: Any, unit: Any) -> float:
    prof = None
    for m in unit.alive_models:
        p = model_profile_for(state, unit, m)
        if p and (prof is None or p.m < prof.m):
            prof = p          # a unit moves at the speed of its slowest model
    return prof.m if prof else 6.0


def unit_leadership(state: Any, unit: Any) -> int:
    best = 10
    for m in unit.alive_models:
        p = model_profile_for(state, unit, m)
        if p:
            best = min(best, p.ld)
    return best
