// Base overlap (the 2026-06-12 owner rule): models can be moved AROUND each other but a base can
// never END on top of another base — across moves, deployment, Deep Strike, charges, pile-ins,
// and whole AI games.
import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../src/core/state';
import { resolveCharge, resolveFightMove, type EngineContext } from '../src/core/engine';
import { basesOverlap } from '../src/core/geometry';
import { clampDeltaAvoidingOverlap, occupiedBases, unitOverlaps } from '../src/core/collision';
import { checkUnitDeployment, deepStrikeArrivalLegal } from '../src/core/deployment';
import { makeRNG } from '../src/core/rng';
import { runMatch, type MatchData } from '../src/core/ai/match';
import { datasheetsById, deployAbilityForDatasheet, stratagems, layouts } from '../src/data/loaders';
import type { Datasheet, GameState, Layout, Roster, UnitInstance, Vec2 } from '../src/core/types';
import bane from '../data/rosters/bane.json';
import rogue from '../data/rosters/rogue_traders_army.json';

const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] },
};
const circle = { kind: 'circle' as const, radius: 0.49 };
const trooper: Datasheet = {
  id: 'troop', name: 'Troopers', faction: 'AoI',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [{ name: 'Claws', type: 'melee', attacks: '2', skill: 4, S: 4, AP: 0, D: '1', keywords: [] }],
  baseShape: circle, keywords: ['INFANTRY'], abilityIds: [],
};
const ctx: EngineContext = { datasheets: new Map([[trooper.id, trooper]]) };
const rng = makeRNG(7);

function spawn(s: GameState, id: string, owner: 'player' | 'ai', x: number, y: number, n = 1): GameState {
  return reduce(s, {
    type: 'SpawnUnit', unitId: id, owner, datasheetId: 'troop', baseShape: circle,
    modelCount: n, wounds: 1, anchor: { x, y },
  }, rng, ctx);
}
const asMatch = (s: GameState, phase: string): GameState => ({ ...s, mode: 'match', phase });
const unitOf = (s: GameState, id: string): UnitInstance => s.units.find((u) => u.id === id)!;

describe('geometry/collision primitives', () => {
  it('bases overlap only when closer than the sum of radii (touching is legal)', () => {
    const a = { x: 0, y: 0 };
    expect(basesOverlap(a, circle, { x: 0.98, y: 0 }, circle)).toBe(false); // exact contact
    expect(basesOverlap(a, circle, { x: 1.2, y: 0 }, circle)).toBe(false);
    expect(basesOverlap(a, circle, { x: 0.5, y: 0 }, circle)).toBe(true);
    expect(basesOverlap(a, circle, a, circle)).toBe(true); // stacked dead-centre
  });

  it('clampDeltaAvoidingOverlap backs a rigid translate off to the last clear point', () => {
    const occupied = [{ pos: { x: 5, y: 0 }, shape: circle }];
    const clamped = clampDeltaAvoidingOverlap([{ pos: { x: 0, y: 0 }, shape: circle }], occupied, { x: 5, y: 0 });
    const len = Math.hypot(clamped.x, clamped.y);
    expect(len).toBeLessThanOrEqual(5 - 0.98 + 0.02); // stops at ~base contact
    expect(len).toBeGreaterThan(3.5);
    expect(basesOverlap({ x: clamped.x, y: clamped.y }, circle, { x: 5, y: 0 }, circle)).toBe(false);
  });
});

describe('movement cannot end stacked', () => {
  it('EndMove rejects a move ending on another model, accepts after moving clear', () => {
    let s = spawn(spawn(createInitialState(layout), 'a', 'player', 10, 10), 'b', 'ai', 12, 10);
    s = asMatch(s, 'Movement');
    s = reduce(s, { type: 'BeginMove', unitIds: ['a'], mode: 'normal' }, rng, ctx);
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['a'], delta: { x: 2, y: 0 } }, rng, ctx); // onto b
    expect(unitOverlaps(s, unitOf(s, 'a'), ctx)).toBe(true);
    s = reduce(s, { type: 'EndMove', unitIds: ['a'] }, rng, ctx);
    expect(s.log.at(-1)).toMatch(/ends on top of another model/);
    expect(unitOf(s, 'a').status.moveMode).toBe('normal'); // still mid-activation

    s = reduce(s, { type: 'NudgeUnit', unitIds: ['a'], delta: { x: -1.5, y: 0 } }, rng, ctx);
    s = reduce(s, { type: 'EndMove', unitIds: ['a'] }, rng, ctx);
    expect(s.log.at(-1)).toMatch(/Move confirmed/);
    expect(unitOf(s, 'a').status.moved).toBe(true);
  });

  it('models inside one unit cannot be stacked on each other either', () => {
    let s = spawn(createInitialState(layout), 'a', 'player', 10, 10, 2);
    s = asMatch(s, 'Movement');
    s = reduce(s, { type: 'BeginMove', unitIds: ['a'], mode: 'normal' }, rng, ctx);
    const [m0, m1] = unitOf(s, 'a').models;
    s = reduce(s, { type: 'MoveModel', modelId: m1!.id, pos: m0!.pos }, rng, ctx); // stack squad mates
    s = reduce(s, { type: 'EndMove', unitIds: ['a'] }, rng, ctx);
    expect(s.log.at(-1)).toMatch(/ends on top of another model/);
  });
});

