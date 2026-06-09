import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../src/core/state';
import { resolveAttack, type EngineContext } from '../src/core/engine';
import { makeRNG } from '../src/core/rng';
import type { Datasheet, Layout } from '../src/core/types';

// Deliverable #2: a model's loadout (e.g. a shield) drives its save in the actual game.

const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] },
};

// A high-AP weapon so the target's armour save is useless and only an invuln can stop it.
const shooter: Datasheet = {
  id: 'shooter', name: 'Shooters', faction: 'AoI',
  models: [{ name: 'm', M: 6, T: 4, Sv: 3, W: 1, Ld: 7, OC: 1 }],
  weapons: [{ name: 'plasma', type: 'ranged', range: 24, attacks: '2', skill: 2, S: 8, AP: -3, D: '1', keywords: [] }],
  baseShape: { kind: 'circle', radius: 0.63 }, keywords: ['INFANTRY'], abilityIds: [],
};
// Target has a mediocre armour save (Sv 4 → 7+ after AP-3) and 2 wounds each.
const target: Datasheet = {
  id: 'target', name: 'Breachers', faction: 'AoI',
  models: [{ name: 'm', M: 6, T: 4, Sv: 4, W: 2, Ld: 7, OC: 1 }],
  weapons: [], baseShape: { kind: 'circle', radius: 0.63 }, keywords: ['INFANTRY'], abilityIds: [],
};
const ctx: EngineContext = { datasheets: new Map([[shooter.id, shooter], [target.id, target]]) };

function trial(seed: number, shields: number): number {
  const rng = makeRNG(seed);
  let s = createInitialState(layout);
  s = reduce(s, { type: 'SpawnUnit', unitId: 'A', owner: 'player', datasheetId: 'shooter', baseShape: shooter.baseShape, modelCount: 10, wounds: 1, anchor: { x: 10, y: 22 } }, rng);
  s = reduce(s, {
    type: 'SpawnUnit', unitId: 'B', owner: 'ai', datasheetId: 'target', baseShape: target.baseShape,
    modelCount: 10, wounds: 2, anchor: { x: 14, y: 22 },
    ...(shields > 0 ? { wargear: { 'Astartes shield': shields } } : {}),
  }, rng);
  const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'plasma' }, ctx, makeRNG(seed + 100));
  const b = out.state.units.find((u) => u.id === 'B')!;
  return b.models.reduce((sum, m) => sum + m.wounds, 0); // total wounds remaining on the unit
}

describe('per-model saves from loadout', () => {
  it('tags shield-bearing models with their wargear at spawn', () => {
    const rng = makeRNG(1);
    let s = createInitialState(layout);
    s = reduce(s, {
      type: 'SpawnUnit', unitId: 'B', owner: 'ai', datasheetId: 'target', baseShape: target.baseShape,
      modelCount: 10, wounds: 2, anchor: { x: 14, y: 22 }, wargear: { 'Astartes shield': 2 },
    }, rng);
    const models = s.units[0]!.models;
    expect(models.filter((m) => m.wargear?.includes('Astartes shield'))).toHaveLength(2);
  });

  it('a unit of shield-bearers (4++) survives high-AP fire far better than one without', () => {
    const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
    const woundsNoShield = seeds.reduce((a, s) => a + trial(s, 0), 0);
    const woundsAllShield = seeds.reduce((a, s) => a + trial(s, 10), 0);
    // The 4++ invuln roughly halves casualties vs a 7+ (impossible) armour save.
    expect(woundsAllShield).toBeGreaterThan(woundsNoShield * 1.3);
  });
});
