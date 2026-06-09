// Engine glue between the static datasheet data and the live game state. PURE — no I/O imports;
// the datasheet lookup is *injected* via EngineContext (same dependency-injection seam as the RNG).
//
// `resolveAttack` turns a high-level "unit A attacks unit B with weapon W" request into the
// numeric combat call (combat.ts), maps the casualties back onto the target's live models, and
// returns a new GameState plus a dice log. Range / half-range / engagement are read from the
// real model positions via geometry; line-of-sight and cover arrive in Phase 2.

import type { Datasheet, GameState, UnitInstance, Vec2, BaseShape } from './types';
import type { RNG } from './rng';
import { baseRadius, gapBetweenBases } from './geometry';
import { parseKeywords } from './keywords';
import { resolveAttacks, type AttackProfile, type DefenderProfile, type CombatSituation } from './combat';
import { unitCanSee, unitHasCover } from './los';
import { controlOfObjective, scorePrimary, type OcModel } from './objectives';
import { battleShockTest } from './battleshock';
import { rollCharge } from './movement';
import { gatherAttackModifiers, type AttackContext } from './effects';
import { defensiveProfileForItem } from './wargear';

/** Injected lookup the engine needs to read unit stats. Not imported — passed in (rule #1/#2). */
export interface EngineContext {
  datasheets: Map<string, Datasheet>;
}

export interface AttackParams {
  attackerUnitId: string;
  targetUnitId: string;
  weaponName: string;
  /** Override the number of firing models (defaults to every alive model in the attacker). */
  attackerCount?: number;
}

export interface AttackOutcome {
  state: GameState;
  /** Single-line human summary; empty when the attack was illegal (see `rejected`). */
  summary: string;
  rejected?: string; // reason the attack could not be made (out of range, no LoS later, etc.)
}

const ENGAGEMENT_RANGE = 1; // inches

function attackProfileFor(ds: Datasheet, weaponName: string): AttackProfile | undefined {
  const w = ds.weapons.find((x) => x.name === weaponName);
  if (!w) return undefined;
  return {
    name: w.name,
    attacks: w.attacks,
    skill: w.skill,
    S: w.S,
    AP: w.AP,
    D: w.D,
    keywords: parseKeywords(w.keywords),
  };
}

/**
 * Curated innate effects per datasheet (Phase 3 seam). Maps a datasheet id to always-on effect
 * ids from EFFECT_REGISTRY. Empty until the owned lists enumerate each unit's specials; this is
 * where e.g. a Bullgryn's "-1 Damage" or a unit's innate Feel No Pain gets bound (one line each).
 */
export const INNATE_ABILITY_EFFECTS: Record<string, string[]> = {};

/** All effect ids active on a unit right now: issued Orders/Stratagems plus innate abilities. */
function effectsOf(unit: UnitInstance): string[] {
  return [...(unit.status.activeEffects ?? []), ...(INNATE_ABILITY_EFFECTS[unit.datasheetId] ?? [])];
}

function defenderProfileFor(ds: Datasheet, unit: UnitInstance): DefenderProfile {
  const m = ds.models[0]!; // primary profile; multi-profile allocation arrives later
  return {
    T: m.T,
    save: m.Sv,
    invuln: m.invuln,
    keywords: ds.keywords,
    models: unit.models
      .filter((x) => x.alive)
      .map((x) => {
        // A shield-bearer (or other defensive wargear) overrides the unit's save/invuln.
        let invuln = m.invuln;
        let save: number | undefined;
        for (const item of x.wargear ?? []) {
          const def = defensiveProfileForItem(item);
          if (!def) continue;
          if (def.invuln != null) invuln = Math.min(invuln ?? 7, def.invuln);
          if (def.saveBonus != null) save = Math.max(2, (save ?? m.Sv) - def.saveBonus);
        }
        return { maxW: m.W, wounds: x.wounds, ...(invuln != null ? { invuln } : {}), ...(save != null ? { save } : {}) };
      }),
  };
}

/** Closest base-to-base gap (inches) between any two alive models of the two units. */
export function closestGap(a: UnitInstance, aShape: BaseShape, b: UnitInstance, bShape: BaseShape): number {
  let min = Infinity;
  for (const am of a.models) {
    if (!am.alive) continue;
    for (const bm of b.models) {
      if (!bm.alive) continue;
      min = Math.min(min, gapBetweenBases(am.pos as Vec2, aShape, bm.pos as Vec2, bShape));
    }
  }
  return min;
}

