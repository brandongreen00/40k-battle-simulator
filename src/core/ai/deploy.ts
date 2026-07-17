// AI pre-battle decisions: alternating deployment, Reserves, Infiltrators, Leader pairing,
// and team picking. PURE.
//
// Placement legality is exactly the reducer's: candidates are tested with the same
// `checkUnitDeployment` the DeployUnit intent runs, so an emitted intent cannot be rejected.
// Entry keys are `${side}:${index}` — identical to the UI's deployment list, so a game the AI
// deploys looks the same in the panels as one a human deploys.

import type { Datasheet, DeclaredFormation, GameState, Roster, RosterUnit, Side, Vec2 } from '../types';
import { otherSide } from '../setup';
import { checkUnitDeployment, isEntryPlaced, zoneFor, type DeployAbility } from '../deployment';
import { grantedDeployAbility } from '../enhancements';
import { occupiedBases } from '../collision';
import { formationPositions } from '../formation';
import { canAttach, isCharacter } from '../leaders';
import { pointInPolygon, distancePointToPolygon, dist } from '../geometry';
import { hasBackroomDeals, hasLoneOperative } from '../abilities';
import { canEmbark, embarkedUnits, isAircraft } from '../transport';
import { modelValue } from './evaluate';
import { classifyDatasheet, rolePlan } from './roles';
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
  const occupied = occupiedBases(state, ctx); // both sides — bases may never stack
  const friends = state.units.filter((u) => u.owner === side && !u.inReserves && u.models.some((m) => m.alive));
  const friendAnchors = friends.map((u) => {
    const ms = u.models.filter((m) => m.alive);
    return { x: ms.reduce((s, m) => s + m.pos.x, 0) / ms.length, y: ms.reduce((s, m) => s + m.pos.y, 0) / ms.length };
  });

  // Role depth (0 = right at the zone's front edge, 1 = deepest): snipers/artillery hug the back,
  // assault/assassins stand forward, battleline holds the midline. The role also scales how hard
  // objectives pull on the anchor — a sniper does not deploy ONTO a marker just because it is
  // near one (the old behaviour that walked the Vindicare to the midfield). See ai/roles.ts.
  const range = Math.max(0, ...entry.ds.weapons.filter((w) => w.type === 'ranged').map((w) => w.range ?? 0));
  const plan = rolePlan(classifyDatasheet(entry.ds), range);
  const wantDepth = plan.wantDepth;

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
        if (!checkUnitDeployment(positions, entry.ds.baseShape, layout, side, ability, enemies, occupied).legal) continue;

        const objDist = layout.objectives.length
          ? Math.min(...layout.objectives.map((o) => dist(anchor, o)))
          : 0;
        const depth = enemyZone.length ? distancePointToPolygon(anchor, enemyZone) / maxDepth : 0.5;
        const spacing = friendAnchors.length
          ? Math.min(...friendAnchors.map((f) => dist(anchor, f)))
          : 99;
        const score =
          -objDist * profile.objective * plan.objectiveWeight // role-scaled objective pull
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

// ── Declare Battle Formations (pre-deployment Leader pairings) ────────────────
/** The declared pairing whose Bodyguard is this entry (so the pair deploys together). */
export function formationForBodyguard(state: GameState, entryKey: string): DeclaredFormation | undefined {
  return (state.setup?.formations ?? []).find((f) => f.bodyguardKey === entryKey);
}

/** Is this entry a Leader that has been paired (it deploys with its Bodyguard, not alone)? */
export function isPairedLeader(state: GameState, entryKey: string): boolean {
  return (state.setup?.formations ?? []).some((f) => f.leaderKey === entryKey);
}

/** The deployment ability a declared pair sets up with: the Backroom-Deals/both-Infiltrators grant,
 *  or Deep Strike only when BOTH halves have it (10e: every model needs the ability). */
