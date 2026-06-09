import { useMemo, useState } from 'react';
import type { Datasheet, GameState } from '../core/types';
import type { Intent } from '../core/state';
import type { EngineContext } from '../core/engine';
import type { MoveMode } from '../core/movement';
import { EFFECT_REGISTRY } from '../core/effects';
import { reservesArrivable, unitCoherency } from '../core/phases';
import { OWNER_COLOR } from './view';

interface Props {
  state: GameState;
  dispatch: (i: Intent) => void;
  datasheetsById: Map<string, Datasheet>;
  /** Units selected on the board (Movement phase); managed by the parent. */
  selectedUnitIds?: string[];
  setSelectedUnitIds?: (ids: string[]) => void;
  /** Begin a Deep Strike arrival placement for a Reserves unit (handled by the board). */
  onBeginArrival?: (unitId: string) => void;
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
export function GamePanel({ state, dispatch, datasheetsById, selectedUnitIds = [], setSelectedUnitIds, onBeginArrival }: Props) {
  const units = state.units;
  const [attackerId, setAttackerId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [weaponName, setWeaponName] = useState('');
  const [effectId, setEffectId] = useState('order:take_aim');

  const ctx: EngineContext = useMemo(() => ({ datasheets: datasheetsById }), [datasheetsById]);
  const movingUnits = units.filter((u) => u.status.moveMode);
  const coherencyOk = movingUnits.every((u) => unitCoherency(u, ctx).inCoherency);
  const arrivable = reservesArrivable(state);
  const nameOfUnit = (id: string) => datasheetsById.get(units.find((u) => u.id === id)?.datasheetId ?? '')?.name ?? id;

  const attacker = units.find((u) => u.id === attackerId);
  const attackerDs = attacker ? datasheetsById.get(attacker.datasheetId) : undefined;
  const weapons = attackerDs?.weapons ?? [];

  const nameOf = (id: string) => {
    const u = units.find((x) => x.id === id);
    const ds = u ? datasheetsById.get(u.datasheetId) : undefined;
    return ds?.name ?? id;
  };
  const aliveOf = (id: string) => units.find((x) => x.id === id)?.models.filter((m) => m.alive).length ?? 0;

  const enemies = useMemo(
    () => units.filter((u) => attacker && u.owner !== attacker.owner && u.models.some((m) => m.alive)),
    [units, attacker],
  );

  const offensiveEffects = Object.values(EFFECT_REGISTRY).filter((e) => e.side === 'attacker');
  const defensiveEffects = Object.values(EFFECT_REGISTRY).filter((e) => e.side === 'defender');

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

      {/* Attack / charge */}
      <h3>Resolve combat</h3>
      <label className="field">
        <span>Attacker</span>
        <select value={attackerId} onChange={(e) => { setAttackerId(e.target.value); setWeaponName(''); }}>
          <option value="">— pick a unit —</option>
          {units.filter((u) => u.models.some((m) => m.alive)).map((u) => (
            <option key={u.id} value={u.id}>{nameOf(u.id)} ({u.owner}, ×{aliveOf(u.id)})</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Weapon</span>
        <select value={weaponName} onChange={(e) => setWeaponName(e.target.value)} disabled={!attacker}>
          <option value="">— pick a weapon —</option>
          {weapons.map((w) => (
            <option key={w.name} value={w.name}>{w.name} ({w.type === 'melee' ? 'melee' : `${w.range}"`})</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Target</span>
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={!attacker}>
          <option value="">— pick a target —</option>
          {enemies.map((u) => (
            <option key={u.id} value={u.id}>{nameOf(u.id)} (×{aliveOf(u.id)})</option>
          ))}
        </select>
      </label>
      <div className="btnrow">
        <button
          disabled={!attackerId || !targetId || !weaponName}
          onClick={() => dispatch({ type: 'Attack', attackerUnitId: attackerId, targetUnitId: targetId, weaponName })}
        >
          Resolve attack
        </button>
        <button
          disabled={!attackerId || !targetId}
          onClick={() => dispatch({ type: 'Charge', chargerUnitId: attackerId, targetUnitId: targetId })}
        >
          Charge (2D6)
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
