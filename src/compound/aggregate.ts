import { argmax, clamp, effectiveN, logit, mean, normalize, sigmoid, softmaxLog } from "../math.ts";
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
 * How several verdicts become one. Which fits depends on what the members are, and for a
 * battery the choice is the gate's whole meaning:
 * - logodds: sum of log-odds, shrunk for correlation. For members that are evidence for one
 *   answer: replicas, framings or models asked the same question. Members that ask different
 *   questions are not that: in a disjunction one confident yes is outvoted by confident noes
 *   (a clear threat and a clear spam post both published at go above 0.998), and in a
 *   conjunction agreeing members drive the pool to the ends (37% of verdicts beyond 0.001 or
 *   0.999, a fitted bar of 0.99999991). The default, because changing it would move every
 *   existing gate's evidence.
 * - any: "does any of these apply?", the probability that at least one member's yes is true,
 *   1 - prod(1 - p) at independence (noisy-OR). For a battery of distinct risks.
 * - all: "do all of these hold?", prod(p) at independence (noisy-AND). For conjunctive
 *   requirements: numbers right, every item present, scope kept.
 * - max: the strongest yes wins, which is `any` at full correlation; min: the weakest, `all`
 *   at full correlation.
 * - majority: count votes. mean: average the probabilities.
 * - geomean: mean log-odds (log-odds with no accumulation); the fully correlated case.
 * A learned combiner (`fitLogistic`) fits the members' weights on labelled rows instead, and
 * beat every fixed pool on a conjunctive battery (ECE 0.036 against 0.198 for log-odds).
 * Soft pools tie or beat thresholding each sub-question and AND-ing the booleans, which lost
 * on 9 of 10 benchmarks in the "Just Ask Jev" study.
 */
export type PoolMethod =
  | "logodds"
  | "majority"
  | "mean"
  | "max"
  | "min"
  | "geomean"
  | "any"
  | "all";

/** Pairwise error correlation by member key, either order: what `memberCorrelation` measures. */
export type CorrelationMatrix = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface PoolOptions {
  /**
   * Pairwise error correlation among the pooled verdicts, 0..1. The pooled evidence is
   * shrunk by effectiveN(n, rho) / n so that n correlated voices do not masquerade as n
   * independent ones. Measure this from the ledger; do not guess it low. With `correlations`,
   * it is the value for any pair the matrix does not name. For `any` and `all` it moves the
   * pool from its independent value toward `max` or `min` (see `poolJudge`).
   */
  readonly correlation?: number;
  /**
   * Per-verdict reliability weights, default 1. For a voter with known accuracy p the
   * Nitzan-Paroush optimal weight is log(p / (1 - p)); see `reliabilityWeight`. For `any` and
   * `all` a weight is an exponent on the member's term, so 0 drops it; it must not be negative.
   */
  readonly weights?: readonly number[];
  /** logodds (default) treats calibrated probabilities as independent evidence; see `PoolMethod`. */
  readonly method?: PoolMethod;
  /**
   * Per-pair error correlation by member key (`memberCorrelation(...).matrix`), for log-odds
   * pooling of members that are not exchangeable. One scalar rho cannot pool a mixed ensemble:
   * with two near-duplicates and one independent member (pairs 0.58, -0.04, -0.04), pooling at
   * the mean 0.165 discounted the independent member as much as the duplicates and worsened
   * held-out log loss (0.095 to 0.102), where weights from the matrix improved Brier from 0.027
   * to 0.019. Each verdict is weighted by w = R^-1 1 (generalised least squares) kept
   * non-negative by dropping members the others account for and solving again, which with
   * every pair at one rho is exactly the scalar shrink; the evidence pooled is then worth
   * 1' R^-1 1 independent members, the generalised design effect, never more than the members
   * pooled, and the pool is never more confident than the same answers at rho 0. Needs
   * `memberKeys`. Changing
   * weights can change which answer wins, so adopting a matrix is a configuration change: bump
   * the gate's `evidenceVersion`.
   */
  readonly correlations?: CorrelationMatrix;
  /**
   * The member key of each pooled verdict, in order; required with `correlations`. `ensemble`
   * and `sequential` fill it from their members (a member sampled again keeps its key).
   */
  readonly memberKeys?: readonly string[];
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

/** Off-diagonal correlations are read in [0, 0.99], as the scalar path reads rho in [0, 1]. */
const MAX_RHO = 0.99;

/** Solve A x = b by Gaussian elimination with partial pivoting; undefined when singular. */
function solve(a: readonly (readonly number[])[], b: readonly number[]): number[] | undefined {
  const n = b.length;
  const m = a.map((row, i) => [...row.slice(0, n), b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[pivot]?.[c] ?? 0)) pivot = r;
    }
    const top = m[pivot] as number[];
    if (!(Math.abs(top[c] ?? 0) > 1e-9)) return undefined;
    [m[c], m[pivot]] = [top, m[c] as number[]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = m[r] as number[];
      const f = (row[c] ?? 0) / (top[c] ?? 1);
      if (f === 0) continue;
      for (let k = c; k <= n; k++) row[k] = (row[k] ?? 0) - f * (top[k] ?? 0);
    }
  }
  const x = m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
  return x.every(Number.isFinite) ? x : undefined;
}

