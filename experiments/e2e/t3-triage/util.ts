/**
 * Statistics and run plumbing for track T3. Every rate is reported with its n and an interval:
 * Wilson for proportions (the engine's own `wilsonInterval`), exact Clopper-Pearson where a
 * bound is compared with a promise, and exact McNemar (a sign test on the discordant pairs) for
 * paired arms. Authored corpora are correlated by template, so intervals here are optimistic:
 * they treat items as independent, which items from one template are not.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exactLowerBound } from "../../../src/acceptance.ts";
import type { Engine } from "../../../src/engine.ts";
import {
  brier,
  ece,
  reliability,
  type Scored,
  wilsonInterval,
} from "../../../src/ledger/calibration.ts";
import { type DecisionRecord, parseJsonlLedger } from "../../../src/ledger/ledger.ts";
import { binomialTail, rng } from "../../../src/math.ts";
import { type DeciderLabel, labelAsDecider, writeJson } from "../lib.ts";

export const CORPUS = join(import.meta.dirname, "corpus");

export function loadCorpus<T>(name: string): T {
  return JSON.parse(readFileSync(join(CORPUS, `${name}.json`), "utf8")) as T;
}

// ---------------------------------------------------------------------------
// Proportions
// ---------------------------------------------------------------------------

export interface Rate {
  readonly k: number;
  readonly n: number;
  readonly p: number;
  readonly lo: number;
  readonly hi: number;
}

export function wilson(k: number, n: number): Rate {
  const p = n === 0 ? 0 : k / n;
  const { lower, upper } = wilsonInterval(p, n, 0.95);
  return { k, n, p, lo: lower, hi: upper };
}

/** Two-sided 95% Clopper-Pearson interval. */
export function clopper(k: number, n: number): Rate {
  const p = n === 0 ? 0 : k / n;
  const lo = n === 0 ? 0 : exactLowerBound(k, n, 0.975);
  const hi = n === 0 ? 1 : 1 - exactLowerBound(n - k, n, 0.975);
  return { k, n, p, lo, hi };
}

export const rateOf = (xs: readonly boolean[]): Rate =>
  wilson(xs.filter(Boolean).length, xs.length);

export const pct = (x: number | undefined, d = 1): string =>
  x === undefined || Number.isNaN(x) ? "-" : `${(100 * x).toFixed(d)}%`;

export const fmt = (r: Rate): string =>
  r.n === 0 ? "- (n=0)" : `${pct(r.p)} [${pct(r.lo)}, ${pct(r.hi)}] (${r.k}/${r.n})`;

export const num = (x: number | undefined, d = 3): string =>
  x === undefined || Number.isNaN(x) ? "-" : x.toFixed(d);

// ---------------------------------------------------------------------------
// Paired comparison
// ---------------------------------------------------------------------------

export interface Paired {
  readonly n: number;
  /** Right in arm a only. */
  readonly aOnly: number;
  /** Right in arm b only. */
  readonly bOnly: number;
  /** Exact two-sided McNemar p: a sign test on the discordant pairs. */
  readonly p: number;
}

export function mcnemar(a: readonly boolean[], b: readonly boolean[]): Paired {
  if (a.length !== b.length) throw new Error("paired arms differ in length");
  let aOnly = 0;
  let bOnly = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && !b[i]) aOnly++;
    if (!a[i] && b[i]) bOnly++;
  }
  const m = aOnly + bOnly;
  const lo = Math.min(aOnly, bOnly);
  // P(X <= lo) for X ~ Bin(m, 1/2), doubled; binomialTail gives P(X >= k).
  const lower = m === 0 ? 1 : 1 - (lo + 1 <= m ? binomialTail(m, lo + 1, 0.5) : 0);
  return { n: a.length, aOnly, bOnly, p: Math.min(1, 2 * lower) };
}

export const fmtPaired = (x: Paired, a: string, b: string): string =>
  `${a} only right ${x.aOnly}, ${b} only right ${x.bOnly} of ${x.n} pairs; exact McNemar p = ${x.p < 0.001 ? x.p.toExponential(1) : x.p.toFixed(3)}`;

