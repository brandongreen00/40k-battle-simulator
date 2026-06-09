import { describe, it, expect } from 'vitest';
import { gatherAttackModifiers, EFFECT_REGISTRY, type AttackContext } from '../src/core/effects';
import { parseKeywords } from '../src/core/keywords';

const ctx = (over: Partial<AttackContext> = {}): AttackContext => ({
  phase: 'shooting', weaponType: 'ranged', weaponKeywords: parseKeywords([]),
  attackerKeywords: ['INFANTRY'], targetKeywords: ['INFANTRY'], gap: 6, ...over,
});

describe('gatherAttackModifiers', () => {
  it('sums offensive modifiers from issued orders', () => {
    const m = gatherAttackModifiers(ctx(), ['order:take_aim', 'plus1_to_wound'], []);
    expect(m.hitModifier).toBe(1);
    expect(m.woundModifier).toBe(1);
  });
  it('a defender Stealth effect lowers the attacker hit modifier', () => {
    const m = gatherAttackModifiers(ctx(), [], ['stealth']);
    expect(m.hitModifier).toBe(-1);
  });
  it('respects appliesTo gating (Take Aim! is ranged-only)', () => {
    const m = gatherAttackModifiers(ctx({ weaponType: 'melee', phase: 'fight' }), ['order:take_aim'], []);
    expect(m.hitModifier).toBe(0);
  });
  it('aggregates defensive damage reduction and FNP', () => {
    const m = gatherAttackModifiers(ctx(), [], ['minus1_damage', 'fnp_5']);
    expect(m.damageReduction).toBe(1);
    expect(m.fnp).toBe(5);
  });
  it('keeps the best re-roll', () => {
    const m = gatherAttackModifiers(ctx(), ['reroll_hits_1'], []);
    expect(m.rerollHits).toBe('ones');
  });
  it('a defender effect is ignored when listed as an attacker effect', () => {
    const m = gatherAttackModifiers(ctx(), ['minus1_damage'], []);
    expect(m.damageReduction).toBe(0);
  });
  it('every registry entry has a matching id and a side', () => {
    for (const [id, eff] of Object.entries(EFFECT_REGISTRY)) {
      expect(eff.id).toBe(id);
      expect(['attacker', 'defender']).toContain(eff.side);
    }
  });
});
