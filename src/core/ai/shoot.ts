// AI Shooting-phase decisions. PURE.
//
// One shooting activation per tick: rank every (eligible shooter → legal target) pair by expected
// points of damage and fire the best, letting casualties update the next decision. Shooters and
// targets come from phases.ts (`eligibleToShoot` / `validUnitShootingTargets`), so an emitted
// ShootUnit is legal by construction. When nothing useful is left to fire, the phase advances.

import type { GameState, Side } from '../types';
import { eligibleToShoot, engagedEnemies, validUnitShootingTargets, isOnBoard } from '../phases';
import { objectiveControl, planUnitShooting } from '../engine';
import { gapBetweenBases } from '../geometry';
import { pointLosBlocked } from '../visibility';
import { weaponEV } from './evaluate';
import { secondaryKillBonus } from '../secondaries';
import { cpKillBonus, cpSanctificationCandidate } from '../cpmissions';
import { bestMissionAction } from './missionplay';
import { shootingEV, unitThreat, unitValue } from './evaluate';
import { unitRolePlan } from './roles';
import type { AiAction, AiDeps } from './types';
import type { AiProfile } from './profile';

/** Explosives (15.05): a legal, worthwhile grenade throw this phase, or null. Mirrors the
 *  reducer's legality exactly so the emitted intent cannot bounce. */
function explosivesPlay(state: GameState, side: Side, deps: AiDeps): AiAction | null {
  const { ctx } = deps;
  if (state.cp[side] < 1) return null;
  if (state.stratUsed?.[`${side}:core:explosives`] === `${state.round}:${state.activePlayer}:${state.phase}`) return null;
  for (const u of state.units) {
    if (u.owner !== side || !isOnBoard(u)) continue;
    const ds = ctx.datasheets.get(u.datasheetId);
    if (!ds || !ds.keywords.some((k) => /^(explosives|grenades)$/i.test(k))) continue;
    if (u.status.advanced || !eligibleToShoot(u, state, ctx).eligible) continue;
    if (engagedEnemies(u, state, ctx).length > 0) continue;
    for (const t of state.units) {
      if (t.owner === side || !isOnBoard(t)) continue;
      if (engagedEnemies(t, state, ctx).length > 0) continue;
      if (unitValue(t, ctx) < 70) continue; // ~3 mortal wounds should hit something that matters
      const tDs = ctx.datasheets.get(t.datasheetId);
      if (!tDs) continue;
      const tPts = t.models.filter((m) => m.alive).map((m) => m.pos);
      const thrower = u.models.some(
        (m) =>
          m.alive &&
          tPts.some(
            (p) => gapBetweenBases(m.pos, ds.baseShape, p, tDs.baseShape) <= 8 && !pointLosBlocked(m.pos, p, state.layout),
          ),
      );
      if (!thrower) continue;
      const unitId = u.id;
      const targetId = t.id;
      return {
        intents: [
          {
            intent: { type: 'ThrowExplosives', unitId, targetUnitId: targetId },
            skipIf: (s) =>
              s.cp[side] < 1 || !s.units.find((x) => x.id === targetId)?.models.some((m) => m.alive),
          },
        ],
        note: `${side} throws Explosives: ${ds.name} → ${tDs.name}`,
      };
    }
  }
  return null;
}

export function aiShootingAction(state: GameState, side: Side, profile: AiProfile, deps: AiDeps): AiAction {
  const { ctx } = deps;
  // A worthwhile grenade throw is a free action beside the phase's shooting activations.
  const grenades = explosivesPlay(state, side, deps);
  if (grenades) return grenades;
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
      // Active Tactical Missions (Assassination / Bring It Down) pay extra for this kill —
      // and so does a Combat Patrol mission (Inquisitorial Sanction: CHARACTER kills).
      ev *= secondaryKillBonus(state, side, t, ctx) * cpKillBonus(state, side, t, ctx);
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

  // Combat Patrol — Purification: Sanctification pays 10VP at the end of the battle. Start it
  // with a unit already in range whenever that unit's own shooting is worth less.
  const sanct = cpSanctificationCandidate(state, side, ctx, exclude);
  if (sanct) {
    let ev = 0;
    const u = state.units.find((x) => x.id === sanct.unitId);
    if (u && eligibleToShoot(u, state, ctx).eligible) {
      for (const t of validUnitShootingTargets(u, state, ctx)) ev = Math.max(ev, shootingEV(state, u, t, ctx));
    }
    if (10 * 12 * (profile.actionPriority ?? 1) > ev) {
      return {
        intents: [{ intent: { type: 'StartSanctification', ...sanct } }],
        note: `sanctifies objective ${sanct.objectiveIdx + 1}`,
      };
    }
  }

  if (best) {
    // Per-weapon target splitting (04.02): weapons that do clearly better work elsewhere are
    // reassigned (the anti-tank gun leaves the infantry volley). Only meaningfully better
    // alternatives split — the main target keeps the unit's focus.
    const shooter = state.units.find((u) => u.id === best!.shooter)!;
    const mainTarget = state.units.find((u) => u.id === best!.target)!;
    const targets = validUnitShootingTargets(shooter, state, ctx);
    const splitTargets: Record<string, string> = {};
    if (targets.length > 1) {
      const { fire } = planUnitShooting(state, shooter, ctx);
      for (const w of fire) {
        const evMain = weaponEV(state, shooter, w, mainTarget, ctx);
        let alt: { id: string; ev: number } | null = null;
        for (const t of targets) {
          if (t.id === best.target) continue;
          const ev = weaponEV(state, shooter, w, t, ctx) * secondaryKillBonus(state, side, t, ctx) * cpKillBonus(state, side, t, ctx);
          if (!alt || ev > alt.ev) alt = { id: t.id, ev };
        }
        if (alt && alt.ev > evMain * 1.3 + 5) splitTargets[`${w.sourceDsId}|${w.weapon.name}`] = alt.id;
      }
    }
    return {
      intents: [
        {
          intent: {
            type: 'ShootUnit', attackerUnitId: best.shooter, targetUnitId: best.target,
            ...(Object.keys(splitTargets).length ? { splitTargets } : {}),
          },
        },
      ],
      note: `${side} shoots: ${best.names}${Object.keys(splitTargets).length ? ` (+${Object.keys(splitTargets).length} weapon(s) split)` : ''} (EV ${best.score.toFixed(0)})`,
    };
  }
  return { intents: [{ intent: { type: 'AdvancePhase' } }], note: `${side} ends the Shooting phase` };
}
