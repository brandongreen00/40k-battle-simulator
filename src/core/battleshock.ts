// Battle-shock (11e Core Rules 01.07 / 08.03). PURE — uses the injected RNG.
//
// In the Battle-shock step of the Command phase, the active player makes one battle-shock roll
// (a leadership roll: 2D6 ≥ Ld) for each of their units that is AT OR BELOW half-strength, or
// that is already battle-shocked (success clears the state — recovery is new in 11e).
// While battle-shocked: OC becomes '-', the controller cannot target the unit with stratagems,
// it cannot start (or complete) actions, and it must use Desperate Escape to fall back.

import type { RNG } from './rng';

/** 11e half-strength (Rules Appendix): AT or below half. Single-model units use wounds vs W. */
export function atOrBelowHalfStrength(
  aliveModels: number,
  startingModels: number,
  woundsFraction?: number,
): boolean {
  if (startingModels === 1 && woundsFraction != null) return woundsFraction <= 0.5;
  return aliveModels <= startingModels / 2;
}

/** @deprecated 10e name — kept for callers that still mean "strictly below half". */
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

/**
 * Resolve a battle-shock roll. A roll is required when the unit is at-or-below half-strength
 * OR is currently battle-shocked (recovery roll, 08.03).
 */
export function battleShockTest(
  aliveModels: number,
  startingModels: number,
  leadership: number,
  rng: RNG,
  woundsFraction?: number,
  currentlyShocked = false,
): BattleShockTest {
  if (!currentlyShocked && !atOrBelowHalfStrength(aliveModels, startingModels, woundsFraction)) {
    return { required: false, roll: [], total: 0, leadership, passed: true };
  }
  const roll = rng.roll(2);
  const total = roll[0]! + roll[1]!;
  return { required: true, roll, total, leadership, passed: total >= leadership };
}
