"""Import a 40k app text export OR a named-list payload into a v2 army.

    python3 tools2/import_army.py tools/rosters/imports/bane.txt
    python3 tools2/import_army.py <export.txt> --name "Bane" --dry-run
    python3 tools2/import_army.py my_list.sim2list.json          # named-list payload

The app's export is the only place the owner's real lists exist in a machine-
readable form, so this is the bridge between "lists I actually play" and the
simulator. v1 has its own importer for the 10th-edition schema
(`src/core/importer.ts`); this is the 11th-edition equivalent and shares none of
its code — the two schemas key units differently (v1 by Wahapedia numeric id,
v2 by 11e slug).

The second accepted input is a **named-list payload** (`kind:
"sim2_named_list"`): unit NAMES + model counts, no ids of either schema. It is
what the Auto Player tab generates in the browser from a List Builder saved
list (`src/ui/autoplayer/savedArmies.ts`) — localStorage only exists in the
browser, so the browser transcribes names and this importer resolves them
against the snapshot, exactly like the text-export path (same resolvers, same
points columns). `sim2.cli` also accepts such a payload file directly as
`--a`/`--b`/`--vs`, resolving it in memory for a one-off run.

Discipline (brief mandate 3): a unit whose name does not resolve against the
snapshot is **reported and skipped**, never approximated to something similar.
The importer prints what it could not place and exits non-zero if anything was
dropped, so a partial import cannot be mistaken for a complete one.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sim2.loader import load
from sim2.schema import Army, ArmyUnit, Datasheet

#: Section headings the export prints between unit blocks.
SECTION_RE = re.compile(r"^[A-Z][A-Z '&/-]{3,}$")
#: "Death Korps of Krieg (65 points)" — the unit header.
UNIT_RE = re.compile(r"^(?P<name>[^(]+?)\s*\((?P<points>[\d,]+)\s*points?\)\s*$", re.I)
#: "Incursion (1,000 Points)" — the battle size line.
SIZE_RE = re.compile(
    r"^(?P<label>Combat Patrol|Incursion|Strike Force|Onslaught)\s*\((?P<points>[\d,]+)", re.I
)
BULLET_RE = re.compile(r"^(?P<indent>\s*)(?P<glyph>[•◦▪·-])\s*(?P<text>.+?)\s*$")
COUNT_RE = re.compile(r"^(?P<n>\d+)\s*x\s+(?P<item>.+)$", re.I)

#: Bullets that describe the entry rather than its models.
META_PREFIXES = ("warlord", "enhancement", "attached as", "attached unit", "force disposition")


def norm(s: str) -> str:
    """Compare names ignoring case, punctuation and the app's curly quotes."""
    s = unicodedata.normalize("NFKD", s or "")
    s = s.replace("’", "'").replace("‘", "'")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


@dataclass
class Bullet:
    depth: int
    text: str


@dataclass
class ParsedUnit:
    name: str
    points: int
    bullets: List[Bullet] = field(default_factory=list)
    section: str = ""

    @property
    def warlord(self) -> bool:
        return any(b.text.lower().startswith("warlord") for b in self.bullets)

    @property
    def enhancement(self) -> str:
        for b in self.bullets:
            m = re.match(r"enhancements?\s*:\s*(.+)$", b.text, re.I)
            if m:
                return m.group(1).strip()
        return ""

    @property
    def attached_as(self) -> str:
        for b in self.bullets:
            m = re.match(r"attached as\s*:\s*([A-Za-z ]+)", b.text, re.I)
            if m:
                return m.group(1).strip().lower()
        return ""


