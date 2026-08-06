// Combat Patrol: the four extracted patrols, the three 30"×44" maps, and the deployment flow.
import { describe, it, expect } from 'vitest';
import type { CpMissionState, GameState, Roster, Side, UnitInstance } from '../src/core/types';
import { distancePointToPolygon, pointInPolygon } from '../src/core/geometry';
import { parseTransportCapacity } from '../src/core/transport';
import { CP_MISSIONS, cpMissionsOnBattleEnd, cpMissionsOnCommandEnd, cpMissionsOnTurnEnd, cpObjectiveStatuses, missionForPatrol, startSanctification } from '../src/core/cpmissions';
import { createInitialState, reduce } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { gatherAttackModifiers } from '../src/core/effects';
import { cpInnateEffectIds } from '../src/core/abilities';
import { isEntryPlaced } from '../src/core/deployment';
import { CP_BANNED_CORE, usableStratagems } from '../src/core/stratagems';
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
    // Every patrol's stratagem/enhancement texts are captured for the later steps.
    for (const p of patrols) {
      expect(p.stratagems, p.id).toHaveLength(3);
      expect(p.enhancements, p.id).toHaveLength(2);
    }
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

describe('combat patrol missions (core/cpmissions.ts)', () => {
  const ctx = { datasheets: datasheetsById };
  let seq = 0;
  const mkUnit = (owner: Side, datasheetId: string, pos: { x: number; y: number }, count = 1): UnitInstance => ({
    id: `t${++seq}`,
    owner,
    datasheetId,
    models: Array.from({ length: count }, (_, i) => ({
      id: `t${seq}m${i}`, unitId: `t${seq}`, pos: { x: pos.x + i * 0.2, y: pos.y }, wounds: 1, alive: true,
    })),
    startingModels: count,
    status: {},
  });
  const mkState = (
    round: number,
    active: Side,
    units: UnitInstance[],
    cpOverrides?: Partial<CpMissionState>,
    extra?: Partial<GameState>,
  ): GameState => ({
    ...createInitialState(layoutsCp[0]!),
    stage: 'battle',
    mode: 'match',
    battleType: 'combat_patrol',
    round,
    activePlayer: active,
    firstPlayer: 'player',
    units,
    cpMissions: {
      attacker: 'player',
      missionId: { player: 'inquisitorial_sanction', ai: 'expansionary_campaign' },
      vp: { player: 0, ai: 0 },
      events: [],
      ...cpOverrides,
    },
    ...extra,
  });

  it('maps every patrol to a mission card', () => {
    for (const pid of ['crowes_sanctifiers', 'inquisitors_hand', 'sudden_dawn_cadre', 'vengeful_brethren']) {
      expect(missionForPatrol(pid), pid).toBeTruthy();
    }
    // All four cards are captured in full (owner screenshots 2026-08-06).
    for (const id of ['inquisitorial_sanction', 'expansionary_campaign', 'purification', 'seize_their_strongholds']) {
      expect(CP_MISSIONS[id]!.captured, id).toBe('full');
    }
  });

  it('Inquisitorial Sanction: 10VP per enemy CHARACTER model this + previous turn, objectives from round 2', () => {
    // On map 1: GH area (1,26)-(7,30) holds an expansion objective; CD (2.5,2.5)-(14,10) the red home.
    const vigilants = 'cp-inquisitors-hand-vigilant-squad';
    const units = [mkUnit('player', vigilants, { x: 4, y: 28 }, 5), mkUnit('player', vigilants, { x: 7, y: 6 }, 5)];
    // Round 1: objectives do NOT score yet; a character killed this turn + one the previous turn do.
    const kill = { side: 'ai' as Side, datasheetIds: ['x'], maxWounds: 4, onObjective: false, charactersSlain: 1 };
    let s = mkState(1, 'player', units);
    s = { ...s, turnKills: [kill], cpMissions: { ...s.cpMissions!, prevTurnKills: [kill] } };
    s = cpMissionsOnTurnEnd(s, ctx);
    expect(s.cpMissions!.vp.player).toBe(20);
    // Round 2: controlling two objectives scores both lines (5+5), cumulative.
    let s2 = mkState(2, 'player', units);
    s2 = cpMissionsOnTurnEnd(s2, ctx);
    expect(s2.cpMissions!.vp.player).toBe(10);
    expect(s2.score.player).toBe(10);
    // The kill window rotated: this turn's ledger became prevTurnKills.
    expect(s2.cpMissions!.prevTurnKills).toEqual([]);
  });

  it('Expansionary Campaign: expansion objectives pay 10/15 in rounds 1-2, then 5/10', () => {
    const breachers = 'cp-sudden-dawn-cadre-breacher-team';
    // Both expansion objectives on map 1: GH area and AB area (23,14)-(29,18).
    const both = [mkUnit('ai', breachers, { x: 4, y: 28 }, 5), mkUnit('ai', breachers, { x: 26, y: 16 }, 5)];
    let s = mkState(2, 'ai', both);
    s = cpMissionsOnTurnEnd(s, ctx);
    expect(s.cpMissions!.vp.ai).toBe(25); // 10 (one or more) + 15 (two or more)
    let s2 = mkState(3, 'ai', both);
    s2 = cpMissionsOnTurnEnd(s2, ctx);
    expect(s2.cpMissions!.vp.ai).toBe(15); // 5 + 10
    // Holding only one expansion in round 1 pays 10.
    let s3 = mkState(1, 'ai', [both[0]!]);
    s3 = cpMissionsOnTurnEnd(s3, ctx);
    expect(s3.cpMissions!.vp.ai).toBe(10);
  });

  it('Seize their Strongholds: command-end windows rounds 2-4, end-of-turn in round 5', () => {
    const inter = 'cp-vengeful-brethren-intercessor-squad';
    // ai is the defender (attacker: player) → its home objective sits on the EF ruin area.
    const units = [mkUnit('ai', inter, { x: 20, y: 38 }, 5), mkUnit('ai', inter, { x: 4, y: 28 }, 5)];
    const seize = { missionId: { player: 'inquisitorial_sanction', ai: 'seize_their_strongholds' } };
    // Round 2, end of ai's Command phase: more objectives (5) + home (5) + non-home (5) = 15.
    let s = mkState(2, 'ai', units, seize, { phase: 'Command' });
    s = cpMissionsOnCommandEnd(s, ctx);
    expect(s.cpMissions!.vp.ai).toBe(15);
    // Round 1 command phase scores nothing; round 5's window moves to the end of the turn.
    let s1 = mkState(1, 'ai', units, seize, { phase: 'Command' });
    expect(cpMissionsOnCommandEnd(s1, ctx).cpMissions!.vp.ai).toBe(0);
    let s5c = mkState(5, 'ai', units, seize, { phase: 'Command' });
    expect(cpMissionsOnCommandEnd(s5c, ctx).cpMissions!.vp.ai).toBe(0);
    let s5t = mkState(5, 'ai', units, seize);
    expect(cpMissionsOnTurnEnd(s5t, ctx).cpMissions!.vp.ai).toBe(15);
  });

  it('Sanctification: starts in your Shooting phase, completes at your next Command phase, pays at battle end', () => {
    const strike = 'cp-crowes-sanctifiers-strike-squad';
    const purify = { missionId: { player: 'purification', ai: 'seize_their_strongholds' } };
    const unit = mkUnit('player', strike, { x: 4, y: 28 }, 5); // inside the GH expansion area
    const unitB = mkUnit('player', strike, { x: 26, y: 16 }, 5); // inside the AB expansion area
    const points = layoutsCp[0]!.objectivePoints!;
    const ghIdx = points.findIndex((o) => o.kind === 'expansion' && o.pos.x < 15);
    const abIdx = points.findIndex((o) => o.kind === 'expansion' && o.pos.x > 15);
    let s = mkState(1, 'player', [unit, unitB], purify, { phase: 'Shooting', turnCounter: 0 });
    s = startSanctification(s, ctx, unit.id, ghIdx);
    expect(s.cpMissions!.sanctifying).toHaveLength(1);
    expect(s.units[0]!.status.hasShot).toBe(true); // 16.01: cannot shoot after starting
    // Once per turn: a second start the same turn is rejected.
    const again = startSanctification(s, ctx, unitB.id, abIdx);
    expect(again.log[again.log.length - 1]).toContain('once per turn');
    // The action does NOT complete in the same turn it started…
    let sameTurn = cpMissionsOnCommandEnd({ ...s, phase: 'Command' }, ctx);
    expect(sameTurn.cpMissions!.sanctified ?? []).toHaveLength(0);
    // …but completes at the player's NEXT Command phase (a later turnCounter).
    let done = cpMissionsOnCommandEnd({ ...s, phase: 'Command', turnCounter: 2 }, ctx);
    expect(done.cpMissions!.sanctified).toEqual([{ idx: ghIdx, side: 'player' }]);
    // Battle end: 5VP × two controlled objectives + 10VP for the sanctified one.
    const scored = cpMissionsOnBattleEnd(done, ctx);
    expect(scored.cpMissions!.vp.player).toBe(20);
    // A battle-shocked unit fails the completion (card effect condition).
    const shocked = {
      ...s,
      phase: 'Command',
      turnCounter: 2,
      units: s.units.map((u) => ({ ...u, status: { ...u.status, battleShocked: true } })),
    };
    const failed = cpMissionsOnCommandEnd(shocked, ctx);
    expect(failed.cpMissions!.sanctified ?? []).toHaveLength(0);
    expect(failed.cpMissions!.sanctifying).toHaveLength(0);
    // Pending sanctifications also complete at the end of the battle (whichever occurs first).
    const atEnd = cpMissionsOnBattleEnd(s, ctx);
    expect(atEnd.cpMissions!.sanctified).toEqual([{ idx: ghIdx, side: 'player' }]);
  });

  it('end of battle: Purification pays 5VP per controlled objective; Sanction 10VP for a tabled character roster', () => {
    const strike = 'cp-crowes-sanctifiers-strike-squad';
    const units = [mkUnit('player', strike, { x: 4, y: 28 }, 5), mkUnit('player', strike, { x: 26, y: 16 }, 5)];
    let s = mkState(5, 'player', units, { missionId: { player: 'purification', ai: 'seize_their_strongholds' } });
    s = cpMissionsOnBattleEnd(s, ctx);
    expect(s.cpMissions!.vp.player).toBe(10); // two objectives controlled × 5
    expect(s.cpMissions!.vp.ai).toBe(0); // Seize their Strongholds has no end-of-battle block
    // Sanction end-of-battle: no enemy CHARACTER model alive anywhere → +10.
    let s2 = mkState(5, 'player', units); // enemy has no units at all
    s2 = cpMissionsOnBattleEnd(s2, ctx);
    expect(s2.cpMissions!.vp.player).toBe(10);
    // With an enemy character alive (even in reserves), the 10VP is withheld.
    const crowe = mkUnit('ai', 'cp-crowes-sanctifiers-castellan-crowe', { x: 0, y: 0 });
    let s3 = mkState(5, 'player', [...units, { ...crowe, inReserves: true }]);
    s3 = cpMissionsOnBattleEnd(s3, ctx);
    expect(s3.cpMissions!.vp.player).toBe(0);
  });
});

