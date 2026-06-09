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

import type { BaseShape, Layout, Side, Vec2 } from './types';
import { gapBetweenBases, distancePointToPolygon, pointInPolygon } from './geometry';

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
 */
export function checkUnitDeployment(
  positions: Vec2[],
  baseShape: BaseShape,
  layout: Layout,
  side: Side,
  ability: DeployAbility,
  enemyModels: { pos: Vec2; shape: BaseShape }[] = [],
): DeploymentCheck {
  if (ability === 'infiltrators') {
    const enemyZone = zoneFor(layout, side === 'player' ? 'ai' : 'player');
    const perModel = positions.map((p) => {
      const farFromZone = enemyZone.length === 0 || distancePointToPolygon(p, enemyZone) > INFILTRATE_MIN;
      const farFromEnemies = enemyModels.every((e) => gapBetweenBases(p, baseShape, e.pos, e.shape) > INFILTRATE_MIN);
      const onBoard = p.x >= 0 && p.y >= 0 && p.x <= layout.boardWidth && p.y <= layout.boardHeight;
      return onBoard && farFromZone && farFromEnemies;
    });
    return {
      legal: perModel.every(Boolean),
      perModel,
      reason: perModel.every(Boolean) ? undefined : 'Infiltrators must be set up > 9" from the enemy zone and enemy models',
    };
  }

  // Standard deployment: every model within the side's own zone.
  const perModel = positions.map((p) => inOwnZone(p, layout, side));
  return {
    legal: perModel.every(Boolean),
    perModel,
    reason: perModel.every(Boolean) ? undefined : 'All models must be within your deployment zone',
  };
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
): DeploymentCheck {
  if (round < 2) {
    return { legal: false, perModel: positions.map(() => false), reason: 'Reserves cannot arrive in the first battle round' };
  }
  const perModel = positions.map((p) =>
    enemyModels.every((e) => gapBetweenBases(p, baseShape, e.pos, e.shape) > INFILTRATE_MIN),
  );
  return {
    legal: perModel.every(Boolean),
    perModel,
    reason: perModel.every(Boolean) ? undefined : 'Deep Strike must arrive > 9" from all enemy models',
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
