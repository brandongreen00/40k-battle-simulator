// Unit Coherency (11e Core Rules, 03.03). PURE — no React, no DOM.
//
// "A unit that contains more than one model must be set up and end any kind of move in coherency.
//  A unit is in coherency while both of the following apply to every model in that unit:
//   ▪ Within 2" horizontally (and 5" vertically) of at least one other model in that unit.
//   ▪ Within 9" horizontally (and 5" vertically) of EVERY other model in that unit."
//
// We measure base-to-base (closest points of bases — architecture rule #5). The 10e 7+-model
// two-neighbour rule and the explicit single-group requirement are gone in 11e — the 9" spread
// cap replaces them. (Our board is 2D, so the vertical clauses are moot.)
//
// This is the function the Movement UI gates "confirm" on, and the AI calls to keep its own
// moves legal. 11e also enforces coherency in the End of Turn step (models removed until the
// unit is coherent again) — the reducer does that via this check.

import type { BaseShape, Vec2 } from './types';
import { gapBetweenBases } from './geometry';

export const COHERENCY_DISTANCE = 2; // inches, horizontal, base-to-base
export const COHERENCY_SPREAD = 9; // inches — every model within 9" of every other model

export interface CoherencyResult {
  /** True when every model has a 2" neighbour AND the unit is within the 9" spread. */
  inCoherency: boolean;
  /** Indices of models violating either clause (no 2" neighbour, or >9" from some model). */
  outOfCoherency: number[];
  /** Kept for API compatibility: true when no model breaks the 9" spread clause. */
  connected: boolean;
  /** Minimum 2" neighbours each model needs (always 1 in 11e). */
  required: number;
}

/**
 * Evaluate unit coherency for a set of model positions sharing one base shape.
 * Single-model units are always in coherency. `positions` should be the unit's ALIVE models.
 */
export function checkCoherency(
  positions: Vec2[],
  baseShape: BaseShape,
  distance = COHERENCY_DISTANCE,
  spread = COHERENCY_SPREAD,
): CoherencyResult {
  const n = positions.length;
  const required = 1;
  if (n <= 1) return { inCoherency: true, outOfCoherency: [], connected: true, required };

  const bad = new Set<number>();
  let spreadOk = true;
  for (let i = 0; i < n; i++) {
    let hasNeighbour = false;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const gap = gapBetweenBases(positions[i]!, baseShape, positions[j]!, baseShape);
      if (gap <= distance) hasNeighbour = true;
      if (gap > spread) {
        bad.add(i);
        spreadOk = false;
      }
    }
    if (!hasNeighbour) bad.add(i);
  }

  const outOfCoherency = [...bad].sort((a, b) => a - b);
  return { inCoherency: bad.size === 0, outOfCoherency, connected: spreadOk, required };
}
