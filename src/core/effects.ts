// The ability / effect hook system (plan §6) — the part that makes 40k *40k*. PURE.
//
// Design: a generic effect engine + bespoke hooks, registered by id. The combat pipeline never
// hard-codes any specific rule; instead, before resolving an attack the engine gathers the
// `EffectOutput`s of every active effect on the attacker (offensive) and target (defensive) and
// merges them into the `CombatSituation` modifiers that combat.ts already reads. Adding a new
// ability/Order/stratagem is therefore ~a registry entry, not a pipeline change.
//
// Effects come from three sources, all funnelled through the same registry:
//   • innate datasheet abilities (e.g. a unit that always has Feel No Pain),
//   • AM Orders (a temporary effect issued in the Command phase, expiring end of turn),
//   • Stratagems (a temporary effect, possibly applied reactively in the opponent's turn).
//
// NOTE ON SCOPE: the *specific* detachment rules, ~25 stratagems, and per-unit specials of the
// three owned lists need those list files to enumerate. This module ships the engine plus a
// representative, mechanically-correct effect set (the universal building blocks they are made of).
// Binding a named Order/Stratagem to one of these effects is a one-line registry addition.

import type { ParsedKeywords } from './keywords';
import type { Reroll } from './combat';

/** Everything an effect needs to decide whether and how it applies to one attack. */
export interface AttackContext {
  phase: 'shooting' | 'fight';
  weaponType: 'ranged' | 'melee';
  weaponKeywords: ParsedKeywords;
  attackerKeywords: string[]; // datasheet unit keywords, upper-cased
  targetKeywords: string[];
  gap: number; // base-to-base, inches
}

/** The modifiers an effect can contribute. Offensive and defensive effects use different fields. */
export interface EffectOutput {
  // Offensive (the bearer is attacking)
  hitModifier?: number;
  woundModifier?: number;
  rerollHits?: Reroll;
  rerollWounds?: Reroll;
  critHitOn?: number;
  critWoundOn?: number;
  ignoresCover?: boolean;
  extraAttacks?: number; // +N to the Attacks characteristic, per firing model (e.g. First Rank Fire!)
  // Defensive (the bearer is being attacked)
  toBeHitModifier?: number; // e.g. Stealth -1 (subtracts from the attacker's hit roll)
  damageReduction?: number; // e.g. -1 Damage
  fnp?: number; // Feel No Pain value
  invulnFloor?: number; // grant/raise an invuln (e.g. a 4++ from a Displacer Field)
  saveBonus?: number; // +N to the Save characteristic, capped at 3+ (e.g. Take Cover!)
}

export interface Effect {
  id: string;
  name: string;
  side: 'attacker' | 'defender';
  /** Optional gate: phase / weapon type / keyword / range conditions. */
  appliesTo?: (ctx: AttackContext) => boolean;
  output: EffectOutput | ((ctx: AttackContext) => EffectOutput);
}

const rerollRank: Record<Reroll, number> = { none: 0, ones: 1, fail: 2, all: 3 };
const bestReroll = (a: Reroll | undefined, b: Reroll | undefined): Reroll =>
  rerollRank[a ?? 'none'] >= rerollRank[b ?? 'none'] ? a ?? 'none' : b ?? 'none';

const ranged = (c: AttackContext) => c.weaponType === 'ranged';
const melee = (c: AttackContext) => c.weaponType === 'melee';

/**
 * The curated effect registry. Each entry is a small, mechanically-unambiguous building block.
 * Named Orders / stratagems / detachment rules from the three lists map onto these (or add their
 * own entries) once those lists are supplied.
 */
