/**
 * Small numeric toolkit shared by the engine and the simulations.
 * Everything here is pure and dependency-free.
 */

export const EPS = 1e-6;

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** log(p / (1 - p)), clamped away from 0 and 1 so evidence stays finite. */
export const logit = (p: number): number => {
  const q = clamp(p, EPS, 1 - EPS);
  return Math.log(q / (1 - q));
};

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export function normalize(xs: readonly number[]): number[] {
  const s = xs.reduce((a, b) => a + b, 0);
  if (!(s > 0) || !Number.isFinite(s)) return xs.map(() => 1 / xs.length);
  return xs.map((x) => x / s);
}

/** Turn unnormalized log-weights into a probability vector (numerically stable). */
export function softmaxLog(logs: readonly number[]): number[] {
  const m = Math.max(...logs);
  return normalize(logs.map((l) => Math.exp(l - m)));
}

export function argmax(xs: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) {
    const cur = xs[i];
    const b = xs[best];
    if (cur !== undefined && b !== undefined && cur > b) best = i;
  }
  return best;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Binomial coefficient via log-gamma to avoid overflow for moderate n. */
function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Lanczos approximation of log Gamma(x). Good to about 1e-10 for x > 0. */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = c[0] ?? 0;
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += (c[i] ?? 0) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomialTail(n: number, k: number, p: number): number {
  let s = 0;
  for (let i = k; i <= n; i++) {
    s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return clamp(s, 0, 1);
}

/**
 * Condorcet: probability that a simple majority of n independent voters, each correct with
 * probability p, is correct. For even n, ties are broken by a fair coin.
 */
export function majorityAccuracy(n: number, p: number): number {
  if (n % 2 === 1) return binomialTail(n, (n + 1) / 2, p);
  const strict = binomialTail(n, n / 2 + 1, p);
  const tie = Math.exp(logChoose(n, n / 2) + (n / 2) * Math.log(p) + (n / 2) * Math.log(1 - p));
  return clamp(strict + 0.5 * tie, 0, 1);
}

/**
 * Effective number of independent voters when n voters share pairwise error correlation rho.
 * This is the "design effect" from survey statistics; it is the single most important
 * correction in the whole engine, because correlated voters do not compound.
 */
export function effectiveN(n: number, rho: number): number {
  const r = clamp(rho, 0, 1);
  return n / (1 + (n - 1) * r);
}

/** Bayes-optimal threshold to act when a wrong act costs costWrongAct and a wrong hold costs costWrongHold. */
export function thresholdFromCosts(costWrongAct: number, costWrongHold: number): number {
  if (costWrongAct < 0 || costWrongHold < 0) throw new Error("costs must be non-negative");
  const d = costWrongAct + costWrongHold;
  return d === 0 ? 0.5 : costWrongAct / d;
}

// ---------------------------------------------------------------------------
// Seeded randomness (mulberry32). Simulations must be reproducible.
// ---------------------------------------------------------------------------

export type Rand = () => number;

export function rng(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randNormal(rand: Rand): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia and Tsang gamma sampler, shape k > 0, scale 1. */
export function randGamma(k: number, rand: Rand): number {
  if (k < 1) return randGamma(k + 1, rand) * rand() ** (1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = randNormal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function randBeta(a: number, b: number, rand: Rand): number {
  const x = randGamma(a, rand);
  const y = randGamma(b, rand);
  return x / (x + y);
}

export function shuffled<T>(xs: readonly T[], rand: Rand): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

export function round(x: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}
