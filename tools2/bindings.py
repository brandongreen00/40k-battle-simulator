"""Effect bindings: printed rules text -> effect primitives (§3.5).

Every entry here binds an INGESTED record (matched by its id) to the primitive
list that expresses it. The printed text always wins: a binding is only added
when the wording maps cleanly onto the primitive vocabulary. Anything that does
not is left text-only and reported by ``tools2/coverage_report.py`` — an
unbound rule is visible, not silently absent (mandate 3).

Nothing here is engine code. The kernel never learns a unit's name.
"""

from __future__ import annotations

from typing import Any, Dict, List

# --------------------------------------------------------------------------
# Stratagems and enhancements, keyed by ingested record id.
# --------------------------------------------------------------------------
BINDINGS: Dict[str, Dict[str, Any]] = {
    # -- core stratagems (15) ------------------------------------------
    "core.smokescreen": {
        "effects": [
            {"primitive": "grant_unit_ability", "abilities": ["STEALTH"],
             "scope": "unit(from_my_army)", "side": "defender"},
            {"primitive": "defensive_intervention.grant_cover", "scope": "unit(from_my_army)"},
        ],
        "duration": "until_end_of_phase",
        "trigger_window": "opponent_shooting",
    },
    "core.insane_bravery": {
        "effects": [{"primitive": "dice_manipulation.modifier", "rolls": "battle_shock",
                     "amount": 6, "scope": "unit(from_my_army)"}],
        "usage_limits": {"per_battle": 1},
        "duration": "until_end_of_turn",
    },
    "core.epic_challenge": {
        "effects": [{"primitive": "grant_weapon_ability", "abilities": ["PRECISION"],
                     "scope": "weapon(melee)"}],
        "duration": "until_end_of_phase",
    },
    "core.command_re_roll": {
        "effects": [{"primitive": "dice_manipulation.reroll", "reroll": "hit",
                     "values": "all", "scope": "unit(from_my_army)"}],
        "usage_limits": {"per_phase": 1},
        "duration": "until_end_of_phase",
    },
    "core.crushing_impact": {
        "effects": [{"primitive": "mortal_wounds", "dice": "D6", "threshold": 4,
                     "scope": "enemy_unit(engaged_with(bearer))"}],
        "duration": "until_end_of_phase",
    },
    "core.rapid_ingress": {
        "effects": [{"primitive": "reserves_modification.ingress_now",
                     "scope": "unit(in_reserves & from_my_army)"}],
        "trigger_window": "opponent_movement",
        "duration": "until_end_of_phase",
    },
    "core.counteroffensive": {
        "effects": [{"primitive": "eligibility_override.fight_next",
                     "scope": "unit(from_my_army)"}],
        "trigger_window": "fight",
        "duration": "until_end_of_phase",
    },
    "core.fire_overwatch": {
        "effects": [{"primitive": "eligibility_override.snap_shooting",
                     "scope": "unit(from_my_army)"}],
        "trigger_window": "opponent_movement",
        "duration": "until_end_of_phase",
    },
    "core.heroic_intervention": {
        "effects": [{"primitive": "out_of_sequence_move.heroic_intervention",
                     "scope": "unit(from_my_army)"}],
        "trigger_window": "opponent_charge",
        "duration": "until_end_of_phase",
    },
    "core.explosives": {
        "effects": [{"primitive": "mortal_wounds", "dice": "D3", "threshold": 4,
                     "scope": "enemy_unit(within(8, bearer))"}],
        "duration": "until_end_of_phase",
    },

    # -- Imperial Agents (worked example §3.9a) -------------------------
    "ia.ordo_xenos_alien_hunters.armour_of_contempt": {
        "effects": [{"primitive": "defensive_intervention.worsen_ap", "amount": 1,
                     "scope": "unit(from_my_army)"}],
        "duration": "until_attacker_finishes_attacks",
        "trigger_window": "opponent_shooting",
    },
    # §3.9b — out-of-sequence move
    "ia.ordo_xenos_alien_hunters.rapid_tactical_relocation": {
        "effects": [{"primitive": "out_of_sequence_move.remove_and_redeploy",
                     "scope": "unit(from_my_army)",
                     "placement": "anywhere & horizontal_distance(enemy_models) > 8"}],
        "trigger_window": "opponent_fight",
        "duration": "until_end_of_turn",
    },
    "ia.imperialis_fleet.violent_acquisition": {
        "effects": [{"primitive": "grant_weapon_ability",
                     "abilities": ["SUSTAINED HITS 1", "LANCE", "IGNORES COVER"],
                     "scope": "unit(from_my_army)",
                     "condition": "controls_objective"}],
        "duration": "until_end_of_phase",
    },
}

