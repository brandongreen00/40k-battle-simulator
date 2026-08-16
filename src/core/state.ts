// GameState + intent reducer skeleton. PURE — no React, no DOM, no I/O.
//
// Architecture rules honored here from day one (even though Stage 1 fires none of them):
//  #1 This reducer is the ONLY place game state mutates, and only in response to a *validated
//     intent* (+ an injected RNG). The UI and, later, the AI both submit the same Intents.
//  #3 Reactive timing is first-class: the phase model leaves room for actions during the
//     opponent's turn. We don't implement any reactive window yet, but the shape allows it.
//  #4 The turn/phase sequence is DATA (see `PARIAH_NEXUS_PHASES`), not hard-coded into the UI.
//
// Stage 1 only needs to spawn units, move models, and clear the board. No combat, LoS, scoring,
// or AI — those are later stages.

import type { BaseShape, Datasheet, DeclaredFormation, DeclaredSplit, GameState, Layout, ModelInstance, Side, SplitGroup, UnitInstance, Vec2 } from './types';
import type { RNG } from './rng';
import { baseRadius, clamp, clampToRange, gapBetweenBases } from './geometry';
import { formationPositions, type Formation } from './formation';
import { defensiveProfileForItem } from './wargear';
import { rollOff, otherSide } from './setup';
import { checkUnitDeployment, deepStrikeArrivalLegal, deployAbilityFromKeywords, isEntryPlaced, whollyInOwnZone, type DeployAbility } from './deployment';
import { checkCoherency } from './coherency';
import { anyOverlap, occupiedBases, unitOverlaps } from './collision';
import { blockedByDense, unitDenseViolation } from './terrainmove';
import { canEmbark, disembarkMode, isAircraft, splitRideCounts, splitRuleSelects, transportSplitRule } from './transport';
import {
  PREBATTLE_GRANTS, REDEPLOY_RULES, allowsRound1DeepStrike, blocksOverwatch, enhancementDeployGrant,
  enhancementWoundBonus, grantSelects, grantedDeployAbility, ordersEchoTakeCover, redeployRuleSelects,
  transportAllowsChargeAfterMove,
} from './enhancements';
import { hazardRoll } from './combat';
import { eligibleToShoot, engagedEnemies } from './phases';
import { pointLosBlocked, unitCanSeeIn } from './visibility';
import { initSecondaries, recordKills, secondariesOnTurnEnd, secondariesOnTurnStart, secondaryCard } from './secondaries';
import { initMissions, missionsOnBattleEnd, missionsOnCommandEnd, missionsOnTurnEnd, missionsOnTurnStart, startAction, type StartActionParams } from './missionflow';
import { cpMissionsOnBattleEnd, cpMissionsOnCommandEnd, cpMissionsOnTurnEnd, initCpMissions, startSanctification } from './cpmissions';
import type { DispositionId } from './missions11';
import { objectiveStatuses, withinObjectiveRange } from './missions11';
import { canAttach, leaderJoinPositions } from './leaders';
import { abilityWoundBonus, cpEnhancementSlug, hasAbility, hasAbilityStarting, unitHasAbilityStarting, unitScoutDistance } from './abilities';
import { maxMoveDistance, rollAdvance, type MoveMode } from './movement';
import { moveBonusFromOrders } from './orders';
import {
  closestGap,
  resolveAttack,
  resolveCharge,
  resolveFightMove,
  resolveUnitFight,
  resolveEmergencyDisembarks,
  resolveUnitShooting,
  runCommandPhase,
  resolveSurgeMove,
  stampFightStepEngagement,
  sweepDyingModels,
  type AttackParams,
  type SurgeMoveParams,
  type ChargeParams,
  type FightMoveParams,
  type UnitFightParams,
  type UnitShootParams,
  type EngineContext,
} from './engine';

/** The Pariah Nexus phase sequence, as data (rule #4). Stage 1 does not advance through it. */
export const PARIAH_NEXUS_PHASES = [
  'Command',
  'Movement',
  'Shooting',
  'Charge',
  'Fight',
] as const;
export type Phase = (typeof PARIAH_NEXUS_PHASES)[number];

// ── Intents ──────────────────────────────────────────────────────────────────
export type Intent =
  | {
      type: 'SpawnUnit';
      unitId: string;
      owner: Side;
      datasheetId: string;
      baseShape: BaseShape;
      modelCount: number;
      /** Wounds per model (from the datasheet's first model profile). */
      wounds: number;
      /** Where to drop the unit; models are laid out around this point (inches). */
      anchor: Vec2;
      /** Shape to lay the models out in (defaults to a compact block). */
      formation?: Formation;
      /** Rotation of the formation around the anchor, radians (defaults to 0). */
      rotation?: number;
      /** Wargear as item→count (e.g. {"Astartes shield": 2}); assigned to the first N models. */
      wargear?: Record<string, number>;
    }
  | { type: 'MoveModel'; modelId: string; pos: Vec2 }
  | { type: 'RemoveUnit'; unitId: string }
  | { type: 'ClearUnits' }
  /** Swap the board to a different layout. Resets the board (model positions are layout-specific). */
  | { type: 'SetLayout'; layout: Layout }
  // ── Combat core (Phase 1) ────────────────────────────────────────────────────
  /** Advance the phase/turn/round sequencer one step (Command→…→Fight→next turn). */
  | { type: 'AdvancePhase' }
  /** Set the side that takes the first turn (and reset the sequencer to round 1). */
  | { type: 'SetFirstPlayer'; side: Side }
  /** One unit attacks another with one weapon. Requires the EngineContext (datasheet lookup). */
  | ({ type: 'Attack' } & AttackParams)
  /** A unit shoots a target with EVERY ranged weapon its models carry, resolved sequentially
   *  (10e: each model fires all its weapons; Pistols are either/or). Requires the EngineContext. */
  | ({ type: 'ShootUnit' } & UnitShootParams)
  /** A unit fights a target with all its melee weapons (10e: each model fights with one melee
   *  weapon, plus Extra Attacks weapons), resolved sequentially. Requires the EngineContext. */
  | ({ type: 'FightUnit' } & UnitFightParams)
  /** Resolve a charge roll (2D6). Requires the EngineContext. */
  | ({ type: 'Charge' } & ChargeParams)
  /** Pile In / Consolidate (Fight phase): move a unit up to 3" toward the nearest enemy. */
  | ({ type: 'FightMove' } & FightMoveParams)
  /** Run the active player's Command phase: CP, Battle-shock, Primary scoring. Requires EngineContext. */
  | { type: 'RunCommandPhase' }
  /** Set per-unit status flags (movement/charge bookkeeping that later phases drive). */
  | { type: 'SetUnitStatus'; unitId: string; status: Partial<UnitInstance['status']> }
  /** The owner's casualty-allocation preference for a unit (who soaks incoming wounds first).
   *  Persists for the battle — unlike status flags it survives turn resets. */
  | { type: 'SetAllocation'; unitId: string; allocation: 'shields_first' | 'bodies_first' }
  // ── Abilities / Orders / Stratagems (Phase 3) ─────────────────────────────────
  /** Issue an Order to a unit: applies an effect (from core/effects.ts) until end of turn. */
  | { type: 'IssueOrder'; unitId: string; effectId: string }
  /** Use a Stratagem: spend CP for a side and optionally apply an effect to a target unit.
   *  Not gated by the active player, so reactive stratagems (Displacer Field) work in the
   *  opponent's turn (architecture rule #3). */
  | {
      type: 'UseStratagem';
      name: string;
      side: Side;
      cost: number;
      targetUnitId?: string;
      effectId?: string;
      /** Stable id for the once-per-phase tracker (15.01); omitted = untracked (sandbox). */
      stratagemId?: string;
      /** Combat Patrol "secured objective" stratagems (Inquisitorial Mandate / Rapid Acquisition). */
      objectiveIdx?: number;
      /** Swift Embarkation: the transport to embark `targetUnitId` within. */
      transportId?: string;
    }
  /** Discard one of your active Tactical Missions (the end-of-turn discard choice; the AI relies
   *  on the automatic stale-discard instead). */
  | { type: 'DiscardSecondary'; side: Side; cardId: string }
  /** Combat Patrol (Purification): start the Sanctification action in your Shooting phase. */
  | { type: 'StartSanctification'; unitId: string; objectiveIdx: number }
  /** Pre-battle (secret) Secondary Missions choice: Tactical (draw from the deck — the default)
   *  or Fixed with exactly two FIXED-capable cards, scored all battle at 20VP each. */
  | { type: 'ChooseSecondaryMode'; side: Side; fixedCardIds?: [string, string] }
  /** Start (or perform) an 11e Objective Action with a unit (your Shooting phase). */
  | ({ type: 'StartAction' } & StartActionParams)
  // ── Pre-battle setup / deployment (Stage: setup) ──────────────────────────────
  /** Start a new battle: clear the board and enter deployment at the roll-off step.
   *  `dispositions` selects each side's Force Disposition (11e missions; defaults apply). */
  | { type: 'NewBattle'; dispositions?: Record<Side, DispositionId>; battleType?: 'standard' | 'combat_patrol' }
  /** Roll off to determine Attacker (winner) and Defender; Defender then deploys first. */
  | { type: 'RollRoles' }
  /** Manually set the Attacker (the other side is Defender). Defender deploys first. */
  | { type: 'SetAttacker'; side: Side }
  /** Deploy a unit onto the board during setup, validated against the owner's deployment zone. */
  | {
      type: 'DeployUnit';
      unitId: string;
      owner: Side;
      datasheetId: string;
      baseShape: BaseShape;
      modelCount: number;
      wounds: number;
      anchor: Vec2;
      formation?: Formation;
      rotation?: number;
      wargear?: Record<string, number>;
      /** The roster entry's Enhancement (drives in-game effects; see core/enhancements.ts). */
      enhancementId?: string;
      /** Deployment ability — gates zone legality (Infiltrators may deploy in no-man's-land). */
      ability?: DeployAbility;
      /** Start the battle embarked within this already-deployed friendly TRANSPORT (18.01) —
       *  the anchor/zone checks are skipped; capacity and keywords are validated. */
      intoTransportId?: string;
    }
  /** Place a unit into Reserves (Deep Strike / Strategic Reserves) instead of on the board. */
  | {
      type: 'PlaceInReserves';
      unitId: string;
      owner: Side;
      datasheetId: string;
      baseShape: BaseShape;
      modelCount: number;
      wounds: number;
      wargear?: Record<string, number>;
      /** The roster entry's Enhancement (drives in-game effects; see core/enhancements.ts). */
      enhancementId?: string;
    }
  /** Attach a Leader (CHARACTER) unit to a Bodyguard unit (validated against canLead/canBeLedBy). */
  | { type: 'AttachLeader'; leaderUnitId: string; bodyguardUnitId: string }
  /** Detach a previously attached Leader. */
  | { type: 'DetachLeader'; leaderUnitId: string }
  /** Declare a Leader→Bodyguard pairing BEFORE either is deployed (Declare Battle Formations).
   *  The pair then deploys together as one merged unit, and deployment abilities granted to the
   *  led unit (e.g. a Backroom Deals Rogue Trader's Infiltrators) apply at set-up time. */
  | {
      type: 'DeclareFormation';
      side: Side;
      leaderKey: string;
      leaderDsId: string;
      bodyguardKey: string;
      bodyguardDsId: string;
      /** The leader's roster enhancement — some enhancements extend its Leader list
       *  (Exemplar of Duty / Abhuman Detail → Ogryn/Bullgryn squads). */
      leaderEnhancementId?: string;
    }
  /** Undo a declared (not yet deployed) Leader pairing. */
  | { type: 'ClearFormation'; leaderKey: string }
  /** Declare Battle Formations split (e.g. Sisters of Battle Immolator): split a roster entry into
   *  two half-units. The riding half (`${entryKey}#a`, `rideCount` models, carrying `rideWargear`)
   *  immediately starts the battle embarked within `transportUnitId`; the other half becomes a
   *  normal deployable entry (`${entryKey}#b`). Counts as the side's placement for alternation. */
  | {
      type: 'DeclareSplit';
      side: Side;
      entryKey: string;
      datasheetId: string;
      baseShape: BaseShape;
      modelCount: number;
      wounds: number;
      transportUnitId: string;
      rideCount: number;
      rideWargear?: Record<string, number>;
      totalWargear?: Record<string, number>;
    }
  /** Undo a declared split: removes BOTH half-units (wherever they are) and the split record, so
   *  the original entry re-enters the deployment flow. Setup only. */
  | { type: 'ClearSplit'; entryKey: string }
  /** COMBAT SQUAD (Declare Battle Formations): split a 10-model unit into two 5-model units.
   *  The wargear partitions as evenly as possible; both halves deploy like any other unit.
   *  Does not consume the side's deployment slot (nothing is placed). */
  | {
      type: 'DeclareCombatSquad';
      side: Side;
      entryKey: string;
      datasheetId: string;
      modelCount: number;
      totalWargear?: Record<string, number>;
    }
  /** Combat Patrol enhancement pick (one per side, before/during deployment): the enhancement is
   *  stamped onto the bearer's unit (matched by `targetDsId`) — retroactively if it is already
   *  on the board. `enhancementId: null` declines. */
  | { type: 'ChooseCpEnhancement'; side: Side; enhancementId: string | null; targetDsId?: string }
  /** Undo a start-the-battle-embarked deployment: the unit instance is removed and its roster
   *  entry re-enters the deployment flow. Setup only; not for split halves (use ClearSplit). */
  | { type: 'UndeployUnit'; unitId: string }
  /** Declare Battle Formations enhancement pick (Clandestine Operation / Combat Landers): grant
   *  the enhancement's deploy ability to up to N of the side's roster entries. `entries` carries
   *  each entry's datasheet so the unit filter can be validated; an empty list resolves the
   *  decision without picks. */
  | {
      type: 'DeclareEnhancementGrant';
      side: Side;
      enhancementId: string;
      entries: { entryKey: string; datasheetId: string }[];
    }
  /** Start an enhancement redeploy (Liber Heresius etc.): after both armies have deployed, pull
   *  up to the rule's count of qualifying units back into the deployment flow. */
  | { type: 'UseEnhancementRedeploy'; side: Side; enhancementId: string }
  /** Decline (or finish early with) an enhancement redeploy. */
  | { type: 'DeclineEnhancementRedeploy'; side: Side; enhancementId: string }
  /** Pull one qualifying deployed unit back off the board (enhancement redeploy). */
  | { type: 'EnhancementRedeploy'; unitId: string }
  /** Warrant of Trade: roll the D3 and start redeploying up to that many IMPERIUM BATTLELINE units. */
  | { type: 'UseWarrant'; side: Side }
  /** Decline (or finish early with) the Warrant of Trade redeploy. */
  | { type: 'DeclineWarrant'; side: Side }
  /** Pull one deployed IMPERIUM BATTLELINE unit back off the board for redeployment (Warrant). */
  | { type: 'WarrantRedeploy'; unitId: string }
  /** Roll off for the first turn; the winner takes it. Moves setup to 'scouts' (if any unit has a
   *  Scouts X" move to make) or 'ready'. */
  | { type: 'RollFirstTurn' }
  /** Finish deployment and begin the battle (Command phase of round 1). */
  | { type: 'BeginBattle' }
  // ── Movement (Stage: battle) ─────────────────────────────────────────────────
  /** Begin a Movement activation for one or more units: snapshot origins, set the per-unit budget
   *  (M, or M+D6 for an Advance), so MoveModel/NudgeUnit can clamp to range. */
  | { type: 'BeginMove'; unitIds: string[]; mode: MoveMode }
  /** Command Re-roll (1 CP): re-roll the Advance D6 just rolled (before the unit moves). */
  | { type: 'RerollAdvance'; unitId: string; side: Side }
  /** Rigidly translate the given (moving) units by `delta` inches from their move origins, clamped
   *  per-unit to the move budget. Used by the drag-select group move; preserves coherency. */
  | { type: 'NudgeUnit'; unitIds: string[]; delta: Vec2 }
  /** Finalise a Movement activation: rejects if any unit is out of coherency, else locks in the move. */
  | { type: 'EndMove'; unitIds: string[] }
  /** Abort a Movement activation: snap the units back to their origins, record no move. */
  | { type: 'CancelMove'; unitIds: string[] }
  /** Bring a Reserves unit onto the board via an ingress move (11e, 20.04): within 6" of an
   *  edge and >8" from enemies — or anywhere >8" with Deep Strike. Round 2+. With `rapidIngress`
   *  (15.07, 1 CP) the move resolves at the end of the OPPONENT's Movement phase. */
  | { type: 'ArriveFromReserves'; unitId: string; anchor: Vec2; formation?: Formation; rotation?: number; ability?: DeployAbility; rapidIngress?: boolean }
  // ── Core Stratagem plays (15.03–15.12) ───────────────────────────────────────
  /** Fire Overwatch (15.08, 1 CP): end of the opponent's Movement phase — an unengaged
   *  non-TITANIC unit snap-shoots one visible enemy within 24" (only unmodified 6s hit). */
  | { type: 'FireOverwatch'; unitId: string; targetUnitId: string }
  /** Crushing Impact (15.06, 1 CP): after a friendly MONSTER/VEHICLE ends a charge move — roll
   *  its Toughness in D6: each 1 = 1 mortal wound to it, each 5+ = 1 to the target (max 6). */
  | { type: 'CrushingImpact'; unitId: string; targetUnitId: string }
  /** Explosives (15.05, 1 CP): your Shooting phase — an unengaged EXPLOSIVES/GRENADES unit picks
   *  an unengaged enemy within 8" and visible; roll 6D6, each 4+ inflicts 1 mortal wound. */
  | { type: 'ThrowExplosives'; unitId: string; targetUnitId: string }
  /** Counteroffensive (15.12, 2 CP): opponent's Fight phase, after an enemy unit fights — one of
   *  your eligible units gains Fights First and must be selected to fight next. */
  | { type: 'Counteroffensive'; unitId: string }
  /** Insane Bravery (15.04, 1 CP, once per battle): apply BEFORE running your Command phase —
   *  that unit's battle-shock roll automatically succeeds. */
  | { type: 'InsaneBravery'; unitId: string }
  /** Surge move (21.02): ability-triggered — up to `maxDistance` toward the closest enemy (the
   *  surge target), ending engaged with it if possible and never engaged with another enemy. */
  | ({ type: 'SurgeMove' } & SurgeMoveParams)
  // ── Transports (11e, 18) ─────────────────────────────────────────────────────
  /** Embark within a friendly TRANSPORT after a normal/advance/fall-back move (18.02): every
   *  model within 3" of it, capacity permitting. The unit leaves the battlefield. */
  | { type: 'EmbarkUnit'; unitId: string; transportId: string }
  /** Disembark from a transport (18.04). The mode is derived from the transport's state and the
   *  anchor: Rapid (transport moved: 3", no charge), Tactical (transport unmoved: 3", the unit may
   *  then move normally), Combat (6", hazard roll per model, battle-shocked, no charge). */
  | { type: 'DisembarkUnit'; unitId: string; anchor: Vec2; formation?: Formation; rotation?: number }
  // ── Combat Patrol per-unit specials ──────────────────────────────────────────
  /** For the Greater Good (T'au): in your Shooting phase, an eligible unshot FTGG unit becomes an
   *  Observer and marks one visible enemy as its Spotted unit (once per enemy per phase). The
   *  Observer forgoes its own shooting — except a Target Uploaded unit (Pathfinders), which may
   *  still shoot its Spotted unit at +1 BS with [IGNORES COVER]. */
  | { type: 'SpotTarget'; unitId: string; targetUnitId: string }
  /** Play a datasheet/patrol ability (Combat Patrol per-unit specials): Zealot, Overkill,
   *  Bladeguard (hit/stance), Tome Skull, Nuncio-Aquila, Co-ordinated Eradication,
   *  Gate of Infinity. The reducer enforces phase/turn windows and once-per-battle/turn limits. */
  | { type: 'UseUnitAbility'; unitId: string; ability: string; targetUnitId?: string; objectiveIdx?: number };

