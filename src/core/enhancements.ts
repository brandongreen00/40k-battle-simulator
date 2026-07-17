// Enhancement effects (the in-game half of the list-builder's enhancement picks). PURE — no
// React, no DOM, no I/O; imports only types. Keys are the Wahapedia enhancement ids committed in
// data/game/enhancements.json (stable across ingests).
//
// A unit carries its roster entry's `enhancementId` onto the battlefield (UnitInstance /
// attachedLeaders[]). This module maps those ids to mechanics through several seams:
//   • STATIC_EFFECTS / conditional effects → EFFECT_REGISTRY ids merged into every attack
//     (engine.effectsOf), e.g. Veteran Crew's re-roll 1s, Blackweave Shroud's FNP 4+.
//   • WEAPON_GRANTS → extra weapon abilities applied ONLY to weapons fired from the BEARER's
//     datasheet (a merged Leader's own guns), e.g. Ignis Judicium's [DEVASTATING WOUNDS]+[MELTA 1].
//   • deploy grants → Infiltrators / Deep Strike / Scouts at set-up time (Beacon Angelis,
//     Survival Gear), incl. army-wide Declare Battle Formations picks (Clandestine Operation).
//   • REDEPLOY_RULES → post-deployment redeploys in the Warrant-of-Trade mould (Liber Heresius).
//   • small carve-outs read directly by the engine/reducer: Fire-Overwatch immunity, OC/Ld/W
//     bonuses, Death Mask's battle-shock OC floor, Vanguard Honours / Assault Hatches disembark
//     riders, Priority-drop Beacon's round-1 Deep Strike, Digital Weapons' fight-time mortals.
//
// The full status of all 64 enhancements (bound / partial / text-only + reasons) is documented in
// docs/enhancements.md.

import type { Datasheet, GameState, UnitInstance } from './types';
import type { EngineContext } from './engine';
import { gapBetweenBases } from './geometry';

