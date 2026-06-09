import { describe, it, expect } from 'vitest';
import {
  AM_ORDERS, isOfficer, canReceiveOrders, hasActiveOrder,
  moveBonusFromOrders, ocBonusFromOrders, ldBonusFromOrders,
} from '../src/core/orders';
import { orderableUnits } from '../src/core/phases';
import { gatherAttackModifiers, type AttackContext } from '../src/core/effects';
import { resolveAttacks, type AttackProfile, type DefenderProfile, type CombatSituation } from '../src/core/combat';
import { parseKeywords } from '../src/core/keywords';
import { createInitialState, reduce } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import type { BaseShape, Datasheet, GameState, Layout, UnitInstance } from '../src/core/types';
import type { EngineContext } from '../src/core/engine';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const ranged = (kw: string[]): AttackContext => ({
  phase: 'shooting', weaponType: 'ranged', weaponKeywords: parseKeywords(kw),
  attackerKeywords: [], targetKeywords: [], gap: 6,
});

describe('AM Orders → effect modifiers', () => {
  it('First Rank Fire! adds +1 Attack only to Rapid Fire weapons', () => {
    const withRapid = gatherAttackModifiers(ranged(['Rapid Fire 1']), ['order:first_rank_fire'], []);
    expect(withRapid.extraAttacks).toBe(1);
    const noRapid = gatherAttackModifiers(ranged([]), ['order:first_rank_fire'], []);
    expect(noRapid.extraAttacks).toBe(0);
  });

  it('Take Cover! contributes +1 to the Save', () => {
    const mods = gatherAttackModifiers(ranged([]), [], ['order:take_cover']);
    expect(mods.saveBonus).toBe(1);
  });

  it('the combat pipeline honours extraAttacks', () => {
    const weapon: AttackProfile = { name: 'lasgun', attacks: '2', skill: 4, S: 3, AP: 0, D: '1', keywords: parseKeywords([]) };
    const defender: DefenderProfile = { T: 3, save: 5, keywords: [], models: [{ maxW: 1, wounds: 1 }] };
    const base: CombatSituation = { attackerCount: 3, targetModelCount: 1 };
    const rng = makeRNG(1);
    expect(resolveAttacks(weapon, defender, base, rng).attacks).toBe(6); // 2 × 3 models
    expect(resolveAttacks(weapon, defender, { ...base, extraAttacks: 1 }, makeRNG(1)).attacks).toBe(9); // (2+1) × 3
  });
});

describe('orders status helpers', () => {
  const withEffects = (effects: string[]): UnitInstance => ({
    id: 'u', owner: 'player', datasheetId: 'd', startingModels: 1,
    status: { activeEffects: effects }, models: [{ id: 'u:m0', unitId: 'u', pos: { x: 0, y: 0 }, wounds: 1, alive: true }],
  });

  it('detects active orders and their non-combat bonuses', () => {
    expect(hasActiveOrder(withEffects(['order:take_aim']))).toBe(true);
    expect(hasActiveOrder(withEffects(['reroll_hits_1']))).toBe(false);
    expect(moveBonusFromOrders(withEffects(['order:move_move_move']))).toBe(3);
    expect(ocBonusFromOrders(withEffects(['order:duty_and_honour']))).toBe(1);
    expect(ldBonusFromOrders(withEffects(['acquire_buff']))).toBe(1);
  });

  it('identifies Officers and order-eligible REGIMENT units', () => {
    const officer: Datasheet = { id: 'o', name: 'Officer', faction: 'AM', models: [], weapons: [], baseShape: circle, keywords: ['Character'], abilityIds: [] };
    expect(isOfficer(officer, ['Voice of Command'])).toBe(true);
    expect(isOfficer({ ...officer, keywords: ['Officer'] }, [])).toBe(true);
    expect(isOfficer(officer, [])).toBe(false);

    const regiment: Datasheet = { id: 'r', name: 'Squad', faction: 'AM', models: [], weapons: [], baseShape: circle, keywords: ['Regiment', 'Infantry'], abilityIds: [] };
    expect(canReceiveOrders(regiment, withEffects([]))).toBe(true);
    expect(canReceiveOrders(regiment, { ...withEffects([]), status: { battleShocked: true } })).toBe(false);
  });
});

describe('Voice of Command range (orderableUnits)', () => {
  const layout: Layout = { id: 't', boardWidth: 60, boardHeight: 44, deployment: 'x', terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] } };
  const ds = (id: string, kw: string[]): Datasheet => ({ id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }], weapons: [], baseShape: circle, keywords: kw, abilityIds: [] });
  const ctx: EngineContext = { datasheets: new Map([['off', ds('off', ['Character'])], ['reg', ds('reg', ['Regiment'])], ['other', ds('other', ['Infantry'])]]) };
  const u = (id: string, dsId: string, x: number): UnitInstance => ({ id, owner: 'player', datasheetId: dsId, startingModels: 1, status: {}, models: [{ id: `${id}:m`, unitId: id, pos: { x, y: 22 }, wounds: 1, alive: true }] });

  it('includes REGIMENT units within 6", excludes far / non-regiment', () => {
    const off = u('off', 'off', 10);
    const near = u('near', 'reg', 14); // ~3.5" gap
    const far = u('far', 'reg', 30); // way outside 6"
    const plain = u('plain', 'other', 13); // not a regiment
    const s: GameState = { ...createInitialState(layout), units: [off, near, far, plain] };
    const ids = orderableUnits(off, s, ctx).map((x) => x.id);
    expect(ids).toContain('near');
    expect(ids).not.toContain('far');
    expect(ids).not.toContain('plain');
  });
});

describe('Move! Move! Move! integration', () => {
  const layout: Layout = { id: 't', boardWidth: 60, boardHeight: 44, deployment: 'x', terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] } };
  const ctx: EngineContext = { datasheets: new Map([['d', { id: 'd', name: 'd', faction: 'AM', models: [{ name: 'd', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }], weapons: [], baseShape: circle, keywords: ['Regiment'], abilityIds: [] }]]) };

  it('adds +3" to the move budget while under the order', () => {
    const u: UnitInstance = { id: 'u', owner: 'player', datasheetId: 'd', startingModels: 1, status: { activeEffects: ['order:move_move_move'] }, models: [{ id: 'u:m', unitId: 'u', pos: { x: 10, y: 22 }, wounds: 1, alive: true }] };
    const s: GameState = { ...createInitialState(layout), units: [u] };
    const moved = reduce(s, { type: 'BeginMove', unitIds: ['u'], mode: 'normal' }, makeRNG(1), ctx);
    expect(moved.units[0]!.status.moveBudget).toBe(9); // M6 + 3
  });
});
