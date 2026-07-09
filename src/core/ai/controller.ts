// The AI controller: "whose decision is the game waiting on?" and "what does that side do?".
// PURE — both the UI driver and the headless match runner call exactly these two functions, so a
// browser game and a simulated game are the same game.
//
// Stateless by design: every decision is recomputed from GameState, so the controller can be
// stepped, interleaved with a human, or replayed. Progress is guaranteed by the engine's own
// once-per-turn flags (moved / hasShot / chargeAttempted / hasFought / commandRun) — every action
// either sets one of them or advances the phase.

import type { GameState, Side } from '../types';
import { otherSide } from '../setup';
import { scoutTurn } from '../phases';
import { unitHasWarrant } from '../abilities';
import type { AiAction, AiDeps, Decision } from './types';
import { resolveProfile, type AiProfile } from './profile';
import { aiDeployAction, deployTurn, pendingLeaderAttaches } from './deploy';
import { aiCommandAction } from './command';
import { aiMovementAction, aiScoutAction } from './move';
import { aiShootingAction } from './shoot';
import { aiChargeAction } from './melee';
import { aiFightAction, nextFighter } from './melee';

export { aiReactionToFight, aiReactionToPhaseEnd, aiReactionToShooting } from './react';
export { pickRoster } from './deploy';
export type { AiAction, AiDeps, AiIntent, Decision } from './types';
export { AI_PROFILES, resolveProfile, type AiProfile } from './profile';

/** The side (Defender first) with a Warrant of Trade decision or redeploys outstanding, if any. */
export function warrantPending(state: GameState, deps: AiDeps): Side | null {
  if (state.stage !== 'setup' || state.setup?.step !== 'deploy') return null;
  const order: Side[] = state.setup?.defender ? [state.setup.defender, otherSide(state.setup.defender)] : ['player', 'ai'];
  for (const s of order) {
    const w = state.setup?.warrant?.[s];
    if (w && w.remaining > 0) return s; // mid-redeploy
    if (!w && state.units.some((u) => u.owner === s && unitHasWarrant(u, deps.ctx))) return s; // undecided
  }
  return null;
}

/** Whose decision the game is waiting on right now. */
export function whoActs(state: GameState, deps: AiDeps): Decision {
  if (state.stage === 'setup') {
    const step = state.setup?.step ?? 'roll_roles';
    if (step === 'roll_roles') return { actor: 'shared', reason: 'roll off for Attacker/Defender' };
    if (step === 'deploy') {
      const side = deployTurn(state, deps);
      if (side) return { actor: side, reason: `${side} places a unit` };
      // Everything placed — give either side a chance to finish Leader attaches, then resolve
      // Warrant of Trade redeploys, then roll on.
      for (const s of ['player', 'ai'] as const) {
        if (pendingLeaderAttaches(state, s, deps.ctx).length > 0) {
          return { actor: s, reason: `${s} attaches Leaders` };
        }
      }
      const warrant = warrantPending(state, deps);
      if (warrant) return { actor: warrant, reason: `${warrant} resolves Warrant of Trade` };
      return { actor: 'shared', reason: 'roll off for the first turn' };
    }
    if (step === 'scouts') {
      const side = scoutTurn(state, deps.ctx);
      if (side) return { actor: side, reason: `${side} makes Scout moves` };
      return { actor: 'shared', reason: 'begin the battle' };
    }
    return { actor: 'shared', reason: 'begin the battle' };
  }
  if (state.stage === 'battle' && !state.ended) {
    if (state.phase === 'Fight') {
      // The Fight phase alternates between BOTH players' units.
      const f = nextFighter(state, deps);
      if (f) return { actor: f.owner, reason: 'fight activation' };
    }
    return { actor: state.activePlayer, reason: `${state.phase} phase` };
  }
  return { actor: null, reason: 'battle over' };
}

/** The neutral flow actions (dice roll-offs, begin battle). Auto-run only when both seats are AI;
 *  with a human at the table these stay theirs to click. */
export function sharedAction(state: GameState): AiAction | null {
  if (state.stage !== 'setup') return null;
  const step = state.setup?.step ?? 'roll_roles';
  if (step === 'roll_roles') return { intents: [{ intent: { type: 'RollRoles' } }], note: 'roll off: Attacker & Defender' };
  if (step === 'deploy') {
    if (state.units.length === 0) return null; // nothing deployed — wait for rosters
    return { intents: [{ intent: { type: 'RollFirstTurn' } }], note: 'roll off: first turn' };
  }
  if (step === 'scouts' || step === 'ready') {
    return { intents: [{ intent: { type: 'BeginBattle' } }], note: 'begin the battle' };
  }
  return null;
}

/**
 * The next action for `side`, or null when it is not actually this side's decision (wrong turn,
 * battle over, nothing to do). The caller dispatches the returned intents in order, honouring
 * each `skipIf`.
 */
export function aiAction(state: GameState, side: Side, profileIn: string | AiProfile, deps: AiDeps): AiAction | null {
  const profile = resolveProfile(profileIn);

  if (state.stage === 'setup') {
    const step = state.setup?.step;
    if (step === 'scouts') {
      return aiScoutAction(state, side, profile, deps);
    }
    if (step !== 'deploy') return null; // roll-offs are shared actions
    const turn = deployTurn(state, deps);
    if (turn === side) return aiDeployAction(state, side, profile, deps);
    if (turn === null) {
      const attaches = pendingLeaderAttaches(state, side, deps.ctx);
      if (attaches.length) return { intents: attaches, note: `${side} attaches Leaders` };
      // Warrant of Trade: the heuristic AI keeps its deployment (declining is always legal; a
      // redeploy policy is a future profile knob).
      if (warrantPending(state, deps) === side) {
        return { intents: [{ intent: { type: 'DeclineWarrant', side } }], note: `${side} declines the Warrant of Trade redeploy` };
      }
    }
    return null;
  }

  if (state.stage !== 'battle' || state.ended) return null;

  if (state.phase === 'Fight') {
    const fight = aiFightAction(state, side, profile, deps);
    if (fight) return fight;
    // No fight of ours pending. The active player closes the phase once every activation is done.
    if (state.activePlayer === side && !nextFighter(state, deps)) {
      return { intents: [{ intent: { type: 'AdvancePhase' } }], note: `${side} ends the Fight phase` };
    }
    return null;
  }

  if (state.activePlayer !== side) return null; // not our turn (reactions are handled separately)

  switch (state.phase) {
    case 'Command':
      return aiCommandAction(state, side, profile, deps);
    case 'Movement':
      return aiMovementAction(state, side, profile, deps);
    case 'Shooting':
      return aiShootingAction(state, side, profile, deps);
    case 'Charge':
      return aiChargeAction(state, side, profile, deps);
    default:
      return { intents: [{ intent: { type: 'AdvancePhase' } }], note: `${side} advances past ${state.phase}` };
  }
}

/** Convenience for drivers: is `decision` something an AI seated at `aiSides` may take? */
export function aiMayAct(decision: Decision, aiSides: { player: boolean; ai: boolean }): Side | 'shared' | null {
  if (decision.actor === null) return null;
  if (decision.actor === 'shared') return aiSides.player && aiSides.ai ? 'shared' : null;
  return aiSides[decision.actor] ? decision.actor : null;
}

export { otherSide };
