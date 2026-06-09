import { describe, it, expect } from 'vitest';
import { belowHalfStrength, battleShockTest } from '../src/core/battleshock';
import { maxMoveDistance, chargeSucceeds, deepStrikeLegal, rollCharge } from '../src/core/movement';
import { makeRNG } from '../src/core/rng';

describe('battle-shock', () => {
  it('below half strength by model count', () => {
    expect(belowHalfStrength(4, 10)).toBe(true);
    expect(belowHalfStrength(5, 10)).toBe(false); // exactly half is not below
    expect(belowHalfStrength(6, 10)).toBe(false);
  });
  it('single multi-wound model uses wounds fraction', () => {
    expect(belowHalfStrength(1, 1, 0.4)).toBe(true);
    expect(belowHalfStrength(1, 1, 0.6)).toBe(false);
  });
  it('no test required at full strength', () => {
    const t = battleShockTest(10, 10, 7, makeRNG(1));
    expect(t.required).toBe(false);
    expect(t.passed).toBe(true);
  });
  it('a test is required and resolved when below half', () => {
    const t = battleShockTest(3, 10, 7, makeRNG(1));
    expect(t.required).toBe(true);
    expect(t.roll).toHaveLength(2);
    expect(t.passed).toBe(t.total >= 7);
  });
});

describe('movement math', () => {
  it('move modes', () => {
    expect(maxMoveDistance(6, 'normal')).toBe(6);
    expect(maxMoveDistance(6, 'advance', 4)).toBe(10);
    expect(maxMoveDistance(6, 'stationary')).toBe(0);
  });
  it('charge succeeds when the roll closes the gap to engagement', () => {
    expect(chargeSucceeds(7, 7)).toBe(true); // need 6", rolled 7
    expect(chargeSucceeds(10, 6)).toBe(false); // need 9", rolled 6
  });
  it('deep strike must be 9" from all enemies', () => {
    expect(deepStrikeLegal([9, 12, 20])).toBe(true);
    expect(deepStrikeLegal([8.9, 12])).toBe(false);
  });
  it('charge rolls 2D6 deterministically from a seed', () => {
    expect(rollCharge(makeRNG(5)).distance).toBe(rollCharge(makeRNG(5)).distance);
  });
});
