// Deployment legality (11e Core Rules). PURE — no React, no DOM.
//
// During deployment, every model of a unit must be set up wholly within its own deployment zone,
// UNLESS the unit has a deployment ability:
//   • Infiltrators (24.20) — set up anywhere on the battlefield more than 8" horizontally from the
//     enemy deployment zone and from all enemy models.
//   • Deep Strike / Strategic Reserves (20) — set up in strategic reserves instead, then arrive
//     via an INGRESS MOVE (20.04): wholly within 6" of a battlefield edge and more than 8" from
//     all enemy units (not in the enemy deployment zone before round 3). Deep Strike (24.09)
//     upgrades the ingress to anywhere on the battlefield more than 8" from enemies.
//
// These predicates are what the deployment UI gates placement on (ghost turns red when illegal),
// and what the AI calls to keep its own deployment legal.

import type { BaseShape, GameState, Layout, Side, Vec2 } from './types';
import { baseRadius, basesOverlap, distancePointToPolygon, distancePointToSegment, gapBetweenBases, pointInPolygon } from './geometry';
import type { OccupiedBase } from './collision';

/** A unit's deployment ability, derived from its datasheet keywords/abilities. */
export type DeployAbility = 'standard' | 'infiltrators' | 'deep_strike';

const INFILTRATE_MIN = 8; // inches from the enemy deployment zone / enemy models (11e: MORE than 8")
const INGRESS_ENEMY_MIN = 8; // ingress moves: more than 8" from all enemy units (20.04)
const INGRESS_EDGE_MAX = 6; // strategic reserves: wholly within 6" of a battlefield edge (20.04)

export function zoneFor(layout: Layout, side: Side): Vec2[] {
  return side === 'player' ? layout.deploymentZones.player : layout.deploymentZones.opponent;
}

/** Is a single point within `side`'s own deployment zone? (Empty zone polygons accept anywhere.) */
export function inOwnZone(pos: Vec2, layout: Layout, side: Side): boolean {
  const zone = zoneFor(layout, side);
  if (zone.length === 0) return true; // unknown/unspecified zone — don't block (sandbox maps)
  return pointInPolygon(pos, zone);
}

/** Does a zone-polygon edge lie on the battlefield perimeter? (Bases may touch the table edge —
 *  "wholly within" clearance only applies to zone edges interior to the board.) */
function edgeOnBoardPerimeter(a: Vec2, b: Vec2, layout: Layout, eps = 1e-6): boolean {
  const onLine = (va: number, vb: number, line: number) => Math.abs(va - line) < eps && Math.abs(vb - line) < eps;
  return (
    onLine(a.x, b.x, 0) || onLine(a.x, b.x, layout.boardWidth) ||
    onLine(a.y, b.y, 0) || onLine(a.y, b.y, layout.boardHeight)
  );
}

/** "Wholly within" a zone: centre inside AND the base's radius clear of every interior zone edge. */
export function whollyInOwnZone(pos: Vec2, shape: BaseShape, layout: Layout, side: Side): boolean {
  const zone = zoneFor(layout, side);
  if (zone.length === 0) return true;
  if (!pointInPolygon(pos, zone)) return false;
  const r = baseRadius(shape);
  if (r <= 1e-9) return true;
  for (let i = 0; i < zone.length; i++) {
    const a = zone[i]!;
    const b = zone[(i + 1) % zone.length]!;
    if (edgeOnBoardPerimeter(a, b, layout)) continue;
    if (distancePointToSegment(pos, a, b) < r - 1e-6) return false;
  }
  return true;
}

export interface DeploymentCheck {
  legal: boolean;
  /** Per-model legality, in the same order as `positions` (for highlighting offenders). */
  perModel: boolean[];
  reason?: string;
}

/**
 * Is a unit's set of model positions a legal deployment for `side`?
 * - standard: every model wholly within the side's own zone.
 * - infiltrators: every model > 9" from the enemy zone (and from enemy models, passed in).
 * - deep_strike at deploy time: handled by placing the unit in Reserves, not on the board, so this
 *   returns illegal for on-board placement (the UI offers a "to Reserves" action instead).
 * In every case a model may not be set up on top of another model's base (`occupied` — pass ALL
 * on-board models, both sides).
 */
