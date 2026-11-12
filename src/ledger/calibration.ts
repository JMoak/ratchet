import type { CorrelationMatrix } from "../compound/aggregate.ts";
import { clamp, mean } from "../math.ts";
import type { Verdict } from "../types.ts";
import { type DecisionRecord, settledWithoutAnswer } from "./ledger.ts";
import { admits, type FitClass, type TrustFilter } from "./sources.ts";

/** One scored answer: how confident the oracle was, and whether it was right. */
export interface Scored {
  readonly confidence: number;
  readonly correct: boolean;
}

export interface ReliabilityBin {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly meanConfidence: number;
  readonly accuracy: number;
}

/** Brier score of the leading answer: mean squared gap between confidence and correctness. Lower is better. */
export function brier(items: readonly Scored[]): number {
  return mean(items.map((s) => (s.confidence - (s.correct ? 1 : 0)) ** 2));
}

/** Reliability diagram data over equal-width confidence bins. */
export function reliability(items: readonly Scored[], bins = 10): ReliabilityBin[] {
  const buckets: Scored[][] = Array.from({ length: bins }, () => []);
  for (const s of items) {
    const i = Math.min(bins - 1, Math.floor(clamp(s.confidence, 0, 1) * bins));
    buckets[i]?.push(s);
  }
  return buckets.map((b, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    n: b.length,
    meanConfidence: mean(b.map((s) => s.confidence)),
    accuracy: mean(b.map((s) => (s.correct ? 1 : 0))),
  }));
}

/**
 * Expected calibration error: the bin-weighted average gap between stated confidence and
 * observed accuracy. 0 is perfect. A calibrated oracle is what makes thresholds meaningful.
 */
export function ece(items: readonly Scored[], bins = 10): number {
  if (items.length === 0) return 0;
  return reliability(items, bins).reduce(
    (s, b) => s + (b.n / items.length) * Math.abs(b.meanConfidence - b.accuracy),
    0,
  );
}

export interface CoveragePoint {
  readonly threshold: number;
  /** Fraction of items with confidence at or above the threshold. */
  readonly coverage: number;
  /** Accuracy among those items. */
  readonly accuracy: number;
  readonly n: number;
}

/** Risk-coverage curve: for every distinct confidence, what accuracy you get by acting only above it. */
export function riskCoverage(items: readonly Scored[]): CoveragePoint[] {
  const sorted = items.slice().sort((a, b) => b.confidence - a.confidence);
  const out: CoveragePoint[] = [];
  let right = 0;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i] as Scored;
    if (s.correct) right++;
    const next = sorted[i + 1];
    if (next && next.confidence === s.confidence) continue;
    out.push({
      threshold: s.confidence,
      coverage: (i + 1) / sorted.length,
      accuracy: right / (i + 1),
      n: i + 1,
    });
  }
  return out;
}

export interface FittedThreshold {
  readonly threshold: number;
  /** Fraction of items at or above the bar: the share that would be decided automatically. */
  readonly coverage: number;
  /** Accuracy of the leading answer among the items at or above the bar. */
  readonly accuracy: number;
  /** Items at or above the bar. */
  readonly n: number;
  /** Recall mode: share of truly positive items that automation did not answer "no". */
  readonly recall?: number;
  /** Recall mode: share of automated "yes" answers that were truly yes. Absent when there were none. */
  readonly precision?: number;
  /** Recall mode: truly positive items in the fit set, the support behind `recall`. */
  readonly positives?: number;
}

/**
 * A scored judge answer that also knows the truth, which recall needs and accuracy does not.
 * `leanedYes` is the oracle's leading answer (pYes at or above 0.5).
 */
export interface ScoredTruth extends Scored {
  readonly truth: boolean;
  readonly leanedYes: boolean;
}

/**
 * What a fitted bar promises. "accuracy": the leading answer is right at least this often on
 * the items at or above the bar. "recall": items at or above the bar are decided by their
 * leading answer and the rest go to review, and at least this share of the truly positive
 * items survive (every reviewed positive is found; an automated positive is lost only when
 * the oracle answered "no"). Recall is the target for screening, where a missed include
 * costs far more than a wasted read.
 */
export type FitMode = "accuracy" | "recall";

export interface FitOptions {
  /**
   * Accept a bar only when the lower end of the two-sided Wilson interval of its accuracy (or
   * recall) at `confidence` clears the target: at 0.95, z 1.96, a one-sided 97.5% bound.
   */
  readonly conservative?: boolean;
  /** Confidence level of that lower bound. Default 0.95. */
  readonly confidence?: number;
  /** Default "accuracy". "recall" needs items from `scoredWithTruth`. */
  readonly mode?: FitMode;
  /**
   * Trust classes whose labels may fit the bar. Items arrive here already scored, so this is
   * read where they are scored: pass the same options to `scoredFromLedger` or
   * `scoredWithTruth`. Default `TRUSTED_SOURCES`: blind, census and unsourced labels. A
   * consequence label cannot be named; it never fits a bar.
   */
  readonly sources?: readonly FitClass[];
}

