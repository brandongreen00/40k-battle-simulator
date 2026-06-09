import { useMemo, useReducer, useRef, useState } from 'react';
import type { BaseShape, Datasheet, Roster, RosterUnit, Side, Vec2 } from '../core/types';
import { reduce, createInitialState, type Intent } from '../core/state';
import { makeRNG } from '../core/rng';
import { nextFormation, type Formation } from '../core/formation';
import { checkUnitDeployment, deepStrikeArrivalLegal, type DeployAbility } from '../core/deployment';
import { unitCoherency, unitCentroid } from '../core/phases';
import { datasheetsById, deployAbilityForDatasheet, getDatasheet, layouts, rosters } from '../data/loaders';
import { Board, type Placement, type MovementUI } from './Board';
import { GamePanel } from './GamePanel';
import { DeploymentPanel, effectiveSide } from './DeploymentPanel';
import { OWNER_COLOR, TERRAIN_STYLE } from './view';

/** A unit the user has picked up and is positioning with the ghost preview. */
interface Placing {
  unit: RosterUnit;
  ds: Datasheet;
  formation: Formation;
  rotation: number;
  /** Who the unit belongs to (deployment side, or the sandbox spawn-as owner). */
  side: Side;
  /** Set during deployment: the roster entry key used as the unit id (so it can't be double-placed). */
  entryKey?: string;
  /** Set during a Deep Strike arrival: the Reserves unit id being brought onto the board. */
  arriveUnitId?: string;
  ability: DeployAbility;
}

interface DeployEntry {
  key: string;
  unit: RosterUnit;
  ds: Datasheet;
}