export const EFFECT_REGISTRY: Record<string, Effect> = {
  // ── Offensive building blocks (Orders, buffs) ────────────────────────────────
  'order:take_aim': { id: 'order:take_aim', name: 'Take Aim!', side: 'attacker', appliesTo: ranged, output: { hitModifier: 1 } },
  'order:fix_bayonets': { id: 'order:fix_bayonets', name: 'Fix Bayonets!', side: 'attacker', appliesTo: melee, output: { hitModifier: 1 } },
  // First Rank, Fire! Second Rank, Fire! — +1 Attack to Rapid Fire weapons.
  'order:first_rank_fire': {
    id: 'order:first_rank_fire', name: 'First Rank, Fire! Second Rank, Fire!', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'ranged' && !!c.weaponKeywords.rapidFire, output: { extraAttacks: 1 },
  },
  'reroll_hits_1': { id: 'reroll_hits_1', name: 'Re-roll Hit rolls of 1', side: 'attacker', output: { rerollHits: 'ones' } },
  'reroll_wounds_1': { id: 'reroll_wounds_1', name: 'Re-roll Wound rolls of 1', side: 'attacker', output: { rerollWounds: 'ones' } },
  'plus1_to_wound': { id: 'plus1_to_wound', name: '+1 to Wound', side: 'attacker', output: { woundModifier: 1 } },
  'lethal_hits_granted': { id: 'lethal_hits_granted', name: 'Lethal Hits (granted)', side: 'attacker', output: { critHitOn: 6 } },
  'sustained_hits_1_granted': { id: 'sustained_hits_1_granted', name: 'Sustained Hits 1 (granted)', side: 'attacker', output: { critHitOn: 6 } },
  'ignores_cover_granted': { id: 'ignores_cover_granted', name: 'Ignores Cover (granted)', side: 'attacker', output: { ignoresCover: true } },

  // ── Defensive building blocks (stratagems, unit specials) ─────────────────────
  'minus1_damage': { id: 'minus1_damage', name: '-1 Damage', side: 'defender', output: { damageReduction: 1 } },
  'fnp_4': { id: 'fnp_4', name: 'Feel No Pain 4+', side: 'defender', output: { fnp: 4 } },
  'fnp_5': { id: 'fnp_5', name: 'Feel No Pain 5+', side: 'defender', output: { fnp: 5 } },
  'fnp_6': { id: 'fnp_6', name: 'Feel No Pain 6+', side: 'defender', output: { fnp: 6 } },
  'stealth': { id: 'stealth', name: 'Stealth (-1 to be hit)', side: 'defender', appliesTo: ranged, output: { toBeHitModifier: -1 } },
  // Take Cover! — +1 to the Save characteristic (the engine caps the improvement at 3+).
  'order:take_cover': { id: 'order:take_cover', name: 'Take Cover!', side: 'defender', output: { saveBonus: 1 } },
  // A reactive defensive save buff in the mould of a Displacer Field's protective effect.
  'displacer_field': { id: 'displacer_field', name: 'Displacer Field (4++)', side: 'defender', output: { invulnFloor: 4 } },
  // Imperialis Fleet "At all Costs": Eliminate marks an enemy unit (+1 to be hit by your army);
  // Acquire grants the holding unit a 5+ invuln (its +1 OC/Ld are applied via core/orders.ts).
  'mark_eliminate': { id: 'mark_eliminate', name: 'Eliminate At All Costs (+1 to hit)', side: 'defender', output: { toBeHitModifier: 1 } },
  'acquire_buff': { id: 'acquire_buff', name: 'Acquire At All Costs (5++, +1 OC/Ld)', side: 'defender', output: { invulnFloor: 5 } },
};

/** Merge the gathered modifiers for one attack. `attacker`/`defender` are lists of effect ids. */
export function gatherAttackModifiers(
  ctx: AttackContext,
  attackerEffects: string[],
  defenderEffects: string[],
): {
  hitModifier: number;
  woundModifier: number;
  rerollHits: Reroll;
  rerollWounds: Reroll;
  critHitOn?: number;
  critWoundOn?: number;
  ignoresCover: boolean;
  damageReduction: number;
  extraAttacks: number;
  saveBonus: number;
  fnp?: number;
  invulnFloor?: number;
} {
  const acc = {
    hitModifier: 0,
    woundModifier: 0,
    rerollHits: 'none' as Reroll,
    rerollWounds: 'none' as Reroll,
    critHitOn: undefined as number | undefined,
    critWoundOn: undefined as number | undefined,
    ignoresCover: false,
    damageReduction: 0,
    extraAttacks: 0,
    saveBonus: 0,
    fnp: undefined as number | undefined,
    invulnFloor: undefined as number | undefined,
  };

  const apply = (id: string, expectedSide: 'attacker' | 'defender') => {
    const eff = EFFECT_REGISTRY[id];
    if (!eff || eff.side !== expectedSide) return;
    if (eff.appliesTo && !eff.appliesTo(ctx)) return;
    const out = typeof eff.output === 'function' ? eff.output(ctx) : eff.output;
    if (out.hitModifier) acc.hitModifier += out.hitModifier;
    if (out.woundModifier) acc.woundModifier += out.woundModifier;
    if (out.toBeHitModifier) acc.hitModifier += out.toBeHitModifier; // defender lowers attacker hit
    if (out.rerollHits) acc.rerollHits = bestReroll(acc.rerollHits, out.rerollHits);
    if (out.rerollWounds) acc.rerollWounds = bestReroll(acc.rerollWounds, out.rerollWounds);
    if (out.critHitOn != null) acc.critHitOn = Math.min(acc.critHitOn ?? 6, out.critHitOn);
    if (out.critWoundOn != null) acc.critWoundOn = Math.min(acc.critWoundOn ?? 6, out.critWoundOn);
    if (out.ignoresCover) acc.ignoresCover = true;
    if (out.damageReduction) acc.damageReduction += out.damageReduction;
    if (out.extraAttacks) acc.extraAttacks += out.extraAttacks;
    if (out.saveBonus) acc.saveBonus = Math.max(acc.saveBonus, out.saveBonus);
    if (out.fnp != null) acc.fnp = Math.min(acc.fnp ?? 7, out.fnp);
    if (out.invulnFloor != null) acc.invulnFloor = Math.min(acc.invulnFloor ?? 7, out.invulnFloor);
  };

  for (const id of attackerEffects) apply(id, 'attacker');
  for (const id of defenderEffects) apply(id, 'defender');
  return acc;
}
