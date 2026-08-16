// Deployment-phase transport planning: the Immolator's Declare Battle Formations split rule
// (half the squad starts embarked — the player picks which wargear rides), the start-embarked
// undo, and the "cannot transport X or Y" exclusion fix.

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import type { EngineContext } from '../src/core/engine';
import {
  datasheetMayRide, parseTransportCapacity, splitRideCounts, splitRuleSelects, transportSplitRule,
} from '../src/core/transport';
import { isEntryPlaced } from '../src/core/deployment';
import { ENH } from '../src/core/enhancements';
import { remainingEntries } from '../src/core/ai/deploy';
import type { AiDeps } from '../src/core/ai/types';
import type { BaseShape, Datasheet, GameState, Layout, Roster } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const bigBase: BaseShape = { kind: 'oval', rx: 2.4, ry: 1.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: {
    player: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 44 }, { x: 0, y: 44 }],
    opponent: [{ x: 48, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 44 }, { x: 48, y: 44 }],
  },
};

// The real Immolator transport text (Wahapedia, datasheet 000003819) — capacity + split clause.
const IMMOLATOR_TEXT =
  'This model has a transport capacity of 6 ORDO HERETICUS INFANTRy models.' +
  'At the start of the Declare Battle Formations step, you can select one SISTERS OF BATTlE SQUAD ' +
  'from your army. If you do, that unit is split into two units, each containing as equal a number ' +
  'of models as possible (when splitting a unit in this way, make a note of which models form each ' +
  'of the two new units). One of these units must start the battle embarked within this TRANSPORT; ' +
  'the other can start the battle embarked within another TRANSPORT, or it can be deployed as a ' +
  'separate unit.';

const RHINO_TEXT =
  'This model has a transport capacity of 12 AGENTS OF THE IMpERIUM Infantry models. ' +
  'It cannot transport TERMINATOR or OFFICIO ASSASSINORUM models.';

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AoI', models: [{ name: id, M: 6, T: 3, Sv: 3, W: 1, Ld: 7, OC: 2 }],
  weapons: [], baseShape: circle, keywords: ['Infantry', 'Agents of the Imperium'], abilityIds: [], ...over,
});

const sisters = ds('sisters', {
  name: 'Sisters of Battle Squad',
  keywords: ['Agents of the Imperium', 'Sisters of Battle Squad', 'Imperium', 'Ordo Hereticus', 'Infantry'],
});
const subductors = ds('subductors', {
  name: 'Subductor Squad',
  keywords: ['Agents of the Imperium', 'Adeptus Arbites', 'Subductor Squad', 'Infantry', 'Imperium'],
});
const immolator = ds('immolator', {
  name: 'Sisters of Battle Immolator',
  keywords: ['Agents of the Imperium', 'Transport', 'Dedicated Transport', 'Imperium', 'Ordo Hereticus', 'Immolator', 'Vehicle'],
  transport: IMMOLATOR_TEXT,
  baseShape: bigBase,
  models: [{ name: 'immolator', M: 12, T: 9, Sv: 3, W: 11, Ld: 7, OC: 2 }],
});
const vindicare = ds('vindicare', {
  name: 'Vindicare Assassin',
  keywords: ['Agents of the Imperium', 'Infantry', 'Character', 'Officio Assassinorum', 'Imperium'],
});
const rhino = ds('rhino', {
  name: 'Imperial Rhino',
  keywords: ['Agents of the Imperium', 'Vehicle', 'Transport', 'Dedicated Transport', 'Imperium'],
  transport: RHINO_TEXT,
  baseShape: bigBase,
  models: [{ name: 'rhino', M: 12, T: 9, Sv: 3, W: 10, Ld: 7, OC: 2 }],
});

const ctx: EngineContext = {
  datasheets: new Map<string, Datasheet>([
    ['sisters', sisters], ['subductors', subductors], ['immolator', immolator],
    ['vindicare', vindicare], ['rhino', rhino],
  ]),
};

const rng = makeRNG(7);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);

const SISTERS_GEAR = { Meltagun: 2, 'Heavy bolter': 1, Boltgun: 7 };

