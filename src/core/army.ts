// Army list construction: points + validation + pure list edits. PURE — no React/DOM/I/O.
// Lookups (datasheets, enhancements) are passed in as a DataIndex so this stays framework-free.
//
// 10th-edition points model: a unit's cost is set by its model-count tier; wargear is FREE;
// enhancements are the only other points. So points move when you add a unit, change its size,
// or add/remove an enhancement — never when you swap weapons.

import type { Datasheet, Enhancement, Roster } from './types';
import { defensiveItemsInText, validateUnitLoadout, type Loadout } from './wargear';
import { checkDetachmentPoints, dpBudget } from './detachments';

// ── Battle size (points limit + datasheet copy limits) ───────────────────────
export type BattleSize = 'Combat Patrol' | 'Incursion' | 'Strike Force';

export interface BattleSizeRule {
  points: number;
  /** Max copies of a Battleline datasheet. */
  battlelineMax: number;
  /** Max copies of any other (non-Battleline, non-Epic-Hero) datasheet. */
  otherMax: number;
}

// 10e matched-play limits. Combat Patrol is normally a fixed list; we treat it as a 500pt cap.
export const BATTLE_SIZES: Record<BattleSize, BattleSizeRule> = {
  'Combat Patrol': { points: 500, battlelineMax: 3, otherMax: 3 },
  Incursion: { points: 1000, battlelineMax: 3, otherMax: 2 },
  'Strike Force': { points: 2000, battlelineMax: 6, otherMax: 3 },
};

// ── List shape ───────────────────────────────────────────────────────────────
export interface ListUnit {
  uid: string; // unique within the list
  datasheetId: string;
  modelCount: number;
  enhancementId?: string;
  warlord?: boolean;
  attachedTo?: string; // uid of the bodyguard unit a leader is attached to
  /** Chosen wargear as an item→count map (e.g. {"Deathwatch thunder hammer": 4}). Validated
   *  against the datasheet's option caps; does NOT affect points (wargear is free in 10e). */
  loadout?: Loadout;
}

export interface ArmyList {
  name: string;
  faction: string; // 'AM' | 'AoI' — or a patrol's faction name for Combat Patrol lists
  detachment: string;
  battleSize: BattleSize;
  units: ListUnit[];
  /** A fixed Combat Patrol (one of the four boxed patrols) — validation is the box itself. */
  combatPatrol?: boolean;
}

export interface DataIndex {
  datasheets: Map<string, Datasheet>;
  enhancements: Map<string, Enhancement>;
}

// ── keyword predicates ───────────────────────────────────────────────────────
function hasKeyword(ds: Datasheet | undefined, kw: string): boolean {
  return !!ds?.keywords.some((k) => k.toLowerCase() === kw.toLowerCase());
}
export const isCharacter = (ds?: Datasheet): boolean => hasKeyword(ds, 'Character');
export const isEpicHero = (ds?: Datasheet): boolean => hasKeyword(ds, 'Epic Hero');
export const isBattleline = (ds?: Datasheet): boolean => hasKeyword(ds, 'Battleline');

// ── points ───────────────────────────────────────────────────────────────────
export function modelCountOptions(ds?: Datasheet): number[] {
  return (ds?.points ?? []).map((t) => t.models);
}
export function defaultModelCount(ds?: Datasheet): number {
  return ds?.points?.[0]?.models ?? 1;
}
export function unitCost(ds: Datasheet | undefined, modelCount: number): number {
  return ds?.points?.find((t) => t.models === modelCount)?.cost ?? 0;
}
export function enhancementCost(enhId: string | undefined, ix: DataIndex): number {
  return enhId ? (ix.enhancements.get(enhId)?.cost ?? 0) : 0;
}
export function listPoints(list: ArmyList, ix: DataIndex): number {
  let total = 0;
  for (const u of list.units) {
    total += unitCost(ix.datasheets.get(u.datasheetId), u.modelCount);
    total += enhancementCost(u.enhancementId, ix);
  }
  return total;
}

// ── pure list edits ──────────────────────────────────────────────────────────
export function createArmyList(
  faction: string,
  detachment = '',
  battleSize: BattleSize = 'Incursion',
  name = 'New Army',
): ArmyList {
  return { name, faction, detachment, battleSize, units: [] };
}

function nextUid(list: ArmyList, dsId: string): string {
  let i = 1;
  while (list.units.some((u) => u.uid === `${dsId}~${i}`)) i++;
  return `${dsId}~${i}`;
}

export function addUnit(list: ArmyList, ds: Datasheet): ArmyList {
  const unit: ListUnit = { uid: nextUid(list, ds.id), datasheetId: ds.id, modelCount: defaultModelCount(ds) };
  return { ...list, units: [...list.units, unit] };
}
/** Add a unit at a FIXED size/loadout (Combat Patrol box contents — the datasheets carry no
 *  points tiers, the patrol roster is the source of truth). */
