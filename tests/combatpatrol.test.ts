// Combat Patrol: the four extracted patrols, the three 30"×44" maps, and the deployment flow.
import { describe, it, expect } from 'vitest';
import type { Roster } from '../src/core/types';
import { distancePointToPolygon, pointInPolygon } from '../src/core/geometry';
import { parseTransportCapacity } from '../src/core/transport';
import { runMatch, type MatchData } from '../src/core/ai/match';
import {
  datasheets,
  datasheetsById,
  deployAbilityForDatasheet,
  layoutsCp,
  patrols,
  rosters,
  stratagems,
} from '../src/data/loaders';

const cpDatasheets = datasheets.filter((d) => d.patrol);
const cpRosters = rosters.filter((r) => r.combatPatrol);
const byName = (n: string) => cpDatasheets.find((d) => d.name === n)!;

const data: MatchData = {
  ctx: { datasheets: datasheetsById },
  deployAbility: deployAbilityForDatasheet,
  stratagems,
};

describe('combat patrol maps (data/layouts_cp)', () => {
  it('loads the three 30"×44" maps with the full terrain set', () => {
    expect(layoutsCp).toHaveLength(3);
    for (const l of layoutsCp) {
      expect(l.combatPatrol).toBe(true);
      expect([l.boardWidth, l.boardHeight]).toEqual([30, 44]);
      // The CP terrain set: 2× 11.5"×7.5" ruins + 4× 6"×4" mats + 4× 6"×2" plates.
      expect(l.terrainAreas).toHaveLength(10);
      const dims = l.terrainAreas!
        .map((a) => {
          const xs = a.polygon.map((p) => p.x);
          const ys = a.polygon.map((p) => p.y);
          const w = Math.max(...xs) - Math.min(...xs);
          const h = Math.max(...ys) - Math.min(...ys);
          return [Math.min(w, h), Math.max(w, h)].map((v) => Math.round(v * 4) / 4).join('x');
        })
        .sort();
      expect(dims).toEqual(['2x6', '2x6', '2x6', '2x6', '4x6', '4x6', '4x6', '4x6', '7.5x11.5', '7.5x11.5']);
      // The four lettered ruins the missions reference.
      const letters = l.terrainAreas!.map((a) => a.letter).filter(Boolean).sort();
      expect(letters).toEqual(['AB', 'CD', 'EF', 'GH']);
      // 2 home objectives (attacker + defender) + 2 expansion objectives, all area-bound.
      const objs = l.objectivePoints ?? [];
      expect(objs).toHaveLength(4);
      expect(objs.filter((o) => o.kind === 'home').map((o) => o.owner).sort()).toEqual(['attacker', 'defender']);
      expect(objs.filter((o) => o.kind === 'expansion')).toHaveLength(2);
      for (const o of objs) expect(o.areaId).toBeTruthy();
      // Deployment zones present, non-degenerate, on the board; divider present.
      for (const zone of [l.deploymentZones.player, l.deploymentZones.opponent]) {
        expect(zone.length).toBeGreaterThanOrEqual(3);
        for (const p of zone) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(30);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(44);
        }
      }
      expect(l.territoryDivider).toBeTruthy();
      expect(l.dividerMarkers).toHaveLength(2);
      // Home objectives sit in (or hard against — the icon marks a whole terrain area, which
      // can straddle the zone edge on map 2) their side's zone. Attacker loads under `player`.
      const inOrNear = (owner: string, zone: (typeof l.deploymentZones)['player']) => {
        const pos = objs.find((o) => o.kind === 'home' && o.owner === owner)!.pos;
        return pointInPolygon(pos, zone) || distancePointToPolygon(pos, zone) <= 1.5;
      };
      expect(inOrNear('attacker', l.deploymentZones.player)).toBe(true);
      expect(inOrNear('defender', l.deploymentZones.opponent)).toBe(true);
    }
  });

  it('map 3 has the corner-to-corner divider; maps 1–2 divide at mid-board', () => {
    const [l1, l2, l3] = layoutsCp;
    expect(l1!.territoryDivider).toEqual([{ x: 0, y: 22 }, { x: 30, y: 22 }]);
    expect(l2!.territoryDivider).toEqual([{ x: 0, y: 22 }, { x: 30, y: 22 }]);
    expect(l3!.territoryDivider).toEqual([{ x: 0, y: 44 }, { x: 30, y: 0 }]);
  });
});

