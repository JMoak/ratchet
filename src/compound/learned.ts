import { clamp, logit, sigmoid } from "../math.ts";
import type { JudgeVerdict } from "../types.ts";
import { poolJudge } from "./aggregate.ts";

/**
 * Learned composition: treat a battery of judge answers as features and fit the pooling
 * weights on labelled outcomes. Where a single verdict question scored 62.6%, five signal
 * questions plus a logistic regression scored 95% on the same phishing task; TypeSafe's own
 * feature-discovery cookbook does the same with a tree model. This is the smallest version:
 * L2-regularised logistic regression on the log-odds of each member, no dependencies. Fit on
 * unselected rows and refit when the model version moves.
 * The target is always the labelled outcome, never a member's answer: fitting to reproduce a
 * provider's verdicts would be distillation, which its terms forbid (docs/third-party-terms.md).
 */
export interface LogisticModel {
  readonly weights: readonly number[];
  readonly bias: number;
}

/** A fitted model and how the fit ended, so a caller can see that it converged. */
export interface LogisticFit extends LogisticModel {
  /** Mean log loss on the rows fitted, plus the L2 penalty: what the fit minimised. */
  readonly loss: number;
  /**
   * True when the fit found the minimum: the largest gradient component fell below `tolerance`
   * within the cap, on rows where a finite minimum exists. False, with `reason`, otherwise.
   */
  readonly converged: boolean;
  /** Newton steps taken. */
  readonly iterations: number;
  /**
   * Why the fit did not converge. "one class": every row has one label, so the loss falls
   * forever as the bias grows; the bias is the smoothed log-odds of that class instead (a fit
   * that kept going reached a bias of 19.2, p(yes) 1 for anything). "separable": with `l2` 0
   * some weights separate the rows perfectly, so no finite minimum exists and the weights
   * stop wherever the tolerance is met; set `l2` above 0. "iteration cap": the cap came first.
   * "no descent": no step along the Newton direction lowered the loss.
   */
  readonly reason?: "one class" | "separable" | "iteration cap" | "no descent";
}

export interface LogisticOptions {
  /** Most Newton steps to take. Default 100; a handful of features converges in about ten. */
  readonly iterations?: number;
  /**
   * Ignored: kept so older callers still compile. The fit takes Newton steps, which need no
   * learning rate; the gradient descent it replaced (400 steps at 0.1) stopped at a log loss
   * of 0.241 where convergence reaches 0.046, and its held-out battery read 101 of 108 right at
   * ECE 0.157 where the converged fit read 107 at 0.020.
   */
  readonly learningRate?: number;
  /** L2 penalty on the weights (not the bias), per row. Default 0.01. */
  readonly l2?: number;
  /** Stop when every gradient component is below this. Default 1e-8. */
  readonly tolerance?: number;
}

/** Penalised mean log loss of weights `w` and bias `b` (the bias unpenalised). */
function lossOf(
  rows: readonly { readonly x: readonly number[]; readonly y: boolean }[],
  w: readonly number[],
  b: number,
  l2: number,
): number {
  let total = 0;
  for (const r of rows) {
    let z = b;
    for (let j = 0; j < w.length; j++) z += (w[j] ?? 0) * (r.x[j] ?? 0);
    // log(1 + e^z) - y z, computed without overflow.
    total += Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - (r.y ? z : 0);
  }
  return total / rows.length + (l2 / 2) * w.reduce((s, v) => s + v * v, 0);
}

