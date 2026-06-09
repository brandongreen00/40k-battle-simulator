import { useMemo, useState } from 'react';
import type { Datasheet, GameState } from '../core/types';
import type { Intent } from '../core/state';
import { unitWeapons, type EngineContext } from '../core/engine';
import type { MoveMode } from '../core/movement';
import { EFFECT_REGISTRY } from '../core/effects';
import {
  reservesArrivable, unitCoherency, eligibleToShoot, eligibleToCharge, eligibleToFight,
  validShootingTargets, chargeTargets, engagedEnemies, fightActivationOrder, orderableUnits, type Eligibility,
} from '../core/phases';
import { AM_ORDERS, isOfficer } from '../core/orders';
import { usableStratagems } from '../core/stratagems';
import { stratagems, abilityNamesFor } from '../data/loaders';
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
  /** Each side's army detachment (drives which detachment stratagems are available). */
  detachmentBySide?: Record<Side, string>;
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
export function GamePanel({ state, dispatch, datasheetsById, selectedUnitIds = [], setSelectedUnitIds, onBeginArrival, detachmentBySide }: Props) {
  const units = state.units;
  const phase = state.phase;
  const [attackerId, setAttackerId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [weaponName, setWeaponName] = useState('');
  const [effectId, setEffectId] = useState('order:take_aim');
  const [stratSide, setStratSide] = useState<Side>(state.activePlayer);
  const [chargeTargetIds, setChargeTargetIds] = useState<string[]>([]);

  const ctx: EngineContext = useMemo(() => ({ datasheets: datasheetsById }), [datasheetsById]);
  const movingUnits = units.filter((u) => u.status.moveMode);
  const coherencyOk = movingUnits.every((u) => unitCoherency(u, ctx).inCoherency);
  const arrivable = reservesArrivable(state);
  const nameOfUnit = (id: string) => datasheetsById.get(units.find((u) => u.id === id)?.datasheetId ?? '')?.name ?? id;

  const attacker = units.find((u) => u.id === attackerId);
  // Weapons the (possibly merged) attacker can fire — primary datasheet + any merged Leader's.
  const weapons = useMemo(() => (attacker ? unitWeapons(attacker, ctx).map((w) => w.weapon) : []), [attacker, ctx]);

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

  const attackerEligibility: Eligibility | null = !attacker ? null
    : phase === 'Shooting' ? eligibleToShoot(attacker, state, ctx)
    : phase === 'Fight' ? eligibleToFight(attacker, state, ctx)
    : phase === 'Charge' ? eligibleToCharge(attacker, state, ctx) : null;

  const validTargets = useMemo(() => {
    if (!attacker) return [];
    if (phase === 'Shooting') return weaponName ? validShootingTargets(attacker, weaponName, state, ctx) : [];
    if (phase === 'Charge') return chargeTargets(attacker, state, ctx);
    if (phase === 'Fight') return engagedEnemies(attacker, state, ctx);
    return units.filter((u) => u.owner !== attacker.owner && !u.inReserves && u.models.some((m) => m.alive));
  }, [attacker, weaponName, phase, units]);

  const fightOrder = useMemo(() => (phase === 'Fight' ? fightActivationOrder(state, ctx) : []), [phase, units]);

  // Command phase: Officers of the active player that can issue Orders, and the active detachment.
  const activeDetachment = detachmentBySide?.[state.activePlayer] ?? '';
  const officers = useMemo(
    () => (phase === 'Command' ? myUnits.filter((u) => isOfficer(datasheetsById.get(u.datasheetId), abilityNamesFor(datasheetsById.get(u.datasheetId)!))) : []),
    [phase, units, state.activePlayer],
  );
  const enemiesOnBoard = units.filter((u) => u.owner !== state.activePlayer && !u.inReserves && u.models.some((m) => m.alive));

  /** Issue an Order; Grizzled Company also grants re-roll Hit 1s while a unit is under an Order. */
  function issueOrder(unitId: string, effectId: string) {
    dispatch({ type: 'IssueOrder', unitId, effectId });
    if (activeDetachment === 'Grizzled Company') dispatch({ type: 'IssueOrder', unitId, effectId: 'reroll_hits_1' });
  }

  const offensiveEffects = Object.values(EFFECT_REGISTRY).filter((e) => e.side === 'attacker');
  const defensiveEffects = Object.values(EFFECT_REGISTRY).filter((e) => e.side === 'defender');

  // Stratagems usable by `stratSide` right now (Core + that side's detachment, phase/turn-gated).
  const strats = useMemo(
    () => usableStratagems(stratagems, { phase, isYourTurn: stratSide === state.activePlayer, detachment: detachmentBySide?.[stratSide] }),
    [phase, stratSide, state.activePlayer, detachmentBySide],
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
      <div className="btnrow">
        <button onClick={() => dispatch({ type: 'AdvancePhase' })} disabled={state.ended}>Next phase →</button>
        <button onClick={() => dispatch({ type: 'RunCommandPhase' })} disabled={state.ended}>Run Command</button>
      </div>
      <div className="btnrow">
        <span className="muted">First turn:</span>
        {(['player', 'ai'] as const).map((s) => (
          <button key={s} className={state.firstPlayer === s ? 'seg-on' : ''} onClick={() => dispatch({ type: 'SetFirstPlayer', side: s })}>
            {s}
          </button>
        ))}
      </div>

      {/* Scoreboard */}
      <div className="scoreboard">
        {(['player', 'ai'] as const).map((s) => (
          <div key={s} className="score-cell">
            <span className="dot" style={{ background: OWNER_COLOR[s].fill }} /> {s}
            <div className="vp">{state.score[s]} VP</div>
            <div className="cp">{state.cp[s]} CP</div>
          </div>
        ))}
      </div>

      {/* Command phase — Orders (Voice of Command) */}
      {phase === 'Command' && officers.length > 0 && (
        <div className="phase-block">
          <h3>Orders {activeDetachment === 'Grizzled Company' ? '· Ruthless Discipline (+1 order, re-roll Hit 1s)' : ''}</h3>
          {officers.map((off) => {
            const targets = orderableUnits(off, state, ctx);
            return (
              <div key={off.id} className="order-officer">
                <strong>{nameOf(off.id)}</strong>
                {targets.length === 0 ? (
                  <span className="muted"> — no REGIMENT units within 6"</span>
                ) : (
                  targets.map((t) => (
                    <div key={t.id} className="order-row">
                      <span>{nameOf(t.id)}{(t.status.activeEffects ?? []).some((e) => e.startsWith('order:')) ? ' ✓' : ''}</span>
                      <select
                        value=""
                        onChange={(e) => { if (e.target.value) issueOrder(t.id, e.target.value); }}
                      >
                        <option value="">— issue order —</option>
                        {AM_ORDERS.map((o) => <option key={o.id} value={o.effectId} title={o.desc}>{o.name} — {o.desc}</option>)}
                      </select>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Command phase — Imperialis Fleet "At all Costs" */}
      {phase === 'Command' && activeDetachment === 'Imperialis Fleet' && (
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
              <p className="muted">
                {selectedUnitIds.length === 0
                  ? 'Drag a box on the board to select your units.'
                  : `${selectedUnitIds.length} unit(s) selected: ${selectedUnitIds.map(nameOfUnit).join(', ')}`}
              </p>
              <div className="btnrow">
                {MOVE_MODES.map(({ mode, label }) => (
                  <button
                    key={mode}
                    disabled={selectedUnitIds.length === 0}
                    onClick={() => dispatch({ type: 'BeginMove', unitIds: selectedUnitIds, mode })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className={coherencyOk ? 'muted' : 'coh-bad'}>
                {movingUnits.length} unit(s) moving · {coherencyOk ? 'in coherency ✓' : '⚠ out of coherency'}
              </p>
              <div className="btnrow">
                <button
                  className="primary"
                  disabled={!coherencyOk}
                  title={coherencyOk ? '' : 'A unit is out of coherency — bring its models back together first'}
                  onClick={() => { dispatch({ type: 'EndMove', unitIds: movingUnits.map((u) => u.id) }); setSelectedUnitIds?.([]); }}
                >
                  ✓ Confirm move
                </button>
                <button onClick={() => { dispatch({ type: 'CancelMove', unitIds: movingUnits.map((u) => u.id) }); }}>
                  Cancel
                </button>
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
        <span>Attacker {phase === 'Shooting' || phase === 'Fight' || phase === 'Charge' ? `(${eligibleAttackers.length} eligible)` : ''}</span>
        <select value={attackerId} onChange={(e) => { setAttackerId(e.target.value); setWeaponName(''); setTargetId(''); setChargeTargetIds([]); }}>
          <option value="">— pick a unit —</option>
          {(eligibleAttackers.length ? eligibleAttackers : myUnits).map((u) => (
            <option key={u.id} value={u.id}>{nameOf(u.id)} ({u.owner}, ×{aliveOf(u.id)})</option>
          ))}
        </select>
      </label>
      {attackerEligibility && !attackerEligibility.eligible && (
        <p className="coh-bad">⚠ {attackerEligibility.reason}</p>
      )}
      <label className="field">
        <span>Weapon</span>
        <select value={weaponName} onChange={(e) => { setWeaponName(e.target.value); setTargetId(''); }} disabled={!attacker}>
          <option value="">— pick a weapon —</option>
          {weapons.map((w) => (
            <option key={w.name} value={w.name}>{w.name} ({w.type === 'melee' ? 'melee' : `${w.range}"`})</option>
          ))}
        </select>
      </label>
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
        <button
          disabled={!attackerId || !targetId || !weaponName}
          onClick={() => dispatch({ type: 'Attack', attackerUnitId: attackerId, targetUnitId: targetId, weaponName })}
        >
          Resolve attack
        </button>
        <button
          disabled={!attackerId || (phase === 'Charge' ? chargeTargetIds.length === 0 : !targetId)}
          onClick={() => dispatch({ type: 'Charge', chargerUnitId: attackerId, targetUnitIds: phase === 'Charge' ? chargeTargetIds : (targetId ? [targetId] : []) })}
        >
          Charge (2D6){chargeTargetIds.length > 1 ? ` ×${chargeTargetIds.length}` : ''}
        </button>
      </div>

      {/* Orders & stratagems */}
      <h3>Orders & Stratagems</h3>
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
          strats.map((st) => {
            const afford = state.cp[stratSide] >= st.cp;
            return (
              <button
                key={st.id}
                className="strat"
                disabled={!afford}
                title={st.text}
                onClick={() => dispatch({ type: 'UseStratagem', name: st.name, side: stratSide, cost: st.cp, ...(st.effectId && targetId ? { targetUnitId: targetId, effectId: st.effectId } : {}) })}
              >
                <span className="strat-cp">{st.cp}</span>
                <span className="strat-name">{st.name}</span>
                <span className={`strat-det${st.detachment ? '' : ' core'}`}>{st.detachment ?? 'Core'}</span>
              </button>
            );
          })
        )}
      </div>

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
