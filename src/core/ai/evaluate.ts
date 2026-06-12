// Analytic combat expectations for the AI. PURE — no React, no DOM, no I/O, no RNG.
//
// Mirrors the probability structure of core/combat.ts (hit → wound → save → damage, with the
// universal keyword library) so the AI can *rank* targets and positions without rolling dice.
// It deliberately ignores the rarer modifiers (active effects, per-model wargear saves) — the
// numbers steer decisions, the real dice still decide the game.

import type { Datasheet, GameState, UnitInstance, Vec2, WeaponProfile } from '../types';
import type { EngineContext } from '../engine';
import { availableUnitWeapons, planUnitShooting, closestGap } from '../engine';
import { parseDice } from '../dice';
import { parseKeywords, type ParsedKeywords } from '../keywords';
import { woundThreshold, effectiveSave, type Reroll } from '../combat';
import { gapBetweenBases } from '../geometry';
import { unitCanSee } from '../los';
import { hasLoneOperative, ignoresLoneOperative } from '../abilities';
import { aliveModels } from '../phases';

// ── dice & pool probabilities ─────────────────────────────────────────────────
/** Mean of a 40k dice expression ("2", "D6", "2D6+1"). */
export function meanDice(text: string): number {
  const e = parseDice(text);
  return Math.max(0, e.count * ((e.sides + 1) / 2) + e.flat);
}

/**
 * Success/critical probability of one d6 in a hit/wound pool, mirroring combat.ts `rollPool`:
 * criticals read the unmodified die, an unmodified 1 always fails, modifiers are pre-clamped ±1.
 */
export function poolStats(
  threshold: number,
  mod: number,
  critOn: number,
  reroll: Reroll,
): { pSuccess: number; pCrit: number } {
  const m = Math.max(-1, Math.min(1, mod));
  const ok = (raw: number) => raw >= critOn || (raw !== 1 && raw + m >= threshold);
  const crit = (raw: number) => raw >= critOn;
  let pOk = 0;
  let pCrit = 0;
  let pFailNoReroll = 0; // mass that fails and would NOT be re-rolled
  for (let raw = 1; raw <= 6; raw++) {
    const p = 1 / 6;
    if (ok(raw)) {
      pOk += p;
      if (crit(raw)) pCrit += p;
    } else {
      const rerolled = reroll === 'fail' || reroll === 'all' || (reroll === 'ones' && raw === 1);
      if (!rerolled) pFailNoReroll += p;
    }
  }
  const pReroll = 1 - pOk - pFailNoReroll;
  return { pSuccess: pOk + pReroll * pOk, pCrit: pCrit + pReroll * pCrit };
}

/** P(a save roll fails) given armour/AP/invuln/cover — mirrors combat.ts effectiveSave + "1 fails". */
export function pSaveFail(save: number, ap: number, invuln: number | undefined, cover: boolean): number {
  const sv = effectiveSave(save, ap, invuln, cover);
  if (sv > 6) return 1;
  const pSave = (7 - Math.max(2, sv)) / 6;
  return 1 - pSave;
}

/** P(2D6 ≥ need). `need` may be fractional (inches); 2D6 outcomes are integers. */
export function chargeProb(need: number): number {
  const n = Math.ceil(need - 1e-9);
  if (n <= 2) return 1;
  if (n > 12) return 0;
  let ways = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if (a + b >= n) ways++;
  return ways / 36;
}

// ── expected damage of one weapon profile ─────────────────────────────────────
export interface DefenderSummary {
  T: number;
  save: number;
  invuln?: number;
  W: number;
  modelCount: number;
  keywords: string[]; // upper-cased unit keywords (for Anti-X)
}

export interface FireSituation {
  halfRange?: boolean; // Rapid Fire / Melta active
  cover?: boolean;
  hitMod?: number;
  woundMod?: number;
  charged?: boolean; // Lance
  stationary?: boolean; // Heavy
}

export interface WeaponEV {
  /** Expected wounds removed from the target unit. */
  damage: number;
  /** Expected models slain (damage capped per model — overkill doesn't spill). */
  kills: number;
}

