// 11e Secondary Missions (Chapter Approved deck, June 2026). PURE — no React, no DOM, no I/O.
//
// Model: each side has its OWN shuffled 18-card deck (seeded RNG — games stay reproducible).
// At the start of your Command phase you draw TWO cards (11e: no hand limit). Cards score
// automatically at the relevant turn end (ending player first) and are discarded when scored.
// At the end of your turn you may discard unscored cards for 1CP (we auto-discard cards held
// two of your turns without scoring, granting the 1CP — the tabletop choice, automated).
// Caps (Event Companion): Secondary max 45VP, max 15VP per battle round
// (Fixed cards additionally cap at 20VP each — Fixed mode uses the four FIXED-capable cards).
//
// Card text follows docs/11e_missions.md (GDM transcription of the official deck). "Wholly
// within" uses model centre points (same simplification as LoS, noted there). When-Drawn
// redraw options are auto-taken when they are clearly right (no valid targets on the board).

import type { EngineContext } from './engine';
import type { GameState, KillRecord, SecondaryCardInHand, SecondarySideState, Side, UnitInstance, Vec2 } from './types';
import type { RNG } from './rng';
import { zoneFor } from './deployment';
import { baseRadius, dist, pointInPolygon } from './geometry';
import { otherSide } from './setup';
import {
  attackerZoneProbe,
  missionAttacker,
  objectivePoints,
  objectiveStatuses,
  quartersWithPresence,
  buildMissionEval,
  territoryOf,
  withinObjectiveRange,
} from './missions11';

export const SECONDARY_VP_CAP = 45;
export const SECONDARY_ROUND_CAP = 15;
export const FIXED_CARD_CAP = 20;
const STALE_AGE = 2; // own turns an unscored card survives before the discard-for-1CP

