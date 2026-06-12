// Model-base collision (10e: a model's base can never be placed on top of another model's base —
// models move around each other, bases may touch, but never overlap). PURE — no React, no DOM.
//
// Only FINAL positions are checked (a move may pass over other models mid-drag); the reducer,
// the engine's charge/fight moves, deployment legality, and the AI all gate on these helpers so a
// confirmed state can never contain stacked bases. Everything is per-model: a merged unit carries
// Leader models on their OWN (possibly larger) bases.

import type { BaseShape, GameState, Side, UnitInstance, Vec2 } from './types';
import { basesOverlap } from './geometry';

/** A model's footprint on the board. */
export interface OccupiedBase {
  pos: Vec2;
  shape: BaseShape;
}

interface DatasheetLookup {
  datasheets: Map<string, { baseShape: BaseShape }>;
}

const FALLBACK_SHAPE: BaseShape = { kind: 'circle', radius: 0.63 };

/** The base shape of one model in a unit (merged Leader models carry their own datasheetId). */
export function modelBaseShape(
  unit: UnitInstance,
  model: { datasheetId?: string },
  ctx?: DatasheetLookup,
): BaseShape {
  return (
    (model.datasheetId ? ctx?.datasheets.get(model.datasheetId)?.baseShape : undefined) ??
    ctx?.datasheets.get(unit.datasheetId)?.baseShape ??
    FALLBACK_SHAPE
  );
}

/** A unit's alive models as positioned bases (each on its own shape). */
export function unitBases(unit: UnitInstance, ctx?: DatasheetLookup): OccupiedBase[] {
  return unit.models
    .filter((m) => m.alive)
    .map((m) => ({ pos: m.pos, shape: modelBaseShape(unit, m, ctx) }));
}

/**
 * Every alive, on-board model base except those of `excludeUnitIds` — the obstacle set a unit's
 * final positions are checked against. Pass `side` to restrict to one owner (rarely needed).
 */
export function occupiedBases(
  state: GameState,
  ctx?: DatasheetLookup,
  excludeUnitIds: string[] = [],
  side?: Side,
): OccupiedBase[] {
  const excluded = new Set(excludeUnitIds);
  const out: OccupiedBase[] = [];
  for (const u of state.units) {
    if (excluded.has(u.id) || u.inReserves) continue;
    if (side && u.owner !== side) continue;
    out.push(...unitBases(u, ctx));
  }
  return out;
}

/** Does any of `bases` overlap any of `occupied`? */
export function anyOverlap(bases: OccupiedBase[], occupied: OccupiedBase[]): boolean {
  return bases.some((b) => occupied.some((o) => basesOverlap(b.pos, b.shape, o.pos, o.shape)));
}

/**
 * Does `unit` currently overlap anything — another unit's model, OR one of its own models
 * (a single-model drag can stack squad mates)? Used by EndMove and the movement-UI warnings.
 */
export function unitOverlaps(state: GameState, unit: UnitInstance, ctx?: DatasheetLookup): boolean {
  const others = occupiedBases(state, ctx, [unit.id]);
  const mine = unitBases(unit, ctx);
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i]!;
    if (others.some((o) => basesOverlap(a.pos, a.shape, o.pos, o.shape))) return true;
    for (let j = i + 1; j < mine.length; j++) {
      const b = mine[j]!;
      if (basesOverlap(a.pos, a.shape, b.pos, b.shape)) return true;
    }
  }
  return false;
}

/**
 * Largest prefix of a rigid translate `delta` that keeps every base of `bases` clear of
 * `occupied` (binary search along the line; t = 0 must be legal — positions are non-overlapping
 * by invariant, since every way positions change is gated on these checks).
 */
export function clampDeltaAvoidingOverlap(
  bases: OccupiedBase[],
  occupied: OccupiedBase[],
  delta: Vec2,
): Vec2 {
  const at = (d: Vec2): OccupiedBase[] =>
    bases.map((b) => ({ pos: { x: b.pos.x + d.x, y: b.pos.y + d.y }, shape: b.shape }));
  if (!anyOverlap(at(delta), occupied)) return delta;
  const len = Math.hypot(delta.x, delta.y);
  if (len < 1e-9) return { x: 0, y: 0 };
  let lo = 0;
  let hi = len;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const d = { x: (delta.x / len) * mid, y: (delta.y / len) * mid };
    if (anyOverlap(at(d), occupied)) hi = mid;
    else lo = mid;
  }
  return { x: (delta.x / len) * lo, y: (delta.y / len) * lo };
}
