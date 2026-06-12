import { describe, it, expect } from 'vitest';
import { meanDice, poolStats, chargeProb, expectedWeaponDamage, pSaveFail } from '../src/core/ai/evaluate';
import type { WeaponProfile } from '../src/core/types';

describe('ai/evaluate — dice & pool math', () => {
  it('meanDice matches expectations', () => {
    expect(meanDice('2')).toBe(2);
    expect(meanDice('D6')).toBe(3.5);
    expect(meanDice('2D6+1')).toBe(8);
    expect(meanDice('D3')).toBe(2);
  });

  it('poolStats: plain 3+ is 4/6; reroll-1s adds the failed-1 mass', () => {
    const plain = poolStats(3, 0, 6, 'none');
    expect(plain.pSuccess).toBeCloseTo(4 / 6, 10);
    expect(plain.pCrit).toBeCloseTo(1 / 6, 10);
    const ones = poolStats(3, 0, 6, 'ones');
    expect(ones.pSuccess).toBeCloseTo(4 / 6 + (1 / 6) * (4 / 6), 10);
  });

  it('poolStats: +1 cannot make a 2+ better, and an unmodified 1 always fails', () => {
    const buffed = poolStats(2, 1, 6, 'none');
    expect(buffed.pSuccess).toBeCloseTo(5 / 6, 10);
  });

  it('chargeProb matches the 2D6 table', () => {
    expect(chargeProb(2)).toBe(1);
    expect(chargeProb(7)).toBeCloseTo(21 / 36, 10);
    expect(chargeProb(12)).toBeCloseTo(1 / 36, 10);
    expect(chargeProb(12.5)).toBe(0);
  });

  it('pSaveFail respects AP, invuln and cover', () => {
    expect(pSaveFail(3, 0, undefined, false)).toBeCloseTo(2 / 6, 10); // 3+ save
    expect(pSaveFail(3, -3, undefined, false)).toBeCloseTo(5 / 6, 10); // worsened to a 6+
    expect(pSaveFail(5, -2, undefined, false)).toBeCloseTo(1, 10); // pushed past 6+ → no save
    expect(pSaveFail(3, -3, 4, false)).toBeCloseTo(3 / 6, 10); // 4++ floor
    expect(pSaveFail(4, -1, undefined, true)).toBeCloseTo(3 / 6, 10); // cover cancels the AP
  });
});

describe('ai/evaluate — expected damage', () => {
  const bolter: WeaponProfile = { name: 'boltgun', type: 'ranged', range: 24, attacks: '2', skill: 3, S: 4, AP: 0, D: '1', keywords: [] };
  const lascannon: WeaponProfile = { name: 'lascannon', type: 'ranged', range: 48, attacks: '1', skill: 3, S: 12, AP: -3, D: 'D6+1', keywords: [] };

  it('matches a hand-computed bolter volley', () => {
    // 5 models × 2 attacks, 3+ hit (2/3), S4 vs T4 (4+ → 1/2), 3+ save vs AP0 (fail 1/3).
    const ev = expectedWeaponDamage(bolter, 5, { T: 4, save: 3, W: 2, modelCount: 5, keywords: [] });
    expect(ev.damage).toBeCloseTo(10 * (2 / 3) * (1 / 2) * (1 / 3) * 1, 6);
  });

  it('prefers the tank for the lascannon and the infantry for the bolter (kills-value sanity)', () => {
    const tank = { T: 11, save: 2, W: 13, modelCount: 1, keywords: ['VEHICLE'] };
    const squad = { T: 3, save: 5, W: 1, modelCount: 10, keywords: ['INFANTRY'] };
    const lasVsTank = expectedWeaponDamage(lascannon, 1, tank).damage;
    const lasVsSquad = expectedWeaponDamage(lascannon, 1, squad).damage; // capped at W1 per wound
    expect(lasVsTank).toBeGreaterThan(lasVsSquad);
    const boltVsSquad = expectedWeaponDamage(bolter, 5, squad).kills;
    const boltVsTank = expectedWeaponDamage(bolter, 5, tank).kills;
    expect(boltVsSquad).toBeGreaterThan(boltVsTank);
  });

  it('caps kills at the target unit size and applies Rapid Fire at half range', () => {
    const ev = expectedWeaponDamage(bolter, 50, { T: 3, save: 7, W: 1, modelCount: 5, keywords: [] });
    expect(ev.kills).toBeLessThanOrEqual(5);
    const rf: WeaponProfile = { ...bolter, keywords: ['Rapid Fire 1'] };
    const far = expectedWeaponDamage(rf, 5, { T: 4, save: 3, W: 2, modelCount: 5, keywords: [] });
    const near = expectedWeaponDamage(rf, 5, { T: 4, save: 3, W: 2, modelCount: 5, keywords: [] }, { halfRange: true });
    expect(near.damage).toBeCloseTo(far.damage * 1.5, 6);
  });
});
