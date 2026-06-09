import { describe, it, expect } from 'vitest';
import { checkCoherency } from '../src/core/coherency';
import {
  checkUnitDeployment,
  deepStrikeArrivalLegal,
  deployAbilityFromKeywords,
  inOwnZone,
} from '../src/core/deployment';
import { canAttach, eligibleLeaderIds, eligibleBodyguardIds } from '../src/core/leaders';
import { distancePointToPolygon, distancePointToSegment, clampToRange } from '../src/core/geometry';
import type { BaseShape, Datasheet, Layout, Vec2 } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 }; // 25mm-ish

// A 60x44 board; player owns the left 12" strip, ai the right 12" strip (Hammer-and-Anvil-ish).
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: {
    player: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 44 }, { x: 0, y: 44 }],
    opponent: [{ x: 48, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 44 }, { x: 48, y: 44 }],
  },
};

describe('coherency', () => {
  it('a single model is always in coherency', () => {
    expect(checkCoherency([{ x: 5, y: 5 }], circle).inCoherency).toBe(true);
  });

  it('two models within 2" base-to-base are coherent; far apart are not', () => {
    // 0.5" radii: centres 2.5" apart -> gap 1.5" (<=2): coherent.
    expect(checkCoherency([{ x: 0, y: 0 }, { x: 2.5, y: 0 }], circle).inCoherency).toBe(true);
    // centres 5" apart -> gap 4" (>2): not coherent.
    const far = checkCoherency([{ x: 0, y: 0 }, { x: 5, y: 0 }], circle);
    expect(far.inCoherency).toBe(false);
    expect(far.outOfCoherency).toEqual([0, 1]);
  });

  it('flags a detached cluster even when each model has a close neighbour', () => {
    // Two pairs, each pair internally tight, but the pairs are 10" apart -> not a single group.
    const r = checkCoherency(
      [{ x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 20, y: 0 }, { x: 21.5, y: 0 }],
      circle,
    );
    expect(r.connected).toBe(false);
    expect(r.inCoherency).toBe(false);
  });

  it('requires two neighbours for units of 7+ models', () => {
    // A 7-model line: adjacent centres 2.9" apart -> gap 1.9" (<=2, neighbours), but the
    // next-but-one neighbour is 4.8" away (>2). So interior models have 2 neighbours; the ENDS have 1.
    const line: Vec2[] = Array.from({ length: 7 }, (_, i) => ({ x: i * 2.9, y: 0 }));
    const r = checkCoherency(line, circle);
    expect(r.required).toBe(2);
    // End models (index 0 and 6) only have one neighbour within 2".
    expect(r.outOfCoherency).toContain(0);
    expect(r.outOfCoherency).toContain(6);
    expect(r.inCoherency).toBe(false);
  });
});

describe('deployment zones', () => {
  it('accepts a unit wholly inside its own zone, rejects one straying out', () => {
    const inside = [{ x: 3, y: 10 }, { x: 5, y: 12 }];
    expect(checkUnitDeployment(inside, circle, layout, 'player', 'standard').legal).toBe(true);

    const straying = [{ x: 3, y: 10 }, { x: 20, y: 12 }]; // second model past the 12" line
    const r = checkUnitDeployment(straying, circle, layout, 'player', 'standard');
    expect(r.legal).toBe(false);
    expect(r.perModel).toEqual([true, false]);
  });

  it('inOwnZone is true everywhere when the zone polygon is empty (sandbox maps)', () => {
    const bare: Layout = { ...layout, deploymentZones: { player: [], opponent: [] } };
    expect(inOwnZone({ x: 30, y: 22 }, bare, 'player')).toBe(true);
  });

  it('Infiltrators may deploy outside the zone but not within 9" of the enemy zone', () => {
    // Midfield, well clear of the enemy zone (which starts at x=48): legal.
    const mid = checkUnitDeployment([{ x: 30, y: 22 }], circle, layout, 'player', 'infiltrators');
    expect(mid.legal).toBe(true);
    // Hugging the enemy zone edge (x=45 is 3" from x=48): illegal.
    const close = checkUnitDeployment([{ x: 45, y: 22 }], circle, layout, 'player', 'infiltrators');
    expect(close.legal).toBe(false);
  });
});

