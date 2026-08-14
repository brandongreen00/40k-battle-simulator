import type { Datasheet, GameState, UnitInstance } from '../core/types';
import type { Intent } from '../core/state';
import type { EngineContext, FirePlan } from '../core/engine';
import { eligibleToShoot, validShootingTargets } from '../core/phases';
import { woundThreshold } from '../core/combat';
import { parseKeywords } from '../core/keywords';

/** Ring palette for the weapon-range circles: one color per distinct range, longest first. */
const RING_COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#f87171', '#facc15'];

export interface RangeRing {
  range: number;
  color: string;
}

/** Distinct weapon ranges of a fire plan, longest first, each with a stable color. */
export function ringsForPlan(plan: FirePlan): RangeRing[] {
  const ranges = [...new Set(plan.fire.map((w) => w.weapon.range ?? 0))].filter((r) => r > 0);
  ranges.sort((x, y) => y - x);
  return ranges.map((range, i) => ({ range, color: RING_COLORS[i % RING_COLORS.length]! }));
}

interface Props {
  state: GameState;
  attackerUnitId: string;
  targetUnitId: string | null;
  plan: FirePlan;
  rings: RangeRing[];
  datasheetsById: Map<string, Datasheet>;
  dispatch: (i: Intent) => void;
  onClear: () => void;
}

/**
 * The under-board Shooting panel: the tapped shooter's weapons (each dot colored to match its
 * range ring on the board), and — once an enemy is tapped — the matchup stat sheet (weapon BS
 * and Strength vs the target's Toughness and Save) with a Shoot button. Lives on the Board page,
 * so on a phone the whole Shooting phase can be driven from the map without tab-flipping.
 * Shown numbers are the profile stats; modifiers (cover, stealth, orders) resolve in the dice.
 */
export function ShootingBar({ state, attackerUnitId, targetUnitId, plan, rings, datasheetsById, dispatch, onClear }: Props) {
  const ctx: EngineContext = { datasheets: datasheetsById };
  const attacker = state.units.find((u) => u.id === attackerUnitId);
  const target = targetUnitId ? state.units.find((u) => u.id === targetUnitId) : undefined;
  if (!attacker) return null;
  const name = (u: UnitInstance) => datasheetsById.get(u.datasheetId)?.name ?? u.id;
  const aliveCount = (u: UnitInstance) => u.models.filter((m) => m.alive).length;
  const eligibility = eligibleToShoot(attacker, state, ctx);
  const colorOf = (range?: number) => rings.find((r) => r.range === (range ?? 0))?.color ?? '#94a3b8';
  // Can this fire-plan weapon legally reach the tapped target (range + per-bearer visibility)?
  const reaches = (w: FirePlan['fire'][number]) =>
    !!target && validShootingTargets(attacker, w.weapon.name, state, ctx, w.sourceDsId).some((t) => t.id === target.id);
  const reachable = target ? plan.fire.filter((w) => reaches(w)) : [];
  const tds = target ? datasheetsById.get(target.datasheetId) : undefined;
  // The engine defends with the unit's primary (bodyguard) profile — mirror it here.
  const tProfile = tds?.models[0];
  const canShoot = eligibility.eligible && !!target && reachable.length > 0;

  return (
    <div className="shootbar">
      <div className="shoot-head">
        <span className="shoot-title">
          🔫 {name(attacker)} <span className="muted">×{aliveCount(attacker)}</span>
        </span>
        <button type="button" className="shoot-clear" onClick={onClear} aria-label="Clear shooting selection">
          ✕
        </button>
      </div>
      {!eligibility.eligible && <p className="warn">⚠ Cannot shoot: {eligibility.reason}</p>}
      {plan.fire.length === 0 ? (
        <p className="muted">No ranged weapons can fire.</p>
      ) : (
        <div className="shoot-weapons">
          {plan.fire.map((w) => {
            const kw = parseKeywords(w.weapon.keywords);
            const unreachable = !!target && !reaches(w);
            return (
              <div key={`${w.sourceDsId}|${w.weapon.name}`} className={`shoot-w${unreachable ? ' unreachable' : ''}`}>
                <span className="wdot" style={{ background: colorOf(w.weapon.range) }} />
                <span className="wname">
                  {w.carriers}× {w.weapon.name}
                  {w.viaFiringDeck ? ' (Firing Deck)' : ''}
                </span>
                <span className="wstats">
                  {w.weapon.range}" · A{w.weapon.attacks} · {kw.torrent ? 'auto-hit' : `BS ${w.weapon.skill}+`} · S
                  {w.weapon.S} · AP{w.weapon.AP} · D{w.weapon.D}
                </span>
                {target && tProfile && (
                  unreachable ? (
                    <span className="wvs miss">✗ can't reach</span>
                  ) : (
                    <span className="wvs">
                      {kw.torrent ? 'hits auto' : `hits ${w.weapon.skill}+`} · wounds{' '}
                      {woundThreshold(w.weapon.S, tProfile.T)}+
                    </span>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
      {plan.notes.map((n, i) => (
        <p key={i} className="hint">
          {n}
        </p>
      ))}
      {target && tds && tProfile ? (
        <div className="shoot-target">
          <div className="shoot-head">
            <span className="shoot-title">
              🎯 {name(target)} <span className="muted">×{aliveCount(target)}</span>
            </span>
            <span className="tstats">
              T {tProfile.T} · Sv {tProfile.Sv}+{tProfile.invuln ? ` · ${tProfile.invuln}++` : ''} · W {tProfile.W}
            </span>
          </div>
          {reachable.length === 0 ? (
            <p className="warn">✗ Out of range or not visible — no weapon can reach this unit.</p>
          ) : (
            <div className="btnrow">
              <button
                type="button"
                className="primary"
                disabled={!canShoot}
                onClick={() => {
                  dispatch({ type: 'ShootUnit', attackerUnitId, targetUnitId: target.id });
                  onClear();
                }}
              >
                🔫 Shoot — all weapons
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="hint">Tap a highlighted enemy inside a ring to see the matchup and shoot.</p>
      )}
    </div>
  );
}
