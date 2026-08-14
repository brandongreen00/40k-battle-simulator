// 11th edition missions: the Event Companion layouts, the disposition→mission matrix,
// primary scoring windows + caps, Objective Actions, and a full AI acceptance game.
import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../src/core/state';
import type { EngineContext } from '../src/core/engine';
import { makeRNG } from '../src/core/rng';
import {
  DISPOSITIONS, MISSION_MATRIX, MISSION_NAMES, PRIMARY_MISSIONS, PRIMARY_CAP, PRIMARY_ROUND_CAP,
  addPrimaryVp, objectiveStatuses, scoreWindow, withinObjectiveRange,
} from '../src/core/missions11';
import { initMissions, missionsOnTurnStart, missionsOnTurnEnd, canStartAction } from '../src/core/missionflow';
import { runMatch, type MatchData } from '../src/core/ai/match';
import { datasheetsById, deployAbilityForDatasheet, stratagems, layouts11, layoutsForPairing } from '../src/data/loaders';
import type { Datasheet, GameState, Layout, Roster, Side } from '../src/core/types';
import cadian from '../data/rosters/prebuilt_cadian_bulwark.json';
import fleet from '../data/rosters/prebuilt_fleet_boarding.json';

const circle = { kind: 'circle' as const, radius: 0.49 };
const trooper: Datasheet = {
  id: 'troop', name: 'Troopers', faction: 'AM',
  models: [{ name: 'm', M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [{ name: 'Lasgun', type: 'ranged', range: 24, attacks: '1', skill: 4, S: 3, AP: 0, D: '1', keywords: [] }],
  baseShape: circle, keywords: ['INFANTRY'], abilityIds: [],
};
const ctx: EngineContext = { datasheets: new Map([[trooper.id, trooper]]) };
const rng = makeRNG(9);

/** A tiny synthetic 11e layout: one home area per side, one central marker in the open. */
const layout11: Layout = {
  id: 'test11', boardWidth: 44, boardHeight: 60, deployment: 'test',
  terrain: [],
  objectives: [{ x: 22, y: 52 }, { x: 22, y: 30 }, { x: 22, y: 8 }],
  objectivePoints: [
    { pos: { x: 22, y: 52 }, kind: 'home', owner: 'attacker', areaId: 'a-top' },
    { pos: { x: 22, y: 30 }, kind: 'central' }, // open-field 40mm marker
    { pos: { x: 22, y: 8 }, kind: 'home', owner: 'defender', areaId: 'a-bot' },
  ],
  terrainAreas: [
    { id: 'a-top', polygon: [{ x: 18, y: 48 }, { x: 26, y: 48 }, { x: 26, y: 56 }, { x: 18, y: 56 }], features: [{ kind: 'dense', polygon: [{ x: 19, y: 49 }, { x: 25, y: 49 }, { x: 25, y: 55 }, { x: 19, y: 55 }] }] },
    { id: 'a-bot', polygon: [{ x: 18, y: 4 }, { x: 26, y: 4 }, { x: 26, y: 12 }, { x: 18, y: 12 }], features: [{ kind: 'dense', polygon: [{ x: 19, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 11 }, { x: 19, y: 11 }] }] },
  ],
  deploymentZones: {
    player: [{ x: 0, y: 44 }, { x: 44, y: 44 }, { x: 44, y: 60 }, { x: 0, y: 60 }], // attacker (top)
    opponent: [{ x: 0, y: 0 }, { x: 44, y: 0 }, { x: 44, y: 16 }, { x: 0, y: 16 }],
  },
  territoryDivider: [{ x: 0, y: 30 }, { x: 44, y: 30 }],
  attackerEdge: 'top',
};

function spawn(s: GameState, id: string, owner: Side, x: number, y: number, n = 1): GameState {
  return reduce(s, {
    type: 'SpawnUnit', unitId: id, owner, datasheetId: 'troop', baseShape: circle,
    modelCount: n, wounds: 1, anchor: { x, y },
  }, rng, ctx);
}

function battle11(dispositions: { player: string; ai: string }): GameState {
  const s: GameState = { ...createInitialState(layout11), mode: 'match', stage: 'battle' };
  return initMissions(s, ctx, dispositions as never, 'player');
}

describe('Event Companion layouts', () => {
  it('loads all 45 layouts, each with 16 terrain areas, zones and typed objectives', () => {
    expect(layouts11).toHaveLength(45);
    for (const l of layouts11) {
      expect(l.terrainAreas).toHaveLength(16);
      expect(l.deploymentZones.player.length).toBeGreaterThan(3);
      expect(l.deploymentZones.opponent.length).toBeGreaterThan(3);
      const homes = (l.objectivePoints ?? []).filter((o) => o.kind === 'home');
      expect(homes.map((h) => h.owner).sort()).toEqual(['attacker', 'defender']);
      expect((l.objectivePoints ?? []).length).toBeGreaterThanOrEqual(5);
      expect([l.boardWidth, l.boardHeight].sort((a, b) => a - b)).toEqual([44, 60]);
    }
  });

  it('every disposition pairing has exactly its three recommended layouts (A/B/C)', () => {
    for (const a of DISPOSITIONS) {
      for (const b of DISPOSITIONS) {
        const recs = layoutsForPairing(a.id, b.id);
        expect(recs, `${a.id} vs ${b.id}`).toHaveLength(3);
        expect(recs.map((l) => l.pairing?.letter).sort()).toEqual(['A', 'B', 'C']);
      }
    }
  });

  it('territory dividers match the printed lines (Event Companion v1.1 review, 2026-08-14)', () => {
    // Every printed diagonal divider in the companion rises left-to-right; the old bbox-corner
    // endpoint pairing mirrored all 34 of them (falling slope). Pin the direction for the lot.
    for (const l of layouts11) {
      const div = l.territoryDivider!;
      expect(div, l.id).toBeTruthy();
      const [a, b] = div;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) > 0.01 && Math.abs(dy) > 0.01) {
        expect(dy / dx, `${l.id} divider must rise left-to-right like the printed line`).toBeGreaterThan(0);
      }
      for (const p of div) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(l.boardWidth);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(l.boardHeight);
      }
    }
    // Exact pins against the v1.1 PDF: a shallow diagonal (p9), a midline fallback (p10 prints
    // no divider), and a v1.1-updated page (p12) that also gained a sixth objective.
    const at = (id: string) => layouts11.find((l) => l.id === id)!;
    expect(at('ec2026-take-and-hold_vs_take-and-hold-a').territoryDivider).toEqual([
      { x: 0.496, y: 26.139 }, { x: 43.733, y: 33.908 },
    ]);
    expect(at('ec2026-take-and-hold_vs_take-and-hold-b').territoryDivider).toEqual([
      { x: 22, y: 0 }, { x: 22, y: 60 },
    ]);
    const updated = at('ec2026-take-and-hold_vs_purge-the-foe-a');
    expect(updated.territoryDivider).toEqual([{ x: 19.081, y: 0.606 }, { x: 24.912, y: 59.643 }]);
    expect(updated.objectivePoints).toHaveLength(6);
    expect(updated.source).toContain('v1.1');
  });
});

