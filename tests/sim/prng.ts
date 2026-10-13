/**
 * Seeded randomness for the week simulator. Math.random is never used: the same seed must give the same week, decision for decision.
 */

/** mulberry32: a small, fast 32-bit PRNG with good enough statistics for workload generation. Returns floats in [0, 1). */
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

export class Rng {
  private next: () => number;
  constructor(seed: number) { this.next = mulberry32(seed); }
  /** Uniform in [0, 1). */
  u(): number { return this.next(); }
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hiIncl: number): number { return lo + Math.floor(this.next() * (hiIncl - lo + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]!; }
  /** Standard normal (Box-Muller). */
  normal(): number {
    const u1 = Math.max(1e-12, this.next()), u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  /**
   * Lognormal multiplier with median 1 whose typical spread is +-`spread` (0.4 = +-40%): exp(N(0, ln(1 + spread))). Clamped to
   * [1/(1+3s), 1+3s] so one freak draw cannot decide a whole week.
   */
  lognormal(spread: number): number {
    const s = Math.log(1 + spread);
    return Math.min(1 + 3 * spread, Math.max(1 / (1 + 3 * spread), Math.exp(s * this.normal())));
  }
  /** Poisson count with mean `lambda` (Knuth; lambda is small here). */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= this.next(); } while (p > L);
    return k - 1;
  }
}
