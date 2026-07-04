// 11e charge sequencing (11.02/11.04): the 2D6 roll comes FIRST; targets are selected after the
// roll and must be within 12" AND within the rolled distance. Unselected intended targets are
// non-targets (the move may not end engaged with them).

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { rollCharge } from '../src/core/movement';
import { resolveCharge, type EngineContext } from '../src/core/engine';
import { gapBetween } from '../src/core/phases';
import type { BaseShape, Datasheet, GameState, Layout } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: { player: [], opponent: [] },
};

const ds = (id: string): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [{ name: 'Blade', type: 'melee', attacks: '1', skill: 3, S: 4, AP: 0, D: '1', keywords: [] }],
  baseShape: circle, keywords: ['Infantry'], abilityIds: [],
});

const ctx: EngineContext = { datasheets: new Map([['grunt', ds('grunt')]]) };
const rng = makeRNG(3);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);
const spawn = (unitId: string, owner: 'player' | 'ai', x: number, y = 22): Intent => ({
  type: 'SpawnUnit', unitId, owner, datasheetId: 'grunt', baseShape: circle, modelCount: 1, wounds: 1,
  anchor: { x, y },
});
const unit = (s: GameState, id: string) => s.units.find((u) => u.id === id)!;

/** A seed whose first 2D6 charge roll is exactly `want`. */
const seedFor = (want: number): number => {
  for (let s = 0; s < 2000; s++) if (rollCharge(makeRNG(s)).distance === want) return s;
  throw new Error(`no seed rolls ${want}`);
};

describe('11e roll-first charges', () => {
  it('a roll shorter than the closest target GAP fails even if it could reach Engagement Range', () => {
    // Gap 4": a 3" move would reach ER (2"), but a target 4" away is not selectable on a 3.
    const s = run(createInitialState(layout), [spawn('me', 'player', 10), spawn('foe', 'ai', 15)]);
    const out = resolveCharge(s, { chargerUnitId: 'me', targetUnitIds: ['foe'] }, ctx, makeRNG(seedFor(3)));
    expect(out.success).toBe(false);
    expect(out.summary).toMatch(/needed 4\.0", rolled 3"/);
    expect(unit(out.state, 'me').models[0]!.pos.x).toBe(10); // unmoved
  });

  it('a roll covering the gap succeeds and moves into Engagement Range', () => {
    const s = run(createInitialState(layout), [spawn('me', 'player', 10), spawn('foe', 'ai', 15)]);
    const out = resolveCharge(s, { chargerUnitId: 'me', targetUnitIds: ['foe'] }, ctx, makeRNG(seedFor(5)));
    expect(out.success).toBe(true);
    expect(gapBetween(unit(out.state, 'me'), unit(out.state, 'foe'), ctx)).toBeLessThanOrEqual(2);
  });

  it('post-roll target selection drops an intended target beyond the rolled distance', () => {
    // near foe gap 4", far foe gap 9": a roll of 6 selects only the near one.
    const s = run(createInitialState(layout), [
      spawn('me', 'player', 10), spawn('near', 'ai', 15), spawn('far', 'ai', 20),
    ]);
    const out = resolveCharge(
      s, { chargerUnitId: 'me', targetUnitIds: ['near', 'far'] }, ctx, makeRNG(seedFor(6)),
    );
    expect(out.success).toBe(true);
    expect(out.summary).toMatch(/not selected/);
    const me = unit(out.state, 'me');
    expect(gapBetween(me, unit(out.state, 'near'), ctx)).toBeLessThanOrEqual(2); // engaged
    expect(gapBetween(me, unit(out.state, 'far'), ctx)).toBeGreaterThan(2); // NOT engaged (non-target)
  });

  it('a big enough roll engages every intended target', () => {
    const s = run(createInitialState(layout), [
      spawn('me', 'player', 10), spawn('a', 'ai', 15, 21), spawn('b', 'ai', 15, 23),
    ]);
    const out = resolveCharge(
      s, { chargerUnitId: 'me', targetUnitIds: ['a', 'b'] }, ctx, makeRNG(seedFor(9)),
    );
    expect(out.success).toBe(true);
    const me = unit(out.state, 'me');
    expect(gapBetween(me, unit(out.state, 'a'), ctx)).toBeLessThanOrEqual(2);
    expect(gapBetween(me, unit(out.state, 'b'), ctx)).toBeLessThanOrEqual(2);
  });

  it('an intended target beyond 12" is an illegal declaration, not a failed charge', () => {
    const s = run(createInitialState(layout), [spawn('me', 'player', 10), spawn('foe', 'ai', 24)]);
    const out = resolveCharge(s, { chargerUnitId: 'me', targetUnitIds: ['foe'] }, ctx, makeRNG(seedFor(12)));
    expect(out.success).toBe(false);
    expect(out.summary).toMatch(/over 12"/);
  });
});
