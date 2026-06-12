// Battlefield-role classification — HOW each unit wants to be played. PURE.
//
// The AI used to score every unit identically, which produced absurdities like a Vindicare
// Assassin (a 48"-rifle Lone Operative sniper) sprinting at the enemy to stand on a midfield
// objective. Roles give every datasheet a play style: where it deploys, how far it keeps from
// the enemy, and how hard objectives pull on it. The classification is signal-based (abilities,
// weapons, keywords, stats) so it covers every datasheet in the data without a hand-table;
// `docs/ai_unit_roles.md` documents the resulting assignment for the rosters the AI plays.

import type { Datasheet, UnitInstance } from '../types';
import type { EngineContext } from '../engine';
import { hasAbility, hasLoneOperative } from '../abilities';
import { parseKeywords } from '../keywords';
import { datasheetThreat } from './evaluate';

export type UnitRole =
  | 'sniper' // backline character killer: sit far back, never brawl (Vindicare)
  | 'assassin' // melee infiltrator/scout: hunt characters and weak units (Eversor, Callidus)
  | 'artillery' // indirect fire: hug the back edge, shoot what it cannot see
  | 'gunline' // ranged platforms (tanks, heavy infantry): hold a range band
  | 'battleline' // objective troops: take and HOLD markers
  | 'assault' // melee units: push forward, charge
  | 'skirmisher' // fast, cheap screens/scouts: grab far objectives, trade space
  | 'support' // characters/leaders: stay with the squads they buff
  | 'transport'; // carriers (no embark rules yet: played like light gunline)

export interface RolePlan {
  role: UnitRole;
  /** Preferred deployment depth: 0 = zone front edge, 1 = back edge. */
  wantDepth: number;
  /** Minimum distance to keep from the nearest enemy when choosing where to stand, inches. */
  standoff: number;
  /** Multiplier on the objective pull (1 = the AI's profile weight unchanged). */
  objectiveWeight: number;
  /** Multiplier on charge appetite (assassins/assault dive, snipers never). */
  chargeWeight: number;
  /** Bonus multiplier on shooting value vs CHARACTER targets (snipers pick off leaders). */
  characterHunter: number;
}

const has = (ds: Datasheet | undefined, kw: string): boolean =>
  !!ds?.keywords.some((k) => k.toLowerCase() === kw.toLowerCase());

/** The longest ranged-weapon range on the datasheet (0 when it has none). */
function maxRange(ds: Datasheet): number {
  let r = 0;
  for (const w of ds.weapons) if (w.type === 'ranged') r = Math.max(r, w.range ?? 0);
  return r;
}

function hasIndirect(ds: Datasheet): boolean {
  return ds.weapons.some((w) => w.type === 'ranged' && !!parseKeywords(w.keywords).indirectFire);
}

/** Classify one datasheet. Deterministic; order of the rules matters (first match wins). */
export function classifyDatasheet(ds: Datasheet | undefined): UnitRole {
  if (!ds) return 'battleline';
  const ranged = datasheetThreat(ds, 'ranged');
  const melee = datasheetThreat(ds, 'melee');
  const range = maxRange(ds);

  // Lone Operatives split by reach: a 36"+ gun is a sniper, otherwise it kills up close.
  if (hasLoneOperative(ds)) return range >= 36 && ranged >= melee ? 'sniper' : 'assassin';
  // Only DEDICATED transports play taxi. Firing Deck alone must not — a Stormlord is a Titanic
  // gun platform that happens to carry passengers, and the transport plan was benching it.
  if (has(ds, 'Dedicated Transport')) return 'transport';
  // Indirect long guns shelter at the back (they do not need line of sight).
  if (hasIndirect(ds) && range >= 36 && melee < ranged) return 'artillery';
  if (has(ds, 'Character')) return 'support';
  if (melee > ranged * 1.2) return 'assault';
  // Fast and cheap with Scouts/Infiltrators → screens and objective-grabbers.
  const fast = (ds.models[0]?.M ?? 6) >= 8;
  if (fast && (hasAbility(ds, 'Scouts') || hasAbility(ds, 'Infiltrators'))) return 'skirmisher';
  if (has(ds, 'Battleline')) return 'battleline';
  if ((has(ds, 'Vehicle') || has(ds, 'Monster') || ranged > 2 * melee) && range >= 24) return 'gunline';
  return 'battleline';
}

