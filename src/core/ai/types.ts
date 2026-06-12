// Shared types for the AI controller. PURE.
//
// The AI talks to the game EXCLUSIVELY through the same `Intent` reducer the UI uses (architecture
// rule #1) — it can rank options however it likes, but it cannot produce an illegal state: every
// intent is validated by the engine. An `AiAction` is one coherent decision (a move activation, a
// shooting activation, a deployment drop…), possibly several intents long. `skipIf` lets later
// intents in a batch stand down when an earlier one changed the world (e.g. the melee target died
// to the first weapon), so the AI never submits an intent the engine would reject.

import type { Datasheet, GameState, Roster, Side } from '../types';
import type { Intent } from '../state';
import type { EngineContext } from '../engine';
import type { DeployAbility } from '../deployment';
import type { Stratagem } from '../stratagems';
import type { RNG } from '../rng';

export interface AiDeps {
  ctx: EngineContext;
  /** The roster each side is playing (drives deployment entries; entry keys match the UI). */
  rosters: Partial<Record<Side, Roster>>;
  /** Each side's detachment name (Orders/stratagem scoping). */
  detachments: Partial<Record<Side, string>>;
  /** Resolve a datasheet's deployment ability (standard / infiltrators / deep_strike).
   *  Injected because the ability catalog lives in the data layer, not core. */
  deployAbility: (ds: Datasheet) => DeployAbility;
  /** Full stratagem list (Core + detachments) for CP decisions. */
  stratagems: Stratagem[];
  /** Shared RNG — used only for tie-breaks/baseline-random; the reducer rolls the real dice. */
  rng: RNG;
}

export interface AiIntent {
  intent: Intent;
  /** Re-checked against the live state just before dispatch; true = stand down (skip silently). */
  skipIf?: (s: GameState) => boolean;
}

export interface AiAction {
  intents: AiIntent[];
  /** One-line human description for the log/UI ("moves Kasrkin toward objective 2"). */
  note: string;
}

/** Whose decision the game is waiting on right now. 'shared' = a neutral dice/flow action
 *  (roll-off, first-turn roll, begin battle) that either seat may trigger. */
export interface Decision {
  actor: Side | 'shared' | null;
  reason: string;
}
