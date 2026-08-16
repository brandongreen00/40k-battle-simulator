import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Datasheet, GameState, UnitInstance } from '../core/types';
import type { Intent } from '../core/state';
import { availableUnitWeapons, planUnitFight, planUnitShooting, type EngineContext } from '../core/engine';
import { unitOverlaps } from '../core/collision';
import { armyHasDetachment } from '../core/detachments';
import { unitDenseViolation } from '../core/terrainmove';
import type { MoveMode } from '../core/movement';
import { EFFECT_REGISTRY } from '../core/effects';
import {
  reservesArrivable, unitCoherency, eligibleToShoot, eligibleToCharge, eligibleToFight,
  validUnitShootingTargets, chargeTargets, engagedEnemies, fightActivationOrder, orderableUnits,
  gapBetween, type Eligibility,
} from '../core/phases';
import { disembarkMode, embarkOptions } from '../core/transport';
import { abhumanOnlyOrderTarget, ordersAvailableTo, unitIsOfficer } from '../core/orders';
import { secondaryCard } from '../core/secondaries';
import { dispositionName, MISSION_NAMES, PRIMARY_CAP, actionsForSide, objectivePoints } from '../core/missions11';
import { CP_MISSIONS } from '../core/cpmissions';
import { canStartAction, SECONDARY_ACTIONS } from '../core/missionflow';
import { usableStratagems } from '../core/stratagems';
import { stratagems } from '../data/loaders';
import { Die } from './Dice';
import { OWNER_COLOR } from './view';
import type { Side } from '../core/types';

interface Props {
  state: GameState;
  dispatch: (i: Intent) => void;
  datasheetsById: Map<string, Datasheet>;
  /** Units selected on the board (Movement phase); managed by the parent. */
  selectedUnitIds?: string[];
  setSelectedUnitIds?: (ids: string[]) => void;
  /** Begin a Deep Strike arrival placement for a Reserves unit (handled by the board). */
  onBeginArrival?: (unitId: string) => void;
  /** Begin a disembark placement for an embarked unit (handled by the board). */
  onBeginDisembark?: (unitId: string) => void;
  /** Each side's army detachment (drives which detachment stratagems are available). */
  detachmentBySide?: Record<Side, string>;
  /** Reports the currently selected attacker/target so the board can highlight them. */
  onTargeting?: (t: { attackerUnitId?: string; targetUnitId?: string }) => void;
}

const MOVE_MODES: { mode: MoveMode; label: string }[] = [
  { mode: 'normal', label: 'Move' },
  { mode: 'advance', label: 'Advance' },
  { mode: 'fall_back', label: 'Fall Back' },
  { mode: 'stationary', label: 'Remain' },
];

/**
 * The play surface for the combat core (Phases 1–3): turn/phase/round controls, the CP + VP
 * scoreboard, attack/charge resolution between on-board units, Order/Stratagem application, and the
 * live dice log. All actions go through the same intent reducer the rest of the app uses.
 */
