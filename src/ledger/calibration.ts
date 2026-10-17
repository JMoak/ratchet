import { clamp, mean } from "../math.ts";
import type { DecisionRecord } from "./ledger.ts";

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
  /** Accept a bar only when the Wilson lower bound of its accuracy (or recall) clears the target. */
  readonly conservative?: boolean;
  /** Confidence level of that lower bound. Default 0.95. */
  readonly confidence?: number;
  /** Default "accuracy". "recall" needs items from `scoredWithTruth`. */
  readonly mode?: FitMode;
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
 * Wilson score lower bound on a proportion. With `conservative`, a bar is accepted only when
 * the lower bound of its observed accuracy clears the target, so a promise of 98% rests on
 * enough rows to mean it rather than on a lucky point estimate.
 */
export function wilsonLower(p: number, n: number, confidence = 0.95): number {
  if (n === 0) return 0;
  const z = confidence >= 0.99 ? 2.576 : confidence >= 0.95 ? 1.96 : 1.645;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / denom);
}

/** Score labelled ledger rows by the verdict's own confidence. */
export function scoredFromLedger(
  records: readonly DecisionRecord[],
  opts: { readonly unselectedOnly?: boolean } = {},
): Scored[] {
  return records.flatMap((r) => {
    if (!r.outcome || r.failedOpen) return [];
    if (opts.unselectedOnly && !isUnselected(r)) return [];
    return [{ confidence: r.confidence, correct: r.outcome.correct }];
  });
}

/**
 * Rows whose presence in the labelled set did not depend on the oracle's confidence:
 * shadow rows (nothing acted) and blind audits (acts diverted to review at random).
 * Fitting thresholds on anything else lets the engine grade its own homework.
 */
export const isUnselected = (r: DecisionRecord): boolean =>
  r.mode === "shadow" || r.tags.includes("audit");

/**
 * Label-free accuracy estimate: for a calibrated oracle, the mean stated confidence is the
 * expected accuracy (the idea behind NannyML's confidence-based performance estimation).
 * Compare it with observed accuracy on labelled rows; the gap is miscalibration.
 */
export function expectedAccuracy(records: readonly DecisionRecord[]): number | undefined {
  const live = records.filter((r) => !r.failedOpen);
  return live.length === 0 ? undefined : mean(live.map((r) => r.confidence));
}

/** Score labelled judge rows by the yes-probability against the boolean truth. */
export function scoredForYes(records: readonly DecisionRecord[]): Scored[] {
  return records.flatMap((r) => {
    if (!r.outcome || r.failedOpen || r.verdict.kind !== "judge") return [];
    if (typeof r.outcome.truth !== "boolean") return [];
    return [{ confidence: r.verdict.pYes, correct: r.outcome.truth }];
  });
}

/**
 * Score labelled judge rows with their boolean truth and the oracle's leading answer, for
 * recall-mode fitting. Rows without a boolean truth, failed-open rows and non-judge rows are
 * skipped; `correct` is the label as recorded.
 */
export function scoredWithTruth(
  records: readonly DecisionRecord[],
  opts: { readonly unselectedOnly?: boolean } = {},
): ScoredTruth[] {
  return records.flatMap((r) => {
    if (!r.outcome || r.failedOpen || r.verdict.kind !== "judge") return [];
    if (typeof r.outcome.truth !== "boolean") return [];
    if (opts.unselectedOnly && !isUnselected(r)) return [];
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
 * when the model version moves. Returns undefined below `minSupport` rows.
 */
export function fitIsotonic(items: readonly Scored[], minSupport = 30): Calibrator | undefined {
  if (items.length < minSupport) return undefined;
  const sorted = items.slice().sort((a, b) => a.confidence - b.confidence);
  type Block = { lo: number; hi: number; sum: number; n: number };
  const blocks: Block[] = [];
  for (const s of sorted) {
    blocks.push({ lo: s.confidence, hi: s.confidence, sum: s.correct ? 1 : 0, n: 1 });
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
    else total += costWrongHold;
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
