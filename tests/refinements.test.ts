// The 2026-06-12 log-review refinements (Bane vs Rogue Trader's Army analysis):
//  - an ATTACHED Officer still issues Orders (Yarrick merged into Death Korps went silent)
//  - shooting/melee EV is capped at the target's remaining value (the Stormlord valued a lone
//    100pt assassin at several hundred points and fed whole activations into overkill)
//  - the AI's objective pull uses REAL Objective Control (a 1-model OC-8 tank counted as 1)
//  - Firing Deck no longer classifies a super-heavy as a 'transport'
//  - charges are only declared when a legal landing spot exists at SOME roll (screens)
//  - Command Re-roll: 1 CP to re-roll a failed charge, once per phase per side
//  - Lone Operative + Deep Strike characters (the Callidus) start in Reserves
import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../src/core/state';
import { chargePathExists, resolveCharge, type EngineContext } from '../src/core/engine';
import { unitIsOfficer } from '../src/core/orders';
import { orderableUnits } from '../src/core/phases';
import { shootingEV, meleeEV, unitOC, unitValue } from '../src/core/ai/evaluate';
import { classifyDatasheet } from '../src/core/ai/roles';
import { aiCommandAction } from '../src/core/ai/command';
import { whoActs, aiAction, sharedAction } from '../src/core/ai/controller';
import { AI_PROFILES } from '../src/core/ai/profile';
import type { AiDeps } from '../src/core/ai/types';
import { makeRNG } from '../src/core/rng';
import { rollCharge } from '../src/core/movement';
import { datasheetsById, deployAbilityForDatasheet, stratagems, layouts } from '../src/data/loaders';
import type { Datasheet, GameState, Layout, Roster } from '../src/core/types';
import bane from '../data/rosters/bane.json';
import rogue from '../data/rosters/rogue_traders_army.json';

const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] },
};
const circle = { kind: 'circle' as const, radius: 0.49 };

const guardsman: Datasheet = {
  id: 'guard', name: 'Guardsmen', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [{ name: 'Lasgun', type: 'ranged', range: 24, attacks: '1', skill: 4, S: 3, AP: 0, D: '1', keywords: [] }],
  baseShape: circle, keywords: ['INFANTRY', 'REGIMENT'], abilityIds: [],
  points: [{ models: 10, cost: 60 }],
};
const officerDs: Datasheet = {
  id: 'officer', name: 'Lord Officer', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 4, Ld: 6, OC: 1 }],
  weapons: [{ name: 'Power fist', type: 'melee', attacks: '3', skill: 3, S: 6, AP: -2, D: '2', keywords: [] }],
  baseShape: circle, keywords: ['INFANTRY', 'CHARACTER', 'OFFICER'], abilityIds: [],
};
const bigTank: Datasheet = {
  id: 'tank', name: 'Big Tank', faction: 'AM',
  models: [{ name: 'm', M: 10, T: 11, Sv: 2, W: 24, Ld: 7, OC: 8 }],
  weapons: [
    { name: 'Cannon A', type: 'ranged', range: 48, attacks: '6', skill: 3, S: 9, AP: -3, D: '3', keywords: [] },
    { name: 'Cannon B', type: 'ranged', range: 48, attacks: '6', skill: 3, S: 9, AP: -3, D: '3', keywords: [] },
    { name: 'Cannon C', type: 'ranged', range: 48, attacks: '6', skill: 3, S: 9, AP: -3, D: '3', keywords: [] },
    { name: 'Cannon D', type: 'ranged', range: 48, attacks: '6', skill: 3, S: 9, AP: -3, D: '3', keywords: [] },
  ],
  baseShape: circle, keywords: ['VEHICLE', 'TITANIC'], abilityIds: [],
  points: [{ models: 1, cost: 430 }],
};
const lonePriceyModel: Datasheet = {
  id: 'assassin', name: 'Pricey Assassin', faction: 'AoI',
  models: [{ name: 'm', M: 7, T: 4, Sv: 6, invuln: 4, W: 4, Ld: 6, OC: 1 }],
  weapons: [{ name: 'Blade', type: 'melee', attacks: '6', skill: 2, S: 4, AP: -2, D: '2', keywords: [] }],
  baseShape: circle, keywords: ['INFANTRY', 'CHARACTER'], abilityIds: [],
  points: [{ models: 1, cost: 100 }],
};
const ctx: EngineContext = {
  datasheets: new Map([
    [guardsman.id, guardsman], [officerDs.id, officerDs], [bigTank.id, bigTank], [lonePriceyModel.id, lonePriceyModel],
  ]),
};
const rng = makeRNG(3);

