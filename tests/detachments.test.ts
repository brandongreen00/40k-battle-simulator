// Detachment Points (11e): budgets, curated costs, the lone-detachment allowance in validate().

import { describe, it, expect } from 'vitest';
import { dpBudget, detachmentPoints, checkDetachmentPoints } from '../src/core/detachments';

describe('detachment points', () => {
  it('budgets: 2 DP + 2 enhancements at 1000, 3 DP + 4 at 2000', () => {
    expect(dpBudget(1000)).toEqual({ dp: 2, enhancements: 2 });
    expect(dpBudget(2000)).toEqual({ dp: 3, enhancements: 4 });
  });

  it('curated costs match the faction-pack research', () => {
    expect(detachmentPoints('Bridgehead Strike')).toBe(1);
    expect(detachmentPoints('Mechanised Assault')).toBe(2);
    expect(detachmentPoints('Grizzled Company')).toBe(3);
    expect(detachmentPoints('Imperialis Fleet')).toBe(3);
    expect(detachmentPoints('Veiled Blade Elimination Force')).toBe(3);
  });

  it('unlisted detachments default by faction (AM 2, Agents 3)', () => {
    expect(detachmentPoints('Tempestus Boarding Regiment', 'AM')).toBe(2);
    expect(detachmentPoints("Voidship's Company", 'AoI')).toBe(3);
  });

  it('a 3 DP detachment at 1000 pts is over budget but allowed as a lone detachment', () => {
    const check = checkDetachmentPoints('Imperialis Fleet', 'AoI', 1000);
    expect(check.cost).toBe(3);
    expect(check.overBudgetLone).toBe(true);
    expect(checkDetachmentPoints('Imperialis Fleet', 'AoI', 2000).overBudgetLone).toBe(false);
    expect(checkDetachmentPoints('Bridgehead Strike', 'AM', 1000).overBudgetLone).toBe(false);
  });
});
