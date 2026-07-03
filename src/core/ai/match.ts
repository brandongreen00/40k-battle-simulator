// Headless AI-vs-AI match runner. PURE — give it rosters, a layout, two profiles and a seed and
// it plays a complete, reproducible Pariah Nexus game through the SAME reducer the UI uses.
//
// This is the harness the "training" loop runs on: pit profile/team A against B over many seeds,
// read the results, keep what wins. The result carries the full event/dice log plus per-turn VP
// snapshots so a losing game can be replayed line by line.

import type { GameState, Layout, Roster, Side } from '../types';
import { createInitialState, reduce, type Intent } from '../state';
import { makeRNG } from '../rng';
import type { EngineContext } from '../engine';
import { aiAction, sharedAction, whoActs } from './controller';
import { aiReactionToShooting } from './react';
import { resolveProfile, type AiProfile } from './profile';
import type { AiDeps } from './types';
import type { Datasheet } from '../types';
import type { DeployAbility } from '../deployment';
import type { Stratagem } from '../stratagems';

export interface MatchData {
  ctx: EngineContext;
  deployAbility: (ds: Datasheet) => DeployAbility;
  stratagems: Stratagem[];
}

export interface MatchConfig {
  layout: Layout;
  rosters: Record<Side, Roster>;
  profiles: Record<Side, string | AiProfile>;
  /** 11e Force Dispositions per side (defaults to Take and Hold for both). */
  dispositions?: Record<Side, import('../missions11').DispositionId>;
  seed: number;
  /** Hard safety budget; a finished 5-round game uses a few hundred intents. */
  maxIntents?: number;
  /** Called after every applied intent — a test seam for asserting game-state invariants. */
  observe?: (state: GameState) => void;
}

export interface TurnSnapshot {
  round: number;
  turn: Side;
  /** Total VP (primary + secondary). */
  score: { player: number; ai: number };
  /** The secondary (Tactical Mission) share of the total. */
  secondary: { player: number; ai: number };
  cp: { player: number; ai: number };
  unitsAlive: { player: number; ai: number };
}

export interface MatchResult {
  winner: Side | 'draw';
  score: { player: number; ai: number };
  ended: boolean; // reached the natural end of round 5 (false = budget bailout)
  rounds: TurnSnapshot[];
  intentCount: number;
  /** Reducer pushback the AI should never trigger; non-empty means a controller bug. */
  rejectedLog: string[];
  /** Times the runner had to force the phase forward; non-zero means a controller bug. */
  forcedAdvances: number;
  log: string[];
  seed: number;
  profiles: Record<Side, string>;
  rosters: Record<Side, string>;
}

const REJECT_RE = /rejected|not confirmed|ignored:/i;

function aliveUnits(state: GameState, side: Side): number {
  return state.units.filter((u) => u.owner === side && !u.inReserves && u.models.some((m) => m.alive)).length;
}

/** Play one full match. Deterministic for a given config (same seed → same game). */
export function runMatch(cfg: MatchConfig, data: MatchData): MatchResult {
  const rng = makeRNG(cfg.seed);
  const deps: AiDeps = {
    ctx: data.ctx,
    rosters: { player: cfg.rosters.player, ai: cfg.rosters.ai },
    detachments: { player: cfg.rosters.player.detachment, ai: cfg.rosters.ai.detachment },
    deployAbility: data.deployAbility,
    stratagems: data.stratagems,
    rng,
  };
  const profiles: Record<Side, AiProfile> = {
    player: resolveProfile(cfg.profiles.player),
    ai: resolveProfile(cfg.profiles.ai),
  };
  const maxIntents = cfg.maxIntents ?? 5000;

  let state = reduce(createInitialState(cfg.layout), { type: 'NewBattle', dispositions: cfg.dispositions }, rng, data.ctx);
  let intentCount = 1;
  let forcedAdvances = 0;
  const snapshots: TurnSnapshot[] = [];
  let lastTurnKey = '';

  const dispatch = (intent: Intent): void => {
    // Reactive window (rule #3): before a unit shoots, the defender may respond.
    if (intent.type === 'ShootUnit') {
      const target = state.units.find((u) => u.id === intent.targetUnitId);
      if (target) {
        const reactions = aiReactionToShooting(state, target.owner, intent.attackerUnitId, intent.targetUnitId, profiles[target.owner], deps);
        for (const r of reactions) {
          if (r.skipIf?.(state)) continue;
          state = reduce(state, r.intent, rng, data.ctx);
          intentCount++;
        }
      }
    }
    state = reduce(state, intent, rng, data.ctx);
    intentCount++;
    cfg.observe?.(state);
  };

  while (intentCount < maxIntents) {
    if (state.ended) break;
    const decision = whoActs(state, deps);
    if (decision.actor === null) break;

    const action =
      decision.actor === 'shared'
        ? sharedAction(state)
        : aiAction(state, decision.actor, profiles[decision.actor], deps);

    if (!action || action.intents.length === 0) {
      // A correct controller always has something to do at its own decision point. If it ever
      // stalls, force the game forward rather than spinning (and report it).
      forcedAdvances++;
      if (state.stage === 'battle') dispatch({ type: 'AdvancePhase' });
      else break;
      continue;
    }

    for (const item of action.intents) {
      if (intentCount >= maxIntents) break;
      if (item.skipIf?.(state)) continue;
      dispatch(item.intent);
    }

    const turnKey = `${state.round}:${state.activePlayer}`;
    if (state.stage === 'battle' && turnKey !== lastTurnKey) {
      lastTurnKey = turnKey;
      snapshots.push({
        round: state.round,
        turn: state.activePlayer,
        score: { ...state.score },
        secondary: { player: state.secondaries?.player.vp ?? 0, ai: state.secondaries?.ai.vp ?? 0 },
        cp: { ...state.cp },
        unitsAlive: { player: aliveUnits(state, 'player'), ai: aliveUnits(state, 'ai') },
      });
    }
  }

  const winner: Side | 'draw' =
    state.score.player > state.score.ai ? 'player' : state.score.ai > state.score.player ? 'ai' : 'draw';

  return {
    winner,
    score: { ...state.score },
    ended: state.ended,
    rounds: snapshots,
    intentCount,
    rejectedLog: state.log.filter((l) => REJECT_RE.test(l)),
    forcedAdvances,
    log: state.log,
    seed: cfg.seed,
    profiles: { player: profiles.player.name, ai: profiles.ai.name },
    rosters: { player: cfg.rosters.player.name, ai: cfg.rosters.ai.name },
  };
}
