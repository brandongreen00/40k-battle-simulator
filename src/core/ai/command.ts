// AI Command-phase decisions: run the phase, issue AM Orders, use the Imperialis Fleet
// "At all Costs" command actions. PURE.
//
// Two ticks, driven off the state's `commandRun` flag: first RunCommandPhase (CP / Battle-shock /
// Primary scoring — its dice change who can receive Orders), then the buffs + AdvancePhase.

import type { GameState, Side, UnitInstance } from '../types';
import { unitIsOfficer, AM_ORDERS } from '../orders';
import { armyHasDetachment } from '../detachments';
import { extraOrderCount } from '../enhancements';
import { orderableUnits, isOnBoard, engagedEnemies } from '../phases';
import { objectiveControl, availableUnitWeapons } from '../engine';
import { parseKeywords } from '../keywords';
import { unitHasAbilityStarting } from '../abilities';
import { baseRadius } from '../geometry';
import { withinObjectiveRange } from '../missions11';
import { unitGap, unitThreat, unitValue, maxWeaponRange } from './evaluate';
import type { AiAction, AiDeps, AiIntent } from './types';
import type { AiProfile } from './profile';

/** Pick the best Order for one unit given its situation. Mirrors the option set in core/orders. */
function bestOrderFor(state: GameState, unit: UnitInstance, deps: AiDeps): string {
  const { ctx } = deps;
  const enemies = state.units.filter((e) => e.owner !== unit.owner && isOnBoard(e));
  const nearest = enemies.length ? Math.min(...enemies.map((e) => unitGap(unit, e, ctx))) : Infinity;
  const engaged = engagedEnemies(unit, state, ctx).length > 0;
  const range = maxWeaponRange(unit, ctx);
  const onObjective = state.layout.objectives.some((o) =>
    unit.models.some((m) => m.alive && Math.hypot(m.pos.x - o.x, m.pos.y - o.y) <= (state.layout.objectiveControlRadiusIn ?? 3) + 1),
  );

  if (engaged || (nearest <= 8 && unitThreat(unit, ctx, 'melee') > unitThreat(unit, ctx, 'ranged'))) {
    return 'order:fix_bayonets';
  }
  if (onObjective && nearest <= 24) return 'order:take_cover';
  if (nearest > range && !onObjective) return 'order:move_move_move'; // out of the fight — leg it
  const hasRapidFire = availableUnitWeapons(unit, ctx).some(
    (w) => w.weapon.type === 'ranged' && !!parseKeywords(w.weapon.keywords).rapidFire,
  );
  if (hasRapidFire && nearest <= 12) return 'order:first_rank_fire';
  return 'order:take_aim';
}

/**
 * The Command-phase action for `side`. Tick 1: RunCommandPhase. Tick 2: Orders (one per Officer;
 * two for Grizzled Company's Ruthless Discipline, which also grants re-roll Hit 1s per order),
 * the Imperialis Fleet command actions, then AdvancePhase.
 */
