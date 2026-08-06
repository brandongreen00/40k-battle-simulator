// @vitest-environment jsdom
// Reaction prompts in the real UI: the AI pauses at moments the human can react to —
// an incoming volley (with the patrol defensive cards) and the end of its phases.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { MeasuringBoard } from '../src/ui/MeasuringBoard';
import { createInitialState } from '../src/core/state';
import type { GameState, Side, UnitInstance } from '../src/core/types';
import { datasheetsById, layouts } from '../src/data/loaders';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let seq = 0;
const mkUnit = (owner: Side, datasheetId: string, pos: { x: number; y: number }, count = 1, extra?: Partial<UnitInstance>): UnitInstance => {
  const w = datasheetsById.get(datasheetId)?.models[0]?.W ?? 1;
  return {
    id: `r${++seq}`,
    owner,
    datasheetId,
    models: Array.from({ length: count }, (_, i) => ({
      id: `r${seq}m${i}`, unitId: `r${seq}`, pos: { x: pos.x + (i % 5) * 0.6, y: pos.y + Math.floor(i / 5) * 0.6 }, wounds: w, alive: true,
    })),
    startingModels: count,
    status: {},
    ...extra,
  };
};
const cpLayout = layouts.find((l) => l.combatPatrol)!;
const mkState = (units: UnitInstance[], extra?: Partial<GameState>): GameState => ({
  ...createInitialState(cpLayout),
  stage: 'battle',
  mode: 'match',
  battleType: 'combat_patrol',
  round: 4,
  activePlayer: 'ai',
  firstPlayer: 'ai',
  units,
  cp: { player: 3, ai: 3 },
  cpMissions: {
    attacker: 'ai',
    missionId: { player: 'inquisitorial_sanction', ai: 'expansionary_campaign' },
    vp: { player: 0, ai: 0 },
    events: [],
  },
  ...extra,
});

const ticks = async (until: () => boolean, max = 40) => {
  for (let t = 0; t < max && !until(); t++) {
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
  }
};

describe('reaction prompts (jsdom, real UI)', () => {
  it('holds an AI volley at a human unit and offers the patrol defensive card', async () => {
    vi.useFakeTimers();
    // AI Breachers 8" from the human Strike Squad on a clear lane — the AI will shoot.
    const strike = mkUnit('player', 'cp-crowes-sanctifiers-strike-squad', { x: 26, y: 24 }, 10);
    const breachers = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 26, y: 16 }, 10);
    const s = mkState([strike, breachers], { phase: 'Shooting' });
    const { container } = render(<MeasuringBoard initialState={s} />);

    await ticks(() => !!container.querySelector('.incoming-fire'));
    expect(container.querySelector('.incoming-fire')).toBeTruthy();
    // The Crowe's card is offered beside Go to Ground.
    const refusal = [...container.querySelectorAll('.incoming-fire button')].find((b) =>
      /Refusal to Yield/.test(b.textContent ?? ''),
    );
    expect(refusal).toBeTruthy();
    await act(async () => {
      fireEvent.click(refusal!);
    });
    expect(container.textContent).toMatch(/Refusal to Yield/); // logged in the dice log
    // Resolve the volley: the game moves on.
    const resolve = [...container.querySelectorAll('button')].find((b) => /Resolve incoming fire/.test(b.textContent ?? ''))!;
    await act(async () => {
      fireEvent.click(resolve);
    });
    expect(container.querySelector('.incoming-fire')).toBeNull();
  }, 30_000);

  it('pauses the end of the AI Movement phase and prompts Fire Overwatch; Continue releases it', async () => {
    vi.useFakeTimers();
    // Every AI unit has already moved — its next Movement action is AdvancePhase, which must be
    // held because the human could Fire Overwatch (enemy within 24", 1 CP available).
    const strike = mkUnit('player', 'cp-crowes-sanctifiers-strike-squad', { x: 26, y: 24 }, 10);
    const breachers = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 26, y: 16 }, 10, {
      status: { moved: true },
    });
    const s = mkState([strike, breachers], { phase: 'Movement' });
    const { container } = render(<MeasuringBoard initialState={s} />);

    await ticks(() => !!container.querySelector('.reaction-prompt'));
    expect(container.querySelector('.reaction-prompt')).toBeTruthy();
    expect(container.querySelector('.reaction-prompt')!.textContent).toMatch(/Fire Overwatch/);
    expect(container.textContent).toMatch(/Movement/); // the phase has NOT advanced

    // Auto-play stays paused while the prompt is up.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelector('.reaction-prompt')).toBeTruthy();

    // Continue releases the held AdvancePhase.
    const cont = [...container.querySelectorAll('.reaction-prompt button')].find((b) => /Continue/.test(b.textContent ?? ''))!;
    await act(async () => {
      fireEvent.click(cont);
    });
    expect(container.querySelector('.reaction-prompt')).toBeNull();
    expect(container.textContent).toMatch(/Shooting/); // the AI's turn moved on
  }, 30_000);
});
