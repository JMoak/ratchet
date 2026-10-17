import { describe, expect, it } from "vitest";
import {
  binomialTail,
  effectiveN,
  logit,
  majorityAccuracy,
  rng,
  sigmoid,
  thresholdFromCosts,
} from "../src/math.ts";

describe("Condorcet arithmetic", () => {
  it("majority of 3 at p=0.8 is 0.896", () => {
    expect(majorityAccuracy(3, 0.8)).toBeCloseTo(0.896, 6);
  });
  it("majority of 5 at p=0.8 is 0.94208", () => {
    expect(majorityAccuracy(5, 0.8)).toBeCloseTo(0.94208, 6);
  });
  it("a single voter is just p", () => {
    expect(majorityAccuracy(1, 0.8)).toBeCloseTo(0.8, 9);
  });
  it("below one half, more voters make it worse", () => {
    expect(majorityAccuracy(9, 0.4)).toBeLessThan(0.4);
  });
  it("even n breaks ties fairly", () => {
    // 2 voters at 0.8: both right 0.64, split 0.32 (coin), both wrong 0.04 -> 0.64 + 0.16
    expect(majorityAccuracy(2, 0.8)).toBeCloseTo(0.8, 9);
  });
  it("binomial tail", () => {
    expect(binomialTail(3, 2, 0.8)).toBeCloseTo(0.896, 9);
    expect(binomialTail(3, 0, 0.8)).toBeCloseTo(1, 9);
  });
});

describe("design effect", () => {
  it("independent voters count fully, perfectly correlated ones count once", () => {
    expect(effectiveN(5, 0)).toBe(5);
    expect(effectiveN(5, 1)).toBe(1);
    expect(effectiveN(5, 0.5)).toBeCloseTo(5 / 3, 9);
  });
});

describe("thresholds and logits", () => {
  it("a wrong act 99x costlier than a wrong hold needs 0.99", () => {
    expect(thresholdFromCosts(99, 1)).toBeCloseTo(0.99, 9);
    expect(thresholdFromCosts(1, 1)).toBe(0.5);
    expect(thresholdFromCosts(0, 0)).toBe(0.5);
  });
  it("sigmoid inverts logit", () => {
    for (const p of [0.01, 0.3, 0.5, 0.8, 0.99]) expect(sigmoid(logit(p))).toBeCloseTo(p, 9);
  });
  it("seeded rng is reproducible", () => {
    const a = rng(42);
    const b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
