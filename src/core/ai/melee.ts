// AI Charge- and Fight-phase decisions. PURE.
//
// Charges: one declaration per tick, ranked by P(2D6 reaches) × expected melee value, gated by the
// profile's charge threshold. The engine's chargeAttempted flag guarantees progress (a failed roll
// cannot be re-declared).
//
// Fights: the Fight phase belongs to BOTH players (alternating activations). The controller asks
// `nextFighter` whose unit is up; this module then plays one full activation: Pile In → every
// melee weapon (skipIf the target dies mid-batch) → Consolidate → mark fought.

import type { GameState, Side, UnitInstance } from '../types';
import { eligibleToCharge, chargeTargets, eligibleToFight, engagedEnemies, fightActivationOrder, isOnBoard } from '../phases';
import { availableUnitWeapons, chargePathExists, objectiveControl } from '../engine';
import { chargeProb, meleeEV, unitGap, unitValue } from './evaluate';
import { secondaryKillBonus } from '../secondaries';
import { unitRolePlan } from './roles';
import type { AiAction, AiDeps, AiIntent } from './types';
import type { AiProfile } from './profile';

// ── Charge phase ──────────────────────────────────────────────────────────────
export function aiChargeAction(state: GameState, side: Side, profile: AiProfile, deps: AiDeps): AiAction {
  const { ctx } = deps;
  const chargers = state.units.filter(
    (u) => u.owner === side && isOnBoard(u) && eligibleToCharge(u, state, ctx).eligible,
  );
  const { perObjective } = objectiveControl(state, ctx);
  const holdsObjective = (t: UnitInstance): boolean =>
    state.layout.objectives.some((o, i) => {
      if (perObjective[i]!.controller !== t.owner) return false;
      const controlR = state.layout.objectiveControlRadiusIn ?? 3;
      return t.models.some((m) => m.alive && Math.hypot(m.pos.x - o.x, m.pos.y - o.y) <= controlR + 1);
    });

  const candidates: { charger: string; target: string; score: number; names: string }[] = [];
  const options: { charger: string; target: string; names: string }[] = [];
  for (const c of chargers) {
    const plan = unitRolePlan(c, ctx);
    if (plan.chargeWeight <= 0) continue; // snipers/artillery never charge
    for (const t of chargeTargets(c, state, ctx)) {
      const names = `${ctx.datasheets.get(c.datasheetId)?.name ?? c.id} → ${ctx.datasheets.get(t.datasheetId)?.name ?? t.id}`;
      options.push({ charger: c.id, target: t.id, names });
      const need = unitGap(c, t, ctx) - 1; // reach Engagement Range
      const p = chargeProb(need);
      if (p <= 0) continue;
      const value =
        meleeEV(c, t, ctx, true) * secondaryKillBonus(state, side, t, ctx) +
        (holdsObjective(t) ? 15 * profile.objective : 0);
      const retaliation = meleeEV(t, c, ctx) * profile.caution;
      const score = p * (value - retaliation * 0.5) * plan.chargeWeight;
      if (score < profile.chargeThreshold) continue;
      candidates.push({ charger: c.id, target: t.id, score, names });
    }
  }

  if (profile.random && options.length && deps.rng.next() < 0.5) {
    const pick = options[deps.rng.int(0, options.length - 1)]!;
    return {
      intents: [{ intent: { type: 'Charge', chargerUnitId: pick.charger, targetUnitIds: [pick.target] } }],
      note: `${side} charges: ${pick.names}`,
    };
  }

  // Best first — but only declare a charge that has a legal landing spot at SOME roll (≤ 12").
  // The Callidus used to burn her declaration into a screened Stormlord ("no clear path") every
  // game; the feasibility dry-run skips those and takes the next-best target instead.
  candidates.sort((a, b) => b.score - a.score || a.charger.localeCompare(b.charger) || a.target.localeCompare(b.target));
  for (const cand of candidates) {
    if (!chargePathExists(state, cand.charger, [cand.target], ctx)) continue;
    return {
      intents: [
        {
          // commandReroll: a declared charge is the AI's best-scored play this phase, so spending
          // 1 CP to salvage a failed roll outranks holding it (engine enforces once-per-phase).
          intent: { type: 'Charge', chargerUnitId: cand.charger, targetUnitIds: [cand.target], commandReroll: true },
        },
      ],
      note: `${side} charges: ${cand.names}`,
    };
  }
  return { intents: [{ intent: { type: 'AdvancePhase' } }], note: `${side} ends the Charge phase` };
}

// ── Fight phase ───────────────────────────────────────────────────────────────
/** The unit whose Fight activation is up next (Fights First, then alternating), or null. */
export function nextFighter(state: GameState, deps: AiDeps): UnitInstance | null {
  const order = fightActivationOrder(state, deps.ctx);
  return order.find((u) => !u.status.hasFought) ?? null;
}

/** One full Fight activation for `unit` (it must be `side`'s next fighter). */
export function aiFightAction(state: GameState, side: Side, profile: AiProfile, deps: AiDeps): AiAction | null {
  const { ctx } = deps;
  const unit = nextFighter(state, deps);
  if (!unit || unit.owner !== side) return null;
  if (!eligibleToFight(unit, state, ctx).eligible) return null;

  const unitId = unit.id;
  const enemies = engagedEnemies(unit, state, ctx).sort(
    (a, b) => meleeEV(unit, b, ctx) - meleeEV(unit, a, ctx) || unitValue(b, ctx) - unitValue(a, ctx) || a.id.localeCompare(b.id),
  );
  const target = profile.random && enemies.length > 1 ? enemies[deps.rng.int(0, enemies.length - 1)]! : enemies[0];

  const intents: AiIntent[] = [{ intent: { type: 'FightMove', unitId, mode: 'pile_in' } }];
  const hasMelee = availableUnitWeapons(unit, ctx).some((w) => w.weapon.type === 'melee');
  if (target && hasMelee) {
    const targetId = target.id;
    // The target may die to overwatch/abilities, or the pile-in may not reach — stand down silently.
    const cannotHit = (s: GameState): boolean => {
      const me = s.units.find((x) => x.id === unitId);
      const t = s.units.find((x) => x.id === targetId);
      if (!me || !t || !t.models.some((m) => m.alive)) return true;
      return !engagedEnemies(me, s, ctx).some((e) => e.id === targetId);
    };
    // One activation, every melee weapon, per-model weapon picks — same intent the UI button uses.
    intents.push({
      intent: { type: 'FightUnit', attackerUnitId: unitId, targetUnitId: targetId },
      skipIf: cannotHit,
    });
  }
  intents.push({ intent: { type: 'FightMove', unitId, mode: 'consolidate' } });
  // Mark the activation spent even if the unit had no usable melee weapon (it still piled in),
  // so the activation order always progresses.
  intents.push({ intent: { type: 'SetUnitStatus', unitId, status: { hasFought: true } } });

  const name = ctx.datasheets.get(unit.datasheetId)?.name ?? unitId;
  const tName = target ? ctx.datasheets.get(target.datasheetId)?.name ?? target.id : 'no one';
  return { intents, note: `${side} fights: ${name} → ${tName}` };
}
