// 11th edition Chapter Approved missions: Force Dispositions, the 25 Primary Missions,
// Objective Actions and mission scoring. PURE — no React, no DOM, no I/O.
//
// Sources: GW Chapter Approved Mission Deck (June 2026) card text via the research dossier in
// docs/11e_missions.md; scoring caps from the Warhammer Event Companion (Primary max 45VP,
// max 15VP per battle round; Battle Ready +10VP).
//
// Model: each player picks a Force Disposition; the (mine, theirs) ordered pair selects my
// Primary Mission from MISSION_MATRIX. Each mission is a list of ScoreBlocks with a window
// (end of your turn / end of your Command phase (2nd round onwards, or end of your turn in
// round 5) / end of either turn / end of battle) and a scoring function over a MissionEval
// snapshot. Eleven missions add an Objective Action (started in your Shooting phase, completes
// at the end of your turn if the unit still controls the objective).
//
// Documented simplifications (best-effort where the cards leave a *choice* to the player):
//  • Punishment's condemned units, Locate and Deny's five start-of-battle markers and
//    Burden-of-Trust-style picks are auto-selected by a deterministic heuristic (logged).
//  • Surveil the Foe's preamble (remove enemy markers when a unit ends a move in range) is
//    applied at the end-of-turn evaluation rather than per move.

import type {
  GameState,
  KillRecord,
  Layout,
  MissionState,
  ObjectivePoint,
  OperationMarker,
  Side,
  UnitInstance,
  Vec2,
} from './types';
import type { EngineContext } from './engine';
import { modelDatasheet } from './engine';
import { baseRadius, pointInPolygon } from './geometry';
import { ocBonusFromOrders } from './orders';

// ── Force Dispositions ────────────────────────────────────────────────────────
export type DispositionId =
  | 'take_and_hold'
  | 'purge_the_foe'
  | 'disruption'
  | 'reconnaissance'
  | 'priority_assets';

export const DISPOSITIONS: { id: DispositionId; name: string; blurb: string }[] = [
  { id: 'take_and_hold', name: 'Take and Hold', blurb: 'Hold objectives, including your home objective.' },
  { id: 'purge_the_foe', name: 'Purge the Foe', blurb: 'Destroy enemy units while holding ground.' },
  { id: 'disruption', name: 'Disruption', blurb: 'Deny, trap and decoy — win the objective shell game.' },
  { id: 'reconnaissance', name: 'Reconnaissance', blurb: 'Spread out, gather intel, control the quarters.' },
  { id: 'priority_assets', name: 'Priority Assets', blurb: 'Perform objective actions on key assets.' },
];

export const dispositionName = (id: string): string =>
  DISPOSITIONS.find((d) => d.id === id)?.name ?? id;

/** MISSION_MATRIX[mine][theirs] = my Primary Mission id. */
export const MISSION_MATRIX: Record<DispositionId, Record<DispositionId, string>> = {
  take_and_hold: {
    take_and_hold: 'battlefield_dominance',
    purge_the_foe: 'immovable_object',
    disruption: 'determined_acquisition',
    reconnaissance: 'purge_and_secure',
    priority_assets: 'inescapable_dominion',
  },
  purge_the_foe: {
    take_and_hold: 'unstoppable_force',
    purge_the_foe: 'meatgrinder',
    disruption: 'punishment',
    reconnaissance: 'consecrate',
    priority_assets: 'destroyers_wrath',
  },
  disruption: {
    take_and_hold: 'death_trap',
    purge_the_foe: 'delaying_action',
    disruption: 'outmanoeuvre',
    reconnaissance: 'smoke_and_mirrors',
    priority_assets: 'locate_and_deny',
  },
  reconnaissance: {
    take_and_hold: 'reconnaissance_sweep',
    purge_the_foe: 'triangulation',
    disruption: 'surveil_the_foe',
    reconnaissance: 'gather_intel',
    priority_assets: 'search_and_scour',
  },
  priority_assets: {
    take_and_hold: 'secure_asset',
    purge_the_foe: 'vital_link',
    disruption: 'extract_relic',
    reconnaissance: 'vanguard_operation',
    priority_assets: 'sabotage',
  },
};

export const MISSION_NAMES: Record<string, string> = {
  battlefield_dominance: 'Battlefield Dominance', immovable_object: 'Immovable Object',
  determined_acquisition: 'Determined Acquisition', purge_and_secure: 'Purge and Secure',
  inescapable_dominion: 'Inescapable Dominion', unstoppable_force: 'Unstoppable Force',
  meatgrinder: 'Meatgrinder', punishment: 'Punishment', consecrate: 'Consecrate',
  destroyers_wrath: "Destroyer's Wrath", death_trap: 'Death Trap', delaying_action: 'Delaying Action',
  outmanoeuvre: 'Outmanoeuvre', smoke_and_mirrors: 'Smoke and Mirrors', locate_and_deny: 'Locate and Deny',
  reconnaissance_sweep: 'Reconnaissance Sweep', triangulation: 'Triangulation',
  surveil_the_foe: 'Surveil the Foe', gather_intel: 'Gather Intel', search_and_scour: 'Search and Scour',
  secure_asset: 'Secure Asset', vital_link: 'Vital Link', extract_relic: 'Extract Relic',
  vanguard_operation: 'Vanguard Operation', sabotage: 'Sabotage',
};

