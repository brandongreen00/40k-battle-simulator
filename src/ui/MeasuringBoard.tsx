import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BaseShape, Datasheet, GameState, Roster, RosterUnit, Side, Vec2 } from '../core/types';
import { reduce, createInitialState, type Intent } from '../core/state';
import { makeRNG } from '../core/rng';
import { nextFormation, type Formation } from '../core/formation';
import { checkUnitDeployment, deepStrikeArrivalLegal, isEntryPlaced, type DeployAbility } from '../core/deployment';
import { anyOverlap, occupiedBases, unitOverlaps } from '../core/collision';
import { unitCoherency, unitCentroid } from '../core/phases';
import { gapBetweenBases } from '../core/geometry';
import { canEmbark, remainingCapacity, splitRideCounts, splitRuleSelects, transportSplitRule } from '../core/transport';
import { planUnitShooting } from '../core/engine';
import { defensiveProfileForItem } from '../core/wargear';
import {
  aiAction, aiMayAct, aiReactionToFight, aiReactionToPhaseEnd, aiReactionToShooting, resolveProfile, sharedAction, whoActs, type AiDeps,
} from '../core/ai/controller';
import { formationForBodyguard, isPairedLeader, pairDeployAbility } from '../core/ai/deploy';
import { dataIndex, datasheetsById, deployAbilityForDatasheet, getDatasheet, layouts, layoutsForPairing, rosters, stratagems } from '../data/loaders';
import { DISPOSITIONS, MISSION_MATRIX, MISSION_NAMES, type DispositionId } from '../core/missions11';
import { Board, type Placement, type MovementUI, type ShotFx } from './Board';
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
  /** The arrival is a Rapid Ingress stratagem play (15.07 — opponent's Movement phase, 1 CP). */
  arriveRapid?: boolean;
  /** Set during a disembark: the embarked unit id being set up near its transport (18.04). */
  disembarkUnitId?: string;
  ability: DeployAbility;
}

interface DeployEntry {
  key: string;
  unit: RosterUnit;
  ds: Datasheet;
  /** Set when this entry is one half of a declared transport split ('a' rides, 'b' walks). */
  half?: 'a' | 'b';
}

/** Draft of a transport split being edited (before DeclareSplit is dispatched). */
interface SplitDraft {
  entryKey: string;
  transportId: string;
  rideCount: number;
  /** Wargear items riding in the transport (the rest stays with the on-foot half). */
  ride: Record<string, number>;
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
  /** Push a shot tracer between two units' closest models (positions read pre-resolution). */
  const pushShotFx = useCallback((cur: GameState, attackerId: string, targetId: string, kind: ShotFx['kind']) => {
    const att = cur.units.find((u) => u.id === attackerId && !u.inReserves);
    const tgt = cur.units.find((u) => u.id === targetId && !u.inReserves);
    if (!att || !tgt) return;
    let best = Infinity;
    let from: Vec2 | null = null;
    let to: Vec2 | null = null;
    for (const am of att.models) {
      if (!am.alive) continue;
      for (const tm of tgt.models) {
        if (!tm.alive) continue;
        const d = Math.hypot(am.pos.x - tm.pos.x, am.pos.y - tm.pos.y);
        if (d < best) { best = d; from = am.pos; to = tm.pos; }
      }
    }
    if (!from || !to) return;
    const id = ++fxSeq.current;
    setFx((f) => [...f, { id, from: from!, to: to!, kind }]);
    setTimeout(() => setFx((f) => f.filter((x) => x.id !== id)), 1300);
  }, []);