/**
 * Resolve one attack and return the next state. Pure: never mutates `state`.
 * The weapon's type (ranged/melee) selects range vs engagement legality.
 */
export function resolveAttack(
  state: GameState,
  params: AttackParams,
  ctx: EngineContext,
  rng: RNG,
): AttackOutcome {
  const attacker = state.units.find((u) => u.id === params.attackerUnitId);
  const target = state.units.find((u) => u.id === params.targetUnitId);
  if (!attacker || !target) return { state, summary: '', rejected: 'unit not found' };

  const aDs = ctx.datasheets.get(attacker.datasheetId);
  const tDs = ctx.datasheets.get(target.datasheetId);
  if (!aDs || !tDs) return { state, summary: '', rejected: 'datasheet not found' };

  const weaponDef = aDs.weapons.find((w) => w.name === params.weaponName);
  const profile = attackProfileFor(aDs, params.weaponName);
  if (!weaponDef || !profile) return { state, summary: '', rejected: 'weapon not found' };

  const aliveAttackers = attacker.models.filter((m) => m.alive).length;
  const aliveTargets = target.models.filter((m) => m.alive).length;
  if (aliveAttackers === 0 || aliveTargets === 0) return { state, summary: '', rejected: 'no models' };

  const gap = closestGap(attacker, aDs.baseShape, target, tDs.baseShape);
  const kw = profile.keywords;

  // Legality + situational flags from real positions.
  const isMelee = weaponDef.type === 'melee';
  if (isMelee) {
    if (gap > ENGAGEMENT_RANGE) return { state, summary: '', rejected: 'not in engagement range' };
  } else {
    const range = weaponDef.range ?? 0;
    if (gap > range) return { state, summary: '', rejected: `out of range (${gap.toFixed(1)}" > ${range}")` };
  }

  // Line of sight + cover from terrain (Phase 2). Indirect Fire may target unseen units.
  const aPts = attacker.models.filter((m) => m.alive).map((m) => m.pos);
  const tPts = target.models.filter((m) => m.alive).map((m) => m.pos);
  const terrain = state.layout.terrain;
  let hitPenalty = 0;
  let forceCover = false;
  if (!isMelee) {
    const visible = unitCanSee(aPts, tPts, terrain);
    if (!visible) {
      if (!kw.indirectFire) return { state, summary: '', rejected: 'no line of sight' };
      hitPenalty -= 1; // Indirect Fire: -1 to hit and the target gets cover
      forceCover = true;
    }
  }

  const halfRange = (weaponDef.range ?? 0) / 2;

  // Gather ability/Order/Stratagem effects (Phase 3) and merge them into the situation.
  const abilityCtx: AttackContext = {
    phase: isMelee ? 'fight' : 'shooting',
    weaponType: isMelee ? 'melee' : 'ranged',
    weaponKeywords: kw,
    attackerKeywords: aDs.keywords.map((k) => k.toUpperCase()),
    targetKeywords: tDs.keywords.map((k) => k.toUpperCase()),
    gap,
  };
  const mods = gatherAttackModifiers(abilityCtx, effectsOf(attacker), effectsOf(target));

  const cover = (forceCover || (!isMelee && unitHasCover(aPts, tPts, terrain))) && !mods.ignoresCover;
  const situation: CombatSituation = {
    attackerCount: params.attackerCount ?? aliveAttackers,
    hitModifier: hitPenalty + mods.hitModifier,
    woundModifier: mods.woundModifier,
    rapidFireActive: !isMelee && gap <= halfRange,
    meltaActive: !isMelee && gap <= halfRange,
    longRange: !isMelee && gap >= 12,
    charged: attacker.status.charged,
    stationary: attacker.status.remainedStationary,
    cover,
    targetModelCount: aliveTargets,
    critHitOn: mods.critHitOn,
    critWoundOn: mods.critWoundOn,
    rerollHits: mods.rerollHits,
    rerollWounds: mods.rerollWounds,
    damageReduction: mods.damageReduction,
  };

  const defender = defenderProfileFor(tDs, target);
  if (mods.fnp != null) defender.fnp = mods.fnp;
  if (mods.invulnFloor != null) defender.invuln = Math.min(defender.invuln ?? 7, mods.invulnFloor);
  const result = resolveAttacks(profile, defender, situation, rng);

  // Map the updated wound state back onto the target's alive models, in order.
  let idx = 0;
  const newTargetModels = target.models.map((m) => {
    if (!m.alive) return m;
    const updated = result.defenderModels[idx++];
    if (!updated) return m;
    const wounds = updated.wounds;
    return { ...m, wounds, alive: wounds > 0 };
  });

  const newUnits = state.units.map((u) => {
    if (u.id === target.id) return { ...u, models: newTargetModels };
    if (u.id === attacker.id) {
      return { ...u, status: { ...u.status, [isMelee ? 'hasFought' : 'hasShot']: true } };
    }
    return u;
  });

  const verb = isMelee ? 'fights' : 'shoots';
  const summary =
    `${aDs.name} ${verb} ${tDs.name} with ${profile.name}: ` +
    `${result.hits} hits, ${result.failedSaves + result.devastating} wounds through, ` +
    `${result.damageDealt} damage, ${result.modelsSlain} slain`;

  return {
    state: { ...state, units: newUnits, log: [...state.log, summary, ...result.log.map((l) => `  ${l.step}: ${l.detail}`)] },
    summary,
  };
}

