// AI Movement-phase decisions. PURE.
//
// One unit activation per tick, state-driven so the dice stay honest:
//   tick A: pick a unit + mode → BeginMove (the reducer rolls any Advance D6 and sets the budget);
//   tick B: the unit is mid-activation (status.moveBudget set) → pick the best destination the
//           ACTUAL budget allows → one rigid NudgeUnit + EndMove.
// Rigid translation of a coherent unit stays coherent, and the nudge is pre-clamped to the board
// and the budget, so EndMove cannot bounce. Once nothing is left to move (and Reserves have
// arrived), the phase is advanced.

import type { GameState, Side, UnitInstance, Vec2 } from '../types';
import type { EngineContext } from '../engine';
import { aliveModels, isOnBoard, engagedEnemies, pendingScoutUnits, reservesArrivable, unitCentroid, ENGAGEMENT_RANGE } from '../phases';
import { checkCoherency } from '../coherency';
import { anyOverlap, clampDeltaAvoidingOverlap, occupiedBases, unitBases, unitOverlaps } from '../collision';
import { deepStrikeArrivalLegal, zoneFor } from '../deployment';
import { formationPositions } from '../formation';
import { gapBetweenBases, dist, baseRadius } from '../geometry';
import { objectiveControl } from '../engine';
import { unitScoutDistance } from '../abilities';
import { firingDeckX } from '../transport';
import { secondaryPositionBonus } from '../secondaries';
import { missionPositionBonus } from './missionplay';
import { shootingEV, unitThreat, unitValue, unitGap, unitOC, maxWeaponRange, meleeEV } from './evaluate';
import { homeGarrisonId, unitRolePlan, type RolePlan } from './roles';
import type { AiAction, AiDeps } from './types';
import type { AiProfile } from './profile';
import type { MoveMode } from '../movement';

const hasMoved = (u: UnitInstance): boolean =>
  !!(u.status.moved || u.status.advanced || u.status.fellBack || u.status.remainedStationary);

/** The side's HOME objective: the marker closest to its own deployment zone's centroid. */
export function homeObjective(state: GameState, side: Side): Vec2 | null {
  if (state.layout.objectives.length === 0) return null;
  const zone = zoneFor(state.layout, side);
  const anchor =
    zone.length > 0
      ? { x: zone.reduce((s, p) => s + p.x, 0) / zone.length, y: zone.reduce((s, p) => s + p.y, 0) / zone.length }
      : { x: state.layout.boardWidth / 2, y: side === 'player' ? 0 : state.layout.boardHeight };
  return state.layout.objectives.reduce((a, b) => (dist(a, anchor) <= dist(b, anchor) ? a : b));
}

/** Largest fraction t∈[0,1] of `delta` every alive model can take without leaving the board
 *  (centres clamped like the reducer does) — keeps a rigid translate rigid. */
function clampDeltaToBoard(unit: UnitInstance, delta: Vec2, layout: { boardWidth: number; boardHeight: number }): Vec2 {
  let t = 1;
  for (const m of unit.models) {
    if (!m.alive) continue;
    if (delta.x > 1e-9) t = Math.min(t, (layout.boardWidth - m.pos.x) / delta.x);
    if (delta.x < -1e-9) t = Math.min(t, (0 - m.pos.x) / delta.x);
    if (delta.y > 1e-9) t = Math.min(t, (layout.boardHeight - m.pos.y) / delta.y);
    if (delta.y < -1e-9) t = Math.min(t, (0 - m.pos.y) / delta.y);
  }
  t = Math.max(0, Math.min(1, t));
  return { x: delta.x * t, y: delta.y * t };
}

/** Would translating `unit` by `delta` put any model within Engagement Range of an enemy?
 *  (10e: a Normal/Advance/Fall Back move may not end within Engagement Range.) */
