import { useMemo, useState } from 'react';
import type { Datasheet, GameState, Roster, RosterUnit, Side } from '../core/types';
import type { Intent } from '../core/state';
import { canAttach, isCharacter } from '../core/leaders';
import { PREBATTLE_GRANTS, REDEPLOY_RULES, grantSelects, redeployRuleSelects } from '../core/enhancements';
import { unitHasWarrant, unitScoutDistance } from '../core/abilities';
import { pendingScoutUnits, scoutTurn, unitCoherency } from '../core/phases';
import { SECONDARY_CARDS, secondaryCard } from '../core/secondaries';
import { unitOverlaps } from '../core/collision';
import { gapBetweenBases } from '../core/geometry';
import { RollOffDice } from './Dice';
import { OWNER_COLOR } from './view';
import { patrolEnhancements, type CpEnhancement } from '../data/loaders';

/** One side's Combat Patrol enhancement pick: a select over its patrol's two cards + decline. */
function CpEnhancementRow({
  side, options, datasheetsById, dispatch,
}: {
  side: Side;
  options: CpEnhancement[];
  datasheetsById: Map<string, Datasheet>;
  dispatch: (i: Intent) => void;
}) {
  const [pick, setPick] = useState('');
  const chosen = options.find((e) => e.id === pick);
  return (
    <div className="btnrow" title={chosen?.text}>
      <strong style={{ color: OWNER_COLOR[side].fill }}>{side}</strong>
      <select value={pick} onChange={(e) => setPick(e.target.value)}>
        <option value="">— pick an enhancement —</option>
        {options.map((e) => (
          <option key={e.id} value={e.id} title={e.text}>
            {e.name} ({datasheetsById.get(e.targetDsId)?.name ?? e.targetDsId})
          </option>
        ))}
        <option value="none">No enhancement</option>
      </select>
      <button
        disabled={pick === ''}
        onClick={() => {
          dispatch(
            pick === 'none' || !chosen
              ? { type: 'ChooseCpEnhancement', side, enhancementId: null }
              : { type: 'ChooseCpEnhancement', side, enhancementId: chosen.id, targetDsId: chosen.targetDsId },
          );
          setPick('');
        }}
      >
        Confirm
      </button>
    </div>
  );
}

/** A roster entry as the deployment list sees it (key matches the unit id used on deploy). */
export interface PanelEntry {
  key: string;
  unit: RosterUnit;
  ds: Datasheet;
}

interface Props {
  state: GameState;
  dispatch: (i: Intent) => void;
  datasheetsById: Map<string, Datasheet>;
  rosters: Roster[];
  rosterName: Record<Side, string>;
  setRosterName: (side: Side, name: string) => void;
  remaining: Record<Side, number>;
  /** Each side's full deployment entry list (placed or not). */
  entries: Record<Side, PanelEntry[]>;
  isPlaced: (key: string) => boolean;
}

/**
 * The pre-battle deployment controller: assign a roster to each side, roll off for Attacker/Defender
 * (with SVG dice), declare Battle Formations (Leader pairings), watch the alternating deployment,
 * resolve Warrant of Trade redeploys and Scout moves, roll for the first turn, and begin the battle.
 * All actions dispatch the same intents the reducer/tests use.
 */
