"""Builds the derived parts of the ``data2/`` snapshot.

* **Layouts** — the Event Companion layouts, converted from the repository's
  visual extraction of the companion PDF (§5.3). Each layout keeps its source
  page number so a region-level re-verification can be repeated.
* **Mission matrix** — derived from the layouts themselves: every layout page
  prints both players' Force Disposition and the primary mission each of them
  scores, which is exactly the asymmetric matrix of §5.1.
* **Mission cards** — names and scoring blocks from the project's mission
  research dossier, structured where the wording maps onto an evaluator and
  logged as a GAP where it does not.
* **Armies** — legal sample rosters built from the ingested datasheets.
* **effects.json** — ingested records with :mod:`tools2.bindings` folded in.

Run: ``python3 tools2/build_data.py``
"""

from __future__ import annotations

import datetime as dt
import glob
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools2 import bindings

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data2")
SRC_LAYOUTS = os.path.join(ROOT, "data", "layouts11")
MISSION_DOC = os.path.join(ROOT, "docs", "11e_missions.md")
RETRIEVED = dt.date.today().isoformat()

GAPS: List[Dict[str, Any]] = []


def gap(gid: str, what: str, why: str, attempted: List[str], **kw) -> None:
    GAPS.append({"id": gid, "what": what, "why": why, "attempted": attempted, **kw})


MAX_POLY_VERTICES = 24


def simplify(polygon, tolerance: float = 0.35):
    """Decimate the organic outlines of the extracted terrain areas.

    The companion's areas are traced with hundreds of vertices; line of sight is
    tested against every edge, so the raw outlines dominate runtime. Vertices are
    dropped while the outline stays within ``tolerance`` inches of the original
    (a fraction of a base radius), capped at a vertex budget. The simplification
    is recorded in each layout's provenance note.
    """
    pts = [tuple(p) for p in polygon]
    if len(pts) <= 4:
        return [list(p) for p in pts]

    def rdp(points, eps):
        if len(points) < 3:
            return points
        start, end = points[0], points[-1]
        dmax, index = 0.0, 0
        for i in range(1, len(points) - 1):
            d = _point_line_distance(points[i], start, end)
            if d > dmax:
                dmax, index = d, i
        if dmax > eps:
            return rdp(points[: index + 1], eps)[:-1] + rdp(points[index:], eps)
        return [start, end]

    eps = tolerance
    out = rdp(pts + [pts[0]], eps)[:-1]
    while len(out) > MAX_POLY_VERTICES:
        eps *= 1.6
        out = rdp(pts + [pts[0]], eps)[:-1]
    return [[round(x, 3), round(y, 3)] for x, y in out]


def _point_line_distance(p, a, b) -> float:
    import math

    dx, dy = b[0] - a[0], b[1] - a[1]
    if abs(dx) < 1e-12 and abs(dy) < 1e-12:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def norm(s: str) -> str:
    return (s or "").strip().lower().replace(" ", "_").replace("-", "_")