  const dispatch = useCallback((i: Intent) => {
    // Moving the game on past a held incoming volley resolves it first with the default
    // allocation — the shot must land in ITS phase, not whichever one the click reaches.
    if (incomingRef.current && (i.type === 'AdvancePhase' || i.type === 'RunCommandPhase')) {
      resolveIncomingRef.current();
    }
    let cur = stateRef.current;
    // Combat flair: a tracer + impact flash whenever a ranged volley resolves (human or AI).
    if (i.type === 'ShootUnit') pushShotFx(cur, i.attackerUnitId, i.targetUnitId, 'shoot');
    else if (i.type === 'FireOverwatch') pushShotFx(cur, i.unitId, i.targetUnitId, 'overwatch');
    else if (i.type === 'ThrowExplosives') pushShotFx(cur, i.unitId, i.targetUnitId, 'explosives');
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
    // End-of-phase reactive window: an AI defender may Fire Overwatch (end of your Movement) or
    // Heroically Intervene (end of your Charge phase) before the phase advances.
    if (i.type === 'AdvancePhase' && cur.stage === 'battle' && (cur.phase === 'Movement' || cur.phase === 'Charge') && aiDepsRef.current) {
      const defender: Side = cur.activePlayer === 'player' ? 'ai' : 'player';
      const seat = aiSeatsRef.current[defender];
      if (seat?.enabled) {
        const reactions = aiReactionToPhaseEnd(cur, defender, resolveProfile(seat.profile), aiDepsRef.current);
        for (const r of reactions) {
          if (r.skipIf?.(cur)) continue;
          cur = reduce(cur, r.intent, rng, { datasheets: datasheetsById });
        }
      }
    }
    let next = reduce(cur, i, rng, { datasheets: datasheetsById });
    // Counteroffensive window: just AFTER an enemy unit resolves its Fight attacks, an
    // AI-controlled defender may pay 2 CP to fight next.
    if (i.type === 'FightUnit' && aiDepsRef.current) {
      const attacker = next.units.find((u) => u.id === i.attackerUnitId);
      const defender: Side | undefined = attacker ? (attacker.owner === 'player' ? 'ai' : 'player') : undefined;
      const seat = defender ? aiSeatsRef.current[defender] : undefined;
      if (defender && seat?.enabled) {
        for (const r of aiReactionToFight(next, defender, resolveProfile(seat.profile), aiDepsRef.current)) {
          if (r.skipIf?.(next)) continue;
          next = reduce(next, r.intent, rng, { datasheets: datasheetsById });
        }
      }
    }
    stateRef.current = next;
    setState(next);
  }, [pushShotFx]);
  const layout = state.layout;
  const inSetup = state.stage === 'setup';
  const inMatch = state.mode === 'match';

  // On phones the two side panels become tabs under the board ("Units & map" / "Game").
  // Auto-follow the flow: roll-off & battle → Game; deployment placement & sandbox → Units.
  // (flowKey is derived below once the deployment bookkeeping exists; the effect lives with it.)
  const [mTab, setMTab] = useState<'tools' | 'game'>('tools');

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
  // Open transport-split editor (the Immolator's Declare Battle Formations rule): which entry is
  // being split, the chosen transport, the riding-half size, and the wargear riding with it.
  const [splitting, setSplitting] = useState<SplitDraft | null>(null);
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  // Attacker/target picked in the game panel — highlighted on the board (rings + firing line).
  const [targeting, setTargeting] = useState<{ attackerUnitId?: string; targetUnitId?: string }>({});
  const spawnCount = useRef(0);
  // Transient shot tracers/impacts on the board (auto-expire).
  const [fx, setFx] = useState<ShotFx[]>([]);
  const fxSeq = useRef(0);
  // An AI volley aimed at a HUMAN-owned unit is held here so the defender can choose casualty
  // allocation (and reactive stratagems) before the dice roll. Auto-play pauses while set.
  type HeldVolley = {
    intent: Intent & { type: 'ShootUnit' | 'FireOverwatch' };
    rest: { intent: Intent; skipIf?: (s: GameState) => boolean }[];
    note: string;
  };
  const [incoming, setIncomingState] = useState<HeldVolley | null>(null);
  // The ref is the synchronous source of truth (dispatch/resolve run outside the render cycle).
  const incomingRef = useRef<HeldVolley | null>(null);
  const setIncoming = useCallback((v: HeldVolley | null) => {
    incomingRef.current = v;
    setIncomingState(v);
  }, []);
  // resolveIncoming is defined after dispatch (it dispatches) but dispatch needs to trigger it
  // when the human advances the phase past a held volley — bridge with a ref.
  const resolveIncomingRef = useRef<(allocation?: 'shields_first' | 'bodies_first') => void>(() => {});

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

