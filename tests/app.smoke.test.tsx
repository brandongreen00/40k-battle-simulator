import { describe, it, expect } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { App } from '../src/ui/App';
import { rosters } from '../src/data/loaders';

// Light integration smoke test: exercises data loaders -> reducer -> render end to end.
describe('App', () => {
  it('renders the measuring board without crashing', () => {
    const { container } = render(<App />);
    expect(container.querySelector('svg.board-svg')).toBeTruthy();
    // terrain + objectives should have rendered some polygons
    expect(container.querySelectorAll('polygon').length).toBeGreaterThan(0);
  });

  it('spawns models from the demo roster onto the board', () => {
    const demo = rosters.find((r) => r.sample);
    expect(demo, 'a demo/sample roster should exist').toBeTruthy();

    const { container } = render(<App />);
    expect(container.querySelectorAll('.model-token')).toHaveLength(0);

    // Switch to the demo roster, which has real units.
    const select = container.querySelector('select')!;
    fireEvent.change(select, { target: { value: demo!.name } });

    const sidebar = container.querySelector('.sidebar')!;
    const spawnBtn = within(sidebar as HTMLElement).getAllByText('+ Spawn')[0]!;
    fireEvent.click(spawnBtn);

    expect(container.querySelectorAll('.model-token').length).toBeGreaterThan(0);
  });
});
