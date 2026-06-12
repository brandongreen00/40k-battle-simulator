// Pariah Nexus Tactical (Secondary) Missions. PURE — no React, no DOM, no I/O.
//
// Why this exists: primary-only scoring (50 VP for standing on markers) systematically favours
// whichever list brings more OC bodies — elite/tank lists had no scoring outlet for doing what
// they are good at. Secondaries add the missing 40 VP.
//
// Model: each side has its OWN shuffled 12-card deck (seeded RNG — games stay reproducible).
// At the start of your turn (Run Command) you discard stale cards and draw back up to a 2-card
// hand; cards score automatically at the relevant turn end and are discarded when scored.
// Secondary VP is capped at 40 (50 primary + 40 secondary = 90; no paint score).
//
// Scope/fidelity notes (owner-correctable in ONE place — the card table below):
//  • The deck is the subset of the Pariah Nexus deck computable from game state. Cards that need
//    the Actions mechanic (Cleanse, Sabotage, Containment, Establish Locus, Recover Assets) are
//    NOT implemented — the engine has no Actions yet.
//  • VP values are best-effort readings of the official cards; treat them as data to correct.
//  • "Wholly within" uses model centre points (same simplification as LoS, noted there).
//  • Stale rule: an unscored card held for 2+ of your own turns is auto-discarded at your next
//    Command phase (the real rule is a discard CHOICE at end of turn; this keeps the reducer free
//    of an extra decision point — humans can also discard manually via the DiscardSecondary
//    intent at any time in their turn).

import type { EngineContext } from './engine';
import { objectiveControl } from './engine';
import type { GameState, KillRecord, SecondarySideState, Side, UnitInstance, Vec2 } from './types';
import type { RNG } from './rng';
import { zoneFor } from './deployment';
import { dist, pointInPolygon } from './geometry';
import { otherSide } from './setup';

export const SECONDARY_VP_CAP = 40;
const HAND_SIZE = 2;
const STALE_AGE = 2; // own turns an unscored card survives before the auto-discard

export interface SecondaryCard {
  id: string;
  name: string;
  /** When the card is checked: the end of YOUR turn, your OPPONENT's turn, or every turn. */
  scoreAt: 'your_turn' | 'opponent_turn' | 'either';
  /** Short rule text for the UI/log. */
  desc: string;
  /** VP scored at the relevant turn end (0 = not scored; the card stays in hand). */
  score: (state: GameState, side: Side, ctx: EngineContext) => number;
}

// ── shared evaluator helpers ──────────────────────────────────────────────────
/** This turn's kills OF the given side's ENEMIES (what `side`'s kill cards score from). */
function killsBy(state: GameState, side: Side): KillRecord[] {
  return (state.turnKills ?? []).filter((k) => k.side === otherSide(side));
}

function hasKeyword(ctx: EngineContext, datasheetIds: string[], kw: string): boolean {
  return datasheetIds.some((id) =>
    ctx.datasheets.get(id)?.keywords.some((k) => k.toLowerCase() === kw.toLowerCase()),
  );
}

/** Per-objective info relative to `side`: position, current controller, and whose territory. */
function objectiveInfo(state: GameState, side: Side, ctx: EngineContext) {
  const { perObjective } = objectiveControl(state, ctx);
  const own = zoneFor(state.layout, side);
  const enemy = zoneFor(state.layout, otherSide(side));
  return state.layout.objectives.map((pos, i) => ({
    pos,
    controller: perObjective[i]?.controller ?? null,
    territory: (own.length && pointInPolygon(pos, own)
      ? 'own'
      : enemy.length && pointInPolygon(pos, enemy)
        ? 'enemy'
        : 'nml') as 'own' | 'enemy' | 'nml',
  }));
}

const aliveOnBoard = (u: UnitInstance): boolean => !u.inReserves && u.models.some((m) => m.alive);

/** All of a unit's alive model centres inside the polygon ("wholly within", centre-point model). */
function whollyWithin(u: UnitInstance, polygon: Vec2[]): boolean {
  if (polygon.length === 0) return false;
  const alive = u.models.filter((m) => m.alive);
  return alive.length > 0 && alive.every((m) => pointInPolygon(m.pos, polygon));
}

