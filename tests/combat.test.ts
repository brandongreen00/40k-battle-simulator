import { describe, it, expect } from 'vitest';
import {
  resolveAttacks,
  woundThreshold,
  effectiveSave,
  type AttackProfile,
  type DefenderProfile,
} from '../src/core/combat';
import { parseKeywords } from '../src/core/keywords';
import { makeRNG } from '../src/core/rng';

function defender(count: number, p: Partial<DefenderProfile> = {}): DefenderProfile {
  const maxW = p.models?.[0]?.maxW ?? 1;
  return {
    T: p.T ?? 3,
    save: p.save ?? 5,
    invuln: p.invuln,
    keywords: p.keywords ?? ['INFANTRY'],
    fnp: p.fnp,
    models: p.models ?? Array.from({ length: count }, () => ({ maxW, wounds: maxW })),
  };
}

function weapon(p: Omit<Partial<AttackProfile>, 'keywords'> & { keywords?: string[] }): AttackProfile {
  return {
    name: p.name ?? 'test gun',
    attacks: p.attacks ?? '1',
    skill: p.skill ?? 3,
    S: p.S ?? 4,
    AP: p.AP ?? 0,
    D: p.D ?? '1',
    keywords: parseKeywords(p.keywords ?? []),
  };
}

describe('woundThreshold (10e chart)', () => {
  it.each([
    [8, 4, 2], // S >= 2T
    [5, 4, 3], // S > T
    [4, 4, 4], // S == T
    [3, 4, 5], // S < T, more than half
    [2, 4, 6], // S*2 <= T
    [2, 5, 6],
    [3, 5, 5],
  ])('S%i vs T%i wounds on %i+', (S, T, expected) => {
    expect(woundThreshold(S, T)).toBe(expected);
  });
});

describe('effectiveSave', () => {
  it('worsens with AP', () => {
    expect(effectiveSave(3, -1, undefined)).toBe(4);
    expect(effectiveSave(3, -2, undefined)).toBe(5);
  });
  it('11e: cover no longer modifies the save (it worsens the attacker BS instead)', () => {
    expect(effectiveSave(4, 0, undefined)).toBe(4);
  });
  it('AP 0 leaves saves unchanged', () => {
    expect(effectiveSave(3, 0, undefined)).toBe(3);
    expect(effectiveSave(2, 0, undefined)).toBe(2);
    expect(effectiveSave(4, 0, undefined)).toBe(4);
  });
  it('AP worsens the armour save', () => {
    expect(effectiveSave(3, -1, undefined)).toBe(4);
    expect(effectiveSave(2, -1, undefined)).toBe(3);
  });
  it('takes the best of armour and invuln', () => {
    expect(effectiveSave(2, -3, 4)).toBe(4); // armour 5+, invuln 4++ -> 4++
  });
});

describe('resolveAttacks — deterministic edges', () => {
  it('Torrent auto-hits (no hit roll)', () => {
    const r = resolveAttacks(
      weapon({ name: 'Flamer', attacks: '6', S: 4, keywords: ['torrent'] }),
      defender(10),
      { attackerCount: 1 },
      makeRNG(1),
    );
    expect(r.attacks).toBe(6);
    expect(r.hits).toBe(6);
  });

  it('Blast adds +1 attack per 5 target models', () => {
    const r = resolveAttacks(
      weapon({ name: 'Frag', attacks: '3', keywords: ['blast', 'torrent'] }),
      defender(10),
      { attackerCount: 1, targetModelCount: 10 },
      makeRNG(2),
    );
    expect(r.attacks).toBe(5); // 3 + floor(10/5)=2
  });

  it('multi-wound models do not let damage spill over', () => {
    // One S10 AP-3 D6 hit that always wounds & fails save vs a 3-wound model: at most one model dies.
    const r = resolveAttacks(
      weapon({ name: 'Big gun', attacks: '1', S: 20, AP: -6, D: '6' }),
      defender(2, { T: 4, save: 7, models: [{ maxW: 3, wounds: 3 }, { maxW: 3, wounds: 3 }] }),
      { attackerCount: 1 },
      makeRNG(5),
    );
    expect(r.modelsSlain).toBeLessThanOrEqual(1);
  });
});

describe('resolveAttacks — Monte Carlo vs analytic expectation', () => {
  // 20 lasgun-equivalent shots: A1 BS4+ S3 AP0 D1, rapid fire active (10 models -> 20 attacks),
  // into T3 Sv5+ 1W models. Analytic mean damage = 20 * 1/2 (hit) * 1/2 (wound) * 4/6 (failed save).
  it('mean damage matches the dice math within tolerance', () => {
    const analytic = 20 * (1 / 2) * (1 / 2) * (4 / 6); // ≈ 3.33
    const trials = 4000;
    let total = 0;
    for (let s = 0; s < trials; s++) {
      const r = resolveAttacks(
        weapon({ name: 'Lasgun', attacks: '1', skill: 4, S: 3, AP: 0, D: '1', keywords: ['rapid fire 1'] }),
        defender(40, { T: 3, save: 5 }),
        { attackerCount: 10, rapidFireActive: true },
        makeRNG(s + 1),
      );
      total += r.damageDealt;
    }
    const mean = total / trials;
    expect(mean).toBeGreaterThan(analytic - 0.25);
    expect(mean).toBeLessThan(analytic + 0.25);
  });

  it('Sustained Hits 1 increases expected hits', () => {
    const trials = 3000;
    let plain = 0;
    let sustained = 0;
    for (let s = 0; s < trials; s++) {
      plain += resolveAttacks(
        weapon({ attacks: '10', skill: 3, S: 8, AP: -2, D: '1' }),
        defender(40, { T: 3, save: 5 }),
        { attackerCount: 1 },
        makeRNG(s + 1),
      ).hits;
      sustained += resolveAttacks(
        weapon({ attacks: '10', skill: 3, S: 8, AP: -2, D: '1', keywords: ['sustained hits 1'] }),
        defender(40, { T: 3, save: 5 }),
        { attackerCount: 1 },
        makeRNG(s + 1),
      ).hits;
    }
    expect(sustained).toBeGreaterThan(plain);
  });
});
