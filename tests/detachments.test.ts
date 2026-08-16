// Detachment Points (11e): budgets, curated costs, the lone-detachment allowance in validate().

import { describe, it, expect } from 'vitest';
import {
  dpBudget,
  detachmentPoints,
  checkDetachmentPoints,
  splitDetachments,
  armyHasDetachment,
} from '../src/core/detachments';

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
    // Agents detachments fit together (see the multi-detachment block below).
    expect(checkDetachmentPoints('Imperialis Fleet', 'AoI', 1000).overBudgetLone).toBe(false);
    expect(checkDetachmentPoints('Bridgehead Strike', 'AM', 1000).overBudgetLone).toBe(false);
  });
});

describe('multi-detachment armies (the GW app joins the names with "and")', () => {
  const combined = 'Imperialis Fleet and Veiled Blade Elimination Force';

  it('splits a combined name into its canonical components', () => {
    expect(splitDetachments(combined)).toEqual(['Imperialis Fleet', 'Veiled Blade Elimination Force']);
    // The app's DP suffix and punctuation don't break the match.
    expect(splitDetachments('Imperialis Fleet and Veiled Blade Elimination Force (3 Detachment Points)')).toEqual([
      'Imperialis Fleet',
      'Veiled Blade Elimination Force',
    ]);
    // A single name — or anything unrecognised (patrol names, Grotmas leftovers) — stays whole.
    expect(splitDetachments('Imperialis Fleet')).toEqual(['Imperialis Fleet']);
    expect(splitDetachments("Crowe's Sanctifiers")).toEqual(["Crowe's Sanctifiers"]);
    // "and" inside an unknown name never splits it (both halves must be known detachments).
    expect(splitDetachments('Sword and Shield Company')).toEqual(['Sword and Shield Company']);
  });

  it('armyHasDetachment answers membership for combined and single names', () => {
    expect(armyHasDetachment(combined, 'Imperialis Fleet')).toBe(true);
    expect(armyHasDetachment(combined, 'Veiled Blade Elimination Force')).toBe(true);
    expect(armyHasDetachment(combined, 'Ordo Xenos Alien Hunters')).toBe(false);
    expect(armyHasDetachment('Imperialis Fleet', 'Imperialis Fleet')).toBe(true);
    expect(armyHasDetachment(undefined, 'Imperialis Fleet')).toBe(false);
  });

  it('DP sums across components: 2+1 fits the 3 DP budget at 2000 pts, not the 2 DP at 1000', () => {
    expect(detachmentPoints(combined)).toBe(3);
    const at2000 = checkDetachmentPoints(combined, 'AoI', 2000);
    expect(at2000.cost).toBe(3);
    expect(at2000.detachments).toHaveLength(2);
    expect(at2000.overBudgetLone).toBe(false);
    expect(at2000.overBudgetMulti).toBe(false);
    // The same pair at 1000 pts (2 DP budget) is a hard error — the lone allowance is
    // explicitly about single detachments.
    const at1000 = checkDetachmentPoints(combined, 'AoI', 1000);
    expect(at1000.overBudgetMulti).toBe(true);
    expect(at1000.overBudgetLone).toBe(false);
    // Two 2 DP detachments bust the 3 DP budget at 2000 pts too.
    expect(checkDetachmentPoints('Imperialis Fleet and Ordo Xenos Alien Hunters', 'AoI', 2000).overBudgetMulti).toBe(true);
  });
});