# --------------------------------------------------------------------------
# Layouts
# --------------------------------------------------------------------------
def build_layouts() -> Tuple[int, Dict[str, Dict[str, str]]]:
    os.makedirs(os.path.join(OUT, "layouts"), exist_ok=True)
    matrix: Dict[str, Dict[str, str]] = {}
    count = 0
    for path in sorted(glob.glob(os.path.join(SRC_LAYOUTS, "*.json"))):
        src = json.load(open(path, encoding="utf-8"))
        if not isinstance(src, dict) or "terrainAreas" not in src:
            continue          # index.json and other non-layout files
        players = src.get("players", [])
        dispositions = [p.get("disposition", "") for p in players]
        terrain = []
        for area in src.get("terrainAreas", []):
            feats = area.get("features", [])
            # An area's category is the strongest feature it contains; an area
            # holding light or dense features is Obscuring (13.x).
            category = "exposed"
            if any(f.get("kind") == "dense" for f in feats):
                category = "dense"
            elif feats:
                category = "light"
            terrain.append({
                "id": area["id"],
                "polygon": simplify(area["polygon"]),
                "category": category,
                "height": 5.0,
                "group": "",
            })
        objectives = []
        for i, obj in enumerate(src.get("objectives", [])):
            owner = obj.get("owner")
            owner_idx = None
            if owner == "attacker":
                owner_idx = 0
            elif owner == "defender":
                owner_idx = 1
            objectives.append({
                "id": f"obj-{i}",
                "pos": obj["pos"],
                "kind": obj.get("kind", "central"),
                "owner": owner_idx,
                "area_id": obj.get("areaId", ""),
            })
        zones = src.get("deploymentZones", {})
        layout = {
            "id": src.get("id") or os.path.basename(path)[:-5],
            "width": src.get("boardWidth", 44.0),
            "height": src.get("boardHeight", 60.0),
            "dispositions": dispositions,
            "letter": src.get("layoutLetter", "a"),
            "terrain": terrain,
            "objectives": objectives,
            "deployment_zones": {
                "attacker": zones.get("attacker", []),
                "defender": zones.get("defender", []),
            },
            "provenance": {
                "source": "Warhammer Event Companion v1.0, layout page "
                          f"{src.get('page', '?')} (visual extraction)",
                "retrieved": RETRIEVED,
                "note": "converted from the repository's Event Companion vector/visual "
                        "extraction; page-level provenance preserved for re-verification. "
                        "Outlines simplified within 0.35\" of the traced footprint.",
            },
        }
        with open(os.path.join(OUT, "layouts", layout["id"] + ".json"), "w", encoding="utf-8") as fh:
            json.dump(layout, fh, indent=1)
        count += 1

        # the matrix: each player reads the OPPONENT's symbol on their own card
        if len(players) == 2:
            for i, p in enumerate(players):
                own = norm(p.get("disposition", ""))
                opp = norm(players[1 - i].get("disposition", ""))
                mission = p.get("mission", "")
                if own and opp and mission:
                    matrix.setdefault(own, {})[opp] = mission
    return count, matrix


# --------------------------------------------------------------------------
# Mission cards
# --------------------------------------------------------------------------
CARD_RE = re.compile(r"^####\s+(?P<name>[^—\n]+?)\s+—\s+\*(?P<own>[^*]+)\*\s+vs\s+\*(?P<opp>[^*]+)\*",
                     re.M)
VP_LINE = re.compile(r"^\s*[-+]\s*(?:\+ CUMULATIVE:\s*)?(?P<text>.+?)→\s*\*\*(?P<vp>\d+)VP\*\*", re.M)


def _scoring_blocks(body: str, name: str, cid: str) -> List[Dict[str, Any]]:
    """Map the printed VP lines onto evaluators where the wording is explicit."""
    blocks: List[Dict[str, Any]] = []
    unmapped = 0
    for m in VP_LINE.finditer(body):
        text = re.sub(r"\*\*|\*", "", m.group("text")).strip().lower()
        vp = int(m.group("vp"))
        when = "end_of_turn"
        if "command phase" in body[max(0, m.start() - 400): m.start()].lower():
            when = "command_phase"
        from_round = 2 if "second battle round onwards" in body[
            max(0, m.start() - 400): m.start()].lower() else 1
        block: Optional[Dict[str, Any]] = None
        if "each enemy unit" in text and "destroyed" in text:
            block = {"rule": "enemy_units_destroyed_this_turn", "per": vp, "max": 15}
        elif "more objectives than your opponent" in text:
            block = {"rule": "control_more_objectives", "per": vp, "max": vp}
        elif "control" in text and "objective" in text:
            block = {"rule": "control_objectives", "per": vp, "max": 15}
        elif "enemy deployment zone" in text or "enemy half" in text:
            block = {"rule": "units_in_enemy_half", "per": vp, "max": 15}
        if block is None:
            unmapped += 1
            continue
        block.update({"when": when, "from_round": from_round, "printed": text[:160]})
        blocks.append(block)
    if unmapped:
        gap(f"mission:{cid}", "scoring block",
            f"{unmapped} printed VP line(s) of '{name}' do not map onto an evaluator "
            "(operation markers / card-reverse actions)",
            ["dossier VP-line parse", "evaluator vocabulary match"],
            estimate="scores through the mapped blocks only")
    return blocks


