// Pariah Nexus Tactical (Secondary) Missions: deck lifecycle, kill tracking, card evaluators,
// the 40VP cap, and a full AI game where secondaries actually score.
import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../src/core/state';
import type { EngineContext } from '../src/core/engine';
import {
  SECONDARY_CARDS, SECONDARY_VP_CAP, initSecondaries, recordKills, secondariesOnTurnEnd,
  secondariesOnTurnStart, secondaryCard, secondaryPositionBonus,
} from '../src/core/secondaries';
import { makeRNG } from '../src/core/rng';
import { runMatch, type MatchData } from '../src/core/ai/match';
import { datasheetsById, deployAbilityForDatasheet, stratagems, layouts } from '../src/data/loaders';
import type { Datasheet, GameState, Layout, Roster, Side, SecondarySideState } from '../src/core/types';
import bane from '../data/rosters/bane.json';
import rogue from '../data/rosters/rogue_traders_army.json';

// A board with real zones (player x<18, ai x>42), one objective per territory + one NML.
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [],
  objectives: [{ x: 10, y: 22 }, { x: 30, y: 22 }, { x: 50, y: 22 }],
  deploymentZones: {
    player: [{ x: 0, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 44 }, { x: 0, y: 44 }],
    opponent: [{ x: 42, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 44 }, { x: 42, y: 44 }],
  },
};
const circle = { kind: 'circle' as const, radius: 0.49 };
const trooper: Datasheet = {
  id: 'troop', name: 'Troopers', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [{ name: 'Lasgun', type: 'ranged', range: 24, attacks: '1', skill: 4, S: 3, AP: 0, D: '1', keywords: [] }],
  baseShape: circle, keywords: ['INFANTRY'], abilityIds: [],
};
const hero: Datasheet = {
  id: 'hero', name: 'Hero', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 4, Sv: 3, W: 5, Ld: 6, OC: 1 }],
  weapons: [{ name: 'Sword', type: 'melee', attacks: '4', skill: 3, S: 5, AP: -2, D: '2', keywords: [] }],
  baseShape: circle, keywords: ['INFANTRY', 'CHARACTER'], abilityIds: [],
};
const tank: Datasheet = {
  id: 'tank', name: 'Tank', faction: 'AM',
  models: [{ name: 'm', M: 10, T: 11, Sv: 2, W: 18, Ld: 7, OC: 8 }],
  weapons: [{ name: 'Cannon', type: 'ranged', range: 48, attacks: '3', skill: 3, S: 9, AP: -3, D: '3', keywords: [] }],
  baseShape: circle, keywords: ['VEHICLE'], abilityIds: [],
};
const ctx: EngineContext = { datasheets: new Map([[trooper.id, trooper], [hero.id, hero], [tank.id, tank]]) };
const rng = makeRNG(11);

function spawn(s: GameState, id: string, owner: Side, dsId: string, x: number, y: number, n = 1): GameState {
  const ds = ctx.datasheets.get(dsId)!;
  return reduce(s, {
    type: 'SpawnUnit', unitId: id, owner, datasheetId: dsId, baseShape: ds.baseShape,
    modelCount: n, wounds: ds.models[0]!.W, anchor: { x, y },
  }, rng, ctx);
}
const emptySide = (): SecondarySideState => ({ deck: [], hand: [], discard: [], vp: 0 });
function withHand(s: GameState, side: Side, ids: string[], vp = 0): GameState {
  return {
    ...s,
    mode: 'match',
    secondaries: {
      player: side === 'player' ? { ...emptySide(), hand: ids.map((id) => ({ id, drawn: s.round })), vp } : emptySide(),
      ai: side === 'ai' ? { ...emptySide(), hand: ids.map((id) => ({ id, drawn: s.round })), vp } : emptySide(),
    },
  };
}
const killAll = (s: GameState, unitId: string): GameState => ({
  ...s,
  units: s.units.map((u) => (u.id === unitId ? { ...u, models: u.models.map((m) => ({ ...m, alive: false })) } : u)),
});