// ── ids (names in comments; see data/game/enhancements.json) ─────────────────
export const ENH = {
  // Imperialis Fleet
  CLANDESTINE_OPERATION: '000009138002',
  COMBAT_LANDERS: '000009138003',
  DIGITAL_WEAPONS: '000009138004',
  FLEETMASTER: '000009138005', // text-only (0 CP stratagem plays)
  // Ordo Hereticus Purgation Force
  IGNIS_JUDICIUM: '000009130002',
  LIBER_HERESIUS: '000009130003',
  NO_ESCAPE: '000009130004', // text-only (Fall Back Ld-test aura)
  WITCH_HUNTER: '000009130005',
  // Ordo Xenos Alien Hunters
  AMULET_AUTO_CHASTISEMENT: '000009126002', // text-only (reactive shooting debuff)
  BEACON_ANGELIS: '000009126003',
  BLACKWEAVE_SHROUD: '000009126004',
  UNIVERSAL_ANATHEMA: '000009126005',
  // Ordo Malleus Daemon Hunters
  DAEMON_SLAYER: '000009134002',
  FORMIDABLE_RESOLVE: '000009134003',
  GIFT_OF_THE_PRESCIENT: '000009134004', // text-only (Grey Knights carve-out)
  GRIMOIRE_TRUE_NAMES: '000009134005', // text-only (enemy Ld aura)
  // Veiled Blade Elimination Force
  DECOY_TARGETS: '000009757002', // text-only (teleport swap)
  ESOTERIC_EXPLOSIVES: '000009757003', // text-only (Grenades interaction)
  INTRANEURAL_BIOTECH: '000009757004', // text-only (0 CP stratagem plays)
  MICROMELTA_ROUNDS: '000009757005',
  // Grizzled Company
  ABHUMAN_DETAIL: '000010637002', // text-only (no Ogryn units in the owned data pool)
  AQUILAN_EYE: '000010637003',
  SPEC_OPS_VETERAN: '000010637004',
  LAUD_HAILER: '000010637005',
  // Combined Arms
  DEATH_MASK: '000008380002',
  DRILL_COMMANDER: '000008380003',
  GRAND_STRATEGIST_CA: '000008380004',
  REACTIVE_COMMAND: '000008380005', // text-only (event-driven Order)
  // Hammer of the Emperor
  CALM_UNDER_FIRE: '000009865002', // text-only (Order echo)
  INDOMITABLE_STEED: '000009865003',
  REGIMENTAL_BANNER: '000009865004',
  VETERAN_CREW: '000009865005',
  // Siege Regiment
  EAGER_ADVANCE: '000009857002',
  FLASH_GRENADES: '000009857003',
  LEGACY_SIDEARM: '000009857004',
  STALWARTS_HONOURS: '000009857005',
  // Steel Hammer
  BATTALION_COMMANDER: '000010787002',
  TITAN_KILLER: '000010787003', // text-only (damage re-roll not in the combat pipeline)
  ENGINE_SPEAKER: '000010787004', // text-only
  ASSAULT_HATCHES: '000010787005',
  // Armoured Infantry
  EXEMPLARY_OFFICER: '000010791002', // text-only (Order echo)
  MASTER_MANOEUVRIST: '000010791003', // text-only (reactive embark)
  OMNISSIAN_UNGUENTS: '000010791004', // text-only (detachment-keyword aura)
  GRAND_STRATEGIST_AI: '000010791005',
  // Bridgehead Strike
  BOMBAST_VOX: '000009801002', // text-only (multi-target Order)
  PRIORITY_DROP_BEACON: '000009801003',
  SHROUD_PROJECTOR: '000009801004',
  ADVANCE_AUGURY: '000009801005',
  // Mechanised Assault
  BOLD_LEADERSHIP: '000009861002', // text-only (sticky objectives not modelled)
  SACRED_UNGUENTS: '000009861003', // text-only (once-per-phase transport buff)
  SMOKE_GRENADES: '000009861004',
  VANGUARD_HONOURS: '000009861005',
  // Recon Element
  GUERRILLA_HONOURS: '000009869002',
  SCARE_GAS: '000009869003', // text-only (activated battle-shock test)
  SURVIVAL_GEAR: '000009869004',
  TRIPWIRES: '000009869005', // text-only (event-driven stun)
  // Boarding Actions detachments (0 pt)
  RIGGED_BLIND_GRENADES: '000009380002', // text-only (Hatchways not modelled)
  SHIPBOARD_VETERAN: '000009380003', // text-only (CP-on-4+ event)
  MANHUNTERS_HELM: '000009369002', // text-only (priority-target pick)
  VASOVS_AUTO_OPPRESSOR: '000009369003', // text-only (move debuff)
  COVERT_BREACH: '000009389002',
  ELIMINATION_FORCE: '000009389003', // text-only (chosen-target wound bonus)
  HEIRLOOM_BLADE: '000009360003', // text-only (once-per-battle weapon buff)
  LATHIMONS_FLOCK: '000009360002',
} as const;

/** Every enhancement id carried by this live unit (its own + merged Leaders'). */
export function enhancementIdsOf(unit: UnitInstance): string[] {
  return [
    ...(unit.enhancementId ? [unit.enhancementId] : []),
    ...(unit.attachedLeaders ?? []).flatMap((l) => (l.enhancementId ? [l.enhancementId] : [])),
  ];
}

const has = (unit: UnitInstance, id: string): boolean => enhancementIdsOf(unit).includes(id);

// ── EFFECT_REGISTRY bindings (unit-level attack/defence modifiers) ────────────
/** Unconditional effect ids for the bearer's unit ("while the bearer is leading" effects apply to
 *  the merged unit by construction — the merge IS the led unit). */
const STATIC_EFFECTS: Record<string, string[]> = {
  [ENH.WITCH_HUNTER]: ['enh:witch_hunter'], // re-roll hits vs PSYKER while leading
  [ENH.INDOMITABLE_STEED]: ['fnp_6'], // vehicle officer (single-model unit) — exact
  [ENH.VETERAN_CREW]: ['reroll_hits_1'],
};

/**
 * All enhancement-driven EFFECT_REGISTRY ids active on `unit` right now. `state` powers the
 * conditional ones (Drill Commander's Remained Stationary, Smoke Grenades' transport proximity);
 * without it only the unconditional bindings apply.
 */
