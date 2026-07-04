// Transports (11e, 18): capacity parsing, deployment embarks, embark after a move, the three
// disembark modes, emergency disembark on destruction, Firing Deck X (24.14), aircraft basics (23).

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { planUnitShooting, resolveUnitShooting, type EngineContext } from '../src/core/engine';
import {
  canEmbark, datasheetMayRide, disembarkMode, embarkedUnits, firingDeckX, parseTransportCapacity,
  remainingCapacity,
} from '../src/core/transport';
import type { BaseShape, Datasheet, GameState, Layout, WeaponProfile } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const bigBase: BaseShape = { kind: 'oval', rx: 2.4, ry: 1.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: {
    player: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 44 }, { x: 0, y: 44 }],
    opponent: [{ x: 48, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 44 }, { x: 48, y: 44 }],
  },
};

const gun = (name: string, over: Partial<WeaponProfile> = {}): WeaponProfile => ({
  name, type: 'ranged', range: 24, attacks: '2', skill: 4, S: 4, AP: 0, D: '1', keywords: [], ...over,
});

const CHIMERA_TEXT =
  'This model has a transport capacity of 6 Astra Militarum Infantry models. Each Ogryn model takes up the space of 3 models. It cannot transport Artillery models.';

const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [], baseShape: circle, keywords: ['Infantry', 'Astra Militarum'], abilityIds: [], ...over,
});

const ctx: EngineContext = {
  datasheets: new Map<string, Datasheet>([
    ['squad', ds('squad', { weapons: [gun('Lasgun'), gun('Meltagun', { S: 9, D: 'D6' })] })],
    ['gunners', ds('gunners', { weapons: [gun('Lasgun')] })],
    ['artillery', ds('artillery', { keywords: ['Artillery', 'Astra Militarum'] })],
    ['rhino', ds('rhino', {
      keywords: ['Vehicle', 'Transport', 'Dedicated Transport', 'Astra Militarum'],
      transport: CHIMERA_TEXT,
      baseShape: bigBase,
      models: [{ name: 'rhino', M: 12, T: 9, Sv: 3, W: 11, Ld: 7, OC: 2 }],
      weapons: [gun('Storm bolter')],
      abilities: [{ name: 'Firing Deck', description: '', type: 'Core', parameter: '2' }],
    })],
    ['jet', ds('jet', {
      keywords: ['Vehicle', 'Aircraft', 'Fly', 'Astra Militarum'],
      baseShape: bigBase,
      models: [{ name: 'jet', M: 20, T: 8, Sv: 3, W: 12, Ld: 7, OC: 0 }],
    })],
    ['foe', ds('foe', { weapons: [gun('Big gun', { S: 14, AP: -3, D: '6', attacks: '12', skill: 2 })] })],
  ]),
};

const rng = makeRNG(21);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);
const spawn = (unitId: string, owner: 'player' | 'ai', dsId: string, x: number, y = 22, modelCount = 1): Intent => ({
  type: 'SpawnUnit', unitId, owner, datasheetId: dsId, baseShape: ctx.datasheets.get(dsId)!.baseShape, modelCount, wounds: ctx.datasheets.get(dsId)!.models[0]!.W, anchor: { x, y },
});
const unit = (s: GameState, id: string) => s.units.find((u) => u.id === id)!;
const match = (s: GameState): GameState => ({ ...s, mode: 'match', stage: 'battle', phase: 'Movement', activePlayer: 'player' });