describe('deck lifecycle', () => {
  it('initSecondaries deals each side a full, seeded-shuffled deck (reproducible)', () => {
    const a = initSecondaries(makeRNG(5));
    const b = initSecondaries(makeRNG(5));
    expect(a.player.deck).toEqual(b.player.deck);
    expect(a.player.deck.length).toBe(SECONDARY_CARDS.length);
    expect([...a.player.deck].sort()).toEqual(SECONDARY_CARDS.map((c) => c.id).sort());
    expect(a.player.deck.join()).not.toBe(a.ai.deck.join()); // separate shuffles
  });

  it('turn-start upkeep discards stale cards, draws to 2, and snapshots objective control', () => {
    let s = spawn(createInitialState(layout), 'sq', 'player', 'troop', 10, 22, 5); // on own objective
    s = { ...s, mode: 'match', round: 3, activePlayer: 'player' };
    s = {
      ...s,
      secondaries: {
        player: { deck: ['no_prisoners', 'area_denial'], hand: [{ id: 'assassination', drawn: 1 }], discard: [], vp: 0 },
        ai: emptySide(),
      },
    };
    const next = secondariesOnTurnStart(s, ctx);
    const sec = next.secondaries!.player;
    expect(sec.discard).toContain('assassination'); // drawn R1, now R3 → stale
    expect(sec.hand.map((c) => c.id)).toEqual(['no_prisoners', 'area_denial']);
    expect(sec.deck).toEqual([]);
    expect(next.controlAtTurnStart?.[0]).toBe('player');
    expect(next.controlAtTurnStart?.[1]).toBeNull();
  });

  it('the DiscardSecondary intent moves a hand card to the discard pile', () => {
    let s = withHand(createInitialState(layout), 'player', ['area_denial']);
    s = reduce(s, { type: 'DiscardSecondary', side: 'player', cardId: 'area_denial' }, rng, ctx);
    expect(s.secondaries!.player.hand).toEqual([]);
    expect(s.secondaries!.player.discard).toEqual(['area_denial']);
    s = reduce(s, { type: 'DiscardSecondary', side: 'player', cardId: 'area_denial' }, rng, ctx);
    expect(s.log.at(-1)).toMatch(/not in hand/);
  });
});

describe('kill tracking', () => {
  it('recordKills captures the victim side, datasheets (incl. merged Leaders), wounds and objective', () => {
    let s = spawn(createInitialState(layout), 'victim', 'ai', 'troop', 30, 22, 2); // on the NML objective
    s = { ...s, mode: 'match' };
    s = {
      ...s,
      units: s.units.map((u) =>
        u.id === 'victim' ? { ...u, attachedLeaders: [{ unitId: 'boss', datasheetId: 'hero', modelCount: 1, wounds: 5 }] } : u,
      ),
    };
    const after = recordKills(s, killAll(s, 'victim'), ctx);
    expect(after.turnKills).toHaveLength(1);
    const k = after.turnKills![0]!;
    expect(k.side).toBe('ai');
    expect(k.datasheetIds).toEqual(['troop', 'hero']);
    expect(k.maxWounds).toBe(5);
    expect(k.onObjective).toBe(true);
  });

  it('the kill cards score from the ledger (Assassination 5, Bring It Down 4+3, No Prisoners cap)', () => {
    const base = { ...createInitialState(layout), mode: 'match' as const };
    const kills = (recs: GameState['turnKills']) => ({ ...base, turnKills: recs });
    const score = (id: string, s: GameState) => secondaryCard(id)!.score(s, 'player', ctx);
    expect(score('assassination', kills([{ side: 'ai', datasheetIds: ['hero'], maxWounds: 5, onObjective: false }]))).toBe(5);
    expect(score('bring_it_down', kills([{ side: 'ai', datasheetIds: ['tank'], maxWounds: 18, onObjective: false }]))).toBe(7);
    expect(score('no_prisoners', kills(Array(5).fill({ side: 'ai', datasheetIds: ['troop'], maxWounds: 1, onObjective: false })))).toBe(6);
    expect(score('overwhelming_force', kills([{ side: 'ai', datasheetIds: ['troop'], maxWounds: 1, onObjective: true }]))).toBe(3);
    // own losses never score for us
    expect(score('assassination', kills([{ side: 'player', datasheetIds: ['hero'], maxWounds: 5, onObjective: false }]))).toBe(0);
  });
});