function spawn(s: GameState, id: string, owner: 'player' | 'ai', dsId: string, x: number, y: number, n = 1): GameState {
  const ds = ctx.datasheets.get(dsId)!;
  return reduce(s, {
    type: 'SpawnUnit', unitId: id, owner, datasheetId: dsId, baseShape: ds.baseShape,
    modelCount: n, wounds: ds.models[0]!.W, anchor: { x, y },
  }, rng, ctx);
}

const aiDeps = (detachment: string): AiDeps => ({
  ctx,
  rosters: { player: { name: 'p', faction: 'AM', detachment, points: 0, units: [] }, ai: { name: 'a', faction: 'AM', detachment: '', points: 0, units: [] } },
  detachments: { player: detachment, ai: '' },
  deployAbility: () => 'standard',
  stratagems: [],
  rng: makeRNG(9),
});

describe('orders flow through the Leader merge', () => {
  /** A Guardsmen unit with a merged Officer leader (the post-AttachLeader shape). */
  function mergedState(): GameState {
    let s = spawn(createInitialState(layout), 'squad', 'player', 'guard', 10, 10, 10);
    s = {
      ...s,
      units: s.units.map((u) =>
        u.id === 'squad'
          ? { ...u, attachedLeaders: [{ unitId: 'boss', datasheetId: 'officer', modelCount: 1, wounds: 4 }] }
          : u,
      ),
    };
    return s;
  }

  it('unitIsOfficer sees the attached Officer; a plain squad is not an officer', () => {
    const s = mergedState();
    expect(unitIsOfficer(s.units[0]!, ctx)).toBe(true);
    const plain = spawn(createInitialState(layout), 'squad', 'player', 'guard', 10, 10, 10);
    expect(unitIsOfficer(plain.units[0]!, ctx)).toBe(false);
  });

  it('an attached Officer may order his OWN unit; a standalone Officer cannot order himself', () => {
    const s = mergedState();
    const merged = s.units[0]!;
    expect(orderableUnits(merged, s, ctx).map((u) => u.id)).toContain('squad');
    const lone = spawn(createInitialState(layout), 'boss', 'player', 'officer', 10, 10, 1);
    expect(orderableUnits(lone.units[0]!, lone, ctx)).toEqual([]); // no REGIMENT keyword on himself
  });

  it('the AI issues Orders from the merged Officer (with the Grizzled Company rider)', () => {
    const s = { ...mergedState(), commandRun: true, phase: 'Command' };
    const action = aiCommandAction(s, 'player', AI_PROFILES.balanced!, aiDeps('Grizzled Company'));
    const orders = action.intents.filter((i) => i.intent.type === 'IssueOrder');
    expect(orders.length).toBeGreaterThanOrEqual(2); // the order itself + the re-roll-1s rider
    expect(orders.some((i) => i.intent.type === 'IssueOrder' && i.intent.effectId === 'reroll_hits_1')).toBe(true);
  });
});

describe('EV caps and real OC', () => {
  it('a multi-gun volley is never valued above the whole target (overkill cap)', () => {
    let s = spawn(createInitialState(layout), 'tank', 'player', 'tank', 10, 10);
    s = spawn(s, 'lone', 'ai', 'assassin', 30, 10);
    const tank = s.units.find((u) => u.id === 'tank')!;
    const lone = s.units.find((u) => u.id === 'lone')!;
    const ev = shootingEV(s, tank, lone, ctx);
    expect(ev).toBeGreaterThan(0);
    expect(ev).toBeLessThanOrEqual(unitValue(lone, ctx)); // = 100, not 4 cannons × 100
    expect(meleeEV(tank, lone, ctx)).toBeLessThanOrEqual(unitValue(lone, ctx));
  });

  it('unitOC reads the real Objective Control characteristic', () => {
    let s = spawn(createInitialState(layout), 'tank', 'player', 'tank', 10, 10);
    s = spawn(s, 'squad', 'player', 'guard', 20, 10, 10);
    expect(unitOC(s.units.find((u) => u.id === 'tank')!, ctx)).toBe(8);
    expect(unitOC(s.units.find((u) => u.id === 'squad')!, ctx)).toBe(10);
  });

  it('Firing Deck alone no longer classifies a unit as a transport (the Stormlord is a gunline)', () => {
    const stormlord = [...datasheetsById.values()].find((d) => d.name === 'Stormlord');
    expect(stormlord).toBeTruthy();
    expect(classifyDatasheet(stormlord)).toBe('gunline');
  });
});

