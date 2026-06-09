import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../src/core/state';
import { resolveAttack, type EngineContext } from '../src/core/engine';
import { makeRNG } from '../src/core/rng';
import type { Datasheet, Layout } from '../src/core/types';

const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] },
};

const shooter: Datasheet = {
  id: 'shooter', name: 'Shooters', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [
    { name: 'autogun', type: 'ranged', range: 24, attacks: '1', skill: 3, S: 4, AP: -1, D: '1', keywords: [] },
    { name: 'bayonet', type: 'melee', attacks: '2', skill: 4, S: 3, AP: 0, D: '1', keywords: [] },
  ],
  baseShape: { kind: 'circle', radius: 0.63 }, keywords: ['INFANTRY'], abilityIds: [],
};
const target: Datasheet = {
  id: 'target', name: 'Victims', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 6, W: 1, Ld: 7, OC: 1 }],
  weapons: [], baseShape: { kind: 'circle', radius: 0.63 }, keywords: ['INFANTRY'], abilityIds: [],
};
const ctx: EngineContext = { datasheets: new Map([[shooter.id, shooter], [target.id, target]]) };

function twoUnits(gapInches: number) {
  const rng = makeRNG(1);
  let s = createInitialState(layout);
  s = reduce(s, { type: 'SpawnUnit', unitId: 'A', owner: 'player', datasheetId: 'shooter', baseShape: shooter.baseShape, modelCount: 10, wounds: 1, anchor: { x: 10, y: 22 } }, rng);
  s = reduce(s, { type: 'SpawnUnit', unitId: 'B', owner: 'ai', datasheetId: 'target', baseShape: target.baseShape, modelCount: 10, wounds: 1, anchor: { x: 10 + gapInches, y: 22 } }, rng);
  return s;
}

describe('resolveAttack end-to-end', () => {
  it('rejects an out-of-range shot', () => {
    const s = twoUnits(40); // far apart -> beyond 24"
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'autogun' }, ctx, makeRNG(3));
    expect(out.rejected).toMatch(/out of range/);
  });

  it('applies damage and removes models in range', () => {
    const s = twoUnits(6); // within 24"
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'autogun' }, ctx, makeRNG(7));
    const before = s.units.find((u) => u.id === 'B')!.models.filter((m) => m.alive).length;
    const after = out.state.units.find((u) => u.id === 'B')!.models.filter((m) => m.alive).length;
    expect(after).toBeLessThan(before);
    expect(out.state.log.length).toBeGreaterThan(0);
  });

  it('routes through the reducer Attack intent and marks the attacker as having shot', () => {
    const s = twoUnits(6);
    const next = reduce(s, { type: 'Attack', attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'autogun' }, makeRNG(9), ctx);
    expect(next.units.find((u) => u.id === 'A')!.status.hasShot).toBe(true);
  });

  it('rejects melee outside engagement range', () => {
    const s = twoUnits(20);
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'bayonet' }, ctx, makeRNG(2));
    expect(out.rejected).toMatch(/engagement/);
  });
});
