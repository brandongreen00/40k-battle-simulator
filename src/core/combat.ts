// The combat resolution pipeline — the heart of the rules core. PURE; uses injected RNG.
//
// 11th edition (Core Rules 04–06): models one weapon profile fired by `attackerCount` models at
// one target unit, resolving attack dice -> hit -> wound -> save -> damage with the 11e
// allocation-group system (05.03/05.04) and the universal ability library (keywords.ts).
//
// Key 11e semantics implemented here:
//  - Benefit of Cover WORSENS the attack's BS by 1 (13.08) — it is no longer a save bonus.
//    BS changes are characteristic changes, so they bypass the ±1 hit-roll modifier cap.
//  - Save rolls: the defender divides models into allocation groups (per CHARACTER model, and
//    one group per distinct W/Sv/InSv among the rest), declares an order (wounded non-CHARACTER
//    group first; CHARACTERs last; wounded CHARACTERs before unwounded), rolls all saves, then
//    damage resolves lowest roll first against the *current* group (05.04). [PRECISION] lets the
//    attacker promote a visible CHARACTER group to current.
//  - [DEVASTATING WOUNDS]: a critical wound ends the sequence and inflicts D mortal wounds,
//    damaging at most one model per crit (24.10); resolved after the normal damage.
//  - Invulnerable saves are checked on the UNMODIFIED roll; armour saves apply AP.
//  - Hazard rolls fail on 1-2 (06.03) — see `hazardRoll`.
//
// Design intent (rule #1 + plan §6): every step reads modifiers from `CombatSituation`; the
// ability/effect hook system computes those from game events. The pipeline never needs to know
// *why* a modifier exists. Deterministic and fully driven by the injected RNG.

import type { RNG } from './rng';
import type { ParsedKeywords } from './keywords';
import { parseDice, rollDice } from './dice';

// ── Inputs ─────────────────────────────────────────────────────────────────────
export interface AttackProfile {
  name: string;
  attacks: string; // dice notation, per firing model (e.g. "2", "D6")
  skill: number; // BS/WS to-hit value (2..6); ignored when Torrent
  S: number;
  AP: number; // <= 0 (e.g. -1)
  D: string; // damage dice notation
  keywords: ParsedKeywords;
}

/** A target model's live wound state, in the defender's preferred allocation order. */
export interface DefenderModel {
  maxW: number;
  wounds: number;
  /** Per-model invuln (e.g. a shield-bearer's 4++), overriding the unit's. */
  invuln?: number;
  /** Per-model armour save, overriding the unit's. */
  save?: number;
  /** CHARACTER model (merged Leader): gets its own allocation group, damaged last (05.03). */
  character?: boolean;
}

export interface DefenderProfile {
  T: number;
  save: number; // armour save value (e.g. 4 for 4+)
  invuln?: number; // invulnerable save value (e.g. 4 for 4++)
  keywords: string[]; // unit keywords, for Anti-X matching (matched case-insensitively)
  fnp?: number; // Feel No Pain value (e.g. 5 for 5+)
  models: DefenderModel[];
}

export type Reroll = 'none' | 'ones' | 'fail' | 'all';

/** Situational modifiers. Derived from keywords + flags + the ability/effect hooks. */
export interface CombatSituation {
  attackerCount: number; // number of models firing this weapon profile
  hitModifier?: number; // roll modifier, clamped to ±1 (11e)
  woundModifier?: number; // roll modifier, clamped to ±1
  /** BS/WS characteristic delta (NOT a roll modifier — uncapped). +1 = worse, -1 = better.
   *  Benefit of Cover contributes +1 (13.08); Plunging Fire contributes -1 (22.05). */
  skillDelta?: number;
  rapidFireActive?: boolean; // target within half range (Rapid Fire bonus attacks)
  meltaActive?: boolean; // target within half range (Melta bonus damage)
  charged?: boolean; // bearer charged this turn (Lance)
  stationary?: boolean; // bearer eligible for the Heavy bonus (unengaged, moved <= 3")
  longRange?: boolean; // target 12"+ away (Conversion)
  cover?: boolean; // target has the Benefit of Cover (worsens BS by 1)
  targetModelCount?: number; // models in the target unit at start of attack (Blast/Cleave)
  /** Snap shooting (15.09, Fire Overwatch): only unmodified 6s hit, no hit re-rolls. */
  snapShooting?: boolean;
  /** Indirect shooting (10.07): unmodified 1-5 fails (1-3 when `indirectSpotted`), no hit
   *  re-rolls, target has cover. The engine sets cover separately. */
  indirect?: boolean;
  indirectSpotted?: boolean; // shooter stationary + target visible to a friendly unit
  /** [PRECISION] with a visible CHARACTER in the target: attacker promotes that group first. */
  precisionActive?: boolean;
  critHitOn?: number; // critical-hit threshold (default 6)
  critWoundOn?: number; // critical-wound threshold (default 6)
  rerollHits?: Reroll;
  rerollWounds?: Reroll;
  damageReduction?: number; // -X to Damage per wound (floored at 1)
  extraAttacks?: number; // +N to the Attacks characteristic per firing model
  /** Ignore negative BS and hit-roll modifiers (Superior Weapon Support System). */
  ignoreBadHitMods?: boolean;
}

