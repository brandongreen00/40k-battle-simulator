// Unit Coherency (10e Core Rules). PURE — no React, no DOM.
//
// "A unit that contains more than one model must be set up and end any kind of move as a single
//  group, with all of its models within 2" horizontally of at least one other model from that unit.
//  While a unit has seven or more models, all of its models must instead be within 2" of at least
//  TWO other models from that unit."
//
// We measure base-to-base (closest points of bases — architecture rule #5), and enforce BOTH parts
// of the rule the tabletop relies on: (a) the per-model degree requirement (1, or 2 for 7+ models),
// and (b) the "single group" requirement (the coherency graph must be connected — a unit split into
// two clusters that each satisfy the degree rule is still NOT in coherency).
//
// This is the function the Movement UI gates "confirm" on, and the AI will call to keep its own
// moves legal.

import type { BaseShape, Vec2 } from './types';
import { baseRadius, gapBetweenBases } from './geometry';

export const COHERENCY_DISTANCE = 2; // inches, horizontal, base-to-base

export interface CoherencyResult {
  /** True when the whole unit forms one connected group AND every model meets its degree minimum. */
  inCoherency: boolean;
  /** Indices of models that fail the degree minimum (too few neighbours within 2"). */
  outOfCoherency: number[];
  /** True when the coherency graph is a single connected component (no detached clusters). */
  connected: boolean;
  /** Minimum neighbours each model needs (1, or 2 for units of 7+ models). */
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
): CoherencyResult {
  const n = positions.length;
  const required = n >= 7 ? 2 : 1;
  if (n <= 1) return { inCoherency: true, outOfCoherency: [], connected: true, required };

  const r = baseRadius(baseShape);
  // Adjacency: edge between i,j when their base-to-base gap is within `distance`.
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const gap = gapBetweenBases(positions[i]!, baseShape, positions[j]!, baseShape);
      // gapBetweenBases already subtracts both radii; r is unused but kept for clarity of intent.
      void r;
      if (gap <= distance) {
        adj[i]!.push(j);
        adj[j]!.push(i);
      }
    }
  }

  const outOfCoherency: number[] = [];
  for (let i = 0; i < n; i++) if (adj[i]!.length < required) outOfCoherency.push(i);

  // Connectivity (single group): BFS from model 0 must reach every model.
  const seen = new Array<boolean>(n).fill(false);
  const stack = [0];
  seen[0] = true;
  let reached = 1;
  while (stack.length) {
    const v = stack.pop()!;
    for (const w of adj[v]!) {
      if (!seen[w]) {
        seen[w] = true;
        reached++;
        stack.push(w);
      }
    }
  }
  const connected = reached === n;

  return { inCoherency: connected && outOfCoherency.length === 0, outOfCoherency, connected, required };
}
