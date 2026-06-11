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

import type { BaseShape, GameState, Layout, ModelInstance, Side, UnitInstance, Vec2 } from './types';
import type { RNG } from './rng';
import { clamp, clampToRange } from './geometry';
import { formationPositions, type Formation } from './formation';
import { defensiveProfileForItem } from './wargear';
import { rollOff, otherSide } from './setup';
import { checkUnitDeployment, deepStrikeArrivalLegal, type DeployAbility } from './deployment';
import { checkCoherency } from './coherency';
import { canAttach, leaderJoinPositions } from './leaders';
import { maxMoveDistance, rollAdvance, type MoveMode } from './movement';
import { moveBonusFromOrders } from './orders';
import {
  resolveAttack,
  resolveCharge,
  resolveFightMove,
  resolveUnitShooting,
  runCommandPhase,
  type AttackParams,
  type ChargeParams,
  type FightMoveParams,
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
  /** Resolve a charge roll (2D6). Requires the EngineContext. */
  | ({ type: 'Charge' } & ChargeParams)
  /** Pile In / Consolidate (Fight phase): move a unit up to 3" toward the nearest enemy. */
  | ({ type: 'FightMove' } & FightMoveParams)
  /** Run the active player's Command phase: CP, Battle-shock, Primary scoring. Requires EngineContext. */
  | { type: 'RunCommandPhase' }
  /** Set per-unit status flags (movement/charge bookkeeping that later phases drive). */
  | { type: 'SetUnitStatus'; unitId: string; status: Partial<UnitInstance['status']> }
  // ── Abilities / Orders / Stratagems (Phase 3) ─────────────────────────────────
  /** Issue an Order to a unit: applies an effect (from core/effects.ts) until end of turn. */
  | { type: 'IssueOrder'; unitId: string; effectId: string }
  /** Use a Stratagem: spend CP for a side and optionally apply an effect to a target unit.
   *  Not gated by the active player, so reactive stratagems (Displacer Field) work in the
   *  opponent's turn (architecture rule #3). */
  | { type: 'UseStratagem'; name: string; side: Side; cost: number; targetUnitId?: string; effectId?: string }
  // ── Pre-battle setup / deployment (Stage: setup) ──────────────────────────────
  /** Start a new battle: clear the board and enter deployment at the roll-off step. */
  | { type: 'NewBattle' }
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
      /** Deployment ability — gates zone legality (Infiltrators may deploy in no-man's-land). */
      ability?: DeployAbility;
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
    }
  /** Attach a Leader (CHARACTER) unit to a Bodyguard unit (validated against canLead/canBeLedBy). */
  | { type: 'AttachLeader'; leaderUnitId: string; bodyguardUnitId: string }
  /** Detach a previously attached Leader. */
  | { type: 'DetachLeader'; leaderUnitId: string }
  /** Roll off for the first turn; the winner takes it. Moves setup to 'ready'. */
  | { type: 'RollFirstTurn' }
  /** Finish deployment and begin the battle (Command phase of round 1). */
  | { type: 'BeginBattle' }
  // ── Movement (Stage: battle) ─────────────────────────────────────────────────
  /** Begin a Movement activation for one or more units: snapshot origins, set the per-unit budget
   *  (M, or M+D6 for an Advance), so MoveModel/NudgeUnit can clamp to range. */
  | { type: 'BeginMove'; unitIds: string[]; mode: MoveMode }
  /** Rigidly translate the given (moving) units by `delta` inches from their move origins, clamped
   *  per-unit to the move budget. Used by the drag-select group move; preserves coherency. */
  | { type: 'NudgeUnit'; unitIds: string[]; delta: Vec2 }
  /** Finalise a Movement activation: rejects if any unit is out of coherency, else locks in the move. */
  | { type: 'EndMove'; unitIds: string[] }
  /** Abort a Movement activation: snap the units back to their origins, record no move. */
  | { type: 'CancelMove'; unitIds: string[] }
  /** Bring a Reserves unit onto the board (Deep Strike), validated > 9" from enemies, round 2+. */
  | { type: 'ArriveFromReserves'; unitId: string; anchor: Vec2; formation?: Formation; rotation?: number };

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
      ? { ...u, status: {}, models: u.models.map((m) => (m.moveStart ? { ...m, moveStart: undefined } : m)) }
      : u,
  );
}

