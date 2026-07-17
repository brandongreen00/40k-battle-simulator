// Enhancement effects: unit-level effect bindings, bearer-scoped weapon grants, deployment
// grants (Clandestine Operation / Combat Landers), enhancement redeploys (Liber Heresius),
// Fire-Overwatch immunity, OC/Ld/W bonuses, and the transport carve-outs.

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { objectiveControl, type EngineContext } from '../src/core/engine';
import {
  ENH, PREBATTLE_GRANTS, blocksOverwatch, enhancementEffectIds, enhancementLdBonus,
  enhancementOcBonus, enhancementWeaponGrantFor, enhancementWoundBonus, grantSelects,
  grantedDeployAbility,
} from '../src/core/enhancements';
import { enhancementGrantPending, enhancementRedeployPending, aiAction, whoActs } from '../src/core/ai/controller';
import { disembarkMode } from '../src/core/transport';
import { unitScoutDistance } from '../src/core/abilities';
import { ordersAvailableTo, unitIsOfficer } from '../src/core/orders';
import type { AiDeps } from '../src/core/ai/types';
import type { BaseShape, Datasheet, GameState, Layout, Roster, UnitInstance } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [],
  objectives: [{ x: 30, y: 22 }],
  deploymentZones: {
    player: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 44 }, { x: 0, y: 44 }],
    opponent: [{ x: 48, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 44 }, { x: 48, y: 44 }],
  },
};

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AoI', models: [{ name: id, M: 6, T: 3, Sv: 3, W: 3, Ld: 6, OC: 2 }],
  weapons: [], baseShape: circle, keywords: ['Agents of the Imperium', 'Infantry', 'Imperium'], abilityIds: [], ...over,
});

const subductors = ds('subductors', { name: 'Subductor Squad' });
const gkTerms = ds('gkterms', { name: 'Grey Knights Terminator Squad', keywords: ['Agents of the Imperium', 'Infantry', 'Terminator'] });
const inquisitor = ds('inquisitor', { name: 'Inquisitor', keywords: ['Agents of the Imperium', 'Infantry', 'Character', 'Inquisitor'] });
const tank = ds('tank', { name: 'Tank', keywords: ['Astra Militarum', 'Vehicle', 'Squadron'] });

const ctx: EngineContext = {
  datasheets: new Map([
    ['subductors', subductors], ['gkterms', gkTerms], ['inquisitor', inquisitor], ['tank', tank],
  ]),
};

const rng = makeRNG(11);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);

const mkUnit = (over: Partial<UnitInstance> = {}): UnitInstance => ({
  id: 'u1', owner: 'player', datasheetId: 'subductors',
  models: [{ id: 'u1:m0', unitId: 'u1', pos: { x: 5, y: 5 }, wounds: 3, alive: true }],
  startingModels: 1, status: {}, ...over,
});

