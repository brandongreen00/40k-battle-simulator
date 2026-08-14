// AI reactive plays — actions taken on the OPPONENT'S turn (architecture rule #3). PURE.
//
// When an enemy unit is about to shoot one of ours, the AI may spend 1 CP on the matching
// defensive Core stratagem (Smokescreen for SMOKE units, Go to Ground for INFANTRY — both bound
// to the 'stealth' effect, -1 to be hit) if the incoming expected damage justifies it. One
// reaction per phase (proxied by "something of ours already has stealth up").
//
// This is the seam reactive rules grow from: the runner and the UI both call `aiReactionToShooting`
// just before a ShootUnit intent from the other side resolves.

import type { GameState, Side } from '../types';
import { engagedEnemies, gapBetween, isOnBoard, validUnitShootingTargets } from '../phases';
import { pointInPolygon } from '../geometry';
import { blocksOverwatch } from '../enhancements';
import { chargePathExists } from '../engine';
import { meleeEV, shootingEV, unitValue } from './evaluate';
import { unitRolePlan } from './roles';
import { arrivalAbility, findArrivalAnchor } from './move';
import type { AiDeps, AiIntent } from './types';
import type { AiProfile } from './profile';

export function aiReactionToShooting(
  state: GameState,
  defendingSide: Side,
  attackerUnitId: string,
  targetUnitId: string,
  profile: AiProfile,
  deps: AiDeps,
): AiIntent[] {
  const { ctx } = deps;
  if (state.cp[defendingSide] < 1) return [];
  const attacker = state.units.find((u) => u.id === attackerUnitId);
  const target = state.units.find((u) => u.id === targetUnitId);
  if (!attacker || !target || target.owner !== defendingSide || attacker.owner === defendingSide) return [];
  if (target.status.activeEffects?.includes('stealth')) return [];
  // One reaction per phase: if anything of ours already has stealth up, hold the CP.
  if (state.units.some((u) => u.owner === defendingSide && u.status.activeEffects?.includes('stealth'))) return [];

  const ds = ctx.datasheets.get(target.datasheetId);
  const kw = (ds?.keywords ?? []).map((k) => k.toUpperCase());
  const smoke = kw.includes('SMOKE');
  const infantry = kw.includes('INFANTRY');

  const incoming = shootingEV(state, attacker, target, ctx);
  const value = unitValue(target, ctx);
  if (incoming < profile.reactThreshold && incoming < value * 0.4) return [];

  // Combat Patrol reactive stratagems (the patrol sets), before the generic smoke plays.
  if (state.battleType === 'combat_patrol' && ds) {
    const play = (stratagemId: string, name: string, effectId: string): AiIntent[] => [
      {
        intent: { type: 'UseStratagem', name, side: defendingSide, cost: 1, stratagemId, targetUnitId, effectId },
        skipIf: (s) =>
          s.cp[defendingSide] < 1 ||
          s.stratUsed?.[`${defendingSide}:${stratagemId}`] === `${s.round}:${s.activePlayer}:${s.phase}`,
      },
    ];
    // Refusal to Yield: the Strike Squad shrugs high-Strength fire (-1 to wound when S > T).
    if (
      ds.patrol === 'crowes_sanctifiers' &&
      ds.name.includes('Strike Squad') &&
      !target.status.activeEffects?.includes('cp:wound_shield_strong')
    ) {
      return play('cp:crowes_sanctifiers:refusal_to_yield', 'Refusal to Yield', 'cp:wound_shield_strong');
    }
    // Urban Enforcers: an Inquisitor's Hand unit with EVERY model inside one terrain area.
    if (ds.patrol === 'inquisitors_hand' && !target.status.activeEffects?.includes('cp:ap_shield')) {
      const alive = target.models.filter((m) => m.alive);
      const inOneArea = (state.layout.terrainAreas ?? []).some((a) =>
        alive.every((m) => pointInPolygon(m.pos, a.polygon)),
      );
      if (inOneArea) return play('cp:inquisitors_hand:urban_enforcers', 'Urban Enforcers', 'cp:ap_shield');
    }
  }

  if (!smoke && !infantry) return [];

  const name = smoke ? 'Smokescreen' : 'Go to Ground';
  return [
    {
      intent: { type: 'UseStratagem', name, side: defendingSide, cost: 1, targetUnitId, effectId: 'stealth' },
      skipIf: (s) => s.cp[defendingSide] < 1,
    },
  ];
}