export function enhancementEffectIds(unit: UnitInstance, ctx?: EngineContext, state?: GameState): string[] {
  const out: string[] = [];
  for (const id of enhancementIdsOf(unit)) {
    out.push(...(STATIC_EFFECTS[id] ?? []));
    // Blackweave Shroud: FNP 4+ on the BEARER model. Unit-level effects can't scope to one model,
    // so it binds only while the bearer fights alone (a merged squad would be over-buffed).
    if (id === ENH.BLACKWEAVE_SHROUD && !unit.attachedLeaders?.length) out.push('fnp_4');
    // Drill Commander: crits on 5+ with ranged attacks while the unit Remained Stationary.
    if (id === ENH.DRILL_COMMANDER && unit.status.remainedStationary) out.push('enh:crit5_ranged');
    // Smoke Grenades: Benefit of Cover + Stealth while wholly within 3" of a friendly TRANSPORT.
    if (id === ENH.SMOKE_GRENADES && state && ctx && nearFriendlyTransport(unit, state, ctx, 3)) {
      out.push('enh:smoke_cover');
    }
  }
  return out;
}

function nearFriendlyTransport(unit: UnitInstance, state: GameState, ctx: EngineContext, range: number): boolean {
  const fallback = { kind: 'circle', radius: 0.63 } as const;
  const uShape = ctx.datasheets.get(unit.datasheetId)?.baseShape ?? fallback;
  const transports = state.units.filter(
    (t) =>
      t.owner === unit.owner && !t.inReserves && t.models.some((m) => m.alive) &&
      (ctx.datasheets.get(t.datasheetId)?.keywords ?? []).some((k) => k.toLowerCase() === 'transport'),
  );
  if (transports.length === 0) return false;
  return unit.models.every(
    (m) =>
      !m.alive ||
      transports.some((t) => {
        const tShape = ctx.datasheets.get(t.datasheetId)?.baseShape ?? fallback;
        return t.models.some((tm) => tm.alive && gapBetweenBases(m.pos, uShape, tm.pos, tShape) <= range);
      }),
  );
}

// ── weapon grants (apply only to weapons fired from the bearer's datasheet) ───
export interface WeaponGrant {
  type?: 'ranged' | 'melee';
  /** Only the bearer's Pistols (Legacy Sidearm). */
  pistolOnly?: boolean;
  devastatingWounds?: boolean;
  melta?: number;
  precision?: boolean;
  anti?: { keyword: string; threshold: number }[];
  extraAttacks?: number;
}

const WEAPON_GRANTS: Record<string, WeaponGrant> = {
  [ENH.IGNIS_JUDICIUM]: { type: 'ranged', devastatingWounds: true, melta: 1, precision: true },
  [ENH.UNIVERSAL_ANATHEMA]: {
    type: 'melee',
    anti: [{ keyword: 'INFANTRY', threshold: 2 }, { keyword: 'MONSTER', threshold: 4 }],
  },
  [ENH.MICROMELTA_ROUNDS]: {
    type: 'ranged',
    anti: [{ keyword: 'MONSTER', threshold: 4 }, { keyword: 'VEHICLE', threshold: 4 }],
  },
  [ENH.DAEMON_SLAYER]: { type: 'melee', extraAttacks: 1, anti: [{ keyword: 'DAEMON', threshold: 3 }] },
  [ENH.LEGACY_SIDEARM]: { type: 'ranged', pistolOnly: true, extraAttacks: 2 },
};

/** The weapon grant that applies when `unit` fires a weapon sourced from `sourceDsId` — i.e. the
 *  weapon belongs to the enhancement's bearer (the unit itself, or a merged Leader). */
export function enhancementWeaponGrantFor(unit: UnitInstance, sourceDsId: string): WeaponGrant | null {
  const bearerEnhIds: string[] = [];
  if (unit.enhancementId && unit.datasheetId === sourceDsId) bearerEnhIds.push(unit.enhancementId);
  for (const l of unit.attachedLeaders ?? []) {
    if (l.enhancementId && l.datasheetId === sourceDsId) bearerEnhIds.push(l.enhancementId);
  }
  for (const id of bearerEnhIds) {
    const g = WEAPON_GRANTS[id];
    if (g) return g;
  }
  return null;
}

// ── deployment grants ─────────────────────────────────────────────────────────
/** Deploy ability granted to the BEARER's unit (Beacon Angelis: Deep Strike). */
export function enhancementDeployGrant(unit: UnitInstance): 'deep_strike' | null {
  return has(unit, ENH.BEACON_ANGELIS) ? 'deep_strike' : null;
}

