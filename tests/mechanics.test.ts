// Tests for the 2026-06-11 mechanics-review fixes:
//  • one Leader per unit + the Leader physically joins its Bodyguard on attach
//  • unit-level shooting (every model fires its weapons, sequential resolution, Pistol rule)
//  • Benefit of Cover corrected (see combat.test.ts for the effectiveSave cases)

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { checkCoherency } from '../src/core/coherency';
import { gapBetweenBases } from '../src/core/geometry';
import { planUnitShooting, type EngineContext } from '../src/core/engine';
import type { BaseShape, Datasheet, GameState, Layout, WeaponProfile } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: {
    player: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 44 }, { x: 0, y: 44 }],
    opponent: [{ x: 48, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 44 }, { x: 48, y: 44 }],
  },
};

const w = (name: string, over: Partial<WeaponProfile> = {}): WeaponProfile => ({
  name, type: 'ranged', range: 24, attacks: '1', skill: 4, S: 4, AP: 0, D: '1', keywords: [], ...over,
});

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [], baseShape: circle, keywords: ['Infantry'], abilityIds: [], ...over,
});

const ctx: EngineContext = {
  datasheets: new Map<string, Datasheet>([
    ['leader', ds('leader', { keywords: ['Infantry', 'Character'], canLead: ['squad'] })],
    ['squad', ds('squad', { canBeLedBy: ['leader'] })],
    ['trooper', ds('trooper')],
    ['shooters', ds('shooters', {
      weapons: [
        w('Boltgun', { attacks: '2' }),
        w('Plasma gun – standard'),
        w('Plasma gun – supercharge', { S: 8 }),
        w('Laspistol', { range: 12, keywords: ['Pistol'] }),
      ],
    })],
    ['pistoleers', ds('pistoleers', { weapons: [w('Laspistol', { range: 12, keywords: ['Pistol'] })] })],
  ]),
};

const rng = makeRNG(11);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);

const spawn = (unitId: string, owner: 'player' | 'ai', datasheetId: string, modelCount: number, anchor: { x: number; y: number }): Intent => ({
  type: 'SpawnUnit', unitId, owner, datasheetId, baseShape: circle, modelCount, wounds: 1, anchor,
});

