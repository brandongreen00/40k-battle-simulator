// Reaction-window detection for the HUMAN player. PURE.
//
// The engine has reactive windows (architecture rule #3) — Fire Overwatch at the end of the
// opponent's Movement, defensive stratagems when targeted, Heroic Intervention, Counteroffensive,
// Gate of Infinity… — but an auto-playing AI turn used to blow straight past them: the human
// never got a chance to act. These detectors answer "could the human react RIGHT NOW?" so the
// UI can pause the AI and prompt. They mirror the reducer's gates loosely — over-offering is
// harmless (the reducer stays the enforcer); missing a window is what these exist to prevent.

import type { GameState, Side, UnitInstance } from '../types';
import type { EngineContext } from '../engine';
import { engagedEnemies, gapBetween, isOnBoard } from '../phases';
import { pointInPolygon } from '../geometry';

const phaseKeyOf = (s: GameState) => `${s.round}:${s.activePlayer}:${s.phase}`;
const otherSide = (s: Side): Side => (s === 'player' ? 'ai' : 'player');

/** One available reactive play, for display in the prompt panel. */
export interface ReactionWindow {
  id: string;
  label: string;
  hint: string;
}

function stratFree(state: GameState, side: Side, key: string): boolean {
  return state.stratUsed?.[`${side}:${key}`] !== phaseKeyOf(state);
}

/**
 * Reactive plays `side` (the NON-active player) could make before the CURRENT phase ends.
 * Used to hold the opponent's AdvancePhase and prompt: the phase has not advanced yet, so all
 * the panel's usual controls (Stratagem plays / Unit abilities / the stratagem list) stay live.
 */
export function phaseEndReactions(state: GameState, side: Side, ctx: EngineContext): ReactionWindow[] {
  if (state.mode !== 'match' || state.stage !== 'battle' || state.ended) return [];
  if (state.activePlayer === side) return [];
  const out: ReactionWindow[] = [];
  const cp = state.cp[side];
  const mine = state.units.filter((u) => u.owner === side && isOnBoard(u));
  const theirs = state.units.filter((u) => u.owner !== side && isOnBoard(u));

  if (state.phase === 'Movement' && cp >= 1) {
    // Fire Overwatch (15.08): an unengaged non-TITANIC unit with an enemy within 24".
    if (stratFree(state, side, 'core:fire_overwatch')) {
      const can = mine.some(
        (u) =>
          !ctx.datasheets.get(u.datasheetId)?.keywords.some((k) => k.toLowerCase() === 'titanic') &&
          engagedEnemies(u, state, ctx).length === 0 &&
          theirs.some((e) => gapBetween(u, e, ctx) <= 24),
      );
      if (can) {
        out.push({
          id: 'overwatch',
          label: 'Fire Overwatch (1 CP)',
          hint: 'Snap-shoot an enemy within 24" before the Movement phase ends — pick the shooter and target in the Stratagem plays block.',
        });
      }
    }
    // Rapid Ingress (15.07) — banned in Combat Patrol.
    if (
      state.battleType !== 'combat_patrol' &&
      state.round >= 2 &&
      stratFree(state, side, 'core:rapid_ingress') &&
      state.units.some((u) => u.owner === side && u.inReserves && !u.embarkedIn && u.models.some((m) => m.alive))
    ) {
      out.push({
        id: 'rapid_ingress',
        label: 'Rapid Ingress (1 CP)',
        hint: 'Bring a Reserves unit on at the end of the opponent\'s Movement phase — use the Stratagem plays block.',
      });
    }
  }

  if (state.phase === 'Charge' && cp >= 1 && stratFree(state, side, 'core:heroic_intervention')) {
    // Heroic Intervention (15.11): an unengaged non-VEHICLE (or CHARACTER/WALKER) unit within
    // 12" of an enemy that charged this turn (6" reaches any enemy via Into the Fray at 2 CP).
    const can = mine.some((u) => {
      const kws = ctx.datasheets.get(u.datasheetId)?.keywords.map((k) => k.toLowerCase()) ?? [];
      if (kws.includes('vehicle') && !kws.includes('character') && !kws.includes('walker')) return false;
      if (engagedEnemies(u, state, ctx).length > 0) return false;
      return theirs.some(
        (e) => (e.status.charged && gapBetween(u, e, ctx) <= 12) || (cp >= 2 && gapBetween(u, e, ctx) <= 6),
      );
    });
    if (can) {
      out.push({
        id: 'heroic',
        label: 'Heroic Intervention (1–2 CP)',
        hint: 'Counter-charge a unit that charged this turn — pick the unit and target in the Stratagem plays block.',
      });
    }
  }

  if (state.phase === 'Fight' && state.battleType === 'combat_patrol') {
    // Gate of Infinity (Crowe's Sanctifiers): at the end of the opponent's Fight phase, an
    // unengaged unit returns to Strategic Reserves.
    if (stratFree(state, side, 'cp:gate_of_infinity')) {
      const can = mine.some(
        (u) =>
          ctx.datasheets.get(u.datasheetId)?.patrol === 'crowes_sanctifiers' &&
          engagedEnemies(u, state, ctx).length === 0,
      );
      if (can) {
        out.push({
          id: 'gate',
          label: 'Gate of Infinity',
          hint: 'Pull an unengaged Grey Knights unit back into Strategic Reserves — use the Unit abilities block.',
        });
      }
    }
    // Swift Embarkation (Sudden Dawn Cadre): an unengaged INFANTRY unit within 6" of a friendly
    // TRANSPORT embarks at the end of the opponent's Fight phase.
    if (cp >= 1 && stratFree(state, side, 'cp:sudden_dawn_cadre:swift_embarkation')) {
      const transports = mine.filter((u) =>
        ctx.datasheets.get(u.datasheetId)?.keywords.some((k) => k.toUpperCase() === 'TRANSPORT'),
      );
      const can =
        transports.length > 0 &&
        mine.some((u) => {
          const ds = ctx.datasheets.get(u.datasheetId);
          if (ds?.patrol !== 'sudden_dawn_cadre') return false;
          if (!ds.keywords.some((k) => k.toUpperCase() === 'INFANTRY')) return false;
          if (engagedEnemies(u, state, ctx).length > 0) return false;
          return transports.some((t) => t.id !== u.id && gapBetween(u, t, ctx) <= 6);
        });
      if (can) {
        out.push({
          id: 'swift_embark',
          label: 'Swift Embarkation (1 CP)',
          hint: 'An unengaged unit within 6" of the Devilfish may embark — use the Stratagems list.',
        });
      }
    }
  }

  return out;
}