export function createInitialState(layout: Layout): GameState {
  return {
    layout,
    units: [],
    stage: 'battle',
    mode: 'sandbox',
    round: 1,
    firstPlayer: 'player',
    activePlayer: 'player',
    phase: PARIAH_NEXUS_PHASES[0],
    cp: { player: 0, ai: 0 },
    score: { player: 0, ai: 0 },
    ended: false,
    log: [],
  };
}

/** Clear a side's per-unit, per-turn status flags (and transient move origins) at the start of
 *  that side's turn. */
function beginTurnFor(state: GameState, side: Side): UnitInstance[] {
  return state.units.map((u) =>
    u.owner === side
      ? {
          ...u,
          // lastShotOnTurn survives the per-turn reset (Hidden's two-turn window, 13.09);
          // battleShocked persists until a successful recovery roll (08.03).
          status: {
            ...(u.status.lastShotOnTurn != null ? { lastShotOnTurn: u.status.lastShotOnTurn } : {}),
            ...(u.status.battleShocked ? { battleShocked: true } : {}),
            // Pinned (Suppressing Fire) lasts into the pinned unit's own turn.
            ...(u.status.pinnedUntil != null && (state.turnCounter ?? 0) + 1 < u.status.pinnedUntil
              ? { pinnedUntil: u.status.pinnedUntil }
              : {}),
            // Suppressed (Earth Caste Modifications) lasts into the suppressed unit's own turn.
            ...(u.status.suppressedUntil != null && (state.turnCounter ?? 0) + 1 < u.status.suppressedUntil
              ? { suppressedUntil: u.status.suppressedUntil }
              : {}),
            // Once-per-battle/turn ability plays and until-end-of-battle marks survive the reset.
            ...(u.status.abilityUsed ? { abilityUsed: u.status.abilityUsed } : {}),
            ...(u.status.permanentEffects ? { permanentEffects: u.status.permanentEffects } : {}),
            // [ONE SHOT] weapons stay spent for the rest of the battle.
            ...(u.status.oneShotFired ? { oneShotFired: u.status.oneShotFired } : {}),
          },
          models: u.models.map((m) => (m.moveStart ? { ...m, moveStart: undefined } : m)),
        }
      : u,
  );
}

/**
 * Cancel any move activation still open (BeginMove without EndMove/CancelMove): snap the models
 * back to their origins and clear the transient flags. Leaving the phase mid-activation means the
 * move never happened — and a stale `moveMode` would otherwise wedge the Movement panel for the
 * REST of that unit's owner's round (the "can't move my units any more" bug).
 */
function cancelOpenActivations(state: GameState): { units: UnitInstance[]; cancelled: string[] } {
  const cancelled: string[] = [];
  const units = state.units.map((u) => {
    if (!u.status.moveMode) return u;
    cancelled.push(u.id);
    return {
      ...u,
      status: { ...u.status, moveMode: undefined, moveBudget: undefined },
      models: u.models.map((m) => (m.moveStart ? { ...m, pos: m.moveStart, moveStart: undefined } : m)),
    };
  });
  return { units, cancelled };
}

/**
 * End of Turn step (11e, 03.03 "Regaining Coherency"): units not in coherency must remove models
 * (destroyed, no death triggers) until they are coherent again. Applies to BOTH players' units.
 * Removal order: keep the largest coherent subset (greedily drop the model whose absence best
 * restores coherency — models furthest from the unit centroid go first).
 */
