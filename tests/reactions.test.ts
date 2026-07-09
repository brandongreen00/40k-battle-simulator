// AI reactive stratagem policies: Counteroffensive (after an enemy fights) and the
// round-3 Rapid Ingress save (reserves that would die to 20.03).

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { aiReactionToFight, aiReactionToPhaseEnd } from '../src/core/ai/react';
import { AI_PROFILES } from '../src/core/ai/profile';
import type { AiDeps } from '../src/core/ai/types';
import type { BaseShape, Datasheet, GameState, Layout, WeaponProfile } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: { player: [], opponent: [] },
};
const claws: WeaponProfile = { name: 'Claws', type: 'melee', attacks: '6', skill: 2, S: 8, AP: -3, D: '2', keywords: [] };
const fists: WeaponProfile = { name: 'Fists', type: 'melee', attacks: '3', skill: 3, S: 9, AP: -3, D: '3', keywords: [] };

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 4, Sv: 3, W: 2, Ld: 7, OC: 1 }],
  weapons: [fists], baseShape: circle, keywords: ['Infantry'], abilityIds: [], ...over,
});
const ctx = {
  datasheets: new Map<string, Datasheet>([
    ['squad', ds('squad')],
    ['beast', ds('beast', { weapons: [claws], models: [{ name: 'beast', M: 8, T: 7, Sv: 3, W: 8, Ld: 7, OC: 3 }] })],
  ]),
};
const deps: AiDeps = {
  ctx, rosters: { player: undefined, ai: undefined }, detachments: { player: '', ai: '' },
  deployAbility: () => 'standard', stratagems: [], rng: makeRNG(1),
} as unknown as AiDeps;
const rng = makeRNG(31);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);
const spawn = (unitId: string, owner: 'player' | 'ai', dsId: string, x: number, y = 22, modelCount = 5): Intent => ({
  type: 'SpawnUnit', unitId, owner, datasheetId: dsId, baseShape: circle, modelCount,
  wounds: ctx.datasheets.get(dsId)!.models[0]!.W, anchor: { x, y },
});

describe('aiReactionToFight (Counteroffensive)', () => {
  it('pays 2 CP to fight next when an un-fought enemy would wreck our engaged unit', () => {
    let s = run(createInitialState(layout), [
      spawn('mine', 'player', 'squad', 10), spawn('beast', 'ai', 'beast', 12, 22, 3),
    ]);
    s = { ...s, mode: 'match', stage: 'battle', phase: 'Fight', activePlayer: 'ai', cp: { player: 3, ai: 3 } };
    const plays = aiReactionToFight(s, 'player', AI_PROFILES.balanced!, deps);
    expect(plays).toHaveLength(1);
    expect(plays[0]!.intent).toMatchObject({ type: 'Counteroffensive', unitId: 'mine' });
  });

  it('holds the CP when the threat is small or the unit already fought', () => {
    let s = run(createInitialState(layout), [
      spawn('mine', 'player', 'squad', 10), spawn('weak', 'ai', 'squad', 12, 22, 1),
    ]);
    s = { ...s, mode: 'match', stage: 'battle', phase: 'Fight', activePlayer: 'ai', cp: { player: 3, ai: 3 } };
    expect(aiReactionToFight(s, 'player', AI_PROFILES.balanced!, deps)).toHaveLength(0);
    const fought = {
      ...s,
      units: s.units.map((u) => (u.id === 'mine' ? { ...u, status: { ...u.status, hasFought: true } } : u)),
    };
    expect(aiReactionToFight(fought, 'player', AI_PROFILES.balanced!, deps)).toHaveLength(0);
  });
});

describe('aiReactionToPhaseEnd — round-3 Rapid Ingress save', () => {
  it('ingresses a reserve unit at the end of the opponent round-3 Movement when its own turn has passed', () => {
    let s = run(createInitialState(layout), [
      spawn('foe', 'ai', 'squad', 30),
      { type: 'PlaceInReserves', unitId: 'res', owner: 'player', datasheetId: 'squad', baseShape: circle, modelCount: 5, wounds: 2 },
    ]);
    // player went FIRST this round (their turn passed) — the AI's Movement phase is ending.
    s = {
      ...s, mode: 'match', stage: 'battle', phase: 'Movement', activePlayer: 'ai',
      firstPlayer: 'player', round: 3, cp: { player: 2, ai: 2 },
    };
    const plays = aiReactionToPhaseEnd(s, 'player', AI_PROFILES.balanced!, deps);
    const rapid = plays.find((p) => p.intent.type === 'ArriveFromReserves');
    expect(rapid).toBeDefined();
    expect((rapid!.intent as { rapidIngress?: boolean }).rapidIngress).toBe(true);
    // Not played in round 2 (no destruction risk yet).
    const early = aiReactionToPhaseEnd({ ...s, round: 2 }, 'player', AI_PROFILES.balanced!, deps);
    expect(early.some((p) => p.intent.type === 'ArriveFromReserves')).toBe(false);
  });
});
