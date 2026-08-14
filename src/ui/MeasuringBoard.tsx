import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BaseShape, Datasheet, GameState, Roster, RosterUnit, Side, Vec2 } from '../core/types';
import { reduce, createInitialState, type Intent } from '../core/state';
import { makeRNG } from '../core/rng';
import { nextFormation, type Formation } from '../core/formation';
import { checkUnitDeployment, deepStrikeArrivalLegal, isEntryPlaced, type DeployAbility } from '../core/deployment';
import { anyOverlap, occupiedBases, unitOverlaps } from '../core/collision';
import { unitCoherency, unitCentroid, validUnitShootingTargets } from '../core/phases';
import { gapBetweenBases } from '../core/geometry';
import { canEmbark, deploymentProbeUnit, remainingCapacity, splitRideCounts, splitRuleSelects, transportSplitRule } from '../core/transport';
import { PREBATTLE_GRANTS, allowsRound1DeepStrike, grantedDeployAbility } from '../core/enhancements';
import { planUnitShooting } from '../core/engine';
import { defensiveProfileForItem } from '../core/wargear';
import {
  aiAction, aiMayAct, aiReactionToFight, aiReactionToPhaseEnd, aiReactionToShooting, resolveProfile, sharedAction, whoActs, type AiDeps,
} from '../core/ai/controller';
import { formationForBodyguard, isPairedLeader, pairDeployAbility } from '../core/ai/deploy';
import {
  counteroffensiveCandidates, determinedAvailable, phaseEndReactions, promptableDefender,
  volleyDefensiveCards, type ReactionWindow,
} from '../core/ai/prompts';
import { dataIndex, datasheetsById, deployAbilityForDatasheet, getDatasheet, layouts, layoutsForPairing, rosters, stratagems } from '../data/loaders';
import { DISPOSITIONS, MISSION_MATRIX, MISSION_NAMES, type DispositionId } from '../core/missions11';
import { Board, type Placement, type MovementUI, type ShootingUI, type ShotFx } from './Board';
import { GamePanel } from './GamePanel';
import { ShootingBar, ringsForPlan } from './ShootingPanel';
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
  /** The split is a COMBAT SQUAD (no transport — both halves deploy normally). */
  combatSquad?: boolean;
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
  /** Test seam: seed an exact game state (jsdom tests drive mid-battle moments directly). */
  initialState?: GameState;
}

