import { describe, it, expect } from 'vitest';
import { makeRNG } from '../src/core/rng';

describe('makeRNG', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRNG(12345);
    const b = makeRNG(12345);
    const seqA = a.roll(10);
    const seqB = b.roll(10);
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = makeRNG(1).roll(20);
    const b = makeRNG(2).roll(20);
    expect(a).not.toEqual(b);
  });

  it('next() stays within [0, 1)', () => {
    const r = makeRNG(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('d6() yields 1..6 across many rolls', () => {
    const r = makeRNG(99);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = r.d6();
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      expect(Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });

  it('int(min, max) is inclusive of both bounds', () => {
    const r = makeRNG(2024);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 8);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBe(3);
    expect(max).toBe(8);
  });
});
