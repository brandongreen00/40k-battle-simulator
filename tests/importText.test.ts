// The text-export → roster import pipeline (tools/rosters/import-text.ts) and the two
// committed rosters it produced: the owner's "Bane" and "Rogue Trader's Army" lists.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeExport } from '../tools/rosters/import-text';
import { parseArmyText } from '../src/core/importer';
import { validate, listPoints, toRoster } from '../src/core/army';
import { dataIndex } from '../src/data/loaders';
import type { Roster } from '../src/core/types';

const root = join(__dirname, '..');
const deps = {
  datasheets: [...dataIndex.datasheets.values()],
  enhancements: [...dataIndex.enhancements.values()],
};

describe('normalizeExport', () => {
  it('re-bullets glyphless "Nx item" continuation lines as siblings of the previous bullet', () => {
    const text = ['Unit (10 points)', '  • 1x Bale Eye', '    1x Laspistol', '    2x Power sword'].join('\n');
    expect(normalizeExport(text).split('\n')).toEqual([
      'Unit (10 points)',
      '  • 1x Bale Eye',
      '  • 1x Laspistol',
      '  • 2x Power sword',
    ]);
  });

  it('does not attach continuations across a header line and leaves intact exports unchanged', () => {
    const headerReset = ['  • 1x Lasgun', 'OTHER DATASHEETS', '  1x Heavy mortar'].join('\n');
    expect(normalizeExport(headerReset).split('\n')[2]).toBe('  1x Heavy mortar');

    const intact = ['List (985 Points)', '  • 1x Neural shredder', '     ◦ 1x Dartmask'].join('\n');
    expect(normalizeExport(intact)).toBe(intact);
  });
});

describe('imported owner lists', () => {
  const cases = [
    { txt: 'bane.txt', json: 'bane.json', name: 'Bane', units: 7, points: 985 },
    { txt: 'rogue_traders_army.txt', json: 'rogue_traders_army.json', name: 'Rogue Trader’s Army', units: 10, points: 985 },
  ];

  for (const c of cases) {
    it(`${c.name}: parses with no warnings, is legal, and the committed JSON is in sync`, () => {
      const text = readFileSync(join(root, 'tools', 'rosters', 'imports', c.txt), 'utf-8');
      const { list, warnings } = parseArmyText(normalizeExport(text), deps);
      expect(warnings).toEqual([]);
      expect(list.name).toBe(c.name);
      expect(list.units).toHaveLength(c.units);
      expect(listPoints(list, dataIndex)).toBe(c.points);

      const errors = validate(list, dataIndex).filter((v) => v.severity === 'error');
      expect(errors, errors.map((e) => e.message).join('; ')).toEqual([]);

      // Committed JSON == regenerating from the text (run `pnpm import:roster` after edits).
      const onDisk = JSON.parse(
        readFileSync(join(root, 'data', 'rosters', c.json), 'utf-8'),
      ) as Roster;
      const note = `Imported from the 40k-app text export ${c.txt} via pnpm import:roster.`;
      expect(onDisk).toEqual({ ...toRoster(list, dataIndex), note });
    });
  }

  it('Bane carries the full per-model wargear through normalization (the glyphless lines)', () => {
    const onDisk = JSON.parse(
      readFileSync(join(root, 'data', 'rosters', 'bane.json'), 'utf-8'),
    ) as Roster;
    const stormlord = onDisk.units.find((u) => u.wargearCounts?.['Vulcan mega-bolter']);
    expect(stormlord?.wargearCounts).toMatchObject({ Lascannon: 4, 'Twin heavy flamer': 4 });
    const dkok = onDisk.units.find((u) => u.wargearCounts?.['Plasma gun']);
    expect(dkok?.modelCount).toBe(10);
    expect(dkok?.wargearCounts).toMatchObject({ Lasgun: 7, 'Death Korps Medi-pack': 1 });
  });
});
