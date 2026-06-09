// Universal weapon-keyword library. PURE — no React, no DOM.
//
// 10th edition has a finite set of universal weapon abilities (Core rules). Wahapedia stores
// them as free-text inside each weapon's keyword list, with inconsistent casing ("PISTOL" vs
// "pistol", "Rapid Fire 1" vs "rapid fire 1") and numeric suffixes ("Melta 2", "Anti-Infantry 4+",
// "Sustained Hits 1"). This module normalises those strings into a structured `ParsedKeywords`
// the combat pipeline can read without string-matching everywhere.
//
// Scope (architecture rule: only what the three lists exercise, but the universal set is small
// and finite, so we parse all of the Core abilities the plan §4 enumerates).

/** A single Anti-X N+ clause, e.g. {keyword: "VEHICLE", threshold: 4} for "Anti-Vehicle 4+". */
export interface AntiClause {
  keyword: string; // target KEYWORD this applies against, upper-cased (e.g. "INFANTRY")
  threshold: number; // wound-roll value at/above which it auto-criticals (e.g. 4 for 4+)
}

/** Structured form of a weapon's universal abilities. Absent fields mean "doesn't have it". */
export interface ParsedKeywords {
  rapidFire?: number; // +N attacks at half range
  melta?: number; // +N damage at half range
  sustainedHits?: number; // each critical hit -> +N extra hits
  lethalHits?: boolean; // critical hit -> auto-wound
  devastatingWounds?: boolean; // critical wound -> mortal-style wounds (no save)
  anti?: AntiClause[]; // Anti-X N+ : wound crit threshold vs matching targets
  blast?: boolean; // +1 attack per 5 models in target unit; cannot target engaged
  torrent?: boolean; // auto-hits (no hit roll)
  heavy?: boolean; // +1 to hit if the bearer Remained Stationary
  assault?: boolean; // may fire after Advancing
  pistol?: boolean; // may fire while engaged; cannot fire alongside non-pistols
  ignoresCover?: boolean; // target gets no Cover benefit
  lance?: boolean; // +1 to wound if the bearer charged this turn
  precision?: boolean; // may allocate wounds to attached CHARACTERS
  indirectFire?: boolean; // may target units not visible (with penalties)
  hazardous?: boolean; // risk to the bearer after firing
  twinLinked?: boolean; // re-roll the wound roll
  extraAttacks?: boolean; // resolved in addition to the model's other melee weapons
  conversion?: boolean; // crit hit at long range
  oneShot?: boolean; // usable once per battle
  /** Anything we didn't recognise, kept verbatim (lower-cased) for visibility/debugging. */
  unknown: string[];
}

const NUM_AFTER = (s: string): number => {
  const m = /(-?\d+)/.exec(s);
  return m ? parseInt(m[1]!, 10) : 0;
};

/**
 * Parse a weapon's raw keyword strings into structured abilities.
 * Unrecognised entries land in `unknown` rather than being dropped.
 */
export function parseKeywords(raw: string[]): ParsedKeywords {
  const out: ParsedKeywords = { unknown: [] };
  for (const entry of raw) {
    const k = entry.trim().toLowerCase();
    if (k === '') continue;

    if (k.startsWith('rapid fire')) out.rapidFire = NUM_AFTER(k) || 1;
    else if (k.startsWith('melta')) out.melta = NUM_AFTER(k) || 1;
    else if (k.startsWith('sustained hits')) out.sustainedHits = NUM_AFTER(k) || 1;
    else if (k === 'lethal hits') out.lethalHits = true;
    else if (k === 'devastating wounds') out.devastatingWounds = true;
    else if (k.startsWith('anti-') || k.startsWith('anti ')) {
      // "anti-infantry 4+" -> keyword INFANTRY, threshold 4
      const body = k.replace(/^anti[- ]/, '');
      const threshold = NUM_AFTER(body) || 4;
      const keyword = body.replace(/\s*\d+\+?.*$/, '').trim().toUpperCase();
      (out.anti ??= []).push({ keyword, threshold });
    } else if (k === 'blast') out.blast = true;
    else if (k === 'torrent') out.torrent = true;
    else if (k === 'heavy') out.heavy = true;
    else if (k === 'assault') out.assault = true;
    else if (k === 'pistol') out.pistol = true;
    else if (k === 'ignores cover') out.ignoresCover = true;
    else if (k === 'lance') out.lance = true;
    else if (k === 'precision') out.precision = true;
    else if (k === 'indirect fire') out.indirectFire = true;
    else if (k === 'hazardous') out.hazardous = true;
    else if (k === 'twin-linked' || k === 'twin linked') out.twinLinked = true;
    else if (k.startsWith('extra attacks')) out.extraAttacks = true;
    else if (k === 'conversion') out.conversion = true;
    else if (k === 'one shot' || k === 'one-shot') out.oneShot = true;
    else out.unknown.push(k);
  }
  return out;
}
