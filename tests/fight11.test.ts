// 11e Fight-phase fidelity (12.02–12.08): overrun fights, pile-in that must end engaged,
// the three consolidation modes with their mandatory priority, and engaging-consolidation
// chain fights.

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { resolveFightMove, stampFightStepEngagement, type EngineContext } from '../src/core/engine';
import { eligibleToFight, gapBetween } from '../src/core/phases';
import type { BaseShape, Datasheet, GameState, Layout, WeaponProfile } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [],
  objectives: [{ x: 30, y: 22 }],
  objectiveControlRadiusIn: 3,
  deploymentZones: { player: [], opponent: [] },
};

const melee = (name: string): WeaponProfile => ({
  name, type: 'melee', attacks: '2', skill: 3, S: 4, AP: 0, D: '1', keywords: [],
});

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [melee('Blade')], baseShape: circle, keywords: ['Infantry'], abilityIds: [], ...over,
});

const ctx: EngineContext = {
  datasheets: new Map<string, Datasheet>([['grunt', ds('grunt')]]),
};

const rng = makeRNG(7);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);

const spawn = (unitId: string, owner: 'player' | 'ai', x: number, y = 22, modelCount = 1): Intent => ({
  type: 'SpawnUnit', unitId, owner, datasheetId: 'grunt', baseShape: circle, modelCount, wounds: 1,
  anchor: { x, y },
});

/** Sandbox state in the Fight phase with the given units. Gaps below are base-to-base:
 *  two 0.5"-radius circles at Δx apart have a gap of Δx − 1. */
const fightState = (intents: Intent[]): GameState => {
  let s = run(createInitialState(layout), intents);
  return { ...s, phase: 'Fight' };
};

const unit = (s: GameState, id: string) => s.units.find((u) => u.id === id)!;

describe('overrun fights (12.04/12.06)', () => {
  it('an unengaged unit that was engaged at the Fight-step start stays eligible when an enemy is in reach', () => {
    const s = fightState([spawn('me', 'player', 10), spawn('foe', 'ai', 14)]); // gap 3"
    const me = { ...unit(s, 'me'), status: { engagedAtFightStart: true } };
    expect(eligibleToFight(me, s, ctx).eligible).toBe(true);
  });

  it('…but is NOT eligible when no enemy is within pile-in reach (5")', () => {
    const s = fightState([spawn('me', 'player', 10), spawn('foe', 'ai', 17)]); // gap 6"
    const me = { ...unit(s, 'me'), status: { engagedAtFightStart: true } };
    const e = eligibleToFight(me, s, ctx);
    expect(e.eligible).toBe(false);
    expect(e.reason).toMatch(/overrun/);
  });

  it('a unit that charged this turn is overrun-eligible even if its target died', () => {
    const s = fightState([spawn('me', 'player', 10), spawn('foe', 'ai', 14)]);
    const me = { ...unit(s, 'me'), status: { charged: true } };
    expect(eligibleToFight(me, s, ctx).eligible).toBe(true);
  });

  it('entering the Fight phase stamps engagedAtFightStart on engaged units only', () => {
    let s = run(createInitialState(layout), [
      spawn('a', 'player', 10), spawn('b', 'ai', 12), // gap 1" — engaged (ER 2")
      spawn('c', 'player', 30), spawn('d', 'ai', 40), // far apart
    ]);
    s = stampFightStepEngagement(s, ctx);
    expect(unit(s, 'a').status.engagedAtFightStart).toBe(true);
    expect(unit(s, 'b').status.engagedAtFightStart).toBe(true);
    expect(unit(s, 'c').status.engagedAtFightStart).toBe(false);
    expect(unit(s, 'd').status.engagedAtFightStart).toBe(false);
  });
});

