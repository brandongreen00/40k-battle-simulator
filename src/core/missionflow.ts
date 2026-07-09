// 11e mission lifecycle: battle/turn hooks, Objective Actions, marker mechanics. PURE.
//
// Companion to missions11.ts (which owns the static mission data + scoring): this module owns
// the state transitions — starting/completing actions (Core Rules 16), the per-turn snapshots
// the "started the turn …" conditions read, the auto-resolved card preambles (Punishment's
// condemned picks, Locate and Deny's start-of-battle markers, Consecrate's units), and the
// end-of-battle scoring (+ Battle Ready 10VP).

import type {
  ActiveAction,
  GameState,
  MissionState,
  Side,
  UnitInstance,
  Vec2,
} from './types';
import type { EngineContext } from './engine';
import { baseRadius, pointInPolygon } from './geometry';
import {
  actionsForSide,
  attackerZoneProbe,
  BATTLE_READY_VP,
  MISSION_MATRIX,
  MISSION_NAMES,
  missionAttacker,
  dispositionName,
  objectivePoints,
  objectiveStatuses,
  scoreWindow,
  territoryOf,
  withinObjectiveRange,
  type ActionDef,
  type DispositionId,
} from './missions11';
import { zoneFor } from './deployment';

const other = (s: Side): Side => (s === 'player' ? 'ai' : 'player');
const aliveModels = (u: UnitInstance) => u.models.filter((m) => m.alive);
const onBoard = (u: UnitInstance) => !u.inReserves && aliveModels(u).length > 0;

// ── Battle start ──────────────────────────────────────────────────────────────
/** Initialise the 11e mission state once dispositions + attacker are known. */
export function initMissions(
  state: GameState,
  ctx: EngineContext | undefined,
  dispositions: Record<Side, DispositionId>,
  attacker: Side,
): GameState {
  void ctx;
  const perSide = {
    player: {
      disposition: dispositions.player,
      mission: MISSION_MATRIX[dispositions.player][dispositions.ai],
      primaryVp: 0,
      roundVp: {},
    },
    ai: {
      disposition: dispositions.ai,
      mission: MISSION_MATRIX[dispositions.ai][dispositions.player],
      primaryVp: 0,
      roundVp: {},
    },
  };
  let missions: MissionState & { attacker: Side } = { perSide, markers: [], attacker };
  let log = [
    ...state.log,
    `Missions: ${dispositionName(dispositions.player)} (player → ${MISSION_NAMES[perSide.player.mission]}) vs ` +
      `${dispositionName(dispositions.ai)} (computer → ${MISSION_NAMES[perSide.ai.mission]})`,
  ];

  // Locate and Deny preamble: place 5 operation markers in terrain areas outside your DZ.
  for (const side of ['player', 'ai'] as Side[]) {
    if (perSide[side].mission !== 'locate_and_deny') continue;
    const areas = (state.layout.terrainAreas ?? []).filter((a) => {
      const zone = zoneFor(state.layout, side);
      if (zone.length === 0) return true;
      const cx = a.polygon.reduce((s, p) => s + p.x, 0) / a.polygon.length;
      const cy = a.polygon.reduce((s, p) => s + p.y, 0) / a.polygon.length;
      return !pointInPolygon({ x: cx, y: cy }, zone);
    });
    // Auto-pick: the five areas furthest from our zone (spread toward the enemy half — logged).
    const probe = attackerZoneProbe(state.layout, side === attacker ? side : other(side));
    void probe;
    const zone = zoneFor(state.layout, side);
    const zc =
      zone.length > 0
        ? { x: zone.reduce((s, p) => s + p.x, 0) / zone.length, y: zone.reduce((s, p) => s + p.y, 0) / zone.length }
        : { x: 0, y: 0 };
    const picked = [...areas]
      .sort((a, b) => distToCentroid(b.polygon, zc) - distToCentroid(a.polygon, zc))
      .slice(0, 5);
    missions = {
      ...missions,
      markers: [
        ...missions.markers,
        ...picked.map((a) => ({
          side,
          pos: centroid(a.polygon),
          areaId: a.id,
        })),
      ],
    };
    log = [...log, `${side} (Locate and Deny) places 5 operation markers in forward terrain areas`];
  }

  return { ...state, missions, log };
}

