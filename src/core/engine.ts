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
import { parseDice } from './dice';
import { checkCoherency } from './coherency';
import { anyOverlap, clampDeltaAvoidingOverlap, occupiedBases, unitBases, type OccupiedBase } from './collision';
import { resolveAttacks, woundThreshold, effectiveSave, hazardRoll, type AttackProfile, type DefenderProfile, type CombatSituation } from './combat';
import { isHidden, pointLosBlocked, unitCanSeeIn, unitCoverIn, DEFAULT_DETECTION_RANGE } from './visibility';
import { controlOfObjective, scorePrimary, type OcModel } from './objectives';
import { battleShockTest } from './battleshock';
import { rollCharge } from './movement';
import { gatherAttackModifiers, type AttackContext } from './effects';
import { hasLoneOperative, ignoresLoneOperative, innateEffectIds } from './abilities';
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
  /** Snap shooting (15.09, Fire Overwatch): only unmodified 6s hit, no re-rolls. */
  snapShooting?: boolean;
}

export interface AttackOutcome {
  state: GameState;
  /** Single-line human summary; empty when the attack was illegal (see `rejected`). */
  summary: string;
  rejected?: string; // reason the attack could not be made (out of range, no LoS later, etc.)
}

const ENGAGEMENT_RANGE = 2; // inches (11e, 03.04)

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

/** All effect ids active on a unit right now: issued Orders/Stratagems, curated innate effects,
 *  plus the ability-derived ones (innate Stealth, innate Feel No Pain X+) read off the unit's
 *  primary datasheet. (A merged Leader's personal Stealth/FNP does not cover the whole unit —
 *  10e grants unit-wide versions only when every model has the ability.) */
function effectsOf(unit: UnitInstance, ctx?: EngineContext): string[] {
  return [
    ...(unit.status.activeEffects ?? []),
    ...(INNATE_ABILITY_EFFECTS[unit.datasheetId] ?? []),
    ...(ctx ? innateEffectIds(ctx.datasheets.get(unit.datasheetId)) : []),
  ];
}

