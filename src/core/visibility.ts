// 11e terrain & visibility (Core Rules 13). PURE — no React, no DOM.
//
// Layout-aware dispatch: Event Companion layouts carry `terrainAreas` and use the 11e model —
//   • OBSCURING (13.10): a terrain area containing any light/dense feature blocks every line of
//     sight that crosses it, unless one of the two models is within that area.
//   • SOLID (13.11): dense features block sight through themselves (we treat the feature's
//     footprint polygon as the solid block; endpoints inside the feature see out/in).
//   • BENEFIT OF COVER (13.08): the target has cover when every model is INFANTRY/BEASTS/SWARM
//     within a terrain area, or is not fully visible because of intervening features/areas.
//     Cover worsens the attacker's BS by 1 (combat.ts).
//   • HIDDEN (13.09): an I/B/S unit within a dense-containing terrain area that has not made
//     ranged attacks this turn or the previous turn is only visible within 15" detection range.
// Legacy (10e labrador) layouts keep the old ruin-blocking model in los.ts.
//
// 2D simplifications (documented): sight lines are centre-to-centre between models; "fully
// visible" ≈ the firing line clips no feature/area edge; vertical terrain rules are moot.

import type { Datasheet, GameState, Layout, TerrainArea, UnitInstance, Vec2 } from './types';
import type { EngineContext } from './engine';
import { baseRadius, distancePointToPolygon, gapBetweenBases, pointInPolygon } from './geometry';
import { losBlocked as legacyLosBlocked, hasCover as legacyHasCover, segmentIntersectsPolygon } from './los';

export const DEFAULT_DETECTION_RANGE = 15; // inches (13.09)

export const is11eLayout = (layout: Layout): boolean => !!layout.terrainAreas?.length;

/** Terrain areas that are obscuring (contain one or more light/dense features). */
function obscuringAreas(layout: Layout): TerrainArea[] {
  return (layout.terrainAreas ?? []).filter((a) => a.features.length > 0);
}

/** A model counts as "within" a terrain piece when any part of its BASE overlaps it — the
 *  centre point alone misses a model standing on the piece's edge (centre a hair outside),
 *  which would otherwise have every sightline that clips the piece falsely blocked. */
function modelWithin(p: Vec2, r: number, polygon: Vec2[]): boolean {
  return pointInPolygon(p, polygon) || (r > 0 && distancePointToPolygon(p, polygon) <= r);
}

/** Which 11e terrain rule blocks the sight line a→b (if any). */
export type LosBlock = 'obscuring_area' | 'dense_feature';

/** Why the sight line a→b is blocked (Obscuring areas / Solid dense features), or null when it
 *  is clear. `aR`/`bR` are the two models' base radii — a base overlapping an area/feature sees
 *  out of it. */
export function losBlockReason11(a: Vec2, b: Vec2, layout: Layout, aR = 0, bR = 0): LosBlock | null {
  for (const area of obscuringAreas(layout)) {
    // you can see into/out of an obscuring area, not through it
    if (modelWithin(a, aR, area.polygon) || modelWithin(b, bR, area.polygon)) continue;
    if (segmentIntersectsPolygon(a, b, area.polygon)) return 'obscuring_area';
  }
  // Solid: dense features block even within/into an area (unless the model is on the feature).
  for (const area of layout.terrainAreas ?? []) {
    for (const f of area.features) {
      if (f.kind !== 'dense') continue;
      if (modelWithin(a, aR, f.polygon) || modelWithin(b, bR, f.polygon)) continue;
      if (segmentIntersectsPolygon(a, b, f.polygon)) return 'dense_feature';
    }
  }
  return null;
}

/** Is the sight line a→b blocked (Obscuring areas + Solid dense features)? `aR`/`bR` are the
 *  two models' base radii — a base overlapping an area/feature sees out of it. */
export function losBlocked11(a: Vec2, b: Vec2, layout: Layout, aR = 0, bR = 0): boolean {
  return losBlockReason11(a, b, layout, aR, bR) !== null;
}

/** Layout-dispatching point LoS. Optional base radii let a model whose base overlaps a terrain
 *  piece see out of it (11e layouts; the legacy 10e model keeps its centre-point rule). */
