// Engine glue between the static datasheet data and the live game state. PURE — no I/O imports;
// the datasheet lookup is *injected* via EngineContext (same dependency-injection seam as the RNG).
//
// `resolveAttack` turns a high-level "unit A attacks unit B with weapon W" request into the
// numeric combat call (combat.ts), maps the casualties back onto the target's live models, and
// returns a new GameState plus a dice log. Range / half-range / engagement are read from the
// real model positions via geometry; line-of-sight and cover arrive in Phase 2.

import type { Datasheet, GameState, ModelInstance, UnitInstance, Vec2, BaseShape, WeaponProfile } from './types';
import type { RNG } from './rng';
import { baseRadius, gapBetweenBases } from './geometry';
import { parseKeywords } from './keywords';
import { checkCoherency } from './coherency';
import { resolveAttacks, type AttackProfile, type DefenderProfile, type CombatSituation } from './combat';
import { unitCanSee, unitHasCover } from './los';
import { controlOfObjective, scorePrimary, type OcModel } from './objectives';
import { battleShockTest } from './battleshock';
import { rollCharge } from './movement';
import { gatherAttackModifiers, type AttackContext } from './effects';
import { defensiveProfileForItem } from './wargear';
import { ocBonusFromOrders, ldBonusFromOrders } from './orders';

/** Injected lookup the engine needs to read unit stats. Not imported — passed in (rule #1/#2). */
export interface EngineContext {
  datasheets: Map<string, Datasheet>;
}

export interface AttackParams {
  attackerUnitId: string;
  targetUnitId: string;
  weaponName: string;
  /** Disambiguates same-named weapons on merged units (e.g. two "Close combat weapon" entries). */
  weaponSourceDsId?: string;
  /** Override the number of firing models (defaults to the models that carry the weapon). */
  attackerCount?: number;
}

export interface AttackOutcome {
  state: GameState;
  /** Single-line human summary; empty when the attack was illegal (see `rejected`). */
  summary: string;
  rejected?: string; // reason the attack could not be made (out of range, no LoS later, etc.)
}

const ENGAGEMENT_RANGE = 1; // inches

function attackProfileForWeapon(w: WeaponProfile): AttackProfile {
  return { name: w.name, attacks: w.attacks, skill: w.skill, S: w.S, AP: w.AP, D: w.D, keywords: parseKeywords(w.keywords) };
}

/** All datasheet ids contributing models to a unit (its own + any merged-in Leaders). */
export function unitDatasheetIds(unit: UnitInstance): string[] {
  return [...new Set([unit.datasheetId, ...(unit.attachedLeaders ?? []).map((l) => l.datasheetId)])];
}

/** The datasheet governing a specific model (a merged Leader's model uses its own profile). */
export function modelDatasheet(model: ModelInstance, unit: UnitInstance, ctx: EngineContext): Datasheet | undefined {
  return ctx.datasheets.get(model.datasheetId ?? unit.datasheetId);
}

/** The union of weapons a unit can fire (primary + merged Leaders), each with its source datasheet. */
export function unitWeapons(unit: UnitInstance, ctx: EngineContext): { weapon: WeaponProfile; sourceDsId: string }[] {
  const out: { weapon: WeaponProfile; sourceDsId: string }[] = [];
  const seen = new Set<string>();
  for (const dsId of unitDatasheetIds(unit)) {
    for (const w of ctx.datasheets.get(dsId)?.weapons ?? []) {
      const key = `${dsId}:${w.name}`;
      if (!seen.has(key)) { seen.add(key); out.push({ weapon: w, sourceDsId: dsId }); }
    }
  }
  return out;
}

/** A weapon profile's base item name: multi-profile names ("Infernus heavy bolter – heavy bolter")
 *  collapse to the item the roster counts ("Infernus heavy bolter"). */
function weaponItemName(profileName: string): string {
  return profileName.split(/\s+[–—-]\s+/)[0]!.trim().toLowerCase();
}