export interface SecondaryCard {
  id: string;
  name: string;
  /** When the card is checked: the end of YOUR turn, your OPPONENT's turn, or every turn. */
  scoreAt: 'your_turn' | 'opponent_turn' | 'either';
  /** May be chosen as one of your two FIXED missions. */
  fixed?: boolean;
  /** Short rule text for the UI/log. */
  desc: string;
  /** VP scored at the relevant turn end (0 = not scored; the card stays in hand). */
  score: (state: GameState, side: Side, ctx: EngineContext, card: SecondaryCardInHand) => number;
  /** When-Drawn: return a redraw decision and/or card data (picked unit/objective). */
  whenDrawn?: (state: GameState, side: Side, ctx: EngineContext) => { redraw?: boolean; data?: string | number };
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

const aliveOnBoard = (u: UnitInstance): boolean => !u.inReserves && u.models.some((m) => m.alive);
const scorable = (u: UnitInstance): boolean => aliveOnBoard(u) && !u.status.battleShocked;

/** All of a unit's alive model centres inside the polygon ("wholly within", centre-point model). */
function whollyWithinPoly(u: UnitInstance, polygon: Vec2[]): boolean {
  if (polygon.length === 0) return false;
  const alive = u.models.filter((m) => m.alive);
  return alive.length > 0 && alive.every((m) => pointInPolygon(m.pos, polygon));
}

/** My/enemy territory test for a point (11e divider when present; zones as fallback). */
function inMyTerritory(state: GameState, side: Side, p: Vec2): boolean {
  if (state.layout.territoryDivider || state.layout.terrainAreas) {
    const attacker = missionAttacker(state);
    const probe = attackerZoneProbe(state.layout, attacker);
    const mine = side === attacker ? 'attacker' : 'defender';
    return territoryOf(p, state.layout, probe) === mine;
  }
  const zone = zoneFor(state.layout, side);
  return zone.length > 0 && pointInPolygon(p, zone);
}

/** Is a point within NEITHER deployment zone (No Man's Land)? */
function inNoMansLand(state: GameState, p: Vec2): boolean {
  const a = zoneFor(state.layout, 'player');
  const b = zoneFor(state.layout, 'ai');
  return !(a.length && pointInPolygon(p, a)) && !(b.length && pointInPolygon(p, b));
}

/** Objective statuses relative to a side (controller + typed points). */
function objInfo(state: GameState, ctx: EngineContext) {
  return objectiveStatuses(state, ctx, missionAttacker(state));
}

function actionCount(state: GameState, side: Side, actionId: string): number {
  return state.missions?.actionsDoneThisTurn?.[side]?.[actionId] ?? 0;
}

// ── the deck (18 cards) ───────────────────────────────────────────────────────
export const SECONDARY_CARDS: SecondaryCard[] = [
  {
    id: 'a_grievous_blow',
    name: 'A Grievous Blow',
    scoreAt: 'either',
    fixed: true,
    desc: '5VP if an enemy unit with Starting Strength 13+ was destroyed this turn',
    whenDrawn: (s, side, ctx) => ({
      redraw: !s.units.some(
        (u) => u.owner === otherSide(side) && aliveOnBoard(u) && u.startingModels >= 13 && !!ctx,
      ),
    }),
    score: (s, side) =>
      killsBy(s, side).some((k) => (k.startingStrength ?? 0) >= 13) ? 5 : 0,
  },
  {
    id: 'a_tempting_target',
    name: 'A Tempting Target',
    scoreAt: 'your_turn',
    desc: 'Opponent picks a No Man’s Land objective; 5VP if you control it at the end of your turn',
    whenDrawn: (s, _side, ctx) => {
      // The OPPONENT picks: the NML non-home objective hardest for us (furthest from our units).
      const info = objInfo(s, ctx);
      const nml = info.filter((o) => o.point.kind !== 'home' && inNoMansLand(s, o.point.pos));
      if (nml.length === 0) return {};
      const myModels = s.units
        .filter((u) => u.owner === _side && aliveOnBoard(u))
        .flatMap((u) => u.models.filter((m) => m.alive).map((m) => m.pos));
      const far = nml.reduce((best, o) => {
        const d = (x: typeof o) => Math.min(...myModels.map((p) => dist(p, x.point.pos)), Infinity);
        return d(o) > d(best) ? o : best;
      });
      return { data: far.idx };
    },
    score: (s, side, ctx, card) => {
      const idx = typeof card.data === 'number' ? card.data : -1;
      if (idx < 0) return 0;
      return objInfo(s, ctx)[idx]?.controller === side ? 5 : 0;
    },
  },
  {
    id: 'assassination',
    name: 'Assassination',
    scoreAt: 'either',
    fixed: true,
    desc: '5VP if an enemy CHARACTER model was destroyed this turn (or all enemy CHARACTERS are dead)',
    score: (s, side, ctx) => {
      const slainNow = killsBy(s, side).some((k) => (k.charactersSlain ?? 0) > 0);
      if (slainNow) return 5;
      const anyCharacterAlive = s.units.some((u) => {
        if (u.owner !== otherSide(side)) return false;
        return u.models.some((m) => {
          if (!m.alive) return false;
          const ds = ctx.datasheets.get(m.datasheetId ?? u.datasheetId);
          return !!ds?.keywords.some((k) => k.toLowerCase() === 'character');
        });
      });
      const anyCharacterExisted = s.units.some((u) =>
        u.owner === otherSide(side) &&
        [u.datasheetId, ...(u.attachedLeaders ?? []).map((l) => l.datasheetId)].some((id) =>
          ctx.datasheets.get(id)?.keywords.some((k) => k.toLowerCase() === 'character'),
        ),
      );
      return anyCharacterExisted && !anyCharacterAlive ? 5 : 0;
    },
  },
  {
    id: 'beacon',
    name: 'Beacon',
    scoreAt: 'opponent_turn',
    desc: 'Pick a beacon unit when drawn; 3VP if it is out of your deployment zone (5VP out of your territory)',
    whenDrawn: (s, side) => {
      // Auto-pick: our on-board unit furthest from our zone (most likely to push forward).
      const mine = s.units.filter((u) => u.owner === side && aliveOnBoard(u));
      if (mine.length === 0) return {};
      const zone = zoneFor(s.layout, side);
      const zc = zone.length
        ? { x: zone.reduce((t, p) => t + p.x, 0) / zone.length, y: zone.reduce((t, p) => t + p.y, 0) / zone.length }
        : { x: 0, y: 0 };
      const pick = mine.reduce((a, b) => {
        const da = Math.min(...a.models.filter((m) => m.alive).map((m) => dist(m.pos, zc)));
        const db = Math.min(...b.models.filter((m) => m.alive).map((m) => dist(m.pos, zc)));
        return db > da ? b : a;
      });
      return { data: pick.id };
    },
    score: (s, side, _ctx, card) => {
      const u = s.units.find((x) => x.id === card.data);
      if (!u || !aliveOnBoard(u)) return 0;
      const zone = zoneFor(s.layout, side);
      const outOfZone = !u.models.some((m) => m.alive && zone.length && pointInPolygon(m.pos, zone));
      const outOfTerritory = !u.models.some((m) => m.alive && inMyTerritory(s, side, m.pos));
      return outOfTerritory ? 5 : outOfZone ? 3 : 0;
    },
  },
  {
    id: 'behind_enemy_lines',
    name: 'Behind Enemy Lines',
    scoreAt: 'your_turn',
    desc: '3VP per friendly unit wholly within the enemy deployment zone',
    whenDrawn: (s) => ({ redraw: s.round <= 1 }),
    score: (s, side) => {
      const zone = zoneFor(s.layout, otherSide(side));
      return s.units.filter((u) => u.owner === side && scorable(u) && whollyWithinPoly(u, zone)).length * 3;
    },
  },
  {
    id: 'bring_it_down',
    name: 'Bring It Down',
    scoreAt: 'either',
    fixed: true,
    desc: '5VP if an enemy model with 10+ Wounds was destroyed this turn',
    whenDrawn: (s, side, ctx) => ({
      redraw: !s.units.some(
        (u) =>
          u.owner === otherSide(side) && aliveOnBoard(u) &&
          [u.datasheetId, ...(u.attachedLeaders ?? []).map((l) => l.datasheetId)].some(
            (id) => (ctx.datasheets.get(id)?.models[0]?.W ?? 0) >= 10,
          ),
      ),
    }),
    score: (s, side) => (killsBy(s, side).some((k) => k.maxWounds >= 10) ? 5 : 0),
  },
  {
    id: 'burden_of_trust',
    name: 'Burden of Trust',
    scoreAt: 'opponent_turn',
    desc: '2VP per objective you guarded from the start of your turn to the end of your opponent’s',
    score: (s, side, ctx) => {
      // Guarded ≈ controlled at the start of the current turn pair AND still controlled with a
      // friendly unit in range now.
      const snapshot = s.controlAtTurnStart ?? [];
      const info = objInfo(s, ctx);
      let n = 0;
      info.forEach((o, i) => {
        if (snapshot[i] !== side || o.controller !== side) return;
        const guarded = s.units.some(
          (u) => u.owner === side && aliveOnBoard(u) &&
            u.models.some((m) => m.alive && withinObjectiveRange(m.pos, 0.5, o.point, s.layout)),
        );
        if (guarded) n++;
      });
      return n * 2;
    },
  },
  {
    id: 'centre_ground',
    name: 'Centre Ground',
    scoreAt: 'your_turn',
    desc: 'Friendly unit within 3" of the centre: 3VP if no enemy within 3", 5VP if none within 6"',
    score: (s, side) => {
      const centre = { x: s.layout.boardWidth / 2, y: s.layout.boardHeight / 2 };
      const minePresent = s.units.some(
        (u) => u.owner === side && scorable(u) && u.models.some((m) => m.alive && dist(m.pos, centre) <= 3),
      );
      if (!minePresent) return 0;
      let nearestEnemy = Infinity;
      for (const u of s.units) {
        if (u.owner === side || u.inReserves) continue;
        for (const m of u.models) if (m.alive) nearestEnemy = Math.min(nearestEnemy, dist(m.pos, centre));
      }
      return nearestEnemy > 6 ? 5 : nearestEnemy > 3 ? 3 : 0;
    },
  },
  {
    id: 'cleanse',
    name: 'Cleanse',
    scoreAt: 'your_turn',
    desc: 'Cleanse objectives (action): one cleansed = 2VP, two+ = 5VP',
    whenDrawn: (s, side) => ({
      redraw: (s.secondaries?.[side]?.hand ?? []).some((c) => c.id === 'plunder'),
    }),
    score: (s, side) => {
      const n = actionCount(s, side, 'cleanse');
      return n >= 2 ? 5 : n === 1 ? 2 : 0;
    },
  },
  {
    id: 'defend_stronghold',
    name: 'Defend Stronghold',
    scoreAt: 'opponent_turn',
    desc: 'Round 2+: control your home objective = 3VP (+2 if no enemies in your deployment zone)',
    whenDrawn: (s) => ({ redraw: s.round <= 1 }),
    score: (s, side, ctx) => {
      if (s.round < 2) return 0;
      const info = objInfo(s, ctx);
      const attacker = missionAttacker(s);
      const holdsHome = info.some(
        (o) =>
          o.point.kind === 'home' &&
          o.point.owner === (side === attacker ? 'attacker' : 'defender') &&
          o.controller === side,
      );
      // Legacy layouts: fall back to "an objective in my zone".
      const holds =
        holdsHome ||
        (!s.layout.objectivePoints &&
          info.some((o) => inMyTerritory(s, side, o.point.pos) && o.controller === side));
      if (!holds) return 0;
      const zone = zoneFor(s.layout, side);
      const enemiesIn = s.units.some(
        (u) => u.owner === otherSide(side) && aliveOnBoard(u) &&
          u.models.some((m) => m.alive && zone.length && pointInPolygon(m.pos, zone)),
      );
      return 3 + (enemiesIn ? 0 : 2);
    },
  },
  {
    id: 'display_of_might',
    name: 'Display of Might',
    scoreAt: 'either',
    desc: 'More friendly than enemy units wholly within No Man’s Land: 2VP (your turn) / 5VP (opponent’s)',
    score: (s, side) => {
      const count = (owner: Side) =>
        s.units.filter(
          (u) => u.owner === owner && scorable(u) && u.models.filter((m) => m.alive).every((m) => inNoMansLand(s, m.pos)),
        ).length;
      if (count(side) <= count(otherSide(side))) return 0;
      return s.activePlayer === side ? 2 : 5;
    },
  },
  {
    id: 'engage_all_fronts',
    name: 'Engage on All Fronts',
    scoreAt: 'your_turn',
    fixed: true,
    desc: 'Units wholly in table quarters >6" from the centre: 3 quarters = 3VP, 4 = 5VP',
    score: (s, side, ctx) => {
      if (!s.missions) return 0;
      const q = quartersWithPresence(buildMissionEval(s, ctx, side));
      return q >= 4 ? 5 : q >= 3 ? 3 : 0;
    },
  },
  {
    id: 'forward_position',
    name: 'Forward Position',
    scoreAt: 'your_turn',
    desc: '5VP if you control your opponent’s home objective, or every expansion objective',
    whenDrawn: (s) => ({ redraw: s.round <= 1 }),
    score: (s, side, ctx) => {
      const info = objInfo(s, ctx);
      const attacker = missionAttacker(s);
      const enemyHome = info.some(
        (o) =>
          o.point.kind === 'home' &&
          o.point.owner === (side === attacker ? 'defender' : 'attacker') &&
          o.controller === side,
      );
      const expansions = info.filter((o) => o.point.kind === 'expansion');
      const allExpansions = expansions.length > 0 && expansions.every((o) => o.controller === side);
      return enemyHome || allExpansions ? 5 : 0;
    },
  },
  {
    id: 'no_prisoners',
    name: 'No Prisoners',
    scoreAt: 'either',
    desc: '2VP per enemy unit destroyed this turn',
    score: (s, side) => killsBy(s, side).length * 2,
  },
  {
    id: 'outflank',
    name: 'Outflank',
    scoreAt: 'your_turn',
    desc: 'Units within 6" of battlefield edges outside your territory: 3VP (5VP on opposite edges)',
    score: (s, side) => {
      const W = s.layout.boardWidth;
      const H = s.layout.boardHeight;
      const edgeOf = (u: UnitInstance): Set<string> => {
        const edges = new Set<string>();
        for (const m of u.models) {
          if (!m.alive) continue;
          if (m.pos.x <= 6) edges.add('left');
          if (m.pos.x >= W - 6) edges.add('right');
          if (m.pos.y <= 6) edges.add('bottom');
          if (m.pos.y >= H - 6) edges.add('top');
        }
        return edges;
      };
      const nearEdge = s.units.filter((u) => u.owner === side && scorable(u) && edgeOf(u).size > 0);
      const outOfTerritory = (u: UnitInstance) =>
        !u.models.some((m) => m.alive && inMyTerritory(s, side, m.pos));
      const forward = nearEdge.filter(outOfTerritory);
      if (forward.length === 0) return 0;
      // Opposite edges: left+right or top+bottom across the near-edge units, one out of territory.
      const all = new Set(nearEdge.flatMap((u) => [...edgeOf(u)]));
      const opposite = (all.has('left') && all.has('right')) || (all.has('top') && all.has('bottom'));
      return opposite && nearEdge.length >= 2 ? 5 : 3;
    },
  },
  {
    id: 'overwhelming_force',
    name: 'Overwhelming Force',
    scoreAt: 'either',
    desc: '3VP per enemy unit destroyed this turn that started the turn on an objective',
    score: (s, side) => killsBy(s, side).filter((k) => k.startedTurnOnObjective).length * 3,
  },
  {
    id: 'plunder',
    name: 'Plunder',
    scoreAt: 'your_turn',
    desc: 'Plunder a terrain area outside your territory (action): 5VP',
    whenDrawn: (s, side) => ({
      redraw: (s.secondaries?.[side]?.hand ?? []).some((c) => c.id === 'cleanse'),
    }),
    score: (s, side) => (actionCount(s, side, 'plunder') >= 1 ? 5 : 0),
  },
  {
    id: 'secure_no_mans_land',
    name: 'Secure No Man’s Land',
    scoreAt: 'your_turn',
    desc: 'Control two or more objectives in No Man’s Land: 5VP',
    score: (s, side, ctx) =>
      objInfo(s, ctx).filter((o) => inNoMansLand(s, o.point.pos) && o.controller === side).length >= 2 ? 5 : 0,
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
 * Start-of-Command-phase upkeep for the ACTIVE player: draw TWO cards (11e — no hand limit),
 * resolving When-Drawn picks/redraws as they arrive.
 */
export function secondariesOnTurnStart(state: GameState, ctx: EngineContext): GameState {
  if (!state.secondaries) return state;
  const side = state.activePlayer;
  const log: string[] = [];

  const mine = state.secondaries[side];
  const hand = [...mine.hand];
  const deck = [...mine.deck];
  const discard = [...mine.discard];
  let drawn = 0;
  let guard = 0;
  while (drawn < 2 && deck.length > 0 && guard++ < 30) {
    const id = deck.shift()!;
    const card = secondaryCard(id);
    const decision = card?.whenDrawn?.(
      { ...state, secondaries: { ...state.secondaries, [side]: { ...mine, hand } } },
      side,
      ctx,
    );
    if (decision?.redraw && deck.length > 0) {
      // Shuffle-back / discard-and-redraw are equivalent for the sim: put it at the bottom.
      deck.push(id);
      log.push(`${side} redraws Tactical Mission "${card?.name ?? id}" (When Drawn)`);
      continue;
    }
    hand.push({ id, drawn: state.round, ...(decision?.data != null ? { data: decision.data } : {}) });
    log.push(`${side} draws Tactical Mission "${card?.name ?? id}"`);
    drawn++;
  }

  return {
    ...state,
    secondaries: { ...state.secondaries, [side]: { ...mine, deck, hand, discard } },
    log: [...state.log, ...log],
  };
}

/**
 * End-of-turn scoring (called from AdvancePhase when the active player's turn ends): the ending
 * player checks their `your_turn`/`either` cards first, then the other player their
 * `opponent_turn`/`either` cards. Scored cards are discarded. Caps: 45 total, 15 per round.
 * Afterwards the ending player auto-discards stale cards for 1CP (once).
 */
export function secondariesOnTurnEnd(state: GameState, ctx: EngineContext | undefined): GameState {
  if (!state.secondaries || !ctx) return state;
  const ending = state.activePlayer;
  let next = state;
  for (const side of [ending, otherSide(ending)] as Side[]) {
    const relevant = side === ending ? ['your_turn', 'either'] : ['opponent_turn', 'either'];
    const sec = next.secondaries![side];
    const hand: typeof sec.hand = [];
    const discard = [...sec.discard];
    let vp = sec.vp;
    const roundVp = { ...(sec.roundVp ?? {}) };
    let score = next.score[side];
    const log: string[] = [];
    for (const c of sec.hand) {
      const card = secondaryCard(c.id);
      if (!card || !relevant.includes(card.scoreAt)) {
        hand.push(c);
        continue;
      }
      const raw = card.score(next, side, ctx, c);
      if (raw <= 0) {
        hand.push(c);
        continue;
      }
      const roundSoFar = roundVp[next.round] ?? 0;
      const gained = Math.max(
        0,
        Math.min(raw, SECONDARY_VP_CAP - vp, SECONDARY_ROUND_CAP - roundSoFar),
      );
      if (gained <= 0) {
        hand.push(c);
        continue;
      }
      vp += gained;
      roundVp[next.round] = roundSoFar + gained;
      score += gained;
      discard.push(c.id);
      log.push(`${side} scores Tactical Mission "${card.name}": +${gained} VP (secondary ${vp}/${SECONDARY_VP_CAP})`);
    }
    next = {
      ...next,
      secondaries: { ...next.secondaries!, [side]: { ...sec, hand, discard, vp, roundVp } },
      score: { ...next.score, [side]: score },
      log: [...next.log, ...log],
    };
  }

  // Discard-for-1CP: the ending player bins unscored cards held 2+ of their own turns.
  const sec = next.secondaries![ending];
  const stale = sec.hand.filter((c) => next.round - c.drawn >= STALE_AGE);
  if (stale.length > 0) {
    next = {
      ...next,
      secondaries: {
        ...next.secondaries!,
        [ending]: {
          ...sec,
          hand: sec.hand.filter((c) => !stale.includes(c)),
          discard: [...sec.discard, ...stale.map((c) => c.id)],
        },
      },
      cp: { ...next.cp, [ending]: next.cp[ending] + 1 },
      log: [
        ...next.log,
        `${ending} discards ${stale.length} Tactical Mission(s) for 1 CP (${stale.map((c) => secondaryCard(c.id)?.name ?? c.id).join(', ')})`,
      ],
    };
  }
  return next;
}

/** Record units destroyed by an intent (diff before→after) onto `turnKills`. Match-mode only.
 *  Also records CHARACTER-model deaths inside surviving units (Assassination scores models). */
export function recordKills(before: GameState, after: GameState, ctx: EngineContext | undefined): GameState {
  if (before.mode !== 'match' || !ctx) return after;
  const beforeById = new Map(before.units.map((u) => [u.id, u]));
  const flags = after.missions?.unitStartTurnFlags ?? {};
  const kills: KillRecord[] = [];

  for (const u of after.units) {
    const prev = beforeById.get(u.id);
    if (!prev) continue;
    const wasAlive = prev.models.some((m) => m.alive);
    const isAlive = u.models.some((m) => m.alive);

    // CHARACTER models slain (whether or not the unit died with them).
    let charactersSlain = 0;
    let characterMaxW = 0;
    for (let i = 0; i < u.models.length; i++) {
      const now = u.models[i]!;
      const then = prev.models[i];
      if (!then?.alive || now.alive) continue;
      const ds = ctx.datasheets.get(now.datasheetId ?? u.datasheetId);
      if (ds?.keywords.some((k) => k.toLowerCase() === 'character')) {
        charactersSlain++;
        characterMaxW = Math.max(characterMaxW, ds.models[0]?.W ?? 0);
      }
    }

    if (wasAlive && !isAlive) {
      const datasheetIds = [u.datasheetId, ...(u.attachedLeaders ?? []).map((l) => l.datasheetId)];
      const maxWounds = Math.max(
        1,
        ...datasheetIds.flatMap((id) => (ctx.datasheets.get(id)?.models ?? []).map((m) => m.W)),
      );
      const points = objectivePoints(after.layout);
      const onObjective = points.some((o) =>
        prev.models.some((m) => m.alive && withinObjectiveRange(m.pos, 0.5, o, after.layout)),
      );
      const f = flags[u.id];
      kills.push({
        side: u.owner,
        unitId: u.id,
        datasheetIds,
        maxWounds,
        onObjective,
        startingStrength: u.startingModels,
        ...(charactersSlain ? { charactersSlain, characterMaxW } : {}),
        ...(f?.onObjective ? { startedTurnOnObjective: true } : {}),
        ...(f?.onCentral ? { startedTurnOnCentral: true } : {}),
        ...(f?.areaId ? { startedTurnInArea: f.areaId } : {}),
        killerOnObjective: killerNearObjective(before, u.owner, ctx),
      });
    } else if (charactersSlain > 0) {
      kills.push({
        side: u.owner,
        datasheetIds: [u.datasheetId],
        maxWounds: characterMaxW,
        onObjective: false,
        charactersSlain,
        characterMaxW,
      });
    }
  }
  if (kills.length === 0) return after;
  return { ...after, turnKills: [...(after.turnKills ?? []), ...kills] };
}

/** Was any unit of the KILLING side within range of an objective when the kill happened?
 *  (Purge and Secure — approximated as "any friendly-of-killer unit on an objective".) */
function killerNearObjective(before: GameState, victimSide: Side, ctx: EngineContext): boolean {
  const killer = otherSide(victimSide);
  const points = objectivePoints(before.layout);
  return before.units.some(
    (u) =>
      u.owner === killer && aliveOnBoard(u) &&
      u.models.some((m) => {
        if (!m.alive) return false;
        const r = baseRadius(ctx.datasheets.get(m.datasheetId ?? u.datasheetId)?.baseShape ?? { kind: 'circle', radius: 0.63 });
        return points.some((o) => withinObjectiveRange(m.pos, r, o, before.layout));
      }),
  );
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
  if (active.has('bring_it_down') && ds.some((id) => (ctx.datasheets.get(id)?.models[0]?.W ?? 0) >= 10)) mult *= 1.4;
  if (active.has('a_grievous_blow') && target.startingModels >= 13) mult *= 1.4;
  if (active.has('no_prisoners') || active.has('overwhelming_force')) mult *= 1.15;
  return mult;
}

/** Additive position-score bonus for standing where an active card scores. */
export function secondaryPositionBonus(state: GameState, side: Side, at: Vec2, ctx: EngineContext): number {
  const active = activeIds(state, side);
  if (active.size === 0) return 0;
  let bonus = 0;
  if (active.has('behind_enemy_lines')) {
    const zone = zoneFor(state.layout, otherSide(side));
    if (zone.length && pointInPolygon(at, zone)) bonus += 7;
  }
  if (active.has('centre_ground')) {
    const centre = { x: state.layout.boardWidth / 2, y: state.layout.boardHeight / 2 };
    if (dist(at, centre) <= 3) bonus += 5;
  }
  if (active.has('outflank') || active.has('beacon')) {
    const nearEdge =
      at.x <= 6 || at.y <= 6 || at.x >= state.layout.boardWidth - 6 || at.y >= state.layout.boardHeight - 6;
    if (nearEdge && !inMyTerritory(state, side, at)) bonus += 4;
  }
  const info = objInfo(state, ctx);
  for (const o of info) {
    const near = withinObjectiveRange(at, 0.5, o.point, state.layout);
    if (!near) continue;
    if (active.has('a_tempting_target')) {
      const card = state.secondaries?.[side]?.hand.find((c) => c.id === 'a_tempting_target');
      if (typeof card?.data === 'number' && card.data === o.idx) bonus += 8;
    }
    if (active.has('secure_no_mans_land') && inNoMansLand(state, o.point.pos)) bonus += 4;
    if (active.has('forward_position') && o.point.kind !== 'home') bonus += 3;
    if (active.has('defend_stronghold') && o.point.kind === 'home' && inMyTerritory(state, side, o.point.pos)) bonus += 3;
    if (active.has('burden_of_trust') && o.controller === side) bonus += 2;
  }
  return bonus;
}
