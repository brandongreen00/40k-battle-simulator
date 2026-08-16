// @vitest-environment jsdom
// The List Builder's detachment MULTISELECT (11e multi-detachment armies): checkboxes compose
// the combined "A and B" detachment string, with the DP budget as the limiter — a 2 DP and a
// 1 DP detachment fit together at Strike Force (3 DP); a lone detachment may exceed the budget
// (the printed lone-detachment allowance); legacy 10e/Grotmas detachments are lone-only.
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup, within } from '@testing-library/react';
import { ListBuilder } from '../src/ui/listbuilder/ListBuilder';
import type { Roster } from '../src/core/types';

afterEach(cleanup);

const rows = (c: HTMLElement) => [...c.querySelectorAll('.detach-opt')] as HTMLLabelElement[];
const row = (c: HTMLElement, name: string) =>
  rows(c).find((r) => r.querySelector('.detach-name')?.textContent === name)!;
const box = (r: HTMLElement) => r.querySelector('input[type="checkbox"]') as HTMLInputElement;
const sizeSelect = (c: HTMLElement): HTMLSelectElement => {
  const label = [...c.querySelectorAll('label.field')].find((l) =>
    l.querySelector('span')?.textContent?.startsWith('Battle size'),
  )!;
  return label.querySelector('select')!;
};

describe('detachment multiselect (jsdom)', () => {
  it('composes a 2 DP + 1 DP pair at Strike Force (3 DP budget) and hands the combined name to the board', () => {
    let opened: Roster | null = null;
    const { container } = render(<ListBuilder onOpenInBoard={(r) => { opened = r; }} />);
    fireEvent.change(sizeSelect(container), { target: { value: 'Strike Force' } });

    // Every AM detachment renders as a checkbox row with its DP price.
    expect(row(container, 'Combined Arms')).toBeTruthy();
    expect(row(container, 'Combined Arms').querySelector('.detach-dp')?.textContent).toBe('2 DP');

    // Swap the default lone pick for Combined Arms (2 DP), then ADD Bridgehead Strike (1 DP).
    fireEvent.click(box(row(container, 'Abhuman Auxiliaries'))); // default off
    fireEvent.click(box(row(container, 'Combined Arms')));
    expect(container.textContent).toContain('2/3 DP');
    expect(box(row(container, 'Bridgehead Strike')).disabled).toBe(false);
    fireEvent.click(box(row(container, 'Bridgehead Strike')));
    expect(container.textContent).toContain('3/3 DP');
    expect(container.textContent).not.toContain('over budget');

    // The budget is the limiter: at 3/3 every other option is disabled (checked ones stay live).
    expect(box(row(container, 'Designation Force')).disabled).toBe(true);
    expect(box(row(container, 'Combined Arms')).disabled).toBe(false);

    // The roster the board receives carries the canonical combined name.
    fireEvent.click(within(container as HTMLElement).getByText('Open in board →'));
    expect(opened!.detachment).toBe('Combined Arms and Bridgehead Strike');
  });

  it('at Incursion (2 DP) a 2 DP partner is blocked, and a lone 3 DP pick uses the allowance', () => {
    const { container } = render(<ListBuilder onOpenInBoard={() => {}} />);
    // Default: Incursion, Abhuman Auxiliaries (1 DP) checked.
    expect(box(row(container, 'Abhuman Auxiliaries')).checked).toBe(true);
    expect(container.textContent).toContain('1/2 DP');
    expect(box(row(container, 'Combined Arms')).disabled).toBe(true); // 1+2 > 2
    expect(box(row(container, 'Bridgehead Strike')).disabled).toBe(false); // 1+1 fits

    // A lone over-budget detachment is legal (nothing checked → everything selectable).
    fireEvent.click(box(row(container, 'Abhuman Auxiliaries')));
    expect(box(row(container, 'Grizzled Company')).disabled).toBe(false);
    fireEvent.click(box(row(container, 'Grizzled Company')));
    expect(container.textContent).toContain('3/2 DP');
    expect(container.textContent).toContain('lone-detachment allowance');
    // ...but it can never take a partner (3 + anything busts the budget).
    expect(rows(container).filter((r) => !box(r).checked).every((r) => box(r).disabled)).toBe(true);
  });

  it('legacy detachments (not in the printed 11e pack) are lone-only in both directions', () => {
    const { container } = render(<ListBuilder onOpenInBoard={() => {}} />);
    // While a curated detachment is selected, the legacy row is blocked.
    const legacy = 'Tempestus Boarding Regiment';
    expect(box(row(container, legacy)).disabled).toBe(true);
    expect(row(container, legacy).getAttribute('title')).toMatch(/lone pick only/);
    // Alone it is selectable — and then blocks every other row (its combined name
    // could never split back apart).
    fireEvent.click(box(row(container, 'Abhuman Auxiliaries')));
    fireEvent.click(box(row(container, legacy)));
    expect(box(row(container, legacy)).checked).toBe(true);
    expect(rows(container).filter((r) => !box(r).checked).every((r) => box(r).disabled)).toBe(true);
    expect(row(container, 'Abhuman Auxiliaries').getAttribute('title')).toMatch(/cannot be combined/);
  });
});
