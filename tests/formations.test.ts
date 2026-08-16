// Declare Battle Formations (the pre-deployment step): start-embarked declarations (18.01),
// Strategic Reserves picks (20.01), the DEDICATED TRANSPORT destruction rule, and the transport
// capacity parser fixes verified against the live 11e Wahapedia wordings.
import { describe, it, expect } from 'vitest';
import type { GameState, Roster } from '../src/core/types';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import {
  canDeclareEmbark, datasheetMayRide, declaredCapacityLeft, deploymentProbeUnit,
  isDedicatedTransport, parseTransportCapacity,
} from '../src/core/transport';
import { isEntryPlaced } from '../src/core/deployment';
import { whoActs, aiAction, sharedAction, type AiDeps } from '../src/core/ai/controller';
import { datasheetsById, deployAbilityForDatasheet, stratagems, layouts } from '../src/data/loaders';
import holdObjectives from '../data/rosters/hold_objectives.json';
import fleet from '../data/rosters/prebuilt_fleet_boarding.json';

const ctx = { datasheets: datasheetsById };
const rng = makeRNG(11);
const layout = layouts.find((l) => l.id === 'ca2025-hammer-and-anvil-1') ?? layouts[0]!;
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);

const byName = (name: string) => [...datasheetsById.values()].find((d) => d.name === name)!;
const RHINO = byName('Imperial Rhino');
const CHIMERA_INQ = byName('Inquisitorial Chimera');
const DWKT = byName('Deathwatch Kill Team');
const WATCH_MASTER = byName('Watch Master');
const INQUISITOR = byName('Inquisitor');
const AGENTS = byName('Inquisitorial Agents');
const CALLIDUS = byName('Callidus Assassin');

