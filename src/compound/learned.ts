import { clamp, logit, sigmoid } from "../math.ts";
import type { JudgeVerdict } from "../types.ts";

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