/**
 * The lowest confidence bar that still delivers the target accuracy on labelled history,
 * with at least `minSupport` items above it. This is the whole "learn to compound" loop in
 * one function: act automatically above the bar, review below it, re-fit as labels arrive.
 * Returns undefined when no bar reaches the target with enough support.
 *
 * With `mode: "recall"` the target is recall of the positive class instead (see `FitMode`),
 * `minSupport` counts truly positive items, and the result also carries recall, precision and
 * the positive count. Lowering the bar can only lose positives, so recall falls monotonically
 * as coverage grows and the lowest bar that holds the target is the one with the most work
 * saved, which is the systematic-review screening number ("work saved at 95% recall").
 */
export function fitThreshold(
  items: readonly Scored[],
  target: number,
  minSupport = 20,
  opts: FitOptions = {},
): FittedThreshold | undefined {
  if (opts.mode === "recall") return fitRecall(items, target, minSupport, opts);
  let best: FittedThreshold | undefined;
  for (const p of riskCoverage(items)) {
    const acc = opts.conservative
      ? wilsonLower(p.accuracy, p.n, opts.confidence ?? 0.95)
      : p.accuracy;
    if (p.n >= minSupport && acc >= target) best = p;
  }
  return best;
}

const isScoredTruth = (s: Scored): s is ScoredTruth =>
  typeof (s as Partial<ScoredTruth>).truth === "boolean" &&
  typeof (s as Partial<ScoredTruth>).leanedYes === "boolean";

function fitRecall(
  items: readonly Scored[],
  targetRecall: number,
  minSupport: number,
  opts: FitOptions,
): FittedThreshold | undefined {
  const truthful: ScoredTruth[] = [];
  for (const s of items) {
    if (!isScoredTruth(s)) {
      throw new TypeError(
        "fitThreshold recall mode needs truth and leanedYes; use scoredWithTruth",
      );
    }
    truthful.push(s);
  }
  const positives = truthful.filter((s) => s.truth).length;
  if (positives === 0 || positives < minSupport) return undefined;
  const sorted = truthful.slice().sort((a, b) => b.confidence - a.confidence);
  let best: FittedThreshold | undefined;
  let right = 0;
  let lost = 0;
  let saidYes = 0;
  let yesRight = 0;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i] as ScoredTruth;
    if (s.correct) right++;
    if (s.truth && !s.leanedYes) lost++;
    if (s.leanedYes) {
      saidYes++;
      if (s.truth) yesRight++;
    }
    const next = sorted[i + 1];
    if (next && next.confidence === s.confidence) continue;
    const recall = 1 - lost / positives;
    const bound = opts.conservative
      ? wilsonLower(recall, positives, opts.confidence ?? 0.95)
      : recall;
    // Recall only falls as the bar drops, so the first miss ends the search.
    if (bound < targetRecall) break;
    const n = i + 1;
    best = {
      threshold: s.confidence,
      coverage: n / sorted.length,
      accuracy: right / n,
      n,
      recall,
      ...(saidYes > 0 ? { precision: yesRight / saidYes } : {}),
      positives,
    };
  }
  return best;
}

/**
 * What one bar delivers on labelled history: the share of items at or above it, and the
 * accuracy of those items. Accuracy is 0 when nothing clears the bar; check `n`. This is the
 * readout for "act above 0.8 auto-applied 71% of invoices at zero errors".
 */
export function coverageAt(
  items: readonly Scored[],
  threshold: number,
): { readonly coverage: number; readonly accuracy: number; readonly n: number } {
  let n = 0;
  let right = 0;
  for (const s of items) {
    if (s.confidence < threshold) continue;
    n++;
    if (s.correct) right++;
  }
  return {
    coverage: items.length === 0 ? 0 : n / items.length,
    accuracy: n === 0 ? 0 : right / n,
    n,
  };
}

/**
 * Wilson score lower bound on a proportion: the lower end of the two-sided Wilson interval at
 * `confidence`, so at 0.95 (z 1.96) a one-sided 97.5% bound. With `conservative`, a bar is
 * accepted only when
 * the lower bound of its observed accuracy clears the target, so a promise of 98% rests on
 * enough rows to mean it rather than on a lucky point estimate.
 */
export function wilsonLower(p: number, n: number, confidence = 0.95): number {
  return wilsonInterval(p, n, confidence).lower;
}

/**
 * Wilson score interval on a proportion: `wilsonLower` and its upper end, on the same coarse
 * scale (z of 2.576 at 0.99 and above, 1.96 at 0.95 and above, else 1.645). Unlike the normal
 * approximation it stays inside [0, 1] and does not collapse to a point at 0 or n successes,
 * which is where a small labelled slice usually sits. With no rows it is the whole of [0, 1].
 */