function endsEngaged(state: GameState, unit: UnitInstance, delta: Vec2, ctx: EngineContext): boolean {
  const shape = ctx.datasheets.get(unit.datasheetId)?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
  for (const e of state.units) {
    if (e.owner === unit.owner || e.inReserves) continue;
    const eShape = ctx.datasheets.get(e.datasheetId)?.baseShape ?? shape;
    for (const m of unit.models) {
      if (!m.alive) continue;
      const p = { x: m.pos.x + delta.x, y: m.pos.y + delta.y };
      for (const em of e.models) {
        if (!em.alive) continue;
        if (gapBetweenBases(p, shape, em.pos, eShape) <= ENGAGEMENT_RANGE) return true;
      }
    }
  }
  return false;
}

/** Score the unit standing at `delta` from its current spot (the move-candidate utility). */
function positionScore(
  state: GameState,
  unit: UnitInstance,
  delta: Vec2,
  profile: AiProfile,
  deps: AiDeps,
  plan: RolePlan,
  garrison: boolean,
): number {
  const { ctx } = deps;
  const centroid = unitCentroid(unit);
  const at = { x: centroid.x + delta.x, y: centroid.y + delta.y };
  const controlR = state.layout.objectiveControlRadiusIn ?? 3;
  const enemies = state.units.filter((e) => e.owner !== unit.owner && isOnBoard(e));
  // Real OC, capped so a horde can't fully drown the other terms: a 10-strong squad saturates,
  // and a one-model OC-8 Stormlord pulls toward markers as hard as a squad (it used to count 1).
  const myOC = Math.min(unitOC(unit, ctx), 8);
  const home = homeObjective(state, unit.owner);

  let score = 0;

  // Objectives: reward standing in control range, weighted by how contested/empty the marker is.
  // Holding what you already own matters too — Primary scores EVERY Command phase — so a safely
  // held marker is still worth standing on, and one with enemies closing in is nearly contested.
  const { perObjective } = objectiveControl(state, ctx);
  state.layout.objectives.forEach((o, i) => {
    const d = dist(at, o);
    if (d > controlR + 6) return;
    const c = perObjective[i]!;
    const mine = unit.owner === 'player' ? c.player : c.ai;
    const theirs = unit.owner === 'player' ? c.ai : c.player;
    const enemyNear = enemies.some((e) => e.models.some((m) => m.alive && dist(m.pos, o) <= 12));
    const contested = theirs >= mine || mine === 0;
    const urgency = contested ? 1.2 : enemyNear ? 0.9 : 0.45; // keep holding ≫ the old 0.3
    const isHome = home && o.x === home.x && o.y === home.y;
    const garrisonBoost = garrison && isHome ? 3 : 1;
    const inRange = d <= controlR;
    score +=
      (inRange ? 10 : (controlR + 6 - d)) * urgency * profile.objective * plan.objectiveWeight *
      garrisonBoost * Math.min(myOC, 5);
  });

  // Active Tactical Missions: standing where a card scores (enemy DZ, outpost/NML markers…).
  score += secondaryPositionBonus(state, unit.owner, at, ctx);
  // The PRIMARY mission: standing where the side's disposition pays VP (enemy home for
  // Outmanoeuvre, centrals for Immovable Object, quarters for Reconnaissance Sweep…).
  score += missionPositionBonus(state, unit.owner, at, ctx) * 1.5 * profile.objective;

  // Shooting from the new spot: best target's expected points of damage (role bonus vs CHARACTERs).
  let bestEV = 0;
  for (const e of enemies) {
    let ev = shootingEV(state, unit, e, ctx, delta);
    if (plan.characterHunter > 1 && ctx.datasheets.get(e.datasheetId)?.keywords.some((k) => k.toLowerCase() === 'character')) {
      ev *= plan.characterHunter;
    }
    bestEV = Math.max(bestEV, ev);
  }
  score += bestEV * profile.damage;

  // Role standoff: closing inside the role's keep-away band is penalised (a sniper that CAN
  // shoot from 36" should not be standing at 10").
  if (plan.standoff > 0 && enemies.length) {
    let nearest = Infinity;
    for (const e of enemies) {
      for (const m of e.models) if (m.alive) nearest = Math.min(nearest, dist(m.pos, at));
    }
    if (nearest < plan.standoff) score -= (plan.standoff - nearest) * 1.5;
  }

  // Danger: enemies that can reach/shoot this spot, scaled by what we'd lose.
  const myValue = unitValue(unit, ctx);
  let danger = 0;
  for (const e of enemies) {
    const eGap = Math.max(0, unitGap(e, unit, ctx) - Math.hypot(delta.x, delta.y) * 0.5); // rough
    const eRange = maxWeaponRange(e, ctx);
    const eMove = ctx.datasheets.get(e.datasheetId)?.models[0]?.M ?? 6;
    if (eGap <= eRange + eMove) danger += unitThreat(e, ctx, 'ranged') * 0.5;
    if (eGap <= eMove + 12) danger += unitThreat(e, ctx, 'melee') * 0.5;
  }
  score -= Math.min(danger, myValue) * profile.caution * 0.1;

  return score;
}

