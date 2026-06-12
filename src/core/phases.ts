// Per-phase legality & targeting queries (10e Core Rules). PURE — no React, no DOM.
//
// This is the "what can I legally do right now" layer that BOTH the UI and the future AI call.
// Everything here is a read-only query over GameState + the injected datasheet context; nothing
// mutates state (that is the reducer's job). Keeping these as pure predicates means the AI opponent
// can enumerate its legal options by calling functions, exactly as the plan intends.

import type { Datasheet, GameState, Side, UnitInstance, Vec2 } from './types';
import type { EngineContext } from './engine';
import { closestGap, planUnitShooting, unitWeapons } from './engine';
import { parseKeywords } from './keywords';
import { unitCanSee } from './los';
import { canActAfterAdvance, hasFightsFirstAbility, hasLoneOperative, ignoresLoneOperative, unitScoutDistance } from './abilities';
import { checkCoherency, type CoherencyResult } from './coherency';

const FALLBACK_SHAPE = { kind: 'circle' as const, radius: 0.63 };

export const ENGAGEMENT_RANGE = 1; // inches
export const CHARGE_THREAT = 12; // inches — a unit may declare a charge within 12"

export interface Eligibility {
  eligible: boolean;
  reason?: string;
}

// ── basic helpers ────────────────────────────────────────────────────────────
export const aliveModels = (u: UnitInstance) => u.models.filter((m) => m.alive);
export const isOnBoard = (u: UnitInstance) => !u.inReserves && aliveModels(u).length > 0;
export const dsOf = (u: UnitInstance, ctx: EngineContext): Datasheet | undefined =>
  ctx.datasheets.get(u.datasheetId);
const alivePts = (u: UnitInstance): Vec2[] => aliveModels(u).map((m) => m.pos);

function hasKeyword(ds: Datasheet | undefined, kw: string): boolean {
  return !!ds?.keywords.some((k) => k.toLowerCase() === kw.toLowerCase());
}

/** Closest base-to-base gap between two units (Infinity if either has no alive models). */
export function gapBetween(a: UnitInstance, b: UnitInstance, ctx: EngineContext): number {
  const aDs = dsOf(a, ctx);
  const bDs = dsOf(b, ctx);
  if (!aDs || !bDs) return Infinity;
  return closestGap(a, aDs.baseShape, b, bDs.baseShape);
}

export const inEngagementRange = (a: UnitInstance, b: UnitInstance, ctx: EngineContext): boolean =>
  gapBetween(a, b, ctx) <= ENGAGEMENT_RANGE;

export const enemiesOf = (u: UnitInstance, state: GameState): UnitInstance[] =>
  state.units.filter((x) => x.owner !== u.owner && isOnBoard(x));

/** Enemy units this unit is currently within Engagement Range of. */
export function engagedEnemies(u: UnitInstance, state: GameState, ctx: EngineContext): UnitInstance[] {
  return enemiesOf(u, state).filter((e) => inEngagementRange(u, e, ctx));
}

// ── Leader targeting protection ──────────────────────────────────────────────
/**
 * A Leader unit attached to a Bodyguard that still has its own (non-leader) models cannot be
 * selected as a target (its attacks are "absorbed" by the Bodyguard). Precision is the exception,
 * handled at attack time. Returns true when `u` is currently shielded by its Bodyguard.
 */
export function isLeaderProtected(u: UnitInstance, state: GameState): boolean {
  if (!u.attachedTo) return false;
  const bodyguard = state.units.find((x) => x.id === u.attachedTo);
  if (!bodyguard) return false;
  return bodyguard.models.some((m) => m.alive);
}

// ── Shooting ─────────────────────────────────────────────────────────────────
export function hasAssaultWeapon(ds: Datasheet | undefined): boolean {
  return !!ds?.weapons.some((w) => w.type === 'ranged' && parseKeywords(w.keywords).assault);
}
export function hasPistol(ds: Datasheet | undefined): boolean {
  return !!ds?.weapons.some((w) => w.type === 'ranged' && parseKeywords(w.keywords).pistol);
}
export const isMonsterOrVehicle = (ds: Datasheet | undefined): boolean =>
  hasKeyword(ds, 'Monster') || hasKeyword(ds, 'Vehicle');

/** Is `u` eligible to be selected to shoot this phase? (10e shooting eligibility.) */
export function eligibleToShoot(u: UnitInstance, state: GameState, ctx: EngineContext): Eligibility {
  if (!isOnBoard(u)) return { eligible: false, reason: 'not on the battlefield' };
  if (u.status.hasShot) return { eligible: false, reason: 'already shot this turn' };
  const ds = dsOf(u, ctx);
  // Frenzon-style abilities ("eligible to shoot … in a turn in which it Advanced") lift the
  // Advance restriction entirely; Assault weapons lift it for themselves.
  if (u.status.advanced && !hasAssaultWeapon(ds) && !canActAfterAdvance(ds).shoot) {
    return { eligible: false, reason: 'Advanced this turn (no Assault weapons)' };
  }
  if (u.status.fellBack) return { eligible: false, reason: 'Fell Back this turn' };
  // A unit within Engagement Range can only shoot via Big Guns Never Tire (Monster/Vehicle) or Pistols.
  if (engagedEnemies(u, state, ctx).length > 0 && !isMonsterOrVehicle(ds) && !hasPistol(ds)) {
    return { eligible: false, reason: 'within Engagement Range (no Pistols / not a Monster or Vehicle)' };
  }
  return { eligible: true };
}