export function wilsonInterval(
  p: number,
  n: number,
  confidence = 0.95,
): { readonly lower: number; readonly upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const z = confidence >= 0.99 ? 2.576 : confidence >= 0.95 ? 1.96 : 1.645;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, (centre - spread) / denom),
    upper: Math.min(1, (centre + spread) / denom),
  };
}

/** Which labelled rows a scorer reads: by the trust of the label's source, and by selection. */
export type ScoreOptions = TrustFilter & {
  /** Only rows the oracle's confidence did not select: shadow rows and blind audits. */
  readonly unselectedOnly?: boolean;
};

/**
 * Score actual labelled answers; code-only placeholders cannot calibrate an oracle. Only labels
 * whose source passes the trust filter are read: by default blind, census and unsourced ones,
 * the labels a bar may be fitted on.
 */
export function scoredFromLedger(
  records: readonly DecisionRecord[],
  opts: ScoreOptions = {},
): Scored[] {
  return records.flatMap((r) => {
    if (!r.outcome || r.failedOpen || settledWithoutAnswer(r)) return [];
    if (!admits(opts, r.outcome.source)) return [];
    if (opts.unselectedOnly && !unselectedRow(r)) return [];
    return [{ confidence: r.confidence, correct: r.outcome.correct }];
  });
}

/**
 * The attempt number a chain row carries (`chain:attempt:<n>`, the tag `runChain` writes beside
 * `chain` and `chain:step:<name>`), or undefined for a row outside a chain.
 */
