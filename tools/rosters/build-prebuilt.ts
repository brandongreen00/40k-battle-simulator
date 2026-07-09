// Generate data/rosters/prebuilt_*.json from tools/rosters/prebuilt.ts.
//
//   pnpm build:rosters
//
// Each list is validated against the army engine (points, copy limits, Epic Hero uniqueness,
// Warlord) and the script FAILS if any list has an error — an illegal prebuilt list can never
// land in the repo. Output is the same `Roster` shape the board loads (toRoster), with wargear
// counts resolved so per-model saves (shields etc.) work in-game.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Datasheet, Enhancement } from '../../src/core/types';
import { listPoints, toRoster, validate, type DataIndex } from '../../src/core/army';
import { PREBUILT, PREBUILT_NOTE } from './prebuilt';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const datasheets = JSON.parse(readFileSync(join(root, 'data/game/datasheets.json'), 'utf-8')) as Datasheet[];
const enhancements = JSON.parse(readFileSync(join(root, 'data/game/enhancements.json'), 'utf-8')) as Enhancement[];
const ix: DataIndex = {
  datasheets: new Map(datasheets.map((d) => [d.id, d])),
  enhancements: new Map(enhancements.map((e) => [e.id, e])),
};

const outDir = join(root, 'data/rosters');
mkdirSync(outDir, { recursive: true });

let failed = false;
for (const { fileName, list, recommended } of PREBUILT) {
  const violations = validate(list, ix).filter((v) => v.severity === 'error');
  const points = listPoints(list, ix);
  if (violations.length > 0) {
    failed = true;
    console.error(`✗ ${list.name}: ${points} pts — ILLEGAL`);
    for (const v of violations) console.error(`    ${v.message}`);
    continue;
  }
  const roster = { ...toRoster(list, ix), note: PREBUILT_NOTE, ...(recommended ? { recommended } : {}) };
  const path = join(outDir, `${fileName}.json`);
  writeFileSync(path, JSON.stringify(roster, null, 2) + '\n');
  console.log(`✓ ${list.name}: ${points} pts, ${list.units.length} units → data/rosters/${fileName}.json`);
}

if (failed) {
  console.error('\nOne or more prebuilt lists are illegal — nothing partial was kept for them.');
  process.exit(1);
}