/**
 * Units this attacker may legally choose as a target with `weaponName`: an enemy unit with at least
 * one model within range AND visible (LoS) to at least one of the weapon's BEARERS — the engine
 * only lets models that themselves see the target fire (10e), so a merged Leader's gun needs the
 * Leader's own sightline. Indirect Fire weapons may target unseen units. Leader-protected units
 * are excluded.
 */
export function validShootingTargets(
  attacker: UnitInstance,
  weaponName: string,
  state: GameState,
  ctx: EngineContext,
  weaponSourceDsId?: string,
): UnitInstance[] {
  const aDs = dsOf(attacker, ctx);
  const candidates = unitWeapons(attacker, ctx).filter((w) => w.weapon.name === weaponName);
  const found = weaponSourceDsId ? candidates.find((w) => w.sourceDsId === weaponSourceDsId) : candidates[0];
  const weapon = found?.weapon;
  if (!aDs || !found || !weapon || weapon.type !== 'ranged') return [];
  const srcDsId = found.sourceDsId;
  const aPts = aliveModels(attacker)
    .filter((m) => (m.datasheetId ?? attacker.datasheetId) === srcDsId)
    .map((m) => m.pos);
  if (aPts.length === 0) return [];
  const range = weapon.range ?? 0;
  const kw = parseKeywords(weapon.keywords);
  const out: UnitInstance[] = [];
  for (const e of enemiesOf(attacker, state)) {
    if (isLeaderProtected(e, state)) continue;
    const eDs = dsOf(e, ctx);
    if (!eDs) continue;
    const gap = gapBetween(attacker, e, ctx);
    if (gap > range) continue;
    // Lone Operative: unless attached, only targetable by ranged attacks within 12"
    // (ignored by a Deadshot attacker, e.g. the Vindicare).
    if (
      hasLoneOperative(eDs) &&
      (e.attachedLeaders ?? []).length === 0 &&
      gap > 12 &&
      !ignoresLoneOperative(aDs)
    ) {
      continue;
    }
    const visible = kw.indirectFire || unitCanSee(aPts, alivePts(e), state.layout.terrain);
    if (visible) out.push(e);
  }
  return out;
}

/**
 * Targets the whole unit may shoot at (unit-level shooting: every model fires its weapons).
 * A unit is a valid target when at least one weapon in the unit's fire plan can reach it
 * (range + visibility). While the shooter is engaged, only units it is engaged with qualify.
 */
export function validUnitShootingTargets(
  attacker: UnitInstance,
  state: GameState,
  ctx: EngineContext,
): UnitInstance[] {
  const { fire } = planUnitShooting(state, attacker, ctx);
  const engaged = engagedEnemies(attacker, state, ctx);
  const ids = new Set<string>();
  const out: UnitInstance[] = [];
  for (const w of fire) {
    for (const t of validShootingTargets(attacker, w.weapon.name, state, ctx, w.sourceDsId)) {
      if (ids.has(t.id)) continue;
      if (engaged.length > 0 && !engaged.some((e) => e.id === t.id)) continue;
      ids.add(t.id);
      out.push(t);
    }
  }
  return out;
}

// ── Charge ───────────────────────────────────────────────────────────────────
/** Enemy units within 12" that `u` could declare as charge targets. */
export function chargeTargets(u: UnitInstance, state: GameState, ctx: EngineContext): UnitInstance[] {
  return enemiesOf(u, state).filter((e) => gapBetween(u, e, ctx) <= CHARGE_THREAT);
}

export function eligibleToCharge(u: UnitInstance, state: GameState, ctx: EngineContext): Eligibility {
  if (!isOnBoard(u)) return { eligible: false, reason: 'not on the battlefield' };
  // Frenzon-style abilities allow declaring a charge in a turn the unit Advanced.
  if (u.status.advanced && !canActAfterAdvance(dsOf(u, ctx)).charge) {
    return { eligible: false, reason: 'Advanced this turn' };
  }
  if (u.status.fellBack) return { eligible: false, reason: 'Fell Back this turn' };
  if (u.status.charged) return { eligible: false, reason: 'already charged this turn' };
  if (u.status.chargeAttempted) return { eligible: false, reason: 'already declared a charge this phase' };
  const ds = dsOf(u, ctx);
  if (hasKeyword(ds, 'Aircraft')) return { eligible: false, reason: 'Aircraft cannot charge' };
  if (engagedEnemies(u, state, ctx).length > 0) {
    return { eligible: false, reason: 'already within Engagement Range' };
  }
  if (chargeTargets(u, state, ctx).length === 0) {
    return { eligible: false, reason: 'no enemy unit within 12"' };
  }
  return { eligible: true };
}

