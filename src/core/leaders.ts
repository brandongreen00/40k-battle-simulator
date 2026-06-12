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

import type { BaseShape, Datasheet, Vec2 } from './types';
import { baseRadius, gapBetweenBases } from './geometry';

const dedupe = (xs: string[] | undefined): string[] => [...new Set(xs ?? [])];

/**
 * Positions for a Leader's models when it attaches: the Leader physically joins the Bodyguard,
 * so each Leader model is placed in base-to-base coherency distance (< 2") of the unit, without
 * overlapping any existing model. Searches rings around the bodyguard models (and around already
 * placed leader models) at growing gaps; falls back to the first anchor if the area is packed.
 * `legal` (optional) constrains candidates further — e.g. wholly within the deployment zone when
 * attaching during deployment.
 */
export function leaderJoinPositions(
  count: number,
  leaderShape: BaseShape,
  bodyguardModels: Vec2[],
  bodyguardShape: BaseShape,
  occupied: { pos: Vec2; shape: BaseShape }[],
  board: { width: number; height: number },
  legal?: (pos: Vec2) => boolean,
): Vec2[] {
  const rL = baseRadius(leaderShape);
  const placed: Vec2[] = [];
  const occ = [...occupied];
  for (let k = 0; k < count; k++) {
    const anchors = [
      ...bodyguardModels.map((pos) => ({ pos, shape: bodyguardShape })),
      ...placed.map((pos) => ({ pos, shape: leaderShape })),
    ];
    let found: Vec2 | null = null;
    let fallback: Vec2 | null = null; // best candidate ignoring `legal`, if nothing legal fits
    outer: for (const gap of [0.2, 0.5, 1, 1.5, 1.9]) {
      for (const a of anchors) {
        const dist = baseRadius(a.shape) + rL + gap;
        for (let i = 0; i < 16; i++) {
          const ang = (i / 16) * 2 * Math.PI;
          const c = { x: a.pos.x + Math.cos(ang) * dist, y: a.pos.y + Math.sin(ang) * dist };
          if (c.x < rL || c.y < rL || c.x > board.width - rL || c.y > board.height - rL) continue;
          if (occ.some((o) => gapBetweenBases(c, leaderShape, o.pos, o.shape) < 0.05)) continue;
          if (legal && !legal(c)) {
            fallback ??= c;
            continue;
          }
          found = c;
          break outer;
        }
      }
    }
    const c = found ?? fallback ?? bodyguardModels[0] ?? { x: 0, y: 0 };
    placed.push(c);
    occ.push({ pos: c, shape: leaderShape });
  }
  return placed;
}

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