interface MovePlan {
  mode: MoveMode;
  /** Where the unit centroid wants to end up (recomputed under the real budget on tick B). */
  goal: Vec2 | null;
}

/** Decide where one unit wants to go this turn. `garrison` = this unit holds the home objective. */
export function planMove(
  state: GameState,
  unit: UnitInstance,
  profile: AiProfile,
  deps: AiDeps,
  garrison = false,
): MovePlan {
  const { ctx } = deps;
  const centroid = unitCentroid(unit);
  const M = ctx.datasheets.get(unit.datasheetId)?.models[0]?.M ?? 6;
  const engaged = engagedEnemies(unit, state, ctx);
  const plan = unitRolePlan(unit, ctx);

  // Engaged: stay and fight when our melee out-trades theirs, otherwise Fall Back.
  if (engaged.length > 0) {
    const ourMelee = Math.max(...engaged.map((e) => meleeEV(unit, e, ctx)), 0);
    const theirMelee = Math.max(...engaged.map((e) => meleeEV(e, unit, ctx)), 0);
    if (ourMelee >= theirMelee * 0.8) return { mode: 'stationary', goal: null };
    const threat = engaged[0]!;
    const away = { x: centroid.x - unitCentroid(threat).x, y: centroid.y - unitCentroid(threat).y };
    const len = Math.hypot(away.x, away.y) || 1;
    return { mode: 'fall_back', goal: { x: centroid.x + (away.x / len) * M, y: centroid.y + (away.y / len) * M } };
  }

  // Candidate goals: hold, each objective (the garrison only considers HOME), the role's
  // standoff approach, retreat/kite.
  const enemies = state.units.filter((e) => e.owner !== unit.owner && isOnBoard(e));
  const home = homeObjective(state, unit.owner);
  const goals: { goal: Vec2 | null; advanceOk: boolean }[] = [{ goal: null, advanceOk: false }];
  for (const o of state.layout.objectives) {
    if (garrison && home && (o.x !== home.x || o.y !== home.y)) continue; // the garrison stays home
    goals.push({ goal: o, advanceOk: true });
  }
  if (enemies.length) {
    const nearest = enemies.reduce((a, b) => (unitGap(a, unit, ctx) < unitGap(b, unit, ctx) ? a : b));
    const nc = unitCentroid(nearest);
    const towards = { x: nc.x - centroid.x, y: nc.y - centroid.y };
    const len = Math.hypot(towards.x, towards.y) || 1;
    const gap = unitGap(unit, nearest, ctx);
    const range = maxWeaponRange(unit, ctx);
    // Close to weapons range (or to melee), but no closer than the ROLE's keep-away band
    // (profile standoff acts as a floor for cagey personalities).
    const standoff = Math.max(plan.standoff, plan.role === 'assault' || plan.role === 'assassin' ? 0 : Math.min(profile.standoff, 12), 0);
    const closeBy = Math.max(0, Math.min(gap - standoff, gap - (range > 0 ? range * 0.6 : 1)));
    if (closeBy > 0.5) goals.push({ goal: { x: centroid.x + (towards.x / len) * closeBy, y: centroid.y + (towards.y / len) * closeBy }, advanceOk: range === 0 });
    // And the kite-away option for soft shooters.
    goals.push({ goal: { x: centroid.x - (towards.x / len) * M, y: centroid.y - (towards.y / len) * M }, advanceOk: false });
  }

  if (profile.random) {
    // True baseline: wander a random legal direction (or hold), no curated goals.
    if (deps.rng.next() < 0.25) return { mode: 'stationary', goal: null };
    const ang = deps.rng.next() * 2 * Math.PI;
    const r = deps.rng.next() * M;
    return { mode: 'normal', goal: { x: centroid.x + Math.cos(ang) * r, y: centroid.y + Math.sin(ang) * r } };
  }

  let best: { score: number; goal: Vec2 | null; advance: boolean } = {
    score: positionScore(state, unit, { x: 0, y: 0 }, profile, deps, plan, garrison) + 0.5, // Remain Stationary edge (Heavy)
    goal: null,
    advance: false,
  };
  for (const g of goals) {
    if (!g.goal) continue;
    const want = { x: g.goal.x - centroid.x, y: g.goal.y - centroid.y };
    const need = Math.hypot(want.x, want.y);
    for (const budget of need > M && g.advanceOk ? [M, M + 3.5] : [M]) {
      const t = need > budget ? budget / need : 1;
      let delta = clampDeltaToBoard(unit, { x: want.x * t, y: want.y * t }, state.layout);
      if (endsEngaged(state, unit, delta, ctx)) {
        // Stop 1.2" short of engagement along the same line rather than discarding the goal.
        const len = Math.hypot(delta.x, delta.y);
        let lo = 0, hi = len;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          const d = len > 0 ? { x: (delta.x / len) * mid, y: (delta.y / len) * mid } : { x: 0, y: 0 };
          if (endsEngaged(state, unit, d, ctx)) hi = mid; else lo = mid;
        }
        delta = len > 0 ? { x: (delta.x / len) * lo, y: (delta.y / len) * lo } : { x: 0, y: 0 };
        if (Math.hypot(delta.x, delta.y) < 0.5) continue;
      }
      const advance = budget > M;
      const score = positionScore(state, unit, delta, profile, deps, plan, garrison) - (advance ? 2 : 0); // Advance forfeits shooting
      if (score > best.score) best = { score, goal: { x: centroid.x + delta.x, y: centroid.y + delta.y }, advance };
    }
  }
  if (!best.goal) return { mode: 'stationary', goal: null };
  const needDist = dist(best.goal, centroid);
  return { mode: best.advance && needDist > M ? 'advance' : 'normal', goal: best.goal };
}