function centroid(poly: Vec2[]): Vec2 {
  return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
}
function distToCentroid(poly: Vec2[], from: Vec2): number {
  const c = centroid(poly);
  return Math.hypot(c.x - from.x, c.y - from.y);
}

// ── Turn start ────────────────────────────────────────────────────────────────
/** Snapshot objective control + unit positions, resolve start-of-turn preambles. */
export function missionsOnTurnStart(state: GameState, ctx?: EngineContext): GameState {
  if (!state.missions || !ctx) return state;
  const side = state.activePlayer;
  const attacker = missionAttacker(state);
  const statuses = objectiveStatuses(state, ctx, attacker);
  const controlAtTurnStart = statuses.map((s) => s.controller);

  // Per-unit "started the turn …" flags (both sides).
  const layout = state.layout;
  const flags: NonNullable<MissionState['unitStartTurnFlags']> = {};
  for (const u of state.units) {
    if (!onBoard(u)) continue;
    let onObjective = false;
    let onCentral = false;
    let areaId: string | undefined;
    for (const m of aliveModels(u)) {
      const r = baseRadius(ctx.datasheets.get(m.datasheetId ?? u.datasheetId)?.baseShape ?? { kind: 'circle', radius: 0.63 });
      for (const s of statuses) {
        if (withinObjectiveRange(m.pos, r, s.point, layout)) {
          onObjective = true;
          if (s.point.kind === 'central') onCentral = true;
        }
      }
      if (!areaId) {
        areaId = (layout.terrainAreas ?? []).find((a) => pointInPolygon(m.pos, a.polygon))?.id;
      }
    }
    flags[u.id] = { onObjective, onCentral, ...(areaId ? { areaId } : {}) };
  }

  let ms: MissionState = {
    ...state.missions,
    unitStartTurnFlags: flags,
    trappedThisTurn: [],
    surveilledThisTurn: [],
    actionsDoneThisTurn: { ...state.missions.actionsDoneThisTurn, [side]: {} },
  };
  let log = state.log;

  // Punishment preamble (active player's card): condemn 1-3 enemy units within range of
  // objectives and/or that destroyed a friendly unit last turn; else any enemy unit.
  if (ms.perSide[side].mission === 'punishment') {
    const enemies = state.units.filter((u) => u.owner === other(side) && onBoard(u));
    const qualifying = enemies.filter((u) => flags[u.id]?.onObjective);
    const pool = qualifying.length > 0 ? qualifying : enemies;
    const picked = pool
      .sort((a, b) => aliveModels(b).length - aliveModels(a).length)
      .slice(0, qualifying.length > 0 ? 3 : 1)
      .map((u) => u.id);
    ms = { ...ms, condemned: picked };
    if (picked.length > 0) {
      const names = picked.map((id) => ctx.datasheets.get(state.units.find((u) => u.id === id)!.datasheetId)?.name ?? id);
      log = [...log, `${side} (Punishment) condemns: ${names.join(', ')}`];
    }
  }

  return { ...state, missions: ms, controlAtTurnStart, log };
}

// ── Objective Actions (16.01 + card reverses) ─────────────────────────────────
export interface StartActionParams {
  unitId: string;
  actionId: string;
  objectiveIdx?: number;
  areaId?: string;
  targetUnitId?: string;
}

