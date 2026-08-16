/**
 * Apply the 11th-edition points / cost patch on top of the 10e-CSV ingest output.
 *
 * `pnpm ingest` still converts the Wahapedia 10e CSV exports (Wahapedia never published 11e
 * CSVs — the 11e data is HTML-only), so datasheet stats come from 10e while POINTS, priced
 * wargear and enhancement costs are 11e values extracted from the wh40k11ed faction pages
 * into `tools/ingest/points11e.json`. This script overwrites those fields in
 * `data/game/datasheets.json` + `data/game/enhancements.json`. Run it after every ingest:
 *
 *   pnpm ingest && pnpm apply:points11e
 *
 * Matching is by (faction, datasheet name) — the 11e pages carry the same unit names as the
 * 10e data (verified: all 180 sheets match; the one 11e-only sheet, Tarantula Battery, is
 * omitted from the patch file). Enhancements match by (detachment, normalized name).
 * Detachment DP costs live in src/core/detachments.ts (typed table), not here — the
 * `detachments` block in points11e.json is the provenance record for that table.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Datasheet, Enhancement, PointsTier, WargearCost } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const GAME_DIR = resolve(REPO_ROOT, 'data/game');

interface PatchFile {
  source: string;
  packVersion: string;
  retrieved: string;
  detachments: { faction: string; name: string; dp: number; disposition: string }[];
  enhancements: { faction: string; detachment: string; name: string; cost: number }[];
  datasheets: { faction: string; name: string; points: PointsTier[]; wargearCosts?: WargearCost[] }[];
  /** Full records for 11e-ONLY enhancements/Upgrades whose detachments have no 10e counterpart
   *  (Abhuman Auxiliaries, Designation Force) — upserted into enhancements.json by id.
   *  Recon Star's bearer filter uses REGIMENT as the 10e-data stand-in for the 11e PLATOON
   *  keyword (the 10e CSVs carry no PLATOON). */
  addEnhancements?: Enhancement[];
}

/** Fold case, unicode punctuation and whitespace so "Priority-drop Beacon" = "Priority drop Beacon". */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const patch: PatchFile = JSON.parse(readFileSync(resolve(HERE, 'points11e.json'), 'utf8'));
const datasheets: Datasheet[] = JSON.parse(readFileSync(resolve(GAME_DIR, 'datasheets.json'), 'utf8'));
const enhancements: Enhancement[] = JSON.parse(readFileSync(resolve(GAME_DIR, 'enhancements.json'), 'utf8'));

// ── datasheet points + priced wargear ────────────────────────────────────────
const byName = new Map(datasheets.map((d) => [`${d.faction}|${norm(d.name)}`, d]));
let patched = 0;
const unmatched: string[] = [];
for (const p of patch.datasheets) {
  const ds = byName.get(`${p.faction}|${norm(p.name)}`);
  if (!ds) {
    unmatched.push(`${p.faction} ${p.name}`);
    continue;
  }
  ds.points = p.points;
  if (p.wargearCosts) ds.wargearCosts = p.wargearCosts;
  else delete ds.wargearCosts;
  patched++;
}

// ── enhancement costs ────────────────────────────────────────────────────────
const enhCost = new Map(patch.enhancements.map((e) => [`${norm(e.detachment)}|${norm(e.name)}`, e.cost]));
let enhPatched = 0;
const enhNo11e: string[] = [];
for (const e of enhancements) {
  const cost = enhCost.get(`${norm(e.detachment)}|${norm(e.name)}`);
  if (cost == null) {
    // 10e leftovers (Grotmas detachments) and the two Bridgehead enhancements the 11e pack
    // dropped — costs left as-is; they are unreachable/no-op under the 11e detachment list.
    enhNo11e.push(`${e.detachment} | ${e.name}`);
    continue;
  }
  if (e.cost !== cost) enhPatched++;
  e.cost = cost;
}

// ── 11e-only enhancement/Upgrade records (no 10e counterpart) — upsert by id ─
let enhAdded = 0;
for (const rec of patch.addEnhancements ?? []) {
  const at = enhancements.findIndex((e) => e.id === rec.id);
  if (at === -1) {
    enhancements.push(rec);
    enhAdded++;
  } else {
    enhancements[at] = rec;
  }
}

writeFileSync(resolve(GAME_DIR, 'datasheets.json'), JSON.stringify(datasheets, null, 2) + '\n', 'utf8');
writeFileSync(resolve(GAME_DIR, 'enhancements.json'), JSON.stringify(enhancements, null, 2) + '\n', 'utf8');

console.log(`points11e (${patch.packVersion}, retrieved ${patch.retrieved})`);
console.log(`  datasheets patched: ${patched}/${datasheets.length}`);
if (unmatched.length) console.log(`  ⚠ 11e sheets with no 10e datasheet (skipped): ${unmatched.join(', ')}`);
console.log(`  enhancement costs changed: ${enhPatched} (matched ${enhancements.length - enhNo11e.length}/${enhancements.length})`);
console.log(`  11e-only enhancement records upserted: ${(patch.addEnhancements ?? []).length} (${enhAdded} new)`);
if (enhNo11e.length) console.log(`  no 11e price (left as-is):\n    ${enhNo11e.join('\n    ')}`);
if (patched !== patch.datasheets.length) {
  process.exitCode = 1;
  console.error('  ✗ some 11e patch entries did not match — investigate before committing.');
}