// ── Reserves arrival ──────────────────────────────────────────────────────────
/** The deployment ability an arriving unit uses — MUST match what the intent passes to the
 *  reducer, or the AI would validate one rule and the engine another. */
export function arrivalAbility(unit: UnitInstance, deps: AiDeps): 'standard' | 'deep_strike' {
  const ds = deps.ctx.datasheets.get(unit.datasheetId);
  if (!ds) return 'standard';
  const deep =
    deps.deployAbility(ds) === 'deep_strike' ||
    (ds.abilities ?? []).some((a) => a.name.toLowerCase().includes('deep strike'));
  return deep ? 'deep_strike' : 'standard';
}

/**
 * Find a legal ingress anchor near the most useful objective. Deep Strike units may arrive
 * anywhere more than 8" from enemies (24.09); other strategic reserves must arrive wholly
 * within 6" of a battlefield edge (20.04) — the AI mirrors the reducer's exact legality.
 */
export function findArrivalAnchor(state: GameState, unit: UnitInstance, deps: AiDeps): Vec2 | null {
  const { ctx } = deps;
  const ds = ctx.datasheets.get(unit.datasheetId);
  if (!ds) return null;
  const deepStrike = arrivalAbility(unit, deps) === 'deep_strike';
  const enemies: { pos: Vec2; shape: typeof ds.baseShape }[] = [];
  for (const e of state.units) {
    if (e.owner === unit.owner || e.inReserves) continue;
    const shape = ctx.datasheets.get(e.datasheetId)?.baseShape ?? ds.baseShape;
    for (const m of e.models) if (m.alive) enemies.push({ pos: m.pos, shape });
  }
  const targets = [...state.layout.objectives, { x: state.layout.boardWidth / 2, y: state.layout.boardHeight / 2 }];
  const occupied = occupiedBases(state, ctx, [unit.id]);
  const r = baseRadius(ds.baseShape);
  const W = state.layout.boardWidth;
  const H = state.layout.boardHeight;
  const legalOpts = { deepStrike, layout: state.layout, side: unit.owner };
  for (const step of [2, 1]) {
    let best: { anchor: Vec2; score: number } | null = null;
    for (let x = r + step / 2; x <= W - r; x += step) {
      for (let y = r + step / 2; y <= H - r; y += step) {
        // Non-Deep-Strike ingress: the whole unit must sit within 6" of an edge — skip the
        // interior before doing any geometry.
        if (!deepStrike && Math.min(x, y, W - x, H - y) > 5.5) continue;
        const anchor = { x, y };
        const objDist = Math.min(...targets.map((o) => dist(anchor, o)));
        if (best && objDist >= -best.score) continue; // can't beat the best — skip the geometry
        const positions = formationPositions({ anchor, count: unit.models.length, baseShape: ds.baseShape, formation: 'block', rotation: 0 });
        if (!deepStrikeArrivalLegal(positions, ds.baseShape, enemies, state.round, occupied, legalOpts).legal) continue;
        if (positions.some((p) => p.x < r || p.y < r || p.x > W - r || p.y > H - r)) continue;
        if (!best || -objDist > best.score) best = { anchor, score: -objDist };
      }
    }
    if (best) return best.anchor;
  }
  return null;
}