export function pairDeployAbility(
  f: DeclaredFormation,
  ctx: EngineContext,
  deployAbility: (ds: Datasheet) => DeployAbility,
): DeployAbility {
  if (f.infiltrate) return 'infiltrators';
  const lDs = ctx.datasheets.get(f.leaderDsId);
  const bDs = ctx.datasheets.get(f.bodyguardDsId);
  if (lDs && bDs && deployAbility(lDs) === 'deep_strike' && deployAbility(bDs) === 'deep_strike') return 'deep_strike';
  return 'standard';
}

/**
 * The Leader pairings `side` wants to declare, given what is still undeployed: each unpaired
 * CHARACTER entry joins its best eligible Bodyguard entry (Backroom Deals leaders pick the
 * biggest BATTLELINE unit so the Infiltrators grant moves a real brick up the board).
 */
export function desiredFormations(state: GameState, side: Side, deps: AiDeps): AiIntent[] {
  const declared = state.setup?.formations ?? [];
  const out: AiIntent[] = [];
  const takenBodyguards = new Set(declared.map((f) => f.bodyguardKey));
  const remaining = remainingEntries(state, side, deps);
  const leaders = remaining.filter(
    (e) => isCharacter(e.ds) && !declared.some((f) => f.leaderKey === e.key),
  );
  // Backroom Deals leaders declare first so the one-per-army Infiltrators grant lands on them.
  leaders.sort((a, b) => Number(hasBackroomDeals(b.ds)) - Number(hasBackroomDeals(a.ds)) || a.index - b.index);
  for (const leader of leaders) {
    const candidates = remaining.filter(
      (e) =>
        !isCharacter(e.ds) &&
        !takenBodyguards.has(e.key) &&
        e.key !== leader.key &&
        canAttach(leader.ds, e.ds),
    );
    if (candidates.length === 0) continue;
    const wantBattleline = hasBackroomDeals(leader.ds);
    const score = (e: DeployEntry): number => {
      let s = modelValue(e.ds) * e.unit.modelCount;
      if (wantBattleline && e.ds.keywords.some((k) => k.toLowerCase() === 'battleline')) s += 1000;
      // Attaching strips a deployment ability the leader does not share (every model needs it) —
      // do not delete a unit's Deep Strike/Infiltrators just to give it a leader.
      const ba = deps.deployAbility(e.ds);
      if (ba !== 'standard' && deps.deployAbility(leader.ds) !== ba && !hasBackroomDeals(leader.ds)) s -= 500;
      return s;
    };
    const pick = candidates.reduce((x, y) => (score(y) > score(x) ? y : x));
    takenBodyguards.add(pick.key);
    const leaderKey = leader.key;
    const bodyguardKey = pick.key;
    out.push({
      intent: {
        type: 'DeclareFormation',
        side,
        leaderKey,
        leaderDsId: leader.ds.id,
        bodyguardKey,
        bodyguardDsId: pick.ds.id,
      },
      skipIf: (s) =>
        (s.setup?.formations ?? []).some((f) => f.leaderKey === leaderKey || f.bodyguardKey === bodyguardKey) ||
        isEntryPlaced(s, leaderKey) ||
        isEntryPlaced(s, bodyguardKey),
    });
  }
  return out;
}

// ── The deployment decision ───────────────────────────────────────────────────
/** Should this entry start in Reserves? Deep Strikers do (profile-gated), Characters don't
 *  (they want to merge with a bodyguard on the board), and never more than half the army. */
function wantsReserves(state: GameState, side: Side, entry: DeployEntry, ability: DeployAbility, profile: AiProfile, deps: AiDeps): boolean {
  // AIRCRAFT must start in Strategic Reserves (23.01) — the reducer enforces it, so this is
  // not profile-gated.
  if (isAircraft(entry.ds)) return true;
  if (!profile.useReserves) return false;
  // Lone Operative characters that ALSO have Deep Strike (the Callidus has Infiltrators too, so
  // her classified ability is 'infiltrators') survive by arriving from Reserves on round 2 —
  // infiltrating to the 9" line parks them inside the enemy's 12" targeting bubble after one
  // move, and the logs showed the Callidus dying on round 1 in 10 straight games.
  const loneOpDeepStrike =
    isCharacter(entry.ds) &&
    hasLoneOperative(entry.ds) &&
    (entry.ds.abilities ?? []).some((a) => a.name.toLowerCase().includes('deep strike'));
  if (ability !== 'deep_strike' && !loneOpDeepStrike) return false;
  if (isCharacter(entry.ds) && !loneOpDeepStrike) return false;
  const total = rosterEntries(deps.rosters[side], side, deps.ctx).length;
  const reserved = state.units.filter((u) => u.owner === side && u.inReserves).length;
  return reserved + 1 <= Math.floor(total / 2);
}