/** Counteroffensive (15.12): before the opponent's next Fight activation, `side` could pay 2 CP
 *  to swing first with an un-fought engaged unit. */
export function counteroffensiveCandidates(state: GameState, side: Side, ctx: EngineContext): UnitInstance[] {
  if (state.mode !== 'match' || state.stage !== 'battle' || state.ended) return [];
  if (state.phase !== 'Fight' || state.activePlayer === side) return [];
  if (state.cp[side] < 2 || state.fightNext) return [];
  if (!stratFree(state, side, 'core:counter_offensive')) return [];
  return state.units.filter(
    (u) => u.owner === side && isOnBoard(u) && !u.status.hasFought && engagedEnemies(u, state, ctx).length > 0,
  );
}

/** Determined to the Last (Vengeful Brethren): the targeted Bladeguard may pay 1 CP so its
 *  destroyed models fight before removal. Available when the enemy targets them in melee. */
export function determinedAvailable(state: GameState, targetUnitId: string, ctx: EngineContext): boolean {
  if (state.battleType !== 'combat_patrol' || state.phase !== 'Fight') return false;
  const target = state.units.find((u) => u.id === targetUnitId);
  if (!target || !isOnBoard(target) || target.status.hasFought) return false;
  const ds = ctx.datasheets.get(target.datasheetId);
  if (ds?.patrol !== 'vengeful_brethren' || !ds.name.toLowerCase().includes('bladeguard')) return false;
  if (state.cp[target.owner] < 1) return false;
  if (target.status.activeEffects?.includes('cp:fights_on_death')) return false;
  return stratFree(state, target.owner, 'cp:vengeful_brethren:determined_to_the_last');
}

/** Patrol defensive stratagems the targeted unit could play against an incoming volley —
 *  offered in the Incoming fire panel beside Smokescreen / Go to Ground. */
export function volleyDefensiveCards(
  state: GameState,
  target: UnitInstance,
  ctx: EngineContext,
): { stratagemId: string; name: string; effectId: string; hint: string }[] {
  if (state.battleType !== 'combat_patrol' || state.cp[target.owner] < 1) return [];
  const ds = ctx.datasheets.get(target.datasheetId);
  if (!ds) return [];
  const out: { stratagemId: string; name: string; effectId: string; hint: string }[] = [];
  if (
    ds.patrol === 'crowes_sanctifiers' &&
    ds.name.toLowerCase().includes('strike squad') &&
    !target.status.activeEffects?.includes('cp:wound_shield_strong') &&
    stratFree(state, target.owner, 'cp:crowes_sanctifiers:refusal_to_yield')
  ) {
    out.push({
      stratagemId: 'cp:crowes_sanctifiers:refusal_to_yield',
      name: 'Refusal to Yield',
      effectId: 'cp:wound_shield_strong',
      hint: 'Ranged attacks with S greater than the unit\'s T get -1 to wound this phase.',
    });
  }
  if (
    ds.patrol === 'inquisitors_hand' &&
    !target.status.activeEffects?.includes('cp:ap_shield') &&
    stratFree(state, target.owner, 'cp:inquisitors_hand:urban_enforcers')
  ) {
    const alive = target.models.filter((m) => m.alive);
    const inOneArea = (state.layout.terrainAreas ?? []).some((a) =>
      alive.every((m) => pointInPolygon(m.pos, a.polygon)),
    );
    if (inOneArea) {
      out.push({
        stratagemId: 'cp:inquisitors_hand:urban_enforcers',
        name: 'Urban Enforcers',
        effectId: 'cp:ap_shield',
        hint: 'Every model is within a terrain area: incoming attacks lose 1 AP this phase.',
      });
    }
  }
  return out;
}

/** The human side that could be prompted right now (the non-active seat), or null when both
 *  seats are AI / the active player IS the human. */
export function promptableDefender(state: GameState, humanSeats: Record<Side, boolean>): Side | null {
  if (state.mode !== 'match' || state.stage !== 'battle' || state.ended) return null;
  const defender = otherSide(state.activePlayer);
  return humanSeats[defender] ? defender : null;
}