// ── the deck ──────────────────────────────────────────────────────────────────
export const SECONDARY_CARDS: SecondaryCard[] = [
  {
    id: 'assassination',
    name: 'Assassination',
    scoreAt: 'either',
    desc: '5VP for each enemy CHARACTER unit destroyed this turn',
    score: (s, side, ctx) =>
      killsBy(s, side).filter((k) => hasKeyword(ctx, k.datasheetIds, 'character')).length * 5,
  },
  {
    id: 'bring_it_down',
    name: 'Bring It Down',
    scoreAt: 'either',
    desc: '4VP per enemy MONSTER/VEHICLE unit destroyed this turn (+3 if 15+ Wounds)',
    score: (s, side, ctx) =>
      killsBy(s, side)
        .filter((k) => hasKeyword(ctx, k.datasheetIds, 'monster') || hasKeyword(ctx, k.datasheetIds, 'vehicle'))
        .reduce((vp, k) => vp + 4 + (k.maxWounds >= 15 ? 3 : 0), 0),
  },
  {
    id: 'no_prisoners',
    name: 'No Prisoners',
    scoreAt: 'either',
    desc: '2VP per enemy unit destroyed this turn (max 6)',
    score: (s, side) => Math.min(6, killsBy(s, side).length * 2),
  },
  {
    id: 'overwhelming_force',
    name: 'Overwhelming Force',
    scoreAt: 'either',
    desc: '3VP per enemy unit destroyed this turn that was on an objective (max 9)',
    score: (s, side) => Math.min(9, killsBy(s, side).filter((k) => k.onObjective).length * 3),
  },
  {
    id: 'behind_enemy_lines',
    name: 'Behind Enemy Lines',
    scoreAt: 'your_turn',
    desc: 'End of your turn: 1 unit wholly within the enemy deployment zone = 3VP, 2+ = 5VP',
    score: (s, side) => {
      const zone = zoneFor(s.layout, otherSide(side));
      const n = s.units.filter((u) => u.owner === side && aliveOnBoard(u) && whollyWithin(u, zone)).length;
      return n >= 2 ? 5 : n === 1 ? 3 : 0;
    },
  },
  {
    id: 'engage_all_fronts',
    name: 'Engage on All Fronts',
    scoreAt: 'your_turn',
    desc: 'End of your turn: units wholly within a table quarter, >6" from the centre — 3 quarters = 2VP, 4 = 5VP',
    score: (s, side) => {
      const cx = s.layout.boardWidth / 2;
      const cy = s.layout.boardHeight / 2;
      const quarters = new Set<number>();
      for (const u of s.units) {
        if (u.owner !== side || !aliveOnBoard(u)) continue;
        const alive = u.models.filter((m) => m.alive);
        const qs = new Set(alive.map((m) => (m.pos.x < cx ? 0 : 1) + (m.pos.y < cy ? 0 : 2)));
        if (qs.size !== 1) continue; // not wholly within one quarter
        if (!alive.every((m) => dist(m.pos, { x: cx, y: cy }) > 6)) continue;
        quarters.add([...qs][0]!);
      }
      return quarters.size >= 4 ? 5 : quarters.size === 3 ? 2 : 0;
    },
  },
  {
    id: 'area_denial',
    name: 'Area Denial',
    scoreAt: 'your_turn',
    desc: 'End of your turn: no enemy models within 3" of the centre = 2VP, none within 6" = 5VP',
    score: (s, side) => {
      const centre = { x: s.layout.boardWidth / 2, y: s.layout.boardHeight / 2 };
      let nearest = Infinity;
      for (const u of s.units) {
        if (u.owner === side || u.inReserves) continue;
        for (const m of u.models) if (m.alive) nearest = Math.min(nearest, dist(m.pos, centre));
      }
      // Own presence required — denying an empty centre from your deployment zone scores nothing.
      const minePresent = s.units.some(
        (u) => u.owner === side && aliveOnBoard(u) && u.models.some((m) => m.alive && dist(m.pos, centre) <= 9),
      );
      if (!minePresent) return 0;
      return nearest > 6 ? 5 : nearest > 3 ? 2 : 0;
    },
  },
  {
    id: 'secure_no_mans_land',
    name: 'Secure No Man’s Land',
    scoreAt: 'your_turn',
    desc: 'End of your turn: control 1 objective in no man’s land = 2VP, 2+ = 5VP',
    score: (s, side, ctx) => {
      const n = objectiveInfo(s, side, ctx).filter((o) => o.territory === 'nml' && o.controller === side).length;
      return n >= 2 ? 5 : n === 1 ? 2 : 0;
    },
  },
  {
    id: 'extend_battle_lines',
    name: 'Extend Battle Lines',
    scoreAt: 'your_turn',
    desc: 'End of your turn: control 1+ objective in your territory AND 1+ in no man’s land = 5VP (own only = 2VP)',
    score: (s, side, ctx) => {
      const info = objectiveInfo(s, side, ctx);
      const own = info.some((o) => o.territory === 'own' && o.controller === side);
      const nml = info.some((o) => o.territory === 'nml' && o.controller === side);
      return own && nml ? 5 : own ? 2 : 0;
    },
  },
  {
    id: 'capture_enemy_outpost',
    name: 'Capture Enemy Outpost',
    scoreAt: 'your_turn',
    desc: 'End of your turn: control 1+ objective in the enemy deployment zone = 8VP',
    score: (s, side, ctx) =>
      objectiveInfo(s, side, ctx).some((o) => o.territory === 'enemy' && o.controller === side) ? 8 : 0,
  },
  {
    id: 'storm_hostile_objective',
    name: 'Storm Hostile Objective',
    scoreAt: 'your_turn',
    desc: 'End of your turn: control an objective the opponent controlled at the start of the turn = 4VP',
    score: (s, side, ctx) => {
      const snapshot = s.controlAtTurnStart ?? [];
      const info = objectiveInfo(s, side, ctx);
      return info.some((o, i) => snapshot[i] === otherSide(side) && o.controller === side) ? 4 : 0;
    },
  },
  {
    id: 'defend_stronghold',
    name: 'Defend Stronghold',
    scoreAt: 'opponent_turn',
    desc: 'End of your opponent’s turn: control an objective in your deployment zone = 3VP',
    score: (s, side, ctx) =>
      objectiveInfo(s, side, ctx).some((o) => o.territory === 'own' && o.controller === side) ? 3 : 0,
  },
];

