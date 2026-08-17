import { useEffect, useMemo, useState } from 'react';
import type { ArmySummary, BatchResult, BattleLog, OptimizerResult, ResultsIndex } from './artifacts';
import { checkResultVersion, fetchJson, loadIndex } from './artifacts';
import { ReplayViewer } from './ReplayViewer';
import {
  loadSavedArmyCatalog,
  payloadFileName,
  type SavedArmy,
  type SavedArmyCatalog,
} from './savedArmies';

/**
 * Auto Player — the v2 simulator's control-and-replay surface (brief §11).
 *
 * GitHub Pages cannot execute the engine, so this app does three things:
 * configure a run (and hand you the exact command, or dispatch it to GitHub
 * Actions), read the committed result artifacts, and replay any battle log.
 *
 * The surface follows the app shell: on desktop an in-page tab strip under the
 * top nav, on phones the same bottom tab bar as the List Builder / board.
 */

type Tab = 'run' | 'results' | 'replay';

const TOKEN_KEY = 'autoplayer.ghtoken';
const REPO_KEY = 'autoplayer.repo';

export function AutoPlayer() {
  const [tab, setTab] = useState<Tab>('run');
  const [index, setIndex] = useState<ResultsIndex | null>(null);
  const [error, setError] = useState<string>('');
  const [log, setLog] = useState<BattleLog | null>(null);

  useEffect(() => {
    loadIndex()
      .then(setIndex)
      .catch((e) =>
        setError(
          `No published results yet (${String(e.message ?? e)}). Run a batch with the CLI ` +
            `or the GitHub Action, then commit results/.`,
        ),
      );
  }, []);

  const tabs: Array<{ id: Tab; ico: string; label: string }> = [
    { id: 'run', ico: '▶️', label: 'Run' },
    { id: 'results', ico: '📊', label: 'Results' },
    { id: 'replay', ico: '🎞️', label: 'Replay' },
  ];

  return (
    <div className="autoplayer">
      {/* Desktop tab strip (hidden on phones — the bottom bar takes over). */}
      <div className="ap-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.ico} {t.label}
          </button>
        ))}
        <span className="ap-datav">
          {index?.data_version ? `snapshot ${index.data_version}` : ''}
        </span>
      </div>

      <div className="ap-page">
        {error && <p className="ap-warn">{error}</p>}

        {tab === 'run' && <RunTab index={index} />}
        {tab === 'results' && (
          <ResultsTab index={index} onReplay={(l) => { setLog(l); setTab('replay'); }} />
        )}
        {tab === 'replay' && <ReplayTab index={index} log={log} setLog={setLog} />}
      </div>

      {/* Mobile-only bottom nav — same shell as the List Builder / board pages. */}
      <div className="m-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
          >
            <span className="m-ico" aria-hidden>{t.ico}</span>
            <span>{t.label}</span>
          </button>
        ))}
        {index?.data_version && <span className="m-points">{index.data_version}</span>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Run --- */

/** Picker values: published armies are their plain name; saved lists are
 *  prefixed so a name collision with a published army stays unambiguous. */
const SAVED_PREFIX = 'saved:';

function ArmyPicker({
  label, value, onChange, armies, saved,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  armies: ArmySummary[];
  saved: SavedArmyCatalog;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {armies.length > 0 && (
          <optgroup label="Published (data2/armies)">
            {armies.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name} — {x.faction} {x.points}pts [{x.disposition}]
              </option>
            ))}
          </optgroup>
        )}
        {saved.armies.length > 0 && (
          <optgroup label="My saved lists (this browser)">
            {saved.armies.map((s) => (
              <option key={SAVED_PREFIX + s.payload.name} value={SAVED_PREFIX + s.payload.name}>
                {s.payload.name} — {s.payload.faction} · {s.payload.units.length} units (saved)
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** Hand the browser-held payload to the user as a file the CLI can take. */
function downloadPayload(s: SavedArmy) {
  const blob = new Blob([JSON.stringify(s.payload, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url;
  el.download = payloadFileName(s.payload);
  el.click();
  URL.revokeObjectURL(url);
}

function RunTab({ index }: { index: ResultsIndex | null }) {
  const armies = index?.armies ?? [];
  // Saved List Builder lists, converted to named-list payloads (savedArmies.ts).
  const saved = useMemo(() => loadSavedArmyCatalog(), []);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [mode, setMode] = useState<'batch' | 'optimize'>('batch');
  const [games, setGames] = useState(20);
  const [size, setSize] = useState(1000);
  const [seed, setSeed] = useState(1);
  const [agentA, setAgentA] = useState('heuristic');
  const [agentB, setAgentB] = useState('heuristic');
  const [candidates, setCandidates] = useState(20);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [repo, setRepo] = useState(
    () => localStorage.getItem(REPO_KEY) ?? 'brandongreen00/40k-battle-simulator',
  );
  const [dispatch, setDispatch] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const fallback = saved.armies.length ? SAVED_PREFIX + saved.armies[0].payload.name : '';
    if (!a) {
      if (armies.length) setA(armies[0].name);
      else if (fallback) setA(fallback);
    }
    if (!b) {
      if (armies.length > 1) setB(armies[1].name);
      else if (armies.length) setB(armies[0].name);
      else if (fallback) setB(fallback);
    }
  }, [armies, saved, a, b]);

  // A saved-list selection resolves to its payload; a published one to its name.
  const savedByName = useMemo(
    () => new Map(saved.armies.map((s) => [s.payload.name, s])),
    [saved],
  );
  const savedOf = (v: string): SavedArmy | undefined =>
    v.startsWith(SAVED_PREFIX) ? savedByName.get(v.slice(SAVED_PREFIX.length)) : undefined;
  const labelOf = (v: string): string =>
    v.startsWith(SAVED_PREFIX) ? v.slice(SAVED_PREFIX.length) : v;

  const savedA = savedOf(a);
  const savedB = savedOf(b);
  // In the local command a saved list is the downloaded payload file next to
  // the CLI; sim2.cli resolves its unit names against the snapshot at run time.
  const aArg = savedA ? `./${payloadFileName(savedA.payload)}` : labelOf(a);
  const bArg = savedB ? `./${payloadFileName(savedB.payload)}` : labelOf(b);
  // The payload files the local command actually reads (the optimizer's seed
  // side contributes only its faction, so no file is needed for it).
  const commandFiles = [...new Set(
    (mode === 'batch' ? [savedA, savedB] : [savedB]).filter((s): s is SavedArmy => !!s),
  )];

  const command = useMemo(() => {
    if (mode === 'optimize') {
      const faction =
        savedA?.payload.faction ?? armies.find((x) => x.name === a)?.faction ?? 'AM';
      return `python3 -m sim2.cli optimize --faction ${faction} --vs "${bArg}" ` +
        `--candidates ${candidates} --games ${games} --battle-size ${size} --seed ${seed}`;
    }
    return `python3 -m sim2.cli batch --a "${aArg}" --b "${bArg}" --games ${games} ` +
      `--battle-size ${size} --seed ${seed} --agent-a ${agentA} --agent-b ${agentB}`;
  }, [mode, a, aArg, bArg, games, size, seed, agentA, agentB, candidates, armies, savedA]);

  function copyCommand() {
    navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => undefined);
  }

  async function runOnActions() {
    setDispatch('dispatching…');
    try {
      const workflow = mode === 'batch' ? 'simulate.yml' : 'optimize.yml';
      const inputs: Record<string, string> =
        mode === 'batch'
          ? { army_a: labelOf(a), army_b: labelOf(b), games: String(games),
              battle_size: String(size), seed: String(seed),
              agent_a: agentA, agent_b: agentB }
          : { faction: savedA?.payload.faction ?? armies.find((x) => x.name === a)?.faction ?? 'AM',
              opponent: labelOf(b), candidates: String(candidates), games: String(games),
              battle_size: String(size), seed: String(seed) };
      // A saved list rides along as a named-list payload input; the workflow
      // writes it to a file and the CLI resolves it (or refuses) at run time.
      // The keys are only sent when needed so older committed workflows keep
      // accepting published-army dispatches.
      if (mode === 'batch') {
        if (savedA) inputs.army_a_json = JSON.stringify(savedA.payload);
        if (savedB) inputs.army_b_json = JSON.stringify(savedB.payload);
      } else if (savedB) {
        inputs.opponent_json = JSON.stringify(savedB.payload);
      }
      const res = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ ref: 'main', inputs }),
        },
      );
      setDispatch(
        res.status === 204
          ? '✓ queued — the workflow commits its artifacts to results/ when it finishes'
          : `✗ ${res.status} ${res.statusText}`,
      );
    } catch (e) {
      setDispatch(`✗ ${String((e as Error).message)}`);
    }
  }

  return (
    <div className="ap-panel">
      <h2>Configure a run</h2>
      <p className="ap-dim ap-lead">
        The engine is Python and runs outside this page — GitHub Pages serves static files only.
        Copy the command below, or dispatch it to GitHub Actions with a fine-grained token
        (kept in this browser, never committed).
      </p>

      <section className="ap-sec">
        <h3>Matchup</h3>
        <div className="ap-grid">
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as 'batch' | 'optimize')}>
              <option value="batch">Batch — army vs army</option>
              <option value="optimize">Optimizer — search lists vs a fixed opponent</option>
            </select>
          </label>
          <ArmyPicker
            label={mode === 'batch' ? 'Army A' : 'Faction seed army'}
            value={a} onChange={setA} armies={armies} saved={saved}
          />
          <ArmyPicker
            label={mode === 'batch' ? 'Army B' : 'Opponent list'}
            value={b} onChange={setB} armies={armies} saved={saved}
          />
          <label>
            Battle size
            <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
              <option value={500}>500 — Combat Patrol-class</option>
              <option value={1000}>1000 — Incursion-class</option>
              <option value={2000}>2000 — Strike Force-class</option>
            </select>
          </label>
          <label>
            Games {mode === 'optimize' ? 'per candidate' : ''}
            <input type="number" min={1} max={500} value={games}
                   onChange={(e) => setGames(Number(e.target.value))} />
          </label>
          <label>
            Seed
            <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
          </label>
          {mode === 'batch' ? (
            <>
              <label>
                Agent A
                <select value={agentA} onChange={(e) => setAgentA(e.target.value)}>
                  <option value="heuristic">heuristic</option>
                  <option value="random">random</option>
                  <option value="search">search (MCTS scaffold)</option>
                </select>
              </label>
              <label>
                Agent B
                <select value={agentB} onChange={(e) => setAgentB(e.target.value)}>
                  <option value="heuristic">heuristic</option>
                  <option value="random">random</option>
                  <option value="search">search (MCTS scaffold)</option>
                </select>
              </label>
            </>
          ) : (
            <label>
              Candidate lists
              <input type="number" min={2} max={500} value={candidates}
                     onChange={(e) => setCandidates(Number(e.target.value))} />
            </label>
          )}
        </div>
        <p className="ap-dim">
          Lists saved in the List Builder appear under “My saved lists” automatically.
          {saved.skipped.length > 0 &&
            ` Not offered: ${saved.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}.`}
        </p>
        {mode === 'optimize' && savedA && (
          <p className="ap-dim">
            A saved list as the seed contributes only its faction — the optimizer generates
            its own candidate lists against the opponent.
          </p>
        )}
        {(savedA?.problems.length || savedB?.problems.length) ? (
          <p className="ap-warn">
            ⚠ {[...new Set([...(savedA?.problems ?? []), ...(savedB?.problems ?? [])])].join(' · ')}
          </p>
        ) : null}
      </section>

      <section className="ap-sec">
        <h3>Run it locally</h3>
        <pre className="ap-cmd">{command}</pre>
        <div className="ap-btnrow">
          <button className="ap-ghost" onClick={copyCommand}>
            {copied ? '✓ Copied' : '⧉ Copy command'}
          </button>
          {commandFiles.map((s) => (
            <button key={s.payload.name} className="ap-ghost" onClick={() => downloadPayload(s)}>
              ⬇ {payloadFileName(s.payload)}
            </button>
          ))}
        </div>
        {commandFiles.length > 0 && (
          <p className="ap-dim">
            Saved lists exist only in this browser — download the army file(s) into the
            folder you run the command from. Unit names resolve against the v2 snapshot
            when the run starts; anything that does not resolve aborts the run instead of
            fielding a partial army.
          </p>
        )}
      </section>

      <section className="ap-sec">
        <h3>Or run it on GitHub Actions</h3>
        <div className="ap-grid">
          <label>
            Repository
            <input value={repo} onChange={(e) => { setRepo(e.target.value); localStorage.setItem(REPO_KEY, e.target.value); }} />
          </label>
          <label>
            Fine-grained token (Actions: write)
            <input type="password" value={token} placeholder="github_pat_…"
                   onChange={(e) => { setToken(e.target.value); localStorage.setItem(TOKEN_KEY, e.target.value); }} />
          </label>
        </div>
        <div className="ap-btnrow">
          <button className="ap-primary" disabled={!token} onClick={runOnActions}>
            🚀 Dispatch workflow
          </button>
        </div>
        {dispatch && <p className="ap-dim">{dispatch}</p>}
        <p className="ap-dim">
          The token stays in this browser's local storage. Committing a token to the repository is
          prohibited.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ Results --- */
function ResultsTab({
  index,
  onReplay,
}: {
  index: ResultsIndex | null;
  onReplay: (log: BattleLog) => void;
}) {
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [opt, setOpt] = useState<OptimizerResult | null>(null);
  const [warn, setWarn] = useState('');

  useEffect(() => {
    const first = index?.batches?.[0];
    if (first) {
      fetchJson<BatchResult>(first.path)
        .then((b) => {
          setBatch(b);
          setWarn(checkResultVersion(b.result_schema_version) ?? '');
        })
        .catch(() => undefined);
    }
    const o = index?.optimizer?.[0];
    if (o) fetchJson<OptimizerResult>(o.path).then(setOpt).catch(() => undefined);
  }, [index]);

  const cov = index?.coverage;

  return (
    <div className="ap-panel">
      <h2>Results</h2>
      {warn && <p className="ap-warn">⚠ {warn}</p>}

      {cov && (
        <section className="ap-sec">
          <h3>Data snapshot</h3>
          <div className="ap-cards">
            <Card label="datasheets" value={cov.datasheets ?? 0} />
            <Card label="effect records" value={cov.effects ?? 0}
                  sub={`${boundCount(cov)} bound to primitives`} />
            <Card label="detachments" value={cov.detachments ?? 0} />
            <Card label="layouts" value={cov.layouts ?? 0} />
            <Card label="logged gaps" value={cov.gaps ?? 0} sub="never guessed" />
          </div>
        </section>
      )}

      {batch ? (
        <section className="ap-sec">
          <h3>
            {batch.config.armies[0]} vs {batch.config.armies[1]}
            <span className="ap-dim">
              {' '}· {batch.config.games} games · {batch.config.battle_size}pts ·{' '}
              {batch.config.agents.join(' vs ')}
            </span>
          </h3>
          <div className="ap-cards">
            <Card label="win rate A" value={`${Math.round(batch.totals.win_rate[0] * 100)}%`} />
            <Card label="win rate B" value={`${Math.round(batch.totals.win_rate[1] * 100)}%`} />
            <Card label="draws" value={batch.totals.draws} />
            <Card label="avg VP" value={batch.totals.avg_vp.join(' : ')} />
            <Card label="illegal actions" value={batch.totals.rejected_actions}
                  sub="engine legality metric" />
            <Card label="avg seconds/game" value={batch.totals.avg_duration_s} />
          </div>

          <div className="ap-scroll">
            <table className="ap-table">
              <thead>
                <tr>
                  <th>seed</th><th>VP</th><th>winner</th><th>rounds</th>
                  <th>layout</th><th>primaries</th><th></th>
                </tr>
              </thead>
              <tbody>
                {batch.games.map((g) => (
                  <tr key={g.seed}>
                    <td>{g.seed}</td>
                    <td>{g.vp.join(' : ')}</td>
                    <td className={g.winner === null ? '' : `p${g.winner}`}>
                      {g.winner === null ? 'draw' : batch.config.armies[g.winner]}
                    </td>
                    <td>{g.rounds}</td>
                    <td className="ap-dim">{g.layout}</td>
                    <td className="ap-dim">{g.primaries.join(' / ')}</td>
                    <td>
                      {g.log && (
                        <button
                          className="ap-ghost"
                          onClick={() =>
                            fetchJson<BattleLog>(g.log!.replace(/^results\//, '')).then(onReplay)
                          }
                        >
                          🎞 replay
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <p className="ap-dim">No batch artifact published yet.</p>
      )}

      {opt && (
        <section className="ap-sec">
          <h3>
            Optimizer leaderboard
            <span className="ap-dim">
              {' '}· {String(opt.config.faction)} vs {String(opt.config.opponent)} ·{' '}
              {opt.pool_size} legal datasheets searched
            </span>
          </h3>
          <div className="ap-scroll">
            <table className="ap-table">
              <thead>
                <tr><th>#</th><th>list</th><th>pts</th><th>score</th><th>W</th><th>avg VP</th></tr>
              </thead>
              <tbody>
                {opt.leaderboard.slice(0, 12).map((e, i) => (
                  <tr key={e.name}>
                    <td>{i + 1}</td>
                    <td>
                      {e.name}
                      <div className="ap-dim ap-units">
                        {e.units.map((u) => `${u.models}× ${u.datasheet.split('.').pop()}`).join(', ')}
                      </div>
                    </td>
                    <td>{e.points}</td>
                    <td>{e.score}</td>
                    <td>{e.wins}/{e.games}</td>
                    <td>{e.avg_vp_for} : {e.avg_vp_against}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function boundCount(cov: NonNullable<ResultsIndex['coverage']>): number {
  return Object.values(cov.effects_by_kind ?? {}).reduce((n, k) => n + k.bound, 0);
}

function Card({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="ap-card">
      <div className="ap-card-value">{value}</div>
      <div className="ap-card-label">{label}</div>
      {sub && <div className="ap-dim ap-card-sub">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- Replay --- */
function ReplayTab({
  index,
  log,
  setLog,
}: {
  index: ResultsIndex | null;
  log: BattleLog | null;
  setLog: (l: BattleLog | null) => void;
}) {
  const [error, setError] = useState('');
  const logs = index?.logs ?? [];

  function onFile(file: File) {
    file
      .text()
      .then((t) => setLog(JSON.parse(t) as BattleLog))
      .catch((e) => setError(String(e)));
  }

  if (log) return <ReplayViewer log={log} onClose={() => setLog(null)} />;

  return (
    <div className="ap-panel">
      <h2>Replay a battle</h2>
      {error && <p className="ap-warn">{error}</p>}

      <section className="ap-sec">
        <h3>Published battle logs</h3>
        {logs.length ? (
          <ul className="ap-loglist">
            {logs.map((l) => (
              <li key={l.path}>
                <button
                  className="ap-logrow"
                  onClick={() =>
                    fetchJson<BattleLog>(l.path.replace(/^results\//, ''))
                      .then(setLog)
                      .catch((e) => setError(String(e)))
                  }
                >
                  <span className="ap-logname">🎞 {l.label ?? l.path}</span>
                  <span className="ap-dim">{l.generated ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ap-dim">No published battle logs yet.</p>
        )}
      </section>

      <section className="ap-sec">
        <h3>Open a log from disk</h3>
        <label className="ap-file">
          Any log written by the CLI (<code>results/logs/battle_&lt;seed&gt;.json</code>) replays
          here.
          <input
            type="file"
            accept="application/json"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>
      </section>
    </div>
  );
}