describe('combat patrol stratagems (step 3)', () => {
  const ctx = { datasheets: datasheetsById };
  const rng = makeRNG(9);
  let seq = 100;
  const mkUnit = (owner: Side, datasheetId: string, pos: { x: number; y: number }, count = 1): UnitInstance => ({
    id: `s${++seq}`,
    owner,
    datasheetId,
    models: Array.from({ length: count }, (_, i) => ({
      id: `s${seq}m${i}`, unitId: `s${seq}`, pos: { x: pos.x + i * 0.3, y: pos.y }, wounds: 1, alive: true,
    })),
    startingModels: count,
    status: {},
  });
  const mkState = (units: UnitInstance[], extra?: Partial<GameState>): GameState => ({
    ...createInitialState(layoutsCp[0]!),
    stage: 'battle',
    mode: 'match',
    battleType: 'combat_patrol',
    round: 2,
    activePlayer: 'player',
    firstPlayer: 'player',
    units,
    cp: { player: 3, ai: 3 },
    cpMissions: {
      attacker: 'player',
      missionId: { player: 'inquisitorial_sanction', ai: 'expansionary_campaign' },
      vp: { player: 0, ai: 0 },
      events: [],
    },
    ...extra,
  });

  it('bans Explosives / Rapid Ingress / Crushing Impact from the Core set in CP battles', () => {
    for (const phase of ['Command phase', 'Movement phase', 'Shooting phase', 'Charge phase', 'Fight phase']) {
      for (const isYourTurn of [true, false]) {
        const offered = usableStratagems(stratagems, { phase, isYourTurn, battleType: 'combat_patrol' });
        expect(offered.some((s) => CP_BANNED_CORE.has(s.id))).toBe(false);
      }
    }
    // Standard battles keep the full core set.
    const standard = usableStratagems(stratagems, { phase: 'Shooting phase', isYourTurn: true });
    expect(standard.some((s) => s.id === 'core:explosives')).toBe(true);
    // The reducer enforces the ban too.
    const s = mkState([mkUnit('player', 'cp-inquisitors-hand-vigilant-squad', { x: 5, y: 5 }, 5)], { phase: 'Shooting' });
    const out = reduce(s, { type: 'ThrowExplosives', unitId: s.units[0]!.id, targetUnitId: 'x' }, rng, ctx);
    expect(out.log[out.log.length - 1]).toContain('not available in Combat Patrol');
  });

  it("offers each patrol its own three stratagems (and nobody else's)", () => {
    const all = ['Command phase', 'Movement phase', 'Shooting phase', 'Charge phase', 'Fight phase'].flatMap((phase) =>
      [true, false].flatMap((isYourTurn) =>
        usableStratagems(stratagems, { phase, isYourTurn, detachment: "Inquisitor's Hand", battleType: 'combat_patrol' }),
      ),
    );
    const names = new Set(all.map((s) => s.name));
    expect(names.has('Urban Enforcers')).toBe(true);
    expect(names.has('Superior Weaponry')).toBe(true);
    expect(names.has('Inquisitorial Mandate')).toBe(true);
    expect(names.has('Suppressing Fire')).toBe(false); // T'au card
    expect(names.has('For the Lion')).toBe(false); // Dark Angels card
  });

  it('binds the AP and S-vs-T effects', () => {
    const base = {
      phase: 'shooting' as const,
      weaponType: 'ranged' as const,
      weaponKeywords: { unknown: [] },
      attackerKeywords: [],
      targetKeywords: [],
      gap: 12,
    };
    // Superior Weaponry: +1 AP; Urban Enforcers: incoming attacks lose 1 AP.
    expect(gatherAttackModifiers(base, ['cp:ap_boost'], []).apImprove).toBe(1);
    expect(gatherAttackModifiers(base, [], ['cp:ap_shield']).apWorsen).toBe(1);
    // Refusal to Yield: -1 to wound only when the attack's S beats the unit's T.
    expect(gatherAttackModifiers({ ...base, attackS: 8, targetT: 4 }, [], ['cp:wound_shield_strong']).woundModifier).toBe(-1);
    expect(gatherAttackModifiers({ ...base, attackS: 4, targetT: 4 }, [], ['cp:wound_shield_strong']).woundModifier).toBe(0);
    // Psi-reactive Ammunition: [PSYCHIC] granted to storm bolters only.
    expect(gatherAttackModifiers({ ...base, weaponName: 'storm bolter' }, ['cp:psychic_ammo'], []).grantPsychic).toBe(true);
    expect(gatherAttackModifiers({ ...base, weaponName: 'incinerator' }, ['cp:psychic_ammo'], []).grantPsychic).toBe(false);
  });

  it('secures an objective (Rapid Acquisition), holds it while empty, loses it to enemy control', () => {
    const breachers = 'cp-sudden-dawn-cadre-breacher-team';
    const unit = mkUnit('ai', breachers, { x: 4, y: 28 }, 5); // on the GH expansion area
    const ghIdx = layoutsCp[0]!.objectivePoints!.findIndex((o) => o.kind === 'expansion' && o.pos.x < 15);
    let s = mkState([unit], { phase: 'Movement', activePlayer: 'ai' });
    s = reduce(
      s,
      {
        type: 'UseStratagem', name: 'Rapid Acquisition', side: 'ai', cost: 1,
        stratagemId: 'cp:sudden_dawn_cadre:rapid_acquisition', effectId: 'cp:secure_objective',
        targetUnitId: unit.id, objectiveIdx: ghIdx,
      },
      rng,
      ctx,
    );
    expect(s.cpMissions!.securedBy?.[ghIdx]).toBe('ai');
    expect(s.cp.ai).toBe(2);
    // The unit leaves — the secured objective still counts as controlled by ai.
    const empty = { ...s, units: [] };
    expect(cpObjectiveStatuses(empty, ctx)[ghIdx]!.controller).toBe('ai');
    // The enemy takes live control — the secured flag is pruned at the next scoring window.
    const contested = { ...s, units: [mkUnit('player', 'cp-vengeful-brethren-intercessor-squad', { x: 4, y: 28 }, 5)] };
    const pruned = cpMissionsOnTurnEnd(contested, ctx);
    expect(pruned.cpMissions!.securedBy?.[ghIdx]).toBeNull();
  });

  it('Suppressing Fire pins: -2" Move through the enemy turn, expiring at the caster\'s next Command phase', () => {
    const breachers = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 20, y: 20 }, 5);
    let s = mkState([breachers], { phase: 'Shooting', activePlayer: 'player', turnCounter: 0 });
    s = reduce(
      s,
      { type: 'UseStratagem', name: 'Suppressing Fire', side: 'player', cost: 1, stratagemId: 'cp:sudden_dawn_cadre:suppressing_fire', effectId: 'cp:pin', targetUnitId: breachers.id },
      rng,
      ctx,
    );
    expect(s.units[0]!.status.pinnedUntil).toBe(2);
    // The enemy's own Movement phase (turnCounter 1): budget = M 6 - 2 = 4.
    let enemyTurn: GameState = { ...s, phase: 'Movement', activePlayer: 'ai' as Side, turnCounter: 1 };
    enemyTurn = reduce(enemyTurn, { type: 'BeginMove', unitIds: [breachers.id], mode: 'normal' }, rng, ctx);
    expect(enemyTurn.units[0]!.status.moveBudget).toBe(4);
    // After the caster's next Command phase (turnCounter 2) the pin has expired.
    let later: GameState = { ...s, phase: 'Movement', activePlayer: 'ai' as Side, turnCounter: 2 };
    later = reduce(later, { type: 'BeginMove', unitIds: [breachers.id], mode: 'normal' }, rng, ctx);
    expect(later.units[0]!.status.moveBudget).toBe(6);
  });

  it('Command Re-roll re-rolls the Advance D6 once per phase (1 CP)', () => {
    const inter = mkUnit('player', 'cp-vengeful-brethren-intercessor-squad', { x: 5, y: 5 }, 5);
    let s = mkState([inter], { phase: 'Movement', activePlayer: 'player' });
    s = reduce(s, { type: 'BeginMove', unitIds: [inter.id], mode: 'advance' }, rng, ctx);
    const first = s.units[0]!.status.moveBudget!;
    expect(first).toBeGreaterThanOrEqual(7); // M6 + D6
    s = reduce(s, { type: 'RerollAdvance', unitId: inter.id, side: 'player' }, rng, ctx);
    expect(s.cp.player).toBe(2);
    expect(s.units[0]!.status.moveBudget).toBeGreaterThanOrEqual(7);
    const again = reduce(s, { type: 'RerollAdvance', unitId: inter.id, side: 'player' }, rng, ctx);
    expect(again.log[again.log.length - 1]).toContain('already used this phase');
  });

  it('For the Lion grants +1 OC through the objective-control sums', () => {
    const inter = mkUnit('ai', 'cp-vengeful-brethren-intercessor-squad', { x: 4, y: 28 }, 2); // OC 2 each
    let s = mkState([inter], { phase: 'Command', activePlayer: 'ai' });
    const ghIdx = layoutsCp[0]!.objectivePoints!.findIndex((o) => o.kind === 'expansion' && o.pos.x < 15);
    const before = cpObjectiveStatuses(s, ctx)[ghIdx]!.control.ai;
    s = reduce(
      s,
      { type: 'UseStratagem', name: 'For the Lion', side: 'ai', cost: 1, stratagemId: 'cp:vengeful_brethren:for_the_lion', effectId: 'cp:oc_plus1', targetUnitId: inter.id },
      rng,
      ctx,
    );
    expect(cpObjectiveStatuses(s, ctx)[ghIdx]!.control.ai).toBe(before + 2); // +1 OC × 2 models
  });
});

