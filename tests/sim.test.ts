import { describe, expect, it } from "vitest";
import {
  ece,
  errorCorrelation,
  fitIsotonic,
  fitThresholdByCost,
  type Scored,
} from "../src/ledger/calibration.ts";
import { mean } from "../src/math.ts";
import { SimOracle, type Truth } from "../src/oracles/sim.ts";
import { judge, pick } from "../src/questions.ts";

const N = 4000;
const items = Array.from({ length: N }, (_, i) => `item-${i}`);
const truths = new Map<string, Truth>(
  items.map((s, i) => [s, { judge: i % 3 !== 0, pick: ["a", "b", "c", "d"][i % 4] as string }]),
);
const truthOf = (s: string) => truths.get(s);
const q = judge("is it?", { id: "j" });
const pq = pick("which?", ["a", "b", "c", "d"], { id: "p" });

async function score(oracle: SimOracle): Promise<Scored[]> {
  const out: Scored[] = [];
  for (const s of items) {
    const [d] = await oracle.decide(s, [q]);
    const v = d?.verdict;
    if (v?.kind !== "judge") throw new Error("bad");
    const lean = v.pYes >= 0.5;
    out.push({ confidence: v.confidence, correct: lean === truths.get(s)?.judge });
  }
  return out;
}

describe("SimOracle", () => {
  it("hits its accuracy and is calibrated at temperature 1", async () => {
    const scored = await score(new SimOracle({ accuracy: 0.8, seed: 7 }, truthOf));
    expect(mean(scored.map((s) => (s.correct ? 1 : 0)))).toBeCloseTo(0.8, 1);
    expect(ece(scored)).toBeLessThan(0.03);
  });
  it("is overconfident above temperature 1", async () => {
    const scored = await score(new SimOracle({ accuracy: 0.8, seed: 7, temperature: 3 }, truthOf));
    expect(ece(scored)).toBeGreaterThan(0.08);
    expect(mean(scored.map((s) => s.confidence))).toBeGreaterThan(0.88);
  });
  it("repeated calls are independent at rho=0 and identical at rho=1", async () => {
    for (const [rho, lo, hi] of [
      [0, -0.08, 0.08],
      [1, 0.999, 1],
    ] as const) {
      const o = new SimOracle({ accuracy: 0.8, seed: 3, correlation: rho }, truthOf);
      const pairs: { a: boolean; b: boolean }[] = [];
      for (const s of items.slice(0, 2000)) {
        const [d1] = await o.decide(s, [q]);
        const [d2] = await o.decide(s, [q]);
        const t = truths.get(s)?.judge;
        const c = (v: typeof d1) => v?.verdict.kind === "judge" && v.verdict.pYes >= 0.5 === t;
        pairs.push({ a: c(d1), b: c(d2) });
      }
      const phi = errorCorrelation(pairs);
      expect(phi).toBeGreaterThanOrEqual(lo);
      expect(phi).toBeLessThanOrEqual(hi);
    }
  });
  it("pick answers land on the truth at the configured rate", async () => {
    const o = new SimOracle({ accuracy: 0.8, seed: 11 }, truthOf);
    let right = 0;
    for (const s of items) {
      const [d] = await o.decide(s, [pq]);
      if (d?.verdict.kind === "pick" && d.verdict.choice === truths.get(s)?.pick) right++;
    }
    expect(right / N).toBeCloseTo(0.8, 1);
  });
  it("position bias drags low-confidence picks to the first option", async () => {
    const o = new SimOracle({ accuracy: 0.6, seed: 5, positionBias: 0.4 }, truthOf);
    let firsts = 0;
    for (const s of items.slice(0, 1000)) {
      const [d] = await o.decide(s, [pq]);
      if (d?.verdict.kind === "pick" && d.verdict.choice === "a") firsts++;
    }
    expect(firsts / 1000).toBeGreaterThan(0.4);
  });
});

describe("isotonic recalibration", () => {
  it("repairs an overconfident oracle out of sample", async () => {
    const scored = await score(new SimOracle({ accuracy: 0.8, seed: 21, temperature: 3 }, truthOf));
    const fit = scored.slice(0, 2000);
    const test = scored.slice(2000);
    const cal = fitIsotonic(fit);
    expect(cal).toBeDefined();
    const before = ece(test);
    const after = ece(
      test.map((s) => ({
        confidence: cal?.apply(s.confidence) ?? s.confidence,
        correct: s.correct,
      })),
    );
    expect(before).toBeGreaterThan(0.08);
    expect(after).toBeLessThan(before / 2);
    const ps = cal?.blocks.map((b) => b.p) ?? [];
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1] ?? 0);
    expect(fitIsotonic(scored.slice(0, 10))).toBeUndefined();
  });
});

describe("cost-aware threshold fitting", () => {
  it("moves the bar when the oracle is miscalibrated and keeps the Bayes bar when it is not", async () => {
    const over = await score(new SimOracle({ accuracy: 0.8, seed: 41, temperature: 3 }, truthOf));
    const fitOver = fitThresholdByCost(over, 20, 1);
    expect(fitOver).toBeDefined();
    expect(fitOver?.accepted).toBe(true);
    expect(fitOver?.threshold ?? 0).toBeGreaterThan(fitOver?.baselineThreshold ?? 1);
    expect(fitOver?.cost ?? 1).toBeLessThan(fitOver?.baselineCost ?? 0);

    const fair = await score(new SimOracle({ accuracy: 0.8, seed: 42 }, truthOf));
    const fitFair = fitThresholdByCost(fair, 20, 1);
    expect(fitFair).toBeDefined();
    expect(Math.abs((fitFair?.threshold ?? 0) - (fitFair?.baselineThreshold ?? 0))).toBeLessThan(
      0.08,
    );
    expect(fitThresholdByCost(fair.slice(0, 5), 20, 1)).toBeUndefined();
  });
});
