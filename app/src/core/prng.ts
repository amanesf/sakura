/**
 * Deterministic PRNG so the procedural tree/mountains look identical on every reload,
 * which matters for reviewing composition changes via screenshot diffing.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export function rngRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}
