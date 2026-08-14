// @vitest-environment jsdom
// Tap-a-unit stat block (owner request 2026-08-14): tapping a unit on the map opens a mobile
// friendly stat block — profile line, weapons, abilities, keywords, live status — and dragging
// a unit (a move, not a tap) must NOT open it.
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
    id: `i${++seq}`,
    owner,
    datasheetId,
    models: Array.from({ length: count }, (_, i) => ({
      id: `i${seq}m${i}`, unitId: `i${seq}`, pos: { x: pos.x + (i % 5) * 0.6, y: pos.y + Math.floor(i / 5) * 0.6 }, wounds: w, alive: true,
    })),
    startingModels: count,
    status: {},
  };
};

const cpLayout = layouts.find((l) => l.combatPatrol)!;
// The player's Strike Squad and an enemy Breacher Team, in the player's MOVEMENT phase (the
// Shooting phase has its own stat sheet, so the inspector deliberately stays out of its way).
const mkState = (): GameState => {
  const mine = mkUnit('player', 'cp-crowes-sanctifiers-strike-squad', { x: 26, y: 24 }, 5);
  const theirs = mkUnit('ai', 'cp-sudden-dawn-cadre-breacher-team', { x: 26, y: 16 }, 5);
  return {
    ...createInitialState(cpLayout),
    stage: 'battle',
    mode: 'match',
    battleType: 'combat_patrol',
    round: 2,
    activePlayer: 'player',
    firstPlayer: 'player',
    phase: 'Movement',
    units: [mine, theirs],
    cp: { player: 3, ai: 3 },
  };
};

const at = (el: Element, type: string, x: number, y: number) =>
  act(() => {
    fireEvent(el, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  });
const tap = async (el: Element) => {
  await at(el, 'pointerdown', 40, 40);
  await at(el, 'pointerup', 41, 40); // a wobble inside the tap slop is still a tap
};

describe('unit stat block from the map (jsdom, real UI)', () => {
  it('tapping a unit opens its stat block; ✕ closes it', async () => {
    const { container } = render(<MeasuringBoard initialState={mkState()} />);
    expect(container.querySelector('.statblock')).toBeNull();

    // Tokens render in unit order: 0-4 the Strike Squad, 5-9 the Breacher Team.
    await tap(container.querySelectorAll('.model-token')[0]!);
    const sb = container.querySelector('.statblock')!;
    expect(sb).toBeTruthy();
    expect(sb.textContent).toMatch(/Strike Squad/);
    // The datasheet profile line and the live model count.
    expect(sb.textContent).toMatch(/×5\/5/);
    expect(sb.textContent).toMatch(/M\s*\d+"/);
    expect(sb.textContent).toMatch(/T\s*\d/);
    expect(sb.textContent).toMatch(/Sv\s*\d\+/);
    expect(sb.textContent).toMatch(/OC\s*\d/);
    // Weapons with their full profiles, plus abilities and keywords.
    expect(sb.textContent).toMatch(/Ranged weapons/);
    expect(sb.textContent).toMatch(/Melee weapons/);
    expect(sb.textContent).toMatch(/BS \d\+/);
    expect(sb.textContent).toMatch(/WS \d\+/);
    expect(sb.querySelectorAll('.sb-ability').length).toBeGreaterThan(0);
    expect(sb.querySelector('.sb-keywords')!.textContent).toMatch(/INFANTRY/i);

    // Tapping an ENEMY unit swaps the sheet to it (you can read what you're up against).
    await tap(container.querySelectorAll('.model-token')[5]!);
    expect(container.querySelector('.statblock')!.textContent).toMatch(/Breacher/);

    await act(async () => {
      fireEvent.click(container.querySelector('.sb-close')!);
    });
    expect(container.querySelector('.statblock')).toBeNull();
  }, 30_000);

  it('dragging a unit does not open the stat block', async () => {
    const { container } = render(<MeasuringBoard initialState={mkState()} />);
    const token = container.querySelectorAll('.model-token')[0]!;
    await at(token, 'pointerdown', 40, 40);
    await at(token, 'pointermove', 90, 70); // well past the tap slop → this is a drag
    await at(token, 'pointerup', 90, 70);
    expect(container.querySelector('.statblock')).toBeNull();
  }, 30_000);
});