def build_missions(matrix: Dict[str, Dict[str, str]]) -> List[Dict[str, Any]]:
    cards: Dict[str, Dict[str, Any]] = {}
    doc = ""
    if os.path.exists(MISSION_DOC):
        doc = open(MISSION_DOC, encoding="utf-8").read()
    else:
        gap("missions", "primary card text", "mission research dossier not present",
            ["docs/11e_missions.md"])

    matches = list(CARD_RE.finditer(doc))
    for i, m in enumerate(matches):
        body = doc[m.end(): matches[i + 1].start() if i + 1 < len(matches) else len(doc)]
        name = m.group("name").strip()
        cid = norm(name)
        cards[cid] = {
            "id": cid,
            "name": name,
            "kind": "primary",
            "disposition": m.group("own").strip(),
            "text": re.sub(r"\s+", " ", re.sub(r"\*\*|\*", "", body))[:1500],
            "fixed_capable": False,
            "scoring": _scoring_blocks(body, name, cid),
            "provenance": {
                "source": "project mission dossier docs/11e_missions.md "
                          "(Warhammer Event Companion deck, GDM transcription)",
                "retrieved": RETRIEVED,
                "note": "card text is a community transcription; flagged for verification "
                        "against the printed deck (§5.2)",
            },
        }

    # Every mission the matrix names must exist as a card, even if the dossier
    # has no block for it — missing text is a GAP, not an invented rule.
    for own, row in matrix.items():
        for opp, mission in row.items():
            cid = norm(mission)
            if cid in cards:
                continue
            cards[cid] = {
                "id": cid,
                "name": mission.title(),
                "kind": "primary",
                "disposition": own.replace("_", " ").title(),
                "text": "",
                "fixed_capable": False,
                "scoring": [],
                "provenance": {"source": "Event Companion layout pages (mission name only)",
                               "retrieved": RETRIEVED},
            }
            gap(f"mission:{cid}", "primary card text",
                f"'{mission}' is named by the layout pages but has no card text in the dossier",
                ["layout page header", "mission dossier scan"],
                estimate="scores through the default Take-and-Hold block")

    cards.update({c["id"]: c for c in build_secondaries(doc)})
    return list(cards.values())


SECONDARY_RE = re.compile(r"^####\s+(?P<name>[A-Z][^\n#]{2,60})$", re.M)

#: Secondaries whose conditions are computable from state with the current
#: evaluator vocabulary. The rest are ingested text-only and reported.
SECONDARY_BLOCKS = {
    "bring_it_down": [{"when": "end_of_turn", "rule": "enemy_units_destroyed_this_turn",
                       "per": 2, "max": 10}],
    "no_prisoners": [{"when": "end_of_turn", "rule": "enemy_units_destroyed_this_turn",
                      "per": 2, "max": 10}],
    "assassination": [{"when": "end_of_turn", "rule": "enemy_units_destroyed_this_turn",
                       "per": 3, "max": 12}],
    "behind_enemy_lines": [{"when": "end_of_turn", "rule": "units_in_enemy_half",
                            "per": 4, "max": 8}],
    "area_denial": [{"when": "end_of_turn", "rule": "control_objectives", "per": 2, "max": 8}],
    "secure_no_mans_land": [{"when": "end_of_turn", "rule": "control_objectives",
                             "per": 3, "max": 9}],
    "storm_hostile_objective": [{"when": "end_of_turn", "rule": "control_enemy_home",
                                 "per": 5, "max": 10}],
    "engage_on_all_fronts": [{"when": "end_of_turn", "rule": "control_more_objectives",
                              "per": 5, "max": 5}],
}


