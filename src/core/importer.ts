// Team importer. PURE — no React/DOM/I/O (the datasheet catalog is passed in).
//
// Parses the plain-text export produced by the GW "Warhammer 40,000" app's team builder
// (the format in the task description) into an `ArmyList`. It resolves each unit to a real
// datasheet, infers the model count and the per-item loadout (e.g. "4x Deathwatch thunder
// hammer"), and captures the Warlord and any Enhancement. Anything it can't resolve is returned
// as a warning rather than invented (CLAUDE.md scope rule #6).
//
// Scope: the two owned factions (Astra Militarum, Imperial Agents). The parser is intentionally
// tolerant of the app's bullet glyphs (•, ◦) and indentation.

import type { Datasheet } from './types';
import {
  createArmyList,
  defaultModelCount,
  setEnhancement,
  setWarlord,
  type ArmyList,
  type BattleSize,
  type ListUnit,
} from './army';
import type { Loadout } from './wargear';

export interface ImportResult {
  list: ArmyList;
  warnings: string[];
}

export interface ImportDeps {
  datasheets: Datasheet[];
  enhancements: { id: string; name: string; detachment: string }[];
}

// ── faction / battle-size dictionaries ───────────────────────────────────────────
function factionFromText(line: string): string | undefined {
  const l = line.toLowerCase();
  if (l.includes('imperial agents') || l.includes('agents of the imperium')) return 'AoI';
  if (l.includes('astra militarum') || l.includes('militarum')) return 'AM';
  return undefined;
}

const BATTLE_SIZE_BY_NAME: Record<string, BattleSize> = {
  'combat patrol': 'Combat Patrol',
  incursion: 'Incursion',
  'strike force': 'Strike Force',
};

// ── line model ───────────────────────────────────────────────────────────────────
const GLYPH_RANK: Record<string, number> = { '•': 0, '◦': 1, '‣': 2, '▪': 2, '·': 2, '*': 0, '-': 0 };
const GLYPHS = '•◦‣▪·*-';

interface Bullet {
  depth: number;
  count?: number; // the N in "Nx ..."; undefined for non-quantified lines (e.g. "Warlord")
  text: string; // the item / model name
  isWarlord: boolean;
  enhancement?: string;
}

function parseBullet(raw: string): Bullet | undefined {
  const m = raw.match(new RegExp(`^(\\s*)([${GLYPHS}])\\s*(.*)$`, 'u'));
  if (!m) return undefined;
  const indent = m[1]!.length;
  const glyph = m[2]!;
  let body = m[3]!.trim();
  const depth = indent + (GLYPH_RANK[glyph] ?? 2);

  if (/^warlord$/i.test(body)) return { depth, text: 'Warlord', isWarlord: true };
  const enh = body.match(/^enhancements?:\s*(.+)$/i);
  if (enh) return { depth, text: body, isWarlord: false, enhancement: enh[1]!.trim() };

  const q = body.match(/^(\d+)x\s+(.+)$/i);
  if (q) return { depth, count: parseInt(q[1]!, 10), text: q[2]!.trim(), isWarlord: false };
  return { depth, text: body, isWarlord: false };
}

const isSectionHeader = (line: string): boolean =>
  /^[A-Z][A-Z \-]{2,}$/.test(line.trim()) && !/\d/.test(line);

const unitHeader = (line: string): { name: string; points: number } | undefined => {
  const m = line.trim().match(/^(.+?)\s*\((\d[\d,]*)\s*points?\)$/i);
  if (!m) return undefined;
  return { name: m[1]!.trim(), points: parseInt(m[2]!.replace(/,/g, ''), 10) };
};

// ── datasheet resolution ───────────────────────────────────────────────────────
function findDatasheet(name: string, faction: string, dss: Datasheet[]): Datasheet | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  const target = norm(name);
  const inFaction = dss.filter((d) => d.faction === faction);
  return (
    inFaction.find((d) => norm(d.name) === target) ??
    dss.find((d) => norm(d.name) === target) ?? // fall back across factions (allied/agents)
    inFaction.find((d) => norm(d.name).startsWith(target) || target.startsWith(norm(d.name)))
  );
}