/**
 * Reactive plays at the END of the opponent's Movement/Charge phase — called just before the
 * active player's AdvancePhase intent resolves (the runner and the UI both call this):
 *  • Movement → Fire Overwatch (15.08): snap-shoot the juiciest visible enemy within 24".
 *  • Charge → Heroic Intervention (15.11, Leap to Defend): counter-charge a charger within 12".
 * Returns at most one stratagem play; the engine enforces CP and once-per-phase.
 */
export function aiReactionToPhaseEnd(
  state: GameState,
  defendingSide: Side,
  profile: AiProfile,
  deps: AiDeps,
): AiIntent[] {
  const { ctx } = deps;
  if (state.mode !== 'match' || state.stage !== 'battle') return [];
  if (state.activePlayer === defendingSide) return [];
  if (state.cp[defendingSide] < 1) return [];

  if (state.phase === 'Movement') {
    const plays: AiIntent[] = [];
    // Rapid Ingress (15.07) — played when it SAVES a reserve unit: at the end of the opponent's
    // round-3 Movement phase, a defender whose own round-3 turn has already passed will lose any
    // unarrived reserves to 20.03. One ingress per phase (the engine enforces the rest).
    const myTurnPassedThisRound = defendingSide === state.firstPlayer;
    if (
      state.round === 3 &&
      state.battleType !== 'combat_patrol' && // CP plays its own stratagem cards, not the core set
      myTurnPassedThisRound &&
      state.stratUsed?.[`${defendingSide}:core:rapid_ingress`] !== `${state.round}:${state.activePlayer}:${state.phase}`
    ) {
      const reserve = state.units.find(
        (u) => u.owner === defendingSide && u.inReserves && !u.embarkedIn && u.models.some((m) => m.alive),
      );
      if (reserve) {
        const anchor = findArrivalAnchor(state, reserve, deps);
        if (anchor) {
          const unitId = reserve.id;
          plays.push({
            intent: {
              type: 'ArriveFromReserves', unitId, anchor, formation: 'block', rotation: 0,
              ability: arrivalAbility(reserve, deps), rapidIngress: true,
            },
            skipIf: (s) => s.cp[defendingSide] < 1 || !s.units.find((x) => x.id === unitId)?.inReserves,
          });
        }
      }
    }
    // Fire Overwatch (15.08): snap shooting hits only on unmodified 6s — roughly a quarter of
    // normal output, so demand a real payoff before spending the CP.
    if (state.stratUsed?.[`${defendingSide}:core:fire_overwatch`] !== `${state.round}:${state.activePlayer}:${state.phase}`) {
      let best: { unitId: string; targetId: string; ev: number } | null = null;
      for (const u of state.units) {
        if (u.owner !== defendingSide || !isOnBoard(u)) continue;
        const ds = ctx.datasheets.get(u.datasheetId);
        if (!ds || ds.keywords.some((k) => k.toLowerCase() === 'titanic')) continue;
        if (engagedEnemies(u, state, ctx).length > 0) continue;
        // The exact per-weapon range+LoS check the engine resolves with — shootingEV's sampled
        // visibility uses the legacy terrain list (empty on 11e maps), so it alone would happily
        // declare an overwatch the reducer then rejects ("no weapon could fire").
        const legalTargets = validUnitShootingTargets(u, state, ctx);
        if (legalTargets.length === 0) continue;
        for (const e of state.units) {
          if (e.owner === defendingSide || !isOnBoard(e)) continue;
          if (blocksOverwatch(e)) continue; // Shroud Projector / Flash Grenades
          if (gapBetween(u, e, ctx) > 24) continue;
          if (!legalTargets.some((t) => t.id === e.id)) continue;
          const ev = shootingEV(state, u, e, ctx) * 0.28;
          if (!best || ev > best.ev) best = { unitId: u.id, targetId: e.id, ev };
        }
      }
      if (best && best.ev >= profile.reactThreshold) {
        const { unitId, targetId } = best;
        plays.push({
          intent: { type: 'FireOverwatch', unitId, targetUnitId: targetId },
          skipIf: (s) =>
            s.cp[defendingSide] < 1 ||
            !s.units.find((x) => x.id === targetId)?.models.some((m) => m.alive),
        });
      }
    }
    return plays;
  }

  if (state.phase === 'Charge') {
    if (state.stratUsed?.[`${defendingSide}:core:heroic_intervention`] === `${state.round}:${state.activePlayer}:${state.phase}`) return [];
    let best: { unitId: string; targetId: string; score: number } | null = null;
    for (const u of state.units) {
      if (u.owner !== defendingSide || !isOnBoard(u)) continue;
      const ds = ctx.datasheets.get(u.datasheetId);
      if (!ds) continue;
      const kws = ds.keywords.map((k) => k.toLowerCase());
      if (kws.includes('vehicle') && !kws.includes('character') && !kws.includes('walker')) continue;
      if (engagedEnemies(u, state, ctx).length > 0) continue;
      if (unitRolePlan(u, ctx).chargeWeight <= 0) continue; // snipers/artillery stay put
      for (const e of state.units) {
        if (e.owner === defendingSide || !isOnBoard(e) || !e.status.charged) continue;
        const gap = gapBetween(u, e, ctx);
        if (gap > 12) continue;
        const score = meleeEV(u, e, ctx, true) - meleeEV(e, u, ctx) * profile.caution * 0.5;
        if (score <= profile.reactThreshold) continue;
        if (!chargePathExists(state, u.id, [e.id], ctx)) continue;
        if (!best || score > best.score) best = { unitId: u.id, targetId: e.id, score };
      }
    }
    if (!best) return [];
    const { unitId, targetId } = best;
    return [
      {
        intent: { type: 'Charge', chargerUnitId: unitId, targetUnitIds: [targetId], heroic: 'leap_to_defend' },
        skipIf: (s) =>
          s.cp[defendingSide] < 1 ||
          !s.units.find((x) => x.id === targetId)?.models.some((m) => m.alive),
      },
    ];
  }
  return [];
}

