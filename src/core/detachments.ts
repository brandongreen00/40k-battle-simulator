// Detachment Points (11e army construction). PURE.
//
// Every detachment costs 1–3 DP; the battle size sets the budget. Costs curated from the
// launch-window faction-pack reviews (tabletopbattles.com, 2026-06-11) cross-checked against the
// GDM 2026 fan database — the official faction-pack PDFs do not print DP costs. See
// docs/11e_detachment_points.md for sources and confidence notes.
//
// GW has stated (Warhammer Community) that any SINGLE lone detachment is meant to be legal
// regardless of its DP cost, but this is not yet errata'd. Army lists in this project carry one
// detachment, so we apply that stated-intent rule and emit a warning (not an error) when the
// lone detachment exceeds the RAW budget.

export interface DpBudget {
  dp: number;
  enhancements: number;
}

/** DP + enhancement budget by points limit (official army-construction rules). */
export function dpBudget(pointsLimit: number): DpBudget {
  return pointsLimit <= 1000 ? { dp: 2, enhancements: 2 } : { dp: 3, enhancements: 4 };
}

/** Curated 11e Detachment Point costs (Astra Militarum + Imperial Agents). */
export const DETACHMENT_POINTS: Record<string, number> = {
  // ── Astra Militarum ──
  'Abhuman Auxiliaries': 1,
  'Bridgehead Strike': 1,
  'Designation Force': 1,
  'Armoured Infantry': 2,
  'Hammer of the Emperor': 2,
  'Mechanised Assault': 2,
  'Siege Regiment': 2,
  'Steel Hammer': 2,
  'Combined Arms': 3,
  'Grizzled Company': 3,
  'Recon Element': 3,
  // ── Imperial Agents (every Agents detachment costs the maximum 3 DP) ──
  'Imperialis Fleet': 3,
  'Ordo Hereticus Purgation Force': 3,
  'Ordo Malleus Daemon Hunters': 3,
  'Ordo Xenos Alien Hunters': 3,
  'Veiled Blade Elimination Force': 3,
};

/** DP cost of a detachment. Unlisted detachments (Grotmas/10e leftovers in the data) default to
 *  2 DP for Astra Militarum and 3 DP for Imperial Agents (the faction pattern). */
export function detachmentPoints(name: string, faction?: string): number {
  const known = DETACHMENT_POINTS[name];
  if (known != null) return known;
  return faction && /agents|aoi/i.test(faction) ? 3 : 2;
}

export interface DpCheck {
  cost: number;
  budget: DpBudget;
  /** RAW-over-budget, permitted by GW's stated lone-detachment allowance. */
  overBudgetLone: boolean;
}

/** Check one army list's lone detachment against the DP budget for its points limit. */
export function checkDetachmentPoints(detachment: string, faction: string | undefined, pointsLimit: number): DpCheck {
  const cost = detachmentPoints(detachment, faction);
  const budget = dpBudget(pointsLimit);
  return { cost, budget, overBudgetLone: cost > budget.dp };
}