/** Can `unit` legally start this action now? Returns a reason when not. */
export function canStartAction(
  state: GameState,
  ctx: EngineContext,
  params: StartActionParams,
): { ok: boolean; reason?: string; def?: ActionDef } {
  const unit = state.units.find((u) => u.id === params.unitId);
  if (!unit || !onBoard(unit)) return { ok: false, reason: 'unit not on the battlefield' };
  const side = unit.owner;
  if (state.activePlayer !== side) return { ok: false, reason: 'not your turn' };
  if (state.phase !== 'Shooting') return { ok: false, reason: 'actions start in your Shooting phase' };
  const def = actionsForSide(state, side).find((a) => a.id === params.actionId);
  if (!def) return { ok: false, reason: 'action not available to your mission' };
  if (def.fromRound && state.round < def.fromRound) return { ok: false, reason: `from battle round ${def.fromRound}` };
  // 16.01 eligibility.
  if (unit.status.battleShocked) return { ok: false, reason: 'battle-shocked units cannot start actions' };
  if (unit.status.advanced || unit.status.fellBack) return { ok: false, reason: 'advanced/fell back this turn' };
  if (unit.status.hasShot) return { ok: false, reason: 'already shot this phase' };
  if ((state.activeActions ?? []).some((a) => a.unitId === unit.id)) {
    return { ok: false, reason: 'already started an action this turn' };
  }
  const ds = ctx.datasheets.get(unit.datasheetId);
  if ((ds?.models[0]?.OC ?? 0) <= 0) return { ok: false, reason: 'OC 0 units cannot start actions' };
  // Engaged units cannot start actions (TITANIC exempt).
  const isTitanic = ds?.keywords.some((k) => k.toLowerCase() === 'titanic');
  if (!isTitanic) {
    for (const e of state.units) {
      if (e.owner === side || !onBoard(e)) continue;
      const eShape = ctx.datasheets.get(e.datasheetId)?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
      const uShape = ds?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
      for (const um of aliveModels(unit)) {
        for (const em of aliveModels(e)) {
          const gap =
            Math.hypot(um.pos.x - em.pos.x, um.pos.y - em.pos.y) - baseRadius(uShape) - baseRadius(eShape);
          if (gap <= 2) return { ok: false, reason: 'engaged units cannot start actions' };
        }
      }
    }
  }
  // Once-per-turn limit.
  if (def.oncePerTurn && (state.activeActions ?? []).some((a) => a.side === side && a.actionId === def.id)) {
    return { ok: false, reason: 'once per turn' };
  }
  // Target requirements.
  if (def.kind === 'objective') {
    if (params.objectiveIdx == null) return { ok: false, reason: 'pick an objective' };
    const points = objectivePoints(state.layout);
    const o = points[params.objectiveIdx];
    if (!o) return { ok: false, reason: 'no such objective' };
    if (def.centralOnly && o.kind !== 'central') return { ok: false, reason: 'central objectives only' };
    if (def.excludeOwnHome) {
      const attacker = missionAttacker(state);
      const homeSide = o.kind === 'home' && o.owner ? (o.owner === 'attacker' ? attacker : other(attacker)) : undefined;
      if (homeSide === side) return { ok: false, reason: 'not your home objective' };
    }
    const inRange = aliveModels(unit).some((m) => {
      const r = baseRadius(ctx.datasheets.get(m.datasheetId ?? unit.datasheetId)?.baseShape ?? { kind: 'circle', radius: 0.63 });
      return withinObjectiveRange(m.pos, r, o, state.layout);
    });
    if (!inRange) return { ok: false, reason: 'unit is not within range of that objective' };
    if (def.distinctTargets) {
      const used = (state.activeActions ?? []).some(
        (a) => a.side === side && a.actionId === def.id && a.objectiveIdx === params.objectiveIdx,
      );
      if (used) return { ok: false, reason: 'another unit already targets that objective this phase' };
    }
    // Decoy: only objectives that are not already decoys; Triangulate: not already triangulated…
    if (def.id === 'decoy' && (state.missions?.decoyed ?? []).includes(params.objectiveIdx)) {
      return { ok: false, reason: 'already a decoy' };
    }
    if (def.id === 'triangulate' && (state.missions?.triangulated ?? []).includes(params.objectiveIdx)) {
      return { ok: false, reason: 'already triangulated' };
    }
    if (def.id === 'extract_intelligence') {
      const mine = (state.missions?.markers ?? []).some(
        (m) => m.side === side && m.objectiveIdx === params.objectiveIdx,
      );
      if (mine) return { ok: false, reason: 'you already have a marker there' };
    }
    if ((def.id === 'sensor_sweep' || def.id === 'sensor_sweep_relic') && (state.missions?.markers.length ?? 0) <= 1) {
      return { ok: false, reason: 'only one operation marker remains' };
    }
  } else if (def.kind === 'area') {
    const area = (state.layout.terrainAreas ?? []).find((a) => a.id === params.areaId);
    if (!area) return { ok: false, reason: 'pick a terrain area' };
    const inArea = aliveModels(unit).some((m) => pointInPolygon(m.pos, area.polygon));
    if (!inArea) return { ok: false, reason: 'unit is not within that terrain area' };
    if (def.id === 'booby_trap' && (state.missions?.trapped ?? []).includes(area.id)) {
      return { ok: false, reason: 'already trapped' };
    }
    if (def.distinctTargets) {
      const used = (state.activeActions ?? []).some(
        (a) => a.side === side && a.actionId === def.id && a.areaId === params.areaId,
      );
      if (used) return { ok: false, reason: 'another unit already targets that terrain area this phase' };
    }
    if (def.areaInEnemyTerritory) {
      const attacker = missionAttacker(state);
      const probe = attackerZoneProbe(state.layout, attacker);
      const myTerritory = side === attacker ? 'attacker' : 'defender';
      const c = centroid(area.polygon);
      if (territoryOf(c, state.layout, probe) === myTerritory) {
        return { ok: false, reason: 'the terrain area must be in enemy territory' };
      }
    }
  } else if (def.kind === 'enemy') {
    const target = state.units.find((u) => u.id === params.targetUnitId);
    if (!target || target.owner === side || !onBoard(target)) return { ok: false, reason: 'pick an enemy unit' };
    if ((state.missions?.surveilledThisTurn ?? []).includes(target.id)) {
      return { ok: false, reason: 'already surveilled this turn' };
    }
    // Within 18" and visible (approximate visibility as centre distance — engine LoS optional).
    const near = aliveModels(unit).some((m) =>
      aliveModels(target).some((t) => Math.hypot(m.pos.x - t.pos.x, m.pos.y - t.pos.y) <= 18),
    );
    if (!near) return { ok: false, reason: 'no visible enemy unit within 18"' };
  }
  return { ok: true, def };
}

