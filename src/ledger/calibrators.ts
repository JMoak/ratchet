/**
 * Calibration maps that behave on 50 to 500 labels. `fitIsotonic` returns hard 0 and 1 at the
 * ends of a small sample, which ruined its log loss in simulation (0.69 at 50 rows, against 0.37
 * for the raw stated probability), and an exact 0 or 1 is infinite in log-odds pooling. Beta
 * calibration fits three numbers and contains the identity, so a calibrated score is left alone;
 * an inductive Venn-Abers predictor keeps isotonic regression's freedom of shape and says how
 * unsure it is as an interval. Neither ever returns exactly 0 or 1. Fit both on unselected rows
 * only (shadow rows and blind audits), and refit when the model version moves. Like every fit
 * here they map stated probability to observed correctness, never to another model's answer.
 */

import { clamp, EPS, sigmoid } from "../math.ts";
import type { Scored } from "./calibration.ts";

/** A fitted beta calibration map and how the fit ended. */
export interface BetaCalibration {
  /** Weight on ln(p). */
  readonly a: number;
  /** Weight on -ln(1 - p). */
  readonly b: number;
  /** Intercept. */
  readonly c: number;
  /**
   * The calibrated probability for a stated one: sigmoid(a ln p - b ln(1 - p) + c), with p held
   * in [EPS, 1 - EPS] and the result held there too, the range `logit` reads. Throws on anything
   * but a probability.
   */
  readonly apply: (confidence: number) => number;
  /** Mean log loss on the rows fitted, plus the ridge: what the fit minimised. */
  readonly loss: number;
  /**
   * True when the fit found the minimum: the largest gradient component fell below `tolerance`
   * within the cap. False, with `reason`, otherwise.
   */
  readonly converged: boolean;
  /** Newton steps taken, over every refit. */
  readonly iterations: number;
  /** Rows fitted. */
  readonly n: number;
  /**
   * Why the fit did not converge. "no rows" and "one class": nothing says how stated probability
   * maps to the observed rate, so the map is the identity (a fit would be the ridge's choice, not
   * the data's). "iteration cap": the cap came first. "no descent": no step along the Newton
   * direction lowered the loss.
   */
  readonly reason?: "no rows" | "one class" | "iteration cap" | "no descent";
}

export interface BetaOptions {
  /**
   * Ridge toward the identity (a = b = 1, c = 0) on the summed log loss, so it fades as rows
   * accrue. It keeps a fit on tiny or separable rows finite. Must be positive. Default 0.1: in a
   * simulated sweep from 0.001 to 3 it was within noise of the best at 50 to 500 rows in both
   * models, and a fit on 50 rows came out worse than the raw score on 1 draw in 150, against 1 in
   * 7 at 0.001; a ridge of 1 or more still biased the map at 500 rows.
   */
  readonly ridge?: number;
  /** Most Newton steps per fit. Default 100; three parameters converge in about ten. */
  readonly iterations?: number;
  /** Stop when every component of the mean gradient is below this. Default 1e-8. */
  readonly tolerance?: number;
}

const IDENTITY = [1, 1, 0] as const;

/**
 * Beta calibration: logit(q) = a ln(p) - b ln(1 - p) + c, a logistic regression on the features
 * ln(p) and -ln(1 - p). The family contains the identity (a = b = 1, c = 0 gives q = p), so a
 * well-calibrated score is left alone, which logistic calibration on the raw score cannot do; and
 * unlike Platt scaling on logit(p) its two slopes bend the two ends separately. It was best or
 * within noise of best at 50 to 500 rows in both simulated models, including one where the true
 * map is not logistic in logit(p).
 *
 * Fitted by Newton's method with a backtracking line search (every step lowers the loss) and a
 * small ridge toward the identity, so it is stable on tiny or separable samples. a and b are kept
 * at or above 0 so the map never reverses the order of stated probabilities (Kull et al.'s
 * constraint): a slope that fits negative is held at 0 and the rest refitted. With no rows, or
 * rows of one class, the map is the identity and `converged` is false. Throws on a row or option
 * out of range.
 */