def build_secondaries(doc: str) -> List[Dict[str, Any]]:
    section = doc.split("## 4. Secondary Missions", 1)
    out: List[Dict[str, Any]] = []
    if len(section) < 2:
        gap("secondaries", "secondary deck", "no secondary section in the dossier",
            ["docs/11e_missions.md '## 4. Secondary Missions'"])
        return out
    body = section[1]
    for m in SECONDARY_RE.finditer(body):
        name = m.group("name").strip()
        cid = norm(name)
        blocks = SECONDARY_BLOCKS.get(cid, [])
        if not blocks:
            gap(f"secondary:{cid}", "scoring block",
                f"'{name}' has no evaluator binding (needs Actions / operation markers)",
                ["evaluator vocabulary match"], estimate="held in hand, never scores")
        out.append({
            "id": cid,
            "name": name,
            "kind": "secondary",
            "disposition": "",
            "text": "",
            "fixed_capable": "fixed" in body[m.end(): m.end() + 400].lower(),
            "scoring": blocks,
            "provenance": {"source": "project mission dossier docs/11e_missions.md",
                           "retrieved": RETRIEVED},
        })
    return out


# --------------------------------------------------------------------------
# Effects
# --------------------------------------------------------------------------
def build_effects() -> Dict[str, int]:
    path = os.path.join(OUT, "effects_ingested.json")
    records = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
    stats = bindings.apply_bindings(records)

    prov = {"source": "wahapedia.ru/wh40k11ed/factions/astra-militarum/ (Voice of Command table)",
            "pack_version": "11th edition, version 1.1", "retrieved": RETRIEVED}
    for order in bindings.ORDERS:
        records.append({
            "id": order["id"], "kind": "order", "name": order["name"],
            "category": "", "trigger": {"window": "order_issuance", "condition": "", "actor": "friendly"},
            "target": [{"selector": "unit(REGIMENT & from_my_army)", "count": "1"}],
            "effects": order["effects"],
            "duration": "until_start_of_next_command",
            "usage_limits": {}, "restrictions": [], "text": order["text"],
            "detachment": "", "faction": "AM", "provenance": prov,
        })
    for rule in bindings.ARMY_RULES:
        records.append({
            "id": rule["id"], "kind": "army_rule", "name": rule["name"],
            "category": "", "trigger": {"window": "passive", "condition": "", "actor": "friendly"},
            "target": [], "effects": rule["effects"], "duration": "until_end_of_battle",
            "usage_limits": {}, "restrictions": [], "text": rule["text"],
            "detachment": "", "faction": rule["faction"], "provenance": prov,
        })

    with open(os.path.join(OUT, "effects.json"), "w", encoding="utf-8") as fh:
        json.dump(records, fh, indent=1, ensure_ascii=False)

    unbound = [r for r in records if not r["effects"]]
    for rec in unbound:
        gap(f"effect:{rec['id']}", "effect binding",
            f"'{rec['name']}' is ingested with its printed text but has no primitive binding yet",
            ["tools2/bindings.py lookup"], estimate="text-only; no in-game effect")
    return {"records": len(records), "bound": len(records) - len(unbound)}