/** Start an action: record it and (for immediate actions) resolve the effect now. */
export function startAction(
  state: GameState,
  ctx: EngineContext,
  params: StartActionParams,
): GameState {
  const check = canStartAction(state, ctx, params);
  const unit = state.units.find((u) => u.id === params.unitId);
  if (!check.ok || !check.def || !unit) {
    return { ...state, log: [...state.log, `Action rejected: ${check.reason ?? 'invalid'}`] };
  }
  const def = check.def;
  const side = unit.owner;
  const action: ActiveAction = {
    side,
    unitId: unit.id,
    actionId: def.id,
    ...(params.objectiveIdx != null ? { objectiveIdx: params.objectiveIdx } : {}),
    ...(params.areaId ? { areaId: params.areaId } : {}),
    ...(params.targetUnitId ? { targetUnitId: params.targetUnitId } : {}),
  };
  let next: GameState = {
    ...state,
    activeActions: [...(state.activeActions ?? []), action],
    // Starting an action: not eligible to shoot or charge this turn (16.01).
    units: state.units.map((u) => (u.id === unit.id ? { ...u, status: { ...u.status, hasShot: true, chargeAttempted: true } } : u)),
    log: [...state.log, `${side} starts ${def.name} with ${ctx.datasheets.get(unit.datasheetId)?.name ?? unit.id}`],
  };
  if (def.immediate) next = completeAction(next, ctx, action, def);
  return next;
}

