// Geometry for the measuring board. PURE — no React, no DOM.
// Board coordinates are in INCHES; origin bottom-left, x along the long (60") edge,
// y along the short (44") edge. 40k measures between the CLOSEST POINTS OF BASES,
// never centre-to-centre (architecture rule #5).

import type { Vec2, BaseShape } from './types';

export const MM_PER_INCH = 25.4;

/** Convert a base size in millimetres (e.g. 32) to inches. */
export function mmToInches(mm: number): number {
  return mm / MM_PER_INCH;
}

// ── Vector helpers ───────────────────────────────────────────────────────────
export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}
export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}
export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

/** Centre-to-centre Euclidean distance. */
export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── Base-to-base measuring ───────────────────────────────────────────────────
/**
 * Canonical 40k gap (architecture rule #5): the closest distance between two circular
 * bases, clamped at 0 when they overlap.
 *   gap = max(0, dist(centreA, centreB) − radiusA − radiusB)
 */
export function baseToBaseGap(a: Vec2, ra: number, b: Vec2, rb: number): number {
  return Math.max(0, dist(a, b) - ra - rb);
}

/**
 * Effective circular radius (inches) for a base shape.
 * - circle: exact.
 * - oval: approximated by the average semi-axis. This is a deliberate Phase-0 simplification
 *   (true orientation-aware oval base-to-base arrives with the combat core); it keeps the
 *   measuring board honest enough for the handful of oval bases in the three lists.
 */
export function baseRadius(shape: BaseShape): number {
  if (shape.kind === 'circle') {
    if (shape.radius == null) throw new Error('circle base is missing `radius`');
    return shape.radius;
  }
  if (shape.rx == null || shape.ry == null) {
    throw new Error('oval base is missing `rx`/`ry`');
  }
  return (shape.rx + shape.ry) / 2;
}

/** Base-to-base gap between two models given their base shapes. */
export function gapBetweenBases(a: Vec2, sa: BaseShape, b: Vec2, sb: BaseShape): number {
  return baseToBaseGap(a, baseRadius(sa), b, baseRadius(sb));
}

// ── Point in polygon ─────────────────────────────────────────────────────────
/**
 * Ray-casting point-in-polygon. `polygon` is an ordered vertex list (inches); the edge
 * connecting the last vertex back to the first is implied. Points exactly on an edge are
 * not guaranteed either way — fine for terrain/zone hit-testing.
 */
export function pointInPolygon(p: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const vi = polygon[i]!;
    const vj = polygon[j]!;
    const intersects =
      vi.y > p.y !== vj.y > p.y &&
      p.x < ((vj.x - vi.x) * (p.y - vi.y)) / (vj.y - vi.y) + vi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}