@dataclass
class ImportReport:
    army: Optional[Army] = None
    resolved: List[str] = field(default_factory=list)
    unresolved: List[str] = field(default_factory=list)
    legends: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    stated_points: int = 0

    @property
    def ok(self) -> bool:
        return self.army is not None and not self.unresolved


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------
def parse_export(text: str) -> Tuple[Dict[str, Any], List[ParsedUnit]]:
    lines = text.splitlines()
    header: Dict[str, Any] = {"name": "", "faction": "", "detachment": "",
                              "battle_size": 0, "stated_points": 0,
                              "stated_disposition": ""}
    units: List[ParsedUnit] = []
    section = ""
    current: Optional[ParsedUnit] = None

    # -- header: the first non-empty lines before the first section ---------
    body_start = 0
    for i, raw in enumerate(lines[:12]):
        line = raw.strip()
        if not line:
            continue
        if SECTION_RE.match(line):
            body_start = i
            break
        m = UNIT_RE.match(line)
        if m and not header["name"]:
            header["name"] = m.group("name").strip()
            header["stated_points"] = int(m.group("points").replace(",", ""))
            continue
        m = SIZE_RE.match(line)
        if m:
            header["battle_size"] = int(m.group("points").replace(",", ""))
            continue
        if line.lower().startswith("force disposition"):
            header["stated_disposition"] = line.split(":", 1)[-1].strip()
            continue
        if norm(line) in ("astra militarum", "imperial agents", "agents of the imperium"):
            header["faction"] = "AM" if norm(line) == "astra militarum" else "IA"
            continue
        if not header["detachment"]:
            # Whatever is left on its own line is the detachment. The app prints
            # it two ways: "Grizzled Company" and "Ordo Hereticus, Purgation
            # Force (3 Detachment Points)".
            det = re.sub(r"\(\s*\d+\s*Detachment Points?\s*\)", "", line).strip()
            header["detachment"] = det.replace(",", "").strip()
        body_start = i + 1

    # -- body ---------------------------------------------------------------
    for raw in lines[body_start:]:
        line = raw.strip()
        if not line:
            continue
        if SECTION_RE.match(line) and not UNIT_RE.match(line):
            section = line
            current = None
            continue
        bullet = BULLET_RE.match(raw)
        if bullet:
            if current is not None:
                depth = len(bullet.group("indent")) + (
                    0 if bullet.group("glyph") == "•" else 2
                )
                current.bullets.append(Bullet(depth, bullet.group("text")))
            continue
        m = UNIT_RE.match(line)
        if m:
            current = ParsedUnit(
                name=m.group("name").strip(),
                points=int(m.group("points").replace(",", "")),
                section=section,
            )
            units.append(current)
    return header, units


def infer_model_count(unit: ParsedUnit, ds: Optional[Datasheet]) -> int:
    """Model count from the model-group bullets, reconciled against points.

    The export lists models and wargear in the same bullet tree, distinguished
    only by nesting: a model group is a top-level bullet, its wargear sits
    underneath. Where that is ambiguous the printed points settle it — the tier
    whose cost matches what the app charged is the tier that was taken.
    """
    if not unit.bullets:
        inferred = 0
    else:
        top = min(b.depth for b in unit.bullets)
        inferred = 0
        for b in unit.bullets:
            if b.depth > top:
                continue
            low = b.text.lower()
            if any(low.startswith(p) for p in META_PREFIXES):
                continue
            m = COUNT_RE.match(b.text)
            if m:
                inferred += int(m.group("n"))

    if ds is None:
        return max(1, inferred)
    tiers = [t for t in ds.points]
    if inferred and any(t.models == inferred for t in tiers):
        return inferred
    by_cost = [t for t in tiers if t.points == unit.points]
    if by_cost:
        return by_cost[0].models
    if inferred:
        return inferred
    return min((t.models for t in tiers), default=1)


# --------------------------------------------------------------------------
# resolution
# --------------------------------------------------------------------------
def resolve_datasheet(data, name: str, faction: str) -> Optional[Datasheet]:
    target = norm(name)
    same_faction = [d for d in data.datasheets.values() if d.faction == faction]
    for pool in (same_faction, list(data.datasheets.values())):
        for ds in pool:
            if norm(ds.name) == target:
                return ds
        # the app sometimes prints a squad's singular/plural differently
        for ds in pool:
            n = norm(ds.name)
            if n and (n == target.rstrip("s") or n.rstrip("s") == target):
                return ds
    return None


