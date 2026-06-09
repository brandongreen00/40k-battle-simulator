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
import { clamp } from './geometry';
import { formationPositions, type Formation } from './formation';
import {
  resolveAttack,
  resolveCharge,
  runCommandPhase,
  type AttackParams,
  type ChargeParams,
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
  /** Resolve a charge roll (2D6). Requires the EngineContext. */
  | ({ type: 'Charge' } & ChargeParams)
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
  | { type: 'UseStratagem'; name: string; side: Side; cost: number; targetUnitId?: string; effectId?: string };

export function createInitialState(layout: Layout): GameState {
  return {
    layout,
    units: [],
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

const otherSide = (s: Side): Side => (s === 'player' ? 'ai' : 'player');

/** Clear a side's per-unit, per-turn status flags at the start of that side's turn. */
function beginTurnFor(state: GameState, side: Side): UnitInstance[] {
  return state.units.map((u) => (u.owner === side ? { ...u, status: {} } : u));
}

/** Advance the Pariah Nexus sequencer one step. Phases→turns→rounds; ends after round 5. */
function advancePhase(state: GameState): GameState {
  if (state.ended) return state;
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
      };
      return { ...state, units: [...state.units, unit] };
    }

    case 'MoveModel': {
      const pos = clampToBoard(intent.pos, state.layout);
      return {
        ...state,
        units: state.units.map((u) => ({
          ...u,
          models: u.models.map((m) => (m.id === intent.modelId ? { ...m, pos } : m)),
        })),
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

    case 'Charge': {
      if (!ctx) return { ...state, log: [...state.log, 'Charge ignored: no datasheet context supplied'] };
      const { type: _t, ...params } = intent;
      return resolveCharge(state, params, ctx, rng).state;
    }

    case 'RunCommandPhase': {
      if (!ctx) return { ...state, log: [...state.log, 'Command phase ignored: no datasheet context supplied'] };
      return runCommandPhase(state, ctx, rng);
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
  }
}

/** Append an effect id to a unit's active effects (no duplicates). */
function addEffect(status: UnitInstance['status'], effectId: string): UnitInstance['status'] {
  const current = status.activeEffects ?? [];
  if (current.includes(effectId)) return status;
  return { ...status, activeEffects: [...current, effectId] };
}

// ── helpers ──────────────────────────────────────────────────────────────────
/** Lay a unit's models out in the requested formation around `anchor`, spaced by base size. */
function layoutModels(intent: Extract<Intent, { type: 'SpawnUnit' }>, layout: Layout): ModelInstance[] {
  const positions = formationPositions({
    anchor: intent.anchor,
    count: intent.modelCount,
    baseShape: intent.baseShape,
    formation: intent.formation ?? 'block',
    rotation: intent.rotation ?? 0,
  });
  return positions.map((pos, i) => ({
    id: `${intent.unitId}:m${i}`,
    unitId: intent.unitId,
    pos: clampToBoard(pos, layout),
    wounds: intent.wounds,
    alive: true,
  }));
}

function clampToBoard(p: Vec2, layout: Layout): Vec2 {
  return {
    x: clamp(p.x, 0, layout.boardWidth),
    y: clamp(p.y, 0, layout.boardHeight),
  };
}