// ── Fight ────────────────────────────────────────────────────────────────────
export function eligibleToFight(u: UnitInstance, state: GameState, ctx: EngineContext): Eligibility {
  if (!isOnBoard(u)) return { eligible: false, reason: 'not on the battlefield' };
  if (u.status.hasFought) return { eligible: false, reason: 'already fought this turn' };
  if (engagedEnemies(u, state, ctx).length === 0) {
    return { eligible: false, reason: 'not within Engagement Range of an enemy' };
  }
  return { eligible: true };
}

/** Does this unit have Fights First this turn? (It charged, or has an innate Fights First.) */
export function hasFightsFirst(u: UnitInstance, ctx: EngineContext): boolean {
  if (u.status.charged) return true;
  // The ability list carries resolved names; abilityIds are numeric Wahapedia ids, so the old
  // id-based check could never match (the Callidus' innate Fights First was silently lost).
  return hasFightsFirstAbility(dsOf(u, ctx));
}

/**
 * The Fight-phase activation order: all Fights-First units first, then the rest. Within each tier,
 * the NON-active player selects first, then players alternate. Returns the eligible units in the
 * order they should be activated — the AI/UI walks this list.
 */
export function fightActivationOrder(state: GameState, ctx: EngineContext): UnitInstance[] {
  const eligible = state.units.filter((u) => eligibleToFight(u, state, ctx).eligible);
  const nonActive: Side = state.activePlayer === 'player' ? 'ai' : 'player';

  const interleave = (units: UnitInstance[]): UnitInstance[] => {
    const a = units.filter((u) => u.owner === nonActive);
    const b = units.filter((u) => u.owner === state.activePlayer);
    const out: UnitInstance[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) out.push(a[i]!);
      if (b[i]) out.push(b[i]!);
    }
    return out;
  };

  const fightsFirst = eligible.filter((u) => hasFightsFirst(u, ctx));
  const rest = eligible.filter((u) => !hasFightsFirst(u, ctx));
  return [...interleave(fightsFirst), ...interleave(rest)];
}

// ── Coherency (for the Movement-phase confirm gate + warning markers) ─────────
/** Coherency status of a unit's current alive-model positions. */
export function unitCoherency(u: UnitInstance, ctx: EngineContext): CoherencyResult {
  const shape = dsOf(u, ctx)?.baseShape ?? FALLBACK_SHAPE;
  return checkCoherency(aliveModels(u).map((m) => m.pos), shape);
}

/** Centroid of a unit's alive models (for hovering a warning marker). */
export function unitCentroid(u: UnitInstance): Vec2 {
  const ms = aliveModels(u);
  if (ms.length === 0) return { x: 0, y: 0 };
  return {
    x: ms.reduce((s, m) => s + m.pos.x, 0) / ms.length,
    y: ms.reduce((s, m) => s + m.pos.y, 0) / ms.length,
  };
}

// ── Orders (Voice of Command, 6") ─────────────────────────────────────────────
const VOICE_OF_COMMAND_RANGE = 6; // inches

/**
 * Friendly REGIMENT units an Officer can issue an Order to: same owner, within 6", on the board,
 * not Battle-shocked, not the officer itself. (The order set itself lives in core/orders.ts.)
 */
export function orderableUnits(officer: UnitInstance, state: GameState, ctx: EngineContext): UnitInstance[] {
  return state.units.filter((u) => {
    if (u.owner !== officer.owner || u.id === officer.id || !isOnBoard(u)) return false;
    if (u.status.battleShocked) return false;
    const ds = dsOf(u, ctx);
    if (!ds?.keywords.some((k) => k.toLowerCase() === 'regiment')) return false;
    return gapBetween(officer, u, ctx) <= VOICE_OF_COMMAND_RANGE;
  });
}

// ── Reserves ─────────────────────────────────────────────────────────────────
/** Units held in Reserves that are allowed to arrive this Movement phase (battle round 2+). */
export function reservesArrivable(state: GameState): UnitInstance[] {
  if (state.round < 2) return [];
  return state.units.filter((u) => u.inReserves && u.owner === state.activePlayer);
}

// ── Scout moves (pre-battle) ─────────────────────────────────────────────────
/** Units of `side` (or both sides) that still have a Scouts X" move to make or decline. */
export function pendingScoutUnits(state: GameState, ctx: EngineContext, side?: Side): UnitInstance[] {
  return state.units.filter(
    (u) =>
      (!side || u.owner === side) &&
      isOnBoard(u) &&
      !u.status.scouted &&
      unitScoutDistance(u, ctx) != null,
  );
}

/** Whose Scout move is next: the first-turn player resolves all of theirs first (10e Scouts). */
export function scoutTurn(state: GameState, ctx: EngineContext): Side | null {
  const first = state.setup?.firstTurn ?? state.firstPlayer;
  if (pendingScoutUnits(state, ctx, first).length > 0) return first;
  const other: Side = first === 'player' ? 'ai' : 'player';
  if (pendingScoutUnits(state, ctx, other).length > 0) return other;
  return null;
}