/** Same check from roster data (before a unit instance exists). */
export function enhancementIdGrantsDeepStrike(enhancementId: string | undefined): boolean {
  return enhancementId === ENH.BEACON_ANGELIS;
}

/**
 * Scouts X" granted by an enhancement. Survival Gear / Covert Breach benefit the bearer's own
 * unit; Eager Advance requires the bearer to be leading a REGIMENT unit.
 */
export function enhancementScoutDistance(unit: UnitInstance, ctx?: EngineContext): number | null {
  for (const id of enhancementIdsOf(unit)) {
    if (id === ENH.SURVIVAL_GEAR || id === ENH.COVERT_BREACH) return 6;
    if (id === ENH.EAGER_ADVANCE) {
      const ds = ctx?.datasheets.get(unit.datasheetId);
      if (ds?.keywords.some((k) => k.toLowerCase() === 'regiment')) return 6;
    }
  }
  return null;
}

/** Army-wide Declare Battle Formations pick: grant a deploy ability to up to `count` units. */
export interface PrebattleGrant {
  label: string;
  grant: 'infiltrators' | 'deep_strike';
  count: number;
  /** A unit qualifies if its keywords (lowercased) include every word of ONE alternative. */
  require: string[][];
  /** …and its datasheet name is not one of these (lowercased). */
  excludeNames?: string[];
}

export const PREBATTLE_GRANTS: Record<string, PrebattleGrant> = {
  [ENH.CLANDESTINE_OPERATION]: {
    label: 'Clandestine Operation',
    grant: 'infiltrators',
    count: 3,
    require: [['agents of the imperium', 'infantry']],
    excludeNames: ['grey knights terminator squad'],
  },
  [ENH.COMBAT_LANDERS]: {
    label: 'Combat Landers',
    grant: 'deep_strike',
    count: 3,
    require: [['voidfarers']],
  },
  // Lathimon's Flock: every IMPERIAL NAVY BREACHERS unit gains Infiltrators (no pick limit; the
  // "opponent deploys first" rider stays text-only).
  [ENH.LATHIMONS_FLOCK]: {
    label: "Lathimon's Flock",
    grant: 'infiltrators',
    count: 99,
    require: [['imperial navy breachers']],
  },
};

/** keyword-alternatives matcher shared by grant and redeploy unit filters. */
function keywordAltsMatch(require: string[][], ds: Datasheet): boolean {
  const kws = new Set(ds.keywords.map((k) => k.toLowerCase()));
  return require.some((alt) => alt.every((k) => kws.has(k)));
}

/** Does a datasheet qualify for a pre-battle grant's unit filter? */
export function grantSelects(grant: PrebattleGrant, ds: Datasheet): boolean {
  if (grant.excludeNames?.includes(ds.name.toLowerCase())) return false;
  return keywordAltsMatch(grant.require, ds);
}