describe('enhancement effect bindings', () => {
  it('static and conditional effect ids', () => {
    expect(enhancementEffectIds(mkUnit({ enhancementId: ENH.WITCH_HUNTER }))).toContain('enh:witch_hunter');
    expect(enhancementEffectIds(mkUnit({ enhancementId: ENH.VETERAN_CREW }))).toContain('reroll_hits_1');
    // Drill Commander only while Remained Stationary.
    const dc = mkUnit({ enhancementId: ENH.DRILL_COMMANDER });
    expect(enhancementEffectIds(dc)).not.toContain('enh:crit5_ranged');
    expect(enhancementEffectIds({ ...dc, status: { remainedStationary: true } })).toContain('enh:crit5_ranged');
    // Blackweave Shroud binds only while the bearer fights alone (no merged squad over-buff).
    const bw = mkUnit({ enhancementId: ENH.BLACKWEAVE_SHROUD });
    expect(enhancementEffectIds(bw)).toContain('fnp_4');
    expect(
      enhancementEffectIds({
        ...bw,
        attachedLeaders: [{ unitId: 'x', datasheetId: 'inquisitor', modelCount: 1, wounds: 4 }],
      }),
    ).not.toContain('fnp_4');
  });

  it("a merged Leader's enhancement covers the led unit", () => {
    const merged = mkUnit({
      attachedLeaders: [{ unitId: 'x', datasheetId: 'inquisitor', modelCount: 1, wounds: 4, enhancementId: ENH.WITCH_HUNTER }],
    });
    expect(enhancementEffectIds(merged)).toContain('enh:witch_hunter');
  });

  it('weapon grants apply only to weapons fired from the BEARER’s datasheet', () => {
    const merged = mkUnit({
      attachedLeaders: [{ unitId: 'x', datasheetId: 'inquisitor', modelCount: 1, wounds: 4, enhancementId: ENH.IGNIS_JUDICIUM }],
    });
    const grant = enhancementWeaponGrantFor(merged, 'inquisitor');
    expect(grant).toMatchObject({ devastatingWounds: true, melta: 1, precision: true, type: 'ranged' });
    expect(enhancementWeaponGrantFor(merged, 'subductors')).toBeNull();
  });

  it('OC / Ld / W bonuses and the battle-shock OC floor', () => {
    expect(enhancementOcBonus(mkUnit({ enhancementId: ENH.REGIMENTAL_BANNER }))).toBe(3);
    expect(enhancementLdBonus(mkUnit({ enhancementId: ENH.FORMIDABLE_RESOLVE }))).toBe(1);
    expect(enhancementWoundBonus(ENH.FORMIDABLE_RESOLVE, 1)).toBe(1);
    expect(enhancementWoundBonus(ENH.FORMIDABLE_RESOLVE, 5)).toBe(0); // single-model bearers only
    // Regimental Banner +3 OC flows into objective control.
    const base: GameState = {
      ...createInitialState(layout),
      units: [mkUnit({ models: [{ id: 'u1:m0', unitId: 'u1', pos: { x: 30, y: 22 }, wounds: 3, alive: true }] })],
    };
    expect(objectiveControl(base, ctx).perObjective[0]!.player).toBe(2);
    const banner: GameState = {
      ...base,
      units: [{ ...base.units[0]!, enhancementId: ENH.REGIMENTAL_BANNER }],
    };
    expect(objectiveControl(banner, ctx).perObjective[0]!.player).toBe(5);
    // Death Mask: battle-shocked OC = base − 1 instead of 0.
    const shocked: GameState = {
      ...banner,
      units: [{ ...banner.units[0]!, enhancementId: ENH.DEATH_MASK, status: { battleShocked: true } }],
    };
    expect(objectiveControl(shocked, ctx).perObjective[0]!.player).toBe(1);
  });

  it('scout grants, disembark carve-outs, overwatch immunity, extra orders', () => {
    expect(unitScoutDistance(mkUnit({ enhancementId: ENH.SURVIVAL_GEAR }), ctx)).toBe(6);
    expect(unitScoutDistance(mkUnit(), ctx)).toBeNull();
    // Vanguard Honours: disembark from an ADVANCED transport becomes a rapid disembark.
    const bus = mkUnit({ id: 'bus', status: { advanced: true } });
    expect(disembarkMode(mkUnit(), bus)).toBeNull();
    expect(disembarkMode(mkUnit({ enhancementId: ENH.VANGUARD_HONOURS }), bus)).toBe('rapid');
    expect(blocksOverwatch(mkUnit({ enhancementId: ENH.SHROUD_PROJECTOR }))).toBe(true);
    expect(blocksOverwatch(mkUnit({ enhancementId: ENH.FLASH_GRENADES }))).toBe(true);
    expect(blocksOverwatch(mkUnit())).toBe(false);
    // Aquilan Eye unlocks Target Weak Spot for the bearer's officer unit.
    const officer = mkUnit({ enhancementId: ENH.AQUILAN_EYE });
    expect(ordersAvailableTo(officer).map((o) => o.effectId)).toContain('order:target_weak_spot');
    expect(ordersAvailableTo(mkUnit()).map((o) => o.effectId)).not.toContain('order:target_weak_spot');
    // Battalion Commander makes the bearer an Officer.
    expect(unitIsOfficer(mkUnit({ enhancementId: ENH.BATTALION_COMMANDER, datasheetId: 'tank' }), ctx)).toBe(true);
    expect(unitIsOfficer(mkUnit({ datasheetId: 'tank' }), ctx)).toBe(false);
  });
});

describe('Formidable Resolve +1 W at deployment', () => {
  it('a single-model bearer deploys with W+1', () => {
    const s = run(createInitialState(layout), [
      { type: 'NewBattle' },
      { type: 'SetAttacker', side: 'ai' },
      {
        type: 'DeployUnit', unitId: 'player:0', owner: 'player', datasheetId: 'inquisitor',
        baseShape: circle, modelCount: 1, wounds: 3, anchor: { x: 6, y: 22 },
        enhancementId: ENH.FORMIDABLE_RESOLVE,
      },
    ]);
    expect(s.units[0]!.models[0]!.wounds).toBe(4);
    expect(s.units[0]!.enhancementId).toBe(ENH.FORMIDABLE_RESOLVE);
  });
});