describe('charge declarations and Command Re-roll', () => {
  it('chargePathExists: false for a fully surrounded target, true in the open', () => {
    let s = spawn(spawn(createInitialState(layout), 'charger', 'player', 'guard', 10, 10), 'target', 'ai', 'assassin', 16, 10);
    expect(chargePathExists(s, 'charger', ['target'], ctx)).toBe(true);
    // Ring of non-target enemies: every spot within Engagement Range of the target is within
    // Engagement Range of a ring unit, so no legal landing spot exists at any roll.
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 2 * Math.PI;
      s = spawn(s, `ring${k}`, 'ai', 'guard', 16 + Math.cos(a) * 2.2, 10 + Math.sin(a) * 2.2, 1);
    }
    expect(chargePathExists(s, 'charger', ['target'], ctx)).toBe(false);
  });

  it('Command Re-roll: 1 CP re-rolls a failed charge, once per phase per side', () => {
    // Charger 7" centre-to-centre from the target → needs ~5.02". Find a seed where the first
    // 2D6 falls short and the re-roll makes it.
    const needed = 5.02;
    let seed = -1;
    for (let k = 1; k < 500; k++) {
      const r = makeRNG(k);
      const first = rollCharge(r).distance;
      const second = rollCharge(r).distance;
      if (first < needed && second >= needed + 0.5) { seed = k; break; }
    }
    expect(seed).toBeGreaterThan(0);

    let s = spawn(spawn(createInitialState(layout), 'charger', 'player', 'guard', 10, 10), 'target', 'ai', 'assassin', 17, 10);
    s = { ...s, mode: 'match' as const, phase: 'Charge', cp: { player: 2, ai: 0 } };
    const r1 = resolveCharge(s, { chargerUnitId: 'charger', targetUnitId: 'target', commandReroll: true }, ctx, makeRNG(seed));
    expect(r1.success).toBe(true);
    expect(r1.state.cp.player).toBe(1); // 1 CP spent
    expect(r1.state.log.some((l) => l.includes('Command Re-roll'))).toBe(true);
    expect(r1.state.rerollUsed?.player).toBe(`${s.round}:${s.activePlayer}:Charge`);

    // Same phase, second failed charge: the once-per-phase gate holds (no CP spent again).
    let s2 = spawn(r1.state, 'charger2', 'player', 'guard', 10, 20, 1);
    s2 = spawn(s2, 'target2', 'ai', 'assassin', 21.5, 20, 1); // ~10.5" gap — will fail on most rolls
    let failSeed = -1;
    for (let k = 1; k < 500; k++) {
      if (rollCharge(makeRNG(k)).distance < 10) { failSeed = k; break; }
    }
    const r2 = resolveCharge(s2, { chargerUnitId: 'charger2', targetUnitId: 'target2', commandReroll: true }, ctx, makeRNG(failSeed));
    expect(r2.success).toBe(false);
    expect(r2.state.cp.player).toBe(1); // unchanged — re-roll already used this phase
    expect(r2.state.log.filter((l) => l.includes('Command Re-roll')).length).toBe(1); // still just the first
  });
});

describe('Lone Operative + Deep Strike characters start in Reserves', () => {
  const realCtx = { datasheets: datasheetsById };
  const board = layouts.find((l) => l.id === 'ca2025-hammer-and-anvil-1') ?? layouts[0]!;

  it('the Callidus is held in Reserves during deployment (no more round-1 deaths at the 9" line)', () => {
    const gameRng = makeRNG(42);
    const deps: AiDeps = {
      ctx: realCtx,
      rosters: { player: bane as unknown as Roster, ai: rogue as unknown as Roster },
      detachments: { player: (bane as { detachment: string }).detachment, ai: (rogue as { detachment: string }).detachment },
      deployAbility: deployAbilityForDatasheet,
      stratagems,
      rng: gameRng,
    };
    let state = reduce(createInitialState(board), { type: 'NewBattle' }, gameRng, realCtx);
    for (let i = 0; i < 300 && state.stage === 'setup'; i++) {
      const d = whoActs(state, deps);
      const action = d.actor === 'shared' ? sharedAction(state) : d.actor ? aiAction(state, d.actor, AI_PROFILES.balanced!, deps) : null;
      if (!action) break;
      for (const item of action.intents) {
        if (item.skipIf?.(state)) continue;
        state = reduce(state, item.intent, gameRng, realCtx);
      }
    }
    expect(state.stage).toBe('battle');
    const callidusDs = [...datasheetsById.values()].find((d) => d.name === 'Callidus Assassin')!;
    const callidus = state.units.find((u) => u.datasheetId === callidusDs.id);
    expect(callidus, 'Callidus unit exists').toBeTruthy();
    expect(callidus!.inReserves).toBe(true);
  });
});