export function addUnitWithCount(list: ArmyList, ds: Datasheet, modelCount: number, loadout?: Loadout): ArmyList {
  const unit: ListUnit = {
    uid: nextUid(list, ds.id),
    datasheetId: ds.id,
    modelCount,
    ...(loadout && Object.keys(loadout).length ? { loadout } : {}),
  };
  return { ...list, units: [...list.units, unit] };
}

/**
 * The four boxed Combat Patrols as List Builder lists: built from the fixed patrol roster
 * (units, sizes, wargear). The first CHARACTER is marked Warlord. `combatPatrol` rides through
 * `toRoster`, so "Open in board" hands the board a roster its Combat Patrol picker accepts.
 */
export function patrolArmyList(roster: Roster, ix: DataIndex): ArmyList {
  let list: ArmyList = {
    name: roster.name,
    faction: roster.faction,
    detachment: roster.detachment,
    battleSize: 'Combat Patrol',
    combatPatrol: true,
    units: [],
  };
  for (const u of roster.units) {
    list = addUnitWithCount(list, ix.datasheets.get(u.datasheetId)!, u.modelCount, u.wargearCounts);
  }
  const chief = list.units.find((u) => isCharacter(ix.datasheets.get(u.datasheetId)));
  if (chief) list = { ...list, units: list.units.map((u) => ({ ...u, warlord: u.uid === chief.uid })) };
  return list;
}
export function removeUnit(list: ArmyList, uid: string): ArmyList {
  return {
    ...list,
    // also detach any leader that was attached to the removed unit
    units: list.units
      .filter((u) => u.uid !== uid)
      .map((u) => (u.attachedTo === uid ? { ...u, attachedTo: undefined } : u)),
  };
}
function patch(list: ArmyList, uid: string, fn: (u: ListUnit) => ListUnit): ArmyList {
  return { ...list, units: list.units.map((u) => (u.uid === uid ? fn(u) : u)) };
}
export function setModelCount(list: ArmyList, uid: string, modelCount: number): ArmyList {
  return patch(list, uid, (u) => ({ ...u, modelCount }));
}
export function setEnhancement(list: ArmyList, uid: string, enhancementId?: string): ArmyList {
  return patch(list, uid, (u) => ({ ...u, enhancementId: enhancementId || undefined }));
}
export function setAttachedTo(list: ArmyList, uid: string, attachedTo?: string): ArmyList {
  return patch(list, uid, (u) => ({ ...u, attachedTo: attachedTo || undefined }));
}
/** Make `uid` the sole Warlord. */
export function setWarlord(list: ArmyList, uid: string): ArmyList {
  return { ...list, units: list.units.map((u) => ({ ...u, warlord: u.uid === uid })) };
}
/** Set how many models in a unit carry a given wargear item (0 removes it). */
export function setLoadoutCount(list: ArmyList, uid: string, item: string, count: number): ArmyList {
  return patch(list, uid, (u) => {
    const loadout: Loadout = { ...(u.loadout ?? {}) };
    if (count <= 0) delete loadout[item];
    else loadout[item] = count;
    return { ...u, loadout: Object.keys(loadout).length ? loadout : undefined };
  });
}

// ── validation ───────────────────────────────────────────────────────────────
export type Severity = 'error' | 'warning';
export interface Violation {
  severity: Severity;
  message: string;
  uid?: string;
}

