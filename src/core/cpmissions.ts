// Combat Patrol missions (11e): each patrol plays its OWN fixed mission card, scored at the
// end of the controlling player's turn and at the end of the battle. PURE — no React/DOM/I/O.
//
// Source of truth: the owner's Warhammer-app Battle Setup screenshots (2026-08). Two cards were
// captured in full (Inquisitorial Sanction, Expansionary Campaign); Purification only partially
// (its END OF BATTLE block; the Sanctification mechanic is uncaptured); Seize their Strongholds
// only by name. Nothing is invented: uncaptured blocks simply do not score, and the UI says so.
//
// Interpretation note (recorded, owner-visible): the cards list stacked scoring lines
// ("You control two or more…: X VP" / "You control one or more…: Y VP"). Following the GW
// Combat Patrol card convention, EVERY satisfied line scores (cumulative) — e.g. controlling
// two objectives under Inquisitorial Sanction scores 5+5=10VP that turn.

import type { EngineContext } from './engine';
import type { CpMissionState, GameState, KillRecord, Side } from './types';
import { objectiveStatuses } from './missions11';

const other = (s: Side): Side => (s === 'player' ? 'ai' : 'player');

export type CpCaptured = 'full' | 'partial' | 'none';

export interface CpMissionDef {
  id: string;
  name: string;
  /** The patrol (tools/combatpatrol extracted id) whose card this is. */
  patrol: string;
  captured: CpCaptured;
  /** Verbatim captured card text (scoring blocks), or a note on what is missing. */
  text: string;
  note?: string;
}

export const CP_MISSIONS: Record<string, CpMissionDef> = {
  inquisitorial_sanction: {
    id: 'inquisitorial_sanction',
    name: 'Inquisitorial Sanction',
    patrol: 'inquisitors_hand',
    captured: 'full',
    text:
      'ANY BATTLE ROUND — When: End of your turn. For each enemy CHARACTER model destroyed in ' +
      'this or the previous turn: 10VP. SECOND BATTLE ROUND ONWARDS — When: End of your turn. ' +
      'You control two or more objectives: 5VP. You control one or more objectives: 5VP. ' +
      'END OF THE BATTLE — All enemy CHARACTER models are destroyed: 10VP.',
  },
  expansionary_campaign: {
    id: 'expansionary_campaign',
    name: 'Expansionary Campaign',
    patrol: 'sudden_dawn_cadre',
    captured: 'full',
    text:
      'FIRST TO SECOND BATTLE ROUND — When: End of your turn. You control two or more expansion ' +
      'objectives: 15VP. You control one or more expansion objectives: 10VP. THIRD BATTLE ROUND ' +
      'ONWARDS — When: End of your turn. You control one or more expansion objectives: 5VP. ' +
      'You control two or more expansion objectives: 10VP.',
    note: 'Captured as the OPPONENT\'S MISSION on the Sudden Dawn Cadre battle-setup screen — patrol pairing inferred, confirm.',
  },
  purification: {
    id: 'purification',
    name: 'Purification',
    patrol: 'crowes_sanctifiers',
    captured: 'partial',
    text:
      'END OF THE BATTLE — 5VP per objective you control. 10VP per objective sanctified by your army.',
    note:
      'Only the END OF BATTLE block was captured (partially shown on a battle-setup screen); the ' +
      'Sanctification mechanic/twist and any per-turn blocks are uncaptured and do not score. ' +
      'Patrol pairing inferred from the sanctification theme — confirm, and screenshot the full card.',
  },
  seize_their_strongholds: {
    id: 'seize_their_strongholds',
    name: 'Seize their Strongholds',
    patrol: 'vengeful_brethren',
    captured: 'none',
    text: 'Card seen only as a collapsed accordion on a battle-setup screenshot — contents not captured.',
    note: 'Scores nothing until the card is captured. Patrol pairing inferred — confirm, and screenshot the card.',
  },
};