// ── Outputs ──────────────────────────────────────────────────────────────────
export interface DiceLogEntry {
  step: 'attacks' | 'hit' | 'wound' | 'save' | 'damage';
  detail: string;
  rolls?: number[];
}

export interface AttackResult {
  attacks: number;
  hits: number;
  wounds: number; // saveable wounds reaching the save step (incl. Lethal Hits, excl. Devastating)
  devastating: number; // critical wounds converted to mortal wounds (Devastating Wounds)
  failedSaves: number;
  damageDealt: number; // wounds actually removed from models (after FNP/reduction)
  modelsSlain: number;
  log: DiceLogEntry[];
  defenderModels: DefenderModel[]; // updated wound state
}

// ── To-wound chart (unchanged in 11e) ─────────────────────────────────────────
export function woundThreshold(S: number, T: number): number {
  if (S >= 2 * T) return 2;
  if (S > T) return 3;
  if (S === T) return 4;
  if (2 * S > T) return 5; // S < T but more than half
  return 6; // S*2 <= T
}

/** Hazard roll (06.03): fails on a 1-2 → 1 mortal wound (3 if the unit is all MONSTER/VEHICLE). */
export function hazardRoll(rng: RNG, monsterOrVehicle: boolean): { roll: number; mortals: number } {
  const roll = rng.d6();
  return { roll, mortals: roll <= 2 ? (monsterOrVehicle ? 3 : 1) : 0 };
}

const clampMod = (m: number | undefined): number => Math.max(-1, Math.min(1, m ?? 0));
const clampThreshold = (t: number): number => Math.max(2, Math.min(6, t));

/**
 * Roll a pool of d6 at `threshold` (+mod, capped ±1), with criticals on `critOn` and one optional
 * re-roll. Unmodified 1 always fails; a critical always succeeds and is counted. `threshold` may
 * exceed 6 (a worsened BS) — then only criticals succeed. Used for the hit and wound steps.
 */
function rollPool(
  n: number,
  threshold: number,
  mod: number,
  critOn: number,
  reroll: Reroll,
  rng: RNG,
): { successes: number; crits: number; faces: number[] } {
  let successes = 0;
  let crits = 0;
  const faces: number[] = [];
  const evaluate = (raw: number): { ok: boolean; crit: boolean } => {
    const crit = raw >= critOn; // criticals are based on the UNMODIFIED roll
    const ok = crit || (raw !== 1 && raw + mod >= threshold);
    return { ok, crit };
  };
  for (let i = 0; i < n; i++) {
    let raw = rng.d6();
    let { ok, crit } = evaluate(raw);
    const shouldReroll =
      !ok &&
      (reroll === 'fail' || reroll === 'all' || (reroll === 'ones' && raw === 1));
    if (shouldReroll) {
      raw = rng.d6();
      ({ ok, crit } = evaluate(raw));
    }
    faces.push(raw);
    if (ok) successes++;
    if (crit) crits++;
  }
  return { successes, crits, faces };
}

/**
 * Effective armour-save value after AP (lower is better). 11e: the Benefit of Cover no longer
 * modifies saves (it worsens BS instead); invulnerable saves are checked separately on the
 * unmodified roll — see `saveStops`.
 */
