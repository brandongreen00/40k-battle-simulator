import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup, within } from '@testing-library/react';
import { MeasuringBoard } from '../src/ui/MeasuringBoard';
import type { Roster } from '../src/core/types';
import cadian from '../data/rosters/prebuilt_cadian_bulwark.json';
import fleet from '../data/rosters/prebuilt_fleet_boarding.json';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('deployment guards (the "AI never deploys" wedges)', () => {
  it('empty rosters are unpickable in the deployment army selects', () => {
    const { container, getByText } = render(<MeasuringBoard />);
    fireEvent.click(container.querySelector('.newbattle')!);
    expect(getByText('Deployment')).toBeTruthy();

    // The on-disk scaffolds ("Grizzled Company", "Imperialis Fleet") have 0 units: assigning one
    // to a side used to leave that side with literally nothing to deploy — the AI silently never
    // placed a unit. They must render disabled and labelled.
    const options = [...container.querySelectorAll('.dep-rosters option')] as HTMLOptionElement[];
    const empty = options.filter((o) => /\(empty\)$/.test(o.textContent ?? ''));
    expect(empty.length).toBeGreaterThan(0);
    for (const o of empty) expect(o.disabled).toBe(true);
    const nonEmpty = options.filter((o) => !/\(empty\)$/.test(o.textContent ?? ''));
    for (const o of nonEmpty) expect(o.disabled).toBe(false);
  });

  it("the AI's declaration/deployment slot offers no manual controls (a held ghost pauses auto-play)", async () => {
    vi.useFakeTimers();
    const { container, getByText } = render(
      <MeasuringBoard extraRosters={[cadian as Roster, fleet as Roster]} initialRosterName="Cadian Bulwark" />,
    );
    fireEvent.click(container.querySelector('.newbattle')!);
    fireEvent.click(getByText('player attacks')); // AI = Defender -> declares first
    expect(container.textContent).toMatch(/Declare formations · ai/);

    // The sidebar must NOT offer manual declaration/placement controls for the computer's side.
    const sidebar = container.querySelector('.sidebar')!;
    expect(within(sidebar as HTMLElement).queryAllByText('+ Deploy')).toHaveLength(0);
    expect(within(sidebar as HTMLElement).queryAllByText(/⤓ Reserves/)).toHaveLength(0);
    expect(container.textContent).toMatch(/The computer controls this side/);

    // Switching the seat to Human hands the declarations over: manual controls return.
    const seatRows = container.querySelectorAll('.ai-seat');
    fireEvent.click(seatRows[1]!.querySelector('.seg button:nth-child(1)')!); // ai seat -> Human
    expect(within(sidebar as HTMLElement).queryAllByText(/⤓ Reserves/).length).toBeGreaterThan(0);
    expect(within(sidebar as HTMLElement).queryAllByText(/✓ Finish declaring/).length).toBe(1);
  });

  it('a deployment ghost held when its side flips to AI is dropped, and auto-play resumes', async () => {
    vi.useFakeTimers();
    const { container, getByText } = render(
      <MeasuringBoard extraRosters={[cadian as Roster, fleet as Roster]} initialRosterName="Cadian Bulwark" />,
    );
    fireEvent.click(container.querySelector('.newbattle')!);
    fireEvent.click(getByText('ai attacks')); // human (player) = Defender -> declares first

    // Declare Battle Formations: the human embarks a squad into the Chimera (18.01 — a rider
    // keeps the dedicated transport alive) and finishes; the AI then declares via auto-play.
    const sidebar = container.querySelector('.sidebar') as HTMLElement;
    expect(container.textContent).toMatch(/Declare formations · player/);
    const embarkSel = [...sidebar.querySelectorAll('select.embark-select')].find((s) =>
      [...(s as HTMLSelectElement).options].some((o) => /Chimera/.test(o.text)),
    ) as HTMLSelectElement;
    expect(embarkSel).toBeTruthy();
    const chimeraOpt = [...embarkSel.options].find((o) => /Chimera/.test(o.text))!;
    fireEvent.change(embarkSel, { target: { value: chimeraOpt.value } });
    expect(container.textContent).toMatch(/⇥ Chimera/);
    fireEvent.click(within(sidebar).getByText(/✓ Finish declaring — player/));
    for (let tick = 0; tick < 30 && !/Now placing: player/.test(container.textContent ?? ''); tick++) {
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    }
    expect(container.textContent).toMatch(/Now placing: player/);

    // Human picks a unit up — the ghost is live.
    fireEvent.click(within(sidebar).getAllByText('+ Deploy')[0]!);
    expect(container.querySelector('.board-hud.placing')).toBeTruthy();

    // Seat the AI on the player side mid-placement: the ghost must drop (it would otherwise gate
    // aiCanAct on !placing forever) and auto-play must take the slot.
    const seatRows = container.querySelectorAll('.ai-seat');
    await act(async () => {
      fireEvent.click(seatRows[0]!.querySelector('.seg button:nth-child(2)')!); // player seat -> AI
    });
    expect(container.querySelector('.board-hud.placing')).toBeNull();

    // 13 entries − 1 embarked at Declare Battle Formations = 12; the AI's first drop → 11.
    for (let tick = 0; tick < 20 && !/remaining — player 11/.test(container.textContent ?? ''); tick++) {
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    }
    expect(container.textContent).toMatch(/remaining — player 11/);
  }, 60_000);
});