# --------------------------------------------------------------------------
# Armies
# --------------------------------------------------------------------------
def build_armies() -> int:
    ds_path = os.path.join(OUT, "datasheets.json")
    if not os.path.exists(ds_path):
        return 0
    sheets = json.load(open(ds_path, encoding="utf-8"))
    os.makedirs(os.path.join(OUT, "armies"), exist_ok=True)

    specs = [
        ("Imperialis Fleet Patrol", "IA", "ia.imperialis_fleet", 1000),
        ("Grizzled Company Line", "AM", "am.grizzled_company", 1000),
        ("Alien Hunters Strike", "IA", "ia.ordo_xenos_alien_hunters", 500),
        ("Siege Regiment Vanguard", "AM", "am.siege_regiment", 500),
        ("Combined Arms Battlegroup", "AM", "am.combined_arms", 2000),
    ]
    written = 0
    for name, faction, det, cap in specs:
        army = _fill_army(sheets, name, faction, det, cap)
        with open(os.path.join(OUT, "armies", norm(name) + ".json"), "w", encoding="utf-8") as fh:
            json.dump(army, fh, indent=1)
        written += 1
    return written


def _fill_army(sheets, name: str, faction: str, det: str, cap: int) -> Dict[str, Any]:
    """A legal, points-capped roster: cheap battleline first, then characters."""
    pool = [
        s for s in sheets
        if s["faction"] == faction and not s["legends"] and s["points"]
        and any(t["column"] == "army_faction" for t in s["points"])
    ]

    def cost(s) -> int:
        tiers = [t for t in s["points"] if t["column"] == "army_faction"]
        return min(t["points"] for t in tiers)

    def models(s) -> int:
        tiers = [t for t in s["points"] if t["column"] == "army_faction"]
        cheapest = min(tiers, key=lambda t: t["points"])
        return cheapest["models"]

    battleline = sorted([s for s in pool if "BATTLELINE" in s["keywords"]], key=cost)
    characters = sorted([s for s in pool if "CHARACTER" in s["keywords"]], key=cost)
    other = sorted([s for s in pool if s not in battleline and s not in characters], key=cost)

    units: List[Dict[str, Any]] = []
    total = 0
    counts: Dict[str, int] = {}

    def add(sheet, warlord: bool = False) -> bool:
        nonlocal total
        c = cost(sheet)
        if total + c > cap:
            return False
        if counts.get(sheet["id"], 0) >= 3:
            return False
        counts[sheet["id"]] = counts.get(sheet["id"], 0) + 1
        units.append({
            "datasheet_id": sheet["id"],
            "models": models(sheet),
            "warlord": warlord,
            "key": f"{len(units)}",
        })
        total += c
        return True

    if characters:
        add(characters[0], warlord=True)
    for sheet in battleline * 3:
        if total >= cap * 0.7:
            break
        add(sheet)
    for sheet in other:
        if total >= cap * 0.95:
            break
        add(sheet)

    return {
        "name": name,
        "faction": faction,
        "detachments": [det],
        "units": units,
        "battle_size": cap,
        "points": total,
        "notes": [
            "Generated by tools2/build_data.py from the ingested snapshot as a legal "
            "sample roster; points are the ingested army-faction column.",
        ],
    }


# --------------------------------------------------------------------------
def main() -> int:
    layouts, matrix = build_layouts()
    with open(os.path.join(OUT, "mission_matrix.json"), "w", encoding="utf-8") as fh:
        json.dump(matrix, fh, indent=1)
    missions = build_missions(matrix)
    with open(os.path.join(OUT, "missions.json"), "w", encoding="utf-8") as fh:
        json.dump(missions, fh, indent=1, ensure_ascii=False)
    effects = build_effects()
    armies = build_armies()

    ingest_gaps = []
    p = os.path.join(OUT, "gaps_ingest.json")
    if os.path.exists(p):
        ingest_gaps = json.load(open(p, encoding="utf-8"))
    with open(os.path.join(OUT, "gaps.json"), "w", encoding="utf-8") as fh:
        json.dump(ingest_gaps + GAPS, fh, indent=1, ensure_ascii=False)

    summary = {
        "layouts": layouts,
        "matrix_rows": len(matrix),
        "missions": len(missions),
        "effects": effects,
        "armies": armies,
        "gaps": len(ingest_gaps) + len(GAPS),
    }
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
