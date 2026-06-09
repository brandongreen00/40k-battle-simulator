import { describe, it, expect } from 'vitest';
import {
  eligibleToShoot, eligibleToCharge, eligibleToFight, validShootingTargets,
  chargeTargets, fightActivationOrder, hasFightsFirst, inEngagementRange,
} from '../src/core/phases';
import type { BaseShape, Datasheet, GameState, Layout, UnitInstance } from '../src/core/types';
import { createInitialState, reduce } from '../src/core/state';
import { closestGap, type EngineContext } from '../src/core/engine';
import { makeRNG } from '../src/core/rng';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: { player: [], opponent: [] },
};

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [{ name: 'lasgun', type: 'ranged', range: 24, attacks: '1', skill: 4, S: 3, AP: 0, D: '1', keywords: [] }],
  baseShape: circle, keywords: ['Infantry'], abilityIds: [], ...over,
});

const ctx: EngineContext = {
  datasheets: new Map<string, Datasheet>([
    ['gun', ds('gun')],
    ['melee', ds('melee', { weapons: [{ name: 'sword', type: 'melee', attacks: '3', skill: 3, S: 4, AP: -1, D: '1', keywords: [] }] })],
    ['tank', ds('tank', { keywords: ['Vehicle'] })],
  ]),
};

function unit(id: string, owner: 'player' | 'ai', dsId: string, x: number, y: number, n = 1): UnitInstance {
  return {
    id, owner, datasheetId: dsId, startingModels: n, status: {},
    models: Array.from({ length: n }, (_, i) => ({ id: `${id}:m${i}`, unitId: id, pos: { x: x + i, y }, wounds: 1, alive: true })),
  };
}

const withUnits = (units: UnitInstance[]): GameState => ({ ...createInitialState(layout), units, phase: 'Shooting' });

describe('shooting eligibility', () => {
  it('an idle unit with a target in range and LoS is eligible and can target it', () => {
    const s = withUnits([unit('a', 'player', 'gun', 10, 22), unit('b', 'ai', 'gun', 20, 22)]);
    expect(eligibleToShoot(s.units[0]!, s, ctx).eligible).toBe(true);
    expect(validShootingTargets(s.units[0]!, 'lasgun', s, ctx).map((u) => u.id)).toEqual(['b']);
  });

  it('a unit that Advanced (no Assault weapons) is ineligible', () => {
    const s = withUnits([unit('a', 'player', 'gun', 10, 22), unit('b', 'ai', 'gun', 20, 22)]);
    s.units[0]!.status.advanced = true;
    expect(eligibleToShoot(s.units[0]!, s, ctx).eligible).toBe(false);
  });

  it('a unit within Engagement Range cannot shoot, unless it is a Vehicle', () => {
    const s = withUnits([unit('a', 'player', 'gun', 10, 22), unit('b', 'ai', 'gun', 10.5, 22)]);
    expect(inEngagementRange(s.units[0]!, s.units[1]!, ctx)).toBe(true);
    expect(eligibleToShoot(s.units[0]!, s, ctx).eligible).toBe(false);

    const sv = withUnits([unit('a', 'player', 'tank', 10, 22), unit('b', 'ai', 'gun', 10.5, 22)]);
    expect(eligibleToShoot(sv.units[0]!, sv, ctx).eligible).toBe(true); // Big Guns Never Tire
  });

  it('a weapon out of range yields no valid targets', () => {
    const s = withUnits([unit('a', 'player', 'gun', 0, 22), unit('b', 'ai', 'gun', 50, 22)]); // 50" apart > 24"
    expect(validShootingTargets(s.units[0]!, 'lasgun', s, ctx)).toHaveLength(0);
  });
});

describe('charge eligibility', () => {
  it('is eligible with an enemy within 12" and ineligible after Falling Back', () => {
    const s = withUnits([unit('a', 'player', 'melee', 10, 22), unit('b', 'ai', 'gun', 18, 22)]);
    expect(eligibleToCharge(s.units[0]!, s, ctx).eligible).toBe(true);
    expect(chargeTargets(s.units[0]!, s, ctx).map((u) => u.id)).toEqual(['b']);
    s.units[0]!.status.fellBack = true;
    expect(eligibleToCharge(s.units[0]!, s, ctx).eligible).toBe(false);
  });

  it('is ineligible when already within Engagement Range', () => {
    const s = withUnits([unit('a', 'player', 'melee', 10, 22), unit('b', 'ai', 'gun', 10.5, 22)]);
    expect(eligibleToCharge(s.units[0]!, s, ctx).eligible).toBe(false);
  });
});

describe('fight phase', () => {
  it('only units in engagement range fight, charged units have Fights First', () => {
    const s = withUnits([unit('a', 'player', 'melee', 10, 22), unit('b', 'ai', 'gun', 10.5, 22)]);
    expect(eligibleToFight(s.units[0]!, s, ctx).eligible).toBe(true);
    s.units[0]!.status.charged = true;
    expect(hasFightsFirst(s.units[0]!, ctx)).toBe(true);
  });

  it('fight order puts Fights-First units before the rest', () => {
    // player 'a' charged (FF); ai 'b' and player 'c' are in melee but not FF.
    const a = unit('a', 'player', 'melee', 10, 22); a.status.charged = true;
    const b = unit('b', 'ai', 'melee', 10.5, 22);
    const c = unit('c', 'player', 'melee', 11, 22);
    const s = withUnits([a, b, c]);
    const order = fightActivationOrder(s, ctx).map((u) => u.id);
    expect(order[0]).toBe('a'); // Fights First first
    expect(order).toContain('b');
    expect(order).toContain('c');
  });

  it('a successful charge moves the charger into Engagement Range', () => {
    // centres 4" apart, 0.5" radii -> 3" gap. 2D6 (>=2) always clears it, so the charge succeeds.
    const s = withUnits([unit('a', 'player', 'melee', 10, 22), unit('b', 'ai', 'gun', 14, 22)]);
    expect(closestGap(s.units[0]!, circle, s.units[1]!, circle)).toBeCloseTo(3, 1);
    const after = reduce(s, { type: 'Charge', chargerUnitId: 'a', targetUnitId: 'b' }, makeRNG(3), ctx);
    const charger = after.units.find((u) => u.id === 'a')!;
    expect(charger.status.charged).toBe(true);
    expect(closestGap(charger, circle, after.units.find((u) => u.id === 'b')!, circle)).toBeLessThanOrEqual(1);
  });
});
