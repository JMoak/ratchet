/**
 * Statistics for the verifier evaluation. Every rate is reported with its count and an
 * interval: Wilson for proportions, exact Clopper-Pearson where the count is small or at the
 * boundary, and a cluster bootstrap over task instances for anything computed across items
 * that share sources (AUC, coverage at a precision), because those items are not independent.
 */
import { exactLowerBound } from "../../../src/acceptance.ts";
import { wilsonInterval } from "../../../src/ledger/calibration.ts";
import { rng, shuffled } from "../../../src/math.ts";

export interface Rate {
  readonly k: number;
  readonly n: number;
  readonly p: number;
  readonly lo: number;
  readonly hi: number;
}

export function rate(k: number, n: number): Rate {
  const p = n === 0 ? Number.NaN : k / n;
  const w = wilsonInterval(n === 0 ? 0 : k / n, n, 0.95);
  return { k, n, p, lo: w.lower, hi: w.upper };
}

/** Exact two-sided 95% Clopper-Pearson interval, from the engine's own exact one-sided bound. */
export function exact(k: number, n: number): Rate {
  if (n === 0) return { k, n, p: Number.NaN, lo: 0, hi: 1 };
  const lo = exactLowerBound(k, n, 0.975);
  const hi = 1 - exactLowerBound(n - k, n, 0.975);
  return { k, n, p: k / n, lo, hi };
}

export const pct = (x: number, d = 1): string =>
  Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : "n/a";
export const fmtRate = (r: Rate, d = 1): string =>
  r.n === 0 ? "n/a (n=0)" : `${pct(r.p, d)} [${pct(r.lo, d)}, ${pct(r.hi, d)}] (${r.k}/${r.n})`;

/** One scored candidate: the verifier's probability that the output passes, and the truth. */
export interface Point {
  readonly p: number;
  readonly truth: boolean;
  /** Cluster key: the task instance. */
  readonly cluster: string;
}

