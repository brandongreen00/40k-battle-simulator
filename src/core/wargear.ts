// Wargear option engine. PURE — no React/DOM/I/O.
//
// Two jobs:
//   1. Turn a datasheet's free-text `wargearOption.text` into a real numeric *cap* on how many
//      models may take that option, honouring the "for every N models, up to M models" ratio
//      (e.g. Deathwatch thunder hammers: 2 per 5, so 4 in a 10-model unit). This is what the
//      Options UI ticks against and what `army.validate` enforces.
//   2. Identify the *items* each option grants and which items are defensive (shields → invuln),
//      so the game can resolve per-model saves from a unit's loadout (see engine.ts / combat.ts).
//
// 10e wargear is natural language on Wahapedia, so this is a deliberately pragmatic parser: it
// recognises the handful of phrasings the two owned factions actually use and falls back to a
// safe "1 model" cap otherwise. Loadouts are stored as an item→count map (mirroring the app's
// own export format, e.g. "4x Deathwatch thunder hammer"), which is the granularity the game and
// the importer both need.

import type { Datasheet } from './types';

/** A unit's chosen wargear: item display-name → number of models carrying it. */
export type Loadout = Record<string, number>;

// Base weapons that come "for free" on the default loadout; never the signature of an upgrade.
const GENERIC_WEAPONS = new Set([
  'boltgun',
  'bolt pistol',
  'power weapon',
  'close combat weapon',
  'laspistol',
  'lasgun',
  'chainsword',
  'autopistol',
]);

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
function toInt(token: string): number {
  return WORD_NUM[token.toLowerCase()] ?? parseInt(token, 10);
}
function norm(s: string): string {
  return s.toLowerCase().replace(/[’]/g, "'").trim();
}

/**
 * Maximum number of models in a `modelCount`-strong unit that may take the wargear option whose
 * rule text is `text`. Honours the "for every N models, up to M" ratio; defaults to 1 model.
 */