#: Bindings applied by matching the record's printed NAME (case-insensitive),
#: used where the id differs between factions but the card text is identical.
NAME_BINDINGS: Dict[str, Dict[str, Any]] = {
    "go to ground": {
        "effects": [
            {"primitive": "modify_characteristic", "characteristic": "sv", "op": "improve",
             "amount": 1, "scope": "unit(from_my_army)"},
            {"primitive": "grant_unit_ability", "abilities": ["BENEFIT OF COVER"],
             "scope": "unit(from_my_army)"},
        ],
        "duration": "until_end_of_phase",
    },
    "grenades": {
        "effects": [{"primitive": "mortal_wounds", "dice": "D3", "threshold": 4,
                     "scope": "enemy_unit(within(8, bearer))"}],
    },
}


# --------------------------------------------------------------------------
# The six core Orders (§3.6). Text transcribed verbatim from the Astra
# Militarum faction page's Voice of Command table (11 v1.1, July 2026).
# --------------------------------------------------------------------------
ORDERS: List[Dict[str, Any]] = [
    {
        "id": "am.voice_of_command.move_move_move",
        "name": "Move! Move! Move!",
        "text": 'M +3" — Add 3" to the Move characteristic of models in this unit.',
        "effects": [{"primitive": "modify_characteristic", "characteristic": "m",
                     "op": "add", "amount": 3, "scope": "unit(ASTRA MILITARUM)"}],
    },
    {
        "id": "am.voice_of_command.fix_bayonets",
        "name": "Fix Bayonets!",
        "text": "WS +1 — Improve the Weapon Skill characteristic of melee weapons "
                "equipped by models in this unit by 1.",
        "effects": [{"primitive": "modify_characteristic", "characteristic": "ws",
                     "op": "improve", "amount": 1, "scope": "weapon(melee)"}],
    },
    {
        "id": "am.voice_of_command.take_aim",
        "name": "Take Aim!",
        "text": "BS +1 — Improve the Ballistic Skill characteristic of ranged weapons "
                "equipped by models in this unit by 1.",
        "effects": [{"primitive": "modify_characteristic", "characteristic": "bs",
                     "op": "improve", "amount": 1, "scope": "weapon(ranged)"}],
    },
    {
        "id": "am.voice_of_command.first_rank_fire",
        "name": "First Rank, Fire! Second Rank, Fire!",
        "text": "A +1 — Improve the Attacks characteristic of Rapid Fire weapons "
                "equipped by models in this unit by 1.",
        "effects": [{"primitive": "modify_characteristic", "characteristic": "a",
                     "op": "add", "amount": 1,
                     "scope": "weapon(ranged & has(RAPID FIRE))"}],
    },
    {
        "id": "am.voice_of_command.take_cover",
        "name": "Take Cover!",
        "text": "SV +1 — Improve the Save characteristic of models in this unit by 1 "
                "(this cannot improve a model's Save to better than 3+).",
        "effects": [{"primitive": "modify_characteristic", "characteristic": "sv",
                     "op": "improve", "amount": 1, "cap": "3+",
                     "scope": "unit(ASTRA MILITARUM)"}],
    },
    {
        "id": "am.voice_of_command.duty_and_honour",
        "name": "Duty and Honour!",
        "text": "LD +1, OC +1 — Improve the Leadership and Objective Control "
                "characteristics of models in this unit by 1.",
        "effects": [
            {"primitive": "modify_characteristic", "characteristic": "ld",
             "op": "improve", "amount": 1, "scope": "unit(ASTRA MILITARUM)"},
            {"primitive": "modify_characteristic", "characteristic": "oc",
             "op": "add", "amount": 1, "scope": "unit(ASTRA MILITARUM)"},
        ],
    },
]

#: Army rules that the kernel needs as records rather than as prose.
ARMY_RULES: List[Dict[str, Any]] = [
    {
        "id": "am.army.voice_of_command",
        "name": "Voice of Command",
        "faction": "AM",
        "text": "OFFICER models can issue Orders to REGIMENT units within 6\" in your "
                "Command phase. Battle-shocked units cannot be issued Orders and an "
                "Order is lost when its unit becomes Battle-shocked.",
        "effects": [],
    },
    {
        "id": "ia.army.assigned_agents",
        "name": "Assigned Agents",
        "faction": "IA",
        "text": "AGENTS OF THE IMPERIUM units can be included in another IMPERIUM army "
                "as Assigned Agents, priced from the Assigned Agent points column, "
                "within the battle-size ally allowance.",
        "effects": [],
    },
]


def apply_bindings(records: List[Dict[str, Any]]) -> Dict[str, int]:
    """Fold bindings into ingested records in place; return coverage counts."""
    bound = 0
    for rec in records:
        binding = BINDINGS.get(rec["id"]) or NAME_BINDINGS.get(rec.get("name", "").lower())
        if not binding:
            continue
        rec["effects"] = binding["effects"]
        if "duration" in binding:
            rec["duration"] = binding["duration"]
        if "trigger_window" in binding:
            rec.setdefault("trigger", {})["window"] = binding["trigger_window"]
        if "usage_limits" in binding:
            rec["usage_limits"] = binding["usage_limits"]
        bound += 1
    return {"bound": bound, "total": len(records)}