export function checkUnitDeployment(
  positions: Vec2[],
  baseShape: BaseShape,
  layout: Layout,
  side: Side,
  ability: DeployAbility,
  enemyModels: { pos: Vec2; shape: BaseShape }[] = [],
  occupied: OccupiedBase[] = [],
): DeploymentCheck {
  const clearOfModels = (p: Vec2) => occupied.every((o) => !basesOverlap(p, baseShape, o.pos, o.shape));
  const stacked = positions.some((p) => !clearOfModels(p));

  if (ability === 'infiltrators') {
    const enemyZone = zoneFor(layout, side === 'player' ? 'ai' : 'player');
    const perModel = positions.map((p) => {
      const farFromZone = enemyZone.length === 0 || distancePointToPolygon(p, enemyZone) > INFILTRATE_MIN;
      const farFromEnemies = enemyModels.every((e) => gapBetweenBases(p, baseShape, e.pos, e.shape) > INFILTRATE_MIN);
      const onBoard = p.x >= 0 && p.y >= 0 && p.x <= layout.boardWidth && p.y <= layout.boardHeight;
      return onBoard && farFromZone && farFromEnemies && clearOfModels(p);
    });
    return {
      legal: perModel.every(Boolean),
      perModel,
      reason: perModel.every(Boolean)
        ? undefined
        : stacked
          ? 'Models cannot be set up on top of other models'
          : 'Infiltrators must be set up more than 8" from the enemy zone and enemy models',
    };
  }

  // Standard deployment: every model's base wholly within the side's own zone.
  const perModel = positions.map((p) => whollyInOwnZone(p, baseShape, layout, side) && clearOfModels(p));
  return {
    legal: perModel.every(Boolean),
    perModel,
    reason: perModel.every(Boolean)
      ? undefined
      : stacked
        ? 'Models cannot be set up on top of other models'
        : 'All models must be wholly within your deployment zone',
  };
}

/**
 * Has a deployment-list entry been placed (or reserved)? Checks live unit ids AND merged Leaders —
 * an attached Leader's unit instance is removed by the merge, but its entry stays "placed" so it
 * cannot be deployed a second time.
 */
export function isEntryPlaced(state: GameState, entryKey: string): boolean {
  return state.units.some(
    (u) => u.id === entryKey || (u.attachedLeaders ?? []).some((l) => l.unitId === entryKey),
  );
}

/**
 * Ingress-move legality (11e, 20.04): a strategic reserves unit arrives wholly within 6" of one or
 * more battlefield edges and more than 8" from all enemy units; before the third battle round it
 * cannot be set up within the enemy deployment zone. A unit whose every model has Deep Strike
 * (24.09) may instead be set up ANYWHERE more than 8" from all enemy units (enemy zone included).
 * Reserves cannot arrive in the first battle round (20.03).
 */
export function deepStrikeArrivalLegal(
  positions: Vec2[],
  baseShape: BaseShape,
  enemyModels: { pos: Vec2; shape: BaseShape }[],
  round: number,
  occupied: OccupiedBase[] = [],
  opts: { deepStrike?: boolean; layout?: Layout; side?: Side } = {},
): DeploymentCheck {
  if (round < 2) {
    return { legal: false, perModel: positions.map(() => false), reason: 'Reserves cannot arrive in the first battle round' };
  }
  const clearOfModels = (p: Vec2) => occupied.every((o) => !basesOverlap(p, baseShape, o.pos, o.shape));
  const stacked = positions.some((p) => !clearOfModels(p));
  const deepStrike = opts.deepStrike ?? true; // legacy callers treated every arrival as Deep Strike
  const layout = opts.layout;
  const r = baseRadius(baseShape);

  const nearEdge = (p: Vec2): boolean => {
    if (!layout) return true;
    const d = Math.min(p.x, p.y, layout.boardWidth - p.x, layout.boardHeight - p.y);
    return d + r <= INGRESS_EDGE_MAX; // the whole base within 6" of an edge
  };
  const inEnemyZone = (p: Vec2): boolean => {
    if (!layout || !opts.side) return false;
    const zone = zoneFor(layout, opts.side === 'player' ? 'ai' : 'player');
    return zone.length > 0 && pointInPolygon(p, zone);
  };

  const perModel = positions.map((p) => {
    const farFromEnemies = enemyModels.every((e) => gapBetweenBases(p, baseShape, e.pos, e.shape) > INGRESS_ENEMY_MIN);
    if (!farFromEnemies || !clearOfModels(p)) return false;
    if (deepStrike) return true;
    if (!nearEdge(p)) return false;
    if (round < 3 && inEnemyZone(p)) return false;
    return true;
  });
  return {
    legal: perModel.every(Boolean),
    perModel,
    reason: perModel.every(Boolean)
      ? undefined
      : stacked
        ? 'Models cannot be set up on top of other models'
        : deepStrike
          ? 'Deep Strike must arrive more than 8" from all enemy units'
          : 'Reserves must arrive wholly within 6" of a battlefield edge, more than 8" from enemies' +
            (round < 3 ? ', outside the enemy deployment zone' : ''),
  };
}

/** Derive a unit's deployment ability from its datasheet keywords + ability names (best-effort). */
export function deployAbilityFromKeywords(keywords: string[], abilityNames: string[] = []): DeployAbility {
  const hay = [...keywords, ...abilityNames].map((k) => k.toLowerCase());
  if (hay.some((k) => k.includes('infiltrat'))) return 'infiltrators';
  if (hay.some((k) => k.includes('deep strike') || k.includes('deep-strike') || k.includes('teleport'))) {
    return 'deep_strike';
  }
  return 'standard';
}
