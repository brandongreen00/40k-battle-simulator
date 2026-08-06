// Data loaders: read the committed JSON under data/* into typed objects.
// These are the only place the app touches the on-disk data; everything else uses the types.

import type { Datasheet, Enhancement, Layout, Roster } from '../core/types';
import type { DataIndex } from '../core/army';
import { deployAbilityFromKeywords, type DeployAbility } from '../core/deployment';
import { CORE_STRATAGEMS, DETACHMENT_STRAT_EFFECTS, parseTurn, type Stratagem } from '../core/stratagems';
import datasheetsJson from '../../data/game/datasheets.json';
import cpDatasheetsJson from '../../data/game/cp_datasheets.json';
import cpPatrolsJson from '../../data/game/cp_patrols.json';
import enhancementsJson from '../../data/game/enhancements.json';
import abilitiesJson from '../../data/game/abilities.json';
import stratagemsJson from '../../data/game/stratagems.json';

// The Combat Patrol datasheets (tools/combatpatrol) join the Wahapedia-converted ones — every
// engine path looks units up through this one list/map.
export const datasheets = [
  ...(datasheetsJson as unknown as Datasheet[]),
  ...(cpDatasheetsJson as unknown as Datasheet[]),
];

export const datasheetsById: Map<string, Datasheet> = new Map(
  datasheets.map((d) => [d.id, d]),
);

export function getDatasheet(id: string): Datasheet | undefined {
  return datasheetsById.get(id);
}

export const enhancements = enhancementsJson as unknown as Enhancement[];
export const enhancementsById: Map<string, Enhancement> = new Map(
  enhancements.map((e) => [e.id, e]),
);

// ── Abilities (used to resolve deployment specials: Infiltrators / Deep Strike / Scouts) ──
interface AbilityRow { id: string; name: string; description?: string }
export const abilities = abilitiesJson as unknown as AbilityRow[];
const abilityNameById = new Map(abilities.map((a) => [a.id, a.name]));

/** Resolve a datasheet's ability names — from the full ability list when present, else abilityIds. */
export function abilityNamesFor(ds: Datasheet): string[] {
  if (ds.abilities?.length) return ds.abilities.map((a) => a.name).filter(Boolean);
  return (ds.abilityIds ?? []).map((id) => abilityNameById.get(id) ?? '').filter(Boolean);
}

/** A datasheet's deployment ability (standard / infiltrators / deep_strike), from keywords + abilities. */
export function deployAbilityForDatasheet(ds: Datasheet): DeployAbility {
  return deployAbilityFromKeywords(ds.keywords, abilityNamesFor(ds));
}