const CARD_BY_ID = new Map(SECONDARY_CARDS.map((c) => [c.id, c]));
export const secondaryCard = (id: string): SecondaryCard | undefined => CARD_BY_ID.get(id);

// ── deck / hand lifecycle ─────────────────────────────────────────────────────
function shuffled(rng: RNG): string[] {
  const ids = SECONDARY_CARDS.map((c) => c.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids;
}

/** Fresh per-side decks for a new battle (each side shuffles its OWN copy of the deck). */
export function initSecondaries(rng: RNG): Record<Side, SecondarySideState> {
  return {
    player: { deck: shuffled(rng), hand: [], discard: [], vp: 0 },
    ai: { deck: shuffled(rng), hand: [], discard: [], vp: 0 },
  };
}

/**
 * Start-of-turn upkeep for the ACTIVE player (called from Run Command): snapshot objective
 * control (Storm Hostile Objective), auto-discard stale unscored cards, draw back up to 2.
 */
export function secondariesOnTurnStart(state: GameState, ctx: EngineContext): GameState {
  if (!state.secondaries) return state;
  const side = state.activePlayer;
  const log: string[] = [];

  const controlAtTurnStart = objectiveControl(state, ctx).perObjective.map((o) => o.controller ?? null);

  const mine = state.secondaries[side];
  const keep: typeof mine.hand = [];
  const discard = [...mine.discard];
  for (const c of mine.hand) {
    if (state.round - c.drawn >= STALE_AGE) {
      discard.push(c.id);
      log.push(`${side} discards Tactical Mission "${secondaryCard(c.id)?.name ?? c.id}" (stale)`);
    } else {
      keep.push(c);
    }
  }
  const deck = [...mine.deck];
  while (keep.length < HAND_SIZE && deck.length > 0) {
    const id = deck.shift()!;
    keep.push({ id, drawn: state.round });
    log.push(`${side} draws Tactical Mission "${secondaryCard(id)?.name ?? id}"`);
  }

  return {
    ...state,
    controlAtTurnStart,
    secondaries: { ...state.secondaries, [side]: { ...mine, deck, hand: keep, discard } },
    log: [...state.log, ...log],
  };
}

/**
 * End-of-turn scoring (called from AdvancePhase when the active player's turn ends): the ending
 * player checks their `your_turn`/`either` cards, the other player their `opponent_turn`/`either`
 * cards. Scored cards are discarded; secondary VP is capped at 40 and added to the total score.
 */
export function secondariesOnTurnEnd(state: GameState, ctx: EngineContext | undefined): GameState {
  if (!state.secondaries || !ctx) return state;
  const ending = state.activePlayer;
  let next = state;
  for (const side of ['player', 'ai'] as Side[]) {
    const relevant = side === ending ? ['your_turn', 'either'] : ['opponent_turn', 'either'];
    const sec = next.secondaries![side];
    const hand: typeof sec.hand = [];
    const discard = [...sec.discard];
    let vp = sec.vp;
    let score = next.score[side];
    const log: string[] = [];
    for (const c of sec.hand) {
      const card = secondaryCard(c.id);
      if (!card || !relevant.includes(card.scoreAt)) {
        hand.push(c);
        continue;
      }
      const raw = card.score(next, side, ctx);
      if (raw <= 0) {
        hand.push(c);
        continue;
      }
      const gained = Math.min(raw, SECONDARY_VP_CAP - vp);
      vp += gained;
      score += gained;
      discard.push(c.id);
      log.push(`${side} scores Tactical Mission "${card.name}": +${gained} VP (secondary ${vp}/${SECONDARY_VP_CAP})`);
    }
    next = {
      ...next,
      secondaries: { ...next.secondaries!, [side]: { ...sec, hand, discard, vp } },
      score: { ...next.score, [side]: score },
      log: [...next.log, ...log],
    };
  }
  return next;
}

/** Record units destroyed by an intent (diff before→after) onto `turnKills`. Match-mode only. */
export function recordKills(before: GameState, after: GameState, ctx: EngineContext | undefined): GameState {
  if (before.mode !== 'match' || !ctx) return after;
  const wasAlive = new Set(before.units.filter((u) => u.models.some((m) => m.alive)).map((u) => u.id));
  const controlR = after.layout.objectiveControlRadiusIn ?? 3;
  const kills: KillRecord[] = [];
  for (const u of after.units) {
    if (!wasAlive.has(u.id) || u.models.some((m) => m.alive)) continue;
    const datasheetIds = [u.datasheetId, ...(u.attachedLeaders ?? []).map((l) => l.datasheetId)];
    const maxWounds = Math.max(
      1,
      ...datasheetIds.flatMap((id) => (ctx.datasheets.get(id)?.models ?? []).map((m) => m.W)),
    );
    const onObjective = after.layout.objectives.some((o) =>
      u.models.some((m) => dist(m.pos, o) <= controlR),
    );
    kills.push({ side: u.owner, datasheetIds, maxWounds, onObjective });
  }
  if (kills.length === 0) return after;
  return { ...after, turnKills: [...(after.turnKills ?? []), ...kills] };
}

// ── AI hooks (light touch — the AI plays toward its active cards) ─────────────
const activeIds = (state: GameState, side: Side): Set<string> =>
  new Set((state.secondaries?.[side]?.hand ?? []).map((c) => c.id));

/** Multiplier on shooting/charge EV against `target` while a kill card wants it dead. */
export function secondaryKillBonus(state: GameState, side: Side, target: UnitInstance, ctx: EngineContext): number {
  const active = activeIds(state, side);
  if (active.size === 0) return 1;
  const ds = [target.datasheetId, ...(target.attachedLeaders ?? []).map((l) => l.datasheetId)];
  let mult = 1;
  if (active.has('assassination') && hasKeyword(ctx, ds, 'character')) mult *= 1.5;
  if (active.has('bring_it_down') && (hasKeyword(ctx, ds, 'monster') || hasKeyword(ctx, ds, 'vehicle'))) mult *= 1.4;
  return mult;
}

/** Additive position-score bonus for standing where an active card scores. */
export function secondaryPositionBonus(state: GameState, side: Side, at: Vec2, ctx: EngineContext): number {
  const active = activeIds(state, side);
  if (active.size === 0) return 0;
  let bonus = 0;
  const controlR = state.layout.objectiveControlRadiusIn ?? 3;
  if (active.has('behind_enemy_lines')) {
    const zone = zoneFor(state.layout, otherSide(side));
    if (zone.length && pointInPolygon(at, zone)) bonus += 7;
  }
  const wantsObjectives =
    active.has('capture_enemy_outpost') || active.has('secure_no_mans_land') ||
    active.has('storm_hostile_objective') || active.has('extend_battle_lines') || active.has('defend_stronghold');
  if (wantsObjectives) {
    const info = objectiveInfo(state, side, ctx);
    for (const o of info) {
      if (dist(at, o.pos) > controlR) continue;
      if (active.has('capture_enemy_outpost') && o.territory === 'enemy') bonus += 8;
      if (active.has('secure_no_mans_land') && o.territory === 'nml') bonus += 4;
      if (active.has('extend_battle_lines') && o.territory !== 'enemy') bonus += 3;
      if (active.has('defend_stronghold') && o.territory === 'own') bonus += 3;
      if (active.has('storm_hostile_objective') && o.controller === otherSide(side)) bonus += 6;
    }
  }
  return bonus;
}
