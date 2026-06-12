// Deployment legality (10e Core Rules + Pariah Nexus). PURE — no React, no DOM.
//
// During deployment, every model of a unit must be set up wholly within its own deployment zone,
// UNLESS the unit has a deployment ability:
//   • Infiltrators — set up anywhere on the battlefield that is more than 9" horizontally from the
//     enemy deployment zone and from all enemy models (we approximate "enemy models" with the enemy
//     zone since enemies are not yet placed when Infiltrators deploy).
//   • Deep Strike / Strategic Reserves — set up in Reserves instead of on the battlefield, then
//     arrive later (see `deepStrikeArrivalLegal`).
//
// These predicates are what the deployment UI gates placement on (ghost turns red when illegal),
// and what the AI calls to keep its own deployment legal.

import type { BaseShape, GameState, Layout, Side, Vec2 } from './types';
import { baseRadius, basesOverlap, distancePointToPolygon, distancePointToSegment, gapBetweenBases, pointInPolygon } from './geometry';
import type { OccupiedBase } from './collision';

/** A unit's deployment ability, derived from its datasheet keywords/abilities. */
export type DeployAbility = 'standard' | 'infiltrators' | 'deep_strike';

const INFILTRATE_MIN = 9; // inches from the enemy deployment zone / enemy models

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
          : 'Infiltrators must be set up > 9" from the enemy zone and enemy models',
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
 * Deep Strike arrival legality: when a unit arrives from Reserves it must be set up so that every
 * model is more than 9" horizontally from all enemy models. Strategic/Deep-Strike reserves also
 * cannot arrive during the first battle round.
 */
export function deepStrikeArrivalLegal(
  positions: Vec2[],
  baseShape: BaseShape,
  enemyModels: { pos: Vec2; shape: BaseShape }[],
  round: number,
  occupied: OccupiedBase[] = [],
): DeploymentCheck {
  if (round < 2) {
    return { legal: false, perModel: positions.map(() => false), reason: 'Reserves cannot arrive in the first battle round' };
  }
  const clearOfModels = (p: Vec2) => occupied.every((o) => !basesOverlap(p, baseShape, o.pos, o.shape));
  const stacked = positions.some((p) => !clearOfModels(p));
  const perModel = positions.map(
    (p) => enemyModels.every((e) => gapBetweenBases(p, baseShape, e.pos, e.shape) > INFILTRATE_MIN) && clearOfModels(p),
  );
  return {
    legal: perModel.every(Boolean),
    perModel,
    reason: perModel.every(Boolean)
      ? undefined
      : stacked
        ? 'Models cannot be set up on top of other models'
        : 'Deep Strike must arrive > 9" from all enemy models',
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
