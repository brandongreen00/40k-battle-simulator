// Detachment Points (11e army construction). PURE.
//
// Every detachment costs 1–3 DP; the battle size sets the budget. Costs transcribed from the
// Wahapedia 11e faction pages (Faction Pack v1.1, retrieved 2026-08-16), which now carry the
// real printed DP values — these replace the launch-window review guesses (which had all
// Imperial Agents at 3 DP; the printed packs price them at 1–2). Provenance snapshot:
// tools/ingest/points11e.json `detachments`; sources in docs/11e_detachment_points.md.
//
// GW has stated (Warhammer Community) that any SINGLE lone detachment is meant to be legal
// regardless of its DP cost, but this is not yet errata'd. Army lists in this project carry one
// detachment, so we apply that stated-intent rule and emit a warning (not an error) when the
// lone detachment exceeds the RAW budget. (After the v1.1 costs, that only bites the 3 DP
// Grizzled Company / Recon Element at 1000 pts.)

export interface DpBudget {
  dp: number;
  enhancements: number;
}

/** DP + enhancement budget by points limit (official army-construction rules). */
export function dpBudget(pointsLimit: number): DpBudget {
  return pointsLimit <= 1000 ? { dp: 2, enhancements: 2 } : { dp: 3, enhancements: 4 };
}

/** 11e Detachment Point costs (Astra Militarum + Imperial Agents), Faction Pack v1.1.
 *  The comment after each entry is the detachment's printed Force Disposition. */
export const DETACHMENT_POINTS: Record<string, number> = {
  // ── Astra Militarum ──
  'Abhuman Auxiliaries': 1, // Take and Hold
  'Bridgehead Strike': 1, // Priority Assets
  'Designation Force': 1, // Reconnaissance
  'Armoured Infantry': 2, // Take and Hold
  'Combined Arms': 2, // Take and Hold
  'Hammer of the Emperor': 2, // Purge the Foe
  'Mechanised Assault': 2, // Reconnaissance
  'Siege Regiment': 2, // Disruption
  'Steel Hammer': 2, // Purge the Foe
  'Grizzled Company': 3, // Priority Assets
  'Recon Element': 3, // Reconnaissance
  // ── Imperial Agents (v1.1 prices every Agents detachment at 1–2 DP, so a 2000 pt /
  // 3 DP army could legally field TWO Agents detachments — not yet modelled here) ──
  'Imperialis Fleet': 2, // Reconnaissance
  'Ordo Hereticus Purgation Force': 2, // Take and Hold
  'Ordo Malleus Daemon Hunters': 2, // Priority Assets
  'Ordo Xenos Alien Hunters': 2, // Purge the Foe
  'Veiled Blade Elimination Force': 1, // Disruption
};

/** DP cost of a detachment. Unlisted detachments (Grotmas/10e leftovers in the data) default to
 *  2 DP — the modal cost of both factions' printed packs. (The faction parameter is kept for
 *  callers; since v1.1 the fallback no longer differs by faction.) */
export function detachmentPoints(name: string, _faction?: string): number {
  return DETACHMENT_POINTS[name] ?? 2;
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
