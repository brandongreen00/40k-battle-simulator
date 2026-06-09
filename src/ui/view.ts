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

export const TERRAIN_STYLE: Record<TerrainType, { fill: string; stroke: string; label: string }> = {
  ruin_blocking: { fill: 'rgba(120, 90, 70, 0.55)', stroke: '#8a6a52', label: 'Ruin (blocks LoS)' },
  area_cover: { fill: 'rgba(70, 120, 70, 0.40)', stroke: '#5a8a5a', label: 'Area (cover)' },
  obstacle: { fill: 'rgba(140, 120, 60, 0.55)', stroke: '#a89436', label: 'Obstacle' },
};

export const OWNER_COLOR: Record<'player' | 'ai', { fill: string; stroke: string }> = {
  player: { fill: '#3b82f6', stroke: '#bfdbfe' },
  ai: { fill: '#ef4444', stroke: '#fecaca' },
};