describe('transport capacity parsing', () => {
  it('parses capacity, bulky riders and exclusions from the Chimera text', () => {
    const cap = parseTransportCapacity(CHIMERA_TEXT)!;
    expect(cap.capacity).toBe(6);
    expect(cap.allowed).toEqual([['astra', 'militarum', 'infantry']]);
    expect(cap.bulky).toEqual([{ match: 'ogryn', space: 3 }]);
    expect(cap.excluded).toEqual(['artillery']);
  });
  it('parses "or" alternatives (Taurox Prime)', () => {
    const cap = parseTransportCapacity(
      'This model has a transport capacity of 12 Militarum Tempestus Infantry or Astra Militarum Infantry Character models.',
    )!;
    expect(cap.capacity).toBe(12);
    expect(cap.allowed).toHaveLength(2);
  });
  it('keyword matching covers multi-word keywords; exclusions apply', () => {
    const cap = parseTransportCapacity(CHIMERA_TEXT)!;
    expect(datasheetMayRide(ctx.datasheets.get('squad')!, cap)).toBe(true);
    expect(datasheetMayRide(ctx.datasheets.get('artillery')!, cap)).toBe(false);
    expect(datasheetMayRide(ctx.datasheets.get('rhino')!, cap)).toBe(false); // not Infantry
  });
  it('reads Firing Deck X off the ability parameter', () => {
    expect(firingDeckX(ctx.datasheets.get('rhino')!)).toBe(2);
    expect(firingDeckX(ctx.datasheets.get('squad')!)).toBe(0);
  });
});