function enforceEndOfTurnCoherency(state: GameState, ctx?: EngineContext): GameState {
  let log = state.log;
  const units = state.units.map((u) => {
    if (u.inReserves) return u;
    const shape = ctx?.datasheets.get(u.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
    let alive = u.models.filter((m) => m.alive);
    if (alive.length <= 1) return u;
    if (checkCoherency(alive.map((m) => m.pos), shape).inCoherency) return u;
    const dead = new Set<string>();
    while (alive.length > 1 && !checkCoherency(alive.map((m) => m.pos), shape).inCoherency) {
      const cx = alive.reduce((s, m) => s + m.pos.x, 0) / alive.length;
      const cy = alive.reduce((s, m) => s + m.pos.y, 0) / alive.length;
      const far = [...alive].sort(
        (a, b) =>
          Math.hypot(b.pos.x - cx, b.pos.y - cy) - Math.hypot(a.pos.x - cx, a.pos.y - cy),
      )[0]!;
      dead.add(far.id);
      alive = alive.filter((m) => m.id !== far.id);
    }
    if (dead.size === 0) return u;
    const name = ctx?.datasheets.get(u.datasheetId)?.name ?? u.id;
    log = [...log, `${name}: ${dead.size} model(s) destroyed to regain coherency (End of Turn)`];
    return { ...u, models: u.models.map((m) => (dead.has(m.id) ? { ...m, alive: false, wounds: 0 } : m)) };
  });
  return { ...state, units, log };
}

/** The 11e turn sequencer as data (rule #4). Phases→turns→rounds; ends after round 5. */
function advancePhase(state: GameState, ctx?: EngineContext): GameState {
  if (state.ended || state.stage !== 'battle') return state;
  // An unconfirmed move activation does not survive the phase ending.
  const open = cancelOpenActivations(state);
  if (open.cancelled.length > 0) {
    state = { ...state, units: open.units, log: [...state.log, 'Unconfirmed move cancelled (phase ended mid-activation)'] };
  }
  // FTGG Spotted marks last "until the end of the phase" — any phase change clears them.
  if (state.spotted) state = { ...state, spotted: undefined };
  const i = PARIAH_NEXUS_PHASES.indexOf(state.phase as Phase);
  if (i >= 0 && i < PARIAH_NEXUS_PHASES.length - 1) {
    const next: GameState = { ...state, phase: PARIAH_NEXUS_PHASES[i + 1]! };
    // Entering the Fight phase: snapshot who is engaged (12.04) — a unit whose combat evaporates
    // mid-phase stays eligible and fights via an overrun fight (12.06).
    if (PARIAH_NEXUS_PHASES[i + 1] === 'Fight' && ctx) return stampFightStepEngagement(next, ctx);
    return next;
  }
  // End of the Fight phase — the End of Turn step (11e): enforce coherency (03.03), then the
  // mission consults (primary + secondary scoring hooks), then clear the per-turn kill ledger.
  if (state.fightNext) state = { ...state, fightNext: undefined }; // Counteroffensive expires
  // Fights-on-death expires with the phase: every dying model is removed (and its kill recorded).
  {
    const swept = sweepDyingModels(state, 'all', ctx);
    if (swept !== state) state = recordKills(state, swept, ctx);
  }
  state = enforceEndOfTurnCoherency(state, ctx);
  state = missionsOnTurnEnd(state, ctx);
  state = secondariesOnTurnEnd(state, ctx);
  state = cpMissionsOnTurnEnd(state, ctx);
  // 23.02: at the end of your opponent's turn, your AIRCRAFT on the battlefield return to
  // Strategic Reserves. The turn ending belongs to `activePlayer`, so the OTHER side's aircraft
  // leave now.
  if (ctx) {
    const other = otherSide(state.activePlayer);
    const leaving = state.units.filter(
      (u) => u.owner === other && !u.inReserves && u.models.some((m) => m.alive) && isAircraft(ctx.datasheets.get(u.datasheetId)),
    );
    if (leaving.length > 0) {
      state = {
        ...state,
        units: state.units.map((u) => (leaving.some((l) => l.id === u.id) ? { ...u, inReserves: true } : u)),
        log: [...state.log, `${leaving.length} AIRCRAFT return to Strategic Reserves (end of opponent's turn)`],
      };
    }
  }
  if (state.activePlayer === state.firstPlayer) {
    const next = otherSide(state.activePlayer);
    return {
      ...state,
      activePlayer: next,
      phase: PARIAH_NEXUS_PHASES[0]!,
      commandRun: false,
      turnKills: [],
      turnCounter: (state.turnCounter ?? 0) + 1,
      units: beginTurnFor(state, next),
      log: [...state.log, `— ${next} turn, round ${state.round} —`],
    };
  }
  // Second player just finished — End of Battle Round. At the end of round 3, strategic reserves
  // that never arrived are destroyed (20.03).
  if (state.round === 3) {
    // Embarked units are aboard a transport (not in Strategic Reserves), and AIRCRAFT legally
    // cycle on and off the battlefield — neither is destroyed by 20.03.
    const stranded = (u: UnitInstance): boolean =>
      !!u.inReserves && !u.embarkedIn && u.models.some((m) => m.alive) &&
      !(ctx && isAircraft(ctx.datasheets.get(u.datasheetId)));
    const count = state.units.filter(stranded).length;
    if (count > 0) {
      state = {
        ...state,
        units: state.units.map((u) =>
          stranded(u) ? { ...u, models: u.models.map((m) => ({ ...m, alive: false, wounds: 0 })) } : u,
        ),
        log: [...state.log, `${count} reserves unit(s) destroyed (never arrived by the end of round 3)`],
      };
    }
  }
  if (state.round >= 5) {
    // End of the battle: END OF BATTLE mission scoring + Battle Ready VP (missions11), or the
    // Combat Patrol cards' END OF BATTLE blocks.
    const finished = cpMissionsOnBattleEnd(missionsOnBattleEnd({ ...state, ended: true }, ctx), ctx);
    return { ...finished, turnKills: [], log: [...finished.log, '— battle ends (round 5 complete) —'] };
  }
  const round = state.round + 1;
  const next = state.firstPlayer;
  return {
    ...state,
    round,
    activePlayer: next,
    phase: PARIAH_NEXUS_PHASES[0]!,
    commandRun: false,
    turnKills: [],
    turnCounter: (state.turnCounter ?? 0) + 1,
    units: beginTurnFor(state, next),
    log: [...state.log, `— ${next} turn, round ${round} —`],
  };
}

/**
 * Apply one validated intent, returning a new GameState (never mutates the input).
 * `ctx` (the datasheet lookup) is required only by intents that read unit stats (Attack).
 */
export function reduce(state: GameState, intent: Intent, rng: RNG, ctx?: EngineContext): GameState {
  switch (intent.type) {
    case 'SpawnUnit': {
      const models = layoutModels(
        { ...intent, wounds: intent.wounds + (ctx ? abilityWoundBonus(ctx.datasheets.get(intent.datasheetId)) : 0) },
        state.layout,
      );
      const unit: UnitInstance = {
        id: intent.unitId,
        owner: intent.owner,
        datasheetId: intent.datasheetId,
        models,
        startingModels: models.length,
        status: {},
        ...(intent.wargear ? { wargearCounts: intent.wargear } : {}),
      };
      return { ...state, units: [...state.units, unit] };
    }

    case 'MoveModel': {
      // In a match, models only move inside a Movement activation (BeginMove sets the budget) —
      // free dragging outside it would bypass the movement rules. The sandbox/deployment stay free
      // (the pre-battle Scout step is budgeted like the battle).
      if (state.mode === 'match' && (state.stage === 'battle' || state.setup?.step === 'scouts')) {
        const owner = state.units.find((u) => u.models.some((m) => m.id === intent.modelId));
        if (owner && owner.status.moveBudget == null) return state;
      }
      return {
        ...state,
        units: state.units.map((u) => {
          if (!u.models.some((m) => m.id === intent.modelId)) return u;
          const budget = u.status.moveBudget;
          return {
            ...u,
            models: u.models.map((m) => {
              if (m.id !== intent.modelId) return m;
              // While a unit is mid-activation, a model may not move beyond its budget from its origin.
              const target =
                budget != null && m.moveStart ? clampToRange(m.moveStart, intent.pos, budget) : intent.pos;
              return { ...m, pos: clampToBoard(target, state.layout) };
            }),
          };
        }),
      };
    }

    case 'RemoveUnit':
      return { ...state, units: state.units.filter((u) => u.id !== intent.unitId) };

    case 'ClearUnits':
      return { ...state, units: [] };

    case 'SetLayout':
      return createInitialState(intent.layout);

    case 'AdvancePhase':
      return advancePhase(state, ctx);

    case 'SetFirstPlayer':
      return { ...state, firstPlayer: intent.side, activePlayer: intent.side, round: 1, phase: PARIAH_NEXUS_PHASES[0], ended: false };

    case 'SetUnitStatus': {
      let next: GameState = {
        ...state,
        units: state.units.map((u) =>
          u.id === intent.unitId ? { ...u, status: { ...u.status, ...intent.status } } : u,
        ),
      };
      // A unit marked as having fought loses its fights-on-death (dying) models.
      if (intent.status.hasFought) {
        const swept = sweepDyingModels(next, [intent.unitId], ctx);
        if (swept !== next) next = recordKills(state, swept, ctx);
      }
      return next;
    }

    case 'SetAllocation':
      return {
        ...state,
        units: state.units.map((u) => (u.id === intent.unitId ? { ...u, allocation: intent.allocation } : u)),
        log: [...state.log, `Casualty allocation for ${intent.unitId}: ${intent.allocation === 'bodies_first' ? 'regular models first (preserve wargear bearers)' : 'wargear bearers soak first'}`],
      };

    case 'Attack': {
      if (!ctx) {
        return { ...state, log: [...state.log, 'Attack ignored: no datasheet context supplied'] };
      }
      const { type: _t, ...params } = intent;
      const outcome = resolveAttack(state, params, ctx, rng);
      if (outcome.rejected) {
        return { ...state, log: [...state.log, `Attack rejected: ${outcome.rejected}`] };
      }
      let after = resolveEmergencyDisembarks(outcome.state, ctx, rng);
      // Fights-on-death expires once the unit has fought — its dying models are removed.
      if (after.units.find((u) => u.id === intent.attackerUnitId)?.status.hasFought) {
        after = sweepDyingModels(after, [intent.attackerUnitId], ctx);
      }
      return recordKills(state, after, ctx);
    }

    case 'ShootUnit': {
      if (!ctx) {
        return { ...state, log: [...state.log, 'Shooting ignored: no datasheet context supplied'] };
      }
      const { type: _t, ...params } = intent;
      const outcome = resolveUnitShooting(state, params, ctx, rng);
      if (outcome.rejected) {
        return { ...state, log: [...state.log, `Shooting rejected: ${outcome.rejected}`] };
      }
      let next = recordKills(state, resolveEmergencyDisembarks(outcome.state, ctx, rng), ctx);
      // Post-shoot per-unit specials (CP): Punishing Volley / Guidance of the Ancients.
      next = cpPostShootAbilities(next, intent.attackerUnitId, intent.targetUnitId, ctx, rng);
      return next;
    }

    case 'FightUnit': {
      if (!ctx) {
        return { ...state, log: [...state.log, 'Fight ignored: no datasheet context supplied'] };
      }
      const { type: _t, ...params } = intent;
      const outcome = resolveUnitFight(state, params, ctx, rng);
      if (outcome.rejected) {
        return { ...state, log: [...state.log, `Fight rejected: ${outcome.rejected}`] };
      }
      // The activation is over: the unit has fought, so its dying models are removed.
      const after = sweepDyingModels(resolveEmergencyDisembarks(outcome.state, ctx, rng), [intent.attackerUnitId], ctx);
      return recordKills(state, after, ctx);
    }

    case 'Charge': {
      if (!ctx) return { ...state, log: [...state.log, 'Charge ignored: no datasheet context supplied'] };
      const { type: _t, ...params } = intent;
      return resolveCharge(state, params, ctx, rng).state;
    }

    case 'FightMove': {
      if (!ctx) return { ...state, log: [...state.log, 'Fight move ignored: no datasheet context supplied'] };
      const { type: _t, ...params } = intent;
      return resolveFightMove(state, params, ctx, rng).state;
    }

    case 'SurgeMove': {
      if (!ctx) return { ...state, log: [...state.log, 'Surge move ignored: no datasheet context supplied'] };
      const { type: _t, ...params } = intent;
      return resolveSurgeMove(state, params, ctx).state;
    }

    case 'RunCommandPhase': {
      if (!ctx) return { ...state, log: [...state.log, 'Command phase ignored: no datasheet context supplied'] };
      // In a real match, the Command phase runs in the Command phase, once per turn — it grants CP
      // and scores Primary, so repeats/off-phase runs would farm both.
      if (state.mode === 'match') {
        if (state.phase !== 'Command') {
          return { ...state, log: [...state.log, `Command phase rejected: it is the ${state.phase} phase`] };
        }
        if (state.commandRun) {
          return { ...state, log: [...state.log, 'Command phase rejected: already run this turn'] };
        }
      }
      // Run the phase (both players' CP, battle-shock), then the 11e mission bookkeeping:
      // start-of-turn snapshots + preambles, Tactical Mission draws (2/Command phase), and the
      // "end of your Command phase" primary scoring window (round 2+; round 5 fires at turn end).
      let next: GameState = { ...runCommandPhase(state, ctx, rng), commandRun: true };
      if (next.mode === 'match' && next.stage === 'battle') {
        next = missionsOnTurnStart(next, ctx);
        next = secondariesOnTurnStart(next, ctx);
        next = missionsOnCommandEnd(next, ctx);
        next = cpMissionsOnCommandEnd(next, ctx);
      }
      return next;
    }

    case 'IssueOrder':
      return {
        ...state,
        units: state.units.map((u) => {
          if (u.id !== intent.unitId) return u;
          let status = addEffect(u.status, intent.effectId);
          // Stalwart's Honours: an Order issued to the bearer's unit also applies Take Cover!.
          if (ordersEchoTakeCover(u) && intent.effectId.startsWith('order:') && intent.effectId !== 'order:take_cover') {
            status = addEffect(status, 'order:take_cover');
          }
          return { ...u, status };
        }),
        log: [...state.log, `Order ${intent.effectId} → ${intent.unitId}`],
      };

    case 'UseStratagem': {
      if (state.cp[intent.side] < intent.cost) {
        return { ...state, log: [...state.log, `Stratagem "${intent.name}" rejected: needs ${intent.cost} CP, ${intent.side} has ${state.cp[intent.side]}`] };
      }
      // Once per phase per stratagem (15.01) — tracked when the play carries a stable id.
      const useKey = intent.stratagemId ? `${intent.side}:${intent.stratagemId}` : undefined;
      if (useKey && state.mode === 'match' && state.stratUsed?.[useKey] === phaseKeyOf(state)) {
        return { ...state, log: [...state.log, `Stratagem "${intent.name}" rejected: already used this phase`] };
      }
      const cp = { ...state.cp, [intent.side]: state.cp[intent.side] - intent.cost };
      const track = useKey ? { stratUsed: { ...(state.stratUsed ?? {}), [useKey]: phaseKeyOf(state) } } : {};
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Stratagem "${intent.name}" rejected: ${why}`] });

      // ── Combat Patrol special effects (validated here; the generic path just applies an effect) ──
      if (intent.effectId === 'cp:secure_objective') {
        // Inquisitorial Mandate / Rapid Acquisition: end of your Movement phase, one objective
        // your unit controls becomes secured (14.03).
        const cpm = state.cpMissions;
        if (!cpm || !ctx) return reject('no Combat Patrol mission state');
        if (state.phase !== 'Movement' || state.activePlayer !== intent.side) return reject('end of your Movement phase only');
        if (intent.objectiveIdx == null || !intent.targetUnitId) return reject('pick a unit and an objective');
        const statuses = objectiveStatuses(state, ctx, cpm.attacker);
        const st = statuses[intent.objectiveIdx];
        if (!st) return reject('no such objective');
        if (st.controller !== intent.side) return reject('your side does not control that objective');
        const unit = state.units.find((u) => u.id === intent.targetUnitId);
        const shape = unit ? ctx.datasheets.get(unit.datasheetId)?.baseShape : undefined;
        const inRange = !!unit && unit.models.some(
          (m) => m.alive && withinObjectiveRange(m.pos, shape ? baseRadius(shape) : 0.63, st.point, state.layout),
        );
        if (!inRange) return reject('that unit is not within range of the objective');
        const securedBy = [...(cpm.securedBy ?? statuses.map(() => null))];
        securedBy[intent.objectiveIdx] = intent.side;
        return {
          ...state, cp, ...track,
          cpMissions: { ...cpm, securedBy },
          log: [...state.log, `${intent.side} uses "${intent.name}" (-${intent.cost} CP) — objective ${intent.objectiveIdx + 1} is secured`],
        };
      }
      if (intent.effectId === 'cp:pin') {
        // Suppressing Fire: the enemy unit is pinned (-2" M) until the start of your next
        // Command phase. ("Hit by those attacks" is the player's claim, not re-checked.)
        const target = state.units.find((u) => u.id === intent.targetUnitId);
        if (!target || target.owner === intent.side) return reject('pick an enemy unit');
        if (state.phase !== 'Shooting' || state.activePlayer !== intent.side) return reject('your Shooting phase only');
        return {
          ...state, cp, ...track,
          units: state.units.map((u) =>
            u.id === target.id ? { ...u, status: { ...u.status, pinnedUntil: (state.turnCounter ?? 0) + 2 } } : u,
          ),
          log: [...state.log, `${intent.side} uses "${intent.name}" (-${intent.cost} CP) — the target is pinned (-2" M)`],
        };
      }
      if (intent.effectId === 'cp:swift_embark') {
        // Swift Embarkation: end of the opponent's Fight phase, an unengaged INFANTRY unit wholly
        // within 6" of a friendly TRANSPORT embarks within it.
        if (!ctx) return reject('no datasheet context');
        const unit = state.units.find((u) => u.id === intent.targetUnitId);
        const transport = state.units.find((u) => u.id === intent.transportId);
        if (!unit || unit.owner !== intent.side) return reject('pick your unit');
        if (!transport || transport.owner !== intent.side) return reject('pick a friendly transport');
        if (state.phase !== 'Fight' || state.activePlayer === intent.side) return reject("end of your opponent's Fight phase only");
        if (unit.inReserves || transport.inReserves) return reject('both units must be on the battlefield');
        if (engagedEnemies(unit, state, ctx).length > 0) return reject('the unit must be unengaged');
        const legal = canEmbark(state, unit, transport, ctx);
        if (!legal.ok) return reject(legal.reason!);
        const shape = ctx.datasheets.get(unit.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
        const tShape = ctx.datasheets.get(transport.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
        const tAlive = transport.models.filter((m) => m.alive);
        const near = unit.models.every(
          (m) => !m.alive || tAlive.some((tm) => gapBetweenBases(m.pos, shape, tm.pos, tShape) <= 6),
        );
        if (!near) return reject('every model must be wholly within 6" of the transport');
        return {
          ...state, cp, ...track,
          units: state.units.map((u) =>
            u.id === unit.id
              ? { ...u, inReserves: true, embarkedIn: transport.id, status: { ...u.status, justEmbarked: true } }
              : u,
          ),
          log: [...state.log, `${intent.side} uses "${intent.name}" (-${intent.cost} CP) — the unit embarks within the transport`],
        };
      }

      const units =
        intent.targetUnitId && intent.effectId
          ? state.units.map((u) =>
              u.id === intent.targetUnitId ? { ...u, status: addEffect(u.status, intent.effectId!) } : u,
            )
          : state.units;
      return {
        ...state,
        cp,
        ...track,
        units,
        log: [...state.log, `${intent.side} uses Stratagem "${intent.name}" (-${intent.cost} CP)${intent.effectId ? ` → ${intent.effectId}` : ''}`],
      };
    }

    case 'StartSanctification':
      return startSanctification(state, ctx, intent.unitId, intent.objectiveIdx);

    case 'DiscardSecondary': {
      const sec = state.secondaries?.[intent.side];
      if (!sec || !sec.hand.some((c) => c.id === intent.cardId)) {
        return { ...state, log: [...state.log, 'Discard rejected: that Tactical Mission is not in hand'] };
      }
      return {
        ...state,
        secondaries: {
          ...state.secondaries!,
          [intent.side]: {
            ...sec,
            hand: sec.hand.filter((c) => c.id !== intent.cardId),
            discard: [...sec.discard, intent.cardId],
          },
        },
        log: [...state.log, `${intent.side} discards Tactical Mission "${intent.cardId}"`],
      };
    }

    case 'StartAction': {
      if (!ctx) return { ...state, log: [...state.log, 'Action ignored: no datasheet context supplied'] };
      const { type: _t, ...params } = intent;
      return startAction(state, ctx, params);
    }

    case 'ChooseSecondaryMode': {
      const sec = state.secondaries?.[intent.side];
      if (!sec) return { ...state, log: [...state.log, 'Secondary mode rejected: no mission decks (start a battle first)'] };
      if (state.stage !== 'setup') return { ...state, log: [...state.log, 'Secondary mode rejected: choose before the battle begins'] };
      if (sec.mode) return { ...state, log: [...state.log, 'Secondary mode rejected: already chosen'] };
      if (intent.fixedCardIds) {
        const [a, b] = intent.fixedCardIds;
        const cards = [secondaryCard(a), secondaryCard(b)];
        if (a === b || cards.some((c) => !c?.fixed)) {
          return { ...state, log: [...state.log, 'Secondary mode rejected: pick two DIFFERENT fixed-capable cards'] };
        }
        return {
          ...state,
          secondaries: {
            ...state.secondaries!,
            [intent.side]: { ...sec, mode: 'fixed' as const, fixed: [{ id: a, drawn: 0 }, { id: b, drawn: 0 }], fixedVp: {}, deck: [] },
          },
          log: [...state.log, `${intent.side} chooses FIXED Secondary Missions (kept secret until the battle begins)`],
        };
      }
      return {
        ...state,
        secondaries: { ...state.secondaries!, [intent.side]: { ...sec, mode: 'tactical' as const } },
        log: [...state.log, `${intent.side} will draw Tactical Missions`],
      };
    }

    // ── Pre-battle setup / deployment ──────────────────────────────────────────
    case 'NewBattle': {
      const dispositions = intent.dispositions ?? { player: 'take_and_hold' as DispositionId, ai: 'take_and_hold' as DispositionId };
      const battleType = intent.battleType ?? 'standard';
      return {
        ...createInitialState(state.layout),
        stage: 'setup',
        mode: 'match',
        battleType,
        setup: { step: 'roll_roles', dispositions },
        // Each side shuffles its own Tactical Mission deck now (seeded — games stay reproducible).
        // Combat Patrol plays its own mission cards (later stage) — no Tactical deck.
        ...(battleType === 'combat_patrol' ? {} : { secondaries: initSecondaries(rng) }),
        turnKills: [],
        log: [
          battleType === 'combat_patrol'
            ? '— Combat Patrol — roll off to determine Attacker and Defender —'
            : '— Deployment — roll off to determine Attacker and Defender —',
        ],
      };
    }

    case 'RollRoles': {
      const ro = rollOff(rng);
      const attacker = ro.winner;
      const defender = otherSide(attacker);
      let next: GameState = {
        ...state,
        stage: 'setup',
        layout: layoutForAttacker(state.layout, attacker),
        setup: {
          ...(state.setup ?? { step: 'roll_roles' }),
          step: 'deploy',
          roleRoll: ro,
          attacker,
          defender,
          toDeploy: defender, // the Defender deploys first (mission sequence step 8)
        },
        log: [...state.log, `Roll-off: player ${ro.player}, ai ${ro.ai} → ${attacker} is Attacker; ${defender} deploys first`],
      };
      const dispositions = state.setup?.dispositions as Record<Side, DispositionId> | undefined;
      // Combat Patrol battles play the CP mission cards (a later stage), not the 11e CA deck.
      if (dispositions && next.layout.terrainAreas && state.battleType !== 'combat_patrol') {
        next = initMissions(next, ctx, dispositions, attacker);
      }
      return next;
    }

    case 'SetAttacker': {
      const attacker = intent.side;
      const defender = otherSide(attacker);
      let next: GameState = {
        ...state,
        stage: 'setup',
        layout: layoutForAttacker(state.layout, attacker),
        setup: { ...(state.setup ?? { step: 'roll_roles' }), step: 'deploy', attacker, defender, toDeploy: defender },
        log: [...state.log, `${attacker} is Attacker; ${defender} deploys first`],
      };
      const dispositions = state.setup?.dispositions as Record<Side, DispositionId> | undefined;
      if (dispositions && next.layout.terrainAreas && state.battleType !== 'combat_patrol') {
        next = initMissions(next, ctx, dispositions, attacker);
      }
      return next;
    }

    case 'DeployUnit': {
      // Aircraft must start in Strategic Reserves (23.01).
      if (state.mode === 'match' && ctx && isAircraft(ctx.datasheets.get(intent.datasheetId))) {
        return { ...state, log: [...state.log, 'Deployment rejected: AIRCRAFT must start in Strategic Reserves'] };
      }
      // Combat Patrol: some units MUST start in Strategic Reserves (e.g. Strike from the Warp).
      const cpRound = state.battleType === 'combat_patrol' ? ctx?.datasheets.get(intent.datasheetId)?.cpReserveRound : undefined;
      if (state.mode === 'match' && cpRound) {
        return {
          ...state,
          log: [...state.log, `Deployment rejected: this unit must start in Strategic Reserves (arrives battle round ${cpRound})`],
        };
      }
      // Start the battle embarked within a friendly transport (18.01) — capacity-checked; the
      // models are placeholders off the board until the unit disembarks.
      if (intent.intoTransportId) {
        const transport = state.units.find((u) => u.id === intent.intoTransportId);
        if (!transport || !ctx) {
          return { ...state, log: [...state.log, 'Deployment rejected: transport not found'] };
        }
        const carry = absorbCpEnhancementCarry(state, intent.owner, intent.datasheetId, intent.enhancementId);
        const models = layoutModels(
          { ...intent, wounds: intent.wounds + enhancementWoundBonus(carry.enhancementId, intent.modelCount) + (ctx ? abilityWoundBonus(ctx.datasheets.get(intent.datasheetId)) : 0), anchor: { x: 0, y: 0 } },
          state.layout,
        );
        const unit: UnitInstance = {
          id: intent.unitId, owner: intent.owner, datasheetId: intent.datasheetId,
          models, startingModels: models.length, status: {},
          inReserves: true, embarkedIn: transport.id,
          ...(intent.wargear ? { wargearCounts: intent.wargear } : {}),
          ...(carry.enhancementId ? { enhancementId: carry.enhancementId } : cpEnhancementFor(state, intent.owner, intent.datasheetId) ? { enhancementId: cpEnhancementFor(state, intent.owner, intent.datasheetId)! } : {}),
        };
        const check = canEmbark(state, unit, transport, ctx);
        if (!check.ok) {
          return { ...state, log: [...state.log, `Deployment rejected: ${check.reason}`] };
        }
        const setup = carry.state.setup ? { ...carry.state.setup, toDeploy: otherSide(intent.owner) } : carry.state.setup;
        const tName = ctx.datasheets.get(transport.datasheetId)?.name ?? transport.id;
        return {
          ...carry.state, units: [...carry.state.units, unit], setup,
          log: [...carry.state.log, `${intent.owner} deploys a unit embarked within ${tName}`],
        };
      }
      const ability = intent.ability ?? 'standard';
      const positions = formationWorld(intent);
      const enemies = enemyModelsOnBoard(state, intent.owner, ctx);
      const check = checkUnitDeployment(
        positions, intent.baseShape, state.layout, intent.owner, ability, enemies,
        occupiedBases(state, ctx),
        blockedByDense(ctx?.datasheets.get(intent.datasheetId)),
      );
      if (!check.legal) {
        return { ...state, log: [...state.log, `Deployment rejected (${intent.owner}): ${check.reason}`] };
      }
      const carry = absorbCpEnhancementCarry(state, intent.owner, intent.datasheetId, intent.enhancementId);
      const models = layoutModels(
        { ...intent, wounds: intent.wounds + enhancementWoundBonus(carry.enhancementId, intent.modelCount) + (ctx ? abilityWoundBonus(ctx.datasheets.get(intent.datasheetId)) : 0) },
        state.layout,
      );
      const grantAb = grantedDeployAbility(state, intent.unitId);
      const unit: UnitInstance = {
        id: intent.unitId, owner: intent.owner, datasheetId: intent.datasheetId,
        models, startingModels: models.length, status: {},
        ...(intent.wargear ? { wargearCounts: intent.wargear } : {}),
        ...(carry.enhancementId ? { enhancementId: carry.enhancementId } : cpEnhancementFor(state, intent.owner, intent.datasheetId) ? { enhancementId: cpEnhancementFor(state, intent.owner, intent.datasheetId)! } : {}),
        ...(grantAb ? { deployGrant: grantAb } : {}),
      };
      const setup = carry.state.setup ? { ...carry.state.setup, toDeploy: otherSide(intent.owner) } : carry.state.setup;
      return { ...carry.state, units: [...carry.state.units, unit], setup, log: [...carry.state.log, `${intent.owner} deploys a unit (${models.length} models)`] };
    }

    case 'PlaceInReserves': {
      // Off-board until it arrives; lay the models out at the origin as placeholders.
      const carry = absorbCpEnhancementCarry(state, intent.owner, intent.datasheetId, intent.enhancementId);
      const models = layoutModels(
        { ...intent, wounds: intent.wounds + enhancementWoundBonus(carry.enhancementId, intent.modelCount) + (ctx ? abilityWoundBonus(ctx.datasheets.get(intent.datasheetId)) : 0), anchor: { x: 0, y: 0 } },
        state.layout,
      );
      // The Declare Battle Formations grant (Combat Landers' Deep Strike) must survive into the
      // battle stage (BeginBattle clears setup) — stamp it on the unit.
      const grantAb = grantedDeployAbility(state, intent.unitId);
      const unit: UnitInstance = {
        id: intent.unitId, owner: intent.owner, datasheetId: intent.datasheetId,
        models, startingModels: models.length, status: {}, inReserves: true,
        ...(intent.wargear ? { wargearCounts: intent.wargear } : {}),
        ...(carry.enhancementId ? { enhancementId: carry.enhancementId } : cpEnhancementFor(state, intent.owner, intent.datasheetId) ? { enhancementId: cpEnhancementFor(state, intent.owner, intent.datasheetId)! } : {}),
        ...(grantAb ? { deployGrant: grantAb } : {}),
      };
      const setup = carry.state.setup ? { ...carry.state.setup, toDeploy: otherSide(intent.owner) } : carry.state.setup;
      return { ...carry.state, units: [...carry.state.units, unit], setup, log: [...carry.state.log, `${intent.owner} places a unit in Reserves`] };
    }

    case 'AttachLeader': {
      // Merge the Leader into the Bodyguard: ONE unit instance. The Leader's models live in the
      // Bodyguard, tagged with their datasheetId (so the merged unit keeps the Leader's profile and
      // can fire the Leader's weapons). The Leader unit instance is removed.
      const leader = state.units.find((u) => u.id === intent.leaderUnitId);
      const bodyguard = state.units.find((u) => u.id === intent.bodyguardUnitId);
      if (!leader || !bodyguard) return { ...state, log: [...state.log, 'Attach rejected: unit not found'] };
      if (leader.attachedTo || (leader.attachedLeaders?.length ?? 0) > 0) {
        return { ...state, log: [...state.log, 'Attach rejected: leader already merged'] };
      }
      // 10e: a unit can normally have only ONE Leader attached.
      if ((bodyguard.attachedLeaders?.length ?? 0) > 0) {
        return { ...state, log: [...state.log, 'Attach rejected: that unit already has a Leader (one Leader per unit)'] };
      }
      if (ctx) {
        const lDs = ctx.datasheets.get(leader.datasheetId);
        const bDs = ctx.datasheets.get(bodyguard.datasheetId);
        if (!canAttach(lDs, bDs, leader.enhancementId)) {
          return { ...state, log: [...state.log, `Attach rejected: ${lDs?.name ?? leader.id} cannot lead ${bDs?.name ?? bodyguard.id}`] };
        }
      }
      // Attaching means the Leader physically joins the unit: snap its models into base-to-base
      // coherency with the Bodyguard (no overlap with anything on the board).
      const lShape = ctx?.datasheets.get(leader.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
      const bShape = ctx?.datasheets.get(bodyguard.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
      const occupied = state.units
        .filter((u) => u.id !== leader.id && !u.inReserves)
        .flatMap((u) =>
          u.models
            .filter((m) => m.alive)
            .map((m) => ({
              pos: m.pos,
              shape:
                (m.datasheetId ? ctx?.datasheets.get(m.datasheetId)?.baseShape : undefined) ??
                ctx?.datasheets.get(u.datasheetId)?.baseShape ??
                FALLBACK_SHAPE,
            })),
        );
      const bgAlive = bodyguard.models.filter((m) => m.alive).map((m) => m.pos);
      // During deployment, the joining Leader's models must be legally placed too: wholly within
      // the zone when the Bodyguard deployed in-zone, or > 9" from enemies for an infiltrated /
      // midfield unit. (In-battle attaches are unrestricted — the unit is already wherever it is.)
      const joinLegal =
        state.stage === 'setup'
          ? (pos: Vec2): boolean => {
              const bodyguardInZone = bgAlive.every((p) => whollyInOwnZone(p, bShape, state.layout, bodyguard.owner));
              if (bodyguardInZone) return whollyInOwnZone(pos, lShape, state.layout, bodyguard.owner);
              const enemies = enemyModelsOnBoard(state, bodyguard.owner, ctx);
              return enemies.every((e) => gapBetweenBases(pos, lShape, e.pos, e.shape) > 9);
            }
          : undefined;
      const joined =
        bodyguard.inReserves || bgAlive.length === 0
          ? null
          : leaderJoinPositions(
              leader.models.filter((m) => m.alive).length,
              lShape,
              bgAlive,
              bShape,
              occupied,
              { width: state.layout.boardWidth, height: state.layout.boardHeight },
              joinLegal,
            );
      let joinCursor = 0;
      const leaderModels = leader.models.map((m) => ({
        ...m,
        unitId: bodyguard.id,
        datasheetId: leader.datasheetId,
        ...(joined && m.alive ? { pos: joined[joinCursor++]! } : {}),
      }));
      const merged: UnitInstance = {
        ...bodyguard,
        models: [...bodyguard.models, ...leaderModels],
        startingModels: bodyguard.startingModels + leaderModels.length,
        attachedLeaders: [
          ...(bodyguard.attachedLeaders ?? []),
          {
            unitId: leader.id, datasheetId: leader.datasheetId, modelCount: leaderModels.length,
            wounds: leader.models[0]?.wounds ?? 1,
            ...(leader.wargearCounts ? { wargearCounts: leader.wargearCounts } : {}),
            ...(leader.enhancementId ? { enhancementId: leader.enhancementId } : {}),
          },
        ],
      };
      return {
        ...state,
        units: state.units.filter((u) => u.id !== leader.id).map((u) => (u.id === bodyguard.id ? merged : u)),
        log: [...state.log, 'Leader merged into its Bodyguard unit (placed in coherency with it)'],
      };
    }

    case 'DetachLeader': {
      // Split a merged Leader back out into its own unit instance.
      const bodyguard = state.units.find((u) => (u.attachedLeaders ?? []).some((l) => l.unitId === intent.leaderUnitId));
      if (!bodyguard) return state;
      const rec = bodyguard.attachedLeaders!.find((l) => l.unitId === intent.leaderUnitId)!;
      const leaderModels = bodyguard.models
        .filter((m) => m.datasheetId === rec.datasheetId)
        .map((m) => ({ ...m, unitId: rec.unitId, datasheetId: undefined }));
      const remaining = bodyguard.models.filter((m) => m.datasheetId !== rec.datasheetId);
      const newBodyguard: UnitInstance = {
        ...bodyguard,
        models: remaining,
        startingModels: Math.max(0, bodyguard.startingModels - rec.modelCount),
        attachedLeaders: (bodyguard.attachedLeaders ?? []).filter((l) => l.unitId !== intent.leaderUnitId),
      };
      const leaderUnit: UnitInstance = {
        id: rec.unitId, owner: bodyguard.owner, datasheetId: rec.datasheetId,
        models: leaderModels, startingModels: rec.modelCount, status: {},
        ...(rec.wargearCounts ? { wargearCounts: rec.wargearCounts } : {}),
        ...(rec.enhancementId ? { enhancementId: rec.enhancementId } : {}),
      };
      return {
        ...state,
        units: [...state.units.map((u) => (u.id === bodyguard.id ? newBodyguard : u)), leaderUnit],
        log: [...state.log, 'Leader detached from its Bodyguard unit'],
      };
    }

    case 'DeclareFormation': {
      if (state.stage !== 'setup' || state.setup?.step !== 'deploy') {
        return { ...state, log: [...state.log, 'Formation rejected: declare Leader pairings during deployment'] };
      }
      if (isUnitPlaced(state, intent.leaderKey) || isUnitPlaced(state, intent.bodyguardKey)) {
        return { ...state, log: [...state.log, 'Formation rejected: that unit is already deployed'] };
      }
      const formations = state.setup.formations ?? [];
      if (formations.some((f) => f.leaderKey === intent.leaderKey)) {
        return { ...state, log: [...state.log, 'Formation rejected: that Leader is already paired'] };
      }
      if (formations.some((f) => f.bodyguardKey === intent.bodyguardKey)) {
        return { ...state, log: [...state.log, 'Formation rejected: that unit already has a Leader (one Leader per unit)'] };
      }
      const lDs = ctx?.datasheets.get(intent.leaderDsId);
      const bDs = ctx?.datasheets.get(intent.bodyguardDsId);
      if (!ctx || !lDs || !bDs || !canAttach(lDs, bDs, intent.leaderEnhancementId)) {
        return { ...state, log: [...state.log, `Formation rejected: ${lDs?.name ?? intent.leaderDsId} cannot lead ${bDs?.name ?? intent.bodyguardDsId}`] };
      }
      const infiltrate = pairInfiltrates(lDs, bDs, formations, intent.side, ctx);
      const declared: DeclaredFormation = {
        side: intent.side,
        leaderKey: intent.leaderKey,
        leaderDsId: intent.leaderDsId,
        bodyguardKey: intent.bodyguardKey,
        bodyguardDsId: intent.bodyguardDsId,
        ...(infiltrate ? { infiltrate } : {}),
      };
      return {
        ...state,
        setup: { ...state.setup, formations: [...formations, declared] },
        log: [...state.log, `${intent.side} declares ${lDs!.name} will lead ${bDs!.name}${infiltrate ? ' (unit gains Infiltrators)' : ''}`],
      };
    }

    case 'ClearFormation': {
      if (state.stage !== 'setup' || !state.setup?.formations) return state;
      const f = state.setup.formations.find((x) => x.leaderKey === intent.leaderKey);
      if (!f) return state;
      if (isUnitPlaced(state, f.bodyguardKey)) {
        return { ...state, log: [...state.log, 'Formation kept: the pair is already deployed (detach the Leader instead)'] };
      }
      return {
        ...state,
        setup: { ...state.setup, formations: state.setup.formations.filter((x) => x.leaderKey !== intent.leaderKey) },
        log: [...state.log, 'Leader pairing cleared'],
      };
    }

    case 'DeclareSplit': {
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Split rejected: ${why}`] });
      if (state.stage !== 'setup' || state.setup?.step !== 'deploy') return reject('declare splits during deployment');
      if (!ctx) return reject('no datasheet context supplied');
      if (state.setup.splits?.some((s) => s.entryKey === intent.entryKey)) return reject('that unit is already split');
      if (isUnitPlaced(state, intent.entryKey)) return reject('that unit is already deployed');
      if ((state.setup.formations ?? []).some((f) => f.leaderKey === intent.entryKey || f.bodyguardKey === intent.entryKey)) {
        return reject('that unit is in a declared Leader pairing');
      }
      const transport = state.units.find((u) => u.id === intent.transportUnitId);
      if (!transport || transport.owner !== intent.side || transport.inReserves || !transport.models.some((m) => m.alive)) {
        return reject('the transport must be deployed on the battlefield first');
      }
      const tDs = ctx.datasheets.get(transport.datasheetId);
      const uDs = ctx.datasheets.get(intent.datasheetId);
      const rule = transportSplitRule(tDs);
      if (!tDs || !rule) return reject(`${tDs?.name ?? transport.id} has no Declare Battle Formations split rule`);
      if (!uDs || !splitRuleSelects(rule, uDs)) {
        return reject(`${tDs.name} cannot select ${uDs?.name ?? intent.datasheetId} (rule: ${rule.selectTokens.join(' ').toUpperCase()})`);
      }
      if (!splitRideCounts(intent.modelCount).includes(intent.rideCount)) {
        return reject(`the two units must be as equal as possible (${intent.modelCount} models → ${splitRideCounts(intent.modelCount).join(' or ')} may ride)`);
      }
      // Partition the wargear: the riding half takes `rideWargear`, the rest walks.
      const total = intent.totalWargear ?? {};
      const rideWargear: Record<string, number> = {};
      const footWargear: Record<string, number> = { ...total };
      const footCountCheck = intent.modelCount - intent.rideCount;
      for (const [item, n] of Object.entries(intent.rideWargear ?? {})) {
        if (n <= 0) continue;
        if (n > (total[item] ?? 0)) return reject(`the unit only has ${total[item] ?? 0}× ${item}`);
        // An item can't have more bearers in a half than that half has models.
        if (n > intent.rideCount) return reject(`only ${intent.rideCount} models ride — they cannot carry ${n}× ${item}`);
        if ((total[item] ?? 0) - n > footCountCheck) {
          return reject(`${(total[item] ?? 0) - n}× ${item} would be left with only ${footCountCheck} models on foot`);
        }
        rideWargear[item] = n;
        const left = (footWargear[item] ?? 0) - n;
        if (left > 0) footWargear[item] = left;
        else delete footWargear[item];
      }
      // Items not mentioned in rideWargear stay whole with the on-foot half — they too need bearers.
      for (const [item, n] of Object.entries(footWargear)) {
        if (n > footCountCheck && !(item in rideWargear)) {
          return reject(`${n}× ${item} would be left with only ${footCountCheck} models on foot — allocate some to the riders`);
        }
      }
      // Build the riding half embarked within the transport (capacity/keyword checked).
      const rideId = `${intent.entryKey}#a`;
      const rideModels = layoutModels(
        { unitId: rideId, baseShape: intent.baseShape, modelCount: intent.rideCount, wounds: intent.wounds, anchor: { x: 0, y: 0 }, wargear: rideWargear },
        state.layout,
      );
      const rider: UnitInstance = {
        id: rideId, owner: intent.side, datasheetId: intent.datasheetId,
        models: rideModels, startingModels: rideModels.length, status: {},
        inReserves: true, embarkedIn: transport.id,
        ...(Object.keys(rideWargear).length ? { wargearCounts: rideWargear } : {}),
      };
      const check = canEmbark(state, rider, transport, ctx);
      if (!check.ok) return reject(check.reason!);
      const footCount = intent.modelCount - intent.rideCount;
      const split = {
        side: intent.side,
        entryKey: intent.entryKey,
        dsId: intent.datasheetId,
        transportUnitId: transport.id,
        groups: [
          { count: intent.rideCount, ...(Object.keys(rideWargear).length ? { wargear: rideWargear } : {}) },
          { count: footCount, ...(Object.keys(footWargear).length ? { wargear: footWargear } : {}) },
        ] as [SplitGroup, SplitGroup],
      };
      const setup = { ...state.setup, splits: [...(state.setup.splits ?? []), split], toDeploy: otherSide(intent.side) };
      return {
        ...state,
        units: [...state.units, rider],
        setup,
        log: [
          ...state.log,
          `${intent.side} splits ${uDs.name}: ${intent.rideCount} models start embarked within ${tDs.name}` +
            `${Object.keys(rideWargear).length ? ` (carrying ${Object.entries(rideWargear).map(([k, v]) => `${v}× ${k}`).join(', ')})` : ''}` +
            `; ${footCount} deploy separately`,
        ],
      };
    }

    case 'DeclareCombatSquad': {
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Combat Squad rejected: ${why}`] });
      if (state.stage !== 'setup' || state.setup?.step !== 'deploy') return reject('declare Combat Squads during deployment');
      if (!ctx) return reject('no datasheet context supplied');
      const ds = ctx.datasheets.get(intent.datasheetId);
      if (!ds || !hasAbilityStarting(ds, 'combat squad')) return reject(`${ds?.name ?? intent.datasheetId} has no COMBAT SQUAD ability`);
      if (intent.modelCount !== 10) return reject('COMBAT SQUAD splits a 10-model unit into two units of five');
      if (state.setup.splits?.some((s) => s.entryKey === intent.entryKey)) return reject('that unit is already split');
      if (isUnitPlaced(state, intent.entryKey)) return reject('that unit is already deployed');
      if ((state.setup.formations ?? []).some((f) => f.leaderKey === intent.entryKey || f.bodyguardKey === intent.entryKey)) {
        return reject('that unit is in a declared Leader pairing');
      }
      // Partition the wargear as evenly as possible (half A takes the odd item).
      const a: Record<string, number> = {};
      const b: Record<string, number> = {};
      for (const [item, n] of Object.entries(intent.totalWargear ?? {})) {
        if (n <= 0) continue;
        const toA = Math.min(5, Math.ceil(n / 2));
        const toB = n - toA;
        if (toB > 5) return reject(`${n}× ${item} cannot be carried by two units of five`);
        if (toA > 0) a[item] = toA;
        if (toB > 0) b[item] = toB;
      }
      const split: DeclaredSplit = {
        side: intent.side,
        entryKey: intent.entryKey,
        dsId: intent.datasheetId,
        groups: [
          { count: 5, ...(Object.keys(a).length ? { wargear: a } : {}) },
          { count: 5, ...(Object.keys(b).length ? { wargear: b } : {}) },
        ],
      };
      return {
        ...state,
        setup: { ...state.setup, splits: [...(state.setup.splits ?? []), split] },
        log: [...state.log, `${intent.side} splits ${ds.name} into two Combat Squads of five`],
      };
    }

    case 'ChooseCpEnhancement': {
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Enhancement rejected: ${why}`] });
      if (state.battleType !== 'combat_patrol') return reject('Combat Patrol battles only');
      if (state.stage !== 'setup') return reject('pick the enhancement during setup');
      if (state.cpEnhancements?.[intent.side]) return reject('already decided (one enhancement per patrol)');
      const pick = { id: intent.enhancementId, ...(intent.targetDsId ? { targetDsId: intent.targetDsId } : {}) };
      let next: GameState = {
        ...state,
        cpEnhancements: { ...(state.cpEnhancements ?? {}), [intent.side]: pick },
        log: [
          ...state.log,
          intent.enhancementId
            ? `${intent.side} takes the ${intent.enhancementId.split(':')[2]?.replace(/_/g, ' ')} enhancement`
            : `${intent.side} declines an enhancement`,
        ],
      };
      // Stamp retroactively when the bearer is already down (deployed or reserved).
      if (intent.enhancementId && intent.targetDsId) {
        const bearer = next.units.find(
          (u) => u.owner === intent.side && u.datasheetId === intent.targetDsId && !u.enhancementId,
        );
        if (bearer) {
          next = {
            ...next,
            units: next.units.map((u) => (u.id === bearer.id ? { ...u, enhancementId: intent.enhancementId! } : u)),
          };
        }
      }
      return next;
    }

    case 'ClearSplit': {
      if (state.stage !== 'setup' || state.setup?.step !== 'deploy') {
        return { ...state, log: [...state.log, 'Split kept: the battle is under way'] };
      }
      const split = state.setup.splits?.find((s) => s.entryKey === intent.entryKey);
      if (!split) return state;
      const halfIds = [`${intent.entryKey}#a`, `${intent.entryKey}#b`];
      return {
        ...state,
        units: state.units.filter((u) => !halfIds.includes(u.id)),
        setup: {
          ...state.setup,
          splits: state.setup.splits!.filter((s) => s.entryKey !== intent.entryKey),
          // A Leader pairing declared onto a half-unit would dangle once the halves vanish.
          formations: (state.setup.formations ?? []).filter(
            (f) => !halfIds.includes(f.bodyguardKey) && !halfIds.includes(f.leaderKey),
          ),
        },
        log: [...state.log, 'Split cleared — the unit re-enters the deployment flow whole'],
      };
    }

    case 'UndeployUnit': {
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Undo rejected: ${why}`] });
      if (state.stage !== 'setup' || state.setup?.step !== 'deploy') return reject('only during deployment');
      const unit = state.units.find((u) => u.id === intent.unitId);
      if (!unit) return reject('unit not found');
      if (!unit.embarkedIn) return reject('only a start-embarked deployment can be undone here');
      // The RIDING half of a split (#a) must stay embarked in its transport — undo the whole
      // split instead. The on-foot half (#b) that chose to embark elsewhere may freely undo.
      if (state.setup.splits?.some((s) => intent.unitId === `${s.entryKey}#a`)) {
        return reject('that unit is the riding half of a declared split — clear the split instead');
      }
      return {
        ...state,
        units: state.units.filter((u) => u.id !== unit.id),
        log: [...state.log, `${ctx?.datasheets.get(unit.datasheetId)?.name ?? unit.id} disembarks back into the deployment pool`],
      };
    }

    case 'DeclareEnhancementGrant': {
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Enhancement grant rejected: ${why}`] });
      if (state.stage !== 'setup' || state.setup?.step !== 'deploy') return reject('declare during deployment');
      const rule = PREBATTLE_GRANTS[intent.enhancementId];
      if (!rule) return reject('that enhancement has no Declare Battle Formations grant');
      if ((state.setup.grants ?? []).some((g) => g.side === intent.side && g.enhancementId === intent.enhancementId)) {
        return reject('already declared');
      }
      if (intent.entries.length > rule.count) return reject(`select up to ${rule.count} units`);
      const keys = new Set(intent.entries.map((e) => e.entryKey));
      if (keys.size !== intent.entries.length) return reject('each unit may be selected once');
      for (const e of intent.entries) {
        const ds = ctx?.datasheets.get(e.datasheetId);
        if (!ds || !grantSelects(rule, ds)) {
          return reject(`${ds?.name ?? e.datasheetId} does not qualify for ${rule.label}`);
        }
        if (isUnitPlaced(state, e.entryKey)) {
          return reject(`${ds.name} is already deployed — declare the grant before placing it`);
        }
      }
      const grant = {
        side: intent.side, enhancementId: intent.enhancementId, label: rule.label,
        grant: rule.grant, entryKeys: intent.entries.map((e) => e.entryKey),
      };
      return {
        ...state,
        setup: { ...state.setup, grants: [...(state.setup.grants ?? []), grant] },
        log: [
          ...state.log,
          intent.entries.length === 0
            ? `${intent.side} declines the ${rule.label} grant`
            : `${intent.side} · ${rule.label}: ${intent.entries.length} unit(s) gain ${rule.grant === 'infiltrators' ? 'Infiltrators' : 'Deep Strike'}`,
        ],
      };
    }

    case 'UseEnhancementRedeploy': {
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Redeploy rejected: ${why}`] });
      if (state.stage !== 'setup' || state.setup?.step !== 'deploy') return reject('only during deployment');
      const rule = REDEPLOY_RULES[intent.enhancementId];
      if (!rule) return reject('that enhancement has no redeploy');
      if (state.setup.redeploy?.[intent.side]) return reject('already used');
      return {
        ...state,
        setup: {
          ...state.setup,
          redeploy: {
            ...state.setup.redeploy,
            [intent.side]: { enhancementId: intent.enhancementId, label: rule.label, remaining: rule.count },
          },
        },
        log: [...state.log, `${intent.side} uses ${rule.label}: redeploy up to ${rule.count} unit(s)`],
      };
    }

    case 'DeclineEnhancementRedeploy': {
      if (state.stage !== 'setup' || !state.setup) return state;
      const rule = REDEPLOY_RULES[intent.enhancementId];
      const existing = state.setup.redeploy?.[intent.side];
      return {
        ...state,
        setup: {
          ...state.setup,
          redeploy: {
            ...state.setup.redeploy,
            [intent.side]: {
              enhancementId: intent.enhancementId,
              label: existing?.label ?? rule?.label ?? 'Redeploy',
              remaining: 0,
            },
          },
        },
        log: [...state.log, `${intent.side} ${existing ? 'finishes' : 'declines'} the ${existing?.label ?? rule?.label ?? ''} redeploy`.replace('  ', ' ')],
      };
    }

    case 'EnhancementRedeploy': {
      const unit = state.units.find((u) => u.id === intent.unitId);
      if (!unit || state.stage !== 'setup') {
        return { ...state, log: [...state.log, 'Redeploy rejected: unit not found'] };
      }
      const red = state.setup?.redeploy?.[unit.owner];
      if (!red || red.remaining <= 0) {
        return { ...state, log: [...state.log, 'Redeploy rejected: no enhancement redeploys remaining'] };
      }
      const rule = REDEPLOY_RULES[red.enhancementId];
      const ds = ctx?.datasheets.get(unit.datasheetId);
      if (!rule || !redeployRuleSelects(rule, ds)) {
        return { ...state, log: [...state.log, `Redeploy rejected: ${ds?.name ?? unit.id} does not qualify for ${red.label}`] };
      }
      // A transport with start-embarked passengers would strand them (dangling embarkedIn).
      if (state.units.some((u) => u.embarkedIn === unit.id)) {
        return { ...state, log: [...state.log, `Redeploy rejected: ${ds?.name ?? unit.id} is carrying embarked units — undo their embark first`] };
      }
      // Pull the unit (and any merged Leader) off the board — its roster entries become
      // undeployed again and re-enter the normal deployment flow (board or Reserves).
      return {
        ...state,
        units: state.units.filter((u) => u.id !== unit.id),
        setup: {
          ...state.setup!,
          redeploy: { ...state.setup!.redeploy, [unit.owner]: { ...red, remaining: red.remaining - 1 } },
        },
        log: [...state.log, `${red.label}: ${ds?.name ?? unit.id} is pulled back for redeployment (${red.remaining - 1} left)`],
      };
    }

    case 'UseWarrant': {
      if (state.stage !== 'setup' || state.setup?.step !== 'deploy') {
        return { ...state, log: [...state.log, 'Warrant of Trade rejected: only during deployment'] };
      }
      if (state.setup.warrant?.[intent.side]) {
        return { ...state, log: [...state.log, 'Warrant of Trade rejected: already used'] };
      }
      const rolled = rng.int(1, 3);
      return {
        ...state,
        setup: { ...state.setup, warrant: { ...state.setup.warrant, [intent.side]: { side: intent.side, rolled, remaining: rolled } } },
        log: [...state.log, `${intent.side} uses Warrant of Trade: D3 = ${rolled} — redeploy up to ${rolled} IMPERIUM BATTLELINE unit(s)`],
      };
    }

    case 'DeclineWarrant': {
      if (state.stage !== 'setup' || !state.setup) return state;
      const existing = state.setup.warrant?.[intent.side];
      return {
        ...state,
        setup: {
          ...state.setup,
          warrant: { ...state.setup.warrant, [intent.side]: { side: intent.side, rolled: existing?.rolled ?? 0, remaining: 0 } },
        },
        log: [...state.log, `${intent.side} ${existing ? 'finishes' : 'declines'} the Warrant of Trade redeploy`],
      };
    }

    case 'WarrantRedeploy': {
      const unit = state.units.find((u) => u.id === intent.unitId);
      if (!unit || state.stage !== 'setup') {
        return { ...state, log: [...state.log, 'Redeploy rejected: unit not found'] };
      }
      const warrant = state.setup?.warrant?.[unit.owner];
      if (!warrant || warrant.remaining <= 0) {
        return { ...state, log: [...state.log, 'Redeploy rejected: no Warrant of Trade redeploys remaining'] };
      }
      const ds = ctx?.datasheets.get(unit.datasheetId);
      const kws = (ds?.keywords ?? []).map((k) => k.toLowerCase());
      if (!kws.includes('imperium') || !kws.includes('battleline')) {
        return { ...state, log: [...state.log, `Redeploy rejected: ${ds?.name ?? unit.id} is not an IMPERIUM BATTLELINE unit`] };
      }
      // Pull the unit (and any merged Leader) off the board — its roster entries become
      // undeployed again and re-enter the normal deployment flow (board or Reserves).
      return {
        ...state,
        units: state.units.filter((u) => u.id !== unit.id),
        setup: {
          ...state.setup!,
          warrant: { ...state.setup!.warrant, [unit.owner]: { ...warrant, remaining: warrant.remaining - 1 } },
        },
        log: [...state.log, `${unit.owner} pulls ${ds?.name ?? unit.id} back for redeployment (Warrant of Trade, ${warrant.remaining - 1} left)`],
      };
    }

    case 'RollFirstTurn': {
      const ro = rollOff(rng);
      // Scout moves happen at the start of the first battle round, before the first turn begins —
      // insert the 'scouts' step when any deployed unit has a Scouts X" move to make.
      const hasScouts =
        !!ctx && state.units.some((u) => !u.inReserves && u.models.some((m) => m.alive) && unitScoutDistance(u, ctx) != null);
      return {
        ...state,
        firstPlayer: ro.winner,
        activePlayer: ro.winner,
        setup: { ...(state.setup ?? { step: 'deploy' }), step: hasScouts ? 'scouts' : 'ready', firstTurnRoll: ro, firstTurn: ro.winner },
        log: [
          ...state.log,
          `First-turn roll-off: player ${ro.player}, ai ${ro.ai} → ${ro.winner} takes the first turn`,
          ...(hasScouts ? ['— Scout moves: units with Scouts X" may move before the battle begins —'] : []),
        ],
      };
    }

    case 'BeginBattle': {
      const first = state.setup?.firstTurn ?? state.firstPlayer;
      const attacker = state.setup?.attacker ?? first;
      let next: GameState = {
        ...state,
        stage: 'battle',
        setup: undefined,
        commandRun: false,
        round: 1,
        firstPlayer: first,
        activePlayer: first,
        phase: PARIAH_NEXUS_PHASES[0],
        ended: false,
        // Clean slate for round 1: pre-battle bookkeeping (Scout-move flags etc.) is not turn state.
        units: state.units.map((u) => ({
          ...u,
          status: {},
          models: u.models.map((m) => (m.moveStart ? { ...m, moveStart: undefined } : m)),
        })),
        log: [...state.log, `— Battle begins — ${first} takes the first turn (round 1) —`],
      };
      // Combat Patrol: each side now plays its patrol's own mission card.
      if (state.battleType === 'combat_patrol' && ctx) next = initCpMissions(next, ctx, attacker);
      return next;
    }

    // ── Movement ───────────────────────────────────────────────────────────────
    case 'BeginMove': {
      let log = state.log;
      // Scout moves are a pre-battle activation: only during the setup 'scouts' step, only for
      // units with a Scouts X" move they have not resolved yet. Budget = X (not M).
      if (intent.mode === 'scout') {
        if (state.mode === 'match' && (state.stage !== 'setup' || state.setup?.step !== 'scouts')) {
          return { ...state, log: [...log, 'Scout move rejected: only during the pre-battle Scout step'] };
        }
        const units = state.units.map((u) => {
          if (!intent.unitIds.includes(u.id)) return u;
          if (u.status.scouted) {
            log = [...log, `${ctx?.datasheets.get(u.datasheetId)?.name ?? u.id} has already made its Scout move`];
            return u;
          }
          const X = ctx ? unitScoutDistance(u, ctx) : null;
          if (X == null) {
            log = [...log, `${ctx?.datasheets.get(u.datasheetId)?.name ?? u.id} has no Scouts ability`];
            return u;
          }
          return {
            ...u,
            status: { ...u.status, moveMode: intent.mode, moveBudget: X },
            models: u.models.map((m) => (m.alive ? { ...m, moveStart: m.pos } : m)),
          };
        });
        return { ...state, units, log };
      }
      // Battle moves happen in the battle stage (the sandbox stays free).
      if (state.mode === 'match' && state.stage !== 'battle') {
        return { ...state, log: [...log, 'Move rejected: the battle has not begun'] };
      }
      // Aircraft only make ingress moves (23.02).
      if (state.mode === 'match' && ctx) {
        const aircraft = state.units.find(
          (u) => intent.unitIds.includes(u.id) && isAircraft(ctx.datasheets.get(u.datasheetId)),
        );
        if (aircraft) return { ...state, log: [...log, 'Move rejected: AIRCRAFT only make ingress moves'] };
      }
      // A unit moves once per Movement phase — in a match, re-activating an already-moved unit
      // (even after an Advance) is rejected. The flags reset at the start of the unit's next turn.
      const alreadyMoved = (u: UnitInstance) =>
        !!(u.status.moved || u.status.advanced || u.status.fellBack || u.status.remainedStationary);
      const blockedIds =
        state.mode === 'match'
          ? new Set(state.units.filter((u) => intent.unitIds.includes(u.id) && alreadyMoved(u)).map((u) => u.id))
          : new Set<string>();
      if (blockedIds.size > 0) {
        const names = state.units
          .filter((u) => blockedIds.has(u.id))
          .map((u) => ctx?.datasheets.get(u.datasheetId)?.name ?? u.id);
        log = [...log, `Already moved this turn: ${names.join(', ')}`];
      }
      const units = state.units.map((u) => {
        if (!intent.unitIds.includes(u.id) || blockedIds.has(u.id)) return u;
        const M = ctx?.datasheets.get(u.datasheetId)?.models[0]?.M ?? 6;
        let advanceRoll = 0;
        if (intent.mode === 'advance') {
          advanceRoll = rollAdvance(rng).roll;
          log = [...log, `Advance roll: +${advanceRoll}" (move up to ${M + advanceRoll}")`];
        }
        const orderBonus = intent.mode === 'stationary' ? 0 : moveBonusFromOrders(u); // Move! Move! Move! +3"
        // Pinned (Suppressing Fire): -2" Move until the caster's next Command phase.
        const pinMalus =
          intent.mode !== 'stationary' && u.status.pinnedUntil != null && (state.turnCounter ?? 0) < u.status.pinnedUntil ? 2 : 0;
        const budget = Math.max(0, maxMoveDistance(M, intent.mode, advanceRoll) + orderBonus - pinMalus);
        return {
          ...u,
          status: { ...u.status, moveMode: intent.mode, moveBudget: budget },
          models: u.models.map((m) => (m.alive ? { ...m, moveStart: m.pos } : m)),
        };
      });
      return { ...state, units, log };
    }

    case 'RerollAdvance': {
      // Command Re-roll on the Advance D6: only mid-activation, before any model has moved.
      const unit = state.units.find((u) => u.id === intent.unitId);
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Advance re-roll rejected: ${why}`] });
      if (!unit || unit.owner !== intent.side) return reject('unit not found');
      if (unit.status.moveMode !== 'advance' || unit.status.moveBudget == null) return reject('the unit is not mid-Advance');
      if (unit.models.some((m) => m.alive && m.moveStart && (m.pos.x !== m.moveStart.x || m.pos.y !== m.moveStart.y))) {
        return reject('re-roll before moving any model');
      }
      const phaseKey = phaseKeyOf(state);
      if (state.mode === 'match') {
        if (state.cp[intent.side] < 1) return reject('needs 1 CP');
        if (state.rerollUsed?.[intent.side] === phaseKey) return reject('Command Re-roll already used this phase');
      }
      const M = ctx?.datasheets.get(unit.datasheetId)?.models[0]?.M ?? 6;
      const roll = rollAdvance(rng).roll;
      const orderBonus = moveBonusFromOrders(unit);
      const pinMalus = unit.status.pinnedUntil != null && (state.turnCounter ?? 0) < unit.status.pinnedUntil ? 2 : 0;
      const budget = Math.max(0, maxMoveDistance(M, 'advance', roll) + orderBonus - pinMalus);
      return {
        ...state,
        units: state.units.map((u) => (u.id === unit.id ? { ...u, status: { ...u.status, moveBudget: budget } } : u)),
        ...(state.mode === 'match'
          ? {
              cp: { ...state.cp, [intent.side]: state.cp[intent.side] - 1 },
              rerollUsed: { ...(state.rerollUsed ?? {}), [intent.side]: phaseKey },
            }
          : {}),
        log: [...state.log, `Command Re-roll (1 CP): Advance re-rolled → +${roll}" (move up to ${budget}")`],
      };
    }

    case 'NudgeUnit': {
      // Incremental translate (delta since the last pointer event), clamped per model to the move
      // budget measured from its origin. Stateless for the UI — it just streams small deltas.
      const units = state.units.map((u) => {
        if (!intent.unitIds.includes(u.id)) return u;
        const budget = u.status.moveBudget ?? 0;
        return {
          ...u,
          models: u.models.map((m) => {
            if (!m.alive || !m.moveStart) return m;
            const target = { x: m.pos.x + intent.delta.x, y: m.pos.y + intent.delta.y };
            return { ...m, pos: clampToBoard(clampToRange(m.moveStart, target, budget), state.layout) };
          }),
        };
      });
      return { ...state, units };
    }

    case 'CancelMove': {
      // Snap the units back to their move origins and clear the activation (no move recorded).
      const units = state.units.map((u) => {
        if (!intent.unitIds.includes(u.id)) return u;
        return {
          ...u,
          status: { ...u.status, moveMode: undefined, moveBudget: undefined },
          models: u.models.map((m) => (m.moveStart ? { ...m, pos: m.moveStart, moveStart: undefined } : m)),
        };
      });
      return { ...state, units, log: [...state.log, 'Move cancelled'] };
    }

    case 'EndMove': {
      let log = state.log;
      let anyRejected = false;
      const units = state.units.map((u) => {
        if (!intent.unitIds.includes(u.id)) return u;
        const shape = ctx?.datasheets.get(u.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
        const positions = u.models.filter((m) => m.alive).map((m) => m.pos);
        if (!checkCoherency(positions, shape).inCoherency) {
          anyRejected = true;
          const name = ctx?.datasheets.get(u.datasheetId)?.name ?? u.id;
          log = [...log, `Move not confirmed: ${name} is out of coherency`];
          return u; // stay in the move so the user can fix it
        }
        // A move may pass over other models but can never END with bases stacked.
        if (unitOverlaps(state, u, ctx)) {
          anyRejected = true;
          const name = ctx?.datasheets.get(u.datasheetId)?.name ?? u.id;
          log = [...log, `Move not confirmed: ${name} ends on top of another model's base`];
          return u;
        }
        // Dense terrain (13.06): tanks/riders/monsters can neither cross a dense (green)
        // feature nor end a move on one — only Infantry/Beasts/Swarms pass through; FLY is over.
        if (ctx) {
          const dense = unitDenseViolation(u, ctx, state.layout);
          if (dense) {
            anyRejected = true;
            const name = ctx.datasheets.get(u.datasheetId)?.name ?? u.id;
            log = [...log, `Move not confirmed: ${name} ${dense === 'ends_on' ? 'ends on' : 'moves through'} a dense terrain feature (only Infantry, Beasts and Swarms can — go around instead)`];
            return u;
          }
        }
        const mode = u.status.moveMode;
        // A Scout move must end more than 9" from all enemy models (10e Scouts).
        if (mode === 'scout') {
          const enemies = enemyModelsOnBoard(state, u.owner, ctx);
          const tooClose = u.models.some(
            (m) => m.alive && enemies.some((e) => gapBetweenBases(m.pos, shape, e.pos, e.shape) <= 9),
          );
          if (tooClose) {
            anyRejected = true;
            const name = ctx?.datasheets.get(u.datasheetId)?.name ?? u.id;
            log = [...log, `Scout move not confirmed: ${name} must end more than 9" from all enemy models`];
            return u;
          }
        }
        const flag =
          mode === 'scout' ? { scouted: true }
          : mode === 'advance' ? { advanced: true, moved: true }
          : mode === 'fall_back' ? { fellBack: true, moved: true }
          : mode === 'stationary' ? { remainedStationary: true }
          : { moved: true };
        let models = u.models.map((m) => (m.moveStart ? { ...m, moveStart: undefined } : m));
        // Desperate Escape (11e, 09.07): a battle-shocked unit MUST use this fall-back mode —
        // one hazard roll per model (1-2: 1 mortal wound; the unit is already battle-shocked).
        if (mode === 'fall_back' && u.status.battleShocked && state.mode === 'match') {
          const aliveIdx = models.map((m, k) => (m.alive ? k : -1)).filter((k) => k >= 0);
          let mortals = 0;
          for (let n = 0; n < aliveIdx.length; n++) if (rng.d6() <= 2) mortals++;
          for (let n = 0; n < mortals; n++) {
            const k = models.findIndex((m) => m.alive);
            if (k < 0) break;
            const wounds = models[k]!.wounds - 1;
            models = models.map((m, j) => (j === k ? { ...m, wounds, alive: wounds > 0 } : m));
          }
          if (mortals > 0) {
            const name = ctx?.datasheets.get(u.datasheetId)?.name ?? u.id;
            log = [...log, `${name} Desperate Escape: ${mortals} mortal wound(s) while fleeing`];
          }
        }
        return {
          ...u,
          status: { ...u.status, ...flag, moveMode: undefined, moveBudget: undefined },
          models,
        };
      });
      if (!anyRejected) log = [...log, `Move confirmed`];
      // A transport destroyed by Desperate Escape mortals spills its passengers (18.05).
      const settled: GameState = { ...state, units, log };
      return ctx ? resolveEmergencyDisembarks(settled, ctx, rng) : settled;
    }

    case 'ArriveFromReserves': {
      const unit = state.units.find((u) => u.id === intent.unitId);
      if (!unit || !unit.inReserves) return { ...state, log: [...state.log, 'Arrival rejected: not in Reserves'] };
      if (unit.embarkedIn) return { ...state, log: [...state.log, 'Arrival rejected: the unit is embarked (disembark instead)'] };
      // Rapid Ingress (15.07, 1 CP): an ingress move at the end of the OPPONENT's Movement phase.
      let rapidCp = 0;
      const rapidKey = `${unit.owner}:core:rapid_ingress`;
      if (intent.rapidIngress && state.mode === 'match' && state.stage === 'battle') {
        const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Rapid Ingress rejected: ${why}`] });
        if (state.battleType === 'combat_patrol') return reject('not available in Combat Patrol battles');
        if (state.phase !== 'Movement') return reject(`only in the Movement phase (now ${state.phase})`);
        if (unit.owner === state.activePlayer) return reject("used at the end of the OPPONENT's Movement phase");
        if (state.cp[unit.owner] < 1) return reject('needs 1 CP');
        if (state.stratUsed?.[rapidKey] === phaseKeyOf(state)) return reject('already used this phase');
        rapidCp = 1;
      } else if (state.mode === 'match' && state.stage === 'battle' && unit.owner !== state.activePlayer) {
        return { ...state, log: [...state.log, 'Arrival rejected: reserves arrive in their own Movement phase (or via Rapid Ingress)'] };
      }
      const shape = ctx?.datasheets.get(unit.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
      const wounds = unit.models[0]?.wounds ?? 1;
      const opts: LayoutOpts = {
        unitId: unit.id, baseShape: shape, modelCount: unit.models.length, wounds,
        anchor: intent.anchor, formation: intent.formation, rotation: intent.rotation,
      };
      const enemies = enemyModelsOnBoard(state, unit.owner, ctx);
      // 11e ingress (20.04): strategic reserves arrive within 6" of an edge; Deep Strike (24.09)
      // arrives anywhere. Both must be more than 8" from all enemy units. The caller passes the
      // resolved deployment ability (the catalog lives in the data layer); keywords are the
      // fallback for direct reducer calls.
      const ds = ctx?.datasheets.get(unit.datasheetId);
      // Deep Strike can come from the datasheet, the bearer's enhancement (Beacon Angelis), or an
      // army-wide Declare Battle Formations grant (Combat Landers — stamped on the unit at
      // placement, because BeginBattle clears setup.grants).
      const granted = enhancementDeployGrant(unit) === 'deep_strike' || unit.deployGrant === 'deep_strike';
      const ability =
        intent.ability ??
        (granted
          ? 'deep_strike'
          : ds
            ? deployAbilityFromKeywords(ds.keywords, (ds.abilities ?? []).map((a) => a.name))
            : 'standard');
      // Combat Patrol mandatory reserves (e.g. Strike from the Warp): the unit cannot arrive
      // before its stated battle round and must be set up wholly within its own deployment zone.
      const cpRound = state.battleType === 'combat_patrol' ? ds?.cpReserveRound : undefined;
      if (cpRound) {
        if (state.round < cpRound) {
          return { ...state, log: [...state.log, `Reserves arrival rejected: cannot arrive before battle round ${cpRound}`] };
        }
        const zoneCheck = checkUnitDeployment(
          formationWorld(opts), shape, state.layout, unit.owner, 'standard', [],
          occupiedBases(state, ctx, [unit.id]),
          blockedByDense(ds),
        );
        if (!zoneCheck.legal) {
          return { ...state, log: [...state.log, `Reserves arrival rejected: must arrive wholly within your deployment zone (${zoneCheck.reason})`] };
        }
      }
      // Earth Caste Modifications (Cloudspear enhancement): the ingress may arrive more than 6"
      // from enemies (instead of 8"), but the unit then cannot charge this turn.
      const earthCaste = cpEnhancementSlug(unit) === 'earth_caste_modifications';
      let earthCasteClose = false;
      if (!cpRound) {
        // Priority-drop Beacon: the bearer's unit may Deep Strike from the FIRST battle round.
        const effectiveRound = allowsRound1DeepStrike(unit) ? Math.max(state.round, 2) : state.round;
        const baseOpts = {
          deepStrike: ability === 'deep_strike', layout: state.layout, side: unit.owner,
          denseBlocked: blockedByDense(ds),
        };
        let check = deepStrikeArrivalLegal(
          formationWorld(opts), shape, enemies, effectiveRound,
          occupiedBases(state, ctx, [unit.id]), baseOpts,
        );
        if (!check.legal && earthCaste) {
          check = deepStrikeArrivalLegal(
            formationWorld(opts), shape, enemies, effectiveRound,
            occupiedBases(state, ctx, [unit.id]), { ...baseOpts, minEnemyDist: 6 },
          );
          if (check.legal) earthCasteClose = true;
        }
        if (!check.legal) return { ...state, log: [...state.log, `Reserves arrival rejected: ${check.reason}`] };
      }
      const newModels = layoutModels(opts, state.layout).map((m, i) => ({
        ...m,
        wounds: unit.models[i]?.wounds ?? m.wounds,
        alive: unit.models[i]?.alive ?? true,
        ...(unit.models[i]?.wargear ? { wargear: unit.models[i]!.wargear } : {}),
      }));
      return {
        ...state,
        units: state.units.map((u) =>
          u.id === unit.id
            ? {
                ...u, models: newModels, inReserves: false, arrivedRound: state.round,
                status: { ...u.status, moved: true, setUpThisTurn: true, ...(earthCasteClose ? { cannotCharge: true } : {}) },
              }
            : u,
        ),
        ...(rapidCp > 0
          ? {
              cp: { ...state.cp, [unit.owner]: state.cp[unit.owner] - rapidCp },
              stratUsed: { ...(state.stratUsed ?? {}), [rapidKey]: phaseKeyOf(state) },
            }
          : {}),
        log: [
          ...state.log,
          `A unit arrives from Reserves via ${rapidCp > 0 ? 'Rapid Ingress (1 CP)' : 'Deep Strike'} (round ${state.round})`,
        ],
      };
    }

    case 'EmbarkUnit': {
      const unit = state.units.find((u) => u.id === intent.unitId);
      const transport = state.units.find((u) => u.id === intent.transportId);
      if (!unit || !transport || !ctx) return { ...state, log: [...state.log, 'Embark rejected: unit not found'] };
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Embark rejected: ${why}`] });
      if (unit.inReserves) return reject('unit is not on the battlefield');
      if (transport.inReserves || !transport.models.some((m) => m.alive)) return reject('transport is not on the battlefield');
      if (state.mode === 'match' && state.stage === 'battle') {
        if (state.phase !== 'Movement') return reject(`only in the Movement phase (now ${state.phase})`);
        if (state.activePlayer !== unit.owner) return reject('not your turn');
        // 18.02: after a normal/advance/fall-back move (not Remain Stationary), and the unit must
        // not have been set up on the battlefield this turn.
        if (!(unit.status.moved || unit.status.advanced || unit.status.fellBack) || unit.status.remainedStationary) {
          return reject('a unit embarks after making a normal, advance or fall-back move');
        }
        if (unit.status.setUpThisTurn) return reject('the unit was set up on the battlefield this turn');
      }
      const legal = canEmbark(state, unit, transport, ctx);
      if (!legal.ok) return reject(legal.reason!);
      // Every model within 3" of the transport (18.02).
      const shape = ctx.datasheets.get(unit.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
      const tShape = ctx.datasheets.get(transport.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
      const tAlive = transport.models.filter((m) => m.alive);
      const near = unit.models.every(
        (m) => !m.alive || tAlive.some((tm) => gapBetweenBases(m.pos, shape, tm.pos, tShape) <= 3),
      );
      if (!near) return reject('every model must be within 3" of the transport');
      const tName = ctx.datasheets.get(transport.datasheetId)?.name ?? transport.id;
      const uName = ctx.datasheets.get(unit.datasheetId)?.name ?? unit.id;
      return {
        ...state,
        units: state.units.map((u) =>
          u.id === unit.id
            ? {
                ...u,
                inReserves: true,
                embarkedIn: transport.id,
                status: { ...u.status, justEmbarked: true, moveMode: undefined, moveBudget: undefined },
                models: u.models.map((m) => (m.moveStart ? { ...m, moveStart: undefined } : m)),
              }
            : u,
        ),
        log: [...state.log, `${uName} embarks within ${tName}`],
      };
    }

    case 'DisembarkUnit': {
      const unit = state.units.find((u) => u.id === intent.unitId);
      if (!unit || !unit.embarkedIn) return { ...state, log: [...state.log, 'Disembark rejected: not embarked'] };
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Disembark rejected: ${why}`] });
      const transport = state.units.find((u) => u.id === unit.embarkedIn);
      if (!transport || transport.inReserves || !transport.models.some((m) => m.alive)) {
        return reject('the transport is not on the battlefield');
      }
      if (state.mode === 'match' && state.stage === 'battle') {
        if (state.phase !== 'Movement') return reject(`only in the Movement phase (now ${state.phase})`);
        if (state.activePlayer !== unit.owner) return reject('not your turn');
      }
      const modeAvail = disembarkMode(unit, transport);
      if (!modeAvail) return reject('the transport advanced or fell back this phase (or the unit embarked this turn)');

      const shape = ctx?.datasheets.get(unit.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
      const tShape = ctx?.datasheets.get(transport.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
      const wounds = unit.models[0]?.wounds ?? 1;
      const opts: LayoutOpts = {
        unitId: unit.id, baseShape: shape, modelCount: unit.models.length, wounds,
        anchor: intent.anchor, formation: intent.formation, rotation: intent.rotation,
      };
      const placed = layoutModels(opts, state.layout);
      const positions = placed.map((m) => m.pos);
      const tAlive = transport.models.filter((m) => m.alive);
      const distToTransport = (p: Vec2): number =>
        Math.min(...tAlive.map((tm) => gapBetweenBases(p, shape, tm.pos, tShape)));
      // Enemy units, with whether each is engaged with the TRANSPORT (combat disembark may set up
      // engaged with those — 18.04).
      const ER = 2; // Engagement Range (11e, 03.04)
      const enemyUnits = state.units.filter(
        (u) => u.owner !== unit.owner && !u.inReserves && u.models.some((m) => m.alive),
      );
      const enemyInfo = enemyUnits.map((e) => {
        const eShape = ctx?.datasheets.get(e.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
        const pts = e.models.filter((m) => m.alive).map((m) => m.pos);
        const engagedWithTransport = tAlive.some((tm) =>
          pts.some((p) => gapBetweenBases(tm.pos, tShape, p, eShape) <= ER),
        );
        return { pts, eShape, engagedWithTransport };
      });
      const erViolations = (allowTransportEngaged: boolean): boolean =>
        positions.some((p) =>
          enemyInfo.some(
            (e) =>
              !(allowTransportEngaged && e.engagedWithTransport) &&
              e.pts.some((ep) => gapBetweenBases(p, shape, ep, e.eShape) <= ER),
          ),
        );
      if (anyOverlap(positions.map((p) => ({ pos: p, shape })), occupiedBases(state, ctx, [unit.id]))) {
        return reject('models would be set up on top of another model\'s base');
      }
      const whollyWithin = (d: number): boolean => positions.every((p) => distToTransport(p) <= d);
      // Rapid Disembark (Devilfish): rapid/tactical disembark set-up distance becomes 6".
      const nearDist = hasAbility(ctx?.datasheets.get(transport.datasheetId), 'Rapid Disembark') ? 6 : 3;

      let mode: 'rapid' | 'tactical' | 'combat';
      if (modeAvail === 'rapid') {
        if (!whollyWithin(nearDist)) return reject(`rapid disembark: set up wholly within ${nearDist}" of the transport`);
        if (erViolations(false)) return reject('cannot be set up within Engagement Range of an enemy');
        mode = 'rapid';
      } else if (whollyWithin(nearDist) && !erViolations(false)) {
        mode = 'tactical';
      } else if (whollyWithin(6) && !erViolations(true)) {
        mode = 'combat';
      } else {
        return reject(`set up wholly within ${nearDist}" (tactical) or 6" (combat) of the transport, clear of enemies`);
      }

      let log = [...state.log];
      let models = placed.map((m, i) => ({
        ...m,
        wounds: unit.models[i]?.wounds ?? m.wounds,
        alive: unit.models[i]?.alive ?? true,
        ...(unit.models[i]?.wargear ? { wargear: unit.models[i]!.wargear } : {}),
      }));
      // Combat disembark: one hazard roll per model (06.03) — 1-2 fails, 1 mortal wound each.
      let shocked = false;
      if (mode === 'combat') {
        const aliveCount = models.filter((m) => m.alive).length;
        let mortals = 0;
        for (let n = 0; n < aliveCount; n++) if (hazardRoll(rng, false).mortals > 0) mortals++;
        for (let n = 0; n < mortals; n++) {
          const k = models.findIndex((m) => m.alive);
          if (k < 0) break;
          const w = models[k]!.wounds - 1;
          models = models.map((m, j) => (j === k ? { ...m, wounds: w, alive: w > 0 } : m));
        }
        if (mortals > 0) log = [...log, `Combat disembark hazard: ${mortals} mortal wound(s)`];
        shocked = true;
      }
      const uName = ctx?.datasheets.get(unit.datasheetId)?.name ?? unit.id;
      // Assault Hatches: a unit disembarking from the bearer after its NORMAL move (rapid mode,
      // not an Advance) is still eligible to charge.
      const chargeOk =
        mode === 'rapid' && !transport.status.advanced && transportAllowsChargeAfterMove(transport);
      const flags =
        mode === 'tactical'
          ? { setUpThisTurn: true } // 18.04: the unit is then selected for a normal or advance move
          : {
              setUpThisTurn: true, moved: true,
              ...(chargeOk ? {} : { cannotCharge: true }),
              ...(shocked ? { battleShocked: true } : {}),
            };
      // Proximity Scanners (Devilfish enhancement): the disembarking unit's pulse blasters and
      // pulse carbines get +1 A (this turn — the effect expires at the unit's next turn reset).
      let proximity = false;
      if (cpEnhancementSlug(transport) === 'proximity_scanners') {
        proximity = true;
        log = [...log, `Proximity Scanners: ${uName}'s pulse weapons get +1 A`];
      }
      log = [...log, `${uName} disembarks (${mode})${mode === 'tactical' ? ' and may move' : ''}`];
      return {
        ...state,
        units: state.units.map((u) =>
          u.id === unit.id
            ? {
                ...u, models, inReserves: false, embarkedIn: undefined,
                status: proximity ? addEffect({ ...u.status, ...flags }, 'cp:pulse_bonus') : { ...u.status, ...flags },
              }
            : u,
        ),
        log,
      };
    }

    // ── Combat Patrol per-unit specials (step 4) ───────────────────────────────
    case 'SpotTarget': {
      // For the Greater Good (T'au): in your Shooting phase, an eligible FTGG unit that has not
      // shot becomes an Observer and marks one visible enemy as its Spotted unit. The Observer
      // forgoes shooting — unless it has Target Uploaded (Pathfinders).
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Spot rejected: ${why}`] });
      if (!ctx) return reject('no datasheet context');
      const unit = state.units.find((u) => u.id === intent.unitId);
      const target = state.units.find((u) => u.id === intent.targetUnitId);
      if (!unit || !target) return reject('unit not found');
      if (state.mode === 'match' && state.stage === 'battle') {
        if (state.phase !== 'Shooting') return reject(`only in the Shooting phase (now ${state.phase})`);
        if (state.activePlayer !== unit.owner) return reject('not your turn');
      }
      if (target.owner === unit.owner) return reject('the Spotted unit must be an enemy');
      if (unit.inReserves || !unit.models.some((m) => m.alive)) return reject('the Observer is not on the battlefield');
      if (target.inReserves || !target.models.some((m) => m.alive)) return reject('the target is not on the battlefield');
      const ds = ctx.datasheets.get(unit.datasheetId);
      if (!hasAbility(ds, 'For the Greater Good')) return reject('the unit does not have For the Greater Good');
      if (unit.status.battleShocked) return reject('a Battle-shocked unit cannot be an Observer');
      if (unit.status.hasShot) return reject('the unit has already been selected to shoot this phase');
      if (state.spotted?.[target.id]) return reject('that enemy unit is already Spotted this phase');
      if (Object.values(state.spotted ?? {}).some((s) => s.by === unit.id)) {
        return reject('this Observer has already marked a Spotted unit this phase');
      }
      const seers = unit.models.filter((m) => m.alive).map((m) => m.pos);
      if (!unitCanSeeIn(seers, target, state, ctx)) return reject('the target is not visible to the Observer');
      const pathfinder = hasAbilityStarting(ds, 'target uploaded');
      const markerlight = (ds?.keywords ?? []).some((k) => k.toUpperCase() === 'MARKERLIGHT');
      const tName = ctx.datasheets.get(target.datasheetId)?.name ?? target.id;
      return {
        ...state,
        spotted: { ...(state.spotted ?? {}), [target.id]: { by: unit.id, markerlight, ...(pathfinder ? { pathfinder: true } : {}) } },
        // A non-Pathfinder Observer forgoes its shooting this phase.
        units: pathfinder
          ? state.units
          : state.units.map((u) => (u.id === unit.id ? { ...u, status: { ...u.status, hasShot: true } } : u)),
        log: [
          ...state.log,
          `${ds?.name ?? unit.id} spots ${tName} (For the Greater Good${markerlight ? ', Markerlight' : ''}${pathfinder ? '; Target Uploaded — may still shoot it' : ' — forgoes its shooting'})`,
        ],
      };
    }

    case 'UseUnitAbility': {
      const reject = (why: string): GameState => ({
        ...state,
        log: [...state.log, `Ability "${intent.ability}" rejected: ${why}`],
      });
      if (!ctx) return reject('no datasheet context');
      const unit = state.units.find((u) => u.id === intent.unitId);
      if (!unit) return reject('unit not found');
      if (state.mode === 'match' && state.stage !== 'battle') return reject('only during the battle');
      if (unit.inReserves && intent.ability !== 'gate_of_infinity') return reject('the unit is not on the battlefield');
      if (!unit.models.some((m) => m.alive)) return reject('the unit has no models left');
      const turnNow = state.turnCounter ?? 0;
      const used = unit.status.abilityUsed ?? {};
      const markUsed = (slug: string, u: UnitInstance): UnitInstance => ({
        ...u,
        status: { ...u.status, abilityUsed: { ...(u.status.abilityUsed ?? {}), [slug]: turnNow } },
      });
      const name = ctx.datasheets.get(unit.datasheetId)?.name ?? unit.id;

      switch (intent.ability) {
        case 'zealot': {
          if (state.phase !== 'Fight') return reject('used when the unit is selected to fight (Fight phase)');
          if (!unitHasAbilityStarting(unit, ctx, 'zealot')) return reject('the unit does not have Zealot');
          if (used['zealot'] != null) return reject('once per battle');
          return {
            ...state,
            units: state.units.map((u) => (u.id === unit.id ? markUsed('zealot', { ...u, status: addEffect(u.status, 'cp:zealot') }) : u)),
            log: [...state.log, `${name} uses ZEALOT: +3 A and S to the Preacher's melee attacks this fight`],
          };
        }
        case 'overkill': {
          if (state.phase !== 'Fight') return reject('used when the unit is selected to attack (Fight phase)');
          if (!unitHasAbilityStarting(unit, ctx, 'overkill')) return reject('the unit does not have Overkill');
          if (used['overkill'] != null) return reject('once per battle');
          return {
            ...state,
            units: state.units.map((u) => (u.id === unit.id ? markUsed('overkill', { ...u, status: addEffect(u.status, 'cp:overkill') }) : u)),
            log: [...state.log, `${name} uses OVERKILL: melee attacks at AP -4 this fight`],
          };
        }
        case 'bladeguard_hit':
        case 'bladeguard_stance': {
          if (state.phase !== 'Fight') return reject('used in the Fight phase');
          if (!unitHasAbilityStarting(unit, ctx, 'bladeguard')) return reject('the unit does not have the Bladeguard ability');
          if (used['bladeguard'] === turnNow) return reject('once per turn');
          const effectId = intent.ability === 'bladeguard_hit' ? 'cp:bladeguard_hit' : 'cp:bladeguard_stance';
          const what = intent.ability === 'bladeguard_hit' ? '+1 to hit in melee' : '-1 to be hit';
          return {
            ...state,
            units: state.units.map((u) => (u.id === unit.id ? markUsed('bladeguard', { ...u, status: addEffect(u.status, effectId) }) : u)),
            log: [...state.log, `${name} uses BLADEGUARD: ${what} until the end of the turn`],
          };
        }
        case 'tome_skull': {
          if (!unitHasAbilityStarting(unit, ctx, 'tome skull')) return reject('the unit does not have Tome Skull');
          if (used['tome_skull'] != null) return reject('once per battle');
          const target = state.units.find((u) => u.id === intent.targetUnitId);
          if (!target || target.inReserves || !target.models.some((m) => m.alive)) return reject('target not on the battlefield');
          const tDs = ctx.datasheets.get(target.datasheetId);
          const tShape = tDs?.baseShape ?? FALLBACK_SHAPE;
          const uShape = ctx.datasheets.get(unit.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
          const within6 = unit.models.some(
            (m) => m.alive && target.models.some((t) => t.alive && gapBetweenBases(m.pos, uShape, t.pos, tShape) <= 6),
          );
          if (!within6) return reject('the target must be within 6"');
          let next: GameState = {
            ...state,
            units: state.units.map((u) => (u.id === unit.id ? markUsed('tome_skull', u) : u)),
          };
          if (target.owner === unit.owner) {
            if (!target.status.battleShocked) return reject('a friendly target must be battle-shocked');
            return {
              ...next,
              units: next.units.map((u) => (u.id === target.id ? { ...u, status: { ...u.status, battleShocked: false } } : u)),
              log: [...next.log, `${name} uses TOME SKULL: ${tDs?.name ?? target.id} is no longer battle-shocked`],
            };
          }
          next = { ...next, log: [...next.log, `${name} uses TOME SKULL on ${tDs?.name ?? target.id}`] };
          return forcedBattleShockRoll(next, target.id, 'Tome Skull', ctx, rng);
        }
        case 'nuncio_aquila': {
          if (state.phase !== 'Command') return reject('used at the start of the Command phase');
          if (!unitHasAbilityStarting(unit, ctx, 'nuncio-aquila')) return reject('the unit does not have Nuncio-Aquila');
          const objIdx = intent.objectiveIdx;
          const objPts = state.layout.objectivePoints;
          if (objIdx == null || !objPts?.[objIdx]) return reject('pick an objective');
          if (used[`nuncio:${objIdx}`] === turnNow) return reject('that objective was already selected this turn');
          const obj = objPts[objIdx]!;
          const uShape = ctx.datasheets.get(unit.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
          // "Within 6" of this model" is measured to the objective marker itself.
          const near = unit.models.some(
            (m) => m.alive && Math.hypot(m.pos.x - obj.pos.x, m.pos.y - obj.pos.y) - baseRadius(uShape) <= 6,
          );
          if (!near) return reject('the objective must be within 6" of this model');
          let next: GameState = {
            ...state,
            units: state.units.map((u) => (u.id === unit.id ? markUsed(`nuncio:${objIdx}`, u) : u)),
            log: [...state.log, `${name} uses NUNCIO-AQUILA on objective ${objIdx + 1}`],
          };
          for (const e of state.units) {
            if (e.owner === unit.owner || e.inReserves || !e.models.some((m) => m.alive)) continue;
            const eDs = ctx.datasheets.get(e.datasheetId);
            if (eDs?.keywords.some((k) => /^(monster|vehicle)$/i.test(k))) continue;
            const eShape = eDs?.baseShape ?? FALLBACK_SHAPE;
            const inRange = e.models.some((m) => m.alive && withinObjectiveRange(m.pos, baseRadius(eShape), obj, state.layout));
            if (inRange) next = forcedBattleShockRoll(next, e.id, 'Nuncio-Aquila', ctx, rng);
          }
          return next;
        }
        case 'coordinated_eradication': {
          if (state.mode === 'match' && state.stage === 'battle') {
            if (state.phase !== 'Shooting') return reject('used when a unit is selected to shoot (Shooting phase)');
            if (state.activePlayer !== unit.owner) return reject('not your turn');
          }
          const ds = ctx.datasheets.get(unit.datasheetId);
          if (ds?.patrol !== 'sudden_dawn_cadre') return reject('a Sudden Dawn Cadre unit must use it');
          const onceKey = `${unit.owner}:coordinated_eradication`;
          if (state.cpArmyOnce?.[onceKey]) return reject('once per battle per army');
          const target = state.units.find((u) => u.id === intent.targetUnitId);
          if (!target || target.owner === unit.owner || !target.models.some((m) => m.alive)) return reject('pick an enemy unit');
          const tName = ctx.datasheets.get(target.datasheetId)?.name ?? target.id;
          return {
            ...state,
            cpArmyOnce: { ...(state.cpArmyOnce ?? {}), [onceKey]: true },
            units: state.units.map((u) =>
              u.id === target.id
                ? { ...u, status: { ...u.status, permanentEffects: [...(u.status.permanentEffects ?? []), 'cp:eradication_mark'] } }
                : u,
            ),
            log: [...state.log, `${unit.owner} uses CO-ORDINATED ERADICATION: Sudden Dawn Cadre attacks against ${tName} have +1 AP for the rest of the battle`],
          };
        }
        case 'sanctic_slayers': {
          // Enhancement (Teguen, once per turn): a friendly IH unit's attacks get +1 to wound
          // when the target's T is greater than or equal to the attack's S.
          if (cpEnhancementSlug(unit) !== 'sanctic_slayers') return reject('the unit does not carry Sanctic Slayers');
          if (used['sanctic_slayers'] === turnNow) return reject('once per turn');
          const target = state.units.find((u) => u.id === intent.targetUnitId);
          if (!target || target.owner !== unit.owner || target.inReserves || !target.models.some((m) => m.alive)) {
            return reject('pick a friendly unit on the battlefield');
          }
          if (ctx.datasheets.get(target.datasheetId)?.patrol !== 'inquisitors_hand') {
            return reject("an INQUISITOR'S HAND unit must be the target");
          }
          return {
            ...state,
            units: state.units.map((u) => {
              if (u.id === unit.id) u = markUsed('sanctic_slayers', u);
              if (u.id === target.id) u = { ...u, status: addEffect(u.status, 'cp:wound_boost_weak') };
              return u;
            }),
            log: [...state.log, `${name} uses SANCTIC SLAYERS: ${ctx.datasheets.get(target.datasheetId)?.name ?? target.id} gets +1 to wound vs tougher targets`],
          };
        }
        case 'purifying_force': {
          // Enhancement (Brotherhood Terminators, once per battle per army): after a charge,
          // the unit's melee attacks have [LETHAL HITS] this fight.
          if (state.phase !== 'Fight') return reject('used when the unit is selected to fight (Fight phase)');
          if (cpEnhancementSlug(unit) !== 'purifying_force') return reject('the unit does not carry Purifying Force');
          if (!unit.status.charged) return reject('the unit must have made a charge move this turn');
          const onceKey = `${unit.owner}:purifying_force`;
          if (state.cpArmyOnce?.[onceKey]) return reject('once per battle per army');
          return {
            ...state,
            cpArmyOnce: { ...(state.cpArmyOnce ?? {}), [onceKey]: true },
            units: state.units.map((u) => (u.id === unit.id ? { ...u, status: addEffect(u.status, 'cp:lethal_melee') } : u)),
            log: [...state.log, `${name} uses PURIFYING FORCE: melee attacks have [LETHAL HITS] this fight`],
          };
        }
        case 'gate_of_infinity': {
          // At the end of your OPPONENT's Fight phase — remove an unengaged unit to Reserves.
          if (state.mode === 'match' && state.stage === 'battle') {
            if (state.phase !== 'Fight') return reject("used at the end of your opponent's Fight phase");
            if (state.activePlayer === unit.owner) return reject("used in your OPPONENT's Fight phase");
          }
          const ds = ctx.datasheets.get(unit.datasheetId);
          if (ds?.patrol !== 'crowes_sanctifiers') return reject('every model must have Gate of Infinity');
          if (unit.inReserves) return reject('the unit is already in Reserves');
          if (engagedEnemies(unit, state, ctx).length > 0) return reject('an engaged unit cannot use Gate of Infinity');
          // Battle-size table not captured — Combat Patrol allows ONE unit per use, once per phase.
          const gateKey = `${unit.owner}:cp:gate_of_infinity`;
          const phaseKey = `${state.round}:${state.activePlayer}:${state.phase}`;
          if (state.stratUsed?.[gateKey] === phaseKey) return reject('already used this phase');
          return {
            ...state,
            stratUsed: { ...(state.stratUsed ?? {}), [gateKey]: phaseKey },
            units: state.units.map((u) => (u.id === unit.id ? { ...u, inReserves: true } : u)),
            log: [...state.log, `${name} steps through the GATE OF INFINITY into Strategic Reserves`],
          };
        }
        default:
          return reject('unknown ability');
      }
    }

    // ── Core Stratagem plays (15.03–15.12) ─────────────────────────────────────
    case 'FireOverwatch': {
      if (!ctx) return { ...state, log: [...state.log, 'Fire Overwatch ignored: no datasheet context'] };
      const unit = state.units.find((u) => u.id === intent.unitId);
      if (!unit) return { ...state, log: [...state.log, 'Fire Overwatch rejected: unit not found'] };
      // Shroud Projector / Flash Grenades: enemy units cannot Fire Overwatch at the bearer's unit.
      const owTarget = state.units.find((u) => u.id === intent.targetUnitId);
      if (owTarget && blocksOverwatch(owTarget)) {
        return { ...state, log: [...state.log, 'Fire Overwatch rejected: that unit cannot be targeted by Fire Overwatch (enhancement)'] };
      }
      const gate = stratGate(state, unit.owner, 'core:fire_overwatch', 1);
      if (gate) return { ...state, log: [...state.log, `Fire Overwatch rejected: ${gate}`] };
      const outcome = resolveUnitShooting(
        state, { attackerUnitId: intent.unitId, targetUnitId: intent.targetUnitId, overwatch: true }, ctx, rng,
      );
      if (outcome.rejected) return { ...state, log: [...state.log, `Fire Overwatch rejected: ${outcome.rejected}`] };
      let next = recordKills(state, resolveEmergencyDisembarks(outcome.state, ctx, rng), ctx);
      return {
        ...next,
        cp: { ...next.cp, [unit.owner]: next.cp[unit.owner] - 1 },
        stratUsed: { ...(next.stratUsed ?? {}), [`${unit.owner}:core:fire_overwatch`]: phaseKeyOf(state) },
        log: [...next.log, `${unit.owner} spent 1 CP on Fire Overwatch (snap shooting)`],
      };
    }

    case 'CrushingImpact': {
      if (!ctx) return { ...state, log: [...state.log, 'Crushing Impact ignored: no datasheet context'] };
      if (state.battleType === 'combat_patrol') {
        return { ...state, log: [...state.log, 'Crushing Impact rejected: not available in Combat Patrol battles'] };
      }
      const unit = state.units.find((u) => u.id === intent.unitId);
      const target = state.units.find((u) => u.id === intent.targetUnitId);
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Crushing Impact rejected: ${why}`] });
      if (!unit || !target) return reject('unit not found');
      const ds = ctx.datasheets.get(unit.datasheetId);
      const tDs = ctx.datasheets.get(target.datasheetId);
      if (!ds || !tDs) return reject('datasheet not found');
      if (!ds.keywords.some((k) => /^(monster|vehicle)$/i.test(k))) return reject('MONSTER/VEHICLE units only');
      if (state.mode === 'match' && state.stage === 'battle') {
        if (state.phase !== 'Charge') return reject(`only in the Charge phase (now ${state.phase})`);
        if (unit.owner !== state.activePlayer) return reject('used in your own Charge phase');
        if (!unit.status.charged) return reject('the unit must have just ended a charge move');
      }
      if (closestGap(unit, ds.baseShape, target, tDs.baseShape) > 2) return reject('target not engaged');
      const gate = stratGate(state, unit.owner, 'core:crushing_impact', 1);
      if (gate) return reject(gate);
      const T = ds.models[0]?.T ?? 6;
      let selfMortals = 0;
      let targetMortals = 0;
      const rollsOut: number[] = [];
      for (let i = 0; i < T; i++) {
        const r = rng.d6();
        rollsOut.push(r);
        if (r === 1) selfMortals++;
        else if (r >= 5) targetMortals++;
      }
      targetMortals = Math.min(6, targetMortals);
      const units = state.units.map((u) => {
        if (u.id === unit.id && selfMortals > 0) return applyMortalWounds(u, selfMortals);
        if (u.id === target.id && targetMortals > 0) return applyMortalWounds(u, targetMortals);
        return u;
      });
      const next: GameState = {
        ...state,
        units,
        cp: { ...state.cp, [unit.owner]: state.cp[unit.owner] - 1 },
        stratUsed: { ...(state.stratUsed ?? {}), [`${unit.owner}:core:crushing_impact`]: phaseKeyOf(state) },
        log: [
          ...state.log,
          `${unit.owner} spends 1 CP on Crushing Impact: ${ds.name} rolls ${T}D6 [${rollsOut.join(' ')}] → ` +
            `${targetMortals} mortal wound(s) to ${tDs.name}${selfMortals ? `, ${selfMortals} to itself` : ''}`,
        ],
      };
      return recordKills(state, resolveEmergencyDisembarks(next, ctx, rng), ctx);
    }

    case 'ThrowExplosives': {
      if (!ctx) return { ...state, log: [...state.log, 'Explosives ignored: no datasheet context'] };
      if (state.battleType === 'combat_patrol') {
        return { ...state, log: [...state.log, 'Explosives rejected: not available in Combat Patrol battles'] };
      }
      const unit = state.units.find((u) => u.id === intent.unitId);
      const target = state.units.find((u) => u.id === intent.targetUnitId);
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Explosives rejected: ${why}`] });
      if (!unit || !target) return reject('unit not found');
      const ds = ctx.datasheets.get(unit.datasheetId);
      const tDs = ctx.datasheets.get(target.datasheetId);
      if (!ds || !tDs) return reject('datasheet not found');
      if (!ds.keywords.some((k) => /^(explosives|grenades)$/i.test(k))) return reject('EXPLOSIVES/GRENADES units only');
      if (state.mode === 'match' && state.stage === 'battle') {
        if (state.phase !== 'Shooting') return reject(`only in your Shooting phase (now ${state.phase})`);
        if (unit.owner !== state.activePlayer) return reject('used in your own Shooting phase');
        const elig = eligibleToShoot(unit, state, ctx);
        if (!elig.eligible) return reject(elig.reason ?? 'not eligible to shoot');
        if (unit.status.advanced) return reject('the unit made an advance move this turn');
      }
      const engagedWith = (u: UnitInstance): boolean =>
        state.units.some(
          (e) =>
            e.owner !== u.owner && !e.inReserves && e.models.some((m) => m.alive) &&
            closestGap(u, ctx.datasheets.get(u.datasheetId)?.baseShape ?? ds.baseShape, e, ctx.datasheets.get(e.datasheetId)?.baseShape ?? ds.baseShape) <= 2,
        );
      if (engagedWith(unit)) return reject('the throwing unit must be unengaged');
      if (engagedWith(target)) return reject('the target must be unengaged');
      // Within 8" of and visible to one model in the unit.
      const tPts = target.models.filter((m) => m.alive).map((m) => m.pos);
      const thrower = unit.models.find(
        (m) =>
          m.alive &&
          tPts.some(
            (t) =>
              gapBetweenBases(m.pos, ds.baseShape, t, tDs.baseShape) <= 8 && !pointLosBlocked(m.pos, t, state.layout),
          ),
      );
      if (!thrower) return reject('no model is within 8" of a visible target model');
      const gate = stratGate(state, unit.owner, 'core:explosives', 1);
      if (gate) return reject(gate);
      const rollsOut: number[] = [];
      let mortals = 0;
      for (let i = 0; i < 6; i++) {
        const r = rng.d6();
        rollsOut.push(r);
        if (r >= 4) mortals++;
      }
      const units = state.units.map((u) => (u.id === target.id && mortals > 0 ? applyMortalWounds(u, mortals) : u));
      const next: GameState = {
        ...state,
        units,
        cp: { ...state.cp, [unit.owner]: state.cp[unit.owner] - 1 },
        stratUsed: { ...(state.stratUsed ?? {}), [`${unit.owner}:core:explosives`]: phaseKeyOf(state) },
        log: [
          ...state.log,
          `${unit.owner} spends 1 CP on Explosives: ${ds.name} → ${tDs.name}, 6D6 [${rollsOut.join(' ')}] → ${mortals} mortal wound(s)`,
        ],
      };
      return recordKills(state, resolveEmergencyDisembarks(next, ctx, rng), ctx);
    }

    case 'Counteroffensive': {
      const unit = state.units.find((u) => u.id === intent.unitId);
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Counteroffensive rejected: ${why}`] });
      if (!unit) return reject('unit not found');
      if (state.mode === 'match' && state.stage === 'battle') {
        if (state.phase !== 'Fight') return reject(`only in the Fight phase (now ${state.phase})`);
        if (unit.owner === state.activePlayer) return reject("used in the OPPONENT's Fight phase");
      }
      if (unit.status.hasFought) return reject('the unit has already fought');
      const gate = stratGate(state, unit.owner, 'core:counter_offensive', 2);
      if (gate) return reject(gate);
      return {
        ...state,
        fightNext: unit.id,
        cp: { ...state.cp, [unit.owner]: state.cp[unit.owner] - 2 },
        stratUsed: { ...(state.stratUsed ?? {}), [`${unit.owner}:core:counter_offensive`]: phaseKeyOf(state) },
        units: state.units.map((u) => (u.id === unit.id ? { ...u, status: addEffect(u.status, 'fights_first_granted') } : u)),
        log: [...state.log, `${unit.owner} spends 2 CP on Counteroffensive: that unit fights next`],
      };
    }

    case 'InsaneBravery': {
      const unit = state.units.find((u) => u.id === intent.unitId);
      const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Insane Bravery rejected: ${why}`] });
      if (!unit) return reject('unit not found');
      if (state.mode === 'match' && state.stage === 'battle') {
        if (state.phase !== 'Command') return reject(`only in your Command phase (now ${state.phase})`);
        if (unit.owner !== state.activePlayer) return reject('used in your own Command phase');
        if (state.commandRun) return reject('apply it BEFORE running the Command phase');
      }
      if (state.insaneBraveryUsed?.[unit.owner]) return reject('once per battle');
      if (state.cp[unit.owner] < 1) return reject('needs 1 CP');
      return {
        ...state,
        cp: { ...state.cp, [unit.owner]: state.cp[unit.owner] - 1 },
        insaneBraveryUsed: { ...(state.insaneBraveryUsed ?? {}), [unit.owner]: true },
        units: state.units.map((u) => (u.id === unit.id ? { ...u, status: addEffect(u.status, 'insane_bravery') } : u)),
        log: [...state.log, `${unit.owner} spends 1 CP on Insane Bravery (auto-pass the battle-shock roll)`],
      };
    }
  }
}

