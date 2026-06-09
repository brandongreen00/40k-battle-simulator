import { useMemo, useReducer, useRef, useState } from 'react';
import type { Roster, RosterUnit, Side, Vec2 } from '../core/types';
import { reduce, createInitialState, type Intent } from '../core/state';
import { makeRNG } from '../core/rng';
import { clamp } from '../core/geometry';
import { datasheetsById, getDatasheet, layouts, rosters } from '../data/loaders';
import { Board } from './Board';
import { OWNER_COLOR, TERRAIN_STYLE } from './view';

// Seeded RNG for reproducibility (Stage 1 intents are deterministic; the seam is what matters).
const rng = makeRNG(0xc0ffee);

export function App() {
  const layout = layouts[0];
  const [state, dispatch] = useReducer(
    (s: ReturnType<typeof createInitialState>, i: Intent) => reduce(s, i, rng),
    layout,
    createInitialState,
  );
  const [rosterName, setRosterName] = useState<string>(rosters[0]?.name ?? '');
  const [owner, setOwner] = useState<Side>('player');
  const spawnCount = useRef(0);

  const roster: Roster | undefined = useMemo(
    () => rosters.find((r) => r.name === rosterName),
    [rosterName],
  );

  if (!layout) {
    return <div className="app-shell">No layout found in data/layouts.</div>;
  }

  function spawn(unit: RosterUnit) {
    const ds = getDatasheet(unit.datasheetId);
    if (!ds) return;
    const n = spawnCount.current++;
    const zoneX = owner === 'player' ? 9 : 51;
    const anchor: Vec2 = {
      x: clamp(zoneX + ((n % 3) - 1) * 5, 3, layout!.boardWidth - 3),
      y: clamp(22 + ((Math.floor(n / 3) % 3) - 1) * 10, 6, layout!.boardHeight - 6),
    };
    dispatch({
      type: 'SpawnUnit',
      unitId: `u${n}`,
      owner,
      datasheetId: ds.id,
      baseShape: ds.baseShape,
      modelCount: unit.modelCount,
      wounds: ds.models[0]?.W ?? 1,
      anchor,
    });
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Measuring Board</h1>
        <p className="muted">
          {layout.name ?? layout.id} · {layout.deployment} · {layout.boardWidth}"×{layout.boardHeight}"
        </p>

        <section>
          <label className="field">
            <span>Roster</span>
            <select value={rosterName} onChange={(e) => setRosterName(e.target.value)}>
              {rosters.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                  {r.sample ? ' (demo)' : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span>Spawn as</span>
            <div className="seg">
              {(['player', 'ai'] as const).map((o) => (
                <button
                  key={o}
                  className={owner === o ? 'seg-on' : ''}
                  style={{ borderColor: OWNER_COLOR[o].fill }}
                  onClick={() => setOwner(o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
        </section>

        {roster?.note && <p className="note">{roster.note}</p>}

        <section>
          <h2>Units</h2>
          {roster && roster.units.length > 0 ? (
            <ul className="unit-list">
              {roster.units.map((u, i) => {
                const ds = getDatasheet(u.datasheetId);
                const m = ds?.models[0];
                return (
                  <li key={i}>
                    <button className="spawn" onClick={() => spawn(u)} disabled={!ds}>
                      + Spawn
                    </button>
                    <span className="unit-name">{u.displayName ?? ds?.name ?? u.datasheetId}</span>
                    <span className="unit-meta">
                      ×{u.modelCount}
                      {m ? ` · M${m.M}" T${m.T} Sv${m.Sv}+ W${m.W}` : ds ? '' : ' · UNRESOLVED'}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">This roster has no units yet (see note above). Pick the demo roster to try the board.</p>
          )}
        </section>

        <section>
          <h2>On board ({state.units.length})</h2>
          {state.units.length > 0 && (
            <button className="clear" onClick={() => dispatch({ type: 'ClearUnits' })}>
              Clear all
            </button>
          )}
          <ul className="unit-list">
            {state.units.map((u) => {
              const ds = getDatasheet(u.datasheetId);
              return (
                <li key={u.id}>
                  <button className="remove" onClick={() => dispatch({ type: 'RemoveUnit', unitId: u.id })}>
                    ×
                  </button>
                  <span className="dot" style={{ background: OWNER_COLOR[u.owner].fill }} />
                  <span className="unit-name">{ds?.name ?? u.datasheetId}</span>
                  <span className="unit-meta">×{u.models.length}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="legend">
          <h2>Legend</h2>
          {Object.values(TERRAIN_STYLE).map((s) => (
            <div key={s.label} className="legend-row">
              <span className="swatch" style={{ background: s.fill, borderColor: s.stroke }} />
              {s.label}
            </div>
          ))}
          <div className="legend-row">
            <span className="swatch" style={{ background: 'rgba(234,179,8,0.25)', borderColor: '#eab308' }} />
            Objective marker
          </div>
        </section>
      </aside>

      <main className="board-main">
        <Board layout={layout} units={state.units} datasheetsById={datasheetsById} onMoveModel={(id, pos) => dispatch({ type: 'MoveModel', modelId: id, pos })} />
      </main>
    </div>
  );
}
