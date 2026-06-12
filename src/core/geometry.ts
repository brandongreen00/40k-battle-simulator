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

/**
 * Do two bases physically overlap? Models may be moved AROUND each other and bases may touch
 * (base-to-base contact is how melee works), but a model can never stand ON TOP of another —
 * `baseToBaseGap` clamps at 0, so overlap needs the raw centre distance. Ovals use their
 * INSCRIBED circle (min semi-axis): base rotation isn't tracked, and the average-radius
 * approximation would falsely flag legal tight oval formations (e.g. Death Riders in a block)
 * as stacked. Conservative: real stacking is always caught, shallow edge-on oval overlap may
 * not be. The tolerance forgives float noise from moves ending exactly at base contact.
 */
export const OVERLAP_TOLERANCE = 0.01; // inches
function inscribedRadius(shape: BaseShape): number {
  if (shape.kind === 'circle') return baseRadius(shape);
  return Math.min(shape.rx ?? 0, shape.ry ?? 0);
}
export function basesOverlap(a: Vec2, sa: BaseShape, b: Vec2, sb: BaseShape, tol = OVERLAP_TOLERANCE): boolean {
  return dist(a, b) < inscribedRadius(sa) + inscribedRadius(sb) - tol;
}

/** Half-extents (inches) of a base along x/y — circle is symmetric, oval uses its semi-axes. */
export function baseHalfExtents(shape: BaseShape): { hx: number; hy: number } {
  if (shape.kind === 'circle') {
    const r = baseRadius(shape);
    return { hx: r, hy: r };
  }
  return { hx: shape.rx!, hy: shape.ry! };
}

/** Clamp a scalar to [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Clamp a point so its distance from `from` is at most `maxDist` (the direction is preserved). */
export function clampToRange(from: Vec2, to: Vec2, maxDist: number): Vec2 {
  const d = dist(from, to);
  if (d <= maxDist || d === 0) return to;
  const k = maxDist / d;
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

// ── Point-to-segment / point-to-polygon distance ─────────────────────────────
/** Shortest distance from point `p` to the line segment a→b. */
export function distancePointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = clamp(t, 0, 1);
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * Shortest distance from point `p` to a polygon footprint. Returns 0 when `p` is inside.
 * Used for deployment legality (e.g. Infiltrators must be > 9" from the enemy deployment zone).
 */
export function distancePointToPolygon(p: Vec2, polygon: Vec2[]): number {
  if (polygon.length === 0) return Infinity;
  if (pointInPolygon(p, polygon)) return 0;
  let min = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    min = Math.min(min, distancePointToSegment(p, polygon[j]!, polygon[i]!));
  }
  return min;
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