  /** Take one AI action if the game is waiting on an AI seat. Returns true when something ran.
   *  An AI volley aimed at a HUMAN-owned unit is intercepted: the intent is held in `incoming`
   *  and the defender chooses casualty allocation (and reactions) before the dice roll. */
  const aiTick = useCallback((): boolean => {
    const cur = stateRef.current;
    if (cur.mode !== 'match') return false; // the AI plays matches, never the free sandbox
    if (incomingRef.current) return false; // waiting on the defender's allocation choice
    const seats = aiSeatsRef.current;
    const actor = aiMayAct(whoActs(cur, aiDeps), { player: seats.player.enabled, ai: seats.ai.enabled });
    if (!actor) return false;
    const action = actor === 'shared' ? sharedAction(cur) : aiAction(cur, actor, seats[actor].profile, aiDeps);
    if (!action || action.intents.length === 0) {
      // Mirror the headless runner: an empty battle-phase action would stall auto-play forever
      // (no dispatch → no state change → the effect never re-fires), so advance the phase.
      if (cur.stage === 'battle' && !cur.ended) {
        dispatch({ type: 'AdvancePhase' });
        setAiNote(`${actor}: nothing to do — phase advanced`);
        return true;
      }
      return false;
    }
    for (let i = 0; i < action.intents.length; i++) {
      const item = action.intents[i]!;
      if (item.skipIf?.(stateRef.current)) continue;
      const it = item.intent;
      if (it.type === 'ShootUnit') {
        const target = stateRef.current.units.find((u) => u.id === it.targetUnitId);
        if (target && !aiSeatsRef.current[target.owner].enabled && target.models.some((m) => m.alive)) {
          setIncoming({ intent: it, rest: action.intents.slice(i + 1), note: action.note });
          setAiNote('⚠ Incoming fire — choose your casualty allocation');
          return true;
        }
      }
      dispatch(it);
    }
    setAiNote(action.note);
    return true;
  }, [aiDeps, dispatch]);

  /** The defender confirmed: apply the allocation choice, then let the held volley resolve
   *  (plus whatever followed it in the AI's batch). */
  const resolveIncoming = useCallback((allocation?: 'shields_first' | 'bodies_first') => {
    const held = incomingRef.current;
    if (!held) return;
    setIncoming(null); // clears the ref synchronously — dispatch below cannot re-enter here
    const cur = stateRef.current;
    const targetId = held.intent.type === 'ShootUnit' ? held.intent.targetUnitId : held.intent.targetUnitId;
    const target = cur.units.find((u) => u.id === targetId);
    if (allocation && target && target.allocation !== allocation) {
      dispatch({ type: 'SetAllocation', unitId: targetId, allocation });
    }
    const attackerId = held.intent.type === 'ShootUnit' ? held.intent.attackerUnitId : held.intent.unitId;
    const attacker = stateRef.current.units.find((u) => u.id === attackerId);
    if (attacker?.models.some((m) => m.alive) && target?.models.some((m) => m.alive)) {
      dispatch(held.intent);
    }
    for (const item of held.rest) {
      if (item.skipIf?.(stateRef.current)) continue;
      dispatch(item.intent);
    }
  }, [dispatch, setIncoming]);
  resolveIncomingRef.current = resolveIncoming;

  // Whether the game is currently waiting on an AI seat (drives auto-play and the Step button).
  // A held incoming volley pauses auto-play until the defender resolves it.
  const aiCanAct =
    state.mode === 'match' &&
    !placing &&
    !incoming &&
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

  // Drop an open split editor when the game leaves the deployment step (or the seat flips to AI).
  useEffect(() => {
    if (!splitting) return;
    const side = splitting.entryKey.split(':')[0] as Side;
    if (state.stage !== 'setup' || state.setup?.step !== 'deploy' || aiSeats[side]?.enabled) {
      setSplitting(null);
    }
  }, [splitting, state.stage, state.setup?.step, aiSeats]);

  // A held incoming volley only makes sense mid-match; drop it if the game resets — and resolve
  // it automatically if the defender's seat flips to AI (no human left to choose).
  useEffect(() => {
    if (!incoming) return;
    if (state.mode !== 'match') { setIncoming(null); return; }
    const target = state.units.find((u) => u.id === incoming.intent.targetUnitId);
    if (!target || aiSeats[target.owner].enabled) resolveIncoming();
  }, [incoming, state.mode, aiSeats, resolveIncoming, state.units]);

