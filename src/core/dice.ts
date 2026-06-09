// Dice-notation parsing and rolling. PURE — no React, no DOM. Uses the injected RNG (rule #2).
//
// Weapon `attacks` and `D` (damage) come from Wahapedia as short strings: "1", "20", "D6",
// "2D6", "D3", "D3+1", "D6+2", "2D6-1". This module turns those into a structured DiceExpr
// and rolls them deterministically through the RNG so combat is reproducible and testable.

import type { RNG } from './rng';

/** A parsed dice expression: `count`d`sides` + `flat`. A pure constant is `count: 0`. */
export interface DiceExpr {
  count: number; // number of dice (0 for a flat constant)
  sides: number; // die size (6 or 3 in 40k); ignored when count is 0
  flat: number; // additive modifier
  /** The original string, preserved for the dice log. */
  text: string;
}

const DICE_RE = /^\s*(\d*)\s*[dD]\s*(\d+)\s*([+-]\s*\d+)?\s*$/;
const FLAT_RE = /^\s*([+-]?\d+)\s*$/;

/**
 * Parse a 40k dice string. Accepts "N", "DN", "MDN", "DN+K", "MDN-K".
 * Throws on anything it doesn't recognise so bad data surfaces loudly rather than silently
 * resolving to zero.
 */
export function parseDice(text: string): DiceExpr {
  const flat = FLAT_RE.exec(text);
  if (flat) {
    return { count: 0, sides: 6, flat: parseInt(flat[1]!, 10), text: text.trim() };
  }
  const m = DICE_RE.exec(text);
  if (!m) throw new Error(`unrecognised dice expression: ${JSON.stringify(text)}`);
  const count = m[1] === '' ? 1 : parseInt(m[1]!, 10);
  const sides = parseInt(m[2]!, 10);
  const flatMod = m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0;
  return { count, sides, flat: flatMod, text: text.trim() };
}

/** The largest value an expression can roll (used for "is this variable?" and previews). */
export function maxValue(expr: DiceExpr): number {
  return expr.count * expr.sides + expr.flat;
}

/** True when the expression involves a die (so the value isn't fixed). */
export function isVariable(expr: DiceExpr): boolean {
  return expr.count > 0;
}

/** Roll one expression, returning the total (floored at 0) plus the individual die faces. */
export function rollDice(expr: DiceExpr, rng: RNG): { total: number; rolls: number[] } {
  const rolls = expr.count > 0 ? rng.roll(expr.count, expr.sides) : [];
  const sum = rolls.reduce((a, b) => a + b, 0) + expr.flat;
  return { total: Math.max(0, sum), rolls };
}

/** Convenience: parse and roll in one step. */
export function roll(text: string, rng: RNG): { total: number; rolls: number[] } {
  return rollDice(parseDice(text), rng);
}
