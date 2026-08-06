// Combat Patrol missions (11e): each patrol plays its OWN fixed mission card, scored at the
// end of the controlling player's turn and at the end of the battle. PURE — no React/DOM/I/O.
//
// Source of truth: the owner's Warhammer-app Battle Setup screenshots (2026-08). All four
// cards are captured in full (Inquisitorial Sanction, Expansionary Campaign, Purification incl.
// its Sanctification action, Seize their Strongholds); the patrol↔mission pairing was confirmed
// by the owner's follow-up captures.
//
// Interpretation note (recorded, owner-visible): the cards list stacked scoring lines
// ("You control two or more…: X VP" / "You control one or more…: Y VP"). Following the GW
// Combat Patrol card convention, EVERY satisfied line scores (cumulative) — e.g. controlling
// two objectives under Inquisitorial Sanction scores 5+5=10VP that turn.

import type { EngineContext } from './engine';
import type { CpMissionState, GameState, KillRecord, Side, UnitInstance } from './types';
import { objectivePoints, objectiveStatuses, withinObjectiveRange } from './missions11';
import { baseRadius, gapBetweenBases } from './geometry';

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
  },
  purification: {
    id: 'purification',
    name: 'Purification',
    patrol: 'crowes_sanctifiers',
    captured: 'full',
    text:
      'SANCTIFICATION (action) — Starts: Start of your Shooting phase. Units: One friendly ' +
      "CROWE'S SANCTIFIERS unit within range of an objective that is not sanctified. Use limit: " +
      'Once per turn. Completes: End of your next Command phase or the end of the battle ' +
      '(whichever occurs first). Effect: If that unit is not battle-shocked, that objective is ' +
      'sanctified by your army. END OF THE BATTLE — For each objective you control: 5VP. For ' +
      'each objective that was sanctified by your army: 10VP.',
    note:
      'Simplification: a pending Sanctification fails only if the unit is destroyed, leaves the ' +
      'battlefield or is battle-shocked at completion (attacks made mid-window are not tracked).',
  },
  seize_their_strongholds: {
    id: 'seize_their_strongholds',
    name: 'Seize their Strongholds',
    patrol: 'vengeful_brethren',
    captured: 'full',
    text:
      'SECOND BATTLE ROUND ONWARDS — When: End of your Command phase (or the end of your turn ' +
      'in the fifth battle round). You control more objectives than your opponent: 5VP. You ' +
      'control your home objective: 5VP. You control one or more objectives (excluding your ' +
      'home objective): 5VP.',
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

/** Objective statuses with SECURED objectives applied (14.03, via Inquisitorial Mandate /
 *  Rapid Acquisition): an objective nobody live-controls stays under the securing side's
 *  control. Live enemy control beats (and, via pruneSecured, clears) the secured state. */
export function cpObjectiveStatuses(state: GameState, ctx: EngineContext) {
  const cp = state.cpMissions;
  const statuses = objectiveStatuses(state, ctx, cp?.attacker ?? 'player');
  if (!cp?.securedBy?.some(Boolean)) return statuses;
  return statuses.map((s, i) => {
    const secured = cp.securedBy![i];
    return s.controller == null && secured ? { ...s, controller: secured } : s;
  });
}

/** Clear secured flags on objectives the opponent has taken live control of. */
function pruneSecured(state: GameState, ctx: EngineContext): GameState {
  const cp = state.cpMissions;
  if (!cp?.securedBy?.some(Boolean)) return state;
  const statuses = objectiveStatuses(state, ctx, cp.attacker);
  const securedBy = cp.securedBy.map((s, i) =>
    s && statuses[i]?.controller && statuses[i]!.controller !== s ? null : s,
  );
  if (securedBy.every((s, i) => s === cp.securedBy![i])) return state;
  return { ...state, cpMissions: { ...cp, securedBy } };
}

/** Objectives controlled by `side` right now (area-aware, battle-shock- and secured-aware). */
function controlledObjectives(state: GameState, ctx: EngineContext, side: Side): { total: number; expansion: number } {
  const mine = cpObjectiveStatuses(state, ctx).filter((s) => s.controller === side);
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

// ── Sanctification (Purification's objective action) ──────────────────────────

const ENGAGEMENT = 2; // 11e Engagement Range, inches

function unitEngaged(state: GameState, ctx: EngineContext, unit: UnitInstance): boolean {
  const shape = ctx.datasheets.get(unit.datasheetId)?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
  for (const e of state.units) {
    if (e.owner === unit.owner || e.inReserves) continue;
    const eShape = ctx.datasheets.get(e.datasheetId)?.baseShape ?? shape;
    for (const m of unit.models) {
      if (!m.alive) continue;
      for (const em of e.models) {
        if (em.alive && gapBetweenBases(m.pos, shape, em.pos, eShape) <= ENGAGEMENT) return true;
      }
    }
  }
  return false;
}

/** Start Sanctification (16.01-style eligibility; the reducer's StartSanctification intent). */
export function startSanctification(state: GameState, ctx: EngineContext | undefined, unitId: string, objectiveIdx: number): GameState {
  const reject = (why: string): GameState => ({ ...state, log: [...state.log, `Sanctification rejected: ${why}`] });
  const cp = state.cpMissions;
  if (!cp || !ctx) return reject('no Combat Patrol mission state');
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return reject('unit not found');
  const side = unit.owner;
  if (cp.missionId[side] !== 'purification') return reject('your mission has no Sanctification action');
  if (state.stage !== 'battle' || state.phase !== 'Shooting') return reject('starts in your Shooting phase');
  if (state.activePlayer !== side) return reject('not your turn');
  if (unit.inReserves || !unit.models.some((m) => m.alive)) return reject('unit is not on the battlefield');
  if (unit.status.battleShocked) return reject('battle-shocked units cannot start actions');
  if (unit.status.advanced || unit.status.fellBack) return reject('advanced/fell back this turn');
  if (unit.status.hasShot) return reject('already shot this phase');
  if ((ctx.datasheets.get(unit.datasheetId)?.models[0]?.OC ?? 0) <= 0) return reject('OC 0 units cannot start actions');
  if (unitEngaged(state, ctx, unit)) return reject('engaged units cannot start actions');
  if ((cp.sanctifying ?? []).some((s) => s.unitId === unit.id)) return reject('this unit is already sanctifying');
  const turnCounter = state.turnCounter ?? 0;
  if ((cp.sanctifying ?? []).some((s) => s.side === side && s.startedTurnCounter === turnCounter)) {
    return reject('once per turn');
  }
  const points = objectivePoints(state.layout);
  const o = points[objectiveIdx];
  if (!o) return reject('no such objective');
  if ((cp.sanctified ?? []).some((s) => s.idx === objectiveIdx)) return reject('that objective is already sanctified');
  const inRange = unit.models.some((m) => {
    if (!m.alive) return false;
    const r = baseRadius(ctx.datasheets.get(m.datasheetId ?? unit.datasheetId)?.baseShape ?? { kind: 'circle', radius: 0.63 });
    return withinObjectiveRange(m.pos, r, o, state.layout);
  });
  if (!inRange) return reject('unit is not within range of that objective');
  return {
    ...state,
    cpMissions: {
      ...cp,
      sanctifying: [...(cp.sanctifying ?? []), { side, unitId: unit.id, objectiveIdx, startedTurnCounter: turnCounter }],
    },
    // Starting an action: not eligible to shoot or charge this turn (16.01).
    units: state.units.map((u) => (u.id === unit.id ? { ...u, status: { ...u.status, hasShot: true, chargeAttempted: true } } : u)),
    log: [...state.log, `${side} starts Sanctification of objective ${objectiveIdx + 1} (completes at ${side}'s next Command phase)`],
  };
}

/** Resolve pending Sanctifications for `side` (next-Command-phase or end-of-battle windows). */
function completeSanctifications(state: GameState, side: Side, window: 'command' | 'battle_end'): GameState {
  const cp = state.cpMissions;
  if (!cp?.sanctifying?.length) return state;
  const turnCounter = state.turnCounter ?? 0;
  const due = cp.sanctifying.filter(
    (s) => s.side === side && (window === 'battle_end' || s.startedTurnCounter < turnCounter),
  );
  if (due.length === 0) return state;
  let next = state;
  const sanctified = [...(cp.sanctified ?? [])];
  for (const s of due) {
    const unit = next.units.find((u) => u.id === s.unitId);
    const ok = !!unit && !unit.inReserves && unit.models.some((m) => m.alive) && !unit.status.battleShocked;
    if (ok) {
      sanctified.push({ idx: s.objectiveIdx, side });
      next = { ...next, log: [...next.log, `${side} sanctifies objective ${s.objectiveIdx + 1}`] };
    } else {
      next = { ...next, log: [...next.log, `${side}'s Sanctification of objective ${s.objectiveIdx + 1} fails`] };
    }
  }
  return {
    ...next,
    cpMissions: {
      ...next.cpMissions!,
      sanctified,
      sanctifying: cp.sanctifying.filter((s) => !due.includes(s)),
    },
  };
}

// ── Seize their Strongholds (command-end windows, round-5 turn-end rider) ─────

function scoreSeize(state: GameState, ctx: EngineContext, side: Side): GameState {
  const statuses = cpObjectiveStatuses(state, ctx);
  const mine = statuses.filter((s) => s.controller === side);
  const theirs = statuses.filter((s) => s.controller === other(side));
  let next = state;
  if (mine.length > theirs.length) next = addVp(next, side, 5, 'controls more objectives than the opponent');
  if (mine.some((s) => s.homeOf === side)) next = addVp(next, side, 5, 'controls its home objective');
  if (mine.some((s) => s.homeOf !== side)) next = addVp(next, side, 5, 'controls one or more non-home objectives');
  return next;
}

// ── Command-phase scoring window (end of the active player's Command phase) ───

export function cpMissionsOnCommandEnd(state: GameState, ctx: EngineContext | undefined): GameState {
  const cp = state.cpMissions;
  if (!cp || !ctx || state.stage !== 'battle') return state;
  const side = state.activePlayer;
  // Pending Sanctifications complete at the start of this window, before any scoring.
  let next = completeSanctifications(pruneSecured(state, ctx), side, 'command');
  // SANCTIFYING RITUAL (Strike Squad) / OBJECTIVE SECURED (Intercessors): at the end of your
  // Command phase, an objective the unit is controlling becomes secured (14.03).
  next = cpAutoSecure(next, ctx, side);
  if (cp.missionId[side] === 'seize_their_strongholds' && state.round >= 2 && state.round <= 4) {
    next = scoreSeize(next, ctx, side);
  }
  return next;
}

/** End-of-Command auto-secures from datasheet abilities (Sanctifying Ritual / Objective Secured):
 *  every objective such a unit is controlling becomes secured by its side. */
function cpAutoSecure(state: GameState, ctx: EngineContext, side: Side): GameState {
  const cp = state.cpMissions;
  if (!cp) return state;
  const holders = state.units.filter((u) => {
    if (u.owner !== side || u.inReserves || !u.models.some((m) => m.alive)) return false;
    const names = (ctx.datasheets.get(u.datasheetId)?.abilities ?? []).map((a) => a.name.toLowerCase());
    return names.some((n) => n.startsWith('sanctifying ritual') || n.startsWith('objective secured'));
  });
  if (holders.length === 0) return state;
  const objs = objectivePoints(state.layout);
  const statuses = cpObjectiveStatuses(state, ctx);
  let next = state;
  objs.forEach((o, idx) => {
    if (statuses[idx]?.controller !== side) return;
    if (next.cpMissions?.securedBy?.[idx] === side) return;
    const holderOn = holders.some((u) => {
      const shape = ctx.datasheets.get(u.datasheetId)?.baseShape;
      const radius = shape ? baseRadius(shape) : 0.63;
      return u.models.some((m) => m.alive && withinObjectiveRange(m.pos, radius, o, state.layout));
    });
    if (!holderOn) return;
    const securedBy = [...(next.cpMissions!.securedBy ?? objs.map(() => null))];
    securedBy[idx] = side;
    next = {
      ...next,
      cpMissions: { ...next.cpMissions!, securedBy },
      log: [...next.log, `${side} secures objective ${idx + 1} (Sanctifying Ritual / Objective Secured)`],
    };
  });
  return next;
}

// ── Turn-end scoring (end of the ACTIVE player's turn) ────────────────────────

export function cpMissionsOnTurnEnd(state: GameState, ctx: EngineContext | undefined): GameState {
  const cp = state.cpMissions;
  if (!cp || !ctx || state.stage !== 'battle') return state;
  const side = state.activePlayer;
  const enemy = other(side);
  const mission = CP_MISSIONS[cp.missionId[side]];

  let next = pruneSecured(state, ctx);
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
  } else if (mission?.id === 'seize_their_strongholds' && state.round === 5) {
    // Round-5 rider: the command-end window moves to the end of your turn.
    next = scoreSeize(next, ctx, side);
  }
  // 'purification' scores only at the end of the battle.

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
  let next = pruneSecured(state, ctx);
  // Pending Sanctifications complete at the end of the battle (whichever occurs first).
  for (const side of ['player', 'ai'] as Side[]) next = completeSanctifications(next, side, 'battle_end');
  for (const side of ['player', 'ai'] as Side[]) {
    const mission = CP_MISSIONS[cp.missionId[side]];
    if (mission?.id === 'inquisitorial_sanction') {
      if (!enemyCharactersAlive(next, ctx, other(side))) {
        next = addVp(next, side, 10, 'all enemy CHARACTER models destroyed (end of battle)');
      }
    } else if (mission?.id === 'purification') {
      const { total } = controlledObjectives(next, ctx, side);
      if (total > 0) next = addVp(next, side, total * 5, `controls ${total} objective(s) at the end of the battle`);
      const holy = (next.cpMissions!.sanctified ?? []).filter((s) => s.side === side).length;
      if (holy > 0) next = addVp(next, side, holy * 10, `${holy} objective(s) sanctified by its army`);
    }
  }
  return next;
}

/** AI: the best Sanctification start available to `side` this Shooting phase (null if none).
 *  Prefers a unit already standing in range whose loss of shooting hurts least — the caller
 *  compares the 10VP payoff against that unit's shooting EV. */
export function cpSanctificationCandidate(
  state: GameState,
  side: Side,
  ctx: EngineContext,
  exclude?: Set<string>,
): { unitId: string; objectiveIdx: number } | null {
  const cp = state.cpMissions;
  if (!cp || cp.missionId[side] !== 'purification') return null;
  if (state.stage !== 'battle' || state.phase !== 'Shooting' || state.activePlayer !== side) return null;
  const turnCounter = state.turnCounter ?? 0;
  if ((cp.sanctifying ?? []).some((s) => s.side === side && s.startedTurnCounter === turnCounter)) return null;
  const points = objectivePoints(state.layout);
  for (const u of state.units) {
    if (u.owner !== side || u.inReserves || exclude?.has(u.id)) continue;
    if (!u.models.some((m) => m.alive)) continue;
    if (u.status.battleShocked || u.status.advanced || u.status.fellBack || u.status.hasShot) continue;
    if ((cp.sanctifying ?? []).some((s) => s.unitId === u.id)) continue;
    if ((ctx.datasheets.get(u.datasheetId)?.models[0]?.OC ?? 0) <= 0) continue;
    if (unitEngaged(state, ctx, u)) continue;
    for (let idx = 0; idx < points.length; idx++) {
      if ((cp.sanctified ?? []).some((s) => s.idx === idx)) continue;
      const o = points[idx]!;
      const inRange = u.models.some((m) => {
        if (!m.alive) return false;
        const r = baseRadius(ctx.datasheets.get(m.datasheetId ?? u.datasheetId)?.baseShape ?? { kind: 'circle', radius: 0.63 });
        return withinObjectiveRange(m.pos, r, o, state.layout);
      });
      if (inRange) return { unitId: u.id, objectiveIdx: idx };
    }
  }
  return null;
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
