// Seeded, injectable RNG (architecture rule #2). Core never calls Math.random();
// it takes an RNG so every game is reproducible and every test deterministic.
// Stage 1 barely rolls dice — this just establishes the seam.

export interface RNG {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** A single six-sided die: 1..6. */
  d6(): number;
  /** Roll `count` dice of `sides` (default 6); returns each result in order. */
  roll(count: number, sides?: number): number[];
}

/**
 * mulberry32 — a tiny, fast, deterministic 32-bit PRNG. Good enough for dice and
 * fully reproducible from a seed. NOT cryptographically secure.
 */
export function makeRNG(seed: number): RNG {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1));

  const d6 = (): number => int(1, 6);

  const roll = (count: number, sides = 6): number[] => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(int(1, sides));
    return out;
  };

  return { next, int, d6, roll };
}
