// AI personality profiles — the tunable knobs every AI decision reads. PURE data.
//
// Profiles are plain JSON-serialisable objects so the sim harness (tools/sim) can load tweaked
// weight sets from disk, pit them against each other over many seeded matches, and keep whichever
// wins more — that comparison loop is how the AI gets "trained" without any ML machinery.

export interface AiProfile {
  name: string;
  /** Weight on taking/holding objectives (VP is the win condition). */
  objective: number;
  /** Weight on expected damage dealt (target choice, move-to-shoot value). */
  damage: number;
  /** Weight on expected damage *received* (standoff distance, screening). 0 = fearless. */
  caution: number;
  /** Declare a charge when P(success) × melee value (in points) exceeds this. Lower = charge-happy. */
  chargeThreshold: number;
  /** Hold Deep Strike-capable units in Reserves during deployment. */
  useReserves: boolean;
  /** Preferred standoff from the nearest enemy when there is no objective to take, in inches. */
  standoff: number;
  /** Spend 1 CP on a defensive reaction when an own unit is about to take at least this many
   *  points of expected damage from one enemy shooting activation. */
  reactThreshold: number;
  /** Weight on starting Objective Actions over shooting (11e mission play). Default 1. */
  actionPriority?: number;
  /** Legal-move baseline: ignore all scores and pick uniformly at random (for sanity matches). */
  random?: boolean;
}

export const AI_PROFILES: Record<string, AiProfile> = {
  balanced: {
    name: 'balanced',
    objective: 1.0,
    damage: 1.0,
    caution: 0.5,
    chargeThreshold: 25,
    useReserves: true,
    standoff: 18,
    reactThreshold: 60,
  },
  aggressive: {
    name: 'aggressive',
    objective: 0.7,
    damage: 1.5,
    caution: 0.15,
    chargeThreshold: 10,
    useReserves: true,
    standoff: 10,
    reactThreshold: 90,
  },
  defensive: {
    name: 'defensive',
    objective: 1.3,
    damage: 0.8,
    caution: 1.0,
    chargeThreshold: 45,
    useReserves: false,
    standoff: 24,
    reactThreshold: 40,
  },
  // ── Disposition-tuned players ("prepare different AI players") ────────────────
  /** Take and Hold / Disruption: floods objectives early and holds them. */
  objective_rusher: {
    name: 'objective_rusher',
    objective: 1.6,
    damage: 0.8,
    caution: 0.35,
    chargeThreshold: 20,
    useReserves: true,
    standoff: 12,
    reactThreshold: 70,
    actionPriority: 1.0,
  },
  /** Purge the Foe: trades aggressively — kills ARE its primary VP. */
  attrition: {
    name: 'attrition',
    objective: 0.9,
    damage: 1.5,
    caution: 0.3,
    chargeThreshold: 14,
    useReserves: true,
    standoff: 12,
    reactThreshold: 80,
    actionPriority: 0.7,
  },
  /** Priority Assets / Reconnaissance: performs actions, screens, avoids bad trades. */
  operative: {
    name: 'operative',
    objective: 1.3,
    damage: 0.7,
    caution: 0.8,
    chargeThreshold: 35,
    useReserves: true,
    standoff: 18,
    reactThreshold: 50,
    actionPriority: 1.6,
  },
  random: {
    name: 'random',
    objective: 0,
    damage: 0,
    caution: 0,
    chargeThreshold: 0,
    useReserves: false,
    standoff: 0,
    reactThreshold: 9999,
    random: true,
  },
};

/** The profile that best plays a Force Disposition (the sim's default seat assignment). */
export function profileForDisposition(disposition: string): string {
  switch (disposition) {
    case 'purge_the_foe': return 'attrition';
    case 'priority_assets':
    case 'reconnaissance': return 'operative';
    case 'take_and_hold':
    case 'disruption': return 'objective_rusher';
    default: return 'balanced';
  }
}

/** Resolve a profile by name (falling back to balanced) or pass a custom weight set through. */
export function resolveProfile(p: string | AiProfile | undefined): AiProfile {
  if (!p) return AI_PROFILES.balanced!;
  if (typeof p === 'string') return AI_PROFILES[p] ?? AI_PROFILES.balanced!;
  return p;
}
