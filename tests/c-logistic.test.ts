import { describe, expect, it } from "vitest";
import {
  batteryFeatures,
  fitLogistic,
  type LogisticModel,
  poolLearned,
  predictLogistic,
} from "../src/compound/learned.ts";
import { rng } from "../src/math.ts";
import { judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion } from "../src/types.ts";

type Row = { readonly x: readonly number[]; readonly y: boolean };

/**
 * A seeded disjunctive battery, as the triage track's moderation gate was: four members, one
 * per risk, each confident and right on its own risk; the post needs action when any applies.
 * Features are member log-odds clamped to +-7, so a model has to learn large weights.
 */
function battery(n: number, seed: number): Row[] {
  const rand = rng(seed);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const risk = rand() < 0.5 ? Math.floor(rand() * 4) : -1;
    const ps = [0, 1, 2, 3].map((k) => {
      const on = k === risk;
      const noise = 0.08 * rand();
      return on ? 0.9 + noise : 0.02 + noise;
    });
    const q = { kind: "judge", id: "m", prompt: "" } as JudgeQuestion;
    rows.push({ x: batteryFeatures(ps.map((p) => judgeVerdictFrom(q, p))), y: risk >= 0 });
  }
  return rows;
}

const logLoss = (m: LogisticModel, rows: readonly Row[], l2 = 0.01): number => {
  const data =
    rows.reduce((s, r) => {
      const p = Math.min(1 - 1e-12, Math.max(1e-12, predictLogistic(m, r.x)));
      return s - (r.y ? Math.log(p) : Math.log(1 - p));
    }, 0) / rows.length;
  return data + (l2 / 2) * m.weights.reduce((s, w) => s + w * w, 0);
};

/** The fit `fitLogistic` used to be: 400 steps of gradient descent at learning rate 0.1. */
function gradientDescent(rows: readonly Row[], iterations = 400): LogisticModel {
  const d = rows[0]?.x.length ?? 0;
  const w = new Array<number>(d).fill(0);
  let b = 0;
  for (let it = 0; it < iterations; it++) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    for (const r of rows) {
      const err = predictLogistic({ weights: w, bias: b }, r.x) - (r.y ? 1 : 0);
      for (let j = 0; j < d; j++) gw[j] = (gw[j] ?? 0) + err * (r.x[j] ?? 0);
      gb += err;
    }
    for (let j = 0; j < d; j++)
      w[j] = (w[j] ?? 0) - 0.1 * ((gw[j] ?? 0) / rows.length + 0.01 * (w[j] ?? 0));
    b -= 0.1 * (gb / rows.length);
  }
  return { weights: w, bias: b };
}

describe("fitLogistic runs to convergence and says so (e2e T3-06)", () => {
  it("converges in a handful of Newton steps to a lower loss than the old 400 steps reached", () => {
    const fit = battery(300, 7);
    const m = fitLogistic(fit);
    expect(m.converged).toBe(true);
    expect(m.iterations).toBeLessThan(30);
    expect(m.loss).toBeCloseTo(logLoss(m, fit), 9);
    const old = gradientDescent(fit);
    // The old fit stopped well short of the optimum on these clamped features.
    expect(logLoss(old, fit)).toBeGreaterThan(m.loss + 0.02);
    // Gradient descent run far longer approaches the same optimum, from above.
    expect(logLoss(gradientDescent(fit, 20_000), fit)).toBeGreaterThanOrEqual(m.loss - 1e-9);
    // And it reads held-out rows at least as well.
    const held = battery(300, 8);
    const right = (model: LogisticModel) =>
      held.filter((r) => predictLogistic(model, r.x) >= 0.5 === r.y).length;
    expect(right(m)).toBeGreaterThanOrEqual(right(old));
  });

  it("stops at the iteration cap and says it did not converge", () => {
    const m = fitLogistic(battery(200, 3), { iterations: 1 });
    expect(m.converged).toBe(false);
    expect(m.iterations).toBe(1);
  });

  it("converges on separable rows, where the L2 penalty keeps the weights finite", () => {
    const rows: Row[] = Array.from({ length: 40 }, (_, i) => ({
      x: [i < 20 ? -3 : 3],
      y: i >= 20,
    }));
    const m = fitLogistic(rows);
    expect(m.converged).toBe(true);
    expect(Number.isFinite(m.weights[0])).toBe(true);
    expect(predictLogistic(m, [3])).toBeGreaterThan(0.95);
    expect(predictLogistic(m, [-3])).toBeLessThan(0.05);
  });

  it("still pools a battery, and a fit is still a combiner", () => {
    const m = fitLogistic(battery(200, 5));
    const q = { kind: "judge", id: "m", prompt: "" } as JudgeQuestion;
    const out = poolLearned(
      [0.95, 0.03, 0.03, 0.03].map((p) => judgeVerdictFrom(q, p)),
      m,
    );
    expect(out.pYes).toBeGreaterThan(0.8);
    const none = poolLearned(
      [0.03, 0.03, 0.03, 0.03].map((p) => judgeVerdictFrom(q, p)),
      m,
    );
    expect(none.pYes).toBeLessThan(0.2);
    expect(() => fitLogistic([])).toThrow(/needs rows/);
  });
});