/** A fresh match in the deploy step with the player's Immolator already on the board. */
function deployedImmolator(): GameState {
  return run(createInitialState(layout), [
    { type: 'NewBattle' },
    { type: 'SetAttacker', side: 'ai' }, // player is Defender → deploys first
    {
      type: 'DeployUnit', unitId: 'player:0', owner: 'player', datasheetId: 'immolator',
      baseShape: bigBase, modelCount: 1, wounds: 11, anchor: { x: 6, y: 22 },
    },
  ]);
}

const declareSplit = (over: Record<string, unknown> = {}): Intent => ({
  type: 'DeclareSplit', side: 'player', entryKey: 'player:1', datasheetId: 'sisters',
  baseShape: circle, modelCount: 10, wounds: 1, transportUnitId: 'player:0',
  // The riders take both meltas + 3 boltguns (5 bearers for 5 models); the foot half keeps the
  // heavy bolter + 4 boltguns — every item has enough bearers in its half.
  rideCount: 5, rideWargear: { Meltagun: 2, Boltgun: 3 }, totalWargear: SISTERS_GEAR,
  ...over,
} as Intent);

describe('transport split rule parsing', () => {
  it('parses the Immolator split clause and matches the Sisters of Battle Squad', () => {
    const rule = transportSplitRule(immolator)!;
    expect(rule).not.toBeNull();
    expect(rule.selectTokens).toEqual(['sisters', 'of', 'battle', 'squad']);
    expect(splitRuleSelects(rule, sisters)).toBe(true);
    expect(splitRuleSelects(rule, subductors)).toBe(false);
  });
  it('transports without the clause have no split rule', () => {
    expect(transportSplitRule(rhino)).toBeNull();
    expect(transportSplitRule(sisters)).toBeNull();
  });
  it('splitRideCounts: as equal as possible', () => {
    expect(splitRideCounts(10)).toEqual([5]);
    expect(splitRideCounts(9)).toEqual([5, 4]);
    expect(splitRideCounts(1)).toEqual([]);
  });
});

describe('"cannot transport X or Y" exclusions', () => {
  it('each alternative excludes on its own (Rhino: TERMINATOR or OFFICIO ASSASSINORUM)', () => {
    const cap = parseTransportCapacity(RHINO_TEXT)!;
    expect(cap.excluded).toEqual(['terminator', 'officio assassinorum']);
    expect(datasheetMayRide(vindicare, cap)).toBe(false);
    expect(datasheetMayRide(sisters, cap)).toBe(true);
  });
});