export const PRIMARY_CAP = 45;
export const PRIMARY_ROUND_CAP = 15;
export const BATTLE_READY_VP = 10;

// ── Objective & territory geometry ────────────────────────────────────────────
export interface ObjectiveStatus {
  idx: number;
  point: ObjectivePoint;
  /** The side whose home objective this is (mapped from attacker/defender), if a home. */
  homeOf?: Side;
  control: { player: number; ai: number };
  controller: Side | null;
}

const other = (s: Side): Side => (s === 'player' ? 'ai' : 'player');

/** Typed objectives for a layout (synthesised for legacy layouts: all 'central', no owner). */
export function objectivePoints(layout: Layout): ObjectivePoint[] {
  if (layout.objectivePoints?.length) return layout.objectivePoints;
  return layout.objectives.map((pos) => ({ pos, kind: 'central' as const }));
}

/** Is a model position "within range" of objective `o` (terrain area membership, or 3" of the
 *  40 mm marker for objectives not on a terrain area — Rules Appendix)? */
export function withinObjectiveRange(
  pos: Vec2,
  radius: number,
  o: ObjectivePoint,
  layout: Layout,
): boolean {
  if (o.areaId && layout.terrainAreas) {
    const area = layout.terrainAreas.find((a) => a.id === o.areaId);
    if (area) {
      // A grouped area counts as ONE terrain area — membership of any member qualifies.
      const members = area.groupId
        ? layout.terrainAreas.filter((x) => x.groupId === area.groupId)
        : [area];
      return members.some((x) => pointInPolygon(pos, x.polygon));
    }
  }
  const controlRadius = layout.objectiveControlRadiusIn ?? 3;
  const markerRadius = (layout.objectiveMarkerDiameterIn ?? 1.575) / 2;
  return Math.hypot(pos.x - o.pos.x, pos.y - o.pos.y) - radius - markerRadius <= controlRadius;
}

/** Which side does each home objective belong to? attacker/defender → Side via missions state. */
export function homeSideOf(o: ObjectivePoint, attackerSide: Side): Side | undefined {
  if (o.kind !== 'home' || !o.owner) return undefined;
  return o.owner === 'attacker' ? attackerSide : other(attackerSide);
}

/** Level of control (14.02) for every objective. Battle-shocked units contribute nothing. */
export function objectiveStatuses(
  state: GameState,
  ctx: EngineContext,
  attackerSide: Side,
): ObjectiveStatus[] {
  const layout = state.layout;
  const points = objectivePoints(layout);
  return points.map((point, idx) => {
    const control = { player: 0, ai: 0 };
    for (const u of state.units) {
      if (u.inReserves || u.status.battleShocked) continue;
      const bonus = ocBonusFromOrders(u);
      for (const m of u.models) {
        if (!m.alive) continue;
        const mds = modelDatasheet(m, u, ctx);
        const oc = (mds?.models[0]?.OC ?? 0) + bonus;
        if (oc <= 0) continue;
        const r = baseRadius(mds?.baseShape ?? { kind: 'circle', radius: 0.63 });
        if (withinObjectiveRange(m.pos, r, point, layout)) control[u.owner] += oc;
      }
    }
    const controller = control.player > control.ai ? 'player' : control.ai > control.player ? 'ai' : null;
    return { idx, point, homeOf: homeSideOf(point, attackerSide), control, controller };
  });
}

/** Side of the territory divider a point falls on; the attacker's territory is the side that
 *  contains the attacker's deployment zone. Returns 'attacker' | 'defender'. */
export function territoryOf(pos: Vec2, layout: Layout, attackerZoneProbe: Vec2): 'attacker' | 'defender' {
  const div = layout.territoryDivider;
  if (!div) {
    // No divider: halves along the battle axis using the attacker probe.
    const vertical = layout.boardHeight >= layout.boardWidth;
    const mid = vertical ? layout.boardHeight / 2 : layout.boardWidth / 2;
    const v = vertical ? pos.y : pos.x;
    const probeV = vertical ? attackerZoneProbe.y : attackerZoneProbe.x;
    return (v >= mid) === (probeV >= mid) ? 'attacker' : 'defender';
  }
  const [a, b] = div;
  const cross = (p: Vec2) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const sidePos = cross(pos) >= 0;
  const sideAtt = cross(attackerZoneProbe) >= 0;
  return sidePos === sideAtt ? 'attacker' : 'defender';
}