def resolve_detachment(data, name: str, faction: str) -> str:
    target = norm(name)
    candidates = [d for d in data.detachments.values() if d.faction == faction]
    for det in candidates:
        if norm(det.name) == target:
            return det.id
    for det in candidates:
        n = norm(det.name)
        if target and (target in n or n in target):
            return det.id
    return ""


def resolve_detachments(data, raw: str, faction: str) -> Tuple[List[str], List[str]]:
    """One raw detachment line → the army's detachment id list.

    The 11e app prints a multi-detachment army as one combined header
    ("Imperialis Fleet and Veiled Blade Elimination Force"). The whole string
    is tried first so a name containing "and" can never be broken; only when
    that fails is it split, and the split is kept only if EVERY part resolves
    (mirroring v1's splitDetachments rule). Returns (ids, warnings).
    """
    raw = (raw or "").strip()
    if not raw:
        return [], []
    # Exact whole-string match first, so a single detachment whose name happens
    # to contain "and" can never be broken apart.
    target = norm(raw)
    for det in data.detachments.values():
        if det.faction == faction and norm(det.name) == target:
            return [det.id], []
    parts = [p.strip() for p in re.split(r"\s+and\s+", raw) if p.strip()]
    if len(parts) > 1:
        ids = [resolve_detachment(data, p, faction) for p in parts]
        if all(ids):
            return ids, []
    # Fuzzy fallback last — it substring-matches, which would otherwise swallow
    # a combined header into one of its components.
    whole = resolve_detachment(data, raw, faction)
    if whole:
        return [whole], []
    return [], [
        f"detachment {raw!r} did not resolve; the army carries none, "
        "so its detachment rule and stratagems will not be in play"
    ]


def resolve_enhancement(data, name: str, detachment_id: str) -> str:
    target = norm(name)
    for rec in data.effects.values():
        if rec.kind != "enhancement":
            continue
        if detachment_id and rec.detachment != detachment_id:
            continue
        if norm(rec.name) == target:
            return rec.id
    return ""


def points_column(ds: Datasheet, army_faction: str) -> str:
    """Trap §6.5: an Agents unit inside another army pays the ally column."""
    return "army_faction" if ds.faction == army_faction else "assigned_agent"


# --------------------------------------------------------------------------
@dataclass
class UnitSpec:
    """One unit as the input names it — the shared shape both import paths
    (text export and named-list payload) feed the assembler."""

    name: str
    models: int = 0                # 0 = infer from the parsed bullets/points
    stated_points: int = 0         # 0 = the source stated no per-unit points
    enhancement: str = ""
    warlord: bool = False
    attached_as: str = ""
    parsed: Optional[ParsedUnit] = None