/**
 * Non-negative generalised least squares weights by active set: solve R w = 1 over the members
 * still in play; while any weight is negative, drop the member with the most negative one and
 * solve again; when the system is singular, drop the member most correlated with the rest. A
 * negative GLS weight is a member the others already account for (a generalist whose errors
 * are the union of two specialists'); zeroing it without solving again left the others
 * weighted as if it still carried their shared evidence, and three answers pooled as 6, 15.5
 * or 30 independent ones. Every correlation is read in [0, 0.99], so a non-negative solution
 * has w_i = 1 - sum of r_ij w_j <= 1 for each member: no member counts more than once and the
 * pool is worth at most the members it reads, whether or not the measured matrix is positive
 * definite (one measured pair by pair on different rows need not be).
 */
function nonNegativeGls(r: readonly (readonly number[])[]): number[] {
  const n = r.length;
  let active = Array.from({ length: n }, (_, i) => i);
  for (;;) {
    const sub = active.map((i) => active.map((j) => r[i]?.[j] ?? 0));
    const w = solve(
      sub,
      active.map(() => 1),
    );
    let drop = -1;
    if (w === undefined) {
      // Singular: the member most correlated with the others adds nothing they do not.
      let most = -1;
      sub.forEach((row, k) => {
        const total = row.reduce((s, x, j) => s + (j === k ? 0 : x), 0);
        if (total > most) {
          most = total;
          drop = k;
        }
      });
    } else {
      for (let k = 0; k < w.length; k++) {
        if ((w[k] ?? 0) < -1e-12 && (drop < 0 || (w[k] ?? 0) < (w[drop] ?? 0))) drop = k;
      }
    }
    if (drop < 0 && w !== undefined) {
      const out = new Array<number>(n).fill(0);
      active.forEach((i, k) => {
        out[i] = clamp(w[k] ?? 0, 0, 1);
      });
      return out;
    }
    active = active.filter((_, k) => k !== drop);
    if (active.length === 0) return new Array<number>(n).fill(0);
  }
}

/**
 * The evidence weight of each pooled verdict and what the pool is worth in independent
 * members. Without a matrix every verdict weighs effectiveN(n, rho) / n, the design effect.
 * With one, the weights are the generalised least squares weights w = R^-1 1 over the members'
 * correlation matrix R (pairs the matrix does not name take `correlation`), constrained to be
 * non-negative (`nonNegativeGls`), and the pool is worth the sum of the weights, the
 * generalised design effect 1' R^-1 1: at most the member count, and no weight above 1.
 */
export function poolWeights(
  n: number,
  o: PoolOptions = {},
): { readonly weights: readonly number[]; readonly effectiveN: number } {
  if (o.correlations === undefined) {
    const k = shrink(n, o);
    return { weights: new Array<number>(n).fill(k), effectiveN: n * k };
  }
  const keys = o.memberKeys;
  if (keys === undefined || keys.length !== n) {
    throw new Error("correlations need memberKeys, one per pooled verdict");
  }
  const fallback = clamp(Number.isFinite(o.correlation) ? (o.correlation ?? 0) : 0, 0, MAX_RHO);
  const m = o.correlations;
  // Own properties only, so a member keyed "__proto__" or "constructor" reads as any other.
  const lookup = (a: string, b: string): number | undefined => {
    const row = Object.hasOwn(m, a) ? m[a] : undefined;
    const v = row !== undefined && Object.hasOwn(row, b) ? row[b] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const rho = (a: string, b: string): number => {
    // One member's answer twice is as correlated as two answers can be.
    if (a === b) return MAX_RHO;
    const v = lookup(a, b) ?? lookup(b, a);
    return v === undefined ? fallback : clamp(v, 0, MAX_RHO);
  };
  const r = keys.map((a, i) => keys.map((b, j) => (i === j ? 1 : rho(a, b))));
  const weights = nonNegativeGls(r);
  return {
    weights,
    effectiveN: Math.min(
      n,
      weights.reduce((s, x) => s + x, 0),
    ),
  };
}

/**
 * Scale pooled log-scores toward uniform until their leading probability is no higher than
 * `ceiling`: a matrix may say members are redundant, never that they carry more evidence than
 * the same answers pooled as independent ones (rho 0), so the matrix pool is never more
 * confident than that. With answers that disagree, dropping a member the others account for
 * could otherwise push the pool past it.
 */
function capConfidence(logs: readonly number[], ceiling: number): number[] {
  const lead = (t: number) => Math.max(...softmaxLog(logs.map((x) => x * t)));
  if (lead(1) <= ceiling) return softmaxLog(logs);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (lead(mid) <= ceiling) lo = mid;
    else hi = mid;
  }
  return softmaxLog(logs.map((x) => x * lo));
}

