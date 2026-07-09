// Regression tests for the 2026-06-10 review fixes:
//  - match-mode guards (Run Command, phase-gated attacks/charges, single move per turn, free drag)
//  - merged Leaders stay "placed" (no double-deploy) and keep their wargear counts
//  - per-model weapon counts drive attack volume (no more whole-unit volleys from one gun)
//  - casualties keep the survivors connected (coherency-aware allocation)
//  - "wholly within" deployment zones (with the board-edge exception)
//  - charge failures distinguish a short roll from a blocked path
import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../src/core/state';
import { resolveAttack, resolveCharge, availableUnitWeapons, type EngineContext } from '../src/core/engine';
import { checkUnitDeployment, isEntryPlaced } from '../src/core/deployment';
import { checkCoherency } from '../src/core/coherency';
import { makeRNG } from '../src/core/rng';
import { rollCharge } from '../src/core/movement';
import type { Datasheet, GameState, Layout } from '../src/core/types';

const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] },
};

const circle = { kind: 'circle' as const, radius: 0.49 };

const trooper: Datasheet = {
  id: 'troop', name: 'Troopers', faction: 'AoI',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [
    { name: 'Lasgun', type: 'ranged', range: 24, attacks: '1', skill: 4, S: 3, AP: 0, D: '1', keywords: [] },
    { name: 'Meltagun', type: 'ranged', range: 24, attacks: '1', skill: 4, S: 9, AP: -4, D: '1', keywords: [] },
    { name: 'Combi-gun – melta', type: 'ranged', range: 24, attacks: '1', skill: 4, S: 9, AP: -4, D: '1', keywords: [] },
    { name: 'Volley gun', type: 'ranged', range: 24, attacks: '6', skill: 2, S: 10, AP: -5, D: '1', keywords: [] },
    { name: 'Claws', type: 'melee', attacks: '2', skill: 4, S: 4, AP: 0, D: '1', keywords: [] },
  ],
  baseShape: circle, keywords: ['INFANTRY'], abilityIds: [],
};
const leaderDs: Datasheet = {
  id: 'cap', name: 'Captain', faction: 'AoI',
  models: [{ name: 'm', M: 6, T: 4, Sv: 3, W: 4, Ld: 6, OC: 1 }],
  weapons: [{ name: 'Power fist', type: 'melee', attacks: '3', skill: 3, S: 8, AP: -2, D: '2', keywords: [] }],
  baseShape: circle, keywords: ['INFANTRY', 'CHARACTER'], abilityIds: [], canLead: ['troop'],
};
const ctx: EngineContext = { datasheets: new Map([[trooper.id, trooper], [leaderDs.id, leaderDs]]) };
const rng = makeRNG(7);

function spawn(s: GameState, id: string, owner: 'player' | 'ai', x: number, y: number, n = 1, wargear?: Record<string, number>): GameState {
  return reduce(s, {
    type: 'SpawnUnit', unitId: id, owner, datasheetId: 'troop', baseShape: circle,
    modelCount: n, wounds: 1, anchor: { x, y }, ...(wargear ? { wargear } : {}),
  }, rng, ctx);
}
const asMatch = (s: GameState, phase = 'Command'): GameState => ({ ...s, mode: 'match', phase });