// ── Objective control & scoring (Phase 2) ──────────────────────────────────────
const aliveCount = (u: UnitInstance): number => u.models.filter((m) => m.alive).length;

/** Build the OC model list for every alive model. Battle-shocked units contribute OC 0. */
function ocModels(state: GameState, ctx: EngineContext): OcModel[] {
  const out: OcModel[] = [];
  for (const u of state.units) {
    const ds = ctx.datasheets.get(u.datasheetId);
    if (!ds) continue;
    const oc = u.status.battleShocked ? 0 : ds.models[0]!.OC;
    const radius = baseRadius(ds.baseShape);
    for (const m of u.models) {
      if (m.alive) out.push({ pos: m.pos, oc, radius, owner: u.owner });
    }
  }
  return out;
}

/** Per-objective control plus the number of objectives each side controls. */
export function objectiveControl(state: GameState, ctx: EngineContext) {
  const markerRadius = (state.layout.objectiveMarkerDiameterIn ?? 1.575) / 2;
  const controlRadius = state.layout.objectiveControlRadiusIn ?? 3;
  const models = ocModels(state, ctx);
  const perObjective = state.layout.objectives.map((marker) =>
    controlOfObjective(marker, markerRadius, controlRadius, models),
  );
  const controlled = { player: 0, ai: 0 };
  for (const c of perObjective) if (c.controller) controlled[c.controller]++;
  return { perObjective, controlled };
}

/**
 * Run the active player's Command phase: gain 1 CP, take Battle-shock tests for below-half units,
 * then score Primary VP for held objectives. Pure; requires data (Ld/OC) + RNG (the 2D6 tests).
 */
export function runCommandPhase(state: GameState, ctx: EngineContext, rng: RNG): GameState {
  const side = state.activePlayer;
  const log: string[] = [`— ${side} Command phase (round ${state.round}) —`];

  // 1. Command points: +1 at the start of each player's Command phase.
  const cp = { ...state.cp, [side]: state.cp[side] + 1 };
  log.push(`${side} gains 1 CP (now ${cp[side]})`);

  // 2. Battle-shock tests for the active player's below-half units.
  const reports: import('./types').BattleShockReport[] = [];
  const units = state.units.map((u) => {
    if (u.owner !== side) return u;
    const ds = ctx.datasheets.get(u.datasheetId);
    if (!ds) return { ...u, status: { ...u.status, battleShocked: false } };
    const alive = aliveCount(u);
    if (alive === 0) return u;
    const ld = ds.models[0]!.Ld;
    const woundsFraction =
      u.startingModels === 1 ? u.models[0]!.wounds / Math.max(1, ds.models[0]!.W) : undefined;
    const test = battleShockTest(alive, u.startingModels, ld, rng, woundsFraction);
    if (test.required) {
      reports.push({ unitId: u.id, unitName: ds.name, roll: [test.roll[0]!, test.roll[1]!], total: test.total, ld, passed: test.passed });
      log.push(
        `${ds.name} Battle-shock: ${test.roll.join('+')}=${test.total} vs Ld ${ld}+ → ${test.passed ? 'passed' : 'BATTLE-SHOCKED'}`,
      );
    }
    return { ...u, status: { ...u.status, battleShocked: test.required && !test.passed } };
  });

  // 3. Primary scoring for objectives the active player controls (from battle round 2+).
  const stateForScore = { ...state, units };
  let score = state.score;
  if (state.round >= 2) {
    const { controlled } = objectiveControl(stateForScore, ctx);
    const gained = scorePrimary(controlled[side], state.score[side]);
    if (gained > 0) {
      score = { ...state.score, [side]: state.score[side] + gained };
      log.push(`${side} controls ${controlled[side]} objective(s): +${gained} Primary VP (now ${score[side]})`);
    }
  }

  return { ...state, units, cp, score, lastBattleShock: reports, log: [...state.log, ...log] };
}

