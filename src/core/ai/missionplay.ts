// AI mission play (11e): the AI plays its PRIMARY mission, not just the kill game. PURE.
//
// Two levers:
//  • missionPositionBonus — an additive move-candidate score for standing where the side's
//    primary mission pays VP (enemy home for Outmanoeuvre/Vital Link, centrals for Immovable
//    Object, quarters for Reconnaissance Sweep, forward terrain areas for the action decks…).
//  • bestMissionAction — the best Objective Action to start this Shooting phase, valued in VP
//    and traded off against the unit's shooting (a unit holding a point with nothing worth
//    shooting should be doing its mission's action instead).
//
// The priority of a 40k game is NOT to table the opponent — it is to maximise your own VP while
// minimising theirs. These hooks are where that priority enters the utility AI.

import type { GameState, Side, Vec2 } from '../types';
import type { EngineContext } from '../engine';
import { pointInPolygon } from '../geometry';
import {
  actionsForSide,
  attackerZoneProbe,
  missionAttacker,
  objectivePoints,
  objectiveStatuses,
  territoryOf,
  withinObjectiveRange,
  type ActionDef,
} from '../missions11';
import { canStartAction, SECONDARY_ACTIONS, type StartActionParams } from '../missionflow';
import { zoneFor } from '../deployment';
import type { AiDeps } from './types';

const other = (s: Side): Side => (s === 'player' ? 'ai' : 'player');

/** Missions whose big payoff is the ENEMY HOME objective (weight = rough VP at stake). */
const ENEMY_HOME_MISSIONS: Record<string, number> = {
  outmanoeuvre: 10, punishment: 8, vital_link: 10, vanguard_operation: 10,
  inescapable_dominion: 5, meatgrinder: 5, consecrate: 5,
};
/** Missions paying extra for CENTRAL objectives. */
const CENTRAL_MISSIONS: Record<string, number> = {
  immovable_object: 3, vital_link: 4, gather_intel: 4, search_and_scour: 3,
  delaying_action: 3, unstoppable_force: 4, secure_asset: 2, extract_relic: 2, locate_and_deny: 2,
};
/** Missions wanting units spread across table quarters, away from the centre. */
const QUARTER_MISSIONS = new Set(['reconnaissance_sweep']);
/** Missions paying for objectives in ENEMY TERRITORY. */
const ENEMY_TERRITORY_MISSIONS: Record<string, number> = { determined_acquisition: 3, smoke_and_mirrors: 2, sabotage: 2 };

/** Additive position score for the side's PRIMARY mission (11e games only). */
export function missionPositionBonus(state: GameState, side: Side, at: Vec2, ctx: EngineContext): number {
  void ctx;
  const ms = state.missions;
  if (!ms) return 0;
  const mission = ms.perSide[side].mission;
  const attacker = missionAttacker(state);
  const layout = state.layout;
  const points = objectivePoints(layout);
  let bonus = 0;

  const probe = attackerZoneProbe(layout, attacker);
  const myTerritory = side === attacker ? 'attacker' : 'defender';

  points.forEach((o) => {
    if (!withinObjectiveRange(at, 0.5, o, layout)) return;
    const homeSide = o.kind === 'home' && o.owner ? (o.owner === 'attacker' ? attacker : other(attacker)) : undefined;
    if (homeSide === other(side)) bonus += ENEMY_HOME_MISSIONS[mission] ?? 2;
    if (o.kind === 'central') bonus += CENTRAL_MISSIONS[mission] ?? 0;
    if ((ENEMY_TERRITORY_MISSIONS[mission] ?? 0) > 0 && territoryOf(o.pos, layout, probe) !== myTerritory) {
      bonus += ENEMY_TERRITORY_MISSIONS[mission]!;
    }
    // Non-home objectives matter to nearly every command-phase block.
    if (homeSide !== side) bonus += 2;
  });

  if (QUARTER_MISSIONS.has(mission)) {
    const centre = { x: layout.boardWidth / 2, y: layout.boardHeight / 2 };
    const d = Math.hypot(at.x - centre.x, at.y - centre.y);
    if (d > 7 && d < 20) bonus += 2.5; // stand in a quarter, clear of the centre
  }

  // Action-deck missions want bodies in forward terrain areas (Booby Trap / Vanguard / Plunder).
  if (mission === 'death_trap' || mission === 'vanguard_operation') {
    const zone = zoneFor(layout, side);
    const inForwardArea = (layout.terrainAreas ?? []).some(
      (a) => pointInPolygon(at, a.polygon) && !(zone.length && pointInPolygon(o(a.polygon), zone)),
    );
    if (inForwardArea) bonus += 2;
  }
  return bonus;
}

