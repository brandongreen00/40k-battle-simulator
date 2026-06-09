import { useMemo, useReducer, useRef, useState } from 'react';
import type { Datasheet, Roster, RosterUnit, Side, Vec2 } from '../core/types';
import { reduce, createInitialState, type Intent } from '../core/state';
import { makeRNG } from '../core/rng';
import { nextFormation, type Formation } from '../core/formation';
import { datasheetsById, getDatasheet, layouts, rosters } from '../data/loaders';
import { Board, type Placement } from './Board';
import { GamePanel } from './GamePanel';
import { OWNER_COLOR, TERRAIN_STYLE } from './view';

/** A unit the user has picked up and is positioning with the ghost preview. */
interface Placing {
  unit: RosterUnit;
  ds: Datasheet;
  formation: Formation;
  rotation: number;
}

// Seeded RNG for reproducibility (Stage 1 intents are deterministic; the seam is what matters).
const rng = makeRNG(0xc0ffee);

interface Props {
  /** Lists built in the List Builder this session, surfaced ahead of the on-disk rosters. */
  extraRosters?: Roster[];
  initialRosterName?: string;
}

export function MeasuringBoard({ extraRosters = [], initialRosterName }: Props) {
  const [state, dispatch] = useReducer(
    (s: ReturnType<typeof createInitialState>, i: Intent) => reduce(s, i, rng, { datasheets: datasheetsById }),
    layouts[0],
    createInitialState,
  );
  // The reducer owns the active layout; the selector drives it via SetLayout.
  const layout = state.layout;

  // Group the layouts by deployment for the map picker (8 terrain layouts per deployment).
  const layoutGroups = useMemo(() => {
    const groups = new Map<string, typeof layouts>();
    for (const l of layouts) {
      const key = l.deployment;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(l);
    }
    return [...groups.entries()];
  }, []);

  const allRosters = useMemo(() => [...extraRosters, ...rosters], [extraRosters]);
  const [rosterName, setRosterName] = useState<string>(
    initialRosterName ?? (allRosters.find((r) => r.units.length > 0) ?? allRosters[0])?.name ?? '',
  );
  const [owner, setOwner] = useState<Side>('player');
  const [placing, setPlacing] = useState<Placing | null>(null);
  const spawnCount = useRef(0);

  const roster: Roster | undefined = useMemo(
    () => allRosters.find((r) => r.name === rosterName),
    [allRosters, rosterName],
  );

  if (!layout) {
    return <div className="app-shell">No layout found in data/layouts.</div>;
  }

  /** Pick a unit up for placement: the ghost then tracks the cursor until the user clicks. */
  function beginPlacing(unit: RosterUnit) {
    const ds = getDatasheet(unit.datasheetId);
    if (!ds) return;
    setPlacing({ unit, ds, formation: 'block', rotation: 0 });
  }

  /** Drop the held unit at `anchor`, in its current formation/rotation. */
  function commitPlacement(anchor: Vec2) {
    if (!placing) return;
    const n = spawnCount.current++;
    dispatch({
      type: 'SpawnUnit',
      unitId: `u${n}`,
      owner,
      datasheetId: placing.ds.id,
      baseShape: placing.ds.baseShape,
      modelCount: placing.unit.modelCount,
      wounds: placing.ds.models[0]?.W ?? 1,
      anchor,
      formation: placing.formation,
      rotation: placing.rotation,
    });
    setPlacing(null);
  }

  // Ghost the board renders: owner reflects the live "Spawn as" toggle.
  const placement: Placement | null = placing
    ? {
        baseShape: placing.ds.baseShape,
        modelCount: placing.unit.modelCount,
        owner,
        formation: placing.formation,
        rotation: placing.rotation,
      }
    : null;

  return (
    <div className="layout">
      <aside className="sidebar">
        <p className="muted">
          {layout.deployment} · {layout.boardWidth}"×{layout.boardHeight}"
        </p>

        <section>
          <label className="field">
            <span>Map</span>
            <select
              value={layout.id}
              onChange={(e) => {
                const next = layouts.find((l) => l.id === e.target.value);
                if (next) dispatch({ type: 'SetLayout', layout: next });
              }}
            >
              {layoutGroups.map(([deployment, group]) => (
                <optgroup key={deployment} label={deployment}>
                  {group.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name?.split('·').pop()?.trim() ?? l.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Roster</span>
            <select value={rosterName} onChange={(e) => setRosterName(e.target.value)}>
              {allRosters.map((r) => (
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
                const active = placing?.unit === u;
                return (
                  <li key={i}>
                    <button
                      className={`spawn${active ? ' seg-on' : ''}`}
                      onClick={() => (active ? setPlacing(null) : beginPlacing(u))}
                      disabled={!ds}
                    >
                      {active ? 'Placing…' : '+ Place'}
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
            <p className="muted">This roster has no units yet. Pick the demo roster, or build one in the List Builder.</p>
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
        <Board
          layout={layout}
          units={state.units}
          datasheetsById={datasheetsById}
          onMoveModel={(id, pos) => dispatch({ type: 'MoveModel', modelId: id, pos })}
          placement={placement}
          onPlacementCommit={commitPlacement}
          onPlacementRotate={(d) =>
            setPlacing((p) => (p ? { ...p, rotation: p.rotation + d } : p))
          }
          onPlacementCycle={() =>
            setPlacing((p) => (p ? { ...p, formation: nextFormation(p.formation) } : p))
          }
          onPlacementCancel={() => setPlacing(null)}
        />
      </main>

      <aside className="gamerail">
        <GamePanel state={state} dispatch={dispatch} datasheetsById={datasheetsById} />
      </aside>
    </div>
  );
}
