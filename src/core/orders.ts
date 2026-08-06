// Astra Militarum Orders + the Officer "Voice of Command" mechanic, and the bits of the two owned
// detachment rules that read off unit status. PURE — imports only types (no engine, to avoid cycles;
// the range-based `orderableUnits` lives in phases.ts, which already depends on the engine geometry).
//
// Orders (10e): an Officer issues Orders in the Command phase to friendly REGIMENT units within 6".
// An affected unit keeps the Order until the start of your next Command phase (one Order at a time;
// Battle-shocked units cannot receive Orders). Each Order is modelled as an effect id added to the
// unit's `activeEffects`, which the combat pipeline (effects.ts) and the helpers below read.

import type { Datasheet, UnitInstance } from './types';
import { extraOrderIdsFor, grantsOfficer } from './enhancements';

export interface OrderDef {
  id: string;
  name: string;
  /** Effect id added to the target's activeEffects (see EFFECT_REGISTRY / the helpers below). */
  effectId: string;
  desc: string;
}

/** The six universal Astra Militarum Orders (10e). */
export const AM_ORDERS: OrderDef[] = [
  { id: 'take_aim', name: 'Take Aim!', effectId: 'order:take_aim', desc: '+1 to Hit with ranged weapons' },
  { id: 'fix_bayonets', name: 'Fix Bayonets!', effectId: 'order:fix_bayonets', desc: '+1 to Hit with melee weapons' },
  { id: 'first_rank', name: 'First Rank, Fire! Second Rank, Fire!', effectId: 'order:first_rank_fire', desc: '+1 Attack to Rapid Fire weapons' },
  { id: 'take_cover', name: 'Take Cover!', effectId: 'order:take_cover', desc: '+1 to Save (max 3+)' },
  { id: 'move', name: 'Move! Move! Move!', effectId: 'order:move_move_move', desc: '+3" Move' },
  { id: 'duty', name: 'Duty and Honour!', effectId: 'order:duty_and_honour', desc: '+1 Leadership and +1 Objective Control' },
];

/** Enhancement-unlocked Orders (offered only when the issuing officer carries the enhancement). */
export const ENHANCEMENT_ORDERS: OrderDef[] = [
  { id: 'target_weak_spot', name: 'Target Weak Spot (Aquilan Eye)', effectId: 'order:target_weak_spot', desc: '+1 AP against targets within 12"' },
  { id: 'move_to_shadows', name: 'Move to the Shadows (Spec Ops Veteran)', effectId: 'order:move_to_shadows', desc: 'Stealth against ranged attacks' },
];

/** The Orders this officer unit can pick from: the universal six, plus its enhancement's. */
export function ordersAvailableTo(officer: UnitInstance): OrderDef[] {
  const extra = extraOrderIdsFor(officer);
  return [...AM_ORDERS, ...ENHANCEMENT_ORDERS.filter((o) => extra.includes(o.effectId))];
}

const ORDER_EFFECT_IDS = new Set([...AM_ORDERS, ...ENHANCEMENT_ORDERS].map((o) => o.effectId));

const effectsOf = (u: UnitInstance): string[] => u.status.activeEffects ?? [];

/** Is this unit currently affected by any Order? (Grizzled Company's re-roll keys off this.) */
export function hasActiveOrder(u: UnitInstance): boolean {
  return effectsOf(u).some((e) => ORDER_EFFECT_IDS.has(e));
}

/** Extra inches of movement from an active Order (Move! Move! Move! grants +3"). */
export function moveBonusFromOrders(u: UnitInstance): number {
  return effectsOf(u).includes('order:move_move_move') ? 3 : 0;
}

/** +Objective Control from Orders / detachment buffs (Duty and Honour!, Acquire At All Costs). */
export function ocBonusFromOrders(u: UnitInstance): number {
  const e = effectsOf(u);
  return (
    (e.includes('order:duty_and_honour') ? 1 : 0) +
    (e.includes('acquire_buff') ? 1 : 0) +
    (e.includes('cp:oc_plus1') ? 1 : 0) // For the Lion (Vengeful Brethren)
  );
}

/** +Leadership from Orders / detachment buffs (improves the Battle-shock test). */
export function ldBonusFromOrders(u: UnitInstance): number {
  const e = effectsOf(u);
  return (e.includes('order:duty_and_honour') ? 1 : 0) + (e.includes('acquire_buff') ? 1 : 0);
}

/** An Officer model can issue Orders (has the Voice of Command ability or the OFFICER keyword). */
export function isOfficer(ds: Datasheet | undefined, abilityNames: string[] = []): boolean {
  if (!ds) return false;
  if (ds.keywords.some((k) => k.toLowerCase() === 'officer')) return true;
  return abilityNames.some((a) => a.toLowerCase().includes('voice of command'));
}

/**
 * Does this live unit contain an Officer — its own datasheet, OR a merged attached Leader's?
 * An attached Officer keeps Voice of Command (10e): Yarrick merged into a Death Korps squad
 * still issues Orders. The Leader-merge replaces the Officer's unit instance, so any scan that
 * only reads `unit.datasheetId` goes blind the moment the Officer joins a squad.
 */
export function unitIsOfficer(
  u: UnitInstance,
  ctx: { datasheets: Map<string, Datasheet> },
): boolean {
  // Battalion Commander (Steel Hammer): the bearer gains Voice of Command / OFFICER.
  if (grantsOfficer(u)) return true;
  const officerDs = (id: string): boolean => {
    const ds = ctx.datasheets.get(id);
    return isOfficer(ds, (ds?.abilities ?? []).map((a) => a.name));
  };
  if (officerDs(u.datasheetId)) return true;
  return (u.attachedLeaders ?? []).some((l) => officerDs(l.datasheetId));
}

/** A unit can receive Orders if it has the REGIMENT keyword and is not Battle-shocked. */
export function canReceiveOrders(ds: Datasheet | undefined, u: UnitInstance): boolean {
  if (!ds || u.status.battleShocked) return false;
  return ds.keywords.some((k) => k.toLowerCase() === 'regiment');
}