describe('pile in (12.03)', () => {
  it('an engaged unit piles in toward the enemy it is engaged with (not a closer other enemy later)', () => {
    const s = fightState([spawn('me', 'player', 10), spawn('foe', 'ai', 12.5)]); // gap 1.5" — engaged
    const out = resolveFightMove(s, { unitId: 'me', mode: 'pile_in' }, ctx);
    const gap = gapBetween(unit(out.state, 'me'), unit(out.state, 'foe'), ctx);
    expect(gap).toBeLessThan(0.05); // moved to base contact
  });

  it('an unengaged unit may pile in up to 3" onto an enemy within 5" (overrun pile-in) and must end engaged', () => {
    const s = fightState([spawn('me', 'player', 10), spawn('foe', 'ai', 14)]); // gap 3"
    const out = resolveFightMove(s, { unitId: 'me', mode: 'pile_in' }, ctx);
    const gap = gapBetween(unit(out.state, 'me'), unit(out.state, 'foe'), ctx);
    expect(gap).toBeLessThanOrEqual(2); // engaged
  });

  it('an unengaged unit does not pile in when no enemy is within 5"', () => {
    const s = fightState([spawn('me', 'player', 10), spawn('foe', 'ai', 17)]); // gap 6"
    const out = resolveFightMove(s, { unitId: 'me', mode: 'pile_in' }, ctx);
    expect(out.summary).toMatch(/does not pile in/);
    expect(unit(out.state, 'me').models[0]!.pos.x).toBe(10); // unmoved
  });
});

describe('consolidation modes (12.08)', () => {
  it('Ongoing: an engaged unit consolidates toward its engaged enemy into base contact', () => {
    const s = fightState([spawn('me', 'player', 10), spawn('foe', 'ai', 12)]); // gap 1" — engaged
    const out = resolveFightMove(s, { unitId: 'me', mode: 'consolidate' }, ctx);
    expect(out.summary).toMatch(/ongoing/);
    const gap = gapBetween(unit(out.state, 'me'), unit(out.state, 'foe'), ctx);
    expect(gap).toBeLessThan(0.05);
  });

  it('Engaging: an unengaged unit within 3" of an enemy must consolidate into engagement', () => {
    const s = fightState([spawn('me', 'player', 10), spawn('foe', 'ai', 13.5)]); // gap 2.5" — NOT engaged
    const out = resolveFightMove(s, { unitId: 'me', mode: 'consolidate' }, ctx);
    expect(out.summary).toMatch(/engaging/);
    const gap = gapBetween(unit(out.state, 'me'), unit(out.state, 'foe'), ctx);
    expect(gap).toBeLessThanOrEqual(2);
    // Chain fight: the enemy engaged this way (that has not fought) is now eligible to fight.
    expect(eligibleToFight(unit(out.state, 'foe'), out.state, ctx).eligible).toBe(true);
  });

  it('Objective: with no enemy within 3", the unit consolidates into range of a nearby objective', () => {
    // Objective at (30,22), control radius 3": model at x=25 is 5" out — a 3" move gets within range.
    const s = fightState([spawn('me', 'player', 25), spawn('foe', 'ai', 50)]);
    const out = resolveFightMove(s, { unitId: 'me', mode: 'consolidate' }, ctx);
    expect(out.summary).toMatch(/objective/);
    const m = unit(out.state, 'me').models[0]!;
    expect(Math.hypot(m.pos.x - 30, m.pos.y - 22)).toBeLessThanOrEqual(3);
  });

  it('no mode applies: the unit cannot consolidate (no free 3" toward the nearest enemy)', () => {
    // No enemy within 3", no objective within reach (unit at x=5 → objective 25" away).
    const s = fightState([spawn('me', 'player', 5), spawn('foe', 'ai', 50)]);
    const out = resolveFightMove(s, { unitId: 'me', mode: 'consolidate' }, ctx);
    expect(out.summary).toMatch(/does not consolidate/);
    expect(unit(out.state, 'me').models[0]!.pos.x).toBe(5);
  });
});
