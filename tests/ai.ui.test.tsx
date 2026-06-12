import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { MeasuringBoard } from '../src/ui/MeasuringBoard';
import type { Roster } from '../src/core/types';
import cadian from '../data/rosters/prebuilt_cadian_bulwark.json';
import fleet from '../data/rosters/prebuilt_fleet_boarding.json';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('AI seats in the real UI (jsdom)', () => {
  it('AI-vs-AI auto-play drives setup through deployment into the battle', async () => {
    vi.useFakeTimers();
    const { container, getByText, getAllByText } = render(
      <MeasuringBoard extraRosters={[cadian as Roster, fleet as Roster]} initialRosterName="Cadian Bulwark" />,
    );

    // Start a match — the Players bar appears (it hides on the sandbox).
    fireEvent.click(container.querySelector('.newbattle')!);
    expect(getByText('Players')).toBeTruthy();

    // Seat the AI on BOTH sides (the `ai` seat defaults to AI; flip `player` too).
    const seatRows = container.querySelectorAll('.ai-seat');
    expect(seatRows.length).toBe(2);
    fireEvent.click(seatRows[0]!.querySelector('.seg button:nth-child(2)')!);
    expect(getAllByText('AI').length).toBeGreaterThan(0);

    // Let the auto-driver play: each 350ms beat takes one AI action (roll-off, a deployment
    // drop, an activation…). Deployment of two 13-unit lists plus roll-offs ≈ 30 actions.
    for (let tick = 0; tick < 80; tick++) {
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      const note = container.querySelector('.ai-note');
      if (note && /Battle begins|round/i.test(container.textContent ?? '')) break;
    }

    // The AI must at least have rolled off and be deploying; give it more beats to reach battle.
    expect(container.textContent).toMatch(/is Attacker/);
    for (let tick = 0; tick < 80 && !/Round \d/.test(container.textContent ?? ''); tick++) {
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    }

    // Battle reached: the Game panel shows Round 1 and units are on the board.
    expect(container.textContent).toMatch(/Round 1/);
    expect(container.querySelectorAll('.model-token').length).toBeGreaterThan(20);

    // And the game keeps progressing (the AI takes Command/Movement actions, the log grows).
    const before = container.querySelectorAll('.dicelog div').length;
    for (let tick = 0; tick < 12; tick++) {
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    }
    const after = container.querySelectorAll('.dicelog div').length;
    expect(after).toBeGreaterThan(before);
  }, 120_000);

  it('human-vs-AI: the AI deploys only its own units and waits for the human elsewhere', async () => {
    vi.useFakeTimers();
    const { container, getByText } = render(
      <MeasuringBoard extraRosters={[cadian as Roster, fleet as Roster]} initialRosterName="Cadian Bulwark" />,
    );
    fireEvent.click(container.querySelector('.newbattle')!);

    // Default seats: player = Human, ai = AI. The roll-off is SHARED, so with a human at the
    // table auto-play must NOT roll it — the human clicks.
    for (let tick = 0; tick < 5; tick++) {
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    }
    expect(container.textContent).not.toMatch(/is Attacker/);

    // Make the human the Attacker, so the AI (Defender) owns the FIRST deployment slot.
    fireEvent.click(getByText('player attacks'));
    expect(container.textContent).toMatch(/Now placing: ai/);

    // The AI takes exactly its own slot (one drop) and then waits for the human's alternating
    // turn — it must not deploy the human's units or keep placing out of turn. (The dice log is
    // not rendered during setup, so assert on the panel's remaining counter + board tokens.)
    for (let tick = 0; tick < 40; tick++) {
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    }
    expect(container.textContent).toMatch(/remaining — player 13, ai 12/);
    expect(container.textContent).toMatch(/Now placing: player/);
    expect(container.querySelectorAll('.model-token').length).toBeGreaterThan(0);
  }, 120_000);
});
