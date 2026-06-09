import { describe, it, expect } from 'vitest';
import { reduce, createInitialState } from '../src/core/state';
import { unitWeapons } from '../src/core/engine';
import { makeRNG } from '../src/core/rng';
import type { BaseShape, Datasheet, GameState, Layout, ModelInstance, UnitInstance } from '../src/core/types';
import type { EngineContext } from '../src/core/engine';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = { id: 't', boardWidth: 60, boardHeight: 44, deployment: 'x', terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] } };

const ds = (id: string, over: Partial<Datasheet>): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [], baseShape: circle, keywords: ['Infantry'], abilityIds: [], ...over,
});

const ctx: EngineContext = {
  datasheets: new Map<string, Datasheet>([
    ['bg', ds('bg', { keywords: ['Infantry', 'Regiment'], weapons: [{ name: 'lasgun', type: 'ranged', range: 24, attacks: '1', skill: 4, S: 3, AP: 0, D: '1', keywords: [] }] })],
    ['cap', ds('cap', { keywords: ['Character', 'Infantry'], models: [{ name: 'cap', M: 6, T: 3, Sv: 2, W: 3, Ld: 8, OC: 1 }], canLead: ['bg'], weapons: [{ name: 'bolt pistol', type: 'ranged', range: 12, attacks: '1', skill: 2, S: 4, AP: 0, D: '1', keywords: [] }] })],
    ['foe', ds('foe', { weapons: [{ name: 'lasgun', type: 'ranged', range: 24, attacks: '1', skill: 4, S: 3, AP: 0, D: '1', keywords: [] }] })],
  ]),
};

// A merged unit: 3 bodyguard models + 1 Leader model (tagged with its own datasheet), plus an enemy.
function model(id: string, unitId: string, x: number, dsId?: string, wounds = 1): ModelInstance {
  return { id, unitId, pos: { x, y: 22 }, wounds, alive: true, ...(dsId ? { datasheetId: dsId } : {}) };
}
function mergedState(): GameState {
  const merged: UnitInstance = {
    id: 'u', owner: 'player', datasheetId: 'bg', startingModels: 4, status: {},
    models: [model('u:m0', 'u', 10), model('u:m1', 'u', 10.8), model('u:m2', 'u', 11.6), model('u:cap', 'u', 12.4, 'cap', 3)],
    attachedLeaders: [{ unitId: 'cap', datasheetId: 'cap', modelCount: 1, wounds: 3 }],
  };
  const foe: UnitInstance = { id: 'foe', owner: 'ai', datasheetId: 'foe', startingModels: 5, status: {}, models: Array.from({ length: 5 }, (_, i) => model(`foe:m${i}`, 'foe', 16 + i * 0.6)) };
  return { ...createInitialState(layout), phase: 'Shooting', units: [merged, foe] };
}

describe('merged Leader + Bodyguard unit', () => {
  it('can fire weapons from BOTH datasheets', () => {
    const names = unitWeapons(mergedState().units[0]!, ctx).map((w) => w.weapon.name);
    expect(names).toContain('lasgun'); // bodyguard
    expect(names).toContain('bolt pistol'); // leader
  });

  it('fires each weapon with only the models from that datasheet', () => {
    const rng = makeRNG(4);
    // Bodyguard weapon: 3 bodyguard models fire.
    const las = reduce(mergedState(), { type: 'Attack', attackerUnitId: 'u', targetUnitId: 'foe', weaponName: 'lasgun' }, rng, ctx);
    expect(las.log.some((l) => /3× lasgun/.test(l))).toBe(true);
    // Leader weapon: only the 1 leader model fires.
    const pistol = reduce(mergedState(), { type: 'Attack', attackerUnitId: 'u', targetUnitId: 'foe', weaponName: 'bolt pistol' }, rng, ctx);
    expect(pistol.log.some((l) => /1× bolt pistol/.test(l))).toBe(true);
  });
});
