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
import { cpKillBonus } from '../cpmissions';
import { cpEnhancementSlug, unitHasAbilityStarting } from '../abilities';
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
      // 11.04 roll-first: a target is only selectable when within the ROLLED distance, so the
      // needed roll is the full gap (not gap minus Engagement Range).
      const need = unitGap(c, t, ctx);
      const p = chargeProb(need);
      if (p <= 0) continue;
      const value =
        meleeEV(c, t, ctx, true) * secondaryKillBonus(state, side, t, ctx) * cpKillBonus(state, side, t, ctx) +
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
    const chargerUnit = state.units.find((u) => u.id === cand.charger)!;
    const isMV = !!ctx.datasheets.get(chargerUnit.datasheetId)?.keywords.some((k) => /^(monster|vehicle)$/i.test(k));
    const chargerId = cand.charger;
    const targetId = cand.target;
    const intents: AiIntent[] = [
      {
        // commandReroll: a declared charge is the AI's best-scored play this phase, so spending
        // 1 CP to salvage a failed roll outranks holding it (engine enforces once-per-phase).
        intent: { type: 'Charge', chargerUnitId: chargerId, targetUnitIds: [targetId], commandReroll: true },
      },
    ];
    if (isMV && state.battleType !== 'combat_patrol') {
      // Crushing Impact (15.06): T dice of mortal wounds is nearly always worth 1 CP after a
      // successful tank/monster charge (banned in Combat Patrol). Mirrors the reducer's legality.
      intents.push({
        intent: { type: 'CrushingImpact', unitId: chargerId, targetUnitId: targetId },
        skipIf: (s) => {
          if (s.cp[side] < 1) return true;
          if (s.stratUsed?.[`${side}:core:crushing_impact`] === `${s.round}:${s.activePlayer}:${s.phase}`) return true;
          const me = s.units.find((x) => x.id === chargerId);
          const t = s.units.find((x) => x.id === targetId);
          if (!me?.status.charged || !t || !t.models.some((m) => m.alive)) return true;
          return unitGap(me, t, ctx) > 2;
        },
      });
    }
    return { intents, note: `${side} charges: ${cand.names}` };
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
  // Engaged targets — or, for an OVERRUN FIGHT (12.06: eligible but unengaged), enemies within
  // pile-in-and-engage reach (ER + 3"); the pile-in intent below moves us into Engagement Range.
  let pool = engagedEnemies(unit, state, ctx);
  if (pool.length === 0) {
    pool = state.units.filter(
      (e) => e.owner !== side && isOnBoard(e) && unitGap(unit, e, ctx) <= 5,
    );
  }
  const enemies = pool.sort(
    (a, b) => meleeEV(unit, b, ctx) - meleeEV(unit, a, ctx) || unitValue(b, ctx) - unitValue(a, ctx) || a.id.localeCompare(b.id),
  );
  const target = profile.random && enemies.length > 1 ? enemies[deps.rng.int(0, enemies.length - 1)]! : enemies[0];

  const intents: AiIntent[] = [{ intent: { type: 'FightMove', unitId, mode: 'pile_in' } }];
  const hasMelee = availableUnitWeapons(unit, ctx).some((w) => w.weapon.type === 'melee');
  if (target && hasMelee) {
    const targetId = target.id;
    // Combat Patrol per-unit specials: free once-per-battle/turn melee buffs on this activation.
    if (state.battleType === 'combat_patrol') {
      const used = unit.status.abilityUsed ?? {};
      if (unitHasAbilityStarting(unit, ctx, 'zealot') && used['zealot'] == null) {
        intents.push({ intent: { type: 'UseUnitAbility', unitId, ability: 'zealot' } });
      }
      if (unitHasAbilityStarting(unit, ctx, 'overkill') && used['overkill'] == null) {
        intents.push({ intent: { type: 'UseUnitAbility', unitId, ability: 'overkill' } });
      }
      if (unitHasAbilityStarting(unit, ctx, 'bladeguard') && used['bladeguard'] !== (state.turnCounter ?? 0)) {
        intents.push({ intent: { type: 'UseUnitAbility', unitId, ability: 'bladeguard_hit' } });
      }
      // Purifying Force (enhancement, once per battle per army): [LETHAL HITS] after a charge.
      if (cpEnhancementSlug(unit) === 'purifying_force' && unit.status.charged && !state.cpArmyOnce?.[`${side}:purifying_force`]) {
        intents.push({ intent: { type: 'UseUnitAbility', unitId, ability: 'purifying_force' } });
      }
      // Sanctic Slayers (Teguen's enhancement, once per turn): +1 to wound for this IH activation.
      if (ctx.datasheets.get(unit.datasheetId)?.patrol === 'inquisitors_hand') {
        const bearer = state.units.find(
          (b) =>
            b.owner === side && isOnBoard(b) && cpEnhancementSlug(b) === 'sanctic_slayers' &&
            b.status.abilityUsed?.['sanctic_slayers'] !== (state.turnCounter ?? 0),
        );
        if (bearer) {
          const bearerId = bearer.id;
          intents.push({
            intent: { type: 'UseUnitAbility', unitId: bearerId, ability: 'sanctic_slayers', targetUnitId: unitId },
            skipIf: (s) => {
              const b = s.units.find((x) => x.id === bearerId);
              return !b || !b.models.some((m) => m.alive) || b.status.abilityUsed?.['sanctic_slayers'] === (s.turnCounter ?? 0);
            },
          });
        }
      }
    }
    // Epic Challenge (15.03): when our CHARACTER fights a unit that is hiding a CHARACTER inside
    // a squad, 1 CP of [PRECISION] lets the melee wounds go straight for that character.
    const isChar = (dsId: string) => ctx.datasheets.get(dsId)?.keywords.some((k) => k.toLowerCase() === 'character');
    const weAreCharacter = isChar(unit.datasheetId) || (unit.attachedLeaders ?? []).some((l) => isChar(l.datasheetId));
    const targetHidesCharacter =
      target.models.filter((m) => m.alive).length > 1 &&
      target.models.some((m) => m.alive && m.datasheetId && m.datasheetId !== target.datasheetId && isChar(m.datasheetId));
    const alreadyGranted = state.units.some(
      (u) => u.owner === side && u.status.activeEffects?.includes('precision_melee'),
    );
    if (weAreCharacter && targetHidesCharacter && !alreadyGranted && state.cp[side] >= 2) {
      intents.push({
        intent: { type: 'UseStratagem', name: 'Epic Challenge', side, cost: 1, targetUnitId: unitId, effectId: 'precision_melee' },
        skipIf: (s) => s.cp[side] < 1,
      });
    }
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
