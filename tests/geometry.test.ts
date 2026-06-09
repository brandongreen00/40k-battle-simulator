import { describe, it, expect } from 'vitest';
import {
  mmToInches,
  dist,
  baseToBaseGap,
  baseRadius,
  gapBetweenBases,
  pointInPolygon,
  add,
  sub,
  scale,
  length,
} from '../src/core/geometry';
import type { BaseShape, Vec2 } from '../src/core/types';

describe('mmToInches', () => {
  it('converts a 32mm base to ~1.26"', () => {
    expect(mmToInches(32)).toBeCloseTo(1.2598, 4);
  });
});

describe('dist', () => {
  it('is the Euclidean centre-to-centre distance', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe('baseToBaseGap', () => {
  // CLAUDE.md acceptance criterion: two 32mm bases 2" apart centre-to-centre
  // report ~0.74" gap, NOT 2".
  it('reports ~0.74" between two 32mm bases 2" apart (centre-to-centre)', () => {
    const r = mmToInches(32) / 2; // 32mm base radius in inches
    const gap = baseToBaseGap({ x: 0, y: 0 }, r, { x: 2, y: 0 }, r);
    expect(gap).toBeCloseTo(0.74, 2);
    expect(gap).not.toBeCloseTo(2, 1);
  });

  it('clamps to 0 when bases overlap', () => {
    expect(baseToBaseGap({ x: 0, y: 0 }, 1, { x: 1, y: 0 }, 1)).toBe(0);
  });

  it('equals centre distance minus both radii when apart', () => {
    expect(baseToBaseGap({ x: 0, y: 0 }, 0.5, { x: 10, y: 0 }, 0.5)).toBeCloseTo(9, 6);
  });
});

describe('baseRadius', () => {
  it('returns the radius for a circle', () => {
    const c: BaseShape = { kind: 'circle', radius: 0.63 };
    expect(baseRadius(c)).toBe(0.63);
  });

  it('approximates an oval by its average semi-axis', () => {
    const o: BaseShape = { kind: 'oval', rx: 1.18, ry: 0.69 }; // ~60x35mm
    expect(baseRadius(o)).toBeCloseTo((1.18 + 0.69) / 2, 6);
  });

  it('throws when a circle is missing its radius', () => {
    expect(() => baseRadius({ kind: 'circle' })).toThrow();
  });
});

describe('gapBetweenBases', () => {
  it('uses each shape radius', () => {
    const a: BaseShape = { kind: 'circle', radius: 0.5 };
    const b: BaseShape = { kind: 'circle', radius: 0.5 };
    expect(gapBetweenBases({ x: 0, y: 0 }, a, { x: 3, y: 0 }, b)).toBeCloseTo(2, 6);
  });
});

describe('pointInPolygon', () => {
  const square: Vec2[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];

  it('detects an interior point', () => {
    expect(pointInPolygon({ x: 2, y: 2 }, square)).toBe(true);
  });

  it('rejects an exterior point', () => {
    expect(pointInPolygon({ x: 5, y: 2 }, square)).toBe(false);
    expect(pointInPolygon({ x: -1, y: -1 }, square)).toBe(false);
  });

  it('handles a concave (L-shaped) polygon', () => {
    const lShape: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(pointInPolygon({ x: 1, y: 3 }, lShape)).toBe(true); // in the tall arm
    expect(pointInPolygon({ x: 3, y: 3 }, lShape)).toBe(false); // in the notch
  });
});

describe('vector helpers', () => {
  it('add / sub / scale / length', () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(sub({ x: 3, y: 4 }, { x: 1, y: 2 })).toEqual({ x: 2, y: 2 });
    expect(scale({ x: 2, y: -3 }, 2)).toEqual({ x: 4, y: -6 });
    expect(length({ x: 3, y: 4 })).toBe(5);
  });
});