// Seeded RNG for reproducibility (the seam is what matters; dice roll-offs use it).
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
  const layout = state.layout;
  const inSetup = state.stage === 'setup';

  // Group the layouts by deployment for the map picker (8 terrain layouts per deployment).
  const layoutGroups = useMemo(() => {
    const groups = new Map<string, typeof layouts>();
    for (const l of layouts) {
      if (!groups.has(l.deployment)) groups.set(l.deployment, []);
      groups.get(l.deployment)!.push(l);
    }
    return [...groups.entries()];
  }, []);

  const allRosters = useMemo(() => [...extraRosters, ...rosters], [extraRosters]);
  const firstWithUnits = allRosters.find((r) => r.units.length > 0) ?? allRosters[0];
  const [rosterNameBySide, setRosterNameBySide] = useState<Record<Side, string>>({
    player: initialRosterName ?? firstWithUnits?.name ?? '',
    ai: firstWithUnits?.name ?? '',
  });
  const [owner, setOwner] = useState<Side>('player'); // sandbox spawn-as
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const spawnCount = useRef(0);

  const rosterFor = (side: Side): Roster | undefined => allRosters.find((r) => r.name === rosterNameBySide[side]);
  const setRosterName = (side: Side, name: string) => setRosterNameBySide((m) => ({ ...m, [side]: name }));

  // Deployment entries per side, and which are already on the board / in reserves.
  const entriesFor = (side: Side): DeployEntry[] => {
    const r = rosterFor(side);
    if (!r) return [];
    return r.units
      .map((unit, i) => ({ key: `${side}:${i}`, unit, ds: getDatasheet(unit.datasheetId)! }))
      .filter((e) => e.ds);
  };
  const isPlaced = (key: string) => state.units.some((u) => u.id === key);
  const remaining: Record<Side, number> = {
    player: entriesFor('player').filter((e) => !isPlaced(e.key)).length,
    ai: entriesFor('ai').filter((e) => !isPlaced(e.key)).length,
  };
  const sideToPlace = inSetup && state.setup?.attacker ? effectiveSide(state.setup, remaining) : owner;

  if (!layout) return <div className="app-shell">No layout found in data/layouts.</div>;

  // Enemy models on the board, for the deployment legality (Infiltrators 9" / zone checks).
  function enemyModels(side: Side): { pos: Vec2; shape: BaseShape }[] {
    const out: { pos: Vec2; shape: BaseShape }[] = [];
    for (const u of state.units) {
      if (u.owner === side || u.inReserves) continue;
      const shape = getDatasheet(u.datasheetId)?.baseShape ?? { kind: 'circle', radius: 0.63 };
      for (const m of u.models) if (m.alive) out.push({ pos: m.pos, shape });
    }
    return out;
  }

  /** Pick a unit up for deployment placement (ghost tracks the cursor, zone-limited). */
  function beginDeploy(entry: DeployEntry, side: Side) {
    setPlacing({ unit: entry.unit, ds: entry.ds, formation: 'block', rotation: 0, side, entryKey: entry.key, ability: deployAbilityForDatasheet(entry.ds) });
  }
  /** Pick a unit up for free sandbox placement (no zone restriction). */
  function beginSandbox(unit: RosterUnit) {
    const ds = getDatasheet(unit.datasheetId);
    if (!ds) return;
    setPlacing({ unit, ds, formation: 'block', rotation: 0, side: owner, ability: 'standard' });
  }

  function commitPlacement(anchor: Vec2) {
    if (!placing) return;
    const common = {
      datasheetId: placing.ds.id,
      baseShape: placing.ds.baseShape,
      modelCount: placing.unit.modelCount,
      wounds: placing.ds.models[0]?.W ?? 1,
      ...(placing.unit.wargearCounts ? { wargear: placing.unit.wargearCounts } : {}),
    };
    if (placing.arriveUnitId) {
      dispatch({ type: 'ArriveFromReserves', unitId: placing.arriveUnitId, anchor, formation: placing.formation, rotation: placing.rotation });
    } else if (placing.entryKey) {
      dispatch({ type: 'DeployUnit', unitId: placing.entryKey, owner: placing.side, anchor, formation: placing.formation, rotation: placing.rotation, ability: placing.ability, ...common });
    } else {
      dispatch({ type: 'SpawnUnit', unitId: `u${spawnCount.current++}`, owner: placing.side, anchor, formation: placing.formation, rotation: placing.rotation, ...common });
    }
    setPlacing(null);
  }

  /** Begin a Deep Strike arrival: ghost the Reserves unit, gated by the > 9" rule. */
  function beginArrival(unitId: string) {
    const u = state.units.find((x) => x.id === unitId);
    const ds = u && getDatasheet(u.datasheetId);
    if (!u || !ds) return;
    setSelectedUnitIds([]);
    setPlacing({
      unit: { datasheetId: ds.id, modelCount: u.models.length },
      ds, formation: 'block', rotation: 0, side: u.owner, arriveUnitId: unitId, ability: 'deep_strike',
    });
  }

  function placeReserves(entry: DeployEntry, side: Side) {
    const ds = entry.ds;
    dispatch({ type: 'PlaceInReserves', unitId: entry.key, owner: side, datasheetId: ds.id, baseShape: ds.baseShape, modelCount: entry.unit.modelCount, wounds: ds.models[0]?.W ?? 1, ...(entry.unit.wargearCounts ? { wargear: entry.unit.wargearCounts } : {}) });
  }

  // The ghost the board renders; carries a legality predicate for deployment / Deep Strike arrival.
  const placement: Placement | null = placing
    ? {
        baseShape: placing.ds.baseShape,
        modelCount: placing.unit.modelCount,
        owner: placing.side,
        formation: placing.formation,
        rotation: placing.rotation,
        ...(placing.arriveUnitId
          ? { legal: (positions: Vec2[]) => deepStrikeArrivalLegal(positions, placing.ds.baseShape, enemyModels(placing.side), state.round).legal }
          : placing.entryKey
          ? { legal: (positions: Vec2[]) => checkUnitDeployment(positions, placing.ds.baseShape, layout, placing.side, placing.ability, enemyModels(placing.side)).legal }
          : {}),
      }
    : null;

  // Movement-phase board interaction (drag-select, group move, coherency warnings).
  const inMovement = state.stage === 'battle' && state.phase === 'Movement' && !placing;
  const movement: MovementUI | null = inMovement
    ? {
        selectedUnitIds,
        movingUnitIds: state.units.filter((u) => u.status.moveMode).map((u) => u.id),
        onSelectUnits: (ids, additive) => {
          // Only your own units, and pull in any attached Leader / Bodyguard so they move together.
          const own = ids.filter((id) => state.units.find((u) => u.id === id)?.owner === state.activePlayer);
          const linked = new Set(own);
          for (const id of own) {
            const u = state.units.find((x) => x.id === id);
            if (u?.attachedTo) linked.add(u.attachedTo);
            for (const l of u?.leaderUnitIds ?? []) linked.add(l);
          }
          const expanded = [...linked];
          setSelectedUnitIds((prev) => (additive ? [...new Set([...prev, ...expanded])] : expanded));
        },
        onGroupNudge: (delta) => {
          const moving = state.units.filter((u) => u.status.moveMode).map((u) => u.id);
          if (moving.length) dispatch({ type: 'NudgeUnit', unitIds: moving, delta });
        },
        warnings: state.units
          .filter((u) => u.owner === state.activePlayer && !u.inReserves && u.models.some((m) => m.alive))
          .filter((u) => !unitCoherency(u, { datasheets: datasheetsById }).inCoherency)
          .map((u) => ({ unitId: u.id, centroid: unitCentroid(u) })),
      }
    : null;

  const sandboxRoster = rosterFor('player');

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-head">
          <p className="muted">{layout.deployment} · {layout.boardWidth}"×{layout.boardHeight}"</p>
          <button className="newbattle" onClick={() => { setPlacing(null); dispatch({ type: 'NewBattle' }); }}>
            {inSetup ? '↻ Restart deployment' : '⚔ New battle'}
          </button>
        </div>

        <section>
          <label className="field">
            <span>Map</span>
            <select value={layout.id} onChange={(e) => { const next = layouts.find((l) => l.id === e.target.value); if (next) dispatch({ type: 'SetLayout', layout: next }); }}>
              {layoutGroups.map(([deployment, group]) => (
                <optgroup key={deployment} label={deployment}>
                  {group.map((l) => <option key={l.id} value={l.id}>{l.name?.split('·').pop()?.trim() ?? l.id}</option>)}
                </optgroup>
              ))}
            </select>
          </label>

          {!inSetup && (
            <>
              <label className="field">
                <span>Roster</span>
                <select value={rosterNameBySide.player} onChange={(e) => setRosterName('player', e.target.value)}>
                  {allRosters.map((r) => <option key={r.name} value={r.name}>{r.name}{r.sample ? ' (demo)' : ''}</option>)}
                </select>
              </label>
              <div className="field">
                <span>Spawn as</span>
                <div className="seg">
                  {(['player', 'ai'] as const).map((o) => (
                    <button key={o} className={owner === o ? 'seg-on' : ''} style={{ borderColor: OWNER_COLOR[o].fill }} onClick={() => setOwner(o)}>{o}</button>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>

        {/* Units to place */}
        {inSetup && state.setup?.attacker ? (
          <section>
            <h2>Deploy · <span style={{ color: OWNER_COLOR[sideToPlace].fill }}>{sideToPlace}</span></h2>
            <ul className="unit-list">
              {entriesFor(sideToPlace).map((e) => {
                const placed = isPlaced(e.key);
                const active = placing?.entryKey === e.key;
                const reserve = state.units.find((u) => u.id === e.key)?.inReserves;
                return (
                  <li key={e.key} className={placed ? 'placed' : ''}>
                    {placed ? (
                      <span className="spawn done">{reserve ? 'Reserves' : '✓'}</span>
                    ) : (
                      <>
                        <button className={`spawn${active ? ' seg-on' : ''}`} onClick={() => (active ? setPlacing(null) : beginDeploy(e, sideToPlace))}>
                          {active ? 'Placing…' : '+ Deploy'}
                        </button>
                        <button className="reserve-btn" title="Place in Reserves (Deep Strike, arrives round 2+)" onClick={() => placeReserves(e, sideToPlace)}>⤓</button>
                      </>
                    )}
                    <span className="unit-name">{e.ds.name}</span>
                    <span className="unit-meta">×{e.unit.modelCount}{deployAbilityForDatasheet(e.ds) !== 'standard' ? ` · ${deployAbilityForDatasheet(e.ds) === 'infiltrators' ? 'Infiltrators' : 'Deep Strike'}` : ''}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <section>
            <h2>Units</h2>
            {sandboxRoster && sandboxRoster.units.length > 0 ? (
              <ul className="unit-list">
                {sandboxRoster.units.map((u, i) => {
                  const ds = getDatasheet(u.datasheetId);
                  const m = ds?.models[0];
                  const active = placing?.unit === u;
                  return (
                    <li key={i}>
                      <button className={`spawn${active ? ' seg-on' : ''}`} onClick={() => (active ? setPlacing(null) : beginSandbox(u))} disabled={!ds}>
                        {active ? 'Placing…' : '+ Place'}
                      </button>
                      <span className="unit-name">{u.displayName ?? ds?.name ?? u.datasheetId}</span>
                      <span className="unit-meta">×{u.modelCount}{m ? ` · M${m.M}" T${m.T} Sv${m.Sv}+ W${m.W}` : ds ? '' : ' · UNRESOLVED'}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">This roster has no units yet. Pick the demo roster, or build one in the List Builder.</p>
            )}
          </section>
        )}

        <section>
          <h2>On board ({state.units.filter((u) => !u.inReserves).length})</h2>
          {state.units.length > 0 && !inSetup && (
            <button className="clear" onClick={() => dispatch({ type: 'ClearUnits' })}>Clear all</button>
          )}
          <ul className="unit-list">
            {state.units.map((u) => {
              const ds = getDatasheet(u.datasheetId);
              return (
                <li key={u.id}>
                  {!inSetup && <button className="remove" onClick={() => dispatch({ type: 'RemoveUnit', unitId: u.id })}>×</button>}
                  <span className="dot" style={{ background: OWNER_COLOR[u.owner].fill }} />
                  <span className="unit-name">{ds?.name ?? u.datasheetId}{u.attachedTo ? ' ⚑' : ''}</span>
                  <span className="unit-meta">{u.inReserves ? 'reserves' : `×${u.models.filter((m) => m.alive).length}`}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="legend">
          <h2>Legend</h2>
          {Object.values(TERRAIN_STYLE).map((s) => (
            <div key={s.label} className="legend-row"><span className="swatch" style={{ background: s.fill, borderColor: s.stroke }} />{s.label}</div>
          ))}
          <div className="legend-row"><span className="swatch" style={{ background: 'rgba(234,179,8,0.25)', borderColor: '#eab308' }} />Objective marker</div>
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
          onPlacementRotate={(d) => setPlacing((p) => (p ? { ...p, rotation: p.rotation + d } : p))}
          onPlacementCycle={() => setPlacing((p) => (p ? { ...p, formation: nextFormation(p.formation) } : p))}
          onPlacementCancel={() => setPlacing(null)}
          movement={movement}
        />
      </main>

      <aside className="gamerail">
        {inSetup ? (
          <DeploymentPanel
            state={state}
            dispatch={dispatch}
            datasheetsById={datasheetsById}
            rosters={allRosters}
            rosterName={rosterNameBySide}
            setRosterName={setRosterName}
            remaining={remaining}
          />
        ) : (
          <GamePanel
            state={state}
            dispatch={dispatch}
            datasheetsById={datasheetsById}
            selectedUnitIds={selectedUnitIds}
            setSelectedUnitIds={setSelectedUnitIds}
            onBeginArrival={beginArrival}
            detachmentBySide={{ player: rosterFor('player')?.detachment ?? '', ai: rosterFor('ai')?.detachment ?? '' }}
          />
        )}
      </aside>
    </div>
  );
}