describe('disposition → mission matrix', () => {
  it('has 25 distinct primary missions, each with scoring blocks and a display name', () => {
    const ids = new Set<string>();
    for (const mine of DISPOSITIONS) {
      for (const theirs of DISPOSITIONS) {
        const id = MISSION_MATRIX[mine.id][theirs.id];
        ids.add(id);
        expect(PRIMARY_MISSIONS[id], id).toBeDefined();
        expect(MISSION_NAMES[id], id).toBeDefined();
      }
    }
    expect(ids.size).toBe(25);
  });
});

describe('primary scoring', () => {
  it('scores the Command-phase window with the 15/round cap and logs the mission', () => {
    // Immovable Object: 5VP per non-home objective at end of Command (rounds 2-4).
    let s = battle11({ player: 'take_and_hold', ai: 'purge_the_foe' });
    expect(s.missions!.perSide.player.mission).toBe('immovable_object');
    // Player holds the central marker AND the enemy home (2 non-home = raw 10VP).
    s = spawn(s, 'a', 'player', 22, 30, 5);
    s = spawn(s, 'b', 'player', 22, 8, 5);
    s = { ...s, round: 2, activePlayer: 'player' };
    const scored = scoreWindow(s, ctx, 'player', 'commandEnd');
    expect(scored.missions!.perSide.player.primaryVp).toBe(10);
    expect(scored.score.player).toBe(10);
    // The round cap kicks in: another scoring event in the same round adds at most 5.
    const again = scoreWindow(scored, ctx, 'player', 'commandEnd');
    expect(again.missions!.perSide.player.primaryVp).toBe(PRIMARY_ROUND_CAP);
  });

  it('the total cap holds at 45', () => {
    let s = battle11({ player: 'take_and_hold', ai: 'take_and_hold' });
    s = { ...s, missions: { ...s.missions!, perSide: { ...s.missions!.perSide, player: { ...s.missions!.perSide.player, primaryVp: 44, roundVp: {} } } } };
    const capped = addPrimaryVp(s, 'player', 10, 'test');
    expect(capped.missions!.perSide.player.primaryVp).toBe(PRIMARY_CAP);
  });

  it('terrain objectives control by area membership; markers by 3\" range', () => {
    let s = battle11({ player: 'take_and_hold', ai: 'take_and_hold' });
    s = spawn(s, 'inArea', 'player', 19, 49); // inside a-top but ~4.4" from the objective POINT
    s = spawn(s, 'nearMarker', 'ai', 22, 32); // 2" from the central marker
    const statuses = objectiveStatuses(s, ctx, 'player');
    expect(statuses[0]!.controller).toBe('player'); // the whole area is the objective
    expect(statuses[1]!.controller).toBe('ai');
    expect(statuses[0]!.homeOf).toBe('player');
    expect(statuses[2]!.controller).toBeNull();
    expect(withinObjectiveRange({ x: 22, y: 36 }, 0.5, layout11.objectivePoints![1]!, layout11)).toBe(false);
  });

  it('Outmanoeuvre pays 10VP for the enemy home objective at end of turn', () => {
    let s = battle11({ player: 'disruption', ai: 'disruption' });
    s = spawn(s, 'raiders', 'player', 22, 8, 5); // standing in the DEFENDER (ai) home area
    s = { ...s, round: 1, activePlayer: 'player' };
    const scored = scoreWindow(s, ctx, 'player', 'turnEnd');
    expect(scored.missions!.perSide.player.primaryVp).toBeGreaterThanOrEqual(10);
    expect(scored.log.some((l) => l.includes('Outmanoeuvre'))).toBe(true);
  });
});

