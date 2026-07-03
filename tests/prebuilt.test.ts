import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PREBUILT, PREBUILT_NOTE } from '../tools/rosters/prebuilt';
import { validate, listPoints, toRoster } from '../src/core/army';
import { dataIndex } from '../src/data/loaders';
import type { Roster } from '../src/core/types';

describe('prebuilt AI sparring lists', () => {
  it('there are at least 6 lists covering both factions', () => {
    expect(PREBUILT.length).toBeGreaterThanOrEqual(6);
    const factions = new Set(PREBUILT.map((p) => p.list.faction));
    expect(factions).toContain('AM');
    expect(factions).toContain('AoI');
  });

  for (const { fileName, list, recommended } of PREBUILT) {
    it(`${list.name} is a legal list at its battle size and the committed JSON is in sync`, () => {
      const errors = validate(list, dataIndex).filter((v) => v.severity === 'error');
      expect(errors, errors.map((e) => e.message).join('; ')).toEqual([]);

      const cap = list.battleSize === 'Strike Force' ? 2000 : 1000;
      const points = listPoints(list, dataIndex);
      expect(points).toBeGreaterThanOrEqual(cap - 100); // a real list, not a token one
      expect(points).toBeLessThanOrEqual(cap);

      // Committed JSON == regenerating from the definition (run `pnpm build:rosters` after edits).
      const onDisk = JSON.parse(
        readFileSync(join(__dirname, '..', 'data', 'rosters', `${fileName}.json`), 'utf-8'),
      ) as Roster;
      expect(onDisk).toEqual({ ...toRoster(list, dataIndex), note: PREBUILT_NOTE, ...(recommended ? { recommended } : {}) });

      // Every unit resolves and is sized to a real points tier (the board needs both).
      for (const u of list.units) {
        const ds = dataIndex.datasheets.get(u.datasheetId);
        expect(ds, `unknown datasheet ${u.datasheetId}`).toBeTruthy();
        expect(ds!.points?.some((t) => t.models === u.modelCount), `${ds!.name} has no ${u.modelCount}-model tier`).toBe(true);
      }
    });
  }
});
