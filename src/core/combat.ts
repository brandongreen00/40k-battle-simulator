// The combat resolution pipeline — the heart of the rules core (plan §4). PURE; uses injected RNG.
//
// Models one weapon profile fired by `attackerCount` models at one target unit, resolving the
// full 10e sequence: attacks -> hit -> wound -> save -> damage -> allocation, with the universal
// keyword library (keywords.ts) and a `CombatSituation` of modifiers.
//
// Design intent (rule #1 + plan §6): every step reads modifiers from `CombatSituation`. In Phase 3
// the ability/effect hook system computes those modifiers from game events and hands them in here;
// the pipeline itself never needs to know *why* a modifier exists. Keep this deterministic and
// fully driven by the RNG so it can be validated against a dice calculator.

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

/** A target model's live wound state, in allocation order. */
export interface DefenderModel {
  maxW: number;
  wounds: number;
  /** Per-model invuln (e.g. a shield-bearer's 4++), overriding the unit's. */
  invuln?: number;
  /** Per-model armour save, overriding the unit's. */
  save?: number;
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

/** Situational modifiers. Phase 1 derives these from keywords + flags; Phase 3 from ability hooks. */
export interface CombatSituation {
  attackerCount: number; // number of models firing this weapon profile
  hitModifier?: number; // pre-cap; clamped to ±1
  woundModifier?: number; // pre-cap; clamped to ±1
  rapidFireActive?: boolean; // target within half range (Rapid Fire bonus attacks)
  meltaActive?: boolean; // target within half range (Melta bonus damage)
  charged?: boolean; // bearer charged this turn (Lance)
  stationary?: boolean; // bearer Remained Stationary (Heavy)
  longRange?: boolean; // target 12"+ away (Conversion)
  cover?: boolean; // target has the Benefit of Cover
  targetModelCount?: number; // models in the target unit at start of attack (Blast)
  critHitOn?: number; // critical-hit threshold (default 6)
  critWoundOn?: number; // critical-wound threshold (default 6)
  rerollHits?: Reroll;
  rerollWounds?: Reroll;
  damageReduction?: number; // -X to Damage per wound (floored at 1)
  extraAttacks?: number; // +N to the Attacks characteristic per firing model (e.g. First Rank Fire!)
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
  devastating: number; // unsavable wounds (Devastating Wounds)
  failedSaves: number;
  damageDealt: number; // wounds actually removed from models (after FNP/reduction)
  modelsSlain: number;
  log: DiceLogEntry[];
  defenderModels: DefenderModel[]; // updated wound state
}

// ── To-wound chart (10e) ───────────────────────────────────────────────────────
export function woundThreshold(S: number, T: number): number {
  if (S >= 2 * T) return 2;
  if (S > T) return 3;
  if (S === T) return 4;
  if (2 * S > T) return 5; // S < T but more than half
  return 6; // S*2 <= T
}

const clampMod = (m: number | undefined): number => Math.max(-1, Math.min(1, m ?? 0));
const clampThreshold = (t: number): number => Math.max(2, Math.min(6, t));

/**
 * Roll a pool of d6 at `threshold` (+mod, capped ±1), with criticals on `critOn` and one optional
 * re-roll. Unmodified 1 always fails; a critical always succeeds and is counted. Used for both the
 * hit and wound steps (saves are resolved separately — they have no criticals).
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

/** Effective save value (lower is better) after AP, the Benefit of Cover, and any invuln. */
export function effectiveSave(
  save: number,
  ap: number,
  invuln: number | undefined,
  cover: boolean,
): number {
  let armour = save - ap; // ap <= 0, so this worsens (raises) the value
  if (cover) {
    let improved = armour - 1;
    // Cover cannot improve a save to better than 3+ unless the attack is AP 0 (10e Core).
    if (ap !== 0) improved = Math.max(3, improved);
    armour = Math.min(armour, improved);
  }
  return Math.min(armour, invuln ?? 99);
}

/** Apply Feel No Pain to a damage amount: each point negated on a `fnp`+ roll. */
function applyFnp(dmg: number, fnp: number | undefined, rng: RNG): { taken: number; rolls: number[] } {
  if (!fnp || dmg <= 0) return { taken: dmg, rolls: [] };
  const rolls = rng.roll(dmg);
  const negated = rolls.filter((r) => r >= fnp).length;
  return { taken: dmg - negated, rolls };
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

  // ── 1. Number of attacks ─────────────────────────────────────────────────────
  const attacksExpr = parseDice(weapon.attacks);
  const blastBonus = kw.blast ? Math.floor((situation.targetModelCount ?? models.length) / 5) : 0;
  const rapidBonus = kw.rapidFire && situation.rapidFireActive ? kw.rapidFire : 0;
  const extra = situation.extraAttacks ?? 0; // +N Attacks per model (e.g. First Rank Fire!)
  let totalAttacks = 0;
  const attackRolls: number[] = [];
  for (let i = 0; i < situation.attackerCount; i++) {
    const { total, rolls } = rollDice(attacksExpr, rng);
    attackRolls.push(...rolls);
    totalAttacks += total + rapidBonus + blastBonus + extra;
  }
  log.push({
    step: 'attacks',
    detail:
      `${situation.attackerCount}× ${weapon.name}: ${totalAttacks} attacks` +
      (rapidBonus ? ` (+${rapidBonus} Rapid Fire)` : '') +
      (blastBonus ? ` (+${blastBonus} Blast)` : ''),
    rolls: attackRolls.length ? attackRolls : undefined,
  });

  // ── 2. Hit roll ──────────────────────────────────────────────────────────────
  let hitsToWound: number;
  let lethalAutoWounds = 0;
  if (kw.torrent) {
    hitsToWound = totalAttacks;
    log.push({ step: 'hit', detail: `Torrent: ${totalAttacks} automatic hits` });
  } else {
    const hitMod = clampMod(situation.hitModifier) + (kw.heavy && situation.stationary ? 1 : 0);
    let critHitOn = clampThreshold(situation.critHitOn ?? 6);
    if (kw.conversion && situation.longRange) critHitOn = Math.min(critHitOn, 5);
    const { successes, crits, faces } = rollPool(
      totalAttacks,
      weapon.skill,
      clampMod(hitMod),
      critHitOn,
      situation.rerollHits ?? 'none',
      rng,
    );
    const sustained = kw.sustainedHits ? crits * kw.sustainedHits : 0;
    lethalAutoWounds = kw.lethalHits ? crits : 0;
    hitsToWound = successes - lethalAutoWounds + sustained;
    log.push({
      step: 'hit',
      detail:
        `${successes} hits (${crits} crit)` +
        (sustained ? ` +${sustained} Sustained` : '') +
        (lethalAutoWounds ? `, ${lethalAutoWounds} Lethal auto-wound` : ''),
      rolls: faces,
    });
  }

  // ── 3. Wound roll ──────────────────────────────────────────────────────────────
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
  const devastating = kw.devastatingWounds ? woundCrits : 0;
  const saveableWounds = woundSucc - devastating + lethalAutoWounds;
  log.push({
    step: 'wound',
    detail:
      `${woundSucc} wounds (need ${baseWoundThreshold}+, ${woundCrits} crit)` +
      (devastating ? `, ${devastating} Devastating (no save)` : '') +
      (lethalAutoWounds ? `, +${lethalAutoWounds} from Lethal Hits` : ''),
    rolls: woundFaces,
  });

  // ── 4 + 5. Allocate → save → damage, one model at a time ─────────────────────────
  // Each wound is allocated to a target model before its save is rolled, so a model's own
  // invuln/armour (e.g. a shield-bearer's 4++) is used. Allocation follows 10e: wounds go to the
  // current "lead" model (first with wounds remaining) until it dies, then the next. Devastating
  // Wounds skip the save step. No damage spills between models.
  const cover = situation.cover && !kw.ignoresCover;
  const dmgExpr = parseDice(weapon.D);
  const meltaBonus = kw.melta && situation.meltaActive ? kw.melta : 0;
  const reduction = situation.damageReduction ?? 0;

  let failedSaves = 0;
  let damageDealt = 0;
  let modelsSlain = 0;
  const saveFaces: number[] = [];
  const dmgFaces: number[] = [];
  const savesByValue = new Map<number, number>(); // for the log: final-save value → count taken

  const totalWounds = saveableWounds + devastating;
  let cursor = models.findIndex((m) => m.wounds > 0);
  for (let i = 0; i < totalWounds && cursor !== -1; i++) {
    const isDevastating = i >= saveableWounds; // the trailing `devastating` wounds allow no save
    const model = models[cursor]!;
    let woundGetsThrough = isDevastating;

    if (!isDevastating) {
      const finalSave = effectiveSave(model.save ?? defender.save, weapon.AP, model.invuln ?? defender.invuln, !!cover);
      savesByValue.set(finalSave, (savesByValue.get(finalSave) ?? 0) + 1);
      const r = rng.d6();
      saveFaces.push(r);
      if (r === 1 || r < finalSave) {
        failedSaves++;
        woundGetsThrough = true;
      }
    }

    if (woundGetsThrough) {
      const { total, rolls } = rollDice(dmgExpr, rng);
      dmgFaces.push(...rolls);
      const rawDmg = Math.max(1, total + meltaBonus - reduction);
      const { taken } = applyFnp(rawDmg, defender.fnp, rng);
      const applied = Math.min(taken, model.wounds);
      model.wounds -= applied;
      damageDealt += applied;
      if (model.wounds <= 0) {
        modelsSlain++;
        cursor = models.findIndex((m) => m.wounds > 0);
      }
    }
  }

  const saveSummary = [...savesByValue.entries()]
    .map(([s, n]) => `${n}@${s > 6 ? '—' : s + '+'}`)
    .join(', ');
  log.push({
    step: 'save',
    detail: `${saveableWounds} saves (${saveSummary || '—'})${cover ? ' (cover)' : ''}: ${failedSaves} failed`,
    rolls: saveFaces,
  });
  log.push({
    step: 'damage',
    detail: `${failedSaves + devastating} wounds dealt ${damageDealt} damage, ${modelsSlain} model(s) slain`,
    rolls: dmgFaces.length ? dmgFaces : undefined,
  });

  return {
    attacks: totalAttacks,
    hits: kw.torrent ? totalAttacks : hitsToWound + lethalAutoWounds,
    wounds: saveableWounds,
    devastating,
    failedSaves,
    damageDealt,
    modelsSlain,
    log,
    defenderModels: models,
  };
}