/** Solve A x = g by Gaussian elimination with partial pivoting; undefined when A is singular. */
function solve(a: number[][], g: number[]): number[] | undefined {
  const n = g.length;
  const m = a.map((row, i) => [...row, g[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[pivot]?.[c] ?? 0)) pivot = r;
    }
    const top = m[pivot] as number[];
    if (Math.abs(top[c] ?? 0) < 1e-14) return undefined;
    [m[c], m[pivot]] = [top, m[c] as number[]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = m[r] as number[];
      const f = (row[c] ?? 0) / (top[c] ?? 1);
      if (f === 0) continue;
      for (let k = c; k <= n; k++) row[k] = (row[k] ?? 0) - f * (top[k] ?? 0);
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

/**
 * Fit an L2-regularised logistic regression by Newton's method (iteratively reweighted least
 * squares) with a backtracking line search, so every step lowers the penalised loss. The
 * penalty makes the loss strictly convex in the weights, so the fit converges even on
 * separable rows; it stops when the largest gradient component is below `tolerance`, or after
 * `iterations` steps, and says which. On a battery of a handful of members it converges in
 * about ten steps.
 */
export function fitLogistic(
  rows: readonly { readonly x: readonly number[]; readonly y: boolean }[],
  opts: LogisticOptions = {},
): LogisticFit {
  const n = rows.length;
  if (n === 0) throw new Error("fitLogistic needs rows");
  const d = rows[0]?.x.length ?? 0;
  const cap = opts.iterations ?? 100;
  const l2 = opts.l2 ?? 0.01;
  const tolerance = opts.tolerance ?? 1e-8;
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error("iterations must be a whole number");
  if (!(l2 >= 0)) throw new Error("l2 must not be negative");
  const yes = rows.filter((r) => r.y).length;
  if (yes === 0 || yes === n) {
    // One class: no finite minimum; the class frequency, smoothed by half a row each way.
    const weights = new Array<number>(d).fill(0);
    const bias = Math.log((yes + 0.5) / (n - yes + 0.5));
    return {
      weights,
      bias,
      loss: lossOf(rows, weights, bias, l2),
      converged: false,
      iterations: 0,
      reason: "one class",
    };
  }
  // Parameters: weights 0..d-1, then the bias at d.
  let theta = new Array<number>(d + 1).fill(0);
  const split = (t: readonly number[]) => ({ w: t.slice(0, d), b: t[d] ?? 0 });
  let { w, b } = split(theta);
  let loss = lossOf(rows, w, b, l2);
  let converged = false;
  let reason: LogisticFit["reason"];
  let iterations = 0;
  for (; iterations <= cap; iterations++) {
    const grad = new Array<number>(d + 1).fill(0);
    const hess = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
    for (const r of rows) {
      let z = b;
      for (let j = 0; j < d; j++) z += (w[j] ?? 0) * (r.x[j] ?? 0);
      const p = sigmoid(z);
      const err = p - (r.y ? 1 : 0);
      const s = p * (1 - p);
      const xs = [...r.x.slice(0, d), 1];
      for (let i = 0; i <= d; i++) {
        const xi = xs[i] ?? 0;
        grad[i] = (grad[i] ?? 0) + (err * xi) / n;
        const hi = hess[i] as number[];
        for (let j = 0; j <= i; j++) hi[j] = (hi[j] ?? 0) + (s * xi * (xs[j] ?? 0)) / n;
      }
    }
    for (let i = 0; i <= d; i++) {
      const hi = hess[i] as number[];
      for (let j = 0; j < i; j++) (hess[j] as number[])[i] = hi[j] ?? 0;
      if (i < d) {
        grad[i] = (grad[i] ?? 0) + l2 * (w[i] ?? 0);
        hi[i] = (hi[i] ?? 0) + l2;
      }
    }
    if (Math.max(...grad.map(Math.abs)) < tolerance) {
      converged = true;
      break;
    }
    if (iterations === cap) {
      reason = "iteration cap";
      break;
    }
    // A tiny ridge keeps the step defined when a feature never varies.
    for (let i = 0; i <= d; i++) (hess[i] as number[])[i] = (hess[i]?.[i] ?? 0) + 1e-12;
    const step = solve(hess, grad);
    if (step === undefined) {
      reason = "no descent";
      break;
    }
    let t = 1;
    let next = theta;
    let nextLoss = loss;
    for (let k = 0; k < 40; k++) {
      next = theta.map((v, i) => v - t * (step[i] ?? 0));
      const s = split(next);
      nextLoss = lossOf(rows, s.w, s.b, l2);
      if (nextLoss <= loss) break;
      t /= 2;
    }
    if (!(nextLoss <= loss)) {
      reason = "no descent";
      break;
    }
    theta = next;
    ({ w, b } = split(theta));
    const moved = loss - nextLoss;
    loss = nextLoss;
    // A step that no longer moves the loss at all has nothing left to find.
    if (moved === 0) {
      converged = true;
      break;
    }
  }
  // Without a penalty, rows some weights classify perfectly have no finite minimum: the
  // gradient reaches the tolerance only because the loss is nearly 0, not at an optimum.
  if (l2 === 0 && separates(rows, w, b)) {
    converged = false;
    reason = "separable";
  }
  return {
    weights: w,
    bias: b,
    loss,
    converged,
    iterations,
    ...(!converged && reason !== undefined ? { reason } : {}),
  };
}

/** True when the model puts every row strictly on its own label's side. */
function separates(
  rows: readonly { readonly x: readonly number[]; readonly y: boolean }[],
  w: readonly number[],
  b: number,
): boolean {
  return rows.every((r) => {
    let z = b;
    for (let j = 0; j < w.length; j++) z += (w[j] ?? 0) * (r.x[j] ?? 0);
    return r.y ? z > 0 : z < 0;
  });
}

export function predictLogistic(m: LogisticModel, x: readonly number[]): number {
  let z = m.bias;
  for (let j = 0; j < m.weights.length; j++) z += (m.weights[j] ?? 0) * (x[j] ?? 0);
  return sigmoid(z);
}

/** Features for a battery: the log-odds of each member's yes-probability, clamped. */
export function batteryFeatures(vs: readonly JudgeVerdict[]): number[] {
  return vs.map((v) => clamp(logit(v.pYes), -7, 7));
}

/** Pool a battery with a fitted model. The questionId is taken from the first member. */
export function poolLearned(vs: readonly JudgeVerdict[], m: LogisticModel): JudgeVerdict {
  const first = vs[0];
  if (!first) throw new Error("nothing to pool");
  const p = predictLogistic(m, batteryFeatures(vs));
  return { kind: "judge", questionId: first.questionId, pYes: p, confidence: Math.max(p, 1 - p) };
}

/**
 * Platt scaling of one pooled probability: logit(q) = slope * logit(p) + intercept. A logical
 * pool has the right shape for its battery (`all`, the product at independence, for a
 * conjunction; `any`, noisy-OR, for a disjunction) but states its probability as if every
 * member were calibrated on its own question and their errors independent. One model asked
 * several questions about one state is neither, so the pool has the right shape and states the
 * wrong level; two parameters fix the level and the spread without changing the order. In the
 * research simulation of all-of batteries (three and eight members, conditions and member
 * noise each independent or correlated, 200 labelled rows), the product followed by this fit
 * had ECE 0.010 to 0.016 in every configuration, the only combiner calibrated in all of them;
 * with eight members whose noise correlated at 0.6 the product alone read 0.040, and the learned
 * combiner on clamped logits (`fitLogistic` over `batteryFeatures`) fell to AUC 0.686 against
 * the product's 0.925, because a conjunction is close to the minimum of its members' log-odds,
 * which no weighted sum of them represents.
 */
export interface PlattModel {
  /** Above 1 sharpens the pool, below 1 softens it toward 0.5; 1 keeps its spread. */
  readonly slope: number;
  /** Shifts every pool's log-odds; above 0 raises p(yes). */
  readonly intercept: number;
}

/** A fitted Platt map and how the fit ended, read as a `LogisticFit` is. */
export interface PlattFit extends PlattModel {
  /** Mean log loss on the rows fitted, plus the slope's ridge penalty: what the fit minimised. */
  readonly loss: number;
  /**
   * True when the fit found the minimum: both gradient components fell below `tolerance`
   * within the cap, on rows where a finite minimum exists. False, with `reason`, otherwise.
   */
  readonly converged: boolean;
  /** Newton steps taken. */
  readonly iterations: number;
  /**
   * Why the fit did not converge. "one class": every row has one label, so no finite intercept
   * minimises the loss; the map is the identity, the pool as stated, because a one-class sample
   * says nothing about the map and a fit would shift every pool toward the class seen (on a
   * yes-is-go gate whose sample was all yes, toward acting). "separable": with `l2` 0 some map
   * puts every row on its own side, so the slope grows without bound; the map is again the
   * identity rather than the step a diverging slope approaches. Set `l2` above 0. "iteration
   * cap": the cap came first. "no descent": no step along the Newton direction lowered the loss.
   */
  readonly reason?: "one class" | "separable" | "iteration cap" | "no descent";
}

export interface PlattOptions {
  /** Most Newton steps to take. Default 100; two parameters converge in a handful. */
  readonly iterations?: number;
  /**
   * Ridge pulling the slope toward 1, per row: the loss adds (l2 / 2) (slope - 1)^2 to the mean
   * log loss. The intercept is free: the base rate of a battery's truth is the first thing a
   * few labels measure well. Default 0.05, the research note's. With it a finite minimum exists
   * whenever both classes are present, separable rows included.
   */
  readonly l2?: number;
  /** Stop when both gradient components are below this. Default 1e-8. */
  readonly tolerance?: number;
}

/**
 * A pool's log-odds as the Platt fit reads it: `logit` keeps p within 1e-6 of 0 and 1, as every
 * feature in this file is kept, then the research note's +-12. Not the +-7 of
 * `batteryFeatures`: that clamp reads every pool above 0.99909 as 0.99909, and so caps what the
 * identity map can state where a strict bar sits.
 */
const plattFeature = (p: number): number => clamp(logit(p), -12, 12);

/** The calibrated probability for a pooled probability p. */
export function predictPlatt(m: PlattModel, p: number): number {
  return sigmoid(m.slope * plattFeature(p) + m.intercept);
}

type PlattRow = { readonly u: number; readonly y: boolean };

/** Mean log loss of the map (a, b) plus the slope's ridge toward 1; the intercept is free. */
function plattLoss(rows: readonly PlattRow[], a: number, b: number, l2: number): number {
  let total = 0;
  for (const r of rows) {
    const z = a * r.u + b;
    // log(1 + e^z) - y z, computed without overflow.
    total += Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - (r.y ? z : 0);
  }
  return total / rows.length + (l2 / 2) * (a - 1) ** 2;
}

/** The identity map, returned when the rows set no finite map. */
function identityFit(
  rows: readonly PlattRow[],
  l2: number,
  reason: "one class" | "separable",
): PlattFit {
  return {
    slope: 1,
    intercept: 0,
    loss: plattLoss(rows, 1, 0, l2),
    converged: false,
    iterations: 0,
    reason,
  };
}

/**
 * Fit a Platt map to pooled probabilities `p` against the truths `y` by Newton's method with a
 * backtracking line search, starting from the identity, so every step lowers the penalised
 * loss. It stops when both gradient components are below `tolerance`, or after `iterations`
 * steps, and says which, as `fitLogistic` does. Fit on unselected rows (shadow and blind
 * audits) of the current configuration, as every bar is. Below 30 such rows use the pool as it
 * is, as the research note does: the ridge keeps a small sample's slope near 1, but nothing
 * holds its intercept.
 */
export function fitPlatt(
  rows: readonly { readonly p: number; readonly y: boolean }[],
  opts: PlattOptions = {},
): PlattFit {
  const n = rows.length;
  if (n === 0) throw new Error("fitPlatt needs rows");
  const cap = opts.iterations ?? 100;
  const l2 = opts.l2 ?? 0.05;
  const tolerance = opts.tolerance ?? 1e-8;
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error("iterations must be a whole number");
  if (!(Number.isFinite(l2) && l2 >= 0)) {
    throw new Error("l2 must be a finite number of at least 0");
  }
  const data: PlattRow[] = rows.map((r, i) => {
    if (!(typeof r.p === "number" && r.p >= 0 && r.p <= 1)) {
      throw new Error(`fitPlatt: row ${i} has p ${String(r.p)}, not a probability`);
    }
    return { u: plattFeature(r.p), y: r.y };
  });
  const yes = data.filter((r) => r.y).length;
  if (yes === 0 || yes === n) return identityFit(data, l2, "one class");
  let a = 1;
  let b = 0;
  let loss = plattLoss(data, a, b, l2);
  let converged = false;
  let reason: PlattFit["reason"];
  let iterations = 0;
  for (; iterations <= cap; iterations++) {
    let ga = 0;
    let gb = 0;
    let haa = 0;
    let hab = 0;
    let hbb = 0;
    for (const r of data) {
      const q = sigmoid(a * r.u + b);
      const err = q - (r.y ? 1 : 0);
      const s = q * (1 - q);
      ga += err * r.u;
      gb += err;
      haa += s * r.u * r.u;
      hab += s * r.u;
      hbb += s;
    }
    ga = ga / n + l2 * (a - 1);
    gb /= n;
    if (Math.max(Math.abs(ga), Math.abs(gb)) < tolerance) {
      converged = true;
      break;
    }
    if (iterations === cap) {
      reason = "iteration cap";
      break;
    }
    // A tiny ridge keeps the step defined when every pool is the same number.
    const step = solve(
      [
        [haa / n + l2 + 1e-12, hab / n],
        [hab / n, hbb / n + 1e-12],
      ],
      [ga, gb],
    );
    if (step === undefined) {
      reason = "no descent";
      break;
    }
    const [da, db] = [step[0] ?? 0, step[1] ?? 0];
    let t = 1;
    let next = { a, b };
    let nextLoss = loss;
    for (let k = 0; k < 40; k++) {
      next = { a: a - t * da, b: b - t * db };
      nextLoss = plattLoss(data, next.a, next.b, l2);
      if (nextLoss <= loss) break;
      t /= 2;
    }
    if (!(nextLoss <= loss)) {
      reason = "no descent";
      break;
    }
    ({ a, b } = next);
    const moved = loss - nextLoss;
    loss = nextLoss;
    // A step that no longer moves the loss at all has nothing left to find.
    if (moved === 0) {
      converged = true;
      break;
    }
  }
  // Without the ridge, rows some map orders perfectly have no finite minimum: the gradient
  // reaches the tolerance only because the loss is nearly 0, at a slope that is a step.
  if (l2 === 0 && data.every((r) => (r.y ? a * r.u + b > 0 : a * r.u + b < 0))) {
    return identityFit(data, l2, "separable");
  }
  return {
    slope: a,
    intercept: b,
    loss,
    converged,
    iterations,
    ...(!converged && reason !== undefined ? { reason } : {}),
  };
}

/**
 * The pool a Platt combiner calibrates: `any` (noisy-OR) for a disjunction, `all` (the product)
 * for a conjunction, through `poolJudge`.
 */
export interface LogicalPool {
  readonly method: "any" | "all";
  /**
   * Passed to `poolJudge`: it moves `all` from the product up toward the smallest p(yes) and
   * `any` from noisy-OR down toward the largest. Default 0, and only ever the caller's. In both
   * of a battery's usual shapes, an all-of whose go side is yes and an any-of whose go side is
   * no ("act when none applies"), a higher correlation acts more often: it is the permissive
   * direction, and a default keyed on who the members are (one model asked several questions
   * about one state, the usual battery) would push it up. What it stands for is the dependence
   * between the conditions' truths, which sets P(all); the members' error correlation is another
   * quantity, and the Platt fit is what absorbs it. Never set it from `memberCorrelation`.
   */
  readonly correlation?: number;
}

/**
 * A battery combiner in the function form `GateSpec.combine` takes, carrying what it computes
 * (`pool`, `platt`) so a caller can read and record it.
 */
export type PlattCombiner = ((verdicts: readonly JudgeVerdict[]) => JudgeVerdict) & {
  readonly pool: Readonly<Required<LogicalPool>>;
  readonly platt: Readonly<PlattModel>;
};

/**
 * A logical pool followed by a Platt map, as a battery combiner: `poolJudge` by `pool.method`
 * at `pool.correlation`, then `predictPlatt`. The question id is the first member's; the gate
 * renames it. Throws here, at construction, on a method other than `any` or `all`, a
 * correlation outside [0, 1], or a map that is not finite and increasing (a slope at or below 0
 * would invert or flatten the pool, which is no calibration), so the combiner cannot return a
 * p(yes) that is not a probability from its own parameters; a member answer it cannot read
 * makes it throw or return NaN, and either fails the battery open, to review.
 *
 * A gate records every function combiner as "function": the map is not part of the gate's
 * rubric hash. Bump the gate's `evidenceVersion` whenever the fit, the method or the
 * correlation changes, or the old configuration's labels keep grading the new one.
 */
export function plattCombiner(pool: LogicalPool, platt: PlattModel): PlattCombiner {
  const { method } = pool;
  if (method !== "any" && method !== "all") {
    throw new Error(`a Platt combiner pools by "any" or "all", not ${JSON.stringify(method)}`);
  }
  const correlation = pool.correlation ?? 0;
  if (!(Number.isFinite(correlation) && correlation >= 0 && correlation <= 1)) {
    throw new Error(`correlation must be from 0 to 1, not ${String(correlation)}`);
  }
  const { slope, intercept } = platt;
  if (!(Number.isFinite(slope) && slope > 0)) {
    throw new Error(
      `a Platt slope must be a positive number, not ${String(slope)}: a slope at or below 0 inverts or flattens the pool`,
    );
  }
  if (!Number.isFinite(intercept)) {
    throw new Error(`a Platt intercept must be a finite number, not ${String(intercept)}`);
  }
  const model: PlattModel = Object.freeze({ slope, intercept });
  const combine = (vs: readonly JudgeVerdict[]): JudgeVerdict => {
    const pooled = poolJudge(vs, { method, correlation });
    const p = predictPlatt(model, pooled.pYes);
    return {
      kind: "judge",
      questionId: pooled.questionId,
      pYes: p,
      confidence: Math.max(p, 1 - p),
    };
  };
  Object.defineProperty(combine, "pool", {
    value: Object.freeze({ method, correlation }),
    enumerable: true,
  });
  Object.defineProperty(combine, "platt", { value: model, enumerable: true });
  return combine as PlattCombiner;
}

/**
 * Labelled battery requests to a Platt combiner in one call. Each row is one request: its
 * members' verdicts in battery order (as `batteryFeatures` is fed) and the battery's truth.
 * Take them from unselected labelled rows of the current configuration (group member rows by
 * `requestId`), and leave out requests where a member failed open: the battery failed open on
 * them, and a neutral answer is not the member's. The correlation is the caller's alone, as
 * `LogicalPool` says. Check `fit.converged` and `fit.reason` before adopting the combiner, and
 * bump the gate's `evidenceVersion` when you do. Throws when the rows disagree on the member
 * count, or when the fitted slope is not positive: the pool ranks these rows backwards, so check
 * the members' polarity and the method rather than invert it.
 */
export function fitPlattCombiner(
  rows: readonly { readonly verdicts: readonly JudgeVerdict[]; readonly y: boolean }[],
  pool: LogicalPool,
  opts: PlattOptions = {},
): { readonly combine: PlattCombiner; readonly fit: PlattFit } {
  const k = rows[0]?.verdicts.length ?? 0;
  if (k === 0) throw new Error("fitPlattCombiner needs rows with member verdicts");
  if (rows.some((r) => r.verdicts.length !== k)) {
    throw new Error(`fitPlattCombiner: every row needs the same ${k} member verdicts`);
  }
  // Checked first, so a bad method or correlation is refused before anything is fitted.
  const { method, correlation } = plattCombiner(pool, { slope: 1, intercept: 0 }).pool;
  const fit = fitPlatt(
    rows.map((r) => ({ p: poolJudge(r.verdicts, { method, correlation }).pYes, y: r.y })),
    opts,
  );
  if (!(fit.slope > 0)) {
    throw new Error(
      `the fitted Platt slope is ${String(fit.slope)}: the "${method}" pool ranks these rows backwards; check the members' polarity and the method`,
    );
  }
  return { combine: plattCombiner(pool, fit), fit };
}