/** Seeded paired bootstrap of a difference in a statistic, 95% percentile interval. */
export function bootstrapDiff<T>(
  items: readonly T[],
  stat: (xs: readonly T[]) => number,
  other: (xs: readonly T[]) => number,
  rounds = 2000,
  seed = 7,
): { readonly diff: number; readonly lo: number; readonly hi: number } {
  const r = rng(seed);
  const diffs: number[] = [];
  for (let b = 0; b < rounds; b++) {
    const s = Array.from(
      { length: items.length },
      () => items[Math.floor(r() * items.length)] as T,
    );
    diffs.push(stat(s) - other(s));
  }
  diffs.sort((x, y) => x - y);
  return {
    diff: stat(items) - other(items),
    lo: diffs[Math.floor(0.025 * rounds)] ?? 0,
    hi: diffs[Math.floor(0.975 * rounds)] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Calibration summaries
// ---------------------------------------------------------------------------

export type Posture = "underconfident" | "overconfident" | "calibrated";

export interface Calib {
  readonly n: number;
  readonly accuracy: Rate;
  /** Mean stated confidence of the leading answer: the accuracy the model claims. */
  readonly expected: number;
  readonly posture: Posture;
  readonly ece: number;
  readonly brier: number;
}

/** The engine report's posture rule: more than 2 points either side of calibrated. */
export function postureOf(observed: number, expected: number): Posture {
  const gap = observed - expected;
  return gap > 0.02 ? "underconfident" : gap < -0.02 ? "overconfident" : "calibrated";
}

export function calib(items: readonly Scored[]): Calib {
  const acc = rateOf(items.map((s) => s.correct));
  const expected =
    items.length === 0 ? Number.NaN : items.reduce((s, x) => s + x.confidence, 0) / items.length;
  return {
    n: items.length,
    accuracy: acc,
    expected,
    posture: postureOf(acc.p, expected),
    ece: ece(items),
    brier: brier(items),
  };
}

export const reliabilityRows = (items: readonly Scored[]) =>
  reliability(items, 10).filter((b) => b.n > 0);

/** Area under the ROC curve of `score` for the positive class (Mann-Whitney, ties halved). */
export function auc(scores: readonly number[], positive: readonly boolean[]): number {
  const pos: number[] = [];
  const neg: number[] = [];
  scores.forEach((s, i) => {
    (positive[i] ? pos : neg).push(s);
  });
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// ---------------------------------------------------------------------------
// Run plumbing
// ---------------------------------------------------------------------------

/** Run `fn` over `items` with at most `limit` in flight, keeping input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Label rows by the decider, in order, one at a time (the JSONL ledger rereads itself per label). */
export async function labelAll(
  engine: Engine,
  rows: readonly {
    readonly recordId: string;
    readonly verdict: DecisionRecord["verdict"];
    readonly label: DeciderLabel;
  }[],
): Promise<number> {
  let n = 0;
  for (const r of rows) if (await labelAsDecider(engine, r.recordId, r.verdict, r.label)) n++;
  return n;
}

/** Manifest kept in the run directory: written at start, extended as phases freeze fits. */
export class Manifest {
  private data: Record<string, unknown>;
  constructor(
    private readonly path: string,
    initial: Record<string, unknown>,
  ) {
    this.data = { ...initial };
    this.save();
  }
  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.save();
  }
  freeze(phase: string, value: unknown): void {
    const frozen = (this.data.frozen as Record<string, unknown> | undefined) ?? {};
    this.data.frozen = {
      ...frozen,
      [phase]: { ...((value as object) ?? {}), frozenAt: new Date().toISOString() },
    };
    this.save();
  }
  get(): Readonly<Record<string, unknown>> {
    return this.data;
  }
  private save(): void {
    writeJson(this.path, this.data);
  }
}

/** USD this run's ledgers recorded, every row of every ledger in the run directory. */
export function ledgerSpend(dir: string): number {
  let total = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    for (const r of parseJsonlLedger(readFileSync(join(dir, f), "utf8"))) total += r.cost;
  }
  return total;
}
