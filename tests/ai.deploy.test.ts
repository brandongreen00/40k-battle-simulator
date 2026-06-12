import { describe, it, expect } from 'vitest';
import type { GameState, Roster } from '../src/core/types';
import { createInitialState, reduce } from '../src/core/state';
import { makeRNG } from '../src/core/rng';
import { whoActs, aiAction, sharedAction, type AiDeps } from '../src/core/ai/controller';
import { whollyInOwnZone, checkUnitDeployment } from '../src/core/deployment';
import { unitScoutDistance } from '../src/core/abilities';
import { formationPositions } from '../src/core/formation';
import { datasheetsById, deployAbilityForDatasheet, stratagems, layouts } from '../src/data/loaders';
import cadian from '../data/rosters/prebuilt_cadian_bulwark.json';
import fleet from '../data/rosters/prebuilt_fleet_boarding.json';
import deathwatch from '../data/rosters/prebuilt_deathwatch_vigil.json';

const ctx = { datasheets: datasheetsById };
const layout = layouts.find((l) => l.id === 'ca2025-hammer-and-anvil-1') ?? layouts[0]!;

function makeDeps(rng = makeRNG(5), player: Roster = cadian as Roster, ai: Roster = fleet as Roster): AiDeps {
  return {
    ctx,
    rosters: { player, ai },
    detachments: { player: player.detachment, ai: ai.detachment },
    deployAbility: deployAbilityForDatasheet,
    stratagems,
    rng,
  };
}

/** Drive setup with the AI on both seats until the battle begins (bounded). */
function runSetup(deps: AiDeps, rng: ReturnType<typeof makeRNG>): GameState {
  let state = reduce(createInitialState(layout), { type: 'NewBattle' }, rng, ctx);
  for (let i = 0; i < 200 && state.stage === 'setup'; i++) {
    const d = whoActs(state, deps);
    const action = d.actor === 'shared' ? sharedAction(state) : d.actor ? aiAction(state, d.actor, 'balanced', deps) : null;
    expect(action, `setup stalled at ${d.reason}`).toBeTruthy();
    for (const item of action!.intents) {
      if (item.skipIf?.(state)) continue;
      state = reduce(state, item.intent, rng, ctx);
    }
  }
  return state;
}

describe('ai/deploy — full alternating deployment', () => {
  it('deploys two full rosters legally and starts the battle', () => {
    const rng = makeRNG(5);
    const deps = makeDeps(rng);
    const state = runSetup(deps, rng);

    expect(state.stage).toBe('battle');
    expect(state.log.filter((l) => /rejected/i.test(l))).toEqual([]);

    // Every roster entry is accounted for: on the board or in Reserves (merged Leaders count
    // via their bodyguard's attachedLeaders).
    const placed = (side: 'player' | 'ai', count: number) => {
      let n = 0;
      for (let i = 0; i < count; i++) {
        const key = `${side}:${i}`;
        const found = state.units.some(
          (u) => u.id === key || (u.attachedLeaders ?? []).some((l) => l.unitId === key),
        );
        expect(found, `${key} missing after deployment`).toBe(true);
        n++;
      }
      return n;
    };
    expect(placed('player', (cadian as Roster).units.length)).toBe((cadian as Roster).units.length);
    expect(placed('ai', (fleet as Roster).units.length)).toBe((fleet as Roster).units.length);

    // Standard deployments sit wholly within their own zone — except units with a Scouts X"
    // move (they legally walk out of the zone before the battle begins) and led units (a
    // declared pair may deploy under a granted ability, e.g. Backroom Deals → Infiltrators;
    // the reducer validated that placement, asserted by the no-rejections check above).
    for (const u of state.units) {
      if (u.inReserves) continue;
      const ds = datasheetsById.get(u.datasheetId)!;
      if (deployAbilityForDatasheet(ds) !== 'standard') continue;
      if (unitScoutDistance(u, ctx) != null) continue;
      if ((u.attachedLeaders?.length ?? 0) > 0) continue;
      for (const m of u.models.filter((m) => m.alive)) {
        expect(
          whollyInOwnZone(m.pos, ds.baseShape, state.layout, u.owner),
          `${ds.name} (${u.owner}) model outside its zone at ${m.pos.x},${m.pos.y}`,
        ).toBe(true);
      }
    }

    // The Fleet list pairs Leaders (Rogue Trader Entourage etc.) — at least one merge happened.
    expect(state.units.some((u) => (u.attachedLeaders?.length ?? 0) > 0)).toBe(true);
  });

  it('Deathwatch (Deep Strike units) put something in Reserves with a reserves-using profile', () => {
    const rng = makeRNG(9);
    const deps = makeDeps(rng, deathwatch as Roster, cadian as Roster);
    let state = reduce(createInitialState(layout), { type: 'NewBattle' }, rng, ctx);
    for (let i = 0; i < 200 && state.stage === 'setup'; i++) {
      const d = whoActs(state, deps);
      const action = d.actor === 'shared' ? sharedAction(state) : d.actor ? aiAction(state, d.actor, 'balanced', deps) : null;
      if (!action) break;
      for (const item of action.intents) {
        if (item.skipIf?.(state)) continue;
        state = reduce(state, item.intent, rng, ctx);
      }
    }
    expect(state.stage).toBe('battle');
    const reserved = state.units.filter((u) => u.owner === 'player' && u.inReserves);
    expect(reserved.length).toBeGreaterThan(0);
    // Infiltrators (if any deployed) were validated by the reducer — no rejected lines at all.
    expect(state.log.filter((l) => /rejected/i.test(l))).toEqual([]);
  });

  it('an AI deployment intent is identical to what the reducer validates (spot check)', () => {
    const rng = makeRNG(7);
    const deps = makeDeps(rng);
    let state = reduce(createInitialState(layout), { type: 'NewBattle' }, rng, ctx);
    state = reduce(state, { type: 'RollRoles' }, rng, ctx);
    // The side's first action may be the battle-formations declaration — take actions until the
    // first actual placement comes out.
    let deployIntent;
    for (let i = 0; i < 5 && !deployIntent; i++) {
      const d = whoActs(state, deps);
      expect(d.actor === 'player' || d.actor === 'ai').toBe(true);
      const action = aiAction(state, d.actor as 'player' | 'ai', 'balanced', deps)!;
      deployIntent = action.intents.map((x) => x.intent).find((x) => x.type === 'DeployUnit' || x.type === 'PlaceInReserves');
      if (!deployIntent) {
        for (const item of action.intents) {
          if (item.skipIf?.(state)) continue;
          state = reduce(state, item.intent, rng, ctx);
        }
      }
    }
    expect(deployIntent).toBeTruthy();
    if (deployIntent?.type === 'DeployUnit') {
      // Re-run the reducer's own check on the AI's chosen anchor.
      const positions = formationPositions({
        anchor: deployIntent.anchor,
        count: deployIntent.modelCount,
        baseShape: deployIntent.baseShape,
        formation: 'block',
        rotation: 0,
      });
      expect(checkUnitDeployment(positions, deployIntent.baseShape, state.layout, deployIntent.owner, deployIntent.ability ?? 'standard').legal).toBe(true);
    }
  });
});