/** Resolve a parsed item name to its canonical datasheet weapon name (keeps unknowns verbatim). */
function canonicalItem(item: string, ds: Datasheet): string {
  const lc = item.toLowerCase();
  const exact = ds.weapons.find((w) => w.name.toLowerCase() === lc);
  // Wargear like shields aren't in the weapons array, so unknowns are kept as written.
  return exact ? exact.name : item;
}

/** Choose the model-count tier that best fits the stated points / inferred model count. */
function resolveModelCount(ds: Datasheet, inferred: number, statedPoints: number): number {
  const tiers = ds.points ?? [];
  if (tiers.length === 0) return inferred || defaultModelCount(ds);
  if (inferred > 0 && tiers.some((t) => t.models === inferred)) return inferred;
  const byCost = tiers.find((t) => t.cost === statedPoints);
  if (byCost) return byCost.models;
  return inferred || defaultModelCount(ds);
}

// ── the parser ───────────────────────────────────────────────────────────────────
export function parseArmyText(text: string, deps: ImportDeps): ImportResult {
  const warnings: string[] = [];
  const rawLines = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ').split('\n');
  const lines = rawLines.filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { list: createArmyList('AM'), warnings: ['Empty import.'] };

  // ── header / preamble ──
  const nameLine = lines[0]!;
  const nameMatch = unitHeader(nameLine);
  const listName = nameMatch ? nameMatch.name : nameLine.trim();

  // Find where the body (sections + units) begins. Prefer the first section header so the
  // "Incursion (1,000 Points)" battle-size line stays in the preamble; otherwise the first unit.
  let bodyStart = lines.findIndex((l, i) => i > 0 && isSectionHeader(l));
  if (bodyStart === -1) {
    bodyStart = lines.findIndex(
      (l, i) => i > 0 && unitHeader(l) !== undefined && !/\b(combat patrol|incursion|strike force)\b/i.test(l),
    );
  }
  if (bodyStart === -1) bodyStart = lines.length;
  const preamble = lines.slice(1, bodyStart).map((l) => l.trim());

  let faction = 'AM';
  let battleSize: BattleSize = 'Incursion';
  const leftover: string[] = [];
  for (const line of preamble) {
    const f = factionFromText(line);
    const bs = line.match(/\b(combat patrol|incursion|strike force)\b/i);
    if (f) faction = f;
    else if (bs) battleSize = BATTLE_SIZE_BY_NAME[bs[1]!.toLowerCase()] ?? battleSize;
    else leftover.push(line);
  }
  // The detachment is the remaining preamble line (e.g. "Imperialis Fleet", "Grizzled Company").
  const detachment = pickDetachment(leftover, deps);

  let list = createArmyList(faction, detachment, battleSize, listName);

  // ── walk sections / units ──
  const warlordUids: string[] = [];
  const enhancementByUid: Record<string, string> = {};
  let i = bodyStart;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^exported with/i.test(line.trim())) break;
    if (isSectionHeader(line)) { i++; continue; }
    const header = unitHeader(line);
    if (!header) { i++; continue; }

    // Collect this unit's bullet block (until the next unit header / section / EOF).
    const bullets: Bullet[] = [];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (/^exported with/i.test(l.trim())) break;
      if (isSectionHeader(l) || unitHeader(l)) break;
      const b = parseBullet(l);
      if (b) bullets.push(b);
      i++;
    }

    const ds = findDatasheet(header.name, faction, deps.datasheets);
    if (!ds) {
      warnings.push(`Could not resolve unit "${header.name}" (${header.points} pts) — skipped.`);
      continue;
    }

    const { modelCount, loadout, warlord, enhancementName } = buildUnit(ds, bullets, header.points);
    const uid = addResolvedUnit(list, ds, modelCount, loadout);
    list = uid.list;
    if (warlord) warlordUids.push(uid.uid);
    if (enhancementName) enhancementByUid[uid.uid] = enhancementName;
  }

  // Apply Warlord (first one wins) and enhancements after all units exist.
  if (warlordUids.length > 0) list = setWarlord(list, warlordUids[0]!);
  if (warlordUids.length > 1) warnings.push('Multiple Warlords in import — kept the first.');
  for (const [uid, enhName] of Object.entries(enhancementByUid)) {
    const enh = deps.enhancements.find((e) => e.name.toLowerCase() === enhName.toLowerCase());
    if (enh) list = setEnhancement(list, uid, enh.id);
    else warnings.push(`Enhancement "${enhName}" not found in the catalog — left unset.`);
  }

  return { list, warnings };
}

