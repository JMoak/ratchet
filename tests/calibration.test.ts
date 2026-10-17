import { describe, expect, it } from "vitest";
import {
  coverageAt,
  fitThreshold,
  riskCoverage,
  type ScoredTruth,
  scoredWithTruth,
} from "../src/ledger/calibration.ts";
import type { DecisionRecord } from "../src/ledger/ledger.ts";
import { mean } from "../src/math.ts";
import { SimOracle, type Truth } from "../src/oracles/sim.ts";
import { judge } from "../src/questions.ts";

// A screening-shaped set: one document in four is an include.
const N = 3000;
const docs = Array.from({ length: N }, (_, i) => `doc-${i}`);
const truths = new Map<string, Truth>(docs.map((s, i) => [s, { judge: i % 4 === 0 }]));
const truthOf = (s: string) => truths.get(s);
const include = judge("Does this abstract meet the inclusion criteria?", { id: "include" });

async function screen(oracle: SimOracle): Promise<ScoredTruth[]> {
  const out: ScoredTruth[] = [];
  for (const s of docs) {
    const [d] = await oracle.decide(s, [include]);
    const v = d?.verdict;
    if (v?.kind !== "judge") throw new Error("expected a judge verdict");
    const truth = truths.get(s)?.judge === true;
    const leanedYes = v.pYes >= 0.5;
    out.push({ confidence: v.confidence, correct: leanedYes === truth, truth, leanedYes });
  }
  return out;
}

// Independent readouts, written the slow obvious way, to check the fit against.
const positives = (xs: readonly ScoredTruth[]) => xs.filter((s) => s.truth).length;
const recallAt = (xs: readonly ScoredTruth[], t: number) =>
  1 - xs.filter((s) => s.truth && !s.leanedYes && s.confidence >= t).length / positives(xs);
const precisionAt = (xs: readonly ScoredTruth[], t: number) => {
  const yes = xs.filter((s) => s.leanedYes && s.confidence >= t);
  return yes.filter((s) => s.truth).length / yes.length;
};

const scored = await screen(new SimOracle({ accuracy: 0.85, seed: 11 }, truthOf));

describe("fitThreshold recall mode", () => {
  it("finds the lowest bar that keeps recall of includes at the target", () => {
    const fit = fitThreshold(scored, 0.95, 30, { mode: "recall" });
    expect(fit).toBeDefined();
    if (!fit) return;
    expect(fit.recall).toBeCloseTo(recallAt(scored, fit.threshold), 12);
    expect(fit.recall ?? 0).toBeGreaterThanOrEqual(0.95);
    expect(fit.precision).toBeCloseTo(precisionAt(scored, fit.threshold), 12);
    expect(fit.positives).toBe(positives(scored));
    // Lowest: the next distinct confidence below the bar breaks the target.
    const below = Math.max(...scored.map((s) => s.confidence).filter((c) => c < fit.threshold));
    expect(recallAt(scored, below)).toBeLessThan(0.95);
    // Coverage is the work saved, and agrees with coverageAt at the same bar.
    const at = coverageAt(scored, fit.threshold);
    expect(fit.coverage).toBeCloseTo(at.coverage, 12);
    expect(fit.n).toBe(at.n);
    expect(fit.accuracy).toBeCloseTo(at.accuracy, 12);
    expect(fit.coverage).toBeGreaterThan(0.1);
    expect(fit.coverage).toBeLessThan(0.95);
  });

  it("a stricter recall target needs a higher bar and saves less work", () => {
    const loose = fitThreshold(scored, 0.9, 30, { mode: "recall" });
    const strict = fitThreshold(scored, 0.99, 30, { mode: "recall" });
    expect(loose && strict).toBeTruthy();
    if (!loose || !strict) return;
    expect(strict.threshold).toBeGreaterThanOrEqual(loose.threshold);
    expect(strict.coverage).toBeLessThanOrEqual(loose.coverage);
    expect(strict.recall ?? 0).toBeGreaterThanOrEqual(0.99);
  });

  it("conservative recall rests on the Wilson lower bound", () => {
    const point = fitThreshold(scored, 0.95, 30, { mode: "recall" });
    const safe = fitThreshold(scored, 0.95, 30, { mode: "recall", conservative: true });
    expect(point && safe).toBeTruthy();
    expect(safe?.threshold ?? 0).toBeGreaterThanOrEqual(point?.threshold ?? 1);
    expect(safe?.coverage ?? 1).toBeLessThanOrEqual(point?.coverage ?? 0);
  });

  it("needs minSupport positives, and truth on every item", () => {
    // 40 documents hold 10 includes.
    expect(fitThreshold(scored.slice(0, 40), 0.95, 30, { mode: "recall" })).toBeUndefined();
    expect(fitThreshold(scored.slice(0, 40), 0.95, 5, { mode: "recall" })).toBeDefined();
    expect(() =>
      fitThreshold([{ confidence: 0.9, correct: true }], 0.9, 1, { mode: "recall" }),
    ).toThrow(/scoredWithTruth/);
  });

  it("returns undefined when even the highest bar loses too many includes", () => {
    const items: ScoredTruth[] = [
      { confidence: 0.99, correct: false, truth: true, leanedYes: false },
      { confidence: 0.6, correct: true, truth: true, leanedYes: true },
      { confidence: 0.6, correct: true, truth: false, leanedYes: false },
    ];
    expect(fitThreshold(items, 0.9, 1, { mode: "recall" })).toBeUndefined();
  });

  it("leaves accuracy mode as it was", () => {
    const plain = fitThreshold(scored, 0.95, 30);
    expect(plain).toEqual(fitThreshold(scored, 0.95, 30, { mode: "accuracy" }));
    expect(plain?.recall).toBeUndefined();
    expect(plain?.accuracy ?? 0).toBeGreaterThanOrEqual(0.95);
  });
});