describe('combat patrol per-unit specials (step 4)', () => {
  const ctx = { datasheets: datasheetsById };
  const rng = makeRNG(17);
  let seq = 500;
  const mkUnit = (owner: Side, datasheetId: string, pos: { x: number; y: number }, count = 1, wounds?: number): UnitInstance => {
    const w = wounds ?? datasheetsById.get(datasheetId)?.models[0]?.W ?? 1;
    return {
      id: `q${++seq}`,
      owner,
      datasheetId,
      models: Array.from({ length: count }, (_, i) => ({
        id: `q${seq}m${i}`, unitId: `q${seq}`, pos: { x: pos.x + (i % 5) * 0.6, y: pos.y + Math.floor(i / 5) * 0.6 }, wounds: w, alive: true,
      })),
      startingModels: count,
      status: {},
    };
  };
  const mkState = (units: UnitInstance[], extra?: Partial<GameState>): GameState => ({
    ...createInitialState(layoutsCp[0]!),
    stage: 'battle',
    mode: 'match',
    battleType: 'combat_patrol',
    round: 2,
    activePlayer: 'player',
    firstPlayer: 'player',
    units,
    cp: { player: 3, ai: 3 },
    cpMissions: {
      attacker: 'player',
      missionId: { player: 'inquisitorial_sanction', ai: 'expansionary_campaign' },
      vp: { player: 0, ai: 0 },
      events: [],
    },
    ...extra,
  });
  const base = {
    phase: 'shooting' as const,
    weaponType: 'ranged' as const,
    weaponKeywords: { unknown: [] },
    attackerKeywords: [],
    targetKeywords: [],
    gap: 12,
  };

  it('binds the passive attack-pipeline specials', () => {
    // FOESIGHT: re-roll hits vs CHARACTER only.
    expect(gatherAttackModifiers({ ...base, targetKeywords: ['CHARACTER'] }, ['cp:foesight'], []).rerollHits).toBe('fail');
    expect(gatherAttackModifiers(base, ['cp:foesight'], []).rerollHits).toBe('none');
    // FORCE EDGE: +1 AP melee vs non-MONSTER/VEHICLE.
    const melee = { ...base, phase: 'fight' as const, weaponType: 'melee' as const, gap: 1 };
    expect(gatherAttackModifiers(melee, ['cp:force_edge'], []).apImprove).toBe(1);
    expect(gatherAttackModifiers({ ...melee, targetKeywords: ['VEHICLE'] }, ['cp:force_edge'], []).apImprove).toBe(0);
    // HOLY HATRED: [SUSTAINED HITS 1] on melee only.
    expect(gatherAttackModifiers(melee, ['cp:holy_hatred'], []).grantSustained).toBe(1);
    expect(gatherAttackModifiers(base, ['cp:holy_hatred'], []).grantSustained).toBe(0);
    // MERCILESS JUDGEMENT / LOYAL TO THE CAUSE / GRAVIS PROTECTION / SWSS / Breach and Clear.
    expect(gatherAttackModifiers({ ...base, targetBelowHalf: true }, ['cp:merciless_judgement'], []).woundModifier).toBe(1);
    expect(gatherAttackModifiers(base, ['cp:merciless_judgement'], []).woundModifier).toBe(0);
    expect(gatherAttackModifiers({ ...base, targetOnObjective: true }, [], ['cp:loyal_to_the_cause']).woundModifier).toBe(-1);
    expect(gatherAttackModifiers(base, [], ['cp:gravis_protection']).damageReduction).toBe(1);
    expect(gatherAttackModifiers(base, ['cp:swss'], []).ignoreBadHitMods).toBe(true);
    expect(gatherAttackModifiers({ ...base, targetOnObjective: true }, ['cp:breach_and_clear'], []).rerollWounds).toBe('fail');
    // ZEALOT: only Teguen's own melee weapon; OVERKILL: AP set to -4; defence stance: S>T only.
    const teguenMelee = { ...melee, weaponSourceDsId: 'cp-inquisitors-hand-preacher-teguen' };
    expect(gatherAttackModifiers(teguenMelee, ['cp:zealot'], []).extraAttacks).toBe(3);
    expect(gatherAttackModifiers(teguenMelee, ['cp:zealot'], []).strengthBonus).toBe(3);
    expect(gatherAttackModifiers(melee, ['cp:zealot'], []).extraAttacks).toBe(0);
    expect(gatherAttackModifiers({ ...melee, weaponSourceDsId: 'cp-inquisitors-hand-eversor-assassin' }, ['cp:overkill'], []).apSet).toBe(-4);
    expect(gatherAttackModifiers({ ...melee, attackS: 8, targetT: 4 }, [], ['cp:defence_stance']).woundModifier).toBe(-1);
    expect(gatherAttackModifiers({ ...melee, attackS: 4, targetT: 4 }, [], ['cp:defence_stance']).woundModifier).toBe(0);
  });

  it('collects innate specials per unit, seeing through the Leader merge (Holy Hatred)', () => {
    const cloudspear = mkUnit('player', 'cp-sudden-dawn-cadre-commander-cloudspear', { x: 5, y: 5 });
    expect(cpInnateEffectIds(cloudspear, ctx)).toContain('cp:swss');
    const teguen = mkUnit('player', 'cp-inquisitors-hand-preacher-teguen', { x: 5, y: 5 });
    expect(cpInnateEffectIds(teguen, ctx)).not.toContain('cp:holy_hatred'); // not attached
    const merged: UnitInstance = {
      ...mkUnit('player', 'cp-inquisitors-hand-inquisitorial-agents', { x: 5, y: 5 }, 6),
      attachedLeaders: [{ unitId: 'L1', datasheetId: 'cp-inquisitors-hand-preacher-teguen', modelCount: 1, wounds: 3 }],
    };
    expect(cpInnateEffectIds(merged, ctx)).toContain('cp:holy_hatred');
    const zach = mkUnit('ai', 'cp-vengeful-brethren-master-zacharial', { x: 5, y: 5 });
    expect(cpInnateEffectIds(zach, ctx)).toContain('cp:gravis_protection');
  });

  it('Shield Drone gives Commander Cloudspear +1 W at spawn', () => {
    const ds = datasheetsById.get('cp-sudden-dawn-cadre-commander-cloudspear')!;
    let s = mkState([]);
    s = reduce(
      s,
      {
        type: 'SpawnUnit', unitId: 'cs1', owner: 'player', datasheetId: ds.id,
        baseShape: ds.baseShape, modelCount: 1, wounds: ds.models[0]!.W, anchor: { x: 10, y: 10 },
      },
      rng,
      ctx,
    );
    expect(s.units[0]!.models[0]!.wounds).toBe(ds.models[0]!.W + 1); // 6 → 7
  });

  it('Zealot and Overkill are once-per-battle ability plays', () => {
    const merged: UnitInstance = {
      ...mkUnit('player', 'cp-inquisitors-hand-inquisitorial-agents', { x: 5, y: 5 }, 6),
      attachedLeaders: [{ unitId: 'L1', datasheetId: 'cp-inquisitors-hand-preacher-teguen', modelCount: 1, wounds: 3 }],
    };
    let s = mkState([merged], { phase: 'Fight' });
    s = reduce(s, { type: 'UseUnitAbility', unitId: merged.id, ability: 'zealot' }, rng, ctx);
    expect(s.units[0]!.status.activeEffects).toContain('cp:zealot');
    const again = reduce(s, { type: 'UseUnitAbility', unitId: merged.id, ability: 'zealot' }, rng, ctx);
    expect(again.log[again.log.length - 1]).toContain('once per battle');
    // Overkill on the Eversor.
    const eversor = mkUnit('ai', 'cp-inquisitors-hand-eversor-assassin', { x: 8, y: 8 });
    let s2 = mkState([eversor], { phase: 'Fight', activePlayer: 'ai' });
    s2 = reduce(s2, { type: 'UseUnitAbility', unitId: eversor.id, ability: 'overkill' }, rng, ctx);
    expect(s2.units[0]!.status.activeEffects).toContain('cp:overkill');
    // Wrong unit is rejected.
    const wrong = reduce(mkState([mkUnit('player', 'cp-sudden-dawn-cadre-breacher-team', { x: 5, y: 5 }, 5)], { phase: 'Fight' }), { type: 'UseUnitAbility', unitId: `q${seq}`, ability: 'zealot' }, rng, ctx);
    expect(wrong.log[wrong.log.length - 1]).toContain('does not have Zealot');
  });

  it('Grav-Inhibitor Drone subtracts 2" from charges declared against the Pathfinders', () => {
    const chargers = mkUnit('ai', 'cp-vengeful-brethren-intercessor-squad', { x: 15, y: 18 }, 5);
    const pathfinders = mkUnit('player', 'cp-sudden-dawn-cadre-pathfinder-team', { x: 15, y: 24 }, 10);
    const s = mkState([chargers, pathfinders], { phase: 'Charge', activePlayer: 'ai' });
    const out = reduce(s, { type: 'Charge', chargerUnitId: chargers.id, targetUnitIds: [pathfinders.id] }, rng, ctx);
    expect(out.log.join('\n')).toContain('Grav-Inhibitor Drone: -2"');
  });

  it('Honoured Knights: a charge ending engaged puts the Vengeful Brethren into defence stance', () => {
    const chargers = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 15, y: 20 }, 5);
    const bladeguard = mkUnit('player', 'cp-vengeful-brethren-bladeguard-veteran-squad', { x: 15, y: 22 }, 3);
    const s = mkState([chargers, bladeguard], { phase: 'Charge', activePlayer: 'ai' });
    const out = reduce(s, { type: 'Charge', chargerUnitId: chargers.id, targetUnitIds: [bladeguard.id] }, rng, ctx);
    const bg = out.units.find((u) => u.id === bladeguard.id)!;
    if (out.log.join('\n').includes('SUCCESS')) {
      expect(bg.status.activeEffects).toContain('cp:defence_stance');
      expect(out.log.join('\n')).toContain('defence stance');
    }
    // Strike from the Warp: an ingress-then-charge forces a battle-shock roll on the enemy.
    const strike = { ...mkUnit('ai', 'cp-crowes-sanctifiers-strike-squad', { x: 15, y: 20 }, 5), status: { setUpThisTurn: true } };
    const marines = mkUnit('player', 'cp-vengeful-brethren-intercessor-squad', { x: 15, y: 22 }, 5);
    const s2 = mkState([strike, marines], { phase: 'Charge', activePlayer: 'ai' });
    const out2 = reduce(s2, { type: 'Charge', chargerUnitId: strike.id, targetUnitIds: [marines.id] }, rng, ctx);
    if (out2.log.join('\n').includes('SUCCESS')) {
      expect(out2.log.join('\n')).toContain('Strike from the Warp');
    }
  });

  it('For the Greater Good: spotting, Observer forgoing, Target Uploaded, and the Guided bonus', () => {
    const breachers = mkUnit('player', 'cp-sudden-dawn-cadre-breacher-team', { x: 15, y: 22 }, 5);
    const pathfinders = mkUnit('player', 'cp-sudden-dawn-cadre-pathfinder-team', { x: 13, y: 22 }, 10);
    const enemy = mkUnit('ai', 'cp-vengeful-brethren-intercessor-squad', { x: 15, y: 17 }, 5);
    const enemy2 = mkUnit('ai', 'cp-vengeful-brethren-hellblaster-squad', { x: 13, y: 17 }, 5);
    let s = mkState([breachers, pathfinders, enemy, enemy2], { phase: 'Shooting' });
    // A non-Pathfinder Observer marks a target and forgoes its shooting.
    s = reduce(s, { type: 'SpotTarget', unitId: breachers.id, targetUnitId: enemy.id }, rng, ctx);
    expect(s.spotted?.[enemy.id]?.by).toBe(breachers.id);
    expect(s.units.find((u) => u.id === breachers.id)!.status.hasShot).toBe(true);
    // The same enemy cannot be Spotted twice.
    const dup = reduce(s, { type: 'SpotTarget', unitId: pathfinders.id, targetUnitId: enemy.id }, rng, ctx);
    expect(dup.log[dup.log.length - 1]).toContain('already Spotted');
    // Pathfinders (Target Uploaded + MARKERLIGHT) spot without forgoing their shooting.
    s = reduce(s, { type: 'SpotTarget', unitId: pathfinders.id, targetUnitId: enemy2.id }, rng, ctx);
    expect(s.spotted?.[enemy2.id]).toMatchObject({ by: pathfinders.id, markerlight: true, pathfinder: true });
    expect(s.units.find((u) => u.id === pathfinders.id)!.status.hasShot).toBeFalsy();
    // Their volley against their own Spotted unit is Guided (+1 BS, log-visible).
    const shot = reduce(s, { type: 'ShootUnit', attackerUnitId: pathfinders.id, targetUnitId: enemy2.id }, rng, ctx);
    expect(shot.log.join('\n')).toContain('Guided: +1 BS');
    // Spotted marks clear when the phase advances.
    const advanced = reduce(shot, { type: 'AdvancePhase' }, rng, ctx);
    expect(advanced.spotted).toBeUndefined();
  });

  it('Punishing Volley and Guidance of the Ancients fire after the volley', () => {
    // (26,16)→(26,24) is a clear firing lane on map 1.
    const hellblasters = mkUnit('player', 'cp-vengeful-brethren-hellblaster-squad', { x: 26, y: 16 }, 5);
    const target = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 26, y: 24 }, 10);
    let s = mkState([hellblasters, target], { phase: 'Shooting' });
    s = reduce(s, { type: 'ShootUnit', attackerUnitId: hellblasters.id, targetUnitId: target.id }, rng, ctx);
    expect(s.log.join('\n')).not.toContain('Shooting rejected');
    if (s.units.find((u) => u.id === target.id)!.models.some((m) => m.alive)) {
      expect(s.log.join('\n')).toContain('Punishing Volley');
    }
    const dread = mkUnit('player', 'cp-crowes-sanctifiers-venerable-dreadnought', { x: 26, y: 16 });
    const target2 = mkUnit('ai', 'cp-vengeful-brethren-intercessor-squad', { x: 26, y: 24 }, 10);
    let s2 = mkState([dread, target2], { phase: 'Shooting' });
    s2 = reduce(s2, { type: 'ShootUnit', attackerUnitId: dread.id, targetUnitId: target2.id }, rng, ctx);
    expect(s2.log.join('\n')).not.toContain('Shooting rejected');
    if (s2.units.find((u) => u.id === target2.id)!.models.some((m) => m.alive)) {
      expect(s2.units.find((u) => u.id === target2.id)!.status.activeEffects).toContain('cp:guided_target');
    }
  });

  it('auto-secures objectives at Command end (Sanctifying Ritual / Objective Secured)', () => {
    const ghIdx = layoutsCp[0]!.objectivePoints!.findIndex((o) => o.kind === 'expansion' && o.pos.x < 15);
    const intercessors = mkUnit('player', 'cp-vengeful-brethren-intercessor-squad', { x: 4, y: 28 }, 5);
    let s = mkState([intercessors], { phase: 'Command' });
    s = cpMissionsOnCommandEnd(s, ctx);
    expect(s.cpMissions!.securedBy?.[ghIdx]).toBe('player');
    expect(s.log.join('\n')).toContain('secures objective');
  });

  it('Rapid Disembark: the Devilfish lets riders set up wholly within 6"', () => {
    const devilfish = mkUnit('player', 'cp-sudden-dawn-cadre-devilfish', { x: 15, y: 22 });
    const riders: UnitInstance = {
      ...mkUnit('player', 'cp-sudden-dawn-cadre-breacher-team', { x: 0, y: 0 }, 5),
      inReserves: true,
      embarkedIn: devilfish.id,
    };
    const s = mkState([devilfish, riders], { phase: 'Movement' });
    const out = reduce(s, { type: 'DisembarkUnit', unitId: riders.id, anchor: { x: 15, y: 17 } }, rng, ctx);
    expect(out.log[out.log.length - 1]).toContain('disembarks (tactical)');
  });

  it('Gate of Infinity pulls an unengaged Grey Knights unit back to Reserves, once per phase', () => {
    const strike = mkUnit('ai', 'cp-crowes-sanctifiers-strike-squad', { x: 15, y: 22 }, 5);
    const crowe = mkUnit('ai', 'cp-crowes-sanctifiers-castellan-crowe', { x: 10, y: 22 });
    let s = mkState([strike, crowe], { phase: 'Fight', activePlayer: 'player' });
    s = reduce(s, { type: 'UseUnitAbility', unitId: strike.id, ability: 'gate_of_infinity' }, rng, ctx);
    expect(s.units.find((u) => u.id === strike.id)!.inReserves).toBe(true);
    const again = reduce(s, { type: 'UseUnitAbility', unitId: crowe.id, ability: 'gate_of_infinity' }, rng, ctx);
    expect(again.log[again.log.length - 1]).toContain('already used this phase');
    // Not usable in the unit's own Fight phase.
    const ownTurn = reduce(mkState([mkUnit('ai', 'cp-crowes-sanctifiers-castellan-crowe', { x: 10, y: 22 })], { phase: 'Fight', activePlayer: 'ai' }), { type: 'UseUnitAbility', unitId: `q${seq}`, ability: 'gate_of_infinity' }, rng, ctx);
    expect(ownTurn.log[ownTurn.log.length - 1]).toContain("OPPONENT's Fight phase");
  });

  it('Co-ordinated Eradication marks an enemy for the rest of the battle (army once)', () => {
    const breachers = mkUnit('player', 'cp-sudden-dawn-cadre-breacher-team', { x: 15, y: 22 }, 5);
    const mark = mkUnit('ai', 'cp-vengeful-brethren-hellblaster-squad', { x: 15, y: 16 }, 5);
    let s = mkState([breachers, mark], { phase: 'Shooting' });
    s = reduce(s, { type: 'UseUnitAbility', unitId: breachers.id, ability: 'coordinated_eradication', targetUnitId: mark.id }, rng, ctx);
    expect(s.units.find((u) => u.id === mark.id)!.status.permanentEffects).toContain('cp:eradication_mark');
    expect(s.cpArmyOnce?.['player:coordinated_eradication']).toBe(true);
    const again = reduce(s, { type: 'UseUnitAbility', unitId: breachers.id, ability: 'coordinated_eradication', targetUnitId: mark.id }, rng, ctx);
    expect(again.log[again.log.length - 1]).toContain('once per battle per army');
    // The mark is a defender-side +1 AP for incoming fire.
    expect(gatherAttackModifiers(base, [], ['cp:eradication_mark']).apImprove).toBe(1);
  });

  it('Tome Skull recovers a shocked friend or shocks an enemy; Nuncio-Aquila shocks objective holders', () => {
    const agents = mkUnit('player', 'cp-inquisitors-hand-inquisitorial-agents', { x: 15, y: 22 }, 6);
    const friend = { ...mkUnit('player', 'cp-inquisitors-hand-vigilant-squad', { x: 15, y: 24 }, 10), status: { battleShocked: true } };
    let s = mkState([agents, friend], { phase: 'Movement' });
    s = reduce(s, { type: 'UseUnitAbility', unitId: agents.id, ability: 'tome_skull', targetUnitId: friend.id }, rng, ctx);
    expect(s.units.find((u) => u.id === friend.id)!.status.battleShocked).toBe(false);
    const again = reduce(s, { type: 'UseUnitAbility', unitId: agents.id, ability: 'tome_skull', targetUnitId: friend.id }, rng, ctx);
    expect(again.log[again.log.length - 1]).toContain('once per battle');
    // Nuncio-Aquila: enemy INFANTRY within range of a nearby objective take a battle-shock roll.
    const ghIdx = layoutsCp[0]!.objectivePoints!.findIndex((o) => o.kind === 'expansion' && o.pos.x < 15);
    const vigilants = mkUnit('player', 'cp-inquisitors-hand-vigilant-squad', { x: 6, y: 28 }, 10);
    const holders = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 4, y: 28 }, 5);
    let s2 = mkState([vigilants, holders], { phase: 'Command' });
    s2 = reduce(s2, { type: 'UseUnitAbility', unitId: vigilants.id, ability: 'nuncio_aquila', objectiveIdx: ghIdx }, rng, ctx);
    expect(s2.log.join('\n')).toContain('NUNCIO-AQUILA');
    expect(s2.log.join('\n')).toContain('Nuncio-Aquila:');
  });
});