/** The current phase key for once-per-phase stratagem tracking. */
function phaseKeyOf(state: GameState): string {
  return `${state.round}:${state.activePlayer}:${state.phase}`;
}

/** Common stratagem gate: CP affordability + "each stratagem once per phase" (15.01). */
function stratGate(state: GameState, side: Side, stratId: string, cp: number): string | null {
  if (state.cp[side] < cp) return `needs ${cp} CP`;
  if (state.stratUsed?.[`${side}:${stratId}`] === phaseKeyOf(state)) return 'already used this phase';
  return null;
}

/** Apply N mortal wounds to a unit, one model at a time (no saves; FNP not modelled here). */
function applyMortalWounds(u: UnitInstance, n: number): UnitInstance {
  let models = u.models;
  for (let i = 0; i < n; i++) {
    const k = models.findIndex((m) => m.alive);
    if (k < 0) break;
    const w = models[k]!.wounds - 1;
    models = models.map((m, j) => (j === k ? { ...m, wounds: w, alive: w > 0 } : m));
  }
  return { ...u, models };
}

/** Append an effect id to a unit's active effects (no duplicates). */
function addEffect(status: UnitInstance['status'], effectId: string): UnitInstance['status'] {
  const current = status.activeEffects ?? [];
  if (current.includes(effectId)) return status;
  return { ...status, activeEffects: [...current, effectId] };
}