/**
 * Find a legal TACTICAL disembark anchor: every model wholly within 3" of the transport, no model
 * within Engagement Range of an enemy, no stacked bases. Mirrors the reducer's checks exactly, so
 * an emitted DisembarkUnit intent cannot bounce. Prefers the side of the transport facing the
 * nearest objective.
 */
export function findDisembarkAnchor(
  state: GameState,
  unit: UnitInstance,
  transport: UnitInstance,
  deps: AiDeps,
): Vec2 | null {
  const { ctx } = deps;
  const ds = ctx.datasheets.get(unit.datasheetId);
  const tDs = ctx.datasheets.get(transport.datasheetId);
  if (!ds || !tDs) return null;
  const tAlive = transport.models.filter((m) => m.alive);
  if (!tAlive.length) return null;
  const tc = {
    x: tAlive.reduce((s, m) => s + m.pos.x, 0) / tAlive.length,
    y: tAlive.reduce((s, m) => s + m.pos.y, 0) / tAlive.length,
  };
  const enemies: { pos: Vec2; shape: typeof ds.baseShape }[] = [];
  for (const e of state.units) {
    if (e.owner === unit.owner || e.inReserves) continue;
    const shape = ctx.datasheets.get(e.datasheetId)?.baseShape ?? ds.baseShape;
    for (const m of e.models) if (m.alive) enemies.push({ pos: m.pos, shape });
  }
  const occupied = occupiedBases(state, ctx, [unit.id]);
  const r = baseRadius(ds.baseShape);
  const W = state.layout.boardWidth;
  const H = state.layout.boardHeight;
  const targets = state.layout.objectivePoints?.map((o) => o.pos) ?? state.layout.objectives;
  const toward = targets.length
    ? targets.reduce((a, b) => (dist(tc, a) <= dist(tc, b) ? a : b))
    : { x: W / 2, y: H / 2 };
  const baseAng = Math.atan2(toward.y - tc.y, toward.x - tc.x);
  const tR = baseRadius(tDs.baseShape);
  for (const dr of [1.2, 0.6, 1.8]) {
    for (const off of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
      const ang = baseAng + (off * Math.PI) / 180;
      const anchor = { x: tc.x + (tR + dr) * Math.cos(ang), y: tc.y + (tR + dr) * Math.sin(ang) };
      const positions = formationPositions({
        anchor, count: unit.models.length, baseShape: ds.baseShape, formation: 'block', rotation: 0,
      });
      const ok = positions.every((p) => {
        if (p.x < r || p.y < r || p.x > W - r || p.y > H - r) return false;
        if (Math.min(...tAlive.map((tm) => gapBetweenBases(p, ds.baseShape, tm.pos, tDs.baseShape))) > 3) return false;
        if (enemies.some((e) => gapBetweenBases(p, ds.baseShape, e.pos, e.shape) <= 2)) return false;
        return true;
      });
      if (!ok) continue;
      if (anyOverlap(positions.map((p) => ({ pos: p, shape: ds.baseShape })), occupied)) continue;
      return anchor;
    }
  }
  return null;
}

