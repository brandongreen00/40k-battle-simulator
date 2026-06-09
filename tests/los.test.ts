import { describe, it, expect } from 'vitest';
import { losBlocked, hasCover, segmentsIntersect, unitCanSee } from '../src/core/los';
import type { TerrainPiece } from '../src/core/types';

// A 10x10 tall ruin centred on (30,22).
const ruin: TerrainPiece = {
  id: 'r', type: 'ruin_blocking', height: 'tall',
  polygon: [{ x: 25, y: 17 }, { x: 35, y: 17 }, { x: 35, y: 27 }, { x: 25, y: 27 }],
};
const area: TerrainPiece = {
  id: 'a', type: 'area_cover', height: 'low',
  polygon: [{ x: 25, y: 17 }, { x: 35, y: 17 }, { x: 35, y: 27 }, { x: 25, y: 27 }],
};

describe('segmentsIntersect', () => {
  it('detects crossing and non-crossing', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 5 }, { x: 1, y: 5 })).toBe(false);
  });
});

describe('losBlocked', () => {
  it('blocks a sightline through a tall ruin', () => {
    expect(losBlocked({ x: 10, y: 22 }, { x: 50, y: 22 }, [ruin])).toBe(true);
  });
  it('allows a sightline that misses the ruin', () => {
    expect(losBlocked({ x: 10, y: 5 }, { x: 50, y: 5 }, [ruin])).toBe(false);
  });
  it('carve-out: a model inside the ruin can see out', () => {
    expect(losBlocked({ x: 30, y: 22 }, { x: 50, y: 22 }, [ruin])).toBe(false);
  });
  it('low area terrain never blocks LoS', () => {
    expect(losBlocked({ x: 10, y: 22 }, { x: 50, y: 22 }, [area])).toBe(false);
  });
});

describe('hasCover', () => {
  it('grants cover when the target stands in area terrain', () => {
    expect(hasCover({ x: 10, y: 22 }, { x: 30, y: 22 }, [area])).toBe(true);
  });
  it('grants cover when the firing line clips intervening terrain', () => {
    expect(hasCover({ x: 10, y: 22 }, { x: 50, y: 22 }, [area])).toBe(true);
  });
  it('no cover on a clear line', () => {
    expect(hasCover({ x: 10, y: 5 }, { x: 50, y: 5 }, [area])).toBe(false);
  });
});

describe('unitCanSee', () => {
  it('is true if any model pair has LoS', () => {
    expect(unitCanSee([{ x: 10, y: 22 }, { x: 10, y: 5 }], [{ x: 50, y: 5 }], [ruin])).toBe(true);
  });
  it('is false if every line is blocked', () => {
    expect(unitCanSee([{ x: 10, y: 22 }], [{ x: 50, y: 22 }], [ruin])).toBe(false);
  });
});
