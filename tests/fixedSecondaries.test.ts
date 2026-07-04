// Fixed Secondary Missions mode: the pre-battle choice, the FIXED scoring variants of the four
// FIXED-capable cards, the 20VP-per-card cap, and no drawing in fixed mode.

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { secondariesOnTurnEnd, secondariesOnTurnStart, FIXED_CARD_CAP } from '../src/core/secondaries';
import type { EngineContext } from '../src/core/engine';
import type { BaseShape, Datasheet, GameState, KillRecord, Layout } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: { player: [], opponent: [] },
};

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [], baseShape: circle, keywords: ['Infantry'], abilityIds: [], ...over,
});
const ctx: EngineContext = {
  datasheets: new Map([
    ['grunt', ds('grunt')],
    ['boss', ds('boss', { keywords: ['Infantry', 'Character'], models: [{ name: 'boss', M: 6, T: 4, Sv: 3, W: 5, Ld: 6, OC: 1 }] })],
    ['tank', ds('tank', { keywords: ['Vehicle'], models: [{ name: 'tank', M: 10, T: 10, Sv: 3, W: 12, Ld: 7, OC: 3 }] })],
  ]),
};
const rng = makeRNG(4);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);

/** A match state with the given side in fixed mode and a synthetic kill ledger. */
function fixedState(cards: [string, string], kills: KillRecord[]): GameState {
  let s = run(createInitialState(layout), [{ type: 'NewBattle' }]);
  s = run(s, [{ type: 'ChooseSecondaryMode', side: 'player', fixedCardIds: cards }]);
  return {
    ...s,
    stage: 'battle', phase: 'Fight', activePlayer: 'player', round: 2,
    turnKills: kills,
  };
}

describe('ChooseSecondaryMode', () => {
  it('fixed mode stores two distinct FIXED-capable cards and empties the deck', () => {
    const s = fixedState(['assassination', 'bring_it_down'], []);
    const sec = s.secondaries!.player;
    expect(sec.mode).toBe('fixed');
    expect(sec.fixed?.map((c) => c.id)).toEqual(['assassination', 'bring_it_down']);
    expect(sec.deck).toHaveLength(0);
  });

  it('rejects duplicates and non-fixed cards', () => {
    let s = run(createInitialState(layout), [{ type: 'NewBattle' }]);
    const dup = run(s, [{ type: 'ChooseSecondaryMode', side: 'player', fixedCardIds: ['assassination', 'assassination'] }]);
    expect(dup.secondaries!.player.mode).toBeUndefined();
    const bad = run(s, [{ type: 'ChooseSecondaryMode', side: 'player', fixedCardIds: ['assassination', 'a_tempting_target'] }]);
    expect(bad.secondaries!.player.mode).toBeUndefined();
  });

  it('fixed mode never draws in the Command phase', () => {
    const s = fixedState(['assassination', 'engage_all_fronts'], []);
    const after = secondariesOnTurnStart(s, ctx);
    expect(after.secondaries!.player.hand).toHaveLength(0);
  });
});

describe('FIXED scoring variants', () => {
  it('Assassination FIXED: 3VP per CHARACTER model slain, +1 each with W4+', () => {
    const s = fixedState(['assassination', 'engage_all_fronts'], [
      { side: 'ai', datasheetIds: ['boss'], maxWounds: 5, onObjective: false, charactersSlain: 2, characterMaxW: 5, charactersSlain4W: 1 },
    ]);
    const after = secondariesOnTurnEnd(s, ctx);
    // 2 characters × 3 + 1 with W4+ = 7 VP
    expect(after.secondaries!.player.fixedVp?.assassination).toBe(7);
    expect(after.score.player).toBe(7);
  });

  it('Bring It Down FIXED: 4VP per W10+ model destroyed (per instance, not flat 5)', () => {
    const s = fixedState(['bring_it_down', 'engage_all_fronts'], [
      { side: 'ai', unitId: 'x', datasheetIds: ['tank'], maxWounds: 12, onObjective: false, bigModelsSlain: 2, startingStrength: 2 },
    ]);
    const after = secondariesOnTurnEnd(s, ctx);
    expect(after.secondaries!.player.fixedVp?.bring_it_down).toBe(8);
  });

  it('A Grievous Blow FIXED: 4VP per Starting-Strength-13+ unit destroyed', () => {
    const s = fixedState(['a_grievous_blow', 'engage_all_fronts'], [
      { side: 'ai', unitId: 'h1', datasheetIds: ['grunt'], maxWounds: 1, onObjective: false, startingStrength: 15 },
      { side: 'ai', unitId: 'h2', datasheetIds: ['grunt'], maxWounds: 1, onObjective: false, startingStrength: 20 },
    ]);
    const after = secondariesOnTurnEnd(s, ctx);
    expect(after.secondaries!.player.fixedVp?.a_grievous_blow).toBe(8);
  });

  it('each fixed card caps at 20 VP for the battle', () => {
    let s = fixedState(['bring_it_down', 'engage_all_fronts'], [
      { side: 'ai', unitId: 'x', datasheetIds: ['tank'], maxWounds: 12, onObjective: false, bigModelsSlain: 3, startingStrength: 3 },
    ]);
    // Pretend 10 VP already scored on the card and 10 this round: 3 kills = 12 raw, capped to 10.
    s = {
      ...s,
      secondaries: {
        ...s.secondaries!,
        player: { ...s.secondaries!.player, fixedVp: { bring_it_down: 10 }, vp: 10 },
      },
    };
    const after = secondariesOnTurnEnd(s, ctx);
    expect(after.secondaries!.player.fixedVp?.bring_it_down).toBe(FIXED_CARD_CAP);
  });

  it('fixed cards are never discarded — they can score again next turn', () => {
    const kills: KillRecord[] = [
      { side: 'ai', datasheetIds: ['boss'], maxWounds: 5, onObjective: false, charactersSlain: 1, characterMaxW: 5, charactersSlain4W: 1 },
    ];
    let s = secondariesOnTurnEnd(fixedState(['assassination', 'engage_all_fronts'], kills), ctx);
    expect(s.secondaries!.player.fixedVp?.assassination).toBe(4);
    // Next round, another character dies — the same card scores again.
    s = secondariesOnTurnEnd({ ...s, round: 3, turnKills: kills }, ctx);
    expect(s.secondaries!.player.fixedVp?.assassination).toBe(8);
  });
});
