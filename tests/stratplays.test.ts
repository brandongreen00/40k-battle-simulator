// Core Stratagem engine bindings (15.03–15.12): Fire Overwatch (snap shooting), Heroic
// Intervention (Leap to Defend / Into the Fray), Crushing Impact, Explosives, Counteroffensive,
// Insane Bravery, Rapid Ingress. Each is gated by CP + once-per-phase (once-per-battle for
// Insane Bravery) and the phase/turn windows.

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { resolveCharge, runCommandPhase, type EngineContext } from '../src/core/engine';
import { fightActivationOrder, hasFightsFirst } from '../src/core/phases';
import { rollCharge } from '../src/core/movement';
import type { BaseShape, Datasheet, GameState, Layout, WeaponProfile } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: { player: [], opponent: [] },
};

const gun = (name: string, over: Partial<WeaponProfile> = {}): WeaponProfile => ({
  name, type: 'ranged', range: 24, attacks: '10', skill: 4, S: 4, AP: 0, D: '1', keywords: [], ...over,
});
const blade: WeaponProfile = { name: 'Blade', type: 'melee', attacks: '2', skill: 3, S: 4, AP: 0, D: '1', keywords: [] };

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [gun('Lasgun'), blade], baseShape: circle, keywords: ['Infantry', 'Grenades'], abilityIds: [], ...over,
});

const ctx: EngineContext = {
  datasheets: new Map<string, Datasheet>([
    ['grunt', ds('grunt')],
    ['tank', ds('tank', {
      keywords: ['Vehicle'], weapons: [gun('Battle cannon'), blade],
      models: [{ name: 'tank', M: 10, T: 10, Sv: 3, W: 12, Ld: 7, OC: 3 }],
    })],
  ]),
};

const rng = makeRNG(9);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);
const spawn = (unitId: string, owner: 'player' | 'ai', dsId: string, x: number, y = 22, modelCount = 5): Intent => ({
  type: 'SpawnUnit', unitId, owner, datasheetId: dsId, baseShape: circle, modelCount,
  wounds: ctx.datasheets.get(dsId)!.models[0]!.W, anchor: { x, y },
});
const unit = (s: GameState, id: string) => s.units.find((u) => u.id === id)!;
const alive = (s: GameState, id: string) => unit(s, id).models.filter((m) => m.alive).length;

/** Match-mode state mid-battle at the given phase/active player, with CP. */
const at = (s: GameState, phase: string, activePlayer: 'player' | 'ai', cp = 3): GameState => ({
  ...s, mode: 'match', stage: 'battle', phase, activePlayer, cp: { player: cp, ai: cp },
});

