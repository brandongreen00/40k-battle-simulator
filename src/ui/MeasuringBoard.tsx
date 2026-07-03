import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BaseShape, Datasheet, Roster, RosterUnit, Side, Vec2 } from '../core/types';
import { reduce, createInitialState, type Intent } from '../core/state';
import { makeRNG } from '../core/rng';
import { nextFormation, type Formation } from '../core/formation';
import { checkUnitDeployment, deepStrikeArrivalLegal, isEntryPlaced, type DeployAbility } from '../core/deployment';
import { occupiedBases, unitOverlaps } from '../core/collision';
import { unitCoherency, unitCentroid } from '../core/phases';
import {
  aiAction, aiMayAct, aiReactionToShooting, resolveProfile, sharedAction, whoActs, type AiDeps,
} from '../core/ai/controller';
import { formationForBodyguard, isPairedLeader, pairDeployAbility } from '../core/ai/deploy';
import { dataIndex, datasheetsById, deployAbilityForDatasheet, getDatasheet, layouts, layoutsForPairing, rosters, stratagems } from '../data/loaders';
import { DISPOSITIONS, MISSION_MATRIX, MISSION_NAMES, type DispositionId } from '../core/missions11';
import { Board, type Placement, type MovementUI } from './Board';
import { GamePanel } from './GamePanel';
import { DeploymentPanel, effectiveSide } from './DeploymentPanel';
import { AiBar, type AiSeats } from './AiBar';
import { loadSavedRosters } from './savedLists';
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
  // The reducer draws from the RNG, so it must run exactly once per intent. React's useReducer
  // double-invokes reducers in dev StrictMode (the dice would be consumed twice and diverge from
  // the seed), so we reduce OUTSIDE React — once, in the event handler — and store the result.
  const [state, setState] = useState(() => createInitialState(layouts[0]!));
  const stateRef = useRef(state);
  // AI seats: who is the computer. Defaults: you play `player`, the computer plays `ai`.
  const [aiSeats, setAiSeats] = useState<AiSeats>({
    player: { enabled: false, profile: 'balanced' },
    ai: { enabled: true, profile: 'balanced' },
  });
  const [aiAuto, setAiAuto] = useState(true);
  const [aiNote, setAiNote] = useState('');
  const aiSeatsRef = useRef(aiSeats);
  aiSeatsRef.current = aiSeats;
  const aiDepsRef = useRef<AiDeps | null>(null);
  const dispatch = useCallback((i: Intent) => {
    let cur = stateRef.current;
    // Reactive window (architecture rule #3): before a unit shoots, an AI-controlled defender may
    // answer with a defensive stratagem — exactly as the headless match runner does.
    if (i.type === 'ShootUnit' && aiDepsRef.current) {
      const target = cur.units.find((u) => u.id === i.targetUnitId);
      const seat = target ? aiSeatsRef.current[target.owner] : undefined;
      if (target && seat?.enabled) {
        const reactions = aiReactionToShooting(
          cur, target.owner, i.attackerUnitId, i.targetUnitId, resolveProfile(seat.profile), aiDepsRef.current,
        );
        for (const r of reactions) {
          if (r.skipIf?.(cur)) continue;
          cur = reduce(cur, r.intent, rng, { datasheets: datasheetsById });
        }
      }
    }
    const next = reduce(cur, i, rng, { datasheets: datasheetsById });
    stateRef.current = next;
    setState(next);
  }, []);
  const layout = state.layout;
  const inSetup = state.stage === 'setup';
  const inMatch = state.mode === 'match';

  // On phones the two side panels become tabs under the board ("Units & map" / "Game").
  // Auto-follow the flow: roll-off & battle → Game; deployment placement & sandbox → Units.
  const [mTab, setMTab] = useState<'tools' | 'game'>('tools');
  const flowKey = inSetup ? (state.setup?.attacker ? 'deploy' : 'rolloff') : inMatch ? 'battle' : 'sandbox';
  useEffect(() => {
    setMTab(flowKey === 'rolloff' || flowKey === 'battle' ? 'game' : 'tools');
  }, [flowKey]);

  // Group the layouts by deployment for the map picker (8 terrain layouts per deployment).
  const layoutGroups = useMemo(() => {
    const groups = new Map<string, typeof layouts>();
    for (const l of layouts) {
      if (!groups.has(l.deployment)) groups.set(l.deployment, []);
      groups.get(l.deployment)!.push(l);
    }
    return [...groups.entries()];
  }, []);

  // Lists saved in the List Builder (localStorage) — so they survive a refresh and can be picked
  // when starting a game, not just the one handed over this session via "Open in board".
  const savedRosters = useMemo(() => loadSavedRosters(dataIndex), []);
  const allRosters = useMemo(() => {
    // Dedupe by name; precedence: this-session build > saved > on-disk scaffolds/demo.
    const byName = new Map<string, Roster>();
    for (const r of [...extraRosters, ...savedRosters, ...rosters]) {
      if (!byName.has(r.name)) byName.set(r.name, r);
    }
    return [...byName.values()];
  }, [extraRosters, savedRosters]);
  const firstWithUnits = allRosters.find((r) => r.units.length > 0) ?? allRosters[0];
  const [rosterNameBySide, setRosterNameBySide] = useState<Record<Side, string>>({
    player: initialRosterName ?? firstWithUnits?.name ?? '',
    ai: firstWithUnits?.name ?? '',
  });
  const [owner, setOwner] = useState<Side>('player'); // sandbox spawn-as
  // 11e Force Dispositions: each side picks a card; the pairing fixes both Primary Missions and
  // restricts the battle to the pairing's three recommended layouts (A/B/C).
  const [dispositions, setDispositions] = useState<Record<Side, DispositionId>>({
    player: 'take_and_hold',
    ai: 'take_and_hold',
  });
  const recommendedLayouts = useMemo(
    () => layoutsForPairing(dispositions.player, dispositions.ai),
    [dispositions],
  );
  const setDisposition = (side: Side, id: DispositionId) => {
    const next = { ...dispositions, [side]: id };
    setDispositions(next);
    // Keep the board on a recommended map for the pairing (pick layout A when leaving the set).
    const rec = layoutsForPairing(next.player, next.ai);
    if (rec.length > 0 && !rec.some((l) => l.id === state.layout.id)) {
      dispatch({ type: 'SetLayout', layout: rec[0]! });
    }
  };
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  // Attacker/target picked in the game panel — highlighted on the board (rings + firing line).
  const [targeting, setTargeting] = useState<{ attackerUnitId?: string; targetUnitId?: string }>({});
  const spawnCount = useRef(0);

  const rosterFor = (side: Side): Roster | undefined => allRosters.find((r) => r.name === rosterNameBySide[side]);
  const setRosterName = (side: Side, name: string) => setRosterNameBySide((m) => ({ ...m, [side]: name }));

  // Everything the AI controller needs to read the game (same data the panels use).
  const aiDeps: AiDeps = useMemo(
    () => ({
      ctx: { datasheets: datasheetsById },
      rosters: { player: rosterFor('player'), ai: rosterFor('ai') },
      detachments: { player: rosterFor('player')?.detachment ?? '', ai: rosterFor('ai')?.detachment ?? '' },
      deployAbility: deployAbilityForDatasheet,
      stratagems,
      rng,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rosterNameBySide, allRosters],
  );
  aiDepsRef.current = aiDeps;

  /** Take one AI action if the game is waiting on an AI seat. Returns true when something ran. */
  const aiTick = useCallback((): boolean => {
    const cur = stateRef.current;
    if (cur.mode !== 'match') return false; // the AI plays matches, never the free sandbox
    const seats = aiSeatsRef.current;
    const actor = aiMayAct(whoActs(cur, aiDeps), { player: seats.player.enabled, ai: seats.ai.enabled });
    if (!actor) return false;
    const action = actor === 'shared' ? sharedAction(cur) : aiAction(cur, actor, seats[actor].profile, aiDeps);
    if (!action || action.intents.length === 0) return false;
    for (const item of action.intents) {
      if (item.skipIf?.(stateRef.current)) continue;
      dispatch(item.intent);
    }
    setAiNote(action.note);
    return true;
  }, [aiDeps, dispatch]);

  // Whether the game is currently waiting on an AI seat (drives auto-play and the Step button).
  const aiCanAct =
    state.mode === 'match' &&
    !placing &&
    aiMayAct(whoActs(state, aiDeps), { player: aiSeats.player.enabled, ai: aiSeats.ai.enabled }) !== null;

  // Auto-play: whenever the game waits on an AI seat, take the next action after a short beat
  // (slow enough to watch, fast enough to not drag a full AI-vs-AI game out).
  useEffect(() => {
    if (!aiAuto || !aiCanAct) return;
    const t = setTimeout(() => {
      aiTick();
    }, 350);
    return () => clearTimeout(t);
  }, [state, aiAuto, aiCanAct, aiTick]);

  // A deployment ghost held for an AI-controlled side would pause auto-play forever (aiCanAct
  // gates on !placing) — drop it. Can happen when the seat flips to AI mid-placement.
  useEffect(() => {
    if (placing?.entryKey && aiSeats[placing.side].enabled) setPlacing(null);
  }, [placing, aiSeats]);

  // Deployment entries per side, and which are already on the board / in reserves.
  const entriesFor = (side: Side): DeployEntry[] => {
    const r = rosterFor(side);
    if (!r) return [];
    return r.units
      .map((unit, i) => ({ key: `${side}:${i}`, unit, ds: getDatasheet(unit.datasheetId)! }))
      .filter((e) => e.ds);
  };
  // A merged Leader's unit instance is removed, but its entry stays placed (no double-deploy).
  const isPlaced = (key: string) => isEntryPlaced(state, key);
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

  /** Pick a unit up for deployment placement (ghost tracks the cursor, zone-limited). A paired
   *  Bodyguard deploys with its declared pair ability (e.g. Backroom Deals → Infiltrators). */
  function beginDeploy(entry: DeployEntry, side: Side) {
    const pair = formationForBodyguard(state, entry.key);
    const ability = pair
      ? (() => {
          const a = pairDeployAbility(pair, { datasheets: datasheetsById }, deployAbilityForDatasheet);
          return a === 'deep_strike' ? 'standard' : a; // on-board placement; Reserves handles DS
        })()
      : deployAbilityForDatasheet(entry.ds);
    setPlacing({ unit: entry.unit, ds: entry.ds, formation: 'block', rotation: 0, side, entryKey: entry.key, ability });
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
      // A declared pair deploys as ONE unit: the Leader cannot be dropped ON the unit (bases
      // never stack), so it stages via Reserves and merges — AttachLeader re-seats its models
      // into base-to-base coherency with the unit, clear of every occupied base.
      const pair = formationForBodyguard(state, placing.entryKey);
      const leaderEntry = pair ? entriesFor(placing.side).find((e) => e.key === pair.leaderKey) : undefined;
      if (pair && leaderEntry) {
        dispatch({
          type: 'PlaceInReserves',
          unitId: pair.leaderKey,
          owner: placing.side,
          datasheetId: leaderEntry.ds.id,
          baseShape: leaderEntry.ds.baseShape,
          modelCount: leaderEntry.unit.modelCount,
          wounds: leaderEntry.ds.models[0]?.W ?? 1,
          ...(leaderEntry.unit.wargearCounts ? { wargear: leaderEntry.unit.wargearCounts } : {}),
        });
        dispatch({ type: 'AttachLeader', leaderUnitId: pair.leaderKey, bodyguardUnitId: placing.entryKey });
      }
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
    // A paired Leader follows its unit into Reserves and merges there.
    const pair = formationForBodyguard(state, entry.key);
    const leaderEntry = pair ? entriesFor(side).find((e) => e.key === pair.leaderKey) : undefined;
    if (pair && leaderEntry) {
      dispatch({
        type: 'PlaceInReserves',
        unitId: pair.leaderKey, owner: side, datasheetId: leaderEntry.ds.id, baseShape: leaderEntry.ds.baseShape,
        modelCount: leaderEntry.unit.modelCount, wounds: leaderEntry.ds.models[0]?.W ?? 1,
        ...(leaderEntry.unit.wargearCounts ? { wargear: leaderEntry.unit.wargearCounts } : {}),
      });
      dispatch({ type: 'AttachLeader', leaderUnitId: pair.leaderKey, bodyguardUnitId: entry.key });
    }
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
          ? { legal: (positions: Vec2[]) => deepStrikeArrivalLegal(positions, placing.ds.baseShape, enemyModels(placing.side), state.round, occupiedBases(state, { datasheets: datasheetsById }, placing.arriveUnitId ? [placing.arriveUnitId] : [])).legal }
          : placing.entryKey
          ? { legal: (positions: Vec2[]) => checkUnitDeployment(positions, placing.ds.baseShape, layout, placing.side, placing.ability, enemyModels(placing.side), occupiedBases(state, { datasheets: datasheetsById })).legal }
          : {}),
      }
    : null;

  // Movement-phase board interaction (drag-select, group move, coherency warnings). The
  // pre-battle Scout step reuses the same drag machinery (BeginMove 'scout' sets the budget).
  const inMovement =
    ((state.stage === 'battle' && state.phase === 'Movement') ||
      (state.stage === 'setup' && state.setup?.step === 'scouts')) &&
    !placing;
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
          .filter(
            (u) =>
              !unitCoherency(u, { datasheets: datasheetsById }).inCoherency ||
              (u.status.moveMode != null && unitOverlaps(state, u, { datasheets: datasheetsById })),
          )
          .map((u) => ({ unitId: u.id, centroid: unitCentroid(u) })),
      }
    : null;

  const sandboxRoster = rosterFor('player');

  return (
    <div className="layout" data-mtab={mTab}>
      {/* Mobile-only tab bar: switches which panel shows under the board. */}
      <div className="m-tabs" role="tablist">
        <button role="tab" aria-selected={mTab === 'tools'} className={mTab === 'tools' ? 'on' : ''} onClick={() => setMTab('tools')}>
          {inSetup ? 'Deploy units' : 'Units & map'}
        </button>
        <button role="tab" aria-selected={mTab === 'game'} className={mTab === 'game' ? 'on' : ''} onClick={() => setMTab('game')}>
          {inSetup ? 'Setup & dice' : 'Game'}
        </button>
      </div>
      <aside className="sidebar">
        <div className="sidebar-head">
          <p className="muted">{layout.deployment} · {layout.boardWidth}"×{layout.boardHeight}"</p>
          <button
            className="newbattle"
            onClick={() => {
              // Mid-match this throws the whole game away — make sure it's intentional.
              if (inMatch && !inSetup && !state.ended && typeof window !== 'undefined' && typeof window.confirm === 'function') {
                if (!window.confirm('Abandon the battle in progress and start a new one?')) return;
              }
              setPlacing(null);
              dispatch({ type: 'NewBattle', dispositions });
            }}
          >
            {inSetup ? '↻ Restart deployment' : '⚔ New battle'}
          </button>
        </div>

        <section>
          {!inMatch && (
            <div className="dispositions">
              <h2>Force Dispositions (11e)</h2>
              {(['player', 'ai'] as const).map((side) => (
                <label className="field" key={side}>
                  <span style={{ color: OWNER_COLOR[side].fill }}>{side === 'player' ? 'your' : 'computer'} disposition</span>
                  <select value={dispositions[side]} onChange={(e) => setDisposition(side, e.target.value as DispositionId)}>
                    {DISPOSITIONS.map((d) => (
                      <option key={d.id} value={d.id} title={d.blurb}>{d.name}</option>
                    ))}
                  </select>
                </label>
              ))}
              <p className="hint">
                Missions: you play <strong>{MISSION_NAMES[MISSION_MATRIX[dispositions.player][dispositions.ai]]}</strong>,
                {' '}the computer plays <strong>{MISSION_NAMES[MISSION_MATRIX[dispositions.ai][dispositions.player]]}</strong>.
                {' '}This pairing restricts the battle to {recommendedLayouts.length || 'its'} recommended layouts.
              </p>
            </div>
          )}
          <label className="field">
            <span>Map{inMatch && !inSetup ? ' (locked during battle)' : ''}</span>
            <select
              value={layout.id}
              disabled={inMatch && !inSetup}
              title={inMatch && !inSetup ? 'Changing the map resets the board — finish or abandon the battle first' : undefined}
              onChange={(e) => { const next = layouts.find((l) => l.id === e.target.value); if (next) dispatch({ type: 'SetLayout', layout: next }); }}
            >
              {recommendedLayouts.length > 0 && (
                <optgroup label={`Recommended for this pairing (A/B/C)`}>
                  {recommendedLayouts.map((l) => (
                    <option key={`rec-${l.id}`} value={l.id}>Layout {l.pairing?.letter ?? '?'} — {l.deployment}</option>
                  ))}
                </optgroup>
              )}
              {layoutGroups.map(([deployment, group]) => (
                <optgroup key={deployment} label={deployment}>
                  {group.map((l) => <option key={l.id} value={l.id}>{l.name?.split('·').pop()?.trim() ?? l.id}</option>)}
                </optgroup>
              ))}
            </select>
          </label>

          {!inSetup && !inMatch && (
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
            {aiSeats[sideToPlace].enabled && (
              <p className="hint">🤖 The computer controls this side and deploys by itself{aiAuto ? '' : ' — auto-play is off, use Step in the Players bar'}. Switch the seat to Human there to place these units yourself.</p>
            )}
            <ul className="unit-list">
              {entriesFor(sideToPlace).map((e) => {
                const placed = isPlaced(e.key);
                const active = placing?.entryKey === e.key;
                const reserve = state.units.find((u) => u.id === e.key)?.inReserves;
                // A paired Leader deploys with its unit, not alone.
                const paired = isPairedLeader(state, e.key);
                const pair = formationForBodyguard(state, e.key);
                return (
                  <li key={e.key} className={placed ? 'placed' : ''}>
                    {placed ? (
                      <span className="spawn done">{reserve ? 'Reserves' : '✓'}</span>
                    ) : paired ? (
                      <span className="spawn done" title="Declared as a Leader — deploys merged with its unit">⚑ with unit</span>
                    ) : aiSeats[sideToPlace].enabled ? (
                      // An AI-controlled side deploys itself: a picked-up ghost would silently pause
                      // auto-play (aiCanAct gates on !placing), so don't offer manual placement here.
                      <span className="spawn done" title="The AI deploys this unit (switch the seat to Human in the Players bar to place it yourself)">🤖</span>
                    ) : (
                      <>
                        <button className={`spawn${active ? ' seg-on' : ''}`} onClick={() => (active ? setPlacing(null) : beginDeploy(e, sideToPlace))}>
                          {active ? 'Placing…' : '+ Deploy'}
                        </button>
                        <button className="reserve-btn" title="Place in Reserves (Deep Strike, arrives round 2+)" onClick={() => placeReserves(e, sideToPlace)}>⤓</button>
                      </>
                    )}
                    <span className="unit-name">{e.ds.name}{pair ? ' ⚑' : ''}</span>
                    <span className="unit-meta">×{e.unit.modelCount}{deployAbilityForDatasheet(e.ds) !== 'standard' ? ` · ${deployAbilityForDatasheet(e.ds) === 'infiltrators' ? 'Infiltrators' : 'Deep Strike'}` : ''}{pair?.infiltrate ? ' · Infiltrators (granted)' : ''}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : inMatch ? (
          <section>
            <h2>Battle in progress</h2>
            <p className="muted">Units act through the game panel on the right — spawning, removing and clearing are sandbox tools.</p>
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
          {state.units.length > 0 && !inSetup && !inMatch && (
            <button className="clear" onClick={() => dispatch({ type: 'ClearUnits' })}>Clear all</button>
          )}
          <ul className="unit-list">
            {state.units.map((u) => {
              const ds = getDatasheet(u.datasheetId);
              return (
                <li key={u.id}>
                  {!inSetup && !inMatch && <button className="remove" onClick={() => dispatch({ type: 'RemoveUnit', unitId: u.id })}>×</button>}
                  <span className="dot" style={{ background: OWNER_COLOR[u.owner].fill }} />
                  <span className="unit-name">{ds?.name ?? u.datasheetId}{u.attachedLeaders?.length ? ' ⚑' : ''}</span>
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
          operationMarkers={state.missions?.markers}
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
          targeting={inSetup ? null : targeting}
        />
      </main>

      <aside className="gamerail">
        <AiBar
          seats={aiSeats}
          onSeats={setAiSeats}
          auto={aiAuto}
          onAuto={setAiAuto}
          onStep={() => aiTick()}
          canStep={aiCanAct}
          note={aiNote}
          active={inMatch}
        />
        {inSetup ? (
          <DeploymentPanel
            state={state}
            dispatch={dispatch}
            datasheetsById={datasheetsById}
            rosters={allRosters}
            rosterName={rosterNameBySide}
            setRosterName={setRosterName}
            remaining={remaining}
            entries={{ player: entriesFor('player'), ai: entriesFor('ai') }}
            isPlaced={isPlaced}
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
            onTargeting={setTargeting}
          />
        )}
      </aside>
    </div>
  );
}
