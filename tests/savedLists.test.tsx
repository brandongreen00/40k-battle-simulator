import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MeasuringBoard } from '../src/ui/MeasuringBoard';
import { loadSavedRosters, writeSavedArmyLists, loadSavedArmyLists } from '../src/ui/savedLists';
import { addUnit, createArmyList, type ArmyList } from '../src/core/army';
import { dataIndex, datasheets } from '../src/data/loaders';

// A saved list referencing a real datasheet (so it resolves on the board).
function makeSavedList(name: string): ArmyList {
  const ds = datasheets.find((d) => d.faction === 'AM' && (d.points?.length ?? 0) > 0)!;
  return addUnit(createArmyList('AM', '', 'Incursion', name), ds);
}

describe('saved army lists (localStorage → board rosters)', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a saved list through localStorage', () => {
    const list = makeSavedList('My Saved Army');
    writeSavedArmyLists({ [list.name]: list });
    expect(loadSavedArmyLists()['My Saved Army']).toBeTruthy();
  });

  it('converts saved lists into board-ready rosters', () => {
    const list = makeSavedList('My Saved Army');
    writeSavedArmyLists({ [list.name]: list });

    const rosters = loadSavedRosters(dataIndex);
    const mine = rosters.find((r) => r.name === 'My Saved Army');
    expect(mine).toBeTruthy();
    expect(mine!.units).toHaveLength(1);
    expect(mine!.units[0]!.datasheetId).toBe(list.units[0]!.datasheetId);
  });

  it('returns [] for an empty store and never throws', () => {
    expect(loadSavedRosters(dataIndex)).toEqual([]);
  });

  // The actual user bug: after a refresh, a saved list should be pickable when starting a game.
  // A fresh component mount is exactly what a refresh produces — it reads localStorage on mount.
  it('surfaces a saved list in the new-game army picker after a fresh mount', () => {
    const list = makeSavedList('Persisted List');
    writeSavedArmyLists({ [list.name]: list });

    const { container, getByText } = render(<MeasuringBoard />);
    fireEvent.click(container.querySelector('.newbattle')!);
    expect(getByText('Deployment')).toBeTruthy();

    const options = [...container.querySelectorAll('.dep-rosters option')].map((o) => o.textContent);
    expect(options).toContain('Persisted List');
  });
});