export function MeasuringBoard({ extraRosters = [], initialRosterName, initialState }: Props) {
  // The reducer draws from the RNG, so it must run exactly once per intent. React's useReducer
  // double-invokes reducers in dev StrictMode (the dice would be consumed twice and diverge from
  // the seed), so we reduce OUTSIDE React — once, in the event handler — and store the result.
  const [state, setState] = useState(() => initialState ?? createInitialState(layouts[0]!));
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

  // On phones the app becomes three full-height pages behind a bottom nav: the Board, the
  // Units/tools panel, and the Game panel. Auto-follow the flow: roll-off & battle → Play;
  // deployment & sandbox → Units; arming a placement ghost → Board (that's where you drop it).
  // (flowKey is derived below once the deployment bookkeeping exists; the effect lives with it.)
  const [mTab, setMTab] = useState<'board' | 'tools' | 'game'>('tools');

  // Battle type: a standard (11e Chapter Approved) battle, or Combat Patrol (fixed patrol
  // lists on the three 30"×44" CP maps). Drives which maps and rosters are offered.
  const [battleType, setBattleType] = useState<'standard' | 'combat_patrol'>('standard');

  // Group the layouts by deployment for the map picker (8 terrain layouts per deployment).
  // Combat Patrol maps live in their own picker mode, not the standard groups.
  const layoutGroups = useMemo(() => {
    const groups = new Map<string, typeof layouts>();
    for (const l of layouts) {
      if (l.combatPatrol) continue;
      if (!groups.has(l.deployment)) groups.set(l.deployment, []);
      groups.get(l.deployment)!.push(l);
    }
    return [...groups.entries()];
  }, []);
  const cpLayouts = useMemo(() => layouts.filter((l) => l.combatPatrol), []);

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
  // In a Combat Patrol battle only the fixed patrol lists are offered; in a standard battle
  // they are hidden (a 4-unit patrol is not a legal 1000pt list). Mid-match the battle type
  // comes from the game state (it survives a reload; the local toggle does not).
  const effectiveBattleType = state.mode === 'match' ? (state.battleType ?? 'standard') : battleType;
  const pickableRosters = useMemo(
    () => allRosters.filter((r) => (effectiveBattleType === 'combat_patrol' ? r.combatPatrol : !r.combatPatrol)),
    [allRosters, effectiveBattleType],
  );
  const firstWithUnits = allRosters.find((r) => !r.combatPatrol && r.units.length > 0) ?? allRosters[0];
  const [rosterNameBySide, setRosterNameBySide] = useState<Record<Side, string>>({
    player: initialRosterName ?? firstWithUnits?.name ?? '',
    ai: firstWithUnits?.name ?? '',
  });
  // Switching battle type swaps the map and both armies to matching picks.
  const switchBattleType = (t: 'standard' | 'combat_patrol') => {
    if (t === battleType) return;
    setBattleType(t);
    const pool = allRosters.filter((r) => (t === 'combat_patrol' ? r.combatPatrol : !r.combatPatrol && r.units.length > 0));
    const first = pool[0]?.name ?? '';
    const second = pool[1]?.name ?? first;
    setRosterNameBySide({ player: first, ai: second });
    if (t === 'combat_patrol') {
      if (!state.layout.combatPatrol && cpLayouts[0]) dispatch({ type: 'SetLayout', layout: cpLayouts[0] });
    } else if (state.layout.combatPatrol) {
      const rec = layoutsForPairing(dispositions.player, dispositions.ai);
      const back = rec[0] ?? layouts.find((l) => !l.combatPatrol);
      if (back) dispatch({ type: 'SetLayout', layout: back });
    }
  };
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
  // Shooting from the map: the unit tapped as the shooter and the enemy tapped as its target.
  const [shootSel, setShootSel] = useState<{ attackerId?: string; targetId?: string }>({});
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

  // A REACTION PROMPT: the AI is paused just before a moment the human could react to (the end
  // of its Movement/Charge/Fight phase, or a fight activation) — the held intents resume when
  // the human continues (or are discarded when the reaction re-plans the AI, e.g.
  // Counteroffensive). Auto-play pauses while set.
  type HeldPrompt = {
    kind: 'phase_end' | 'fight_start' | 'melee';
    side: Side; // the human defender being prompted
    label: string;
    windows: ReactionWindow[];
    intents: { intent: Intent; skipIf?: (s: GameState) => boolean }[];
    note: string;
    /** Determined to the Last target (kind 'melee'). */
    meleeTargetId?: string;
  };
  const [heldPrompt, setHeldPromptState] = useState<HeldPrompt | null>(null);
  const heldPromptRef = useRef<HeldPrompt | null>(null);
  const setHeldPrompt = useCallback((v: HeldPrompt | null) => {
    heldPromptRef.current = v;
    setHeldPromptState(v);
  }, []);
  // Fight-start prompts (Counteroffensive) recur every enemy activation — one dismissal
  // silences them for the rest of that phase.
  const promptDismissRef = useRef<string>('');

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

  // A patrol enhancement picked in the List Builder rides on the roster — register it as the
  // side's one-per-patrol decision up front, so the deployment picker shows it as decided
  // instead of asking again (and an AI seat doesn't stack its own default on top).
  useEffect(() => {
    if (state.mode !== 'match' || state.battleType !== 'combat_patrol') return;
    if (state.stage !== 'setup' || !state.setup?.attacker) return;
    for (const side of ['player', 'ai'] as const) {
      if (state.cpEnhancements?.[side]) continue;
      const carried = rosterFor(side)?.units.find((u) => u.enhancementId?.startsWith('cpenh:'));
      if (carried) {
        dispatch({ type: 'ChooseCpEnhancement', side, enhancementId: carried.enhancementId!, targetDsId: carried.datasheetId });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.battleType, state.stage, state.setup?.attacker, state.cpEnhancements, rosterNameBySide]);

  /** Take one AI action if the game is waiting on an AI seat. Returns true when something ran.
   *  An AI volley aimed at a HUMAN-owned unit is intercepted: the intent is held in `incoming`
   *  and the defender chooses casualty allocation (and reactions) before the dice roll. */
  const aiTick = useCallback((): boolean => {
    const cur = stateRef.current;
    if (cur.mode !== 'match') return false; // the AI plays matches, never the free sandbox
    if (incomingRef.current) return false; // waiting on the defender's allocation choice
    if (heldPromptRef.current) return false; // waiting on the human's reaction window
    const seats = aiSeatsRef.current;
    const actor = aiMayAct(whoActs(cur, aiDeps), { player: seats.player.enabled, ai: seats.ai.enabled });
    if (!actor) return false;
    const action = actor === 'shared' ? sharedAction(cur) : aiAction(cur, actor, seats[actor].profile, aiDeps);
    /** The human seat (if any) that could react to the AI's current turn. */
    const humanDefender = (s: GameState): Side | null =>
      promptableDefender(s, { player: !aiSeatsRef.current.player.enabled, ai: !aiSeatsRef.current.ai.enabled });
    /** Hold `intents` (starting at index i) behind a reaction prompt. Returns true. */
    const holdFor = (
      kind: 'phase_end' | 'fight_start' | 'melee',
      side: Side,
      label: string,
      windows: ReactionWindow[],
      intents: { intent: Intent; skipIf?: (s: GameState) => boolean }[],
      note: string,
      meleeTargetId?: string,
    ): boolean => {
      setHeldPrompt({ kind, side, label, windows, intents, note, ...(meleeTargetId ? { meleeTargetId } : {}) });
      setAiNote(`⚡ Reaction window — ${label}`);
      return true;
    };
    if (!action || action.intents.length === 0) {
      // Mirror the headless runner: an empty battle-phase action would stall auto-play forever
      // (no dispatch → no state change → the effect never re-fires), so advance the phase.
      if (cur.stage === 'battle' && !cur.ended) {
        // Even a forced advance is a phase end the human may want to react to.
        const side = humanDefender(cur);
        const windows = side ? phaseEndReactions(cur, side, { datasheets: datasheetsById }) : [];
        if (side && windows.length > 0) {
          return holdFor('phase_end', side, `the opponent is ending its ${cur.phase} phase`, windows, [{ intent: { type: 'AdvancePhase' } }], 'phase advanced');
        }
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
      const now = stateRef.current;
      if (it.type === 'ShootUnit') {
        const target = now.units.find((u) => u.id === it.targetUnitId);
        if (target && !aiSeatsRef.current[target.owner].enabled && target.models.some((m) => m.alive)) {
          setIncoming({ intent: it, rest: action.intents.slice(i + 1), note: action.note });
          setAiNote('⚠ Incoming fire — choose your casualty allocation');
          return true;
        }
      }
      // Reaction prompts: pause the AI just before a moment the human could react to.
      if (now.stage === 'battle' && !now.ended) {
        const side = humanDefender(now);
        if (side) {
          // End of the AI's Movement/Charge/Fight phase → Overwatch / Rapid Ingress / Heroic
          // Intervention / Gate of Infinity / Swift Embarkation.
          if (it.type === 'AdvancePhase') {
            const windows = phaseEndReactions(now, side, { datasheets: datasheetsById });
            if (windows.length > 0) {
              return holdFor('phase_end', side, `the opponent is ending its ${now.phase} phase`, windows, action.intents.slice(i), action.note);
            }
          }
          // Before an enemy Fight activation → Counteroffensive (2 CP to swing first).
          if (
            it.type === 'FightMove' && it.mode === 'pile_in' &&
            promptDismissRef.current !== `${now.round}:${now.activePlayer}:${now.phase}` &&
            counteroffensiveCandidates(now, side, { datasheets: datasheetsById }).length > 0
          ) {
            return holdFor(
              'fight_start', side, 'an enemy unit is about to fight',
              [{ id: 'counter', label: 'Counteroffensive (2 CP)', hint: 'One of your un-fought engaged units swings first instead.' }],
              action.intents.slice(i), action.note,
            );
          }
          // An enemy melee volley at the Bladeguard → Determined to the Last (fights-on-death).
          if (it.type === 'FightUnit') {
            const target = now.units.find((u) => u.id === it.targetUnitId);
            if (target && target.owner === side && determinedAvailable(now, target.id, { datasheets: datasheetsById })) {
              return holdFor(
                'melee', side, 'the Bladeguard are targeted in melee',
                [{ id: 'determined', label: 'Determined to the Last (1 CP)', hint: 'Destroyed models fight on a 2+ before they are removed.' }],
                action.intents.slice(i), action.note, target.id,
              );
            }
          }
        }
      }
      dispatch(it);
    }
    setAiNote(action.note);
    return true;
  }, [aiDeps, dispatch, setHeldPrompt, setIncoming]);

  /** Resume a held reaction prompt: dispatch what the AI had queued (skipIf re-checked). A
   *  later item can open the NEXT window (Continue past Counteroffensive must still offer
   *  Determined to the Last on the same activation's melee volley). */
  const resumePrompt = useCallback(() => {
    const held = heldPromptRef.current;
    if (!held) return;
    setHeldPrompt(null);
    if (held.kind === 'fight_start') {
      promptDismissRef.current = `${stateRef.current.round}:${stateRef.current.activePlayer}:${stateRef.current.phase}`;
    }
    for (let i = 0; i < held.intents.length; i++) {
      const item = held.intents[i]!;
      if (item.skipIf?.(stateRef.current)) continue;
      const it = item.intent;
      const now = stateRef.current;
      if (held.kind !== 'melee' && it.type === 'FightUnit' && now.stage === 'battle' && !now.ended) {
        const target = now.units.find((u) => u.id === it.targetUnitId);
        if (
          target && target.owner === held.side && !aiSeatsRef.current[held.side].enabled &&
          determinedAvailable(now, target.id, { datasheets: datasheetsById })
        ) {
          setHeldPrompt({
            kind: 'melee', side: held.side, label: 'the Bladeguard are targeted in melee',
            windows: [{ id: 'determined', label: 'Determined to the Last (1 CP)', hint: 'Destroyed models fight on a 2+ before they are removed.' }],
            intents: held.intents.slice(i), note: held.note, meleeTargetId: target.id,
          });
          return;
        }
      }
      dispatch(it);
    }
    setAiNote(held.note);
  }, [dispatch, setHeldPrompt]);

  /** Discard a held prompt WITHOUT dispatching — used when the human's reaction re-plans the
   *  AI's activation (Counteroffensive: the human fights next, the AI re-picks on its tick). */
  const discardPrompt = useCallback(() => {
    setHeldPrompt(null);
  }, [setHeldPrompt]);

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
  // A held incoming volley or reaction prompt pauses auto-play until the human resolves it.
  const aiCanAct =
    state.mode === 'match' &&
    !placing &&
    !incoming &&
    !heldPrompt &&
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

  // A held reaction prompt likewise: drop it when the game resets, resume automatically when
  // the prompted seat flips to AI (its own reaction seams already answered).
  useEffect(() => {
    if (!heldPrompt) return;
    if (state.mode !== 'match' || state.stage !== 'battle') { setHeldPrompt(null); return; }
    if (aiSeats[heldPrompt.side].enabled) resumePrompt();
  }, [heldPrompt, state.mode, state.stage, aiSeats, resumePrompt, setHeldPrompt]);

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
          ...(s.transportUnitId ? {} : { combatSquad: true }),
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
  // Declare Battle Formations enhancement grants (Clandestine Operation…) resolve BEFORE any
  // unit is placed: whoActs already holds the AI back, so manual placement must pause too or the
  // human deploys their whole army with zero alternation while the AI politely waits.
  const grantPending =
    inSetup && state.setup?.step === 'deploy' &&
    (['player', 'ai'] as const).some((side) =>
      entriesFor(side).some((e) => {
        const id = e.unit.enhancementId;
        if (!id || !PREBATTLE_GRANTS[id]) return false;
        return !(state.setup?.grants ?? []).some((g) => g.side === side && g.enhancementId === id);
      }),
    );

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
  // Arming any placement ghost (deploy drop, Deep Strike arrival, disembark) jumps to the Board
  // page — that is where the ghost is dropped; resolving it returns to the flow's home page.
  const placingActive = !!placing;
  useEffect(() => {
    if (placingActive) setMTab('board');
    else setMTab(flowKey === 'deploy' || flowKey === 'sandbox' ? 'tools' : 'game');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placingActive]);
  // A prompt (incoming fire / reaction window) must be SEEN — on phones, jump to the Game tab.
  useEffect(() => {
    if (incoming || heldPrompt) setMTab('game');
  }, [incoming, heldPrompt]);

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
   *  Bodyguard deploys with its declared pair ability (e.g. Backroom Deals → Infiltrators);
   *  a Clandestine Operation-style Battle Formations grant upgrades a standard deployer. */
  function beginDeploy(entry: DeployEntry, side: Side) {
    const pair = formationForBodyguard(state, entry.key);
    let ability = pair
      ? (() => {
          const a = pairDeployAbility(pair, { datasheets: datasheetsById }, deployAbilityForDatasheet);
          return a === 'deep_strike' ? 'standard' : a; // on-board placement; Reserves handles DS
        })()
      : deployAbilityForDatasheet(entry.ds);
    if (ability === 'standard' && grantedDeployAbility(state, entry.key) === 'infiltrators') {
      ability = 'infiltrators';
    }
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
      ...(placing.unit.enhancementId ? { enhancementId: placing.unit.enhancementId } : {}),
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
          ...(leaderEntry.unit.enhancementId ? { enhancementId: leaderEntry.unit.enhancementId } : {}),
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
    const probe = deploymentProbeUnit(entry.key, side, entry.ds.id, entry.unit.modelCount);
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
    dispatch({ type: 'PlaceInReserves', unitId: entry.key, owner: side, datasheetId: ds.id, baseShape: ds.baseShape, modelCount: entry.unit.modelCount, wounds: ds.models[0]?.W ?? 1, ...(entry.unit.wargearCounts ? { wargear: entry.unit.wargearCounts } : {}), ...(entry.unit.enhancementId ? { enhancementId: entry.unit.enhancementId } : {}) });
    // A paired Leader follows its unit into Reserves and merges there.
    const pair = formationForBodyguard(state, entry.key);
    const leaderEntry = pair ? entriesFor(side).find((e) => e.key === pair.leaderKey) : undefined;
    if (pair && leaderEntry) {
      dispatch({
        type: 'PlaceInReserves',
        unitId: pair.leaderKey, owner: side, datasheetId: leaderEntry.ds.id, baseShape: leaderEntry.ds.baseShape,
        modelCount: leaderEntry.unit.modelCount, wounds: leaderEntry.ds.models[0]?.W ?? 1,
        ...(leaderEntry.unit.wargearCounts ? { wargear: leaderEntry.unit.wargearCounts } : {}),
        ...(leaderEntry.unit.enhancementId ? { enhancementId: leaderEntry.unit.enhancementId } : {}),
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
          ? {
              legal: (positions: Vec2[]) => {
                // Priority-drop Beacon: the bearer may Deep Strike from round 1 — the ghost must
                // agree with the reducer's round bump or round-1 arrivals are a red dead-end.
                const arriving = state.units.find((u) => u.id === placing.arriveUnitId);
                const effRound = arriving && allowsRound1DeepStrike(arriving) ? Math.max(state.round, 2) : state.round;
                return deepStrikeArrivalLegal(
                  positions, placing.ds.baseShape, enemyModels(placing.side), effRound,
                  occupiedBases(state, { datasheets: datasheetsById }, placing.arriveUnitId ? [placing.arriveUnitId] : []),
                ).legal;
              },
            }
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

  // Shooting-phase board interaction: tap your unit → its weapons + range rings; tap an enemy →
  // the matchup stat sheet + Shoot. Active only on a HUMAN side's own Shooting phase (an AI
  // volley at your units already pauses in the Incoming fire panel).
  const inShooting =
    inMatch && state.stage === 'battle' && state.phase === 'Shooting' && !state.ended &&
    !placing && !aiSeats[state.activePlayer].enabled;
  useEffect(() => {
    if (!inShooting && (shootSel.attackerId || shootSel.targetId)) setShootSel({});
  }, [inShooting, shootSel]);
  const shootAttacker =
    inShooting && shootSel.attackerId
      ? state.units.find(
          (u) =>
            u.id === shootSel.attackerId && u.owner === state.activePlayer &&
            !u.inReserves && u.models.some((m) => m.alive),
        )
      : undefined;
  const shootPlan = useMemo(
    () => (shootAttacker ? planUnitShooting(state, shootAttacker, { datasheets: datasheetsById }) : null),
    [state, shootAttacker],
  );
  const shootRings = useMemo(() => (shootPlan ? ringsForPlan(shootPlan) : []), [shootPlan]);
  const shootTargetable = useMemo(
    () =>
      shootAttacker
        ? validUnitShootingTargets(shootAttacker, state, { datasheets: datasheetsById }).map((u) => u.id)
        : [],
    [state, shootAttacker],
  );
  const shooting: ShootingUI | null = inShooting
    ? {
        side: state.activePlayer,
        attackerUnitId: shootAttacker?.id ?? null,
        targetUnitId: shootSel.targetId ?? null,
        rings: shootRings,
        targetableIds: shootTargetable,
        onPickUnit: (unitId) => {
          const cur = stateRef.current;
          const u = cur.units.find((x) => x.id === unitId);
          if (!u || u.inReserves || !u.models.some((m) => m.alive)) return;
          if (u.owner === cur.activePlayer) {
            // Tap your unit: select it as the shooter (tap again to clear; a new unit switches).
            setShootSel((s) => (s.attackerId === unitId ? {} : { attackerId: unitId }));
          } else {
            // Tap an enemy: target it for the selected shooter (tap again to untarget).
            setShootSel((s) =>
              s.attackerId
                ? { attackerId: s.attackerId, ...(s.targetId === unitId ? {} : { targetId: unitId }) }
                : s,
            );
          }
        },
        onClear: () => setShootSel({}),
      }
    : null;

  const sandboxRoster = rosterFor('player');

  return (
    <div className="layout" data-mtab={mTab}>
      {/* Mobile-only bottom nav: three full-height pages (Board / Units / Play). */}
      <div className="m-tabs" role="tablist">
        <button role="tab" aria-selected={mTab === 'board'} className={mTab === 'board' ? 'on' : ''} onClick={() => setMTab('board')}>
          <span className="m-ico" aria-hidden>🗺️</span>
          <span>Board</span>
        </button>
        <button role="tab" aria-selected={mTab === 'tools'} className={mTab === 'tools' ? 'on' : ''} onClick={() => setMTab('tools')}>
          <span className="m-ico" aria-hidden>📋</span>
          <span>{inSetup ? 'Deploy' : 'Units'}</span>
        </button>
        <button role="tab" aria-selected={mTab === 'game'} className={mTab === 'game' ? 'on' : ''} onClick={() => setMTab('game')}>
          <span className="m-ico" aria-hidden>⚔️</span>
          <span>{inSetup ? 'Setup' : 'Play'}</span>
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
              // Restarting mid-setup keeps the running battle's type (it survives a reload).
              dispatch({ type: 'NewBattle', dispositions, battleType: effectiveBattleType });
            }}
          >
            {inSetup ? '↻ Restart deployment' : battleType === 'combat_patrol' ? '⚔ New Combat Patrol battle' : '⚔ New battle'}
          </button>
        </div>

        <section>
          {!inMatch && (
            <div className="field">
              <span>Battle type</span>
              <div className="seg">
                {(['standard', 'combat_patrol'] as const).map((t) => (
                  <button key={t} className={battleType === t ? 'seg-on' : ''} onClick={() => switchBattleType(t)}>
                    {t === 'standard' ? 'Standard' : 'Combat Patrol'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!inMatch && battleType === 'combat_patrol' && (
            <p className="hint">
              Combat Patrol: each side plays one of the four fixed patrols on one of the three
              30"×44" maps. Pick the map and both patrols, then start the battle.
            </p>
          )}
          {!inMatch && battleType === 'standard' && (
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
              {battleType === 'combat_patrol' ? (
                <optgroup label="Combat Patrol maps (30″×44″)">
                  {cpLayouts.map((l) => (
                    <option key={l.id} value={l.id}>{l.name ?? l.id}</option>
                  ))}
                </optgroup>
              ) : (
                <>
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
                </>
              )}
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
            ) : grantPending ? (
              <p className="hint">✨ A Declare Battle Formations enhancement pick (e.g. Clandestine Operation) is waiting in the game panel — confirm or skip it, then deployment continues.</p>
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
                // Transport options only matter for an actionable (unplaced, human-controlled) row —
                // skip the capacity scans for everything else.
                const actionable = !placed && !paired && !aiSeats[sideToPlace].enabled && !grantPending;
                const buses = !actionable || pair ? [] : embarkBusesFor(e, sideToPlace);
                const splitBuses = !actionable || pair || e.half || e.unit.modelCount < 2 ? [] : splitTransportsFor(e, sideToPlace);
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
                    ) : grantPending ? (
                      // Deployment pauses until every Declare Battle Formations enhancement pick is
                      // resolved (the AI is held back by the same gate — alternation stays fair).
                      <span className="spawn done" title="Resolve the ✨ enhancement pick in the deployment panel first">✨…</span>
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
                                ...(e.unit.enhancementId ? { enhancementId: e.unit.enhancementId } : {}),
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
                        {!e.half && e.unit.modelCount === 10 &&
                          (e.ds.abilities ?? []).some((a) => a.name.toLowerCase().startsWith('combat squad')) && (
                            <button
                              className="reserve-btn"
                              title="COMBAT SQUAD: split into two units of five (wargear divides as evenly as possible)"
                              onClick={() =>
                                dispatch({
                                  type: 'DeclareCombatSquad', side: sideToPlace, entryKey: e.key,
                                  datasheetId: e.ds.id, modelCount: e.unit.modelCount,
                                  ...(e.unit.wargearCounts ? { totalWargear: e.unit.wargearCounts } : {}),
                                })
                              }
                            >⚟ Combat Squad</button>
                          )}
                        {e.combatSquad && e.half === 'a' && (
                          <button
                            className="reserve-btn"
                            title="Undo the Combat Squad split (both halves return to the pool as one unit)"
                            onClick={() => dispatch({ type: 'ClearSplit', entryKey: e.key.replace(/#a$/, '') })}
                          >↩</button>
                        )}
                      </>
                    )}
                    <span className="unit-name">{e.ds.name}{pair ? ' ⚑' : ''}{e.combatSquad ? (e.half === 'a' ? ' · squad A' : ' · squad B') : e.half === 'a' ? ' · riders' : e.half === 'b' ? ' · on foot' : ''}</span>
                    <span className="unit-meta">
                      ×{e.unit.modelCount}
                      {deployAbilityForDatasheet(e.ds) !== 'standard' ? ` · ${deployAbilityForDatasheet(e.ds) === 'infiltrators' ? 'Infiltrators' : 'Deep Strike'}` : ''}
                      {pair?.infiltrate ? ' · Infiltrators (granted)' : ''}
                      {grantedDeployAbility(state, e.key) === 'infiltrators' ? ' · Infiltrators ✨' : grantedDeployAbility(state, e.key) === 'deep_strike' ? ' · Deep Strike ✨' : ''}
                    </span>
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
          shooting={shooting}
          targeting={
            incoming
              ? {
                  attackerUnitId: incoming.intent.type === 'ShootUnit' ? incoming.intent.attackerUnitId : incoming.intent.unitId,
                  targetUnitId: incoming.intent.targetUnitId,
                }
              : inSetup
                ? null
                : shooting && (shooting.attackerUnitId || shooting.targetUnitId)
                  ? {
                      ...(shooting.attackerUnitId ? { attackerUnitId: shooting.attackerUnitId } : {}),
                      ...(shooting.targetUnitId ? { targetUnitId: shooting.targetUnitId } : {}),
                    }
                  : targeting
          }
          fx={fx}
        />
        {/* Shooting phase, driven from the map: the tapped shooter's weapons + range rings, and
            the tapped enemy's stat sheet. Lives right under the board so the phone's Board page
            covers the whole phase without tab-flipping. */}
        {shooting?.attackerUnitId && shootPlan && (
          <ShootingBar
            state={state}
            attackerUnitId={shooting.attackerUnitId}
            targetUnitId={shooting.targetUnitId}
            plan={shootPlan}
            rings={shootRings}
            datasheetsById={datasheetsById}
            dispatch={dispatch}
            onClear={() => setShootSel({})}
          />
        )}
        {/* Mobile-only: drive the Movement phase right on the Board page — selecting and
            dragging happen here, so starting and confirming the move should too (no tab-flip). */}
        {inMatch && !inSetup && !state.ended && (() => {
          const side = state.activePlayer;
          if (aiSeats[side].enabled) return null;
          const movers = state.units.filter((u) => u.owner === side && u.status.moveBudget != null);
          if (movers.length > 0) {
            const ids = movers.map((u) => u.id);
            return (
              <div className="m-movebar m-only">
                <span className="m-movelabel">
                  {movers.length} unit{movers.length > 1 ? 's' : ''} moving — drag, then confirm
                </span>
                <button className="ok" onClick={() => dispatch({ type: 'EndMove', unitIds: ids })}>✓ Confirm</button>
                <button onClick={() => dispatch({ type: 'CancelMove', unitIds: ids })}>✕ Cancel</button>
              </div>
            );
          }
          // Selected but not yet activated: offer Move/Advance here in the Movement phase.
          if (state.phase !== 'Movement') return null;
          const selectable = selectedUnitIds.filter((id) => {
            const u = state.units.find((x) => x.id === id);
            return u && u.owner === side && !u.inReserves && !u.status.moved && !u.status.advanced &&
              !u.status.fellBack && !u.status.remainedStationary && u.models.some((m) => m.alive);
          });
          if (selectable.length === 0) return null;
          return (
            <div className="m-movebar m-only">
              <span className="m-movelabel">
                {selectable.length} unit{selectable.length > 1 ? 's' : ''} selected
              </span>
              <button className="ok" onClick={() => dispatch({ type: 'BeginMove', unitIds: selectable, mode: 'normal' })}>Move</button>
              <button onClick={() => dispatch({ type: 'BeginMove', unitIds: selectable, mode: 'advance' })}>Advance</button>
            </div>
          );
        })()}
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
        {heldPrompt && (
          <ReactionPromptPanel
            state={state}
            held={heldPrompt}
            datasheetsById={datasheetsById}
            onContinue={resumePrompt}
            onDiscard={discardPrompt}
            dispatch={dispatch}
          />
        )}
        {inSetup ? (
          <DeploymentPanel
            state={state}
            dispatch={dispatch}
            datasheetsById={datasheetsById}
            rosters={pickableRosters}
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
  // Every item needs bearers in its half: at most `rideCount` riders can carry it, and whatever
  // stays on foot needs at most `footCount` bearers (mirrors the reducer's validation).
  const boundsFor = (count: number) => ({
    min: Math.max(0, count - footCount),
    max: Math.min(count, splitting.rideCount),
  });
  const setRide = (item: string, n: number) => {
    const count = entry.unit.wargearCounts?.[item] ?? 0;
    const { min, max } = boundsFor(count);
    const next = { ...splitting.ride, [item]: Math.max(min, Math.min(max, n)) };
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
            const { min, max } = boundsFor(n);
            return (
              <div className="split-gear-row" key={item}>
                <span className="unit-name">{item}</span>
                <button onClick={() => setRide(item, riding - 1)} disabled={riding <= min}>−</button>
                <span className="unit-meta">{riding}/{n} ride</span>
                <button onClick={() => setRide(item, riding + 1)} disabled={riding >= max}>+</button>
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
      {/* Combat Patrol defensive cards (Refusal to Yield / Urban Enforcers) — same window. */}
      {volleyDefensiveCards(state, target, { datasheets: datasheetsById }).map((c) => (
        <div className="btnrow" key={c.stratagemId}>
          <button
            title={c.hint}
            onClick={() =>
              dispatch({
                type: 'UseStratagem', name: c.name, side, cost: 1,
                stratagemId: c.stratagemId, targetUnitId: target.id, effectId: c.effectId,
              })
            }
          >
            🛡 {c.name} (1 CP)
          </button>
          <span className="muted">{c.hint}</span>
        </div>
      ))}
      {stealthUp && <p className="muted">Stealth is up (-1 to be hit).</p>}
      <div className="btnrow">
        <button className="primary" onClick={() => onResolve(gearBearers > 0 ? alloc : undefined)}>
          🎲 Resolve incoming fire
        </button>
      </div>
    </section>
  );
}

/**
 * A reactive-window prompt: the AI is paused at a moment the human can act on (the end of its
 * Movement/Charge/Fight phase, an enemy fight activation, or a melee volley at the Bladeguard).
 * The phase has NOT advanced, so the panel's usual controls below (Stratagem plays / Unit
 * abilities / the Stratagems list) are live — direct one-tap plays render inline.
 */
function ReactionPromptPanel({
  state, held, datasheetsById, onContinue, onDiscard, dispatch,
}: {
  state: GameState;
  held: {
    kind: 'phase_end' | 'fight_start' | 'melee';
    side: Side;
    label: string;
    windows: { id: string; label: string; hint: string }[];
    meleeTargetId?: string;
  };
  datasheetsById: Map<string, Datasheet>;
  onContinue: () => void;
  onDiscard: () => void;
  dispatch: (i: Intent) => void;
}) {
  const name = (id: string) => {
    const u = state.units.find((x) => x.id === id);
    return u ? datasheetsById.get(u.datasheetId)?.name ?? id : id;
  };
  const counterUnits =
    held.kind === 'fight_start'
      ? counteroffensiveCandidates(state, held.side, { datasheets: datasheetsById })
      : [];
  return (
    <section className="incoming-fire reaction-prompt">
      <h4>⚡ You can react — {held.label}</h4>
      {held.windows.map((w) => (
        <p className="fire-plan" key={w.id}>
          <strong>{w.label}</strong> — {w.hint}
        </p>
      ))}
      {held.kind === 'fight_start' && counterUnits.length > 0 && (
        <div className="btnrow">
          <span className="muted">Fight next with:</span>
          {counterUnits.slice(0, 3).map((u) => (
            <button
              key={u.id}
              onClick={() => {
                // The reaction re-plans the enemy's activation — discard what it had queued;
                // the AI re-picks on its next tick (after your unit fights).
                dispatch({ type: 'Counteroffensive', unitId: u.id });
                onDiscard();
              }}
            >
              ⚔ {name(u.id)} (2 CP)
            </button>
          ))}
        </div>
      )}
      {held.kind === 'melee' && held.meleeTargetId && (
        <div className="btnrow">
          <button
            onClick={() => {
              dispatch({
                type: 'UseStratagem', name: 'Determined to the Last', side: held.side, cost: 1,
                stratagemId: 'cp:vengeful_brethren:determined_to_the_last',
                targetUnitId: held.meleeTargetId!, effectId: 'cp:fights_on_death',
              });
              // The buffed fight still happens — resume the enemy's activation.
              onContinue();
            }}
          >
            🛡 Determined to the Last (1 CP)
          </button>
        </div>
      )}
      {held.kind === 'phase_end' && (
        <p className="muted">The phase has not ended yet — the controls below are live.</p>
      )}
      <div className="btnrow">
        <button className="primary" onClick={onContinue}>
          ▶ Continue{held.kind === 'fight_start' ? " (don't ask again this phase)" : ''}
        </button>
      </div>
    </section>
  );
}