describe("coverageAt", () => {
  it("reads coverage and accuracy at one bar", () => {
    const all = coverageAt(scored, 0);
    expect(all.coverage).toBe(1);
    expect(all.n).toBe(N);
    expect(all.accuracy).toBeCloseTo(mean(scored.map((s) => (s.correct ? 1 : 0))), 12);
    expect(coverageAt(scored, 1.01)).toEqual({ coverage: 0, accuracy: 0, n: 0 });
    expect(coverageAt([], 0.5)).toEqual({ coverage: 0, accuracy: 0, n: 0 });
  });

  it("agrees with the risk-coverage curve and the fitted bar", () => {
    for (const p of riskCoverage(scored).filter((_, i) => i % 50 === 0)) {
      const at = coverageAt(scored, p.threshold);
      expect(at.n).toBe(p.n);
      expect(at.accuracy).toBeCloseTo(p.accuracy, 12);
    }
    const fit = fitThreshold(scored, 0.95, 30);
    expect(fit).toBeDefined();
    if (fit)
      expect(coverageAt(scored, fit.threshold)).toEqual({
        coverage: fit.coverage,
        accuracy: fit.accuracy,
        n: fit.n,
      });
  });

  it("on a calibrated oracle, accuracy above a bar is at least the bar", () => {
    const at = coverageAt(scored, 0.9);
    expect(at.n).toBeGreaterThan(300);
    expect(at.accuracy).toBeGreaterThan(0.9);
  });
});

describe("scoredWithTruth", () => {
  const base = {
    id: "r",
    at: "2026-10-17T00:00:00.000Z",
    gateId: "screen.include",
    requestId: "q",
    questionId: "include",
    kind: "judge",
    prompt: "include?",
    questionHash: "h",
    stateHash: "s",
    trustedHash: "s",
    untrusted: [],
    oracle: "sim",
    strategy: "single",
    verdict: { kind: "judge", questionId: "include", pYes: 0.8, confidence: 0.8 },
    go: 0.8,
    confidence: 0.8,
    agreement: 1,
    soft: "review",
    action: "review",
    mode: "shadow",
    cost: 0,
    latencyMs: 0,
    failedOpen: false,
    tags: [],
  };
  const row = (over: Record<string, unknown>): DecisionRecord =>
    ({ ...base, ...over }) as unknown as DecisionRecord;
  const at = "2026-10-17T01:00:00.000Z";

  it("keeps labelled judge rows with a boolean truth and the oracle's lean", () => {
    const rows = [
      row({ id: "yes", outcome: { at, correct: true, truth: true } }),
      row({
        id: "no",
        verdict: { kind: "judge", questionId: "include", pYes: 0.3, confidence: 0.7 },
        confidence: 0.7,
        outcome: { at, correct: false, truth: true },
      }),
      row({ id: "unlabelled" }),
      row({ id: "string-truth", outcome: { at, correct: true, truth: "yes" } }),
      row({ id: "failed", failedOpen: true, outcome: { at, correct: true, truth: true } }),
      row({
        id: "pick",
        kind: "pick",
        verdict: {
          kind: "pick",
          questionId: "p",
          choice: "a",
          probabilities: { a: 0.9, b: 0.1 },
          confidence: 0.9,
        },
        outcome: { at, correct: true, truth: "a" },
      }),
      row({ id: "selected", mode: "enforce", outcome: { at, correct: true, truth: true } }),
    ];
    expect(scoredWithTruth(rows)).toEqual([
      { confidence: 0.8, correct: true, truth: true, leanedYes: true },
      { confidence: 0.7, correct: false, truth: true, leanedYes: false },
      { confidence: 0.8, correct: true, truth: true, leanedYes: true },
    ]);
    expect(scoredWithTruth(rows, { unselectedOnly: true })).toHaveLength(2);
  });
});