function defenderProfileFor(unit: UnitInstance, ctx: EngineContext, ordered?: ModelInstance[]): DefenderProfile {
  const primary = ctx.datasheets.get(unit.datasheetId)!;
  const pm = primary.models[0]!; // the unit's main profile
  // 19.02 (11e): attacks against an attached unit use the highest BODYGUARD Toughness while any
  // bodyguard models remain; only the leaders' T when they alone survive.
  const bodyguardAlive = unit.models.some(
    (m) => m.alive && (m.datasheetId ?? unit.datasheetId) === unit.datasheetId,
  );
  let T = pm.T;
  if (!bodyguardAlive) {
    for (const m of unit.models) {
      if (!m.alive) continue;
      const mds = modelDatasheet(m, unit, ctx);
      if (mds?.models[0]) T = Math.max(T, mds.models[0].T);
    }
  }
  return {
    T,
    save: pm.Sv,
    invuln: pm.invuln,
    keywords: primary.keywords,
    models: (ordered ?? unit.models.filter((x) => x.alive))
      .map((x) => {
        // Per-model profile: a merged Leader model uses its own datasheet's W / Sv / invuln.
        const mds = modelDatasheet(x, unit, ctx) ?? primary;
        const base = mds.models[0]!;
        // Merged CHARACTER models form their own allocation groups, damaged last (05.03).
        const character =
          (x.datasheetId != null && x.datasheetId !== unit.datasheetId &&
            mds.keywords.some((k) => k.toLowerCase() === 'character')) || undefined;
        let invuln = base.invuln;
        let save: number | undefined = base.Sv !== pm.Sv ? base.Sv : undefined;
        for (const item of x.wargear ?? []) {
          const def = defensiveProfileForItem(item);
          if (!def) continue;
          if (def.invuln != null) invuln = Math.min(invuln ?? 7, def.invuln);
          if (def.saveBonus != null) save = Math.max(2, (save ?? base.Sv) - def.saveBonus);
        }
        return {
          maxW: base.W,
          wounds: x.wounds,
          ...(invuln != null ? { invuln } : {}),
          ...(save != null ? { save } : {}),
          ...(character ? { character } : {}),
        };
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
  let aliveAttackers = carriers;
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
    // Lone Operative: unless part of an Attached unit, only targetable by ranged attacks within
    // 12" (the Vindicare's Deadshot ignores this when it shoots).
    if (
      hasLoneOperative(tDs) &&
      (target.attachedLeaders ?? []).length === 0 &&
      gap > 12 &&
      !ignoresLoneOperative(aDs)
    ) {
      return { state, summary: '', rejected: `${tDs.name} is a Lone Operative (only targetable within 12")` };
    }
  }

  // Line of sight + cover from terrain. Indirect Fire may target unseen units (10.07).
  const aPts = attacker.models.filter((m) => m.alive).map((m) => m.pos);
  const tPts = target.models.filter((m) => m.alive).map((m) => m.pos);
  let hitPenalty = 0;
  let forceCover = false;
  let indirect = false;
  let indirectSpotted = false;
  // Close-quarters shooting (10.06): a MONSTER/VEHICLE shooting while engaged takes -1 to hit,
  // except with [CLOSE-QUARTERS] weapons targeting a unit it is engaged with. Other engaged
  // shooters may only fire [CLOSE-QUARTERS] weapons — enforced by phases.ts/resolveUnitShooting.
  const attackerEngagedWith = !isMelee ? enemiesInEngagement(state, attacker, ctx) : [];
  if (!isMelee && attackerEngagedWith.length > 0) {
    const cqAtEngaged = kw.pistol && attackerEngagedWith.some((e) => e.id === target.id);
    if (!cqAtEngaged) hitPenalty -= 1;
  }
  // Shooting at an engaged target (17.03): only MONSTER/VEHICLE units can be targeted while
  // engaged (by units not themselves engaged with them), at -1 to hit; [BLAST] never can.
  if (!isMelee && attackerEngagedWith.every((e) => e.id !== target.id)) {
    const targetEngaged = enemiesInEngagement(state, target, ctx).length > 0;
    if (targetEngaged) {
      const tMV = tDs.keywords.some((k) => /^(monster|vehicle)$/i.test(k));
      if (!tMV) return { state, summary: '', rejected: 'target is engaged (only engaged MONSTERS/VEHICLES can be shot)' };
      if (kw.blast) return { state, summary: '', rejected: '[BLAST] weapons cannot target engaged units' };
      hitPenalty -= 1;
    }
  }
  if (!isMelee) {
    const visible = unitCanSeeIn(aPts, target, state, ctx);
    if (!visible) {
      if (!kw.indirectFire) return { state, summary: '', rejected: 'no line of sight' };
      // Indirect shooting (10.07): unmod 1-5 fails (1-3 if stationary + target visible to a
      // friendly unit), no hit re-rolls, target has the Benefit of Cover.
      indirect = true;
      forceCover = true;
      if (attacker.status.remainedStationary) {
        indirectSpotted = state.units.some((u) => {
          if (u.owner !== attacker.owner || u.id === attacker.id || u.inReserves) return false;
          const spotters = u.models.filter((m) => m.alive).map((m) => m.pos);
          return spotters.length > 0 && unitCanSeeIn(spotters, target, state, ctx);
        });
      }
    } else if (!kw.indirectFire) {
      // Per-model visibility (10e: a model can only shoot a target it can see). Only the bearers
      // that themselves have line of sight fire — a squad mostly hidden behind a tall ruin no
      // longer contributes its hidden models' shots because one squadmate can peek around it.
      const bearers = attacker.models.filter(
        (m) => m.alive && (m.datasheetId ?? attacker.datasheetId) === found.sourceDsId,
      );
      const hidden = isHidden(target, state, ctx);
      const seeing = bearers.filter((m) =>
        tPts.some(
          (t) =>
            !(hidden && Math.hypot(m.pos.x - t.x, m.pos.y - t.y) > DEFAULT_DETECTION_RANGE) &&
            !pointLosBlocked(m.pos, t, state.layout),
        ),
      ).length;
      if (seeing === 0) return { state, summary: '', rejected: 'no line of sight' };
      if (seeing < aliveAttackers) {
        aliveAttackers = seeing;
      }
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
  const mods = gatherAttackModifiers(abilityCtx, effectsOf(attacker, ctx), effectsOf(target, ctx));

  const cover = (forceCover || (!isMelee && unitCoverIn(aPts, target, state, ctx))) && !mods.ignoresCover;
  // [PRECISION] (24.28): with a visible CHARACTER in the target unit, the attacker may promote
  // that CHARACTER's allocation group to current. The AI/engine always does when it can.
  const precisionActive =
    kw.precision &&
    target.models.some(
      (m) =>
        m.alive &&
        m.datasheetId != null &&
        m.datasheetId !== target.datasheetId &&
        (ctx.datasheets.get(m.datasheetId)?.keywords ?? []).some((k) => k.toLowerCase() === 'character'),
    );
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
    indirect,
    indirectSpotted,
    snapShooting: params.snapShooting,
    precisionActive,
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

  // [HAZARDOUS] (24.15): after resolving, one hazard roll per hazardous weapon selected — this
  // call resolves one weapon, so one roll. Fails on 1-2: 1 mortal wound (3 if all M/V).
  let hazardLog: string[] = [];
  let attackerModels = attacker.models;
  if (kw.hazardous) {
    const aMV = aDs.keywords.some((k) => /^(monster|vehicle)$/i.test(k));
    const { roll, mortals } = hazardRoll(rng, aMV);
    if (mortals > 0) {
      attackerModels = [...attacker.models];
      let left = mortals;
      // Mortal-wound allocation (06.02): wounded non-CHARACTERs, then non-CHARACTERs, then chars.
      while (left > 0) {
        const alive = attackerModels.filter((m) => m.alive);
        if (alive.length === 0) break;
        const isChar = (m: ModelInstance) =>
          m.datasheetId != null && m.datasheetId !== attacker.datasheetId;
        const mds = (m: ModelInstance) => modelDatasheet(m, attacker, ctx) ?? aDs;
        const pick =
          alive.find((m) => !isChar(m) && m.wounds < mds(m).models[0]!.W) ??
          alive.find((m) => !isChar(m)) ??
          alive.find((m) => m.wounds < mds(m).models[0]!.W) ??
          alive[0]!;
        const k = attackerModels.indexOf(pick);
        const wounds = pick.wounds - 1;
        attackerModels[k] = { ...pick, wounds, alive: wounds > 0 };
        left--;
      }
      hazardLog = [`  Hazardous: rolled ${roll} — ${mortals} mortal wound(s) to ${aDs.name}`];
    } else {
      hazardLog = [`  Hazardous: rolled ${roll} — safe`];
    }
  }

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
      return {
        ...u,
        models: attackerModels,
        status: {
          ...u.status,
          [isMelee ? 'hasFought' : 'hasShot']: true,
          ...(!isMelee ? { lastShotOnTurn: state.turnCounter ?? 0 } : {}),
        },
      };
    }
    return u;
  });

  const verb = isMelee ? 'fights' : 'shoots';
  const summary =
    `${aDs.name} ${verb} ${tDs.name} with ${profile.name}: ` +
    `${result.hits} hits, ${result.failedSaves + result.devastating} wounds through, ` +
    `${result.damageDealt} damage, ${result.modelsSlain} slain`;

  return {
    state: { ...state, units: newUnits, log: [...state.log, summary, ...result.log.map((l) => `  ${l.step}: ${l.detail}`), ...hazardLog] },
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

  const units = cur.units.map((u) =>
    u.id === attacker.id
      ? { ...u, status: { ...u.status, hasShot: true, lastShotOnTurn: cur.turnCounter ?? 0 } }
      : u,
  );
  const aliveAfter = units.find((u) => u.id === target.id)?.models.filter((m) => m.alive).length ?? 0;
  const summary = `${aDs.name} shooting at ${tDs.name}: ${firedCount} weapon(s) fired, ${aliveBefore - aliveAfter} model(s) slain`;
  return { state: { ...cur, units, log: [...cur.log, summary] }, summary };
}

// ── Unit-level fighting: every model swings its best melee weapon ───────────────
/** Quick deterministic expected damage per bearer of a melee profile into a defender — used only
 *  to RANK weapon choices inside one unit (the dice still decide the game). */
function meleeProfileRank(w: WeaponProfile, def: { T: number; save: number; invuln?: number }): number {
  const kw = parseKeywords(w.keywords);
  const a = parseDice(w.attacks);
  const attacks = Math.max(0, a.count * ((a.sides + 1) / 2) + a.flat);
  const pHit = kw.torrent ? 1 : Math.max(1 / 6, Math.min(5 / 6, (7 - w.skill) / 6));
  const pWound = Math.max(1 / 6, Math.min(5 / 6, (7 - woundThreshold(w.S, def.T)) / 6));
  const sv = effectiveSave(def.save, w.AP, def.invuln);
  const pFail = sv > 6 ? 1 : 1 - (7 - Math.max(2, sv)) / 6;
  const d = parseDice(w.D);
  const dmg = Math.max(1, d.count * ((d.sides + 1) / 2) + d.flat);
  return attacks * pHit * pWound * pFail * dmg;
}

/**
 * Which melee weapons swing when the whole unit fights (10e: each model fights with ONE of its
 * melee weapons — its choice — plus any [EXTRA ATTACKS] weapons on top). Applies:
 *  • one profile per multi-profile weapon ("– strike" / "– sweep" are one weapon): the better
 *    profile against this target is kept;
 *  • per-model weapon choice: bearers are assigned to their highest-ranked weapon first, and the
 *    remaining models swing the next-best weapon they carry (unit-level approximation of "each
 *    model picks one" — the roster tracks counts, not which model holds what);
 *  • Extra Attacks weapons always swing in addition, without using up a model's pick.
 */
export function planUnitFight(
  state: GameState,
  attacker: UnitInstance,
  ctx: EngineContext,
  targetUnitId?: string,
): FirePlan {
  const notes: string[] = [];
  let melee = availableUnitWeapons(attacker, ctx).filter((w) => w.weapon.type === 'melee');

  const target = targetUnitId ? state.units.find((u) => u.id === targetUnitId) : undefined;
  const tProfile = target ? ctx.datasheets.get(target.datasheetId)?.models[0] : undefined;
  const def = { T: tProfile?.T ?? 4, save: tProfile?.Sv ?? 3, invuln: tProfile?.invuln };

  // Multi-profile weapons are ONE weapon: keep the best profile per item against this target.
  const byItem = new Map<string, typeof melee>();
  for (const w of melee) {
    const key = `${w.sourceDsId}|${weaponItemName(w.weapon.name)}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key)!.push(w);
  }
  melee = [...byItem.values()].map((profiles) => {
    if (profiles.length === 1) return profiles[0]!;
    const best = profiles.reduce((x, y) => (meleeProfileRank(y.weapon, def) > meleeProfileRank(x.weapon, def) ? y : x));
    notes.push(`${weaponItemName(best.weapon.name)}: fighting with the "${best.weapon.name}" profile`);
    return best;
  });

  const extras = melee.filter((w) => !!parseKeywords(w.weapon.keywords).extraAttacks);
  const mains = melee
    .filter((w) => !parseKeywords(w.weapon.keywords).extraAttacks)
    .sort((x, y) => meleeProfileRank(y.weapon, def) - meleeProfileRank(x.weapon, def));

  // Each model fights with ONE main melee weapon: hand the best weapons to their bearers first.
  const budget = new Map<string, number>(); // sourceDsId -> models still without a weapon pick
  const fire: FirePlan['fire'] = [];
  for (const w of mains) {
    if (!budget.has(w.sourceDsId)) {
      budget.set(
        w.sourceDsId,
        attacker.models.filter((m) => m.alive && (m.datasheetId ?? attacker.datasheetId) === w.sourceDsId).length,
      );
    }
    const left = budget.get(w.sourceDsId)!;
    const n = Math.min(w.carriers, left);
    if (n <= 0) {
      notes.push(`${w.weapon.name}: held (its bearers swing a better weapon)`);
      continue;
    }
    budget.set(w.sourceDsId, left - n);
    fire.push({ weapon: w.weapon, sourceDsId: w.sourceDsId, carriers: n });
  }
  for (const w of extras) fire.push({ weapon: w.weapon, sourceDsId: w.sourceDsId, carriers: w.carriers });

  return { fire, notes };
}

export interface UnitFightParams {
  attackerUnitId: string;
  targetUnitId: string;
}

/**
 * Resolve a whole unit's Fight activation against one target: every weapon in the fight plan is
 * resolved SEQUENTIALLY (casualties from one weapon are removed before the next swings), exactly
 * like unit-level shooting. Marks the unit as having fought.
 */
export function resolveUnitFight(
  state: GameState,
  params: UnitFightParams,
  ctx: EngineContext,
  rng: RNG,
): AttackOutcome {
  const attacker = state.units.find((u) => u.id === params.attackerUnitId);
  const target = state.units.find((u) => u.id === params.targetUnitId);
  if (!attacker || !target) return { state, summary: '', rejected: 'unit not found' };
  const aDs = ctx.datasheets.get(attacker.datasheetId);
  const tDs = ctx.datasheets.get(target.datasheetId);
  if (!aDs || !tDs) return { state, summary: '', rejected: 'datasheet not found' };

  if (state.mode === 'match' && state.stage === 'battle' && state.phase !== 'Fight') {
    return { state, summary: '', rejected: `fighting only in the Fight phase (now ${state.phase})` };
  }
  if (state.mode === 'match' && attacker.status.hasFought) {
    return { state, summary: '', rejected: 'this unit has already fought this turn' };
  }
  if (closestGap(attacker, aDs.baseShape, target, tDs.baseShape) > ENGAGEMENT_RANGE) {
    return { state, summary: '', rejected: 'not in engagement range' };
  }

  const { fire, notes } = planUnitFight(state, attacker, ctx, target.id);
  if (fire.length === 0) return { state, summary: '', rejected: 'no melee weapons' };

  const aliveBefore = target.models.filter((m) => m.alive).length;
  let cur: GameState = {
    ...state,
    log: [
      ...state.log,
      `— ${aDs.name} fights ${tDs.name}: ${fire.length} weapon(s), resolved sequentially —`,
      ...notes.map((n) => `  ${n}`),
    ],
  };
  let swungCount = 0;
  const skipped: string[] = [];
  for (const w of fire) {
    const tNow = cur.units.find((u) => u.id === target.id);
    if (!tNow || !tNow.models.some((m) => m.alive)) {
      cur = { ...cur, log: [...cur.log, '  target destroyed — remaining weapons not used'] };
      break;
    }
    const out = resolveAttack(
      cur,
      {
        attackerUnitId: attacker.id,
        targetUnitId: target.id,
        weaponName: w.weapon.name,
        weaponSourceDsId: w.sourceDsId,
        attackerCount: w.carriers,
      },
      ctx,
      rng,
    );
    if (out.rejected) {
      skipped.push(`  ${w.weapon.name} not used: ${out.rejected}`);
      continue;
    }
    swungCount++;
    cur = out.state;
  }
  if (skipped.length) cur = { ...cur, log: [...cur.log, ...skipped] };
  if (swungCount === 0) {
    return { state, summary: '', rejected: `no melee weapon could be used (${skipped[0]?.trim() ?? 'not in engagement range'})` };
  }

  const units = cur.units.map((u) => (u.id === attacker.id ? { ...u, status: { ...u.status, hasFought: true } } : u));
  const aliveAfter = units.find((u) => u.id === target.id)?.models.filter((m) => m.alive).length ?? 0;
  const summary = `${aDs.name} fighting ${tDs.name}: ${swungCount} weapon(s), ${aliveBefore - aliveAfter} model(s) slain`;
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
  const other: import('./types').Side = side === 'player' ? 'ai' : 'player';
  const log: string[] = [`— ${side} Command phase (round ${state.round}) —`];

  // 1. Gain Core CP (08.02, 11e): BOTH players gain 1 CP in each Command phase.
  const cp = { player: state.cp.player + 1, ai: state.cp.ai + 1 };
  log.push(`both players gain 1 CP (${side}: ${cp[side]}, ${other}: ${cp[other]})`);

  // 2. Battle-shock (08.03, 11e): the active player rolls for each of their units that is at or
  // below half-strength OR already battle-shocked; a successful roll clears the state.
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
    const test = battleShockTest(alive, u.startingModels, ld, rng, woundsFraction, u.status.battleShocked);
    if (test.required) {
      reports.push({ unitId: u.id, unitName: ds.name, roll: [test.roll[0]!, test.roll[1]!], total: test.total, ld, passed: test.passed });
      log.push(
        `${ds.name} Battle-shock: ${test.roll.join('+')}=${test.total} vs Ld ${ld}+ → ${test.passed ? 'passed' : 'BATTLE-SHOCKED'}`,
      );
    }
    return { ...u, status: { ...u.status, battleShocked: test.required && !test.passed } };
  });

  // Primary VP: 11e mission games score via missions11.ts (Command-end + turn-end windows).
  // Legacy layouts (no mission state) keep the old Pariah-style hold-objectives scoring so the
  // 10e maps stay playable.
  const stateForScore = { ...state, units };
  let score = state.score;
  if (!state.missions && state.round >= 2) {
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
  /** Spend 1 CP on the Core Stratagem "Command Re-roll" if the charge roll fails (match mode;
   *  once per phase per side — the engine enforces both and re-rolls the full 2D6). */
  commandReroll?: boolean;
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
  occupied: OccupiedBase[] = [],
  /** Per-model bases of a translated charger copy (merged units mix base sizes). */
  chargerBases: (u: UnitInstance) => OccupiedBase[] = (u) =>
    u.models.filter((m) => m.alive).map((m) => ({ pos: m.pos, shape: cShape })),
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
        // Bases may end in contact but never on top of another model (friend or foe).
        if (anyOverlap(chargerBases(moved), occupied)) continue;
        return v;
      }
    }
  }
  return null;
}

/**
 * Resolve a charge with 11e sequencing (11.02/11.04): the 2D6 charge roll is made FIRST, and
 * targets are selected AFTER the roll — each selected target must be within 12" AND within the
 * rolled distance. `targetUnitIds` carries the player's INTENDED targets; after the roll the
 * engine selects the best subset it can actually engage (dropping the furthest intended targets
 * first), exactly as a player choosing targets post-roll would. Any intended target NOT selected
 * counts as a non-target (the move cannot end engaged with it). On success, moves the charger,
 * marks it charged, and grants Fights First (via the charged flag).
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

  // Intent legality: every INTENDED target must be within 12" (11.04 — targets beyond 12" can
  // never be selected, so declaring one is an illegal intent, not a failed charge).
  for (const t of targets) {
    if (closestGap(charger, cDs.baseShape, t.unit, t.shape) > 12) {
      const summary = `Charge illegal: ${ctx.datasheets.get(t.unit.datasheetId)?.name ?? t.unit.id} is over 12" away`;
      return { state: { ...state, log: [...state.log, summary] }, success: false, summary };
    }
  }

  // Enemies that end up unselected are non-targets: the move may not end within Engagement Range
  // of them. (Computed per-attempt below, since target selection follows the roll.)
  const enemyShape = (u: UnitInstance) => ctx.datasheets.get(u.datasheetId)?.baseShape ?? cDs.baseShape;
  const otherEnemies = state.units
    .filter((u) => u.owner !== charger.owner && !u.inReserves && u.models.some((m) => m.alive))
    .map((u) => ({ unit: u, shape: enemyShape(u) }));

  const occupied = occupiedBases(state, ctx, [charger.id]);
  // 11.04: select targets AFTER the roll — intended targets within the rolled distance, best
  // engageable subset first (drop the furthest intended target when the full set has no path).
  const attempt = (dist: number): { move: Vec2; selected: typeof targets } | null => {
    const selectable = targets
      .filter((t) => closestGap(charger, cDs.baseShape, t.unit, t.shape) <= dist)
      .sort(
        (a, b) =>
          closestGap(charger, cDs.baseShape, a.unit, a.shape) -
          closestGap(charger, cDs.baseShape, b.unit, b.shape),
      );
    for (let n = selectable.length; n >= 1; n--) {
      const selected = selectable.slice(0, n);
      const selectedIds = new Set(selected.map((t) => t.unit.id));
      const nonTargets = otherEnemies.filter((e) => !selectedIds.has(e.unit.id));
      const move = findChargeMove(charger, cDs.baseShape, selected, nonTargets, dist, occupied, (u) => unitBases(u, ctx));
      if (move) return { move, selected };
    }
    return null;
  };

  let { distance, rolls } = rollCharge(rng);
  let result = attempt(distance);

  // Core Stratagem "Command Re-roll": on a failed charge the issuer may spend 1 CP to re-roll
  // the full 2D6 (once per phase per side, match mode only).
  let cp = state.cp;
  let rerollUsed = state.rerollUsed;
  const extraLog: string[] = [];
  if (!result && params.commandReroll && state.mode === 'match') {
    const phaseKey = `${state.round}:${state.activePlayer}:${state.phase}`;
    if (cp[charger.owner] >= 1 && rerollUsed?.[charger.owner] !== phaseKey) {
      cp = { ...cp, [charger.owner]: cp[charger.owner] - 1 };
      rerollUsed = { ...(rerollUsed ?? {}), [charger.owner]: phaseKey };
      const first = `${rolls.join('+')}=${distance}"`;
      ({ distance, rolls } = rollCharge(rng));
      extraLog.push(`${charger.owner} spends 1 CP on Command Re-roll: charge 2D6 ${first} re-rolled`);
      result = attempt(distance);
    }
  }

  const success = result !== null;
  const move = result?.move ?? null;
  const engagedTargets = result?.selected ?? targets;
  const names = engagedTargets.map((t) => ctx.datasheets.get(t.unit.datasheetId)?.name ?? t.unit.id).join(' + ');
  // Tell a short roll apart from a blocked path. A target is only SELECTABLE when it is within
  // the rolled distance (11.04), so the minimum roll that could possibly work is the closest
  // intended target's full gap — not gap minus Engagement Range.
  const needed = Math.min(...targets.map((t) => closestGap(charger, cDs.baseShape, t.unit, t.shape)));
  const dropped = success && engagedTargets.length < targets.length
    ? ` (${targets.length - engagedTargets.length} intended target(s) out of reach and not selected)`
    : '';
  const reason = success
    ? `SUCCESS${dropped}`
    : distance < needed - 1e-6
      ? `failed — needed ${Math.max(0, needed).toFixed(1)}", rolled ${distance}"`
      : 'failed — no clear path (cannot reach a target without ending within Engagement Range of another enemy)';
  const summary = `${cDs.name} charges ${names}: 2D6=${rolls.join('+')}=${distance}" → ${reason}`;

  // The declaration is spent whether or not the roll/path succeeded (match mode; the sandbox
  // stays a free dice calculator).
  const attempted = state.mode === 'match' ? { chargeAttempted: true } : {};
  const units = state.units.map((u) => {
    if (u.id !== charger.id) return u;
    if (success) return { ...translatedModels(u, move!), status: { ...u.status, ...attempted, charged: true, moved: true } };
    return { ...u, status: { ...u.status, ...attempted } };
  });
  return { state: { ...state, units, cp, rerollUsed, log: [...state.log, ...extraLog, summary] }, success, summary };
}

/**
 * Could `charger` complete a charge against `targetUnitIds` on a roll of `roll` (default 12, the
 * 2D6 maximum)? Runs the same path search as `resolveCharge` without dice or state changes. The
 * AI calls this before DECLARING, so a charge with no legal landing spot at ANY roll (screens,
 * stacked bases) never burns the once-per-phase declaration on a guaranteed failure.
 */
export function chargePathExists(
  state: GameState,
  chargerUnitId: string,
  targetUnitIds: string[],
  ctx: EngineContext,
  roll = 12,
): boolean {
  const charger = state.units.find((u) => u.id === chargerUnitId);
  const cDs = charger ? ctx.datasheets.get(charger.datasheetId) : undefined;
  if (!charger || !cDs) return false;
  const targets = targetUnitIds
    .map((id) => state.units.find((u) => u.id === id))
    .filter((u): u is UnitInstance => !!u && u.models.some((m) => m.alive))
    .map((u) => ({ unit: u, shape: ctx.datasheets.get(u.datasheetId)?.baseShape ?? cDs.baseShape }));
  if (targets.length === 0) return false;
  const targetSet = new Set(targets.map((t) => t.unit.id));
  const nonTargets = state.units
    .filter((u) => u.owner !== charger.owner && !u.inReserves && !targetSet.has(u.id) && u.models.some((m) => m.alive))
    .map((u) => ({ unit: u, shape: ctx.datasheets.get(u.datasheetId)?.baseShape ?? cDs.baseShape }));
  const occupied = occupiedBases(state, ctx, [charger.id]);
  return findChargeMove(charger, cDs.baseShape, targets, nonTargets, roll, occupied, (u) => unitBases(u, ctx)) !== null;
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

// ── Fight-phase moves: Pile In (12.03) / Consolidate (12.08) ───────────────────
export interface FightMoveParams {
  unitId: string;
  mode: 'pile_in' | 'consolidate';
}

/**
 * Stamp `engagedAtFightStart` on every on-board unit — called when the Fight phase begins.
 * 12.04 keeps a unit eligible to fight even if its combat evaporates mid-phase (its enemy is
 * destroyed by another fight, or emergency-disembarks away); such a unit fights via an
 * OVERRUN FIGHT (12.06).
 */
export function stampFightStepEngagement(state: GameState, ctx: EngineContext): GameState {
  const alive = state.units.filter((u) => !u.inReserves && u.models.some((m) => m.alive));
  const engaged = new Set<string>();
  for (const u of alive) {
    const uDs = ctx.datasheets.get(u.datasheetId);
    if (!uDs) continue;
    for (const e of alive) {
      if (e.owner === u.owner) continue;
      const eDs = ctx.datasheets.get(e.datasheetId);
      if (!eDs) continue;
      if (closestGap(u, uDs.baseShape, e, eDs.baseShape) <= ENGAGEMENT_RANGE) {
        engaged.add(u.id);
        break;
      }
    }
  }
  return {
    ...state,
    units: state.units.map((u) => ({ ...u, status: { ...u.status, engagedAtFightStart: engaged.has(u.id) } })),
  };
}

/**
 * Pile In (12.03) and Consolidation (12.08) moves — up to 3", modelled as a coherency-preserving
 * rigid translate (per-model movement is approximated; the unit-level constraints are enforced).
 *
 * Pile In: targets are the units we're engaged with, otherwise enemy units within 5" (the overrun
 * fight's extra pile-in). The unit must END engaged, or it does not move.
 *
 * Consolidation selects its mode by the 11e mandatory priority:
 *  • Ongoing (engaged): move toward the closest engaged enemy, staying engaged.
 *  • Engaging (enemy within 3"): move toward it and END engaged — or don't move at all. Enemy
 *    units engaged this way that have not fought become eligible to fight (the caller's live
 *    eligibility check picks them up — "chain fights").
 *  • Objective (objective within reach): end within control range of it if possible.
 *  • Otherwise the unit cannot consolidate (11e removed the free 3" toward the nearest enemy).
 *
 * Timing note: the Core Rules resolve Pile In (12.02) and Consolidate (12.07) as whole-phase
 * steps (active player's units all at once, then the opponent's); this engine resolves them
 * per-activation around each unit's fight, which preserves the same reach and the same chain-fight
 * consequences under alternating activations. Documented simplification.
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
  const verb = params.mode === 'pile_in' ? 'piles in' : 'consolidates';

  // Phase legality (real matches only).
  if (state.mode === 'match' && state.stage === 'battle' && state.phase !== 'Fight') {
    const summary = `Pile In/Consolidate rejected: only in the Fight phase (now ${state.phase})`;
    return { state: { ...state, log: [...state.log, summary] }, summary };
  }

  // Enemy units by base-to-base gap.
  const enemies: { unit: UnitInstance; gap: number }[] = [];
  for (const e of state.units) {
    if (e.owner === unit.owner || e.inReserves || !e.models.some((m) => m.alive)) continue;
    const eDs = ctx.datasheets.get(e.datasheetId);
    if (!eDs) continue;
    enemies.push({ unit: e, gap: closestGap(unit, ds.baseShape, e, eDs.baseShape) });
  }
  enemies.sort((a, b) => a.gap - b.gap);
  const engagedWith = enemies.filter((e) => e.gap <= ENGAGEMENT_RANGE);

  const noMove = (why: string): { state: GameState; summary: string } => {
    const summary = `${ds.name} does not ${params.mode === 'pile_in' ? 'pile in' : 'consolidate'} (${why})`;
    return { state: { ...state, log: [...state.log, summary] }, summary };
  };

  // Pick the move goal by mode.
  let goal: { unit: UnitInstance; gap: number } | undefined;
  let mustEndEngaged = false;
  let modeNote = '';
  let objectiveGoal: Vec2 | undefined;
  if (params.mode === 'pile_in') {
    // 12.03: targets = engaged enemies; an unengaged unit (overrun fight, 12.06) may pick
    // enemies within 5". Either way the unit must END engaged.
    const pool = engagedWith.length ? engagedWith : enemies.filter((e) => e.gap <= 5);
    if (!pool.length) return noMove('no enemy within pile-in reach');
    goal = pool[0]!;
    if (!engagedWith.length) {
      mustEndEngaged = true;
      modeNote = ' (overrun)';
      if (goal.gap - 3 > ENGAGEMENT_RANGE) return noMove('cannot end the pile-in engaged');
    }
  } else if (engagedWith.length) {
    goal = engagedWith[0]!; // Ongoing Consolidation: closer to the closest engaged enemy
    modeNote = ' (ongoing)';
  } else if (enemies.length && enemies[0]!.gap <= 3) {
    goal = enemies[0]!; // Engaging Consolidation: must end engaged
    mustEndEngaged = true;
    modeNote = ' (engaging)';
  } else {
    // Objective Consolidation: the closest objective the unit could end within range of.
    const controlR = state.layout.objectiveControlRadiusIn ?? 3;
    const objPts: Vec2[] = state.layout.objectivePoints?.map((o) => o.pos) ?? state.layout.objectives;
    let bestObj: { pos: Vec2; d: number } | undefined;
    for (const o of objPts) {
      // Distance from the unit's closest model to the marker/area centre.
      let d = Infinity;
      for (const m of unit.models) {
        if (!m.alive) continue;
        d = Math.min(d, Math.hypot(m.pos.x - o.x, m.pos.y - o.y));
      }
      if ((!bestObj || d < bestObj.d) && d > controlR && d - 3 <= controlR + 1) bestObj = { pos: o, d };
    }
    if (!bestObj) return noMove('no eligible consolidation mode — stays put');
    objectiveGoal = bestObj.pos;
    modeNote = ' (objective)';
  }

  let dir: Vec2;
  let moveDist: number;
  if (goal) {
    dir = closestAxis(unit, goal.unit);
    moveDist = Math.min(3, Math.max(0, goal.gap)); // up to 3", stopping at base contact
  } else {
    // Toward the objective centre, just far enough to be in range.
    const controlR = state.layout.objectiveControlRadiusIn ?? 3;
    const from = aliveCentroid(unit);
    const dx = objectiveGoal!.x - from.x;
    const dy = objectiveGoal!.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    dir = { x: dx / len, y: dy / len };
    let need = Infinity;
    for (const m of unit.models) {
      if (!m.alive) continue;
      need = Math.min(need, Math.hypot(m.pos.x - objectiveGoal!.x, m.pos.y - objectiveGoal!.y) - controlR);
    }
    moveDist = Math.min(3, Math.max(0, need + 0.1));
  }

  // Never end on top of another model's base (a friendly unit can sit between us and the enemy).
  const occupied = occupiedBases(state, ctx, [unit.id]);
  const clamped = clampDeltaAvoidingOverlap(
    unitBases(unit, ctx), occupied, { x: dir.x * moveDist, y: dir.y * moveDist },
  );
  moveDist = Math.hypot(clamped.x, clamped.y);

  // "Must end engaged" modes: if the clamped move still leaves us out of Engagement Range, the
  // move cannot be made at all (12.03 / 12.08 Engaging).
  if (mustEndEngaged && goal) {
    const endGap = goal.gap - moveDist; // rigid translate along the closest axis
    if (endGap > ENGAGEMENT_RANGE + 1e-6) return noMove('cannot end the move engaged');
  }

  if (moveDist <= 1e-6) {
    return { state: { ...state, log: [...state.log, `${ds.name} ${verb}${modeNote} (already in position)`] }, summary: 'no move' };
  }
  const units = state.units.map((u) =>
    u.id === unit.id
      ? { ...u, models: u.models.map((m) => (m.alive ? { ...m, pos: { x: m.pos.x + clamped.x, y: m.pos.y + clamped.y } } : m)) }
      : u,
  );
  const summary = `${ds.name} ${verb}${modeNote} ${moveDist.toFixed(1)}" ${goal ? 'toward the enemy' : 'toward the objective'}`;
  return { state: { ...state, units, log: [...state.log, summary] }, summary };
}
