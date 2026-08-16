// Tests for the 2026-06-12 review fixes:
//  1. movement after a previous-turn Advance (+ stale-activation cleanup),
//  2. unit-level fighting (FightUnit — per-model melee weapon picks),
//  3/4. AI unit roles + home-objective garrison,
//  5. visibility: per-bearer line of sight, into-but-not-through ruins,
//  6. Scout moves (pre-battle step),
//  7. pre-deployment Leader pairing (Backroom Deals) + Warrant of Trade,
//  plus ability-audit fixes: Lone Operative, innate Stealth/FNP, Fights First, Frenzon.

import { describe, expect, it } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { losBlocked, unitCanSee } from '../src/core/los';
import {
  eligibleToCharge, eligibleToShoot, hasFightsFirst, pendingScoutUnits, scoutTurn, validShootingTargets,
} from '../src/core/phases';
import { planUnitFight, resolveUnitFight, type EngineContext } from '../src/core/engine';
import {
  canActAfterAdvance, innateEffectIds, scoutDistance, unitScoutDistance,
} from '../src/core/abilities';
import { classifyDatasheet, homeGarrisonId, rolePlan, unitRolePlan } from '../src/core/ai/roles';
import { homeObjective } from '../src/core/ai/move';
import { zoneFor } from '../src/core/deployment';
import { datasheetsById } from '../src/data/loaders';
import type { Datasheet, GameState, Layout, Side, TerrainPiece, UnitInstance, Vec2 } from '../src/core/types';
import layout1 from '../data/layouts/ca2025-hammer-and-anvil-1.json';

/** A point safely inside a side's deployment zone (zone polygons here are convex rectangles). */
function zoneAnchor(side: Side, layout: Layout = layout1 as unknown as Layout): Vec2 {
  const zone = zoneFor(layout, side);
  return {
    x: zone.reduce((s, p) => s + p.x, 0) / zone.length,
    y: zone.reduce((s, p) => s + p.y, 0) / zone.length,
  };
}

const rng = makeRNG(0xbeef);
const realCtx: EngineContext = { datasheets: datasheetsById };

const EVERSOR = '000000872';
const CALLIDUS = '000000871';
const VINDICARE = '000000870';
const ROGUE_TRADER = '000002762';
const BREACHERS = '000002587';
const BASILISK = '000000695';
const LEMAN_RUSS = '000000700';

// ── tiny synthetic datasheets for combat-shape tests ─────────────────────────
function mkDs(id: string, over: Partial<Datasheet> = {}): Datasheet {
  return {
    id,
    name: id,
    faction: 'T',
    models: [{ name: id, M: 6, T: 4, Sv: 3, W: 2, Ld: 7, OC: 1 }],
    weapons: [],
    baseShape: { kind: 'circle', radius: 0.5 },
    keywords: ['Infantry'],
    abilityIds: [],
    ...over,
  };
}

const flatLayout: Layout = {
  id: 'flat', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] },
};

function matchState(layout: Layout = flatLayout, phase = 'Fight'): GameState {
  return { ...createInitialState(layout), mode: 'match', stage: 'battle', phase };
}

const spawn = (
  id: string, ds: string, owner: 'player' | 'ai', x: number, y: number, n = 1, wargear?: Record<string, number>,
): Intent => ({
  type: 'SpawnUnit', unitId: id, owner, datasheetId: ds, baseShape: { kind: 'circle', radius: 0.5 },
  modelCount: n, wounds: 2, anchor: { x, y }, ...(wargear ? { wargear } : {}),
});

