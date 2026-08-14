// Dense-terrain movement (11e, 13.06): only INFANTRY / BEASTS / SWARM models move through
// dense features horizontally, and FLY models move over everything. Every other model —
// VEHICLE, MOUNTED, MONSTER, ... — can neither cross a dense (green) feature nor end a move
// or set-up on one. Light (yellow) features and plain terrain areas (grey mats, including the
// area objectives) restrict nobody. Applies on layouts that carry terrain areas (Event
// Companion + Combat Patrol maps); legacy 10e labrador maps keep free movement.
// PURE — no React, no DOM.

import type { BaseShape, Datasheet, Layout, UnitInstance, Vec2 } from './types';
import { baseRadius, distancePointToPolygon, pointInPolygon } from './geometry';
import { segmentIntersectsPolygon } from './los';
import { is11eLayout } from './visibility';
import { modelBaseShape } from './collision';

/** Matches geometry.OVERLAP_TOLERANCE's intent: base contact with a feature edge is legal. */
const EDGE_TOLERANCE = 1e-3;

const PASSES_DENSE = ['infantry', 'beasts', 'swarm', 'fly', 'aircraft'];

/** Can this datasheet's models NOT enter dense features (13.06)? Infantry/Beasts/Swarm pass
 *  through; FLY (and Aircraft) move over; everyone else — tanks, riders, monsters — is blocked. */
export function blockedByDense(ds: Datasheet | undefined): boolean {
  if (!ds) return false;
  return !ds.keywords.some((k) => PASSES_DENSE.includes(k.toLowerCase()));
}

/** All dense-feature footprints of the layout (empty on legacy 10e maps). */
export function denseFeaturePolygons(layout: Layout): Vec2[][] {
  if (!is11eLayout(layout)) return [];
  const out: Vec2[][] = [];
  for (const a of layout.terrainAreas ?? []) {
    for (const f of a.features) if (f.kind === 'dense') out.push(f.polygon);
  }
  return out;
}

/** Does a base at `pos` (radius `r`) overlap a dense feature? Edge contact stays legal. */
export function baseOnDense(pos: Vec2, r: number, layout: Layout): boolean {
  return denseFeaturePolygons(layout).some(
    (poly) => pointInPolygon(pos, poly) || distancePointToPolygon(pos, poly) < r - EDGE_TOLERANCE,
  );
}

/**
 * May a dense-blocked model move `from` → `to` (the sim's moves are straight lines: budgets
 * measure from the move origin, and charges/pile-ins are rigid translates)? The move may not
 * END on a dense feature nor CROSS one — with a carve-out: a model already overlapping a
 * feature (pre-rule saves, edge cases) may move off it.
 */
export function denseMoveLegal(from: Vec2, to: Vec2, r: number, layout: Layout): boolean {
  for (const poly of denseFeaturePolygons(layout)) {
    // Carve-out: a model already overlapping THIS feature (pre-rule saves, edge cases) is
    // grandfathered on it — it may stay put or move off, so it can never be wedged. It still
    // cannot enter or cross any OTHER dense feature.
    const startOn = pointInPolygon(from, poly) || distancePointToPolygon(from, poly) < r - EDGE_TOLERANCE;
    if (startOn) continue;
    const endOn = pointInPolygon(to, poly) || distancePointToPolygon(to, poly) < r - EDGE_TOLERANCE;
    if (endOn) return false;
    if (segmentIntersectsPolygon(from, to, poly)) return false;
  }
  return true;
}

interface DatasheetLookup {
  datasheets: Map<string, Datasheet>;
}

/** Is this unit's movement dense-blocked (keyed off its PRIMARY datasheet — a merged unit
 *  moves as one, under the bodyguard's movement rules)? */
export function unitBlockedByDense(unit: UnitInstance, ctx: DatasheetLookup, layout: Layout): boolean {
  if (!is11eLayout(layout)) return false;
  return blockedByDense(ctx.datasheets.get(unit.datasheetId));
}

export type DenseViolation = 'ends_on' | 'crosses';

/**
 * Does the unit's CURRENT position violate the dense rule for the move in progress? Each model
 * is checked from its `moveStart` (set by BeginMove) to its present position — the same straight
 * line its move budget was measured along. Models without a moveStart only check the end overlap.
 * Returns null when the unit is not dense-blocked or nothing is violated.
 */
export function unitDenseViolation(
  unit: UnitInstance,
  ctx: DatasheetLookup,
  layout: Layout,
): DenseViolation | null {
  if (!unitBlockedByDense(unit, ctx, layout)) return null;
  for (const m of unit.models) {
    if (!m.alive) continue;
    const r = baseRadius(modelBaseShape(unit, m, ctx));
    const from = m.moveStart ?? m.pos;
    if (!denseMoveLegal(from, m.pos, r, layout)) {
      return baseOnDense(m.pos, r, layout) ? 'ends_on' : 'crosses';
    }
  }
  return null;
}

/** Would a rigid translate of the whole unit by `delta` be dense-legal (path + end)? */
export function translateDenseLegal(
  unit: UnitInstance,
  delta: Vec2,
  ctx: DatasheetLookup,
  layout: Layout,
): boolean {
  if (!unitBlockedByDense(unit, ctx, layout)) return true;
  return unit.models.every((m) => {
    if (!m.alive) return true;
    const r = baseRadius(modelBaseShape(unit, m, ctx));
    return denseMoveLegal(m.pos, { x: m.pos.x + delta.x, y: m.pos.y + delta.y }, r, layout);
  });
}

/**
 * Largest prefix of a rigid translate `delta` that keeps a dense-blocked unit legal (binary
 * search along the line, like collision.clampDeltaAvoidingOverlap). A unit that is not
 * dense-blocked gets `delta` back unchanged.
 */
export function clampDeltaAvoidingDense(
  unit: UnitInstance,
  delta: Vec2,
  ctx: DatasheetLookup,
  layout: Layout,
): Vec2 {
  if (translateDenseLegal(unit, delta, ctx, layout)) return delta;
  const len = Math.hypot(delta.x, delta.y);
  if (len < 1e-9) return { x: 0, y: 0 };
  let lo = 0;
  let hi = len;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const d = { x: (delta.x / len) * mid, y: (delta.y / len) * mid };
    if (translateDenseLegal(unit, d, ctx, layout)) lo = mid;
    else hi = mid;
  }
  // Back off a hair so the clamped position isn't within numeric noise of illegal.
  const t = Math.max(0, lo - 0.02);
  return { x: (delta.x / len) * t, y: (delta.y / len) * t };
}

/** Set-up legality helper: which of `positions` put a base of `shape` on a dense feature. */
export function denseSetupIllegal(positions: Vec2[], shape: BaseShape, layout: Layout): boolean[] {
  const r = baseRadius(shape);
  return positions.map((p) => baseOnDense(p, r, layout));
}
