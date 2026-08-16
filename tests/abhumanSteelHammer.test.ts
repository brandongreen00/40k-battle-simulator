// The Comp III import's rule set: 11e Upgrade-tagged enhancements (non-Character bearers,
// max 3 copies, only the first counts against the budget), Steel Hammer's KEYWORDS rule
// (AM TITANIC units may gain CHARACTER to take enhancements), the Exemplar of Duty /
// Abhuman Detail leader grants (Commissars leading Ogryn/Bullgryn squads), and Abhuman
// Auxiliaries' Absolutist Principles order binding.

import { describe, it, expect } from 'vitest';
import { dataIndex } from '../src/data/loaders';
import { validate, type ArmyList, type ListUnit } from '../src/core/army';
import { canAttach } from '../src/core/leaders';
import { ENH, leaderGrantTargets } from '../src/core/enhancements';
import { abhumanOnlyOrderTarget, isAbhumanUnit } from '../src/core/orders';
import { orderableUnits } from '../src/core/phases';
import { createInitialState } from '../src/core/state';
import type { BaseShape, Datasheet, GameState, Layout, UnitInstance } from '../src/core/types';
import type { EngineContext } from '../src/core/engine';

const byName = (name: string): Datasheet => {
  const ds = [...dataIndex.datasheets.values()].find((d) => d.name === name);
  expect(ds, name).toBeDefined();
  return ds!;
};
const enhByName = (name: string): string => {
  const e = [...dataIndex.enhancements.values()].find((x) => x.name === name);
  expect(e, name).toBeDefined();
  return e!.id;
};

const unit = (name: string, n: number, uid: string, enhancementId?: string): ListUnit => ({
  uid,
  datasheetId: byName(name).id,
  modelCount: n,
  ...(enhancementId ? { enhancementId } : {}),
});
const list = (detachment: string, units: ListUnit[]): ArmyList => ({
  name: 't',
  faction: 'AM',
  detachment,
  battleSize: 'Strike Force',
  units,
});
const errs = (l: ArmyList): string[] =>
  validate(l, dataIndex).filter((v) => v.severity === 'error').map((v) => v.message);

describe('11e Upgrade-tagged enhancements (printed core rule)', () => {
  const EXEMPLAR = enhByName('Exemplar of Duty');
  const AASH = 'Abhuman Auxiliaries and Steel Hammer';

  it('the catalog carries the 11e-only Upgrade records (survives re-ingest via the overlay)', () => {
    for (const name of ['Exemplar of Duty', 'Sharp eyes, Light fingers', 'Long-Range Scout', 'Recon Star']) {
      const e = [...dataIndex.enhancements.values()].find((x) => x.name === name)!;
      expect(e.upgrade, name).toBe(true);
      expect(e.cost, name).toBe(10);
    }
  });

  it('three copies of the same Upgrade are legal and count ONCE against the budget', () => {
    // 3× Exemplar of Duty + Titan Killer + Battalion Commander + Engine Speaker = 4/4 budget.
    const l = list(AASH, [
      unit('Commissar', 1, 'c1', EXEMPLAR),
      unit('Commissar', 1, 'c2', EXEMPLAR),
      unit('Commissar', 1, 'c3', EXEMPLAR),
      unit('Banesword', 1, 'b1', enhByName('Titan Killer')),
      unit('Stormsword', 1, 's1', enhByName('Battalion Commander')),
      unit('Tech-Priest Enginseer', 1, 't1', enhByName('Engine Speaker')),
    ]);
    expect(errs(l)).toEqual([]);
    // A 4th distinct-counting enhancement busts the 4-at-2000 budget.
    const over = { ...l, units: [...l.units, unit('Tech-Priest Enginseer', 1, 't2', enhByName('Assault Hatches'))] };
    expect(errs(over).some((m) => m.includes('Too many enhancements'))).toBe(true);
  });

  it('a fourth copy of the same Upgrade is flagged (max 3 per army)', () => {
    const l = list(AASH, ['c1', 'c2', 'c3', 'c4'].map((uid) => unit('Commissar', 1, uid, EXEMPLAR)));
    expect(errs(l).some((m) => m.includes('max 3'))).toBe(true);
  });

  it('Upgrades are bearer-scoped: Exemplar of Duty is for COMMISSAR models only', () => {
    const l = list(AASH, [unit('Tech-Priest Enginseer', 1, 't1', EXEMPLAR)]);
    expect(errs(l).some((m) => m.includes('COMMISSAR'))).toBe(true);
  });
});

