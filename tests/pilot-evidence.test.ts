import { describe, expect, it } from "vitest";
import {
  exactBinomialLowerBound,
  runEvidenceExperiment,
  validateFixedPolicy,
} from "../experiments/pilot/evidence.ts";

describe("fixed-policy pilot evidence", () => {
  it("keeps no evidence unknown and a perfect small sample insufficient", () => {
    expect(validateFixedPolicy([], { targetAccuracy: 0.98 })).toEqual({
      acts: 0,
      wrongActs: 0,
      accuracy: null,
      lowerBound: null,
      targetAccuracy: 0.98,
      confidence: 0.95,
      status: "insufficient-evidence",
    });
    expect(validateFixedPolicy(Array(20).fill(true), { targetAccuracy: 0.98 })).toMatchObject({
      acts: 20,
      wrongActs: 0,
      accuracy: 1,
      status: "insufficient-evidence",
    });
    expect(exactBinomialLowerBound(20, 20)).toBeCloseTo(0.8608916593, 9);
  });

  it("needs 149 independent perfect acts to support 98% at a single planned 95% look", () => {
    expect(validateFixedPolicy(Array(148).fill(true), { targetAccuracy: 0.98 }).status).toBe(
      "insufficient-evidence",
    );
    expect(validateFixedPolicy(Array(149).fill(true), { targetAccuracy: 0.98 }).status).toBe(
      "supported",
    );
    expect(exactBinomialLowerBound(149, 149)).toBeCloseTo(0.9800951838, 9);
    expect(exactBinomialLowerBound(0, 20)).toBe(0);
    expect(validateFixedPolicy(Array(20).fill(false), { targetAccuracy: 0.98 })).toMatchObject({
      acts: 20,
      wrongActs: 20,
      accuracy: 0,
      lowerBound: 0,
      status: "below-target",
    });
  });

  it("inverts the binomial tail, including a mixed sample and an extreme small bound", () => {
    // P(X >= 1) = 1 - (1-p)^n gives an independent closed-form anchor.
    expect(exactBinomialLowerBound(1, 20)).toBeCloseTo(1 - 0.95 ** (1 / 20), 12);
    expect(exactBinomialLowerBound(1, 10_000)).toBeCloseTo(
      -Math.expm1(Math.log(0.95) / 10_000),
      12,
    );
    // For 2/3 successes, P(X >= 2) = 3p² - 2p³.
    const lower = exactBinomialLowerBound(2, 3) ?? Number.NaN;
    expect(3 * lower ** 2 - 2 * lower ** 3).toBeCloseTo(0.05, 12);
    expect(exactBinomialLowerBound(19, 20, 0.99)).toBeLessThan(
      exactBinomialLowerBound(19, 20, 0.95) ?? 0,
    );
    expect(exactBinomialLowerBound(19, 20)).toBeLessThan(exactBinomialLowerBound(20, 20) ?? 0);
  });

  it.each([0.01, 0.1, 0.5, 0.95, 0.99])(
    "uses the full probability interval when confidence is %s",
    (confidence) => {
      // For 1/2 successes, 1 - (1-p)^2 = 1-confidence.
      expect(exactBinomialLowerBound(1, 2, confidence)).toBeCloseTo(1 - Math.sqrt(confidence), 12);
    },
  );

  it.each([
    [-1, 20],
    [21, 20],
    [0.5, 20],
    [1, -1],
    [1, 2.5],
    [Number.NaN, 20],
    [1, Number.POSITIVE_INFINITY],
    [1, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects invalid counts %s / %s", (correct, total) => {
    expect(() => exactBinomialLowerBound(correct, total)).toThrow(RangeError);
  });

  it.each([0, 1, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid confidence %s even without data",
    (confidence) => {
      expect(() => exactBinomialLowerBound(0, 0, confidence)).toThrow(RangeError);
      expect(() => validateFixedPolicy([], { targetAccuracy: 0.98, confidence })).toThrow(
        RangeError,
      );
    },
  );

  it.each([0, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid target %s",
    (targetAccuracy) => {
      expect(() => validateFixedPolicy([], { targetAccuracy })).toThrow(RangeError);
    },
  );

  it("cannot support certainty from any finite perfect sample and rejects non-booleans", () => {
    expect(validateFixedPolicy(Array(200).fill(true), { targetAccuracy: 1 }).status).toBe(
      "insufficient-evidence",
    );
    expect(() =>
      validateFixedPolicy([true, 1] as unknown as boolean[], { targetAccuracy: 0.98 }),
    ).toThrow(TypeError);
  });
});

describe("seeded evidence experiment", () => {
  it("is reproducible, shares label budgets, and exposes repeated looks", () => {
    const first = runEvidenceExperiment({ trials: 10, seed: 71 });
    expect(runEvidenceExperiment({ trials: 10, seed: 71 })).toEqual(first);
    const byId = new Map(first.methods.map((method) => [method.id, method]));
    expect(byId.get("point200")?.maxLabels).toBe(byId.get("exact200")?.maxLabels);
    expect(byId.get("exact2000")?.maxLabels).toBe(byId.get("repeatedExact2000")?.maxLabels);
    expect(byId.get("exact2000")?.looks).toEqual([2000]);
    expect(byId.get("repeatedExact2000")?.looks).toHaveLength(100);
    for (const row of first.rows) {
      for (const result of row.results) {
        expect(result.acceptances).toBeGreaterThanOrEqual(0);
        expect(result.acceptances).toBeLessThanOrEqual(first.trials);
        expect(result.acceptanceRate).toBe(result.acceptances / first.trials);
        expect(result.meanLabelsEvaluated).toBeLessThanOrEqual(
          byId.get(result.methodId)?.maxLabels ?? 0,
        );
      }
    }
  });

  it("controls single-look false acceptance while uncorrected repeated looks inflate it", () => {
    const result = runEvidenceExperiment({ trials: 3000, seed: 20261020 });
    const rate = (accuracy: number, methodId: string): number =>
      result.rows
        .find((row) => row.trueAccuracy === accuracy)
        ?.results.find((method) => method.methodId === methodId)?.acceptanceRate ?? Number.NaN;
    // Broad Monte Carlo tolerances, not seed-specific snapshots. At the boundary,
    // rejection can be up to alpha; a rate below the target is a false promotion.
    for (const accuracy of [0.9, 0.95, 0.97, 0.98]) {
      expect(rate(accuracy, "exact200")).toBeLessThan(0.07);
      expect(rate(accuracy, "exact2000")).toBeLessThan(0.07);
    }
    expect(rate(0.95, "point20")).toBeGreaterThan(0.3);
    expect(rate(0.97, "point200")).toBeGreaterThan(rate(0.97, "exact200") + 0.15);
    expect(rate(0.98, "repeatedExact2000")).toBeGreaterThan(0.08);
    expect(rate(0.98, "repeatedExact2000")).toBeGreaterThan(rate(0.98, "exact2000") + 0.04);
    expect(rate(0.995, "exact2000")).toBeGreaterThan(0.95);
  });

  it.each([
    { trials: 0 },
    { trials: -1 },
    { trials: 1.5 },
    { trials: 100_001 },
    { trials: Number.NaN },
    { seed: -1 },
    { seed: 1.5 },
    { seed: 0x100000000 },
    { seed: Number.POSITIVE_INFINITY },
  ])("rejects invalid experiment settings %j", (options) => {
    expect(() => runEvidenceExperiment(options)).toThrow(RangeError);
  });
});