describe('embark & capacity', () => {
  it('a unit embarks after a move when every model is within 3"', () => {
    let s = match(run(createInitialState(layout), [
      spawn('bus', 'player', 'rhino', 20), spawn('sq', 'player', 'squad', 24, 22, 5),
    ]));
    s = run(s, [{ type: 'SetUnitStatus', unitId: 'sq', status: { moved: true } }]);
    s = run(s, [{ type: 'EmbarkUnit', unitId: 'sq', transportId: 'bus' }]);
    expect(unit(s, 'sq').embarkedIn).toBe('bus');
    expect(unit(s, 'sq').inReserves).toBe(true);
    expect(embarkedUnits(s, 'bus')).toHaveLength(1);
    expect(remainingCapacity(s, unit(s, 'bus'), ctx)).toBe(1); // 6 − 5
  });

  it('rejects embarking without having moved, or from too far away', () => {
    let s = match(run(createInitialState(layout), [
      spawn('bus', 'player', 'rhino', 20), spawn('sq', 'player', 'squad', 24, 22, 5),
    ]));
    const noMove = run(s, [{ type: 'EmbarkUnit', unitId: 'sq', transportId: 'bus' }]);
    expect(unit(noMove, 'sq').embarkedIn).toBeUndefined();
    s = run(s, [
      { type: 'SetUnitStatus', unitId: 'sq', status: { moved: true } },
      { type: 'MoveModel', modelId: unit(s, 'sq').models[0]!.id, pos: { x: 40, y: 22 } },
    ]);
    // Sandbox MoveModel is blocked in match mode outside an activation — instead spawn far away.
    const far = match(run(createInitialState(layout), [
      spawn('bus', 'player', 'rhino', 20), spawn('sq', 'player', 'squad', 30, 22, 5),
    ]));
    const rejected = run(far, [
      { type: 'SetUnitStatus', unitId: 'sq', status: { moved: true } },
      { type: 'EmbarkUnit', unitId: 'sq', transportId: 'bus' },
    ]);
    expect(unit(rejected, 'sq').embarkedIn).toBeUndefined();
  });

  it('capacity rejects a unit that does not fit (and non-riders outright)', () => {
    const s = match(run(createInitialState(layout), [
      spawn('bus', 'player', 'rhino', 20),
      spawn('sq', 'player', 'squad', 24, 22, 5),
      spawn('sq2', 'player', 'gunners', 24, 26, 2),
      spawn('art', 'player', 'artillery', 24, 18, 1),
    ]));
    const withSq = run(s, [
      { type: 'SetUnitStatus', unitId: 'sq', status: { moved: true } },
      { type: 'EmbarkUnit', unitId: 'sq', transportId: 'bus' },
    ]);
    expect(canEmbark(withSq, unit(withSq, 'sq2'), unit(withSq, 'bus'), ctx).ok).toBe(false); // 2 > 1 left
    expect(canEmbark(s, unit(s, 'art'), unit(s, 'bus'), ctx).ok).toBe(false); // Artillery excluded
  });

  it('units can start the battle embarked (DeployUnit intoTransportId)', () => {
    let s = run(createInitialState(layout), [
      { type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' },
      { type: 'DeployUnit', unitId: 'bus', owner: 'player', datasheetId: 'rhino', baseShape: bigBase, modelCount: 1, wounds: 11, anchor: { x: 6, y: 22 } },
      { type: 'DeployUnit', unitId: 'sq', owner: 'player', datasheetId: 'squad', baseShape: circle, modelCount: 5, wounds: 1, anchor: { x: 0, y: 0 }, intoTransportId: 'bus' },
    ]);
    expect(unit(s, 'sq').embarkedIn).toBe('bus');
    expect(unit(s, 'sq').inReserves).toBe(true);
  });
});

describe('disembark modes (18.04)', () => {
  const embarked = (): GameState => {
    let s = match(run(createInitialState(layout), [
      spawn('bus', 'player', 'rhino', 20), spawn('sq', 'player', 'squad', 22, 22, 4),
    ]));
    return run(s, [
      { type: 'SetUnitStatus', unitId: 'sq', status: { moved: true } },
      { type: 'EmbarkUnit', unitId: 'sq', transportId: 'bus' },
      // fresh turn: clear the passenger's flags (embark was last turn)
      { type: 'SetUnitStatus', unitId: 'sq', status: { moved: false, justEmbarked: false } },
    ]);
  };

  it('Tactical: transport unmoved → unit disembarks within 3" and may then move', () => {
    const s = run(embarked(), [{ type: 'DisembarkUnit', unitId: 'sq', anchor: { x: 24.5, y: 22 } }]);
    const sq = unit(s, 'sq');
    expect(sq.embarkedIn).toBeUndefined();
    expect(sq.inReserves).toBe(false);
    expect(sq.status.moved).toBeFalsy(); // may still make a normal/advance move
    expect(s.log.some((l) => /disembarks \(tactical\)/.test(l))).toBe(true);
  });

  it('Rapid: transport moved this phase → 3", cannot charge, cannot move again', () => {
    let s = embarked();
    s = run(s, [{ type: 'SetUnitStatus', unitId: 'bus', status: { moved: true } }]);
    s = run(s, [{ type: 'DisembarkUnit', unitId: 'sq', anchor: { x: 24.5, y: 22 } }]);
    const sq = unit(s, 'sq');
    expect(sq.embarkedIn).toBeUndefined();
    expect(sq.status.moved).toBe(true);
    expect(sq.status.cannotCharge).toBe(true);
    expect(s.log.some((l) => /disembarks \(rapid\)/.test(l))).toBe(true);
  });

  it('no disembark after the transport advanced or fell back', () => {
    let s = embarked();
    s = run(s, [{ type: 'SetUnitStatus', unitId: 'bus', status: { advanced: true } }]);
    expect(disembarkMode(unit(s, 'sq'), unit(s, 'bus'))).toBeNull();
    s = run(s, [{ type: 'DisembarkUnit', unitId: 'sq', anchor: { x: 24.5, y: 22 } }]);
    expect(unit(s, 'sq').embarkedIn).toBe('bus'); // still aboard
  });

  it('Combat: an anchor only satisfiable at 6" → hazard rolls, battle-shock, no charge', () => {
    let s = embarked();
    s = run(s, [{ type: 'DisembarkUnit', unitId: 'sq', anchor: { x: 27.5, y: 22 } }]);
    const sq = unit(s, 'sq');
    expect(sq.embarkedIn).toBeUndefined();
    expect(sq.status.battleShocked).toBe(true);
    expect(sq.status.cannotCharge).toBe(true);
    expect(s.log.some((l) => /disembarks \(combat\)/.test(l))).toBe(true);
  });
});

describe('emergency disembark (18.05)', () => {
  it('destroying a transport spills its passengers within 6", battle-shocked', () => {
    let s = match(run(createInitialState(layout), [
      spawn('bus', 'player', 'rhino', 20), spawn('sq', 'player', 'squad', 22, 22, 4),
      spawn('foe', 'ai', 'foe', 40, 22, 6),
    ]));
    s = run(s, [
      { type: 'SetUnitStatus', unitId: 'sq', status: { moved: true } },
      { type: 'EmbarkUnit', unitId: 'sq', transportId: 'bus' },
    ]);
    s = { ...s, phase: 'Shooting', activePlayer: 'ai' };
    // Shoot until the transport dies (S14 D6 into T9 W11 — a few volleys at most).
    for (let i = 0; i < 12 && unit(s, 'bus').models.some((m) => m.alive); i++) {
      s = run(s, [
        { type: 'SetUnitStatus', unitId: 'foe', status: { hasShot: false } },
        { type: 'ShootUnit', attackerUnitId: 'foe', targetUnitId: 'bus' },
      ]);
    }
    expect(unit(s, 'bus').models.some((m) => m.alive)).toBe(false);
    const sq = unit(s, 'sq');
    expect(sq.embarkedIn).toBeUndefined();
    expect(sq.inReserves).toBe(false);
    expect(sq.status.battleShocked).toBe(true);
    // Survivors are set up near the wreck.
    for (const m of sq.models.filter((m) => m.alive)) {
      expect(Math.hypot(m.pos.x - 20, m.pos.y - 22)).toBeLessThanOrEqual(12);
    }
  });
});

describe('Firing Deck X (24.14)', () => {
  it('the transport fires up to X embarked weapons, best first, and marks contributors as shot', () => {
    let s = match(run(createInitialState(layout), [
      spawn('bus', 'player', 'rhino', 20), spawn('sq', 'player', 'squad', 22, 22, 4),
      spawn('foe', 'ai', 'foe', 30, 22, 6),
    ]));
    s = run(s, [
      { type: 'SetUnitStatus', unitId: 'sq', status: { moved: true } },
      { type: 'EmbarkUnit', unitId: 'sq', transportId: 'bus' },
    ]);
    s = { ...s, phase: 'Shooting' };
    const plan = planUnitShooting(s, unit(s, 'bus'), ctx);
    const deck = plan.fire.filter((f) => f.viaFiringDeck);
    expect(deck.length).toBeGreaterThan(0);
    expect(deck.reduce((n, f) => n + f.carriers, 0)).toBeLessThanOrEqual(2); // Firing Deck 2
    // The meltagun (best rank) is picked over lasguns.
    expect(deck.some((f) => f.weapon.name === 'Meltagun')).toBe(true);
    const out = resolveUnitShooting(s, { attackerUnitId: 'bus', targetUnitId: 'foe' }, ctx, makeRNG(5));
    expect(out.rejected).toBeUndefined();
    expect(unit(out.state, 'sq').status.hasShot).toBe(true); // contributors may not shoot again
  });
});

describe('aircraft (23)', () => {
  it('cannot be deployed on the board in a match, and cannot make normal moves', () => {
    let s = run(createInitialState(layout), [
      { type: 'NewBattle' }, { type: 'SetAttacker', side: 'ai' },
      { type: 'DeployUnit', unitId: 'jet', owner: 'player', datasheetId: 'jet', baseShape: bigBase, modelCount: 1, wounds: 12, anchor: { x: 6, y: 22 } },
    ]);
    expect(s.units.find((u) => u.id === 'jet')).toBeUndefined();
    expect(s.log.some((l) => /AIRCRAFT must start in Strategic Reserves/.test(l))).toBe(true);

    let m = match(run(createInitialState(layout), [spawn('jet', 'player', 'jet', 20)]));
    m = run(m, [{ type: 'BeginMove', unitIds: ['jet'], mode: 'normal' }]);
    expect(unit(m, 'jet').status.moveMode).toBeUndefined();
    expect(m.log.some((l) => /AIRCRAFT only make ingress moves/.test(l))).toBe(true);
  });

  it('returns to Strategic Reserves at the end of the opponent\'s turn', () => {
    // player's aircraft on the board; AI's turn ends (activePlayer=ai finishing the round's
    // second turn) → player aircraft leave.
    let s = match(run(createInitialState(layout), [spawn('jet', 'player', 'jet', 20), spawn('foe', 'ai', 'foe', 40)]));
    s = { ...s, phase: 'Fight', activePlayer: 'ai', firstPlayer: 'player', round: 2 };
    s = run(s, [{ type: 'AdvancePhase' }]);
    expect(unit(s, 'jet').inReserves).toBe(true);
  });
});
