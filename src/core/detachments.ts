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
  // 3 DP army can legally field TWO Agents detachments — see splitDetachments below) ──
  'Imperialis Fleet': 2, // Reconnaissance
  'Ordo Hereticus Purgation Force': 2, // Take and Hold
  'Ordo Malleus Daemon Hunters': 2, // Priority Assets
  'Ordo Xenos Alien Hunters': 2, // Purge the Foe
  'Veiled Blade Elimination Force': 1, // Disruption
};

/** DP cost of a detachment — or the SUM for a combined multi-detachment name ("A and B").
 *  Unlisted detachments (Grotmas/10e leftovers in the data) default to 2 DP — the modal cost of
 *  both factions' printed packs. (The faction parameter is kept for callers; since v1.1 the
 *  fallback no longer differs by faction.) */
export function detachmentPoints(name: string, _faction?: string): number {
  return splitDetachments(name).reduce((s, d) => s + (DETACHMENT_POINTS[d] ?? 2), 0);
}

// ── Multi-detachment armies (11e) ────────────────────────────────────────────
// An army may take MULTIPLE detachments within the DP budget (2+1 at 2000 pts). The GW app
// exports such an army with the detachments joined in one header line — "Imperialis Fleet and
// Veiled Blade Elimination Force (3 Detachment Points)" — and that combined string is what an
// ArmyList/Roster carries as its `detachment`. These helpers split it back into its component
// detachments wherever a rule is detachment-scoped (enhancements, stratagems, detachment rules).

/** Punctuation/case-insensitive canonical form for comparing detachment names across sources
 *  (the app writes "Ordo Hereticus, Purgation Force" where the data says
 *  "Ordo Hereticus Purgation Force"). */
export function normalizeDetachmentName(s: string): string {
  return s
    .replace(/\(\s*\d+\s*detachment points?\s*\)/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Split an army's detachment string into its component detachment names. A single known name
 * (or any unrecognised string — Combat Patrol names, Grotmas leftovers) returns as-is; a
 * combined "<A> and <B>" line splits only when EVERY part matches a known detachment, so a
 * detachment whose own name contained "and" could never be broken apart by accident.
 */
export function splitDetachments(name: string): string[] {
  const known = new Map(Object.keys(DETACHMENT_POINTS).map((k) => [normalizeDetachmentName(k), k]));
  const whole = known.get(normalizeDetachmentName(name));
  if (whole) return [whole];
  const parts = name
    .replace(/\(\s*\d+\s*detachment points?\s*\)/i, '')
    .split(/\s+(?:and|&)\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length > 1 && parts.every((p) => known.has(normalizeDetachmentName(p)))) {
    return parts.map((p) => known.get(normalizeDetachmentName(p))!);
  }
  return [name];
}

/** Is `name` one of the curated 11e detachments — i.e. a name splitDetachments can recognise
 *  inside a combined string? Grotmas/10e leftovers in the data are NOT: a combined name
 *  containing one would never split back apart (silently breaking enhancement scoping and DP
 *  sums), so such detachments can only ever be an army's LONE detachment. */
export function isKnownDetachment(name: string): boolean {
  const norm = normalizeDetachmentName(name);
  return Object.keys(DETACHMENT_POINTS).some((k) => normalizeDetachmentName(k) === norm);
}

/** Canonical inverse of splitDetachments: join component detachments into the combined string
 *  the GW app prints ("A and B"). Blanks and duplicates (compared case/punctuation-insensitively)
 *  are dropped; one part returns as-is; none returns ''. */
export function joinDetachments(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const norm = normalizeDetachmentName(t);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(t);
  }
  return out.join(' and ');
}

/** Does an army whose (possibly combined) detachment string is `armyDetachment` include the
 *  detachment `name`? Used for enhancement/stratagem scoping and detachment rules. */
export function armyHasDetachment(armyDetachment: string | undefined, name: string): boolean {
  if (!armyDetachment) return false;
  const target = normalizeDetachmentName(name);
  return splitDetachments(armyDetachment).some((d) => normalizeDetachmentName(d) === target);
}

export interface DpCheck {
  cost: number;
  budget: DpBudget;
  /** The component detachments (1 entry for a normal lone-detachment army). */
  detachments: string[];
  /** A LONE detachment RAW-over-budget — permitted by GW's stated lone-detachment allowance. */
  overBudgetLone: boolean;
  /** MULTIPLE detachments whose summed cost exceeds the budget — a hard error (the lone
   *  allowance is explicitly about single detachments). */
  overBudgetMulti: boolean;
}

/** Check an army's detachment(s) — possibly a combined "<A> and <B>" string — against the DP
 *  budget for its points limit. Multiple detachments sum their costs. */
export function checkDetachmentPoints(detachment: string, faction: string | undefined, pointsLimit: number): DpCheck {
  const detachments = splitDetachments(detachment);
  const cost = detachmentPoints(detachment, faction);
  const budget = dpBudget(pointsLimit);
  const over = cost > budget.dp;
  return {
    cost,
    budget,
    detachments,
    overBudgetLone: over && detachments.length === 1,
    overBudgetMulti: over && detachments.length > 1,
  };
}