// ── The Movement decision ─────────────────────────────────────────────────────
export function aiMovementAction(state: GameState, side: Side, profile: AiProfile, deps: AiDeps): AiAction {
  const { ctx } = deps;
  const mine = state.units.filter((u) => u.owner === side && isOnBoard(u));
  // One unit per side garrisons the home objective (holding your own point is free Primary VP).
  const garrisonId = homeGarrisonId(mine, homeObjective(state, side), ctx, (u) => unitValue(u, ctx));

  // Tick B — finish the open activation under the real (post-Advance-roll) budget.
  const moving = mine.find((u) => u.status.moveMode);
  if (moving) {
    const ids = [moving.id];
    const budget = moving.status.moveBudget ?? 0;
    const shape = ctx.datasheets.get(moving.datasheetId)?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
    const coherentNow =
      checkCoherency(aliveModels(moving).map((m) => m.pos), shape).inCoherency &&
      !unitOverlaps(state, moving, ctx);
    if (!coherentNow) {
      // Rare (casualty-shaped) — forfeit the move rather than risk a rejected confirm.
      return {
        intents: [
          { intent: { type: 'CancelMove', unitIds: ids } },
          { intent: { type: 'SetUnitStatus', unitId: moving.id, status: { moved: true } } },
        ],
        note: `${side} regroups ${ctx.datasheets.get(moving.datasheetId)?.name ?? moving.id} (coherency)`,
      };
    }
    const plan = planMove(state, moving, profile, deps, moving.id === garrisonId);
    const centroid = unitCentroid(moving);
    let delta = { x: 0, y: 0 };
    if (plan.goal && budget > 0.05) {
      const want = { x: plan.goal.x - centroid.x, y: plan.goal.y - centroid.y };
      const need = Math.hypot(want.x, want.y);
      const t = need > budget - 0.05 ? (budget - 0.05) / need : 1;
      delta = clampDeltaToBoard(moving, { x: want.x * t, y: want.y * t }, state.layout);
      if (moving.status.moveMode !== 'fall_back' && endsEngaged(state, moving, delta, ctx)) {
        delta = { x: 0, y: 0 };
      }
      // Never END the move with bases stacked on another unit (friend or foe) — back off along
      // the line so EndMove cannot bounce. Passing over models mid-move is fine.
      delta = clampDeltaAvoidingOverlap(unitBases(moving, ctx), occupiedBases(state, ctx, [moving.id]), delta);
    }
    const intents: AiAction['intents'] = [];
    if (Math.hypot(delta.x, delta.y) > 0.01) intents.push({ intent: { type: 'NudgeUnit', unitIds: ids, delta } });
    intents.push({ intent: { type: 'EndMove', unitIds: ids } });
    const name = ctx.datasheets.get(moving.datasheetId)?.name ?? moving.id;
    return { intents, note: `${side} moves ${name} ${Math.hypot(delta.x, delta.y).toFixed(1)}"` };
  }

  // Transports: disembark passengers from round 2 (a tactical disembark before the transport
  // moves lets BOTH act this phase). Round 1 they ride toward the fight.
  if (state.activePlayer === side && state.round >= 2) {
    for (const u of state.units) {
      if (u.owner !== side || !u.embarkedIn || !u.models.some((m) => m.alive)) continue;
      if (u.status.justEmbarked) continue;
      const transport = state.units.find((t) => t.id === u.embarkedIn);
      if (!transport || transport.inReserves || !transport.models.some((m) => m.alive)) continue;
      if (transport.status.advanced || transport.status.fellBack) continue;
      // A Firing Deck platform keeps its passengers an extra round — they shoot from the deck
      // (24.14) instead of hopping out. They still disembark early to grab a nearby objective.
      if (firingDeckX(ctx.datasheets.get(transport.datasheetId)) > 0 && state.round < 3) {
        const tAlive = transport.models.filter((m) => m.alive);
        const tc = {
          x: tAlive.reduce((s, m) => s + m.pos.x, 0) / tAlive.length,
          y: tAlive.reduce((s, m) => s + m.pos.y, 0) / tAlive.length,
        };
        const objs = state.layout.objectivePoints?.map((o) => o.pos) ?? state.layout.objectives;
        const nearObjective = objs.some((o) => dist(tc, o) <= 9);
        if (!nearObjective) continue;
      }
      const anchor = findDisembarkAnchor(state, u, transport, deps);
      if (!anchor) continue;
      const unitId = u.id;
      return {
        intents: [
          {
            intent: { type: 'DisembarkUnit', unitId, anchor, formation: 'block', rotation: 0 },
            skipIf: (s) => {
              const me = s.units.find((x) => x.id === unitId);
              const t = me?.embarkedIn ? s.units.find((x) => x.id === me.embarkedIn) : undefined;
              return !me?.embarkedIn || !t || !t.models.some((m) => m.alive);
            },
          },
        ],
        note: `${side} disembarks ${ctx.datasheets.get(u.datasheetId)?.name ?? u.id}`,
      };
    }
  }

  // Reserves: bring everything on as soon as it may arrive (round 2+).
  if (state.activePlayer === side) {
    for (const u of reservesArrivable(state)) {
      const anchor = findArrivalAnchor(state, u, deps);
      if (!anchor) continue; // no legal spot this turn — try again next round
      return {
        intents: [
          {
            intent: {
              type: 'ArriveFromReserves',
              unitId: u.id,
              anchor,
              formation: 'block',
              rotation: 0,
              ability: arrivalAbility(u, deps),
            },
          },
        ],
        note: `${side} deep-strikes ${ctx.datasheets.get(u.datasheetId)?.name ?? u.id}`,
      };
    }
  }

  // Tick A — open the next activation (most valuable unit first; deterministic tie-break).
  const next = mine
    .filter((u) => !hasMoved(u))
    .sort((a, b) => unitValue(b, ctx) - unitValue(a, ctx) || a.id.localeCompare(b.id))[0];
  if (next) {
    const name = ctx.datasheets.get(next.datasheetId)?.name ?? next.id;
    // Casualties can leave a unit out of coherency (the 7+-model two-neighbour rule); EndMove
    // would refuse to confirm, so forfeit the move instead of opening an unfinishable activation.
    const shape = ctx.datasheets.get(next.datasheetId)?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
    if (!checkCoherency(aliveModels(next).map((m) => m.pos), shape).inCoherency) {
      return {
        intents: [{ intent: { type: 'SetUnitStatus', unitId: next.id, status: { moved: true } } }],
        note: `${side} regroups ${name} (out of coherency — move forfeited)`,
      };
    }
    const plan = planMove(state, next, profile, deps, next.id === garrisonId);
    if (plan.mode === 'stationary') {
      return {
        intents: [
          { intent: { type: 'BeginMove', unitIds: [next.id], mode: 'stationary' } },
          { intent: { type: 'EndMove', unitIds: [next.id] } },
        ],
        note: `${side} holds ${name}`,
      };
    }
    return { intents: [{ intent: { type: 'BeginMove', unitIds: [next.id], mode: plan.mode } }], note: `${side} activates ${name} (${plan.mode})` };
  }

  return { intents: [{ intent: { type: 'AdvancePhase' } }], note: `${side} ends the Movement phase` };
}