describe("Steel Hammer's KEYWORDS rule (AM TITANIC units may gain CHARACTER)", () => {
  it('a TITANIC tank in a Steel Hammer army can take an enhancement; elsewhere it cannot', () => {
    const ok = list('Steel Hammer', [unit('Banesword', 1, 'b1', enhByName('Titan Killer'))]);
    expect(errs(ok)).toEqual([]);
    // Same tank in a non-Steel-Hammer AM army: not a Character (Veteran Crew keeps the
    // detachment scope legal so the only failure is the Character rule).
    const no = list('Hammer of the Emperor', [unit('Banesword', 1, 'b1', enhByName('Veteran Crew'))]);
    expect(errs(no).some((m) => m.includes('not a Character'))).toBe(true);
  });
});

describe('leader grants: Exemplar of Duty / Abhuman Detail attach Commissars to Bullgryns', () => {
  it('canAttach honours the enhancement grant (and only with it)', () => {
    const commissar = byName('Commissar');
    const bullgryns = byName('Bullgryn Squad');
    expect(canAttach(commissar, bullgryns)).toBe(false);
    expect(canAttach(commissar, bullgryns, enhByName('Exemplar of Duty'))).toBe(true);
    expect(canAttach(commissar, bullgryns, ENH.ABHUMAN_DETAIL)).toBe(true); // Grizzled's card, same grant
    expect(canAttach(commissar, byName('Ogryn Squad'), enhByName('Exemplar of Duty'))).toBe(true);
    // The grant never makes a non-Character a leader, and grants nothing else.
    expect(leaderGrantTargets(enhByName('Engine Speaker'))).toEqual([]);
  });
});

describe("Absolutist Principles (Abhuman Auxiliaries): Commissars order ABHUMAN units", () => {
  const circle: BaseShape = { kind: 'circle', radius: 0.5 };
  const layout: Layout = { id: 't', boardWidth: 60, boardHeight: 44, deployment: 'x', terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] } };
  const ds = (id: string, kw: string[]): Datasheet => ({ id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }], weapons: [], baseShape: circle, keywords: kw, abilityIds: [] });
  const ctx: EngineContext = {
    datasheets: new Map([
      ['com', ds('com', ['Character', 'Officer', 'Commissar'])],
      ['bull', ds('bull', ['Infantry', 'Bullgryn Squad', 'Ogryn'])],
      ['reg', ds('reg', ['Regiment'])],
    ]),
  };
  const u = (id: string, dsId: string, x: number): UnitInstance => ({ id, owner: 'player', datasheetId: dsId, startingModels: 1, status: {}, models: [{ id: `${id}:m`, unitId: id, pos: { x, y: 22 }, wounds: 1, alive: true }] });

  it('ABHUMAN units are orderable by a Commissar only in an Abhuman Auxiliaries army', () => {
    const off = u('off', 'com', 10);
    const bull = u('bull', 'bull', 13);
    const s: GameState = { ...createInitialState(layout), units: [off, bull] };
    expect(orderableUnits(off, s, ctx).map((x) => x.id)).toEqual([]); // no detachment → no ABHUMAN reach
    expect(orderableUnits(off, s, ctx, 'Abhuman Auxiliaries and Steel Hammer').map((x) => x.id)).toEqual(['bull']);
    expect(orderableUnits(off, s, ctx, 'Grizzled Company').map((x) => x.id)).toEqual([]);
  });

  it('an ABHUMAN-only target is restricted to Take Aim! at the decision sites', () => {
    expect(isAbhumanUnit(ctx.datasheets.get('bull'))).toBe(true);
    expect(abhumanOnlyOrderTarget(ctx.datasheets.get('bull'))).toBe(true);
    expect(abhumanOnlyOrderTarget(ctx.datasheets.get('reg'))).toBe(false); // REGIMENT gets the full menu
  });
});

describe('lone-detachment allowance is now the printed core rule (no warning)', () => {
  it('a 3 DP detachment at 1000 pts validates without the old over-budget warning', () => {
    const l: ArmyList = { name: 't', faction: 'AM', detachment: 'Grizzled Company', battleSize: 'Incursion', units: [] };
    expect(validate(l, dataIndex).filter((v) => v.message.includes('DP'))).toEqual([]);
  });
});