export function fitBeta(items: readonly Scored[], opts: BetaOptions = {}): BetaCalibration {
  const ridge = opts.ridge ?? 0.1;
  const cap = opts.iterations ?? 100;
  const tolerance = opts.tolerance ?? 1e-8;
  if (!(typeof ridge === "number" && ridge > 0 && Number.isFinite(ridge))) {
    throw new Error("ridge must be a positive number: it keeps a fit on separable rows finite");
  }
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error("iterations must be a whole number");
  if (!(typeof tolerance === "number" && tolerance > 0)) {
    throw new Error("tolerance must be positive");
  }
  const rows = checkedRows(items).map((s) => {
    const p = clamp(s.confidence, EPS, 1 - EPS);
    return { x: [Math.log(p), -Math.log(1 - p), 1] as const, y: s.correct ? 1 : 0 };
  });
  const n = rows.length;
  const yes = rows.filter((r) => r.y === 1).length;
  if (yes === 0 || yes === n) {
    const [a, b, c] = IDENTITY;
    return {
      a,
      b,
      c,
      apply: betaMap(a, b, c),
      loss: n === 0 ? 0 : penalised(rows, IDENTITY, ridge),
      converged: false,
      iterations: 0,
      n,
      reason: n === 0 ? "no rows" : "one class",
    };
  }
  // Active set for the slopes: fit, hold the most negative slope at 0, refit, at most twice.
  const free = [true, true, true];
  let theta: number[] = [...IDENTITY];
  let fit: NewtonResult;
  let iterations = 0;
  for (;;) {
    fit = newton(rows, theta, free, ridge, cap, tolerance);
    iterations += fit.iterations;
    theta = fit.theta;
    const negative = [0, 1].filter((j) => free[j] && (theta[j] as number) < 0);
    if (negative.length === 0) break;
    const worst = negative.reduce((m, j) => ((theta[j] as number) < (theta[m] as number) ? j : m));
    free[worst] = false;
    theta[worst] = 0;
  }
  const [a, b, c] = theta as [number, number, number];
  return {
    a,
    b,
    c,
    apply: betaMap(a, b, c),
    loss: fit.loss,
    converged: fit.converged,
    iterations,
    n,
    ...(!fit.converged && fit.reason !== undefined ? { reason: fit.reason } : {}),
  };
}

interface Row {
  readonly x: readonly [number, number, number];
  readonly y: number;
}

interface NewtonResult {
  readonly theta: number[];
  readonly loss: number;
  readonly converged: boolean;
  readonly iterations: number;
  readonly reason?: "iteration cap" | "no descent";
}

/** Mean log loss of `theta` on the rows, plus the ridge toward the identity spread over them. */
function penalised(rows: readonly Row[], theta: readonly number[], ridge: number): number {
  let total = 0;
  for (const r of rows) {
    const z = dot(r.x, theta);
    // log(1 + e^z) - y z, computed without overflow.
    total += Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - r.y * z;
  }
  let pull = 0;
  for (let j = 0; j < 3; j++) pull += ((theta[j] as number) - (IDENTITY[j] as number)) ** 2;
  return (total + (ridge / 2) * pull) / rows.length;
}

