// @vitest-environment jsdom
// Combat Patrol in the List Builder: picking one of the four boxed patrols from the
// Faction/Detachment menus when the battle size is "Combat Patrol".
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, within } from '@testing-library/react';
import { ListBuilder } from '../src/ui/listbuilder/ListBuilder';
import { patrolArmyList, setEnhancement, toRoster, validate, isCharacter } from '../src/core/army';
import { dataIndex, datasheetsById, patrolEnhancements, rosters } from '../src/data/loaders';
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

describe('patrol enhancements in the List Builder (pure)', () => {
  it('one of the patrol’s two, on its printed bearer, rides into the roster', () => {
    const crowes = cpPatrols.find((r) => r.detachment === "Crowe's Sanctifiers")!;
    const cards = patrolEnhancements.filter((e) => e.patrolName === "Crowe's Sanctifiers");
    expect(cards).toHaveLength(2);
    const purifying = cards.find((e) => e.id.endsWith('purifying_force'))!;
    const auspexes = cards.find((e) => e.id.endsWith('sanctified_auspexes'))!;

    let list = patrolArmyList(crowes, dataIndex);
    const bearer = list.units.find((u) => u.datasheetId === purifying.targetDsId)!;
    list = setEnhancement(list, bearer.uid, purifying.id);
    expect(validate(list, dataIndex)).toEqual([]);
    const out = toRoster(list, dataIndex);
    expect(out.units.find((u) => u.datasheetId === purifying.targetDsId)!.enhancementId).toBe(purifying.id);

    // On the wrong unit → error naming the printed bearer.
    const fresh = patrolArmyList(crowes, dataIndex);
    const wrongUnit = fresh.units.find((u) => u.datasheetId !== purifying.targetDsId)!;
    const wrong = setEnhancement(fresh, wrongUnit.uid, purifying.id);
    expect(validate(wrong, dataIndex).some((v) => v.message.includes('belongs on'))).toBe(true);

    // Both cards at once → the one-per-battle rule.
    const both = setEnhancement(list, list.units.find((u) => u.datasheetId === auspexes.targetDsId)!.uid, auspexes.id);
    expect(validate(both, dataIndex).some((v) => v.message.includes('One patrol enhancement'))).toBe(true);
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

  it('offers each enhancement on its bearer card, enforces one per battle, and exports the pick', () => {
    const cardOf = (container: HTMLElement, name: string) =>
      [...container.querySelectorAll('.lu-card')].find((c) =>
        c.querySelector('.lu-name')?.textContent?.includes(name),
      ) as HTMLElement;
    const enhSelect = (card: HTMLElement) =>
      [...card.querySelectorAll('label.lu-field')]
        .find((l) => l.querySelector('span')?.textContent === 'Enhancement')
        ?.querySelector('select') as HTMLSelectElement | undefined;
    const cpOption = (sel: HTMLSelectElement) =>
      [...sel.querySelectorAll('option')].find((o) => o.getAttribute('value')?.startsWith('cpenh:'))!;

    let opened: Roster | null = null;
    const { container } = render(<ListBuilder onOpenInBoard={(r) => { opened = r; }} />);
    fireEvent.change(sizeSelect(container), { target: { value: 'Combat Patrol' } });
    fireEvent.change(factionSelect(container), { target: { value: "Crowe's Sanctifiers" } });

    // Purifying Force is printed for the Terminator squad (not a CHARACTER — the select must
    // still appear); Castellan Crowe bears neither card, so he gets no picker.
    const termSel = enhSelect(cardOf(container, 'Brotherhood Terminator Squad'))!;
    expect([...termSel.querySelectorAll('option')].some((o) => o.textContent?.includes('Purifying Force'))).toBe(true);
    expect(enhSelect(cardOf(container, 'Castellan Crowe'))).toBeFalsy();

    fireEvent.change(termSel, { target: { value: cpOption(termSel).getAttribute('value')! } });
    expect(container.textContent).toMatch(/Legal list/);
    expect(container.textContent).toMatch(/LETHAL HITS/); // the card's rule text shows on pick

    // A second pick (Sanctified Auspexes on the Dreadnought) trips the one-per-battle rule.
    const dreadSel = enhSelect(cardOf(container, 'Venerable Dreadnought'))!;
    fireEvent.change(dreadSel, { target: { value: cpOption(dreadSel).getAttribute('value')! } });
    expect(container.textContent).toMatch(/One patrol enhancement per battle/);
    fireEvent.change(dreadSel, { target: { value: '' } });
    expect(container.textContent).toMatch(/Legal list/);

    // The roster handed to the board carries the pick.
    fireEvent.click(within(container as HTMLElement).getByText('Open in board →'));
    const carried = opened!.units.find((u) => u.enhancementId);
    expect(carried?.enhancementId).toBe('cpenh:crowes_sanctifiers:purifying_force');
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
