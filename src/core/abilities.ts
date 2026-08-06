// Datasheet-ability lookups (10e Core + per-unit specials). PURE — no React, no DOM, no I/O.
//
// The converted data carries every datasheet's resolved ability list (name + rules text + the
// per-unit `parameter` of parameterised Core abilities like Scouts 9" / Feel No Pain 5+). This
// module is the one place that string-matches those names/texts into game-mechanical predicates,
// so the rest of the core never greps rules text itself.

import type { Datasheet, UnitInstance } from './types';
import type { EngineContext } from './engine';
import { enhancementScoutDistance } from './enhancements';

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
 * An enhancement can grant the unit Scouts outright (Survival Gear / Eager Advance — see
 * core/enhancements.ts), independent of the datasheets.
 */
export function unitScoutDistance(unit: UnitInstance, ctx: EngineContext): number | null {
  const granted = enhancementScoutDistance(unit, ctx);
  const dsIds = [...new Set([unit.datasheetId, ...(unit.attachedLeaders ?? []).map((l) => l.datasheetId)])];
  let min = Infinity;
  for (const id of dsIds) {
    const d = scoutDistance(ctx.datasheets.get(id));
    if (d == null) return granted;
    min = Math.min(min, d);
  }
  const innate = Number.isFinite(min) ? min : null;
  if (granted != null) return Math.max(granted, innate ?? 0);
  return innate;
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

/** Ability-name prefix match across the unit's datasheets (primary + merged Leaders) — CP
 *  ability names carry suffixes like "FOESIGHT (PSYCHIC)". */
export function unitHasAbilityStarting(unit: UnitInstance, ctx: EngineContext, prefix: string): boolean {
  const sheets = [
    ctx.datasheets.get(unit.datasheetId),
    ...(unit.attachedLeaders ?? []).map((l) => ctx.datasheets.get(l.datasheetId)),
  ];
  const want = prefix.toLowerCase();
  return sheets.some((ds) => abilityNames(ds).some((n) => n.toLowerCase().startsWith(want)));
}

/** Does any of the unit's datasheets carry the named ability (prefix match)? */
export function hasAbilityStarting(ds: Datasheet | undefined, prefix: string): boolean {
  const want = prefix.toLowerCase();
  return abilityNames(ds).some((n) => n.toLowerCase().startsWith(want));
}

/**
 * Combat Patrol per-unit specials: always-on EFFECT_REGISTRY bindings implied by the unit's
 * ability list (incl. merged Leaders' abilities where the rule is unit-scoped). The gated
 * conditions (target CHARACTER / S vs T / on an objective / below half) live on the effects'
 * `appliesTo` — this function only answers "does the unit carry the rule".
 */
export function cpInnateEffectIds(unit: UnitInstance, ctx: EngineContext): string[] {
  const out: string[] = [];
  const has = (prefix: string) => unitHasAbilityStarting(unit, ctx, prefix);
  if (has('foesight')) out.push('cp:foesight');
  if (has('force edge')) out.push('cp:force_edge');
  // Holy Hatred: "If this is an Attached unit" — only while Teguen leads.
  if (has('holy hatred') && (unit.attachedLeaders ?? []).length > 0) out.push('cp:holy_hatred');
  if (has('merciless judgement')) out.push('cp:merciless_judgement');
  if (has('loyal to the cause')) out.push('cp:loyal_to_the_cause');
  if (has('gravis protection')) out.push('cp:gravis_protection');
  if (has('superior weapon support system')) out.push('cp:swss');
  if (has('breach and clear')) out.push('cp:breach_and_clear');
  return out;
}

/** Shield Drone (T'au): +1 to the bearer's Wounds characteristic. */
export function abilityWoundBonus(ds: Datasheet | undefined): number {
  return hasAbility(ds, 'Shield Drone') ? 1 : 0;
}
