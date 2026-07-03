import { describe, it, expect } from 'vitest';
import { parseKeywords } from '../src/core/keywords';

describe('parseKeywords', () => {
  it('parses numeric abilities regardless of casing', () => {
    const k = parseKeywords(['Rapid Fire 1', 'MELTA 2', 'sustained hits 1']);
    expect(k.rapidFire).toBe(1);
    expect(k.melta).toBe(2);
    expect(k.sustainedHits).toBe(1);
  });
  it('parses boolean abilities', () => {
    const k = parseKeywords(['Lethal Hits', 'devastating wounds', 'Torrent', 'ignores cover', 'pistol']);
    expect(k.lethalHits).toBe(true);
    expect(k.devastatingWounds).toBe(true);
    expect(k.torrent).toBe(true);
    expect(k.ignoresCover).toBe(true);
    expect(k.pistol).toBe(true);
  });
  it('parses Anti-X N+ into target keyword + threshold', () => {
    const k = parseKeywords(['Anti-Infantry 4+', 'anti-vehicle 3+']);
    expect(k.anti).toEqual([
      { keyword: 'INFANTRY', threshold: 4 },
      { keyword: 'VEHICLE', threshold: 3 },
    ]);
  });
  it('keeps unrecognised keywords in `unknown`', () => {
    const k = parseKeywords(['Some New Rule', 'Lethal Hits']);
    expect(k.unknown).toContain('some new rule');
    expect(k.lethalHits).toBe(true);
    // 11e additions parse structurally.
    expect(parseKeywords(['Psychic']).psychic).toBe(true);
    expect(parseKeywords(['Cleave 1']).cleave).toBe(1);
    expect(parseKeywords(['Close-Quarters']).pistol).toBe(true);
  });
});