/** A `cpenh:` enhancement carried on the roster (a List Builder pick) decides the side's
 *  one-per-patrol choice when its bearer is placed; if the side has already decided otherwise
 *  (deployment picker / another carried pick), the carried enhancement is dropped. Returns the
 *  effective enhancement for the placing unit plus the (possibly updated) state. */
function absorbCpEnhancementCarry(
  state: GameState,
  owner: Side,
  datasheetId: string,
  enhancementId: string | undefined,
): { state: GameState; enhancementId: string | undefined } {
  if (!enhancementId?.startsWith('cpenh:') || state.battleType !== 'combat_patrol') {
    return { state, enhancementId };
  }
  const label = enhancementId.split(':')[2]?.replace(/_/g, ' ') ?? enhancementId;
  const decided = state.cpEnhancements?.[owner];
  if (!decided) {
    return {
      enhancementId,
      state: {
        ...state,
        cpEnhancements: { ...(state.cpEnhancements ?? {}), [owner]: { id: enhancementId, targetDsId: datasheetId } },
        log: [...state.log, `${owner}'s list carries the ${label} enhancement`],
      },
    };
  }
  if (decided.id === enhancementId) return { state, enhancementId };
  return {
    enhancementId: undefined,
    state: {
      ...state,
      log: [...state.log, `${owner} already decided an enhancement — the list's ${label} is dropped (one per patrol)`],
    },
  };
}