/** Apply a completed action's effect. */
function completeAction(state: GameState, ctx: EngineContext, action: ActiveAction, def: ActionDef): GameState {
  void ctx;
  const ms = state.missions!;
  const side = action.side;
  const done = { ...(ms.actionsDoneThisTurn ?? {}) };
  const mine = { ...(done[side] ?? {}) };
  const bump = (key: string) => (mine[key] = (mine[key] ?? 0) + 1);
  let missions: MissionState = ms;
  let log = state.log;
  const points = objectivePoints(state.layout);
  const objPos = action.objectiveIdx != null ? points[action.objectiveIdx]?.pos : undefined;

  switch (def.id) {
    case 'booby_trap': {
      bump('booby_trap');
      missions = {
        ...ms,
        trapped: [...(ms.trapped ?? []), action.areaId!],
        trappedThisTurn: [...(ms.trappedThisTurn ?? []), action.areaId!],
        markers: [...ms.markers, { side, pos: centroidOfArea(state, action.areaId!), areaId: action.areaId }],
      };
      log = [...log, `Terrain area ${action.areaId} is trapped (Booby Trap)`];
      break;
    }
    case 'decoy': {
      bump('decoy');
      missions = {
        ...ms,
        decoyed: [...(ms.decoyed ?? []), action.objectiveIdx!],
        markers: [...ms.markers, { side, pos: objPos!, objectiveIdx: action.objectiveIdx }],
      };
      log = [...log, `Objective ${action.objectiveIdx! + 1} becomes a decoy`];
      break;
    }
    case 'triangulate': {
      bump('triangulate');
      missions = {
        ...ms,
        triangulated: [...(ms.triangulated ?? []), action.objectiveIdx!],
        markers: [...ms.markers, { side, pos: objPos!, objectiveIdx: action.objectiveIdx }],
      };
      log = [...log, `Objective ${action.objectiveIdx! + 1} is triangulated`];
      break;
    }
    case 'sensor_sweep': {
      // Locate and Deny: remove one of YOUR OWN markers (working down toward "only one remains").
      bump('sensor_sweep');
      const idx = ms.markers.findIndex((m) => m.side === side);
      if (idx >= 0) missions = { ...ms, markers: ms.markers.filter((_, i) => i !== idx) };
      log = [...log, `${side} performs a sensor sweep (marker removed)`];
      break;
    }
    case 'sensor_sweep_relic': {
      // Extract Relic: remove an OPPONENT marker (hunting for the relic).
      bump('sensor_sweep');
      const idx = ms.markers.findIndex((m) => m.side !== side);
      const fallback = idx >= 0 ? idx : ms.markers.findIndex(() => true);
      if (fallback >= 0) missions = { ...ms, markers: ms.markers.filter((_, i) => i !== fallback) };
      log = [...log, `${side} performs a sensor sweep (marker removed)`];
      break;
    }
    case 'surveil': {
      bump('surveil');
      missions = { ...ms, surveilledThisTurn: [...(ms.surveilledThisTurn ?? []), action.targetUnitId!] };
      log = [...log, `${side} surveils an enemy unit`];
      break;
    }
    case 'extract_intelligence': {
      bump('extract_intelligence');
      missions = { ...ms, markers: [...ms.markers, { side, pos: objPos!, objectiveIdx: action.objectiveIdx }] };
      log = [...log, `${side} extracts intelligence at objective ${action.objectiveIdx! + 1}`];
      break;
    }
    case 'secure_asset': {
      bump('secure_asset');
      log = [...log, `${side} secures the asset`];
      break;
    }
    case 'maintain_control': {
      bump('maintain_control');
      missions = { ...ms, markers: [...ms.markers, { side, pos: objPos!, objectiveIdx: action.objectiveIdx }] };
      log = [...log, `${side} maintains control of objective ${action.objectiveIdx! + 1}`];
      break;
    }
    case 'vanguard_operation': {
      bump('vanguard_operation');
      log = [...log, `${side} performs a vanguard operation`];
      break;
    }
    case 'sabotage': {
      bump('sabotage');
      // Cumulative rider: within range of an objective in enemy territory.
      const o = action.objectiveIdx != null ? points[action.objectiveIdx] : undefined;
      if (o) {
        const attacker = missionAttacker(state);
        const probe = attackerZoneProbe(state.layout, attacker);
        const myTerritory = side === attacker ? 'attacker' : 'defender';
        if (territoryOf(o.pos, state.layout, probe) !== myTerritory) bump('sabotage_enemy_territory');
      }
      log = [...log, `${side} commits sabotage at objective ${(action.objectiveIdx ?? 0) + 1}`];
      break;
    }
    // Secondary-card actions (Cleanse / Plunder) complete via the secondaries module's keys.
    case 'cleanse': {
      bump('cleanse');
      log = [...log, `${side} cleanses objective ${(action.objectiveIdx ?? 0) + 1}`];
      break;
    }
    case 'plunder': {
      bump('plunder');
      log = [...log, `${side} plunders terrain area ${action.areaId}`];
      break;
    }
  }
  done[side] = mine;
  return { ...state, missions: { ...missions, actionsDoneThisTurn: done }, log };
}

