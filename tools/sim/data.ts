// Node-side data loading for the headless simulator (fs, not Vite imports — `src/data/loaders.ts`
// uses import.meta.glob, which only exists in the browser build/test pipeline).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Datasheet, Layout, Roster } from '../../src/core/types';
import { deployAbilityFromKeywords } from '../../src/core/deployment';
import { CORE_STRATAGEMS, parseTurn, type Stratagem } from '../../src/core/stratagems';
import type { MatchData } from '../../src/core/ai/match';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(join(repoRoot, rel), 'utf-8')) as T;

interface AbilityRow { id: string; name: string }
interface StratagemRow {
  id: string; name: string; cp_cost?: string; turn?: string; phase?: string;
  detachment?: string; faction_id?: string; type?: string; description?: string;
}

export function loadMatchData(): MatchData {
  const datasheets = readJson<Datasheet[]>('data/game/datasheets.json');
  const abilities = readJson<AbilityRow[]>('data/game/abilities.json');
  const stratRows = readJson<StratagemRow[]>('data/game/stratagems.json');
  const abilityNameById = new Map(abilities.map((a) => [a.id, a.name]));

  const detachmentStratagems: Stratagem[] = stratRows.map((s) => ({
    id: s.id,
    name: s.name,
    cp: parseInt(s.cp_cost ?? '0', 10) || 0,
    phase: s.phase ?? 'Any phase',
    turn: parseTurn(s.turn ?? 'Your turn'),
    detachment: s.detachment,
    faction: s.faction_id,
    type: s.type,
  }));

  return {
    ctx: { datasheets: new Map(datasheets.map((d) => [d.id, d])) },
    deployAbility: (ds: Datasheet) => {
      const names = ds.abilities?.length
        ? ds.abilities.map((a) => a.name)
        : (ds.abilityIds ?? []).map((id) => abilityNameById.get(id) ?? '');
      return deployAbilityFromKeywords(ds.keywords, names);
    },
    stratagems: [...CORE_STRATAGEMS, ...detachmentStratagems],
  };
}

/** All rosters that can actually field an army (units present), playable in the sim. */
export function loadRosters(): Roster[] {
  const dir = join(repoRoot, 'data/rosters');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Roster)
    .filter((r) => r.units.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadLayouts(): Layout[] {
  const dir = join(repoRoot, 'data/layouts');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Layout)
    .sort((a, b) => a.id.localeCompare(b.id));
}
