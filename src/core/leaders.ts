// Leader attachment (10e Core Rules — Leaders). PURE — no React, no DOM.
//
// A CHARACTER unit with the Leader ability can be attached to one eligible Bodyguard unit during
// the Declare Battle Formations step (we surface it during deployment). While attached they form a
// single "Attached unit": they move and are targeted together, and the Leader cannot usually be
// picked as a target while the Bodyguard has other models (Precision is the exception).
//
// The converted datasheet data already carries the pairing both ways:
//   • leader.canLead     — bodyguard datasheet ids this character may join
//   • bodyguard.canBeLedBy — character datasheet ids that may join this unit
// e.g. a Rogue Trader can lead an Imperial Navy Breachers unit. We treat a pairing as legal if
// EITHER side lists the other (the export is occasionally one-directional).

import type { Datasheet } from './types';

const dedupe = (xs: string[] | undefined): string[] => [...new Set(xs ?? [])];

export function isCharacter(ds: Datasheet | undefined): boolean {
  return !!ds?.keywords.some((k) => k.toLowerCase() === 'character');
}

/** Can `leader` attach to `bodyguard`? Both must exist, leader must be a Character, and the data
 *  must pair them in at least one direction. */
export function canAttach(leader: Datasheet | undefined, bodyguard: Datasheet | undefined): boolean {
  if (!leader || !bodyguard || leader.id === bodyguard.id) return false;
  if (!isCharacter(leader)) return false;
  const byLead = dedupe(leader.canLead).includes(bodyguard.id);
  const byLedBy = dedupe(bodyguard.canBeLedBy).includes(leader.id);
  return byLead || byLedBy;
}

/** Datasheet ids of every bodyguard `leader` may join. */
export function eligibleBodyguardIds(leader: Datasheet | undefined, all: Map<string, Datasheet>): string[] {
  if (!leader || !isCharacter(leader)) return [];
  const ids = new Set<string>(dedupe(leader.canLead));
  for (const ds of all.values()) {
    if (dedupe(ds.canBeLedBy).includes(leader.id)) ids.add(ds.id);
  }
  return [...ids].filter((id) => all.has(id));
}

/** Datasheet ids of every Character that may lead `bodyguard`. */
export function eligibleLeaderIds(bodyguard: Datasheet | undefined, all: Map<string, Datasheet>): string[] {
  if (!bodyguard) return [];
  const ids = new Set<string>(dedupe(bodyguard.canBeLedBy));
  for (const ds of all.values()) {
    if (dedupe(ds.canLead).includes(bodyguard.id)) ids.add(ds.id);
  }
  return [...ids].filter((id) => {
    const ds = all.get(id);
    return ds && isCharacter(ds);
  });
}
