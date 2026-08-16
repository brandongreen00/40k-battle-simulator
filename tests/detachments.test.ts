// Detachment Points (11e): budgets, curated costs, the lone-detachment allowance in validate().

import { describe, it, expect } from 'vitest';
import { dpBudget, detachmentPoints, checkDetachmentPoints } from '../src/core/detachments';

describe('detachment points', () => {
  it('budgets: 2 DP + 2 enhancements at 1000, 3 DP + 4 at 2000', () => {
    expect(dpBudget(1000)).toEqual({ dp: 2, enhancements: 2 });
    expect(dpBudget(2000)).toEqual({ dp: 3, enhancements: 4 });
  });

  it('costs match the printed Faction Pack v1.1 values (Wahapedia 11e, 2026-08-16)', () => {
    expect(detachmentPoints('Bridgehead Strike')).toBe(1);
    expect(detachmentPoints('Mechanised Assault')).toBe(2);
    expect(detachmentPoints('Combined Arms')).toBe(2); // the reviews guessed 3
    expect(detachmentPoints('Grizzled Company')).toBe(3);
    // Imperial Agents: the launch reviews had all five at 3 DP; the pack prices them 1–2.
    expect(detachmentPoints('Imperialis Fleet')).toBe(2);
    expect(detachmentPoints('Ordo Hereticus Purgation Force')).toBe(2);
    expect(detachmentPoints('Veiled Blade Elimination Force')).toBe(1);
  });

  it('unlisted detachments (Grotmas/10e leftovers) default to 2 DP', () => {
    expect(detachmentPoints('Tempestus Boarding Regiment', 'AM')).toBe(2);
    expect(detachmentPoints("Voidship's Company", 'AoI')).toBe(2);
  });

  it('a 3 DP detachment at 1000 pts is over budget but allowed as a lone detachment', () => {
    const check = checkDetachmentPoints('Grizzled Company', 'AM', 1000);
    expect(check.cost).toBe(3);
    expect(check.overBudgetLone).toBe(true);
    expect(checkDetachmentPoints('Grizzled Company', 'AM', 2000).overBudgetLone).toBe(false);
    // Every Agents detachment now fits the 1000 pt budget — and at 2000 pts (3 DP) two
    // Agents detachments would fit together (not yet modelled; one detachment per list).
    expect(checkDetachmentPoints('Imperialis Fleet', 'AoI', 1000).overBudgetLone).toBe(false);
    expect(checkDetachmentPoints('Bridgehead Strike', 'AM', 1000).overBudgetLone).toBe(false);
  });
});