export function maxModelsForOption(text: string, modelCount: number): number {
  const t = norm(text);
  const per = t.match(/for every (\d+)[^,]* in (?:this|the) unit/);
  const scope = per ? t.slice((per.index ?? 0) + per[0].length) : t;

  let count: number;
  if (/any number of/.test(scope)) {
    count = modelCount;
  } else {
    const upto = scope.match(/up to (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
    if (upto) {
      count = toInt(upto[1]!);
    } else {
      // Leading quantity of the *subject* (before the verb): "1 Navis Armsman", "One model".
      const subject = scope.split(/\b(?:can|could|replaced|replace|equipped|have|has)\b/)[0] ?? scope;
      const lead = subject.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
      count = lead ? toInt(lead[1]!) : 1;
    }
  }

  if (per) {
    const n = parseInt(per[1]!, 10);
    if (n > 0) return Math.max(0, Math.min(modelCount, Math.floor(modelCount / n) * count));
  }
  return Math.max(0, Math.min(modelCount, count));
}

// ── Item extraction ────────────────────────────────────────────────────────────
function stripLeadingCount(s: string): string {
  return s.replace(/^\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+/i, '').trim();
}

/** Split a clause like "1 power weapon and 1 Astartes shield" into its item names. */
function itemsInClause(clause: string): string[] {
  return clause
    .replace(/\.$/, '')
    .split(/\s+and\s+/i)
    .map((s) => stripLeadingCount(s))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^one of the following/i.test(s));
}

/**
 * The "signature" item of a single replacement clause — the non-generic / defining piece. Returns
 * undefined when the clause only grants generic default weapons (e.g. "1 bolt pistol and 1 power
 * weapon"): those can't be told apart from a model's default loadout by counting, so we don't track
 * or enforce them (it would false-positive against default-weapon counts).
 */
function signatureOf(clause: string, weaponNames: string[]): string | undefined {
  const items = itemsInClause(clause);
  const special = items.find((it) => !GENERIC_WEAPONS.has(it.toLowerCase()));
  if (!special) return undefined;
  const hit = weaponNames.find((w) => w.toLowerCase() === special.toLowerCase());
  return hit ?? special;
}

/** Pull the granted clause(s) out of a single-swap option text (no explicit `choices`). */
function grantedClause(text: string): string {
  const m = text.match(/(?:replaced with|equipped with|replace (?:its|their)[^]*? with)\s+(.+)$/i);
  return (m ? m[1]! : text).trim();
}

export interface WargearChoice {
  /** Canonical item name the loadout map is keyed on (e.g. "Deathwatch thunder hammer"). */
  item: string;
  /** Human label shown in the UI (the full choice text when it differs from `item`). */
  label: string;
}

export interface UnitWargearOption {
  optionIndex: number; // index into datasheet.wargearOptions
  text: string; // original rule text
  max: number; // cap on models taking this option, given the current model count
  choices: WargearChoice[]; // selectable items; share `max` as one pool
}

/**
 * Resolve a datasheet's wargear options against a concrete `modelCount` into UI-ready options:
 * each with a numeric cap and the list of items it can grant. Items across an option's `choices`
 * draw from the same `max` pool (e.g. two Astartes-shield variants share the "up to 2 per 5" cap).
 */
export function unitWargearOptions(ds: Datasheet, modelCount: number): UnitWargearOption[] {
  const weaponNames = ds.weapons.map((w) => w.name);
  const out: UnitWargearOption[] = [];
  (ds.wargearOptions ?? []).forEach((opt, optionIndex) => {
    if (/^none$/i.test(opt.text.trim())) return;
    const max = maxModelsForOption(opt.text, modelCount);
    const choices: WargearChoice[] = [];
    const seen = new Set<string>();
    const add = (item: string | undefined, label: string) => {
      if (!item) return;
      const key = item.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      choices.push({ item, label });
    };
    if (opt.choices.length > 0) {
      for (const c of opt.choices) add(signatureOf(c, weaponNames), c.trim());
    } else {
      const clause = grantedClause(opt.text);
      add(signatureOf(clause, weaponNames), stripLeadingCount(clause).replace(/\.$/, ''));
    }
    if (choices.length > 0) out.push({ optionIndex, text: opt.text, max, choices });
  });
  return out;
}

// ── Defensive wargear (per-model saves) ─────────────────────────────────────────
export interface DefensiveProfile {
  invuln?: number; // invulnerable save value the bearer gains (e.g. 4 → 4++)
  saveBonus?: number; // improvement to the armour save (e.g. 1 → Sv 4+ becomes 3+)
}

/**
 * Curated table of defensive wargear in the two owned factions. Keys are matched as lowercase
 * substrings of an item name. Values are best-effort 10e readings — flagged as assumptions in the
 * Progress Log; the *mechanism* (per-model loadout → per-model save) is the deliverable, the exact
 * numbers are data and easily corrected here.
 */
export const DEFENSIVE_WARGEAR: Record<string, DefensiveProfile> = {
  'astartes shield': { invuln: 4 },
  'endurant shield': { invuln: 4 },
  'storm shield': { invuln: 4 },
  'boarding shield': { invuln: 4 },
  'brute shield': { invuln: 4 },
};

/** The defensive profile a single wargear item confers, if any. */
export function defensiveProfileForItem(item: string): DefensiveProfile | undefined {
  const lc = item.toLowerCase();
  for (const key of Object.keys(DEFENSIVE_WARGEAR)) {
    if (lc.includes(key)) return DEFENSIVE_WARGEAR[key];
  }
  return undefined;
}

/** Scan free text (e.g. a default-loadout description) for known defensive wargear item names. */
export function defensiveItemsInText(text: string): string[] {
  const lc = text.toLowerCase();
  return Object.keys(DEFENSIVE_WARGEAR)
    .filter((key) => lc.includes(key))
    // Recover a presentable name (Title-case the matched key).
    .map((key) => key.replace(/\b\w/g, (c) => c.toUpperCase()));
}

// ── Loadout validation ──────────────────────────────────────────────────────────
export interface LoadoutViolation {
  optionIndex: number;
  message: string;
}

/**
 * Validate a unit's loadout against its option caps. For each option, the number of models that
 * took *any* of its items must not exceed the option's `max`.
 */
export function validateUnitLoadout(ds: Datasheet, modelCount: number, loadout: Loadout | undefined): LoadoutViolation[] {
  if (!loadout) return [];
  const violations: LoadoutViolation[] = [];
  for (const opt of unitWargearOptions(ds, modelCount)) {
    const used = opt.choices.reduce((sum, c) => sum + (loadout[c.item] ?? 0), 0);
    if (used > opt.max) {
      const names = opt.choices.map((c) => c.item).join(' / ');
      violations.push({
        optionIndex: opt.optionIndex,
        message: `${ds.name}: ${used} models take ${names} but only ${opt.max} may (for ${modelCount} models).`,
      });
    }
  }
  return violations;
}