/** One deployment drop for `side`: declare Leader pairings first (their own action, so the
 *  reducer computes the Infiltrators grant before anything is placed), then place the next
 *  entry — a paired Bodyguard brings its Leader down with it, merged. Null when nothing is left. */
export function aiDeployAction(state: GameState, side: Side, profile: AiProfile, deps: AiDeps): AiAction | null {
  // Pre-battle Secondary Missions choice (secret): Fixed when the enemy roster offers reliable
  // kill targets for the FIXED cards, otherwise Tactical (draw). Decided once, before any drop.
  if (state.secondaries && !state.secondaries[side].mode) {
    const enemy = deps.rosters[otherSide(side)];
    let bigModels = 0; // W10+ models (Bring It Down FIXED: 4VP each)
    let characters = 0; // CHARACTER units (Assassination FIXED: 3VP+1)
    let hordes = 0; // Starting Strength 13+ units (A Grievous Blow FIXED: 4VP each)
    for (const u of enemy?.units ?? []) {
      const ds = deps.ctx.datasheets.get(u.datasheetId);
      if (!ds) continue;
      if ((ds.models[0]?.W ?? 0) >= 10) bigModels += u.modelCount;
      if (ds.keywords.some((k) => k.toLowerCase() === 'character')) characters++;
      if (u.modelCount >= 13) hordes++;
    }
    const scores: [string, number][] = [
      ['bring_it_down', Math.min(bigModels, 5) * 4],
      ['assassination', Math.min(characters, 5) * 3.5],
      ['a_grievous_blow', Math.min(hordes, 5) * 4],
      ['engage_all_fronts', 9], // ~2VP/turn baseline for a board-playing army
    ];
    scores.sort((a, b) => b[1] - a[1]);
    const [first, second] = [scores[0]!, scores[1]!];
    const fixedWorth = first[1] + second[1];
    const intent: AiIntent = {
      intent:
        fixedWorth >= 26
          ? { type: 'ChooseSecondaryMode', side, fixedCardIds: [first[0], second[0]] as [string, string] }
          : { type: 'ChooseSecondaryMode', side },
    };
    return {
      intents: [intent],
      note:
        fixedWorth >= 26
          ? `${side} picks FIXED missions (${first[0]} + ${second[0]})`
          : `${side} will draw Tactical Missions`,
    };
  }

  // Declare Battle Formations before the side's first drop.
  const formations = desiredFormations(state, side, deps);
  if (formations.length > 0) {
    return { intents: formations, note: `${side} declares battle formations (Leader pairings)` };
  }

  const attaches = pendingLeaderAttaches(state, side, deps.ctx);
  const allRemaining = remainingEntries(state, side, deps);
  // Paired Leaders deploy with their Bodyguard — never alone.
  const remaining = allRemaining.filter((e) => !isPairedLeader(state, e.key));

  if (remaining.length === 0) {
    // Rescue any stranded paired Leader (its Bodyguard is already down but the Leader's own
    // deploy was skipped): Reserves placement is always legal, and the merge re-seats its models
    // into coherency with the on-board unit.
    const stranded = allRemaining.filter((e) => isPairedLeader(state, e.key));
    for (const le of stranded) {
      const f = (state.setup?.formations ?? []).find((x) => x.leaderKey === le.key)!;
      const bodyguard = state.units.find((u) => u.id === f.bodyguardKey);
      if (!bodyguard) continue;
      const leaderUnitId = le.key;
      const bodyguardUnitId = bodyguard.id;
      return {
        intents: [
          {
            intent: {
              type: 'PlaceInReserves',
              unitId: le.key, owner: side, datasheetId: le.ds.id, baseShape: le.ds.baseShape,
              modelCount: le.unit.modelCount, wounds: le.ds.models[0]?.W ?? 1,
              ...(le.unit.wargearCounts ? { wargear: le.unit.wargearCounts } : {}),
            },
          },
          {
            intent: { type: 'AttachLeader', leaderUnitId, bodyguardUnitId },
            skipIf: (s) => {
              const b = s.units.find((u) => u.id === bodyguardUnitId);
              return !s.units.some((u) => u.id === leaderUnitId) || !b || (b.attachedLeaders?.length ?? 0) > 0;
            },
          },
        ],
        note: `${side} joins ${le.ds.name} to its unit`,
      };
    }
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

  const pair = formationForBodyguard(state, entry.key);
  const pairedLeaderEntry = pair
    ? rosterEntries(deps.rosters[side], side, deps.ctx).find((e) => e.key === pair.leaderKey)
    : undefined;
  const baseAbility: DeployAbility = pair
    ? pairDeployAbility(pair, deps.ctx, deps.deployAbility)
    : deps.deployAbility(entry.ds);
  // A declared Battle Formations grant (Clandestine Operation's Infiltrators) upgrades a standard
  // deployer; datasheet Deep Strike / Infiltrators keep priority.
  const grantAb = grantedDeployAbility(state, entry.key);
  const ability: DeployAbility = baseAbility === 'standard' && grantAb === 'infiltrators' ? 'infiltrators' : baseAbility;

  const common = {
    unitId: entry.key,
    owner: side,
    datasheetId: entry.ds.id,
    baseShape: entry.ds.baseShape,
    modelCount: entry.unit.modelCount,
    wounds: entry.ds.models[0]?.W ?? 1,
    ...(entry.unit.wargearCounts ? { wargear: entry.unit.wargearCounts } : {}),
    ...(entry.unit.enhancementId ? { enhancementId: entry.unit.enhancementId } : {}),
  };
  const leaderCommon = pairedLeaderEntry
    ? {
        unitId: pairedLeaderEntry.key,
        owner: side,
        datasheetId: pairedLeaderEntry.ds.id,
        baseShape: pairedLeaderEntry.ds.baseShape,
        modelCount: pairedLeaderEntry.unit.modelCount,
        wounds: pairedLeaderEntry.ds.models[0]?.W ?? 1,
        ...(pairedLeaderEntry.unit.wargearCounts ? { wargear: pairedLeaderEntry.unit.wargearCounts } : {}),
        ...(pairedLeaderEntry.unit.enhancementId ? { enhancementId: pairedLeaderEntry.unit.enhancementId } : {}),
      }
    : null;
  const mergeIntents = (leaderUnitId: string, bodyguardUnitId: string): AiIntent => ({
    intent: { type: 'AttachLeader', leaderUnitId, bodyguardUnitId },
    skipIf: (s) => {
      const b = s.units.find((u) => u.id === bodyguardUnitId);
      return !s.units.some((u) => u.id === leaderUnitId) || !b || (b.attachedLeaders?.length ?? 0) > 0;
    },
  });

  if (!pair && wantsReserves(state, side, entry, ability, profile, deps)) {
    return {
      intents: [...attaches, { intent: { type: 'PlaceInReserves', ...common } }],
      note: `${side} holds ${entry.ds.name} in Reserves (Deep Strike)`,
    };
  }
  // Start embarked (18.01): an unpaired INFANTRY unit rides an already-deployed, still-empty
  // friendly transport it fits in — it deploys safe and disembarks near the action from round 2.
  if (!pair && !isCharacter(entry.ds) && entry.ds.keywords.some((k) => k.toLowerCase() === 'infantry')) {
    const bus = state.units.find((t) => {
      if (t.owner !== side || t.inReserves || !t.models.some((m) => m.alive)) return false;
      if (embarkedUnits(state, t.id).length > 0) return false; // one passenger unit per transport (policy)
      const probe: import('../types').UnitInstance = {
        id: entry.key, owner: side, datasheetId: entry.ds.id,
        models: Array.from({ length: entry.unit.modelCount }, (_, i) => ({
          id: `${entry.key}:m${i}`, unitId: entry.key, pos: { x: 0, y: 0 }, wounds: 1, alive: true,
        })),
        startingModels: entry.unit.modelCount, status: {},
      };
      return canEmbark(state, probe, t, deps.ctx).ok;
    });
    if (bus) {
      return {
        intents: [...attaches, { intent: { type: 'DeployUnit', ...common, anchor: { x: 0, y: 0 }, intoTransportId: bus.id } }],
        note: `${side} deploys ${entry.ds.name} embarked within ${deps.ctx.datasheets.get(bus.datasheetId)?.name ?? bus.id}`,
      };
    }
  }
  // A paired unit where BOTH halves Deep Strike may start in Reserves together.
  if (pair && leaderCommon && ability === 'deep_strike' && profile.useReserves) {
    return {
      intents: [
        ...attaches,
        { intent: { type: 'PlaceInReserves', ...common } },
        { intent: { type: 'PlaceInReserves', ...leaderCommon } },
        mergeIntents(leaderCommon.unitId, common.unitId),
      ],
      note: `${side} holds ${entry.ds.name} (led) in Reserves (Deep Strike)`,
    };
  }

  const onBoardAbility: DeployAbility = ability === 'deep_strike' ? 'standard' : ability;
  const anchor = findDeployAnchor(state, side, entry, onBoardAbility, profile, deps);
  if (!anchor) {
    // No legal spot (packed zone) — Reserves keeps deployment moving and is always legal.
    const reserveIntents: AiIntent[] = [...attaches, { intent: { type: 'PlaceInReserves', ...common } }];
    if (leaderCommon) {
      reserveIntents.push({ intent: { type: 'PlaceInReserves', ...leaderCommon } });
      reserveIntents.push(mergeIntents(leaderCommon.unitId, common.unitId));
    }
    return { intents: reserveIntents, note: `${side} holds ${entry.ds.name} in Reserves (no legal deployment spot)` };
  }

  const intents: AiIntent[] = [
    ...attaches,
    { intent: { type: 'DeployUnit', ...common, anchor, formation: 'block', rotation: 0, ability: onBoardAbility } },
  ];
  let note = `${side} deploys ${entry.ds.name}${onBoardAbility === 'infiltrators' ? ' (Infiltrators)' : ''}`;
  if (leaderCommon) {
    // The Leader physically joins the unit it leads. It cannot be DROPPED on the unit (bases never
    // stack), so stage it via Reserves and merge — AttachLeader re-seats its models into
    // base-to-base coherency with the on-board unit, avoiding every occupied base.
    const leaderUnitId = leaderCommon.unitId;
    const bodyguardUnitId = common.unitId;
    intents.push({
      intent: { type: 'PlaceInReserves', ...leaderCommon },
      skipIf: (s) => isEntryPlaced(s, leaderUnitId) || !isEntryPlaced(s, bodyguardUnitId),
    });
    intents.push(mergeIntents(leaderUnitId, bodyguardUnitId));
    note = `${side} deploys ${entry.ds.name} led by ${pairedLeaderEntry!.ds.name}${onBoardAbility === 'infiltrators' ? ' (Infiltrators)' : ''}`;
  }
  return { intents, note };
}

// ── Team pick ─────────────────────────────────────────────────────────────────
/** Pick a roster for the AI from the available pool (only lists that actually have units). */
export function pickRoster(rosters: Roster[], rng: { int(a: number, b: number): number }, avoidName?: string): Roster | undefined {
  const playable = rosters.filter((r) => r.units.length > 0 && r.name !== avoidName);
  const pool = playable.length ? playable : rosters.filter((r) => r.units.length > 0);
  if (pool.length === 0) return undefined;
  return pool[rng.int(0, pool.length - 1)];
}
