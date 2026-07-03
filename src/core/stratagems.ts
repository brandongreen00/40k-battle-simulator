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

/** The universal Core stratagems (11e Core Rules 15.02–15.12). */
export const CORE_STRATAGEMS: Stratagem[] = [
  { id: 'core:command_reroll', name: 'Command Re-roll', cp: 1, phase: 'Any phase', turn: 'either', text: 'Re-roll one advance/charge/damage/hazard/hit/save/wound/attacks roll (charge rolls re-roll the full 2D6).' },
  { id: 'core:epic_challenge', name: 'Epic Challenge', cp: 1, phase: 'Fight phase', turn: 'either', effectId: 'precision_melee', text: 'When a friendly CHARACTER unit is selected to fight: one CHARACTER model’s melee weapons gain [PRECISION] this phase.' },
  { id: 'core:insane_bravery', name: 'Insane Bravery', cp: 1, phase: 'Command phase', turn: 'your', text: 'One battle-shock roll is automatically successful (once per battle).' },
  { id: 'core:explosives', name: 'Explosives', cp: 1, phase: 'Shooting phase', turn: 'your', text: 'An unengaged EXPLOSIVES/GRENADES unit that did not advance: pick an enemy unit within 8" and visible — roll 6D6; each 4+ inflicts 1 mortal wound.' },
  { id: 'core:crushing_impact', name: 'Crushing Impact', cp: 1, phase: 'Charge phase', turn: 'your', text: 'After a friendly MONSTER/VEHICLE ends a charge move: roll dice equal to its Toughness — each 1 = 1 mortal wound to it, each 5+ = 1 mortal wound to an engaged enemy unit (max 6).' },
  { id: 'core:rapid_ingress', name: 'Rapid Ingress', cp: 1, phase: 'Movement phase', turn: 'opponent', text: 'End of your opponent’s Movement phase: one of your strategic reserves units makes an ingress move (not in the first battle round).' },
  { id: 'core:fire_overwatch', name: 'Fire Overwatch', cp: 1, phase: 'Movement phase', turn: 'opponent', text: 'End of your opponent’s Movement phase: one unengaged non-TITANIC unit shoots one visible enemy unit within 24" using snap shooting (only unmodified 6s hit).' },
  { id: 'core:smokescreen', name: 'Smokescreen', cp: 1, phase: 'Shooting phase', turn: 'opponent', effectId: 'stealth', text: 'Start of your opponent’s Shooting phase: a SMOKE unit (and units it screens) has the Benefit of Cover this phase.' },
  { id: 'core:heroic_intervention', name: 'Heroic Intervention', cp: 1, phase: 'Charge phase', turn: 'opponent', text: 'End of your opponent’s Charge phase: an unengaged unit within 12" of an enemy resolves a charge (Leap to Defend: chargers only; +1CP Into the Fray: roll capped at 6, targets within 6").' },
  { id: 'core:counter_offensive', name: 'Counteroffensive', cp: 2, phase: 'Fight phase', turn: 'opponent', text: 'After an enemy unit resolves its attacks in the Fight step: one of your eligible units gains Fights First and must be selected next.' },
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
