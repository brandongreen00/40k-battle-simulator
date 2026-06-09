// Battle-shock (plan §4). PURE — uses the injected RNG.
//
// In the Command phase, a unit Below Half-strength must take a Battle-shock test: 2D6 vs its
// Leadership. Fail and it is Battle-shocked until its controller's next Command phase
// (OC becomes 0, it can't use stratagems, and — crucially for Grizzled Company — Orders switch off).

import type { RNG } from './rng';

/** A unit is Below Half-strength when fewer than half its starting models remain (or, for a
 *  single multi-wound model, when it is below half its starting wounds). */
export function belowHalfStrength(aliveModels: number, startingModels: number, woundsFraction?: number): boolean {
  if (startingModels === 1 && woundsFraction != null) return woundsFraction < 0.5;
  return aliveModels < startingModels / 2;
}

export interface BattleShockTest {
  required: boolean;
  roll: number[]; // the 2D6 (empty when no test was required)
  total: number;
  leadership: number;
  passed: boolean;
}

/** Resolve a Battle-shock test. A test is only required when the unit is below half-strength. */
export function battleShockTest(
  aliveModels: number,
  startingModels: number,
  leadership: number,
  rng: RNG,
  woundsFraction?: number,
): BattleShockTest {
  if (!belowHalfStrength(aliveModels, startingModels, woundsFraction)) {
    return { required: false, roll: [], total: 0, leadership, passed: true };
  }
  const roll = rng.roll(2);
  const total = roll[0]! + roll[1]!;
  return { required: true, roll, total, leadership, passed: total >= leadership };
}