/** The play-style numbers for a role. `range` is the unit's longest gun, for range-band keeping.
 *  Standoffs are capped at board scale (a 240" earthshaker still fights on a 60" table). */
export function rolePlan(role: UnitRole, range: number): RolePlan {
  switch (role) {
    case 'sniper':
      // Sit at ~3/4 rifle range, never closer than 24": the rifle reaches, the reply does not.
      return { role, wantDepth: 0.85, standoff: Math.min(36, Math.max(24, range * 0.75)), objectiveWeight: 0.25, chargeWeight: 0, characterHunter: 2.0 };
    case 'assassin':
      return { role, wantDepth: 0.2, standoff: 0, objectiveWeight: 0.7, chargeWeight: 1.5, characterHunter: 1.5 };
    case 'artillery':
      return { role, wantDepth: 0.9, standoff: Math.min(36, Math.max(24, range * 0.5)), objectiveWeight: 0.15, chargeWeight: 0, characterHunter: 1.0 };
    case 'gunline':
      return { role, wantDepth: 0.65, standoff: Math.min(30, Math.max(12, range * 0.5)), objectiveWeight: 0.7, chargeWeight: 0.5, characterHunter: 1.0 };
    case 'battleline':
      return { role, wantDepth: 0.35, standoff: 6, objectiveWeight: 1.4, chargeWeight: 0.8, characterHunter: 1.0 };
    case 'assault':
      return { role, wantDepth: 0.1, standoff: 0, objectiveWeight: 1.0, chargeWeight: 1.3, characterHunter: 1.0 };
    case 'skirmisher':
      return { role, wantDepth: 0.25, standoff: 8, objectiveWeight: 1.3, chargeWeight: 0.7, characterHunter: 1.0 };
    case 'support':
      return { role, wantDepth: 0.5, standoff: 14, objectiveWeight: 0.8, chargeWeight: 0.6, characterHunter: 1.0 };
    case 'transport':
      return { role, wantDepth: 0.5, standoff: 12, objectiveWeight: 0.8, chargeWeight: 0.4, characterHunter: 1.0 };
  }
}

/** Role plan for a live unit (merged Leaders keep the Bodyguard's role — they move as the unit). */
export function unitRolePlan(unit: UnitInstance, ctx: EngineContext): RolePlan {
  const ds = ctx.datasheets.get(unit.datasheetId);
  return rolePlan(classifyDatasheet(ds), ds ? maxRange(ds) : 0);
}

/**
 * Which of `side`'s units should garrison the HOME objective (the marker nearest the side's own
 * deployment zone). Holding your own point is free Primary VP every Command phase — someone
 * cheap, durable and objective-happy stays back for it. Deterministic: best fitness wins.
 * Returns null when the side has no units (or no home objective exists).
 */
export function homeGarrisonId(
  units: UnitInstance[],
  home: { x: number; y: number } | null,
  ctx: EngineContext,
  valueOf: (u: UnitInstance) => number,
): string | null {
  if (!home) return null;
  let best: { id: string; fitness: number } | null = null;
  for (const u of units) {
    const plan = unitRolePlan(u, ctx);
    // Snipers/artillery garrison ONLY as a last resort; battleline first; cheaper preferred;
    // already standing near home is a strong tie-breaker.
    const roleFit =
      plan.role === 'battleline' ? 3 : plan.role === 'skirmisher' ? 2.2 : plan.role === 'gunline' ? 1.6
      : plan.role === 'transport' ? 1.4 : plan.role === 'support' ? 1.1 : plan.role === 'assault' ? 1.0
      : 0.3; // sniper / assassin / artillery
    const ms = u.models.filter((m) => m.alive);
    const cx = ms.reduce((s, m) => s + m.pos.x, 0) / Math.max(1, ms.length);
    const cy = ms.reduce((s, m) => s + m.pos.y, 0) / Math.max(1, ms.length);
    const dist = Math.hypot(cx - home.x, cy - home.y);
    const fitness = roleFit * 100 - valueOf(u) * 0.15 - dist;
    if (!best || fitness > best.fitness || (fitness === best.fitness && u.id < best.id)) {
      best = { id: u.id, fitness };
    }
  }
  return best?.id ?? null;
}
