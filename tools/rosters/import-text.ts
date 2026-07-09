// Import an official 40k-app text export into data/rosters/ so the board and the
// headless simulator (`pnpm sim`) can play it.
//
//   pnpm import:roster tools/rosters/imports/bane.txt
//   pnpm import:roster my-export.txt --out my_roster        # override the output file name
//
// Runs the pure core importer (src/core/importer.ts parseArmyText) on the file, validates the
// resulting list with the army engine, and writes the same `Roster` shape the prebuilt builder
// emits (toRoster, with wargear counts so per-model saves/weapons work in-game). Import warnings
// are printed; validation ERRORS abort without writing (an illegal roster never lands in the
// repo). Unresolvable units are warnings from the importer — never invented.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Datasheet, Enhancement } from '../../src/core/types';
import { listPoints, toRoster, validate, type DataIndex } from '../../src/core/army';
import { parseArmyText } from '../../src/core/importer';
import { DISPOSITIONS } from '../../src/core/missions11';
import { profileForDisposition } from '../../src/core/ai/profile';
import { repoRoot } from '../sim/data';

/**
 * Repair bullet glyphs lost in copy-paste: an indented "Nx item" line with no glyph is a
 * continuation of the previous bulleted line — re-emit it as a sibling (same indent + glyph),
 * e.g. Bane's "• 1x Bale Eye" followed by "    1x Laspistol". Headers reset the carry so a
 * stray line can never attach across units. Exports with intact glyphs pass through unchanged.
 */
export function normalizeExport(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let lastBulletPrefix: string | undefined;
  return lines
    .map((line) => {
      const bullet = line.match(/^(\s*)([•◦‣▪·*-])\s/u);
      if (bullet) {
        lastBulletPrefix = `${bullet[1]}${bullet[2]} `;
        return line;
      }
      const continuation = line.match(/^\s+(\d+x\s+.+)$/);
      if (continuation && lastBulletPrefix) return lastBulletPrefix + continuation[1];
      if (line.trim().length > 0) lastBulletPrefix = undefined; // header/section line
      return line;
    })
    .join('\n');
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

function main(): void {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let outName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outName = argv[++i];
    else files.push(argv[i]!);
  }
  if (files.length === 0) {
    console.error('Usage: pnpm import:roster <export.txt> [--out file_name]');
    process.exit(1);
  }

  const datasheets = JSON.parse(
    readFileSync(join(repoRoot, 'data/game/datasheets.json'), 'utf-8'),
  ) as Datasheet[];
  const enhancements = JSON.parse(
    readFileSync(join(repoRoot, 'data/game/enhancements.json'), 'utf-8'),
  ) as Enhancement[];
  const ix: DataIndex = {
    datasheets: new Map(datasheets.map((d) => [d.id, d])),
    enhancements: new Map(enhancements.map((e) => [e.id, e])),
  };

  const outDir = join(repoRoot, 'data/rosters');
  mkdirSync(outDir, { recursive: true });

  let failed = false;
  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    const { list, warnings, disposition } = parseArmyText(normalizeExport(text), { datasheets, enhancements });
    for (const w of warnings) console.warn(`  ⚠ ${w}`);

    const errors = validate(list, ix).filter((v) => v.severity === 'error');
    const points = listPoints(list, ix);
    if (errors.length > 0) {
      failed = true;
      console.error(`✗ ${list.name}: ${points} pts — ILLEGAL, not written`);
      for (const v of errors) console.error(`    ${v.message}`);
      continue;
    }

    // An 11e export names its Force Disposition — carry it as the roster's recommended pick.
    const dispId = disposition
      ? DISPOSITIONS.find((d) => d.name.toLowerCase() === disposition.toLowerCase())?.id
      : undefined;
    const roster = {
      ...toRoster(list, ix),
      ...(dispId ? { recommended: { disposition: dispId, profile: profileForDisposition(dispId) } } : {}),
      note: `Imported from the 40k-app text export ${basename(file)} via pnpm import:roster.`,
    };
    const fileName = `${outName ?? slug(list.name)}.json`;
    writeFileSync(join(outDir, fileName), JSON.stringify(roster, null, 2) + '\n');
    console.log(`✓ ${list.name}: ${points} pts, ${list.units.length} units → data/rosters/${fileName}`);
  }
  if (failed) process.exit(1);
}

// Only run as a CLI (vitest imports normalizeExport).
if (process.argv[1] && /import-text\.(ts|js)$/.test(process.argv[1])) main();
