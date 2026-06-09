// Saved army lists live in the browser's localStorage (the List Builder writes them, the board
// reads them). This is browser/IO code — deliberately kept OUT of src/core, which stays pure.

import type { ArmyList, DataIndex } from '../core/army';
import { toRoster } from '../core/army';
import type { Roster } from '../core/types';

/** localStorage key the List Builder saves army lists under (keyed by list name). */
export const SAVED_LISTS_KEY = '40k-armylists';

export function loadSavedArmyLists(): Record<string, ArmyList> {
  try {
    return JSON.parse(localStorage.getItem(SAVED_LISTS_KEY) ?? '{}') as Record<string, ArmyList>;
  } catch {
    return {};
  }
}

export function writeSavedArmyLists(map: Record<string, ArmyList>): void {
  localStorage.setItem(SAVED_LISTS_KEY, JSON.stringify(map));
}

/**
 * Saved army lists converted to board-ready Rosters, so a list saved in the builder can be
 * picked when starting a game (and survives a page refresh). Lists that fail to convert are
 * skipped rather than crashing the picker.
 */
export function loadSavedRosters(ix: DataIndex): Roster[] {
  return Object.values(loadSavedArmyLists())
    .map((list) => {
      try {
        return toRoster(list, ix);
      } catch {
        return null;
      }
    })
    .filter((r): r is Roster => r !== null);
}