describe('set-up cannot stack bases', () => {
  it('DeployUnit refuses placement on top of an existing unit', () => {
    let s = spawn(createInitialState(layout), 'a', 'player', 10, 10);
    s = reduce(s, {
      type: 'DeployUnit', unitId: 'b', owner: 'player', datasheetId: 'troop', baseShape: circle,
      modelCount: 1, wounds: 1, anchor: { x: 10, y: 10 },
    }, rng, ctx);
    expect(s.units.find((u) => u.id === 'b')).toBeUndefined();
    expect(s.log.at(-1)).toMatch(/cannot be set up on top of other models/);

    s = reduce(s, {
      type: 'DeployUnit', unitId: 'b', owner: 'player', datasheetId: 'troop', baseShape: circle,
      modelCount: 1, wounds: 1, anchor: { x: 13, y: 10 },
    }, rng, ctx);
    expect(s.units.find((u) => u.id === 'b')).toBeDefined();
  });

  it('checkUnitDeployment / deepStrikeArrivalLegal flag stacked positions per model', () => {
    const occupied = [{ pos: { x: 10, y: 10 }, shape: circle }];
    const dep = checkUnitDeployment([{ x: 10, y: 10 }, { x: 14, y: 10 }], circle, layout, 'player', 'standard', [], occupied);
    expect(dep.legal).toBe(false);
    expect(dep.perModel).toEqual([false, true]);
    expect(dep.reason).toMatch(/on top of other models/);

    const ds = deepStrikeArrivalLegal([{ x: 10, y: 10 }], circle, [], 2, occupied);
    expect(ds.legal).toBe(false);
    expect(ds.reason).toMatch(/on top of other models/);
    expect(deepStrikeArrivalLegal([{ x: 14, y: 10 }], circle, [], 2, occupied).legal).toBe(true);
  });
});

describe('engine moves cannot stack bases', () => {
  it('a successful charge never ends overlapping a friendly screen between charger and target', () => {
    // Friendly wall at x=13 directly on the line from the charger (10,10) to the target (16,10).
    let s = spawn(spawn(createInitialState(layout), 'charger', 'player', 10, 10), 'target', 'ai', 16, 10);
    s = spawn(s, 'wall', 'player', 13, 10, 3); // block formation straddles the aim line
    s = asMatch(s, 'Charge');
    let successes = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = resolveCharge(s, { chargerUnitId: 'charger', targetUnitId: 'target' }, ctx, makeRNG(seed));
      if (!r.success) continue;
      successes++;
      const after = r.state;
      expect(unitOverlaps(after, unitOf(after, 'charger'), ctx)).toBe(false);
    }
    expect(successes).toBeGreaterThan(0); // the fan-out still finds a path around the wall
  });

  it('pile-in stops at the friendly unit in the way instead of moving through it', () => {
    let s = spawn(spawn(createInitialState(layout), 'p', 'player', 10, 10), 'e', 'ai', 14, 10);
    s = spawn(s, 'friend', 'player', 12.8, 10);
    s = asMatch(s, 'Fight');
    const r = resolveFightMove(s, { unitId: 'p', mode: 'pile_in' }, ctx);
    const moved = unitOf(r.state, 'p');
    expect(unitOverlaps(r.state, moved, ctx)).toBe(false);
    expect(moved.models[0]!.pos.x).toBeGreaterThan(10.5); // it still piled in…
    expect(moved.models[0]!.pos.x).toBeLessThan(12.8 - 0.9); // …but stopped at the friend's base
  });
});

describe('AI games never stack bases', () => {
  const data: MatchData = { ctx: { datasheets: datasheetsById }, deployAbility: deployAbilityForDatasheet, stratagems };
  const board = layouts.find((l) => l.id === 'ca2025-hammer-and-anvil-1') ?? layouts[0]!;

  /** Assert no two settled models overlap (units mid-activation may pass over others). */
  function expectNoStacking(state: GameState): void {
    const models: { pos: Vec2; shape: typeof circle; key: string }[] = [];
    for (const u of state.units) {
      if (u.inReserves || u.status.moveMode) continue;
      for (const m of u.models) {
        if (!m.alive) continue;
        const shape =
          (m.datasheetId ? datasheetsById.get(m.datasheetId)?.baseShape : undefined) ??
          datasheetsById.get(u.datasheetId)?.baseShape ?? circle;
        models.push({ pos: m.pos, shape: shape as typeof circle, key: `${u.id}/${m.id}` });
      }
    }
    for (let i = 0; i < models.length; i++) {
      for (let j = i + 1; j < models.length; j++) {
        if (basesOverlap(models[i]!.pos, models[i]!.shape, models[j]!.pos, models[j]!.shape)) {
          throw new Error(`stacked bases: ${models[i]!.key} on ${models[j]!.key} (round ${state.round}, ${state.phase})`);
        }
      }
    }
  }

  it('a full Bane vs Rogue Trader game keeps every settled base clear after every intent', () => {
    const result = runMatch(
      {
        layout: board,
        rosters: { player: bane as unknown as Roster, ai: rogue as unknown as Roster },
        profiles: { player: 'balanced', ai: 'balanced' },
        seed: 42,
        observe: expectNoStacking,
      },
      data,
    );
    expect(result.ended).toBe(true);
    expect(result.forcedAdvances).toBe(0);
    expect(result.rejectedLog).toEqual([]);
  }, 120_000);

  it('occupiedBases skips reserves and dead models', () => {
    let s = spawn(createInitialState(layout), 'a', 'player', 10, 10, 2);
    s = {
      ...s,
      units: s.units.map((u) => ({
        ...u,
        models: u.models.map((m, i) => (i === 0 ? { ...m, alive: false } : m)),
      })),
    };
    expect(occupiedBases(s, ctx)).toHaveLength(1);
    expect(occupiedBases(s, ctx, ['a'])).toHaveLength(0);
  });
});
