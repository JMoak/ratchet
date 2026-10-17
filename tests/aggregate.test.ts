import { describe, expect, it } from "vitest";
import { agreement, poolJudge, poolPick, reliabilityWeight } from "../src/compound/aggregate.ts";
import { logit, sigmoid } from "../src/math.ts";
import { pick } from "../src/questions.ts";
import type { JudgeVerdict, PickVerdict } from "../src/types.ts";

const j = (pYes: number): JudgeVerdict => ({
  kind: "judge",
  questionId: "q",
  pYes,
  confidence: Math.max(pYes, 1 - pYes),
});

describe("log-odds pooling", () => {
  it("three independent 0.8s compound to about 0.985", () => {
    const v = poolJudge([j(0.8), j(0.8), j(0.8)]);
    expect(v.pYes).toBeCloseTo(sigmoid(3 * logit(0.8)), 6);
    expect(v.pYes).toBeGreaterThan(0.98);
  });
  it("perfectly correlated voices add nothing", () => {
    const v = poolJudge([j(0.8), j(0.8), j(0.8)], { correlation: 1 });
    expect(v.pYes).toBeCloseTo(0.8, 6);
  });
  it("correlation never changes which side wins, only how sure", () => {
    const free = poolJudge([j(0.9), j(0.3), j(0.7)]);
    const tied = poolJudge([j(0.9), j(0.3), j(0.7)], { correlation: 0.6 });
    expect(free.pYes > 0.5).toBe(tied.pYes > 0.5);
    expect(tied.confidence).toBeLessThan(free.confidence);
  });
  it("opposing evidence cancels", () => {
    expect(poolJudge([j(0.8), j(0.2)]).pYes).toBeCloseTo(0.5, 6);
  });
  it("max, min and geomean methods", () => {
    expect(poolJudge([j(0.9), j(0.2), j(0.4)], { method: "max" }).pYes).toBeCloseTo(0.9, 9);
    expect(poolJudge([j(0.9), j(0.2), j(0.4)], { method: "min" }).pYes).toBeCloseTo(0.2, 9);
    expect(poolJudge([j(0.8), j(0.8), j(0.8)], { method: "geomean" }).pYes).toBeCloseTo(0.8, 6);
    expect(poolJudge([j(0.8), j(0.8), j(0.8)]).pYes).toBeGreaterThan(0.98);
  });
  it("majority and mean methods", () => {
    expect(poolJudge([j(0.9), j(0.6), j(0.4)], { method: "majority" }).pYes).toBeCloseTo(2 / 3, 6);
    expect(poolJudge([j(0.9), j(0.6), j(0.3)], { method: "mean" }).pYes).toBeCloseTo(0.6, 6);
  });
  it("reliability weights are log-odds of accuracy", () => {
    expect(reliabilityWeight(0.8)).toBeCloseTo(logit(0.8), 9);
    expect(reliabilityWeight(0.5)).toBeCloseTo(0, 9);
  });
});

describe("pick pooling", () => {
  const q = pick("which", ["a", "b", "c"], { id: "q" });
  const v = (probs: [number, number, number]): PickVerdict => {
    const [a, b, c] = probs;
    const best = a >= b && a >= c ? "a" : b >= c ? "b" : "c";
    return {
      kind: "pick",
      questionId: "q",
      choice: best,
      probabilities: { a, b, c },
      confidence: Math.max(a, b, c),
    };
  };
  it("product of experts sharpens agreement", () => {
    const pooled = poolPick(q, [v([0.6, 0.2, 0.2]), v([0.6, 0.2, 0.2]), v([0.6, 0.2, 0.2])]);
    expect(pooled.choice).toBe("a");
    expect(pooled.confidence).toBeGreaterThan(0.9);
  });
  it("majority counts votes", () => {
    const pooled = poolPick(q, [v([0.5, 0.4, 0.1]), v([0.5, 0.4, 0.1]), v([0.1, 0.8, 0.1])], {
      method: "majority",
    });
    expect(pooled.choice).toBe("a");
    expect(pooled.probabilities.a).toBeCloseTo(2 / 3, 6);
  });
  it("agreement is the plurality share", () => {
    expect(agreement([v([0.5, 0.4, 0.1]), v([0.5, 0.4, 0.1]), v([0.1, 0.8, 0.1])])).toBeCloseTo(
      2 / 3,
      6,
    );
    expect(agreement([j(0.9), j(0.2)])).toBe(0.5);
  });
});