/** Expected damage/kills of `carriers` models firing one weapon profile at a defender. */
export function expectedWeaponDamage(
  weapon: WeaponProfile,
  carriers: number,
  def: DefenderSummary,
  sit: FireSituation = {},
): WeaponEV {
  if (carriers <= 0 || def.modelCount <= 0) return { damage: 0, kills: 0 };
  const kw: ParsedKeywords = parseKeywords(weapon.keywords);

  // 1. attacks
  let attacksPerModel = meanDice(weapon.attacks);
  if (kw.rapidFire && sit.halfRange) attacksPerModel += kw.rapidFire;
  if (kw.blast) attacksPerModel += Math.floor(def.modelCount / 5);
  const attacks = carriers * attacksPerModel;

  // 2. hits
  let hitsToWound: number;
  let lethalWounds = 0;
  if (kw.torrent) {
    hitsToWound = attacks;
  } else {
    const hitMod = (sit.hitMod ?? 0) + (kw.heavy && sit.stationary ? 1 : 0);
    const { pSuccess, pCrit } = poolStats(weapon.skill, hitMod, 6, 'none');
    const sustained = kw.sustainedHits ? pCrit * kw.sustainedHits : 0;
    lethalWounds = kw.lethalHits ? attacks * pCrit : 0;
    hitsToWound = attacks * (pSuccess + sustained) - lethalWounds;
  }

  // 3. wounds
  let critWoundOn = 6;
  for (const a of kw.anti ?? []) {
    if (def.keywords.includes(a.keyword)) critWoundOn = Math.min(critWoundOn, Math.max(2, a.threshold));
  }
  const woundMod = (sit.woundMod ?? 0) + (kw.lance && sit.charged ? 1 : 0);
  const reroll: Reroll = kw.twinLinked ? 'fail' : 'none';
  const { pSuccess: pW, pCrit: pWCrit } = poolStats(woundThreshold(weapon.S, def.T), woundMod, critWoundOn, reroll);
  const devastating = kw.devastatingWounds ? hitsToWound * pWCrit : 0;
  const saveable = hitsToWound * pW - devastating + lethalWounds;

  // 4 + 5. saves & damage
  const cover = !!sit.cover && !kw.ignoresCover;
  const pFail = pSaveFail(def.save, weapon.AP, def.invuln, cover);
  const woundsThrough = saveable * pFail + devastating;
  let dmgPerWound = meanDice(weapon.D);
  if (kw.melta && sit.halfRange) dmgPerWound += kw.melta;
  const effPerWound = Math.min(dmgPerWound, def.W); // overkill never spills between models
  const damage = woundsThrough * effPerWound;
  return { damage, kills: Math.min(def.modelCount, damage / Math.max(1, def.W)) };
}

// ── unit-level values ─────────────────────────────────────────────────────────
/** Points value of one model of a datasheet (points tier ÷ models; heuristic fallback). */
export function modelValue(ds: Datasheet | undefined): number {
  if (!ds) return 10;
  const tier = ds.points?.[0];
  if (tier && tier.models > 0 && tier.cost > 0) return tier.cost / tier.models;
  const m = ds.models[0];
  return m ? m.W * 4 + m.OC * 3 : 10;
}

/** Remaining points value of a unit (alive models × per-model value, incl. merged Leaders). */
export function unitValue(u: UnitInstance, ctx: EngineContext): number {
  let total = 0;
  for (const m of u.models) {
    if (!m.alive) continue;
    total += modelValue(ctx.datasheets.get(m.datasheetId ?? u.datasheetId));
  }
  return total;
}

/** Defender summary for EV math, from the unit's primary profile. */
export function defenderSummary(u: UnitInstance, ctx: EngineContext): DefenderSummary | null {
  const ds = ctx.datasheets.get(u.datasheetId);
  const p = ds?.models[0];
  if (!ds || !p) return null;
  return {
    T: p.T,
    save: p.Sv,
    invuln: p.invuln,
    W: p.W,
    modelCount: aliveModels(u).length,
    keywords: ds.keywords.map((k) => k.toUpperCase()),
  };
}

const REFERENCE_DEFENDER: DefenderSummary = { T: 4, save: 3, W: 2, modelCount: 5, keywords: ['INFANTRY'] };

/** Up to three spread-out points of a unit (first, middle, last) — enough for heuristic LoS. */
function samplePts(pts: Vec2[]): Vec2[] {
  if (pts.length <= 3) return pts;
  return [pts[0]!, pts[Math.floor(pts.length / 2)]!, pts[pts.length - 1]!];
}

/** Rough threat rating of a unit: expected damage of all its weapons into a reference target.
 *  Used to rank "what should I kill first" and "how scary is standing here". */
export function unitThreat(u: UnitInstance, ctx: EngineContext, type?: 'ranged' | 'melee'): number {
  let total = 0;
  for (const w of availableUnitWeapons(u, ctx)) {
    if (type && w.weapon.type !== type) continue;
    total += expectedWeaponDamage(w.weapon, w.carriers, REFERENCE_DEFENDER).damage;
  }
  return total;
}

