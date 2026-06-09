/**
 * Generate human-readable per-unit ability references for the two owned factions, straight from the
 * converted datasheet data. One file per faction, units grouped by battlefield role, each listing
 * its *special* rules (the per-unit specials we wire into the ability system) plus a compact line of
 * its Core/Faction abilities.
 *
 * Run with:  pnpm report:abilities   (or: tsx tools/ingest/abilities-report.ts)
 *
 * Output (committed, personal-use only — GW IP): docs/lists/<faction>_unit_abilities.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Datasheet } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const datasheets = JSON.parse(readFileSync(resolve(REPO, 'data/game/datasheets.json'), 'utf8')) as Datasheet[];

const FACTIONS: { id: string; name: string; file: string }[] = [
  { id: 'AM', name: 'Astra Militarum', file: 'astra_militarum_unit_abilities.md' },
  { id: 'AoI', name: 'Imperial Agents (Imperialis Fleet)', file: 'imperial_agents_unit_abilities.md' },
];

// Ability types that are genuinely unit-specific (vs. the universal Core/Faction wording).
const SPECIAL_TYPES = new Set(['Datasheet', 'Special', 'Primarch', 'Fortification']);
const WARGEAR_TYPES = new Set(['Wargear', 'Wargear profile']);

const pts = (ds: Datasheet): string => {
  const tiers = ds.points ?? [];
  if (tiers.length === 0) return '';
  if (tiers.length === 1) return ` — ${tiers[0]!.cost} pts`;
  return ` — ${tiers.map((t) => `${t.models}:${t.cost}`).join(' / ')} pts`;
};

for (const fac of FACTIONS) {
  const units = datasheets.filter((d) => d.faction === fac.id).sort((a, b) => (a.role ?? '').localeCompare(b.role ?? '') || a.name.localeCompare(b.name));
  const byRole = new Map<string, Datasheet[]>();
  for (const u of units) {
    const role = u.role || 'Other';
    (byRole.get(role) ?? byRole.set(role, []).get(role)!).push(u);
  }

  const out: string[] = [];
  out.push(`# ${fac.name} — unit special abilities`);
  out.push('');
  out.push(`> Auto-generated from the converted Wahapedia data (\`pnpm report:abilities\`). Personal-use only — all 40k rules/IP belong to Games Workshop. ${units.length} datasheets.`);
  out.push('');

  for (const [role, list] of [...byRole.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`## ${role} (${list.length})`);
    out.push('');
    for (const u of list) {
      const abilities = u.abilities ?? [];
      const specials = abilities.filter((a) => SPECIAL_TYPES.has(a.type ?? ''));
      const wargear = abilities.filter((a) => WARGEAR_TYPES.has(a.type ?? ''));
      const generic = abilities.filter((a) => a.type === 'Core' || a.type === 'Faction').map((a) => a.name);

      out.push(`### ${u.name}${pts(u)}`);
      if (generic.length) out.push(`*Abilities:* ${generic.join(', ')}`);
      for (const a of specials) out.push(`- **${a.name}** — ${a.description}`);
      for (const a of wargear) out.push(`- *(wargear)* **${a.name}** — ${a.description}`);
      if (specials.length === 0 && wargear.length === 0 && generic.length === 0) out.push('- *(no abilities listed)*');
      out.push('');
    }
  }

  const dest = resolve(REPO, 'docs/lists', fac.file);
  writeFileSync(dest, out.join('\n'), 'utf8');
  console.log(`Wrote ${dest} (${units.length} units)`);
}