/** Newton's method on the free parameters, the others held where they are. */
function newton(
  rows: readonly Row[],
  start: readonly number[],
  free: readonly boolean[],
  ridge: number,
  cap: number,
  tolerance: number,
): NewtonResult {
  const n = rows.length;
  const idx = [0, 1, 2].filter((j) => free[j]);
  let theta = start.slice();
  let loss = penalised(rows, theta, ridge);
  for (let it = 0; ; it++) {
    const grad = [0, 0, 0];
    const hess = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const r of rows) {
      const q = sigmoid(dot(r.x, theta));
      const err = q - r.y;
      const w = q * (1 - q);
      for (let i = 0; i < 3; i++) {
        grad[i] = (grad[i] as number) + err * (r.x[i] as number);
        const hi = hess[i] as number[];
        for (let j = 0; j < 3; j++) {
          hi[j] = (hi[j] as number) + w * (r.x[i] as number) * (r.x[j] as number);
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      const pull = (theta[i] as number) - (IDENTITY[i] as number);
      grad[i] = ((grad[i] as number) + ridge * pull) / n;
      const hi = hess[i] as number[];
      for (let j = 0; j < 3; j++) hi[j] = ((hi[j] as number) + (i === j ? ridge : 0)) / n;
    }
    const g = idx.map((i) => grad[i] as number);
    if (Math.max(...g.map(Math.abs)) < tolerance) {
      return { theta, loss, converged: true, iterations: it };
    }
    if (it === cap)
      return { theta, loss, converged: false, iterations: it, reason: "iteration cap" };
    // The ridge makes the Hessian positive definite, so the step is always defined.
    const step = solve(
      idx.map((i) => idx.map((j) => (hess[i] as number[])[j] as number)),
      g,
    );
    let t = 1;
    let next = theta;
    let nextLoss = loss;
    for (let k = 0; k < 40; k++) {
      next = theta.slice();
      idx.forEach((i, m) => {
        next[i] = (theta[i] as number) - t * (step[m] as number);
      });
      nextLoss = penalised(rows, next, ridge);
      if (nextLoss <= loss) break;
      t /= 2;
    }
    if (!(nextLoss <= loss)) {
      return { theta, loss, converged: false, iterations: it, reason: "no descent" };
    }
    const moved = loss - nextLoss;
    theta = next;
    loss = nextLoss;
    // A step that no longer moves the loss at all has nothing left to find.
    if (moved === 0) return { theta, loss, converged: true, iterations: it + 1 };
  }
}

const dot = (x: readonly number[], theta: readonly number[]): number =>
  (x[0] as number) * (theta[0] as number) +
  (x[1] as number) * (theta[1] as number) +
  (x[2] as number) * (theta[2] as number);

/** Solve A x = g by Gaussian elimination with partial pivoting, for a positive definite A. */
function solve(a: readonly (readonly number[])[], g: readonly number[]): number[] {
  const n = g.length;
  const m = a.map((row, i) => [...row, g[i] as number]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) {
      if (
        Math.abs((m[r] as number[])[c] as number) > Math.abs((m[pivot] as number[])[c] as number)
      ) {
        pivot = r;
      }
    }
    const top = m[pivot] as number[];
    [m[c], m[pivot]] = [top, m[c] as number[]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = m[r] as number[];
      const f = (row[c] as number) / (top[c] as number);
      for (let k = c; k <= n; k++) row[k] = (row[k] as number) - f * (top[k] as number);
    }
  }
  return m.map((row, i) => (row[n] as number) / (row[i] as number));
}

function betaMap(a: number, b: number, c: number): (confidence: number) => number {
  return (confidence) => {
    const p = clamp(checkedProbability(confidence), EPS, 1 - EPS);
    return clamp(sigmoid(a * Math.log(p) - b * Math.log(1 - p) + c), EPS, 1 - EPS);
  };
}

/** What an inductive Venn-Abers predictor says about one stated probability. */
export interface VennAbersPrediction {
  /** The isotonic fit at the query with the query labelled wrong added to the calibration rows. */
  readonly p0: number;
  /** The same with the query labelled right. Never below `p0`. */
  readonly p1: number;
  /**
   * p1 / (1 - p0 + p1): one number with good log loss, strictly between 0 and 1. Merging gives up
   * the calibration guarantee; it is then just a good estimator.
   */
  readonly merged: number;
}

export interface VennAbers {
  /** The prediction for a stated probability. Throws on anything but a probability. */
  readonly predict: (confidence: number) => VennAbersPrediction;
  /** Calibration rows. */
  readonly n: number;
}

/**
 * An inductive Venn-Abers predictor. For a query score s, isotonic regression
 * (pool-adjacent-violators) on the calibration rows with (s, wrong) added gives p0 at s, and with
 * (s, right) added gives p1. The pair is the calibrated object: under exchangeability, the one of
 * the two computed with the query's true label is perfectly calibrated (the validity of Venn
 * predictors). Its width p1 - p0 says how much the calibration rows know near s: in simulation
 * about 0.17 to 0.20 near the bars at 50 rows and 0.03 to 0.04 at 500. The merged
 * p1 / (1 - p0 + p1) gives up that guarantee for a single number; read it as an estimate.
 *
 * Equal scores share one fitted value (the secondary approach to ties, as `fitIsotonic` treats
 * them), so a query equal to a calibration score joins its block. The isotonic fit on the
 * calibration rows is prepared once from both ends, so a query merges only the blocks its added
 * row violates: the result is the same pool-adjacent-violators fit, read in time proportional to
 * the merges rather than to the rows. Merged is never exactly 0 or 1: p1 averages a block that
 * holds a right row and p0 one that holds a wrong row, so p1 > 0 and p0 < 1.
 *
 * Throws on a row out of range. With no rows every query is [0, 1], merged 0.5.
 */
