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
  it('renders terrain and places models from the demo roster via the ghost flow', () => {
    expect(rosters.some((r) => r.sample)).toBe(true);
    const { container } = render(<MeasuringBoard />);
    expect(container.querySelectorAll('polygon').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.model-token')).toHaveLength(0);

    // Pick a unit up for placement, then drop it on the board with a click.
    const sidebar = container.querySelector('.sidebar')!;
    fireEvent.click(within(sidebar as HTMLElement).getAllByText('+ Place')[0]!);
    expect(container.querySelector('.board-hud.placing')).toBeTruthy();

    // jsdom's synthetic PointerEvent drops clientX/Y, so fire a MouseEvent typed 'pointerdown'
    // (which carries real coords) — React routes it to onPointerDown all the same.
    const svg = container.querySelector('svg.board-svg')!;
    fireEvent(svg, new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }));
    expect(container.querySelectorAll('.model-token').length).toBeGreaterThan(0);
    // committing exits placement mode
    expect(container.querySelector('.board-hud.placing')).toBeNull();
  });
});

describe('Deployment flow', () => {
  it('starts a battle, rolls off with dice, and offers zone deployment', () => {
    const { container, getByText } = render(<MeasuringBoard />);

    // Enter deployment.
    fireEvent.click(container.querySelector('.newbattle')!);
    expect(getByText('Deployment')).toBeTruthy();

    // Roll off for Attacker/Defender -> dice render and a role is assigned.
    fireEvent.click(getByText(/Roll off/));
    expect(container.querySelectorAll('svg[aria-label^="die showing"]').length).toBeGreaterThan(0);
    expect(container.textContent).toMatch(/is Attacker/);

    // Whoever deploys first may be the AI seat (the roll-off is seeded) — flip both seats to
    // Human so the sidebar offers manual deployment buttons.
    const humanButtons = within(container.querySelector('.ai-bar') as HTMLElement).getAllByText('Human');
    for (const b of humanButtons) fireEvent.click(b);

    // The side that deploys first now has units offered for deployment.
    const sidebar = container.querySelector('.sidebar')!;
    expect(within(sidebar as HTMLElement).getAllByText('+ Deploy').length).toBeGreaterThan(0);
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
