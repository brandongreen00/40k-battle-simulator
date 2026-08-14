// @vitest-environment jsdom
// Shooting phase driven from the map (owner request 2026-08-14): tapping your unit shows its
// weapons + a range ring per weapon; tapping an enemy inside a ring shows the matchup stat
// sheet (weapon BS + S vs the enemy's T + Sv) and a Shoot button.
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
    id: `s${++seq}`,
    owner,
    datasheetId,
    models: Array.from({ length: count }, (_, i) => ({
      id: `s${seq}m${i}`, unitId: `s${seq}`, pos: { x: pos.x + (i % 5) * 0.6, y: pos.y + Math.floor(i / 5) * 0.6 }, wounds: w, alive: true,
    })),
    startingModels: count,
    status: {},
  };
};

const cpLayout = layouts.find((l) => l.combatPatrol)!;
// The player's Strike Squad with a clear 8" lane to one Breacher Team (the exact clear-lane
// coordinates the reaction-prompt tests shoot along) and a second Breacher Team ~32" away —
// beyond every Strike Squad gun. The PLAYER is active, so the AI seat stays idle.
const mkState = (): { state: GameState; attacker: UnitInstance; near: UnitInstance; far: UnitInstance } => {
  const attacker = mkUnit('player', 'cp-crowes-sanctifiers-strike-squad', { x: 26, y: 24 }, 5);
  const near = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 26, y: 16 }, 5);
  const far = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 2, y: 2 }, 5);
  const state: GameState = {
    ...createInitialState(cpLayout),
    stage: 'battle',
    mode: 'match',
    battleType: 'combat_patrol',
    round: 2,
    activePlayer: 'player',
    firstPlayer: 'player',
    phase: 'Shooting',
    units: [attacker, near, far],
    cp: { player: 3, ai: 3 },
  };
  return { state, attacker, near, far };
};

const tap = (el: Element) =>
  act(() => {
    fireEvent(el, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 40 }));
  });

describe('shooting from the map (jsdom, real UI)', () => {
  it('tap your unit → weapons + range rings; tap an enemy in range → stat sheet + Shoot', async () => {
    const { state } = mkState();
    const { container } = render(<MeasuringBoard initialState={state} />);
    expect(container.querySelector('.shootbar')).toBeNull();

    // Tap a Strike Squad model (tokens render in unit order: 0-4 attacker, 5-9 near, 10-14 far).
    const tokens = container.querySelectorAll('.model-token');
    await tap(tokens[0]!);

    const bar = container.querySelector('.shootbar')!;
    expect(bar).toBeTruthy();
    expect(bar.textContent).toMatch(/Strike Squad/);
    // The weapon rows carry the requested stats: range, BS, S (and AP/D).
    expect(bar.textContent).toMatch(/BS \d\+/);
    expect(bar.textContent).toMatch(/S\d/);
    // A range ring per distinct weapon range, drawn per alive model.
    expect(container.querySelectorAll('.range-ring').length).toBeGreaterThan(0);
    // The in-range Breachers are highlighted as targetable; the far unit is not.
    expect(container.querySelectorAll('.targetable-ring').length).toBe(5);

    // Tap a model of the in-range enemy: the stat sheet shows its Toughness and Save.
    await tap(container.querySelectorAll('.model-token')[5]!);
    const target = container.querySelector('.shoot-target')!;
    expect(target).toBeTruthy();
    expect(target.textContent).toMatch(/T \d/);
    expect(target.textContent).toMatch(/Sv \d\+/);
    // Each reachable weapon row shows the matchup (hit + wound thresholds).
    expect(container.querySelector('.shootbar')!.textContent).toMatch(/wounds \d\+/);

    // Shoot resolves the volley from the map: tracer fires, selection clears, unit has shot.
    const shoot = [...container.querySelectorAll('.shootbar button')].find((b) => /Shoot/.test(b.textContent ?? ''))!;
    expect(shoot).toBeTruthy();
    expect((shoot as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(shoot);
    });
    expect(container.querySelector('.fx-tracer')).toBeTruthy();
    expect(container.querySelector('.shootbar')).toBeNull();

    // Re-tapping the shooter now reports it has already shot (Shoot is not offered again).
    await tap(container.querySelectorAll('.model-token')[0]!);
    expect(container.querySelector('.shootbar')!.textContent).toMatch(/already shot this turn/);
  }, 30_000);

  it('an enemy outside every ring shows the stat sheet but no Shoot button', async () => {
    const { state } = mkState();
    const { container } = render(<MeasuringBoard initialState={state} />);
    await tap(container.querySelectorAll('.model-token')[0]!);
    // Tap a model of the far Breacher Team (~32" away, beyond every gun).
    await tap(container.querySelectorAll('.model-token')[10]!);
    const bar = container.querySelector('.shootbar')!;
    expect(bar.textContent).toMatch(/Out of range or not visible/);
    expect(bar.textContent).toMatch(/can't reach/);
    expect([...bar.querySelectorAll('button')].some((b) => /Shoot/.test(b.textContent ?? ''))).toBe(false);

    // Tapping empty board clears the whole selection.
    await tap(container.querySelector('.board-svg')!);
    expect(container.querySelector('.shootbar')).toBeNull();
  }, 30_000);
});
