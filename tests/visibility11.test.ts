// 11e terrain & visibility (Obscuring / Solid / Hidden / Benefit of Cover) and the
// allocation-group save system.
import { describe, it, expect } from 'vitest';
import type { EngineContext } from '../src/core/engine';
import { makeRNG } from '../src/core/rng';
import { losBlocked11, isHidden, unitHasCover11 } from '../src/core/visibility';
import { resolveAttacks, type AttackProfile, type DefenderProfile } from '../src/core/combat';
import { parseKeywords } from '../src/core/keywords';
import type { Datasheet, GameState, Layout, UnitInstance } from '../src/core/types';

const circle = { kind: 'circle' as const, radius: 0.49 };
const infantry: Datasheet = {
  id: 'inf', name: 'Infantry', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [], baseShape: circle, keywords: ['INFANTRY'], abilityIds: [],
};
const tank: Datasheet = {
  id: 'tank', name: 'Tank', faction: 'AM',
  models: [{ name: 'm', M: 10, T: 11, Sv: 2, W: 14, Ld: 7, OC: 3 }],
  weapons: [], baseShape: circle, keywords: ['VEHICLE'], abilityIds: [],
};
const ctx: EngineContext = { datasheets: new Map([[infantry.id, infantry], [tank.id, tank]]) };

const layout: Layout = {
  id: 'v11', boardWidth: 44, boardHeight: 60, deployment: 'test', terrain: [],
  objectives: [],
  terrainAreas: [
    // A dense-featured area mid-board.
    {
      id: 'ruin',
      polygon: [{ x: 18, y: 26 }, { x: 26, y: 26 }, { x: 26, y: 34 }, { x: 18, y: 34 }],
      features: [{ kind: 'dense', polygon: [{ x: 20, y: 28 }, { x: 24, y: 28 }, { x: 24, y: 32 }, { x: 20, y: 32 }] }],
    },
  ],
  deploymentZones: { player: [], opponent: [] },
};

function unit(id: string, owner: 'player' | 'ai', dsId: string, x: number, y: number, opts: Partial<UnitInstance['status']> = {}): UnitInstance {
  return {
    id, owner, datasheetId: dsId, startingModels: 1, status: { ...opts },
    models: [{ id: `${id}:m0`, unitId: id, pos: { x, y }, wounds: 1, alive: true }],
  };
}

const state = (units: UnitInstance[], turnCounter = 4): GameState => ({
  layout, units, stage: 'battle', mode: 'match', round: 2, turnCounter,
  firstPlayer: 'player', activePlayer: 'player', phase: 'Shooting',
  cp: { player: 0, ai: 0 }, score: { player: 0, ai: 0 }, ended: false, log: [],
});

describe('11e visibility', () => {
  it('Obscuring: sight through the area is blocked; into/out of it is not', () => {
    // Across the area (both outside).
    expect(losBlocked11({ x: 22, y: 10 }, { x: 22, y: 50 }, layout)).toBe(true);
    // Into the area's edge zone (target inside, clear of the dense feature footprint).
    expect(losBlocked11({ x: 22, y: 10 }, { x: 22, y: 27 }, layout)).toBe(false);
    // Clear of the area entirely.
    expect(losBlocked11({ x: 5, y: 10 }, { x: 5, y: 50 }, layout)).toBe(false);
  });

  it('Solid: the dense feature blocks sight within the area too', () => {
    // Both endpoints inside the area, feature between them.
    expect(losBlocked11({ x: 22, y: 26.5 }, { x: 22, y: 33.5 }, layout)).toBe(true);
    // Around the feature inside the area.
    expect(losBlocked11({ x: 19, y: 27 }, { x: 19, y: 33 }, layout)).toBe(false);
  });

  it('Hidden: infantry in a dense area that has not shot recently is invisible beyond 15\"', () => {
    const lurker = unit('l', 'ai', 'inf', 19, 27); // inside the area, not in the feature
    const s = state([lurker]);
    expect(isHidden(lurker, s, ctx)).toBe(true);
    // Shooting recently breaks Hidden (this turn or the previous one).
    const shot = { ...lurker, status: { lastShotOnTurn: 3 } };
    expect(isHidden(shot, state([shot], 4), ctx)).toBe(false);
    expect(isHidden(shot, state([shot], 6), ctx)).toBe(true); // two turns later it hides again
    // Vehicles never hide.
    const t = unit('t', 'ai', 'tank', 19, 27);
    expect(isHidden(t, state([t]), ctx)).toBe(false);
  });

  it('Benefit of Cover: infantry within a terrain area (open-field infantry gets none)', () => {
    const inArea = unit('c', 'ai', 'inf', 19, 27);
    const open = unit('o', 'ai', 'inf', 5, 50);
    const s = state([inArea, open]);
    expect(unitHasCover11([{ x: 22, y: 5 }], inArea, s, ctx)).toBe(true);
    expect(unitHasCover11([{ x: 5, y: 5 }], open, s, ctx)).toBe(false);
  });
});