export function DeploymentPanel({ state, dispatch, datasheetsById, rosters, rosterName, setRosterName, remaining, entries, isPlaced }: Props) {
  const setup = state.setup!;
  const ctx = useMemo(() => ({ datasheets: datasheetsById }), [datasheetsById]);
  const dsName = (id: string) => datasheetsById.get(id)?.name ?? id;
  const formations = setup.formations ?? [];

  // ── Declare Battle Formations: unplaced Leader entries × eligible unplaced Bodyguard entries ──
  const pairable = useMemo(() => {
    const out: { side: Side; leader: PanelEntry; targets: PanelEntry[] }[] = [];
    for (const side of ['player', 'ai'] as const) {
      for (const e of entries[side]) {
        if (!isCharacter(e.ds) || isPlaced(e.key)) continue;
        if (formations.some((f) => f.leaderKey === e.key)) continue;
        const targets = entries[side].filter(
          (b) =>
            !isCharacter(b.ds) &&
            b.key !== e.key &&
            !isPlaced(b.key) &&
            !formations.some((f) => f.bodyguardKey === b.key) &&
            canAttach(e.ds, b.ds, e.unit.enhancementId),
        );
        if (targets.length) out.push({ side, leader: e, targets });
      }
    }
    return out;
  }, [entries, formations, state.units]);

  // Leaders on the board not yet attached, with their eligible (deployed) bodyguards.
  const attachable = useMemo(() => {
    const out: { leader: GameState['units'][number]; targets: GameState['units'] }[] = [];
    for (const u of state.units) {
      const ds = datasheetsById.get(u.datasheetId);
      if (!ds || !isCharacter(ds) || u.attachedTo || u.inReserves) continue;
      const targets = state.units.filter((b) => {
        if (b.owner !== u.owner || b.id === u.id || b.inReserves) return false;
        if ((b.attachedLeaders?.length ?? 0) > 0) return false; // one Leader per unit
        return canAttach(ds, datasheetsById.get(b.datasheetId), u.enhancementId);
      });
      if (targets.length) out.push({ leader: u, targets });
    }
    return out;
  }, [state.units, datasheetsById]);

  // ── Declare Battle Formations enhancement grants (Clandestine Operation, Combat Landers) ──
  // A side's roster carries the enhancement; the grant must be declared (or skipped) before the
  // chosen units are placed. One record per (side, enhancement) marks it resolved.
  const pendingGrants = useMemo(() => {
    const out: { side: Side; enhancementId: string }[] = [];
    for (const side of ['player', 'ai'] as const) {
      const seen = new Set<string>();
      for (const e of entries[side]) {
        const id = e.unit.enhancementId;
        if (!id || !PREBATTLE_GRANTS[id] || seen.has(id)) continue;
        seen.add(id);
        if (!(state.setup?.grants ?? []).some((g) => g.side === side && g.enhancementId === id)) {
          out.push({ side, enhancementId: id });
        }
      }
    }
    return out;
  }, [entries, state.setup?.grants]);

  // ── Enhancement redeploys (Liber Heresius etc.) — Warrant-of-Trade mould ──
  const redeployBySide = (['player', 'ai'] as const).map((side) => {
    const entry = entries[side].find((e) => e.unit.enhancementId && REDEPLOY_RULES[e.unit.enhancementId]);
    return entry ? { side, enhancementId: entry.unit.enhancementId!, rule: REDEPLOY_RULES[entry.unit.enhancementId!]! } : null;
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  // ── Warrant of Trade (after both armies have deployed) ──
  // Not during Declare Battle Formations: a fully-declared army (everything embarked/reserved)
  // still has to pass through the deploy step before post-deployment windows open.
  const deploymentComplete =
    setup.attacker != null && setup.step !== 'formations' && remaining.player + remaining.ai === 0;
  const warrantSides = (['player', 'ai'] as const).filter((s) =>
    state.units.some((u) => u.owner === s && unitHasWarrant(u, ctx)),
  );
  const warrantOpen = warrantSides.some((s) => {
    const w = setup.warrant?.[s];
    return (!w && deploymentComplete) || (w?.remaining ?? 0) > 0;
  });
  const grantOpen = pendingGrants.length > 0;
  const redeployOpen = redeployBySide.some(({ side }) => {
    const r = setup.redeploy?.[side];
    return (!r && deploymentComplete) || (r?.remaining ?? 0) > 0;
  });
  const battlelineOf = (side: Side) =>
    state.units.filter((u) => {
      if (u.owner !== side) return false;
      const kws = (datasheetsById.get(u.datasheetId)?.keywords ?? []).map((k) => k.toLowerCase());
      return kws.includes('imperium') && kws.includes('battleline');
    });

  // ── Scout moves (setup step 'scouts') ──
  const scoutSide = setup.step === 'scouts' ? scoutTurn(state, ctx) : null;
  const scoutPending = setup.step === 'scouts' ? pendingScoutUnits(state, ctx) : [];
  const scoutMoving = state.units.find((u) => u.status.moveMode === 'scout');
  const scoutLegal = (u: GameState['units'][number]): boolean => {
    const shape = datasheetsById.get(u.datasheetId)?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
    for (const e of state.units) {
      if (e.owner === u.owner || e.inReserves) continue;
      const eShape = datasheetsById.get(e.datasheetId)?.baseShape ?? shape;
      for (const m of u.models) {
        if (!m.alive) continue;
        for (const em of e.models) {
          if (em.alive && gapBetweenBases(m.pos, shape, em.pos, eShape) <= 9) return false;
        }
      }
    }
    return true;
  };

  return (
    <section className="game-panel">
      <h2>Deployment</h2>

      {/* Rosters per side. A roster with no units would leave that side with NOTHING to deploy
          (the AI would simply never place anything) — keep the empty scaffolds unpickable. */}
      <div className="dep-rosters">
        {(['player', 'ai'] as const).map((side) => (
          <label className="field" key={side}>
            <span style={{ color: OWNER_COLOR[side].fill }}>{side} army</span>
            <select value={rosterName[side]} onChange={(e) => setRosterName(side, e.target.value)} disabled={setup.step !== 'roll_roles'}>
              {rosters.map((r) => (
                <option key={r.name} value={r.name} disabled={r.units.length === 0}>
                  {r.name}{r.sample ? ' (demo)' : ''}{r.units.length === 0 ? ' (empty)' : ''}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {(['player', 'ai'] as const).some((s) => (rosters.find((r) => r.name === rosterName[s])?.units.length ?? 0) === 0) && (
        <p className="warn">
          ⚠ {(['player', 'ai'] as const)
            .filter((s) => (rosters.find((r) => r.name === rosterName[s])?.units.length ?? 0) === 0)
            .map((s) => `the ${s} army "${rosterName[s]}" has no units`)
            .join(' and ')} — that side has nothing to deploy. Pick a list with units.
        </p>
      )}

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

      {/* Combat Patrol enhancements: one pick per patrol, stamped onto the bearer's unit. */}
      {state.battleType === 'combat_patrol' && setup.attacker && (
        <div className="dep-step">
          <h3>Patrol enhancement</h3>
          {(['player', 'ai'] as const).map((side) => {
            const decided = state.cpEnhancements?.[side];
            const patrolName = rosters.find((r) => r.name === rosterName[side])?.detachment ?? '';
            const options = patrolEnhancements.filter((e) => e.patrolName === patrolName);
            if (decided) {
              const chosen = options.find((e) => e.id === decided.id);
              return (
                <p className="muted" key={side}>
                  <strong style={{ color: OWNER_COLOR[side].fill }}>{side}</strong>: {chosen ? `${chosen.name} → ${datasheetsById.get(chosen.targetDsId)?.name ?? chosen.targetDsId}` : 'no enhancement'}
                </p>
              );
            }
            return <CpEnhancementRow key={side} side={side} options={options} datasheetsById={datasheetsById} dispatch={dispatch} />;
          })}
        </div>
      )}

      {/* Step 2 — Declare Battle Formations (before deployment) · Step 3 — Deploy */}
      {setup.attacker && (setup.step === 'formations' || setup.step === 'deploy') && (
        <div className="dep-step">
          <h3>{setup.step === 'formations' ? '2 · Declare Battle Formations' : '3 · Deploy units'}</h3>
          {setup.step === 'formations' ? (
            <>
              <p className="hint">
                Before anyone deploys, each side declares which units <strong>start embarked in
                transports</strong> (“⇥ Embark…” in the unit list, 18.01) and which start in{' '}
                <strong>Strategic Reserves</strong> (“⤓”, 20.01), pairs Leaders below, and then
                finishes declaring in the unit list. A DEDICATED TRANSPORT with no unit embarked
                when this step ends is <strong>destroyed</strong> (18.01).
              </p>
              <p className="muted">
                {(['player', 'ai'] as const).map((s, i) => (
                  <span key={s}>
                    {i > 0 ? ' · ' : ''}
                    <strong style={{ color: OWNER_COLOR[s].fill }}>{s}</strong>:{' '}
                    {setup.formationsDone?.[s] ? '✓ declared' : 'declaring…'}
                  </span>
                ))}
              </p>
            </>
          ) : remaining.player + remaining.ai === 0 ? (
            <p className="muted">✓ All units placed — attach Leaders below if you want, then finish deploying.</p>
          ) : (
            <>
              <p className="muted">
                Now placing:{' '}
                <strong style={{ color: OWNER_COLOR[effectiveSide(setup, remaining)].fill }}>{effectiveSide(setup, remaining)}</strong>
                {' '}· remaining — player {remaining.player}, ai {remaining.ai}
              </p>
              <p className="hint">Pick a unit on the left, drop it inside your zone (Infiltrators may deploy in no-man's-land). Deploying a transport brings its declared riders with it.</p>
            </>
          )}

          {/* Declare Battle Formations enhancement grants: Clandestine Operation (Infiltrators ×3),
              Combat Landers (Deep Strike ×3). Resolve BEFORE placing the units you want to pick. */}
          {pendingGrants.map(({ side, enhancementId }) => (
            <GrantPicker
              key={`${side}:${enhancementId}`}
              side={side}
              enhancementId={enhancementId}
              entries={entries[side]}
              isPlaced={isPlaced}
              dispatch={dispatch}
            />
          ))}
          {(state.setup?.grants ?? []).filter((g) => g.entryKeys.length > 0).map((g) => (
            <p className="muted" key={`${g.side}:${g.enhancementId}`}>
              ✨ <span style={{ color: OWNER_COLOR[g.side].fill }}>{g.side}</span> · {g.label}:{' '}
              {g.entryKeys.length} unit(s) gain {g.grant === 'infiltrators' ? 'Infiltrators' : 'Deep Strike'}
            </p>
          ))}
          {/* Secondary Missions choice (secret, pre-battle): Tactical (draw) or two Fixed cards. */}
          {state.secondaries && (
            <div className="dep-leaders">
              <h4>Secondary missions — Tactical or Fixed</h4>
              {(['player', 'ai'] as const).map((side) => {
                const sec = state.secondaries![side];
                if (sec.mode) {
                  return (
                    <p className="muted" key={side}>
                      <span style={{ color: OWNER_COLOR[side].fill }}>{side}</span>:{' '}
                      {sec.mode === 'fixed'
                        ? `FIXED — ${(sec.fixed ?? []).map((c) => secondaryCard(c.id)?.name ?? c.id).join(' + ')}`
                        : 'Tactical (draw 2 per Command phase)'}
                    </p>
                  );
                }
                const fixedCards = SECONDARY_CARDS.filter((c) => c.fixed);
                return (
                  <div className="field" key={side}>
                    <span style={{ color: OWNER_COLOR[side].fill }}>{side}</span>
                    <button onClick={() => dispatch({ type: 'ChooseSecondaryMode', side })}>Tactical (draw)</button>
                    <select
                      value=""
                      onChange={(e) => {
                        const [a, b] = e.target.value.split('|');
                        if (a && b) dispatch({ type: 'ChooseSecondaryMode', side, fixedCardIds: [a, b] });
                      }}
                    >
                      <option value="">Fixed: pick a pair…</option>
                      {fixedCards.flatMap((a, i) =>
                        fixedCards.slice(i + 1).map((b) => (
                          <option key={`${a.id}|${b.id}`} value={`${a.id}|${b.id}`}>
                            {a.name} + {b.name}
                          </option>
                        )),
                      )}
                    </select>
                  </div>
                );
              })}
              <p className="hint">Unchosen sides default to Tactical when the battle begins.</p>
              <details className="fixed-cards-info">
                <summary>ℹ Fixed-capable card texts</summary>
                {SECONDARY_CARDS.filter((c) => c.fixed).map((c) => (
                  <p className="card-desc" key={c.id}>
                    <strong>{c.name}</strong> — {c.desc}
                  </p>
                ))}
              </details>
            </div>
          )}

          {/* Pre-deployment Leader pairings: the pair deploys as one unit, and grants like the
              Rogue Trader's Backroom Deals (Infiltrators) apply at set-up time. */}
          {pairable.length > 0 && (
            <div className="dep-leaders">
              <h4>Battle formations — pair Leaders before deploying</h4>
              {pairable.map(({ side, leader, targets }) => (
                <div className="field" key={leader.key}>
                  <span>
                    <span style={{ color: OWNER_COLOR[side].fill }}>{side}</span> · {leader.ds.name}
                  </span>
                  <select
                    value=""
                    onChange={(e) => {
                      const b = targets.find((t) => t.key === e.target.value);
                      if (b) dispatch({ type: 'DeclareFormation', side, leaderKey: leader.key, leaderDsId: leader.ds.id, bodyguardKey: b.key, bodyguardDsId: b.ds.id, ...(leader.unit.enhancementId ? { leaderEnhancementId: leader.unit.enhancementId } : {}) });
                    }}
                  >
                    <option value="">— will lead —</option>
                    {targets.map((b) => (
                      <option key={b.key} value={b.key}>{b.ds.name}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          {formations.length > 0 && (
            <ul className="dep-attached">
              {formations.map((f) => (
                <li key={f.leaderKey}>
                  <span style={{ color: OWNER_COLOR[f.side].fill }}>{f.side}</span> · {dsName(f.leaderDsId)} → {dsName(f.bodyguardDsId)}
                  {f.infiltrate ? ' · Infiltrators ✓' : ''}
                  {!isPlaced(f.bodyguardKey) && (
                    <button className="link" onClick={() => dispatch({ type: 'ClearFormation', leaderKey: f.leaderKey })}>clear</button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {attachable.length > 0 && (
            <div className="dep-leaders">
              <h4>Attach Leaders (already deployed)</h4>
              {attachable.map(({ leader, targets }) => (
                <div className="field" key={leader.id}>
                  <span>
                    <span style={{ color: OWNER_COLOR[leader.owner].fill }}>{leader.owner}</span> · {dsName(leader.datasheetId)}
                  </span>
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
                    <span style={{ color: OWNER_COLOR[u.owner].fill }}>{u.owner}</span> · {dsName(l.datasheetId)} → {dsName(u.datasheetId)} (merged)
                    <button className="link" onClick={() => dispatch({ type: 'DetachLeader', leaderUnitId: l.unitId })}>detach</button>
                  </li>
                )),
              )}
            </ul>
          )}

          {/* Enhancement redeploys (Liber Heresius, Guerrilla Honours…): after both armies have
              deployed, pull qualifying units back into the deployment flow. */}
          {deploymentComplete &&
            redeployBySide.map(({ side, enhancementId, rule }) => {
              const r = setup.redeploy?.[side];
              if (!r) {
                return (
                  <div className="dep-leaders" key={`red:${side}`}>
                    <h4>{rule.label} · <span style={{ color: OWNER_COLOR[side].fill }}>{side}</span></h4>
                    <p className="hint">Redeploy up to {rule.count} qualifying unit(s) (board or Reserves).</p>
                    <div className="btnrow">
                      <button onClick={() => dispatch({ type: 'UseEnhancementRedeploy', side, enhancementId })}>↩ Redeploy units</button>
                      <button onClick={() => dispatch({ type: 'DeclineEnhancementRedeploy', side, enhancementId })}>Skip</button>
                    </div>
                  </div>
                );
              }
              if (r.remaining <= 0) return null;
              const eligible = state.units.filter(
                (u) => u.owner === side && !u.embarkedIn && u.models.some((m) => m.alive) &&
                  redeployRuleSelects(rule, datasheetsById.get(u.datasheetId)),
              );
              return (
                <div className="dep-leaders" key={`red:${side}`}>
                  <h4>{rule.label} · <span style={{ color: OWNER_COLOR[side].fill }}>{side}</span> — {r.remaining} redeploy(s) left</h4>
                  {eligible.length === 0 ? (
                    <p className="muted">No qualifying units left to pull back.</p>
                  ) : (
                    eligible.map((u) => (
                      <div className="btnrow" key={u.id}>
                        <button onClick={() => dispatch({ type: 'EnhancementRedeploy', unitId: u.id })}>
                          ↩ Redeploy {dsName(u.datasheetId)}{u.inReserves ? ' (reserves)' : ''}
                        </button>
                      </div>
                    ))
                  )}
                  <div className="btnrow">
                    <button onClick={() => dispatch({ type: 'DeclineEnhancementRedeploy', side, enhancementId })}>Done</button>
                  </div>
                </div>
              );
            })}

          {/* Warrant of Trade: after both armies have deployed, redeploy up to D3 IMPERIUM
              BATTLELINE units (they re-enter the deployment flow — board or Reserves). */}
          {deploymentComplete &&
            warrantSides.map((s) => {
              const w = setup.warrant?.[s];
              if (!w) {
                return (
                  <div className="dep-leaders" key={s}>
                    <h4>Warrant of Trade · <span style={{ color: OWNER_COLOR[s].fill }}>{s}</span></h4>
                    <p className="hint">Redeploy up to D3 IMPERIUM BATTLELINE units (Rogue Trader).</p>
                    <div className="btnrow">
                      <button onClick={() => dispatch({ type: 'UseWarrant', side: s })}>🎲 Roll D3 &amp; redeploy</button>
                      <button onClick={() => dispatch({ type: 'DeclineWarrant', side: s })}>Skip</button>
                    </div>
                  </div>
                );
              }
              if (w.remaining <= 0) return null;
              return (
                <div className="dep-leaders" key={s}>
                  <h4>Warrant of Trade · <span style={{ color: OWNER_COLOR[s].fill }}>{s}</span> — {w.remaining} redeploy(s) left (rolled {w.rolled})</h4>
                  {battlelineOf(s).length === 0 ? (
                    <p className="muted">No IMPERIUM BATTLELINE units left to pull back.</p>
                  ) : (
                    battlelineOf(s).map((u) => (
                      <div className="btnrow" key={u.id}>
                        <button onClick={() => dispatch({ type: 'WarrantRedeploy', unitId: u.id })}>
                          ↩ Redeploy {dsName(u.datasheetId)}{u.inReserves ? ' (reserves)' : ''}
                        </button>
                      </div>
                    ))
                  )}
                  <div className="btnrow">
                    <button onClick={() => dispatch({ type: 'DeclineWarrant', side: s })}>Done</button>
                  </div>
                </div>
              );
            })}

          {setup.step === 'deploy' && (
            <div className="btnrow">
              <button
                disabled={state.units.length === 0 || remaining.player + remaining.ai > 0 || warrantOpen || grantOpen || redeployOpen}
                title={
                  remaining.player + remaining.ai > 0
                    ? `Still to deploy — player ${remaining.player}, ai ${remaining.ai} (use Reserves ⤓ for units arriving later)`
                    : grantOpen
                      ? 'Resolve the Declare Battle Formations enhancement pick first (confirm or skip it)'
                      : warrantOpen
                        ? 'Resolve the Warrant of Trade redeploy first (use it or skip it)'
                        : redeployOpen
                          ? 'Resolve the enhancement redeploy first (use it or skip it)'
                          : ''
                }
                onClick={() => dispatch({ type: 'RollFirstTurn' })}
              >
                Finish deploying →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 4 — First turn */}
      {setup.firstTurnRoll && (
        <div className="dep-step">
          <h3>4 · First turn</h3>
          <RollOffDice {...setup.firstTurnRoll} label="first turn" />
          <p className="muted">
            <strong style={{ color: OWNER_COLOR[setup.firstTurn!].fill }}>{setup.firstTurn}</strong> takes the first turn.
          </p>
        </div>
      )}

      {/* Step 3b — Scout moves (before the battle begins; first-turn player first) */}
      {setup.step === 'scouts' && (
        <div className="dep-step">
          <h3>Scout moves</h3>
          {scoutMoving ? (
            <>
              <p className="muted">
                Drag <strong>{dsName(scoutMoving.datasheetId)}</strong> on the board (up to{' '}
                {scoutMoving.status.moveBudget ?? 0}"). It must end more than 9" from all enemy models.
              </p>
              {!scoutLegal(scoutMoving) && <p className="coh-bad">⚠ within 9" of an enemy — keep moving</p>}
              {!unitCoherency(scoutMoving, ctx).inCoherency && <p className="coh-bad">⚠ out of coherency</p>}
              {unitOverlaps(state, scoutMoving, ctx) && <p className="coh-bad">⚠ on top of another model's base</p>}
              <div className="btnrow">
                <button
                  className="primary"
                  disabled={
                    !scoutLegal(scoutMoving) ||
                    !unitCoherency(scoutMoving, ctx).inCoherency ||
                    unitOverlaps(state, scoutMoving, ctx)
                  }
                  onClick={() => dispatch({ type: 'EndMove', unitIds: [scoutMoving.id] })}
                >
                  ✓ Confirm Scout move
                </button>
                <button onClick={() => dispatch({ type: 'CancelMove', unitIds: [scoutMoving.id] })}>Cancel</button>
              </div>
            </>
          ) : scoutPending.length > 0 ? (
            <>
              <p className="muted">
                <strong style={{ color: OWNER_COLOR[scoutSide ?? 'player'].fill }}>{scoutSide}</strong> resolves Scout moves
                (first-turn player first).
              </p>
              {scoutPending
                .filter((u) => u.owner === scoutSide)
                .map((u) => (
                  <div className="btnrow" key={u.id}>
                    <span className="unit-name">{dsName(u.datasheetId)} · Scouts {unitScoutDistance(u, ctx)}"</span>
                    <button onClick={() => dispatch({ type: 'BeginMove', unitIds: [u.id], mode: 'scout' })}>Move</button>
                    <button onClick={() => dispatch({ type: 'SetUnitStatus', unitId: u.id, status: { scouted: true } })}>Skip</button>
                  </div>
                ))}
            </>
          ) : (
            <p className="muted">All Scout moves resolved.</p>
          )}
          <div className="btnrow">
            <button
              className="primary"
              disabled={scoutPending.length > 0 || !!scoutMoving}
              title={scoutPending.length > 0 ? 'Resolve (or skip) every Scout move first' : ''}
              onClick={() => dispatch({ type: 'BeginBattle' })}
            >
              ⚔ Begin battle
            </button>
          </div>
        </div>
      )}

      {setup.step === 'ready' && (
        <div className="dep-step">
          <div className="btnrow">
            <button className="primary" onClick={() => dispatch({ type: 'BeginBattle' })}>⚔ Begin battle</button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Declare Battle Formations enhancement pick (Clandestine Operation: up to 3 AGENTS OF THE
 * IMPERIUM INFANTRY units gain Infiltrators; Combat Landers: up to 3 VOIDFARERS gain Deep
 * Strike). Checkbox the units, confirm — or skip. Only unplaced units can be picked, so resolve
 * this before deploying them.
 */
function GrantPicker({
  side, enhancementId, entries, isPlaced, dispatch,
}: {
  side: Side;
  enhancementId: string;
  entries: PanelEntry[];
  isPlaced: (key: string) => boolean;
  dispatch: (i: Intent) => void;
}) {
  const rule = PREBATTLE_GRANTS[enhancementId]!;
  const [picked, setPicked] = useState<string[]>([]);
  const eligible = entries.filter((e) => grantSelects(rule, e.ds) && !isPlaced(e.key));
  // A picked unit can be deployed out from under the picker — drop stale keys or Confirm would
  // dispatch an intent the reducer rejects wholesale (with log-only feedback).
  const validPicked = picked.filter((k) => eligible.some((e) => e.key === k));
  const toggle = (key: string) =>
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : validPicked.length < rule.count ? [...validPicked, key] : p));
  const abilityName = rule.grant === 'infiltrators' ? 'Infiltrators' : 'Deep Strike';
  return (
    <div className="dep-leaders grant-picker">
      <h4>
        ✨ {rule.label} · <span style={{ color: OWNER_COLOR[side].fill }}>{side}</span>
      </h4>
      <p className="hint">
        Select up to {Math.min(rule.count, Math.max(eligible.length, 1))} unit(s) to gain {abilityName}
        {rule.grant === 'infiltrators' ? ' (deploy anywhere more than 9" from the enemy — e.g. Subductors blocking a flank)' : ''}.
      </p>
      {eligible.length === 0 ? (
        <p className="muted">No eligible undeployed units (the grant only applies before a unit is placed).</p>
      ) : (
        eligible.map((e) => (
          <label className="grant-row" key={e.key}>
            <input type="checkbox" checked={validPicked.includes(e.key)} onChange={() => toggle(e.key)} />
            <span className="unit-name">{e.ds.name}</span>
            <span className="unit-meta">×{e.unit.modelCount}</span>
          </label>
        ))
      )}
      <div className="btnrow">
        <button
          className="primary"
          disabled={validPicked.length === 0}
          onClick={() =>
            dispatch({
              type: 'DeclareEnhancementGrant', side, enhancementId,
              entries: validPicked
                .map((key) => {
                  const e = entries.find((x) => x.key === key);
                  return e ? { entryKey: key, datasheetId: e.ds.id } : null;
                })
                .filter((x): x is { entryKey: string; datasheetId: string } => x !== null),
            })
          }
        >
          ✓ Grant {abilityName} to {validPicked.length} unit(s)
        </button>
        <button onClick={() => dispatch({ type: 'DeclareEnhancementGrant', side, enhancementId, entries: [] })}>
          Skip
        </button>
      </div>
    </div>
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