export function validate(list: ArmyList, ix: DataIndex): Violation[] {
  // A boxed Combat Patrol is pre-validated by the box: fixed units, sizes and wargear; the
  // patrol datasheets carry no points/enhancement catalog, so the standard checks don't apply.
  if (list.combatPatrol) {
    const v: Violation[] = [];
    if (!list.detachment) v.push({ severity: 'error', message: 'Pick one of the four Combat Patrols.' });
    return v;
  }
  const v: Violation[] = [];
  const rule = BATTLE_SIZES[list.battleSize];
  const total = listPoints(list, ix);

  if (total > rule.points) {
    v.push({ severity: 'error', message: `Over points: ${total} / ${rule.points} (${total - rule.points} over).` });
  }
  if (!list.detachment) {
    v.push({ severity: 'error', message: 'No detachment selected — enhancements and stratagems are detachment-scoped.' });
  } else {
    // Detachment Points (11e): a lone detachment over the budget is legal by GW's stated
    // lone-detachment allowance (not yet errata'd) — surface it as a warning, not an error.
    const dp = checkDetachmentPoints(list.detachment, list.faction, rule.points);
    if (dp.overBudgetLone) {
      v.push({
        severity: 'warning',
        message: `${list.detachment} costs ${dp.cost} DP — over the ${dp.budget.dp} DP budget at ${rule.points} pts. Legal as a lone detachment (GW stated intent, pending errata).`,
      });
    }
  }

  let warlords = 0;
  const enhUsed = new Map<string, number>();
  const dsCounts = new Map<string, number>();

  for (const u of list.units) {
    const ds = ix.datasheets.get(u.datasheetId);
    if (!ds) {
      v.push({ severity: 'error', uid: u.uid, message: `Unknown datasheet ${u.datasheetId}.` });
      continue;
    }
    dsCounts.set(u.datasheetId, (dsCounts.get(u.datasheetId) ?? 0) + 1);
    if (u.warlord) warlords++;

    if (ds.points && ds.points.length > 0 && !ds.points.some((t) => t.models === u.modelCount)) {
      v.push({
        severity: 'error',
        uid: u.uid,
        message: `${ds.name}: ${u.modelCount} models has no points value (valid: ${modelCountOptions(ds).join(', ')}).`,
      });
    }

    // Wargear option caps (e.g. "2 thunder hammers per 5 models").
    for (const lv of validateUnitLoadout(ds, u.modelCount, u.loadout)) {
      v.push({ severity: 'error', uid: u.uid, message: lv.message });
    }

    if (u.enhancementId) {
      enhUsed.set(u.enhancementId, (enhUsed.get(u.enhancementId) ?? 0) + 1);
      const enh = ix.enhancements.get(u.enhancementId);
      if (!enh) {
        v.push({ severity: 'error', uid: u.uid, message: `${ds.name}: unknown enhancement.` });
      } else {
        if (!isCharacter(ds)) {
          v.push({ severity: 'error', uid: u.uid, message: `${ds.name} is not a Character and cannot take an enhancement.` });
        }
        if (isEpicHero(ds)) {
          v.push({ severity: 'error', uid: u.uid, message: `${ds.name} is an Epic Hero and cannot take an enhancement.` });
        }
        if (list.detachment && enh.detachment && enh.detachment !== list.detachment) {
          v.push({ severity: 'error', uid: u.uid, message: `Enhancement "${enh.name}" is from ${enh.detachment}, not ${list.detachment}.` });
        }
      }
    }
  }

  // 11e: the enhancement budget scales with battle size (2 at 1000 pts, 4 at 2000 pts).
  const totalEnh = [...enhUsed.values()].reduce((a, b) => a + b, 0);
  const enhMax = dpBudget(rule.points).enhancements;
  if (totalEnh > enhMax) v.push({ severity: 'error', message: `Too many enhancements: ${totalEnh} (max ${enhMax} at ${rule.points} pts).` });
  for (const [id, c] of enhUsed) {
    if (c > 1) v.push({ severity: 'error', message: `Enhancement "${ix.enhancements.get(id)?.name ?? id}" used ${c} times (max once).` });
  }

  for (const [id, c] of dsCounts) {
    const ds = ix.datasheets.get(id)!;
    if (isEpicHero(ds)) {
      if (c > 1) v.push({ severity: 'error', message: `${ds.name} is an Epic Hero — only 1 allowed (have ${c}).` });
    } else {
      const max = isBattleline(ds) ? rule.battlelineMax : rule.otherMax;
      if (c > max) {
        v.push({ severity: 'error', message: `${ds.name}: ${c} copies exceeds the limit of ${max} for ${list.battleSize}.` });
      }
    }
  }

  if (list.units.length > 0 && warlords === 0) {
    v.push({ severity: 'warning', message: 'No Warlord selected — pick one Character to be your Warlord.' });
  }
  if (warlords > 1) v.push({ severity: 'error', message: `${warlords} Warlords selected (exactly 1 allowed).` });

  return v;
}

// ── export to the Roster shape the board/loaders already understand ──────────
/**
 * Resolve a unit's full wargear counts for the game: the chosen loadout, plus any defensive
 * wargear baked into the datasheet's *default* loadout (e.g. one Navis Armsman's Endurant Shield)
 * that the builder never asks about. This is what the board needs to assign per-model saves.
 */
export function resolveWargearCounts(ds: Datasheet | undefined, unit: ListUnit): Loadout {
  const counts: Loadout = { ...(unit.loadout ?? {}) };
  if (ds?.loadout) {
    for (const item of defensiveItemsInText(ds.loadout)) {
      if (counts[item] == null) counts[item] = 1; // the default loadout fields exactly one bearer
    }
  }
  return counts;
}

export function toRoster(list: ArmyList, ix: DataIndex): Roster {
  return {
    name: list.name,
    faction: list.faction,
    detachment: list.detachment,
    ...(list.combatPatrol ? { combatPatrol: true } : {}),
    points: listPoints(list, ix),
    units: list.units.map((u) => {
      const wargearCounts = resolveWargearCounts(ix.datasheets.get(u.datasheetId), u);
      return {
        datasheetId: u.datasheetId,
        modelCount: u.modelCount,
        ...(Object.keys(wargearCounts).length ? { wargearCounts } : {}),
        ...(u.enhancementId ? { enhancementId: u.enhancementId } : {}),
        ...(u.attachedTo ? { attachedCharacterId: u.attachedTo } : {}),
      };
    }),
  };
}