describe('objective actions (16.01)', () => {
  it('validates eligibility and completes at end of turn when the unit controls the objective', () => {
    let s = battle11({ player: 'priority_assets', ai: 'take_and_hold' });
    expect(s.missions!.perSide.player.mission).toBe('secure_asset');
    s = spawn(s, 'squad', 'player', 22, 30, 5); // on the central marker
    s = { ...s, phase: 'Shooting', activePlayer: 'player' };
    s = missionsOnTurnStart(s, ctx);

    // Wrong phase / wrong objective rejections.
    expect(canStartAction({ ...s, phase: 'Movement' }, ctx, { unitId: 'squad', actionId: 'secure_asset', objectiveIdx: 1 }).ok).toBe(false);
    expect(canStartAction(s, ctx, { unitId: 'squad', actionId: 'secure_asset', objectiveIdx: 2 }).ok).toBe(false); // not in range
    expect(canStartAction(s, ctx, { unitId: 'squad', actionId: 'secure_asset', objectiveIdx: 1 }).ok).toBe(true);

    s = reduce(s, { type: 'StartAction', unitId: 'squad', actionId: 'secure_asset', objectiveIdx: 1 }, rng, ctx);
    expect(s.activeActions).toHaveLength(1);
    // Starting an action forfeits shooting/charging (16.01).
    expect(s.units.find((u) => u.id === 'squad')!.status.hasShot).toBe(true);

    // End of turn: the unit still controls the objective → the action completes and scores 4VP.
    const done = missionsOnTurnEnd(s, ctx);
    expect(done.missions!.actionsDoneThisTurn?.player?.['secure_asset']).toBe(1);
    expect(done.missions!.perSide.player.primaryVp).toBeGreaterThanOrEqual(4);
  });

  it('a battle-shocked unit cannot start actions', () => {
    let s = battle11({ player: 'priority_assets', ai: 'take_and_hold' });
    s = spawn(s, 'squad', 'player', 22, 30, 5);
    s = { ...s, phase: 'Shooting', activePlayer: 'player' };
    s = { ...s, units: s.units.map((u) => ({ ...u, status: { ...u.status, battleShocked: true } })) };
    expect(canStartAction(s, ctx, { unitId: 'squad', actionId: 'secure_asset', objectiveIdx: 1 }).ok).toBe(false);
  });
});

describe('full 11e AI acceptance game', () => {
  const data: MatchData = { ctx: { datasheets: datasheetsById }, deployAbility: deployAbilityForDatasheet, stratagems };

  it('plays a clean asymmetric-mission game on an extracted Event Companion layout', () => {
    const board = layouts11.find((l) => l.id === 'ec2026-take-and-hold_vs_purge-the-foe-a')!;
    const result = runMatch({
      layout: board,
      rosters: { player: cadian as Roster, ai: fleet as Roster },
      profiles: { player: 'balanced', ai: 'balanced' },
      dispositions: { player: 'take_and_hold', ai: 'purge_the_foe' },
      seed: 3,
    }, data);
    expect(result.ended).toBe(true);
    expect(result.forcedAdvances).toBe(0);
    expect(result.rejectedLog).toEqual([]);
    expect(result.rounds).toHaveLength(10);
    // Both sides scored real mission VP; caps hold (45P + 45S + 10 Battle Ready).
    expect(result.score.player).toBeGreaterThan(10);
    expect(result.score.ai).toBeGreaterThan(10);
    expect(result.score.player).toBeLessThanOrEqual(100);
    expect(result.score.ai).toBeLessThanOrEqual(100);
    expect(result.log.some((l) => l.includes('Missions: Take and Hold'))).toBe(true);
    expect(result.log.some((l) => l.includes('Battle Ready'))).toBe(true);
  }, 180_000);
});

describe('AI mission play', () => {
  it('bestMissionAction proposes a legal Objective Action for a unit holding the objective', async () => {
    const { bestMissionAction } = await import('../src/core/ai/missionplay');
    let s = battle11({ player: 'priority_assets', ai: 'take_and_hold' });
    s = spawn(s, 'squad', 'player', 22, 30, 5);
    s = { ...s, phase: 'Shooting', activePlayer: 'player' };
    s = missionsOnTurnStart(s, ctx);
    const deps = { ctx } as never;
    const pick = bestMissionAction(s, 'player', deps);
    expect(pick).not.toBeNull();
    expect(pick!.params.actionId).toBe('secure_asset');
    expect(pick!.vp).toBeGreaterThanOrEqual(4);
  });
});
