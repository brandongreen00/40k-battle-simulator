// Line of sight vs engagement (owner report 2026-08-07): an engaged Eversor had ZERO valid
// pistol targets because a terrain-area edge sliced between the two models' CENTRE points —
// its base overlapped the area but the centre-only "within" test refused the see-out carve-out.
// Fixes under test: (1) a unit you are in Engagement Range of is always visible; (2) a base
// overlapping an area/feature counts as within it for the see-out carve-outs.
import { describe, it, expect } from 'vitest';
import type { GameState, Side, UnitInstance } from '../src/core/types';
import { createInitialState, reduce } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { engagedEnemies, validUnitShootingTargets } from '../src/core/phases';
import { losBlocked11 } from '../src/core/visibility';
import { datasheetsById, layoutsCp } from '../src/data/loaders';

const ctx = { datasheets: datasheetsById };
let seq = 0;
const mkUnit = (owner: Side, dsId: string, pos: { x: number; y: number }): UnitInstance => {
  const ds = datasheetsById.get(dsId)!;
  return {
    id: `q${++seq}`,
    owner,
    datasheetId: dsId,
    models: [{ id: `q${seq}m0`, unitId: `q${seq}`, pos, wounds: ds.models[0]!.W, alive: true }],
    startingModels: 1,
    status: {},
  };
};
const mkState = (units: UnitInstance[], li: number): GameState => ({
  ...createInitialState(layoutsCp[li]!),
  stage: 'battle',
  mode: 'match',
  battleType: 'combat_patrol',
  round: 2,
  activePlayer: 'player',
  firstPlayer: 'player',
  units,
  phase: 'shooting',
});

describe('engaged units are always shootable (close-quarters)', () => {
  it('no engaged position on any CP map has zero pistol targets (the owner-reported class)', () => {
    const EV = 'cp-inquisitors-hand-eversor-assassin';
    const fails: string[] = [];
    for (let li = 0; li < 3; li++) {
      for (let x = 2; x <= 28; x += 1) {
        for (let y = 2; y <= 42; y += 1) {
          for (const tgt of ['cp-sudden-dawn-cadre-commander-cloudspear', 'cp-sudden-dawn-cadre-devilfish']) {
            const ev = mkUnit('player', EV, { x, y });
            const foe = mkUnit('ai', tgt, { x: x + 1.9, y });
            const s = mkState([ev, foe], li);
            if (engagedEnemies(ev, s, ctx).length === 0) continue;
            if (validUnitShootingTargets(ev, s, ctx).length === 0) fails.push(`map${li} (${x},${y}) vs ${tgt}`);
          }
        }
      }
    }
    expect(fails, fails.slice(0, 5).join('; ')).toEqual([]);
  });

  it('the engaged pistol shot RESOLVES (the target filter and the dice path agree)', () => {
    // Map 0 area CD spans (2.5,2.5)-(14,10): put the sightline on its y=10 boundary — the
    // exact geometry that used to report "no line of sight" at base contact.
    const ev = mkUnit('player', 'cp-inquisitors-hand-eversor-assassin', { x: 2, y: 10 });
    const foe = mkUnit('ai', 'cp-sudden-dawn-cadre-commander-cloudspear', { x: 3.9, y: 10 });
    let s: GameState = { ...mkState([ev, foe], 0), phase: 'Shooting' };
    expect(validUnitShootingTargets(ev, s, ctx).map((u) => u.id)).toEqual([foe.id]);
    s = reduce(s, { type: 'ShootUnit', attackerUnitId: ev.id, targetUnitId: foe.id }, makeRNG(1), ctx);
    expect(s.log.join('\n')).not.toContain('no line of sight');
    expect(s.units.find((u) => u.id === ev.id)!.status.hasShot).toBe(true);
  });
});

describe('a base overlapping terrain sees out of it', () => {
  it('centre just outside an obscuring area: blocked with no radius, clear with the base radius', () => {
    // A model standing ON an area's edge (centre 0.3" outside, 0.63" base overlapping it)
    // shoots across the area at a target beyond the far edge.
    const layout = {
      ...layoutsCp[0]!,
      terrain: [],
      terrainAreas: [
        { id: 'a', polygon: [{ x: 2, y: 2 }, { x: 12, y: 2 }, { x: 12, y: 10 }, { x: 2, y: 10 }], features: [{ kind: 'light' as const, polygon: [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }] }] },
      ],
    };
    const a = { x: 8, y: 10.3 };
    const b = { x: 8, y: 1 };
    expect(losBlocked11(a, b, layout, 0, 0)).toBe(true); // centre-only: "outside", sight across → blocked
    expect(losBlocked11(a, b, layout, 0.63, 0)).toBe(false); // the base overlaps the area → within → sees out
  });
});
