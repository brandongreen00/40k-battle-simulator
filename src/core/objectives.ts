// Objective control and Primary scoring (plan §4). PURE — no React, no DOM.
//
// Objective control = the side with the greater total Objective Control (OC) of models within
// range of the marker controls it (10e: "within range of an objective marker"). Ties leave the
// objective contested (no controller this check). Primary scoring is the Pariah Nexus
// "hold objectives" engine: VP per controlled objective, capped per turn and overall.

import type { Side, Vec2 } from './types';
import { baseToBaseGap } from './geometry';

/** A model's contribution to objective control. */
export interface OcModel {
  pos: Vec2;
  oc: number;
  radius: number; // base radius, inches
  owner: Side;
}

export interface ObjectiveControl {
  player: number; // total OC in range, player side
  ai: number;
  controller: Side | null; // strictly-greater side; null when contested/empty
}

/**
 * Resolve who controls one objective marker. A model is "in range" when its base is within
 * `controlRadius` of the marker (measured base-to-marker, the marker treated as a circle).
 */
export function controlOfObjective(
  marker: Vec2,
  markerRadius: number,
  controlRadius: number,
  models: OcModel[],
): ObjectiveControl {
  let player = 0;
  let ai = 0;
  for (const m of models) {
    if (m.oc <= 0) continue;
    const gap = baseToBaseGap(m.pos, m.radius, marker, markerRadius);
    if (gap <= controlRadius) {
      if (m.owner === 'player') player += m.oc;
      else ai += m.oc;
    }
  }
  const controller = player > ai ? 'player' : ai > player ? 'ai' : null;
  return { player, ai, controller };
}

export interface PrimaryScoring {
  perObjective: number; // VP per controlled objective (5 in Pariah Nexus)
  perTurnCap: number; // max primary VP a side can score per turn (15)
  totalCap: number; // max primary VP overall (50)
}

export const PARIAH_NEXUS_PRIMARY: PrimaryScoring = { perObjective: 5, perTurnCap: 15, totalCap: 50 };

/**
 * Primary VP a side scores this turn for controlling `controlledCount` objectives, respecting the
 * per-turn cap and the side's running `currentTotal` against the overall cap.
 */
export function scorePrimary(
  controlledCount: number,
  currentTotal: number,
  scoring: PrimaryScoring = PARIAH_NEXUS_PRIMARY,
): number {
  const thisTurn = Math.min(controlledCount * scoring.perObjective, scoring.perTurnCap);
  const room = Math.max(0, scoring.totalCap - currentTotal);
  return Math.min(thisTurn, room);
}