function freshFormations(): GameState {
  return run(createInitialState(layout), [{ type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' }]);
}

const declareEmbark = (over: Record<string, unknown> = {}): Intent => ({
  type: 'DeclareEmbark', side: 'player', unitId: 'player:1', transportKey: 'player:0',
  transportDsId: RHINO.id, datasheetId: DWKT.id, baseShape: DWKT.baseShape,
  modelCount: 10, wounds: DWKT.models[0]?.W ?? 1,
  ...over,
} as Intent);

describe('transport capacity parsing (verified against the live 11e wordings)', () => {
  it('the Imperial Rhino: AGENTS OF THE IMPERIUM INFANTRY, TERMINATOR/OFFICIO ASSASSINORUM excluded', () => {
    const cap = parseTransportCapacity(RHINO.transport)!;
    expect(cap.capacity).toBe(12);
    expect(datasheetMayRide(DWKT, cap)).toBe(true);
    expect(datasheetMayRide(WATCH_MASTER, cap)).toBe(true);
    expect(datasheetMayRide(CALLIDUS, cap)).toBe(false); // OFFICIO ASSASSINORUM
  });

  it('the Inquisitorial Chimera: "INQUISITOR INFANTRY and INQUISITORIAL AGENT" are two alternatives (and-joined, singular/plural folded)', () => {
    const cap = parseTransportCapacity(CHIMERA_INQ.transport)!;
    expect(cap.capacity).toBe(13);
    expect(cap.allowed).toHaveLength(2);
    expect(datasheetMayRide(INQUISITOR, cap)).toBe(true); // INQUISITOR + INFANTRY
    expect(datasheetMayRide(AGENTS, cap)).toBe(true); // keyword "Inquisitorial Agents" vs "INQUISITORIAL AGENT"
    expect(datasheetMayRide(DWKT, cap)).toBe(false); // neither alternative
  });

  it('DEDICATED TRANSPORT detection', () => {
    expect(isDedicatedTransport(RHINO)).toBe(true);
    expect(isDedicatedTransport(byName('Corvus Blackstar'))).toBe(false); // TRANSPORT but not dedicated
  });
});

describe('the Declare Battle Formations step', () => {
  it('RollRoles/SetAttacker enter the formations step; embarks declare BEFORE the transport is deployed', () => {
    const s = freshFormations();
    expect(s.setup?.step).toBe('formations');

    const declared = run(s, [declareEmbark()]);
    const rider = declared.units.find((u) => u.id === 'player:1')!;
    expect(rider).toBeDefined();
    expect(rider.inReserves).toBe(true);
    expect(rider.embarkedIn).toBe('player:0'); // the transport's ENTRY KEY — no unit exists yet
    expect(declared.units.some((u) => u.id === 'player:0')).toBe(false);
    expect(isEntryPlaced(declared, 'player:1')).toBe(true);
    expect(declaredCapacityLeft(declared, 'player:0', RHINO, ctx)).toBe(2); // 12 − 10

    // Deploying the transport later brings the declared riders with it (same id = entry key).
    const deployed = run(declared, [
      { type: 'FinishFormations', side: 'player' },
      { type: 'FinishFormations', side: 'ai' },
      {
        type: 'DeployUnit', unitId: 'player:0', owner: 'player', datasheetId: RHINO.id,
        baseShape: RHINO.baseShape, modelCount: 1, wounds: RHINO.models[0]?.W ?? 1,
        anchor: { x: 52, y: 22 }, // the Defender's zone on this layout (attacker = ai took the other side)
      },
    ]);
    const bus = deployed.units.find((u) => u.id === 'player:0')!;
    expect(bus).toBeDefined();
    expect(bus.inReserves).toBeFalsy();
    expect(deployed.units.find((u) => u.id === 'player:1')!.embarkedIn).toBe('player:0');
  });

  it('capacity counts the already-declared riders; the wrong faction may not ride', () => {
    const s = run(freshFormations(), [declareEmbark()]);
    // 10 of 12 seats taken — a 9-model squad no longer fits.
    const over = run(s, [declareEmbark({ unitId: 'player:2', datasheetId: byName('Sanctifiers').id, modelCount: 9 })]);
    expect(over.log.at(-1)).toMatch(/Embark declaration rejected: insufficient transport capacity/);
    expect(over.units.some((u) => u.id === 'player:2')).toBe(false);
    // The Callidus (OFFICIO ASSASSINORUM) is excluded outright.
    const wrong = run(freshFormations(), [
      declareEmbark({ unitId: 'player:3', datasheetId: CALLIDUS.id, modelCount: 1 }),
    ]);
    expect(wrong.log.at(-1)).toMatch(/Embark declaration rejected: unit may not ride this transport/);
  });

  it('a Leader-paired unit embarks WITH its Leader (the owner-reported Deathwatch + Watch Master → Rhino)', () => {
    // Watch Master (1) + Deathwatch Kill Team (10) = 11 of the Rhino's 12 seats.
    const probes = [
      deploymentProbeUnit('player:1', 'player', DWKT.id, 10),
      deploymentProbeUnit('player:2', 'player', WATCH_MASTER.id, 1),
    ];
    expect(canDeclareEmbark(freshFormations(), probes, 'player:0', RHINO, ctx).ok).toBe(true);

    const s = run(freshFormations(), [
      {
        type: 'DeclareFormation', side: 'player', leaderKey: 'player:2', leaderDsId: WATCH_MASTER.id,
        bodyguardKey: 'player:1', bodyguardDsId: DWKT.id,
      },
      declareEmbark(),
      declareEmbark({ unitId: 'player:2', datasheetId: WATCH_MASTER.id, modelCount: 1 }),
      { type: 'AttachLeader', leaderUnitId: 'player:2', bodyguardUnitId: 'player:1' },
    ]);
    const merged = s.units.find((u) => u.id === 'player:1')!;
    expect(merged.attachedLeaders?.length).toBe(1);
    expect(merged.models).toHaveLength(11);
    expect(merged.embarkedIn).toBe('player:0');
    expect(s.units.some((u) => u.id === 'player:2')).toBe(false); // merged away
    expect(isEntryPlaced(s, 'player:2')).toBe(true);
    expect(declaredCapacityLeft(s, 'player:0', RHINO, ctx)).toBe(1); // 12 − 11
    expect(s.log.filter((l) => /rejected/i.test(l))).toEqual([]);
  });

  it('18.01: a DEDICATED TRANSPORT with no unit embarked is destroyed at FinishFormations; one with riders is kept', () => {
    const s = run(freshFormations(), [
      { type: 'FinishFormations', side: 'player', destroyEntries: [{ entryKey: 'player:0', datasheetId: RHINO.id }] },
    ]);
    expect(s.setup?.destroyedEntries).toEqual([{ side: 'player', entryKey: 'player:0', name: 'Imperial Rhino' }]);
    expect(isEntryPlaced(s, 'player:0')).toBe(true); // handled — never deploys
    expect(s.log.some((l) => /Imperial Rhino is destroyed — no unit embarked/.test(l))).toBe(true);
    // Declaring INTO a destroyed transport is rejected.
    const late = run(s, [declareEmbark()]);
    expect(late.log.at(-1)).toMatch(/destroyed at Declare Battle Formations/);

    // With a rider declared, the same destroy request is ignored (re-validated by the reducer).
    const kept = run(freshFormations(), [
      declareEmbark(),
      { type: 'FinishFormations', side: 'player', destroyEntries: [{ entryKey: 'player:0', datasheetId: RHINO.id }] },
    ]);
    expect(kept.setup?.destroyedEntries ?? []).toEqual([]);
    // A non-dedicated entry can never be destroyed this way.
    const notDedicated = run(freshFormations(), [
      { type: 'FinishFormations', side: 'player', destroyEntries: [{ entryKey: 'player:5', datasheetId: DWKT.id }] },
    ]);
    expect(notDedicated.setup?.destroyedEntries ?? []).toEqual([]);
  });

  it('both sides finishing advances to the deploy step, Defender first', () => {
    const s = run(freshFormations(), [
      { type: 'FinishFormations', side: 'player' },
      { type: 'FinishFormations', side: 'ai' },
    ]);
    expect(s.setup?.step).toBe('deploy');
    expect(s.setup?.toDeploy).toBe('player'); // ai attacked → player defends → deploys first
    const again = run(s, [{ type: 'FinishFormations', side: 'player' }]);
    expect(again.log.at(-1)).toMatch(/Finish rejected/);
  });

  it('UndeployUnit during formations: riders and Reserves declarations undo; a transport with riders refuses', () => {
    const s = run(freshFormations(), [
      declareEmbark(),
      {
        type: 'PlaceInReserves', unitId: 'player:4', owner: 'player', datasheetId: byName('Inquisitor Draxus').id,
        baseShape: byName('Inquisitor Draxus').baseShape, modelCount: 1, wounds: 4,
      },
    ]);
    const undone = run(s, [{ type: 'UndeployUnit', unitId: 'player:1' }, { type: 'UndeployUnit', unitId: 'player:4' }]);
    expect(undone.units.some((u) => u.id === 'player:1')).toBe(false);
    expect(undone.units.some((u) => u.id === 'player:4')).toBe(false);
    expect(isEntryPlaced(undone, 'player:1')).toBe(false);

    // A transport placed in Reserves while riders are declared within it cannot be undone
    // out from under them.
    const reservedBus = run(s, [
      {
        type: 'PlaceInReserves', unitId: 'player:0', owner: 'player', datasheetId: RHINO.id,
        baseShape: RHINO.baseShape, modelCount: 1, wounds: RHINO.models[0]?.W ?? 1,
      },
    ]);
    const refused = run(reservedBus, [{ type: 'UndeployUnit', unitId: 'player:0' }]);
    expect(refused.units.some((u) => u.id === 'player:0')).toBe(true);
    expect(refused.log.at(-1)).toMatch(/undo those first/);
  });
});

describe('the AI plays the whole step (the owner-reported army shapes)', () => {
  it('AI-vs-AI setup with HOLD OBJECTIVES (Rhino + Chimera + Immolators) reaches battle with every dedicated transport carrying riders and zero rejects', () => {
    const rngLocal = makeRNG(21);
    const deps: AiDeps = {
      ctx,
      rosters: { player: holdObjectives as unknown as Roster, ai: fleet as unknown as Roster },
      detachments: {
        player: (holdObjectives as unknown as Roster).detachment,
        ai: (fleet as unknown as Roster).detachment,
      },
      deployAbility: deployAbilityForDatasheet,
      stratagems,
      rng: rngLocal,
    };
    let state = reduce(createInitialState(layout), { type: 'NewBattle' }, rngLocal, ctx);
    for (let i = 0; i < 300 && state.stage === 'setup'; i++) {
      const d = whoActs(state, deps);
      const action = d.actor === 'shared' ? sharedAction(state) : d.actor ? aiAction(state, d.actor, 'balanced', deps) : null;
      expect(action, `setup stalled at ${d.reason}`).toBeTruthy();
      for (const item of action!.intents) {
        if (item.skipIf?.(state)) continue;
        state = reduce(state, item.intent, rngLocal, ctx);
      }
    }
    expect(state.stage).toBe('battle');
    expect(state.log.filter((l) => /rejected/i.test(l))).toEqual([]);
    // No dedicated transport was destroyed (18.01) — the AI declared riders into every one:
    // HOLD OBJECTIVES' Rhino, Inquisitorial Chimera and both Immolators, and the Fleet's Rhino.
    expect(state.log.filter((l) => /destroyed — no unit embarked/.test(l))).toEqual([]);
    const embarked = state.units.filter((u) => u.embarkedIn);
    expect(embarked.length).toBeGreaterThanOrEqual(4);
  });
});
