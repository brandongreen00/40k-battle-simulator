// Pins that the committed data/game JSON carries the 11e (Faction Pack v1.1) point values
// applied by tools/ingest/apply-points11e.ts — a re-run of `pnpm ingest` without the overlay
// would silently revert points to the 10e CSVs, and these pins catch that.

import { describe, it, expect } from 'vitest';
import { dataIndex } from '../src/data/loaders';
import { unitCost, unitWargearPoints } from '../src/core/army';

function byName(name: string) {
  const ds = [...dataIndex.datasheets.values()].find((d) => d.name === name);
  expect(ds, `datasheet "${name}"`).toBeTruthy();
  return ds!;
}

describe('11e points overlay (Faction Pack v1.1) is applied to the committed data', () => {
  it('Agents dual pricing: detachment price first, Assigned Agent price second', () => {
    const vindicare = byName('Vindicare Assassin');
    expect(vindicare.points).toEqual([
      { models: 1, cost: 110, note: 'AGENTS OF THE IMPERIUM Detachment' },
      { models: 1, cost: 125, note: 'Assigned Agent' },
    ]);
    expect(unitCost(vindicare, 1)).toBe(110); // a pure-Agents list pays the detachment price
  });

  it('escalating copies: the 2nd Stormlord and 3rd Hellhound cost more', () => {
    const stormlord = byName('Stormlord');
    expect(unitCost(stormlord, 1, 1)).toBe(395);
    expect(unitCost(stormlord, 1, 2)).toBe(430);
    const hellhound = byName('Hellhound');
    expect(unitCost(hellhound, 1, 2)).toBe(125);
    expect(unitCost(hellhound, 1, 3)).toBe(135);
  });

  it('priced wargear: the five 11e WARGEAR OPTIONS rows are captured and priced', () => {
    expect(byName('Leman Russ Commander').wargearCosts).toEqual([{ item: 'Demolisher battle cannon', cost: 15 }]);
    expect(byName('Sisters of Battle Immolator').wargearCosts).toEqual([{ item: 'Twin multi-melta', cost: 15 }]);
    expect(byName('Grey Knights Terminator Squad').wargearCosts).toEqual([{ item: 'Psycannon', cost: 5 }]);
    expect(byName('Field Ordnance Battery').wargearCosts).toEqual([{ item: 'Bombast field gun', cost: 10 }]);
    expect(byName('Krieg Heavy Weapons Squad').wargearCosts).toEqual([{ item: 'Krieg heavy flamer', cost: 5 }]);
    expect(unitWargearPoints(byName('Field Ordnance Battery'), { 'Bombast field gun': 2 })).toBe(20);
    // Wargear-priced sheets are rare by design — everything else must stay free.
    const priced = [...dataIndex.datasheets.values()].filter((d) => d.wargearCosts?.length);
    expect(priced.map((d) => d.name).sort()).toEqual([
      'Field Ordnance Battery',
      'Grey Knights Terminator Squad',
      'Krieg Heavy Weapons Squad',
      'Leman Russ Commander',
      'Sisters of Battle Immolator',
    ]);
  });

  it('every AM/AoI datasheet still has a points tier (no sheet lost by the overlay)', () => {
    // Combat Patrol datasheets (cp-*) deliberately carry no tiers — the box is the price.
    for (const ds of dataIndex.datasheets.values()) {
      if (ds.faction !== 'AM' && ds.faction !== 'AoI') continue;
      expect(ds.points?.length, ds.name).toBeGreaterThan(0);
    }
  });

  it('11e enhancement repricing reached the catalog (Veiled Blade cuts)', () => {
    const micromelta = [...dataIndex.enhancements.values()].find((e) => e.name === 'Micromelta Rounds');
    expect(micromelta?.cost).toBe(20); // was 45 in 10e
  });
});
