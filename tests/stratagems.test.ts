import { describe, it, expect } from 'vitest';
import {
  CORE_STRATAGEMS, usableStratagems, phaseMatches, turnMatches, parseTurn, type Stratagem,
} from '../src/core/stratagems';

describe('stratagem filters', () => {
  it('parses the data export turn strings', () => {
    expect(parseTurn('Either player’s turn')).toBe('either');
    expect(parseTurn('Your turn')).toBe('your');
    expect(parseTurn('Opponent’s turn')).toBe('opponent');
  });

  it('matches phases, with "Any phase" and compound phases', () => {
    expect(phaseMatches('Any phase', 'Command')).toBe(true);
    expect(phaseMatches('Shooting phase', 'Shooting')).toBe(true);
    expect(phaseMatches('Movement or Charge phase', 'Charge')).toBe(true);
    expect(phaseMatches('Fight phase', 'Shooting')).toBe(false);
  });

  it('gates by whose turn it is', () => {
    expect(turnMatches('either', true)).toBe(true);
    expect(turnMatches('your', true)).toBe(true);
    expect(turnMatches('your', false)).toBe(false);
    expect(turnMatches('opponent', false)).toBe(true); // reactive on the opponent's turn
  });
});

describe('usableStratagems', () => {
  const det: Stratagem = { id: 'd1', name: 'Ruthless', cp: 1, phase: 'Shooting phase', turn: 'your', detachment: 'Grizzled Company' };
  const all = [...CORE_STRATAGEMS, det];

  it('offers Core stratagems to anyone but detachment ones only to that detachment', () => {
    const mine = usableStratagems(all, { phase: 'Shooting', isYourTurn: true, detachment: 'Grizzled Company' });
    expect(mine.map((s) => s.name)).toContain('Ruthless'); // my detachment
    expect(mine.map((s) => s.name)).toContain('Explosives'); // core, shooting, your turn (11e)

    const other = usableStratagems(all, { phase: 'Shooting', isYourTurn: true, detachment: 'Siege Regiment' });
    expect(other.map((s) => s.name)).not.toContain('Ruthless');
  });

  it('surfaces reactive stratagems on the opponent turn only', () => {
    const reactive = usableStratagems(CORE_STRATAGEMS, { phase: 'Shooting', isYourTurn: false });
    expect(reactive.map((s) => s.name)).toContain('Smokescreen'); // opponent's Shooting phase
    const myTurn = usableStratagems(CORE_STRATAGEMS, { phase: 'Shooting', isYourTurn: true });
    expect(myTurn.map((s) => s.name)).not.toContain('Smokescreen');
  });

  it('Command Re-roll (Any phase, either) is always available', () => {
    for (const ph of ['Command', 'Movement', 'Shooting', 'Charge', 'Fight']) {
      expect(usableStratagems(CORE_STRATAGEMS, { phase: ph, isYourTurn: true }).some((s) => s.name === 'Command Re-roll')).toBe(true);
    }
  });
});