export function pointLosBlocked(a: Vec2, b: Vec2, layout: Layout, aR = 0, bR = 0): boolean {
  if (is11eLayout(layout)) return losBlocked11(a, b, layout, aR, bR);
  return legacyLosBlocked(a, b, layout.terrain);
}

const IBS = ['infantry', 'beasts', 'swarm'];

export function isIBS(ds: Datasheet | undefined): boolean {
  return !!ds?.keywords.some((k) => IBS.includes(k.toLowerCase()));
}

/** The terrain area containing a point (if any). */
export function areaAt(pos: Vec2, layout: Layout): TerrainArea | undefined {
  return (layout.terrainAreas ?? []).find((a) => pointInPolygon(pos, a.polygon));
}

/**
 * Is `target` hidden from observers beyond detection range (13.09)?
 * Every model I/B/S within a dense-containing terrain area, and the unit made no ranged attacks
 * this turn or the previous player-turn.
 */
export function isHidden(target: UnitInstance, state: GameState, ctx: EngineContext): boolean {
  if (!is11eLayout(state.layout)) return false;
  const ds = ctx.datasheets.get(target.datasheetId);
  if (!isIBS(ds)) return false;
  const lastShot = target.status.lastShotOnTurn;
  const turnCounter = state.turnCounter ?? 0;
  if (lastShot != null && turnCounter - lastShot < 2) return false;
  const alive = target.models.filter((m) => m.alive);
  if (alive.length === 0) return false;
  return alive.every((m) => {
    const area = areaAt(m.pos, state.layout);
    if (!area) return false;
    const members = area.groupId
      ? (state.layout.terrainAreas ?? []).filter((x) => x.groupId === area.groupId)
      : [area];
    return members.some((x) => x.features.some((f) => f.kind === 'dense'));
  });
}

/**
 * Unit-level visibility under 11e: any attacker model sees any target model within the terrain
 * rules; a hidden target is only visible within the detection range.
 */
export function unitCanSee11(
  attackerPts: Vec2[],
  target: UnitInstance,
  state: GameState,
  ctx: EngineContext,
  detectionRange = DEFAULT_DETECTION_RANGE,
  attackerR = 0,
): boolean {
  const layout = state.layout;
  const hidden = isHidden(target, state, ctx);
  for (const a of attackerPts) {
    for (const m of target.models) {
      if (!m.alive) continue;
      if (hidden && Math.hypot(a.x - m.pos.x, a.y - m.pos.y) > detectionRange) continue;
      const shape = ctx.datasheets.get(m.datasheetId ?? target.datasheetId)?.baseShape;
      if (!pointLosBlocked(a, m.pos, layout, attackerR, shape ? baseRadius(shape) : 0)) return true;
    }
  }
  return false;
}

/**
 * Benefit of Cover (13.08): every model in the target qualifies —
 *  (a) I/B/S within a terrain area, or
 *  (b) not fully visible to the attacker (the closest clear firing line clips an intervening
 *      feature footprint — 2D approximation of "not fully visible").
 */
export function unitHasCover11(
  attackerPts: Vec2[],
  target: UnitInstance,
  state: GameState,
  ctx: EngineContext,
): boolean {
  const layout = state.layout;
  const ds = ctx.datasheets.get(target.datasheetId);
  const ibs = isIBS(ds);
  const alive = target.models.filter((m) => m.alive);
  if (alive.length === 0) return false;
  return alive.every((m) => {
    if (ibs && areaAt(m.pos, layout)) return true;
    // Not fully visible: every attacker sightline to this model clips a feature or area edge.
    return attackerPts.every((a) => {
      if (pointLosBlocked(a, m.pos, layout)) return true; // not visible at all
      for (const area of layout.terrainAreas ?? []) {
        for (const f of area.features) {
          if (pointInPolygon(a, f.polygon) || pointInPolygon(m.pos, f.polygon)) continue;
          if (segmentIntersectsPolygon(a, m.pos, f.polygon)) return true;
        }
      }
      return false;
    });
  });
}

