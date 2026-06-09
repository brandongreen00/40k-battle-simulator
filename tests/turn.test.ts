import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, PARIAH_NEXUS_PHASES } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import type { Layout } from '../src/core/types';

const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test',
  terrain: [], objectives: [], deploymentZones: { player: [], opponent: [] },
};
const rng = makeRNG(1);
const advance = (s: ReturnType<typeof createInitialState>, n: number) => {
  let st = s;
  for (let i = 0; i < n; i++) st = reduce(st, { type: 'AdvancePhase' }, rng);
  return st;
};

describe('turn/phase sequencer', () => {
  it('walks the five Pariah Nexus phases in order', () => {
    let s = createInitialState(layout);
    expect(s.phase).toBe('Command');
    s = reduce(s, { type: 'AdvancePhase' }, rng);
    expect(s.phase).toBe('Movement');
    s = advance(s, 3);
    expect(s.phase).toBe('Fight');
  });

  it('hands the turn to the second player after Fight, same round', () => {
    const s = advance(createInitialState(layout), PARIAH_NEXUS_PHASES.length); // through first turn
    expect(s.activePlayer).toBe('ai');
    expect(s.round).toBe(1);
    expect(s.phase).toBe('Command');
  });

  it('increments the round after both players have taken a turn', () => {
    const s = advance(createInitialState(layout), PARIAH_NEXUS_PHASES.length * 2);
    expect(s.round).toBe(2);
    expect(s.activePlayer).toBe('player');
  });

  it('ends the battle after round 5', () => {
    const s = advance(createInitialState(layout), PARIAH_NEXUS_PHASES.length * 10);
    expect(s.ended).toBe(true);
    expect(s.round).toBe(5);
    // Further advances are no-ops.
    expect(advance(s, 5).ended).toBe(true);
  });

  it('respects SetFirstPlayer', () => {
    let s = reduce(createInitialState(layout), { type: 'SetFirstPlayer', side: 'ai' }, rng);
    expect(s.activePlayer).toBe('ai');
    s = advance(s, PARIAH_NEXUS_PHASES.length);
    expect(s.activePlayer).toBe('player'); // ai went first, player second
  });

  it('clears the active side status flags at the start of its turn', () => {
    let s = createInitialState(layout);
    s = reduce(s, {
      type: 'SpawnUnit', unitId: 'u1', owner: 'ai', datasheetId: 'd', baseShape: { kind: 'circle', radius: 0.63 },
      modelCount: 1, wounds: 1, anchor: { x: 10, y: 10 },
    }, rng);
    s = reduce(s, { type: 'SetUnitStatus', unitId: 'u1', status: { hasShot: true } }, rng);
    expect(s.units[0]!.status.hasShot).toBe(true);
    s = advance(s, PARIAH_NEXUS_PHASES.length); // hand turn to ai -> resets ai units
    expect(s.units[0]!.status.hasShot).toBeUndefined();
  });
});