// ── Stratagems: Core (universal) + the detachment-scoped ones from the data ──
interface StratagemRow {
  id: string; name: string; faction_id?: string; type?: string; cp_cost?: string;
  turn?: string; phase?: string; detachment?: string; legend?: string; description?: string;
}
const stratRows = stratagemsJson as unknown as StratagemRow[];
const detachmentStratagems: Stratagem[] = stratRows.map((s) => ({
  id: s.id,
  name: s.name,
  cp: parseInt(s.cp_cost ?? '0', 10) || 0,
  phase: s.phase ?? 'Any phase',
  turn: parseTurn(s.turn ?? 'Your turn'),
  detachment: s.detachment,
  faction: s.faction_id,
  type: s.type,
  text: (s.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  ...(DETACHMENT_STRAT_EFFECTS[s.name.toUpperCase()]
    ? { effectId: DETACHMENT_STRAT_EFFECTS[s.name.toUpperCase()]! }
    : {}),
}));

// ── Combat Patrol stratagems (each patrol's three, from tools/combatpatrol) ──
// detachment = the patrol name (CP rosters carry it), so the standard detachment filter scopes
// them to their patrol; battleType gating (Core bans) lives in usableStratagems.
interface CpPatrolRaw {
  id: string;
  name: string;
  faction: string;
  stratagems: { name: string; cp?: number; when?: string; target?: string; effect?: string }[];
}
const cpSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const CP_STRAT_META: Record<string, { phase: string; turn: 'either' | 'your' | 'opponent'; effectId?: string; note?: string }> = {
  // Crowe's Sanctifiers
  'Exigent Assignments': { phase: 'Fight phase', turn: 'either', effectId: 'cp:consolidate_extended' },
  'Refusal to Yield': { phase: 'Shooting phase', turn: 'opponent', effectId: 'cp:wound_shield_strong' },
  'Psi-reactive Ammunition': { phase: 'Shooting phase', turn: 'your', effectId: 'cp:psychic_ammo' },
  // Inquisitor's Hand
  'Urban Enforcers': { phase: 'Shooting or Fight phase', turn: 'either', effectId: 'cp:ap_shield', note: '(Play on your unit when it is targeted with every model within a terrain area.)' },
  'Superior Weaponry': { phase: 'Shooting or Fight phase', turn: 'either', effectId: 'cp:ap_boost' },
  'Inquisitorial Mandate': { phase: 'Movement phase', turn: 'your', effectId: 'cp:secure_objective' },
  // Sudden Dawn Cadre
  'Suppressing Fire': { phase: 'Shooting phase', turn: 'your', effectId: 'cp:pin' },
  'Rapid Acquisition': { phase: 'Movement phase', turn: 'your', effectId: 'cp:secure_objective' },
  'Swift Embarkation': { phase: 'Fight phase', turn: 'opponent', effectId: 'cp:swift_embark' },
  // The Vengeful Brethren
  'For the Lion': { phase: 'Command phase', turn: 'either', effectId: 'cp:oc_plus1' },
  'Mission Focus': { phase: 'Shooting or Fight phase', turn: 'either', effectId: 'cp:plus1_hit', note: '(The "within range of an objective" condition is checked when you play it, not per attack.)' },
  'Determined to the Last': { phase: 'Fight phase', turn: 'either', note: '(Fights-on-death is not automated yet — resolve manually.)' },
};
export const patrolStratagems: Stratagem[] = (cpPatrolsJson as unknown as CpPatrolRaw[]).flatMap((p) =>
  p.stratagems.map((s) => {
    const meta = CP_STRAT_META[s.name] ?? { phase: 'Any phase', turn: 'either' as const };
    return {
      id: `cp:${p.id}:${cpSlug(s.name)}`,
      name: s.name,
      cp: s.cp ?? 1,
      phase: meta.phase,
      turn: meta.turn,
      detachment: p.name,
      faction: p.faction,
      type: 'Combat Patrol',
      text: [
        s.when ? `When: ${s.when}` : '',
        s.target ? `Target: ${s.target}` : '',
        s.effect ? `Effect: ${s.effect}` : '',
        meta.note ?? '',
      ]
        .filter(Boolean)
        .join(' '),
      ...(meta.effectId ? { effectId: meta.effectId } : {}),
    };
  }),
);

/** Core stratagems + every detachment stratagem from the data + the Combat Patrol sets. */
export const stratagems: Stratagem[] = [...CORE_STRATAGEMS, ...detachmentStratagems, ...patrolStratagems];

/** The lookup bundle the pure army engine expects. */
export const dataIndex: DataIndex = {
  datasheets: datasheetsById,
  enhancements: enhancementsById,
};

/** Distinct detachment names available for a faction (from the enhancement catalog). */
export function detachmentsForFaction(faction: string): string[] {
  return [
    ...new Set(
      enhancements.filter((e) => e.faction === faction && e.detachment).map((e) => e.detachment),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/** Enhancements offered by a given detachment. */
export function enhancementsForDetachment(detachment: string): Enhancement[] {
  return enhancements
    .filter((e) => e.detachment === detachment)
    .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
}

// Rosters and layouts are small and may grow in number — load them all via glob.
const rosterModules = import.meta.glob<{ default: Roster }>('../../data/rosters/*.json', {
  eager: true,
});
export const rosters: Roster[] = Object.values(rosterModules)
  .map((m) => m.default)
  // Real owned lists first (alphabetical), demo/sample rosters last.
  .sort((a, b) => Number(a.sample ?? false) - Number(b.sample ?? false) || a.name.localeCompare(b.name));

const layoutModules = import.meta.glob<{ default: Layout }>('../../data/layouts/*.json', {
  eager: true,
});
const legacyLayouts: Layout[] = Object.values(layoutModules).map((m) => m.default);

// ── 11e Event Companion layouts (data/layouts11, produced by tools/layouts11) ──
interface Ec11Raw {
  id: string;
  page: number;
  boardWidth: number;
  boardHeight: number;
  attackerEdge?: 'top' | 'bottom' | 'left' | 'right';
  layoutLetter: string;
  source: string;
  players: { disposition: string; mission: string }[];
  deploymentZones: { attacker: number[][][]; defender: number[][][] };
  territoryDivider: number[][] | null;
  terrainAreas: {
    id: string;
    polygon: number[][];
    features: { kind: 'dense' | 'light'; polygon: number[][]; letter?: string }[];
  }[];
  objectives: { kind: 'home' | 'central' | 'expansion'; owner?: 'attacker' | 'defender'; pos: number[]; areaId?: string }[];
  areaMarkers: { kind: 'single' | 'separate'; pos: number[] }[];
}

const v = (p: number[]) => ({ x: p[0]!, y: p[1]! });
const poly = (pts: number[][]) => pts.map(v);

const dispSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** Distance from a point to a polygon's nearest vertex (cheap "which areas does this marker join"). */
function polyDist(p: { x: number; y: number }, pts: { x: number; y: number }[]): number {
  return Math.min(...pts.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
}

function convertEc11(raw: Ec11Raw): Layout {
  const areas = raw.terrainAreas.map((a) => ({
    id: a.id,
    polygon: poly(a.polygon),
    features: a.features.map((f) => ({ kind: f.kind, polygon: poly(f.polygon), ...(f.letter ? { letter: f.letter } : {}) })),
  }));

  // "Single terrain area" eye markers merge the two nearest footprints into one rules-area.
  const parent = new Map<string, string>(areas.map((a) => [a.id, a.id]));
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const m of raw.areaMarkers) {
    if (m.kind !== 'single') continue;
    const at = v(m.pos);
    const near = [...areas].sort((a, b) => polyDist(at, a.polygon) - polyDist(at, b.polygon)).slice(0, 2);
    if (near.length === 2) parent.set(find(near[0]!.id), find(near[1]!.id));
  }
  const groupSize = new Map<string, number>();
  for (const a of areas) groupSize.set(find(a.id), (groupSize.get(find(a.id)) ?? 0) + 1);
  const grouped = areas.map((a) => {
    const root = find(a.id);
    return (groupSize.get(root) ?? 1) > 1 ? { ...a, groupId: root } : a;
  });

  const finalAreas = grouped;
  const objectivePoints = raw.objectives.map((o) => ({
    pos: v(o.pos),
    kind: o.kind,
    ...(o.owner ? { owner: o.owner } : {}),
    ...(o.areaId ? { areaId: o.areaId } : {}),
  }));

  const [pA, pB] = raw.players;
  return {
    id: raw.id,
    name: `${pA?.disposition ?? '?'} vs ${pB?.disposition ?? '?'} — Layout ${raw.layoutLetter}`,
    boardWidth: raw.boardWidth,
    boardHeight: raw.boardHeight,
    deployment: `${pA?.disposition ?? '?'} vs ${pB?.disposition ?? '?'}`,
    deploymentId: raw.id.replace(/-[abc]$/, ''),
    source: raw.source,
    // Features double as legacy terrain pieces so old render/AI paths keep working.
    terrain: finalAreas.flatMap((a) =>
      a.features.map((f, i) => ({
        id: `${a.id}-f${i}`,
        type: (f.kind === 'dense' ? 'ruin_blocking' : 'area_cover') as Layout['terrain'][number]['type'],
        polygon: f.polygon,
        height: (f.kind === 'dense' ? 'tall' : 'low') as 'tall' | 'low',
      })),
    ),
    objectives: objectivePoints.map((o) => o.pos),
    objectiveMarkerDiameterIn: 1.575,
    objectiveControlRadiusIn: 3,
    // Loader convention: the ATTACKER's zone starts under `player` (the reducer swaps when the
    // roll-off makes the computer the Attacker).
    deploymentZones: {
      player: raw.deploymentZones.attacker[0] ? poly(raw.deploymentZones.attacker[0]) : [],
      opponent: raw.deploymentZones.defender[0] ? poly(raw.deploymentZones.defender[0]) : [],
    },
    terrainAreas: finalAreas,
    objectivePoints,
    ...(raw.territoryDivider
      ? { territoryDivider: [v(raw.territoryDivider[0]!), v(raw.territoryDivider[1]!)] as [Vec2Like, Vec2Like] }
      : {}),
    ...(raw.attackerEdge ? { attackerEdge: raw.attackerEdge } : {}),
    pairing: {
      dispositions: [dispSlug(pA?.disposition ?? ''), dispSlug(pB?.disposition ?? '')],
      missions: [pA?.mission ?? '', pB?.mission ?? ''],
      letter: raw.layoutLetter,
    },
  };
}

type Vec2Like = { x: number; y: number };

const ec11Modules = import.meta.glob<{ default: Ec11Raw }>('../../data/layouts11/ec2026-*.json', {
  eager: true,
});
export const layouts11: Layout[] = Object.values(ec11Modules)
  .map((m) => convertEc11(m.default))
  .sort((a, b) => a.id.localeCompare(b.id));

/** The three recommended layouts (A/B/C) for a disposition pairing (order-insensitive). */
export function layoutsForPairing(a: string, b: string): Layout[] {
  return layouts11.filter((l) => {
    const d = l.pairing?.dispositions;
    if (!d) return false;
    return (d[0] === a && d[1] === b) || (d[0] === b && d[1] === a);
  });
}

// ── Combat Patrol maps (data/layouts_cp, produced by tools/layouts_cp) ──
// Same raw shape as the Event Companion files plus `name`/`dividerMarkers`; no pairing.
interface CpRaw extends Omit<Ec11Raw, 'players' | 'page' | 'layoutLetter'> {
  name: string;
  dividerMarkers?: { pos: number[] }[];
  terrainAreas: (Ec11Raw['terrainAreas'][number] & { letter?: string })[];
}

function convertCp(raw: CpRaw): Layout {
  const base = convertEc11({ ...raw, page: 0, layoutLetter: '', players: [] });
  const { pairing: _pairing, ...rest } = base;
  return {
    ...rest,
    name: raw.name,
    deployment: 'Combat Patrol',
    deploymentId: raw.id,
    combatPatrol: true,
    // Preserve the printed ruin letters (AB/CD/EF/GH) the CP missions reference.
    terrainAreas: rest.terrainAreas?.map((a, i) => {
      const letter = raw.terrainAreas[i]?.letter;
      return letter ? { ...a, letter } : a;
    }),
    ...(raw.dividerMarkers?.length ? { dividerMarkers: raw.dividerMarkers.map((m) => v(m.pos)) } : {}),
  };
}

const cpModules = import.meta.glob<{ default: CpRaw }>('../../data/layouts_cp/cp*.json', {
  eager: true,
});
export const layoutsCp: Layout[] = Object.values(cpModules)
  .map((m) => convertCp(m.default))
  .sort((a, b) => a.id.localeCompare(b.id));

// ── Combat Patrol rosters + patrol meta ──
export interface PatrolMeta {
  id: string;
  name: string;
  faction: string;
  rules: { name: string; text: string }[];
  enhancements: { name: string; text: string }[];
  stratagems: { name: string; cp?: number; when?: string; target?: string; effect?: string; restrictions?: string }[];
  forceDispositions: string[];
}
export const patrols = cpPatrolsJson as unknown as PatrolMeta[];

/** The fixed Combat Patrol lists (the only rosters offered in a Combat Patrol battle). */
export function combatPatrolRosters(all: Roster[]): Roster[] {
  return all.filter((r) => r.combatPatrol);
}

/** 11e Event Companion layouts first, then Combat Patrol maps, then the legacy 10e maps. */
export const layouts: Layout[] = [...layouts11, ...layoutsCp, ...legacyLayouts];
