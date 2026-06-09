// Pre-battle setup: roll-offs and the deployment sequence (10e Core Rules + Pariah Nexus). PURE.
//
// The mission-pack pre-battle order we model:
//   1. Determine Attacker & Defender — both players roll off; the winner is the Attacker.
//   2. Deploy Armies — players alternate setting up one unit at a time, the DEFENDER first, each
//      unit wholly within their own deployment zone (Infiltrators/Reserves excepted).
//   3. Determine First Turn — both players roll off; the winner takes the first turn.
//
// Roll-offs re-roll ties (a draw has no winner), so they always resolve. The dice are returned for
// the UI to render as SVG dice.

import type { RNG } from './rng';
import type { RollOff, Side } from './types';

/** A single roll-off: each side rolls a D6, re-rolling on a tie until someone wins. */
export function rollOff(rng: RNG): RollOff {
  let player = rng.d6();
  let ai = rng.d6();
  while (player === ai) {
    player = rng.d6();
    ai = rng.d6();
  }
  return { player, ai, winner: player > ai ? 'player' : 'ai' };
}

export const otherSide = (s: Side): Side => (s === 'player' ? 'ai' : 'player');