/** The side's chosen Combat Patrol enhancement id, when this datasheet is its bearer and no
 *  unit carries it yet (Combat Squad halves etc. — first matching deploy gets the stamp). */
function cpEnhancementFor(state: GameState, owner: Side, datasheetId: string): string | undefined {
  const pick = state.cpEnhancements?.[owner];
  if (!pick?.id || pick.targetDsId !== datasheetId) return undefined;
  if (state.units.some((u) => u.owner === owner && u.enhancementId === pick.id)) return undefined;
  return pick.id;
}

/** A FORCED battle-shock roll (ability-triggered, regardless of strength): 2D6 vs Ld; on a
 *  failure the unit is battle-shocked. Returns the updated state. */
function forcedBattleShockRoll(
  state: GameState,
  unitId: string,
  cause: string,
  ctx: EngineContext,
  rng: RNG,
): GameState {
  const unit = state.units.find((u) => u.id === unitId);
  const ds = unit ? ctx.datasheets.get(unit.datasheetId) : undefined;
  if (!unit || !ds || !unit.models.some((m) => m.alive)) return state;
  const roll = rng.roll(2);
  const total = roll[0]! + roll[1]!;
  const ld = ds.models[0]?.Ld ?? 7;
  const failed = total < ld;
  return {
    ...state,
    units: failed
      ? state.units.map((u) => (u.id === unitId ? { ...u, status: { ...u.status, battleShocked: true } } : u))
      : state.units,
    log: [...state.log, `${cause}: ${ds.name} battle-shock roll 2D6=${total} vs Ld ${ld} — ${failed ? 'FAILED (battle-shocked)' : 'passed'}`],
  };
}

