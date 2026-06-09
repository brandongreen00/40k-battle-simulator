import { describe, it, expect } from 'vitest';
import { controlOfObjective, scorePrimary, type OcModel } from '../src/core/objectives';

const marker = { x: 30, y: 22 };
const R = 0.7875; // 40mm marker radius
const ctrl = 3;

function m(x: number, y: number, owner: 'player' | 'ai', oc = 1): OcModel {
  return { pos: { x, y }, oc, radius: 0.63, owner };
}

describe('controlOfObjective', () => {
  it('the side with more OC in range controls it', () => {
    const c = controlOfObjective(marker, R, ctrl, [m(30, 22, 'player', 2), m(31, 22, 'ai', 1)]);
    expect(c.player).toBe(2);
    expect(c.ai).toBe(1);
    expect(c.controller).toBe('player');
  });
  it('models out of range do not count', () => {
    const c = controlOfObjective(marker, R, ctrl, [m(30, 22, 'player', 1), m(50, 22, 'ai', 5)]);
    expect(c.ai).toBe(0);
    expect(c.controller).toBe('player');
  });
  it('equal OC is contested (no controller)', () => {
    const c = controlOfObjective(marker, R, ctrl, [m(30, 22, 'player', 1), m(31, 22, 'ai', 1)]);
    expect(c.controller).toBeNull();
  });
});

describe('scorePrimary', () => {
  it('5 VP per objective, capped at 15/turn', () => {
    expect(scorePrimary(2, 0)).toBe(10);
    expect(scorePrimary(4, 0)).toBe(15); // per-turn cap
  });
  it('respects the 50 VP overall cap', () => {
    expect(scorePrimary(3, 48)).toBe(2);
    expect(scorePrimary(3, 50)).toBe(0);
  });
});
