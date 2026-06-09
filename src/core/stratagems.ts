// Stratagems (10e). PURE — no React, no DOM, no I/O.
//
// Two sources, one shape:
//   • CORE_STRATAGEMS — the dozen universal stratagems every army may use, curated here (the
//     Wahapedia export only carries detachment-scoped ones).
//   • detachment stratagems — normalised from the data by the loader and passed in.
//
// `usableStratagems` is the pure filter the UI and the future AI both call to ask "which stratagems
// can <side> use right now?" given the phase, whose turn it is, the side's detachment, and its CP.
// Reactive stratagems (turn: 'opponent') are intentionally usable on the *other* player's turn —
// the engine never gates Stratagems by the active player (architecture rule #3).

export type StratTurn = 'either' | 'your' | 'opponent';

export interface Stratagem {
  id: string;
  name: string;
  cp: number;
  /** Raw phase string ("Command phase", "Shooting phase", "Any phase", "Movement or Charge phase"…). */
  phase: string;
  turn: StratTurn;
  /** Undefined => a Core stratagem available to every army; else the owning detachment. */
  detachment?: string;
  faction?: string;
  type?: string;
  text?: string;
  /** Optional binding into core/effects.ts EFFECT_REGISTRY (applied to a target when chosen). */
  effectId?: string;
}

/** The universal Core stratagems (10e). */
export const CORE_STRATAGEMS: Stratagem[] = [
  { id: 'core:command_reroll', name: 'Command Re-roll', cp: 1, phase: 'Any phase', turn: 'either', text: 'Re-roll one dice (a single hit/wound/save/etc. roll, or a roll made for a 2D6/3D6 charge etc.).' },
  { id: 'core:counter_offensive', name: 'Counter-offensive', cp: 2, phase: 'Fight phase', turn: 'either', text: 'After an enemy unit fights, fight with one of your eligible units out of sequence.' },
  { id: 'core:epic_challenge', name: 'Epic Challenge', cp: 1, phase: 'Fight phase', turn: 'either', text: 'A CHARACTER in a fighting unit gains Precision until the end of the phase.' },
  { id: 'core:insane_bravery', name: 'Insane Bravery', cp: 1, phase: 'Command phase', turn: 'your', text: 'One of your units automatically passes its Battle-shock test (once per battle).' },
  { id: 'core:go_to_ground', name: 'Go to Ground', cp: 1, phase: 'Shooting phase', turn: 'opponent', effectId: 'stealth', text: 'An INFANTRY target gains the Benefit of Cover and a 6+ invulnerable save until the end of the phase.' },
  { id: 'core:smokescreen', name: 'Smokescreen', cp: 1, phase: 'Shooting phase', turn: 'opponent', effectId: 'stealth', text: 'A SMOKE target gains the Benefit of Cover and Stealth until the end of the phase.' },
  { id: 'core:tank_shock', name: 'Tank Shock', cp: 1, phase: 'Charge phase', turn: 'your', text: 'A charging VEHICLE rolls dice based on its Strength, dealing mortal wounds to an enemy it is in base contact with.' },
  { id: 'core:grenade', name: 'Grenade', cp: 1, phase: 'Shooting phase', turn: 'your', text: 'A GRENADES unit throws a grenade at a nearby enemy: D6 hits, mortal wounds on 4+.' },
  { id: 'core:fire_overwatch', name: 'Fire Overwatch', cp: 1, phase: 'Movement or Charge phase', turn: 'opponent', text: 'When an enemy unit moves, a unit shoots it, scoring hits only on unmodified 6s.' },
  { id: 'core:rapid_ingress', name: 'Rapid Ingress', cp: 1, phase: 'Movement phase', turn: 'opponent', text: 'At the end of your opponent’s Movement phase, set up one of your Reserves units as if it were the Reinforcements step.' },
  { id: 'core:heroic_intervention', name: 'Heroic Intervention', cp: 2, phase: 'Charge phase', turn: 'opponent', text: 'When an enemy ends a Charge move nearby, one of your eligible units can declare a charge against it.' },
];

/** Normalise the data export's turn string ("Either player’s turn" / "Your turn" / "Opponent’s turn"). */
export function parseTurn(raw: string): StratTurn {
  const t = raw.toLowerCase();
  if (t.includes('either')) return 'either';
  if (t.includes('opponent')) return 'opponent';
  return 'your';
}

/** Does a stratagem's phase string include the current phase? ("Any phase" always matches.) */
export function phaseMatches(stratPhase: string, currentPhase: string): boolean {
  const p = stratPhase.toLowerCase();
  if (p.includes('any phase')) return true;
  return p.includes(currentPhase.toLowerCase());
}

/** Does a stratagem's turn restriction allow `side` to use it on `activePlayer`'s turn? */
export function turnMatches(turn: StratTurn, isYourTurn: boolean): boolean {
  if (turn === 'either') return true;
  return turn === 'your' ? isYourTurn : !isYourTurn;
}

export interface StratagemQuery {
  phase: string;
  /** True when it is `side`'s own turn (drives the your/opponent restriction). */
  isYourTurn: boolean;
  /** The side's army detachment (limits which detachment stratagems are available). */
  detachment?: string;
}

/**
 * The stratagems a side can use right now: Core stratagems plus those of its own detachment, gated
 * by phase and whose-turn. CP affordability is left to the caller (so the UI can grey out, not hide).
 */
export function usableStratagems(all: Stratagem[], q: StratagemQuery): Stratagem[] {
  return all.filter((s) => {
    if (s.detachment && s.detachment !== q.detachment) return false;
    if (!phaseMatches(s.phase, q.phase)) return false;
    if (!turnMatches(s.turn, q.isYourTurn)) return false;
    return true;
  });
}