/** Combat Patrol post-shoot specials, applied after a ShootUnit resolves:
 *  • PUNISHING VOLLEY (Hellblasters): one enemy unit hit makes a battle-shock roll;
 *  • GUIDANCE OF THE ANCIENTS (Venerable Dreadnought): one enemy unit hit is marked — friendly
 *    ranged attacks against it get +1 to hit.
 *  Simplification: "hit by those attacks" is proxied by the volley's MAIN target. */
function cpPostShootAbilities(
  state: GameState,
  attackerUnitId: string,
  targetUnitId: string,
  ctx: EngineContext,
  rng: RNG,
): GameState {
  const attacker = state.units.find((u) => u.id === attackerUnitId);
  const aDs = attacker ? ctx.datasheets.get(attacker.datasheetId) : undefined;
  if (!attacker || !aDs) return state;
  const target = state.units.find((u) => u.id === targetUnitId);
  if (!target || !target.models.some((m) => m.alive)) return state;
  let next = state;
  if (hasAbilityStarting(aDs, 'punishing volley')) {
    next = forcedBattleShockRoll(next, targetUnitId, 'Punishing Volley', ctx, rng);
  }
  if (hasAbilityStarting(aDs, 'guidance of the ancients') && !target.status.activeEffects?.includes('cp:guided_target')) {
    next = {
      ...next,
      units: next.units.map((u) => (u.id === targetUnitId ? { ...u, status: addEffect(u.status, 'cp:guided_target') } : u)),
      log: [...next.log, `Guidance of the Ancients: ranged attacks against ${ctx.datasheets.get(target.datasheetId)?.name ?? target.id} get +1 to hit`],
    };
  }
  // Earth Caste Modifications (Cloudspear enhancement): one enemy unit hit is suppressed until
  // the start of the bearer's next turn — its attacks take -1 to hit.
  if (cpEnhancementSlug(attacker) === 'earth_caste_modifications') {
    const until = (next.turnCounter ?? 0) + 2;
    if ((target.status.suppressedUntil ?? 0) < until) {
      next = {
        ...next,
        units: next.units.map((u) => (u.id === targetUnitId ? { ...u, status: { ...u.status, suppressedUntil: until } } : u)),
        log: [...next.log, `Earth Caste Modifications: ${ctx.datasheets.get(target.datasheetId)?.name ?? target.id} is suppressed (-1 to hit)`],
      };
    }
  }
  return next;
}

