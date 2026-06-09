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
import { baseHalfExtents, clamp } from './geometry';

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
      /** Where to drop the unit; models are laid out in a grid around this point (inches). */
      anchor: Vec2;
    }
  | { type: 'MoveModel'; modelId: string; pos: Vec2 }
  | { type: 'RemoveUnit'; unitId: string }
  | { type: 'ClearUnits' };

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
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
/** Lay a unit's models out in a compact grid around `anchor`, spaced by base size. */
function layoutModels(intent: Extract<Intent, { type: 'SpawnUnit' }>, layout: Layout): ModelInstance[] {
  const { hx, hy } = baseHalfExtents(intent.baseShape);
  const gap = 0.2; // inches between bases
  const stepX = hx * 2 + gap;
  const stepY = hy * 2 + gap;
  const cols = Math.max(1, Math.ceil(Math.sqrt(intent.modelCount)));

  const models: ModelInstance[] = [];
  for (let i = 0; i < intent.modelCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const rows = Math.ceil(intent.modelCount / cols);
    const pos: Vec2 = {
      x: intent.anchor.x + (col - (cols - 1) / 2) * stepX,
      y: intent.anchor.y + (row - (rows - 1) / 2) * stepY,
    };
    models.push({
      id: `${intent.unitId}:m${i}`,
      unitId: intent.unitId,
      pos: clampToBoard(pos, layout),
      wounds: intent.wounds,
      alive: true,
    });
  }
  return models;
}

function clampToBoard(p: Vec2, layout: Layout): Vec2 {
  return {
    x: clamp(p.x, 0, layout.boardWidth),
    y: clamp(p.y, 0, layout.boardHeight),
  };
}
