import { describe, it, expect } from 'vitest';
import type { Datasheet, GameState, Layout } from '../src/core/types';
import { createInitialState, reduce } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { eligibleToCharge } from '../src/core/phases';
import type { EngineContext } from '../src/core/engine';

const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [],
  objectives: [], deploymentZones: { player: [], opponent: [] },
};

const grunt: Datasheet = {
  id: 'grunt', name: 'Grunt', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [
    { name: 'knife', type: 'melee', attacks: '1', skill: 4, S: 3, AP: 0, D: '1', keywords: [] },
  ],
  baseShape: { kind: 'circle', radius: 0.5 }, keywords: ['INFANTRY'], abilityIds: [],
};

const ctx: EngineContext = { datasheets: new Map([[grunt.id, grunt]]) };

function matchState(): GameState {
  let s = createInitialState(layout);
  s = { ...s, mode: 'match', stage: 'battle', phase: 'Charge' };
  const mk = (id: string, owner: 'player' | 'ai', x: number) => ({
    id, owner, datasheetId: grunt.id, startingModels: 1, status: {},
    models: [{ id: `${id}:m0`, unitId: id, pos: { x, y: 20 }, wounds: 1, alive: true }],
  });
  return { ...s, units: [mk('a', 'player', 10), mk('b', 'ai', 21)] };
}

describe('charge-declaration guard (10e: one declaration per phase)', () => {
  it('a failed charge cannot be re-declared the same phase, and eligibility reflects it', () => {
    const rng = makeRNG(2); // whatever it rolls, 11" away needs a 10+: usually fails
    let s = matchState();
    // Find a seed/state where the first charge FAILS (10" needed). Roll until one fails.
    s = reduce(s, { type: 'Charge', chargerUnitId: 'a', targetUnitId: 'b' }, rng, ctx);
    const afterFirst = s.units.find((u) => u.id === 'a')!;
    expect(afterFirst.status.chargeAttempted).toBe(true);

    const before = s.log.length;
    s = reduce(s, { type: 'Charge', chargerUnitId: 'a', targetUnitId: 'b' }, rng, ctx);
    expect(s.log.slice(before).join('\n')).toMatch(/already declared a charge this phase/);

    expect(eligibleToCharge(s.units.find((u) => u.id === 'a')!, s, ctx).eligible).toBe(false);
  });

  it('the sandbox (dice-calculator) is unaffected by the guard', () => {
    let s = matchState();
    s = { ...s, mode: 'sandbox' };
    const rng = makeRNG(3);
    s = reduce(s, { type: 'Charge', chargerUnitId: 'a', targetUnitId: 'b' }, rng, ctx);
    expect(s.units.find((u) => u.id === 'a')!.status.chargeAttempted).toBeUndefined();
    const before = s.log.length;
    s = reduce(s, { type: 'Charge', chargerUnitId: 'a', targetUnitId: 'b' }, rng, ctx);
    expect(s.log.slice(before).join('\n')).not.toMatch(/already declared/);
  });
});
