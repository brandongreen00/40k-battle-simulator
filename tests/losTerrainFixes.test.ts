// Owner-reported LoS/visibility/terrain fixes (2026-08-14):
//  1. Inquisitor Kroyle's Jindarii tox-cycler (app export uses a U+2011 non-breaking hyphen;
//     the Wahapedia datasheet uses ASCII) must appear in fire plans — Unicode-normalized
//     wargear matching.
//  2. explainNoReach names the actual blocking rule (Obscuring area / Solid dense feature /
//     Hidden / plain range) instead of a generic "out of range or not visible".
//  3. Per-weapon holds (save the One Shot Hunter-killer missile) + [ONE SHOT] enforcement.
//  4. Dense terrain movement (13.06): only Infantry/Beasts/Swarms move through dense (green)
//     features (FLY over); tanks/riders/monsters can neither cross nor end/set up on one.
import { describe, it, expect } from 'vitest';
import { makeRNG } from '../src/core/rng';
import { createInitialState, reduce } from '../src/core/state';
import {
  availableUnitWeapons, planUnitShooting, resolveUnitShooting, chargePathExists,
  type EngineContext,
} from '../src/core/engine';
import { normalizeItemName } from '../src/core/wargear';
import { explainNoReach, losBlockReason11 } from '../src/core/visibility';
import {
  baseOnDense, blockedByDense, clampDeltaAvoidingDense, denseMoveLegal, unitDenseViolation,
} from '../src/core/terrainmove';
import { checkUnitDeployment, deepStrikeArrivalLegal } from '../src/core/deployment';
import type { Datasheet, GameState, Layout, UnitInstance } from '../src/core/types';
import datasheetsJson from '../data/game/datasheets.json';
import inquisitors from '../data/rosters/inquisitors.json';

const circle = { kind: 'circle' as const, radius: 0.49 };

const gun = (name: string, range: number, keywords: string[] = []) => ({
  name, type: 'ranged' as const, range, attacks: '1', skill: 3, S: 5, AP: 0, D: '1', keywords,
});

const rifles: Datasheet = {
  id: 'inf', name: 'Rifles', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [gun('Boltgun', 24)], baseShape: circle, keywords: ['INFANTRY'], abilityIds: [],
};
const tank: Datasheet = {
  id: 'tank', name: 'Tank', faction: 'AM',
  models: [{ name: 'm', M: 12, T: 9, Sv: 3, W: 11, Ld: 7, OC: 3 }],
  weapons: [gun('Heavy bolter', 36), gun('Hunter-killer missile', 48, ['one shot'])],
  baseShape: circle, keywords: ['VEHICLE'], abilityIds: [],
};
const riders: Datasheet = {
  id: 'riders', name: 'Riders', faction: 'AM',
  models: [{ name: 'm', M: 12, T: 4, Sv: 4, W: 2, Ld: 7, OC: 2 }],
  weapons: [], baseShape: circle, keywords: ['MOUNTED'], abilityIds: [],
};
const flyer: Datasheet = {
  id: 'flyer', name: 'Flyer', faction: 'AM',
  models: [{ name: 'm', M: 20, T: 9, Sv: 3, W: 12, Ld: 7, OC: 0 }],
  weapons: [], baseShape: circle, keywords: ['VEHICLE', 'FLY'], abilityIds: [],
};
const ctx: EngineContext = {
  datasheets: new Map([[rifles.id, rifles], [tank.id, tank], [riders.id, riders], [flyer.id, flyer]]),
};

// A 60×44 11e-style layout: one obscuring area with a dense (green) feature inside it.
const layout11: Layout = {
  id: 't11', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  terrainAreas: [
    {
      id: 'ruin',
      polygon: [{ x: 18, y: 16 }, { x: 26, y: 16 }, { x: 26, y: 28 }, { x: 18, y: 28 }],
      features: [{ kind: 'dense', polygon: [{ x: 20, y: 20 }, { x: 24, y: 20 }, { x: 24, y: 24 }, { x: 20, y: 24 }] }],
    },
    {
      id: 'lightarea',
      polygon: [{ x: 40, y: 16 }, { x: 48, y: 16 }, { x: 48, y: 24 }, { x: 40, y: 24 }],
      features: [{ kind: 'light', polygon: [{ x: 42, y: 18 }, { x: 46, y: 18 }, { x: 46, y: 22 }, { x: 42, y: 22 }] }],
    },
  ],
  deploymentZones: { player: [], opponent: [] },
};