export function effectiveSave(save: number, ap: number, invuln: number | undefined): number {
  const armour = save - ap; // ap <= 0, so this worsens (raises) the value
  return Math.min(armour, invuln ?? 99);
}

/** Does save roll `r` stop the attack? (05.04: unmod 1 damages; InSv unmodified; else Sv + AP.) */
function saveStops(r: number, save: number, ap: number, invuln: number | undefined): boolean {
  if (r === 1) return false;
  if (invuln !== undefined && r >= invuln) return true;
  return r + ap >= save; // ap <= 0 worsens the roll
}

/** Apply Feel No Pain to a damage amount: each point negated on a `fnp`+ roll. */
function applyFnp(dmg: number, fnp: number | undefined, rng: RNG): { taken: number; rolls: number[] } {
  if (!fnp || dmg <= 0) return { taken: dmg, rolls: [] };
  const rolls = rng.roll(dmg);
  const negated = rolls.filter((r) => r >= fnp).length;
  return { taken: dmg - negated, rolls };
}

// ── Allocation groups (05.03) ─────────────────────────────────────────────────
interface AllocGroup {
  character: boolean;
  save: number;
  invuln?: number;
  members: DefenderModel[]; // live references into the working model array
}

/**
 * Build the 11e allocation groups from the defender's model list and put them in a legal order:
 * wounded non-CHARACTER groups first, then non-CHARACTER groups (in the order provided — the
 * engine passes them in the defender's preferred order), then wounded CHARACTER groups, then
 * unwounded CHARACTER groups. With `precisionActive`, the first CHARACTER group is promoted to
 * the front (the attacker's choice under [PRECISION]).
 */
function buildGroups(models: DefenderModel[], defender: DefenderProfile, precisionActive: boolean): AllocGroup[] {
  const alive = models.filter((m) => m.wounds > 0);
  const nonChar = new Map<string, AllocGroup>();
  const charGroups: AllocGroup[] = [];
  for (const m of alive) {
    const save = m.save ?? defender.save;
    const invuln = m.invuln ?? defender.invuln;
    if (m.character) {
      charGroups.push({ character: true, save, invuln, members: [m] });
    } else {
      const key = `${m.maxW}|${save}|${invuln ?? '-'}`;
      const g = nonChar.get(key);
      if (g) g.members.push(m);
      else nonChar.set(key, { character: false, save, invuln, members: [m] });
    }
  }
  const isWounded = (g: AllocGroup) => g.members.some((m) => m.wounds < m.maxW);
  const nonCharGroups = [...nonChar.values()].sort((a, b) => Number(isWounded(b)) - Number(isWounded(a)));
  const chars = charGroups.sort((a, b) => Number(isWounded(b)) - Number(isWounded(a)));
  const groups = [...nonCharGroups, ...chars];
  if (precisionActive && chars.length > 0) {
    const first = chars[0]!;
    return [first, ...groups.filter((g) => g !== first)];
  }
  return groups;
}

/** Allocate one damaging hit within the current group: a wounded member first (05.04). */
function pickModel(group: AllocGroup): DefenderModel | undefined {
  const alive = group.members.filter((m) => m.wounds > 0);
  return alive.find((m) => m.wounds < m.maxW) ?? alive[0];
}

/**
 * Resolve one weapon profile fired by `situation.attackerCount` models at `defender`.
 * Returns the casualties plus a step-by-step dice log. Does not mutate inputs.
 */