export function fitVennAbers(items: readonly Scored[]): VennAbers {
  const sorted = checkedRows(items)
    .map((s) => ({ x: s.confidence, y: s.correct ? 1 : 0 }))
    .sort((p, q) => p.x - q.x);
  // Distinct scores with their counts and right counts.
  const xs: number[] = [];
  const blocks: Block[] = [];
  for (const r of sorted) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && xs[xs.length - 1] === r.x) {
      blocks[blocks.length - 1] = { sum: last.sum + r.y, weight: last.weight + 1 };
    } else {
      xs.push(r.x);
      blocks.push({ sum: r.y, weight: 1 });
    }
  }
  const k = xs.length;
  // left[j]: top of the pool-adjacent-violators stack over scores 0..j-1, built left to right.
  // right[j]: front of the stack over scores j..k-1, built right to left. Both are persistent:
  // a merge makes a new node and leaves the old ones to the shorter prefixes and suffixes.
  const left: (Node | undefined)[] = [undefined];
  for (let j = 0; j < k; j++) {
    let cur: Block = blocks[j] as Block;
    let below = left[j];
    while (below !== undefined && above(below, cur)) {
      cur = pool(cur, below);
      below = below.next;
    }
    left.push({ ...cur, next: below });
  }
  const right: (Node | undefined)[] = new Array(k + 1).fill(undefined);
  for (let j = k - 1; j >= 0; j--) {
    let cur: Block = blocks[j] as Block;
    let after = right[j + 1];
    while (after !== undefined && above(cur, after)) {
      cur = pool(cur, after);
      after = after.next;
    }
    right[j] = { ...cur, next: after };
  }
  const fitAt = (start: Block, l: Node | undefined, r: Node | undefined): number => {
    let b = start;
    for (;;) {
      if (l !== undefined && above(l, b)) {
        b = pool(b, l);
        l = l.next;
      } else if (r !== undefined && above(b, r)) {
        b = pool(b, r);
        r = r.next;
      } else {
        return b.sum / b.weight;
      }
    }
  };
  const predict = (confidence: number): VennAbersPrediction => {
    const s = checkedProbability(confidence);
    // lo: how many distinct scores lie below s.
    let lo = 0;
    let hi = k;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((xs[mid] as number) < s) lo = mid + 1;
      else hi = mid;
    }
    const tie = xs[lo] === s;
    const own: Block = tie ? (blocks[lo] as Block) : { sum: 0, weight: 0 };
    const l = left[lo];
    const r = right[tie ? lo + 1 : lo];
    const p0 = fitAt({ sum: own.sum, weight: own.weight + 1 }, l, r);
    const p1 = fitAt({ sum: own.sum + 1, weight: own.weight + 1 }, l, r);
    return { p0, p1, merged: p1 / (1 - p0 + p1) };
  };
  return { predict, n: sorted.length };
}

interface Block {
  /** Right rows in the block. */
  readonly sum: number;
  /** Rows in the block. */
  readonly weight: number;
}

interface Node extends Block {
  /** The next block away from the query: lower scores on the left stack, higher on the right. */
  readonly next: Node | undefined;
}

/** True when block `l`'s mean is above block `r`'s, compared exactly on the integer counts. */
const above = (l: Block, r: Block): boolean => l.sum * r.weight > r.sum * l.weight;

const pool = (a: Block, b: Block): Block => ({ sum: a.sum + b.sum, weight: a.weight + b.weight });

function checkedProbability(x: number): number {
  if (typeof x !== "number" || !(x >= 0 && x <= 1)) {
    throw new Error(`a stated probability must be in [0, 1]; got ${String(x)}`);
  }
  return x;
}

function checkedRows(items: readonly Scored[]): readonly Scored[] {
  if (!Array.isArray(items)) throw new Error("rows must be an array");
  items.forEach((s, i) => {
    if (typeof s?.confidence !== "number" || !(s.confidence >= 0 && s.confidence <= 1)) {
      throw new Error(`row ${i}: confidence must be a probability in [0, 1]`);
    }
    if (typeof s.correct !== "boolean") throw new Error(`row ${i}: correct must be a boolean`);
  });
  return items;
}