// ── Charges (Phase 2 + multi-target pathing) ───────────────────────────────────
export interface ChargeParams {
  chargerUnitId: string;
  /** One or more declared charge targets. `targetUnitId` is accepted for back-compat. */
  targetUnitIds?: string[];
  targetUnitId?: string;
}

/** Rigid copy of a unit translated by `v` (alive models only). */
function translatedModels(u: UnitInstance, v: Vec2): UnitInstance {
  return { ...u, models: u.models.map((m) => (m.alive ? { ...m, pos: { x: m.pos.x + v.x, y: m.pos.y + v.y } } : m)) };
}

function aliveCentroid(u: UnitInstance): Vec2 {
  const ms = u.models.filter((m) => m.alive);
  if (!ms.length) return { x: 0, y: 0 };
  return { x: ms.reduce((s, m) => s + m.pos.x, 0) / ms.length, y: ms.reduce((s, m) => s + m.pos.y, 0) / ms.length };
}

/**
 * Search for a legal charge move: a rigid translate (≤ roll inches) toward the targets that ends
 * with the charger within Engagement Range of EVERY declared target and NOT within Engagement Range
 * of any non-target enemy. Rigid translation preserves coherency by construction. Returns the
 * translation vector, or null if no distance up to the roll satisfies all constraints.
 */
function findChargeMove(
  charger: UnitInstance,
  cShape: BaseShape,
  targets: { unit: UnitInstance; shape: BaseShape }[],
  nonTargets: { unit: UnitInstance; shape: BaseShape }[],
  roll: number,
  step = 0.1,
): Vec2 | null {
  const from = aliveCentroid(charger);
  // Aim at the mean of the targets' centroids.
  const aim = { x: 0, y: 0 };
  for (const t of targets) { const c = aliveCentroid(t.unit); aim.x += c.x; aim.y += c.y; }
  aim.x /= targets.length; aim.y /= targets.length;
  const dx = aim.x - from.x, dy = aim.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const dir = { x: dx / len, y: dy / len };

  for (let d = 0; d <= roll + 1e-9; d += step) {
    const v = { x: dir.x * d, y: dir.y * d };
    const moved = translatedModels(charger, v);
    const reachesAll = targets.every((t) => closestGap(moved, cShape, t.unit, t.shape) <= ENGAGEMENT_RANGE);
    if (!reachesAll) continue;
    const clearOfNonTargets = nonTargets.every((nt) => closestGap(moved, cShape, nt.unit, nt.shape) > ENGAGEMENT_RANGE);
    if (!clearOfNonTargets) continue; // a longer move might clear it — keep scanning
    return v;
  }
  return null;
}

/**
 * Resolve a charge (2D6) against one or more targets. Succeeds only when a single coherent move of
 * up to the rolled distance reaches Engagement Range of every target without ending within
 * Engagement Range of a non-target enemy. On success, moves the charger and marks it charged.
 */