/** Layout-dispatching unit cover (legacy layouts use the 10e-style heuristic). */
export function unitCoverIn(
  attackerPts: Vec2[],
  target: UnitInstance,
  state: GameState,
  ctx: EngineContext,
): boolean {
  if (is11eLayout(state.layout)) return unitHasCover11(attackerPts, target, state, ctx);
  const tPts = target.models.filter((m) => m.alive).map((m) => m.pos);
  return tPts.some((b) => attackerPts.some((a) => !legacyLosBlocked(a, b, state.layout.terrain) && legacyHasCover(a, b, state.layout.terrain)));
}

/**
 * Human-readable reason no weapon of `plan` can reach `target` — shown by the shooting UI so
 * "out of range or not visible" names the actual rule (Obscuring area / Solid dense feature /
 * Hidden / plain range). Diagnostic only: legality stays with validShootingTargets.
 */
export function explainNoReach(
  attacker: UnitInstance,
  plan: { fire: { weapon: { range?: number } }[] },
  target: UnitInstance,
  state: GameState,
  ctx: EngineContext,
): string {
  const fallback = 'Out of range or not visible — no weapon can reach this unit.';
  const layout = state.layout;
  const aDs = ctx.datasheets.get(attacker.datasheetId);
  const tDs = ctx.datasheets.get(target.datasheetId);
  const aAlive = attacker.models.filter((m) => m.alive);
  const tAlive = target.models.filter((m) => m.alive);
  if (!aDs || !tDs || aAlive.length === 0 || tAlive.length === 0 || plan.fire.length === 0) return fallback;

  // Closest base-to-base gap between the two units (merged Leader models use their own bases).
  const shapeOf = (m: { datasheetId?: string }, own: Datasheet) =>
    (m.datasheetId ? ctx.datasheets.get(m.datasheetId)?.baseShape : undefined) ?? own.baseShape;
  let gap = Infinity;
  let closest: { a: Vec2; aR: number; t: Vec2; tR: number } | null = null;
  for (const am of aAlive) {
    for (const tm of tAlive) {
      const aShape = shapeOf(am, aDs);
      const tShape = shapeOf(tm, tDs);
      const g = gapBetweenBases(am.pos, aShape, tm.pos, tShape);
      if (g < gap) {
        gap = g;
        closest = { a: am.pos, aR: baseRadius(aShape), t: tm.pos, tR: baseRadius(tShape) };
      }
    }
  }
  if (!closest) return fallback;

  const maxRange = Math.max(...plan.fire.map((w) => w.weapon.range ?? 0));
  if (gap > maxRange) {
    return `Out of range — the closest model is ${gap.toFixed(1)}" away and the longest weapon reaches ${maxRange}".`;
  }

  // In range, so it's a visibility block. Name the rule on the closest sight line.
  if (is11eLayout(layout)) {
    const reason = losBlockReason11(closest.a, closest.t, layout, closest.aR, closest.tR);
    if (reason === 'dense_feature') {
      return 'Not visible — a dense ruin (green) blocks the sight line. Solid terrain cannot be seen through, even from inside the same terrain area.';
    }
    if (reason === 'obscuring_area') {
      return 'Not visible — the sight line crosses a terrain area neither unit is inside. Terrain areas are Obscuring: you can see into one, not through it.';
    }
    if (isHidden(target, state, ctx)) {
      return `Not visible — the target is Hidden (holding fire inside dense terrain): it can only be seen within ${DEFAULT_DETECTION_RANGE}". Move closer, or wait for it to shoot.`;
    }
  } else if (pointLosBlocked(closest.a, closest.t, layout)) {
    return 'Not visible — a ruin blocks line of sight.';
  }
  return fallback;
}

/** Layout-dispatching unit visibility. `attackerR` = the attacker models' base radius (11e:
 *  a base overlapping a terrain piece sees out of it). */
export function unitCanSeeIn(
  attackerPts: Vec2[],
  target: UnitInstance,
  state: GameState,
  ctx: EngineContext,
  attackerR = 0,
): boolean {
  if (is11eLayout(state.layout)) return unitCanSee11(attackerPts, target, state, ctx, DEFAULT_DETECTION_RANGE, attackerR);
  const tPts = target.models.filter((m) => m.alive).map((m) => m.pos);
  return attackerPts.some((a) => tPts.some((b) => !legacyLosBlocked(a, b, state.layout.terrain)));
}
