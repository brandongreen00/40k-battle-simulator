// Movement math (plan §4). PURE — uses the injected RNG for variable distances.
//
// Position application stays with the MoveModel intent (which clamps to the board); these helpers
// supply the *legality* and the random distances (Advance D6, charge 2D6, Deep Strike 9" rule) so
// the engine and UI can validate moves and resolve charges deterministically.

import type { RNG } from './rng';

/** 'scout' = the pre-battle Scouts X" move (budget comes from the ability, not M). */
export type MoveMode = 'normal' | 'advance' | 'fall_back' | 'stationary' | 'scout';

/** Maximum move distance (inches) for a mode. `advanceRoll` is the extra D6 for an Advance. */
export function maxMoveDistance(M: number, mode: MoveMode, advanceRoll = 0): number {
  switch (mode) {
    case 'normal':
    case 'fall_back':
    case 'scout': // callers pass the Scouts X" in place of M
      return M;
    case 'advance':
      return M + advanceRoll;
    case 'stationary':
      return 0;
  }
}

/** Roll an Advance: a single D6 of bonus movement. */
export function rollAdvance(rng: RNG): { distance: number; roll: number } {
  const roll = rng.d6();
  return { distance: roll, roll };
}

/** Roll a charge: 2D6 of movement. */
export function rollCharge(rng: RNG): { distance: number; rolls: number[] } {
  const rolls = rng.roll(2);
  return { distance: rolls[0]! + rolls[1]!, rolls };
}

/**
 * Does a charge of `rollTotal` inches let the charger reach Engagement Range (within 2", 11e)?
 * Needs to close the base-to-base gap to ≤ 2", i.e. move at least (closestGap − 2) inches.
 */
export function chargeSucceeds(closestGap: number, rollTotal: number, engagementRange = 2): boolean {
  return rollTotal >= Math.max(0, closestGap - engagementRange);
}

/** Ingress/Deep Strike legality (11e, 20.04/24.09): more than `minDist` (8") from all enemies. */
export function deepStrikeLegal(enemyGaps: number[], minDist = 8): boolean {
  return enemyGaps.every((g) => g > minDist);
}