/** Datasheet-level threat (1 bearer per weapon) — for role classification before models exist. */
export function datasheetThreat(ds: Datasheet | undefined, type: 'ranged' | 'melee'): number {
  let total = 0;
  for (const w of ds?.weapons ?? []) {
    if (w.type !== type) continue;
    total += expectedWeaponDamage(w, 1, REFERENCE_DEFENDER).damage;
  }
  return total;
}

/** The longest range among a unit's fireable ranged weapons (0 if none). */
export function maxWeaponRange(u: UnitInstance, ctx: EngineContext): number {
  let r = 0;
  for (const w of availableUnitWeapons(u, ctx)) {
    if (w.weapon.type === 'ranged') r = Math.max(r, w.weapon.range ?? 0);
  }
  return r;
}

// ── whole-unit shooting EV (the score the AI ranks targets/positions with) ────
/**
 * Expected points of damage if `attacker` shoots `target` now, with the attacker's alive models
 * optionally translated by `delta` (for move-candidate scoring). Uses the real fire plan (Pistol
 * rule, profile collapse), real ranges/LoS from model positions, and values kills in points.
 * Returns 0 when nothing can fire (out of range / no line of sight).
 */
export function shootingEV(
  state: GameState,
  attacker: UnitInstance,
  target: UnitInstance,
  ctx: EngineContext,
  delta: Vec2 = { x: 0, y: 0 },
): number {
  const aDs = ctx.datasheets.get(attacker.datasheetId);
  const tDs = ctx.datasheets.get(target.datasheetId);
  const def = defenderSummary(target, ctx);
  if (!aDs || !tDs || !def) return 0;
  const aPts = aliveModels(attacker).map((m) => ({ x: m.pos.x + delta.x, y: m.pos.y + delta.y }));
  const tPts = aliveModels(target).map((m) => m.pos);
  if (aPts.length === 0 || tPts.length === 0) return 0;

  let gap = Infinity;
  for (const a of aPts) for (const t of tPts) gap = Math.min(gap, gapBetweenBases(a, aDs.baseShape, t, tDs.baseShape));
  // Lone Operative mirrors the engine's targeting gate (>12" ranged shots are illegal) so the
  // AI never values — or submits — a shot the reducer would reject.
  if (
    hasLoneOperative(tDs) &&
    (target.attachedLeaders ?? []).length === 0 &&
    gap > 12 &&
    !ignoresLoneOperative(aDs)
  ) {
    return 0;
  }
  // LoS over a few representative models, not every pair — this is a ranking heuristic that runs
  // inside move-candidate loops; the engine still checks true unit-to-unit LoS when firing.
  const visible = unitCanSee(samplePts(aPts), samplePts(tPts), state.layout.terrain);

  const { fire } = planUnitShooting(state, attacker, ctx);
  const perModel = modelValue(tDs);
  let ev = 0;
  for (const w of fire) {
    const range = w.weapon.range ?? 0;
    if (gap > range) continue;
    const kw = parseKeywords(w.weapon.keywords);
    if (!visible && !kw.indirectFire) continue;
    const sit: FireSituation = {
      halfRange: gap <= range / 2,
      hitMod: !visible && kw.indirectFire ? -1 : 0,
      cover: !visible && kw.indirectFire ? true : undefined,
      stationary: attacker.status.remainedStationary,
    };
    ev += expectedWeaponDamage(w.weapon, w.carriers, def, sit).kills * perModel;
  }
  return ev;
}

/** Expected points of damage from one Fight activation of `attacker` into `target` (all melee weapons). */
export function meleeEV(attacker: UnitInstance, target: UnitInstance, ctx: EngineContext, charged = false): number {
  const def = defenderSummary(target, ctx);
  const tDs = ctx.datasheets.get(target.datasheetId);
  if (!def || !tDs) return 0;
  const perModel = modelValue(tDs);
  let ev = 0;
  for (const w of availableUnitWeapons(attacker, ctx)) {
    if (w.weapon.type !== 'melee') continue;
    ev += expectedWeaponDamage(w.weapon, w.carriers, def, { charged }).kills * perModel;
  }
  return ev;
}

/** Closest base-to-base gap between two units (Infinity when either is off-board/dead). */
export function unitGap(a: UnitInstance, b: UnitInstance, ctx: EngineContext): number {
  const aDs = ctx.datasheets.get(a.datasheetId);
  const bDs = ctx.datasheets.get(b.datasheetId);
  if (!aDs || !bDs) return Infinity;
  return closestGap(a, aDs.baseShape, b, bDs.baseShape);
}
