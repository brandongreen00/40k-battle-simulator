// @vitest-environment jsdom
// Dead models leave the board (owner report 2026-08-07: "Dead units stay on the board").
// Fights-on-death `dying` models are still alive:true until swept, so they keep rendering.
import { it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MeasuringBoard } from '../src/ui/MeasuringBoard';
import { createInitialState } from '../src/core/state';
import type { GameState, Side, UnitInstance } from '../src/core/types';
import { datasheetsById, layouts } from '../src/data/loaders';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let seq = 0;
const mkUnit = (owner: Side, datasheetId: string, pos: { x: number; y: number }, count: number): UnitInstance => {
  const w = datasheetsById.get(datasheetId)?.models[0]?.W ?? 1;
  return {
    id: `d${++seq}`,
    owner,
    datasheetId,
    models: Array.from({ length: count }, (_, i) => ({
      id: `d${seq}m${i}`, unitId: `d${seq}`, pos: { x: pos.x + i * 0.7, y: pos.y }, wounds: w, alive: true,
    })),
    startingModels: count,
    status: {},
  };
};

it('renders only alive models — casualties disappear, dying models stay', () => {
  vi.useFakeTimers(); // hold the AI auto-play still while we count
  const cpLayout = layouts.find((l) => l.combatPatrol)!;
  const squad = mkUnit('player', 'cp-inquisitors-hand-vigilant-squad', { x: 5, y: 20 }, 5);
  squad.models[0]!.alive = false; // a casualty
  squad.models[1]!.alive = false;
  squad.models[2]!.dying = true; // fights-on-death: destroyed but not yet removed (alive stays true)
  const foe = mkUnit('ai', 'cp-sudden-dawn-cadre-commander-cloudspear', { x: 25, y: 40 }, 1);
  const state: GameState = {
    ...createInitialState(cpLayout),
    stage: 'battle',
    mode: 'match',
    battleType: 'combat_patrol',
    round: 2,
    activePlayer: 'player',
    firstPlayer: 'player',
    units: [squad, foe],
  };
  const { container } = render(<MeasuringBoard initialState={state} />);
  // 5-model squad with 2 casualties → 3 tokens (incl. the dying one), +1 for the enemy.
  expect(container.querySelectorAll('.model-token')).toHaveLength(4);
});