/**
 * `any` and `all` at independence and at full correlation, and between. At independence
 * `any` is 1 - prod(1 - p) and `all` is prod(p). At full correlation the members fire
 * together and the bounds are Frechet's: P(any) = max(p), P(all) = min(p). Between, the
 * strongest member's term (the largest p for any, the smallest for all) counts in full and
 * every other member's term is raised to the power 1 - rho, so the pool slides from the
 * independent value to the bound as the stated correlation rises, never past either.
 */
function poolLogical(
  ps: readonly number[],
  method: "any" | "all",
  w: readonly number[],
  rho: number,
): number {
  if (w.some((x) => !(x >= 0))) throw new Error(`"${method}" takes non-negative weights`);
  const r = clamp(rho, 0, 1);
  // any works on the complements: P(none) = prod(1 - p).
  const terms = ps.map((p) => clamp(method === "any" ? 1 - p : p, 1e-12, 1));
  let lead = 0;
  for (let i = 1; i < terms.length; i++) if ((terms[i] ?? 1) < (terms[lead] ?? 1)) lead = i;
  let log = 0;
  terms.forEach((t, i) => {
    log += (w[i] ?? 1) * (i === lead ? 1 : 1 - r) * Math.log(t);
  });
  const product = clamp(Math.exp(log), 0, 1);
  return method === "any" ? 1 - product : product;
}

const judgeOnly = (method: PoolMethod): never => {
  throw new Error(
    `"${method}" pools judge verdicts only: a pick or rate question has no "any of" or "all of" to take`,
  );
};

export function poolJudge(vs: readonly JudgeVerdict[], o: PoolOptions = {}): JudgeVerdict {
  if (vs.length === 0) throw new Error("nothing to pool");
  const q0 = vs[0] as JudgeVerdict;
  const ps = vs.map((v) => v.pYes);
  const method = o.method ?? "logodds";
  let pYes: number;
  if (method === "any" || method === "all") {
    pYes = poolLogical(ps, method, weightsFor(vs.length, o), o.correlation ?? 0);
  } else if (method === "mean") {
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
    if (o.correlations === undefined) {
      // Kept in this order so a pool without a matrix is the same float it always was.
      const sum = ps.reduce((acc, p, i) => acc + (w[i] ?? 1) * logit(p), 0);
      pYes = sigmoid(sum * shrink(vs.length, o));
    } else {
      const g = poolWeights(vs.length, o).weights;
      const z = ps.reduce((acc, p, i) => acc + (g[i] ?? 0) * (w[i] ?? 1) * logit(p), 0);
      // Never more confident than the same answers pooled as independent (see capConfidence).
      const independent = Math.abs(ps.reduce((acc, p, i) => acc + (w[i] ?? 1) * logit(p), 0));
      pYes = sigmoid(Math.sign(z) * Math.min(Math.abs(z), independent));
    }
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
  if (method === "any" || method === "all") return judgeOnly(method);
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
    const g = o.correlations === undefined ? undefined : poolWeights(vs.length, o).weights;
    const logOf = (v: PickVerdict<O>, opt: O) =>
      Math.log(Math.max(v.probabilities[opt] ?? 0, 1e-6));
    if (g === undefined) {
      probs = softmaxLog(
        q.options.map((opt) => k * vs.reduce((s, v, i) => s + (w[i] ?? 1) * logOf(v, opt), 0)),
      );
    } else {
      const independent = q.options.map((opt) =>
        vs.reduce((s, v, i) => s + (w[i] ?? 1) * logOf(v, opt), 0),
      );
      const logs = q.options.map((opt) =>
        vs.reduce((s, v, i) => s + (g[i] ?? 0) * (w[i] ?? 1) * logOf(v, opt), 0),
      );
      probs = capConfidence(logs, Math.max(...softmaxLog(independent)));
    }
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
  if (method === "any" || method === "all") return judgeOnly(method);
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
    const g = o.correlations === undefined ? undefined : poolWeights(vs.length, o).weights;
    const logOf = (v: RateVerdict, i: number) => Math.log(Math.max(v.probabilities[i] ?? 0, 1e-6));
    if (g === undefined) {
      probs = softmaxLog(
        Array.from(
          { length: n },
          (_, i) => k * vs.reduce((s, v, j) => s + (w[j] ?? 1) * logOf(v, i), 0),
        ),
      );
    } else {
      const independent = Array.from({ length: n }, (_, i) =>
        vs.reduce((s, v, j) => s + (w[j] ?? 1) * logOf(v, i), 0),
      );
      const logs = Array.from({ length: n }, (_, i) =>
        vs.reduce((s, v, j) => s + (g[j] ?? 0) * (w[j] ?? 1) * logOf(v, i), 0),
      );
      probs = capConfidence(logs, Math.max(...softmaxLog(independent)));
    }
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