/** A probe point inside the attacker's deployment zone (its centroid). */
export function attackerZoneProbe(layout: Layout, attackerSide: Side): Vec2 {
  const zone = attackerSide === 'player' ? layout.deploymentZones.player : layout.deploymentZones.opponent;
  if (zone.length === 0) return { x: layout.boardWidth / 2, y: layout.boardHeight };
  return {
    x: zone.reduce((s, p) => s + p.x, 0) / zone.length,
    y: zone.reduce((s, p) => s + p.y, 0) / zone.length,
  };
}

/** Table quarter of a point: 0..3 (quadrants around the board centre). */
export function tableQuarter(pos: Vec2, layout: Layout): number {
  const cx = layout.boardWidth / 2;
  const cy = layout.boardHeight / 2;
  return (pos.x >= cx ? 1 : 0) + (pos.y >= cy ? 2 : 0);
}

const aliveModels = (u: UnitInstance) => u.models.filter((m) => m.alive);
const onBoard = (u: UnitInstance) => !u.inReserves && aliveModels(u).length > 0;

/** Is every alive model of the unit inside the given predicate region? */
function whollyWithin(u: UnitInstance, test: (p: Vec2) => boolean): boolean {
  const ms = aliveModels(u);
  return ms.length > 0 && ms.every((m) => test(m.pos));
}

// ── Mission evaluation snapshot ───────────────────────────────────────────────
export interface MissionEval {
  state: GameState;
  ctx: EngineContext;
  side: Side; // the scoring player
  ms: MissionState;
  round: number;
  layout: Layout;
  objectives: ObjectiveStatus[];
  /** Objectives I control / opponent controls (counts). */
  myObjectives: number;
  theirObjectives: number;
  /** Objectives I control excluding my home objective. */
  myNonHome: number;
  myCentral: number;
  myExpansion: number;
  controlsOwnHome: boolean;
  controlsEnemyHome: boolean;
  /** Kills of ENEMY units this turn / previous turn (from my perspective). */
  enemyKillsThisTurn: KillRecord[];
  friendlyKillsThisTurn: KillRecord[];
  enemyKillsPrevTurn: KillRecord[];
  friendlyKillsPrevTurn: KillRecord[];
  /** Objective indices I controlled at the start of the turn. */
  controlledAtTurnStart: Set<number>;
  /** Which territory each point is in. */
  territory: (pos: Vec2) => 'attacker' | 'defender';
  myTerritory: 'attacker' | 'defender';
  /** Completed action counts this turn for my side. */
  actionsDone: Record<string, number>;
  myMarkers: OperationMarker[];
  theirMarkers: OperationMarker[];
}

export function buildMissionEval(state: GameState, ctx: EngineContext, side: Side): MissionEval {
  const ms = state.missions!;
  const attackerSide = missionAttacker(state);
  const layout = state.layout;
  const objectives = objectiveStatuses(state, ctx, attackerSide);
  const probe = attackerZoneProbe(layout, attackerSide);
  const territory = (pos: Vec2) => territoryOf(pos, layout, probe);
  const myTerritory: 'attacker' | 'defender' = side === attackerSide ? 'attacker' : 'defender';

  const myObjs = objectives.filter((o) => o.controller === side);
  const kills = state.turnKills ?? [];
  const prevKills = ms.prevTurnKills ?? [];
  const controlledAtStart = new Set<number>();
  (state.controlAtTurnStart ?? []).forEach((c, i) => {
    if (c === side) controlledAtStart.add(i);
  });

  return {
    state, ctx, side, ms, round: state.round, layout, objectives,
    myObjectives: myObjs.length,
    theirObjectives: objectives.filter((o) => o.controller === other(side)).length,
    myNonHome: myObjs.filter((o) => o.homeOf !== side).length,
    myCentral: myObjs.filter((o) => o.point.kind === 'central').length,
    myExpansion: myObjs.filter((o) => o.point.kind === 'expansion').length,
    controlsOwnHome: objectives.some((o) => o.homeOf === side && o.controller === side),
    controlsEnemyHome: objectives.some((o) => o.homeOf === other(side) && o.controller === side),
    enemyKillsThisTurn: kills.filter((k) => k.side === other(side)),
    friendlyKillsThisTurn: kills.filter((k) => k.side === side),
    enemyKillsPrevTurn: prevKills.filter((k) => k.side === other(side)),
    friendlyKillsPrevTurn: prevKills.filter((k) => k.side === side),
    controlledAtTurnStart: controlledAtStart,
    territory, myTerritory,
    actionsDone: ms.actionsDoneThisTurn?.[side] ?? {},
    myMarkers: ms.markers.filter((m) => m.side === side),
    theirMarkers: ms.markers.filter((m) => m.side !== side),
  };
}