export function resolveCharge(
  state: GameState,
  params: ChargeParams,
  ctx: EngineContext,
  rng: RNG,
): { state: GameState; success: boolean; summary: string } {
  const charger = state.units.find((u) => u.id === params.chargerUnitId);
  if (!charger) return { state, success: false, summary: 'unit not found' };
  const cDs = ctx.datasheets.get(charger.datasheetId);
  if (!cDs) return { state, success: false, summary: 'datasheet not found' };

  const targetIds = params.targetUnitIds ?? (params.targetUnitId ? [params.targetUnitId] : []);
  const targets = targetIds
    .map((id) => state.units.find((u) => u.id === id))
    .filter((u): u is UnitInstance => !!u && u.models.some((m) => m.alive))
    .map((u) => ({ unit: u, shape: ctx.datasheets.get(u.datasheetId)?.baseShape ?? cDs.baseShape }));
  if (targets.length === 0) return { state, success: false, summary: 'no valid target' };

  // Declaration legality: every target must be within 12".
  for (const t of targets) {
    if (closestGap(charger, cDs.baseShape, t.unit, t.shape) > 12) {
      const summary = `Charge illegal: ${ctx.datasheets.get(t.unit.datasheetId)?.name ?? t.unit.id} is over 12" away`;
      return { state: { ...state, log: [...state.log, summary] }, success: false, summary };
    }
  }

  // Non-target enemies on the board (the charge may not end within Engagement Range of these).
  const targetSet = new Set(targets.map((t) => t.unit.id));
  const nonTargets = state.units
    .filter((u) => u.owner !== charger.owner && !u.inReserves && !targetSet.has(u.id) && u.models.some((m) => m.alive))
    .map((u) => ({ unit: u, shape: ctx.datasheets.get(u.datasheetId)?.baseShape ?? cDs.baseShape }));

  const { distance, rolls } = rollCharge(rng);
  const move = findChargeMove(charger, cDs.baseShape, targets, nonTargets, distance);
  const success = move !== null;
  const names = targets.map((t) => ctx.datasheets.get(t.unit.datasheetId)?.name ?? t.unit.id).join(' + ');
  const reason = success ? 'SUCCESS' : 'failed (cannot reach all targets / would clip a non-target)';
  const summary = `${cDs.name} charges ${names}: 2D6=${rolls.join('+')}=${distance}" → ${reason}`;

  const units = success
    ? state.units.map((u) => (u.id === charger.id
        ? { ...translatedModels(u, move!), status: { ...u.status, charged: true, moved: true } }
        : u))
    : state.units;
  return { state: { ...state, units, log: [...state.log, summary] }, success, summary };
}

/** Unit vector from the charger's closest model to the target's closest model. */
export function closestAxis(a: UnitInstance, b: UnitInstance): Vec2 {
  let best = Infinity;
  let from = a.models[0]?.pos ?? { x: 0, y: 0 };
  let to = b.models[0]?.pos ?? { x: 0, y: 0 };
  for (const am of a.models) {
    if (!am.alive) continue;
    for (const bm of b.models) {
      if (!bm.alive) continue;
      const d = Math.hypot(am.pos.x - bm.pos.x, am.pos.y - bm.pos.y);
      if (d < best) { best = d; from = am.pos; to = bm.pos; }
    }
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

// ── Fight-phase moves: Pile In / Consolidate (3") ──────────────────────────────
export interface FightMoveParams {
  unitId: string;
  mode: 'pile_in' | 'consolidate';
}

/**
 * Pile In (before attacking) and Consolidate (after) — each lets a unit move every model up to 3"
 * toward the closest enemy model. Modelled as a coherency-preserving rigid translate toward the
 * nearest enemy unit, capped at 3" and at base contact (so it never overlaps). A simplification of
 * the per-model rule that keeps the unit legal; faithful enough for engaged combats.
 */
export function resolveFightMove(
  state: GameState,
  params: FightMoveParams,
  ctx: EngineContext,
): { state: GameState; summary: string } {
  const unit = state.units.find((u) => u.id === params.unitId);
  if (!unit) return { state, summary: 'unit not found' };
  const ds = ctx.datasheets.get(unit.datasheetId);
  if (!ds) return { state, summary: 'datasheet not found' };

  // Nearest enemy unit by base-to-base gap.
  let nearest: UnitInstance | undefined;
  let minGap = Infinity;
  for (const e of state.units) {
    if (e.owner === unit.owner || e.inReserves || !e.models.some((m) => m.alive)) continue;
    const eDs = ctx.datasheets.get(e.datasheetId);
    if (!eDs) continue;
    const g = closestGap(unit, ds.baseShape, e, eDs.baseShape);
    if (g < minGap) { minGap = g; nearest = e; }
  }
  if (!nearest) return { state, summary: 'no enemy to move toward' };

  const dir = closestAxis(unit, nearest);
  const moveDist = Math.min(3, Math.max(0, minGap)); // up to 3", stopping at base contact
  if (moveDist <= 1e-6) {
    return { state: { ...state, log: [...state.log, `${ds.name} ${params.mode === 'pile_in' ? 'piles in' : 'consolidates'} (already in base contact)`] }, summary: 'no move' };
  }
  const units = state.units.map((u) =>
    u.id === unit.id
      ? { ...u, models: u.models.map((m) => (m.alive ? { ...m, pos: { x: m.pos.x + dir.x * moveDist, y: m.pos.y + dir.y * moveDist } } : m)) }
      : u,
  );
  const verb = params.mode === 'pile_in' ? 'piles in' : 'consolidates';
  const summary = `${ds.name} ${verb} ${moveDist.toFixed(1)}" toward the enemy`;
  return { state: { ...state, units, log: [...state.log, summary] }, summary };
}
