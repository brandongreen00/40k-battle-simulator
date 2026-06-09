// Line-of-sight and cover — the 2D-footprint abstraction (plan §5). PURE — no React, no DOM.
//
// The deliberate, documented simplification: a model sees a target if the straight segment between
// their base centres does not pass through a line-of-sight-BLOCKING terrain footprint (tall ruins),
// with the standard Ruins carve-out — a model within a ruin footprint can see out, and can be seen
// into. This reduces "true 3D LoS" to segment-vs-polygon intersection. Cover falls out of the same
// data: a target has the Benefit of Cover if the firing line clips intervening terrain, or the
// target stands within area terrain.
//
// Known limitation (intentional): this is centre-to-centre LoS between single points, not the full
// "any visible point of any model" tabletop rule. It matches how a lot of competitive play
// adjudicates ruins and is fast and deterministic. Refine to base-edge sampling later if needed.

import type { TerrainPiece, Vec2 } from './types';
import { pointInPolygon } from './geometry';

const EPS = 1e-9;

/** Do open segments p1p2 and p3p4 cross? (proper or collinear-overlap intersection) */
export function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
      ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }
  const onSeg = (a: Vec2, b: Vec2, c: Vec2) =>
    Math.abs(d(a, b, c)) <= EPS &&
    Math.min(a.x, b.x) - EPS <= c.x && c.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= c.y && c.y <= Math.max(a.y, b.y) + EPS;
  return onSeg(p3, p4, p1) || onSeg(p3, p4, p2) || onSeg(p1, p2, p3) || onSeg(p1, p2, p4);
}

/** Does segment a→b cross any edge of (or pass through) the polygon? */
export function segmentIntersectsPolygon(a: Vec2, b: Vec2, poly: Vec2[]): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsIntersect(a, b, poly[j]!, poly[i]!)) return true;
  }
  // Fully-contained segment (no edge crossing) still passes "through" the piece.
  return pointInPolygon(a, poly) && pointInPolygon(b, poly);
}

/** A terrain piece blocks line of sight if it is a tall ruin. */
export function blocksLoS(piece: TerrainPiece): boolean {
  return piece.type === 'ruin_blocking' || piece.height === 'tall';
}

/**
 * Is line of sight from `a` to `b` blocked by terrain?
 * Carve-out: a blocking piece is ignored if either endpoint lies within its footprint (a model
 * inside a ruin can see out / be seen into).
 */
export function losBlocked(a: Vec2, b: Vec2, terrain: TerrainPiece[]): boolean {
  for (const piece of terrain) {
    if (!blocksLoS(piece)) continue;
    if (pointInPolygon(a, piece.polygon) || pointInPolygon(b, piece.polygon)) continue;
    if (segmentIntersectsPolygon(a, b, piece.polygon)) return true;
  }
  return false;
}

/**
 * Does the target at `b` (seen from `a`) get the Benefit of Cover?
 * Granted when the target stands within an area-terrain/ruin footprint, or when the firing line
 * clips an intervening terrain piece. The attacker's own footprint never grants the target cover.
 */
export function hasCover(a: Vec2, b: Vec2, terrain: TerrainPiece[]): boolean {
  for (const piece of terrain) {
    if (piece.type === 'obstacle') continue; // obstacles handled by their own rules later
    if (pointInPolygon(b, piece.polygon)) return true; // target within cover terrain
    if (pointInPolygon(a, piece.polygon)) continue; // attacker inside this piece — not cover for target
    if (segmentIntersectsPolygon(a, b, piece.polygon)) return true; // intervening terrain
  }
  return false;
}

/** Unit-level visibility: any alive attacker model can see any alive target model. */
export function unitCanSee(attackerPts: Vec2[], targetPts: Vec2[], terrain: TerrainPiece[]): boolean {
  for (const a of attackerPts) {
    for (const b of targetPts) {
      if (!losBlocked(a, b, terrain)) return true;
    }
  }
  return false;
}

/**
 * Unit-level cover: a target unit benefits from cover if, along the closest visible firing line,
 * the line clips terrain or the target model sits in cover. Conservative: returns true if ANY
 * visible target model would have cover (the defender's favour, matching how cover is usually given).
 */
export function unitHasCover(attackerPts: Vec2[], targetPts: Vec2[], terrain: TerrainPiece[]): boolean {
  for (const b of targetPts) {
    for (const a of attackerPts) {
      if (losBlocked(a, b, terrain)) continue;
      if (hasCover(a, b, terrain)) return true;
    }
  }
  return false;
}