export function resolveAttacks(
  weapon: AttackProfile,
  defender: DefenderProfile,
  situation: CombatSituation,
  rng: RNG,
): AttackResult {
  const log: DiceLogEntry[] = [];
  const kw = weapon.keywords;
  const models = defender.models.map((m) => ({ ...m }));

  // ── 1. Gather attack dice (04.03) ────────────────────────────────────────────
  const attacksExpr = parseDice(weapon.attacks);
  const per5 = Math.floor((situation.targetModelCount ?? models.length) / 5);
  const blastBonus = kw.blast ? (kw.blast === true ? 1 : kw.blast) * per5 : 0;
  // [CLEAVE X]: melee Blast — +X dice per 5 models when the weapon has a single target (24.06).
  // The engine resolves one target per call, so cleave always applies here.
  const cleaveBonus = kw.cleave ? kw.cleave * per5 : 0;
  const rapidBonus = kw.rapidFire && situation.rapidFireActive ? kw.rapidFire : 0;
  const extra = situation.extraAttacks ?? 0;
  let totalAttacks = 0;
  const attackRolls: number[] = [];
  for (let i = 0; i < situation.attackerCount; i++) {
    const { total, rolls } = rollDice(attacksExpr, rng);
    attackRolls.push(...rolls);
    totalAttacks += total + rapidBonus + blastBonus + cleaveBonus + extra;
  }
  log.push({
    step: 'attacks',
    detail:
      `${situation.attackerCount}× ${weapon.name}: ${totalAttacks} attacks` +
      (rapidBonus ? ` (+${rapidBonus} Rapid Fire)` : '') +
      (blastBonus ? ` (+${blastBonus} Blast)` : '') +
      (cleaveBonus ? ` (+${cleaveBonus} Cleave)` : ''),
    rolls: attackRolls.length ? attackRolls : undefined,
  });

  // ── 2. Hit rolls (05.01) ─────────────────────────────────────────────────────
  let hitsToWound: number;
  let lethalAutoWounds = 0;
  if (kw.torrent && !situation.snapShooting) {
    hitsToWound = totalAttacks;
    log.push({ step: 'hit', detail: `Torrent: ${totalAttacks} automatic hits` });
  } else {
    // BS/WS characteristic changes (uncapped): Benefit of Cover worsens by 1 (13.08);
    // Plunging Fire / other effects arrive via skillDelta. [PSYCHIC] ignores modifiers (24.29).
    const coverApplies = situation.cover && !kw.ignoresCover;
    let skill = weapon.skill + (situation.skillDelta ?? 0) + (coverApplies ? 1 : 0);
    let hitMod = clampMod(situation.hitModifier) + (kw.heavy && situation.stationary ? 1 : 0);
    let reroll = situation.rerollHits ?? 'none';
    if (kw.psychic) hitMod = Math.max(hitMod, 0); // may ignore negative modifiers
    if (situation.ignoreBadHitMods) {
      // Superior Weapon Support System: ignore modifiers that worsen BS or the hit roll.
      skill = Math.min(skill, weapon.skill);
      hitMod = Math.max(hitMod, 0);
    }
    let critHitOn = clampThreshold(situation.critHitOn ?? 6);
    if (kw.conversion && situation.longRange) critHitOn = Math.min(critHitOn, 5);
    if (situation.snapShooting) {
      skill = 7; // only unmodified 6s (criticals) hit
      hitMod = 0;
      reroll = 'none';
      critHitOn = 6;
    } else if (situation.indirect) {
      // 10.07: unmodified 1-5 fails, or 1-3 when stationary + spotted; no re-rolls.
      skill = situation.indirectSpotted ? 4 : 6;
      hitMod = 0;
      reroll = 'none';
    }
    const { successes, crits, faces } = rollPool(
      totalAttacks,
      skill,
      clampMod(hitMod),
      critHitOn,
      reroll,
      rng,
    );
    const sustained = kw.sustainedHits ? crits * kw.sustainedHits : 0;
    lethalAutoWounds = kw.lethalHits ? crits : 0;
    hitsToWound = successes - lethalAutoWounds + sustained;
    log.push({
      step: 'hit',
      detail:
        `${successes} hits (${crits} crit)` +
        (coverApplies ? ' (cover: BS worsened)' : '') +
        (sustained ? ` +${sustained} Sustained` : '') +
        (lethalAutoWounds ? `, ${lethalAutoWounds} Lethal auto-wound` : ''),
      rolls: faces,
    });
  }

  // ── 3. Wound rolls (05.02) ───────────────────────────────────────────────────
  const baseWoundThreshold = woundThreshold(weapon.S, defender.T);
  let critWoundOn = clampThreshold(situation.critWoundOn ?? 6);
  const defenderKw = defender.keywords.map((k) => k.toUpperCase());
  for (const a of kw.anti ?? []) {
    if (defenderKw.includes(a.keyword)) critWoundOn = Math.min(critWoundOn, clampThreshold(a.threshold));
  }
  const woundMod = clampMod(situation.woundModifier) + (kw.lance && situation.charged ? 1 : 0);
  const { successes: woundSucc, crits: woundCrits, faces: woundFaces } = rollPool(
    hitsToWound,
    baseWoundThreshold,
    clampMod(woundMod),
    critWoundOn,
    situation.rerollWounds ?? (kw.twinLinked ? 'fail' : 'none'),
    rng,
  );
  // [DEVASTATING WOUNDS] (24.10): each critical wound becomes D mortal wounds instead.
  const devastating = kw.devastatingWounds ? woundCrits : 0;
  const saveableWounds = woundSucc - devastating + lethalAutoWounds;
  log.push({
    step: 'wound',
    detail:
      `${woundSucc} wounds (need ${baseWoundThreshold}+, ${woundCrits} crit)` +
      (devastating ? `, ${devastating} Devastating (mortal wounds)` : '') +
      (lethalAutoWounds ? `, +${lethalAutoWounds} from Lethal Hits` : ''),
    rolls: woundFaces,
  });

  // ── 4+5. Save rolls → inflict damage, via allocation groups (05.03/05.04) ────
  const dmgExpr = parseDice(weapon.D);
  const meltaBonus = kw.melta && situation.meltaActive ? kw.melta : 0;
  const reduction = situation.damageReduction ?? 0;

  let failedSaves = 0;
  let damageDealt = 0;
  let modelsSlain = 0;
  const dmgFaces: number[] = [];

  let groups = buildGroups(models, defender, !!(situation.precisionActive && kw.precision));
  let current = 0;
  const nextGroup = () => {
    while (current < groups.length && groups[current]!.members.every((m) => m.wounds <= 0)) current++;
    return current < groups.length ? groups[current]! : undefined;
  };

  // Roll all saves together, then resolve from the lowest result up (05.04).
  const saveFaces = saveableWounds > 0 ? rng.roll(saveableWounds) : [];
  const ordered = [...saveFaces].sort((a, b) => a - b);
  for (const r of ordered) {
    const group = nextGroup();
    if (!group) break;
    if (saveStops(r, group.save, weapon.AP, group.invuln)) continue;
    failedSaves++;
    const model = pickModel(group)!;
    const { total, rolls } = rollDice(dmgExpr, rng);
    dmgFaces.push(...rolls);
    const rawDmg = Math.max(1, total + meltaBonus - reduction);
    const { taken } = applyFnp(rawDmg, defender.fnp, rng);
    const applied = Math.min(taken, model.wounds);
    model.wounds -= applied;
    damageDealt += applied;
    if (model.wounds <= 0) modelsSlain++;
  }
  log.push({
    step: 'save',
    detail: `${saveableWounds} saves: ${failedSaves} failed`,
    rolls: saveFaces.length ? saveFaces : undefined,
  });

  // Devastating mortal wounds — after the normal damage (06.02/24.10). Each crit inflicts D
  // mortal wounds but can damage at most ONE model (excess lost). Allocation follows the mortal
  // wound rules: wounded non-CHARACTER first, then non-CHARACTERs, then wounded CHARACTERs.
  for (let i = 0; i < devastating; i++) {
    const alive = models.filter((m) => m.wounds > 0);
    if (alive.length === 0) break;
    const target =
      alive.find((m) => !m.character && m.wounds < m.maxW) ??
      alive.find((m) => !m.character) ??
      alive.find((m) => m.wounds < m.maxW) ??
      alive[0]!;
    const { total, rolls } = rollDice(dmgExpr, rng);
    dmgFaces.push(...rolls);
    const rawDmg = Math.max(1, total + meltaBonus - reduction);
    const { taken } = applyFnp(rawDmg, defender.fnp, rng);
    const applied = Math.min(taken, target.wounds); // one model max — excess is lost
    target.wounds -= applied;
    damageDealt += applied;
    if (target.wounds <= 0) modelsSlain++;
  }

  log.push({
    step: 'damage',
    detail: `${failedSaves + devastating} wounds dealt ${damageDealt} damage, ${modelsSlain} model(s) slain`,
    rolls: dmgFaces.length ? dmgFaces : undefined,
  });

  return {
    attacks: totalAttacks,
    hits: kw.torrent && !situation.snapShooting ? totalAttacks : hitsToWound + lethalAutoWounds,
    wounds: saveableWounds,
    devastating,
    failedSaves,
    damageDealt,
    modelsSlain,
    log,
    defenderModels: models,
  };
}
