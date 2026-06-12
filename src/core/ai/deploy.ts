// AI pre-battle decisions: alternating deployment, Reserves, Infiltrators, Leader pairing,
// and team picking. PURE.
//
// Placement legality is exactly the reducer's: candidates are tested with the same
// `checkUnitDeployment` the DeployUnit intent runs, so an emitted intent cannot be rejected.
// Entry keys are `${side}:${index}` — identical to the UI's deployment list, so a game the AI
// deploys looks the same in the panels as one a human deploys.

import type { Datasheet, GameState, Roster, RosterUnit, Side, Vec2 } from '../types';
import { otherSide } from '../setup';
import { checkUnitDeployment, isEntryPlaced, zoneFor, type DeployAbility } from '../deployment';
import { formationPositions } from '../formation';
import { canAttach, isCharacter } from '../leaders';
import { pointInPolygon, distancePointToPolygon, dist } from '../geometry';
import { datasheetThreat, modelValue } from './evaluate';
import type { AiAction, AiDeps, AiIntent } from './types';
import type { AiProfile } from './profile';
import type { EngineContext } from '../engine';

export interface DeployEntry {
  key: string;
  index: number;
  unit: RosterUnit;
  ds: Datasheet;
}

/** A side's deployable roster entries, keyed exactly like the UI (`side:index`). */
export function rosterEntries(roster: Roster | undefined, side: Side, ctx: EngineContext): DeployEntry[] {
  if (!roster) return [];
  return roster.units
    .map((unit, index) => ({ key: `${side}:${index}`, index, unit, ds: ctx.datasheets.get(unit.datasheetId)! }))
    .filter((e) => !!e.ds);
}

/** Entries of `side` not yet on the board or in Reserves. */
export function remainingEntries(state: GameState, side: Side, deps: AiDeps): DeployEntry[] {
  return rosterEntries(deps.rosters[side], side, deps.ctx).filter((e) => !isEntryPlaced(state, e.key));
}

/** The side whose turn it is to place next (mirrors the UI's effectiveSide): `toDeploy` unless
 *  it has nothing left and the other side does. Null when deployment is complete. */
export function deployTurn(state: GameState, deps: AiDeps): Side | null {
  const remaining: Record<Side, number> = {
    player: remainingEntries(state, 'player', deps).length,
    ai: remainingEntries(state, 'ai', deps).length,
  };
  if (remaining.player + remaining.ai === 0) return null;
  const t: Side = state.setup?.toDeploy ?? state.setup?.defender ?? 'player';
  const other = otherSide(t);
  if (remaining[t] === 0 && remaining[other] > 0) return other;
  return t;
}

// ── Leader pairing ────────────────────────────────────────────────────────────
/** AttachLeader intents for every unattached on-board CHARACTER of `side` that has an eligible
 *  on-board bodyguard (one Leader per unit). Safe to emit any time during setup. */
export function pendingLeaderAttaches(state: GameState, side: Side, ctx: EngineContext): AiIntent[] {
  const out: AiIntent[] = [];
  const taken = new Set<string>();
  for (const u of state.units) {
    if (u.owner !== side || u.inReserves || u.attachedTo) continue;
    const ds = ctx.datasheets.get(u.datasheetId);
    if (!isCharacter(ds)) continue;
    const bodyguard = state.units.find(
      (b) =>
        b.owner === side &&
        b.id !== u.id &&
        !b.inReserves &&
        !taken.has(b.id) &&
        (b.attachedLeaders?.length ?? 0) === 0 &&
        !isCharacter(ctx.datasheets.get(b.datasheetId)) &&
        canAttach(ds, ctx.datasheets.get(b.datasheetId)),
    );
    if (!bodyguard) continue;
    taken.add(bodyguard.id);
    const leaderId = u.id;
    const bodyguardId = bodyguard.id;
    out.push({
      intent: { type: 'AttachLeader', leaderUnitId: leaderId, bodyguardUnitId: bodyguardId },
      skipIf: (s) => {
        const l = s.units.find((x) => x.id === leaderId);
        const b = s.units.find((x) => x.id === bodyguardId);
        return !l || !b || !!l.attachedTo || (b.attachedLeaders?.length ?? 0) > 0;
      },
    });
  }
  return out;
}

