import { useMemo } from 'react';
import type { Datasheet, GameState, Roster, Side } from '../core/types';
import type { Intent } from '../core/state';
import { canAttach, isCharacter } from '../core/leaders';
import { RollOffDice } from './Dice';
import { OWNER_COLOR } from './view';

interface Props {
  state: GameState;
  dispatch: (i: Intent) => void;
  datasheetsById: Map<string, Datasheet>;
  rosters: Roster[];
  rosterName: Record<Side, string>;
  setRosterName: (side: Side, name: string) => void;
  remaining: Record<Side, number>;
}

/**
 * The pre-battle deployment controller: assign a roster to each side, roll off for Attacker/Defender
 * (with SVG dice), watch the alternating deployment, attach Leaders, roll for the first turn, and
 * begin the battle. All actions dispatch the same intents the reducer/tests use.
 */
export function DeploymentPanel({ state, dispatch, datasheetsById, rosters, rosterName, setRosterName, remaining }: Props) {
  const setup = state.setup!;
  const dsName = (id: string) => datasheetsById.get(id)?.name ?? id;

  // Leaders on the board not yet attached, with their eligible (deployed) bodyguards.
  const attachable = useMemo(() => {
    const out: { leader: GameState['units'][number]; targets: GameState['units'] }[] = [];
    for (const u of state.units) {
      const ds = datasheetsById.get(u.datasheetId);
      if (!ds || !isCharacter(ds) || u.attachedTo || u.inReserves) continue;
      const targets = state.units.filter((b) => {
        if (b.owner !== u.owner || b.id === u.id || b.inReserves) return false;
        return canAttach(ds, datasheetsById.get(b.datasheetId));
      });
      if (targets.length) out.push({ leader: u, targets });
    }
    return out;
  }, [state.units, datasheetsById]);

  return (
    <section className="game-panel">
      <h2>Deployment</h2>

      {/* Rosters per side */}
      <div className="dep-rosters">
        {(['player', 'ai'] as const).map((side) => (
          <label className="field" key={side}>
            <span style={{ color: OWNER_COLOR[side].fill }}>{side} army</span>
            <select value={rosterName[side]} onChange={(e) => setRosterName(side, e.target.value)} disabled={setup.step !== 'roll_roles'}>
              {rosters.map((r) => (
                <option key={r.name} value={r.name}>{r.name}{r.sample ? ' (demo)' : ''}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {/* Step 1 — Attacker / Defender */}
      <div className="dep-step">
        <h3>1 · Attacker &amp; Defender</h3>
        {setup.roleRoll ? (
          <>
            <RollOffDice {...setup.roleRoll} />
            <p className="muted">
              <strong style={{ color: OWNER_COLOR[setup.attacker!].fill }}>{setup.attacker}</strong> is Attacker ·{' '}
              <strong style={{ color: OWNER_COLOR[setup.defender!].fill }}>{setup.defender}</strong> is Defender (deploys first)
            </p>
          </>
        ) : (
          <div className="btnrow">
            <button onClick={() => dispatch({ type: 'RollRoles' })}>🎲 Roll off</button>
            <span className="muted">or set:</span>
            {(['player', 'ai'] as const).map((s) => (
              <button key={s} onClick={() => dispatch({ type: 'SetAttacker', side: s })}>{s} attacks</button>
            ))}
          </div>
        )}
      </div>

      {/* Step 2 — Deploy */}
      {setup.attacker && (
        <div className="dep-step">
          <h3>2 · Deploy units</h3>
          <p className="muted">
            Now placing:{' '}
            <strong style={{ color: OWNER_COLOR[effectiveSide(setup, remaining)].fill }}>{effectiveSide(setup, remaining)}</strong>
            {' '}· remaining — player {remaining.player}, ai {remaining.ai}
          </p>
          <p className="hint">Pick a unit on the left, drop it inside your zone (Infiltrators may deploy in no-man's-land). Use “Reserves” for Deep Strike.</p>

          {attachable.length > 0 && (
            <div className="dep-leaders">
              <h4>Attach Leaders</h4>
              {attachable.map(({ leader, targets }) => (
                <div className="field" key={leader.id}>
                  <span>{dsName(leader.datasheetId)}</span>
                  <select
                    defaultValue=""
                    onChange={(e) => e.target.value && dispatch({ type: 'AttachLeader', leaderUnitId: leader.id, bodyguardUnitId: e.target.value })}
                  >
                    <option value="">— lead a unit —</option>
                    {targets.map((b) => (
                      <option key={b.id} value={b.id}>{dsName(b.datasheetId)}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}

          {state.units.some((u) => u.attachedLeaders?.length) && (
            <ul className="dep-attached">
              {state.units.flatMap((u) =>
                (u.attachedLeaders ?? []).map((l) => (
                  <li key={l.unitId}>
                    {dsName(l.datasheetId)} → {dsName(u.datasheetId)} (merged)
                    <button className="link" onClick={() => dispatch({ type: 'DetachLeader', leaderUnitId: l.unitId })}>detach</button>
                  </li>
                )),
              )}
            </ul>
          )}

          <div className="btnrow">
            <button disabled={state.units.length === 0} onClick={() => dispatch({ type: 'RollFirstTurn' })}>
              Finish deploying →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — First turn */}
      {setup.firstTurnRoll && (
        <div className="dep-step">
          <h3>3 · First turn</h3>
          <RollOffDice {...setup.firstTurnRoll} label="first turn" />
          <p className="muted">
            <strong style={{ color: OWNER_COLOR[setup.firstTurn!].fill }}>{setup.firstTurn}</strong> takes the first turn.
          </p>
          <div className="btnrow">
            <button className="primary" onClick={() => dispatch({ type: 'BeginBattle' })}>⚔ Begin battle</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The side that should actually place next: `toDeploy` unless it's out of units and the other isn't. */
function effectiveSide(setup: NonNullable<GameState['setup']>, remaining: Record<Side, number>): Side {
  const t = setup.toDeploy ?? setup.defender ?? 'player';
  const other: Side = t === 'player' ? 'ai' : 'player';
  if (remaining[t] === 0 && remaining[other] > 0) return other;
  return t;
}

export { effectiveSide };
