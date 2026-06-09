import { describe, it, expect } from 'vitest';
import { layouts } from '../src/data/loaders';
import type { Vec2 } from '../src/core/types';

// The GW Chapter Approved 2025-26 maps extracted from labrador.dev (tools/layouts/extract-gw-ca-2025.ts).
const ca = layouts.filter((l) => l.id.startsWith('ca2025-'));
const key = (p: Vec2) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
const partner = (p: Vec2): Vec2 => ({ x: 60 - p.x, y: 44 - p.y }); // 180° about board centre

describe('GW Chapter Approved 2025-26 layouts', () => {
  it('has 48 maps — 6 Strike Force deployments × 8 terrain layouts', () => {
    expect(ca.length).toBe(48);
    const deployments = [...new Set(ca.map((l) => l.deployment))].sort();
    expect(deployments).toEqual([
      'Crucible of Battle',
      'Dawn of War',
      'Hammer and Anvil',
      'Search and Destroy',
      'Sweeping Engagement',
      'Tipping Point',
    ]);
    // Each deployment has terrain layouts 1..8.
    for (const dep of deployments) {
      const ns = ca.filter((l) => l.deployment === dep).map((l) => l.id.match(/-(\d)$/)?.[1]);
      expect(new Set(ns)).toEqual(new Set(['1', '2', '3', '4', '5', '6', '7', '8']));
    }
  });

  it('every map is a 60×44 board with 5 objectives and two ≥3-vertex zones', () => {
    for (const l of ca) {
      expect(l.boardWidth, l.id).toBe(60);
      expect(l.boardHeight, l.id).toBe(44);
      expect(l.objectives.length, l.id).toBe(5);
      expect(l.deploymentZones.player.length, l.id).toBeGreaterThanOrEqual(3);
      expect(l.deploymentZones.opponent.length, l.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('every objective is a 40mm marker with a 3" control range', () => {
    for (const l of ca) {
      expect(l.objectiveControlRadiusIn, l.id).toBe(3);
      expect(l.objectiveMarkerDiameterIn ?? 0, l.id).toBeCloseTo(40 / 25.4, 2);
    }
  });

  it('terrain pieces are on-board 4-corner footprints, grey (ruin) or blue (area) only', () => {
    for (const l of ca) {
      expect(l.terrain.length, l.id).toBeGreaterThan(0);
      for (const t of l.terrain) {
        expect(t.polygon.length, `${l.id}/${t.id}`).toBe(4);
        expect(['ruin_blocking', 'area_cover'], `${l.id}/${t.id}`).toContain(t.type);
        // grey ⇒ tall, blue ⇒ low.
        expect(t.height, `${l.id}/${t.id}`).toBe(t.type === 'ruin_blocking' ? 'tall' : 'low');
        for (const p of t.polygon) {
          expect(p.x, `${l.id}/${t.id}`).toBeGreaterThanOrEqual(-0.8);
          expect(p.x, `${l.id}/${t.id}`).toBeLessThanOrEqual(60.8);
          expect(p.y, `${l.id}/${t.id}`).toBeGreaterThanOrEqual(-0.8);
          expect(p.y, `${l.id}/${t.id}`).toBeLessThanOrEqual(44.8);
        }
      }
    }
  });

  it('terrain and objectives have 180° rotational symmetry about the board centre', () => {
    for (const l of ca) {
      const corners = new Set<string>();
      for (const t of l.terrain) for (const p of t.polygon) corners.add(key(p));
      for (const t of l.terrain)
        for (const p of t.polygon) expect(corners.has(key(partner(p))), `${l.id}/${t.id}`).toBe(true);

      const objs = new Set(l.objectives.map(key));
      for (const o of l.objectives) expect(objs.has(key(partner(o))), l.id).toBe(true);
    }
  });

  it('the 8 terrain layouts are shared across deployments (same terrain, different zones/objectives)', () => {
    // Crucible vs Hammer-and-Anvil, terrain layout 1, must have identical terrain footprints…
    const crucible1 = ca.find((l) => l.id === 'ca2025-crucible-of-battle-1')!;
    const hammer1 = ca.find((l) => l.id === 'ca2025-hammer-and-anvil-1')!;
    const footprints = (l: typeof crucible1) =>
      l.terrain.map((t) => t.polygon.map(key).sort().join('|')).sort();
    expect(footprints(crucible1)).toEqual(footprints(hammer1));
    // …but different deployment zones.
    expect(crucible1.deploymentZones.player).not.toEqual(hammer1.deploymentZones.player);
  });
});