describe('DeclareSplit (Immolator: half rides, half walks)', () => {
  it('embarks the chosen riders (with the chosen wargear) and leaves the rest deployable', () => {
    const s = run(deployedImmolator(), [declareSplit()]);
    const riders = s.units.find((u) => u.id === 'player:1#a')!;
    expect(riders).toBeDefined();
    expect(riders.embarkedIn).toBe('player:0');
    expect(riders.inReserves).toBe(true);
    expect(riders.models).toHaveLength(5);
    expect(riders.wargearCounts).toEqual({ Meltagun: 2, Boltgun: 3 });
    const split = s.setup!.splits![0]!;
    expect(split.groups[0]).toEqual({ count: 5, wargear: { Meltagun: 2, Boltgun: 3 } });
    expect(split.groups[1]).toEqual({ count: 5, wargear: { 'Heavy bolter': 1, Boltgun: 4 } });
    // The declaration consumed the player's placement slot.
    expect(s.setup!.toDeploy).toBe('ai');
    // The parent entry is not "placed" until the on-foot half is down too.
    expect(isEntryPlaced(s, 'player:1')).toBe(false);
    const s2 = run(s, [
      {
        type: 'DeployUnit', unitId: 'player:1#b', owner: 'player', datasheetId: 'sisters',
        baseShape: circle, modelCount: 5, wounds: 1, anchor: { x: 6, y: 10 },
        wargear: split.groups[1]!.wargear,
      },
    ]);
    expect(isEntryPlaced(s2, 'player:1')).toBe(true);
  });

  it('rejects an unequal split, a non-selectable unit, and a double split', () => {
    const base = deployedImmolator();
    const bad1 = run(base, [declareSplit({ rideCount: 6 })]);
    expect(bad1.units.find((u) => u.id === 'player:1#a')).toBeUndefined();
    expect(bad1.log.at(-1)).toMatch(/Split rejected: .*as equal as possible/);

    const bad2 = run(base, [declareSplit({ datasheetId: 'subductors', entryKey: 'player:2' })]);
    expect(bad2.log.at(-1)).toMatch(/Split rejected: .*cannot select/);

    const once = run(base, [declareSplit()]);
    const twice = run(once, [declareSplit()]);
    expect(twice.log.at(-1)).toMatch(/Split rejected: .*already split/);
  });

  it('every wargear item needs enough bearers in its half', () => {
    const base = deployedImmolator();
    // 6 boltguns cannot ride with only 5 models riding.
    const bad1 = run(base, [declareSplit({ rideWargear: { Boltgun: 6 } })]);
    expect(bad1.log.at(-1)).toMatch(/Split rejected: only 5 models ride/);
    // Leaving all 7 boltguns with the 5 on-foot models is just as impossible.
    const bad2 = run(base, [declareSplit({ rideWargear: { Meltagun: 2 } })]);
    expect(bad2.log.at(-1)).toMatch(/Split rejected: .*7× Boltgun.*only 5 models on foot/);
  });

  it('rejects riding wargear the unit does not have; a transport in Strategic Reserves may carry the riders (20.01)', () => {
    const base = deployedImmolator();
    const bad = run(base, [declareSplit({ rideWargear: { Meltagun: 3 } })]);
    expect(bad.log.at(-1)).toMatch(/Split rejected: .*only has 2/);

    // 20.01 explicitly allows Strategic Reserves transports with units embarked within them —
    // the riding half joins the reserved Immolator and arrives with it.
    const withReserved = run(base, [
      {
        type: 'PlaceInReserves', unitId: 'player:3', owner: 'player', datasheetId: 'immolator',
        baseShape: bigBase, modelCount: 1, wounds: 11,
      },
    ]);
    const ok = run(withReserved, [declareSplit({ transportUnitId: 'player:3' })]);
    const riders = ok.units.find((u) => u.id === 'player:1#a')!;
    expect(riders).toBeDefined();
    expect(riders.embarkedIn).toBe('player:3');
    expect(riders.inReserves).toBe(true);
  });

  it('ClearSplit removes both halves and restores the whole entry', () => {
    const s = run(deployedImmolator(), [declareSplit()]);
    const s2 = run(s, [
      {
        type: 'DeployUnit', unitId: 'player:1#b', owner: 'player', datasheetId: 'sisters',
        baseShape: circle, modelCount: 5, wounds: 1, anchor: { x: 6, y: 10 },
      },
      { type: 'ClearSplit', entryKey: 'player:1' },
    ]);
    expect(s2.units.find((u) => u.id === 'player:1#a')).toBeUndefined();
    expect(s2.units.find((u) => u.id === 'player:1#b')).toBeUndefined();
    expect(s2.setup!.splits).toHaveLength(0);
    expect(isEntryPlaced(s2, 'player:1')).toBe(false);
  });
});

describe('splits and the rest of the system', () => {
  it('AI deployment sees the split halves, not the parent entry (no duplicate deploys)', () => {
    const s = run(deployedImmolator(), [declareSplit()]);
    const roster: Roster = {
      name: 't', faction: 'AoI', detachment: 'Imperialis Fleet', points: 200,
      units: [
        { datasheetId: 'immolator', modelCount: 1 },
        { datasheetId: 'sisters', modelCount: 10, wargearCounts: SISTERS_GEAR },
      ],
    };
    const deps: AiDeps = {
      ctx, rosters: { player: roster }, detachments: {}, deployAbility: () => 'standard',
      stratagems: [], rng: makeRNG(1),
    };
    const rem = remainingEntries(s, 'player', deps);
    expect(rem.map((e) => e.key)).toEqual(['player:1#b']); // riders are placed; parent key gone
    expect(rem[0]!.unit.modelCount).toBe(5);
    expect(rem[0]!.unit.wargearCounts).toEqual({ 'Heavy bolter': 1, Boltgun: 4 });
  });

  it('an enhancement redeploy refuses to pull a transport carrying embarked units', () => {
    const s = run(deployedImmolator(), [
      declareSplit(),
      // Redeploys are a deploy-step window — pass Declare Battle Formations first.
      { type: 'FinishFormations', side: 'player' },
      { type: 'FinishFormations', side: 'ai' },
      { type: 'UseEnhancementRedeploy', side: 'player', enhancementId: ENH.LIBER_HERESIUS },
      { type: 'EnhancementRedeploy', unitId: 'player:0' },
    ]);
    expect(s.units.find((u) => u.id === 'player:0')).toBeDefined(); // still on the board
    expect(s.log.at(-1)).toMatch(/carrying embarked units/);
  });
});