describe('deep strike arrival', () => {
  const enemies = [{ pos: { x: 30, y: 22 }, shape: circle }];
  it('is illegal in round 1, legal in round 2+ when > 9" from all enemies', () => {
    expect(deepStrikeArrivalLegal([{ x: 10, y: 22 }], circle, enemies, 1).legal).toBe(false);
    expect(deepStrikeArrivalLegal([{ x: 10, y: 22 }], circle, enemies, 2).legal).toBe(true);
    // 5" away from the enemy at round 2 -> too close.
    expect(deepStrikeArrivalLegal([{ x: 25, y: 22 }], circle, enemies, 2).legal).toBe(false);
  });
});

describe('deploy ability from keywords', () => {
  it('detects Infiltrators and Deep Strike', () => {
    expect(deployAbilityFromKeywords([], ['Infiltrators'])).toBe('infiltrators');
    expect(deployAbilityFromKeywords([], ['Deep Strike'])).toBe('deep_strike');
    expect(deployAbilityFromKeywords(['Infantry'], [])).toBe('standard');
  });
});

describe('leaders', () => {
  const rogueTrader: Datasheet = {
    id: 'rt', name: 'Rogue Trader', faction: 'AoI', models: [], weapons: [],
    baseShape: circle, keywords: ['Character', 'Infantry'], abilityIds: [], canLead: ['breach'],
  };
  const breachers: Datasheet = {
    id: 'breach', name: 'Imperial Navy Breachers', faction: 'AoI', models: [], weapons: [],
    baseShape: circle, keywords: ['Battleline', 'Infantry'], abilityIds: [], canBeLedBy: ['rt'],
  };
  const tank: Datasheet = {
    id: 'tank', name: 'Leman Russ', faction: 'AM', models: [], weapons: [],
    baseShape: circle, keywords: ['Vehicle'], abilityIds: [],
  };
  const all = new Map<string, Datasheet>([['rt', rogueTrader], ['breach', breachers], ['tank', tank]]);

  it('a Rogue Trader can lead Imperial Navy Breachers', () => {
    expect(canAttach(rogueTrader, breachers)).toBe(true);
  });
  it('a non-character cannot lead, and you cannot lead a non-paired unit', () => {
    expect(canAttach(breachers, rogueTrader)).toBe(false); // breachers aren't a Character
    expect(canAttach(rogueTrader, tank)).toBe(false); // not paired
  });
  it('eligibility lookups resolve both directions of the pairing', () => {
    expect(eligibleBodyguardIds(rogueTrader, all)).toContain('breach');
    expect(eligibleLeaderIds(breachers, all)).toContain('rt');
    expect(eligibleLeaderIds(tank, all)).toHaveLength(0);
  });
});

describe('geometry additions', () => {
  it('distancePointToSegment handles the perpendicular and endpoint cases', () => {
    expect(distancePointToSegment({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeCloseTo(1);
    expect(distancePointToSegment({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeCloseTo(1);
  });
  it('distancePointToPolygon is 0 inside and the edge distance outside', () => {
    const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    expect(distancePointToPolygon({ x: 2, y: 2 }, sq)).toBe(0);
    expect(distancePointToPolygon({ x: 6, y: 2 }, sq)).toBeCloseTo(2);
  });
  it('clampToRange caps the distance but keeps direction', () => {
    const p = clampToRange({ x: 0, y: 0 }, { x: 10, y: 0 }, 6);
    expect(p).toEqual({ x: 6, y: 0 });
    expect(clampToRange({ x: 0, y: 0 }, { x: 3, y: 0 }, 6)).toEqual({ x: 3, y: 0 });
  });
});