// ═════════════════════════════════════════════════════════════════════════════
describe('1 · movement after a previous-turn Advance', () => {
  const assassinCtx: EngineContext = { datasheets: datasheetsById };

  it('units that Advanced can move again next round (flags reset)', () => {
    let s = matchState(layout1 as unknown as Layout, 'Movement');
    s = reduce(s, { type: 'SpawnUnit', unitId: 'ev', owner: 'player', datasheetId: EVERSOR, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: { x: 10, y: 10 } }, rng, assassinCtx);
    s = reduce(s, { type: 'SpawnUnit', unitId: 'cal', owner: 'player', datasheetId: CALLIDUS, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: { x: 15, y: 10 } }, rng, assassinCtx);

    s = reduce(s, { type: 'BeginMove', unitIds: ['ev', 'cal'], mode: 'advance' }, rng, assassinCtx);
    s = reduce(s, { type: 'EndMove', unitIds: ['ev', 'cal'] }, rng, assassinCtx);
    expect(s.units.find((u) => u.id === 'ev')!.status.advanced).toBe(true);

    // Same turn: re-activation refused.
    s = reduce(s, { type: 'BeginMove', unitIds: ['ev'], mode: 'normal' }, rng, assassinCtx);
    expect(s.units.find((u) => u.id === 'ev')!.status.moveBudget).toBeUndefined();

    // Cycle a full round back to the player's Movement phase.
    for (let i = 0; i < 9; i++) s = reduce(s, { type: 'AdvancePhase' }, rng, assassinCtx);
    expect(s.round).toBe(2);
    s = reduce(s, { type: 'AdvancePhase' }, rng, assassinCtx); // Command → Movement
    expect(s.phase).toBe('Movement');

    s = reduce(s, { type: 'BeginMove', unitIds: ['ev', 'cal'], mode: 'normal' }, rng, assassinCtx);
    expect(s.units.find((u) => u.id === 'ev')!.status.moveBudget).toBeGreaterThan(0);
    expect(s.units.find((u) => u.id === 'cal')!.status.moveBudget).toBeGreaterThan(0);
  });

  it('AdvancePhase cancels an unconfirmed activation (no stale moveMode wedging later turns)', () => {
    const ctx: EngineContext = { datasheets: new Map([['d', mkDs('d')]]) };
    let s = matchState(flatLayout, 'Movement');
    s = reduce(s, spawn('a', 'd', 'player', 10, 10), rng, ctx);
    s = reduce(s, { type: 'BeginMove', unitIds: ['a'], mode: 'normal' }, rng, ctx);
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['a'], delta: { x: 3, y: 0 } }, rng, ctx);
    expect(s.units[0]!.models[0]!.pos.x).toBeCloseTo(13);

    // Leaving the phase mid-activation: the move never happened — models snap back, flags clear.
    s = reduce(s, { type: 'AdvancePhase' }, rng, ctx);
    const u = s.units[0]!;
    expect(u.status.moveMode).toBeUndefined();
    expect(u.status.moveBudget).toBeUndefined();
    expect(u.models[0]!.pos.x).toBeCloseTo(10);
    expect(s.log.some((l) => /Unconfirmed move cancelled/.test(l))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('2 · unit-level fighting (FightUnit)', () => {
  const hammer = { name: 'Thunder hammer', type: 'melee' as const, attacks: '3', skill: 4, S: 8, AP: -2, D: '2', keywords: [] };
  const knife = { name: 'Combat knife', type: 'melee' as const, attacks: '2', skill: 3, S: 4, AP: 0, D: '1', keywords: [] };
  const tail = { name: 'Tail spike', type: 'melee' as const, attacks: '1', skill: 3, S: 5, AP: -1, D: '1', keywords: ['extra attacks'] };
  const squad = mkDs('squad', { weapons: [hammer, knife, tail] });
  const blob = mkDs('blob', { models: [{ name: 'blob', M: 6, T: 5, Sv: 3, W: 2, Ld: 7, OC: 1 }] });
  const ctx: EngineContext = { datasheets: new Map([['squad', squad], ['blob', blob]]) };

  function engagedState(): GameState {
    let s = matchState();
    s = reduce(s, spawn('a', 'squad', 'player', 10, 10, 5, { 'Thunder hammer': 2, 'Combat knife': 5, 'Tail spike': 5 }), rng, ctx);
    s = reduce(s, spawn('t', 'blob', 'ai', 10.5, 11.2, 6), rng, ctx);
    return s;
  }

  it('per-model weapon picks: hammer bearers swing hammers, the rest swing knives, Extra Attacks on top', () => {
    const s = engagedState();
    const plan = planUnitFight(s, s.units[0]!, ctx, 't');
    const byName = Object.fromEntries(plan.fire.map((f) => [f.weapon.name, f.carriers]));
    expect(byName['Thunder hammer']).toBe(2); // the two bearers
    expect(byName['Combat knife']).toBe(3); // remaining models, not all 5
    expect(byName['Tail spike']).toBe(5); // Extra Attacks: swings in addition
  });

  it('resolves every weapon sequentially, marks hasFought, and refuses a second activation', () => {
    let s = engagedState();
    const out = resolveUnitFight(s, { attackerUnitId: 'a', targetUnitId: 't' }, ctx, makeRNG(7));
    expect(out.rejected).toBeUndefined();
    s = out.state;
    expect(s.units.find((u) => u.id === 'a')!.status.hasFought).toBe(true);
    const again = resolveUnitFight(s, { attackerUnitId: 'a', targetUnitId: 't' }, ctx, makeRNG(8));
    expect(again.rejected).toMatch(/already fought/);
  });

  it('is phase-gated in a match and requires engagement range', () => {
    let s = engagedState();
    s = { ...s, phase: 'Shooting' };
    expect(resolveUnitFight(s, { attackerUnitId: 'a', targetUnitId: 't' }, ctx, makeRNG(1)).rejected).toMatch(/Fight phase/);
    let far = matchState();
    far = reduce(far, spawn('a', 'squad', 'player', 10, 10, 5), rng, ctx);
    far = reduce(far, spawn('t', 'blob', 'ai', 30, 30, 6), rng, ctx);
    expect(resolveUnitFight(far, { attackerUnitId: 'a', targetUnitId: 't' }, ctx, makeRNG(1)).rejected).toMatch(/engagement/);
  });

  it('FightUnit intent flows through the reducer', () => {
    let s = engagedState();
    s = reduce(s, { type: 'FightUnit', attackerUnitId: 'a', targetUnitId: 't' }, makeRNG(3), ctx);
    expect(s.units.find((u) => u.id === 'a')!.status.hasFought).toBe(true);
    expect(s.log.some((l) => /fights/.test(l))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('5 · visibility: into ruins but not through them; per-bearer LoS', () => {
  const wall: TerrainPiece = {
    id: 'w', type: 'ruin_blocking', height: 'tall',
    polygon: [{ x: 20, y: 5 }, { x: 22, y: 5 }, { x: 22, y: 25 }, { x: 20, y: 25 }],
  };

  it('point rules: blocked through, visible into, visible out from within', () => {
    const a = { x: 10, y: 15 };
    const beyond = { x: 30, y: 15 };
    const inside = { x: 21, y: 15 };
    expect(losBlocked(a, beyond, [wall])).toBe(true); // completely through → blocked
    expect(losBlocked(a, inside, [wall])).toBe(false); // into the ruin → visible
    expect(losBlocked(inside, beyond, [wall])).toBe(false); // wholly within sees out
    expect(unitCanSee([a], [beyond], [wall])).toBe(false);
  });

  it('two ruins: a model inside one cannot see through ANOTHER', () => {
    const wall2: TerrainPiece = { ...wall, id: 'w2', polygon: [{ x: 25, y: 5 }, { x: 27, y: 5 }, { x: 27, y: 25 }, { x: 25, y: 25 }] };
    const inside = { x: 21, y: 15 };
    const beyondBoth = { x: 35, y: 15 };
    expect(losBlocked(inside, beyondBoth, [wall, wall2])).toBe(true);
  });

  it('per-bearer LoS: a merged Leader behind the wall cannot fire its own gun, the unit still shoots', () => {
    const gun = { name: 'Gun', type: 'ranged' as const, range: 24, attacks: '2', skill: 3, S: 4, AP: 0, D: '1', keywords: [] };
    const leadergun = { name: 'Leadergun', type: 'ranged' as const, range: 24, attacks: '1', skill: 2, S: 5, AP: -1, D: '2', keywords: [] };
    const body = mkDs('body', { weapons: [gun] });
    const lead = mkDs('lead', { weapons: [leadergun], keywords: ['Infantry', 'Character'], canLead: ['body'] });
    const tgt = mkDs('tgt');
    const ctx: EngineContext = { datasheets: new Map([['body', body], ['lead', lead], ['tgt', tgt]]) };
    const terrainLayout: Layout = { ...flatLayout, terrain: [wall] };

    let s = matchState(terrainLayout, 'Shooting');
    s = reduce(s, spawn('b', 'body', 'player', 15, 35), rng, ctx); // clear line above the wall
    s = reduce(s, spawn('l', 'lead', 'player', 15, 15), rng, ctx); // behind the wall
    s = reduce(s, spawn('t', 'tgt', 'ai', 30, 15, 2), rng, ctx);
    s = reduce(s, { type: 'AttachLeader', leaderUnitId: 'l', bodyguardUnitId: 'b' }, rng, ctx);
    const merged = s.units.find((u) => (u.attachedLeaders ?? []).length > 0)!;
    // Pin the leader model back behind the wall (the merge seats it next to the bodyguard).
    s = {
      ...s,
      units: s.units.map((u) =>
        u.id === merged.id
          ? { ...u, models: u.models.map((m) => (m.datasheetId === 'lead' ? { ...m, pos: { x: 15, y: 15 } } : m)) }
          : u,
      ),
    };
    s = reduce(s, { type: 'ShootUnit', attackerUnitId: merged.id, targetUnitId: 't' }, makeRNG(11), ctx);
    expect(s.log.some((l) => /Leadergun not fired: no line of sight/.test(l))).toBe(true);
    expect(s.log.some((l) => /shoots t/.test(l) || /shooting at/.test(l))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('ability audit: Lone Operative, Stealth, FNP, Fights First, Frenzon', () => {
  it('Lone Operative: untargetable by ranged attacks beyond 12", targetable within', () => {
    const gun = { name: 'Lascannon', type: 'ranged' as const, range: 48, attacks: '1', skill: 3, S: 12, AP: -3, D: 'D6', keywords: [] };
    const shooter = mkDs('shooter', { weapons: [gun] });
    const ctx: EngineContext = { datasheets: new Map([['shooter', shooter], [VINDICARE, datasheetsById.get(VINDICARE)!]]) };
    let s = matchState(flatLayout, 'Shooting');
    s = reduce(s, spawn('sh', 'shooter', 'player', 10, 10, 3), rng, ctx);
    s = reduce(s, { type: 'SpawnUnit', unitId: 'vin', owner: 'ai', datasheetId: VINDICARE, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: { x: 40, y: 10 } }, rng, ctx);

    expect(validShootingTargets(s.units[0]!, 'Lascannon', s, ctx).length).toBe(0);
    let out = reduce(s, { type: 'ShootUnit', attackerUnitId: 'sh', targetUnitId: 'vin' }, makeRNG(2), ctx);
    expect(out.log.some((l) => /Lone Operative/.test(l))).toBe(true);

    // Within 12" the assassin is fair game.
    s = { ...s, units: s.units.map((u) => (u.id === 'vin' ? { ...u, models: u.models.map((m) => ({ ...m, pos: { x: 18, y: 10 } })) } : u)) };
    expect(validShootingTargets(s.units[0]!, 'Lascannon', s, ctx).length).toBe(1);
  });

  it('Deadshot (Vindicare) ignores Lone Operative when shooting', () => {
    const ctx = realCtx;
    let s = matchState(flatLayout, 'Shooting');
    s = reduce(s, { type: 'SpawnUnit', unitId: 'vin', owner: 'player', datasheetId: VINDICARE, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: { x: 5, y: 10 } }, rng, ctx);
    s = reduce(s, { type: 'SpawnUnit', unitId: 'cal', owner: 'ai', datasheetId: CALLIDUS, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: { x: 40, y: 10 } }, rng, ctx);
    // 35" away: a Lone Operative, but the Vindicare's Deadshot ignores that with its 48" rifle.
    expect(validShootingTargets(s.units[0]!, 'Exitus rifle', s, ctx).map((u) => u.id)).toContain('cal');
  });

  it('innate Stealth and Feel No Pain bind from the ability list', () => {
    expect(innateEffectIds(datasheetsById.get(VINDICARE))).toContain('stealth');
    const bullgryn = [...datasheetsById.values()].find((d) => d.name === 'Bullgryn Squad')!;
    expect(innateEffectIds(bullgryn)).toContain('fnp_6');
  });

  it('Fights First: the Callidus fights in the first tier (the old id-based check never matched)', () => {
    const u: UnitInstance = {
      id: 'cal', owner: 'player', datasheetId: CALLIDUS, startingModels: 1, status: {},
      models: [{ id: 'cal:m0', unitId: 'cal', pos: { x: 0, y: 0 }, wounds: 4, alive: true }],
    };
    expect(hasFightsFirst(u, realCtx)).toBe(true);
  });

  it('Frenzon: the Eversor may shoot and charge in a turn it Advanced', () => {
    expect(canActAfterAdvance(datasheetsById.get(EVERSOR))).toEqual({ shoot: true, charge: true });
    let s = matchState(layout1 as unknown as Layout, 'Charge');
    s = reduce(s, { type: 'SpawnUnit', unitId: 'ev', owner: 'player', datasheetId: EVERSOR, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: { x: 10, y: 10 } }, rng, realCtx);
    s = reduce(s, { type: 'SpawnUnit', unitId: 'foe', owner: 'ai', datasheetId: BREACHERS, baseShape: { kind: 'circle', radius: 0.5 }, modelCount: 5, wounds: 1, anchor: { x: 16, y: 10 } }, rng, realCtx);
    s = { ...s, units: s.units.map((u) => (u.id === 'ev' ? { ...u, status: { advanced: true, moved: true } } : u)) };
    expect(eligibleToShoot(s.units[0]!, s, realCtx).eligible).toBe(true);
    expect(eligibleToCharge(s.units[0]!, s, realCtx).eligible).toBe(true);
    // A unit without the carve-out stays blocked.
    s = { ...s, units: s.units.map((u) => (u.id === 'foe' ? { ...u, owner: 'player' as const, status: { advanced: true } } : u)) };
    const breachers = s.units.find((u) => u.id === 'foe')!;
    expect(eligibleToCharge(breachers, s, realCtx).eligible).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6 · Scout moves', () => {
  it('the data carries Scouts distances (Eversor 9")', () => {
    expect(scoutDistance(datasheetsById.get(EVERSOR))).toBe(9);
  });

  it('a merged Leader without Scouts removes the unit Scout move', () => {
    const u: UnitInstance = {
      id: 'k', owner: 'player', datasheetId: EVERSOR, startingModels: 2, status: {},
      models: [{ id: 'k:m0', unitId: 'k', pos: { x: 0, y: 0 }, wounds: 1, alive: true }],
      attachedLeaders: [{ unitId: 'l', datasheetId: ROGUE_TRADER, modelCount: 1, wounds: 4 }],
    };
    expect(unitScoutDistance(u, realCtx)).toBeNull();
  });

  it('first-turn roll enters the scouts step; the move is budgeted, >9"-gated and flagged', () => {
    const pAnchor = zoneAnchor('player');
    const aAnchor = zoneAnchor('ai');
    let s = createInitialState(layout1 as unknown as Layout);
    s = reduce(s, { type: 'NewBattle' }, rng, realCtx);
    s = reduce(s, { type: 'SetAttacker', side: 'player' }, rng, realCtx);
    s = reduce(s, { type: 'DeployUnit', unitId: 'p:0', owner: 'player', datasheetId: EVERSOR, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: pAnchor, ability: 'standard' }, rng, realCtx);
    s = reduce(s, { type: 'DeployUnit', unitId: 'a:0', owner: 'ai', datasheetId: BREACHERS, baseShape: { kind: 'circle', radius: 0.5 }, modelCount: 5, wounds: 1, anchor: aAnchor, ability: 'standard' }, rng, realCtx);
    expect(s.units.length).toBe(2);
    s = reduce(s, { type: 'RollFirstTurn' }, rng, realCtx);
    expect(s.setup?.step).toBe('scouts');
    expect(pendingScoutUnits(s, realCtx).map((u) => u.id)).toEqual(['p:0']);
    expect(scoutTurn(s, realCtx)).toBeTruthy();

    s = reduce(s, { type: 'BeginMove', unitIds: ['p:0'], mode: 'scout' }, rng, realCtx);
    expect(s.units.find((u) => u.id === 'p:0')!.status.moveBudget).toBe(9);

    // The 9" budget clamps the nudge, the >9"-from-enemies rule gates the confirm.
    const towardMid = Math.sign(30 - pAnchor.x) || 1;
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['p:0'], delta: { x: towardMid * 30, y: 0 } }, rng, realCtx);
    const moved = s.units.find((u) => u.id === 'p:0')!.models[0]!.pos;
    expect(Math.abs(moved.x - pAnchor.x)).toBeLessThanOrEqual(9 + 1e-6);
    s = reduce(s, { type: 'EndMove', unitIds: ['p:0'] }, rng, realCtx);
    const u = s.units.find((x) => x.id === 'p:0')!;
    expect(u.status.scouted).toBe(true);
    expect(u.status.moved).toBeUndefined(); // a Scout move does NOT use up the Movement phase

    // All scouts resolved → battle may begin; round-1 statuses are clean.
    expect(pendingScoutUnits(s, realCtx).length).toBe(0);
    s = reduce(s, { type: 'BeginBattle' }, rng, realCtx);
    expect(s.stage).toBe('battle');
    expect(s.units.every((x) => Object.keys(x.status).length === 0)).toBe(true);
  });

  it('a Scout move may not end within 9" of the enemy', () => {
    const pAnchor = zoneAnchor('player');
    const towardMid = Math.sign(30 - pAnchor.x) || 1;
    let s = createInitialState(layout1 as unknown as Layout);
    s = reduce(s, { type: 'NewBattle' }, rng, realCtx);
    s = reduce(s, { type: 'SetAttacker', side: 'player' }, rng, realCtx);
    s = reduce(s, { type: 'DeployUnit', unitId: 'p:0', owner: 'player', datasheetId: EVERSOR, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: pAnchor, ability: 'standard' }, rng, realCtx);
    expect(s.units.length).toBe(1);
    // An enemy infiltrator 12" toward the middle.
    s = reduce(s, { type: 'SpawnUnit', unitId: 'foe', owner: 'ai', datasheetId: VINDICARE, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: { x: pAnchor.x + towardMid * 12, y: pAnchor.y } }, rng, realCtx);
    s = reduce(s, { type: 'RollFirstTurn' }, rng, realCtx);
    s = reduce(s, { type: 'BeginMove', unitIds: ['p:0'], mode: 'scout' }, rng, realCtx);
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['p:0'], delta: { x: towardMid * 8, y: 0 } }, rng, realCtx); // → ~4" gap
    s = reduce(s, { type: 'EndMove', unitIds: ['p:0'] }, rng, realCtx);
    const u = s.units.find((x) => x.id === 'p:0')!;
    expect(u.status.scouted).toBeUndefined();
    expect(u.status.moveMode).toBe('scout'); // still mid-activation, fix or cancel
    expect(s.log.some((l) => /more than 9"/.test(l))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('7 · pre-deployment Leader pairing + Warrant of Trade', () => {
  function setupWithRoles(): GameState {
    let s = createInitialState(layout1 as unknown as Layout);
    s = reduce(s, { type: 'NewBattle' }, rng, realCtx);
    s = reduce(s, { type: 'SetAttacker', side: 'ai' }, rng, realCtx); // player defends → deploys first
    return s;
  }

  it('Backroom Deals: declaring the Rogue Trader to lead Breachers grants the pair Infiltrators', () => {
    let s = setupWithRoles();
    s = reduce(s, { type: 'DeclareFormation', side: 'player', leaderKey: 'p:0', leaderDsId: ROGUE_TRADER, bodyguardKey: 'p:1', bodyguardDsId: BREACHERS }, rng, realCtx);
    expect(s.setup?.formations?.length).toBe(1);
    expect(s.setup?.formations?.[0]?.infiltrate).toBe(true);

    // The pair deploys midfield as Infiltrators: unit down, Leader staged via Reserves, merge
    // (bases never stack, so the Leader cannot be DROPPED onto the unit's anchor — the merge
    // re-seats its models into base-to-base coherency instead).
    const mid = { x: 30, y: 22 };
    s = reduce(s, { type: 'DeployUnit', unitId: 'p:1', owner: 'player', datasheetId: BREACHERS, baseShape: { kind: 'circle', radius: 0.5 }, modelCount: 10, wounds: 1, anchor: mid, ability: 'infiltrators' }, rng, realCtx);
    s = reduce(s, { type: 'PlaceInReserves', unitId: 'p:0', owner: 'player', datasheetId: ROGUE_TRADER, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 4, wounds: 4 }, rng, realCtx);
    s = reduce(s, { type: 'AttachLeader', leaderUnitId: 'p:0', bodyguardUnitId: 'p:1' }, rng, realCtx);
    const merged = s.units.find((u) => u.id === 'p:1')!;
    expect(merged.attachedLeaders?.length).toBe(1);
    expect(s.units.some((u) => u.id === 'p:0')).toBe(false); // merged away
    expect(s.log.filter((l) => /rejected/i.test(l))).toEqual([]);
  });

  it('formations validate: no double pairing, no pairing once deployed, canAttach enforced', () => {
    let s = setupWithRoles();
    s = reduce(s, { type: 'DeclareFormation', side: 'player', leaderKey: 'p:0', leaderDsId: ROGUE_TRADER, bodyguardKey: 'p:1', bodyguardDsId: BREACHERS }, rng, realCtx);
    // Same leader again → rejected.
    s = reduce(s, { type: 'DeclareFormation', side: 'player', leaderKey: 'p:0', leaderDsId: ROGUE_TRADER, bodyguardKey: 'p:2', bodyguardDsId: BREACHERS }, rng, realCtx);
    expect(s.setup?.formations?.length).toBe(1);
    // A non-character cannot lead.
    s = reduce(s, { type: 'DeclareFormation', side: 'player', leaderKey: 'p:3', leaderDsId: BREACHERS, bodyguardKey: 'p:4', bodyguardDsId: BREACHERS }, rng, realCtx);
    expect(s.setup?.formations?.length).toBe(1);
    // Clearing before deployment works.
    s = reduce(s, { type: 'ClearFormation', leaderKey: 'p:0' }, rng, realCtx);
    expect(s.setup?.formations?.length).toBe(0);
  });

  it('Warrant of Trade: D3 redeploys of IMPERIUM BATTLELINE units, others refused', () => {
    const pz = zoneAnchor('player');
    let s = setupWithRoles();
    // The Warrant is a deploy-step window — pass Declare Battle Formations first.
    s = reduce(s, { type: 'FinishFormations', side: 'player' }, rng, realCtx);
    s = reduce(s, { type: 'FinishFormations', side: 'ai' }, rng, realCtx);
    s = reduce(s, { type: 'DeployUnit', unitId: 'p:0', owner: 'player', datasheetId: ROGUE_TRADER, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 4, wounds: 4, anchor: { x: pz.x, y: pz.y }, ability: 'standard' }, rng, realCtx);
    s = reduce(s, { type: 'DeployUnit', unitId: 'p:1', owner: 'player', datasheetId: BREACHERS, baseShape: { kind: 'circle', radius: 0.5 }, modelCount: 10, wounds: 1, anchor: { x: pz.x, y: pz.y - 6 }, ability: 'standard' }, rng, realCtx);
    s = reduce(s, { type: 'DeployUnit', unitId: 'p:2', owner: 'player', datasheetId: VINDICARE, baseShape: { kind: 'circle', radius: 0.63 }, modelCount: 1, wounds: 4, anchor: { x: pz.x, y: pz.y + 6 }, ability: 'standard' }, rng, realCtx);
    expect(s.units.length).toBe(3);

    s = reduce(s, { type: 'UseWarrant', side: 'player' }, makeRNG(123), realCtx);
    const w = s.setup?.warrant?.player;
    expect(w).toBeTruthy();
    expect(w!.rolled).toBeGreaterThanOrEqual(1);
    expect(w!.rolled).toBeLessThanOrEqual(3);
    expect(w!.remaining).toBe(w!.rolled);

    // The Vindicare is not BATTLELINE — refused. The Breachers are — pulled back for redeploy.
    s = reduce(s, { type: 'WarrantRedeploy', unitId: 'p:2' }, rng, realCtx);
    expect(s.units.some((u) => u.id === 'p:2')).toBe(true);
    expect(s.log.some((l) => /not an IMPERIUM BATTLELINE/.test(l))).toBe(true);
    s = reduce(s, { type: 'WarrantRedeploy', unitId: 'p:1' }, rng, realCtx);
    expect(s.units.some((u) => u.id === 'p:1')).toBe(false); // back in the deploy queue
    expect(s.setup?.warrant?.player?.remaining).toBe(w!.rolled - 1);

    // Re-deploying the pulled unit works through the normal flow.
    s = reduce(s, { type: 'DeployUnit', unitId: 'p:1', owner: 'player', datasheetId: BREACHERS, baseShape: { kind: 'circle', radius: 0.5 }, modelCount: 10, wounds: 1, anchor: { x: pz.x, y: pz.y - 6 }, ability: 'standard' }, rng, realCtx);
    expect(s.units.some((u) => u.id === 'p:1')).toBe(true);

    // Declining zeroes the remaining count.
    s = reduce(s, { type: 'DeclineWarrant', side: 'player' }, rng, realCtx);
    expect(s.setup?.warrant?.player?.remaining).toBe(0);
    // A second UseWarrant is refused.
    s = reduce(s, { type: 'UseWarrant', side: 'player' }, rng, realCtx);
    expect(s.log.some((l) => /already used/.test(l))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('3/4 · AI unit roles + home-objective garrison', () => {
  it('classifies the named units the way they should be played', () => {
    expect(classifyDatasheet(datasheetsById.get(VINDICARE))).toBe('sniper');
    expect(classifyDatasheet(datasheetsById.get(EVERSOR))).toBe('assassin');
    expect(classifyDatasheet(datasheetsById.get(CALLIDUS))).toBe('assassin');
    expect(classifyDatasheet(datasheetsById.get(BREACHERS))).toBe('battleline');
    expect(classifyDatasheet(datasheetsById.get(BASILISK))).toBe('artillery');
    expect(classifyDatasheet(datasheetsById.get(LEMAN_RUSS))).toBe('gunline');
  });

  it('snipers deploy deep and keep their distance; assassins push up', () => {
    const sniper = rolePlan('sniper', 48);
    const assassin = rolePlan('assassin', 12);
    expect(sniper.wantDepth).toBeGreaterThan(assassin.wantDepth);
    expect(sniper.standoff).toBeGreaterThanOrEqual(24);
    expect(sniper.chargeWeight).toBe(0);
    expect(assassin.standoff).toBe(0);
    const vinPlan = unitRolePlan(
      { id: 'v', owner: 'ai', datasheetId: VINDICARE, startingModels: 1, status: {}, models: [] },
      realCtx,
    );
    expect(vinPlan.role).toBe('sniper');
    expect(vinPlan.standoff).toBeGreaterThanOrEqual(24);
  });

  it('the home garrison is a battleline unit, not the sniper', () => {
    const mk = (id: string, ds: string, x: number): UnitInstance => ({
      id, owner: 'ai', datasheetId: ds, startingModels: 5, status: {},
      models: [{ id: `${id}:m0`, unitId: id, pos: { x, y: 22 }, wounds: 1, alive: true }],
    });
    const units = [mk('vin', VINDICARE, 50), mk('br', BREACHERS, 52)];
    const home = { x: 50, y: 36 };
    expect(homeGarrisonId(units, home, realCtx, () => 100)).toBe('br');
  });

  it('homeObjective picks the marker nearest the side’s own zone', () => {
    const s = { ...createInitialState(layout1 as unknown as Layout) };
    const player = homeObjective(s, 'player');
    const ai = homeObjective(s, 'ai');
    expect(player).toBeTruthy();
    expect(ai).toBeTruthy();
    expect(player).not.toEqual(ai);
  });
});