describe('combat patrol datasheets (data/game/cp_datasheets.json)', () => {
  it('loads 16 units across the four patrols', () => {
    expect(cpDatasheets).toHaveLength(16);
    expect(new Set(cpDatasheets.map((d) => d.patrol)).size).toBe(4);
    expect(patrols).toHaveLength(4);
  });

  it('keeps the transcribed anomalies (never "corrected" from prior-edition memory)', () => {
    // Bladeguard: the Sergeant is T3 while the Veterans are T4 — real, crop-verified.
    const blade = byName('Vengeful Brethren Bladeguard Veteran Squad');
    const tOf = (n: string) => blade.models.find((m) => m.name.includes(n))!.T;
    expect(tOf('Sergeant')).toBe(3);
    expect(tOf('Veteran')).toBe(4);
    // Psycannon is S8 in the app (prior editions said S7).
    const strike = byName("Crowe's Sanctifiers Strike Squad");
    const psycannon = strike.weapons.find((w) => w.name === 'Psycannon')!;
    expect(psycannon.S).toBe(8);
    expect(psycannon.skill).toBe(3);
    // Nemesis Force Weapon: A3 on the Strike Squad but A4 on the Terminators.
    const termis = byName("Crowe's Sanctifiers Brotherhood Terminator Squad");
    expect(strike.weapons.find((w) => w.name === 'Nemesis Force Weapon')!.attacks).toBe('3');
    expect(termis.weapons.find((w) => w.name === 'Nemesis Force Weapon')!.attacks).toBe('4');
    // Torrent weapons have no BS ("-") → skill 0, like the converted Wahapedia data.
    expect(strike.weapons.find((w) => w.name === 'Incinerator')!.skill).toBe(0);
    // Multi-profile weapons use the repo-wide "<base> – <profile>" convention.
    const hell = byName('Vengeful Brethren Hellblaster Squad');
    expect(hell.weapons.map((w) => w.name)).toContain('Plasma Incinerator – Standard');
    expect(hell.weapons.map((w) => w.name)).toContain('Plasma Incinerator – Supercharge');
  });

  it('parses base sizes, invulns, transport capacity and leader attachment', () => {
    expect(byName("Crowe's Sanctifiers Strike Squad").baseShape).toEqual({ kind: 'circle', radius: 0.6299 });
    expect(byName('Sanctifiers Castellan Crowe').models[0]!.invuln).toBe(4);
    expect(byName("Crowe's Sanctifiers Venerable Dreadnought").models[0]!.invuln).toBeUndefined();
    // Devilfish: "transport capacity of 12 Infantry models"; hull is the owner-measured
    // 17.5cm × 13cm rectangle (6.89" × 5.12"), stored as half-extents.
    const devilfish = byName('Sudden Dawn Cadre Devilfish');
    const cap = parseTransportCapacity(devilfish.transport!);
    expect(cap?.capacity).toBe(12);
    expect(devilfish.baseShape).toEqual({ kind: 'rect', rx: 3.4449, ry: 2.5591 });
    // Preacher Teguen attaches to the Inquisitorial Agents.
    const teguen = byName('Preacher Teguen');
    expect(teguen.canLead).toEqual(['cp-inquisitors-hand-inquisitorial-agents']);
  });

  it('stamps the Strike from the Warp mandatory-reserves rounds', () => {
    expect(byName("Crowe's Sanctifiers Brotherhood Terminator Squad").cpReserveRound).toBe(2);
    expect(byName("Crowe's Sanctifiers Venerable Dreadnought").cpReserveRound).toBe(3);
    expect(cpDatasheets.filter((d) => d.cpReserveRound).length).toBe(2);
  });
});

