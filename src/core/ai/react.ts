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
import { engagedEnemies, gapBetween, isOnBoard } from '../phases';
import { chargePathExists } from '../engine';
import { meleeEV, shootingEV, unitValue } from './evaluate';
import { unitRolePlan } from './roles';
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
  if (!smoke && !infantry) return [];

  const incoming = shootingEV(state, attacker, target, ctx);
  const value = unitValue(target, ctx);
  if (incoming < profile.reactThreshold && incoming < value * 0.4) return [];

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
    if (state.stratUsed?.[`${defendingSide}:core:fire_overwatch`] === `${state.round}:${state.activePlayer}:${state.phase}`) return [];
    // Best (shooter, target): snap shooting hits only on unmodified 6s — roughly a quarter of
    // normal output, so demand a real payoff before spending the CP.
    let best: { unitId: string; targetId: string; ev: number } | null = null;
    for (const u of state.units) {
      if (u.owner !== defendingSide || !isOnBoard(u)) continue;
      const ds = ctx.datasheets.get(u.datasheetId);
      if (!ds || ds.keywords.some((k) => k.toLowerCase() === 'titanic')) continue;
      if (engagedEnemies(u, state, ctx).length > 0) continue;
      for (const e of state.units) {
        if (e.owner === defendingSide || !isOnBoard(e)) continue;
        if (gapBetween(u, e, ctx) > 24) continue;
        const ev = shootingEV(state, u, e, ctx) * 0.28;
        if (!best || ev > best.ev) best = { unitId: u.id, targetId: e.id, ev };
      }
    }
    if (!best || best.ev < profile.reactThreshold) return [];
    const { unitId, targetId } = best;
    return [
      {
        intent: { type: 'FireOverwatch', unitId, targetUnitId: targetId },
        skipIf: (s) =>
          s.cp[defendingSide] < 1 ||
          !s.units.find((x) => x.id === targetId)?.models.some((m) => m.alive),
      },
    ];
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
