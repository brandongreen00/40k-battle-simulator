import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../src/core/state';
import { resolveAttack, objectiveControl, type EngineContext } from '../src/core/engine';
import { makeRNG } from '../src/core/rng';
import type { Datasheet, Layout } from '../src/core/types';

const ruinLayout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [{ id: 'r', type: 'ruin_blocking', height: 'tall',
    polygon: [{ x: 28, y: 12 }, { x: 32, y: 12 }, { x: 32, y: 32 }, { x: 28, y: 32 }] }],
  objectives: [{ x: 30, y: 22 }], objectiveControlRadiusIn: 3, objectiveMarkerDiameterIn: 1.575,
  deploymentZones: { player: [], opponent: [] },
};

const gunline: Datasheet = {
  id: 'g', name: 'Gunline', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 6, OC: 2 }],
  weapons: [{ name: 'rifle', type: 'ranged', range: 36, attacks: '1', skill: 3, S: 4, AP: 0, D: '1', keywords: [] }],
  baseShape: { kind: 'circle', radius: 0.63 }, keywords: ['INFANTRY'], abilityIds: [],
};
const ctx: EngineContext = { datasheets: new Map([[gunline.id, gunline]]) };

function spawn(s: ReturnType<typeof createInitialState>, id: string, owner: 'player' | 'ai', x: number, y: number, n = 1) {
  return reduce(s, { type: 'SpawnUnit', unitId: id, owner, datasheetId: 'g', baseShape: gunline.baseShape, modelCount: n, wounds: 1, anchor: { x, y } }, makeRNG(1));
}

describe('Phase 2 integration', () => {
  it('a tall ruin blocks line of sight', () => {
    let s = createInitialState(ruinLayout);
    s = spawn(s, 'A', 'player', 12, 22); // left of ruin
    s = spawn(s, 'B', 'ai', 44, 22); // right of ruin, directly behind it
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'rifle' }, ctx, makeRNG(2));
    expect(out.rejected).toMatch(/line of sight/);
  });

  it('a clear shot around the ruin connects', () => {
    let s = createInitialState(ruinLayout);
    s = spawn(s, 'A', 'player', 12, 5);
    s = spawn(s, 'B', 'ai', 44, 5);
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'rifle' }, ctx, makeRNG(2));
    expect(out.rejected).toBeUndefined();
  });

  it('command phase scores Primary VP for a held objective in round 2', () => {
    let s = createInitialState(ruinLayout);
    s = spawn(s, 'A', 'player', 30, 22, 3); // sitting on the objective
    s = { ...s, round: 2, activePlayer: 'player' };
    s = reduce(s, { type: 'RunCommandPhase' }, makeRNG(3), ctx);
    expect(s.cp.player).toBe(1);
    expect(s.score.player).toBeGreaterThan(0); // controlled the objective -> +5
  });

  it('objectiveControl reflects who holds the marker', () => {
    let s = createInitialState(ruinLayout);
    s = spawn(s, 'A', 'player', 30, 22, 2);
    const { controlled } = objectiveControl(s, ctx);
    expect(controlled.player).toBe(1);
    expect(controlled.ai).toBe(0);
  });
});
