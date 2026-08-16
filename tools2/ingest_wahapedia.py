"""Wahapedia ``wh40k11ed`` -> ``data2/`` snapshot ingester (§6).

Run::

    python3 tools2/ingest_wahapedia.py --raw <dir-of-fetched-html> --out data2

Discipline enforced here (§6.1, mandate 3):

* Provenance (pack version + retrieval date) on every record.
* Transcribe, never reconstruct: a value the page does not carry becomes a
  ``GAP`` entry in ``data2/gaps.json``.
* Boarding Actions content is filtered out (trap §6.7) — only blocks whose
  expansion logo says "Faction Pack" are ingested.
* Every weapon row appears twice (collapsed header, then the real profile);
  only rows carrying a full six-cell profile are taken (trap §6.4).
* Legends datasheets are flagged, not dropped, so the optimizer can exclude
  them while the replayer can still render one.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import html
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sim2.geometry import BaseShape
from sim2.schema import (
    Datasheet,
    Detachment,
    EffectRecord,
    EffectPrimitive,
    GapRecord,
    ModelProfile,
    PointsTier,
    Provenance,
    TargetSpec,
    WeaponProfile,
)

RETRIEVED = dt.date.today().isoformat()
SOURCE = "wahapedia.ru/wh40k11ed"
FACTION_CODE = {"imperial-agents": "IA", "astra-militarum": "AM"}
CORE = "CORE"

GAPS: List[GapRecord] = []


def gap(gid: str, what: str, why: str, attempted: List[str], estimate: str = "", basis: str = "") -> None:
    GAPS.append(GapRecord(id=gid, what=what, why=why, attempted=attempted,
                          estimate=estimate or None, basis=basis or None))


# --------------------------------------------------------------------------
# html helpers
# --------------------------------------------------------------------------
def text_of(fragment: str) -> str:
    s = re.sub(r"<br\s*/?>", " ", fragment)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def blocks(src: str, start_pat: str, end_pat: str) -> List[str]:
    out = []
    for m in re.finditer(start_pat, src):
        end = re.search(end_pat, src[m.end():])
        out.append(src[m.start(): m.end() + (end.start() if end else 4000)])
    return out


# --------------------------------------------------------------------------
# datasheet parsing
# --------------------------------------------------------------------------
def parse_datasheet(path: str, slug: str) -> Optional[Datasheet]:
    raw = open(path, encoding="utf-8", errors="replace").read()
    faction = FACTION_CODE[slug]

    frames = [m.start() for m in re.finditer(r'<div class="dsOuterFrame datasheet', raw)]
    if not frames:
        return None
    start = frames[0]
    # The datasheet ends at its KEYWORDS block; everything after is the page's
    # cross-reference boilerplate (core-rules glossary, other detachments'
    # content, Boarding Actions adaptations). Bounding here is what keeps the
    # glossary's M/WS/BS/A tables out of the model profiles.
    kw = raw.find('ds2colKW', start)
    end = frames[1] if len(frames) > 1 else len(raw)
    if kw > 0:
        end = min(end, kw + 6000)
    block = raw[start:end]

    # trap 6.7: only matched-play Faction Pack content
    logo = re.search(r'class="tooltip logo3" title="([^"]+)"', block)
    pack_version = ""
    if logo:
        title = logo.group(1)
        if "Boarding Actions" in title:
            return None
        mv = re.search(r"\(([^)]*edition[^)]*)\)", title)
        pack_version = mv.group(1) if mv else title
    if not pack_version:
        pack_version = "11th edition, version unknown"
        gap(f"ds:{slug}:{os.path.basename(path)}", "pack version",
            "expansion logo missing on the datasheet block", ["logo3 title attribute"])

    name_m = re.search(r'<div class="dsH2Header"><div>([^<]+)</div>', block)
    name = html.unescape(name_m.group(1)).strip() if name_m else os.path.basename(path)

    legends = bool(re.search(r'logo3[^>]*title="[^"]*Legends', block)) or "Legends" in (
        logo.group(1) if logo else ""
    )

    models = parse_profiles(block, name)
    weapons = parse_weapons(block)
    keywords = parse_keywords(block)
    points, priced_wargear = parse_points(block)
    abilities = parse_abilities(block)
    inv_note = parse_invuln_note(block)
    if inv_note:
        abilities["Invulnerable Save note"] = inv_note
    unit_sizes = sorted({t.models for t in points}) or [1]
    transport_cap, transport_text = parse_transport(block)
    if transport_cap and " or " in transport_text.split(".")[0]:
        # e.g. "capacity of 1 TAUROS model or 2 ASTRA MILITARUM WALKER models":
        # the first figure is taken and the alternative is kept as text.
        gap(f"ds:{faction.lower()}.{slug_id(name)}:transport", "conditional transport capacity",
            "capacity depends on which models are carried; only the first figure is structured",
            ["transport section parse"], estimate=str(transport_cap),
            basis="first printed capacity; full wording preserved in transport_text")

    ds_id = f"{faction.lower()}.{slug_id(name)}"
    for item, cost in priced_wargear:
        gap(f"ds:{ds_id}:wargear_cost:{slug_id(item)}", "priced wargear option",
            "the 11e pack prices this wargear option per model; the schema has no wargear-cost "
            "slot, so unit points exclude it",
            ["WARGEAR OPTIONS rows of the unit cost table"],
            estimate=str(cost), basis=f"printed price per {item}")
    if not models:
        gap(f"ds:{ds_id}", "model profile", "no characteristic block parsed",
            ["dsCharName/dsCharValue scan"])
        return None
    if not points:
        gap(f"ds:{ds_id}", "points", "no YOUR UNIT COSTS table on the page",
            ["dsUnitCostHeader table"], basis="MFM reconciliation pending (Phase D2)")

    return Datasheet(
        id=ds_id,
        name=name,
        faction=faction,
        role="",
        models=models,
        weapons=weapons,
        keywords=keywords,
        ability_ids=[],
        ability_text=abilities,
        unit_sizes=unit_sizes,
        points=points,
        transport_capacity=transport_cap,
        transport_text=transport_text,
        legends=legends,
        provenance=Provenance(source=f"{SOURCE}/factions/{slug}/{os.path.basename(path)}",
                              pack_version=pack_version, retrieved=RETRIEVED),
    )


def slug_id(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def parse_profiles(block: str, unit_name: str) -> List[ModelProfile]:
    """Statlines: each profile is a run of dsCharName/dsCharValue pairs."""
    # The profile block runs from dsProfileBaseWrap to the first weapons table
    # or ability header; the characteristic glossary further down the page uses
    # the same class names, so bounding it matters.
    pstart = block.find('dsProfileBaseWrap')
    profile_region = block[pstart:] if pstart >= 0 else block
    for stop in ('wTable', 'dsHeader', 'dsAbility'):
        cut = profile_region.find(stop)
        if cut > 0:
            profile_region = profile_region[:cut]
    pairs = re.findall(
        r'<div class="dsCharName">([A-Z]+)</div>.*?<div class="dsCharValue[^"]*">([^<]*)</div>',
        profile_region, re.S,
    )
    if not pairs:
        return []
    base = parse_base(block)
    inv = parse_invuln(block)

    profiles: List[ModelProfile] = []
    current: Dict[str, str] = {}
    names = _profile_names(block, unit_name)
    for key, value in pairs:
        if key in current:
            profiles.append(_mk_profile(current, base, inv, names, len(profiles), unit_name))
            current = {}
        current[key] = value.strip()
    if current:
        profiles.append(_mk_profile(current, base, inv, names, len(profiles), unit_name))
    return [p for p in profiles if p is not None]


def parse_invuln(block: str) -> Optional[int]:
    """The invulnerable save is its own markup block, not prose.

    Wahapedia renders it as ``dsInvulWrap`` containing a ``dsCharInvulValue``
    of e.g. "4+". Searching the block text for the words "INVULNERABLE SAVE"
    (the obvious approach) matches almost nothing — it captured the value on
    1 of 179 datasheets.
    """
    m = re.search(r'dsCharInvulValue[^>]*>\s*(\d)\+', block)
    return int(m.group(1)) if m else None


def parse_invuln_note(block: str) -> str:
    """Footnotes that exclude specific models from the invulnerable save
    (trap §6.9, e.g. cyber-mastiffs) are transcribed verbatim."""
    m = re.search(r'dsInvul(?:Comment|Text2|Note)[^>]*>(.*?)</div>', block, re.S)
    return text_of(m.group(1)) if m else ""


def _profile_names(block: str, unit_name: str) -> List[str]:
    return re.findall(r'<div class="dsProfileName[^"]*">([^<]+)</div>', block) or [unit_name]


def _mk_profile(vals: Dict[str, str], base: BaseShape, inv, names, idx: int, unit_name: str):
    def num(key: str, default: float) -> float:
        v = vals.get(key, "")
        m = re.search(r"-?\d+", v)
        return float(m.group(0)) if m else default

    if "M" not in vals and "T" not in vals:
        return None
    name = names[idx] if idx < len(names) else unit_name
    return ModelProfile(
        name=name,
        m=num("M", 6),
        t=int(num("T", 4)),
        sv=int(num("SV", 4)),
        w=int(num("W", 1)),
        ld=int(num("LD", 7)),
        oc=int(num("OC", 1)),
        invuln=inv,
        base=base,
        height=2.0,
    )


def parse_base(block: str) -> BaseShape:
    """Base Size Guide values are printed on the datasheet header."""
    m = re.search(r'ShowBaseSize">\(([^)]*)\)</span>', block)
    if not m:
        return BaseShape.circle_mm(32)
    txt = html.unescape(m.group(1))
    oval = re.search(r"(\d+)\s*[x×]\s*(\d+)\s*mm", txt)
    if oval:
        return BaseShape.oval_mm(float(oval.group(1)), float(oval.group(2)))
    circ = re.search(r"(\d+)\s*mm", txt)
    if circ:
        return BaseShape.circle_mm(float(circ.group(1)))
    if "hull" in txt.lower() or "model" in txt.lower():
        # "Hull" entries: footprint must be measured per model (§3.8, gap #2).
        return BaseShape("hull", rx=2.0, ry=3.5)
    return BaseShape.circle_mm(32)


WEAPON_ROW = re.compile(
    r'<td class="wTable2_short[^"]*"[^>]*>(?P<name>.*?)</td>'
    r'(?P<cells>(?:\s*<td>\s*<div class="ct[^"]*">[^<]*</div>\s*</td>\s*){6})',
    re.S,
)
CELL = re.compile(r'<div class="ct[^"]*">([^<]*)</div>')


def parse_weapons(block: str) -> List[WeaponProfile]:
    """Trap §6.4: take the profile row, not the collapsed header row."""
    out: List[WeaponProfile] = []
    for m in WEAPON_ROW.finditer(block):
        raw_name = m.group("name")
        cells = [html.unescape(c).strip() for c in CELL.findall(m.group("cells"))]
        if len(cells) != 6:
            continue
        head, _, tail = raw_name.partition('<span class="kwbw')
        name = text_of(head)
        joined = _join_abilities(tail)
        rng, attacks, skill, strength, ap, damage = cells
        is_melee = rng.strip().lower().startswith("melee")
        out.append(WeaponProfile(
            name=name,
            kind="melee" if is_melee else "ranged",
            attacks=attacks or "1",
            skill=_plus(skill),
            strength=_int(strength),
            ap=_int(ap),
            damage=damage or "1",
            range_in=0.0 if is_melee else _inches(rng),
            abilities=joined,
            profile_of=name.split(" – ")[0] if " – " in name else "",
        ))
    return out


def _join_abilities(fragment: str) -> List[str]:
    """Wahapedia splits each weapon keyword into one span PER WORD; the words
    of one keyword share an enclosing ``kwbw`` span, so split on that."""
    out = []
    for chunk in fragment.split('<span class="kwbw'):
        words = re.findall(r'class="ttw kwbu">([^<]+)</span>', chunk)
        if words:
            out.append(" ".join(w.strip() for w in words).upper())
    return out


def _strip_abilities(name: str, abilities: List[str]) -> str:
    for a in abilities:
        name = re.sub(re.escape(a), "", name, flags=re.I)
    return re.sub(r"\s+", " ", name).strip(" ,;")


def _plus(v: str) -> int:
    m = re.search(r"(\d+)", v)
    return int(m.group(1)) if m else 4


def _int(v: str) -> int:
    m = re.search(r"-?\d+", v)
    return int(m.group(0)) if m else 0


def _inches(v: str) -> float:
    m = re.search(r"(\d+)", v)
    return float(m.group(1)) if m else 0.0


def parse_keywords(block: str) -> List[str]:
    out: List[str] = []
    for label in ("dsLeftСolKW", "dsLeftColKW", "dsRightСolKW", "dsRightColKW"):
        for seg in re.findall(rf'<div class="{label}">(.*?)</div>\s*(?:<div|$)', block, re.S):
            out.extend(_kw_group(seg))
    if not out:
        seg = re.search(r"KEYWORDS:(.*?)</div>", block, re.S)
        if seg:
            out.extend(_kw_group(seg.group(1)))
    seen, uniq = set(), []
    for k in out:
        if k not in seen:
            seen.add(k)
            uniq.append(k)
    return uniq


def _kw_group(seg: str) -> List[str]:
    words: List[str] = []
    for grp in re.findall(r'<span class="tooltip[^"]*"[^>]*>(.*?)</span>\s*(?=;|<|$)', seg, re.S):
        parts = re.findall(r'class="kwb kwbu">([^<]+)</span>', grp)
        if parts:
            words.append(" ".join(p.strip() for p in parts).upper())
    if not words:
        txt = text_of(seg).replace("KEYWORDS:", "").replace("FACTION KEYWORDS:", "")
        words = [w.strip().upper() for w in txt.split(";") if w.strip()]
    return words


def parse_points(block: str) -> Tuple[List[PointsTier], List[Tuple[str, int]]]:
    """Trap §6.5 (dual columns) and §6.6 (per-copy escalation).

    Agents datasheets print TWO cost tables — the AGENTS OF THE IMPERIUM Army
    Faction price and the Assigned Agent ally price — and some AM datasheets
    price later copies higher ("YOUR 1ST TO 2ND UNITS COST" / "YOUR 3RD +
    UNIT COSTS"). Both facts live in header rows, so the table is walked in
    order, carrying the current column and copy range. Prices sit inside
    tooltip spans, so each cell is read as text rather than as a raw number.

    Two header forms found the hard way (2026-08-16, the first ingest run
    captured them wrong):

    * "YOUR 1ST UNIT COSTS" (no TO, no +) bounds the range to exactly that
      copy — reading it as 1..99 made a 2nd Basilisk cost the 1st-copy price.
    * "WARGEAR OPTIONS" starts a priced-wargear section ("per Demolisher
      battle cannon | 15") whose rows are NOT unit tiers — reading them as
      tiers gave five sheets a phantom 5–15 pt tier. The rows are returned
      separately as (item, cost) pairs so the caller can gap-log them
      (priced wargear has no schema slot yet).
    """
    out: List[PointsTier] = []
    wargear: List[Tuple[str, int]] = []
    for table in re.findall(r'dsUnitCostHeader.*?</table>', block, re.S):
        column = "army_faction"
        copy_from, copy_to = 1, 99
        in_wargear = False
        for row in re.findall(r"<tr>(.*?)</tr>", "<tr>" + table, re.S):
            if "dsUnitCostHeader" in row:
                header = text_of(row).upper()
                if "WARGEAR OPTIONS" in header:
                    in_wargear = True
                    continue
                in_wargear = False
                if "ASSIGNED AGENT" in header:
                    column = "assigned_agent"
                elif "DETACHMENT" in header:
                    column = "army_faction"
                span = re.search(r"YOUR (\d+)(?:ST|ND|RD|TH) TO (\d+)(?:ST|ND|RD|TH)", header)
                nth_plus = re.search(r"YOUR (\d+)(?:ST|ND|RD|TH)\s*\+", header)
                nth_only = re.search(r"YOUR (\d+)(?:ST|ND|RD|TH) UNITS? COSTS?", header)
                if span:
                    copy_from, copy_to = int(span.group(1)), int(span.group(2))
                elif nth_plus:
                    copy_from, copy_to = int(nth_plus.group(1)), 99
                elif nth_only:
                    copy_from = copy_to = int(nth_only.group(1))
                elif "YOUR UNIT COSTS" in header:
                    copy_from, copy_to = 1, 99
                continue
            cell = re.search(r"<td>([^<]*)</td>\s*<td><div class=\"PriceTag\">(.*?)</div>", row, re.S)
            if not cell:
                continue
            label, price_html = cell.group(1), cell.group(2)
            m_price = re.search(r"\d+", text_of(price_html))
            if not m_price:
                continue
            if in_wargear:
                item = re.sub(r"^per\s+", "", html.unescape(label).strip(), flags=re.I)
                pair = (item, int(m_price.group(0)))
                if pair not in wargear:  # both Agents columns print the same row
                    wargear.append(pair)
                continue
            models_m = re.search(r"(\d+)\s*model", label, re.I)
            out.append(PointsTier(
                models=int(models_m.group(1)) if models_m else 1,
                points=int(m_price.group(0)),
                copy_from=copy_from,
                copy_to=copy_to,
                column=column,
            ))
    return out, wargear


#: Ability lines the datasheet prints as one comma-separated run.
ABILITY_GROUP_RE = re.compile(
    r'<div class="dsAbility">(CORE|FACTION):\s*<b>(?P<body>.*?)</b>\s*</div>', re.S
)


def parse_ability_group(block: str, label: str) -> List[str]:
    """"CORE: Deep Strike, Fights First, Infiltrators" -> three abilities.

    Each ability is a tooltip span whose words are split one span per word
    (the same trap as weapon keywords, §6.4), so the words are rejoined per
    span and the run is split on the commas BETWEEN spans. Parameters ride
    along with the name: "Scouts 6\"", "Deadly Demise D3", "Firing Deck 2".
    """
    out: List[str] = []
    for m in ABILITY_GROUP_RE.finditer(block):
        if m.group(1) != label:
            continue
        for chunk in re.split(r"</span>\s*,", m.group("body")):
            words = re.findall(r'class="tt kwbu">([^<]+)</span>', chunk)
            if words:
                out.append(" ".join(w.strip() for w in words))
    return out


def parse_abilities(block: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    # Core and faction abilities first: the engine reads these by NAME to grant
    # Deep Strike, Leader, Infiltrators, Scouts, Stealth, Feel No Pain and the
    # rest, so each needs its own entry rather than one "CORE" blob.
    for label in ("CORE", "FACTION"):
        names = parse_ability_group(block, label)
        if names:
            out[label] = ", ".join(names)
            for name in names:
                out.setdefault(name, f"{label.title()} ability (see the core rules).")
    for seg in re.findall(r'<div class="dsAbility">(.*?)</div>\s*(?=<div|$)', block, re.S):
        txt = text_of(seg)
        m = re.match(r"([A-Z][A-Za-z’'\- ]{2,40}):\s*(.+)", txt)
        if m:
            out[m.group(1).strip()] = m.group(2).strip()
    for m in re.finditer(r'<b>([^<]{3,60})</b>\s*[:.]?\s*([^<]{10,600})', block):
        key = html.unescape(m.group(1)).strip().rstrip(":")
        val = html.unescape(m.group(2)).strip()
        if key.isupper() or key.istitle():
            out.setdefault(key, val)
    return out


def parse_transport(block: str) -> Tuple[int, str]:
    """Capacity is printed under a TRANSPORT section header.

    The naive search for the word "TRANSPORT" anywhere in the block matches a
    keyword tooltip long before it reaches the section, which is why capacity
    parsed as 0 on every datasheet. The exclusions ("It cannot transport
    ARTILLERY models") and the space-multipliers ("Each OGRYN model takes up
    the space of 3 models") are kept as text for later binding.
    """
    m = re.search(
        r'<div class="dsHeader[^"]*">\s*TRANSPORT\s*</div>\s*'
        r'<div class="dsAbility">(.*?)</div>', block, re.S,
    )
    if not m:
        return 0, ""
    txt = text_of(m.group(1))
    cap = re.search(r"transport capacity of (\d+)", txt, re.I)
    if not cap:
        cap = re.search(r"can transport up to (\d+)", txt, re.I)
    return (int(cap.group(1)) if cap else 0), txt[:600]


# --------------------------------------------------------------------------
# faction page: detachments, stratagems, enhancements, rules
# --------------------------------------------------------------------------
def parse_faction(path: str, slug: str) -> Tuple[List[Detachment], List[EffectRecord]]:
    raw = open(path, encoding="utf-8", errors="replace").read()
    faction = FACTION_CODE[slug]
    pack = _faction_pack_version(raw, faction)

    detachments: List[Detachment] = []
    for m in re.finditer(
        r'data-det-name="([^"]+)"\s+data-dp-base="(\d+)">.*?title="Force Disposition: ([^"]+)"',
        raw, re.S,
    ):
        name, dp, disposition = m.group(1), int(m.group(2)), m.group(3)
        detachments.append(Detachment(
            id=f"{faction.lower()}.{slug_id(name)}",
            name=name,
            faction=faction,
            disposition=disposition,
            dp=dp,
            provenance=Provenance(source=f"{SOURCE}/factions/{slug}/", pack_version=pack,
                                  retrieved=RETRIEVED),
        ))
    # Boarding Actions detachments carry no Force Disposition and are excluded
    # by construction (the regex requires one) — trap §6.7.

    records = parse_faction_records(raw, faction, slug, pack, detachments)
    _attach_exclusion_tags(raw, detachments)
    return detachments, records


def _faction_pack_version(raw: str, faction: str) -> str:
    m = re.search(r'title="Faction Pack\.[^"]*\(([^)]*)\)"', raw)
    if m:
        return m.group(1)
    gap(f"faction:{faction}", "faction pack version", "no expansion logo title on the faction page",
        ["logo3 title attribute"])
    return "11th edition, version unknown"


def _attach_exclusion_tags(raw: str, detachments: List[Detachment]) -> None:
    text = text_of(raw)
    for det in detachments:
        idx = text.find(det.name)
        if idx < 0:
            continue
        window = text[idx: idx + 600].upper()
        for tag in ("RECON", "ABHUMAN"):
            if f"ANOTHER {tag}" in window or f"{tag} DETACHMENT" in window:
                if tag not in det.exclusion_tags:
                    det.exclusion_tags.append(tag)


STRAT_BLOCK = re.compile(r'<div class="\s*str11Wrap[^"]*">(.*?)(?=<div class="\s*str11Wrap|<h2|<h1|$)', re.S)
ENH_BLOCK = re.compile(
    r'<ul class="EnhancementsPts"><li><span>(?P<name>[^<]+)</span>\s*<span>(?P<pts>\d+)\s*pts</span></li></ul>'
    r'(?P<body>.*?)(?=<ul class="EnhancementsPts"|</table>|$)', re.S,
)
FIELD_RE = re.compile(r'<b>(WHEN|TARGET|EFFECT|RESTRICTIONS)\s*:?\s*</b>\s*(.*?)(?=<b>(?:WHEN|TARGET|EFFECT|RESTRICTIONS)|$)', re.S)


def parse_faction_records(
    raw: str, faction: str, slug: str, pack: str, detachments: List[Detachment]
) -> List[EffectRecord]:
    """Stratagems, enhancements and detachment rules, transcribed verbatim.

    11th edition stratagem cards carry structured WHEN / TARGET / EFFECT /
    RESTRICTIONS fields; those map onto the effect schema's trigger window,
    target selector and restriction clauses, and the printed text is kept
    alongside the parsed form for audit (mandate 3).
    """
    prov = Provenance(source=f"{SOURCE}/factions/{slug}/", pack_version=pack, retrieved=RETRIEVED)
    by_name = {d.name.lower(): d for d in detachments}
    out: List[EffectRecord] = []

    # -- Stratagems: the card's type line names its detachment -------------
    for m in STRAT_BLOCK.finditer(raw):
        seg = m.group(1)
        name_m = re.search(r'class="[^"]*str11Name[^"]*"[^>]*>(.*?)</div>', seg, re.S)
        if not name_m:
            continue
        name = text_of(name_m.group(1))
        rule_no = ""
        num_m = re.search(r"(\d{2}\.\d{2})$", name)
        if num_m:
            rule_no = num_m.group(1)
            name = name[: num_m.start()].strip()
        cp_m = re.search(r'class="str11CP">\s*(\d+)\s*CP', seg)
        type_m = re.search(r'class="[^"]*str11Type[^"]*"[^>]*>(.*?)</div>', seg, re.S)
        type_line = text_of(type_m.group(1)) if type_m else ""
        # Section-15 cards are Stratagems even when their type line prints a
        # shooting type instead (Snap Shooting 15.09).
        if not type_line.endswith("Stratagem") and not rule_no.startswith("15."):
            # Core-rules reference cards (e.g. "NORMAL MOVE 09.05") share the
            # stratagem card markup; they are rules text, not Stratagems.
            continue
        # Two printed forms: "<Detachment> – <Category> Stratagem" and, for the
        # 1-DP detachments and the core cards, plain "<Detachment> Stratagem".
        if "–" in type_line:
            det_name, _, category = type_line.partition("–")
        else:
            det_name, category = type_line[: -len("Stratagem")].strip(), ""
        is_core = det_name.strip().lower() == "core"
        det = None if is_core else _match_detachment(det_name, by_name)
        if det is None and not is_core:
            # Boarding Actions detachments have no Force Disposition and so were
            # never ingested — their stratagems are dropped here (trap §6.7).
            continue
        text_m = re.search(r'class="str11Text">(.*?)</div>', seg, re.S)
        body = text_m.group(1) if text_m else ""
        fields = {k.lower(): text_of(v) for k, v in
                  ((f.group(1), f.group(2)) for f in FIELD_RE.finditer(body))}
        printed = text_of(body)
        rid = (f"core.{slug_id(name)}" if is_core
               else f"{faction.lower()}.{slug_id(det.name)}.{slug_id(name)}")
        out.append(EffectRecord(
            id=rid,
            kind="stratagem",
            name=name,
            cost_cp=int(cp_m.group(1)) if cp_m else 0,
            category=category.replace("Stratagem", "").strip(),
            trigger_window=_infer_window(fields.get("when", printed)),
            trigger_condition="",
            trigger_actor="friendly",
            targets=[TargetSpec(_target_selector(fields.get("target", "")))],
            effects=[],       # bound in tools2/bind_effects.py where expressible
            duration=_infer_duration(fields.get("effect", printed)),
            restrictions=([fields["restrictions"]] if fields.get("restrictions") else [])
            + _restriction_clauses(fields.get("target", "")),
            text=printed[:2000],
            detachment=det.id if det else "",
            faction="" if is_core else faction,
            provenance=Provenance(source=prov.source, pack_version=prov.pack_version,
                                  retrieved=prov.retrieved,
                                  note=f"core rules {rule_no}" if rule_no else ""),
        ))

    # -- Enhancements: attributed by the detachment section they sit in ----
    sections = _detachment_sections(raw, detachments)
    for det, seg in sections:
        for m in ENH_BLOCK.finditer(seg):
            name = text_of(m.group("name"))
            body = text_of(m.group("body"))
            out.append(EffectRecord(
                id=f"{faction.lower()}.{slug_id(det.name)}.enh_{slug_id(name)}",
                kind="enhancement",
                name=name,
                cost_points=int(m.group("pts")),
                targets=[TargetSpec(_enh_selector(body))],
                effects=[],
                duration="until_end_of_battle",
                restrictions=_restriction_clauses(body),
                text=body[:1500],
                detachment=det.id,
                faction=faction,
                provenance=prov,
            ))
        rule = _detachment_rule(seg, det, faction, prov)
        if rule is not None:
            out.append(rule)
            det.rule_ids.append(rule.id)
    return out


def _match_detachment(printed: str, by_name: Dict[str, Detachment]) -> Optional[Detachment]:
    """Stratagem cards print the SHORT detachment name ("Alien Hunters"),
    the detachment list prints the full one ("Ordo Xenos Alien Hunters")."""
    key = printed.strip().lower()
    if not key:
        return None
    if key in by_name:
        return by_name[key]
    for name, det in by_name.items():
        if name.endswith(key) or key.endswith(name) or key in name:
            return det
    return None


def _detachment_sections(raw: str, detachments: List[Detachment]) -> List[Tuple[Detachment, str]]:
    """Split the faction page into one segment per detachment."""
    marks: List[Tuple[int, Detachment]] = []
    for det in detachments:
        anchor = re.escape(det.name.replace(" ", "-"))
        m = re.search(rf'<a name="{anchor}"></a>', raw)
        if m:
            marks.append((m.end(), det))
    marks.sort()
    out = []
    for i, (pos, det) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(raw)
        out.append((det, raw[pos:end]))
    return out


def _detachment_rule(seg: str, det: Detachment, faction: str, prov: Provenance):
    m = re.search(r'<h2[^>]*id="Detachment-Rule[^"]*"[^>]*>.*?</h2>(.*?)(?=<h2|$)', seg, re.S)
    if not m:
        return None
    body = text_of(m.group(1))
    if not body:
        return None
    name_m = re.search(r'<h3[^>]*>(.*?)</h3>', m.group(1), re.S)
    return EffectRecord(
        id=f"{faction.lower()}.{slug_id(det.name)}.rule",
        kind="detachment_rule",
        name=text_of(name_m.group(1)) if name_m else f"{det.name} Detachment Rule",
        trigger_window="passive",
        effects=[],
        duration="until_end_of_battle",
        text=body[:2000],
        detachment=det.id,
        faction=faction,
        provenance=prov,
    )


def _target_selector(target_text: str) -> str:
    """A conservative selector from the card's TARGET line.

    Keyword restrictions that are printed in caps are transcribed; anything
    subtler stays in ``restrictions`` verbatim and is enforced at binding time
    rather than guessed at here.
    """
    kws = re.findall(r"\b([A-Z][A-Z' ]{2,})\b", target_text or "")
    kws = [k.strip() for k in kws if len(k.strip()) > 2][:3]
    if not kws:
        return "unit(from_my_army)"
    expr = " & ".join(k.replace(" ", "_") if " " in k else k for k in kws[:1])
    return f"unit({expr} & from_my_army)"


def _enh_selector(body: str) -> str:
    m = re.match(r"([A-Z][A-Z' ]+) model only", body or "")
    if m:
        kw = m.group(1).strip().split()[-1]
        return f"model({kw} & from_my_army)"
    return "model(CHARACTER & from_my_army)"


def _owning_detachment(raw: str, pos: int, detachments: List[Detachment]) -> Optional[Detachment]:
    """The detachment heading most recently above this record."""
    best = None
    best_at = -1
    for det in detachments:
        for m in re.finditer(re.escape(det.name), raw[:pos]):
            if m.start() > best_at:
                best_at, best = m.start(), det
    return best


def _strat_category(text: str) -> str:
    for cat in ("Battle Tactic", "Strategic Ploy", "Epic Deed", "Wargear"):
        if cat.upper() in text.upper():
            return cat
    return ""


def _infer_window(text: str) -> str:
    t = text.lower()
    table = [
        ("your shooting phase", "own_shooting"),
        ("your movement phase", "own_movement"),
        ("your charge phase", "own_charge"),
        ("your command phase", "own_command"),
        ("fight phase", "fight"),
        ("opponent's shooting phase", "opponent_shooting"),
        ("opponent's movement phase", "opponent_movement"),
        ("opponent's charge phase", "opponent_charge"),
        ("opponent's command phase", "opponent_command"),
        ("shooting phase", "shooting"),
        ("movement phase", "movement"),
        ("charge phase", "charge"),
        ("command phase", "command"),
    ]
    for needle, window in table:
        if needle in t:
            return window
    return "any"


def _infer_duration(text: str) -> str:
    t = text.lower()
    if "until the end of the battle" in t:
        return "until_end_of_battle"
    if "until the end of the turn" in t:
        return "until_end_of_turn"
    if "until the start of your next" in t:
        return "until_start_of_next_command"
    return "until_end_of_phase"


def _restriction_clauses(text: str) -> List[str]:
    out = []
    for sent in re.split(r"(?<=[.!])\s+", text):
        low = sent.lower()
        if "cannot" in low or "only" in low or "you cannot select" in low:
            out.append(sent.strip())
    return out[:6]


# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", default="data2")
    args = ap.parse_args()

    datasheets: List[Datasheet] = []
    detachments: List[Detachment] = []
    effects: List[EffectRecord] = []

    core_path = os.path.join(args.raw, "core-rules.html")
    if os.path.exists(core_path):
        raw_core = open(core_path, encoding="utf-8", errors="replace").read()
        effects.extend(parse_faction_records(raw_core, "CORE", "the-rules/core-rules", "11th edition (June 2026)", []))

    for slug in FACTION_CODE:
        fpath = os.path.join(args.raw, f"faction-{slug}.html")
        if os.path.exists(fpath):
            dets, recs = parse_faction(fpath, slug)
            detachments.extend(dets)
            effects.extend(recs)
        for path in sorted(glob.glob(os.path.join(args.raw, f"ds-{slug}-*.html"))):
            ds = parse_datasheet(path, slug)
            if ds is not None:
                datasheets.append(ds)

    # wire detachment -> its records
    by_det: Dict[str, Detachment] = {d.id: d for d in detachments}
    for rec in effects:
        det = by_det.get(rec.detachment)
        if det is None:
            continue
        if rec.kind == "stratagem":
            det.stratagem_ids.append(rec.id)
        elif rec.kind == "enhancement":
            det.enhancement_ids.append(rec.id)

    seen: Dict[str, EffectRecord] = {}
    for rec in effects:
        seen.setdefault(rec.id, rec)
    effects = list(seen.values())

    os.makedirs(args.out, exist_ok=True)
    write(os.path.join(args.out, "datasheets.json"), [d.to_json() for d in datasheets])
    write(os.path.join(args.out, "detachments.json"), [d.to_json() for d in detachments])
    write(os.path.join(args.out, "effects_ingested.json"), [e.to_json() for e in effects])
    write(os.path.join(args.out, "gaps_ingest.json"), [g.to_json() for g in GAPS])
    write(os.path.join(args.out, "meta.json"), {
        "schema_version": "2.0.0",
        "retrieved": RETRIEVED,
        "source": SOURCE,
        "counts": {
            "datasheets": len(datasheets),
            "legends": sum(1 for d in datasheets if d.legends),
            "detachments": len(detachments),
            "effects_ingested": len(effects),
            "gaps": len(GAPS),
        },
    })
    print(json.dumps({
        "datasheets": len(datasheets),
        "legends": sum(1 for d in datasheets if d.legends),
        "detachments": len(detachments),
        "effects": len(effects),
        "gaps": len(GAPS),
        "no_points": sum(1 for d in datasheets if not d.points),
        "no_weapons": sum(1 for d in datasheets if not d.weapons),
    }, indent=1))
    return 0


def write(path: str, obj: Any) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    raise SystemExit(main())