describe('combat patrol enhancements, fights-on-death and Combat Squad (step 5)', () => {
  const ctx = { datasheets: datasheetsById };
  const rng = makeRNG(23);
  let seq = 700;
  const mkUnit = (owner: Side, datasheetId: string, pos: { x: number; y: number }, count = 1, extra?: Partial<UnitInstance>): UnitInstance => {
    const w = datasheetsById.get(datasheetId)?.models[0]?.W ?? 1;
    return {
      id: `e${++seq}`,
      owner,
      datasheetId,
      models: Array.from({ length: count }, (_, i) => ({
        id: `e${seq}m${i}`, unitId: `e${seq}`, pos: { x: pos.x + (i % 5) * 0.6, y: pos.y + Math.floor(i / 5) * 0.6 }, wounds: w, alive: true,
      })),
      startingModels: count,
      status: {},
      ...extra,
    };
  };
  const mkState = (units: UnitInstance[], extra?: Partial<GameState>): GameState => ({
    ...createInitialState(layoutsCp[0]!),
    stage: 'battle',
    mode: 'match',
    battleType: 'combat_patrol',
    round: 2,
    activePlayer: 'player',
    firstPlayer: 'player',
    units,
    cp: { player: 3, ai: 3 },
    cpMissions: {
      attacker: 'player',
      missionId: { player: 'inquisitorial_sanction', ai: 'expansionary_campaign' },
      vp: { player: 0, ai: 0 },
      events: [],
    },
    ...extra,
  });
  const mkSetupState = (units: UnitInstance[] = []): GameState => ({
    ...createInitialState(layoutsCp[0]!),
    stage: 'setup',
    mode: 'match',
    battleType: 'combat_patrol',
    units,
    setup: { step: 'deploy', attacker: 'player', defender: 'ai', toDeploy: 'ai' },
  });
  const base = {
    phase: 'shooting' as const,
    weaponType: 'ranged' as const,
    weaponKeywords: { unknown: [] },
    attackerKeywords: [],
    targetKeywords: [],
    gap: 12,
  };

  it('ChooseCpEnhancement: once per side, stamped retroactively and at deploy time', () => {
    const eversor = mkUnit('player', 'cp-inquisitors-hand-eversor-assassin', { x: 5, y: 5 });
    let s = mkSetupState([eversor]);
    s = reduce(
      s,
      { type: 'ChooseCpEnhancement', side: 'player', enhancementId: 'cpenh:inquisitors_hand:killer_reflexes', targetDsId: 'cp-inquisitors-hand-eversor-assassin' },
      rng,
      ctx,
    );
    // Retroactive stamp: the Eversor was already down.
    expect(s.units[0]!.enhancementId).toBe('cpenh:inquisitors_hand:killer_reflexes');
    const again = reduce(s, { type: 'ChooseCpEnhancement', side: 'player', enhancementId: null }, rng, ctx);
    expect(again.log[again.log.length - 1]).toContain('already decided');
    // Deploy-time stamp: pick first, then place the bearer in Reserves.
    let s2 = mkSetupState([]);
    s2 = reduce(
      s2,
      { type: 'ChooseCpEnhancement', side: 'ai', enhancementId: 'cpenh:sudden_dawn_cadre:earth_caste_modifications', targetDsId: 'cp-sudden-dawn-cadre-commander-cloudspear' },
      rng,
      ctx,
    );
    const ds = datasheetsById.get('cp-sudden-dawn-cadre-commander-cloudspear')!;
    s2 = reduce(
      s2,
      {
        type: 'PlaceInReserves', unitId: 'cs9', owner: 'ai', datasheetId: ds.id,
        baseShape: ds.baseShape, modelCount: 1, wounds: ds.models[0]!.W,
      },
      rng,
      ctx,
    );
    expect(s2.units.find((u) => u.id === 'cs9')!.enhancementId).toBe('cpenh:sudden_dawn_cadre:earth_caste_modifications');
    // Enhancement effects flow: Killer Reflexes = fights-on-death; Supreme Combatant = lethal.
    expect(cpInnateEffectIds(s.units[0]!, ctx)).toContain('cp:fights_on_death');
    const zach = mkUnit('ai', 'cp-vengeful-brethren-master-zacharial', { x: 5, y: 5 }, 1, { enhancementId: 'cpenh:vengeful_brethren:supreme_combatant' });
    expect(cpInnateEffectIds(zach, ctx)).toContain('lethal_hits_granted');
    const dread = mkUnit('ai', 'cp-crowes-sanctifiers-venerable-dreadnought', { x: 5, y: 5 }, 1, { enhancementId: 'cpenh:crowes_sanctifiers:sanctified_auspexes' });
    expect(cpInnateEffectIds(dread, ctx)).toContain('cp:reroll_one_hit');
    expect(gatherAttackModifiers(base, ['cp:reroll_one_hit'], []).rerollOneHit).toBe(true);
  });

  it('fights-on-death: destroyed models stay on a 2+, fight, and are removed afterwards', () => {
    // 10 Strike Squad falchions into 3 Bladeguard with Determined to the Last active.
    const strike = mkUnit('ai', 'cp-crowes-sanctifiers-strike-squad', { x: 15, y: 22 }, 10);
    const bladeguard = mkUnit('player', 'cp-vengeful-brethren-bladeguard-veteran-squad', { x: 15, y: 23.5 }, 3, {
      status: { activeEffects: ['cp:fights_on_death'] },
    });
    let s = mkState([strike, bladeguard], { phase: 'Fight', activePlayer: 'ai' });
    s = reduce(s, { type: 'FightUnit', attackerUnitId: strike.id, targetUnitId: bladeguard.id }, rng, ctx);
    const bg = s.units.find((u) => u.id === bladeguard.id)!;
    const dead = bg.models.filter((m) => !m.alive).length;
    const dying = bg.models.filter((m) => m.alive && m.dying).length;
    if (dead + dying > 0) {
      expect(s.log.join('\n')).toContain('Fights on death');
      expect(dying).toBeGreaterThan(0); // 5/6 per model — with this seed at least one stays
    }
    if (dying > 0) {
      // The dying models swing back, then are removed when the unit has fought.
      const fought = reduce(s, { type: 'FightUnit', attackerUnitId: bladeguard.id, targetUnitId: strike.id }, rng, ctx);
      const bgAfter = fought.units.find((u) => u.id === bladeguard.id)!;
      expect(bgAfter.models.some((m) => m.alive && m.dying)).toBe(false);
      expect(fought.log.join('\n')).toContain('dying model(s) removed');
      // Or they are removed at the end of the Fight phase.
      const phaseEnd = reduce(s, { type: 'AdvancePhase' }, rng, ctx);
      expect(phaseEnd.units.find((u) => u.id === bladeguard.id)!.models.some((m) => m.alive && m.dying)).toBe(false);
    }
  });

  it('Proximity Scanners and Earth Caste Modifications bind', () => {
    // Proximity Scanners: riders disembarking from the enhanced Devilfish get +1 A pulse guns.
    const devilfish = mkUnit('player', 'cp-sudden-dawn-cadre-devilfish', { x: 15, y: 22 }, 1, { enhancementId: 'cpenh:sudden_dawn_cadre:proximity_scanners' });
    const riders = mkUnit('player', 'cp-sudden-dawn-cadre-breacher-team', { x: 0, y: 0 }, 5, { inReserves: true, embarkedIn: devilfish.id });
    let s = mkState([devilfish, riders], { phase: 'Movement' });
    s = reduce(s, { type: 'DisembarkUnit', unitId: riders.id, anchor: { x: 15, y: 18 } }, rng, ctx);
    expect(s.units.find((u) => u.id === riders.id)!.status.activeEffects).toContain('cp:pulse_bonus');
    expect(gatherAttackModifiers({ ...base, weaponName: 'pulse blaster' }, ['cp:pulse_bonus'], []).extraAttacks).toBe(1);
    expect(gatherAttackModifiers({ ...base, weaponName: 'rail rifle' }, ['cp:pulse_bonus'], []).extraAttacks).toBe(0);
    // Earth Caste: after Cloudspear shoots, the target is suppressed (-1 to hit) through its turn.
    const cloudspear = mkUnit('ai', 'cp-sudden-dawn-cadre-commander-cloudspear', { x: 26, y: 16 }, 1, { enhancementId: 'cpenh:sudden_dawn_cadre:earth_caste_modifications' });
    const target = mkUnit('player', 'cp-vengeful-brethren-intercessor-squad', { x: 26, y: 24 }, 5);
    let s2 = mkState([cloudspear, target], { phase: 'Shooting', activePlayer: 'ai', turnCounter: 4 });
    s2 = reduce(s2, { type: 'ShootUnit', attackerUnitId: cloudspear.id, targetUnitId: target.id }, rng, ctx);
    expect(s2.log.join('\n')).not.toContain('Shooting rejected');
    expect(s2.units.find((u) => u.id === target.id)!.status.suppressedUntil).toBe(6);
    // Earth Caste ingress: Cloudspear may arrive >6" from enemies (instead of >8").
    const arriving = mkUnit('ai', 'cp-sudden-dawn-cadre-commander-cloudspear', { x: 0, y: 0 }, 1, { inReserves: true, enhancementId: 'cpenh:sudden_dawn_cadre:earth_caste_modifications' });
    const enemy = mkUnit('player', 'cp-vengeful-brethren-intercessor-squad', { x: 15, y: 22 }, 5);
    const s3 = mkState([arriving, enemy], { phase: 'Movement', activePlayer: 'ai', round: 2 });
    const arrived = reduce(
      s3,
      { type: 'ArriveFromReserves', unitId: arriving.id, anchor: { x: 15, y: 13.2 }, ability: 'deep_strike' },
      rng,
      ctx,
    );
    const u = arrived.units.find((x) => x.id === arriving.id)!;
    expect(u.inReserves).toBe(false); // ~7" out: legal only via Earth Caste
    expect(u.status.cannotCharge).toBe(true);
    // Without the enhancement the same spot is rejected (>8" required).
    const plain = mkUnit('ai', 'cp-sudden-dawn-cadre-commander-cloudspear', { x: 0, y: 0 }, 1, { inReserves: true });
    const s4 = mkState([plain, enemy], { phase: 'Movement', activePlayer: 'ai', round: 2 });
    const refused = reduce(
      s4,
      { type: 'ArriveFromReserves', unitId: plain.id, anchor: { x: 15, y: 13.2 }, ability: 'deep_strike' },
      rng,
      ctx,
    );
    expect(refused.units.find((x) => x.id === plain.id)!.inReserves).toBe(true);
  });

  it('Sanctic Slayers and Purifying Force are ability plays; Dutiful Defenders discounts Heroic Intervention', () => {
    const teguen = mkUnit('player', 'cp-inquisitors-hand-preacher-teguen', { x: 5, y: 5 }, 1, { enhancementId: 'cpenh:inquisitors_hand:sanctic_slayers' });
    const vigilants = mkUnit('player', 'cp-inquisitors-hand-vigilant-squad', { x: 7, y: 5 }, 10);
    let s = mkState([teguen, vigilants], { phase: 'Fight' });
    s = reduce(s, { type: 'UseUnitAbility', unitId: teguen.id, ability: 'sanctic_slayers', targetUnitId: vigilants.id }, rng, ctx);
    expect(s.units.find((u) => u.id === vigilants.id)!.status.activeEffects).toContain('cp:wound_boost_weak');
    const again = reduce(s, { type: 'UseUnitAbility', unitId: teguen.id, ability: 'sanctic_slayers', targetUnitId: vigilants.id }, rng, ctx);
    expect(again.log[again.log.length - 1]).toContain('once per turn');
    expect(gatherAttackModifiers({ ...base, attackS: 3, targetT: 4 }, ['cp:wound_boost_weak'], []).woundModifier).toBe(1);
    expect(gatherAttackModifiers({ ...base, attackS: 5, targetT: 4 }, ['cp:wound_boost_weak'], []).woundModifier).toBe(0);
    // Purifying Force: after a charge, once per battle per army.
    const termies = mkUnit('ai', 'cp-crowes-sanctifiers-brotherhood-terminator-squad', { x: 15, y: 22 }, 5, {
      status: { charged: true }, enhancementId: 'cpenh:crowes_sanctifiers:purifying_force',
    });
    let s2 = mkState([termies], { phase: 'Fight', activePlayer: 'ai' });
    s2 = reduce(s2, { type: 'UseUnitAbility', unitId: termies.id, ability: 'purifying_force' }, rng, ctx);
    expect(s2.units[0]!.status.activeEffects).toContain('cp:lethal_melee');
    expect(gatherAttackModifiers({ ...base, phase: 'fight', weaponType: 'melee' }, ['cp:lethal_melee'], []).grantLethalHits).toBe(true);
    const again2 = reduce(s2, { type: 'UseUnitAbility', unitId: termies.id, ability: 'purifying_force' }, rng, ctx);
    expect(again2.log[again2.log.length - 1]).toContain('once per battle per army');
    // Dutiful Defenders: a Leap to Defend Heroic Intervention costs 0 CP for the bearer.
    const bladeguard = mkUnit('player', 'cp-vengeful-brethren-bladeguard-veteran-squad', { x: 15, y: 26 }, 3, { enhancementId: 'cpenh:vengeful_brethren:dutiful_defenders' });
    const charger = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 15, y: 22 }, 5, { status: { charged: true } });
    const s3 = mkState([bladeguard, charger], { phase: 'Charge', activePlayer: 'ai' });
    const out = reduce(s3, { type: 'Charge', chargerUnitId: bladeguard.id, targetUnitIds: [charger.id], heroic: 'leap_to_defend' }, rng, ctx);
    expect(out.log.join('\n')).toContain('Dutiful Defenders: -1 CP');
    expect(out.cp.player).toBe(3); // 1 CP - 1 discount = free
  });

  it('COMBAT SQUAD splits the Strike Squad into two deployable fives', () => {
    const strike = cpDatasheets.find((d) => d.id === 'cp-crowes-sanctifiers-strike-squad')!;
    const roster = cpRosters.find((r) => r.name === "Crowe's Sanctifiers")!;
    const entry = roster.units.find((u) => u.datasheetId === strike.id)!;
    let s = mkSetupState([]);
    s = reduce(
      s,
      {
        type: 'DeclareCombatSquad', side: 'ai', entryKey: 'ai:0', datasheetId: strike.id,
        modelCount: 10, ...(entry.wargearCounts ? { totalWargear: entry.wargearCounts } : {}),
      },
      rng,
      ctx,
    );
    const split = s.setup!.splits?.find((x) => x.entryKey === 'ai:0');
    expect(split).toBeTruthy();
    expect(split!.transportUnitId).toBeUndefined();
    expect(split!.groups.map((g) => g.count)).toEqual([5, 5]);
    // The wargear divides evenly: every item's halves sum to the original count.
    for (const [item, n] of Object.entries(entry.wargearCounts ?? {})) {
      expect((split!.groups[0].wargear?.[item] ?? 0) + (split!.groups[1].wargear?.[item] ?? 0)).toBe(n);
    }
    // The entry counts as placed only when BOTH halves are down.
    expect(isEntryPlaced(s, 'ai:0')).toBe(false);
    for (const half of ['a', 'b'] as const) {
      const g = split!.groups[half === 'a' ? 0 : 1];
      s = reduce(
        s,
        {
          type: 'PlaceInReserves', unitId: `ai:0#${half}`, owner: 'ai', datasheetId: strike.id,
          baseShape: strike.baseShape, modelCount: g.count, wounds: strike.models[0]!.W,
          ...(g.wargear ? { wargear: g.wargear } : {}),
        },
        rng,
        ctx,
      );
    }
    expect(isEntryPlaced(s, 'ai:0')).toBe(true);
    // A second declaration and a non-COMBAT-SQUAD unit are rejected.
    const dup = reduce(s, { type: 'DeclareCombatSquad', side: 'ai', entryKey: 'ai:0', datasheetId: strike.id, modelCount: 10 }, rng, ctx);
    expect(dup.log[dup.log.length - 1]).toContain('already');
    const wrong = reduce(mkSetupState([]), { type: 'DeclareCombatSquad', side: 'ai', entryKey: 'ai:1', datasheetId: 'cp-crowes-sanctifiers-castellan-crowe', modelCount: 10 }, rng, ctx);
    expect(wrong.log[wrong.log.length - 1]).toContain('no COMBAT SQUAD ability');
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

  it('plays a full Purification vs Seize their Strongholds game (command windows + sanctification)', () => {
    let finalState: GameState | null = null;
    const result = runMatch(
      {
        layout: layoutsCp[0]!,
        rosters: { player: crowes, ai: brethren },
        profiles: { player: 'balanced', ai: 'balanced' },
        battleType: 'combat_patrol',
        seed: 13,
        observe: (s) => { finalState = s; },
      },
      data,
    );
    expect(result.ended).toBe(true);
    expect(result.rejectedLog).toEqual([]);
    const s = finalState! as GameState;
    expect(s.cpMissions?.missionId).toEqual({ player: 'purification', ai: 'seize_their_strongholds' });
    expect(result.score).toEqual(s.cpMissions!.vp);
    // Both full cards produce VP in a real game between these patrols.
    expect(result.score.player + result.score.ai).toBeGreaterThan(0);
  });

  it('scores ONLY the patrol mission cards in a full game (Inquisitor\'s Hand vs Sudden Dawn Cadre)', () => {
    const inqs = cpRosters.find((r) => r.name === "Inquisitor's Hand")! as Roster;
    let finalState: GameState | null = null;
    const result = runMatch(
      {
        layout: layoutsCp[1]!,
        rosters: { player: inqs, ai: tau },
        profiles: { player: 'balanced', ai: 'balanced' },
        battleType: 'combat_patrol',
        seed: 5,
        observe: (s) => { finalState = s; },
      },
      data,
    );
    expect(result.ended).toBe(true);
    expect(result.rejectedLog).toEqual([]);
    const s = finalState! as GameState;
    // Each side plays its own patrol's card.
    expect(s.cpMissions?.missionId).toEqual({ player: 'inquisitorial_sanction', ai: 'expansionary_campaign' });
    // Mission VP is the ONLY VP source in Combat Patrol: the scoreboard equals the mission tally,
    // the events sum to it, and the legacy Pariah primary never fired.
    expect(result.score).toEqual(s.cpMissions!.vp);
    for (const side of ['player', 'ai'] as const) {
      const sum = s.cpMissions!.events.filter((e) => e.side === side).reduce((a, e) => a + e.vp, 0);
      expect(sum).toBe(s.cpMissions!.vp[side]);
    }
    expect(result.log.some((l) => l.includes('Primary VP'))).toBe(false);
    // A full game between two objective-playing patrols produces mission VP.
    expect(result.score.player + result.score.ai).toBeGreaterThan(0);
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
