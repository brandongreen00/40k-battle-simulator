// Reaction-window detection (core/ai/prompts.ts): what the UI's reaction prompts key off.
import { describe, it, expect } from 'vitest';
import type { GameState, Side, UnitInstance } from '../src/core/types';
import { createInitialState } from '../src/core/state';
import {
  counteroffensiveCandidates,
  determinedAvailable,
  phaseEndReactions,
  promptableDefender,
  volleyDefensiveCards,
} from '../src/core/ai/prompts';
import { datasheetsById, layoutsCp } from '../src/data/loaders';

const ctx = { datasheets: datasheetsById };
let seq = 0;
const mkUnit = (owner: Side, datasheetId: string, pos: { x: number; y: number }, count = 1, extra?: Partial<UnitInstance>): UnitInstance => {
  const w = datasheetsById.get(datasheetId)?.models[0]?.W ?? 1;
  return {
    id: `p${++seq}`,
    owner,
    datasheetId,
    models: Array.from({ length: count }, (_, i) => ({
      id: `p${seq}m${i}`, unitId: `p${seq}`, pos: { x: pos.x + (i % 5) * 0.6, y: pos.y + Math.floor(i / 5) * 0.6 }, wounds: w, alive: true,
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
  activePlayer: 'ai',
  firstPlayer: 'ai',
  units,
  cp: { player: 3, ai: 3 },
  ...extra,
});

const breachers = () => mkUnit('player', 'cp-sudden-dawn-cadre-breacher-team', { x: 15, y: 22 }, 5);
const enemy = (pos = { x: 15, y: 16 }) => mkUnit('ai', 'cp-vengeful-brethren-intercessor-squad', pos, 5);

describe('reaction-window detection (prompts.ts)', () => {
  it('offers Fire Overwatch at the end of the opponent Movement phase — with the right gates', () => {
    const s = mkState([breachers(), enemy()], { phase: 'Movement' });
    expect(phaseEndReactions(s, 'player', ctx).map((w) => w.id)).toContain('overwatch');
    // Not on the active player's own turn.
    expect(phaseEndReactions({ ...s, activePlayer: 'player' }, 'player', ctx)).toEqual([]);
    // Not without CP.
    expect(phaseEndReactions({ ...s, cp: { player: 0, ai: 3 } }, 'player', ctx)).toEqual([]);
    // Not when already used this phase.
    const used = { ...s, stratUsed: { 'player:core:fire_overwatch': '2:ai:Movement' } };
    expect(phaseEndReactions(used, 'player', ctx).map((w) => w.id)).not.toContain('overwatch');
    // Not when the enemy is out of the 24" bubble (opposite corners of the 30"×44" board).
    const far = mkState(
      [mkUnit('player', 'cp-sudden-dawn-cadre-breacher-team', { x: 27, y: 42 }, 5), enemy({ x: 2, y: 2 })],
      { phase: 'Movement' },
    );
    expect(phaseEndReactions(far, 'player', ctx).map((w) => w.id)).not.toContain('overwatch');
  });

  it('offers Rapid Ingress only in standard battles, with unarrived reserves', () => {
    const reserves = mkUnit('player', 'cp-sudden-dawn-cadre-breacher-team', { x: 0, y: 0 }, 5, { inReserves: true });
    const cp = mkState([reserves, enemy()], { phase: 'Movement' });
    expect(phaseEndReactions(cp, 'player', ctx).map((w) => w.id)).not.toContain('rapid_ingress'); // banned in CP
    const std = { ...cp, battleType: 'standard' as const };
    expect(phaseEndReactions(std, 'player', ctx).map((w) => w.id)).toContain('rapid_ingress');
    const noReserves = mkState([breachers(), enemy()], { phase: 'Movement', battleType: 'standard' });
    expect(phaseEndReactions(noReserves, 'player', ctx).map((w) => w.id)).not.toContain('rapid_ingress');
  });

  it('offers Heroic Intervention at the end of the opponent Charge phase vs a charged enemy', () => {
    const charged = mkUnit('ai', 'cp-vengeful-brethren-intercessor-squad', { x: 15, y: 17 }, 5, { status: { charged: true } });
    const s = mkState([breachers(), charged], { phase: 'Charge' });
    expect(phaseEndReactions(s, 'player', ctx).map((w) => w.id)).toContain('heroic');
    // No charged enemy within reach → no window (12" for Leap to Defend).
    const idle = mkState([breachers(), enemy({ x: 15, y: 2 })], { phase: 'Charge' });
    expect(phaseEndReactions(idle, 'player', ctx).map((w) => w.id)).not.toContain('heroic');
  });

  it('offers Gate of Infinity and Swift Embarkation at the end of the opponent Fight phase (CP)', () => {
    const strike = mkUnit('player', 'cp-crowes-sanctifiers-strike-squad', { x: 15, y: 22 }, 5);
    const s = mkState([strike, enemy({ x: 15, y: 2 })], { phase: 'Fight' });
    expect(phaseEndReactions(s, 'player', ctx).map((w) => w.id)).toContain('gate');
    // Swift Embarkation: SDC INFANTRY unengaged within 6" of the Devilfish.
    const fish = mkUnit('player', 'cp-sudden-dawn-cadre-devilfish', { x: 15, y: 24 });
    const s2 = mkState([breachers(), fish, enemy({ x: 15, y: 2 })], { phase: 'Fight' });
    expect(phaseEndReactions(s2, 'player', ctx).map((w) => w.id)).toContain('swift_embark');
    // Neither outside the Fight phase.
    expect(phaseEndReactions({ ...s, phase: 'Shooting' }, 'player', ctx)).toEqual([]);
  });

  it('detects Counteroffensive candidates (un-fought, engaged, 2 CP, opponent turn)', () => {
    const mine = mkUnit('player', 'cp-vengeful-brethren-bladeguard-veteran-squad', { x: 15, y: 22 }, 3);
    const foe = mkUnit('ai', 'cp-crowes-sanctifiers-strike-squad', { x: 15, y: 23.2 }, 5);
    const s = mkState([mine, foe], { phase: 'Fight' });
    expect(counteroffensiveCandidates(s, 'player', ctx).map((u) => u.id)).toEqual([mine.id]);
    expect(counteroffensiveCandidates({ ...s, cp: { player: 1, ai: 3 } }, 'player', ctx)).toEqual([]);
    expect(counteroffensiveCandidates({ ...s, fightNext: 'x' }, 'player', ctx)).toEqual([]);
    const fought = { ...s, units: s.units.map((u) => (u.id === mine.id ? { ...u, status: { hasFought: true } } : u)) };
    expect(counteroffensiveCandidates(fought, 'player', ctx)).toEqual([]);
  });

  it('detects Determined to the Last for the targeted Bladeguard', () => {
    const bg = mkUnit('player', 'cp-vengeful-brethren-bladeguard-veteran-squad', { x: 15, y: 22 }, 3);
    const s = mkState([bg, enemy()], { phase: 'Fight' });
    expect(determinedAvailable(s, bg.id, ctx)).toBe(true);
    expect(determinedAvailable({ ...s, cp: { player: 0, ai: 3 } }, bg.id, ctx)).toBe(false);
    expect(determinedAvailable({ ...s, phase: 'Shooting' }, bg.id, ctx)).toBe(false);
    const covered = { ...s, units: s.units.map((u) => (u.id === bg.id ? { ...u, status: { activeEffects: ['cp:fights_on_death'] } } : u)) };
    expect(determinedAvailable(covered, bg.id, ctx)).toBe(false);
    // Not for a non-Bladeguard unit.
    const others = mkState([breachers(), enemy()], { phase: 'Fight' });
    expect(determinedAvailable(others, others.units[0]!.id, ctx)).toBe(false);
  });

  it('offers the patrol defensive cards against an incoming volley', () => {
    const strike = mkUnit('player', 'cp-crowes-sanctifiers-strike-squad', { x: 15, y: 22 }, 5);
    const s = mkState([strike, enemy()], { phase: 'Shooting' });
    expect(volleyDefensiveCards(s, strike, ctx).map((c) => c.name)).toContain('Refusal to Yield');
    // Urban Enforcers needs EVERY model inside one terrain area — park the unit inside one.
    const area = layoutsCp[0]!.terrainAreas![0]!;
    const cx = area.polygon.reduce((a, p) => a + p.x, 0) / area.polygon.length;
    const cy = area.polygon.reduce((a, p) => a + p.y, 0) / area.polygon.length;
    const agents = mkUnit('player', 'cp-inquisitors-hand-inquisitorial-agents', { x: cx - 0.6, y: cy }, 3);
    const s2 = mkState([agents, enemy()], { phase: 'Shooting' });
    expect(volleyDefensiveCards(s2, agents, ctx).map((c) => c.name)).toContain('Urban Enforcers');
    // Out in the open the IH card is not offered.
    const open = mkUnit('player', 'cp-inquisitors-hand-inquisitorial-agents', { x: 15, y: 20 }, 3);
    const s3 = mkState([open, enemy()], { phase: 'Shooting' });
    expect(volleyDefensiveCards(s3, open, ctx).map((c) => c.name)).not.toContain('Urban Enforcers');
  });

  it('prompts the human defender only (not AI seats, not the active player)', () => {
    const s = mkState([breachers(), enemy()], { phase: 'Movement' });
    expect(promptableDefender(s, { player: true, ai: false })).toBe('player');
    expect(promptableDefender(s, { player: false, ai: false })).toBeNull();
    expect(promptableDefender({ ...s, activePlayer: 'player' }, { player: true, ai: false })).toBeNull();
  });
});