def _assemble(data, report: ImportReport, *, name: str, faction: str,
              detachment_raw: str, battle_size: int, specs: List[UnitSpec],
              source_notes: List[str]) -> ImportReport:
    """Resolve UnitSpecs against the snapshot into ``report.army``.

    Shared by both import paths so name resolution, the Agents ally points
    column, copy escalation and the never-approximate discipline cannot drift
    between them.
    """
    detachment_ids, det_warnings = resolve_detachments(data, detachment_raw, faction)
    report.warnings.extend(det_warnings)

    units: List[ArmyUnit] = []
    total = 0
    copies: Dict[str, int] = {}
    for spec in specs:
        ds = resolve_datasheet(data, spec.name, faction)
        if ds is None:
            report.unresolved.append(
                f"{spec.name} ({spec.stated_points} pts)" if spec.stated_points
                else spec.name
            )
            continue
        if ds.legends:
            report.legends.append(ds.name)

        if spec.models:
            models = spec.models
        elif spec.parsed is not None:
            models = infer_model_count(spec.parsed, ds)
        else:
            models = min((t.models for t in ds.points), default=1)
            report.warnings.append(
                f"{ds.name}: the source stated no model count; the smallest printed "
                f"size ({models}) is used"
            )
        sizes = sorted({t.models for t in ds.points})
        if sizes and models not in sizes:
            report.warnings.append(
                f"{ds.name}: {models} models is not a printed unit size {sizes}; "
                "check the source's model counts"
            )
        copies[ds.id] = copies.get(ds.id, 0) + 1
        column = points_column(ds, faction or ds.faction)
        cost = ds.cost(models, copy_index=copies[ds.id], column=column)
        if cost is None:
            report.warnings.append(
                f"{ds.name}: no points tier for {models} models in the {column} column; "
                f"the source's {spec.stated_points} pts is used"
            )
            cost = spec.stated_points
        elif spec.stated_points and cost != spec.stated_points:
            report.warnings.append(
                f"{ds.name}: snapshot says {cost} pts for {models} models, the source says "
                f"{spec.stated_points} — snapshot value used (points are unreconciled with MFM)"
            )
        total += cost

        enhancement_id = ""
        if spec.enhancement:
            for did in detachment_ids or [""]:
                enhancement_id = resolve_enhancement(data, spec.enhancement, did)
                if enhancement_id:
                    break
            if not enhancement_id:
                report.warnings.append(
                    f"{ds.name}: enhancement {spec.enhancement!r} did not resolve"
                )

        units.append(ArmyUnit(
            datasheet_id=ds.id,
            models=models,
            enhancement_id=enhancement_id,
            warlord=spec.warlord,
            # The source records Leader/Bodyguard pairing; it is transcribed
            # even though attached units are not implemented yet (register C1).
            attached_to=spec.attached_as if spec.attached_as in ("leader", "bodyguard") else "",
            key=str(len(units)),
        ))
        report.resolved.append(f"{ds.name} ×{models} ({cost} pts)")

    if not units:
        report.warnings.append("no units resolved; nothing written")
        return report

    notes = list(source_notes)
    if report.stated_points:
        notes.append(
            f"The source states {report.stated_points} points; the snapshot totals {total}."
        )
    if report.legends:
        notes.append("Contains Legends datasheets (not tournament legal): "
                     + ", ".join(sorted(set(report.legends))))
    notes.extend(report.warnings)

    report.army = Army(
        name=name or "Imported army",
        faction=faction or units[0].datasheet_id.split(".")[0].upper(),
        detachments=detachment_ids,
        units=units,
        battle_size=battle_size or 1000,
        points=total,
        notes=notes,
    )
    return report


def import_export(data, text: str, name_override: str = "") -> ImportReport:
    header, parsed = parse_export(text)
    report = ImportReport(stated_points=header.get("stated_points", 0))

    faction = header.get("faction") or ""
    if not faction:
        report.warnings.append("faction line not recognised; datasheets matched across both")

    specs = [
        UnitSpec(name=entry.name, stated_points=entry.points,
                 enhancement=entry.enhancement, warlord=entry.warlord,
                 attached_as=entry.attached_as, parsed=entry)
        for entry in parsed
    ]
    _assemble(
        data, report,
        name=name_override or header.get("name") or "",
        faction=faction,
        detachment_raw=header.get("detachment", ""),
        battle_size=header.get("battle_size") or 1000,
        specs=specs,
        source_notes=[
            "Imported from a 40k app text export by tools2/import_army.py.",
            "Points come from the 11th edition snapshot, so they differ from an export "
            "written by a 10th edition app: this is the list re-priced under 11e, not a "
            "verified-legal 11e roster. Points are also unreconciled with the MFM "
            "(register A5), so treat the total as provisional.",
        ],
    )

    stated_disp = header.get("stated_disposition", "")
    det_id = report.army.detachments[0] if report.army and report.army.detachments else ""
    if stated_disp and det_id:
        actual = data.detachments[det_id].disposition
        if norm(stated_disp) != norm(actual):
            note = (
                f"the export states Force Disposition {stated_disp!r}, but the 11th edition "
                f"pack gives {data.detachments[det_id].name} {actual!r} — the pack "
                "value is used, and it decides which primary missions this army scores"
            )
            report.warnings.append(note)
            report.army.notes.append(note)
    return report