function unit(
  id: string, owner: 'player' | 'ai', dsId: string, positions: { x: number; y: number }[],
  extra: Partial<UnitInstance> = {},
): UnitInstance {
  return {
    id, owner, datasheetId: dsId, startingModels: positions.length, status: {},
    models: positions.map((pos, i) => ({ id: `${id}:m${i}`, unitId: id, pos, wounds: 2, alive: true })),
    ...extra,
  };
}

const matchState = (units: UnitInstance[], layout: Layout, phase = 'Shooting'): GameState => ({
  layout, units, stage: 'battle', mode: 'match', round: 2, turnCounter: 2,
  firstPlayer: 'player', activePlayer: 'player', phase,
  cp: { player: 3, ai: 3 }, score: { player: 0, ai: 0 }, ended: false, log: [],
});

// ── 1 · Kroyle's tox-cycler ───────────────────────────────────────────────────
describe('Unicode wargear names (Inquisitor Kroyle)', () => {
  it('normalizeItemName folds Unicode hyphens/quotes into ASCII', () => {
    expect(normalizeItemName('Jindarii tox‑cycler')).toBe('jindarii tox-cycler');
    expect(normalizeItemName('Garralisk’s claws and teeth')).toBe("garralisk's claws and teeth");
  });

  it("the real roster's tox-cycler (U+2011 export key) resolves to the datasheet weapon", () => {
    const sheets = new Map((datasheetsJson as unknown as Datasheet[]).map((d) => [d.id, d]));
    const realCtx: EngineContext = { datasheets: sheets };
    const entry = (inquisitors.units as unknown as { datasheetId: string; wargearCounts?: Record<string, number> }[])
      .find((u) => Object.keys(u.wargearCounts ?? {}).some((k) => k.toLowerCase().includes('tox')));
    expect(entry).toBeDefined();
    const kroyle = unit('kroyle', 'player', entry!.datasheetId, [{ x: 10, y: 10 }], {
      wargearCounts: entry!.wargearCounts,
    });
    const names = availableUnitWeapons(kroyle, realCtx).map((w) => w.weapon.name);
    expect(names).toContain('Jindarii tox-cycler');
    // And the fire plan fires it (the Stubcarbine is a Pistol, held while the tox-cycler fires).
    const plan = planUnitShooting(matchState([kroyle], layout11), kroyle, realCtx);
    expect(plan.fire.map((w) => w.weapon.name)).toContain('Jindarii tox-cycler');
  });
});

// ── 2 · explainNoReach names the blocking rule ───────────────────────────────
describe('explainNoReach', () => {
  it('names the Obscuring area when the sight line crosses an area neither unit is in', () => {
    const a = unit('a', 'player', 'inf', [{ x: 22, y: 10 }]);
    const t = unit('t', 'ai', 'inf', [{ x: 22, y: 34 }]); // beyond the area, in range (24")
    const s = matchState([a, t], layout11);
    const msg = explainNoReach(a, planUnitShooting(s, a, ctx), t, s, ctx);
    expect(msg).toMatch(/Obscuring/);
  });

  it('names the dense ruin when both units are inside the area with the feature between', () => {
    const a = unit('a', 'player', 'inf', [{ x: 22, y: 17.5 }]); // in the area, south of the feature
    const t = unit('t', 'ai', 'inf', [{ x: 22, y: 26.5 }]); // in the area, north of the feature
    const s = matchState([a, t], layout11);
    const msg = explainNoReach(a, planUnitShooting(s, a, ctx), t, s, ctx);
    expect(msg).toMatch(/dense ruin/);
  });

  it('reports plain range when the target is simply too far', () => {
    const a = unit('a', 'player', 'inf', [{ x: 2, y: 2 }]);
    const t = unit('t', 'ai', 'inf', [{ x: 50, y: 40 }]);
    const s = matchState([a, t], layout11);
    const msg = explainNoReach(a, planUnitShooting(s, a, ctx), t, s, ctx);
    expect(msg).toMatch(/Out of range/);
  });

  it('losBlockReason11 distinguishes the two block kinds', () => {
    expect(losBlockReason11({ x: 22, y: 10 }, { x: 22, y: 34 }, layout11)).toBe('obscuring_area');
    expect(losBlockReason11({ x: 22, y: 17.5 }, { x: 22, y: 26.5 }, layout11)).toBe('dense_feature');
    expect(losBlockReason11({ x: 5, y: 10 }, { x: 5, y: 34 }, layout11)).toBe(null);
  });
});