/** The wargear counts governing weapons from `sourceDsId` (the unit's own, or a merged Leader's). */
function wargearCountsFor(unit: UnitInstance, sourceDsId: string): Record<string, number> | undefined {
  if (sourceDsId === unit.datasheetId) return unit.wargearCounts;
  return (unit.attachedLeaders ?? []).find((l) => l.datasheetId === sourceDsId)?.wargearCounts;
}

/**
 * How many alive models fire `weapon`. When the unit carries roster wargear counts, only the
 * counted bearers fire (capped by the source datasheet's alive models); without loadout data
 * (sandbox spawns, demo rosters) every alive model of the source datasheet fires — the old
 * behaviour. Returns null when the unit has counts but nobody carries this weapon.
 */
export function weaponCarrierCount(
  unit: UnitInstance,
  weapon: WeaponProfile,
  sourceDsId: string,
): number | null {
  const aliveOfSource = unit.models.filter(
    (m) => m.alive && (m.datasheetId ?? unit.datasheetId) === sourceDsId,
  ).length;
  const counts = wargearCountsFor(unit, sourceDsId);
  if (!counts || Object.keys(counts).length === 0) return aliveOfSource;
  const item = weaponItemName(weapon.name);
  for (const [k, v] of Object.entries(counts)) {
    if (k.trim().toLowerCase() === item) return Math.min(v, aliveOfSource);
  }
  return null; // loadout known and this weapon isn't in it
}

/** Weapons the unit can actually fire right now: source models alive and (when the loadout is
 *  known) at least one bearer. This is what pickers should offer. */
