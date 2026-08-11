/**
 * The artifact contract (brief §11).
 *
 * The Pages app never runs the engine — GitHub Pages cannot execute Python.
 * Every executor (the CLI on a laptop, a GitHub Actions runner, a GPU box)
 * writes the SAME versioned JSON into `results/`, which is published with the
 * site. This module is the only place that knows those shapes.
 */

export const RESULT_SCHEMA_VERSION = '2.0.0';
export const LOG_SCHEMA_VERSION = '2.0.0';

export interface ResultsIndex {
  generated?: string;
  data_version?: string;
  armies?: ArmySummary[];
  batches?: ArtifactRef[];
  optimizer?: ArtifactRef[];
  logs?: ArtifactRef[];
  coverage?: Coverage;
}

export interface ArtifactRef {
  path: string;
  label?: string;
  generated?: string;
}

export interface ArmySummary {
  name: string;
  faction: string;
  detachment: string;
  disposition: string;
  points: number;
  units: number;
  battle_size: number;
}

export interface Coverage {
  datasheets?: number;
  effects?: number;
  effects_by_kind?: Record<string, { total: number; bound: number }>;
  detachments?: number;
  layouts?: number;
  missions?: number;
  gaps?: number;
}

export interface GameRow {
  seed: number;
  vp: [number, number];
  winner: number | null;
  rounds: number;
  actions: number;
  rejected: number;
  layout: string;
  armies: [string, string];
  dispositions: [string, string];
  primaries: [string, string];
  duration_s: number;
  log?: string;
}

export interface BatchResult {
  result_schema_version: string;
  kind: 'batch';
  generated: string;
  config: {
    armies: [string, string];
    agents: [string, string];
    battle_size: number;
    games: number;
    seed: number;
  };
  totals: {
    wins: [number, number];
    draws: number;
    win_rate: [number, number];
    avg_vp: [number, number];
    avg_rounds: number;
    rejected_actions: number;
    avg_duration_s: number;
  };
  games: GameRow[];
}

export interface OptimizerEntry {
  name: string;
  points: number;
  detachment: string;
  units: { datasheet: string; models: number }[];
  score: number;
  wins: number;
  games: number;
  avg_vp_for: number;
  avg_vp_against: number;
}

export interface OptimizerResult {
  result_schema_version: string;
  kind: 'optimizer';
  generated: string;
  config: Record<string, unknown>;
  pool_size: number;
  duration_s: number;
  leaderboard: OptimizerEntry[];
}

/* -- battle logs -------------------------------------------------------- */
export interface LogModel { x: number; y: number; r: number; w: number; }
export interface LogUnit {
  uid: string; owner: number; name: string; models: LogModel[]; shocked?: boolean;
}
export interface BoardSnapshot {
  units: LogUnit[];
  objectives: Record<string, number | null>;
  reserves: { uid: string; owner: number; name: string }[];
}
export interface LogFrame {
  t: number;
  round: number;
  phase: string;
  active: number;
  action: { kind: string; params: Record<string, unknown>; label?: string };
  events: Record<string, unknown>[];
  cp: [number, number];
  vp: [number, number];
  board?: BoardSnapshot;
}
export interface LayoutSnapshot {
  id: string;
  width: number;
  height: number;
  terrain: { id: string; category: string; polygon: [number, number][] }[];
  objectives: { id: string; pos: [number, number]; kind: string; owner: number | null }[];
  deployment_zones: Record<string, [number, number][][]>;
}
export interface BattleLog {
  log_schema_version: string;
  seed: number;
  meta: {
    layout: LayoutSnapshot;
    armies: [string, string];
    factions: [string, string];
    dispositions: [string, string];
    primaries: [string, string];
    battle_size: number;
    agents: [string, string];
    data_version?: string;
  };
  frames: LogFrame[];
  result: {
    vp: [number, number];
    primary: [number, number];
    secondary: [number, number];
    battle_ready: [number, number];
    winner: number | null;
    rounds: number;
    survivors: [number, number];
  };
}

/* -- loading ------------------------------------------------------------ */
const BASE = import.meta.env.BASE_URL ?? '/';

export function resultsUrl(path: string): string {
  const clean = path.replace(/^\/+/, '');
  return `${BASE}${clean.startsWith('results/') ? clean : `results/${clean}`}`;
}

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(resultsUrl(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return (await res.json()) as T;
}

export async function loadIndex(): Promise<ResultsIndex> {
  return fetchJson<ResultsIndex>('index.json');
}

/** Schema guards — a mismatched artifact is reported, never silently rendered. */
export function checkResultVersion(v: string | undefined): string | null {
  if (!v) return 'artifact has no result_schema_version';
  if (v !== RESULT_SCHEMA_VERSION) {
    return `artifact schema ${v} ≠ app schema ${RESULT_SCHEMA_VERSION}`;
  }
  return null;
}

export function checkLogVersion(v: string | undefined): string | null {
  if (!v) return 'battle log has no log_schema_version';
  if (v !== LOG_SCHEMA_VERSION) {
    return `battle log schema ${v} ≠ app schema ${LOG_SCHEMA_VERSION}`;
  }
  return null;
}