/** Mann-Whitney AUC: the chance a random passing output scores above a random failing one. */
export function auc(points: readonly Point[]): number {
  const pos = points.filter((x) => x.truth).map((x) => x.p);
  const neg = points.filter((x) => !x.truth).map((x) => x.p);
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export interface ActStats {
  readonly bar: number;
  readonly accepted: number;
  readonly n: number;
  /** Share of all candidates committed automatically. */
  readonly coverage: Rate;
  /** Share of committed candidates that were truly correct. */
  readonly precision: Rate;
  /** Catch rate t: share of wrong candidates not committed. */
  readonly catchRate: Rate;
  /** False-alarm rate f: share of correct candidates not committed. */
  readonly falseAlarm: Rate;
}

/** What acting at `bar` on p(pass) does: accept when p >= bar, as `rule` does with goIsYes. */
export function actAt(points: readonly Point[], bar: number): ActStats {
  const acc = points.filter((x) => x.p >= bar);
  const wrong = points.filter((x) => !x.truth);
  const right = points.filter((x) => x.truth);
  return {
    bar,
    accepted: acc.length,
    n: points.length,
    coverage: rate(acc.length, points.length),
    precision: rate(acc.filter((x) => x.truth).length, acc.length),
    catchRate: rate(wrong.filter((x) => x.p < bar).length, wrong.length),
    falseAlarm: rate(right.filter((x) => x.p < bar).length, right.length),
  };
}

/**
 * The one-sided act bar: the lowest bar on p(pass) whose accepted set has precision at least
 * `target` (by Wilson lower bound when conservative) with at least `minSupport` accepted.
 * This is the promise an act bar makes for a judge gate; `fitThreshold` instead reads the
 * leading answer's confidence on both sides.
 */
export function fitActBar(
  points: readonly Point[],
  target: number,
  minSupport = 20,
  conservative = false,
): number | undefined {
  const sorted = points.slice().sort((a, b) => b.p - a.p);
  let best: number | undefined;
  let right = 0;
  for (let i = 0; i < sorted.length; i++) {
    const x = sorted[i] as Point;
    if (x.truth) right++;
    const next = sorted[i + 1];
    if (next && next.p === x.p) continue;
    const n = i + 1;
    const prec = conservative ? wilsonInterval(right / n, n, 0.95).lower : right / n;
    if (n >= minSupport && prec >= target) best = x.p;
  }
  return best;
}

/** The most coverage any bar reaches on these points at the target precision (ranking quality). */
export function coverageAtPrecision(points: readonly Point[], target: number): number {
  const sorted = points.slice().sort((a, b) => b.p - a.p);
  let right = 0;
  let best = 0;
  for (let i = 0; i < sorted.length; i++) {
    const x = sorted[i] as Point;
    if (x.truth) right++;
    const next = sorted[i + 1];
    if (next && next.p === x.p) continue;
    if (right / (i + 1) >= target) best = (i + 1) / sorted.length;
  }
  return best;
}

/** Percentile interval of a statistic over a bootstrap that resamples whole clusters. */
export function clusterBootstrap(
  points: readonly Point[],
  stat: (xs: readonly Point[]) => number,
  B = 2000,
  seed = 11,
): { readonly lo: number; readonly hi: number } {
  const byCluster = new Map<string, Point[]>();
  for (const x of points) {
    const list = byCluster.get(x.cluster);
    if (list) list.push(x);
    else byCluster.set(x.cluster, [x]);
  }
  const clusters = [...byCluster.values()];
  const r = rng(seed);
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const draw: Point[] = [];
    for (let i = 0; i < clusters.length; i++) {
      draw.push(...(clusters[Math.floor(r() * clusters.length)] as Point[]));
    }
    const v = stat(draw);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const q = (u: number): number =>
    vals[Math.min(vals.length - 1, Math.floor(u * vals.length))] ?? Number.NaN;
  return { lo: q(0.025), hi: q(0.975) };
}

/** Paired cluster bootstrap of a difference between two scorings of the same items. */
export function pairedDiff(
  a: readonly Point[],
  b: readonly Point[],
  stat: (xs: readonly Point[]) => number,
  B = 2000,
  seed = 13,
): { readonly diff: number; readonly lo: number; readonly hi: number; readonly pBelow0: number } {
  if (a.length !== b.length) throw new Error("paired scorings must cover the same items");
  const idx = new Map<string, number[]>();
  a.forEach((x, i) => {
    const list = idx.get(x.cluster);
    if (list) list.push(i);
    else idx.set(x.cluster, [i]);
  });
  const clusters = [...idx.values()];
  const r = rng(seed);
  const diffs: number[] = [];
  for (let k = 0; k < B; k++) {
    const ia: Point[] = [];
    const ib: Point[] = [];
    for (let i = 0; i < clusters.length; i++) {
      for (const j of clusters[Math.floor(r() * clusters.length)] as number[]) {
        ia.push(a[j] as Point);
        ib.push(b[j] as Point);
      }
    }
    const d = stat(ia) - stat(ib);
    if (Number.isFinite(d)) diffs.push(d);
  }
  diffs.sort((x, y) => x - y);
  const q = (u: number): number =>
    diffs[Math.min(diffs.length - 1, Math.floor(u * diffs.length))] ?? Number.NaN;
  return {
    diff: stat(a) - stat(b),
    lo: q(0.025),
    hi: q(0.975),
    pBelow0: diffs.filter((d) => d <= 0).length / Math.max(1, diffs.length),
  };
}

/** Pearson correlation of two equal-length series. */
export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return Number.NaN;
  const mx = xs.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const my = ys.slice(0, n).reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? Number.NaN : sxy / Math.sqrt(sxx * syy);
}

/** Stable seeded subsample, used where a census is too large to show. */
export const seededPick = <T>(xs: readonly T[], k: number, seed: number): T[] =>
  shuffled(xs, rng(seed)).slice(0, k);
