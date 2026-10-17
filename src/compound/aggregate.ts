import { argmax, effectiveN, logit, mean, normalize, sigmoid, softmaxLog } from "../math.ts";
import { judgeVerdictFrom, pickVerdictFrom, rateVerdictFrom } from "../questions.ts";
import type {
  JudgeVerdict,
  PickQuestion,
  PickVerdict,
  Question,
  RateQuestion,
  RateVerdict,
  Verdict,
} from "../types.ts";

/**
 * How several verdicts become one.
 * - logodds: sum of log-odds, shrunk for correlation (independent evidence).
 * - majority: count votes.
 * - mean: average the probabilities.
 * - max: "any fires"; the strongest yes wins. For a battery of risk signals.
 * - min: "all must hold"; the weakest yes wins. For conjunctive requirements.
 * - geomean: mean log-odds (log-odds with no accumulation); the fully correlated case.
 * Soft pools tie or beat thresholding each sub-question and AND-ing the booleans, which lost
 * on 9 of 10 benchmarks in the "Just Ask Jev" study.
 */
export type PoolMethod = "logodds" | "majority" | "mean" | "max" | "min" | "geomean";

export interface PoolOptions {
  /**
   * Pairwise error correlation among the pooled verdicts, 0..1. The pooled evidence is
   * shrunk by effectiveN(n, rho) / n so that n correlated voices do not masquerade as n
   * independent ones. Measure this from the ledger; do not guess it low.
   */
  readonly correlation?: number;
  /**
   * Per-verdict reliability weights, default 1. For a voter with known accuracy p the
   * Nitzan-Paroush optimal weight is log(p / (1 - p)); see `reliabilityWeight`.
   */
  readonly weights?: readonly number[];
  /** logodds (default) treats calibrated probabilities as independent evidence; majority counts votes; mean averages. */
  readonly method?: PoolMethod;
}

/** Nitzan-Paroush weight for a voter whose accuracy is p. */
export const reliabilityWeight = (accuracy: number): number => logit(accuracy);

function weightsFor(n: number, o: PoolOptions): number[] {
  const w = o.weights ?? Array.from({ length: n }, () => 1);
  if (w.length !== n) throw new Error("weights length must match verdict count");
  return w.slice();
}

function shrink(n: number, o: PoolOptions): number {
  return n === 0 ? 1 : effectiveN(n, o.correlation ?? 0) / n;
}

export function poolJudge(vs: readonly JudgeVerdict[], o: PoolOptions = {}): JudgeVerdict {
  if (vs.length === 0) throw new Error("nothing to pool");
  const q0 = vs[0] as JudgeVerdict;
  const ps = vs.map((v) => v.pYes);
  const method = o.method ?? "logodds";
  let pYes: number;
  if (method === "mean") {
    pYes = mean(ps);
  } else if (method === "max") {
    pYes = Math.max(...ps);
  } else if (method === "min") {
    pYes = Math.min(...ps);
  } else if (method === "geomean") {
    const w = weightsFor(vs.length, o);
    const wsum = w.reduce((a, b) => a + b, 0) || 1;
    pYes = sigmoid(ps.reduce((acc, p, i) => acc + (w[i] ?? 1) * logit(p), 0) / wsum);
  } else if (method === "majority") {
    const w = weightsFor(vs.length, o);
    let yes = 0;
    let total = 0;
    ps.forEach((p, i) => {
      const wi = w[i] ?? 1;
      total += wi;
      if (p > 0.5) yes += wi;
      else if (p === 0.5) yes += wi / 2;
    });
    pYes = total === 0 ? 0.5 : yes / total;
  } else {
    const w = weightsFor(vs.length, o);
    const sum = ps.reduce((acc, p, i) => acc + (w[i] ?? 1) * logit(p), 0);
    pYes = sigmoid(sum * shrink(vs.length, o));
  }
  return judgeVerdictFrom({ kind: "judge", id: q0.questionId, prompt: "" }, pYes);
}