export function GamePanel({ state, dispatch, datasheetsById, selectedUnitIds = [], setSelectedUnitIds, onBeginArrival, onBeginDisembark, detachmentBySide, onTargeting }: Props) {
  const units = state.units;
  const phase = state.phase;
  const inMatch = state.mode === 'match';
  const [attackerId, setAttackerId] = useState('');
  const [targetId, setTargetId] = useState('');
  // Composite weapon selection "<sourceDsId>|<name>" — merged units can carry same-named weapons
  // from two datasheets, so the name alone is ambiguous.
  const [weaponSel, setWeaponSel] = useState('');
  const weaponName = weaponSel.split('|')[1] ?? '';
  const weaponSourceDsId = weaponSel.split('|')[0] ?? '';
  const [effectId, setEffectId] = useState('order:take_aim');
  const [stratSide, setStratSide] = useState<Side>(state.activePlayer);
  const [chargeTargetIds, setChargeTargetIds] = useState<string[]>([]);
  const [chargeReroll, setChargeReroll] = useState(false);
  // Per-weapon target splits (04.02): weapon key → target unit id; cleared when the volley fires.
  const [splitSel, setSplitSel] = useState<Record<string, string>>({});
  // Weapons held back from the volley (weapon keys) — e.g. saving a One Shot Hunter-killer.
  const [holdSel, setHoldSel] = useState<string[]>([]);

  const ctx: EngineContext = useMemo(() => ({ datasheets: datasheetsById }), [datasheetsById]);
  // Only the ACTIVE player's open activations belong to this panel — an opponent's unit left
  // mid-activation must not wedge your Movement phase behind its Confirm/Cancel buttons.
  const movingUnits = units.filter((u) => u.status.moveMode && u.owner === state.activePlayer);
  const incoherentMoving = movingUnits.filter((u) => !unitCoherency(u, ctx).inCoherency);
  const coherencyOk = incoherentMoving.length === 0;
  const overlappingMoving = movingUnits.filter((u) => unitOverlaps(state, u, ctx));
  const overlapOk = overlappingMoving.length === 0;
  // Dense terrain (13.06): tanks/riders/monsters cannot cross or end on a dense (green) feature.
  const denseMoving = movingUnits.filter((u) => unitDenseViolation(u, ctx, state.layout) !== null);
  const denseOk = denseMoving.length === 0;
  const arrivable = reservesArrivable(state);
  const nameOfUnit = (id: string) => datasheetsById.get(units.find((u) => u.id === id)?.datasheetId ?? '')?.name ?? id;

  const attacker = units.find((u) => u.id === attackerId);
  // Weapons the (possibly merged) attacker can fire — only those somebody alive actually carries,
  // and only the type the current phase resolves (ranged in Shooting, melee in Fight) in a match.
  const weapons = useMemo(() => {
    if (!attacker) return [];
    let ws = availableUnitWeapons(attacker, ctx);
    if (inMatch && phase === 'Shooting') ws = ws.filter((w) => w.weapon.type !== 'melee');
    if (inMatch && phase === 'Fight') ws = ws.filter((w) => w.weapon.type === 'melee');
    return ws;
  }, [attacker, ctx, inMatch, phase]);

  const nameOf = (id: string) => {
    const u = units.find((x) => x.id === id);
    const ds = u ? datasheetsById.get(u.datasheetId) : undefined;
    return ds?.name ?? id;
  };
  const aliveOf = (id: string) => units.find((x) => x.id === id)?.models.filter((m) => m.alive).length ?? 0;

  // Phase-aware eligibility: which of my units may act, and which enemies they may target.
  const myUnits = units.filter((u) => u.owner === state.activePlayer && !u.inReserves && u.models.some((m) => m.alive));
  const eligibleAttackers = useMemo(() => {
    if (phase === 'Shooting') return myUnits.filter((u) => eligibleToShoot(u, state, ctx).eligible);
    if (phase === 'Charge') return myUnits.filter((u) => eligibleToCharge(u, state, ctx).eligible);
    // Fight: any engaged unit (keep just-fought ones selectable so they can still Consolidate).
    if (phase === 'Fight') return myUnits.filter((u) => engagedEnemies(u, state, ctx).length > 0);
    return myUnits;
  }, [units, phase, state.activePlayer]);
  // In a match, don't silently fall back to ALL units when none are eligible — the label says
  // "(0 eligible)" and the list should agree with it. The sandbox keeps the permissive list.
  const combatPhase = phase === 'Shooting' || phase === 'Charge' || phase === 'Fight';
  const attackerOptions = eligibleAttackers.length
    ? eligibleAttackers
    : inMatch && combatPhase
      ? []
      : myUnits;

  const attackerEligibility: Eligibility | null = !attacker ? null
    : phase === 'Shooting' ? eligibleToShoot(attacker, state, ctx)
    : phase === 'Fight' ? eligibleToFight(attacker, state, ctx)
    : phase === 'Charge' ? eligibleToCharge(attacker, state, ctx) : null;

  const validTargets = useMemo(() => {
    if (!attacker) return [];
    if (phase === 'Shooting') return validUnitShootingTargets(attacker, state, ctx);
    if (phase === 'Charge') return chargeTargets(attacker, state, ctx);
    if (phase === 'Fight') return engagedEnemies(attacker, state, ctx);
    return units.filter((u) => u.owner !== attacker.owner && !u.inReserves && u.models.some((m) => m.alive));
  }, [attacker, phase, units]);

  // The fire plan when the whole unit shoots (every model fires its weapons, Pistol rule applied).
  const firePlan = useMemo(
    () => (attacker && phase === 'Shooting' ? planUnitShooting(state, attacker, ctx) : null),
    [attacker, phase, units],
  );
  // The fight plan when the whole unit fights (per-model weapon picks + Extra Attacks).
  const fightPlan = useMemo(
    () => (attacker && phase === 'Fight' && inMatch ? planUnitFight(state, attacker, ctx, targetId || undefined) : null),
    [attacker, phase, units, targetId, inMatch],
  );

  // Tell the board which units are attacker/target so it can highlight them.
  useEffect(() => {
    onTargeting?.({ attackerUnitId: attackerId || undefined, targetUnitId: targetId || undefined });
  }, [attackerId, targetId, onTargeting]);

  const fightOrder = useMemo(() => (phase === 'Fight' ? fightActivationOrder(state, ctx) : []), [phase, units]);

  // Command phase: Officers of the active player that can issue Orders, and the active detachment.
  // unitIsOfficer sees through the Leader merge (an attached Yarrick still issues Orders).
  const activeDetachment = detachmentBySide?.[state.activePlayer] ?? '';
  const officers = useMemo(
    () => (phase === 'Command' ? myUnits.filter((u) => unitIsOfficer(u, ctx)) : []),
    [phase, units, state.activePlayer],
  );
  const enemiesOnBoard = units.filter((u) => u.owner !== state.activePlayer && !u.inReserves && u.models.some((m) => m.alive));

  /** Issue an Order; Grizzled Company also grants re-roll Hit 1s while a unit is under an Order. */
  function issueOrder(unitId: string, effectId: string) {
    dispatch({ type: 'IssueOrder', unitId, effectId });
    if (armyHasDetachment(activeDetachment, 'Grizzled Company')) dispatch({ type: 'IssueOrder', unitId, effectId: 'reroll_hits_1' });
  }

  const offensiveEffects = Object.values(EFFECT_REGISTRY).filter((e) => e.side === 'attacker');
  const defensiveEffects = Object.values(EFFECT_REGISTRY).filter((e) => e.side === 'defender');

  // Stratagems usable by `stratSide` right now (Core + that side's detachment, phase/turn-gated).
  const strats = useMemo(
    () =>
      usableStratagems(stratagems, {
        phase,
        isYourTurn: stratSide === state.activePlayer,
        detachment: detachmentBySide?.[stratSide],
        battleType: state.battleType,
      }),
    [phase, stratSide, state.activePlayer, detachmentBySide, state.battleType],
  );

  return (
    <section className="game-panel">
      <h2>Game</h2>

      {/* Turn / phase / round */}
      <div className="turnbar">
        <span className="dot" style={{ background: OWNER_COLOR[state.activePlayer].fill }} />
        <strong>Round {state.round}</strong> · {state.activePlayer} · <em>{state.phase}</em>
        {state.ended && <span className="badge">ended</span>}
      </div>
      {state.ended && (
        <p className="ok">
          Final score — player {state.score.player} : {state.score.ai} ai ·{' '}
          {state.score.player === state.score.ai
            ? 'draw'
            : `${state.score.player > state.score.ai ? 'player' : 'ai'} wins`}
        </p>
      )}
      <div className="btnrow">
        <button onClick={() => dispatch({ type: 'AdvancePhase' })} disabled={state.ended}>Next phase →</button>
        <button
          onClick={() => dispatch({ type: 'RunCommandPhase' })}
          disabled={state.ended || (inMatch && (state.phase !== 'Command' || !!state.commandRun))}
          title={
            inMatch && state.phase !== 'Command' ? 'Only during the Command phase'
            : inMatch && state.commandRun ? 'Already run this turn'
            : 'Gain CP, take Battle-shock tests, score Primary'
          }
        >
          Run Command{inMatch && state.commandRun ? ' ✓' : ''}
        </button>
      </div>
      {/* Switching the first player resets the sequencer — sandbox/debug only. */}
      {!inMatch && (
        <div className="btnrow">
          <span className="muted">First turn:</span>
          {(['player', 'ai'] as const).map((s) => (
            <button key={s} className={state.firstPlayer === s ? 'seg-on' : ''} onClick={() => dispatch({ type: 'SetFirstPlayer', side: s })}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Scoreboard */}
      <div className="scoreboard">
        {(['player', 'ai'] as const).map((s) => (
          <div key={s} className="score-cell">
            <span className="dot" style={{ background: OWNER_COLOR[s].fill }} /> {s}
            <div className="vp">
              {state.score[s]} VP
              {state.secondaries && (
                <span className="muted"> ({state.score[s] - state.secondaries[s].vp}P+{state.secondaries[s].vp}S)</span>
              )}
            </div>
            <div className="cp">{state.cp[s]} CP</div>
          </div>
        ))}
      </div>

      {/* Combat Patrol missions: each side plays its patrol's own card. */}
      {inMatch && state.cpMissions && (
        <div className="phase-block">
          <h3>Combat Patrol Missions</h3>
          {(['player', 'ai'] as const).map((s) => {
            const def = CP_MISSIONS[state.cpMissions!.missionId[s]];
            const events = state.cpMissions!.events.filter((e) => e.side === s);
            return (
              <div key={s} className="order-officer">
                <strong style={{ color: OWNER_COLOR[s].fill }}>{s}</strong>{' '}
                <details style={{ display: 'inline-block' }}>
                  <summary>
                    <strong>{def?.name ?? '(unknown mission)'}</strong>
                    {def?.captured === 'partial' && <span className="warn"> · ⚠ partially captured</span>}
                    {def?.captured === 'none' && <span className="warn"> · ✖ card not captured (scores nothing)</span>}
                    <span className="muted"> · {state.cpMissions!.vp[s]} mission VP</span>
                  </summary>
                  <p className="hint">{def?.text}</p>
                  {def?.note && <p className="muted">{def.note}</p>}
                  {events.length > 0 && (
                    <ul className="hint">
                      {events.slice(-6).map((e, i) => (
                        <li key={i}>R{e.round}: +{e.vp} — {e.label}</li>
                      ))}
                    </ul>
                  )}
                </details>
              </div>
            );
          })}
          {(state.cpMissions.sanctified ?? []).length > 0 && (
            <p className="muted">
              Sanctified: {(state.cpMissions.sanctified ?? []).map((s) => `objective ${s.idx + 1} (${s.side})`).join(', ')}
            </p>
          )}
          {(state.cpMissions.sanctifying ?? []).length > 0 && (
            <p className="muted">
              Sanctifying: {(state.cpMissions.sanctifying ?? []).map((s) => `objective ${s.objectiveIdx + 1} (${s.side})`).join(', ')}
            </p>
          )}
          {state.stage === 'battle' && state.phase === 'Shooting' &&
            state.cpMissions.missionId[state.activePlayer] === 'purification' && (
              <SanctifyBlock state={state} dispatch={dispatch} datasheetsById={datasheetsById} />
            )}
        </div>
      )}

      {/* 11e Primary Missions: each side's disposition, mission and primary VP. */}
      {inMatch && state.missions && (
        <div className="phase-block">
          <h3>Primary Missions</h3>
          {(['player', 'ai'] as const).map((s) => {
            const ms = state.missions!.perSide[s];
            return (
              <div key={s} className="order-officer">
                <strong style={{ color: OWNER_COLOR[s].fill }}>{s}</strong>{' '}
                <span>{dispositionName(ms.disposition)} → <strong>{MISSION_NAMES[ms.mission] ?? ms.mission}</strong></span>
                <span className="muted"> · {ms.primaryVp}/{PRIMARY_CAP} primary VP</span>
              </div>
            );
          })}
          {(state.missions.markers.length > 0) && (
            <p className="muted">Operation markers on the field: {state.missions.markers.length}</p>
          )}
        </div>
      )}

      {/* 11e Objective Actions — started in your Shooting phase, complete at end of turn. */}
      {inMatch && state.missions && state.stage === 'battle' && state.phase === 'Shooting' && (
        <ActionsBlock state={state} dispatch={dispatch} datasheetsById={datasheetsById} ctx={ctx} />
      )}

      {/* Tactical / Fixed (Secondary) Missions — drawn or chosen, scored at turn end. */}
      {inMatch && state.secondaries && state.stage === 'battle' && (
        <div className="phase-block">
          <h3>Secondary Missions</h3>
          {(['player', 'ai'] as const).map((s) => {
            const sec = state.secondaries![s];
            return (
              <div key={s} className="order-officer">
                <strong style={{ color: OWNER_COLOR[s].fill }}>{s}</strong>{' '}
                <span className="muted">
                  {sec.vp}/45 secondary VP · {sec.mode === 'fixed' ? 'FIXED missions' : `${sec.deck.length} in deck`}
                </span>
                {sec.mode === 'fixed' ? (
                  (sec.fixed ?? []).map((c) => {
                    const card = secondaryCard(c.id);
                    return (
                      <SecondaryCardRow
                        key={c.id}
                        name={card?.name ?? c.id}
                        desc={card?.desc}
                        meta={`fixed · ${sec.fixedVp?.[c.id] ?? 0}/20 VP`}
                      />
                    );
                  })
                ) : sec.hand.length === 0 ? (
                  <div className="muted">— no active missions (drawn when the Command phase runs)</div>
                ) : (
                  sec.hand.map((c) => {
                    const card = secondaryCard(c.id);
                    return (
                      <SecondaryCardRow
                        key={c.id}
                        name={card?.name ?? c.id}
                        desc={card?.desc}
                        meta={`drawn R${c.drawn}`}
                        action={
                          s === state.activePlayer ? (
                            <button onClick={() => dispatch({ type: 'DiscardSecondary', side: s, cardId: c.id })}>discard</button>
                          ) : undefined
                        }
                      />
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Command phase — Orders (Voice of Command) */}
      {phase === 'Command' && officers.length > 0 && (
        <div className="phase-block">
          <h3>Orders {armyHasDetachment(activeDetachment, 'Grizzled Company') ? '· Ruthless Discipline (+1 order, re-roll Hit 1s)' : ''}</h3>
          {officers.map((off) => {
            const targets = orderableUnits(off, state, ctx, activeDetachment);
            return (
              <div key={off.id} className="order-officer">
                <strong>{nameOf(off.id)}</strong>
                {targets.length === 0 ? (
                  <span className="muted"> — no orderable units in range</span>
                ) : (
                  targets.map((t) => {
                    // Absolutist Principles targets (ABHUMAN, no REGIMENT) only receive Take Aim!.
                    const abhumanOnly = abhumanOnlyOrderTarget(datasheetsById.get(t.datasheetId));
                    const options = ordersAvailableTo(off).filter((o) => !abhumanOnly || o.id === 'take_aim');
                    return (
                      <div key={t.id} className="order-row">
                        <span>{nameOf(t.id)}{(t.status.activeEffects ?? []).some((e) => e.startsWith('order:')) ? ' ✓' : ''}</span>
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) issueOrder(t.id, e.target.value); }}
                        >
                          <option value="">— issue order —</option>
                          {options.map((o) => <option key={o.id} value={o.effectId} title={o.desc}>{o.name} — {o.desc}</option>)}
                        </select>
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Command phase — Imperialis Fleet "At all Costs" */}
      {phase === 'Command' && armyHasDetachment(activeDetachment, 'Imperialis Fleet') && (
        <div className="phase-block">
          <h3>At all Costs</h3>
          <div className="order-row">
            <span>Eliminate (mark enemy: +1 to Hit it)</span>
            <select value="" onChange={(e) => { if (e.target.value) dispatch({ type: 'UseStratagem', name: 'Eliminate At All Costs', side: state.activePlayer, cost: 0, targetUnitId: e.target.value, effectId: 'mark_eliminate' }); }}>
              <option value="">— enemy unit —</option>
              {enemiesOnBoard.map((u) => <option key={u.id} value={u.id}>{nameOf(u.id)}</option>)}
            </select>
          </div>
          <div className="order-row">
            <span>Acquire (your unit on an objective: 5++, +1 OC/Ld)</span>
            <select value="" onChange={(e) => { if (e.target.value) dispatch({ type: 'UseStratagem', name: 'Acquire At All Costs', side: state.activePlayer, cost: 0, targetUnitId: e.target.value, effectId: 'acquire_buff' }); }}>
              <option value="">— your unit —</option>
              {myUnits.map((u) => <option key={u.id} value={u.id}>{nameOf(u.id)}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Command phase — Battle-shock dice */}
      {state.phase === 'Command' && state.lastBattleShock && state.lastBattleShock.length > 0 && (
        <div className="phase-block">
          <h3>Battle-shock</h3>
          {state.lastBattleShock.map((r) => (
            <div key={r.unitId} className="bs-row">
              <Die value={r.roll[0]} size={24} />
              <Die value={r.roll[1]} size={24} />
              <span className={r.passed ? 'ok' : 'coh-bad'}>
                {r.unitName}: {r.total} vs Ld {r.ld}+ → {r.passed ? 'passed' : 'BATTLE-SHOCKED'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Movement phase */}
      {state.phase === 'Movement' && (
        <div className="phase-block">
          <h3>Movement</h3>
          {movingUnits.length === 0 ? (
            <>
              {(() => {
                const hasMoved = (u: UnitInstance | undefined) =>
                  !!u && !!(u.status.moved || u.status.advanced || u.status.fellBack || u.status.remainedStationary);
                const selected = selectedUnitIds.map((id) => units.find((u) => u.id === id));
                const movableIds = selectedUnitIds.filter((_id, i) => !(inMatch && hasMoved(selected[i])));
                const movedNames = selectedUnitIds.filter((_id, i) => inMatch && hasMoved(selected[i])).map(nameOfUnit);
                return (
                  <>
                    <p className="muted">
                      {selectedUnitIds.length === 0
                        ? 'Drag a box on the board to select your units.'
                        : `${selectedUnitIds.length} unit(s) selected: ${selectedUnitIds.map(nameOfUnit).join(', ')}`}
                    </p>
                    {movedNames.length > 0 && (
                      <p className="hint">Already moved this turn: {movedNames.join(', ')}</p>
                    )}
                    <div className="btnrow">
                      {MOVE_MODES.map(({ mode, label }) => (
                        <button
                          key={mode}
                          disabled={movableIds.length === 0}
                          title={selectedUnitIds.length > 0 && movableIds.length === 0 ? 'Every selected unit has already moved this turn' : ''}
                          onClick={() => dispatch({ type: 'BeginMove', unitIds: movableIds, mode })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </>
                );
              })()}
            </>
          ) : (
            <>
              <p className={coherencyOk && overlapOk && denseOk ? 'muted' : 'coh-bad'}>
                {movingUnits.length} unit(s) moving ·{' '}
                {!coherencyOk
                  ? `⚠ out of coherency: ${incoherentMoving.map((u) => nameOfUnit(u.id)).join(', ')}`
                  : !overlapOk
                    ? `⚠ on top of another model: ${overlappingMoving.map((u) => nameOfUnit(u.id)).join(', ')}`
                    : !denseOk
                      ? `⚠ in dense terrain (tanks/riders cannot cross green ruins): ${denseMoving.map((u) => nameOfUnit(u.id)).join(', ')}`
                      : 'in coherency ✓'}
              </p>
              <div className="btnrow">
                <button
                  className="primary"
                  disabled={!coherencyOk || !overlapOk || !denseOk}
                  title={
                    !coherencyOk
                      ? 'A unit is out of coherency — bring its models back together first'
                      : !overlapOk
                        ? 'Bases cannot end a move on top of another model — move them clear first'
                        : !denseOk
                          ? 'Only Infantry, Beasts and Swarms move through dense (green) terrain — go around it'
                          : ''
                  }
                  onClick={() => { dispatch({ type: 'EndMove', unitIds: movingUnits.map((u) => u.id) }); setSelectedUnitIds?.([]); }}
                >
                  ✓ Confirm move
                </button>
                <button onClick={() => { dispatch({ type: 'CancelMove', unitIds: movingUnits.map((u) => u.id) }); }}>
                  Cancel
                </button>
                {(() => {
                  // Command Re-roll on a fresh Advance roll (before any model has moved).
                  const adv = movingUnits.find(
                    (u) =>
                      u.status.moveMode === 'advance' &&
                      !u.models.some((m) => m.alive && m.moveStart && (m.pos.x !== m.moveStart.x || m.pos.y !== m.moveStart.y)),
                  );
                  if (!adv || state.cp[adv.owner] < 1) return null;
                  return (
                    <button
                      title="Command Re-roll (1 CP): re-roll the Advance D6 before moving"
                      onClick={() => dispatch({ type: 'RerollAdvance', unitId: adv.id, side: adv.owner })}
                    >
                      ↻ Re-roll Advance (1 CP)
                    </button>
                  );
                })()}
              </div>
            </>
          )}

          {arrivable.length > 0 && (
            <div className="arrivals">
              <h4>Reserves (Deep Strike)</h4>
              {arrivable.map((u) => (
                <button key={u.id} className="arrive" onClick={() => onBeginArrival?.(u.id)}>
                  ⤓ Arrive {nameOfUnit(u.id)}
                </button>
              ))}
            </div>
          )}

          {/* Transports (11e, 18): disembark passengers / embark a unit that just moved. */}
          {(() => {
            const embarked = units.filter(
              (u) => u.owner === state.activePlayer && u.embarkedIn && u.models.some((m) => m.alive),
            );
            const embarkable = units.filter((u) => {
              if (u.owner !== state.activePlayer || u.inReserves || !u.models.some((m) => m.alive)) return false;
              if (!(u.status.moved || u.status.advanced || u.status.fellBack) || u.status.setUpThisTurn) return false;
              return embarkOptions(state, u, ctx).some((t) => gapBetween(u, t, ctx) <= 3);
            });
            if (embarked.length === 0 && embarkable.length === 0) return null;
            return (
              <div className="arrivals">
                <h4>Transports</h4>
                {embarked.map((u) => {
                  const bus = units.find((t) => t.id === u.embarkedIn);
                  const mode = bus ? disembarkMode(u, bus) : null;
                  return (
                    <button
                      key={u.id}
                      className="arrive"
                      disabled={!mode}
                      title={mode ? '' : 'The transport advanced/fell back this phase (or the unit embarked this turn)'}
                      onClick={() => onBeginDisembark?.(u.id)}
                    >
                      ⇤ Disembark {nameOfUnit(u.id)} (from {bus ? nameOfUnit(bus.id) : '?'})
                    </button>
                  );
                })}
                {embarkable.map((u) =>
                  embarkOptions(state, u, ctx)
                    .filter((t) => gapBetween(u, t, ctx) <= 3)
                    .map((t) => (
                      <button
                        key={`${u.id}:${t.id}`}
                        className="arrive"
                        onClick={() => dispatch({ type: 'EmbarkUnit', unitId: u.id, transportId: t.id })}
                      >
                        ⇥ Embark {nameOfUnit(u.id)} → {nameOfUnit(t.id)}
                      </button>
                    )),
                )}
              </div>
            );
          })()}
          {state.round < 2 && state.units.some((u) => u.inReserves && u.owner === state.activePlayer) && (
            <p className="hint">Reserves arrive from battle round 2.</p>
          )}
        </div>
      )}

      {/* Fight phase — activation order + pile-in / consolidate */}
      {phase === 'Fight' && (
        <div className="phase-block">
          <h3>Fight — activation order</h3>
          {fightOrder.length === 0 ? (
            <p className="muted">No units are in Engagement Range.</p>
          ) : (
            <ol className="fight-order">
              {fightOrder.map((u) => (
                <li key={u.id} className={u.status.hasFought ? 'fought' : ''}>
                  <span className="dot" style={{ background: OWNER_COLOR[u.owner].fill }} />
                  {nameOf(u.id)}{u.status.charged ? ' · Fights First' : ''}{u.status.hasFought ? ' ✓' : ''}
                </li>
              ))}
            </ol>
          )}
          <p className="hint">Pick the fighting unit as Attacker below · Pile In → resolve melee → Consolidate.</p>
          <div className="btnrow">
            <button disabled={!attackerId} onClick={() => dispatch({ type: 'FightMove', unitId: attackerId, mode: 'pile_in' })}>Pile In 3"</button>
            <button disabled={!attackerId} onClick={() => dispatch({ type: 'FightMove', unitId: attackerId, mode: 'consolidate' })}>Consolidate 3"</button>
          </div>
        </div>
      )}

      {/* Attack / charge */}
      <h3>Resolve combat</h3>
      <label className="field">
        <span>Attacker {combatPhase ? `(${eligibleAttackers.length} eligible)` : ''}</span>
        <select value={attackerId} onChange={(e) => { setAttackerId(e.target.value); setWeaponSel(''); setTargetId(''); setChargeTargetIds([]); setSplitSel({}); setHoldSel([]); }}>
          <option value="">{attackerOptions.length === 0 && combatPhase ? '— no eligible units —' : '— pick a unit —'}</option>
          {attackerOptions.map((u) => (
            <option key={u.id} value={u.id}>{nameOf(u.id)} ({u.owner}, ×{aliveOf(u.id)})</option>
          ))}
        </select>
      </label>
      {attackerEligibility && !attackerEligibility.eligible && (
        <p className="coh-bad">⚠ {attackerEligibility.reason}</p>
      )}
      {/* Shooting and (in a match) fighting are unit-level: every model uses its equipped
          weapons, so there is no weapon picker — the panel shows the plan instead. */}
      {phase !== 'Shooting' && !(inMatch && phase === 'Fight') && (
        <label className="field">
          <span>Weapon</span>
          <select value={weaponSel} onChange={(e) => { setWeaponSel(e.target.value); setTargetId(''); }} disabled={!attacker}>
            <option value="">— pick a weapon —</option>
            {weapons.map((w) => (
              <option key={`${w.sourceDsId}|${w.weapon.name}`} value={`${w.sourceDsId}|${w.weapon.name}`}>
                {w.weapon.name} ({w.weapon.type === 'melee' ? 'melee' : `${w.weapon.range}"`}) ×{w.carriers}
                {attacker && w.sourceDsId !== attacker.datasheetId ? ` — ${datasheetsById.get(w.sourceDsId)?.name ?? w.sourceDsId}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {phase === 'Shooting' && attacker && firePlan && (
        <div className="fire-plan">
          <span className="muted">
            Will fire ({firePlan.fire.length} weapon{firePlan.fire.length === 1 ? '' : 's'}, resolved sequentially
            {validTargets.length > 1 ? ' — each weapon may pick its own target' : ''}):
          </span>
          {firePlan.fire.length === 0 ? (
            <p className="coh-bad">No ranged weapons can fire.</p>
          ) : (
            <ul>
              {firePlan.fire.map((w) => {
                const key = `${w.sourceDsId}|${w.weapon.name}`;
                const held = holdSel.includes(key);
                return (
                  <li key={key} className={held ? 'weapon-held' : undefined}>
                    {/* Hold a weapon out of the volley (e.g. save a One Shot Hunter-killer missile). */}
                    <label className="hold-toggle" title={held ? 'Held back — will not fire this volley' : 'Untick to hold this weapon back (it stays available for a later volley)'}>
                      <input
                        type="checkbox"
                        checked={!held}
                        onChange={(e) =>
                          setHoldSel((prev) => (e.target.checked ? prev.filter((k) => k !== key) : [...prev, key]))
                        }
                      />
                    </label>
                    {w.carriers}× {w.weapon.name} ({w.weapon.range}", A{w.weapon.attacks})
                    {held ? ' — held' : ''}
                    {w.sourceDsId !== attacker.datasheetId && !w.viaFiringDeck ? ` — ${datasheetsById.get(w.sourceDsId)?.name ?? w.sourceDsId}` : ''}
                    {w.viaFiringDeck ? ' — Firing Deck' : ''}
                    {/* Per-weapon target split (04.02): defaults to the main target below. */}
                    {validTargets.length > 1 && (
                      <select
                        value={splitSel[key] ?? ''}
                        onChange={(e) =>
                          setSplitSel((prev) => {
                            const next = { ...prev };
                            if (e.target.value) next[key] = e.target.value;
                            else delete next[key];
                            return next;
                          })
                        }
                        title="Send this weapon at a different target than the rest of the unit"
                      >
                        <option value="">→ main target</option>
                        {validTargets.map((t) => (
                          <option key={t.id} value={t.id}>→ {nameOf(t.id)}</option>
                        ))}
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {firePlan.notes.map((n, i) => <p key={i} className="hint">{n}</p>)}
        </div>
      )}
      {inMatch && phase === 'Fight' && attacker && fightPlan && (
        <div className="fire-plan">
          <span className="muted">Will fight ({fightPlan.fire.length} weapon{fightPlan.fire.length === 1 ? '' : 's'}, each model swings one melee weapon + Extra Attacks):</span>
          {fightPlan.fire.length === 0 ? (
            <p className="coh-bad">No melee weapons.</p>
          ) : (
            <ul>
              {fightPlan.fire.map((w) => (
                <li key={`${w.sourceDsId}|${w.weapon.name}`}>
                  {w.carriers}× {w.weapon.name} (A{w.weapon.attacks})
                  {w.sourceDsId !== attacker.datasheetId ? ` — ${datasheetsById.get(w.sourceDsId)?.name ?? w.sourceDsId}` : ''}
                </li>
              ))}
            </ul>
          )}
          {fightPlan.notes.map((n, i) => <p key={i} className="hint">{n}</p>)}
        </div>
      )}
      <label className="field">
        <span>Target {attacker ? `(${validTargets.length} valid)` : ''}</span>
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={!attacker}>
          <option value="">— pick a target —</option>
          {validTargets.map((u) => (
            <option key={u.id} value={u.id}>{nameOf(u.id)} (×{aliveOf(u.id)})</option>
          ))}
        </select>
      </label>
      {phase === 'Charge' && attacker && (
        <div className="charge-targets">
          <span className="muted">Declare charge targets (within 12"):</span>
          {validTargets.length === 0 ? (
            <p className="muted">No units within 12".</p>
          ) : (
            validTargets.map((u) => (
              <label key={u.id} className="charge-target">
                <input
                  type="checkbox"
                  checked={chargeTargetIds.includes(u.id)}
                  onChange={(e) => setChargeTargetIds((prev) => (e.target.checked ? [...prev, u.id] : prev.filter((id) => id !== u.id)))}
                />
                {nameOf(u.id)} (×{aliveOf(u.id)})
              </label>
            ))
          )}
        </div>
      )}
      <div className="btnrow">
        {phase === 'Shooting' ? (
          <button
            className="primary"
            disabled={
              !attackerId || !targetId || !firePlan || firePlan.fire.length === 0 ||
              firePlan.fire.every((w) => holdSel.includes(`${w.sourceDsId}|${w.weapon.name}`))
            }
            title={
              firePlan && firePlan.fire.length > 0 && firePlan.fire.every((w) => holdSel.includes(`${w.sourceDsId}|${w.weapon.name}`))
                ? 'Every weapon is held back — tick at least one to fire'
                : ''
            }
            onClick={() => {
              const splitTargets = Object.fromEntries(
                Object.entries(splitSel).filter(([, v]) => v && v !== targetId),
              );
              const holdWeapons = holdSel.filter((k) =>
                firePlan!.fire.some((w) => `${w.sourceDsId}|${w.weapon.name}` === k),
              );
              dispatch({
                type: 'ShootUnit', attackerUnitId: attackerId, targetUnitId: targetId,
                ...(Object.keys(splitTargets).length ? { splitTargets } : {}),
                ...(holdWeapons.length ? { holdWeapons } : {}),
              });
              setSplitSel({});
              setHoldSel([]);
            }}
          >
            🔫 Shoot{holdSel.length ? ' — selected weapons' : ' — all weapons'}
          </button>
        ) : inMatch && phase === 'Fight' ? (
          <button
            className="primary"
            disabled={!attackerId || !targetId || !fightPlan || fightPlan.fire.length === 0}
            onClick={() => dispatch({ type: 'FightUnit', attackerUnitId: attackerId, targetUnitId: targetId })}
          >
            ⚔ Fight — all weapons
          </button>
        ) : (
          <button
            disabled={!attackerId || !targetId || !weaponName}
            onClick={() => dispatch({ type: 'Attack', attackerUnitId: attackerId, targetUnitId: targetId, weaponName, weaponSourceDsId })}
          >
            Resolve attack
          </button>
        )}
        <button
          disabled={!attackerId || (phase === 'Charge' ? chargeTargetIds.length === 0 : !targetId)}
          onClick={() => dispatch({ type: 'Charge', chargerUnitId: attackerId, targetUnitIds: phase === 'Charge' ? chargeTargetIds : (targetId ? [targetId] : []), commandReroll: chargeReroll })}
        >
          Charge (2D6){chargeTargetIds.length > 1 ? ` ×${chargeTargetIds.length}` : ''}
        </button>
        {inMatch && phase === 'Charge' && (
          <label className="field" title="If the charge roll fails, spend 1 CP on the Core Stratagem Command Re-roll (once per phase)">
            <span>
              <input type="checkbox" checked={chargeReroll} onChange={(e) => setChargeReroll(e.target.checked)} /> Command
              Re-roll on fail (1 CP)
            </span>
          </label>
        )}
      </div>

      {/* Manual effect applicator — a debug tool: applies any effect with no phase/CP logic. */}
      <h3>Manual effects (debug)</h3>
      <label className="field">
        <span>Effect</span>
        <select value={effectId} onChange={(e) => setEffectId(e.target.value)}>
          <optgroup label="Orders / buffs (on attacker)">
            {offensiveEffects.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </optgroup>
          <optgroup label="Defensive (on target)">
            {defensiveEffects.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </optgroup>
        </select>
      </label>
      <div className="btnrow">
        <button
          disabled={!attackerId}
          onClick={() => dispatch({ type: 'IssueOrder', unitId: attackerId, effectId })}
        >
          Issue to attacker
        </button>
        <button
          disabled={!targetId || !attacker}
          onClick={() => dispatch({ type: 'UseStratagem', name: EFFECT_REGISTRY[effectId]?.name ?? effectId, side: attacker!.owner === 'player' ? 'ai' : 'player', cost: 1, targetUnitId: targetId, effectId })}
        >
          Stratagem on target (1 CP)
        </button>
      </div>

      {/* Stratagems (Core + detachment), phase/turn filtered */}
      <h3>Stratagems</h3>
      <div className="btnrow">
        <span className="muted">For:</span>
        {(['player', 'ai'] as const).map((s) => (
          <button key={s} className={stratSide === s ? 'seg-on' : ''} onClick={() => setStratSide(s)}>
            {s}{s === state.activePlayer ? ' · turn' : ''}
          </button>
        ))}
        <span className="muted">{state.cp[stratSide]} CP</span>
      </div>
      <div className="strat-list">
        {strats.length === 0 ? (
          <p className="muted">No stratagems usable in the {phase} phase for {stratSide}.</p>
        ) : (
          strats
            // Engine-bound Core stratagems resolve through their own controls (the Charge
            // block's re-roll checkbox and the "Stratagem plays" block below) — hide the
            // generic spend-CP button so they can't be paid for twice.
            .filter((st) => !ENGINE_BOUND_STRATS.has(st.id))
            .map((st) => {
            const afford = state.cp[stratSide] >= st.cp;
            // Combat Patrol stratagems that need their own picks (an objective / a transport /
            // one of your own units for Determined to the Last).
            if (st.effectId === 'cp:secure_objective' || st.effectId === 'cp:swift_embark' || st.effectId === 'cp:fights_on_death') {
              return (
                <CpSpecialStrat key={st.id} st={st} side={stratSide} state={state} dispatch={dispatch} nameOfUnit={nameOfUnit} datasheetsById={datasheetsById} />
              );
            }
            return (
              <button
                key={st.id}
                className="strat"
                disabled={!afford}
                title={st.text}
                onClick={() => dispatch({ type: 'UseStratagem', name: st.name, side: stratSide, cost: st.cp, stratagemId: st.id, ...(st.effectId && targetId ? { targetUnitId: targetId, effectId: st.effectId } : {}) })}
              >
                <span className="strat-cp">{st.cp}</span>
                <span className="strat-name">{st.name}</span>
                <span className={`strat-det${st.detachment ? '' : ' core'}`}>{st.detachment ?? 'Core'}</span>
              </button>
            );
          })
        )}
      </div>

      <StratagemPlays state={state} dispatch={dispatch} ctx={ctx} nameOfUnit={nameOfUnit} onBeginArrival={onBeginArrival} />

      {state.battleType === 'combat_patrol' && (
        <CpUnitAbilities state={state} dispatch={dispatch} nameOfUnit={nameOfUnit} datasheetsById={datasheetsById} />
      )}

      {/* Dice log */}
      <h3>Dice log</h3>
      <div className="dicelog">
        {state.log.length === 0 ? (
          <p className="muted">No events yet. Resolve an attack or run the Command phase.</p>
        ) : (
          state.log.slice(-40).map((line, i) => (
            <div key={i} className={line.startsWith('  ') ? 'log-sub' : line.startsWith('—') ? 'log-head' : 'log-line'}>
              {line.trim()}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/** 11e Objective Actions: pick a unit + action + target; validity comes from missionflow. */
/** Combat Patrol stratagems needing their own picks: Inquisitorial Mandate / Rapid Acquisition
 *  (secure an objective the unit controls) and Swift Embarkation (embark within a transport).
 *  Validity is enforced by the reducer; the pickers just gather the choices. */
function CpSpecialStrat({
  st,
  side,
  state,
  dispatch,
  nameOfUnit,
  datasheetsById,
}: {
  st: { id: string; name: string; cp: number; effectId?: string; text?: string };
  side: 'player' | 'ai';
  state: GameState;
  dispatch: (i: Intent) => void;
  nameOfUnit: (id: string) => string;
  datasheetsById: Map<string, Datasheet>;
}) {
  const [unitId, setUnitId] = useState('');
  const [pick, setPick] = useState('');
  const mine = state.units.filter((u) => u.owner === side && !u.inReserves && u.models.some((m) => m.alive));
  const secure = st.effectId === 'cp:secure_objective';
  const unitOnly = st.effectId === 'cp:fights_on_death';
  const points = objectivePoints(state.layout);
  const secured = state.cpMissions?.securedBy ?? [];
  const transports = mine.filter((u) =>
    datasheetsById.get(u.datasheetId)?.keywords.some((k) => k.toUpperCase() === 'TRANSPORT'),
  );
  return (
    <div className="btnrow" title={st.text}>
      <span className="strat-cp">{st.cp}</span>
      <span className="strat-name">{st.name}</span>
      <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
        <option value="">— unit —</option>
        {mine.map((u) => (
          <option key={u.id} value={u.id}>{nameOfUnit(u.id)}</option>
        ))}
      </select>
      {!unitOnly && (
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">{secure ? '— objective —' : '— transport —'}</option>
          {secure
            ? points.map((o, i) =>
                secured[i] === side ? null : (
                  <option key={i} value={i}>objective {i + 1} ({o.kind})</option>
                ),
              )
            : transports.map((u) => (
                <option key={u.id} value={u.id}>{nameOfUnit(u.id)}</option>
              ))}
        </select>
      )}
      <button
        disabled={!unitId || (!unitOnly && pick === '') || state.cp[side] < st.cp}
        onClick={() => {
          dispatch({
            type: 'UseStratagem',
            name: st.name,
            side,
            cost: st.cp,
            stratagemId: st.id,
            effectId: st.effectId,
            targetUnitId: unitId,
            ...(unitOnly ? {} : secure ? { objectiveIdx: Number(pick) } : { transportId: pick }),
          });
          setUnitId('');
          setPick('');
        }}
      >
        Use
      </button>
    </div>
  );
}

/** One Combat Patrol ability play: a button, optionally with a target/objective picker. The
 *  reducer enforces the real legality — pickers just gather the choice. */
function CpAbilityRow({
  label,
  needsPick,
  options,
  onUse,
  hint,
}: {
  label: string;
  needsPick?: boolean;
  options?: { value: string; text: string }[];
  onUse: (pick: string) => void;
  hint?: string;
}) {
  const [pick, setPick] = useState('');
  return (
    <div className="btnrow" title={hint}>
      <span className="strat-name">{label}</span>
      {needsPick && (
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">— pick —</option>
          {(options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.text}</option>
          ))}
        </select>
      )}
      <button disabled={needsPick && pick === ''} onClick={() => { onUse(pick); setPick(''); }}>
        Use
      </button>
    </div>
  );
}

/** Combat Patrol per-unit specials with a play window in the current phase: Zealot, Overkill,
 *  Bladeguard, Tome Skull, Nuncio-Aquila, Co-ordinated Eradication, Gate of Infinity, and the
 *  T'au For the Greater Good spotting step. */
function CpUnitAbilities({
  state,
  dispatch,
  nameOfUnit,
  datasheetsById,
}: {
  state: GameState;
  dispatch: (i: Intent) => void;
  nameOfUnit: (id: string) => string;
  datasheetsById: Map<string, Datasheet>;
}) {
  const turnNow = state.turnCounter ?? 0;
  const hasAb = (u: UnitInstance, prefix: string): boolean => {
    const ids = [u.datasheetId, ...(u.attachedLeaders ?? []).map((l) => l.datasheetId)];
    return ids.some((id) =>
      (datasheetsById.get(id)?.abilities ?? []).some((a) => a.name.toLowerCase().startsWith(prefix)),
    );
  };
  const onBoard = state.units.filter((u) => !u.inReserves && u.models.some((m) => m.alive));
  const enemiesOf = (side: Side) => onBoard.filter((u) => u.owner !== side);
  const points = objectivePoints(state.layout);
  const rows: ReactNode[] = [];

  for (const u of onBoard) {
    const side = u.owner;
    const used = u.status.abilityUsed ?? {};
    const name = `${nameOfUnit(u.id)} (${side})`;
    const play = (ability: string, extra?: Partial<Extract<Intent, { type: 'UseUnitAbility' }>>) =>
      dispatch({ type: 'UseUnitAbility', unitId: u.id, ability, ...extra });
    const enhSlug = [u.enhancementId, ...(u.attachedLeaders ?? []).map((l) => l.enhancementId)]
      .find((id) => id?.startsWith('cpenh:'))
      ?.split(':')[2];
    if (state.phase === 'Fight') {
      if (enhSlug === 'purifying_force' && u.status.charged && !state.cpArmyOnce?.[`${side}:purifying_force`]) {
        rows.push(
          <CpAbilityRow key={`${u.id}:pf`} label={`${name} — Purifying Force ([LETHAL HITS], once per battle)`} onUse={() => play('purifying_force')} />,
        );
      }
      if (hasAb(u, 'zealot') && used['zealot'] == null) {
        rows.push(<CpAbilityRow key={`${u.id}:z`} label={`${name} — Zealot (+3 A/S, once per battle)`} onUse={() => play('zealot')} />);
      }
      if (hasAb(u, 'overkill') && used['overkill'] == null) {
        rows.push(<CpAbilityRow key={`${u.id}:o`} label={`${name} — Overkill (AP -4, once per battle)`} onUse={() => play('overkill')} />);
      }
      if (hasAb(u, 'bladeguard') && used['bladeguard'] !== turnNow) {
        rows.push(<CpAbilityRow key={`${u.id}:bh`} label={`${name} — Bladeguard: +1 to hit`} onUse={() => play('bladeguard_hit')} />);
        rows.push(<CpAbilityRow key={`${u.id}:bs`} label={`${name} — Bladeguard: -1 to be hit`} onUse={() => play('bladeguard_stance')} />);
      }
      if (
        datasheetsById.get(u.datasheetId)?.patrol === 'crowes_sanctifiers' &&
        state.activePlayer !== side
      ) {
        rows.push(
          <CpAbilityRow key={`${u.id}:g`} label={`${name} — Gate of Infinity (to Reserves)`} hint="At the end of your opponent's Fight phase, an unengaged unit returns to Strategic Reserves." onUse={() => play('gate_of_infinity')} />,
        );
      }
    }
    if (state.phase === 'Command' && hasAb(u, 'nuncio-aquila')) {
      rows.push(
        <CpAbilityRow
          key={`${u.id}:n`}
          label={`${name} — Nuncio-Aquila`}
          hint='Select an objective within 6": enemy INFANTRY within its range make a battle-shock roll.'
          needsPick
          options={points.map((o, i) => ({ value: String(i), text: `objective ${i + 1} (${o.kind})` }))}
          onUse={(pick) => play('nuncio_aquila', { objectiveIdx: Number(pick) })}
        />,
      );
    }
    if (enhSlug === 'sanctic_slayers' && (state.phase === 'Shooting' || state.phase === 'Fight') && used['sanctic_slayers'] !== turnNow) {
      rows.push(
        <CpAbilityRow
          key={`${u.id}:ss`}
          label={`${name} — Sanctic Slayers (once per turn)`}
          hint="A friendly Inquisitor's Hand unit's attacks get +1 to wound against targets whose T is greater than or equal to the attack's S."
          needsPick
          options={onBoard
            .filter((t) => t.owner === side && datasheetsById.get(t.datasheetId)?.patrol === 'inquisitors_hand')
            .map((t) => ({ value: t.id, text: nameOfUnit(t.id) }))}
          onUse={(pick) => play('sanctic_slayers', { targetUnitId: pick })}
        />,
      );
    }
    if (hasAb(u, 'tome skull') && used['tome_skull'] == null) {
      rows.push(
        <CpAbilityRow
          key={`${u.id}:t`}
          label={`${name} — Tome Skull (once per battle)`}
          hint='Select a unit within 6": a battle-shocked friend recovers, or an enemy makes a battle-shock roll.'
          needsPick
          options={onBoard.filter((t) => t.id !== u.id).map((t) => ({ value: t.id, text: `${nameOfUnit(t.id)} (${t.owner})` }))}
          onUse={(pick) => play('tome_skull', { targetUnitId: pick })}
        />,
      );
    }
    if (state.phase === 'Shooting' && state.activePlayer === side) {
      if (
        datasheetsById.get(u.datasheetId)?.patrol === 'sudden_dawn_cadre' &&
        !state.cpArmyOnce?.[`${side}:coordinated_eradication`] &&
        !rows.some((r) => (r as { key?: string | null }).key === `erad:${side}`)
      ) {
        rows.push(
          <CpAbilityRow
            key={`erad:${side}`}
            label={`${side} — Co-ordinated Eradication (once per battle)`}
            hint="Mark one enemy unit: Sudden Dawn Cadre attacks against it have +1 AP for the rest of the battle."
            needsPick
            options={enemiesOf(side).map((t) => ({ value: t.id, text: nameOfUnit(t.id) }))}
            onUse={(pick) => play('coordinated_eradication', { targetUnitId: pick })}
          />,
        );
      }
      const isFtgg = (datasheetsById.get(u.datasheetId)?.abilities ?? []).some((a) => a.name.toLowerCase().startsWith('for the greater good'));
      if (isFtgg && !u.status.hasShot && !Object.values(state.spotted ?? {}).some((s) => s.by === u.id)) {
        rows.push(
          <CpAbilityRow
            key={`${u.id}:s`}
            label={`${name} — Spot a target (FTGG)`}
            hint="The Observer marks one visible enemy as Spotted (+1 BS for Guided friends). A non-Pathfinder Observer forgoes its own shooting."
            needsPick
            options={enemiesOf(side).filter((t) => !state.spotted?.[t.id]).map((t) => ({ value: t.id, text: nameOfUnit(t.id) }))}
            onUse={(pick) => dispatch({ type: 'SpotTarget', unitId: u.id, targetUnitId: pick })}
          />,
        );
      }
    }
  }

  if (rows.length === 0) return null;
  return (
    <>
      <h3>Unit abilities</h3>
      {rows}
    </>
  );
}

/** Purification's Sanctification action: pick a unit + an unsanctified objective in your
 *  Shooting phase; it completes at your next Command phase (the reducer validates 16.01). */
function SanctifyBlock({
  state,
  dispatch,
  datasheetsById,
}: {
  state: GameState;
  dispatch: (i: Intent) => void;
  datasheetsById: Map<string, Datasheet>;
}) {
  const side = state.activePlayer;
  const [unitId, setUnitId] = useState('');
  const [objIdx, setObjIdx] = useState('');
  const points = objectivePoints(state.layout);
  const sanctified = new Set((state.cpMissions?.sanctified ?? []).map((s) => s.idx));
  const pending = new Set((state.cpMissions?.sanctifying ?? []).map((s) => s.unitId));
  const units = state.units.filter(
    (u) =>
      u.owner === side && !u.inReserves && u.models.some((m) => m.alive) &&
      !u.status.hasShot && !u.status.advanced && !u.status.fellBack && !u.status.battleShocked &&
      !pending.has(u.id),
  );
  const objectives = points.map((o, i) => ({ o, i })).filter(({ i }) => !sanctified.has(i));
  return (
    <div className="btnrow">
      <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
        <option value="">— sanctifying unit —</option>
        {units.map((u) => (
          <option key={u.id} value={u.id}>{datasheetsById.get(u.datasheetId)?.name ?? u.id}</option>
        ))}
      </select>
      <select value={objIdx} onChange={(e) => setObjIdx(e.target.value)}>
        <option value="">— objective —</option>
        {objectives.map(({ o, i }) => (
          <option key={i} value={i}>objective {i + 1} ({o.kind})</option>
        ))}
      </select>
      <button
        disabled={!unitId || objIdx === ''}
        onClick={() => {
          dispatch({ type: 'StartSanctification', unitId, objectiveIdx: Number(objIdx) });
          setUnitId('');
          setObjIdx('');
        }}
      >
        ⚡ Sanctify
      </button>
    </div>
  );
}

function ActionsBlock({
  state,
  dispatch,
  datasheetsById,
  ctx,
}: {
  state: GameState;
  dispatch: (i: Intent) => void;
  datasheetsById: Map<string, Datasheet>;
  ctx: EngineContext;
}) {
  const side = state.activePlayer;
  const defs = [
    ...actionsForSide(state, side),
    // Cleanse / Plunder become available while the matching Tactical Mission is in hand.
    ...SECONDARY_ACTIONS.filter((a) => state.secondaries?.[side]?.hand.some((c) => c.id === a.id)),
  ];
  const [unitId, setUnitId] = useState('');
  const [actionId, setActionId] = useState(defs[0]?.id ?? '');
  const [objectiveIdx, setObjectiveIdx] = useState(0);
  const [areaId, setAreaId] = useState('');
  const [targetUnitId, setTargetUnitId] = useState('');
  if (defs.length === 0) return null;
  const def = defs.find((d) => d.id === actionId) ?? defs[0]!;
  const mine = state.units.filter((u) => u.owner === side && !u.inReserves && u.models.some((m) => m.alive));
  const params = {
    unitId,
    actionId: def.id,
    ...(def.kind === 'objective' ? { objectiveIdx } : {}),
    ...(def.kind === 'area' ? { areaId } : {}),
    ...(def.kind === 'enemy' ? { targetUnitId } : {}),
  };
  const check = unitId ? canStartAction(state, ctx, params) : { ok: false, reason: 'pick a unit' };
  const points = objectivePoints(state.layout);
  return (
    <div className="phase-block">
      <h3>Objective Actions</h3>
      <p className="hint">Starting an action means the unit cannot shoot or charge this turn (16.01).</p>
      <label className="field">
        <span>Action</span>
        <select value={def.id} onChange={(e) => setActionId(e.target.value)}>
          {defs.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Unit</span>
        <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          <option value="">— pick —</option>
          {mine.map((u) => (
            <option key={u.id} value={u.id}>{datasheetsById.get(u.datasheetId)?.name ?? u.id}</option>
          ))}
        </select>
      </label>
      {def.kind === 'objective' && (
        <label className="field">
          <span>Objective</span>
          <select value={objectiveIdx} onChange={(e) => setObjectiveIdx(Number(e.target.value))}>
            {points.map((o, i) => (
              <option key={i} value={i}>#{i + 1} {o.kind} ({o.pos.x.toFixed(0)}", {o.pos.y.toFixed(0)}")</option>
            ))}
          </select>
        </label>
      )}
      {def.kind === 'area' && (
        <label className="field">
          <span>Terrain area</span>
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">— pick —</option>
            {(state.layout.terrainAreas ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.id}</option>
            ))}
          </select>
        </label>
      )}
      {def.kind === 'enemy' && (
        <label className="field">
          <span>Enemy unit</span>
          <select value={targetUnitId} onChange={(e) => setTargetUnitId(e.target.value)}>
            <option value="">— pick —</option>
            {state.units
              .filter((u) => u.owner !== side && !u.inReserves && u.models.some((m) => m.alive))
              .map((u) => (
                <option key={u.id} value={u.id}>{datasheetsById.get(u.datasheetId)?.name ?? u.id}</option>
              ))}
          </select>
        </label>
      )}
      <div className="btnrow">
        <button disabled={!check.ok} onClick={() => dispatch({ type: 'StartAction', ...params })}>
          Start {def.name}
        </button>
        {!check.ok && unitId && <span className="muted">{check.reason}</span>}
      </div>
      {(state.activeActions ?? []).length > 0 && (
        <ul className="dep-attached">
          {(state.activeActions ?? []).map((a, i) => (
            <li key={i}>
              <span style={{ color: OWNER_COLOR[a.side].fill }}>{a.side}</span> ·{' '}
              {datasheetsById.get(state.units.find((u) => u.id === a.unitId)?.datasheetId ?? '')?.name ?? a.unitId}: {a.actionId}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Core stratagems with dedicated engine bindings — hidden from the generic spend-CP list. */
const ENGINE_BOUND_STRATS = new Set([
  'core:command_reroll', 'core:fire_overwatch', 'core:heroic_intervention', 'core:crushing_impact',
  'core:explosives', 'core:rapid_ingress', 'core:counter_offensive', 'core:insane_bravery',
]);

/**
 * Phase-aware controls for the engine-bound Core Stratagem plays (15.03–15.12): Insane Bravery
 * (Command), Fire Overwatch + Rapid Ingress (opponent's Movement), Explosives (your Shooting),
 * Crushing Impact + Heroic Intervention (Charge), Counteroffensive (opponent's Fight). The
 * reducer enforces CP, once-per-phase and all the rule gates; these controls only offer plays
 * that are plausibly legal right now.
 */
function StratagemPlays({
  state, dispatch, ctx, nameOfUnit, onBeginArrival,
}: {
  state: GameState;
  dispatch: (i: Intent) => void;
  ctx: EngineContext;
  nameOfUnit: (id: string) => string;
  onBeginArrival?: (unitId: string, rapidIngress?: boolean) => void;
}) {
  const [heroicMode, setHeroicMode] = useState<'leap_to_defend' | 'into_the_fray'>('leap_to_defend');
  if (state.mode !== 'match' || state.stage !== 'battle') return null;
  const phase = state.phase;
  const active = state.activePlayer;
  const defender: Side = active === 'player' ? 'ai' : 'player';
  const onBoard = (u: UnitInstance) => !u.inReserves && u.models.some((m) => m.alive);
  const isMV = (u: UnitInstance) =>
    !!ctx.datasheets.get(u.datasheetId)?.keywords.some((k) => /^(monster|vehicle)$/i.test(k));
  const plays: JSX.Element[] = [];

  if (phase === 'Command' && !state.commandRun && !state.insaneBraveryUsed?.[active] && state.cp[active] >= 1) {
    const candidates = state.units.filter(
      (u) => u.owner === active && onBoard(u) &&
        (u.models.filter((m) => m.alive).length <= u.startingModels / 2 || u.status.battleShocked),
    );
    if (candidates.length) {
      plays.push(
        <div className="btnrow" key="ib">
          <span className="muted">Insane Bravery (1 CP, once per battle):</span>
          {candidates.map((u) => (
            <button key={u.id} onClick={() => dispatch({ type: 'InsaneBravery', unitId: u.id })}>
              {nameOfUnit(u.id)}
            </button>
          ))}
        </div>,
      );
    }
  }

  if (phase === 'Movement' && state.cp[defender] >= 1) {
    const shooters = state.units.filter(
      (u) =>
        u.owner === defender && onBoard(u) &&
        !ctx.datasheets.get(u.datasheetId)?.keywords.some((k) => k.toLowerCase() === 'titanic') &&
        engagedEnemies(u, state, ctx).length === 0,
    );
    for (const u of shooters.slice(0, 4)) {
      const targets = state.units.filter(
        (e) => e.owner === active && onBoard(e) && gapBetween(u, e, ctx) <= 24,
      );
      if (!targets.length) continue;
      plays.push(
        <div className="btnrow" key={`ow:${u.id}`}>
          <span className="muted">Fire Overwatch (1 CP, {defender}): {nameOfUnit(u.id)} →</span>
          {targets.slice(0, 3).map((t) => (
            <button key={t.id} onClick={() => dispatch({ type: 'FireOverwatch', unitId: u.id, targetUnitId: t.id })}>
              {nameOfUnit(t.id)}
            </button>
          ))}
        </div>,
      );
    }
    const reserves = state.units.filter((u) => u.owner === defender && u.inReserves && !u.embarkedIn && u.models.some((m) => m.alive));
    if (state.round >= 2 && reserves.length && onBeginArrival) {
      plays.push(
        <div className="btnrow" key="ri">
          <span className="muted">Rapid Ingress (1 CP, {defender}):</span>
          {reserves.map((u) => (
            <button key={u.id} onClick={() => onBeginArrival(u.id, true)}>
              ⤓ {nameOfUnit(u.id)}
            </button>
          ))}
        </div>,
      );
    }
  }

  if (phase === 'Shooting' && state.activePlayer === active && state.cp[active] >= 1) {
    const throwers = state.units.filter(
      (u) =>
        u.owner === active && onBoard(u) && !u.status.advanced && !u.status.hasShot &&
        engagedEnemies(u, state, ctx).length === 0 &&
        ctx.datasheets.get(u.datasheetId)?.keywords.some((k) => /^(explosives|grenades)$/i.test(k)),
    );
    for (const u of throwers.slice(0, 3)) {
      const targets = state.units.filter(
        (e) => e.owner !== active && onBoard(e) && engagedEnemies(e, state, ctx).length === 0 && gapBetween(u, e, ctx) <= 8,
      );
      if (!targets.length) continue;
      plays.push(
        <div className="btnrow" key={`ex:${u.id}`}>
          <span className="muted">Explosives (1 CP): {nameOfUnit(u.id)} →</span>
          {targets.slice(0, 3).map((t) => (
            <button key={t.id} onClick={() => dispatch({ type: 'ThrowExplosives', unitId: u.id, targetUnitId: t.id })}>
              {nameOfUnit(t.id)}
            </button>
          ))}
        </div>,
      );
    }
  }

  if (phase === 'Charge') {
    // Crushing Impact — your charged MONSTER/VEHICLE against an engaged enemy.
    if (state.cp[active] >= 1) {
      const rammers = state.units.filter((u) => u.owner === active && onBoard(u) && u.status.charged && isMV(u));
      for (const u of rammers) {
        const targets = engagedEnemies(u, state, ctx);
        if (!targets.length) continue;
        plays.push(
          <div className="btnrow" key={`ci:${u.id}`}>
            <span className="muted">Crushing Impact (1 CP): {nameOfUnit(u.id)} →</span>
            {targets.map((t) => (
              <button key={t.id} onClick={() => dispatch({ type: 'CrushingImpact', unitId: u.id, targetUnitId: t.id })}>
                {nameOfUnit(t.id)}
              </button>
            ))}
          </div>,
        );
      }
    }
    // Heroic Intervention — the defender counter-charges at the end of your Charge phase.
    if (state.cp[defender] >= 1) {
      const heroes = state.units.filter(
        (u) => u.owner === defender && onBoard(u) && engagedEnemies(u, state, ctx).length === 0,
      );
      for (const u of heroes) {
        const kws = ctx.datasheets.get(u.datasheetId)?.keywords.map((k) => k.toLowerCase()) ?? [];
        if (kws.includes('vehicle') && !kws.includes('character') && !kws.includes('walker')) continue;
        const range = heroicMode === 'into_the_fray' ? 6 : 12;
        const targets = state.units.filter(
          (e) =>
            e.owner === active && onBoard(e) && gapBetween(u, e, ctx) <= range &&
            (heroicMode !== 'leap_to_defend' || e.status.charged),
        );
        if (!targets.length) continue;
        plays.push(
          <div className="btnrow" key={`hi:${u.id}`}>
            <span className="muted">Heroic Intervention ({defender}): {nameOfUnit(u.id)}</span>
            <select value={heroicMode} onChange={(e) => setHeroicMode(e.target.value as typeof heroicMode)}>
              <option value="leap_to_defend">Leap to Defend (1 CP)</option>
              <option value="into_the_fray">Into the Fray (2 CP, roll capped at 6)</option>
            </select>
            {targets.slice(0, 3).map((t) => (
              <button
                key={t.id}
                onClick={() => dispatch({ type: 'Charge', chargerUnitId: u.id, targetUnitIds: [t.id], heroic: heroicMode })}
              >
                → {nameOfUnit(t.id)}
              </button>
            ))}
          </div>,
        );
      }
    }
  }

  if (phase === 'Fight' && state.cp[defender] >= 2 && !state.fightNext) {
    const candidates = state.units.filter(
      (u) => u.owner === defender && onBoard(u) && !u.status.hasFought && engagedEnemies(u, state, ctx).length > 0,
    );
    if (candidates.length) {
      plays.push(
        <div className="btnrow" key="co">
          <span className="muted">Counteroffensive (2 CP, {defender} fights next):</span>
          {candidates.slice(0, 4).map((u) => (
            <button key={u.id} onClick={() => dispatch({ type: 'Counteroffensive', unitId: u.id })}>
              {nameOfUnit(u.id)}
            </button>
          ))}
        </div>,
      );
    }
  }

  if (plays.length === 0) return null;
  return (
    <>
      <h3>Stratagem plays</h3>
      {plays}
    </>
  );
}

/**
 * One Secondary Mission card row: tap the name to expand the full card text (the old
 * hover-tooltip was invisible on touch screens).
 */
function SecondaryCardRow({ name, desc, meta, action }: {
  name: string;
  desc?: string;
  meta: string;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card-row">
      <div className="order-row">
        <button className="card-name" onClick={() => setOpen((o) => !o)} title={open ? 'hide the card text' : 'show the card text'}>
          {open ? '▾' : '▸'} {name}
        </button>
        <span className="muted">· {meta}</span>
        {action}
      </div>
      {open && <p className="card-desc">{desc ?? 'No card text available.'}</p>}
    </div>
  );
}
