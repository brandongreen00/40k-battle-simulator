// Data loaders: read the committed JSON under data/* into typed objects.
// These are the only place the app touches the on-disk data; everything else uses the types.

import type { Datasheet, Enhancement, Layout, Roster } from '../core/types';
import type { DataIndex } from '../core/army';
import { deployAbilityFromKeywords, type DeployAbility } from '../core/deployment';
import datasheetsJson from '../../data/game/datasheets.json';
import enhancementsJson from '../../data/game/enhancements.json';
import abilitiesJson from '../../data/game/abilities.json';

export const datasheets = datasheetsJson as unknown as Datasheet[];

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

/** Resolve a datasheet's referenced ability names (from its abilityIds). */
export function abilityNamesFor(ds: Datasheet): string[] {
  return (ds.abilityIds ?? []).map((id) => abilityNameById.get(id) ?? '').filter(Boolean);
}

/** A datasheet's deployment ability (standard / infiltrators / deep_strike), from keywords + abilities. */
export function deployAbilityForDatasheet(ds: Datasheet): DeployAbility {
  return deployAbilityFromKeywords(ds.keywords, abilityNamesFor(ds));
}

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
export const layouts: Layout[] = Object.values(layoutModules).map((m) => m.default);