// ── Pre-battle Scout moves ────────────────────────────────────────────────────
/** Largest fraction of `delta` that keeps every model of `unit` more than 9" from enemy models
 *  (binary search along the line; 0 is always legal — the unit deployed legally). */
function clampDeltaToNine(state: GameState, unit: UnitInstance, delta: Vec2, ctx: EngineContext): Vec2 {
  const shape = ctx.datasheets.get(unit.datasheetId)?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
  const enemies: { pos: Vec2; shape: typeof shape }[] = [];
  for (const e of state.units) {
    if (e.owner === unit.owner || e.inReserves) continue;
    const eShape = ctx.datasheets.get(e.datasheetId)?.baseShape ?? shape;
    for (const m of e.models) if (m.alive) enemies.push({ pos: m.pos, shape: eShape });
  }
  const legal = (d: Vec2): boolean =>
    unit.models.every(
      (m) => !m.alive || enemies.every((e) => gapBetweenBases({ x: m.pos.x + d.x, y: m.pos.y + d.y }, shape, e.pos, e.shape) > 9.05),
    );
  if (legal(delta)) return delta;
  const len = Math.hypot(delta.x, delta.y);
  if (len < 1e-9) return { x: 0, y: 0 };
  let lo = 0;
  let hi = len;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (legal({ x: (delta.x / len) * mid, y: (delta.y / len) * mid })) lo = mid;
    else hi = mid;
  }
  return { x: (delta.x / len) * lo, y: (delta.y / len) * lo };
}