// ── helpers ───────────────────────────────────────────────────────────────────────
function pickDetachment(candidates: string[], deps: ImportDeps): string {
  const detachNames = new Set(
    deps.enhancements.filter((e) => e.detachment).map((e) => e.detachment.toLowerCase()),
  );
  // Prefer a candidate that matches a known detachment; else the longest non-faction line.
  const known = candidates.find((c) => detachNames.has(c.toLowerCase()));
  if (known) return deps.enhancements.find((e) => e.detachment.toLowerCase() === known.toLowerCase())!.detachment;
  const nonFaction = candidates.filter((c) => !factionFromText(c));
  return nonFaction.sort((a, b) => b.length - a.length)[0] ?? '';
}

interface BuiltUnit {
  modelCount: number;
  loadout: Loadout;
  warlord: boolean;
  enhancementName?: string;
}

/** Turn a unit's bullet block into a model count + item→count loadout, honouring nesting. */
function buildUnit(ds: Datasheet, bullets: Bullet[], statedPoints: number): BuiltUnit {
  const loadout: Loadout = {};
  let modelGroups = 0;
  let warlord = false;
  let enhancementName: string | undefined;

  const addItem = (text: string, count: number) => {
    if (count <= 0) return;
    const key = canonicalItem(text, ds);
    loadout[key] = (loadout[key] ?? 0) + count;
  };

  // Global captures (robust regardless of indentation depth).
  for (const b of bullets) {
    if (b.isWarlord) warlord = true;
    if (b.enhancement) enhancementName = b.enhancement;
  }

  let i = 0;
  while (i < bullets.length) {
    const b = bullets[i]!;
    if (b.isWarlord || b.enhancement) { i++; continue; }

    // Gather deeper-indented children of a top-level entry.
    const children: Bullet[] = [];
    let j = i + 1;
    while (j < bullets.length && bullets[j]!.depth > b.depth) {
      children.push(bullets[j]!);
      j++;
    }
    const itemChildren = children.filter((c) => !c.isWarlord && !c.enhancement && c.count != null);

    if (itemChildren.length > 0) {
      // `b` is a model-group header (e.g. "9x Deathwatch Veterans"); its children are wargear.
      modelGroups += b.count ?? 1;
      for (const c of itemChildren) addItem(c.text, c.count!);
      i = j;
    } else {
      // Leaf line: a weapon on a single-model unit (e.g. Callidus' "1x Neural shredder").
      if (b.count != null) addItem(b.text, b.count);
      i++;
    }
  }

  const inferred = modelGroups > 0 ? modelGroups : 1;
  const modelCount = resolveModelCount(ds, inferred, statedPoints);
  return { modelCount, loadout, warlord, enhancementName };
}

/** Add a fully-specified unit to the list and return the new list + the unit's uid. */
function addResolvedUnit(
  list: ArmyList,
  ds: Datasheet,
  modelCount: number,
  loadout: Loadout,
): { list: ArmyList; uid: string } {
  let n = 1;
  while (list.units.some((u) => u.uid === `${ds.id}~${n}`)) n++;
  const uid = `${ds.id}~${n}`;
  const unit: ListUnit = { uid, datasheetId: ds.id, modelCount };
  if (Object.keys(loadout).length > 0) unit.loadout = loadout;
  return { list: { ...list, units: [...list.units, unit] }, uid };
}