describe('combat patrol rosters (data/rosters/cp_*.json)', () => {
  it('all four fixed lists resolve every unit and carry weapon carrier counts', () => {
    expect(cpRosters).toHaveLength(4);
    for (const r of cpRosters) {
      expect(r.combatPatrol).toBe(true);
      expect(r.units).toHaveLength(4);
      for (const u of r.units) {
        const ds = datasheetsById.get(u.datasheetId);
        expect(ds, `${r.name}: ${u.datasheetId}`).toBeTruthy();
        expect(u.modelCount).toBeGreaterThanOrEqual(1);
        expect(Object.keys(u.wargearCounts ?? {}).length).toBeGreaterThan(0);
      }
    }
    // Spot-check: Strike Squad carries 8 Storm Bolters (7 warriors + the Justicar), 1+1 specials.
    const crowes = cpRosters.find((r) => r.name === "Crowe's Sanctifiers")!;
    const strike = crowes.units.find((u) => u.datasheetId === 'cp-crowes-sanctifiers-strike-squad')!;
    expect(strike.modelCount).toBe(10);
    expect(strike.wargearCounts).toMatchObject({ 'Storm Bolter': 8, Incinerator: 1, Psycannon: 1, 'Nemesis Force Weapon': 8 });
  });
});

describe('combat patrol battles (deployment + full game through the real reducer)', () => {
  const crowes = cpRosters.find((r) => r.name === "Crowe's Sanctifiers")! as Roster;
  const brethren = cpRosters.find((r) => r.name === 'The Vengeful Brethren')! as Roster;
  const tau = cpRosters.find((r) => r.name === 'Sudden Dawn Cadre')! as Roster;

  it('plays a legal Combat Patrol game on map 1 with mandatory reserves honoured', () => {
    const layout = layoutsCp[0]!;
    let terminatorArrival: number | null = null;
    let dreadArrival: number | null = null;
    const result = runMatch(
      {
        layout,
        rosters: { player: crowes, ai: brethren },
        profiles: { player: 'balanced', ai: 'balanced' },
        battleType: 'combat_patrol',
        seed: 7,
        observe: (s) => {
          // Mandatory reserves may never stand on the board before their battle round.
          for (const u of s.units) {
            const ds = datasheetsById.get(u.datasheetId);
            if (!ds?.cpReserveRound || u.inReserves) continue;
            if (ds.cpReserveRound === 2 && terminatorArrival === null) terminatorArrival = s.round;
            if (ds.cpReserveRound === 3 && dreadArrival === null) dreadArrival = s.round;
            expect(s.round).toBeGreaterThanOrEqual(ds.cpReserveRound);
          }
          // No 11e Chapter Approved mission layer in Combat Patrol.
          expect(s.missions).toBeUndefined();
          expect(s.secondaries).toBeUndefined();
        },
      },
      data,
    );
    expect(result.ended).toBe(true);
    expect(result.rejectedLog).toEqual([]);
    expect(result.forcedAdvances).toBe(0);
    // Both Strike-from-the-Warp units actually made it onto the board during the game.
    expect(terminatorArrival).not.toBeNull();
    expect(dreadArrival).not.toBeNull();
    expect(terminatorArrival!).toBeGreaterThanOrEqual(2);
    expect(dreadArrival!).toBeGreaterThanOrEqual(3);
  });

  it('plays a legal game on map 3 (diagonal divider) with the T\'au patrol + transport', () => {
    const result = runMatch(
      {
        layout: layoutsCp[2]!,
        rosters: { player: tau, ai: crowes },
        profiles: { player: 'balanced', ai: 'balanced' },
        battleType: 'combat_patrol',
        seed: 21,
      },
      data,
    );
    expect(result.ended).toBe(true);
    expect(result.rejectedLog).toEqual([]);
    expect(result.forcedAdvances).toBe(0);
  });

  it('deploys every non-reserve unit wholly inside its own zone (checked mid-setup)', () => {
    const layout = layoutsCp[1]!;
    let checkedAny = false;
    runMatch(
      {
        layout,
        rosters: { player: brethren, ai: tau },
        profiles: { player: 'balanced', ai: 'balanced' },
        battleType: 'combat_patrol',
        seed: 3,
        observe: (s) => {
          if (s.stage !== 'setup') return;
          for (const u of s.units) {
            if (u.inReserves || !s.setup?.attacker) continue;
            // Once roles are set, layoutForAttacker keys the zones per Side: player→player.
            const zone = s.layout.deploymentZones[u.owner === 'player' ? 'player' : 'opponent'];
            for (const m of u.models) {
              if (!m.alive) continue;
              expect(pointInPolygon(m.pos, zone), `${u.id} model outside zone`).toBe(true);
              checkedAny = true;
            }
          }
        },
      },
      data,
    );
    expect(checkedAny).toBe(true);
  });
});