describe('one Leader per unit', () => {
  const base = (): GameState => run(createInitialState(layout), [
    { type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' },
    { type: 'DeployUnit', unitId: 'bg', owner: 'player', datasheetId: 'squad', baseShape: circle, modelCount: 5, wounds: 1, anchor: { x: 4, y: 22 } },
    { type: 'DeployUnit', unitId: 'ldr1', owner: 'player', datasheetId: 'leader', baseShape: circle, modelCount: 1, wounds: 1, anchor: { x: 7, y: 22 } },
    { type: 'DeployUnit', unitId: 'ldr2', owner: 'player', datasheetId: 'leader', baseShape: circle, modelCount: 1, wounds: 1, anchor: { x: 9, y: 22 } },
  ]);

  it('rejects attaching a second Leader to the same unit', () => {
    let s = reduce(base(), { type: 'AttachLeader', leaderUnitId: 'ldr1', bodyguardUnitId: 'bg' }, rng, ctx);
    expect(s.units.find((u) => u.id === 'bg')!.attachedLeaders).toHaveLength(1);
    s = reduce(s, { type: 'AttachLeader', leaderUnitId: 'ldr2', bodyguardUnitId: 'bg' }, rng, ctx);
    expect(s.units.find((u) => u.id === 'bg')!.attachedLeaders).toHaveLength(1); // still one
    expect(s.units.find((u) => u.id === 'ldr2')).toBeDefined(); // second leader not absorbed
    expect(s.log.some((l) => /one Leader per unit/.test(l))).toBe(true);
  });
});

describe('Leader physically joins the Bodyguard on attach', () => {
  it('snaps the Leader model into coherency with the unit, without overlaps', () => {
    // Leader deployed FAR from the bodyguard (same zone, ~14" away).
    let s = run(createInitialState(layout), [
      { type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' },
      { type: 'DeployUnit', unitId: 'bg', owner: 'player', datasheetId: 'squad', baseShape: circle, modelCount: 5, wounds: 1, anchor: { x: 4, y: 22 } },
      { type: 'DeployUnit', unitId: 'ldr', owner: 'player', datasheetId: 'leader', baseShape: circle, modelCount: 1, wounds: 1, anchor: { x: 4, y: 8 } },
    ]);
    s = reduce(s, { type: 'AttachLeader', leaderUnitId: 'ldr', bodyguardUnitId: 'bg' }, rng, ctx);
    const bg = s.units.find((u) => u.id === 'bg')!;
    const leaderModel = bg.models.find((m) => m.datasheetId === 'leader')!;
    const rest = bg.models.filter((m) => m !== leaderModel);
    // Within 2" base-to-base of at least one bodyguard model (coherency range)…
    const minGap = Math.min(...rest.map((m) => gapBetweenBases(leaderModel.pos, circle, m.pos, circle)));
    expect(minGap).toBeLessThanOrEqual(2);
    // …without overlapping any model…
    expect(minGap).toBeGreaterThan(0);
    // …and the merged unit as a whole is coherent.
    expect(checkCoherency(bg.models.map((m) => m.pos), circle).inCoherency).toBe(true);
  });
});

describe('unit-level shooting (every model fires its weapons)', () => {
  const seed = (targetAt = { x: 20, y: 22 }): GameState =>
    run(createInitialState(layout), [
      spawn('att', 'player', 'shooters', 3, { x: 10, y: 22 }),
      spawn('tgt', 'ai', 'trooper', 5, targetAt),
    ]);

  it('fires each weapon sequentially, one plasma profile, holds the Pistols, marks hasShot', () => {
    const s = reduce(seed(), { type: 'ShootUnit', attackerUnitId: 'att', targetUnitId: 'tgt' }, rng, ctx);
    const fired = s.log.filter((l) => / shoots .* with /.test(l)); // per-weapon attack summaries
    expect(fired).toHaveLength(2); // Boltgun + ONE plasma profile (not both, not the pistol)
    expect(fired.some((l) => /Boltgun/.test(l))).toBe(true);
    expect(fired.some((l) => /Plasma gun – standard/.test(l))).toBe(true);
    expect(s.log.some((l) => /alternate profile not fired/.test(l))).toBe(true);
    expect(s.log.some((l) => /Pistols held/.test(l))).toBe(true);
    expect(s.units.find((u) => u.id === 'att')!.status.hasShot).toBe(true);
  });

  it('fires only Pistols while within Engagement Range', () => {
    const plan = planUnitShooting(seed({ x: 11.2, y: 22 }), seed({ x: 11.2, y: 22 }).units[0]!, ctx);
    // attacker block spans ~1" around x=10; target at 11.2 is within ER of the nearest model
    expect(plan.fire.every((f) => f.weapon.name === 'Laspistol')).toBe(true);
    expect(plan.fire.length).toBe(1);
  });

  it('a unit with only Pistols fires them when not engaged', () => {
    const s = run(createInitialState(layout), [
      spawn('att', 'player', 'pistoleers', 3, { x: 10, y: 22 }),
      spawn('tgt', 'ai', 'trooper', 5, { x: 18, y: 22 }),
    ]);
    const plan = planUnitShooting(s, s.units[0]!, ctx);
    expect(plan.fire).toHaveLength(1);
    expect(plan.fire[0]!.weapon.name).toBe('Laspistol');
  });

  it('rejects shooting an unengaged target while the shooter is engaged', () => {
    // Attacker engaged by one enemy, trying to pistol a DIFFERENT far-away unit.
    const s = run(createInitialState(layout), [
      spawn('att', 'player', 'shooters', 3, { x: 10, y: 22 }),
      spawn('near', 'ai', 'trooper', 2, { x: 11.2, y: 22 }),
      spawn('far', 'ai', 'trooper', 5, { x: 25, y: 22 }),
    ]);
    const r = reduce(s, { type: 'ShootUnit', attackerUnitId: 'att', targetUnitId: 'far' }, rng, ctx);
    expect(r.log.some((l) => /Shooting rejected: while within Engagement Range/.test(l))).toBe(true);
    expect(r.units.find((u) => u.id === 'att')!.status.hasShot).toBeUndefined();
  });
});