// ── Anchor search ─────────────────────────────────────────────────────────────
interface Candidate {
  anchor: Vec2;
  score: number;
}

function polygonBounds(poly: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function enemyModelsOnBoard(state: GameState, side: Side, ctx: EngineContext) {
  const out: { pos: Vec2; shape: Datasheet['baseShape'] }[] = [];
  for (const u of state.units) {
    if (u.owner === side || u.inReserves) continue;
    const shape = ctx.datasheets.get(u.datasheetId)?.baseShape ?? { kind: 'circle' as const, radius: 0.63 };
    for (const m of u.models) if (m.alive) out.push({ pos: m.pos, shape });
  }
  return out;
}

/**
 * Find a legal, well-scored deployment anchor for one entry. Scans a grid (standard: over the
 * side's zone; infiltrators: over the whole board), keeps only anchors whose full formation
 * passes `checkUnitDeployment`, and scores by closeness to objectives, role depth, and spacing
 * from already-placed friends. Returns null when nothing legal is found (caller falls back to
 * Reserves so deployment ALWAYS progresses).
 */
export function findDeployAnchor(
  state: GameState,
  side: Side,
  entry: DeployEntry,
  ability: DeployAbility,
  profile: AiProfile,
  deps: AiDeps,
): Vec2 | null {
  const { ctx } = deps;
  const layout = state.layout;
  const zone = ability === 'infiltrators'
    ? [{ x: 0, y: 0 }, { x: layout.boardWidth, y: 0 }, { x: layout.boardWidth, y: layout.boardHeight }, { x: 0, y: layout.boardHeight }]
    : zoneFor(layout, side);
  if (zone.length === 0) return { x: layout.boardWidth / 2, y: layout.boardHeight / 2 };
  const enemyZone = zoneFor(layout, otherSide(side));
  const enemies = enemyModelsOnBoard(state, side, ctx);
  const friends = state.units.filter((u) => u.owner === side && !u.inReserves && u.models.some((m) => m.alive));
  const friendAnchors = friends.map((u) => {
    const ms = u.models.filter((m) => m.alive);
    return { x: ms.reduce((s, m) => s + m.pos.x, 0) / ms.length, y: ms.reduce((s, m) => s + m.pos.y, 0) / ms.length };
  });

  // Role depth: artillery/long guns hug the back of the zone, melee/battleline stand forward.
  const ranged = datasheetThreat(entry.ds, 'ranged');
  const melee = datasheetThreat(entry.ds, 'melee');
  // 0 = right at the zone's front edge, 1 = deepest. Characters middle (they join squads anyway).
  const wantDepth = isCharacter(entry.ds) ? 0.5 : melee > ranged ? 0.1 : ranged > 2 * melee ? 0.8 : 0.35;

  const bounds = polygonBounds(zone);
  const maxDepth = enemyZone.length
    ? Math.max(...zone.map((p) => distancePointToPolygon(p, enemyZone)), 1)
    : Math.max(layout.boardWidth, layout.boardHeight) / 2;

  const evaluate = (step: number): Candidate | null => {
    let best: Candidate | null = null;
    for (let x = bounds.minX + step / 2; x <= bounds.maxX; x += step) {
      for (let y = bounds.minY + step / 2; y <= bounds.maxY; y += step) {
        const anchor = { x, y };
        if (!pointInPolygon(anchor, zone)) continue;
        const positions = formationPositions({
          anchor, count: entry.unit.modelCount, baseShape: entry.ds.baseShape, formation: 'block', rotation: 0,
        });
        if (!checkUnitDeployment(positions, entry.ds.baseShape, layout, side, ability, enemies).legal) continue;

        const objDist = layout.objectives.length
          ? Math.min(...layout.objectives.map((o) => dist(anchor, o)))
          : 0;
        const depth = enemyZone.length ? distancePointToPolygon(anchor, enemyZone) / maxDepth : 0.5;
        const spacing = friendAnchors.length
          ? Math.min(...friendAnchors.map((f) => dist(anchor, f)))
          : 99;
        const score =
          -objDist * profile.objective // pull toward the nearest objective
          - Math.abs(depth - wantDepth) * 12 // hold the role's preferred depth
          + Math.min(spacing, 6) // spread out (capped so it can't dominate)
          + (deps.rng && profile.random ? deps.rng.next() * 100 : 0);
        if (!best || score > best.score) best = { anchor, score };
      }
    }
    return best;
  };

  return evaluate(2)?.anchor ?? evaluate(1)?.anchor ?? evaluate(0.5)?.anchor ?? null;
}

// ── The deployment decision ───────────────────────────────────────────────────
/** Should this entry start in Reserves? Deep Strikers do (profile-gated), Characters don't
 *  (they want to merge with a bodyguard on the board), and never more than half the army. */
function wantsReserves(state: GameState, side: Side, entry: DeployEntry, ability: DeployAbility, profile: AiProfile, deps: AiDeps): boolean {
  if (ability !== 'deep_strike' || !profile.useReserves) return false;
  if (isCharacter(entry.ds)) return false;
  const total = rosterEntries(deps.rosters[side], side, deps.ctx).length;
  const reserved = state.units.filter((u) => u.owner === side && u.inReserves).length;
  return reserved + 1 <= Math.floor(total / 2);
}

/** One deployment drop for `side`: attach any ready Leaders, then place the next entry
 *  (board, Infiltrate position, or Reserves). Null when the side has nothing left to place. */
export function aiDeployAction(state: GameState, side: Side, profile: AiProfile, deps: AiDeps): AiAction | null {
  const attaches = pendingLeaderAttaches(state, side, deps.ctx);
  const remaining = remainingEntries(state, side, deps);
  if (remaining.length === 0) {
    return attaches.length ? { intents: attaches, note: `${side} attaches Leaders` } : null;
  }

  // Place anchors/bodyguards before characters (so leaders have someone to join), big units first.
  const order = [...remaining].sort((a, b) => {
    const ac = isCharacter(a.ds) ? 1 : 0;
    const bc = isCharacter(b.ds) ? 1 : 0;
    if (ac !== bc) return ac - bc;
    const av = modelValue(a.ds) * a.unit.modelCount;
    const bv = modelValue(b.ds) * b.unit.modelCount;
    return bv - av || a.index - b.index;
  });
  const entry = profile.random ? order[deps.rng.int(0, order.length - 1)]! : order[0]!;
  const ability = deps.deployAbility(entry.ds);

  const common = {
    unitId: entry.key,
    owner: side,
    datasheetId: entry.ds.id,
    baseShape: entry.ds.baseShape,
    modelCount: entry.unit.modelCount,
    wounds: entry.ds.models[0]?.W ?? 1,
    ...(entry.unit.wargearCounts ? { wargear: entry.unit.wargearCounts } : {}),
  };

  if (wantsReserves(state, side, entry, ability, profile, deps)) {
    return {
      intents: [...attaches, { intent: { type: 'PlaceInReserves', ...common } }],
      note: `${side} holds ${entry.ds.name} in Reserves (Deep Strike)`,
    };
  }

  const anchor = findDeployAnchor(state, side, entry, ability, profile, deps);
  if (!anchor) {
    // No legal spot (packed zone) — Reserves keeps deployment moving and is always legal.
    return {
      intents: [...attaches, { intent: { type: 'PlaceInReserves', ...common } }],
      note: `${side} holds ${entry.ds.name} in Reserves (no legal deployment spot)`,
    };
  }
  return {
    intents: [...attaches, { intent: { type: 'DeployUnit', ...common, anchor, formation: 'block', rotation: 0, ability } }],
    note: `${side} deploys ${entry.ds.name}${ability === 'infiltrators' ? ' (Infiltrators)' : ''}`,
  };
}

// ── Team pick ─────────────────────────────────────────────────────────────────
/** Pick a roster for the AI from the available pool (only lists that actually have units). */
export function pickRoster(rosters: Roster[], rng: { int(a: number, b: number): number }, avoidName?: string): Roster | undefined {
  const playable = rosters.filter((r) => r.units.length > 0 && r.name !== avoidName);
  const pool = playable.length ? playable : rosters.filter((r) => r.units.length > 0);
  if (pool.length === 0) return undefined;
  return pool[rng.int(0, pool.length - 1)];
}