// ── helpers ──────────────────────────────────────────────────────────────────
interface LayoutOpts {
  unitId: string;
  baseShape: BaseShape;
  modelCount: number;
  wounds: number;
  anchor: Vec2;
  formation?: Formation;
  rotation?: number;
  wargear?: Record<string, number>;
}

/** Lay a unit's models out in the requested formation around `anchor`, spaced by base size. */
function layoutModels(opts: LayoutOpts, layout: Layout): ModelInstance[] {
  const positions = formationPositions({
    anchor: opts.anchor,
    count: opts.modelCount,
    baseShape: opts.baseShape,
    formation: opts.formation ?? 'block',
    rotation: opts.rotation ?? 0,
  });
  const wargearByModel = assignWargear(opts.wargear, positions.length);
  return positions.map((pos, i) => ({
    id: `${opts.unitId}:m${i}`,
    unitId: opts.unitId,
    pos: clampToBoard(pos, layout),
    wounds: opts.wounds,
    alive: true,
    ...(wargearByModel[i]?.length ? { wargear: wargearByModel[i] } : {}),
  }));
}

/** World positions for a unit's models in a formation (no clamping) — for deployment validation. */
function formationWorld(opts: LayoutOpts): Vec2[] {
  return formationPositions({
    anchor: opts.anchor,
    count: opts.modelCount,
    baseShape: opts.baseShape,
    formation: opts.formation ?? 'block',
    rotation: opts.rotation ?? 0,
  });
}

const FALLBACK_SHAPE: BaseShape = { kind: 'circle', radius: 0.63 };

/**
 * 11e Event Companion layouts store the ATTACKER's zone under `deploymentZones.player` (loader
 * convention). Once the roll-off decides who attacks, make sure the attacker side owns that
 * zone — swapping the two polygons when the AI is the Attacker. `attackerZone` records the
 * current assignment so repeated calls (SetAttacker after RollRoles) never double-swap.
 */
function layoutForAttacker(layout: Layout, attacker: Side): Layout {
  if (!layout.terrainAreas) return layout; // legacy layouts keep their fixed zones
  const current = (layout as Layout & { attackerZone?: Side }).attackerZone ?? 'player';
  if (current === attacker) return layout;
  return {
    ...layout,
    deploymentZones: { player: layout.deploymentZones.opponent, opponent: layout.deploymentZones.player },
    ...( { attackerZone: attacker } as Partial<Layout>),
  };
}

/** Is a deployment-entry id on the board / in Reserves (directly or as a merged Leader)? */
/** Split-aware "is this deployment entry placed?" — delegates to the canonical helper so the
 *  reducer's guards (DeclareFormation / DeclareSplit / DeclareEnhancementGrant) agree with the
 *  UI and the AI about split entries. */
function isUnitPlaced(state: GameState, entryKey: string): boolean {
  return isEntryPlaced(state, entryKey);
}

/**
 * May a declared Leader pairing set up as Infiltrators? Either every datasheet in the pair has
 * Infiltrators itself (10e: a unit has a deployment ability only if all its models do), or the
 * Leader has Backroom Deals ("while this model is leading a unit, models in that unit have the
 * Infiltrators ability"). Backroom Deals selects ONE unit per army, so only the side's first
 * pairing with a Backroom Deals leader gets the grant.
 */
function pairInfiltrates(
  leaderDs: Datasheet,
  bodyguardDs: Datasheet,
  formations: DeclaredFormation[],
  side: Side,
  ctx: EngineContext,
): boolean {
  const hasInfiltrators = (ds: Datasheet | undefined) =>
    !!ds &&
    ((ds.abilities ?? []).some((a) => a.name.toLowerCase() === 'infiltrators') ||
      ds.keywords.some((k) => k.toLowerCase().includes('infiltrat')));
  const hasBackroom = (ds: Datasheet | undefined) =>
    !!ds && (ds.abilities ?? []).some((a) => a.name.toLowerCase() === 'backroom deals');
  if (hasInfiltrators(leaderDs) && hasInfiltrators(bodyguardDs)) return true;
  if (!hasBackroom(leaderDs)) return false;
  const grantUsed = formations.some(
    (f) => f.side === side && f.infiltrate && hasBackroom(ctx.datasheets.get(f.leaderDsId)),
  );
  return !grantUsed;
}

/** All alive enemy models on the board, with their base shape (for 9"/zone deployment checks). */
function enemyModelsOnBoard(state: GameState, side: Side, ctx?: EngineContext): { pos: Vec2; shape: BaseShape }[] {
  const out: { pos: Vec2; shape: BaseShape }[] = [];
  for (const u of state.units) {
    if (u.owner === side || u.inReserves) continue;
    const shape = ctx?.datasheets.get(u.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
    for (const m of u.models) if (m.alive) out.push({ pos: m.pos, shape });
  }
  return out;
}

/**
 * Pin defensive wargear (shields → invuln) onto distinct models, filling from the front, so the
 * combat engine can resolve per-model saves. Only defensively-relevant items are placed (each on
 * its own model); other wargear has no in-game effect yet and is left off the live models to avoid
 * crowding shields out. The full counts still ride on the Roster for the record.
 */
function assignWargear(wargear: Record<string, number> | undefined, n: number): string[][] {
  const out: string[][] = Array.from({ length: n }, () => []);
  if (!wargear) return out;
  let cursor = 0;
  for (const [item, count] of Object.entries(wargear)) {
    if (!defensiveProfileForItem(item)) continue;
    for (let k = 0; k < count && cursor < n; k++) out[cursor++]!.push(item);
  }
  return out;
}

function clampToBoard(p: Vec2, layout: Layout): Vec2 {
  return {
    x: clamp(p.x, 0, layout.boardWidth),
    y: clamp(p.y, 0, layout.boardHeight),
  };
}