export function poolPick<O extends string>(
  q: PickQuestion<O>,
  vs: readonly PickVerdict<O>[],
  o: PoolOptions = {},
): PickVerdict<O> {
  if (vs.length === 0) throw new Error("nothing to pool");
  const method = o.method ?? "logodds";
  const w = weightsFor(vs.length, o);
  let probs: number[];
  if (method === "mean") {
    probs = normalize(
      q.options.map((opt) =>
        vs.reduce((s, v, i) => s + (w[i] ?? 1) * (v.probabilities[opt] ?? 0), 0),
      ),
    );
  } else if (method === "majority") {
    probs = normalize(
      q.options.map((opt) => vs.reduce((s, v, i) => s + (v.choice === opt ? (w[i] ?? 1) : 0), 0)),
    );
  } else if (method === "max" || method === "min") {
    const agg = method === "max" ? Math.max : Math.min;
    probs = normalize(q.options.map((opt) => agg(...vs.map((v) => v.probabilities[opt] ?? 0))));
  } else if (method === "geomean") {
    const wsum = w.reduce((a, b) => a + b, 0) || 1;
    probs = softmaxLog(
      q.options.map(
        (opt) =>
          vs.reduce(
            (s, v, i) => s + (w[i] ?? 1) * Math.log(Math.max(v.probabilities[opt] ?? 0, 1e-6)),
            0,
          ) / wsum,
      ),
    );
  } else {
    // Product of experts: sum of weighted log-probabilities, shrunk for correlation, then softmax.
    const k = shrink(vs.length, o);
    const logs = q.options.map(
      (opt) =>
        k *
        vs.reduce(
          (s, v, i) => s + (w[i] ?? 1) * Math.log(Math.max(v.probabilities[opt] ?? 0, 1e-6)),
          0,
        ),
    );
    probs = softmaxLog(logs);
  }
  return pickVerdictFrom(q, probs);
}

export function poolRate(
  q: RateQuestion,
  vs: readonly RateVerdict[],
  o: PoolOptions = {},
): RateVerdict {
  if (vs.length === 0) throw new Error("nothing to pool");
  const method = o.method ?? "logodds";
  const w = weightsFor(vs.length, o);
  const n = q.levels.length;
  let probs: number[];
  if (method === "mean") {
    probs = normalize(
      Array.from({ length: n }, (_, i) =>
        vs.reduce((s, v, j) => s + (w[j] ?? 1) * (v.probabilities[i] ?? 0), 0),
      ),
    );
  } else if (method === "majority") {
    probs = normalize(
      q.levels.map((lvl) => vs.reduce((s, v, j) => s + (v.level === lvl ? (w[j] ?? 1) : 0), 0)),
    );
  } else if (method === "max" || method === "min") {
    const agg = method === "max" ? Math.max : Math.min;
    probs = normalize(
      Array.from({ length: n }, (_, i) => agg(...vs.map((v) => v.probabilities[i] ?? 0))),
    );
  } else if (method === "geomean") {
    const wsum = w.reduce((a, b) => a + b, 0) || 1;
    probs = softmaxLog(
      Array.from(
        { length: n },
        (_, i) =>
          vs.reduce(
            (s, v, j) => s + (w[j] ?? 1) * Math.log(Math.max(v.probabilities[i] ?? 0, 1e-6)),
            0,
          ) / wsum,
      ),
    );
  } else {
    const k = shrink(vs.length, o);
    const logs = Array.from(
      { length: n },
      (_, i) =>
        k *
        vs.reduce(
          (s, v, j) => s + (w[j] ?? 1) * Math.log(Math.max(v.probabilities[i] ?? 0, 1e-6)),
          0,
        ),
    );
    probs = softmaxLog(logs);
  }
  return rateVerdictFrom(q, probs);
}

/** Pool verdicts of one question. All verdicts must share the question's kind. */
export function pool(q: Question, vs: readonly Verdict[], o: PoolOptions = {}): Verdict {
  switch (q.kind) {
    case "judge":
      return poolJudge(
        vs.filter((v): v is JudgeVerdict => v.kind === "judge"),
        o,
      );
    case "pick":
      return poolPick(
        q,
        vs.filter((v): v is PickVerdict => v.kind === "pick"),
        o,
      );
    case "rate":
      return poolRate(
        q,
        vs.filter((v): v is RateVerdict => v.kind === "rate"),
        o,
      );
  }
}

function labelOf(v: Verdict): string {
  switch (v.kind) {
    case "judge":
      return v.pYes >= 0.5 ? "yes" : "no";
    case "pick":
      return v.choice;
    case "rate":
      return v.level;
  }
}

/**
 * Fraction of verdicts that agree with the plurality answer. Low agreement is the cheapest
 * available signal that an item is hard; self-consistency work shows it tracks error well.
 */
export function agreement(vs: readonly Verdict[]): number {
  if (vs.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const v of vs) {
    const l = labelOf(v);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const values = [...counts.values()];
  return (values[argmax(values)] ?? 0) / vs.length;
}
