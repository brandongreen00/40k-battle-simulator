import { describe, it, expect } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { GamePanel } from '../src/ui/GamePanel';
import { createInitialState } from '../src/core/state';
import { datasheetsById } from '../src/data/loaders';
import type { GameState, Layout, UnitInstance } from '../src/core/types';

const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: { player: [], opponent: [] },
};

// Two real Cadian Shock Troop units 10" apart (lasgun range 24") — a legal shooting pair.
const CADIAN = '000002612';
function cadians(id: string, owner: 'player' | 'ai', x: number): UnitInstance {
  return {
    id, owner, datasheetId: CADIAN, startingModels: 5, status: {},
    models: Array.from({ length: 5 }, (_, i) => ({ id: `${id}:m${i}`, unitId: id, pos: { x: x + i * 0.6, y: 22 }, wounds: 1, alive: true })),
  };
}

function shootingState(): GameState {
  return {
    ...createInitialState(layout),
    phase: 'Shooting',
    activePlayer: 'player',
    cp: { player: 3, ai: 3 },
    units: [cadians('a', 'player', 20), cadians('b', 'ai', 30)],
  };
}

describe('GamePanel — Shooting phase', () => {
  it('renders eligible attackers, valid targets, and stratagems without crashing', () => {
    const { container, getByText } = render(
      <GamePanel state={shootingState()} dispatch={() => {}} datasheetsById={datasheetsById} detachmentBySide={{ player: 'Combined Arms', ai: 'Combined Arms' }} />,
    );

    // Phase-aware combat section present, with an eligible attacker count.
    expect(getByText(/Attacker \(\d+ eligible\)/)).toBeTruthy();

    // Stratagems section renders. Engine-bound Core stratagems (Command Re-roll, Explosives,
    // Fire Overwatch…) are NOT in the generic spend-CP list — they resolve through their own
    // dedicated controls (charge-block checkbox / "Stratagem plays").
    expect(getByText('Stratagems')).toBeTruthy();
    const stratList = container.querySelector('.strat-list')!;
    expect(within(stratList as HTMLElement).queryByText(/Command Re-roll/)).toBeNull();
    expect(stratList.querySelectorAll('button.strat').length).toBeGreaterThan(0);
  });

  it('shows the unit fire plan and the Shoot button once an attacker is picked', () => {
    const { container, getByText } = render(
      <GamePanel state={shootingState()} dispatch={() => {}} datasheetsById={datasheetsById} />,
    );
    const selects = container.querySelectorAll('select');
    // Attacker select is the first in the "Resolve combat" group; pick unit 'a'.
    const attackerSelect = [...selects].find((s) => [...s.options].some((o) => o.value === 'a'))!;
    fireEvent.change(attackerSelect, { target: { value: 'a' } });
    // Shooting is unit-level: the fire plan lists the lasgun, and the Shoot button is present.
    const firePlan = container.querySelector('.fire-plan')!;
    expect(firePlan).toBeTruthy();
    expect(/lasgun/i.test(firePlan.textContent ?? '')).toBe(true);
    expect(getByText(/Shoot — all weapons/)).toBeTruthy();
  });

  it('with 2+ valid targets, each weapon gets a split-target select that rides on ShootUnit', () => {
    const state: GameState = {
      ...shootingState(),
      units: [cadians('a', 'player', 20), cadians('b', 'ai', 30), cadians('c', 'ai', 14)],
    };
    const sent: unknown[] = [];
    const { container, getByText } = render(
      <GamePanel state={state} dispatch={(i) => sent.push(i)} datasheetsById={datasheetsById} />,
    );
    const selects = () => [...container.querySelectorAll('select')];
    const attackerSelect = selects().find((s) => [...s.options].some((o) => o.value === 'a'))!;
    fireEvent.change(attackerSelect, { target: { value: 'a' } });
    // Per-weapon split selects appear inside the fire plan (options "→ main target" + targets).
    const firePlan = container.querySelector('.fire-plan')!;
    const weaponSelects = [...firePlan.querySelectorAll('select')];
    expect(weaponSelects.length).toBeGreaterThan(0);
    // Send the first weapon at target 'c'; main target stays 'b'.
    fireEvent.change(weaponSelects[0]!, { target: { value: 'c' } });
    const targetSelect = selects().find(
      (s) => !firePlan.contains(s) && [...s.options].some((o) => o.value === 'b'),
    )!;
    fireEvent.change(targetSelect, { target: { value: 'b' } });
    fireEvent.click(getByText(/Shoot — all weapons/));
    const shoot = sent.find((i) => (i as { type: string }).type === 'ShootUnit') as
      | { targetUnitId: string; splitTargets?: Record<string, string> }
      | undefined;
    expect(shoot).toBeDefined();
    expect(shoot!.targetUnitId).toBe('b');
    expect(Object.values(shoot!.splitTargets ?? {})).toContain('c');
  });
});
