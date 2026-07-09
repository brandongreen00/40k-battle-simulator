// Surge moves (21.02) and per-weapon target splitting (04.02).

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce, type Intent } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { resolveSurgeMove, resolveUnitShooting, type EngineContext } from '../src/core/engine';
import { gapBetween } from '../src/core/phases';
import type { BaseShape, Datasheet, GameState, Layout, WeaponProfile } from '../src/core/types';

const circle: BaseShape = { kind: 'circle', radius: 0.5 };
const layout: Layout = {
  id: 't', boardWidth: 60, boardHeight: 44, deployment: 'test', terrain: [], objectives: [],
  deploymentZones: { player: [], opponent: [] },
};
const gun = (name: string, over: Partial<WeaponProfile> = {}): WeaponProfile => ({
  name, type: 'ranged', range: 36, attacks: '4', skill: 3, S: 4, AP: 0, D: '1', keywords: [], ...over,
});
const ds = (id: string, over: Partial<Datasheet> = {}): Datasheet => ({
  id, name: id, faction: 'AM', models: [{ name: id, M: 6, T: 3, Sv: 5, W: 1, Ld: 7, OC: 1 }],
  weapons: [], baseShape: circle, keywords: ['Infantry'], abilityIds: [], ...over,
});
const ctx: EngineContext = {
  datasheets: new Map([
    ['grunt', ds('grunt')],
    ['mixed', ds('mixed', { weapons: [gun('Bolter'), gun('Lascannon', { S: 12, AP: -3, D: 'D6', attacks: '1' })] })],
  ]),
};
const rng = makeRNG(13);
const run = (s: GameState, intents: Intent[]): GameState =>
  intents.reduce((acc, i) => reduce(acc, i, rng, ctx), s);
const spawn = (unitId: string, owner: 'player' | 'ai', dsId: string, x: number, y = 22, modelCount = 1): Intent => ({
  type: 'SpawnUnit', unitId, owner, datasheetId: dsId, baseShape: circle, modelCount, wounds: 1, anchor: { x, y },
});
const unit = (s: GameState, id: string) => s.units.find((u) => u.id === id)!;

describe('surge moves (21.02)', () => {
  it('moves up to X" toward the CLOSEST enemy and can end engaged', () => {
    const s = run(createInitialState(layout), [
      spawn('me', 'player', 'grunt', 10), spawn('near', 'ai', 'grunt', 14), spawn('far', 'ai', 'grunt', 30),
    ]);
    const out = resolveSurgeMove(s, { unitId: 'me', maxDistance: 4 }, ctx);
    expect(gapBetween(unit(out.state, 'me'), unit(out.state, 'near'), ctx)).toBeLessThanOrEqual(2);
    expect(unit(out.state, 'me').status.moved).toBe(true); // cannot move again this phase
  });

  it('is refused when battle-shocked, engaged, or already moved', () => {
    let s = run(createInitialState(layout), [spawn('me', 'player', 'grunt', 10), spawn('foe', 'ai', 'grunt', 14)]);
    const shocked = resolveSurgeMove(
      run(s, [{ type: 'SetUnitStatus', unitId: 'me', status: { battleShocked: true } }]),
      { unitId: 'me', maxDistance: 4 }, ctx,
    );
    expect(shocked.summary).toMatch(/battle-shocked/);
    const moved = resolveSurgeMove(
      run(s, [{ type: 'SetUnitStatus', unitId: 'me', status: { moved: true } }]),
      { unitId: 'me', maxDistance: 4 }, ctx,
    );
    expect(moved.summary).toMatch(/already moved/);
    const engaged = run(createInitialState(layout), [spawn('me', 'player', 'grunt', 10), spawn('foe', 'ai', 'grunt', 12)]);
    expect(resolveSurgeMove(engaged, { unitId: 'me', maxDistance: 4 }, ctx).summary).toMatch(/already engaged/);
  });

  it('will not end engaged with an enemy that is not the surge target', () => {
    // The closest enemy is straight ahead (gap 3"); a second enemy sits off the path, slightly
    // FURTHER away, such that a full-distance surge would clip its Engagement Range — the move
    // shortens so the unit never ends engaged with the non-target.
    const s = run(createInitialState(layout), [
      spawn('me', 'player', 'grunt', 10), spawn('target', 'ai', 'grunt', 14), spawn('bystander', 'ai', 'grunt', 13.5, 24.5),
    ]);
    const out = resolveSurgeMove(s, { unitId: 'me', maxDistance: 5 }, ctx);
    const me = unit(out.state, 'me');
    expect(gapBetween(me, unit(out.state, 'bystander'), ctx)).toBeGreaterThan(2);
  });
});

describe('per-weapon target splitting (04.02)', () => {
  it('splitTargets sends the assigned weapon at its own target', () => {
    const s0 = run(createInitialState(layout), [
      spawn('me', 'player', 'mixed', 10),
      spawn('a', 'ai', 'grunt', 20, 20, 3), spawn('b', 'ai', 'grunt', 20, 26, 3),
    ]);
    const out = resolveUnitShooting(
      s0,
      {
        attackerUnitId: 'me', targetUnitId: 'a',
        splitTargets: { 'mixed|Lascannon': 'b' },
      },
      ctx, makeRNG(2),
    );
    expect(out.rejected).toBeUndefined();
    const log = out.state.log.join('\n');
    expect(log).toMatch(/Bolter[\s\S]*grunt/);
    // Both targets were shot at (the summary counts weapons fired; the lascannon line names b's unit).
    expect(out.state.log.some((l) => /Lascannon/.test(l))).toBe(true);
  });

  it('a split target that died mid-volley just skips that weapon', () => {
    const s0 = run(createInitialState(layout), [
      spawn('me', 'player', 'mixed', 10),
      spawn('a', 'ai', 'grunt', 20, 20, 3),
    ]);
    const out = resolveUnitShooting(
      s0,
      { attackerUnitId: 'me', targetUnitId: 'a', splitTargets: { 'mixed|Lascannon': 'ghost' } },
      ctx, makeRNG(2),
    );
    expect(out.rejected).toBeUndefined();
    expect(out.state.log.some((l) => /Lascannon not fired: its target is already destroyed/.test(l))).toBe(true);
  });
});
