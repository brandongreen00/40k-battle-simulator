// AI Shooting-phase decisions. PURE.
//
// One shooting activation per tick: rank every (eligible shooter → legal target) pair by expected
// points of damage and fire the best, letting casualties update the next decision. Shooters and
// targets come from phases.ts (`eligibleToShoot` / `validUnitShootingTargets`), so an emitted
// ShootUnit is legal by construction. When nothing useful is left to fire, the phase advances.

import type { GameState, Side } from '../types';
import { eligibleToShoot, validUnitShootingTargets, isOnBoard } from '../phases';
import { objectiveControl } from '../engine';
import { secondaryKillBonus } from '../secondaries';
import { bestMissionAction } from './missionplay';
import { shootingEV, unitThreat, unitValue } from './evaluate';
import { unitRolePlan } from './roles';
import type { AiAction, AiDeps } from './types';
import type { AiProfile } from './profile';

export function aiShootingAction(state: GameState, side: Side, profile: AiProfile, deps: AiDeps): AiAction {
  const { ctx } = deps;
  const shooters = state.units.filter(
    (u) => u.owner === side && isOnBoard(u) && eligibleToShoot(u, state, ctx).eligible,
  );

  const { perObjective } = objectiveControl(state, ctx);
  const onContestedObjective = (unitId: string): boolean => {
    const u = state.units.find((x) => x.id === unitId);
    if (!u) return false;
    const controlR = state.layout.objectiveControlRadiusIn ?? 3;
    return state.layout.objectives.some((o, i) => {
      if (perObjective[i]!.controller === side) return false;
      return u.models.some((m) => m.alive && Math.hypot(m.pos.x - o.x, m.pos.y - o.y) <= controlR + 1);
    });
  };

  let best: { shooter: string; target: string; score: number; names: string } | null = null;
  const options: { shooter: string; target: string; names: string }[] = [];
  for (const s of shooters) {
    const plan = unitRolePlan(s, ctx);
    for (const t of validUnitShootingTargets(s, state, ctx)) {
      const names = `${ctx.datasheets.get(s.datasheetId)?.name ?? s.id} → ${ctx.datasheets.get(t.datasheetId)?.name ?? t.id}`;
      options.push({ shooter: s.id, target: t.id, names });
      let ev = shootingEV(state, s, t, ctx);
      // Snipers exist to pick off CHARACTERS (Precision + Lone Operative hunters).
      if (plan.characterHunter > 1 && ctx.datasheets.get(t.datasheetId)?.keywords.some((k) => k.toLowerCase() === 'character')) {
        ev *= plan.characterHunter;
      }
      // Active Tactical Missions (Assassination / Bring It Down) pay extra for this kill.
      ev *= secondaryKillBonus(state, side, t, ctx);
      if (ev <= 0) continue;
      const tValue = unitValue(t, ctx);
      let score = ev * profile.damage;
      score += Math.min(ev, tValue) * (unitThreat(t, ctx) / 100) * profile.caution; // kill the killers
      if (onContestedObjective(t.id)) score += ev * 0.5 * profile.objective; // shoot them off the point
      if (ev >= tValue) score += tValue * 0.3; // finishing a unit is worth extra
      if (!best || score > best.score || (score === best.score && s.id < best.shooter)) {
        best = { shooter: s.id, target: t.id, score, names };
      }
    }
  }

  if (profile.random && options.length) {
    const pick = options[deps.rng.int(0, options.length - 1)]!;
    return {
      intents: [{ intent: { type: 'ShootUnit', attackerUnitId: pick.shooter, targetUnitId: pick.target } }],
      note: `${side} shoots: ${pick.names}`,
    };
  }

  // Objective Actions (11e): a unit sitting on a mission objective with little worth shooting
  // should perform its mission's action instead — VP is the win condition. Keep the current
  // best shooter free; convert action VP to the shooting-EV scale (~12 points of expected
  // damage per VP, scaled by the profile's actionPriority knob).
  const exclude = new Set<string>();
  if (best) exclude.add(best.shooter);
  const action = bestMissionAction(state, side, deps, exclude);
  if (action) {
    const actionScore = action.vp * 12 * (profile.actionPriority ?? 1);
    const shooterBestEv = (unitId: string): number => {
      const u = state.units.find((x) => x.id === unitId);
      if (!u || !eligibleToShoot(u, state, ctx).eligible) return 0;
      let ev = 0;
      for (const t of validUnitShootingTargets(u, state, ctx)) ev = Math.max(ev, shootingEV(state, u, t, ctx));
      return ev;
    };
    if (actionScore > shooterBestEv(action.params.unitId)) {
      return { intents: [{ intent: { type: 'StartAction', ...action.params } }], note: action.note };
    }
  }

  if (best) {
    return {
      intents: [{ intent: { type: 'ShootUnit', attackerUnitId: best.shooter, targetUnitId: best.target } }],
      note: `${side} shoots: ${best.names} (EV ${best.score.toFixed(0)})`,
    };
  }
  return { intents: [{ intent: { type: 'AdvancePhase' } }], note: `${side} ends the Shooting phase` };
}