/** A transport-split half (`key#a`/`key#b`) inherits its parent entry's grant. */
const baseEntryKey = (key: string): string => key.replace(/#[ab]$/, '');

/** The deploy ability granted to a deployment entry key by a declared pre-battle grant. */
export function grantedDeployAbility(state: GameState, entryKey: string): 'infiltrators' | 'deep_strike' | null {
  const want = baseEntryKey(entryKey);
  for (const g of state.setup?.grants ?? []) {
    if (g.entryKeys.some((k) => baseEntryKey(k) === want)) return g.grant;
  }
  return null;
}

// ── post-deployment redeploys (Warrant-of-Trade mould) ───────────────────────
export interface RedeployRule {
  label: string;
  count: number;
  /** A unit qualifies if its keywords (lowercased) include every word of ONE alternative. */
  require: string[][];
}

export const REDEPLOY_RULES: Record<string, RedeployRule> = {
  [ENH.LIBER_HERESIUS]: { label: 'Liber Heresius', count: 3, require: [['agents of the imperium']] },
  [ENH.GUERRILLA_HONOURS]: { label: 'Guerrilla Honours', count: 3, require: [['astra militarum', 'infantry']] },
  [ENH.GRAND_STRATEGIST_AI]: { label: 'Grand Strategist', count: 2, require: [['regiment'], ['squadron']] },
  [ENH.ADVANCE_AUGURY]: { label: 'Advance Augury', count: 3, require: [['regiment']] },
};

export function redeployRuleSelects(rule: RedeployRule, ds: Datasheet | undefined): boolean {
  return !!ds && keywordAltsMatch(rule.require, ds);
}

// ── small carve-outs read by the engine/reducer ──────────────────────────────
/** Enemy units cannot Fire Overwatch at the bearer's unit (Shroud Projector / Flash Grenades). */
export function blocksOverwatch(unit: UnitInstance): boolean {
  return has(unit, ENH.SHROUD_PROJECTOR) || has(unit, ENH.FLASH_GRENADES);
}

/** +Objective Control for the bearer's models (Regimental Banner). */
export function enhancementOcBonus(unit: UnitInstance): number {
  return has(unit, ENH.REGIMENTAL_BANNER) ? 3 : 0;
}

/** Battle-shocked OC: Death Mask of Ollanius keeps OC at (base − 1) instead of 0. */
export function shockedOcFloor(unit: UnitInstance): boolean {
  return has(unit, ENH.DEATH_MASK);
}

/** +Leadership (a LOWER battle-shock target number): Formidable Resolve. */
export function enhancementLdBonus(unit: UnitInstance): number {
  return has(unit, ENH.FORMIDABLE_RESOLVE) ? 1 : 0;
}

/** +Wounds per model at unit creation (Formidable Resolve — single-model bearers only). */
export function enhancementWoundBonus(enhancementId: string | undefined, modelCount: number): number {
  return enhancementId === ENH.FORMIDABLE_RESOLVE && modelCount === 1 ? 1 : 0;
}

/** May this Reserves unit Deep Strike in the FIRST battle round? (Priority-drop Beacon.) */
export function allowsRound1DeepStrike(unit: UnitInstance): boolean {
  return has(unit, ENH.PRIORITY_DROP_BEACON);
}

/** May the unit disembark from a transport that Advanced? (Vanguard Honours — counts as a Normal
 *  move, no charge; resolved as a Rapid disembark.) */
export function canDisembarkAfterAdvance(unit: UnitInstance): boolean {
  return has(unit, ENH.VANGUARD_HONOURS);
}

/** Units disembarking from this transport after its Normal move may still charge (Assault Hatches). */
export function transportAllowsChargeAfterMove(transport: UnitInstance): boolean {
  return has(transport, ENH.ASSAULT_HATCHES);
}

/** Digital Weapons: when the bearer's unit is selected to fight — roll 3D6, each 4+ inflicts
 *  1 mortal wound on an engaged enemy unit ([PRECISION]-style allocation). */
export function hasDigitalWeapons(unit: UnitInstance): boolean {
  return has(unit, ENH.DIGITAL_WEAPONS);
}

/** The bearer gains Voice of Command / OFFICER (Battalion Commander: orders Titanic + Squadron). */
export function grantsOfficer(unit: UnitInstance): boolean {
  return has(unit, ENH.BATTALION_COMMANDER);
}

/** Voice of Command range for this officer (Laud Hailer: 12" instead of 6"). */
export function orderRangeFor(unit: UnitInstance, base: number): number {
  return has(unit, ENH.LAUD_HAILER) ? Math.max(base, 12) : base;
}

/** Battalion Commander's Orders also reach AM TITANIC and SQUADRON units (not just REGIMENT). */
export function ordersReachTitanicSquadron(unit: UnitInstance): boolean {
  return has(unit, ENH.BATTALION_COMMANDER);
}

/** Orders issued to the bearer's unit also apply Take Cover! (Stalwart's Honours). */
export function ordersEchoTakeCover(unit: UnitInstance): boolean {
  return has(unit, ENH.STALWARTS_HONOURS);
}

/** Extra Orders this officer's enhancement unlocks (Aquilan Eye / Spec Ops Veteran). */
export function extraOrderIdsFor(unit: UnitInstance): string[] {
  const out: string[] = [];
  if (has(unit, ENH.AQUILAN_EYE)) out.push('order:target_weak_spot');
  if (has(unit, ENH.SPEC_OPS_VETERAN)) out.push('order:move_to_shadows');
  return out;
}

/** Additional Orders per Command phase for this officer (Grand Strategist, Combined Arms). */
export function extraOrderCount(unit: UnitInstance): number {
  return has(unit, ENH.GRAND_STRATEGIST_CA) ? 1 : 0;
}