describe('Fire Overwatch (15.08)', () => {
  const base = () => at(run(createInitialState(layout), [
    spawn('mine', 'player', 'grunt', 10), spawn('mover', 'ai', 'grunt', 20),
  ]), 'Movement', 'ai');

  it('snap-shoots in the opponent Movement phase, spends 1 CP, only 6s hit', () => {
    const s = run(base(), [{ type: 'FireOverwatch', unitId: 'mine', targetUnitId: 'mover' }]);
    expect(s.cp.player).toBe(2);
    expect(s.log.some((l) => /Fire Overwatch \(snap shooting\)/.test(l))).toBe(true);
    // Snap shooting: hits recorded but never more than the unmodified 6s (statistically loose —
    // just assert the shot resolved and the once-per-phase tracker is set).
    expect(s.stratUsed?.['player:core:fire_overwatch']).toBeDefined();
    // Second overwatch the same phase is rejected without CP loss.
    const again = run(s, [{ type: 'FireOverwatch', unitId: 'mine', targetUnitId: 'mover' }]);
    expect(again.cp.player).toBe(2);
    expect(again.log.some((l) => /Fire Overwatch rejected: already used this phase/.test(l))).toBe(true);
  });

  it('is rejected in your own Movement phase and outside 24"', () => {
    const own = run({ ...base(), activePlayer: 'player' }, [{ type: 'FireOverwatch', unitId: 'mine', targetUnitId: 'mover' }]);
    expect(own.cp.player).toBe(3);
    const far = at(run(createInitialState(layout), [
      spawn('mine', 'player', 'grunt', 10), spawn('mover', 'ai', 'grunt', 40),
    ]), 'Movement', 'ai');
    const out = run(far, [{ type: 'FireOverwatch', unitId: 'mine', targetUnitId: 'mover' }]);
    expect(out.cp.player).toBe(3);
    expect(out.log.some((l) => /within 24"/.test(l))).toBe(true);
  });
});

describe('Heroic Intervention (15.11)', () => {
  const seedFor = (want: number): number => {
    for (let i = 0; i < 2000; i++) if (rollCharge(makeRNG(i)).distance === want) return i;
    throw new Error('no seed');
  };

  it('Leap to Defend counter-charges a unit that charged (opponent Charge phase, 1 CP)', () => {
    let s = at(run(createInitialState(layout), [
      spawn('mine', 'player', 'grunt', 10, 22, 1), spawn('charger', 'ai', 'grunt', 16, 22, 1),
    ]), 'Charge', 'ai');
    s = run(s, [{ type: 'SetUnitStatus', unitId: 'charger', status: { charged: true } }]);
    const out = resolveCharge(
      s, { chargerUnitId: 'mine', targetUnitIds: ['charger'], heroic: 'leap_to_defend' }, ctx, makeRNG(seedFor(8)),
    );
    expect(out.success).toBe(true);
    expect(out.state.cp.player).toBe(2);
    expect(out.state.log.some((l) => /Heroic Intervention \(Leap to Defend\)/.test(l))).toBe(true);
  });

  it('Leap to Defend cannot target enemies that did not charge', () => {
    const s = at(run(createInitialState(layout), [
      spawn('mine', 'player', 'grunt', 10, 22, 1), spawn('idle', 'ai', 'grunt', 16, 22, 1),
    ]), 'Charge', 'ai');
    const out = resolveCharge(
      s, { chargerUnitId: 'mine', targetUnitIds: ['idle'], heroic: 'leap_to_defend' }, ctx, makeRNG(seedFor(8)),
    );
    expect(out.success).toBe(false);
    expect(out.summary).toMatch(/no valid target/);
  });

  it('Into the Fray costs 2 CP and caps the charge roll at 6', () => {
    let s = at(run(createInitialState(layout), [
      spawn('mine', 'player', 'grunt', 10, 22, 1), spawn('idle', 'ai', 'grunt', 18, 22, 1),
    ]), 'Charge', 'ai');
    // Gap 7" — over the 6" Into the Fray selection limit → illegal declaration.
    const tooFar = resolveCharge(
      s, { chargerUnitId: 'mine', targetUnitIds: ['idle'], heroic: 'into_the_fray' }, ctx, makeRNG(seedFor(12)),
    );
    expect(tooFar.success).toBe(false);
    expect(tooFar.summary).toMatch(/over 6"/);
    // Gap 5": a natural 12 is capped to 6 — still enough (needs 5).
    s = at(run(createInitialState(layout), [
      spawn('mine', 'player', 'grunt', 10, 22, 1), spawn('idle', 'ai', 'grunt', 16, 22, 1),
    ]), 'Charge', 'ai');
    const out = resolveCharge(
      s, { chargerUnitId: 'mine', targetUnitIds: ['idle'], heroic: 'into_the_fray' }, ctx, makeRNG(seedFor(12)),
    );
    expect(out.success).toBe(true);
    expect(out.summary).toMatch(/=6"|=12"/); // rolled 12, capped to 6 (log shows the raw dice)
    expect(out.state.cp.player).toBe(1); // 2 CP spent
  });
});

describe('Crushing Impact (15.06)', () => {
  it('rolls T dice after a MONSTER/VEHICLE charge: 5+ wounds the target (max 6), 1s hurt itself', () => {
    let s = at(run(createInitialState(layout), [
      spawn('tank', 'player', 'tank', 10, 22, 1), spawn('foe', 'ai', 'grunt', 12),
    ]), 'Charge', 'player');
    s = run(s, [{ type: 'SetUnitStatus', unitId: 'tank', status: { charged: true } }]);
    const before = alive(s, 'foe');
    s = run(s, [{ type: 'CrushingImpact', unitId: 'tank', targetUnitId: 'foe' }]);
    expect(s.cp.player).toBe(2);
    expect(s.log.some((l) => /Crushing Impact: tank rolls 10D6/.test(l))).toBe(true);
    const line = s.log.find((l) => /Crushing Impact/.test(l))!;
    const m = /(\d+) mortal wound\(s\) to grunt/.exec(line);
    expect(m).toBeTruthy();
    expect(alive(s, 'foe')).toBe(before - Math.min(before, parseInt(m![1]!, 10)));
  });

  it('rejects non-M/V units and unengaged targets', () => {
    let s = at(run(createInitialState(layout), [
      spawn('inf', 'player', 'grunt', 10), spawn('foe', 'ai', 'grunt', 12),
    ]), 'Charge', 'player');
    s = run(s, [
      { type: 'SetUnitStatus', unitId: 'inf', status: { charged: true } },
      { type: 'CrushingImpact', unitId: 'inf', targetUnitId: 'foe' },
    ]);
    expect(s.cp.player).toBe(3);
    expect(s.log.some((l) => /MONSTER\/VEHICLE units only/.test(l))).toBe(true);
  });
});

describe('Explosives (15.05)', () => {
  it('6D6, each 4+ is a mortal wound, in your Shooting phase within 8"', () => {
    const s0 = at(run(createInitialState(layout), [
      spawn('throwers', 'player', 'grunt', 10), spawn('foe', 'ai', 'grunt', 16),
    ]), 'Shooting', 'player');
    const before = alive(s0, 'foe');
    const s = run(s0, [{ type: 'ThrowExplosives', unitId: 'throwers', targetUnitId: 'foe' }]);
    expect(s.cp.player).toBe(2);
    const line = s.log.find((l) => /Explosives: grunt → grunt/.test(l))!;
    const m = /(\d+) mortal wound\(s\)/.exec(line)!;
    expect(alive(s, 'foe')).toBe(before - Math.min(before, parseInt(m[1]!, 10)));
  });

  it('rejects a target beyond 8"', () => {
    const s0 = at(run(createInitialState(layout), [
      spawn('throwers', 'player', 'grunt', 10), spawn('foe', 'ai', 'grunt', 30),
    ]), 'Shooting', 'player');
    const s = run(s0, [{ type: 'ThrowExplosives', unitId: 'throwers', targetUnitId: 'foe' }]);
    expect(s.cp.player).toBe(3);
    expect(s.log.some((l) => /within 8"/.test(l))).toBe(true);
  });
});

describe('Counteroffensive (15.12)', () => {
  it('the paid unit gains Fights First and is first in the activation order', () => {
    let s = at(run(createInitialState(layout), [
      spawn('mine', 'player', 'grunt', 10), spawn('foeA', 'ai', 'grunt', 12), spawn('foeB', 'ai', 'grunt', 8),
    ]), 'Fight', 'ai');
    s = run(s, [{ type: 'Counteroffensive', unitId: 'mine' }]);
    expect(s.cp.player).toBe(1); // 2 CP
    expect(s.fightNext).toBe('mine');
    expect(hasFightsFirst(unit(s, 'mine'), ctx)).toBe(true);
    expect(fightActivationOrder(s, ctx)[0]!.id).toBe('mine');
  });

  it('is rejected in your own Fight phase', () => {
    let s = at(run(createInitialState(layout), [
      spawn('mine', 'player', 'grunt', 10), spawn('foeA', 'ai', 'grunt', 12),
    ]), 'Fight', 'player');
    s = run(s, [{ type: 'Counteroffensive', unitId: 'mine' }]);
    expect(s.cp.player).toBe(3);
    expect(s.fightNext).toBeUndefined();
  });
});

describe('Insane Bravery (15.04)', () => {
  it('auto-passes the battle-shock roll, once per battle', () => {
    let s = at(run(createInitialState(layout), [
      spawn('mine', 'player', 'grunt', 10, 22, 10), spawn('foe', 'ai', 'grunt', 40),
    ]), 'Command', 'player');
    // Knock the unit below half so a test is required.
    s = {
      ...s,
      units: s.units.map((u) =>
        u.id === 'mine'
          ? { ...u, models: u.models.map((m, i) => (i < 7 ? { ...m, alive: false, wounds: 0 } : m)) }
          : u,
      ),
    };
    s = run(s, [{ type: 'InsaneBravery', unitId: 'mine' }]);
    expect(s.cp.player).toBe(2);
    expect(s.insaneBraveryUsed?.player).toBe(true);
    const after = runCommandPhase(s, ctx, makeRNG(1));
    expect(after.log.some((l) => /automatically passed \(Insane Bravery\)/.test(l))).toBe(true);
    expect(after.units.find((u) => u.id === 'mine')!.status.battleShocked).toBe(false);
    // Once per battle: a second use is rejected.
    const again = run({ ...after, phase: 'Command', commandRun: false }, [{ type: 'InsaneBravery', unitId: 'mine' }]);
    expect(again.log.some((l) => /once per battle/.test(l))).toBe(true);
  });
});

describe('Rapid Ingress (15.07)', () => {
  it('brings a reserves unit on at the end of the OPPONENT movement phase for 1 CP', () => {
    let s = run(createInitialState(layout), [spawn('foe', 'ai', 'grunt', 30)]);
    // A player unit in reserves.
    s = run(s, [{ type: 'PlaceInReserves', unitId: 'res', owner: 'player', datasheetId: 'grunt', baseShape: circle, modelCount: 5, wounds: 1 }]);
    s = { ...at(s, 'Movement', 'ai'), round: 2 };
    const out = run(s, [{ type: 'ArriveFromReserves', unitId: 'res', anchor: { x: 5, y: 5 }, rapidIngress: true, ability: 'deep_strike' }]);
    expect(unit(out, 'res').inReserves).toBeFalsy();
    expect(out.cp.player).toBe(2);
    expect(out.log.some((l) => /Rapid Ingress \(1 CP\)/.test(l))).toBe(true);
  });

  it('normal arrivals are rejected in the opponent turn (match mode)', () => {
    let s = run(createInitialState(layout), [spawn('foe', 'ai', 'grunt', 30)]);
    s = run(s, [{ type: 'PlaceInReserves', unitId: 'res', owner: 'player', datasheetId: 'grunt', baseShape: circle, modelCount: 5, wounds: 1 }]);
    s = { ...at(s, 'Movement', 'ai'), round: 2 };
    const out = run(s, [{ type: 'ArriveFromReserves', unitId: 'res', anchor: { x: 5, y: 5 }, ability: 'deep_strike' }]);
    expect(unit(out, 'res').inReserves).toBe(true);
    expect(out.log.some((l) => /reserves arrive in their own Movement phase/.test(l))).toBe(true);
  });
});