describe('position cards and turn-end scoring', () => {
  it('Behind Enemy Lines: 1 unit wholly in the enemy zone = 3, 2+ = 5', () => {
    let s = spawn(createInitialState(layout), 'a', 'player', 'troop', 50, 10, 3);
    const one = secondaryCard('behind_enemy_lines')!.score({ ...s, mode: 'match' }, 'player', ctx);
    expect(one).toBe(3);
    s = spawn(s, 'b', 'player', 'troop', 50, 30, 3);
    expect(secondaryCard('behind_enemy_lines')!.score({ ...s, mode: 'match' }, 'player', ctx)).toBe(5);
    expect(secondaryCard('behind_enemy_lines')!.score({ ...s, mode: 'match' }, 'ai', ctx)).toBe(0);
  });

  it('Storm Hostile Objective needs the turn-start snapshot to flip', () => {
    let s = spawn(createInitialState(layout), 'sq', 'player', 'troop', 30, 22, 5);
    s = { ...s, mode: 'match' };
    const card = secondaryCard('storm_hostile_objective')!;
    expect(card.score({ ...s, controlAtTurnStart: [null, 'ai', null] }, 'player', ctx)).toBe(4);
    expect(card.score({ ...s, controlAtTurnStart: [null, null, null] }, 'player', ctx)).toBe(0);
  });

  it('turn end scores the ending player and the opponent-turn cards, discards scored, caps at 40', () => {
    // player ends its turn holding its home objective AND ai holds Defend Stronghold (opponent_turn).
    let s = spawn(createInitialState(layout), 'mine', 'player', 'troop', 10, 22, 5);
    s = spawn(s, 'theirs', 'ai', 'troop', 50, 22, 5);
    s = { ...s, mode: 'match', activePlayer: 'player' };
    s = {
      ...s,
      secondaries: {
        player: { ...emptySide(), hand: [{ id: 'extend_battle_lines', drawn: 1 }], vp: 38 },
        ai: { ...emptySide(), hand: [{ id: 'defend_stronghold', drawn: 1 }], vp: 0 },
      },
    };
    const next = secondariesOnTurnEnd(s, ctx);
    // player: own objective only → raw 2, capped to 40 (38 + 2)
    expect(next.secondaries!.player.vp).toBe(40);
    expect(next.secondaries!.player.hand).toEqual([]);
    expect(next.score.player).toBe(2);
    // ai: Defend Stronghold scores at the END OF THE OPPONENT'S (player's) turn
    expect(next.secondaries!.ai.vp).toBe(3);
    // the cap holds even if more would score
    const over = secondariesOnTurnEnd({ ...s, secondaries: { ...s.secondaries!, player: { ...emptySide(), hand: [{ id: 'capture_enemy_outpost', drawn: 1 }], vp: 40 } } }, ctx);
    expect(over.secondaries!.player.vp).toBe(40);
  });

  it('secondaryPositionBonus pulls toward the enemy zone / scoring markers while cards are active', () => {
    let s = spawn(createInitialState(layout), 'sq', 'player', 'troop', 10, 22, 5);
    s = withHand(s, 'player', ['behind_enemy_lines', 'capture_enemy_outpost']);
    expect(secondaryPositionBonus(s, 'player', { x: 50, y: 22 }, ctx)).toBeGreaterThan(10); // in zone + on outpost
    expect(secondaryPositionBonus(s, 'player', { x: 10, y: 22 }, ctx)).toBe(0);
    expect(secondaryPositionBonus(s, 'ai', { x: 50, y: 22 }, ctx)).toBe(0); // no cards
  });
});

describe('full AI game with secondaries', () => {
  const data: MatchData = { ctx: { datasheets: datasheetsById }, deployAbility: deployAbilityForDatasheet, stratagems };
  const board = layouts.find((l) => l.id === 'ca2025-hammer-and-anvil-1') ?? layouts[0]!;

  it('Bane vs Rogue Trader plays clean and both sides score secondary VP within the cap', () => {
    const result = runMatch(
      {
        layout: board,
        rosters: { player: bane as unknown as Roster, ai: rogue as unknown as Roster },
        profiles: { player: 'balanced', ai: 'balanced' },
        seed: 42,
      },
      data,
    );
    expect(result.ended).toBe(true);
    expect(result.forcedAdvances).toBe(0);
    expect(result.rejectedLog).toEqual([]);
    const last = result.rounds[result.rounds.length - 1]!;
    expect(last.secondary.player).toBeGreaterThan(0);
    expect(last.secondary.ai).toBeGreaterThan(0);
    expect(last.secondary.player).toBeLessThanOrEqual(SECONDARY_VP_CAP);
    expect(last.secondary.ai).toBeLessThanOrEqual(SECONDARY_VP_CAP);
    // totals: primary (≤50) + secondary (≤40)
    expect(result.score.player).toBeLessThanOrEqual(90);
    expect(result.score.ai).toBeLessThanOrEqual(90);
    expect(result.score.player).toBeGreaterThanOrEqual(last.secondary.player);
  }, 120_000);
});
