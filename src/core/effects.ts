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
  /** The attack's Strength and the target's Toughness (S-vs-T-conditional effects, e.g.
   *  Refusal to Yield / Honoured Knights: -1 to wound when S > T). */
  attackS?: number;
  targetT?: number;
  /** The weapon's name, lower-cased (weapon-scoped grants, e.g. Psi-reactive Ammunition). */
  weaponName?: string;
  /** The datasheet the weapon is fired from (model-scoped abilities on merged units, e.g.
   *  Zealot buffs only Teguen's own melee weapon). */
  weaponSourceDsId?: string;
  /** The target unit is at-or-below half-strength (Merciless Judgement). */
  targetBelowHalf?: boolean;
  /** The target unit is within range of an objective (Loyal to the Cause, Breach and Clear). */
  targetOnObjective?: boolean;
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
  grantPrecision?: boolean; // the bearer's weapons gain [PRECISION] (Epic Challenge)
  grantLethalHits?: boolean; // the bearer's weapons gain [LETHAL HITS] (Dispense Justice)
  grantPsychic?: boolean; // the bearer's weapons gain [PSYCHIC] (Psi-reactive Ammunition)
  grantSustained?: number; // the bearer's weapons gain [SUSTAINED HITS N] (Holy Hatred)
  strengthBonus?: number; // +N to the attack's Strength (Zealot: +3 A and S)
  rerollOneHit?: boolean; // re-roll ONE failed hit roll per attack sequence (Sanctified Auspexes)
  apSet?: number; // the attack's AP becomes N if better than its own (Overkill: -4 AP)
  ignoreBadHitMods?: boolean; // ignore negative BS/hit-roll modifiers (Superior Weapon Support System)
  apImprove?: number; // improve the attack's AP by N (Target Weak Spot: AP -1 → -2)
  // Defensive (the bearer is being attacked)
  toBeHitModifier?: number; // e.g. Stealth -1 (subtracts from the attacker's hit roll)
  damageReduction?: number; // e.g. -1 Damage
  fnp?: number; // Feel No Pain value
  invulnFloor?: number; // grant/raise an invuln (e.g. a 4++ from a Displacer Field)
  saveBonus?: number; // +N to the Save characteristic, capped at 3+ (e.g. Take Cover!)
  grantCover?: boolean; // the bearer has the Benefit of Cover (Smoke Grenades enhancement)
  apWorsen?: number; // incoming attacks lose N AP, floored at AP 0 (Urban Enforcers "-1 AP")
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
  'lethal_hits_granted': { id: 'lethal_hits_granted', name: 'Lethal Hits (granted)', side: 'attacker', output: { grantLethalHits: true } },
  'sustained_hits_1_granted': { id: 'sustained_hits_1_granted', name: 'Sustained Hits 1 (granted)', side: 'attacker', output: { critHitOn: 6 } },
  'ignores_cover_granted': { id: 'ignores_cover_granted', name: 'Ignores Cover (granted)', side: 'attacker', output: { ignoresCover: true } },
  // Epic Challenge (15.03): the CHARACTER's melee weapons gain [PRECISION] for the phase.
  'precision_melee': { id: 'precision_melee', name: 'Epic Challenge ([PRECISION] melee)', side: 'attacker', appliesTo: melee, output: { grantPrecision: true } },
  // Execution Order (Purgation Force): [PRECISION] on all the unit's weapons. Approximation:
  // the "only against the chosen CHARACTER unit" rider is the player's/AI's aim, not enforced.
  'precision_granted': { id: 'precision_granted', name: '[PRECISION] (granted)', side: 'attacker', output: { grantPrecision: true } },
  // Stun Grenades (Purgation Force): applied to the ENEMY unit — its attacks take -1 to hit
  // until the effect expires. (The battle-shock test half is rolled by the owner, not automated.)
  'stunned': { id: 'stunned', name: 'Stunned (-1 to hit)', side: 'attacker', output: { hitModifier: -1 } },
  // Counteroffensive (15.12) grants Fights First — read by phases.hasFightsFirst, not the
  // attack pipeline; registered so the effect applicator can list/apply it.
  'fights_first_granted': { id: 'fights_first_granted', name: 'Fights First (granted)', side: 'attacker', output: {} },

  // ── Enhancement-driven building blocks ───────────────────────────────────────
  // Witch Hunter (Purgation Force): while the bearer leads, re-roll Hit rolls vs PSYKER units.
  'enh:witch_hunter': {
    id: 'enh:witch_hunter', name: 'Witch Hunter (re-roll hits vs PSYKER)', side: 'attacker',
    appliesTo: (c) => c.targetKeywords.includes('PSYKER'), output: { rerollHits: 'fail' },
  },
  // Drill Commander (Combined Arms): ranged crits on unmodified 5+ while Remained Stationary
  // (the stationary gate lives in enhancements.enhancementEffectIds).
  'enh:crit5_ranged': { id: 'enh:crit5_ranged', name: 'Drill Commander (crit 5+)', side: 'attacker', appliesTo: ranged, output: { critHitOn: 5 } },
  // Aquilan Eye (Grizzled Company) — Target Weak Spot (Order): AP +1 within 12".
  'order:target_weak_spot': {
    id: 'order:target_weak_spot', name: 'Target Weak Spot (Order)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'ranged' && c.gap <= 12, output: { apImprove: 1 },
  },
  // Spec Ops Veteran (Grizzled Company) — Move to the Shadows (Order): Stealth vs ranged attacks.
  'order:move_to_shadows': {
    id: 'order:move_to_shadows', name: 'Move to the Shadows (Order)', side: 'defender',
    appliesTo: ranged, output: { toBeHitModifier: -1 },
  },
  // Smoke Grenades (Mechanised Assault): Benefit of Cover + Stealth near a friendly TRANSPORT
  // (the proximity gate lives in enhancements.enhancementEffectIds).
  'enh:smoke_cover': {
    id: 'enh:smoke_cover', name: 'Smoke Grenades (cover + stealth)', side: 'defender',
    appliesTo: ranged, output: { toBeHitModifier: -1, grantCover: true },
  },

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

  // ── Combat Patrol stratagem building blocks (tools/combatpatrol extracted texts) ──
  // Superior Weaponry (Inquisitor's Hand): the unit's attacks have +1 AP this phase.
  'cp:ap_boost': { id: 'cp:ap_boost', name: 'Superior Weaponry (+1 AP)', side: 'attacker', output: { apImprove: 1 } },
  // Urban Enforcers (Inquisitor's Hand): attacks that target the unit have -1 AP.
  'cp:ap_shield': { id: 'cp:ap_shield', name: 'Urban Enforcers (-1 AP incoming)', side: 'defender', output: { apWorsen: 1 } },
  // Refusal to Yield (Crowe's Sanctifiers): ranged attacks with S greater than the unit's T get
  // -1 to wound. (Honoured Knights uses the same block in melee — bound with the specials pass.)
  'cp:wound_shield_strong': {
    id: 'cp:wound_shield_strong', name: 'Refusal to Yield (-1 to wound if S > T)', side: 'defender',
    appliesTo: (c) => c.weaponType === 'ranged' && (c.attackS ?? 0) > (c.targetT ?? 99),
    output: { woundModifier: -1 },
  },
  // Mission Focus (Vengeful Brethren): +1 to hit ("within range of an objective" is validated
  // when the stratagem is played, not re-checked per attack — noted simplification).
  'cp:plus1_hit': { id: 'cp:plus1_hit', name: 'Mission Focus (+1 to hit)', side: 'attacker', output: { hitModifier: 1 } },
  // Psi-reactive Ammunition (Crowe's Sanctifiers): storm bolters gain [PSYCHIC] — psychic
  // attacks ignore negative hit modifiers (24.29, combat.ts).
  'cp:psychic_ammo': {
    id: 'cp:psychic_ammo', name: 'Psi-reactive Ammunition ([PSYCHIC] storm bolters)', side: 'attacker',
    appliesTo: (c) => (c.weaponName ?? '').includes('storm bolter'), output: { grantPsychic: true },
  },
  // Exigent Assignments (Crowe's Sanctifiers): the next consolidation moves up to D3+3"
  // (read by engine.resolveFightMove, not the attack pipeline).
  'cp:consolidate_extended': { id: 'cp:consolidate_extended', name: 'Exigent Assignments (consolidate D3+3")', side: 'attacker', output: {} },
  // For the Lion (Vengeful Brethren): +1 OC until the end of the turn (read by the OC sums).
  'cp:oc_plus1': { id: 'cp:oc_plus1', name: 'For the Lion (+1 OC)', side: 'defender', output: {} },

  // ── Combat Patrol per-unit specials (step 4; bound via abilities.cpInnateEffectIds or plays) ──
  // FOESIGHT (Castellan Crowe): attacks that target a CHARACTER unit can re-roll hit rolls.
  'cp:foesight': {
    id: 'cp:foesight', name: 'Foesight (re-roll hits vs CHARACTER)', side: 'attacker',
    appliesTo: (c) => c.targetKeywords.includes('CHARACTER'), output: { rerollHits: 'fail' },
  },
  // FORCE EDGE (Brotherhood Terminators): melee attacks vs non-MONSTER/VEHICLE have +1 AP.
  'cp:force_edge': {
    id: 'cp:force_edge', name: 'Force Edge (+1 AP melee)', side: 'attacker',
    appliesTo: (c) =>
      c.weaponType === 'melee' && !c.targetKeywords.includes('MONSTER') && !c.targetKeywords.includes('VEHICLE'),
    output: { apImprove: 1 },
  },
  // HOLY HATRED (Preacher Teguen): while attached, the unit's melee attacks have [SUSTAINED HITS 1].
  'cp:holy_hatred': {
    id: 'cp:holy_hatred', name: 'Holy Hatred ([SUSTAINED HITS 1] melee)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'melee', output: { grantSustained: 1 },
  },
  // MERCILESS JUDGEMENT (Vigilant Squad): ranged attacks vs a below-half-strength unit +1 to wound.
  'cp:merciless_judgement': {
    id: 'cp:merciless_judgement', name: 'Merciless Judgement (+1 wound vs below half)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'ranged' && !!c.targetBelowHalf, output: { woundModifier: 1 },
  },
  // LOYAL TO THE CAUSE (Inquisitorial Agents): -1 to wound while within range of an objective.
  'cp:loyal_to_the_cause': {
    id: 'cp:loyal_to_the_cause', name: 'Loyal to the Cause (-1 wound on an objective)', side: 'defender',
    appliesTo: (c) => !!c.targetOnObjective, output: { woundModifier: -1 },
  },
  // GRAVIS PROTECTION (Master Zacharial): attacks that target this unit have -1 D.
  'cp:gravis_protection': { id: 'cp:gravis_protection', name: 'Gravis Protection (-1 Damage)', side: 'defender', output: { damageReduction: 1 } },
  // Superior Weapon Support System (Commander Cloudspear): ranged attacks ignore BS/hit maluses.
  'cp:swss': {
    id: 'cp:swss', name: 'Superior Weapon Support System (ignore hit maluses)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'ranged', output: { ignoreBadHitMods: true },
  },
  // Breach and Clear (Breacher Team): ranged attacks vs a unit on an objective re-roll wounds.
  'cp:breach_and_clear': {
    id: 'cp:breach_and_clear', name: 'Breach and Clear (re-roll wounds vs objective holders)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'ranged' && !!c.targetOnObjective, output: { rerollWounds: 'fail' },
  },
  // ZEALOT (Preacher Teguen, once per battle): his melee attacks have +3 A and S.
  'cp:zealot': {
    id: 'cp:zealot', name: 'Zealot (+3 A and S)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'melee' && c.weaponSourceDsId === 'cp-inquisitors-hand-preacher-teguen',
    output: { extraAttacks: 3, strengthBonus: 3 },
  },
  // OVERKILL (Eversor Assassin, once per battle): melee attacks have -4 AP (read: AP becomes -4).
  'cp:overkill': {
    id: 'cp:overkill', name: 'Overkill (AP -4 melee)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'melee' && c.weaponSourceDsId === 'cp-inquisitors-hand-eversor-assassin',
    output: { apSet: -4 },
  },
  // BLADEGUARD (once per turn): +1 to hit in melee, OR -1 to be hit while in guard.
  'cp:bladeguard_hit': {
    id: 'cp:bladeguard_hit', name: 'Bladeguard (+1 to hit melee)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'melee', output: { hitModifier: 1 },
  },
  'cp:bladeguard_stance': { id: 'cp:bladeguard_stance', name: 'Bladeguard (-1 to be hit)', side: 'defender', output: { toBeHitModifier: -1 } },
  // Honoured Knights (Vengeful Brethren, patrol rule): defence stance after being charged —
  // attacks with S greater than the unit's T have -1 to wound (any weapon type).
  'cp:defence_stance': {
    id: 'cp:defence_stance', name: 'Defence stance (-1 to wound if S > T)', side: 'defender',
    appliesTo: (c) => (c.attackS ?? 0) > (c.targetT ?? 99), output: { woundModifier: -1 },
  },
  // Guidance of the Ancients (Venerable Dreadnought): after it shoots, one enemy unit it hit
  // takes +1 to be hit by friendly ranged attacks (simplification: any ranged attacker, and the
  // mark expires at the enemy's turn start rather than the phase end).
  'cp:guided_target': {
    id: 'cp:guided_target', name: 'Guidance of the Ancients (+1 to be hit)', side: 'defender',
    appliesTo: (c) => c.weaponType === 'ranged', output: { toBeHitModifier: 1 },
  },
  // Co-ordinated Eradication (Sudden Dawn Cadre, once per battle per army): SDC attacks against
  // the marked enemy have +1 AP until the end of the battle (permanent defender-side mark).
  'cp:eradication_mark': { id: 'cp:eradication_mark', name: 'Co-ordinated Eradication (+1 AP incoming)', side: 'defender', output: { apImprove: 1 } },

  // ── Combat Patrol enhancements + fights-on-death (step 5) ─────────────────────
  // Determined to the Last (VB stratagem) / Killer Reflexes (IH enhancement): destroyed models
  // fight on before removal — a MARKER read by the engine's melee resolution, not an attack mod.
  'cp:fights_on_death': { id: 'cp:fights_on_death', name: 'Fights on death (2+ to fight before removal)', side: 'defender', output: {} },
  // Sanctified Auspexes (Venerable Dreadnought): ranged attacks re-roll one hit roll.
  'cp:reroll_one_hit': {
    id: 'cp:reroll_one_hit', name: 'Sanctified Auspexes (re-roll one hit)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'ranged', output: { rerollOneHit: true },
  },
  // Purifying Force (Brotherhood Terminators, once per battle per army): [LETHAL HITS] melee.
  'cp:lethal_melee': {
    id: 'cp:lethal_melee', name: 'Purifying Force ([LETHAL HITS] melee)', side: 'attacker',
    appliesTo: (c) => c.weaponType === 'melee', output: { grantLethalHits: true },
  },
  // Sanctic Slayers (Teguen enhancement, once per turn): the chosen unit's attacks get +1 to
  // wound when the target's T is greater than or equal to the attack's S.
  'cp:wound_boost_weak': {
    id: 'cp:wound_boost_weak', name: 'Sanctic Slayers (+1 wound when T ≥ S)', side: 'attacker',
    appliesTo: (c) => (c.targetT ?? 0) >= (c.attackS ?? 999), output: { woundModifier: 1 },
  },
  // Proximity Scanners (Devilfish enhancement): disembarked riders' pulse weapons get +1 A.
  'cp:pulse_bonus': {
    id: 'cp:pulse_bonus', name: 'Proximity Scanners (+1 A pulse weapons)', side: 'attacker',
    appliesTo: (c) => !!c.weaponName && (c.weaponName.includes('pulse blaster') || c.weaponName.includes('pulse carbine')),
    output: { extraAttacks: 1 },
  },
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
  grantPrecision: boolean;
  grantLethalHits: boolean;
  grantPsychic: boolean;
  grantSustained: number;
  strengthBonus: number;
  apSet?: number;
  ignoreBadHitMods: boolean;
  rerollOneHit: boolean;
  apImprove: number;
  apWorsen: number;
  grantCover: boolean;
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
    grantPrecision: false,
    grantLethalHits: false,
    grantPsychic: false,
    grantSustained: 0,
    strengthBonus: 0,
    apSet: undefined as number | undefined,
    ignoreBadHitMods: false,
    rerollOneHit: false,
    apImprove: 0,
    apWorsen: 0,
    grantCover: false,
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
    if (out.grantPrecision) acc.grantPrecision = true;
    if (out.grantLethalHits) acc.grantLethalHits = true;
    if (out.grantPsychic) acc.grantPsychic = true;
    if (out.grantSustained) acc.grantSustained = Math.max(acc.grantSustained, out.grantSustained);
    if (out.strengthBonus) acc.strengthBonus += out.strengthBonus;
    if (out.apSet != null) acc.apSet = Math.min(acc.apSet ?? 0, out.apSet);
    if (out.ignoreBadHitMods) acc.ignoreBadHitMods = true;
    if (out.rerollOneHit) acc.rerollOneHit = true;
    if (out.apImprove) acc.apImprove += out.apImprove;
    if (out.apWorsen) acc.apWorsen += out.apWorsen;
    if (out.grantCover) acc.grantCover = true;
  };

  for (const id of attackerEffects) apply(id, 'attacker');
  for (const id of defenderEffects) apply(id, 'defender');
  return acc;
}