  // Deployment entries per side, and which are already on the board / in reserves. An entry split
  // by a transport's Declare Battle Formations rule (Immolator) expands into its two half-units.
  const entriesFor = (side: Side): DeployEntry[] => {
    const r = rosterFor(side);
    if (!r) return [];
    const splits = state.setup?.splits ?? [];
    return r.units
      .map((unit, i) => ({ key: `${side}:${i}`, unit, ds: getDatasheet(unit.datasheetId)! }))
      .filter((e) => e.ds)
      .flatMap((e): DeployEntry[] => {
        const s = splits.find((x) => x.entryKey === e.key && x.side === side);
        if (!s) return [e];
        return (['a', 'b'] as const).map((half, gi) => ({
          key: `${e.key}#${half}`,
          unit: { ...e.unit, modelCount: s.groups[gi]!.count, wargearCounts: s.groups[gi]!.wargear },
          ds: e.ds,
          half,
        }));
      });
  };
  // A merged Leader's unit instance is removed, but its entry stays placed (no double-deploy).
  const isPlaced = (key: string) => isEntryPlaced(state, key);
  const remaining: Record<Side, number> = {
    player: entriesFor('player').filter((e) => !isPlaced(e.key)).length,
    ai: entriesFor('ai').filter((e) => !isPlaced(e.key)).length,
  };
  const sideToPlace = inSetup && state.setup?.attacker ? effectiveSide(state.setup, remaining) : owner;
  // Placement is finished once neither side has entries left — the next decisions (leader
  // attaches, Warrant, first-turn roll, scout moves) all live in the Deployment/Game panel.
  const deployDone = inSetup && !!state.setup?.attacker && remaining.player + remaining.ai === 0;

