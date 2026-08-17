// List Builder saved lists → sim2 named-list payloads.
//
// The Auto Player's armies normally come from the committed data2/armies
// snapshot, but the owner's working lists live in this browser's localStorage
// in the v1 schema (Wahapedia numeric datasheet ids), which the Python engine
// cannot read. The bridge is a NAMED-LIST payload: unit names + model counts,
// no ids of either schema. The browser only transcribes names out of the v1
// catalog; all rules-side resolution (name → v2 datasheet, snapshot points,
// the Agents ally column) happens in Python — tools2/import_army
// `import_named_list`, the same resolver the text-export importer uses — which
// REFUSES the run if any unit does not resolve, never approximating.
//
// v2 boundary note (CLAUDE.md §7b): this module reuses only *data* from v1 —
// the two JSON catalogs below and the saved lists themselves. The ArmyList
// import is type-only (erased at build); SAVED_LISTS_KEY/loadSavedArmyLists
// are browser-IO glue shared with the board, not rules code.

import type { ArmyList } from '../../core/army';
import { loadSavedArmyLists } from '../savedLists';
import datasheetsJson from '../../../data/game/datasheets.json';
import enhancementsJson from '../../../data/game/enhancements.json';

export interface NamedListUnit {
  name: string;
  models: number;
  warlord?: boolean;
  enhancement?: string;
  /** Transcribed Leader pairing (v2 logs it; attached units are register C1). */
  attached?: boolean;
}

/** The contract of tools2/import_army.import_named_list (`kind` is its sniff key). */
export interface NamedListPayload {
  kind: 'sim2_named_list';
  name: string;
  /** v2 snapshot faction code: 'AM' | 'IA'. */
  faction: string;
  /** The raw v1 detachment string — Python splits combined names and resolves. */
  detachment: string;
  battle_size: number;
  units: NamedListUnit[];
  source: string;
}

export interface SavedArmy {
  payload: NamedListPayload;
  /** Browser-side conversion notes (catalog ids that would not name). Shown as
   *  warnings; Python is the authority and aborts on unresolved names. */
  problems: string[];
}

export interface SavedArmyCatalog {
  armies: SavedArmy[];
  /** Lists that cannot run in v2 at all, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
}

// Name catalogs (data reuse only — see the header note).
interface NamedRow { id: string; name: string }
const datasheetNameById = new Map(
  (datasheetsJson as unknown as NamedRow[]).map((d) => [d.id, d.name]),
);
const enhancementNameById = new Map(
  (enhancementsJson as unknown as NamedRow[]).map((e) => [e.id, e.name]),
);

/** v1 list faction codes → v2 snapshot faction codes. */
const FACTION_MAP: Record<string, string> = { AM: 'AM', AoI: 'IA' };

/** v1 battle sizes → points (mirrors core/army BATTLE_SIZES; duplicated here so
 *  the v2 surface imports no v1 rules code). */
const BATTLE_SIZE_POINTS: Record<string, number> = {
  'Combat Patrol': 500,
  Incursion: 1000,
  'Strike Force': 2000,
};

/** Convert one saved list. Returns either a payload or the reason it cannot run in v2. */
export function convertSavedList(list: ArmyList): { army?: SavedArmy; skip?: string } {
  if (list.combatPatrol) {
    return { skip: 'Combat Patrol boxes are not in the v2 snapshot (IA/AM only)' };
  }
  const faction = FACTION_MAP[list.faction];
  if (!faction) {
    return { skip: `faction ${list.faction || '(none)'} is not in the v2 snapshot (IA/AM only)` };
  }

  const problems: string[] = [];
  const units: NamedListUnit[] = list.units.map((u) => {
    const name = datasheetNameById.get(u.datasheetId);
    if (!name) {
      // Transcribed verbatim so the Python side reports it unresolved and
      // refuses — dropping it here would silently field a partial army.
      problems.push(`unit ${u.datasheetId} is not in the v1 catalog`);
    }
    const unit: NamedListUnit = { name: name ?? u.datasheetId, models: u.modelCount };
    if (u.warlord) unit.warlord = true;
    if (u.attachedTo) unit.attached = true;
    if (u.enhancementId) {
      const enh = enhancementNameById.get(u.enhancementId);
      if (enh) unit.enhancement = enh;
      else problems.push(`${unit.name}: enhancement ${u.enhancementId} is not in the v1 catalog`);
    }
    return unit;
  });

  return {
    army: {
      payload: {
        kind: 'sim2_named_list',
        name: list.name,
        faction,
        detachment: list.detachment,
        battle_size: BATTLE_SIZE_POINTS[list.battleSize] ?? 1000,
        units,
        source: 'List Builder saved list (browser localStorage)',
      },
      problems,
    },
  };
}

/** Every saved list in this browser, converted (or the reason it was skipped). */
export function loadSavedArmyCatalog(): SavedArmyCatalog {
  const out: SavedArmyCatalog = { armies: [], skipped: [] };
  for (const list of Object.values(loadSavedArmyLists())) {
    const res = convertSavedList(list);
    if (res.army) out.armies.push(res.army);
    else out.skipped.push({ name: list.name, reason: res.skip ?? 'not convertible' });
  }
  out.armies.sort((a, b) => a.payload.name.localeCompare(b.payload.name));
  return out;
}

/** File name for a downloaded payload (the CLI accepts any path; the extension
 *  is a human hint that this is a named-list payload, not a v2 army file). */
export function payloadFileName(payload: NamedListPayload): string {
  const slug = payload.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${slug || 'saved_list'}.sim2list.json`;
}
