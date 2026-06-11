// Board viewport (zoom/pan) math. PURE — no React, no DOM.
//
// The board SVG always renders the full battlefield in board pixels (inches × 12); zooming and
// panning only change the SVG viewBox window. These helpers keep that window valid: aspect-locked
// to the board, never larger than the board, never panned off it.

export interface BoardView {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_ZOOM = 8; // the viewBox can shrink to 1/8th of the board width

export function fullView(boardWpx: number, boardHpx: number): BoardView {
  return { x: 0, y: 0, w: boardWpx, h: boardHpx };
}

export function isFullView(v: BoardView, boardWpx: number): boolean {
  return v.w >= boardWpx - 1e-6;
}

/** Current zoom factor (1 = whole board visible). */
export function zoomOf(v: BoardView, boardWpx: number): number {
  return boardWpx / v.w;
}

/** Clamp a view to the board: aspect-locked size within [board/MAX_ZOOM, board], position inside. */
export function clampView(v: BoardView, boardWpx: number, boardHpx: number): BoardView {
  const w = Math.min(boardWpx, Math.max(boardWpx / MAX_ZOOM, v.w));
  const h = w * (boardHpx / boardWpx);
  const x = Math.min(Math.max(v.x, 0), boardWpx - w);
  const y = Math.min(Math.max(v.y, 0), boardHpx - h);
  return { x, y, w, h };
}

/** Zoom by `factor` (>1 zooms in) keeping the board point `at` fixed on screen. */
export function zoomAt(
  v: BoardView,
  at: { x: number; y: number },
  factor: number,
  boardWpx: number,
  boardHpx: number,
): BoardView {
  const w = v.w / factor;
  const h = v.h / factor;
  // Keep `at` at the same relative position inside the view.
  const rx = (at.x - v.x) / v.w;
  const ry = (at.y - v.y) / v.h;
  return clampView({ x: at.x - rx * w, y: at.y - ry * h, w, h }, boardWpx, boardHpx);
}

/** Pan by a delta in board pixels. */
export function panView(v: BoardView, dx: number, dy: number, boardWpx: number, boardHpx: number): BoardView {
  return clampView({ ...v, x: v.x + dx, y: v.y + dy }, boardWpx, boardHpx);
}

/** One pinch/two-finger update: previous + current positions of both pointers, in board px of the
 *  STARTING view. Returns the view that keeps the touched points under the fingers. */
export function pinchView(
  v: BoardView,
  a0: { x: number; y: number },
  b0: { x: number; y: number },
  a1: { x: number; y: number },
  b1: { x: number; y: number },
  boardWpx: number,
  boardHpx: number,
): BoardView {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y) || 1;
  const factor = d1 / d0;
  const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const mid1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  const zoomed = zoomAt(v, mid0, factor, boardWpx, boardHpx);
  // After zooming around mid0, pan so the midpoint follows the fingers.
  return panView(zoomed, mid0.x - mid1.x, mid0.y - mid1.y, boardWpx, boardHpx);
}