export function availableUnitWeapons(
  unit: UnitInstance,
  ctx: EngineContext,
): { weapon: WeaponProfile; sourceDsId: string; carriers: number }[] {
  return unitWeapons(unit, ctx)
    .map((w) => ({ ...w, carriers: weaponCarrierCount(unit, w.weapon, w.sourceDsId) ?? 0 }))
    .filter((w) => w.carriers > 0);
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

function defenderProfileFor(unit: UnitInstance, ctx: EngineContext, ordered?: ModelInstance[]): DefenderProfile {
  const primary = ctx.datasheets.get(unit.datasheetId)!;
  const pm = primary.models[0]!; // the unit's main profile (used for the wound roll's Toughness)
  return {
    T: pm.T,
    save: pm.Sv,
    invuln: pm.invuln,
    keywords: primary.keywords,
    models: (ordered ?? unit.models.filter((x) => x.alive))
      .map((x) => {
        // Per-model profile: a merged Leader model uses its own datasheet's W / Sv / invuln.
        const base = (modelDatasheet(x, unit, ctx) ?? primary).models[0]!;
        let invuln = base.invuln;
        let save: number | undefined = base.Sv !== pm.Sv ? base.Sv : undefined;
        for (const item of x.wargear ?? []) {
          const def = defensiveProfileForItem(item);
          if (!def) continue;
          if (def.invuln != null) invuln = Math.min(invuln ?? 7, def.invuln);
          if (def.saveBonus != null) save = Math.max(2, (save ?? base.Sv) - def.saveBonus);
        }
        return { maxW: base.W, wounds: x.wounds, ...(invuln != null ? { invuln } : {}), ...(save != null ? { save } : {}) };
      }),
  };
}

/**
 * The order casualties are allocated in (10e: the owner removes models, normally keeping the unit
 * coherent and pulling from the back). Defensive-wargear bearers still soak first (they carry the
 * best save — the existing allocate→save behaviour); within each pool, models furthest from the
 * attacker die first, skipping any model whose removal would split the survivors apart.
 */
function casualtyOrder(target: UnitInstance, ctx: EngineContext, attackerCentroid: Vec2): ModelInstance[] {
  const shape = ctx.datasheets.get(target.datasheetId)?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
  const hasDefensiveGear = (m: ModelInstance) =>
    (m.wargear ?? []).some((item) => defensiveProfileForItem(item));
  const dist = (m: ModelInstance) => Math.hypot(m.pos.x - attackerCentroid.x, m.pos.y - attackerCentroid.y);

  const remaining = target.models.filter((m) => m.alive);
  const order: ModelInstance[] = [];
  while (remaining.length > 0) {
    // Candidates: defensive-gear bearers while any remain, then the rest; furthest first.
    const pool = remaining.some(hasDefensiveGear) ? remaining.filter(hasDefensiveGear) : remaining;
    const sorted = [...pool].sort((a, b) => dist(b) - dist(a));
    const pick =
      sorted.find((m) => {
        const rest = remaining.filter((x) => x !== m);
        return rest.length <= 1 || checkCoherency(rest.map((x) => x.pos), shape).connected;
      }) ?? sorted[0]!;
    order.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return order;
}

/** Centroid of a unit's alive models (used to define "the back" relative to the attacker). */
function aliveUnitCentroid(u: UnitInstance): Vec2 {
  const ms = u.models.filter((m) => m.alive);
  if (!ms.length) return { x: 0, y: 0 };
  return { x: ms.reduce((s, m) => s + m.pos.x, 0) / ms.length, y: ms.reduce((s, m) => s + m.pos.y, 0) / ms.length };
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

  // Find the weapon across the unit's datasheets (primary + merged Leaders) and count only the
  // models that actually carry it as firing it.
  const candidates = unitWeapons(attacker, ctx).filter((w) => w.weapon.name === params.weaponName);
  const found = params.weaponSourceDsId
    ? candidates.find((w) => w.sourceDsId === params.weaponSourceDsId)
    : candidates[0];
  if (!found) return { state, summary: '', rejected: 'weapon not found' };
  const weaponDef = found.weapon;
  const profile = attackProfileForWeapon(weaponDef);
  const isMelee = weaponDef.type === 'melee';

  // Phase legality (real matches only — the sandbox stays a free dice calculator).
  // NOTE: a future Overwatch implementation will need its own carve-out here.
  if (state.mode === 'match' && state.stage === 'battle') {
    const requiredPhase = isMelee ? 'Fight' : 'Shooting';
    if (state.phase !== requiredPhase) {
      return { state, summary: '', rejected: `${isMelee ? 'melee' : 'ranged'} attacks only in the ${requiredPhase} phase (now ${state.phase})` };
    }
  }

  const carriers = weaponCarrierCount(attacker, weaponDef, found.sourceDsId);
  if (carriers == null) return { state, summary: '', rejected: `no models in the unit carry ${weaponDef.name}` };
  const aliveAttackers = carriers;
  const aliveTargets = target.models.filter((m) => m.alive).length;
  if (aliveAttackers === 0 || aliveTargets === 0) return { state, summary: '', rejected: 'no models' };

  const gap = closestGap(attacker, aDs.baseShape, target, tDs.baseShape);
  const kw = profile.keywords;

  // Legality + situational flags from real positions.
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
  // Big Guns Never Tire: ranged attacks made while within Engagement Range of an enemy take -1 to
  // hit (Pistols are exempt). Only Monsters/Vehicles/Pistols may shoot while engaged at all —
  // that eligibility is enforced by phases.ts / resolveUnitShooting.
  if (!isMelee && !kw.pistol && enemiesInEngagement(state, attacker, ctx).length > 0) {
    hitPenalty -= 1;
  }
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
    extraAttacks: mods.extraAttacks,
  };

  // Allocate damage in casualty order (owner removes from the back, keeping the unit coherent;
  // defensive-wargear bearers still soak first) instead of stripping the formation's front rows.
  const allocation = casualtyOrder(target, ctx, aliveUnitCentroid(attacker));
  const defender = defenderProfileFor(target, ctx, allocation);
  if (mods.fnp != null) defender.fnp = mods.fnp;
  if (mods.invulnFloor != null) defender.invuln = Math.min(defender.invuln ?? 7, mods.invulnFloor);
  if (mods.saveBonus) {
    // Take Cover! (+1 Save), capped so it can't improve a save beyond 3+.
    const improve = (s: number) => Math.max(3, s - mods.saveBonus);
    defender.save = improve(defender.save);
    for (const m of defender.models) if (m.save != null) m.save = improve(m.save);
  }
  const result = resolveAttacks(profile, defender, situation, rng);

  // Map the updated wound state back onto the target's models (result order == allocation order).
  const updatedById = new Map<string, { wounds: number }>();
  result.defenderModels.forEach((dm, k) => {
    const m = allocation[k];
    if (m) updatedById.set(m.id, dm);
  });
  const newTargetModels = target.models.map((m) => {
    const updated = updatedById.get(m.id);
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

// ── Unit-level shooting: every model fires its equipped weapons ─────────────────
/** Enemy units within Engagement Range (1") of `unit`. */
function enemiesInEngagement(state: GameState, unit: UnitInstance, ctx: EngineContext): UnitInstance[] {
  const ds = ctx.datasheets.get(unit.datasheetId);
  if (!ds) return [];
  return state.units.filter((e) => {
    if (e.owner === unit.owner || e.inReserves || !e.models.some((m) => m.alive)) return false;
    const eDs = ctx.datasheets.get(e.datasheetId);
    if (!eDs) return false;
    return closestGap(unit, ds.baseShape, e, eDs.baseShape) <= ENGAGEMENT_RANGE;
  });
}

export interface FirePlan {
  /** The weapon profiles that will actually fire, with how many models carry each. */
  fire: { weapon: WeaponProfile; sourceDsId: string; carriers: number }[];
  /** Human-readable rule notes (Pistols held, profile collapses, engagement restriction). */
  notes: string[];
}

/**
 * Which of a unit's ranged weapons fire when the whole unit shoots (10e: each model shoots all
 * the ranged weapons it is equipped with). Applies:
 *  • one profile per multi-profile weapon ("– standard" / "– supercharge" are one gun);
 *  • the Pistol rule — a model fires either its Pistol or its other weapons, so when the unit
 *    carries both, the Pistols are held (unit-level simplification, noted in the plan);
 *  • engagement — while within Engagement Range only Pistols fire, unless the unit is a
 *    Monster/Vehicle (Big Guns Never Tire — those fire everything at -1 to hit).
 */
export function planUnitShooting(state: GameState, attacker: UnitInstance, ctx: EngineContext): FirePlan {
  const notes: string[] = [];
  let ranged = availableUnitWeapons(attacker, ctx).filter((w) => w.weapon.type === 'ranged');

  // Multi-profile weapons are ONE weapon: keep the first profile per item, note the rest.
  const seenItems = new Set<string>();
  ranged = ranged.filter((w) => {
    const key = `${w.sourceDsId}|${weaponItemName(w.weapon.name)}`;
    if (seenItems.has(key)) {
      notes.push(`${w.weapon.name}: alternate profile not fired (one profile per weapon)`);
      return false;
    }
    seenItems.add(key);
    return true;
  });

  const aDs = ctx.datasheets.get(attacker.datasheetId);
  const isPistol = (w: { weapon: WeaponProfile }) => !!parseKeywords(w.weapon.keywords).pistol;
  const engaged = enemiesInEngagement(state, attacker, ctx).length > 0;
  const bigGuns = !!aDs?.keywords.some((k) => /^(monster|vehicle)$/i.test(k));

  if (engaged && !bigGuns) {
    const pistols = ranged.filter(isPistol);
    if (pistols.length) notes.push('Within Engagement Range — only Pistols can be fired');
    return { fire: pistols, notes };
  }
  const pistols = ranged.filter(isPistol);
  const others = ranged.filter((w) => !isPistol(w));
  if (others.length && pistols.length) {
    notes.push('Pistols held — a model fires either its Pistol or all its other weapons');
    return { fire: others, notes };
  }
  return { fire: ranged, notes };
}

export interface UnitShootParams {
  attackerUnitId: string;
  targetUnitId: string;
}

/**
 * Resolve a whole unit's shooting at one target: every weapon in the fire plan is resolved
 * SEQUENTIALLY (attacks from one weapon are allocated and casualties removed before the next
 * weapon fires, per the 10e attack sequence). Marks the unit as having shot.
 */
export function resolveUnitShooting(
  state: GameState,
  params: UnitShootParams,
  ctx: EngineContext,
  rng: RNG,
): AttackOutcome {
  const attacker = state.units.find((u) => u.id === params.attackerUnitId);
  const target = state.units.find((u) => u.id === params.targetUnitId);
  if (!attacker || !target) return { state, summary: '', rejected: 'unit not found' };
  const aDs = ctx.datasheets.get(attacker.datasheetId);
  const tDs = ctx.datasheets.get(target.datasheetId);
  if (!aDs || !tDs) return { state, summary: '', rejected: 'datasheet not found' };

  if (state.mode === 'match' && state.stage === 'battle' && state.phase !== 'Shooting') {
    return { state, summary: '', rejected: `shooting only in the Shooting phase (now ${state.phase})` };
  }
  if (state.mode === 'match' && attacker.status.hasShot) {
    return { state, summary: '', rejected: 'this unit has already shot this turn' };
  }

  // While engaged, ranged attacks (Pistols / Big Guns Never Tire) may only target a unit the
  // shooter is within Engagement Range of.
  const engagedUnits = enemiesInEngagement(state, attacker, ctx);
  if (engagedUnits.length > 0 && !engagedUnits.some((e) => e.id === target.id)) {
    return { state, summary: '', rejected: 'while within Engagement Range, ranged attacks can only target an enemy unit within Engagement Range' };
  }

  const { fire, notes } = planUnitShooting(state, attacker, ctx);
  if (fire.length === 0) return { state, summary: '', rejected: 'no ranged weapons can fire' };

  const aliveBefore = target.models.filter((m) => m.alive).length;
  let cur: GameState = {
    ...state,
    log: [
      ...state.log,
      `— ${aDs.name} shoots at ${tDs.name}: ${fire.length} weapon(s), resolved sequentially —`,
      ...notes.map((n) => `  ${n}`),
    ],
  };
  let firedCount = 0;
  const skipped: string[] = [];
  for (const w of fire) {
    const tNow = cur.units.find((u) => u.id === target.id);
    if (!tNow || !tNow.models.some((m) => m.alive)) {
      cur = { ...cur, log: [...cur.log, '  target destroyed — remaining weapons not fired'] };
      break;
    }
    const out = resolveAttack(
      cur,
      { attackerUnitId: attacker.id, targetUnitId: target.id, weaponName: w.weapon.name, weaponSourceDsId: w.sourceDsId },
      ctx,
      rng,
    );
    if (out.rejected) {
      skipped.push(`  ${w.weapon.name} not fired: ${out.rejected}`);
      continue;
    }
    firedCount++;
    cur = out.state;
  }
  if (skipped.length) cur = { ...cur, log: [...cur.log, ...skipped] };
  if (firedCount === 0) {
    return { state, summary: '', rejected: `no weapon could fire (${skipped[0]?.trim() ?? 'nothing in range / line of sight'})` };
  }

  const units = cur.units.map((u) => (u.id === attacker.id ? { ...u, status: { ...u.status, hasShot: true } } : u));
  const aliveAfter = units.find((u) => u.id === target.id)?.models.filter((m) => m.alive).length ?? 0;
  const summary = `${aDs.name} shooting at ${tDs.name}: ${firedCount} weapon(s) fired, ${aliveBefore - aliveAfter} model(s) slain`;
  return { state: { ...cur, units, log: [...cur.log, summary] }, summary };
}

// ── Objective control & scoring (Phase 2) ──────────────────────────────────────
const aliveCount = (u: UnitInstance): number => u.models.filter((m) => m.alive).length;

/** Build the OC model list for every alive model. Battle-shocked units contribute OC 0. */
function ocModels(state: GameState, ctx: EngineContext): OcModel[] {
  const out: OcModel[] = [];
  for (const u of state.units) {
    const ds = ctx.datasheets.get(u.datasheetId);
    if (!ds) continue;
    const ocBonus = ocBonusFromOrders(u);
    for (const m of u.models) {
      if (!m.alive) continue;
      const mds = modelDatasheet(m, u, ctx) ?? ds; // per-model (a merged Leader has its own OC)
      // Battle-shocked units have OC 0; otherwise add any Order/detachment OC bonus.
      const oc = u.status.battleShocked ? 0 : mds.models[0]!.OC + ocBonus;
      out.push({ pos: m.pos, oc, radius: baseRadius(mds.baseShape), owner: u.owner });
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
    const ld = ds.models[0]!.Ld - ldBonusFromOrders(u); // +Ld = a lower target number (easier test)
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
 * Search for a legal charge move: a rigid translate (≤ roll inches) that ends with the charger
 * within Engagement Range of EVERY declared target and NOT within Engagement Range of any
 * non-target enemy. Rigid translation preserves coherency by construction. The search fans out
 * over several directions around the aim line (so a screening non-target can be sidestepped).
 * Returns the translation vector, or null if no direction/distance up to the roll satisfies all.
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
  // Candidate aim points: the mean of the targets' centroids, plus each target's own centroid.
  const mean = { x: 0, y: 0 };
  for (const t of targets) { const c = aliveCentroid(t.unit); mean.x += c.x; mean.y += c.y; }
  mean.x /= targets.length; mean.y /= targets.length;
  const aims = [mean, ...targets.map((t) => aliveCentroid(t.unit))];

  const tried = new Set<string>();
  for (const aim of aims) {
    const dx = aim.x - from.x, dy = aim.y - from.y;
    const base = Math.atan2(dy, dx);
    // Fan out around the aim line — a straight line into a screen often clips a non-target.
    for (const off of [0, 10, -10, 20, -20, 30, -30, 45, -45]) {
      const ang = base + (off * Math.PI) / 180;
      const key = ang.toFixed(3);
      if (tried.has(key)) continue;
      tried.add(key);
      const dir = { x: Math.cos(ang), y: Math.sin(ang) };
      for (let d = 0; d <= roll + 1e-9; d += step) {
        const v = { x: dir.x * d, y: dir.y * d };
        const moved = translatedModels(charger, v);
        const reachesAll = targets.every((t) => closestGap(moved, cShape, t.unit, t.shape) <= ENGAGEMENT_RANGE);
        if (!reachesAll) continue;
        const clearOfNonTargets = nonTargets.every((nt) => closestGap(moved, cShape, nt.unit, nt.shape) > ENGAGEMENT_RANGE);
        if (!clearOfNonTargets) continue; // a longer move might clear it — keep scanning
        return v;
      }
    }
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

  // Phase legality (real matches only).
  if (state.mode === 'match' && state.stage === 'battle' && state.phase !== 'Charge') {
    const summary = `Charge rejected: only in the Charge phase (now ${state.phase})`;
    return { state: { ...state, log: [...state.log, summary] }, success: false, summary };
  }
  // 10e: a unit is selected to declare a charge once per phase — no re-rolling a failed charge.
  if (state.mode === 'match' && charger.status.chargeAttempted) {
    const summary = 'Charge rejected: this unit already declared a charge this phase';
    return { state: { ...state, log: [...state.log, summary] }, success: false, summary };
  }

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
  // Tell a short roll apart from a blocked path: the minimum distance that could possibly work
  // is the furthest target's gap minus Engagement Range.
  const needed = Math.max(...targets.map((t) => closestGap(charger, cDs.baseShape, t.unit, t.shape))) - ENGAGEMENT_RANGE;
  const reason = success
    ? 'SUCCESS'
    : distance < needed - 1e-6
      ? `failed — needed ${Math.max(0, needed).toFixed(1)}", rolled ${distance}"`
      : 'failed — no clear path (cannot reach every target without ending within 1" of another enemy)';
  const summary = `${cDs.name} charges ${names}: 2D6=${rolls.join('+')}=${distance}" → ${reason}`;

  // The declaration is spent whether or not the roll/path succeeded (match mode; the sandbox
  // stays a free dice calculator).
  const attempted = state.mode === 'match' ? { chargeAttempted: true } : {};
  const units = state.units.map((u) => {
    if (u.id !== charger.id) return u;
    if (success) return { ...translatedModels(u, move!), status: { ...u.status, ...attempted, charged: true, moved: true } };
    return { ...u, status: { ...u.status, ...attempted } };
  });
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

  // Phase legality (real matches only).
  if (state.mode === 'match' && state.stage === 'battle' && state.phase !== 'Fight') {
    const summary = `Pile In/Consolidate rejected: only in the Fight phase (now ${state.phase})`;
    return { state: { ...state, log: [...state.log, summary] }, summary };
  }

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
