import { describe, it, expect } from 'vitest';
import { parseDice, maxValue, isVariable, roll } from '../src/core/dice';
import { makeRNG } from '../src/core/rng';

describe('parseDice', () => {
  it('parses flat constants', () => {
    expect(parseDice('1')).toMatchObject({ count: 0, flat: 1 });
    expect(parseDice('20')).toMatchObject({ count: 0, flat: 20 });
  });
  it('parses plain dice', () => {
    expect(parseDice('D6')).toMatchObject({ count: 1, sides: 6, flat: 0 });
    expect(parseDice('D3')).toMatchObject({ count: 1, sides: 3, flat: 0 });
    expect(parseDice('2D6')).toMatchObject({ count: 2, sides: 6, flat: 0 });
  });
  it('parses dice with a modifier', () => {
    expect(parseDice('D3+1')).toMatchObject({ count: 1, sides: 3, flat: 1 });
    expect(parseDice('2D6-1')).toMatchObject({ count: 2, sides: 6, flat: -1 });
    expect(parseDice('D6 + 2')).toMatchObject({ count: 1, sides: 6, flat: 2 });
  });
  it('throws on garbage', () => {
    expect(() => parseDice('banana')).toThrow();
  });
  it('reports max value and variability', () => {
    expect(maxValue(parseDice('D6+1'))).toBe(7);
    expect(isVariable(parseDice('3'))).toBe(false);
    expect(isVariable(parseDice('D3'))).toBe(true);
  });
});

describe('roll', () => {
  it('is deterministic for a seed and within bounds', () => {
    const a = roll('2D6+1', makeRNG(42));
    const b = roll('2D6+1', makeRNG(42));
    expect(a.total).toBe(b.total);
    expect(a.total).toBeGreaterThanOrEqual(3);
    expect(a.total).toBeLessThanOrEqual(13);
  });
  it('flat expression rolls no dice', () => {
    const r = roll('5', makeRNG(1));
    expect(r.total).toBe(5);
    expect(r.rolls).toEqual([]);
  });
});
