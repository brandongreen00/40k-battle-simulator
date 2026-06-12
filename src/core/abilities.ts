// Datasheet-ability lookups (10e Core + per-unit specials). PURE — no React, no DOM, no I/O.
//
// The converted data carries every datasheet's resolved ability list (name + rules text + the
// per-unit `parameter` of parameterised Core abilities like Scouts 9" / Feel No Pain 5+). This
// module is the one place that string-matches those names/texts into game-mechanical predicates,
// so the rest of the core never greps rules text itself.

import type { Datasheet, UnitInstance } from './types';
import type { EngineContext } from './engine';

/** All ability names on a datasheet (empty when the data has no resolved ability list). */
export function abilityNames(ds: Datasheet | undefined): string[] {
  return (ds?.abilities ?? []).map((a) => a.name).filter(Boolean);
}

/** Case-insensitive exact ability-name lookup. */
export function hasAbility(ds: Datasheet | undefined, name: string): boolean {
  const want = name.toLowerCase();
  return abilityNames(ds).some((n) => n.toLowerCase() === want);
}

/** The verbatim parameter of a named ability (e.g. Scouts → '9"'), if present. */
export function abilityParameter(ds: Datasheet | undefined, name: string): string | undefined {
  const want = name.toLowerCase();
  return (ds?.abilities ?? []).find((a) => a.name.toLowerCase() === want)?.parameter;
}

// ── Scouts ───────────────────────────────────────────────────────────────────
/**
 * Scouts X": the distance this datasheet may move at the start of the first battle round, before
 * the first turn begins (null = no Scouts ability). Falls back to 6" if the data carries the
 * ability without its parameter.
 */
export function scoutDistance(ds: Datasheet | undefined): number | null {
  if (!ds || !hasAbility(ds, 'Scouts')) return null;
  const param = abilityParameter(ds, 'Scouts');
  const n = param ? parseFloat(param) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/**
 * The Scout move a unit may make: every model must have Scouts (10e), so a merged Leader without
 * it removes the unit's Scout move. Uses the smallest X across the contributing datasheets.
 */
export function unitScoutDistance(unit: UnitInstance, ctx: EngineContext): number | null {
  const dsIds = [...new Set([unit.datasheetId, ...(unit.attachedLeaders ?? []).map((l) => l.datasheetId)])];
  let min = Infinity;
  for (const id of dsIds) {
    const d = scoutDistance(ctx.datasheets.get(id));
    if (d == null) return null;
    min = Math.min(min, d);
  }
  return Number.isFinite(min) ? min : null;
}

// ── Targeting / eligibility specials ─────────────────────────────────────────
/** Lone Operative: only targetable by ranged attacks within 12" (unless part of an Attached unit). */
export function hasLoneOperative(ds: Datasheet | undefined): boolean {
  return hasAbility(ds, 'Lone Operative');
}

/** Deadshot (Vindicare): this model's ranged attacks ignore the Lone Operative ability. */
export function ignoresLoneOperative(ds: Datasheet | undefined): boolean {
  return hasAbility(ds, 'Deadshot');
}

/** Innate Stealth (-1 to be hit by ranged attacks). */
export function hasStealth(ds: Datasheet | undefined): boolean {
  return hasAbility(ds, 'Stealth');
}

/** Innate Fights First. */
export function hasFightsFirstAbility(ds: Datasheet | undefined): boolean {
  return hasAbility(ds, 'Fights First');
}

/**
 * Frenzon-style carve-out: "eligible to shoot and/or declare a charge in a turn in which it
 * Advanced". Matched on the rules text so any datasheet with the same wording benefits.
 */
export function canActAfterAdvance(ds: Datasheet | undefined): { shoot: boolean; charge: boolean } {
  for (const a of ds?.abilities ?? []) {
    const t = a.description.toLowerCase();
    if (!/in a turn in which it advanced/.test(t)) continue;
    return {
      shoot: /eligible to shoot/.test(t),
      charge: /declare a charge/.test(t),
    };
  }
  return { shoot: false, charge: false };
}

// ── Pre-battle specials (Rogue Trader) ───────────────────────────────────────
/** Backroom Deals: while this model leads a unit, that unit has Infiltrators (one pick per army). */
export function hasBackroomDeals(ds: Datasheet | undefined): boolean {
  return hasAbility(ds, 'Backroom Deals');
}

/** Warrant of Trade: after both armies deploy, redeploy up to D3 IMPERIUM BATTLELINE units. */
export function hasWarrantOfTrade(ds: Datasheet | undefined): boolean {
  return hasAbility(ds, 'Warrant of Trade');
}

/** Does this unit (incl. merged Leaders) put a Warrant of Trade in the army? */
export function unitHasWarrant(unit: UnitInstance, ctx: EngineContext): boolean {
  if (hasWarrantOfTrade(ctx.datasheets.get(unit.datasheetId))) return true;
  return (unit.attachedLeaders ?? []).some((l) => hasWarrantOfTrade(ctx.datasheets.get(l.datasheetId)));
}

// ── Innate effect bindings ───────────────────────────────────────────────────
/**
 * Always-on effect ids (EFFECT_REGISTRY) implied by a datasheet's ability list: innate Stealth and
 * innate Feel No Pain X+. These join `INNATE_ABILITY_EFFECTS` (the curated per-datasheet seam) in
 * the engine's effect gathering.
 */
export function innateEffectIds(ds: Datasheet | undefined): string[] {
  const out: string[] = [];
  if (hasStealth(ds)) out.push('stealth');
  const fnp = abilityParameter(ds, 'Feel No Pain');
  if (fnp) {
    const n = parseInt(fnp, 10);
    if (n >= 4 && n <= 6) out.push(`fnp_${n}`);
  }
  return out;
}
