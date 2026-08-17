import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AutoPlayer } from '../src/ui/autoplayer/AutoPlayer';
import {
  convertSavedList,
  loadSavedArmyCatalog,
  payloadFileName,
} from '../src/ui/autoplayer/savedArmies';
import { writeSavedArmyLists } from '../src/ui/savedLists';
import { addUnit, createArmyList, type ArmyList } from '../src/core/army';
import { datasheets, enhancements } from '../src/data/loaders';

// A saved list referencing real v1 datasheets, like the List Builder writes.
function makeSavedList(name: string, faction: 'AM' | 'AoI' = 'AM'): ArmyList {
  const ds = datasheets.find((d) => d.faction === faction && (d.points?.length ?? 0) > 0)!;
  return addUnit(createArmyList(faction, 'Grizzled Company', 'Incursion', name), ds);
}

describe('saved lists → sim2 named-list payloads (Auto Player bridge)', () => {
  beforeEach(() => localStorage.clear());

  it('transcribes unit NAMES, counts and flags — no ids of either schema', () => {
    const list = makeSavedList('My AM List');
    const ds = datasheets.find((d) => d.id === list.units[0]!.datasheetId)!;
    list.units[0]!.warlord = true;
    list.units[0]!.enhancementId = enhancements[0]!.id;

    const { army } = convertSavedList(list);
    expect(army).toBeTruthy();
    const p = army!.payload;
    expect(p.kind).toBe('sim2_named_list');
    expect(p.name).toBe('My AM List');
    expect(p.faction).toBe('AM');
    expect(p.detachment).toBe('Grizzled Company');
    expect(p.battle_size).toBe(1000); // Incursion
    expect(p.units).toHaveLength(1);
    expect(p.units[0]!.name).toBe(ds.name); // the name, not the Wahapedia id
    expect(p.units[0]!.models).toBe(list.units[0]!.modelCount);
    expect(p.units[0]!.warlord).toBe(true);
    expect(p.units[0]!.enhancement).toBe(enhancements[0]!.name);
    expect(army!.problems).toEqual([]);
  });

  it('maps the v1 AoI faction code to the v2 IA code', () => {
    const { army } = convertSavedList(makeSavedList('Agents', 'AoI'));
    expect(army!.payload.faction).toBe('IA');
  });

  it('transcribes an unknown catalog id verbatim and flags it, never dropping it', () => {
    const list = makeSavedList('Broken List');
    list.units[0]!.datasheetId = '999999999';
    const { army } = convertSavedList(list);
    // Python is the authority: the raw id will not resolve there and the run
    // aborts — dropping the unit here would silently field a partial army.
    expect(army!.payload.units[0]!.name).toBe('999999999');
    expect(army!.problems.some((w) => w.includes('999999999'))).toBe(true);
  });

  it('skips Combat Patrol boxes with a reason (not in the v2 snapshot)', () => {
    const list = makeSavedList('CP Box');
    list.combatPatrol = true;
    const res = convertSavedList(list);
    expect(res.army).toBeUndefined();
    expect(res.skip).toMatch(/Combat Patrol/);
  });

  it('reads every saved list from localStorage into the catalog', () => {
    const good = makeSavedList('Zulu List');
    const cp = makeSavedList('A CP Box');
    cp.combatPatrol = true;
    writeSavedArmyLists({ [good.name]: good, [cp.name]: cp });

    const cat = loadSavedArmyCatalog();
    expect(cat.armies.map((s) => s.payload.name)).toEqual(['Zulu List']);
    expect(cat.skipped).toEqual([
      { name: 'A CP Box', reason: expect.stringMatching(/Combat Patrol/) },
    ]);
  });

  it('returns an empty catalog for an empty store and never throws', () => {
    expect(loadSavedArmyCatalog()).toEqual({ armies: [], skipped: [] });
  });

  it('names the downloadable payload file from the list name', () => {
    const { army } = convertSavedList(makeSavedList("Jack's 1,000pt List!"));
    expect(payloadFileName(army!.payload)).toBe('jack_s_1_000pt_list.sim2list.json');
  });
});

describe('Auto Player Run tab offers saved lists', () => {
  beforeEach(() => {
    localStorage.clear();
    // No published results index in jsdom — the tab must still offer saved lists.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  });

  it('lists a saved list in the army pickers and targets its payload file in the command', async () => {
    const list = makeSavedList('My Saved Army');
    writeSavedArmyLists({ [list.name]: list });

    const { container, findAllByText } = render(<AutoPlayer />);
    // Both pickers offer the saved list under its own optgroup.
    const groups = container.querySelectorAll('optgroup[label="My saved lists (this browser)"]');
    expect(groups.length).toBe(2);
    await findAllByText(/My Saved Army — AM · 1 units \(saved\)/);
    // With no published armies the saved list is auto-selected, and the local
    // command points at its downloadable payload file.
    const cmd = container.querySelector('.ap-cmd');
    expect(cmd?.textContent).toContain('--a "./my_saved_army.sim2list.json"');
    expect(cmd?.textContent).toContain('--b "./my_saved_army.sim2list.json"');
  });
});
