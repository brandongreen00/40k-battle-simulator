// @vitest-environment jsdom
// "At all Costs" driven from the map (owner request 2026-08-17): the old panel dropdowns were
// replaced by click-the-action → tap the unit on the board → ✓ Confirm. Both halves (Eliminate
// an enemy / Acquire your unit) go through the same picker + confirmation bar.
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { MeasuringBoard } from '../src/ui/MeasuringBoard';
import { createInitialState } from '../src/core/state';
import type { GameState, Side, UnitInstance } from '../src/core/types';
import { datasheetsById, layouts } from '../src/data/loaders';

afterEach(cleanup);

let seq = 0;
const mkUnit = (owner: Side, datasheetId: string, pos: { x: number; y: number }, count: number): UnitInstance => {
  const w = datasheetsById.get(datasheetId)?.models[0]?.W ?? 1;
  return {
    id: `a${++seq}`,
    owner,
    datasheetId,
    models: Array.from({ length: count }, (_, i) => ({
      id: `a${seq}m${i}`, unitId: `a${seq}`, pos: { x: pos.x + (i % 5) * 0.8, y: pos.y + Math.floor(i / 5) * 0.8 }, wounds: w, alive: true,
    })),
    startingModels: count,
    status: {},
  };
};

// The player runs an Imperialis Fleet army (via initialRosterName), on the default layout, in
// their own Command phase — the exact window the detachment rule opens in.
const layout = layouts[0]!;
const mkState = (): { state: GameState; mine: UnitInstance; enemy: UnitInstance } => {
  const obj = layout.objectives[0] ?? { x: 30, y: 22 };
  const mine = mkUnit('player', '000002587', { x: obj.x - 1, y: obj.y - 1 }, 5); // Imperial Navy Breachers
  const enemy = mkUnit('ai', '000002612', { x: 10, y: 10 }, 5); // Cadian Shock Troops
  const state: GameState = {
    ...createInitialState(layout),
    stage: 'battle',
    mode: 'match',
    round: 1,
    activePlayer: 'player',
    firstPlayer: 'player',
    phase: 'Command',
    units: [mine, enemy],
    cp: { player: 3, ai: 3 },
  };
  return { state, mine, enemy };
};

const tap = (el: Element) =>
  act(() => {
    fireEvent(el, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 40 }));
  });

const renderBoard = (state: GameState) =>
  render(<MeasuringBoard initialState={state} initialRosterName="Fleet Boarding Party" />);

describe('At all Costs from the map (jsdom, real UI)', () => {
  it('Eliminate: arm → tap an enemy → confirm; the panel shows the mark and retires the button', async () => {
    const { state } = mkState();
    const { container } = renderBoard(state);

    // The panel offers the two actions as buttons (no dropdowns any more).
    const eliminate = [...container.querySelectorAll('.atac-row button')].find((b) =>
      /Eliminate/.test(b.textContent ?? ''),
    )!;
    expect(eliminate).toBeTruthy();
    expect(container.querySelector('.atac-row select')).toBeNull();

    await act(async () => {
      fireEvent.click(eliminate);
    });
    // The confirmation bar appears under the board, waiting for a tap; the enemy unit's five
    // models carry the amber eligible rings.
    expect(container.querySelector('.atac-bar')!.textContent).toMatch(/tap an enemy unit/i);
    expect(container.querySelectorAll('.targetable-ring').length).toBe(5);

    // Tapping one of MY OWN models is ignored (not an eligible pick for Eliminate).
    const tokens = container.querySelectorAll('.model-token');
    await tap(tokens[0]!); // player model
    expect(container.querySelector('.atac-bar')!.textContent).toMatch(/tap an enemy unit/i);

    // Tap an enemy model: the bar shows the unit's name + Confirm; the target rings mark it.
    await tap(tokens[5]!); // enemy model
    const bar = container.querySelector('.atac-bar')!;
    expect(bar.textContent).toMatch(/Cadian Shock Troops/);
    expect(container.querySelectorAll('.target-ring').length).toBe(5);

    // Nothing has been dispatched yet — the panel still shows the arming row, not a ✓ mark.
    expect(container.textContent).not.toMatch(/✓ 🎯 Eliminate:/);

    const confirm = [...bar.querySelectorAll('button')].find((b) => /Confirm/.test(b.textContent ?? ''))!;
    await act(async () => {
      fireEvent.click(confirm);
    });
    // The mark is live: the bar closes, the panel shows the chosen unit as ✓ and the arm
    // button is retired for the turn (one Eliminate per Command phase).
    expect(container.querySelector('.atac-bar')).toBeNull();
    expect(container.textContent).toMatch(/✓ 🎯 Eliminate: Cadian Shock Troops/);
    expect(
      [...container.querySelectorAll('.atac-row button')].some((b) => /Eliminate —/.test(b.textContent ?? '')),
    ).toBe(false);
  }, 30_000);

  it('Acquire: arm → tap your unit → confirm applies the buff to YOUR unit', async () => {
    const { state } = mkState();
    const { container } = renderBoard(state);

    const acquire = [...container.querySelectorAll('.atac-row button')].find((b) =>
      /Acquire/.test(b.textContent ?? ''),
    )!;
    await act(async () => {
      fireEvent.click(acquire);
    });
    expect(container.querySelector('.atac-bar')!.textContent).toMatch(/tap one of your units/i);
    // Now MY unit is the eligible one (5 amber rings on the Breachers).
    expect(container.querySelectorAll('.targetable-ring').length).toBe(5);

    // Tapping an ENEMY model is ignored for Acquire.
    const tokens = container.querySelectorAll('.model-token');
    await tap(tokens[5]!);
    expect(container.querySelector('.atac-bar')!.textContent).toMatch(/tap one of your units/i);

    await tap(tokens[0]!); // my Breachers
    const bar = container.querySelector('.atac-bar')!;
    expect(bar.textContent).toMatch(/Imperial Navy Breachers/);
    const confirm = [...bar.querySelectorAll('button')].find((b) => /Confirm/.test(b.textContent ?? ''))!;
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(container.querySelector('.atac-bar')).toBeNull();
    expect(container.textContent).toMatch(/✓ 🛡️ Acquire: Imperial Navy Breachers/);
  }, 30_000);

  it('Cancel and Pick-another leave nothing dispatched', async () => {
    const { state } = mkState();
    const { container } = renderBoard(state);

    const eliminate = [...container.querySelectorAll('.atac-row button')].find((b) =>
      /Eliminate/.test(b.textContent ?? ''),
    )!;
    await act(async () => {
      fireEvent.click(eliminate);
    });
    const tokens = container.querySelectorAll('.model-token');
    await tap(tokens[5]!);
    // ↺ Pick another goes back to the tap prompt, keeping the armed action.
    const again = [...container.querySelectorAll('.atac-bar button')].find((b) => /Pick another/.test(b.textContent ?? ''))!;
    await act(async () => {
      fireEvent.click(again);
    });
    expect(container.querySelector('.atac-bar')!.textContent).toMatch(/tap an enemy unit/i);
    // ✕ Cancel closes the flow; no mark was ever applied and the button is back.
    const cancel = [...container.querySelectorAll('.atac-bar button')].find((b) => /Cancel/.test(b.textContent ?? ''))!;
    await act(async () => {
      fireEvent.click(cancel);
    });
    expect(container.querySelector('.atac-bar')).toBeNull();
    expect(container.textContent).not.toMatch(/✓ 🎯 Eliminate:/);
    expect(
      [...container.querySelectorAll('.atac-row button')].some((b) => /Eliminate —/.test(b.textContent ?? '')),
    ).toBe(true);
  }, 30_000);
});