/** Which Side is the Attacker (recorded at battle start in the mission state). */
export function missionAttacker(state: GameState): Side {
  return (state.missions as MissionState & { attacker?: Side })?.attacker ?? 'player';
}

// ── Score blocks ──────────────────────────────────────────────────────────────
type Window = 'turnEnd' | 'commandEnd' | 'eitherTurnEnd' | 'battleEnd';

interface ScoreBlock {
  when: Window;
  /** Inclusive battle-round window (default any). */
  rounds?: [number, number];
  /** The "(or the end of your turn in the fifth battle round)" rider on Command blocks. */
  round5AtTurnEnd?: boolean;
  score: (ev: MissionEval) => number;
  label: string;
}

/** Objectives I control this eval, newly (not controlled at the start of the turn), non-home. */
const newNonHome = (ev: MissionEval): number =>
  ev.objectives.filter(
    (o) => o.controller === ev.side && o.homeOf !== ev.side && !ev.controlledAtTurnStart.has(o.idx),
  ).length;

const killedMoreThanLost = (ev: MissionEval): boolean =>
  ev.enemyKillsThisTurn.length > ev.friendlyKillsPrevTurn.length;

const objInEnemyTerritory = (ev: MissionEval, o: ObjectiveStatus): boolean =>
  ev.territory(o.point.pos) !== ev.myTerritory;

