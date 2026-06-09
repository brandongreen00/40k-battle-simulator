import { describe, it, expect } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { App } from '../src/ui/App';
import { MeasuringBoard } from '../src/ui/MeasuringBoard';
import { ListBuilder } from '../src/ui/listbuilder/ListBuilder';
import { rosters } from '../src/data/loaders';

describe('App shell', () => {
  it('shows the List Builder by default and switches to the board', () => {
    const { container, getByText } = render(<App />);
    expect(container.querySelector('.catalog')).toBeTruthy();
    expect(container.querySelector('svg.board-svg')).toBeNull();

    fireEvent.click(getByText('Measuring Board'));
    expect(container.querySelector('svg.board-svg')).toBeTruthy();
  });
});

describe('MeasuringBoard', () => {
  it('renders terrain and spawns models from the demo roster', () => {
    expect(rosters.some((r) => r.sample)).toBe(true);
    const { container } = render(<MeasuringBoard />);
    expect(container.querySelectorAll('polygon').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.model-token')).toHaveLength(0);

    const sidebar = container.querySelector('.sidebar')!;
    fireEvent.click(within(sidebar as HTMLElement).getAllByText('+ Spawn')[0]!);
    expect(container.querySelectorAll('.model-token').length).toBeGreaterThan(0);
  });
});

describe('ListBuilder', () => {
  it('adds a unit from the catalog and accounts for its points', () => {
    const { container } = render(<ListBuilder onOpenInBoard={() => {}} />);

    // empty list starts at 0 points
    expect(container.querySelector('.points-text')!.textContent).toMatch(/^0 \/ 1000/);

    // find the Cadian Shock Troops catalog entry (65 pts) and add it
    const names = [...container.querySelectorAll('.catalog-item .ci-name')];
    const cadian = names.find((n) => n.textContent === 'Cadian Shock Troops')!;
    expect(cadian).toBeTruthy();
    fireEvent.click(cadian.closest('button')!);

    // the unit appears in the list and points update to 65
    expect(container.querySelector('.lb-list')!.textContent).toContain('Cadian Shock Troops');
    expect(container.querySelector('.points-text')!.textContent).toMatch(/^65 \/ 1000/);
  });
});
