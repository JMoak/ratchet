/**
 * Small, seeded statistics for paired comparisons on one item set: an exact McNemar test on
 * the discordant pairs, a percentile bootstrap over items, and Wilson intervals. Nothing here
 * is fitted; every number is a function of the labelled rows and a seed.
 */
import { wilsonInterval } from "../../../src/ledger/calibration.ts";
import { logGamma, type Rand, rng } from "../../../src/math.ts";

const logChoose = (n: number, k: number): number =>
  logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

/**
 * Exact two-sided McNemar test: under the null the b and c discordant pairs are a fair coin.
 * Returns the p-value; with no discordant pairs there is nothing to test and p is 1.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}

/** Percentile bootstrap of a paired statistic over item indices. */
export function bootstrap(
  n: number,
  stat: (idx: readonly number[]) => number,
  reps = 2000,
  seed = 17,
): { readonly lo: number; readonly hi: number } {
  const r: Rand = rng(seed);
  const vals: number[] = [];
  for (let b = 0; b < reps; b++) {
    const idx = Array.from({ length: n }, () => Math.floor(r() * n));
    vals.push(stat(idx));
  }
  vals.sort((a, b) => a - b);
  return { lo: vals[Math.floor(0.025 * reps)] ?? 0, hi: vals[Math.floor(0.975 * reps)] ?? 0 };
}

export function wilson(k: number, n: number): { readonly lo: number; readonly hi: number } {
  const w = wilsonInterval(n === 0 ? 0 : k / n, n);
  return { lo: w.lower, hi: w.upper };
}

export const pct = (x: number, places = 1): string =>
  Number.isFinite(x) ? `${(100 * x).toFixed(places)}%` : "n/a";
export const num = (x: number, places = 3): string =>
  Number.isFinite(x) ? x.toFixed(places) : "n/a";
export const money = (x: number): string => `$${x.toFixed(6)}`;

export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
}

/** Phi between two boolean columns; undefined when either column is constant (no variance). */
export function phi(pairs: readonly (readonly [boolean, boolean])[]): number | undefined {
  let n11 = 0;
  let n10 = 0;
  let n01 = 0;
  let n00 = 0;
  for (const [a, b] of pairs) {
    if (a && b) n11++;
    else if (a) n10++;
    else if (b) n01++;
    else n00++;
  }
  const d = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
  return d === 0 ? undefined : (n11 * n00 - n10 * n01) / d;
}

/** A markdown table from a header and rows of cells. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}
