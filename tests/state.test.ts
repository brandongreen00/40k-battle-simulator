import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, PARIAH_NEXUS_PHASES } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import type { BaseShape, Layout } from '../src/core/types';

const rng = makeRNG(1);
const layout: Layout = {
  id: 'test',
  boardWidth: 60,
  boardHeight: 44,
  deployment: 'Hammer and Anvil',
  terrain: [],
  objectives: [],
  deploymentZones: { player: [], opponent: [] },
};
const circle: BaseShape = { kind: 'circle', radius: 0.5 };

describe('createInitialState', () => {
  it('starts on round 1, Command phase, no units', () => {
    const s = createInitialState(layout);
    expect(s.round).toBe(1);
    expect(s.phase).toBe(PARIAH_NEXUS_PHASES[0]);
    expect(s.units).toHaveLength(0);
  });
});

describe('reduce: SpawnUnit', () => {
  it('adds a unit with the requested number of models', () => {
    const s = reduce(createInitialState(layout), {
      type: 'SpawnUnit',
      unitId: 'u1',
      owner: 'player',
      datasheetId: '000002612',
      baseShape: circle,
      modelCount: 10,
      wounds: 1,
      anchor: { x: 9, y: 22 },
    }, rng);
    expect(s.units).toHaveLength(1);
    expect(s.units[0]!.models).toHaveLength(10);
    expect(s.units[0]!.models.every((m) => m.alive && m.wounds === 1)).toBe(true);
  });

  it('keeps spawned models on the board', () => {
    const s = reduce(createInitialState(layout), {
      type: 'SpawnUnit',
      unitId: 'u1',
      owner: 'ai',
      datasheetId: 'x',
      baseShape: circle,
      modelCount: 5,
      wounds: 2,
      anchor: { x: 0, y: 0 }, // corner — grid would spill off-board without clamping
    }, rng);
    for (const m of s.units[0]!.models) {
      expect(m.pos.x).toBeGreaterThanOrEqual(0);
      expect(m.pos.y).toBeGreaterThanOrEqual(0);
      expect(m.pos.x).toBeLessThanOrEqual(60);
      expect(m.pos.y).toBeLessThanOrEqual(44);
    }
  });
});

describe('reduce: MoveModel / RemoveUnit / ClearUnits', () => {
  const spawned = reduce(createInitialState(layout), {
    type: 'SpawnUnit',
    unitId: 'u1',
    owner: 'player',
    datasheetId: 'x',
    baseShape: circle,
    modelCount: 2,
    wounds: 1,
    anchor: { x: 30, y: 22 },
  }, rng);

  it('moves a model and clamps to the board', () => {
    const id = spawned.units[0]!.models[0]!.id;
    const moved = reduce(spawned, { type: 'MoveModel', modelId: id, pos: { x: 999, y: -5 } }, rng);
    const m = moved.units[0]!.models.find((mm) => mm.id === id)!;
    expect(m.pos).toEqual({ x: 60, y: 0 });
  });

  it('does not mutate the previous state (immutability)', () => {
    const id = spawned.units[0]!.models[0]!.id;
    const before = spawned.units[0]!.models[0]!.pos;
    reduce(spawned, { type: 'MoveModel', modelId: id, pos: { x: 1, y: 1 } }, rng);
    expect(spawned.units[0]!.models[0]!.pos).toBe(before);
  });

  it('removes a unit and clears all', () => {
    expect(reduce(spawned, { type: 'RemoveUnit', unitId: 'u1' }, rng).units).toHaveLength(0);
    expect(reduce(spawned, { type: 'ClearUnits' }, rng).units).toHaveLength(0);
  });
});