// ── 3 · Weapon holds + [ONE SHOT] ─────────────────────────────────────────────
describe('holdWeapons + One Shot', () => {
  const flat: Layout = {
    id: 'flat', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
    deploymentZones: { player: [], opponent: [] },
  };
  const hkKey = 'tank|Hunter-killer missile';

  it('a held weapon does not fire and is not spent', () => {
    const shooter = unit('s', 'player', 'tank', [{ x: 10, y: 10 }]);
    const target = unit('t', 'ai', 'inf', [{ x: 10, y: 20 }, { x: 11, y: 20 }, { x: 12, y: 20 }]);
    const s = matchState([shooter, target], flat);
    const out = resolveUnitShooting(
      s, { attackerUnitId: 's', targetUnitId: 't', holdWeapons: [hkKey] }, ctx, makeRNG(7),
    );
    expect(out.rejected).toBeUndefined();
    const after = out.state.units.find((u) => u.id === 's')!;
    expect(after.status.oneShotFired ?? []).not.toContain(hkKey);
    expect(out.state.log.join('\n')).toMatch(/Hunter-killer missile: held back/);
    // Still available for a later volley.
    const plan = planUnitShooting(out.state, { ...after, status: {} }, ctx);
    expect(plan.fire.map((w) => w.weapon.name)).toContain('Hunter-killer missile');
  });

  it('holding every weapon rejects the volley instead of wasting the activation', () => {
    const shooter = unit('s', 'player', 'tank', [{ x: 10, y: 10 }]);
    const target = unit('t', 'ai', 'inf', [{ x: 10, y: 20 }]);
    const s = matchState([shooter, target], flat);
    const out = resolveUnitShooting(
      s, { attackerUnitId: 's', targetUnitId: 't', holdWeapons: [hkKey, 'tank|Heavy bolter'] }, ctx, makeRNG(7),
    );
    expect(out.rejected).toMatch(/held back/);
    expect(out.state.units.find((u) => u.id === 's')!.status.hasShot).toBeUndefined();
  });

  it('a fired One Shot weapon is spent for the rest of the battle', () => {
    const shooter = unit('s', 'player', 'tank', [{ x: 10, y: 10 }]);
    const target = unit('t', 'ai', 'inf', [{ x: 10, y: 20 }, { x: 11, y: 20 }, { x: 12, y: 20 }]);
    const s = matchState([shooter, target], flat);
    const out = resolveUnitShooting(s, { attackerUnitId: 's', targetUnitId: 't' }, ctx, makeRNG(7));
    expect(out.rejected).toBeUndefined();
    const after = out.state.units.find((u) => u.id === 's')!;
    expect(after.status.oneShotFired).toContain(hkKey);
    // Next turn (hasShot reset), the plan drops the missile with a note.
    const nextTurn = { ...after, status: { oneShotFired: after.status.oneShotFired } };
    const plan = planUnitShooting({ ...out.state, units: [nextTurn, target] }, nextTurn, ctx);
    expect(plan.fire.map((w) => w.weapon.name)).not.toContain('Hunter-killer missile');
    expect(plan.notes.join('\n')).toMatch(/One Shot/);
  });

  it('oneShotFired survives the per-turn status reset', () => {
    const flatInit = createInitialState(flat);
    const rng = makeRNG(3);
    let s: GameState = {
      ...flatInit, mode: 'match', stage: 'battle', phase: 'Fight', activePlayer: 'ai', round: 1,
      units: [
        { ...unit('s', 'player', 'tank', [{ x: 10, y: 10 }]), status: { oneShotFired: [hkKey], hasShot: true } },
      ],
    };
    // Advance out of the AI's Fight phase → the player's turn begins and per-turn flags reset.
    s = reduce(s, { type: 'AdvancePhase' }, rng, ctx);
    const u = s.units.find((x) => x.id === 's')!;
    expect(u.status.hasShot).toBeUndefined();
    expect(u.status.oneShotFired).toContain(hkKey);
  });
});

