import { describe, it, expect } from 'vitest';
import {
  FORMATIONS,
  formationPositions,
  nextFormation,
  type Formation,
} from '../src/core/formation';
import type { BaseShape } from '../src/core/types';
import { dist } from '../src/core/geometry';

const circle: BaseShape = { kind: 'circle', radius: 0.5 }; // 32mm-ish

describe('nextFormation', () => {
  it('cycles through every formation and wraps', () => {
    const seen: Formation[] = [];
    let f = FORMATIONS[0]!;
    for (let i = 0; i < FORMATIONS.length; i++) {
      seen.push(f);
      f = nextFormation(f);
    }
    expect(seen).toEqual(FORMATIONS);
    expect(f).toBe(FORMATIONS[0]); // wrapped back to the start
  });
});

describe('formationPositions', () => {
  const opts = (formation: Formation, count: number, rotation = 0) => ({
    anchor: { x: 30, y: 22 },
    count,
    baseShape: circle,
    formation,
    rotation,
  });

  it('returns exactly `count` positions for every formation', () => {
    for (const f of FORMATIONS) {
      expect(formationPositions(opts(f, 7))).toHaveLength(7);
    }
  });

  it('handles edge counts (0 and 1) without throwing', () => {
    for (const f of FORMATIONS) {
      expect(formationPositions(opts(f, 0))).toHaveLength(0);
      expect(formationPositions(opts(f, 1))).toHaveLength(1);
    }
  });

  it('centres each formation on the anchor (centroid ≈ anchor)', () => {
    for (const f of FORMATIONS) {
      const ps = formationPositions(opts(f, 6));
      const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
      const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
      expect(cx).toBeCloseTo(30, 6);
      expect(cy).toBeCloseTo(22, 6);
    }
  });

  it('strings a line out wider than a block of the same unit', () => {
    const span = (f: Formation) => {
      const ps = formationPositions(opts(f, 10));
      const xs = ps.map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span('line')).toBeGreaterThan(span('block'));
  });

  it('lays a column out as a single file (all x equal)', () => {
    const ps = formationPositions(opts('column', 5));
    const xs = ps.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0, 6);
  });

  it('spaces a circle so adjacent bases do not overlap', () => {
    const ps = formationPositions(opts('circle', 8));
    for (let i = 0; i < ps.length; i++) {
      const next = ps[(i + 1) % ps.length]!;
      // adjacent centres at least a base diameter apart (2 * radius)
      expect(dist(ps[i]!, next)).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('rotating a line by 90° turns it into a column', () => {
    const line = formationPositions(opts('line', 4));
    const rotated = formationPositions(opts('line', 4, Math.PI / 2));
    // x-spread of the unrotated line equals the y-spread after a quarter turn
    const spreadX = Math.max(...line.map((p) => p.x)) - Math.min(...line.map((p) => p.x));
    const spreadYr = Math.max(...rotated.map((p) => p.y)) - Math.min(...rotated.map((p) => p.y));
    expect(spreadYr).toBeCloseTo(spreadX, 6);
    // and the rotated line is now a single column (x all equal)
    const xs = rotated.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0, 6);
  });
});
