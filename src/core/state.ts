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
  | { type: 'SetLayout'; layout: Layout };

export function createInitialState(layout: Layout): GameState {
  return {
    layout,
    units: [],
    round: 1,
    activePlayer: 'player',
    phase: PARIAH_NEXUS_PHASES[0],
    cp: { player: 0, ai: 0 },
    score: { player: 0, ai: 0 },
  };
}

/**
 * Apply one validated intent, returning a new GameState (never mutates the input).
 * `rng` is accepted for parity with later stages; Stage 1 intents are deterministic.
 */
export function reduce(state: GameState, intent: Intent, _rng: RNG): GameState {
  switch (intent.type) {
    case 'SpawnUnit': {
      const models = layoutModels(intent, state.layout);
      const unit: UnitInstance = {
        id: intent.unitId,
        owner: intent.owner,
        datasheetId: intent.datasheetId,
        models,
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
  }
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
