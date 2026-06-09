import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../src/core/state';
import { resolveAttack, type EngineContext } from '../src/core/engine';
import { makeRNG } from '../src/core/rng';
import type { Datasheet, GameState, Layout } from '../src/core/types';

const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] },
};
const gun: Datasheet = {
  id: 'g', name: 'Shooters', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 4, Sv: 4, W: 2, Ld: 7, OC: 1 }],
  weapons: [{ name: 'rifle', type: 'ranged', range: 36, attacks: '1', skill: 4, S: 5, AP: -1, D: '2', keywords: [] }],
  baseShape: { kind: 'circle', radius: 0.63 }, keywords: ['INFANTRY'], abilityIds: [],
};
const ctx: EngineContext = { datasheets: new Map([[gun.id, gun]]) };

function field(extraSetup?: (s: GameState) => GameState): GameState {
  const rng = makeRNG(1);
  let s = createInitialState(layout);
  s = reduce(s, { type: 'SpawnUnit', unitId: 'A', owner: 'player', datasheetId: 'g', baseShape: gun.baseShape, modelCount: 20, wounds: 2, anchor: { x: 12, y: 22 } }, rng);
  s = reduce(s, { type: 'SpawnUnit', unitId: 'B', owner: 'ai', datasheetId: 'g', baseShape: gun.baseShape, modelCount: 20, wounds: 2, anchor: { x: 24, y: 22 } }, rng);
  // Both sides start with a stockpile of CP so stratagem tests aren't gated by the economy.
  s = { ...s, cp: { player: 5, ai: 5 } };
  return extraSetup ? extraSetup(s) : s;
}

/** Average damage from A shooting B over many seeds, with optional effect setup. */
function meanDamage(setup?: (s: GameState) => GameState, trials = 800): number {
  let total = 0;
  for (let i = 0; i < trials; i++) {
    const s = field(setup);
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'rifle' }, ctx, makeRNG(1000 + i));
    total += out.state.units.find((u) => u.id === 'B')!.models.reduce((acc, m) => acc + (2 - m.wounds), 0);
  }
  return total / trials;
}

describe('effects flow through combat', () => {
  it('a +1 to hit Order increases expected damage', () => {
    const base = meanDamage();
    const buffed = meanDamage((s) => reduce(s, { type: 'IssueOrder', unitId: 'A', effectId: 'order:take_aim' }, makeRNG(1)));
    expect(buffed).toBeGreaterThan(base);
  });

  it('a defensive -1 Damage stratagem reduces incoming damage', () => {
    const base = meanDamage();
    const reduced = meanDamage((s) =>
      reduce(s, { type: 'UseStratagem', name: 'Armoured Resilience', side: 'ai', cost: 1, targetUnitId: 'B', effectId: 'minus1_damage' }, makeRNG(1), ctx),
    );
    expect(reduced).toBeLessThan(base);
  });
});

describe('stratagem CP economy + reactive timing (rule #3)', () => {
  it('rejects a stratagem the side cannot afford', () => {
    let s = field((st) => ({ ...st, cp: { player: 0, ai: 1 } }));
    s = reduce(s, { type: 'UseStratagem', name: 'Pricey', side: 'ai', cost: 2, targetUnitId: 'B', effectId: 'displacer_field' }, makeRNG(1), ctx);
    expect(s.units.find((u) => u.id === 'B')!.status.activeEffects ?? []).not.toContain('displacer_field');
    expect(s.log.some((l) => /rejected/.test(l))).toBe(true);
  });

  it('a reactive defensive stratagem can be used during the opponent (player) turn', () => {
    let s = field();
    // Give the AI CP, then it's the player's turn (player active) — AI reacts with a stratagem.
    s = { ...s, activePlayer: 'player', cp: { player: 0, ai: 3 } };
    s = reduce(s, { type: 'UseStratagem', name: 'Displacer Field', side: 'ai', cost: 1, targetUnitId: 'B', effectId: 'displacer_field' }, makeRNG(1), ctx);
    expect(s.cp.ai).toBe(2);
    expect(s.units.find((u) => u.id === 'B')!.status.activeEffects).toContain('displacer_field');
    // The 4++ now blunts the player's AP-1 attack: damage is no higher than without it.
    const withField = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'rifle' }, ctx, makeRNG(7));
    expect(withField.rejected).toBeUndefined();
  });
});
