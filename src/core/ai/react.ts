// AI reactive plays — actions taken on the OPPONENT'S turn (architecture rule #3). PURE.
//
// When an enemy unit is about to shoot one of ours, the AI may spend 1 CP on the matching
// defensive Core stratagem (Smokescreen for SMOKE units, Go to Ground for INFANTRY — both bound
// to the 'stealth' effect, -1 to be hit) if the incoming expected damage justifies it. One
// reaction per phase (proxied by "something of ours already has stealth up").
//
// This is the seam reactive rules grow from: the runner and the UI both call `aiReactionToShooting`
// just before a ShootUnit intent from the other side resolves.

import type { GameState, Side } from '../types';
import { shootingEV, unitValue } from './evaluate';
import type { AiDeps, AiIntent } from './types';
import type { AiProfile } from './profile';

export function aiReactionToShooting(
  state: GameState,
  defendingSide: Side,
  attackerUnitId: string,
  targetUnitId: string,
  profile: AiProfile,
  deps: AiDeps,
): AiIntent[] {
  const { ctx } = deps;
  if (state.cp[defendingSide] < 1) return [];
  const attacker = state.units.find((u) => u.id === attackerUnitId);
  const target = state.units.find((u) => u.id === targetUnitId);
  if (!attacker || !target || target.owner !== defendingSide || attacker.owner === defendingSide) return [];
  if (target.status.activeEffects?.includes('stealth')) return [];
  // One reaction per phase: if anything of ours already has stealth up, hold the CP.
  if (state.units.some((u) => u.owner === defendingSide && u.status.activeEffects?.includes('stealth'))) return [];

  const ds = ctx.datasheets.get(target.datasheetId);
  const kw = (ds?.keywords ?? []).map((k) => k.toUpperCase());
  const smoke = kw.includes('SMOKE');
  const infantry = kw.includes('INFANTRY');
  if (!smoke && !infantry) return [];

  const incoming = shootingEV(state, attacker, target, ctx);
  const value = unitValue(target, ctx);
  if (incoming < profile.reactThreshold && incoming < value * 0.4) return [];

  const name = smoke ? 'Smokescreen' : 'Go to Ground';
  return [
    {
      intent: { type: 'UseStratagem', name, side: defendingSide, cost: 1, targetUnitId, effectId: 'stealth' },
      skipIf: (s) => s.cp[defendingSide] < 1,
    },
  ];
}
