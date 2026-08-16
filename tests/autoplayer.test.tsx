import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AutoPlayer } from '../src/ui/autoplayer/AutoPlayer';
import { ReplayViewer } from '../src/ui/autoplayer/ReplayViewer';
import type { BattleLog, ResultsIndex } from '../src/ui/autoplayer/artifacts';
import { checkLogVersion, checkResultVersion } from '../src/ui/autoplayer/artifacts';

const index: ResultsIndex = {
  generated: '2026-08-11T00:00:00Z',
  data_version: '2026-08-11',
  armies: [
    { name: 'Alpha', faction: 'IA', detachment: 'ia.imperialis_fleet',
      disposition: 'Reconnaissance', points: 985, units: 10, battle_size: 1000 },
    { name: 'Beta', faction: 'AM', detachment: 'am.grizzled_company',
      disposition: 'Priority Assets', points: 990, units: 12, battle_size: 1000 },
  ],
  coverage: { datasheets: 179, effects: 175, detachments: 16, layouts: 45, gaps: 193 },
  batches: [], optimizer: [], logs: [],
};

const log: BattleLog = {
  log_schema_version: '2.0.0',
  seed: 42,
  meta: {
    layout: {
      id: 'test', width: 44, height: 60,
      terrain: [{ id: 'a', category: 'dense', polygon: [[10, 10], [20, 10], [20, 20], [10, 20]] }],
      objectives: [{ id: 'obj-0', pos: [22, 30], kind: 'central', owner: null }],
      deployment_zones: { attacker: [[[0, 48], [44, 48], [44, 60], [0, 60]]] },
    },
    armies: ['Alpha', 'Beta'],
    factions: ['IA', 'AM'],
    dispositions: ['Reconnaissance', 'Priority Assets'],
    primaries: ['SEARCH AND SCOUR', 'VANGUARD OPERATION'],
    battle_size: 1000,
    agents: ['heuristic', 'heuristic'],
  },
  frames: [
    {
      t: 1, round: 1, phase: 'movement', active: 0,
      action: { kind: 'move_unit', params: {}, label: 'normal p0:1' },
      events: [{ kind: 'move', unit: 'p0:1' }],
      cp: [1, 1], vp: [0, 0],
      board: {
        units: [{ uid: 'p0:1', owner: 0, name: 'Squad', models: [{ x: 22, y: 40, r: 0.63, w: 1 }] }],
        objectives: { 'obj-0': 0 },
        reserves: [],
      },
    },
    {
      t: 2, round: 5, phase: 'fight', active: 1,
      action: { kind: 'fight', params: {}, label: 'fight' },
      events: [{ kind: 'vp', player: 1, vp: 5, vp_kind: 'primary' }],
      cp: [3, 2], vp: [10, 15],
    },
  ],
  result: {
    vp: [10, 15], primary: [0, 5], secondary: [0, 0], battle_ready: [10, 10],
    winner: 1, rounds: 5, survivors: [3, 4],
  },
};

describe('Auto Player artifact contract', () => {
  it('flags a result artifact from a different schema version', () => {
    expect(checkResultVersion('2.0.0')).toBeNull();
    expect(checkResultVersion('1.4.0')).toContain('2.0.0');
    expect(checkResultVersion(undefined)).toContain('no result_schema_version');
  });

  it('flags a battle log from a different schema version', () => {
    expect(checkLogVersion('2.0.0')).toBeNull();
    expect(checkLogVersion('9.9.9')).toContain('≠');
  });
});

describe('Auto Player shell', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK', json: async () => index,
    })) as unknown as typeof fetch);
  });

  it('offers the published armies in the run configurator', async () => {
    render(<AutoPlayer />);
    await waitFor(() => expect(screen.getByText(/Configure a run/i)).toBeTruthy());
    await waitFor(() =>
      expect(screen.getAllByText(/Alpha — IA 985pts \[Reconnaissance\]/).length).toBeGreaterThan(0),
    );
  });

  it('builds a runnable CLI command from the form', async () => {
    render(<AutoPlayer />);
    await waitFor(() =>
      expect(document.querySelector('.ap-cmd')?.textContent).toContain('python3 -m sim2.cli batch'),
    );
    expect(document.querySelector('.ap-cmd')?.textContent).toContain('--battle-size 1000');
  });
});

describe('Replay viewer', () => {
  it('draws terrain, objectives and models from the log', () => {
    const { container } = render(<ReplayViewer log={log} />);
    expect(container.querySelectorAll('.ap-terrain').length).toBe(1);
    expect(container.querySelectorAll('.ap-obj').length).toBe(1);
    expect(container.querySelectorAll('.ap-model').length).toBe(1);
    // board coordinates are bottom-left origin, so y is flipped for SVG
    const model = container.querySelector('.ap-model') as SVGCircleElement;
    expect(Number(model.getAttribute('cy'))).toBeCloseTo((60 - 40) * 9, 3);
  });

  it('carries the last board snapshot forward across frames without one', () => {
    const { container } = render(<ReplayViewer log={log} />);
    const range = container.querySelector('input[type=range]') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '1' } });
    // frame 2 carries no board of its own, so frame 1's board still renders
    expect(container.querySelectorAll('.ap-model').length).toBe(1);
    expect(container.textContent).toContain('Round');
  });

  it('shows the final score once the log ends', () => {
    const { container } = render(<ReplayViewer log={log} />);
    const last = container.querySelector('.ap-transport button:nth-child(5)') as HTMLButtonElement;
    fireEvent.click(last);
    expect(container.textContent).toContain('Beta wins');
  });
});

describe('Replay viewer against a real engine log', () => {
  // The published artifact is the actual contract between the Python engine and
  // this viewer; a synthetic fixture cannot catch a shape drift in the writer.
  const files = import.meta.glob('../public/results/logs/*.json', { eager: true });
  const real = Object.values(files)[0] as { default: BattleLog } | BattleLog | undefined;

  it('renders a log written by sim2 end to end', () => {
    if (!real) return;                       // no artifact published in this checkout
    const parsed = ('default' in (real as never) ? (real as { default: BattleLog }).default
      : real) as BattleLog;
    expect(parsed.log_schema_version).toBe('2.0.0');
    const { container } = render(<ReplayViewer log={parsed} />);
    expect(container.querySelectorAll('.ap-model').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.ap-terrain').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('Round');
  });
});
