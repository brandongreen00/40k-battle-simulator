// Defender casualty-allocation preference (SetAllocation): 'shields_first' (default) lets
// defensive-wargear bearers soak wounds first; 'bodies_first' preserves them.

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import type { EngineContext } from '../src/core/engine';
import type { BaseShape, Datasheet, GameState, Layout, WeaponProfile } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: { player: [], opponent: [] },
};
// One firing model with 4 attacks — roughly one casualty per volley, so the allocation ORDER
// is observable across several volleys.
const gun: WeaponProfile = { name: 'Big gun', type: 'ranged', range: 36, attacks: '4', skill: 3, S: 8, AP: -2, D: '1', keywords: [] };

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [], baseShape: circle, keywords: ['Infantry'], abilityIds: [], ...over,
});
const ctx: EngineContext = {
  datasheets: new Map([
    ['squad', ds('squad')],
    ['foe', ds('foe', { weapons: [gun] })],
  ]),
};
const rng = makeRNG(6);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);

/** 5-model squad where 2 models carry Astartes shields (4++ defensive wargear). */
function base(): GameState {
  let s = run(createInitialState(layout), [
    {
      type: 'SpawnUnit', unitId: 'sq', owner: 'player', datasheetId: 'squad', baseShape: circle,
      modelCount: 5, wounds: 1, anchor: { x: 20, y: 22 }, wargear: { 'Astartes shield': 2 },
    },
    { type: 'SpawnUnit', unitId: 'foe', owner: 'ai', datasheetId: 'foe', baseShape: circle, modelCount: 1, wounds: 1, anchor: { x: 30, y: 22 } },
  ]);
  return { ...s, phase: 'Shooting', activePlayer: 'ai' };
}
const shieldBearers = (s: GameState) =>
  s.units.find((u) => u.id === 'sq')!.models.filter((m) => m.alive && (m.wargear ?? []).includes('Astartes shield')).length;
const aliveCount = (s: GameState) => s.units.find((u) => u.id === 'sq')!.models.filter((m) => m.alive).length;

describe('casualty allocation preference', () => {
  it('default (shields_first): shield bearers soak before regular models die', () => {
    let s = base();
    // Fire until at least 2 models are dead.
    for (let i = 0; i < 20 && aliveCount(s) > 3; i++) {
      s = run(s, [
        { type: 'SetUnitStatus', unitId: 'foe', status: { hasShot: false } },
        { type: 'ShootUnit', attackerUnitId: 'foe', targetUnitId: 'sq' },
      ]);
    }
    const dead = 5 - aliveCount(s);
    expect(dead).toBeGreaterThanOrEqual(2);
    // With shields soaking first, the FIRST casualties are the shield bearers.
    expect(shieldBearers(s)).toBe(Math.max(0, 2 - dead));
  });

  it('bodies_first: regular models die first, shield bearers are preserved', () => {
    let s = run(base(), [{ type: 'SetAllocation', unitId: 'sq', allocation: 'bodies_first' }]);
    for (let i = 0; i < 20 && aliveCount(s) > 3; i++) {
      s = run(s, [
        { type: 'SetUnitStatus', unitId: 'foe', status: { hasShot: false } },
        { type: 'ShootUnit', attackerUnitId: 'foe', targetUnitId: 'sq' },
      ]);
    }
    const dead = 5 - aliveCount(s);
    expect(dead).toBeGreaterThanOrEqual(2);
    expect(shieldBearers(s)).toBe(2); // both preserved while regular bodies remain
  });

  it('the preference persists across turn resets (unlike status flags)', () => {
    let s = run(base(), [{ type: 'SetAllocation', unitId: 'sq', allocation: 'bodies_first' }]);
    s = { ...s, phase: 'Fight' };
    s = run(s, [{ type: 'AdvancePhase' }]); // turn changes; beginTurnFor wipes status
    expect(s.units.find((u) => u.id === 'sq')!.allocation).toBe('bodies_first');
  });
});
