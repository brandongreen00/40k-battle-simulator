// View constants + board<->screen transforms. Board coords are in INCHES with origin
// bottom-left (rule #5); SVG's origin is top-left, so Y is flipped on the way to pixels.

import type { TerrainType, Vec2 } from '../core/types';

/** Single source of truth for board scale. */
export const INCH_TO_PX = 12;

export function pxX(xInches: number): number {
  return xInches * INCH_TO_PX;
}

/** Flip Y so inch-origin (bottom-left) maps to SVG-origin (top-left). */
export function pxY(yInches: number, boardHeight: number): number {
  return (boardHeight - yInches) * INCH_TO_PX;
}

export function pxLen(inches: number): number {
  return inches * INCH_TO_PX;
}

/** Convert a polygon of inch-coords to an SVG `points` attribute string. */
export function polygonPoints(poly: Vec2[], boardHeight: number): string {
  return poly.map((p) => `${pxX(p.x)},${pxY(p.y, boardHeight)}`).join(' ');
}

// Colors follow the GW / labrador convention: grey = tall ruin that blocks line of sight,
// blue = terrain ≤2" high (area / cover).
export const TERRAIN_STYLE: Record<TerrainType, { fill: string; stroke: string; label: string }> = {
  ruin_blocking: { fill: 'rgba(120, 124, 128, 0.62)', stroke: '#5c6061', label: 'Ruin — tall, blocks LoS (grey)' },
  area_cover: { fill: 'rgba(96, 170, 210, 0.38)', stroke: '#2f7da5', label: 'Area terrain — ≤2" (blue)' },
  obstacle: { fill: 'rgba(140, 120, 60, 0.55)', stroke: '#a89436', label: 'Obstacle' },
};

export const OWNER_COLOR: Record<'player' | 'ai', { fill: string; stroke: string }> = {
  player: { fill: '#3b82f6', stroke: '#bfdbfe' },
  ai: { fill: '#ef4444', stroke: '#fecaca' },
};