// ── 4 · Dense terrain movement (13.06) ───────────────────────────────────────
describe('dense terrain movement', () => {
  it('classifies who is blocked: tanks/riders yes, infantry no, FLY over', () => {
    expect(blockedByDense(tank)).toBe(true);
    expect(blockedByDense(riders)).toBe(true);
    expect(blockedByDense(rifles)).toBe(false);
    expect(blockedByDense(flyer)).toBe(false);
  });

  it('denseMoveLegal: cannot end on or cross a dense feature; light/plain terrain is free', () => {
    const r = 0.49;
    // Ending on the feature.
    expect(denseMoveLegal({ x: 22, y: 17 }, { x: 22, y: 22 }, r, layout11)).toBe(false);
    // Crossing it.
    expect(denseMoveLegal({ x: 22, y: 17 }, { x: 22, y: 27 }, r, layout11)).toBe(false);
    // Around it (inside the grey area, which is free).
    expect(denseMoveLegal({ x: 19, y: 17 }, { x: 19, y: 27 }, r, layout11)).toBe(true);
    // Onto the LIGHT (yellow) feature and across the plain grey area: both legal.
    expect(denseMoveLegal({ x: 44, y: 12 }, { x: 44, y: 20 }, r, layout11)).toBe(true);
    // Grandfathered: a model already on the feature may move off it.
    expect(denseMoveLegal({ x: 22, y: 22 }, { x: 22, y: 17 }, r, layout11)).toBe(true);
    expect(baseOnDense({ x: 22, y: 22 }, r, layout11)).toBe(true);
    expect(baseOnDense({ x: 44, y: 20 }, r, layout11)).toBe(false);
  });

  it('EndMove refuses a rider volley across the ruin; going around confirms', () => {
    const rng = makeRNG(11);
    const u = unit('r', 'player', 'riders', [{ x: 22, y: 17 }]);
    let s = matchState([u], layout11, 'Movement');
    s = reduce(s, { type: 'BeginMove', unitIds: ['r'], mode: 'normal' }, rng, ctx);
    expect(s.units[0]!.status.moveMode).toBe('normal');
    // Straight through the green ruin → EndMove refuses, the activation stays open.
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['r'], delta: { x: 0, y: 10 } }, rng, ctx);
    s = reduce(s, { type: 'EndMove', unitIds: ['r'] }, rng, ctx);
    expect(s.log.join('\n')).toMatch(/dense terrain/);
    expect(s.units[0]!.status.moveMode).toBe('normal');
    // Back up and go around the west edge instead.
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['r'], delta: { x: 0, y: -10 } }, rng, ctx);
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['r'], delta: { x: -3.5, y: 0 } }, rng, ctx);
    s = reduce(s, { type: 'EndMove', unitIds: ['r'] }, rng, ctx);
    expect(s.units[0]!.status.moveMode).toBeUndefined();
    expect(s.units[0]!.status.moved).toBe(true);
  });

  it('infantry walk straight through the same ruin', () => {
    const rng = makeRNG(11);
    const u = unit('i', 'player', 'inf', [{ x: 22, y: 17 }]);
    let s = matchState([u], layout11, 'Movement');
    s = reduce(s, { type: 'BeginMove', unitIds: ['i'], mode: 'normal' }, rng, ctx);
    s = reduce(s, { type: 'NudgeUnit', unitIds: ['i'], delta: { x: 0, y: 6 } }, rng, ctx);
    s = reduce(s, { type: 'EndMove', unitIds: ['i'] }, rng, ctx);
    expect(s.units[0]!.status.moved).toBe(true);
  });

  it('clampDeltaAvoidingDense stops a tank at the feature edge', () => {
    const u = unit('t', 'player', 'tank', [{ x: 22, y: 17 }]);
    const clamped = clampDeltaAvoidingDense(u, { x: 0, y: 10 }, ctx, layout11);
    const endY = 17 + clamped.y;
    expect(endY).toBeLessThan(20); // feature starts at y=20 (minus the base radius shell)
    expect(clamped.y).toBeGreaterThan(0.5); // but it did move toward it
    expect(unitDenseViolation({ ...u, models: u.models.map((m) => ({ ...m, pos: { x: m.pos.x, y: m.pos.y + clamped.y } })) }, ctx, layout11)).toBe(null);
  });

  it('set-up legality: a tank cannot deploy or deep-strike onto the green feature', () => {
    const onFeature = [{ x: 22, y: 22 }];
    const denied = checkUnitDeployment(onFeature, circle, layout11, 'player', 'standard', [], [], true);
    expect(denied.legal).toBe(false);
    expect(denied.reason).toMatch(/dense/);
    // Infantry (not dense-blocked) may.
    expect(checkUnitDeployment(onFeature, circle, layout11, 'player', 'standard', [], [], false).legal).toBe(true);
    // Deep Strike arrival mirrors it.
    const ds = deepStrikeArrivalLegal(onFeature, circle, [], 2, [], { layout: layout11, denseBlocked: true });
    expect(ds.legal).toBe(false);
    expect(ds.reason).toMatch(/dense/);
    expect(deepStrikeArrivalLegal(onFeature, circle, [], 2, [], { layout: layout11, denseBlocked: false }).legal).toBe(true);
  });

  it('a rider charge with no path except through the ruin fails; infantry get through', () => {
    const charger = unit('r', 'player', 'riders', [{ x: 22, y: 17.5 }]);
    const victim = unit('v', 'ai', 'inf', [{ x: 22, y: 26.5 }]);
    const s = matchState([charger, victim], layout11, 'Charge');
    expect(chargePathExists(s, 'r', ['v'], ctx)).toBe(false);
    const walker = unit('w', 'player', 'inf', [{ x: 22, y: 17.5 }]);
    const s2 = matchState([walker, victim], layout11, 'Charge');
    expect(chargePathExists(s2, 'w', ['v'], ctx)).toBe(true);
  });

  it('full AI game (tank-heavy lists, 11e map): no rejects, no settled tank/rider on dense', async () => {
    const { runMatch } = await import('../src/core/ai/match');
    const { datasheetsById, deployAbilityForDatasheet, stratagems, layouts11 } = await import('../src/data/loaders');
    const { modelBaseShape } = await import('../src/core/collision');
    const { baseRadius } = await import('../src/core/geometry');
    const bane = (await import('../data/rosters/bane.json')).default;
    const spearhead = (await import('../data/rosters/prebuilt_armoured_spearhead.json')).default;
    const board = layouts11.find((l) => l.id === 'ec2026-take-and-hold_vs_purge-the-foe-a')!;
    const realCtx: EngineContext = { datasheets: datasheetsById };
    let denseSettles = 0;
    const result = runMatch(
      {
        layout: board,
        rosters: { player: bane, ai: spearhead } as never,
        profiles: { player: 'balanced', ai: 'balanced' },
        dispositions: { player: 'take_and_hold', ai: 'purge_the_foe' },
        seed: 9,
        observe: (s) => {
          // After EVERY intent: no dense-blocked unit may have a SETTLED model on a green ruin.
          for (const u of s.units) {
            if (u.inReserves || !blockedByDense(datasheetsById.get(u.datasheetId))) continue;
            for (const m of u.models) {
              if (!m.alive || m.moveStart) continue; // mid-activation positions may still be fixed
              if (baseOnDense(m.pos, baseRadius(modelBaseShape(u, m, realCtx)), s.layout)) denseSettles++;
            }
          }
        },
      },
      { ctx: realCtx, deployAbility: deployAbilityForDatasheet, stratagems },
    );
    expect(result.ended).toBe(true);
    expect(result.forcedAdvances).toBe(0);
    expect(result.rejectedLog).toEqual([]);
    expect(denseSettles).toBe(0);
  }, 180_000);
});
