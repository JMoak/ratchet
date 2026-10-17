import { clamp, logit, sigmoid } from "../math.ts";
import type { JudgeVerdict } from "../types.ts";

/**
 * Learned composition: treat a battery of judge answers as features and fit the pooling
 * weights on labelled outcomes. Where a single verdict question scored 62.6%, five signal
 * questions plus a logistic regression scored 95% on the same phishing task; TypeSafe's own
 * feature-discovery cookbook does the same with a tree model. This is the smallest version:
 * L2-regularised logistic regression on the log-odds of each member, by gradient descent,
 * no dependencies. Fit on unselected rows and refit when the model version moves.
 */
export interface LogisticModel {
  readonly weights: readonly number[];
  readonly bias: number;
}

export interface LogisticOptions {
  readonly iterations?: number;
  readonly learningRate?: number;
  readonly l2?: number;
}

export function fitLogistic(
  rows: readonly { readonly x: readonly number[]; readonly y: boolean }[],
  opts: LogisticOptions = {},
): LogisticModel {
  const n = rows.length;
  if (n === 0) throw new Error("fitLogistic needs rows");
  const d = rows[0]?.x.length ?? 0;
  const iterations = opts.iterations ?? 400;
  const lr = opts.learningRate ?? 0.1;
  const l2 = opts.l2 ?? 0.01;
  const w = new Array<number>(d).fill(0);
  let b = 0;
  for (let it = 0; it < iterations; it++) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    for (const r of rows) {
      let z = b;
      for (let j = 0; j < d; j++) z += (w[j] ?? 0) * (r.x[j] ?? 0);
      const err = sigmoid(z) - (r.y ? 1 : 0);
      for (let j = 0; j < d; j++) gw[j] = (gw[j] ?? 0) + err * (r.x[j] ?? 0);
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] = (w[j] ?? 0) - lr * ((gw[j] ?? 0) / n + l2 * (w[j] ?? 0));
    b -= lr * (gb / n);
  }
  return { weights: w, bias: b };
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