export const PRIMARY_MISSIONS: Record<string, ScoreBlock[]> = {
  battlefield_dominance: [
    { when: 'turnEnd', rounds: [1, 2], label: 'more objectives than opponent',
      score: (ev) => (ev.myObjectives > ev.theirObjectives ? 2 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold objectives (+home rider)',
      score: (ev) => ev.myObjectives * 3 + (ev.controlsOwnHome ? ev.myNonHome * 2 : 0) },
  ],
  immovable_object: [
    { when: 'turnEnd', label: 'hold a central objective', score: (ev) => (ev.myCentral >= 1 ? 3 : 0) },
    { when: 'commandEnd', rounds: [2, 4], label: 'hold non-home objectives', score: (ev) => ev.myNonHome * 5 },
    { when: 'turnEnd', rounds: [5, 5], label: 'hold non-home objectives (R5)', score: (ev) => ev.myNonHome * 5 },
  ],
  determined_acquisition: [
    { when: 'turnEnd', label: 'newly taken non-home objectives', score: (ev) => newNonHome(ev) * 2 },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold objectives (+enemy territory)',
      score: (ev) =>
        ev.myObjectives * 3 +
        ev.objectives.filter((o) => o.controller === ev.side && objInEnemyTerritory(ev, o)).length * 3 },
  ],
  purge_and_secure: [
    { when: 'turnEnd', label: 'kills near objectives',
      score: (ev) =>
        ev.enemyKillsThisTurn.some((k) => k.killerOnObjective) ||
        ev.enemyKillsThisTurn.some((k) => k.startedTurnOnObjective)
          ? 3 : 0 },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold non-home objectives',
      score: (ev) => ev.myNonHome * 4 },
    { when: 'turnEnd', rounds: [2, 5], label: 'newly taken non-home objective',
      score: (ev) => (newNonHome(ev) >= 1 ? 3 : 0) },
  ],
  inescapable_dominion: [
    { when: 'turnEnd', label: 'hold three or more objectives', score: (ev) => (ev.myObjectives >= 3 ? 4 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold two+ / more than opponent',
      score: (ev) => (ev.myObjectives >= 2 ? 5 : 0) + (ev.myObjectives > ev.theirObjectives ? 4 : 0) },
    { when: 'battleEnd', label: "hold opponent's home objective", score: (ev) => (ev.controlsEnemyHome ? 5 : 0) },
  ],
  unstoppable_force: [
    { when: 'turnEnd', label: 'destroyed an enemy unit', score: (ev) => (ev.enemyKillsThisTurn.length >= 1 ? 3 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold non-home objectives',
      score: (ev) => ev.myNonHome * 4 },
    { when: 'turnEnd', rounds: [2, 5], label: 'newly taken non-home objective',
      score: (ev) => (newNonHome(ev) >= 1 ? 3 : 0) },
    { when: 'battleEnd', label: 'hold a central objective', score: (ev) => (ev.myCentral >= 1 ? 5 : 0) },
  ],
  meatgrinder: [
    { when: 'turnEnd', label: 'destroyed an enemy unit', score: (ev) => (ev.enemyKillsThisTurn.length >= 1 ? 3 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
    { when: 'turnEnd', rounds: [2, 5], label: 'out-killed the foe / hold enemy home',
      score: (ev) => (killedMoreThanLost(ev) ? 5 : 0) + (ev.controlsEnemyHome ? 5 : 0) },
  ],
  punishment: [
    { when: 'eitherTurnEnd', label: 'condemned unit destroyed',
      score: (ev) =>
        (ev.ms.condemned ?? []).some((id) =>
          (ev.state.turnKills ?? []).some((k) => k.unitId === id && k.side === other(ev.side)),
        ) ? 5 : 0 },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold non-home / more than opponent',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) + (ev.myObjectives > ev.theirObjectives ? 5 : 0) },
    { when: 'battleEnd', label: "hold opponent's home objective", score: (ev) => (ev.controlsEnemyHome ? 8 : 0) },
  ],
  consecrate: [
    { when: 'turnEnd', label: 'objectives consecrated',
      score: (ev) => {
        const mine = (ev.ms.consecrated ?? []).filter((c) => c.side === ev.side).length;
        return mine >= 3 ? 6 : mine >= 1 ? 3 : 0;
      } },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold non-home / more than opponent',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) + (ev.myObjectives > ev.theirObjectives ? 4 : 0) },
    { when: 'battleEnd', label: 'enemy home consecrated',
      score: (ev) =>
        (ev.ms.consecrated ?? []).some(
          (c) => c.side === ev.side && ev.objectives[c.idx]?.homeOf === other(ev.side),
        ) ? 5 : 0 },
  ],
  destroyers_wrath: [
    { when: 'turnEnd', label: 'destroyed an enemy unit', score: (ev) => (ev.enemyKillsThisTurn.length >= 1 ? 3 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold non-home / more than opponent',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) + (ev.myObjectives > ev.theirObjectives ? 6 : 0) },
    { when: 'turnEnd', rounds: [2, 5], label: 'out-killed the foe', score: (ev) => (killedMoreThanLost(ev) ? 4 : 0) },
  ],
  death_trap: [
    { when: 'turnEnd', label: 'terrain areas trapped this turn',
      score: (ev) => {
        const trapped = ev.ms.trappedThisTurn ?? [];
        const objAreas = new Set(ev.objectives.map((o) => o.point.areaId).filter(Boolean));
        return trapped.length * 2 + trapped.filter((id) => objAreas.has(id)).length * 3;
      } },
    { when: 'turnEnd', label: 'kill in a trapped terrain area',
      score: (ev) =>
        ev.enemyKillsThisTurn.some(
          (k) => k.startedTurnInArea && (ev.ms.trapped ?? []).includes(k.startedTurnInArea),
        ) ? 3 : 0 },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
  ],
  delaying_action: [
    { when: 'turnEnd', label: 'per enemy unit destroyed', score: (ev) => ev.enemyKillsThisTurn.length * 2 },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
    { when: 'turnEnd', rounds: [2, 5], label: 'hold central + expansion',
      score: (ev) => (ev.myCentral >= 1 && ev.myExpansion >= 1 ? 3 : 0) },
  ],
  outmanoeuvre: [
    { when: 'turnEnd', label: 'hold the enemy home objective', score: (ev) => (ev.controlsEnemyHome ? 10 : 0) },
    { when: 'turnEnd', rounds: [1, 1], label: 'hold non-home objectives (R1)', score: (ev) => ev.myNonHome * 4 },
    { when: 'commandEnd', rounds: [2, 3], label: 'hold non-home objectives (R2-3)', score: (ev) => ev.myNonHome * 5 },
    { when: 'turnEnd', rounds: [4, 5], label: 'hold non-home objectives (R4+)', score: (ev) => ev.myNonHome * 6 },
  ],
  smoke_and_mirrors: [
    { when: 'turnEnd', label: 'decoyed objectives',
      score: (ev) => {
        const decoyed = (ev.ms.decoyed ?? []).map((i) => ev.objectives[i]).filter(Boolean) as ObjectiveStatus[];
        return decoyed.length * 2 + decoyed.filter((o) => objInEnemyTerritory(ev, o)).length * 2;
      } },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
    { when: 'battleEnd', label: 'four or more decoyed', score: (ev) => ((ev.ms.decoyed ?? []).length >= 4 ? 10 : 0) },
  ],
  locate_and_deny: [
    { when: 'turnEnd', label: 'kill on objectives / last marker held',
      score: (ev) =>
        (ev.enemyKillsThisTurn.some((k) => k.startedTurnOnObjective) ? 4 : 0) +
        (lastMarkerHeld(ev) ? 4 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
    { when: 'battleEnd', label: 'last marker held', score: (ev) => (lastMarkerHeld(ev) ? 5 : 0) },
  ],
  reconnaissance_sweep: [
    { when: 'turnEnd', label: 'units in table quarters',
      score: (ev) => {
        const q = quartersWithPresence(ev);
        return q >= 4 ? 6 : q >= 3 ? 3 : 0;
      } },
    { when: 'turnEnd', label: 'per enemy unit destroyed', score: (ev) => ev.enemyKillsThisTurn.length },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 3 : 0) },
  ],
  triangulation: [
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
    { when: 'turnEnd', rounds: [2, 5], label: 'objectives triangulated',
      score: (ev) => {
        const n = (ev.ms.triangulated ?? []).length;
        return n >= 3 ? 10 : n === 2 ? 6 : n === 1 ? 3 : 0;
      } },
    { when: 'battleEnd', label: 'hold four or more objectives', score: (ev) => (ev.myObjectives >= 4 ? 10 : 0) },
  ],
  surveil_the_foe: [
    { when: 'turnEnd', label: 'enemy units surveilled',
      score: (ev) => {
        const surveilled = ev.ms.surveilledThisTurn ?? [];
        if (surveilled.length === 0) return 0;
        // "…unless each of those units is within range of an objective that has one or more
        // operation markers within range of it."
        const markerObjIdx = new Set(ev.theirMarkers.map((m) => m.objectiveIdx).filter((i) => i != null));
        const allShielded = surveilled.every((uid) => {
          const u = ev.state.units.find((x) => x.id === uid);
          if (!u || !onBoard(u)) return false;
          return ev.objectives.some(
            (o) =>
              markerObjIdx.has(o.idx) &&
              u.models.some((m) => m.alive && withinObjectiveRange(m.pos, 0.5, o.point, ev.layout)),
          );
        });
        return allShielded ? 0 : 4;
      } },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold non-home / more than opponent',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) + (ev.myObjectives > ev.theirObjectives ? 4 : 0) },
    { when: 'turnEnd', rounds: [2, 5], label: 'no enemy operation markers',
      score: (ev) => (ev.theirMarkers.length === 0 ? 5 : 0) },
  ],
  gather_intel: [
    { when: 'turnEnd', rounds: [1, 1], label: 'hold a central objective (R1)', score: (ev) => (ev.myCentral >= 1 ? 6 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
    { when: 'turnEnd', rounds: [2, 5], label: 'per unit that extracted intelligence',
      score: (ev) => (ev.actionsDone['extract_intelligence'] ?? 0) * 7 },
    { when: 'battleEnd', label: 'markers on the field / near enemy home',
      score: (ev) =>
        (ev.myMarkers.length >= 3 ? 5 : 0) +
        (ev.myMarkers.some((m) => {
          const o = ev.objectives.find((x) => x.homeOf === other(ev.side));
          return o && m.objectiveIdx === o.idx;
        }) ? 5 : 0) },
  ],
  search_and_scour: [
    { when: 'turnEnd', label: 'hold central / kill in terrain',
      score: (ev) =>
        (ev.myCentral >= 1 ? 3 : 0) +
        (ev.enemyKillsThisTurn.some((k) => k.startedTurnInArea) ? 2 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold non-home objectives',
      score: (ev) => ev.myNonHome * 4 },
    { when: 'battleEnd', label: 'no enemies wholly in my territory',
      score: (ev) =>
        ev.state.units.some(
          (u) => u.owner === other(ev.side) && onBoard(u) &&
            whollyWithin(u, (p) => ev.territory(p) === ev.myTerritory),
        ) ? 0 : 5 },
  ],
  secure_asset: [
    { when: 'turnEnd', label: 'secured the asset / kills near central',
      score: (ev) =>
        ((ev.actionsDone['secure_asset'] ?? 0) >= 1 ? 4 : 0) +
        (ev.enemyKillsThisTurn.some((k) => k.startedTurnOnCentral) ? 2 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold non-home / three+',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) + (ev.myObjectives >= 3 ? 4 : 0) },
  ],
  vital_link: [
    { when: 'turnEnd', label: 'hold central (+markers)',
      score: (ev) => {
        if (ev.myCentral < 1) return 0;
        const centralIdx = new Set(
          ev.objectives.filter((o) => o.point.kind === 'central' && o.controller === ev.side).map((o) => o.idx),
        );
        const markers = ev.myMarkers.filter((m) => m.objectiveIdx != null && centralIdx.has(m.objectiveIdx)).length;
        return 2 + markers;
      } },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold non-home (+central rider)',
      score: (ev) => {
        if (ev.myNonHome < 1) return 0;
        return 4 + (ev.myCentral >= 1 ? 4 : 0);
      } },
    { when: 'battleEnd', label: "hold opponent's home objective", score: (ev) => (ev.controlsEnemyHome ? 10 : 0) },
  ],
  extract_relic: [
    { when: 'turnEnd', label: 'sensor sweep / kills on objectives / last enemy marker',
      score: (ev) =>
        ((ev.actionsDone['sensor_sweep'] ?? 0) >= 1 ? 4 : 0) +
        (ev.enemyKillsThisTurn.some((k) => k.startedTurnOnObjective) ? 3 : 0) +
        (lastEnemyMarkerHeld(ev) ? 4 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
    { when: 'battleEnd', label: 'last enemy marker held', score: (ev) => (lastEnemyMarkerHeld(ev) ? 5 : 0) },
  ],
  vanguard_operation: [
    { when: 'turnEnd', label: 'vanguard operation / kills',
      score: (ev) =>
        ((ev.actionsDone['vanguard_operation'] ?? 0) >= 1 ? 4 : 0) +
        (ev.enemyKillsThisTurn.length >= 1 ? 2 : 0) },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
    { when: 'battleEnd', label: "hold opponent's home objective", score: (ev) => (ev.controlsEnemyHome ? 10 : 0) },
  ],
  sabotage: [
    { when: 'turnEnd', label: 'units that committed sabotage',
      score: (ev) => {
        const n = ev.actionsDone['sabotage'] ?? 0;
        const inEnemy = ev.actionsDone['sabotage_enemy_territory'] ?? 0;
        return n * 3 + inEnemy * 2;
      } },
    { when: 'commandEnd', rounds: [2, 5], round5AtTurnEnd: true, label: 'hold a non-home objective',
      score: (ev) => (ev.myNonHome >= 1 ? 4 : 0) },
  ],
};

/** Locate and Deny: only one of MY markers remains, a friendly unit shares its terrain area,
 *  and no enemy unit is in that area. */
function lastMarkerHeld(ev: MissionEval): boolean {
  if (ev.myMarkers.length !== 1) return false;
  return markerAreaHeld(ev, ev.myMarkers[0]!, ev.side);
}

/** Extract Relic: only one OPPONENT marker remains, with one of MY units in its area, no enemies. */
function lastEnemyMarkerHeld(ev: MissionEval): boolean {
  if (ev.theirMarkers.length !== 1) return false;
  return markerAreaHeld(ev, ev.theirMarkers[0]!, ev.side);
}

function markerAreaHeld(ev: MissionEval, marker: OperationMarker, side: Side): boolean {
  if (!marker.areaId || !ev.layout.terrainAreas) return false;
  const area = ev.layout.terrainAreas.find((a) => a.id === marker.areaId);
  if (!area) return false;
  const inArea = (u: UnitInstance) =>
    onBoard(u) && u.models.some((m) => m.alive && pointInPolygon(m.pos, area.polygon));
  const mine = ev.state.units.some((u) => u.owner === side && inArea(u));
  const theirs = ev.state.units.some((u) => u.owner === other(side) && inArea(u));
  return mine && !theirs;
}

/** Reconnaissance Sweep / Engage on All Fronts style: quarters with a friendly unit wholly
 *  within, not within 6" of the board centre (excluding battle-shocked units). */
export function quartersWithPresence(ev: MissionEval): number {
  const centre = { x: ev.layout.boardWidth / 2, y: ev.layout.boardHeight / 2 };
  const quarters = new Set<number>();
  for (const u of ev.state.units) {
    if (u.owner !== ev.side || !onBoard(u) || u.status.battleShocked) continue;
    const ms = aliveModels(u);
    const q = tableQuarter(ms[0]!.pos, ev.layout);
    const wholly = ms.every(
      (m) => tableQuarter(m.pos, ev.layout) === q && Math.hypot(m.pos.x - centre.x, m.pos.y - centre.y) > 6,
    );
    if (wholly) quarters.add(q);
  }
  return quarters.size;
}

// ── Objective Actions (card reverses + preamble mechanics) ────────────────────
export interface ActionDef {
  id: string;
  name: string;
  missionId: string; // which primary mission provides it
  /** 'objective' actions need an objective in range; 'area' actions a terrain area; 'enemy' a target. */
  kind: 'objective' | 'area' | 'enemy';
  excludeOwnHome?: boolean;
  centralOnly?: boolean;
  oncePerTurn?: boolean;
  /** Each starting unit must be within range of a DIFFERENT objective/area this phase. */
  distinctTargets?: boolean;
  /** Completes immediately (else: end of turn, if the unit controls the objective / area clear). */
  immediate?: boolean;
  fromRound?: number;
  areaInEnemyTerritory?: boolean;
}

export const MISSION_ACTIONS: ActionDef[] = [
  { id: 'booby_trap', name: 'Booby Trap', missionId: 'death_trap', kind: 'area', excludeOwnHome: true, distinctTargets: true, immediate: true },
  { id: 'decoy', name: 'Decoy', missionId: 'smoke_and_mirrors', kind: 'objective', excludeOwnHome: true, distinctTargets: true },
  { id: 'sensor_sweep', name: 'Sensor Sweep', missionId: 'locate_and_deny', kind: 'objective', centralOnly: true, oncePerTurn: true },
  { id: 'triangulate', name: 'Triangulate', missionId: 'triangulation', kind: 'objective', excludeOwnHome: true, oncePerTurn: true, fromRound: 2 },
  { id: 'surveil', name: 'Surveil the Foe', missionId: 'surveil_the_foe', kind: 'enemy', immediate: true },
  { id: 'extract_intelligence', name: 'Extract Intelligence', missionId: 'gather_intel', kind: 'objective', excludeOwnHome: true, distinctTargets: true, fromRound: 2 },
  { id: 'secure_asset', name: 'Secure Asset', missionId: 'secure_asset', kind: 'objective', excludeOwnHome: true, oncePerTurn: true },
  { id: 'maintain_control', name: 'Maintain Control', missionId: 'vital_link', kind: 'objective', centralOnly: true, oncePerTurn: true },
  { id: 'sensor_sweep_relic', name: 'Sensor Sweep', missionId: 'extract_relic', kind: 'objective', centralOnly: true, oncePerTurn: true },
  { id: 'vanguard_operation', name: 'Vanguard Operation', missionId: 'vanguard_operation', kind: 'area', areaInEnemyTerritory: true, oncePerTurn: true },
  { id: 'sabotage', name: 'Sabotage', missionId: 'sabotage', kind: 'objective', excludeOwnHome: true, distinctTargets: true },
];

/** Actions available to `side` under its primary mission (plus secondary-card actions the
 *  caller merges in). */
export function actionsForSide(state: GameState, side: Side): ActionDef[] {
  const mission = state.missions?.perSide[side]?.mission;
  if (!mission) return [];
  return MISSION_ACTIONS.filter((a) => a.missionId === mission);
}

// ── VP bookkeeping ────────────────────────────────────────────────────────────
/** Add primary VP for `side`, honouring the 15/round and 45 total caps. Returns [state, added]. */
export function addPrimaryVp(state: GameState, side: Side, vp: number, label: string): GameState {
  if (vp <= 0 || !state.missions) return state;
  const ms = state.missions;
  const sideState = ms.perSide[side];
  const roundSoFar = sideState.roundVp[state.round] ?? 0;
  const roomRound = Math.max(0, PRIMARY_ROUND_CAP - roundSoFar);
  const roomTotal = Math.max(0, PRIMARY_CAP - sideState.primaryVp);
  const gain = Math.min(vp, roomRound, roomTotal);
  if (gain <= 0) return state;
  const perSide = {
    ...ms.perSide,
    [side]: {
      ...sideState,
      primaryVp: sideState.primaryVp + gain,
      roundVp: { ...sideState.roundVp, [state.round]: roundSoFar + gain },
    },
  };
  return {
    ...state,
    missions: { ...ms, perSide },
    score: { ...state.score, [side]: state.score[side] + gain },
    log: [...state.log, `${side} scores ${gain} Primary VP — ${label} (${perSide[side].primaryVp}/${PRIMARY_CAP})`],
  };
}

/** Run all of `side`'s blocks whose window fires now. */
export function scoreWindow(
  state: GameState,
  ctx: EngineContext,
  side: Side,
  window: Window,
): GameState {
  if (!state.missions) return state;
  const mission = state.missions.perSide[side]?.mission;
  const blocks = PRIMARY_MISSIONS[mission ?? ''] ?? [];
  let next = state;
  for (const b of blocks) {
    let fires = false;
    if (window === 'battleEnd') fires = b.when === 'battleEnd';
    else if (window === 'commandEnd') {
      fires = b.when === 'commandEnd' && !!inRounds(b, state.round) && !(b.round5AtTurnEnd && state.round >= 5);
    } else if (window === 'turnEnd') {
      fires =
        (b.when === 'turnEnd' && inRounds(b, state.round)) ||
        (b.when === 'eitherTurnEnd' && inRounds(b, state.round)) ||
        (b.when === 'commandEnd' && !!b.round5AtTurnEnd && state.round >= 5 && inRounds(b, state.round));
    } else if (window === 'eitherTurnEnd') {
      fires = b.when === 'eitherTurnEnd' && inRounds(b, state.round);
    }
    if (!fires) continue;
    const ev = buildMissionEval(next, ctx, side);
    const vp = b.score(ev);
    if (vp > 0) next = addPrimaryVp(next, side, vp, `${MISSION_NAMES[mission!] ?? mission}: ${b.label}`);
  }
  return next;
}

const inRounds = (b: ScoreBlock, round: number): boolean =>
  !b.rounds || (round >= b.rounds[0] && round <= b.rounds[1]);
