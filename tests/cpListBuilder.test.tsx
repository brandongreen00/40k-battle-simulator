// @vitest-environment jsdom
// Combat Patrol in the List Builder: picking one of the four boxed patrols from the
// Faction/Detachment menus when the battle size is "Combat Patrol".
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, within } from '@testing-library/react';
import { ListBuilder } from '../src/ui/listbuilder/ListBuilder';
import { patrolArmyList, toRoster, validate, isCharacter } from '../src/core/army';
import { dataIndex, datasheetsById, rosters } from '../src/data/loaders';
import type { Roster } from '../src/core/types';

afterEach(cleanup);

const cpPatrols = rosters.filter((r) => r.combatPatrol);

describe('patrolArmyList (pure)', () => {
  it('builds every boxed patrol as a legal, warlorded, round-tripping list', () => {
    expect(cpPatrols).toHaveLength(4);
    for (const roster of cpPatrols) {
      const list = patrolArmyList(roster, dataIndex);
      expect(list.combatPatrol).toBe(true);
      expect(list.detachment).toBe(roster.detachment);
      expect(validate(list, dataIndex)).toEqual([]); // the box is the validation
      // The first CHARACTER carries the Warlord star.
      const warlord = list.units.find((u) => u.warlord);
      expect(warlord).toBeTruthy();
      expect(isCharacter(datasheetsById.get(warlord!.datasheetId))).toBe(true);
      // Round trip: the roster the board receives IS the fixed box.
      const out = toRoster(list, dataIndex);
      expect(out.combatPatrol).toBe(true);
      expect(out.units.map((u) => [u.datasheetId, u.modelCount])).toEqual(
        roster.units.map((u) => [u.datasheetId, u.modelCount]),
      );
      for (let i = 0; i < roster.units.length; i++) {
        expect(out.units[i]!.wargearCounts ?? {}).toEqual(roster.units[i]!.wargearCounts ?? {});
      }
    }
  });
});

describe('List Builder Combat Patrol picking (jsdom)', () => {
  const factionSelect = (container: HTMLElement): HTMLSelectElement => {
    const label = [...container.querySelectorAll('label.field')].find((l) =>
      l.querySelector('span')?.textContent?.startsWith('Faction'),
    )!;
    return label.querySelector('select')!;
  };
  const sizeSelect = (container: HTMLElement): HTMLSelectElement => {
    const label = [...container.querySelectorAll('label.field')].find((l) =>
      l.querySelector('span')?.textContent?.startsWith('Battle size'),
    )!;
    return label.querySelector('select')!;
  };

  it('offers the four patrols once the battle size is Combat Patrol, and loads the fixed list', () => {
    let opened: Roster | null = null;
    const { container } = render(<ListBuilder onOpenInBoard={(r) => { opened = r; }} />);

    // Switch the battle size — the Faction menu becomes the patrol picker.
    fireEvent.change(sizeSelect(container), { target: { value: 'Combat Patrol' } });
    const fac = factionSelect(container);
    const options = [...fac.querySelectorAll('option')].map((o) => o.textContent ?? '');
    for (const want of ["Crowe's Sanctifiers", "Inquisitor's Hand", 'Sudden Dawn Cadre', 'The Vengeful Brethren']) {
      expect(options.some((o) => o.includes(want))).toBe(true);
    }

    // Picking the T'au patrol loads its fixed units into the list.
    fireEvent.change(fac, { target: { value: 'Sudden Dawn Cadre' } });
    expect(container.textContent).toMatch(/Devilfish/);
    expect(container.textContent).toMatch(/Pathfinder Team/);
    expect(container.textContent).toMatch(/Legal list/);
    // The Detachment menu shows the patrol.
    expect(container.textContent).toMatch(/Sudden Dawn Cadre/);

    // Open in board hands over a Combat Patrol roster the board's CP picker accepts.
    fireEvent.click(within(container as HTMLElement).getByText('Open in board →'));
    expect(opened).toBeTruthy();
    expect(opened!.combatPatrol).toBe(true);
    expect(opened!.units).toHaveLength(4);
  });

  it('returns to the standard factions when the battle size leaves Combat Patrol', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true); // the guarded clear asks first
    const { container } = render(<ListBuilder onOpenInBoard={() => {}} />);
    fireEvent.change(sizeSelect(container), { target: { value: 'Combat Patrol' } });
    fireEvent.change(factionSelect(container), { target: { value: "Crowe's Sanctifiers" } });
    expect(container.textContent).toMatch(/Strike Squad/);
    fireEvent.change(sizeSelect(container), { target: { value: 'Incursion' } });
    const options = [...factionSelect(container).querySelectorAll('option')].map((o) => o.textContent ?? '');
    expect(options).toContain('Astra Militarum');
    expect(options).toContain('Imperial Agents');
    expect(container.textContent).not.toMatch(/Strike Squad/);
  });
});