describe('UndeployUnit (undo a start-embarked deployment)', () => {
  it('returns an embarked unit to the deployment pool during setup', () => {
    const s = run(deployedImmolator(), [
      {
        type: 'DeployUnit', unitId: 'player:4', owner: 'player', datasheetId: 'sisters',
        baseShape: circle, modelCount: 5, wounds: 1, anchor: { x: 0, y: 0 },
        intoTransportId: 'player:0',
      },
    ]);
    expect(s.units.find((u) => u.id === 'player:4')!.embarkedIn).toBe('player:0');
    const undone = run(s, [{ type: 'UndeployUnit', unitId: 'player:4' }]);
    expect(undone.units.find((u) => u.id === 'player:4')).toBeUndefined();
    expect(isEntryPlaced(undone, 'player:4')).toBe(false);
  });

  it('refuses the riding half (ClearSplit instead) and on-board units', () => {
    const s = run(deployedImmolator(), [declareSplit()]);
    const kept = run(s, [{ type: 'UndeployUnit', unitId: 'player:1#a' }]);
    expect(kept.units.find((u) => u.id === 'player:1#a')).toBeDefined();
    expect(kept.log.at(-1)).toMatch(/Undo rejected: .*clear the split/);

    const kept2 = run(s, [{ type: 'UndeployUnit', unitId: 'player:0' }]);
    expect(kept2.units.find((u) => u.id === 'player:0')).toBeDefined();
    expect(kept2.log.at(-1)).toMatch(/Undo rejected: only a start-embarked/);
  });

  it('the on-foot half embarked in a SECOND transport can undo its embark', () => {
    // Rule: "the other can start the battle embarked within another TRANSPORT".
    const s = run(deployedImmolator(), [
      declareSplit(),
      {
        type: 'DeployUnit', unitId: 'player:9', owner: 'player', datasheetId: 'immolator',
        baseShape: bigBase, modelCount: 1, wounds: 11, anchor: { x: 6, y: 34 },
      },
      {
        type: 'DeployUnit', unitId: 'player:1#b', owner: 'player', datasheetId: 'sisters',
        baseShape: circle, modelCount: 5, wounds: 1, anchor: { x: 0, y: 0 },
        intoTransportId: 'player:9',
      },
    ]);
    expect(s.units.find((u) => u.id === 'player:1#b')!.embarkedIn).toBe('player:9');
    const undone = run(s, [{ type: 'UndeployUnit', unitId: 'player:1#b' }]);
    expect(undone.units.find((u) => u.id === 'player:1#b')).toBeUndefined();
    // The split itself survives — only the #b embark was undone.
    expect(undone.setup!.splits).toHaveLength(1);
  });

  it('ClearSplit also clears a Leader pairing declared onto a half', () => {
    const s = run(deployedImmolator(), [declareSplit()]);
    const withFormation = {
      ...s,
      setup: {
        ...s.setup!,
        formations: [{ side: 'player' as const, leaderKey: 'player:7', leaderDsId: 'x', bodyguardKey: 'player:1#b', bodyguardDsId: 'sisters' }],
      },
    };
    const cleared = run(withFormation, [{ type: 'ClearSplit', entryKey: 'player:1' }]);
    expect(cleared.setup!.formations).toHaveLength(0);
  });
});