function centroidOfArea(state: GameState, areaId: string): Vec2 {
  const area = (state.layout.terrainAreas ?? []).find((a) => a.id === areaId);
  return area ? centroid(area.polygon) : { x: 0, y: 0 };
}

// ── Turn end ──────────────────────────────────────────────────────────────────
/**
 * The mission consult at the end of a turn: complete the ending player's pending actions,
 * resolve Consecrate / Surveil preambles, score the primary windows (ending player's turnEnd,
 * both players' eitherTurnEnd), then roll the kill ledger into prevTurnKills.
 */
export function missionsOnTurnEnd(state: GameState, ctx?: EngineContext): GameState {
  if (!state.missions || !ctx) return state;
  const side = state.activePlayer;
  const attacker = missionAttacker(state);
  let next = state;

  // 1. Complete non-immediate actions whose condition holds (unit controls the objective /
  //    area clear of enemies for Vanguard Operation).
  const statuses = objectiveStatuses(next, ctx, attacker);
  for (const action of next.activeActions ?? []) {
    if (action.side !== side) continue;
    const def = [...actionsForSide(next, side), ...SECONDARY_ACTIONS].find((a) => a.id === action.actionId);
    if (!def || def.immediate) continue;
    const unit = next.units.find((u) => u.id === action.unitId);
    if (!unit || !onBoard(unit)) continue;
    let ok = false;
    if (def.kind === 'objective' && action.objectiveIdx != null) {
      ok = statuses[action.objectiveIdx]?.controller === side;
    } else if (def.kind === 'area' && action.areaId) {
      const area = (next.layout.terrainAreas ?? []).find((a) => a.id === action.areaId);
      ok =
        !!area &&
        !next.units.some(
          (u) => u.owner !== side && onBoard(u) && u.models.some((m) => m.alive && pointInPolygon(m.pos, area.polygon)),
        );
    }
    if (ok) next = completeAction(next, ctx, action, def);
    else next = { ...next, log: [...next.log, `${def.name} not completed (condition failed)`] };
  }

  // 2. Consecrate: the Consecrate player's units that destroyed an enemy unit this turn
  //    consecrate an objective they are in range of (excluding their home).
  for (const s of ['player', 'ai'] as Side[]) {
    if (next.missions!.perSide[s].mission !== 'consecrate') continue;
    const consecrated = next.missions!.consecrated ?? [];
    const killers = new Set(
      (next.turnKills ?? []).filter((k) => k.side === other(s)).map(() => true),
    );
    if (killers.size === 0 && (next.missions!.consecrationUnits ?? []).length === 0) continue;
    // Any of the player's units on an unconsecrated non-home objective consecrates it
    // (simplification: killer attribution approximated by "any unit this turn after a kill").
    if ((next.turnKills ?? []).some((k) => k.side === other(s))) {
      const newOnes: { idx: number; side: Side }[] = [];
      for (const st of statuses) {
        if (st.homeOf === s) continue;
        if (consecrated.some((c) => c.idx === st.idx)) continue;
        const unitThere = next.units.some(
          (u) =>
            u.owner === s && onBoard(u) &&
            u.models.some((m) => m.alive && withinObjectiveRange(m.pos, 0.5, st.point, next.layout)),
        );
        if (unitThere) {
          newOnes.push({ idx: st.idx, side: s });
          break; // one consecration per consecration unit; approximate one per turn
        }
      }
      if (newOnes.length > 0) {
        next = {
          ...next,
          missions: {
            ...next.missions!,
            consecrated: [...consecrated, ...newOnes],
            markers: [
              ...next.missions!.markers,
              ...newOnes.map((n) => ({ side: s, pos: statuses[n.idx]!.point.pos, objectiveIdx: n.idx })),
            ],
          },
          log: [...next.log, `${s} consecrates objective ${newOnes[0]!.idx + 1}`],
        };
      }
    }
  }

  // 3. Surveil the Foe preamble: the card owner's units within range of objectives that have
  //    ENEMY operation markers in range remove those markers.
  for (const s of ['player', 'ai'] as Side[]) {
    if (next.missions!.perSide[s].mission !== 'surveil_the_foe') continue;
    const markers = next.missions!.markers;
    const toRemove = new Set<number>();
    markers.forEach((m, i) => {
      if (m.side === s || m.objectiveIdx == null) return;
      const o = statuses[m.objectiveIdx];
      if (!o) return;
      const reached = next.units.some(
        (u) =>
          u.owner === s && onBoard(u) &&
          u.models.some((mm) => mm.alive && withinObjectiveRange(mm.pos, 0.5, o.point, next.layout)),
      );
      if (reached) toRemove.add(i);
    });
    if (toRemove.size > 0) {
      next = {
        ...next,
        missions: { ...next.missions!, markers: markers.filter((_, i) => !toRemove.has(i)) },
        log: [...next.log, `${s} removes ${toRemove.size} enemy operation marker(s) (Surveil the Foe)`],
      };
    }
  }

  // 4. Score: the ending player's turnEnd window, then the opponent's eitherTurnEnd blocks.
  next = scoreWindow(next, ctx, side, 'turnEnd');
  next = scoreWindow(next, ctx, other(side), 'eitherTurnEnd');

  // 5. Roll the kill ledger and clear this turn's actions.
  next = {
    ...next,
    missions: { ...next.missions!, prevTurnKills: next.turnKills ?? [] },
    activeActions: [],
  };
  return next;
}

