// Unit formation geometry. PURE — no React, no DOM, no I/O.
//
// Given an anchor, a model count, a base size and a formation + rotation, this returns the
// position of every model in the unit. It is the single source of truth for "how a unit is
// shaped on the table", shared by:
//   • the placement ghost preview (UI) — so what you see is exactly what you get, and
//   • the SpawnUnit reducer (core)     — so the committed unit matches the preview.
//
// This is Stage-1 deployment ergonomics, not rules: it does NOT enforce unit coherency,
// deployment-zone legality, or base overlap — the owner asked to place units "wherever they
// want". Those checks belong to later stages.

import type { BaseShape, Vec2 } from './types';
import { baseHalfExtents } from './geometry';

/** The strategic shapes a unit can be deployed in. Order is the `c`-key cycle order. */
export type Formation = 'block' | 'line' | 'column' | 'circle' | 'wedge';

export const FORMATIONS: Formation[] = ['block', 'line', 'column', 'circle', 'wedge'];

export const FORMATION_LABEL: Record<Formation, string> = {
  block: 'Block — bunched',
  line: 'Battle line — strung out',
  column: 'Column — single file',
  circle: 'Circle — defensive ring',
  wedge: 'Wedge — spearhead',
};

/** Next formation in the cycle (wraps). */
export function nextFormation(f: Formation): Formation {
  const i = FORMATIONS.indexOf(f);
  return FORMATIONS[(i + 1) % FORMATIONS.length]!;
}

export interface FormationOptions {
  anchor: Vec2;
  count: number;
  baseShape: BaseShape;
  formation: Formation;
  /** Rotation around the anchor, in radians (clockwise on screen is +; the UI maps scroll to it). */
  rotation: number;
  /** Gap between adjacent base edges, inches. Defaults to 0.2" (a coherency-friendly tight pack). */
  gap?: number;
}

/**
 * Absolute board positions (inches) for every model in a unit, laid out in `formation` and
 * rotated by `rotation` around `anchor`. Length always equals `count` (clamped to ≥ 0).
 */
export function formationPositions(opts: FormationOptions): Vec2[] {
  const { anchor, baseShape, formation, rotation, gap = 0.2 } = opts;
  const count = Math.max(0, Math.floor(opts.count));
  const { hx, hy } = baseHalfExtents(baseShape);
  const stepX = hx * 2 + gap;
  const stepY = hy * 2 + gap;

  const local = localOffsets(formation, count, stepX, stepY);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return local.map((o) => ({
    x: anchor.x + o.x * cos - o.y * sin,
    y: anchor.y + o.x * sin + o.y * cos,
  }));
}

// ── Local (unrotated, anchor-centred) offsets per formation ───────────────────
function localOffsets(formation: Formation, count: number, stepX: number, stepY: number): Vec2[] {
  if (count <= 0) return [];
  switch (formation) {
    case 'block':
      return blockOffsets(count, stepX, stepY);
    case 'line':
      return lineOffsets(count, stepX);
    case 'column':
      return columnOffsets(count, stepY);
    case 'circle':
      return circleOffsets(count, stepX);
    case 'wedge':
      return wedgeOffsets(count, stepX, stepY);
  }
}

/** Compact rectangle (the classic deployment blob). */
function blockOffsets(count: number, stepX: number, stepY: number): Vec2[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({ x: (col - (cols - 1) / 2) * stepX, y: (row - (rows - 1) / 2) * stepY });
  }
  return out;
}

/** A single wide rank (screen / spread to contest a line). */
function lineOffsets(count: number, stepX: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) out.push({ x: (i - (count - 1) / 2) * stepX, y: 0 });
  return out;
}

/** A single file (push down a corridor / minimise frontage). */
function columnOffsets(count: number, stepY: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) out.push({ x: 0, y: (i - (count - 1) / 2) * stepY });
  return out;
}

/** A defensive ring; the radius grows so bases don't overlap. Singletons sit at the centre. */
function circleOffsets(count: number, stepX: number): Vec2[] {
  if (count === 1) return [{ x: 0, y: 0 }];
  const radius = Math.max(stepX, (count * stepX) / (2 * Math.PI));
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * 2 * Math.PI;
    out.push({ x: radius * Math.cos(ang), y: radius * Math.sin(ang) });
  }
  return out;
}

/** A spearhead: rows of 1, 2, 3, … widening behind a tip that points +y (before rotation). */
function wedgeOffsets(count: number, stepX: number, stepY: number): Vec2[] {
  const rows: number[] = [];
  let remaining = count;
  let k = 0;
  while (remaining > 0) {
    const w = Math.min(k + 1, remaining);
    rows.push(w);
    remaining -= w;
    k++;
  }
  const R = rows.length;
  const out: Vec2[] = [];
  rows.forEach((w, kk) => {
    const y = (R - 1 - kk) * stepY; // tip (kk=0) is at the front (+y); recentred below
    for (let j = 0; j < w; j++) out.push({ x: (j - (w - 1) / 2) * stepX, y });
  });
  // Recentre on the model centroid so the anchor sits at the unit's middle (rows have
  // unequal counts, so the geometric row-centre isn't the centroid).
  const meanY = out.reduce((s, p) => s + p.y, 0) / out.length;
  return out.map((p) => ({ x: p.x, y: p.y - meanY }));
}
