import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import type { BaseShape, Datasheet, GameState, Layout, UnitInstance } from '../src/core/types';
import type { EngineContext } from '../src/core/engine';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: {
    player: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 44 }, { x: 0, y: 44 }],
    opponent: [{ x: 48, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 44 }, { x: 48, y: 44 }],
  },
};

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [], baseShape: circle, keywords: ['Infantry'], abilityIds: [], ...over,
});

const ctx: EngineContext = {
  datasheets: new Map<string, Datasheet>([
    ['leader', ds('leader', { keywords: ['Infantry', 'Character'], canLead: ['squad'] })],
    ['squad', ds('squad', { canBeLedBy: ['leader'] })],
    ['trooper', ds('trooper')],
    ['fast', ds('fast', { models: [{ name: 'fast', M: 10, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }] })],
  ]),
};

const rng = makeRNG(7);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);

describe('deployment flow', () => {
  it('NewBattle enters setup at the roll-off step and clears the board', () => {
    const s = reduce(createInitialState(layout), { type: 'NewBattle' }, rng, ctx);
    expect(s.stage).toBe('setup');
    expect(s.setup?.step).toBe('roll_roles');
    expect(s.units).toHaveLength(0);
  });

  it('RollRoles sets Attacker/Defender and makes the Defender deploy first', () => {
    const s = run(createInitialState(layout), [{ type: 'NewBattle' }, { type: 'RollRoles' }]);
    expect(s.setup?.attacker).toBeDefined();
    expect(s.setup?.defender).toBe(s.setup!.attacker === 'player' ? 'ai' : 'player');
    expect(s.setup?.toDeploy).toBe(s.setup?.defender);
    expect(s.setup?.roleRoll?.player).toBeGreaterThanOrEqual(1);
  });

  it('DeployUnit rejects placement outside the owner zone, accepts inside it', () => {
    let s = run(createInitialState(layout), [{ type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' }]);
    // player is Defender (left zone). Drop INSIDE the left zone -> accepted.
    s = reduce(s, {
      type: 'DeployUnit', unitId: 'p1', owner: 'player', datasheetId: 'squad',
      baseShape: circle, modelCount: 3, wounds: 1, anchor: { x: 4, y: 22 },
    }, rng, ctx);
    expect(s.units).toHaveLength(1);
    // Drop OUTSIDE the zone (midfield) -> rejected, no new unit.
    const before = s.units.length;
    s = reduce(s, {
      type: 'DeployUnit', unitId: 'p2', owner: 'player', datasheetId: 'squad',
      baseShape: circle, modelCount: 3, wounds: 1, anchor: { x: 30, y: 22 },
    }, rng, ctx);
    expect(s.units).toHaveLength(before);
    expect(s.log.some((l) => /Deployment rejected/.test(l))).toBe(true);
  });

  it('Infiltrators may deploy in no-mans-land', () => {
    let s = run(createInitialState(layout), [{ type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' }]);
    s = reduce(s, {
      type: 'DeployUnit', unitId: 'inf', owner: 'player', datasheetId: 'squad',
      baseShape: circle, modelCount: 1, wounds: 1, anchor: { x: 28, y: 22 }, ability: 'infiltrators',
    }, rng, ctx);
    expect(s.units).toHaveLength(1);
  });

  it('runs the roll-offs and begins the battle', () => {
    const s = run(createInitialState(layout), [
      { type: 'NewBattle' }, { type: 'RollRoles' }, { type: 'RollFirstTurn' }, { type: 'BeginBattle' },
    ]);
    expect(s.stage).toBe('battle');
    expect(s.setup).toBeUndefined();
    expect(s.round).toBe(1);
    expect(['player', 'ai']).toContain(s.activePlayer);
  });
});

describe('leader attachment', () => {
  const base = (): GameState => run(createInitialState(layout), [
    { type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' },
    { type: 'DeployUnit', unitId: 'bg', owner: 'player', datasheetId: 'squad', baseShape: circle, modelCount: 5, wounds: 1, anchor: { x: 4, y: 22 } },
    { type: 'DeployUnit', unitId: 'ldr', owner: 'player', datasheetId: 'leader', baseShape: circle, modelCount: 1, wounds: 1, anchor: { x: 6, y: 22 } },
  ]);

  it('merges an eligible leader into ONE unit instance', () => {
    const s = reduce(base(), { type: 'AttachLeader', leaderUnitId: 'ldr', bodyguardUnitId: 'bg' }, rng, ctx);
    expect(s.units.find((u) => u.id === 'ldr')).toBeUndefined(); // leader instance absorbed
    const bg = s.units.find((u) => u.id === 'bg')!;
    expect(bg.models).toHaveLength(6); // 5 bodyguard + 1 leader
    expect(bg.attachedLeaders?.[0]?.datasheetId).toBe('leader');
    expect(bg.models.some((m) => m.datasheetId === 'leader')).toBe(true); // leader model tagged
  });

  it('detaches a merged leader back into its own unit', () => {
    let s = reduce(base(), { type: 'AttachLeader', leaderUnitId: 'ldr', bodyguardUnitId: 'bg' }, rng, ctx);
    s = reduce(s, { type: 'DetachLeader', leaderUnitId: 'ldr' }, rng, ctx);
    expect(s.units.find((u) => u.id === 'ldr')).toBeDefined();
    expect(s.units.find((u) => u.id === 'bg')!.models).toHaveLength(5);
    expect(s.units.find((u) => u.id === 'bg')!.attachedLeaders ?? []).toHaveLength(0);
  });

  it('rejects an attachment the data does not allow', () => {
    let s = base();
    s = reduce(s, {
      type: 'DeployUnit', unitId: 'lone', owner: 'player', datasheetId: 'trooper', baseShape: circle, modelCount: 1, wounds: 1, anchor: { x: 8, y: 22 },
    }, rng, ctx);
    s = reduce(s, { type: 'AttachLeader', leaderUnitId: 'ldr', bodyguardUnitId: 'lone' }, rng, ctx);
    expect(s.units.find((u) => u.id === 'ldr')!.attachedTo).toBeUndefined();
    expect(s.log.some((l) => /Attach rejected/.test(l))).toBe(true);
  });
});

describe('movement budget + coherency gate', () => {
  // A battle-stage state with one 3-model player unit, tightly packed and coherent.
  const seed = (): GameState => {
    let s = createInitialState(layout);
    s = reduce(s, {
      type: 'SpawnUnit', unitId: 'u', owner: 'player', datasheetId: 'trooper',
      baseShape: circle, modelCount: 3, wounds: 1, anchor: { x: 10, y: 22 }, formation: 'line',
    }, rng, ctx);
    return s;
  };

  it('clamps a single model to its M" budget from the move origin', () => {
    let s = seed();
    s = reduce(s, { type: 'BeginMove', unitIds: ['u'], mode: 'normal' }, rng, ctx);
    const m0 = s.units[0]!.models[0]!;
    const start = m0.moveStart!;
    // Try to drag it 30" away in x — should clamp to 6" (M).
    s = reduce(s, { type: 'MoveModel', modelId: m0.id, pos: { x: start.x + 30, y: start.y } }, rng, ctx);
    const moved = s.units[0]!.models[0]!;
    const d = Math.hypot(moved.pos.x - start.x, moved.pos.y - start.y);
    expect(d).toBeCloseTo(6, 5);
  });

  it('NudgeUnit rigidly translates a unit within budget and EndMove confirms it', () => {
    let s = seed();
    s = reduce(s, { type: 'BeginMove', unitIds: ['u'], mode: 'normal' }, rng, ctx);
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['u'], delta: { x: 5, y: 0 } }, rng, ctx);
    // every model translated by exactly 5" (rigid) -> coherency preserved.
    for (const m of s.units[0]!.models) {
      expect(m.pos.x - m.moveStart!.x).toBeCloseTo(5, 5);
    }
    s = reduce(s, { type: 'EndMove', unitIds: ['u'] }, rng, ctx);
    expect(s.units[0]!.status.moved).toBe(true);
    expect(s.units[0]!.status.moveMode).toBeUndefined();
  });

  it('NudgeUnit is incremental and clamps the cumulative move to the budget', () => {
    let s = seed();
    s = reduce(s, { type: 'BeginMove', unitIds: ['u'], mode: 'normal' }, rng, ctx);
    const start = s.units[0]!.models[0]!.moveStart!;
    // Two 4" nudges -> 8" requested, clamped to 6" (M).
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['u'], delta: { x: 4, y: 0 } }, rng, ctx);
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['u'], delta: { x: 4, y: 0 } }, rng, ctx);
    const m0 = s.units[0]!.models[0]!;
    expect(Math.hypot(m0.pos.x - start.x, m0.pos.y - start.y)).toBeCloseTo(6, 5);
  });

  it('CancelMove snaps the unit back to its origins and clears the activation', () => {
    let s = seed();
    const before = s.units[0]!.models.map((m) => ({ ...m.pos }));
    s = reduce(s, { type: 'BeginMove', unitIds: ['u'], mode: 'normal' }, rng, ctx);
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['u'], delta: { x: 5, y: 0 } }, rng, ctx);
    s = reduce(s, { type: 'CancelMove', unitIds: ['u'] }, rng, ctx);
    expect(s.units[0]!.status.moveMode).toBeUndefined();
    s.units[0]!.models.forEach((m, i) => {
      expect(m.pos.x).toBeCloseTo(before[i]!.x, 5);
      expect(m.pos.y).toBeCloseTo(before[i]!.y, 5);
    });
  });

  it('refuses to confirm a move that breaks coherency', () => {
    let s = seed();
    s = reduce(s, { type: 'BeginMove', unitIds: ['u'], mode: 'normal' }, rng, ctx);
    // Drag the middle model 6" away (within budget) so it detaches from its neighbours.
    const mid = s.units[0]!.models[1]!;
    s = reduce(s, { type: 'MoveModel', modelId: mid.id, pos: { x: mid.moveStart!.x, y: mid.moveStart!.y + 6 } }, rng, ctx);
    s = reduce(s, { type: 'EndMove', unitIds: ['u'] }, rng, ctx);
    expect(s.units[0]!.status.moved).toBeUndefined(); // not confirmed
    expect(s.log.some((l) => /out of coherency/.test(l))).toBe(true);
  });
});