/** Secondary-card actions (Cleanse / Plunder) so the action engine can host them. */
export const SECONDARY_ACTIONS: ActionDef[] = [
  { id: 'cleanse', name: 'Cleanse', missionId: '(secondary)', kind: 'objective', excludeOwnHome: true, distinctTargets: true },
  { id: 'plunder', name: 'Plunder', missionId: '(secondary)', kind: 'area', oncePerTurn: true, immediate: true, areaInEnemyTerritory: true },
];

/** End of the battle: END OF BATTLE mission blocks + Battle Ready (both armies painted). */
export function missionsOnBattleEnd(state: GameState, ctx?: EngineContext): GameState {
  if (!state.missions || !ctx) return state;
  let next = state;
  for (const s of ['player', 'ai'] as Side[]) next = scoreWindow(next, ctx, s, 'battleEnd');
  next = {
    ...next,
    score: { player: next.score.player + BATTLE_READY_VP, ai: next.score.ai + BATTLE_READY_VP },
    log: [...next.log, `Both armies are Battle Ready: +${BATTLE_READY_VP} VP each`],
  };
  return next;
}

/** Command-phase scoring window (round 2+; in round 5 those blocks fire at end of turn). */
export function missionsOnCommandEnd(state: GameState, ctx?: EngineContext): GameState {
  if (!state.missions || !ctx) return state;
  return scoreWindow(state, ctx, state.activePlayer, 'commandEnd');
}