/**
 * Counteroffensive (15.12) — called just AFTER an enemy unit resolves its Fight attacks (the
 * runner and the UI both call this): if one of our un-fought engaged units is about to be
 * wrecked by another un-fought enemy before its own activation, spend 2 CP to swing first.
 */
export function aiReactionToFight(
  state: GameState,
  defendingSide: Side,
  profile: AiProfile,
  deps: AiDeps,
): AiIntent[] {
  const { ctx } = deps;
  if (state.mode !== 'match' || state.stage !== 'battle' || state.phase !== 'Fight') return [];
  if (state.activePlayer === defendingSide) return [];
  if (state.cp[defendingSide] < 2 || state.fightNext) return [];
  if (state.stratUsed?.[`${defendingSide}:core:counter_offensive`] === `${state.round}:${state.activePlayer}:${state.phase}`) return [];

  let best: { unitId: string; score: number } | null = null;
  for (const u of state.units) {
    if (u.owner !== defendingSide || !isOnBoard(u) || u.status.hasFought) continue;
    const engaged = engagedEnemies(u, state, ctx);
    if (engaged.length === 0) continue;
    // How hard do the un-fought enemies engaged with us hit if they swing first?
    const threat = Math.max(0, ...engaged.filter((e) => !e.status.hasFought).map((e) => meleeEV(e, u, ctx)));
    if (threat < unitValue(u, ctx) * 0.4) continue; // we'd probably survive — hold the CP
    // Swinging first must actually matter — but this is a defensive tempo play, so the bar is
    // half the offensive react threshold.
    const ourSwing = Math.max(0, ...engaged.map((e) => meleeEV(u, e, ctx)));
    if (ourSwing < profile.reactThreshold * 0.5) continue;
    const score = threat + ourSwing;
    if (!best || score > best.score) best = { unitId: u.id, score };
  }
  if (!best) return [];
  const { unitId } = best;
  return [
    {
      intent: { type: 'Counteroffensive', unitId },
      skipIf: (s) => {
        const u = s.units.find((x) => x.id === unitId);
        return s.cp[defendingSide] < 2 || !u || !!u.status.hasFought || !u.models.some((m) => m.alive);
      },
    },
  ];
}