/**
 * One Scout-move activation for `side` during the pre-battle 'scouts' step: take the next pending
 * Scouts X" unit toward its best objective (role-aware), clamped to X" / the board / the >9" rule.
 * The whole activation is one deterministic batch (no dice): BeginMove(scout) → Nudge → EndMove.
 */
export function aiScoutAction(state: GameState, side: Side, profile: AiProfile, deps: AiDeps): AiAction | null {
  const { ctx } = deps;
  const pending = pendingScoutUnits(state, ctx, side).sort((a, b) => a.id.localeCompare(b.id));
  const unit = pending[0];
  if (!unit) return null;
  const X = unitScoutDistance(unit, ctx) ?? 0;
  const name = ctx.datasheets.get(unit.datasheetId)?.name ?? unit.id;

  // Pick the best destination with the same utility the Movement phase uses (no Advance option).
  const plan = unitRolePlan(unit, ctx);
  const centroid = unitCentroid(unit);
  let best: { score: number; delta: Vec2 } = {
    score: positionScore(state, unit, { x: 0, y: 0 }, profile, deps, plan, false),
    delta: { x: 0, y: 0 },
  };
  for (const o of state.layout.objectives) {
    const want = { x: o.x - centroid.x, y: o.y - centroid.y };
    const need = Math.hypot(want.x, want.y);
    const t = need > X ? X / need : 1;
    let delta = clampDeltaToBoard(unit, { x: want.x * t, y: want.y * t }, state.layout);
    delta = clampDeltaToNine(state, unit, delta, ctx);
    delta = clampDeltaAvoidingOverlap(unitBases(unit, ctx), occupiedBases(state, ctx, [unit.id]), delta);
    if (Math.hypot(delta.x, delta.y) < 0.25) continue;
    const score = positionScore(state, unit, delta, profile, deps, plan, false);
    if (score > best.score) best = { score, delta };
  }

  const unitId = unit.id;
  if (Math.hypot(best.delta.x, best.delta.y) < 0.25) {
    // Nothing worth scouting toward — decline the move.
    return {
      intents: [{ intent: { type: 'SetUnitStatus', unitId, status: { scouted: true } } }],
      note: `${side} holds ${name} (no Scout move)`,
    };
  }
  return {
    intents: [
      { intent: { type: 'BeginMove', unitIds: [unitId], mode: 'scout' } },
      { intent: { type: 'NudgeUnit', unitIds: [unitId], delta: best.delta } },
      { intent: { type: 'EndMove', unitIds: [unitId] } },
    ],
    note: `${side} Scout-moves ${name} ${Math.hypot(best.delta.x, best.delta.y).toFixed(1)}"`,
  };
}