#: The payload the Auto Player tab writes from a List Builder saved list
#: (src/ui/autoplayer/savedArmies.ts). Nothing but names and counts — both
#: schemas' ids stay on their own side of the bridge.
NAMED_LIST_KIND = "sim2_named_list"


def looks_like_named_list(blob: Any) -> bool:
    if not isinstance(blob, dict):
        return False
    if blob.get("kind") == NAMED_LIST_KIND:
        return True
    units = blob.get("units")
    return bool(units) and all(
        isinstance(u, dict) and u.get("name") and "datasheet_id" not in u for u in units
    )


def import_named_list(data, payload: Dict[str, Any], name_override: str = "") -> ImportReport:
    """Resolve a named-list payload (unit names + model counts) into an Army."""
    report = ImportReport(stated_points=int(payload.get("points") or 0))

    faction = str(payload.get("faction") or "").strip().upper()
    if faction and faction not in ("IA", "AM"):
        report.warnings.append(
            f"faction {faction!r} is not in the snapshot (IA / AM); "
            "datasheets matched across both"
        )
        faction = ""
    if not faction:
        report.warnings.append("payload names no snapshot faction; datasheets matched across both")

    specs = [
        UnitSpec(
            name=str(u.get("name") or ""),
            models=int(u.get("models") or 0),
            enhancement=str(u.get("enhancement") or ""),
            warlord=bool(u.get("warlord")),
            attached_as="leader" if u.get("attached") else "",
        )
        for u in payload.get("units", [])
        if isinstance(u, dict)
    ]
    return _assemble(
        data, report,
        name=name_override or str(payload.get("name") or ""),
        faction=faction,
        detachment_raw=str(payload.get("detachment") or ""),
        battle_size=int(payload.get("battle_size") or 1000),
        specs=specs,
        source_notes=[
            "Converted from a List Builder saved list (named-list payload) by "
            "tools2/import_army.py.",
            "Points come from the 11th edition snapshot and are unreconciled with the "
            "MFM (register A5), so treat the total as provisional. Wargear/loadout "
            "choices do not transfer — the v2 schema does not model them yet.",
        ],
    )


# --------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", help="path to the app's text export or a named-list payload (.json)")
    ap.add_argument("--out", default="data2/armies", help="output directory")
    ap.add_argument("--name", default="", help="override the army name")
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    args = ap.parse_args(argv)

    data = load()
    text = open(args.export, encoding="utf-8").read()
    blob: Any = None
    if text.lstrip().startswith("{"):
        try:
            blob = json.loads(text)
        except json.JSONDecodeError:
            blob = None
    if blob is not None:
        if not looks_like_named_list(blob):
            print("This JSON is not a named-list payload. A v2 army file "
                  "(datasheet_id units) belongs in data2/armies/ as-is.", file=sys.stderr)
            return 1
        report = import_named_list(data, blob, args.name)
    else:
        report = import_export(data, text, args.name)

    if report.army is None:
        print("IMPORT FAILED", file=sys.stderr)
        for w in report.warnings:
            print(f"  ! {w}", file=sys.stderr)
        return 1

    army = report.army
    print(f"{army.name} — {army.faction} · {army.points} pts · "
          f"{len(army.units)} units · battle size {army.battle_size}")
    print(f"  detachment: {army.detachment or '(unresolved)'}")
    for line in report.resolved:
        print(f"  ✓ {line}")
    for line in report.unresolved:
        print(f"  ✗ UNRESOLVED {line}", file=sys.stderr)
    for w in report.warnings:
        print(f"  ! {w}")

    if not args.dry_run:
        os.makedirs(args.out, exist_ok=True)
        slug = re.sub(r"[^a-z0-9]+", "_", army.name.lower()).strip("_")
        path = os.path.join(args.out, f"{slug}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(army.to_json(), fh, indent=1, ensure_ascii=False)
        print(f"  → {path}")

    if report.unresolved:
        print(f"\n{len(report.unresolved)} unit(s) did not resolve and were dropped — "
              "the army is INCOMPLETE.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