describe('command phase battle-shock report', () => {
  it('records the 2D6 dice for a below-half unit so the UI can render them', () => {
    const u: UnitInstance = {
      id: 'u', owner: 'player', datasheetId: 'trooper', startingModels: 4, status: {},
      models: [{ id: 'u:m0', unitId: 'u', pos: { x: 5, y: 5 }, wounds: 1, alive: true }], // 1 of 4 -> below half
    };
    const s: GameState = { ...createInitialState(layout), units: [u], activePlayer: 'player', round: 2 };
    const r = reduce(s, { type: 'RunCommandPhase' }, makeRNG(2), ctx);
    expect(r.lastBattleShock?.length).toBeGreaterThan(0);
    expect(r.lastBattleShock![0]!.roll).toHaveLength(2);
    expect(r.lastBattleShock![0]!.unitName).toBe('trooper');
  });
});

describe('reserves / deep strike arrival', () => {
  const reserveUnit = (): UnitInstance => ({
    id: 'ds', owner: 'player', datasheetId: 'trooper',
    models: [{ id: 'ds:m0', unitId: 'ds', pos: { x: 0, y: 0 }, wounds: 1, alive: true }],
    startingModels: 1, status: {}, inReserves: true,
  });
  const enemy: UnitInstance = {
    id: 'e', owner: 'ai', datasheetId: 'trooper',
    models: [{ id: 'e:m0', unitId: 'e', pos: { x: 50, y: 22 }, wounds: 1, alive: true }],
    startingModels: 1, status: {},
  };

  it('cannot arrive in round 1; arrives in round 2 far from enemies', () => {
    const s1: GameState = { ...createInitialState(layout), round: 1, units: [reserveUnit(), enemy] };
    const r1 = reduce(s1, { type: 'ArriveFromReserves', unitId: 'ds', anchor: { x: 10, y: 22 } }, rng, ctx);
    expect(r1.units.find((u) => u.id === 'ds')!.inReserves).toBe(true); // still in reserves

    const s2: GameState = { ...s1, round: 2 };
    const r2 = reduce(s2, { type: 'ArriveFromReserves', unitId: 'ds', anchor: { x: 10, y: 22 }, ability: 'deep_strike' }, rng, ctx);
    const arrived = r2.units.find((u) => u.id === 'ds')!;
    expect(arrived.inReserves).toBe(false);
    expect(arrived.arrivedRound).toBe(2);
    expect(arrived.status.moved).toBe(true);
  });

  it('rejects an arrival within 8" of an enemy', () => {
    const s2: GameState = { ...createInitialState(layout), round: 2, units: [reserveUnit(), enemy] };
    const r = reduce(s2, { type: 'ArriveFromReserves', unitId: 'ds', anchor: { x: 46, y: 22 }, ability: 'deep_strike' }, rng, ctx); // ~4" from enemy
    expect(r.units.find((u) => u.id === 'ds')!.inReserves).toBe(true);
    expect(r.log.some((l) => /Reserves arrival rejected/.test(l))).toBe(true);
  });
});