  // Auto-follow the mobile tab: placement happens on the Units tab; everything else (roll-off,
  // post-placement setup steps, the battle itself) is driven from the Game panel.
  const flowKey = inSetup
    ? !state.setup?.attacker
      ? 'rolloff'
      : state.setup?.step !== 'deploy' || deployDone
        ? 'setupflow'
        : 'deploy'
    : inMatch
      ? 'battle'
      : 'sandbox';
  useEffect(() => {
    setMTab(flowKey === 'deploy' || flowKey === 'sandbox' ? 'tools' : 'game');
  }, [flowKey]);

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
    if (placing.disembarkUnitId) {
      dispatch({ type: 'DisembarkUnit', unitId: placing.disembarkUnitId, anchor, formation: placing.formation, rotation: placing.rotation });
    } else if (placing.arriveUnitId) {
      dispatch({
        type: 'ArriveFromReserves', unitId: placing.arriveUnitId, anchor,
        formation: placing.formation, rotation: placing.rotation,
        ...(placing.arriveRapid ? { rapidIngress: true } : {}),
      });
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

  /** Begin a Deep Strike arrival: ghost the Reserves unit, gated by the > 8" rule. With
   *  `rapidIngress` the arrival resolves as the Rapid Ingress stratagem (opponent's Movement). */
  function beginArrival(unitId: string, rapidIngress?: boolean) {
    const u = state.units.find((x) => x.id === unitId);
    const ds = u && getDatasheet(u.datasheetId);
    if (!u || !ds) return;
    setSelectedUnitIds([]);
    setPlacing({
      unit: { datasheetId: ds.id, modelCount: u.models.length },
      ds, formation: 'block', rotation: 0, side: u.owner, arriveUnitId: unitId, ability: 'deep_strike',
      ...(rapidIngress ? { arriveRapid: true } : {}),
    });
  }

  /** Begin a disembark placement: ghost the embarked unit around its transport (3"/6" rule —
   *  the reducer derives the tactical/combat mode from where it lands). */
  function beginDisembark(unitId: string) {
    const u = state.units.find((x) => x.id === unitId);
    const ds = u && getDatasheet(u.datasheetId);
    if (!u || !ds || !u.embarkedIn) return;
    setSelectedUnitIds([]);
    setPlacing({
      unit: { datasheetId: ds.id, modelCount: u.models.length },
      ds, formation: 'block', rotation: 0, side: u.owner, disembarkUnitId: unitId, ability: 'standard',
    });
  }

  /** Deployed friendly transports `entry` could legally start the battle embarked within. */
  function embarkBusesFor(entry: DeployEntry, side: Side) {
    if (!entry.ds.keywords.some((k) => k.toLowerCase() === 'infantry')) return [];
    const probe = {
      id: entry.key, owner: side, datasheetId: entry.ds.id,
      models: Array.from({ length: entry.unit.modelCount }, (_, mi) => ({
        id: `${entry.key}:m${mi}`, unitId: entry.key, pos: { x: 0, y: 0 }, wounds: 1, alive: true,
      })),
      startingModels: entry.unit.modelCount, status: {},
    };
    return state.units.filter(
      (t) =>
        t.owner === side && !t.inReserves && t.models.some((m) => m.alive) &&
        canEmbark(state, probe, t, { datasheets: datasheetsById }).ok,
    );
  }

  /** Deployed friendly transports whose Declare Battle Formations split rule can select `entry`
   *  (e.g. a Sisters of Battle Immolator selecting a Sisters of Battle Squad). */
  function splitTransportsFor(entry: DeployEntry, side: Side) {
    return state.units.filter((t) => {
      if (t.owner !== side || t.inReserves || !t.models.some((m) => m.alive)) return false;
      const rule = transportSplitRule(getDatasheet(t.datasheetId));
      return !!rule && splitRuleSelects(rule, entry.ds);
    });
  }

  /** Open the split editor with sensible defaults: biggest legal riding half, wargear split evenly
   *  (bump the steppers to load e.g. both meltas into the transport). */
  function beginSplit(entry: DeployEntry, transportId: string) {
    const rideCount = splitRideCounts(entry.unit.modelCount)[0] ?? 1;
    const ride: Record<string, number> = {};
    for (const [item, n] of Object.entries(entry.unit.wargearCounts ?? {})) {
      const share = Math.floor((n * rideCount) / entry.unit.modelCount);
      if (share > 0) ride[item] = share;
    }
    setSplitting({ entryKey: entry.key, transportId, rideCount, ride });
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
        ...(placing.disembarkUnitId
          ? {
              legal: (positions: Vec2[]) => {
                // Within 6" of the transport (3" = tactical, 6" = combat — the reducer picks the
                // mode) and never on top of another base. ER legality is the reducer's final say.
                const me = state.units.find((x) => x.id === placing.disembarkUnitId);
                const bus = me?.embarkedIn ? state.units.find((x) => x.id === me.embarkedIn) : undefined;
                const busDs = bus && datasheetsById.get(bus.datasheetId);
                if (!bus || !busDs) return false;
                const hull = bus.models.filter((m) => m.alive);
                const near = positions.every((p) =>
                  hull.some((tm) => gapBetweenBases(p, placing.ds.baseShape, tm.pos, busDs.baseShape) <= 6),
                );
                if (!near) return false;
                return !anyOverlap(
                  positions.map((p) => ({ pos: p, shape: placing.ds.baseShape })),
                  occupiedBases(state, { datasheets: datasheetsById }, [placing.disembarkUnitId!]),
                );
              },
            }
          : placing.arriveUnitId
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
            <h2>{deployDone ? 'Deployment complete' : <>Deploy · <span style={{ color: OWNER_COLOR[sideToPlace].fill }}>{sideToPlace}</span></>}</h2>
            {deployDone ? (
              <p className="hint">✓ Every unit is placed or in Reserves — continue in the game panel (attach Leaders, roll for first turn).</p>
            ) : aiSeats[sideToPlace].enabled ? (
              <p className="hint">🤖 The computer controls this side and deploys by itself{aiAuto ? '' : ' — auto-play is off, use Step in the Players bar'}. Switch the seat to Human there to place these units yourself.</p>
            ) : null}
            <ul className="unit-list">
              {entriesFor(sideToPlace).map((e) => {
                const placed = isPlaced(e.key);
                const active = placing?.entryKey === e.key;
                const reserve = state.units.find((u) => u.id === e.key)?.inReserves;
                // A paired Leader deploys with its unit, not alone.
                const paired = isPairedLeader(state, e.key);
                const pair = formationForBodyguard(state, e.key);
                const inst = state.units.find((u) => u.id === e.key);
                const busOf = inst?.embarkedIn ? state.units.find((t) => t.id === inst.embarkedIn) : undefined;
                const busOfName = busOf ? getDatasheet(busOf.datasheetId)?.name ?? busOf.id : null;
                const buses = pair ? [] : embarkBusesFor(e, sideToPlace);
                const splitBuses = pair || e.half || e.unit.modelCount < 2 ? [] : splitTransportsFor(e, sideToPlace);
                return (
                  <li key={e.key} className={placed ? 'placed' : ''}>
                    {placed ? (
                      <>
                        <span className="spawn done">{busOfName ? `⇥ ${busOfName}` : reserve ? 'Reserves' : '✓'}</span>
                        {busOfName && state.setup?.step === 'deploy' && !aiSeats[sideToPlace].enabled && (
                          e.half === 'a' ? (
                            <button
                              className="reserve-btn"
                              title="Undo the split (both halves return to the deployment pool)"
                              onClick={() => dispatch({ type: 'ClearSplit', entryKey: e.key.replace(/#a$/, '') })}
                            >↩</button>
                          ) : (
                            <button
                              className="reserve-btn"
                              title="Undo — return this unit to the deployment pool"
                              onClick={() => dispatch({ type: 'UndeployUnit', unitId: e.key })}
                            >↩</button>
                          )
                        )}
                      </>
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
                        {buses.length > 0 && (
                          // Start the battle embarked (18.01) — pick which deployed transport.
                          <select
                            className="embark-select"
                            value=""
                            title="Start the battle embarked within a deployed transport"
                            onChange={(ev) => {
                              const bus = buses.find((t) => t.id === ev.target.value);
                              if (!bus) return;
                              dispatch({
                                type: 'DeployUnit', unitId: e.key, owner: sideToPlace, datasheetId: e.ds.id,
                                baseShape: e.ds.baseShape, modelCount: e.unit.modelCount,
                                wounds: e.ds.models[0]?.W ?? 1, anchor: { x: 0, y: 0 },
                                intoTransportId: bus.id,
                                ...(e.unit.wargearCounts ? { wargear: e.unit.wargearCounts } : {}),
                              });
                            }}
                          >
                            <option value="">⇥ Embark…</option>
                            {buses.map((t) => (
                              <option key={t.id} value={t.id}>
                                {getDatasheet(t.datasheetId)?.name ?? t.id} · {remainingCapacity(state, t, { datasheets: datasheetsById })} seats
                              </option>
                            ))}
                          </select>
                        )}
                        {splitBuses.length > 0 && (
                          <button
                            className={`reserve-btn${splitting?.entryKey === e.key ? ' seg-on' : ''}`}
                            title="Split this unit in two: half starts embarked, half deploys on foot (Immolator rule)"
                            onClick={() => (splitting?.entryKey === e.key ? setSplitting(null) : beginSplit(e, splitBuses[0]!.id))}
                          >⇆ Split</button>
                        )}
                      </>
                    )}
                    <span className="unit-name">{e.ds.name}{pair ? ' ⚑' : ''}{e.half === 'a' ? ' · riders' : e.half === 'b' ? ' · on foot' : ''}</span>
                    <span className="unit-meta">×{e.unit.modelCount}{deployAbilityForDatasheet(e.ds) !== 'standard' ? ` · ${deployAbilityForDatasheet(e.ds) === 'infiltrators' ? 'Infiltrators' : 'Deep Strike'}` : ''}{pair?.infiltrate ? ' · Infiltrators (granted)' : ''}</span>
                    {splitting?.entryKey === e.key && !placed && (
                      <SplitEditor
                        state={state}
                        entry={e}
                        transports={splitBuses}
                        splitting={splitting}
                        setSplitting={setSplitting}
                        onConfirm={() => {
                          dispatch({
                            type: 'DeclareSplit', side: sideToPlace, entryKey: e.key,
                            datasheetId: e.ds.id, baseShape: e.ds.baseShape,
                            modelCount: e.unit.modelCount, wounds: e.ds.models[0]?.W ?? 1,
                            transportUnitId: splitting.transportId, rideCount: splitting.rideCount,
                            rideWargear: splitting.ride,
                            ...(e.unit.wargearCounts ? { totalWargear: e.unit.wargearCounts } : {}),
                          });
                          setSplitting(null);
                        }}
                      />
                    )}
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
                  <span className="unit-meta">
                    {u.embarkedIn
                      ? `⇥ ${getDatasheet(state.units.find((t) => t.id === u.embarkedIn)?.datasheetId ?? '')?.name ?? 'transport'}`
                      : u.inReserves
                        ? 'reserves'
                        : `×${u.models.filter((m) => m.alive).length}`}
                  </span>
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
          targeting={
            incoming
              ? {
                  attackerUnitId: incoming.intent.type === 'ShootUnit' ? incoming.intent.attackerUnitId : incoming.intent.unitId,
                  targetUnitId: incoming.intent.targetUnitId,
                }
              : inSetup
                ? null
                : targeting
          }
          fx={fx}
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
        {incoming && (
          <IncomingFirePanel
            state={state}
            held={incoming}
            datasheetsById={datasheetsById}
            onResolve={resolveIncoming}
            dispatch={dispatch}
          />
        )}
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
            onBeginDisembark={beginDisembark}
            detachmentBySide={{ player: rosterFor('player')?.detachment ?? '', ai: rosterFor('ai')?.detachment ?? '' }}
            onTargeting={setTargeting}
          />
        )}
      </aside>
    </div>
  );
}

/**
 * Inline editor for a transport split (Immolator rule): pick the transport, the riding-half size
 * (10 → 5+5), and exactly which wargear rides — e.g. both meltas into the Immolator to threaten
 * tanks — via per-item steppers. Confirm embarks the riding half immediately.
 */
function SplitEditor({
  state, entry, transports, splitting, setSplitting, onConfirm,
}: {
  state: GameState;
  entry: DeployEntry;
  transports: GameState['units'];
  splitting: SplitDraft;
  setSplitting: (d: SplitDraft | null) => void;
  onConfirm: () => void;
}) {
  const total = entry.unit.modelCount;
  const rideChoices = splitRideCounts(total);
  const footCount = total - splitting.rideCount;
  const items = Object.entries(entry.unit.wargearCounts ?? {});
  const bus = transports.find((t) => t.id === splitting.transportId) ?? transports[0];
  const seats = bus ? remainingCapacity(state, bus, { datasheets: datasheetsById }) : 0;
  const fits = !!bus && splitting.rideCount <= seats;
  const setRide = (item: string, n: number) => {
    const max = entry.unit.wargearCounts?.[item] ?? 0;
    const next = { ...splitting.ride, [item]: Math.max(0, Math.min(max, n)) };
    if (next[item] === 0) delete next[item];
    setSplitting({ ...splitting, ride: next });
  };
  return (
    <div className="split-editor">
      <p className="hint">
        ⇆ Split {entry.ds.name}: <strong>{splitting.rideCount} ride</strong> · {footCount} on foot.
        Set which wargear rides (e.g. meltas into the transport).
      </p>
      {transports.length > 1 && (
        <label className="field">
          <span>Transport</span>
          <select value={splitting.transportId} onChange={(e) => setSplitting({ ...splitting, transportId: e.target.value })}>
            {transports.map((t) => (
              <option key={t.id} value={t.id}>
                {datasheetsById.get(t.datasheetId)?.name ?? t.id} · {remainingCapacity(state, t, { datasheets: datasheetsById })} seats
              </option>
            ))}
          </select>
        </label>
      )}
      {rideChoices.length > 1 && (
        <div className="seg">
          {rideChoices.map((n) => (
            <button key={n} className={splitting.rideCount === n ? 'seg-on' : ''} onClick={() => setSplitting({ ...splitting, rideCount: n })}>
              {n} ride
            </button>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div className="split-gear">
          {items.map(([item, n]) => {
            const riding = splitting.ride[item] ?? 0;
            return (
              <div className="split-gear-row" key={item}>
                <span className="unit-name">{item}</span>
                <button onClick={() => setRide(item, riding - 1)} disabled={riding <= 0}>−</button>
                <span className="unit-meta">{riding}/{n} ride</span>
                <button onClick={() => setRide(item, riding + 1)} disabled={riding >= n}>+</button>
              </div>
            );
          })}
        </div>
      )}
      {!fits && <p className="warn">⚠ {bus ? `only ${seats} seats free` : 'no transport available'}</p>}
      <div className="btnrow">
        <button className="primary" disabled={!fits} onClick={onConfirm}>✓ Split &amp; embark {splitting.rideCount}</button>
        <button onClick={() => setSplitting(null)}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * "Incoming fire!" — an AI volley aimed at one of YOUR units, held before the dice roll so you
 * choose how to take it: casualty allocation (shield-bearers soak first vs. spread to the
 * regular bodies) and reactive defensive stratagems (Go to Ground / Smokescreen). The tracer
 * on the board shows who is shooting whom; Resolve rolls the dice.
 */
function IncomingFirePanel({
  state, held, datasheetsById, onResolve, dispatch,
}: {
  state: GameState;
  held: { intent: Intent & { type: 'ShootUnit' | 'FireOverwatch' }; note: string };
  datasheetsById: Map<string, Datasheet>;
  onResolve: (allocation?: 'shields_first' | 'bodies_first') => void;
  dispatch: (i: Intent) => void;
}) {
  const attackerId = held.intent.type === 'ShootUnit' ? held.intent.attackerUnitId : held.intent.unitId;
  const attacker = state.units.find((u) => u.id === attackerId);
  const target = state.units.find((u) => u.id === held.intent.targetUnitId);
  const [alloc, setAlloc] = useState<'shields_first' | 'bodies_first'>(target?.allocation ?? 'shields_first');
  if (!attacker || !target) return null;
  const name = (u: typeof attacker) => datasheetsById.get(u.datasheetId)?.name ?? u.id;
  const plan = planUnitShooting(state, attacker, { datasheets: datasheetsById });
  const gearBearers = target.models.filter(
    (m) => m.alive && (m.wargear ?? []).some((item) => defensiveProfileForItem(item)),
  ).length;
  const side = target.owner;
  const kw = (datasheetsById.get(target.datasheetId)?.keywords ?? []).map((k) => k.toUpperCase());
  const stealthUp = target.status.activeEffects?.includes('stealth');
  const canReact = state.cp[side] >= 1 && !stealthUp && (kw.includes('SMOKE') || kw.includes('INFANTRY'));
  const reactName = kw.includes('SMOKE') ? 'Smokescreen' : 'Go to Ground';

  return (
    <section className="incoming-fire">
      <h4>🎯 Incoming fire!</h4>
      <p className="fire-plan">
        <strong>{name(attacker)}</strong> is shooting <strong>{name(target)}</strong>
        {held.intent.type === 'FireOverwatch' ? ' (Overwatch)' : ''}:
      </p>
      <div className="fire-plan">
        {plan.fire.map((w, i) => (
          <div key={i} className="muted">• {w.carriers}× {w.weapon.name}</div>
        ))}
      </div>
      {gearBearers > 0 ? (
        <div>
          <p className="fire-plan"><strong>Allocate casualties:</strong> ({gearBearers} wargear bearer(s) alive)</p>
          <label className="alloc">
            <input type="radio" checked={alloc === 'shields_first'} onChange={() => setAlloc('shields_first')} />
            {' '}Shield/wargear bearers soak first (their invuln takes the brunt)
          </label>
          <label className="alloc">
            <input type="radio" checked={alloc === 'bodies_first'} onChange={() => setAlloc('bodies_first')} />
            {' '}Regular models first (preserve the wargear bearers)
          </label>
        </div>
      ) : (
        <p className="muted">No defensive-wargear bearers in the target — casualties come from the back.</p>
      )}
      {canReact && (
        <div className="btnrow">
          <button
            title={`Spend 1 CP: the unit gains Stealth (-1 to be hit) this phase`}
            onClick={() => dispatch({ type: 'UseStratagem', name: reactName, side, cost: 1, targetUnitId: target.id, effectId: 'stealth' })}
          >
            🛡 {reactName} (1 CP)
          </button>
        </div>
      )}
      {stealthUp && <p className="muted">Stealth is up (-1 to be hit).</p>}
      <div className="btnrow">
        <button className="primary" onClick={() => onResolve(gearBearers > 0 ? alloc : undefined)}>
          🎲 Resolve incoming fire
        </button>
      </div>
    </section>
  );
}
