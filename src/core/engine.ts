// Engine glue between the static datasheet data and the live game state. PURE — no I/O imports;
// the datasheet lookup is *injected* via EngineContext (same dependency-injection seam as the RNG).
//
// `resolveAttack` turns a high-level "unit A attacks unit B with weapon W" request into the
// numeric combat call (combat.ts), maps the casualties back onto the target's live models, and
// returns a new GameState plus a dice log. Range / half-range / engagement are read from the
// real model positions via geometry; line-of-sight and cover arrive in Phase 2.

import type { Datasheet, GameState, UnitInstance, Vec2, BaseShape } from './types';
import type { RNG } from './rng';
import { gapBetweenBases } from './geometry';
import { parseKeywords } from './keywords';
import { resolveAttacks, type AttackProfile, type DefenderProfile, type CombatSituation } from './combat';

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

function defenderProfileFor(ds: Datasheet, unit: UnitInstance): DefenderProfile {
  const m = ds.models[0]!; // primary profile; multi-profile allocation arrives later
  return {
    T: m.T,
    save: m.Sv,
    invuln: m.invuln,
    keywords: ds.keywords,
    models: unit.models.filter((x) => x.alive).map((x) => ({ maxW: m.W, wounds: x.wounds })),
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

  // Legality + situational flags from real positions.
  const isMelee = weaponDef.type === 'melee';
  if (isMelee) {
    if (gap > ENGAGEMENT_RANGE) return { state, summary: '', rejected: 'not in engagement range' };
  } else {
    const range = weaponDef.range ?? 0;
    if (gap > range) return { state, summary: '', rejected: `out of range (${gap.toFixed(1)}" > ${range}")` };
  }

  const halfRange = (weaponDef.range ?? 0) / 2;
  const situation: CombatSituation = {
    attackerCount: params.attackerCount ?? aliveAttackers,
    rapidFireActive: !isMelee && gap <= halfRange,
    meltaActive: !isMelee && gap <= halfRange,
    longRange: !isMelee && gap >= 12,
    charged: attacker.status.charged,
    stationary: attacker.status.remainedStationary,
    targetModelCount: aliveTargets,
  };

  const defender = defenderProfileFor(tDs, target);
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