export function chainAttempt(r: DecisionRecord): number | undefined {
  for (const t of Array.isArray(r.tags) ? r.tags : []) {
    const m = /^chain:attempt:(\d+)$/.exec(t);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * A retry exists only because an earlier attempt of the same step was held back, so the states
 * that reach a second attempt are chosen by the verifier's own earlier answers: a selected
 * sample, however the row was ruled. Measured on the verifier track, chain rows read as
 * unselected fitted a bar of 0.870 where held-out rows supported 0.48.
 */
const chainRetry = (r: DecisionRecord): boolean => (chainAttempt(r) ?? 1) >= 2;

const unselectedRow = (r: DecisionRecord): boolean =>
  (r.mode === "shadow" || r.tags.includes("audit")) && !chainRetry(r);

/**
 * Historical fit-source classification: shadow rows and blind audits, whose label (if any)
 * comes from a source the trust filter admits (by default blind, census and unsourced). Audits
 * are random only within the acted population; they cannot validate a lower bar. Shadow
 * labels must also be collected representatively. This predicate alone does not establish that.
 * A chain's retries (`chain:attempt:<n>` with n of 2 or more) are never unselected: only a
 * held-back earlier attempt sent their state back to the verifier.
 */
export const isUnselected = (r: DecisionRecord, filter: TrustFilter = {}): boolean =>
  unselectedRow(r) && admits(filter, r.outcome?.source);

/**
 * Label-free accuracy estimate: for a calibrated oracle, the mean stated confidence is the
 * expected accuracy (the idea behind NannyML's confidence-based performance estimation).
 * Compare it with observed accuracy on labelled rows; the gap is miscalibration.
 */
export function expectedAccuracy(records: readonly DecisionRecord[]): number | undefined {
  const live = records.filter((r) => !r.failedOpen && !settledWithoutAnswer(r));
  return live.length === 0 ? undefined : mean(live.map((r) => r.confidence));
}

/**
 * Score labelled rows on the act side: the probability that acting is right as the policy reads
 * it (a judge row's p(yes) or 1 - p(yes) by the side its policy acted on; a pick or rate row's
 * leading confidence), against whether acting was right (`actWasRight`). This is the scale an
 * `actAbove` is set on, so a bar fitted on it is the bar to act at. The leading-answer scale
 * (`scoredFromLedger`) also counts a confident "no" toward the promise, which on a judge gate
 * acting never makes: a verifier sure of its rejections and loose with its passes fitted 0.9
 * for 95% there and delivered 80% precision acting at it. Each row's side is read from its own
 * `go`; a row that cannot tell (an exact 0.5) takes `goIsYes`, default the gate's majority.
 * Rows a floor or bypass settled, failed-open rows and labels the trust filter refuses are
 * skipped, as in every fit.
 */
export function scoredForAct(
  records: readonly DecisionRecord[],
  opts: ScoreOptions & { readonly goIsYes?: boolean } = {},
): Scored[] {
  const fallback = opts.goIsYes ?? inferGoIsYes(records).goIsYes;
  return records.flatMap((r) => {
    if (!r.outcome || r.failedOpen || settledWithoutAnswer(r)) return [];
    if (!admits(opts, r.outcome.source)) return [];
    if (opts.unselectedOnly && !unselectedRow(r)) return [];
    const v = r.verdict;
    const goIsYes = recordedGoIsYes(r) ?? fallback;
    const right = actWasRight(r, goIsYes);
    if (right === undefined) return [];
    const go = v.kind === "judge" ? (goIsYes ? v.pYes : 1 - v.pYes) : r.confidence;
    return Number.isFinite(go) ? [{ confidence: go, correct: right }] : [];
  });
}

/** Score labelled judge rows by the yes-probability against the boolean truth. */
export function scoredForYes(records: readonly DecisionRecord[]): Scored[] {
  return records.flatMap((r) => {
    if (!r.outcome || r.failedOpen || settledWithoutAnswer(r) || r.verdict.kind !== "judge")
      return [];
    if (typeof r.outcome.truth !== "boolean") return [];
    return [{ confidence: r.verdict.pYes, correct: r.outcome.truth }];
  });
}

/**
 * Score labelled judge rows with their boolean truth and the oracle's leading answer, for
 * recall-mode fitting. Rows without a boolean truth, failed-open rows and non-judge rows are
 * skipped, as are code-only placeholders and labels the trust filter does not admit;
 * `correct` is the label as recorded.
 */
export function scoredWithTruth(
  records: readonly DecisionRecord[],
  opts: ScoreOptions = {},
): ScoredTruth[] {
  return records.flatMap((r) => {
    if (!r.outcome || r.failedOpen || settledWithoutAnswer(r) || r.verdict.kind !== "judge")
      return [];
    if (typeof r.outcome.truth !== "boolean" || !admits(opts, r.outcome.source)) return [];
    if (opts.unselectedOnly && !unselectedRow(r)) return [];
    return [
      {
        confidence: r.confidence,
        correct: r.outcome.correct,
        truth: r.outcome.truth,
        leanedYes: r.verdict.pYes >= 0.5,
      },
    ];
  });
}

/**
 * Which side of a judge question meant "go" when this row was ruled, read from the row's own
 * `go` (the policy stores the probability it acted on). Undefined when the row cannot tell:
 * not a judge, failed open, or an exact 0.5.
 */
export function recordedGoIsYes(r: DecisionRecord): boolean | undefined {
  if (r.verdict.kind !== "judge" || r.failedOpen) return undefined;
  const p = r.verdict.pYes;
  if (Math.abs(p - 0.5) < 1e-9) return undefined;
  if (Math.abs(r.go - p) < 1e-9) return true;
  if (Math.abs(r.go - (1 - p)) < 1e-9) return false;
  return undefined;
}

/** The polarity most rows of a gate were ruled with; "yes is go" when no row says. */
export function inferGoIsYes(rows: readonly DecisionRecord[]): {
  readonly goIsYes: boolean;
  readonly evidence: number;
} {
  let yes = 0;
  let no = 0;
  for (const r of rows) {
    const g = recordedGoIsYes(r);
    if (g === true) yes++;
    else if (g === false) no++;
  }
  return { goIsYes: yes >= no, evidence: yes + no };
}

/**
 * On a labelled row, would acting have been right? For pick and rate questions acting means
 * taking the leading answer, so it is the recorded `correct`. For judge questions acting means
 * taking the go side, which is the truth when it is recorded and otherwise follows from
 * whether the go side was the leading answer.
 */
export function actWasRight(r: DecisionRecord, goIsYes: boolean): boolean | undefined {
  const o = r.outcome;
  if (!o) return undefined;
  if (r.verdict.kind !== "judge") return o.correct;
  if (typeof o.truth === "boolean") return o.truth === goIsYes;
  const goLeads = r.verdict.pYes >= 0.5 === goIsYes;
  return goLeads ? o.correct : !o.correct;
}

/** Phi coefficient between two members' correctness on the same items: the error correlation to feed PoolOptions. */
export function errorCorrelation(
  pairs: readonly { readonly a: boolean; readonly b: boolean }[],
): number {
  let n11 = 0;
  let n10 = 0;
  let n01 = 0;
  let n00 = 0;
  for (const p of pairs) {
    if (p.a && p.b) n11++;
    else if (p.a) n10++;
    else if (p.b) n01++;
    else n00++;
  }
  const n1x = n11 + n10;
  const n0x = n01 + n00;
  const nx1 = n11 + n01;
  const nx0 = n10 + n00;
  const denom = Math.sqrt(n1x * n0x * nx1 * nx0);
  if (denom === 0) return 0;
  return clamp((n11 * n00 - n10 * n01) / denom, -1, 1);
}

/** Mean pairwise phi across members; rows are items, columns are members' correctness. */
export function pairwiseCorrelation(matrix: readonly (readonly boolean[])[]): number {
  const k = matrix[0]?.length ?? 0;
  if (k < 2) return 0;
  const vals: number[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      vals.push(
        errorCorrelation(matrix.map((row) => ({ a: row[i] ?? false, b: row[j] ?? false }))),
      );
    }
  }
  return mean(vals);
}

/**
 * Phi between two members' correctness, or undefined when either member's correctness did not
 * vary (it was right on every row read, or wrong on every one): then nothing about their error
 * correlation was observed. `errorCorrelation` reads that case as 0, which is independence,
 * the most optimistic rho there is.
 */
function phiOrUndefined(pairs: readonly (readonly [boolean, boolean])[]): number | undefined {
  const a = pairs.filter(([x]) => x).length;
  const b = pairs.filter(([, y]) => y).length;
  if (a === 0 || a === pairs.length || b === 0 || b === pairs.length) return undefined;
  return errorCorrelation(pairs.map(([x, y]) => ({ a: x, b: y })));
}

/** Phi between two members' correctness, over the rows on which both answered. */
export interface MemberPairCorrelation {
  /** The two member keys, in sorted order. */
  readonly keys: readonly [string, string];
  /**
   * Phi, absent when either member's correctness did not vary on the rows read: three replicas
   * that were never wrong say nothing about how their errors move together, and reading that as
   * 0 would pool them as three independent votes.
   */
  readonly correlation?: number;
  readonly n: number;
}

export interface MemberCorrelation {
  /** Every pair of member keys that answered together on at least one row read. */
  readonly pairs: readonly MemberPairCorrelation[];
  /**
   * Mean over the pairs with a correlation: the rho for `PoolOptions.correlation`. Right only
   * for exchangeable members (replicas, framings of one model); a mixed ensemble wants
   * `matrix`. Absent when no pair has one, rather than 0, which would read as independence.
   */
  readonly mean?: number;
  /** The pairs with a correlation, by member key in both orders: `PoolOptions.correlations`. */
  readonly matrix?: CorrelationMatrix;
  /**
   * Rows read: compound rows labelled with a truth, members recorded, not failed open; and
   * battery requests whose member rows carry a label with a boolean truth.
   */
  readonly n: number;
}

/** Was a member's answer right against a truth? Undefined when the two cannot be compared. */
function memberRight(v: Verdict, truth: string | boolean): boolean | undefined {
  if (v.kind === "judge") return typeof truth === "boolean" ? v.pYes >= 0.5 === truth : undefined;
  if (typeof truth !== "string") return undefined;
  return v.kind === "pick" ? v.choice === truth : v.level === truth;
}

/**
 * Each battery request's member correctness by question id, read from the member rows' own
 * labels: the battery's truth, or a member's own truth when the label gave one
 * (`Outcome.memberTruths`). A battery's members are rows of their own and its combined row
 * carries no `members`, so they pair by request.
 */
function batteryAnswers(
  rows: readonly DecisionRecord[],
  opts: ScoreOptions,
): Map<string, boolean>[] {
  const key = (r: DecisionRecord) => `${r.gateId}\u0000${r.requestId}`;
  const batteries = new Set(rows.filter((r) => r.combined === true).map(key));
  const byRequest = new Map<string, Map<string, boolean>>();
  for (const r of rows) {
    if (r.combined === true || !batteries.has(key(r)) || r.failedOpen) continue;
    const truth = r.outcome?.truth;
    if (typeof truth !== "boolean" || r.verdict.kind !== "judge") continue;
    if (!admits(opts, r.outcome?.source) || (opts.unselectedOnly && !unselectedRow(r))) continue;
    let correct = byRequest.get(key(r));
    if (!correct) {
      correct = new Map();
      byRequest.set(key(r), correct);
    }
    if (!correct.has(r.questionId)) correct.set(r.questionId, r.verdict.pYes >= 0.5 === truth);
  }
  return [...byRequest.values()];
}

/**
 * Member error correlation measured from the ledger: pairwise phi between members'
 * correctness, paired by member key so a tier a cascade did not reach, or a member added
 * later, never misaligns the columns. A compound row's members (ensemble, cascade, sequential)
 * are scored by their own leading answer against the row's truth: p(yes) against a boolean
 * truth, a pick's choice or a rate's level against a string one. A battery's members are rows
 * of their own, paired by request and keyed by question id, each scored by its own label (the
 * battery's truth unless the label gave the member its own, `Outcome.memberTruths`; without
 * member truths, the members of an any/all battery are scored against the composite, which is
 * not their question, and their phi says little). A failed-open answer has no lean and is
 * skipped. This is the number the design effect needs in place of a guessed rho. A pair whose
 * members did not both vary has no phi, and `mean` reads only the pairs that have one. Labels
 * pass the trust filter as in every fit. Pass `unselectedOnly` when labels come from reviewing
 * the unsure: rows chosen on the pooled confidence are chosen on both members at once, and that
 * selection alone moves phi (Berkson's paradox).
 */
export function memberCorrelation(
  rows: readonly DecisionRecord[],
  opts: ScoreOptions = {},
): MemberCorrelation {
  const answered: Map<string, boolean>[] = [];
  for (const r of rows) {
    const truth = r.outcome?.truth;
    if (truth === undefined || !r.members || r.failedOpen) continue;
    if (!admits(opts, r.outcome?.source) || (opts.unselectedOnly && !unselectedRow(r))) continue;
    const correct = new Map<string, boolean>();
    for (const m of r.members) {
      if (m.failedOpen || m.verdict.kind !== r.verdict.kind || correct.has(m.key)) continue;
      const right = memberRight(m.verdict, truth);
      if (right !== undefined) correct.set(m.key, right);
    }
    if (correct.size > 0) answered.push(correct);
  }
  answered.push(...batteryAnswers(rows, opts));
  const keys = [...new Set(answered.flatMap((c) => [...c.keys()]))].sort();
  const pairs: MemberPairCorrelation[] = [];
  const byKey = new Map<string, Map<string, number>>();
  const put = (a: string, b: string, phi: number) => {
    const row = byKey.get(a) ?? new Map<string, number>();
    row.set(b, phi);
    byKey.set(a, row);
  };
  for (const [i, a] of keys.entries()) {
    for (const b of keys.slice(i + 1)) {
      const both = answered.flatMap((c): [boolean, boolean][] => {
        const x = c.get(a);
        const y = c.get(b);
        return x === undefined || y === undefined ? [] : [[x, y]];
      });
      if (both.length === 0) continue;
      const phi = phiOrUndefined(both);
      pairs.push({
        keys: [a, b],
        ...(phi !== undefined ? { correlation: phi } : {}),
        n: both.length,
      });
      if (phi !== undefined) {
        put(a, b, phi);
        put(b, a, phi);
      }
    }
  }
  const measured = pairs.flatMap((p) => (p.correlation === undefined ? [] : [p.correlation]));
  // Built from entries, so a member keyed "__proto__" is a key like any other.
  const matrix: CorrelationMatrix = Object.fromEntries(
    [...byKey].map(([k, row]) => [k, Object.fromEntries(row)]),
  );
  return {
    pairs,
    ...(measured.length > 0 ? { mean: mean(measured), matrix } : {}),
    n: answered.length,
  };
}

/**
 * A model's family: the first token of its name, compared without case. The owner prefix (the
 * part before the last "/") is dropped, and so is a leading name token that repeats the owner
 * ("meta-llama/Meta-Llama-3.1-70B" is "llama"); a revision tag after "@" or ":" goes, the name
 * splits on anything not a letter or digit, and a version glued to the first token is cut
 * ("jev113" is "jev", "qwen2.5" is "qwen"). So "typesafe/jev-1.13", "jev-1.13", "jev113.para"
 * and "typesafe/jev-router" are all "jev"; "anthropic/claude-sonnet-4.5", "claude-sonnet-4-5"
 * and "claude-3-5-sonnet" are all "claude"; "openai/gpt-4o" and "gpt-4o" are "gpt". Haiku and
 * Jev, GPT and Claude stay apart.
 *
 * Families are deliberately coarse. A family decides when two answers count as one voice (a
 * second opinion refused, a correlation defaulted, a lead counted once), and a false merge only
 * adds caution there while a false split removes it: two spellings of one model read as two
 * families pooled as independent and acted where one voice would have been reviewed, and
 * jev-1.13 and jev-1.14 shared 89% of their errors (phi 0.785). Two tiers of one vendor's line
 * are one family here; pass member correlations measured from the ledger to tell them apart.
 * A family no id shows (two vendors serving one model under different names) is the caller's
 * to know. Strategies read voter identity through it, so its spelling of a family is stable.
 */
export function modelFamily(model: string): string {
  const id = model.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  const owner = new Set(
    id
      .slice(0, Math.max(slash, 0))
      .split(/[^a-z0-9]+/)
      .filter((x) => x !== ""),
  );
  const tokens = id
    .slice(slash + 1)
    .replace(/[@:].*$/, "")
    .split(/[^a-z0-9]+/)
    .filter((x) => x !== "");
  // Drop leading tokens that repeat the owner, while a name token follows them.
  let i = 0;
  while (
    i < tokens.length - 1 &&
    owner.has(tokens[i] ?? "") &&
    /^[a-z]/.test(tokens[i + 1] ?? "")
  ) {
    i++;
  }
  const first = tokens[i];
  if (first === undefined) return id;
  // A version glued to the name: greedy on the letters, so "jev113" is "jev", not "je".
  return first.replace(/^([a-z]{2,})\d+$/, "$1");
}

/** The leading answer of a verdict, as a string a disagreement can compare. */
const leadingAnswer = (v: Verdict): string =>
  v.kind === "judge" ? (v.pYes >= 0.5 ? "yes" : "no") : v.kind === "pick" ? v.choice : v.level;

export interface Disagreement {
  /** Ready to pass to `gradeOf` as `borrowed`. */
  readonly via: {
    readonly type: "disagreement";
    readonly rate: number;
    readonly pairs: number;
    readonly models: readonly [string, string];
  };
  /** The two member keys compared. */
  readonly keys: readonly [string, string];
  /** The newest paired row's `at`: pass it to `gradeOf` as `borrowedAt`. */
  readonly at: string;
}

/**
 * How often two members from different model families gave different leading answers, over the
 * compound rows on which both answered (labels are not read). On each such row at least one of
 * the two is wrong, so the rate bounds from below the share of rows on which at least one judge
 * is wrong, whatever their correlation; it is not the gate's error rate, which can be 0 while
 * the second opinion is wrong on every disagreement. `keys` names the two members; without it
 * the two most often recorded member keys whose models are of different families are taken.
 * Undefined when no such pair answered together, or when the two share a family
 * (`modelFamily`).
 */
export function disagreement(
  rows: readonly DecisionRecord[],
  opts: { readonly keys?: readonly [string, string] } = {},
): Disagreement | undefined {
  const seen = new Map<string, { n: number; model: string }>();
  for (const r of rows) {
    for (const m of r.members ?? []) {
      if (m.failedOpen || m.model === undefined) continue;
      const s = seen.get(m.key);
      if (s) s.n++;
      else seen.set(m.key, { n: 1, model: m.model });
    }
  }
  const ranked = [...seen.entries()].sort((x, y) => y[1].n - x[1].n);
  let keys = opts.keys;
  if (keys === undefined) {
    for (const [i, [a, x]] of ranked.entries()) {
      const partner = ranked
        .slice(i + 1)
        .find(([, y]) => modelFamily(y.model) !== modelFamily(x.model));
      if (partner) {
        keys = [a, partner[0]];
        break;
      }
    }
  }
  if (keys === undefined) return undefined;
  const [ka, kb] = keys;
  const a = seen.get(ka);
  const b = seen.get(kb);
  if (!a || !b || modelFamily(a.model) === modelFamily(b.model)) return undefined;
  let pairs = 0;
  let differ = 0;
  let at = "";
  for (const r of rows) {
    if (r.failedOpen) continue;
    const ma = r.members?.find((m) => m.key === ka && !m.failedOpen);
    const mb = r.members?.find((m) => m.key === kb && !m.failedOpen);
    if (!ma || !mb) continue;
    pairs++;
    if (leadingAnswer(ma.verdict) !== leadingAnswer(mb.verdict)) differ++;
    if (r.at > at) at = r.at;
  }
  if (pairs === 0) return undefined;
  return {
    via: { type: "disagreement", rate: differ / pairs, pairs, models: [a.model, b.model] },
    keys: [ka, kb],
    at,
  };
}

/** In shadow mode: how often the engine's soft action matched what the application actually did. */
export function shadowAgreement(records: readonly DecisionRecord[]): number {
  const shadow = records.filter((r) => r.mode === "shadow");
  if (shadow.length === 0) return 0;
  return shadow.filter((r) => r.soft === r.action).length / shadow.length;
}

/** A monotone map from stated confidence to observed accuracy, fitted on labelled rows. */
export interface Calibrator {
  /** Calibrated probability that an answer stated with this confidence is right. */
  readonly apply: (confidence: number) => number;
  /** The fitted step blocks, lowest confidence first. */
  readonly blocks: readonly {
    readonly lo: number;
    readonly hi: number;
    readonly p: number;
    readonly n: number;
  }[];
}

/**
 * Isotonic regression by pool-adjacent-violators: the non-decreasing step function of
 * confidence that best fits observed correctness. Distribution-free, needs no parametric
 * assumption, and on decision-model outputs it has beaten Platt scaling by a wide margin
 * (ECE 0.117 to 0.008 versus 0.052 in one study). Fit it on unselected rows only, and refit
 * when the model version moves. Returns undefined below `minSupport` rows. Like every fit
 * here it maps confidence to observed correctness, never to another model's answer.
 */
export function fitIsotonic(items: readonly Scored[], minSupport = 30): Calibrator | undefined {
  if (items.length < minSupport) return undefined;
  const sorted = items.slice().sort((a, b) => a.confidence - b.confidence);
  type Block = { lo: number; hi: number; sum: number; n: number };
  const blocks: Block[] = [];
  for (let i = 0; i < sorted.length; ) {
    const s = sorted[i] as Scored;
    const block: Block = { lo: s.confidence, hi: s.confidence, sum: 0, n: 0 };
    // Equal inputs must share one fitted value before enforcing monotonicity (weighted PAV).
    do {
      block.sum += sorted[i]?.correct ? 1 : 0;
      block.n++;
      i++;
    } while (i < sorted.length && sorted[i]?.confidence === s.confidence);
    blocks.push(block);
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1] as Block;
      const a = blocks[blocks.length - 2] as Block;
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { lo: a.lo, hi: b.hi, sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  const steps = blocks.map((b) => ({ lo: b.lo, hi: b.hi, p: b.sum / b.n, n: b.n }));
  const apply = (confidence: number): number => {
    const first = steps[0];
    const last = steps[steps.length - 1];
    if (!first || !last) return confidence;
    if (confidence <= first.hi) return first.p;
    if (confidence >= last.lo) return last.p;
    for (let i = 0; i < steps.length - 1; i++) {
      const cur = steps[i] as (typeof steps)[number];
      const next = steps[i + 1] as (typeof steps)[number];
      if (confidence <= cur.hi) return cur.p;
      if (confidence < next.lo) {
        // Interpolate across the gap between two blocks.
        const t = (confidence - cur.hi) / Math.max(next.lo - cur.hi, 1e-9);
        return cur.p + t * (next.p - cur.p);
      }
    }
    return last.p;
  };
  return { apply, blocks: steps };
}

export interface CostFit {
  readonly threshold: number;
  /** Mean cost per item on all rows at the fitted threshold. */
  readonly cost: number;
  /** Mean cost per item at the Bayes threshold costWrongAct / (costWrongAct + costWrongHold). */
  readonly baselineCost: number;
  readonly baselineThreshold: number;
  /** True when the fitted bar beat the baseline on the full set and on held-out folds. */
  readonly accepted: boolean;
  readonly coverage: number;
  readonly n: number;
}

function meanCost(
  items: readonly Scored[],
  threshold: number,
  costWrongAct: number,
  costWrongHold: number,
): number {
  if (items.length === 0) return 0;
  let total = 0;
  for (const s of items) {
    if (s.confidence >= threshold) total += s.correct ? 0 : costWrongAct;
    else if (s.correct) total += costWrongHold;
  }
  return total / items.length;
}

/**
 * Fit the act bar that minimises expected cost on labelled rows, and accept it only if it
 * beats the Bayes bar both on the full set and on the sum of held-out folds (the acceptance
 * rule DSPy's ReAnchor uses). Candidates are midpoints between observed confidences, thinned
 * to at most `maxCandidates`. With a calibrated oracle the fitted bar lands near the Bayes
 * bar; with a miscalibrated one it moves to where the oracle's confidence actually earns it.
 */
export function fitThresholdByCost(
  items: readonly Scored[],
  costWrongAct: number,
  costWrongHold: number,
  opts: {
    readonly folds?: number;
    readonly maxCandidates?: number;
    readonly minSupport?: number;
  } = {},
): CostFit | undefined {
  const minSupport = opts.minSupport ?? 30;
  if (items.length < minSupport) return undefined;
  const folds = Math.max(2, opts.folds ?? 5);
  const maxCandidates = Math.max(2, opts.maxCandidates ?? 40);
  const d = costWrongAct + costWrongHold;
  const baselineThreshold = d === 0 ? 0.5 : costWrongAct / d;
  const sorted = [...new Set(items.map((s) => s.confidence))].sort((a, b) => a - b);
  const mids: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    mids.push(((sorted[i] as number) + (sorted[i + 1] as number)) / 2);
  }
  const step = Math.max(1, Math.ceil(mids.length / maxCandidates));
  const candidates = [baselineThreshold, 0, 1.000001, ...mids.filter((_, i) => i % step === 0)];
  const evalAt = (t: number) => meanCost(items, t, costWrongAct, costWrongHold);
  const baselineCost = evalAt(baselineThreshold);
  let best = baselineThreshold;
  let bestCost = baselineCost;
  for (const t of candidates) {
    const c = evalAt(t);
    if (c < bestCost - 1e-12) {
      best = t;
      bestCost = c;
    }
  }
  // Held-out check: refit on each training fold, score on its held-out fold, sum.
  let heldFitted = 0;
  let heldBaseline = 0;
  for (let f = 0; f < folds; f++) {
    const train = items.filter((_, i) => i % folds !== f);
    const test = items.filter((_, i) => i % folds === f);
    let tBest = baselineThreshold;
    let cBest = meanCost(train, baselineThreshold, costWrongAct, costWrongHold);
    for (const t of candidates) {
      const c = meanCost(train, t, costWrongAct, costWrongHold);
      if (c < cBest - 1e-12) {
        tBest = t;
        cBest = c;
      }
    }
    heldFitted += meanCost(test, tBest, costWrongAct, costWrongHold) * test.length;
    heldBaseline += meanCost(test, baselineThreshold, costWrongAct, costWrongHold) * test.length;
  }
  const accepted = bestCost < baselineCost - 1e-12 && heldFitted < heldBaseline - 1e-12;
  const threshold = accepted ? best : baselineThreshold;
  return {
    threshold,
    cost: accepted ? bestCost : baselineCost,
    baselineCost,
    baselineThreshold,
    accepted,
    coverage: items.filter((s) => s.confidence >= threshold).length / items.length,
    n: items.length,
  };
}