describe('11e combat: cover worsens BS; allocation groups', () => {
  const bolter: AttackProfile = {
    name: 'boltgun', attacks: '1', skill: 4, S: 4, AP: 0, D: '1', keywords: parseKeywords([]),
  };

  it('cover turns a 4+ shooter into a 5+ (hit-rate drop, not a save change)', () => {
    const defender: DefenderProfile = {
      T: 4, save: 7, keywords: [], models: Array.from({ length: 200 }, () => ({ maxW: 1, wounds: 1 })),
    };
    const n = 3000;
    const noCover = resolveAttacks({ ...bolter, attacks: String(n) }, defender, { attackerCount: 1 }, makeRNG(1));
    const withCover = resolveAttacks({ ...bolter, attacks: String(n) }, defender, { attackerCount: 1, cover: true }, makeRNG(1));
    expect(noCover.hits / n).toBeGreaterThan(0.46);
    expect(noCover.hits / n).toBeLessThan(0.54);
    expect(withCover.hits / n).toBeGreaterThan(0.29);
    expect(withCover.hits / n).toBeLessThan(0.38);
  });

  it('CHARACTER allocation groups are damaged last; [PRECISION] promotes them', () => {
    const mkDefender = (): DefenderProfile => ({
      T: 4, save: 7, keywords: [],
      models: [
        { maxW: 1, wounds: 1 },
        { maxW: 1, wounds: 1 },
        { maxW: 3, wounds: 3, character: true },
      ],
    });
    // A hail of auto-hitting, auto-wounding attacks with no save: bodyguards die first.
    const flamer: AttackProfile = { name: 'flamer', attacks: '4', skill: 4, S: 8, AP: 0, D: '1', keywords: parseKeywords(['Torrent']) };
    const r = resolveAttacks(flamer, mkDefender(), { attackerCount: 1 }, makeRNG(2));
    const character = r.defenderModels[2]!;
    const bodyguards = [r.defenderModels[0]!, r.defenderModels[1]!];
    if (r.failedSaves >= 2) {
      expect(bodyguards.every((m) => m.wounds === 0)).toBe(true);
    }
    if (r.failedSaves <= 2) {
      expect(character.wounds).toBe(3); // untouched until the bodyguard groups are gone
    }

    // With [PRECISION], the character's group is promoted to current.
    const sniper: AttackProfile = { name: 'rifle', attacks: '2', skill: 2, S: 8, AP: -4, D: '1', keywords: parseKeywords(['Precision', 'Torrent']) };
    const p = resolveAttacks(sniper, mkDefender(), { attackerCount: 1, precisionActive: true }, makeRNG(3));
    if (p.failedSaves > 0) {
      expect(p.defenderModels[2]!.wounds).toBeLessThan(3);
      expect(p.defenderModels[0]!.wounds).toBe(1);
    }
  });
});