/** Advance the Pariah Nexus sequencer one step. Phases→turns→rounds; ends after round 5. */
function advancePhase(state: GameState): GameState {
  if (state.ended || state.stage !== 'battle') return state;
  const i = PARIAH_NEXUS_PHASES.indexOf(state.phase as Phase);
  if (i >= 0 && i < PARIAH_NEXUS_PHASES.length - 1) {
    return { ...state, phase: PARIAH_NEXUS_PHASES[i + 1]! };
  }
  // End of the Fight phase — the active player's turn ends.
  if (state.activePlayer === state.firstPlayer) {
    const next = otherSide(state.activePlayer);
    return {
      ...state,
      activePlayer: next,
      phase: PARIAH_NEXUS_PHASES[0]!,
      commandRun: false,
      units: beginTurnFor(state, next),
      log: [...state.log, `— ${next} turn, round ${state.round} —`],
    };
  }
  // Second player just finished: advance the round (or end the battle after round 5).
  if (state.round >= 5) {
    return { ...state, ended: true, log: [...state.log, '— battle ends (round 5 complete) —'] };
  }
  const round = state.round + 1;
  const next = state.firstPlayer;
  return {
    ...state,
    round,
    activePlayer: next,
    phase: PARIAH_NEXUS_PHASES[0]!,
    commandRun: false,
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
      const models = layoutModels(intent, state.layout);
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
      // free dragging outside it would bypass the movement rules. The sandbox/deployment stay free.
      if (state.mode === 'match' && state.stage === 'battle') {
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
      return advancePhase(state);

    case 'SetFirstPlayer':
      return { ...state, firstPlayer: intent.side, activePlayer: intent.side, round: 1, phase: PARIAH_NEXUS_PHASES[0], ended: false };

    case 'SetUnitStatus':
      return {
        ...state,
        units: state.units.map((u) =>
          u.id === intent.unitId ? { ...u, status: { ...u.status, ...intent.status } } : u,
        ),
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
      return outcome.state;
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
      return outcome.state;
    }

    case 'Charge': {
      if (!ctx) return { ...state, log: [...state.log, 'Charge ignored: no datasheet context supplied'] };
      const { type: _t, ...params } = intent;
      return resolveCharge(state, params, ctx, rng).state;
    }

    case 'FightMove': {
      if (!ctx) return { ...state, log: [...state.log, 'Fight move ignored: no datasheet context supplied'] };
      const { type: _t, ...params } = intent;
      return resolveFightMove(state, params, ctx).state;
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
      return { ...runCommandPhase(state, ctx, rng), commandRun: true };
    }

    case 'IssueOrder':
      return {
        ...state,
        units: state.units.map((u) =>
          u.id === intent.unitId ? { ...u, status: addEffect(u.status, intent.effectId) } : u,
        ),
        log: [...state.log, `Order ${intent.effectId} → ${intent.unitId}`],
      };

    case 'UseStratagem': {
      if (state.cp[intent.side] < intent.cost) {
        return { ...state, log: [...state.log, `Stratagem "${intent.name}" rejected: needs ${intent.cost} CP, ${intent.side} has ${state.cp[intent.side]}`] };
      }
      const cp = { ...state.cp, [intent.side]: state.cp[intent.side] - intent.cost };
      const units =
        intent.targetUnitId && intent.effectId
          ? state.units.map((u) =>
              u.id === intent.targetUnitId ? { ...u, status: addEffect(u.status, intent.effectId!) } : u,
            )
          : state.units;
      return {
        ...state,
        cp,
        units,
        log: [...state.log, `${intent.side} uses Stratagem "${intent.name}" (-${intent.cost} CP)${intent.effectId ? ` → ${intent.effectId}` : ''}`],
      };
    }

    // ── Pre-battle setup / deployment ──────────────────────────────────────────
    case 'NewBattle':
      return {
        ...createInitialState(state.layout),
        stage: 'setup',
        mode: 'match',
        setup: { step: 'roll_roles' },
        log: ['— Deployment — roll off to determine Attacker and Defender —'],
      };

    case 'RollRoles': {
      const ro = rollOff(rng);
      const attacker = ro.winner;
      const defender = otherSide(attacker);
      return {
        ...state,
        stage: 'setup',
        setup: {
          ...(state.setup ?? { step: 'roll_roles' }),
          step: 'deploy',
          roleRoll: ro,
          attacker,
          defender,
          toDeploy: defender, // the Defender deploys first
        },
        log: [...state.log, `Roll-off: player ${ro.player}, ai ${ro.ai} → ${attacker} is Attacker; ${defender} deploys first`],
      };
    }

    case 'SetAttacker': {
      const attacker = intent.side;
      const defender = otherSide(attacker);
      return {
        ...state,
        stage: 'setup',
        setup: { ...(state.setup ?? { step: 'roll_roles' }), step: 'deploy', attacker, defender, toDeploy: defender },
        log: [...state.log, `${attacker} is Attacker; ${defender} deploys first`],
      };
    }

    case 'DeployUnit': {
      const ability = intent.ability ?? 'standard';
      const positions = formationWorld(intent);
      const enemies = enemyModelsOnBoard(state, intent.owner, ctx);
      const check = checkUnitDeployment(positions, intent.baseShape, state.layout, intent.owner, ability, enemies);
      if (!check.legal) {
        return { ...state, log: [...state.log, `Deployment rejected (${intent.owner}): ${check.reason}`] };
      }
      const models = layoutModels(intent, state.layout);
      const unit: UnitInstance = {
        id: intent.unitId, owner: intent.owner, datasheetId: intent.datasheetId,
        models, startingModels: models.length, status: {},
        ...(intent.wargear ? { wargearCounts: intent.wargear } : {}),
      };
      const setup = state.setup ? { ...state.setup, toDeploy: otherSide(intent.owner) } : state.setup;
      return { ...state, units: [...state.units, unit], setup, log: [...state.log, `${intent.owner} deploys a unit (${models.length} models)`] };
    }

    case 'PlaceInReserves': {
      // Off-board until it arrives; lay the models out at the origin as placeholders.
      const models = layoutModels({ ...intent, anchor: { x: 0, y: 0 } }, state.layout);
      const unit: UnitInstance = {
        id: intent.unitId, owner: intent.owner, datasheetId: intent.datasheetId,
        models, startingModels: models.length, status: {}, inReserves: true,
        ...(intent.wargear ? { wargearCounts: intent.wargear } : {}),
      };
      const setup = state.setup ? { ...state.setup, toDeploy: otherSide(intent.owner) } : state.setup;
      return { ...state, units: [...state.units, unit], setup, log: [...state.log, `${intent.owner} places a unit in Reserves`] };
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
        if (!canAttach(lDs, bDs)) {
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
      };
      return {
        ...state,
        units: [...state.units.map((u) => (u.id === bodyguard.id ? newBodyguard : u)), leaderUnit],
        log: [...state.log, 'Leader detached from its Bodyguard unit'],
      };
    }

    case 'RollFirstTurn': {
      const ro = rollOff(rng);
      return {
        ...state,
        firstPlayer: ro.winner,
        activePlayer: ro.winner,
        setup: { ...(state.setup ?? { step: 'deploy' }), step: 'ready', firstTurnRoll: ro, firstTurn: ro.winner },
        log: [...state.log, `First-turn roll-off: player ${ro.player}, ai ${ro.ai} → ${ro.winner} takes the first turn`],
      };
    }

    case 'BeginBattle': {
      const first = state.setup?.firstTurn ?? state.firstPlayer;
      return {
        ...state,
        stage: 'battle',
        setup: undefined,
        commandRun: false,
        round: 1,
        firstPlayer: first,
        activePlayer: first,
        phase: PARIAH_NEXUS_PHASES[0],
        ended: false,
        log: [...state.log, `— Battle begins — ${first} takes the first turn (round 1) —`],
      };
    }

    // ── Movement ───────────────────────────────────────────────────────────────
    case 'BeginMove': {
      let log = state.log;
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
        const budget = maxMoveDistance(M, intent.mode, advanceRoll) + orderBonus;
        return {
          ...u,
          status: { ...u.status, moveMode: intent.mode, moveBudget: budget },
          models: u.models.map((m) => (m.alive ? { ...m, moveStart: m.pos } : m)),
        };
      });
      return { ...state, units, log };
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
        const mode = u.status.moveMode;
        const flag =
          mode === 'advance' ? { advanced: true, moved: true }
          : mode === 'fall_back' ? { fellBack: true, moved: true }
          : mode === 'stationary' ? { remainedStationary: true }
          : { moved: true };
        return {
          ...u,
          status: { ...u.status, ...flag, moveMode: undefined, moveBudget: undefined },
          models: u.models.map((m) => (m.moveStart ? { ...m, moveStart: undefined } : m)),
        };
      });
      if (!anyRejected) log = [...log, `Move confirmed`];
      return { ...state, units, log };
    }

    case 'ArriveFromReserves': {
      const unit = state.units.find((u) => u.id === intent.unitId);
      if (!unit || !unit.inReserves) return { ...state, log: [...state.log, 'Arrival rejected: not in Reserves'] };
      const shape = ctx?.datasheets.get(unit.datasheetId)?.baseShape ?? FALLBACK_SHAPE;
      const wounds = unit.models[0]?.wounds ?? 1;
      const opts: LayoutOpts = {
        unitId: unit.id, baseShape: shape, modelCount: unit.models.length, wounds,
        anchor: intent.anchor, formation: intent.formation, rotation: intent.rotation,
      };
      const enemies = enemyModelsOnBoard(state, unit.owner, ctx);
      const check = deepStrikeArrivalLegal(formationWorld(opts), shape, enemies, state.round);
      if (!check.legal) return { ...state, log: [...state.log, `Deep Strike rejected: ${check.reason}`] };
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
            ? { ...u, models: newModels, inReserves: false, arrivedRound: state.round, status: { ...u.status, moved: true } }
            : u,
        ),
        log: [...state.log, `A unit arrives from Reserves via Deep Strike (round ${state.round})`],
      };
    }
  }
}

/** Append an effect id to a unit's active effects (no duplicates). */
function addEffect(status: UnitInstance['status'], effectId: string): UnitInstance['status'] {
  const current = status.activeEffects ?? [];
  if (current.includes(effectId)) return status;
  return { ...status, activeEffects: [...current, effectId] };
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