/** The mission a patrol plays (undefined for non-patrol armies). */
export function missionForPatrol(patrol: string | undefined): CpMissionDef | undefined {
  if (!patrol) return undefined;
  return Object.values(CP_MISSIONS).find((m) => m.patrol === patrol);
}

/** Each side's patrol, read off the datasheets of the units it fielded. */
function patrolOf(state: GameState, ctx: EngineContext, side: Side): string | undefined {
  for (const u of state.units) {
    if (u.owner !== side) continue;
    const patrol = ctx.datasheets.get(u.datasheetId)?.patrol;
    if (patrol) return patrol;
  }
  return undefined;
}

/** Initialise the Combat Patrol mission state at BeginBattle (battleType 'combat_patrol'). */
export function initCpMissions(state: GameState, ctx: EngineContext, attacker: Side): GameState {
  const missionId = (side: Side) => missionForPatrol(patrolOf(state, ctx, side))?.id ?? 'unknown';
  const cpMissions: CpMissionState = {
    attacker,
    missionId: { player: missionId('player'), ai: missionId('ai') },
    vp: { player: 0, ai: 0 },
    events: [],
  };
  const label = (side: Side) => CP_MISSIONS[cpMissions.missionId[side]]?.name ?? '(unknown mission)';
  return {
    ...state,
    cpMissions,
    log: [...state.log, `Combat Patrol missions — player: ${label('player')}; ai: ${label('ai')}`],
  };
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

/** Objectives controlled by `side` right now (area-aware, battle-shock-aware). */
function controlledObjectives(state: GameState, ctx: EngineContext, side: Side): { total: number; expansion: number } {
  const statuses = objectiveStatuses(state, ctx, state.cpMissions?.attacker ?? 'player');
  const mine = statuses.filter((s) => s.controller === side);
  return { total: mine.length, expansion: mine.filter((s) => s.point.kind === 'expansion').length };
}

/** Enemy CHARACTER models destroyed in the given kill records. */
function charactersSlainFrom(records: KillRecord[] | undefined, enemy: Side): number {
  return (records ?? []).filter((r) => r.side === enemy).reduce((sum, r) => sum + (r.charactersSlain ?? 0), 0);
}

/** Does `enemy` still have any CHARACTER model alive (anywhere, incl. reserves/embarked)? */
function enemyCharactersAlive(state: GameState, ctx: EngineContext, enemy: Side): boolean {
  for (const u of state.units) {
    if (u.owner !== enemy) continue;
    for (const m of u.models) {
      if (!m.alive) continue;
      const ds = ctx.datasheets.get(m.datasheetId ?? u.datasheetId);
      if (ds?.keywords.some((k) => k.toUpperCase() === 'CHARACTER')) return true;
    }
  }
  return false;
}

function addVp(state: GameState, side: Side, vp: number, label: string): GameState {
  if (vp <= 0 || !state.cpMissions) return state;
  return {
    ...state,
    score: { ...state.score, [side]: state.score[side] + vp },
    cpMissions: {
      ...state.cpMissions,
      vp: { ...state.cpMissions.vp, [side]: state.cpMissions.vp[side] + vp },
      events: [...state.cpMissions.events, { round: state.round, turn: state.activePlayer, label, vp, side }],
    },
    log: [...state.log, `${side} scores ${vp}VP — ${label} (mission total ${state.cpMissions.vp[side] + vp})`],
  };
}

// ── Turn-end scoring (end of the ACTIVE player's turn) ────────────────────────

export function cpMissionsOnTurnEnd(state: GameState, ctx: EngineContext | undefined): GameState {
  const cp = state.cpMissions;
  if (!cp || !ctx || state.stage !== 'battle') return state;
  const side = state.activePlayer;
  const enemy = other(side);
  const mission = CP_MISSIONS[cp.missionId[side]];

  let next = state;
  if (mission?.id === 'inquisitorial_sanction') {
    // ANY battle round: 10VP for each enemy CHARACTER model destroyed this or the previous turn.
    const slain =
      charactersSlainFrom(state.turnKills, enemy) + charactersSlainFrom(cp.prevTurnKills, enemy);
    if (slain > 0) next = addVp(next, side, slain * 10, `${slain} enemy CHARACTER model(s) destroyed`);
    // Round 2+: control 1+ objectives: 5VP; control 2+ objectives: 5VP (each line scores).
    if (state.round >= 2) {
      const { total } = controlledObjectives(next, ctx, side);
      if (total >= 1) next = addVp(next, side, 5, 'controls one or more objectives');
      if (total >= 2) next = addVp(next, side, 5, 'controls two or more objectives');
    }
  } else if (mission?.id === 'expansionary_campaign') {
    const { expansion } = controlledObjectives(next, ctx, side);
    if (state.round <= 2) {
      if (expansion >= 1) next = addVp(next, side, 10, 'controls one or more expansion objectives');
      if (expansion >= 2) next = addVp(next, side, 15, 'controls two or more expansion objectives');
    } else {
      if (expansion >= 1) next = addVp(next, side, 5, 'controls one or more expansion objectives');
      if (expansion >= 2) next = addVp(next, side, 10, 'controls two or more expansion objectives');
    }
  }
  // 'purification' has no captured per-turn block; 'seize_their_strongholds' is uncaptured.

  // Rotate the kill window: the ledger of the turn that just ended becomes "the previous turn".
  return {
    ...next,
    cpMissions: { ...next.cpMissions!, prevTurnKills: state.turnKills ?? [] },
  };
}

// ── End-of-battle scoring (both sides) ────────────────────────────────────────

export function cpMissionsOnBattleEnd(state: GameState, ctx: EngineContext | undefined): GameState {
  const cp = state.cpMissions;
  if (!cp || !ctx) return state;
  let next = state;
  for (const side of ['player', 'ai'] as Side[]) {
    const mission = CP_MISSIONS[cp.missionId[side]];
    if (mission?.id === 'inquisitorial_sanction') {
      if (!enemyCharactersAlive(next, ctx, other(side))) {
        next = addVp(next, side, 10, 'all enemy CHARACTER models destroyed (end of battle)');
      }
    } else if (mission?.id === 'purification') {
      const { total } = controlledObjectives(next, ctx, side);
      if (total > 0) next = addVp(next, side, total * 5, `controls ${total} objective(s) at the end of the battle`);
      // "10VP per objective sanctified by your army" — the Sanctification mechanic is uncaptured.
    }
  }
  return next;
}

// ── AI hooks (mirror the secondaryKillBonus / secondaryPositionBonus seams) ───

/** EV multiplier for killing `target`: Inquisitorial Sanction pays 10VP per CHARACTER model. */
export function cpKillBonus(state: GameState, side: Side, target: { datasheetId: string; models: { alive: boolean; datasheetId?: string }[] }, ctx: EngineContext): number {
  const cp = state.cpMissions;
  if (!cp || cp.missionId[side] !== 'inquisitorial_sanction') return 1;
  const hasCharacter = target.models.some(
    (m) =>
      m.alive &&
      ctx.datasheets.get(m.datasheetId ?? target.datasheetId)?.keywords.some((k) => k.toUpperCase() === 'CHARACTER'),
  );
  return hasCharacter ? 1.5 : 1;
}

/** Additive move-candidate score: Expansionary Campaign wants the expansion objectives early. */
export function cpPositionBonus(state: GameState, side: Side, at: { x: number; y: number }): number {
  const cp = state.cpMissions;
  if (!cp || cp.missionId[side] !== 'expansionary_campaign') return 0;
  const expansions = (state.layout.objectivePoints ?? []).filter((o) => o.kind === 'expansion');
  if (expansions.length === 0) return 0;
  const d = Math.min(...expansions.map((o) => Math.hypot(o.pos.x - at.x, o.pos.y - at.y)));
  // Worth up to ~2 points of move score when standing on one; stronger while the card pays 10/15.
  const weight = state.round <= 2 ? 2 : 1;
  return weight * Math.max(0, 1 - d / 12);
}