describe('Clandestine Operation (Declare Battle Formations grant)', () => {
  const setupState = (): GameState =>
    run(createInitialState(layout), [{ type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' }]);

  it('unit filter: AoI INFANTRY yes, Grey Knights Terminator Squad no', () => {
    const rule = PREBATTLE_GRANTS[ENH.CLANDESTINE_OPERATION]!;
    expect(grantSelects(rule, subductors)).toBe(true);
    expect(grantSelects(rule, inquisitor)).toBe(true);
    expect(grantSelects(rule, gkTerms)).toBe(false);
    expect(grantSelects(rule, tank)).toBe(false);
  });

  it('declaring grants Infiltrators to the picked entries; caps and re-declares are rejected', () => {
    const declared = run(setupState(), [
      {
        type: 'DeclareEnhancementGrant', side: 'player', enhancementId: ENH.CLANDESTINE_OPERATION,
        entries: [
          { entryKey: 'player:1', datasheetId: 'subductors' },
          { entryKey: 'player:2', datasheetId: 'subductors' },
        ],
      },
    ]);
    expect(grantedDeployAbility(declared, 'player:1')).toBe('infiltrators');
    expect(grantedDeployAbility(declared, 'player:2')).toBe('infiltrators');
    expect(grantedDeployAbility(declared, 'player:3')).toBeNull();
    const again = run(declared, [
      { type: 'DeclareEnhancementGrant', side: 'player', enhancementId: ENH.CLANDESTINE_OPERATION, entries: [] },
    ]);
    expect(again.log.at(-1)).toMatch(/rejected: already declared/);
    const overCap = run(setupState(), [
      {
        type: 'DeclareEnhancementGrant', side: 'player', enhancementId: ENH.CLANDESTINE_OPERATION,
        entries: ['a', 'b', 'c', 'd'].map((k) => ({ entryKey: `player:${k}`, datasheetId: 'subductors' })),
      },
    ]);
    expect(overCap.log.at(-1)).toMatch(/rejected: select up to 3/);
    const badUnit = run(setupState(), [
      {
        type: 'DeclareEnhancementGrant', side: 'player', enhancementId: ENH.CLANDESTINE_OPERATION,
        entries: [{ entryKey: 'player:1', datasheetId: 'gkterms' }],
      },
    ]);
    expect(badUnit.log.at(-1)).toMatch(/does not qualify/);
  });

  it('a granted unit may legally deploy in no-man’s-land (Infiltrators)', () => {
    const s = run(setupState(), [
      {
        type: 'DeclareEnhancementGrant', side: 'player', enhancementId: ENH.CLANDESTINE_OPERATION,
        entries: [{ entryKey: 'player:0', datasheetId: 'subductors' }],
      },
      {
        type: 'DeployUnit', unitId: 'player:0', owner: 'player', datasheetId: 'subductors',
        baseShape: circle, modelCount: 5, wounds: 3, anchor: { x: 30, y: 10 }, ability: 'infiltrators',
      },
    ]);
    expect(s.units.find((u) => u.id === 'player:0')).toBeDefined();
  });

  it('whoActs waits on the grant side; the AI declares it on qualifying units', () => {
    const roster: Roster = {
      name: 'Fleet', faction: 'AoI', detachment: 'Imperialis Fleet', points: 985,
      units: [
        { datasheetId: 'inquisitor', modelCount: 1, enhancementId: ENH.CLANDESTINE_OPERATION },
        { datasheetId: 'subductors', modelCount: 5 },
        { datasheetId: 'subductors', modelCount: 5 },
      ],
    };
    const deps: AiDeps = {
      ctx, rosters: { ai: roster }, detachments: { ai: 'Imperialis Fleet' },
      deployAbility: () => 'standard', stratagems: [], rng: makeRNG(3),
    };
    const s = setupState();
    expect(enhancementGrantPending(s, deps)).toEqual({ side: 'ai', enhancementId: ENH.CLANDESTINE_OPERATION });
    expect(whoActs(s, deps).actor).toBe('ai');
    const action = aiAction(s, 'ai', 'balanced', deps)!;
    expect(action).not.toBeNull();
    const intent = action.intents[0]!.intent;
    expect(intent.type).toBe('DeclareEnhancementGrant');
    if (intent.type === 'DeclareEnhancementGrant') {
      expect(intent.entries.length).toBeGreaterThan(0); // the AI uses the Infiltrators grant
      expect(intent.entries.every((e) => e.datasheetId === 'subductors')).toBe(true);
    }
    const resolved = run(s, [intent]);
    expect(enhancementGrantPending(resolved, deps)).toBeNull();
  });
});

describe('Combat Landers-style Deep Strike grants survive into the battle', () => {
  it('the grant is stamped on the unit and honoured by ArriveFromReserves after BeginBattle clears setup', () => {
    const s = run(createInitialState(layout), [
      { type: 'NewBattle' },
      { type: 'SetAttacker', side: 'ai' },
      {
        // Lathimon's Flock grants Infiltrators; use a deep_strike-granting record directly.
        type: 'DeclareEnhancementGrant', side: 'player', enhancementId: ENH.COMBAT_LANDERS,
        entries: [],
      },
    ]);
    // Manually emulate a declared deep-strike grant on entry player:0 (Combat Landers requires
    // VOIDFARERS — our test datasheets aren't; write the record the reducer would store).
    const granted: GameState = {
      ...s,
      setup: {
        ...s.setup!,
        grants: [{ side: 'player', enhancementId: ENH.COMBAT_LANDERS, label: 'Combat Landers', grant: 'deep_strike', entryKeys: ['player:0'] }],
      },
    };
    const reserved = run(granted, [
      {
        type: 'PlaceInReserves', unitId: 'player:0', owner: 'player', datasheetId: 'subductors',
        baseShape: circle, modelCount: 5, wounds: 3,
      },
    ]);
    expect(reserved.units.find((u) => u.id === 'player:0')!.deployGrant).toBe('deep_strike');
    const battle = run(reserved, [{ type: 'BeginBattle' }]);
    expect(battle.setup).toBeUndefined();
    // Round 2, the unit's own Movement phase: a mid-board arrival (nowhere near an edge) is only
    // legal with Deep Strike — the stamped grant must carry it.
    const round2: GameState = { ...battle, round: 2, phase: 'Movement', activePlayer: 'player' };
    const arrived = reduce(round2, { type: 'ArriveFromReserves', unitId: 'player:0', anchor: { x: 30, y: 22 } }, rng, ctx);
    const unit = arrived.units.find((u) => u.id === 'player:0')!;
    expect(unit.inReserves).toBeFalsy();
    expect(arrived.log.at(-1)).toMatch(/arrives from Reserves/);
  });
});

describe('enhancement redeploys (Liber Heresius)', () => {
  it('pulls qualifying deployed units back into the pool, counts down, declines', () => {
    const s = run(createInitialState(layout), [
      { type: 'NewBattle' },
      { type: 'SetAttacker', side: 'ai' },
      {
        type: 'DeployUnit', unitId: 'player:0', owner: 'player', datasheetId: 'subductors',
        baseShape: circle, modelCount: 5, wounds: 3, anchor: { x: 6, y: 22 },
      },
      { type: 'UseEnhancementRedeploy', side: 'player', enhancementId: ENH.LIBER_HERESIUS },
    ]);
    expect(s.setup!.redeploy!.player).toMatchObject({ remaining: 3 });
    const pulled = run(s, [{ type: 'EnhancementRedeploy', unitId: 'player:0' }]);
    expect(pulled.units.find((u) => u.id === 'player:0')).toBeUndefined();
    expect(pulled.setup!.redeploy!.player!.remaining).toBe(2);
    const done = run(pulled, [{ type: 'DeclineEnhancementRedeploy', side: 'player', enhancementId: ENH.LIBER_HERESIUS }]);
    expect(done.setup!.redeploy!.player!.remaining).toBe(0);
  });

  it('pending detection reads the roster; the AI declines', () => {
    const roster: Roster = {
      name: 'Inq', faction: 'AoI', detachment: 'Ordo Hereticus Purgation Force', points: 985,
      units: [{ datasheetId: 'inquisitor', modelCount: 1, enhancementId: ENH.LIBER_HERESIUS }],
    };
    const deps: AiDeps = {
      ctx, rosters: { player: roster }, detachments: {}, deployAbility: () => 'standard', stratagems: [], rng: makeRNG(3),
    };
    const s = run(createInitialState(layout), [{ type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' }]);
    expect(enhancementRedeployPending(s, deps)).toEqual({ side: 'player', enhancementId: ENH.LIBER_HERESIUS });
    const declined = run(s, [{ type: 'DeclineEnhancementRedeploy', side: 'player', enhancementId: ENH.LIBER_HERESIUS }]);
    expect(enhancementRedeployPending(declined, deps)).toBeNull();
  });
});

describe('Fire Overwatch immunity (Shroud Projector / Flash Grenades)', () => {
  it('the reducer rejects an overwatch volley at the bearer’s unit', () => {
    const base = createInitialState(layout);
    const shooter = mkUnit({ id: 'e1', owner: 'ai', models: [{ id: 'e1:m0', unitId: 'e1', pos: { x: 10, y: 22 }, wounds: 3, alive: true }] });
    const mover = mkUnit({ id: 'p1', enhancementId: ENH.SHROUD_PROJECTOR, models: [{ id: 'p1:m0', unitId: 'p1', pos: { x: 14, y: 22 }, wounds: 3, alive: true }] });
    const s: GameState = { ...base, mode: 'match', stage: 'battle', phase: 'Movement', activePlayer: 'player', cp: { player: 1, ai: 1 }, units: [shooter, mover] };
    const next = reduce(s, { type: 'FireOverwatch', unitId: 'e1', targetUnitId: 'p1' }, rng, ctx);
    expect(next.log.at(-1)).toMatch(/cannot be targeted by Fire Overwatch/);
    expect(next.cp.ai).toBe(1); // no CP spent
  });
});