export function aiCommandAction(state: GameState, side: Side, profile: AiProfile, deps: AiDeps): AiAction {
  if (!state.commandRun) {
    const pre: AiIntent[] = [];
    // Insane Bravery (15.04, once per battle): auto-pass the battle-shock roll of the most
    // valuable below-half unit when losing it to OC-0 would hurt (applied BEFORE Run Command).
    if (state.mode === 'match' && !state.insaneBraveryUsed?.[side] && state.cp[side] >= 1) {
      const atRisk = state.units
        .filter((u) => {
          if (u.owner !== side || !isOnBoard(u)) return false;
          const alive = u.models.filter((m) => m.alive).length;
          return (alive <= u.startingModels / 2 || u.status.battleShocked) && unitValue(u, deps.ctx) >= 150;
        })
        .sort((a, b) => unitValue(b, deps.ctx) - unitValue(a, deps.ctx))[0];
      if (atRisk) {
        pre.push({ intent: { type: 'InsaneBravery', unitId: atRisk.id }, skipIf: (s) => s.cp[side] < 1 });
      }
    }
    return { intents: [...pre, { intent: { type: 'RunCommandPhase' } }], note: `${side} runs the Command phase` };
  }

  const { ctx } = deps;
  const intents: AiIntent[] = [];
  const notes: string[] = [];
  const myUnits = state.units.filter((u) => u.owner === side && isOnBoard(u));
  const detachment = deps.detachments[side] ?? '';

  // AM Orders (Voice of Command): one per Officer, +1 for Grizzled Company, +1 for a Grand
  // Strategist (Combined Arms) bearer.
  const baseOrdersPerOfficer = armyHasDetachment(detachment, 'Grizzled Company') ? 2 : 1;
  const ordered = new Set<string>();
  for (const officer of myUnits) {
    // unitIsOfficer sees through the Leader merge: Yarrick attached to a Death Korps squad
    // still issues Orders (and may order his own unit — orderableUnits includes it).
    if (!unitIsOfficer(officer, ctx)) continue;
    const ordersPerOfficer = baseOrdersPerOfficer + extraOrderCount(officer);
    let issued = 0;
    // orderableUnits already applies the keyword + battle-shock eligibility (incl. Battalion
    // Commander's TITANIC/SQUADRON reach — a canReceiveOrders re-check would wrongly demand
    // REGIMENT and silently drop those targets).
    const targets = orderableUnits(officer, state, ctx)
      .filter((t) => !ordered.has(t.id))
      .sort((a, b) => unitValue(b, ctx) - unitValue(a, ctx) || a.id.localeCompare(b.id));
    for (const t of targets) {
      if (issued >= ordersPerOfficer) break;
      const effectId = profile.random
        ? AM_ORDERS[deps.rng.int(0, AM_ORDERS.length - 1)]!.effectId
        : bestOrderFor(state, t, deps);
      ordered.add(t.id);
      issued++;
      intents.push({ intent: { type: 'IssueOrder', unitId: t.id, effectId } });
      // Grizzled Company (Ruthless Discipline): an Order also grants re-roll Hit rolls of 1.
      if (armyHasDetachment(detachment, 'Grizzled Company')) {
        intents.push({ intent: { type: 'IssueOrder', unitId: t.id, effectId: 'reroll_hits_1' } });
      }
      notes.push(`${effectId.replace('order:', '')} → ${ctx.datasheets.get(t.datasheetId)?.name ?? t.id}`);
    }
  }

  // Imperialis Fleet "At all Costs": Eliminate the scariest enemy, Acquire a unit on an objective.
  if (armyHasDetachment(detachment, 'Imperialis Fleet')) {
    const enemies = state.units
      .filter((e) => e.owner !== side && isOnBoard(e))
      .sort((a, b) => unitThreat(b, ctx) - unitThreat(a, ctx) || a.id.localeCompare(b.id));
    if (enemies[0]) {
      intents.push({
        intent: { type: 'UseStratagem', name: 'Eliminate At All Costs', side, cost: 0, targetUnitId: enemies[0].id, effectId: 'mark_eliminate' },
      });
      notes.push(`Eliminate → ${ctx.datasheets.get(enemies[0].datasheetId)?.name ?? enemies[0].id}`);
    }
    const { perObjective } = objectiveControl(state, ctx);
    const holderIdx = perObjective.findIndex((o) => o.controller === side);
    if (holderIdx >= 0) {
      const o = state.layout.objectives[holderIdx]!;
      const controlR = (state.layout.objectiveControlRadiusIn ?? 3) + 1;
      const holder = myUnits
        .filter((u) => u.models.some((m) => m.alive && Math.hypot(m.pos.x - o.x, m.pos.y - o.y) <= controlR))
        .sort((a, b) => unitValue(b, ctx) - unitValue(a, ctx))[0];
      if (holder) {
        intents.push({
          intent: { type: 'UseStratagem', name: 'Acquire At All Costs', side, cost: 0, targetUnitId: holder.id, effectId: 'acquire_buff' },
        });
        notes.push(`Acquire → ${ctx.datasheets.get(holder.datasheetId)?.name ?? holder.id}`);
      }
    }
  }

  // Combat Patrol per-unit specials with Command-phase windows.
  if (state.battleType === 'combat_patrol') {
    for (const u of myUnits) {
      // TOME SKULL (once per battle): unshock a nearby friend, else shock a nearby enemy.
      if (unitHasAbilityStarting(u, ctx, 'tome skull') && u.status.abilityUsed?.['tome_skull'] == null) {
        const near = (t: UnitInstance) => unitGap(u, t, ctx) <= 6;
        const friend = state.units.find((t) => t.owner === side && isOnBoard(t) && t.status.battleShocked && near(t));
        const enemy = state.units
          .filter((t) => t.owner !== side && isOnBoard(t) && !t.status.battleShocked && near(t))
          .sort((a, b) => unitValue(b, ctx) - unitValue(a, ctx))[0];
        const pick = friend ?? enemy;
        if (pick) {
          const unitId = u.id;
          const targetId = pick.id;
          intents.push({
            intent: { type: 'UseUnitAbility', unitId, ability: 'tome_skull', targetUnitId: targetId },
            skipIf: (s) => {
              const me = s.units.find((x) => x.id === unitId);
              const t = s.units.find((x) => x.id === targetId);
              return !me || !t || !t.models.some((m) => m.alive) || me.status.abilityUsed?.['tome_skull'] != null;
            },
          });
          notes.push(`Tome Skull → ${ctx.datasheets.get(pick.datasheetId)?.name ?? pick.id}`);
        }
      }
      // NUNCIO-AQUILA: shock enemy infantry holding an objective within 6" of the Vigilants.
      if (unitHasAbilityStarting(u, ctx, 'nuncio-aquila')) {
        const objs = state.layout.objectivePoints ?? [];
        const uShape = ctx.datasheets.get(u.datasheetId)?.baseShape;
        const uRadius = uShape ? baseRadius(uShape) : 0.63;
        const idx = objs.findIndex((o, i) => {
          if (u.status.abilityUsed?.[`nuncio:${i}`] === (state.turnCounter ?? 0)) return false;
          const near = u.models.some(
            (m) => m.alive && Math.hypot(m.pos.x - o.pos.x, m.pos.y - o.pos.y) - uRadius <= 6,
          );
          if (!near) return false;
          return state.units.some((e) => {
            if (e.owner === side || !isOnBoard(e)) return false;
            const eDs = ctx.datasheets.get(e.datasheetId);
            if (eDs?.keywords.some((k) => /^(monster|vehicle)$/i.test(k))) return false;
            const eRadius = eDs ? baseRadius(eDs.baseShape) : 0.63;
            return e.models.some((m) => m.alive && withinObjectiveRange(m.pos, eRadius, o, state.layout));
          });
        });
        if (idx >= 0) {
          intents.push({ intent: { type: 'UseUnitAbility', unitId: u.id, ability: 'nuncio_aquila', objectiveIdx: idx } });
          notes.push(`Nuncio-Aquila → objective ${idx + 1}`);
        }
      }
    }
  }

  intents.push({ intent: { type: 'AdvancePhase' } });
  return { intents, note: notes.length ? `${side} Command: ${notes.join('; ')}` : `${side} ends the Command phase` };
}
