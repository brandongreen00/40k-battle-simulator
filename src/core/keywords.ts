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
  lethalHits?: boolean; // critical hit -> may auto-wound
  devastatingWounds?: boolean; // critical wound -> D mortal wounds (11e, 24.10)
  anti?: AntiClause[]; // Anti-X N+ : wound crit threshold vs matching targets
  /** [BLAST]/[BLAST X]: +1/+X attack dice per 5 models in the target; cannot target engaged. */
  blast?: boolean | number;
  /** [CLEAVE X] (11e): +X attack dice per 5 models when the melee weapon has a single target. */
  cleave?: number;
  torrent?: boolean; // auto-hits (no hit roll)
  heavy?: boolean; // +1 to hit if the bearer braced (moved <= 3", unengaged — 24.16)
  assault?: boolean; // enables assault shooting after an Advance (10.05)
  /** [CLOSE-QUARTERS] / [PISTOL] (identical in 11e, 24.27): enables close-quarters shooting. */
  pistol?: boolean;
  ignoresCover?: boolean; // target gets no Cover benefit
  lance?: boolean; // +1 to wound if the bearer charged this turn
  precision?: boolean; // may pick a visible CHARACTER's allocation group (24.28)
  indirectFire?: boolean; // enables indirect shooting (10.07)
  hazardous?: boolean; // hazard roll per selected weapon after resolving (24.15)
  twinLinked?: boolean; // re-roll the wound roll
  extraAttacks?: boolean; // resolved in addition to the model's other melee weapons
  psychic?: boolean; // may ignore BS/WS and hit-roll modifiers (24.29); psychic attack
  conversion?: boolean; // crit hit at long range (legacy 10e data)
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
    } else if (k.startsWith('blast')) out.blast = NUM_AFTER(k) || true;
    else if (k.startsWith('cleave')) out.cleave = NUM_AFTER(k) || 1;
    else if (k === 'torrent') out.torrent = true;
    else if (k === 'heavy') out.heavy = true;
    else if (k === 'assault') out.assault = true;
    else if (k === 'pistol' || k === 'close-quarters' || k === 'close quarters') out.pistol = true;
    else if (k === 'psychic') out.psychic = true;
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
