// Board viewport (zoom/pan/pinch) math — the seam behind the mobile pinch-zoom board.
import { describe, it, expect } from 'vitest';
import { clampView, fullView, isFullView, panView, pinchView, zoomAt, zoomOf, MAX_ZOOM } from '../src/ui/boardView';

const W = 720; // 60" board in px
const H = 528; // 44"

describe('board view math', () => {
  it('full view covers the whole board and reports zoom 1', () => {
    const v = fullView(W, H);
    expect(v).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(isFullView(v, W)).toBe(true);
    expect(zoomOf(v, W)).toBe(1);
  });

  it('clamp keeps the window aspect-locked, on-board, and within zoom limits', () => {
    // too small (over max zoom) -> clamped to W/MAX_ZOOM
    const tiny = clampView({ x: 0, y: 0, w: 1, h: 1 }, W, H);
    expect(tiny.w).toBeCloseTo(W / MAX_ZOOM, 5);
    expect(tiny.h / tiny.w).toBeCloseTo(H / W, 5);
    // panned off the right edge -> pulled back on
    const off = clampView({ x: 10_000, y: -50, w: 360, h: 264 }, W, H);
    expect(off.x).toBeCloseTo(W - 360, 5);
    expect(off.y).toBe(0);
    // larger than the board -> the full board
    const big = clampView({ x: -10, y: -10, w: 5000, h: 5000 }, W, H);
    expect(big).toEqual(fullView(W, H));
  });

  it('zoomAt keeps the anchor point fixed in the window', () => {
    const v0 = fullView(W, H);
    const at = { x: 180, y: 132 }; // quarter point
    const v1 = zoomAt(v0, at, 2, W, H);
    expect(zoomOf(v1, W)).toBeCloseTo(2, 5);
    // relative position of `at` inside the window is unchanged (was 25%/25%)
    expect((at.x - v1.x) / v1.w).toBeCloseTo(0.25, 5);
    expect((at.y - v1.y) / v1.h).toBeCloseTo(0.25, 5);
  });

  it('zooming out from full view stays the full view', () => {
    const v = zoomAt(fullView(W, H), { x: 360, y: 264 }, 1 / 2, W, H);
    expect(v).toEqual(fullView(W, H));
  });

  it('pan moves the window and clamps at the edges', () => {
    const v0 = zoomAt(fullView(W, H), { x: 360, y: 264 }, 2, W, H);
    const v1 = panView(v0, 50, -20, W, H);
    expect(v1.x).toBeCloseTo(v0.x + 50, 5);
    expect(v1.y).toBeCloseTo(v0.y - 20, 5);
    const v2 = panView(v0, 1e6, 1e6, W, H);
    expect(v2.x).toBeCloseTo(W - v0.w, 5);
    expect(v2.y).toBeCloseTo(H - v0.h, 5);
  });

  it('pinch: fingers moving apart zoom in around their midpoint', () => {
    const v0 = fullView(W, H);
    const a0 = { x: 300, y: 264 };
    const b0 = { x: 420, y: 264 }; // 120 apart, mid (360,264)
    const a1 = { x: 240, y: 264 };
    const b1 = { x: 480, y: 264 }; // 240 apart -> 2x zoom
    const v1 = pinchView(v0, a0, b0, a1, b1, W, H);
    expect(zoomOf(v1, W)).toBeCloseTo(2, 5);
    // midpoint did not move between the finger pairs -> it stays centred where it was
    expect(v1.x).toBeCloseTo(360 - 0.5 * v1.w, 5);
  });

  it('pinch: fingers moving together (same distance) pans the window', () => {
    const v0 = zoomAt(fullView(W, H), { x: 360, y: 264 }, 2, W, H);
    const a0 = { x: 300, y: 200 };
    const b0 = { x: 420, y: 200 };
    const shift = { x: -40, y: 25 }; // both fingers move the same way -> view pans opposite
    const v1 = pinchView(v0, a0, b0, { x: a0.x + shift.x, y: a0.y + shift.y }, { x: b0.x + shift.x, y: b0.y + shift.y }, W, H);
    expect(zoomOf(v1, W)).toBeCloseTo(2, 5);
    expect(v1.x).toBeCloseTo(v0.x - shift.x, 5);
    expect(v1.y).toBeCloseTo(v0.y - shift.y, 5);
  });
});
