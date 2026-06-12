import { describe, it, expect } from 'vitest';
import type { Roster } from '../src/core/types';
import { runMatch, type MatchData } from '../src/core/ai/match';
import { datasheetsById, deployAbilityForDatasheet, stratagems, layouts } from '../src/data/loaders';
import cadian from '../data/rosters/prebuilt_cadian_bulwark.json';
import fleet from '../data/rosters/prebuilt_fleet_boarding.json';
import krieg from '../data/rosters/prebuilt_krieg_siege.json';
import deathwatch from '../data/rosters/prebuilt_deathwatch_vigil.json';

const data: MatchData = {
  ctx: { datasheets: datasheetsById },
  deployAbility: deployAbilityForDatasheet,
  stratagems,
};
const layout = layouts.find((l) => l.id === 'ca2025-hammer-and-anvil-1') ?? layouts[0]!;

describe('ai/match — full AI-vs-AI games (the Stage 5 acceptance test)', () => {
  it('plays a complete, legal 5-round game (Cadian Bulwark vs Fleet Boarding Party)', () => {
    const result = runMatch(
      {
        layout,
        rosters: { player: cadian as Roster, ai: fleet as Roster },
        profiles: { player: 'balanced', ai: 'balanced' },
        seed: 11,
      },
      data,
    );
    // The game must end naturally, with zero engine pushback and zero forced advances —
    // i.e. the AI made ONLY legal moves all game.
    expect(result.ended).toBe(true);
    expect(result.forcedAdvances).toBe(0);
    expect(result.rejectedLog).toEqual([]);
    // 5 rounds × 2 turns of snapshots.
    expect(result.rounds.length).toBe(10);
    expect(result.rounds[result.rounds.length - 1]!.round).toBe(5);
    // The VP engine produced a result the logs can compare.
    expect(result.score.player + result.score.ai).toBeGreaterThan(0);
    expect(['player', 'ai', 'draw']).toContain(result.winner);
  }, 60_000);

  it('is deterministic: the same seed replays the identical game', () => {
    const cfg = {
      layout,
      rosters: { player: krieg as Roster, ai: deathwatch as Roster },
      profiles: { player: 'aggressive', ai: 'defensive' },
      seed: 7,
    } as const;
    const a = runMatch({ ...cfg, rosters: { ...cfg.rosters }, profiles: { ...cfg.profiles } }, data);
    const b = runMatch({ ...cfg, rosters: { ...cfg.rosters }, profiles: { ...cfg.profiles } }, data);
    expect(a.score).toEqual(b.score);
    expect(a.winner).toBe(b.winner);
    expect(a.log).toEqual(b.log);
    expect(a.ended).toBe(true);
    expect(a.rejectedLog).toEqual([]);
    expect(a.forcedAdvances).toBe(0);
  }, 120_000);

  it('different seeds produce different games', () => {
    const mk = (seed: number) =>
      runMatch(
        {
          layout,
          rosters: { player: cadian as Roster, ai: deathwatch as Roster },
          profiles: { player: 'balanced', ai: 'balanced' },
          seed,
        },
        data,
      );
    const a = mk(1);
    const b = mk(2);
    expect(a.ended && b.ended).toBe(true);
    expect(a.log.join('\n')).not.toBe(b.log.join('\n'));
  }, 120_000);

  it('the random-baseline profile also completes legally (loop-safety floor)', () => {
    const result = runMatch(
      {
        layout,
        rosters: { player: fleet as Roster, ai: krieg as Roster },
        profiles: { player: 'random', ai: 'random' },
        seed: 99,
      },
      data,
    );
    expect(result.ended).toBe(true);
    expect(result.rejectedLog).toEqual([]);
    expect(result.forcedAdvances).toBe(0);
  }, 60_000);
});
