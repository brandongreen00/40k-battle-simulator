import { useMemo, useState } from 'react';
import type { Datasheet, GameState } from '../core/types';
import type { Intent } from '../core/state';
import { EFFECT_REGISTRY } from '../core/effects';
import { OWNER_COLOR } from './view';

interface Props {
  state: GameState;
  dispatch: (i: Intent) => void;
  datasheetsById: Map<string, Datasheet>;
}

/**
 * The play surface for the combat core (Phases 1–3): turn/phase/round controls, the CP + VP
 * scoreboard, attack/charge resolution between on-board units, Order/Stratagem application, and the
 * live dice log. All actions go through the same intent reducer the rest of the app uses.
 */
export function GamePanel({ state, dispatch, datasheetsById }: Props) {
  const units = state.units;
  const [attackerId, setAttackerId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [weaponName, setWeaponName] = useState('');
  const [effectId, setEffectId] = useState('order:take_aim');

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