const o = (poly: Vec2[]): Vec2 => ({
  x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
  y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
});

/** Approximate VP an action completion is worth for the side's mission right now. */
function actionValue(state: GameState, side: Side, def: ActionDef): number {
  const ms = state.missions!;
  switch (def.id) {
    case 'secure_asset': return 4;
    case 'sabotage': return 4; // 3 + likely enemy-territory rider
    case 'extract_intelligence': return 7;
    case 'triangulate': {
      const n = (ms.triangulated ?? []).length;
      return n === 0 ? 3 : n === 1 ? 3 : 4; // marginal VP of the next marker
    }
    case 'decoy': return 3;
    case 'booby_trap': return 3;
    case 'sensor_sweep': {
      // Locate and Deny: working your own markers down to exactly one is the whole plan.
      const mine = ms.markers.filter((m) => m.side === side).length;
      return mine > 1 ? 4 : 0;
    }
    case 'sensor_sweep_relic': return 4;
    case 'vanguard_operation': return 4;
    case 'maintain_control': return 2;
    case 'surveil': return 4;
    case 'cleanse': return 3;
    case 'plunder': return 5;
    default: return 2;
  }
}

export interface MissionActionPick {
  params: StartActionParams;
  vp: number;
  note: string;
}

/**
 * The best legal Objective Action for `side` this Shooting phase (or null). Prefers units that
 * already control the target objective; `excludeUnitIds` lets the caller keep its best shooters.
 */
export function bestMissionAction(
  state: GameState,
  side: Side,
  deps: AiDeps,
  excludeUnitIds: Set<string> = new Set(),
): MissionActionPick | null {
  const ms = state.missions;
  if (!ms || state.phase !== 'Shooting' || state.activePlayer !== side) return null;
  const { ctx } = deps;
  const defs = [
    ...actionsForSide(state, side),
    ...SECONDARY_ACTIONS.filter((a) => state.secondaries?.[side]?.hand.some((c) => c.id === a.id)),
  ];
  if (defs.length === 0) return null;

  const mine = state.units.filter(
    (u) => u.owner === side && !u.inReserves && u.models.some((m) => m.alive) && !excludeUnitIds.has(u.id),
  );
  const points = objectivePoints(state.layout);
  const statuses = objectiveStatuses(state, ctx, missionAttacker(state));

  let best: MissionActionPick | null = null;
  const consider = (params: StartActionParams, def: ActionDef, extra = 0) => {
    const check = canStartAction(state, ctx, params);
    if (!check.ok) return;
    const vp = actionValue(state, side, def) + extra;
    if (vp <= 0) return;
    if (!best || vp > best.vp) {
      const unitName = ctx.datasheets.get(state.units.find((u) => u.id === params.unitId)?.datasheetId ?? '')?.name ?? params.unitId;
      best = { params, vp, note: `${side} starts ${def.name} with ${unitName} (~${vp} VP)` };
    }
  };

  for (const def of defs) {
    for (const u of mine) {
      if (def.kind === 'objective') {
        for (let i = 0; i < points.length; i++) {
          // Completion needs CONTROL of the objective at end of turn — only bother where we
          // control it now (immediate actions are exempt).
          if (!def.immediate && statuses[i]?.controller !== side) continue;
          consider({ unitId: u.id, actionId: def.id, objectiveIdx: i }, def);
        }
      } else if (def.kind === 'area') {
        for (const a of state.layout.terrainAreas ?? []) {
          consider({ unitId: u.id, actionId: def.id, areaId: a.id }, def);
        }
      } else if (def.kind === 'enemy') {
        for (const e of state.units) {
          if (e.owner === side || e.inReserves || !e.models.some((m) => m.alive)) continue;
          consider({ unitId: u.id, actionId: def.id, targetUnitId: e.id }, def);
        }
      }
    }
  }
  return best;
}