// ── match-mode guards ────────────────────────────────────────────────────────────
describe('match-mode guards', () => {
  it('Run Command is rejected outside the Command phase and when already run', () => {
    let s = asMatch(createInitialState(layout), 'Movement');
    s = reduce(s, { type: 'RunCommandPhase' }, makeRNG(1), ctx);
    expect(s.cp.player).toBe(0);
    expect(s.log.at(-1)).toMatch(/rejected: it is the Movement phase/);

    s = { ...s, phase: 'Command' };
    s = reduce(s, { type: 'RunCommandPhase' }, makeRNG(1), ctx);
    expect(s.cp.player).toBe(1);
    expect(s.commandRun).toBe(true);

    s = reduce(s, { type: 'RunCommandPhase' }, makeRNG(1), ctx);
    expect(s.cp.player).toBe(1); // no farming
    expect(s.log.at(-1)).toMatch(/already run this turn/);
  });

  it('commandRun resets when the turn passes', () => {
    let s = asMatch(createInitialState(layout), 'Command');
    s = reduce(s, { type: 'RunCommandPhase' }, makeRNG(1), ctx);
    for (let i = 0; i < 5; i++) s = reduce(s, { type: 'AdvancePhase' }, makeRNG(1), ctx); // -> ai turn
    expect(s.activePlayer).toBe('ai');
    expect(s.commandRun).toBe(false);
    s = reduce(s, { type: 'RunCommandPhase' }, makeRNG(1), ctx);
    expect(s.cp.ai).toBe(2); // 11e: both players gain 1 CP in EACH Command phase
  });

  it('the sandbox keeps the free Run Command (tests/dice-calculator behaviour)', () => {
    let s = { ...createInitialState(layout), phase: 'Movement' };
    s = reduce(s, { type: 'RunCommandPhase' }, makeRNG(1), ctx);
    expect(s.cp.player).toBe(1);
  });

  it('ranged attacks resolve only in the Shooting phase of a match (melee only in Fight)', () => {
    let s = spawn(spawn(createInitialState(layout), 'A', 'player', 10, 22, 5), 'B', 'ai', 20, 22, 5);
    const ranged = resolveAttack(asMatch(s, 'Command'), { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Lasgun' }, ctx, makeRNG(2));
    expect(ranged.rejected).toMatch(/only in the Shooting phase/);
    const ok = resolveAttack(asMatch(s, 'Shooting'), { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Lasgun' }, ctx, makeRNG(2));
    expect(ok.rejected).toBeUndefined();
    const melee = resolveAttack(asMatch(s, 'Shooting'), { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Claws' }, ctx, makeRNG(2));
    expect(melee.rejected).toMatch(/only in the Fight phase/);
    // sandbox: free in any phase (the dice calculator)
    const sandbox = resolveAttack({ ...s, phase: 'Command' }, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Lasgun' }, ctx, makeRNG(2));
    expect(sandbox.rejected).toBeUndefined();
  });

  it('charges resolve only in the Charge phase of a match', () => {
    let s = spawn(spawn(createInitialState(layout), 'A', 'player', 10, 22), 'B', 'ai', 15, 22);
    const out = resolveCharge(asMatch(s, 'Movement'), { chargerUnitId: 'A', targetUnitIds: ['B'] }, ctx, makeRNG(3));
    expect(out.success).toBe(false);
    expect(out.summary).toMatch(/only in the Charge phase/);
  });

  it('a unit cannot begin a second move in the same turn of a match', () => {
    let s = asMatch(spawn(createInitialState(layout), 'u', 'player', 10, 22, 3), 'Movement');
    s = reduce(s, { type: 'BeginMove', unitIds: ['u'], mode: 'normal' }, makeRNG(1), ctx);
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['u'], delta: { x: 3, y: 0 } }, makeRNG(1), ctx);
    s = reduce(s, { type: 'EndMove', unitIds: ['u'] }, makeRNG(1), ctx);
    expect(s.units[0]!.status.moved).toBe(true);
    s = reduce(s, { type: 'BeginMove', unitIds: ['u'], mode: 'normal' }, makeRNG(1), ctx);
    expect(s.units[0]!.status.moveMode).toBeUndefined(); // not re-activated
    expect(s.log.at(-1)).toMatch(/Already moved this turn: Troopers/);
  });

  it('models cannot be free-dragged outside a Movement activation in a match', () => {
    let s = asMatch(spawn(createInitialState(layout), 'u', 'player', 10, 22, 1), 'Shooting');
    const m = s.units[0]!.models[0]!;
    s = reduce(s, { type: 'MoveModel', modelId: m.id, pos: { x: 30, y: 30 } }, makeRNG(1), ctx);
    expect(s.units[0]!.models[0]!.pos).toEqual(m.pos); // unchanged
  });
});

// ── leader merge bookkeeping ─────────────────────────────────────────────────────
describe('merged leaders', () => {
  function merged(): GameState {
    let s = spawn(createInitialState(layout), 'body', 'player', 10, 22, 5);
    s = reduce(s, {
      type: 'SpawnUnit', unitId: 'lead', owner: 'player', datasheetId: 'cap', baseShape: circle,
      modelCount: 1, wounds: 4, anchor: { x: 10, y: 24 }, wargear: { 'Power fist': 1 },
    }, rng, ctx);
    return reduce(s, { type: 'AttachLeader', leaderUnitId: 'lead', bodyguardUnitId: 'body' }, rng, ctx);
  }

  it('a merged leader still counts as placed (no double-deploy)', () => {
    const s = merged();
    expect(s.units.find((u) => u.id === 'lead')).toBeUndefined(); // instance merged away
    expect(isEntryPlaced(s, 'lead')).toBe(true);
    expect(isEntryPlaced(s, 'body')).toBe(true);
    expect(isEntryPlaced(s, 'ghost')).toBe(false);
  });

  it('keeps the leader wargear counts through merge and restores them on detach', () => {
    const s = merged();
    const body = s.units.find((u) => u.id === 'body')!;
    expect(body.attachedLeaders?.[0]?.wargearCounts).toEqual({ 'Power fist': 1 });
    const split = reduce(s, { type: 'DetachLeader', leaderUnitId: 'lead' }, rng, ctx);
    expect(split.units.find((u) => u.id === 'lead')?.wargearCounts).toEqual({ 'Power fist': 1 });
  });
});

// ── per-model weapon counts ─────────────────────────────────────────────────────
describe('weapon carrier counts', () => {
  it('only the counted bearers fire (one meltagun is 1 attack, not 5)', () => {
    let s = spawn(createInitialState(layout), 'A', 'player', 10, 22, 5, { Meltagun: 1, Lasgun: 4 });
    s = spawn(s, 'B', 'ai', 20, 22, 5);
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Meltagun' }, ctx, makeRNG(5));
    expect(out.rejected).toBeUndefined();
    expect(out.state.log.join('\n')).toMatch(/1× Meltagun/);
    const las = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Lasgun' }, ctx, makeRNG(5));
    expect(las.state.log.join('\n')).toMatch(/4× Lasgun/);
  });

  it('weapons nobody carries are rejected and filtered from the offered list', () => {
    let s = spawn(createInitialState(layout), 'A', 'player', 10, 22, 5, { Lasgun: 5 });
    s = spawn(s, 'B', 'ai', 20, 22, 5);
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Volley gun' }, ctx, makeRNG(5));
    expect(out.rejected).toMatch(/no models in the unit carry/);
    const offered = availableUnitWeapons(s.units[0]!, ctx).map((w) => w.weapon.name);
    expect(offered).toContain('Lasgun');
    expect(offered).not.toContain('Volley gun');
  });

  it('multi-profile weapon names match their base item count', () => {
    let s = spawn(createInitialState(layout), 'A', 'player', 10, 22, 5, { 'Combi-gun': 1 });
    s = spawn(s, 'B', 'ai', 20, 22, 5);
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Combi-gun – melta' }, ctx, makeRNG(5));
    expect(out.rejected).toBeUndefined();
    expect(out.state.log.join('\n')).toMatch(/1× Combi-gun – melta/);
  });

  it('units without loadout data keep the old behaviour (every model fires)', () => {
    let s = spawn(createInitialState(layout), 'A', 'player', 10, 22, 5);
    s = spawn(s, 'B', 'ai', 20, 22, 5);
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Lasgun' }, ctx, makeRNG(5));
    expect(out.state.log.join('\n')).toMatch(/5× Lasgun/);
  });
});

// ── casualty allocation keeps survivors coherent ─────────────────────────────────
describe('casualty allocation', () => {
  it('survivors of a volley remain a single connected group', () => {
    let s = spawn(createInitialState(layout), 'B', 'ai', 20, 22, 10); // block formation
    s = spawn(s, 'A', 'player', 10, 22, 1); // one shooter -> ~4-5 of 6 attacks kill
    const out = resolveAttack(s, { attackerUnitId: 'A', targetUnitId: 'B', weaponName: 'Volley gun' }, ctx, makeRNG(11));
    const target = out.state.units.find((u) => u.id === 'B')!;
    const survivors = target.models.filter((m) => m.alive);
    expect(survivors.length).toBeLessThan(10); // the volley killed someone
    expect(survivors.length).toBeGreaterThan(0);
    expect(checkCoherency(survivors.map((m) => m.pos), circle).connected).toBe(true);
  });
});

// ── wholly-within deployment ─────────────────────────────────────────────────────
describe('wholly-within deployment zones', () => {
  const zoned: Layout = {
    ...layout,
    deploymentZones: { player: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }], opponent: [] },
  };
  const shape = { kind: 'circle' as const, radius: 0.63 }; // 32mm

  it('a base overhanging an interior zone edge is illegal', () => {
    const r = checkUnitDeployment([{ x: 19.8, y: 10 }], shape, zoned, 'player', 'standard');
    expect(r.legal).toBe(false);
    expect(r.reason).toMatch(/wholly within/);
  });
  it('a base inside with clearance is legal', () => {
    expect(checkUnitDeployment([{ x: 18, y: 10 }], shape, zoned, 'player', 'standard').legal).toBe(true);
  });
  it('touching the battlefield edge is allowed (the zone edge on the board perimeter)', () => {
    expect(checkUnitDeployment([{ x: 0.3, y: 10 }], shape, zoned, 'player', 'standard').legal).toBe(true);
  });
});

// ── charge failure reasons ───────────────────────────────────────────────────────
describe('charge failure reasons', () => {
  it('a short roll reports the needed distance', () => {
    let s = spawn(createInitialState(layout), 'A', 'player', 10, 10);
    s = spawn(s, 'B', 'ai', 10, 21.5); // ~10.5" gap, needs ~9.5"
    // find a seed whose 2D6 is too short, then assert the message matches that situation
    let seed = 1;
    while (rollCharge(makeRNG(seed)).distance >= 9) seed++;
    const out = resolveCharge(s, { chargerUnitId: 'A', targetUnitIds: ['B'] }, ctx, makeRNG(seed));
    expect(out.success).toBe(false);
    expect(out.summary).toMatch(/needed .*", rolled/);
  });

  it('a blocked approach reports "no clear path" instead', () => {
    let s = spawn(createInitialState(layout), 'A', 'player', 20, 22);
    s = spawn(s, 'B', 'ai', 24, 22); // ~3" gap — any roll reaches
    // ring of non-target enemies hugging the target so every ER position clips one
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * 2 * Math.PI;
      s = spawn(s, `nt${i}`, 'ai', 24 + 1.6 * Math.cos(ang), 22 + 1.6 * Math.sin(ang));
    }
    const out = resolveCharge(s, { chargerUnitId: 'A', targetUnitIds: ['B'] }, ctx, makeRNG(4));
    expect(out.success).toBe(false);
    expect(out.summary).toMatch(/no clear path/);
  });

  it('the fan-out search finds a path around a single screening unit', () => {
    let s = spawn(createInitialState(layout), 'A', 'player', 20, 22);
    s = spawn(s, 'B', 'ai', 26, 22); // ~5" gap
    s = spawn(s, 'screen', 'ai', 23, 22); // directly on the straight line
    // pick a seed with a big enough roll to go around
    let seed = 1;
    while (rollCharge(makeRNG(seed)).distance < 8) seed++;
    const out = resolveCharge(s, { chargerUnitId: 'A', targetUnitIds: ['B'] }, ctx, makeRNG(seed));
    expect(out.success).toBe(true);
  });
});
