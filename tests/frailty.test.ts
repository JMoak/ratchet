/**
 * The verifier frailty model (src/compound/frailty.ts).
 *
 * The figures come from the verified-chains research note (Foundations review 2026-11), fitted to
 * the live verifier track (e2e T2): 15.0% of first correct candidates held back, 55.9% of the
 * next held after a hold; chains finished 48 / 53 / 62 / 58% of the time. The research scripts
 * printed one or two decimals, so exact reproductions are asserted to half a unit of the last
 * printed digit.
 */
import { describe, expect, it } from "vitest";
import { readChainTags, runChain, type Step } from "../src/compound/chain.ts";
import {
  afterHolds,
  betaFrailty,
  completionInterval,
  escalateAfter,
  type Frailty,
  fitFrailty,
  frailtyCounts,
  frailtyFromRates,
  frailtyMoment,
  heldNext,
  holdRates,
  independentFrailty,
  predictChain,
  type StepCounts,
} from "../src/compound/frailty.ts";
import { Engine } from "../src/engine.ts";
import type { DecisionRecord } from "../src/ledger/ledger.ts";
import { MemoryLedger } from "../src/ledger/ledger.ts";
import { randBeta, rng } from "../src/math.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

const LIVE = { first: 0.15, again: 0.559 };
const live = frailtyFromRates(LIVE.first, LIVE.again);

/** |x - y| <= tol; tol is stated at every call. */
const near = (x: number, y: number, tol: number) =>
  expect(Math.abs(x - y)).toBeLessThanOrEqual(tol);

describe("the moment estimator", () => {
  it("fits the live rates: rho 0.481, a 0.162, b 0.917", () => {
    expect(live.mean).toBe(0.15);
    expect(live.rho).toBeCloseTo(0.481, 3);
    expect(live.a).toBeCloseTo(0.162, 3);
    expect(live.b).toBeCloseTo(0.917, 3);
    // Closed form: rho = (psi - mu) / (1 - mu), and the beta gives back psi and its third moment.
    expect(live.rho).toBeCloseTo(0.409 / 0.85, 12);
    expect(heldNext(live, 0)).toBeCloseTo(0.15, 12);
    expect(heldNext(live, 1)).toBeCloseTo(0.559, 12);
    expect(heldNext(live, 2)).toBeCloseTo((live.a + 2) / (live.a + live.b + 2), 12);
    near(heldNext(live, 2), 0.702, 0.0005);
    expect(frailtyMoment(live, 2)).toBeCloseTo(0.15 * 0.559, 12);
  });

  it("reads psi <= mu as no frailty: independent retries at mu", () => {
    for (const again of [0.15, 0.1, 0]) {
      const f = frailtyFromRates(0.15, again);
      expect(f).toEqual(independentFrailty(0.15));
      expect(f.rho).toBe(0);
      expect(f.a).toBe(Number.POSITIVE_INFINITY);
      const model = { p: 0.8, t: 0.95, attempts: 3, steps: 8 };
      // Independence is the textbook formula exactly: (1 - (1 - a)^m)^n.
      const a = 0.8 * 0.85 + 0.2 * 0.05;
      expect(predictChain(f, model).completion).toBeCloseTo((1 - (1 - a) ** 3) ** 8, 12);
      const iv = completionInterval({ first: 0.15, again }, model);
      expect(iv.optimistic).toBeCloseTo((1 - (1 - a) ** 3) ** 8, 12);
      expect(iv.pessimistic).toBeCloseTo(iv.optimistic, 12);
    }
  });

  it("has defined edges: no holds, every first held, every hold repeated", () => {
    expect(frailtyFromRates(0, 0.7)).toEqual(independentFrailty(0));
    expect(frailtyFromRates(1, 1)).toEqual(independentFrailty(1));
    // psi = 1: each instance is always or never held (the Bernoulli limit, a = b = 0).
    const all = frailtyFromRates(0.2, 1);
    expect(all).toMatchObject({ mean: 0.2, rho: 1, a: 0, b: 0 });
    expect(frailtyMoment(all, 5)).toBeCloseTo(0.2, 12);
    // With t = 1 such a chain exhausts exactly on the always-held instances, whatever the budget.
    const model = { p: 0.8, t: 1, attempts: 50, steps: 3 };
    expect(predictChain(all, model).completion).toBeCloseTo(0.8 ** 3, 9);
    // Every candidate held: no commit, up to the rounding of a 51-term sum.
    expect(predictChain(independentFrailty(1), model).completion).toBeCloseTo(0, 12);
    expect(predictChain(independentFrailty(0), { ...model, attempts: 1 }).completion).toBeCloseTo(
      0.8 ** 3,
      12,
    );
  });

  it("betaFrailty keeps the shapes it is given", () => {
    const f = betaFrailty(0.162, 0.917);
    expect(f).toMatchObject({ a: 0.162, b: 0.917 });
    expect(f.mean).toBeCloseTo(0.162 / 1.079, 12);
    expect(f.rho).toBeCloseTo(1 / 2.079, 12);
  });
});

describe("prediction under the beta", () => {
  const t2 = (p: number, attempts: number) => ({ p, t: 1, attempts, steps: 8, distinctCorrect: 3 });

  it("reproduces the live completion: 49.2 / 56.8 / 61.2 / 61.5%", () => {
    // The documented configuration: eight steps, catch rate 1 (270 of 270 held-out errors
    // caught), and three distinct correct candidates per step (the six-attempt arm replayed them).
    const cases = [
      [0.8, 3, 0.492, 0.766, 0.52],
      [0.9, 3, 0.568, 0.901, 0.612],
      [0.8, 6, 0.612, 0.969, 0.677],
      [0.9, 6, 0.615, 0.973, 0.681],
    ] as const;
    for (const [p, m, beta, independent, twoPoint] of cases) {
      // Half a unit of the research table's last printed digit (one decimal of a percent).
      near(predictChain(live, t2(p, m)).completion, beta, 0.0005);
      near(predictChain(independentFrailty(0.15), t2(p, m)).completion, independent, 0.0005);
      near(completionInterval(LIVE, t2(p, m)).optimistic, twoPoint, 0.0005);
    }
  });

  it("is exact at one and two attempts, and the interval is a point there", () => {
    const one = { p: 0.8, t: 1, attempts: 1, steps: 8 };
    // m = 1: a step commits with p (1 - mu) + (1 - p)(1 - t), whatever the law.
    expect(predictChain(live, one).completion).toBeCloseTo((0.8 * 0.85) ** 8, 12);
    const two = { ...one, attempts: 2 };
    // m = 2: E[h^2] = p^2 E[theta^2] + 2 p (1 - p) t mu + ((1 - p) t)^2, with E[theta^2] = mu psi.
    const e2 = 0.64 * 0.15 * 0.559 + 2 * 0.8 * 0.2 * 0.15 + 0.04;
    expect(predictChain(live, two).step.exhausts).toBeCloseTo(e2, 12);
    const iv = completionInterval(LIVE, two);
    expect(iv.optimistic).toBeCloseTo((1 - e2) ** 8, 12);
    expect(iv.pessimistic).toBeCloseTo((1 - e2) ** 8, 12);
  });

  it("gives the precision of commits by the closed form", () => {
    // One attempt: q = p (1 - f) / (p (1 - f) + (1 - p)(1 - t)), the ratchet's formula.
    const one = predictChain(live, { p: 0.8, t: 0.9, attempts: 1, steps: 5 });
    const q = (0.8 * 0.85) / (0.8 * 0.85 + 0.2 * 0.1);
    expect(one.precision).toBeCloseTo(q, 12);
    expect(one.allRight).toBeCloseTo((0.8 * 0.85) ** 5, 12);
    // Two independent attempts by hand: wrong commits come at attempt 1, or at 2 after a hold.
    const h = 0.8 * 0.15 + 0.2 * 0.9;
    const two = predictChain(independentFrailty(0.15), { p: 0.8, t: 0.9, attempts: 2, steps: 1 });
    expect(two.step.commits).toBeCloseTo(1 - h * h, 12);
    expect(two.step.commitsWrong).toBeCloseTo(0.2 * 0.1 * (1 + h), 12);
    expect(two.precision).toBeCloseTo(1 - (0.2 * 0.1 * (1 + h)) / (1 - h * h), 12);
    // t = 1: nothing wrong is ever committed.
    expect(predictChain(live, { p: 0.8, t: 1, attempts: 6, steps: 8 }).precision).toBe(1);
  });

  it("puts exhaustion on a power law in the attempts, not a geometric one", () => {
    // Table B of the note (p 0.8, t 1, fresh candidates): exhaustion to three decimals.
    const table: [number, number][] = [
      [1, 0.32],
      [2, 0.142],
      [3, 0.085],
      [6, 0.041],
      [12, 0.021],
      [24, 0.011],
      [48, 0.006],
      [96, 0.003],
    ];
    const ex = (m: number) =>
      predictChain(live, { p: 0.8, t: 1, attempts: m, steps: 8 }).step.exhausts;
    for (const [m, e] of table) near(ex(m), e, 0.0005);
    // Log-log slope between 48 and 96 attempts against the asymptote -b (note: -0.918 vs
    // -0.917); the gap is the next term of the expansion, so a hundredth is generous.
    near(Math.log(ex(96) / ex(48)) / Math.log(2), -live.b, 0.01);
    // Independence would square exhaustion per doubling; the beta roughly halves it.
    expect(ex(24) / ex(12)).toBeGreaterThan(0.5);
  });
});

describe("the completion interval from two rates", () => {
  const model = (attempts: number) => ({ p: 0.8, t: 1, attempts, steps: 8 });

  it("is [45.0%, 52.0%] at three attempts, around the beta's 49.2%", () => {
    const iv = completionInterval(LIVE, model(3));
    near(iv.pessimistic, 0.45, 0.0005);
    near(iv.optimistic, 0.52, 0.0005);
    const beta = predictChain(live, model(3)).completion;
    expect(beta).toBeGreaterThan(iv.pessimistic);
    expect(beta).toBeLessThan(iv.optimistic);
  });

  it("cannot certify more than 52.1% however many attempts are allowed", () => {
    const iv = completionInterval(LIVE, model(3));
    near(iv.limit.pessimistic, 0.521, 0.0005);
    expect(iv.limit.optimistic).toBe(1);
    // The extreme laws themselves: {0, 0.559} and {0.078, 1} with 0.078 on 1.
    expect(iv.laws.optimistic.map((x) => x.value)).toEqual([0, 0.559]);
    near(iv.laws.pessimistic[1]?.weight ?? 0, 0.078, 0.0005);
    // The pessimistic end approaches its limit from below as attempts grow, and both laws keep
    // the two moments.
    for (const m of [6, 12, 48]) {
      const at = completionInterval(LIVE, model(m));
      expect(at.pessimistic).toBeLessThanOrEqual(at.limit.pessimistic + 1e-12);
    }
    for (const law of [iv.laws.optimistic, iv.laws.pessimistic]) {
      const moment = (k: number) => law.reduce((s, x) => s + x.weight * x.value ** k, 0);
      expect(moment(1)).toBeCloseTo(0.15, 12);
      expect(moment(2)).toBeCloseTo(0.15 * 0.559, 12);
    }
  });

  it("brackets the beta at every budget", () => {
    for (const m of [3, 4, 6, 12, 24]) {
      const iv = completionInterval(LIVE, model(m));
      const beta = predictChain(live, model(m)).completion;
      expect(beta).toBeGreaterThanOrEqual(iv.pessimistic);
      expect(beta).toBeLessThanOrEqual(iv.optimistic);
    }
  });
});

describe("after k holds", () => {
  it("matches the research's posterior table at p 0.8, t 0.99", () => {
    const table: [number, number, number][] = [
      [0, 0.682, 0.9971],
      [1, 0.559, 0.9964],
      [2, 0.402, 0.995],
      [3, 0.279, 0.9928],
      [4, 0.206, 0.9903],
      [6, 0.138, 0.9855],
    ];
    for (const [k, commit, precision] of table) {
      const a = afterHolds(live, { p: 0.8, t: 0.99 }, k);
      near(a.commit, commit, 0.0005);
      near(a.precision, precision, 0.00005);
    }
    // k = 0 is the prior: E[theta] = mu.
    expect(afterHolds(live, { p: 0.8, t: 0.99 }, 0).falseAlarm).toBeCloseTo(0.15, 12);
    // t = 1: every commit is right.
    expect(afterHolds(live, { p: 0.8, t: 1 }, 5).precision).toBe(1);
  });

  it("never raises the commit chance or its precision as holds accumulate", () => {
    const frailties: Frailty[] = [
      live,
      betaFrailty(2, 3),
      betaFrailty(0.05, 0.24),
      frailtyFromRates(0.3, 1),
    ];
    for (const f of frailties) {
      for (const [p, t] of [
        [0.8, 0.99],
        [0.5, 0.9],
        [0.95, 1],
        [0.3, 0.6],
      ] as const) {
        let prev = afterHolds(f, { p, t }, 0);
        for (let k = 1; k <= 40; k++) {
          const next = afterHolds(f, { p, t }, k);
          // Monotone likelihood ratio: equal or smaller, up to rounding.
          expect(next.commit).toBeLessThanOrEqual(prev.commit + 1e-12);
          if (next.commit === 0) {
            // The holds have pinned an always-held instance with t = 1: no commit is possible,
            // and a precision of nothing is NaN, by definition.
            expect(next.precision).toBeNaN();
            break;
          }
          expect(next.precision).toBeLessThanOrEqual(prev.precision + 1e-12);
          prev = next;
        }
      }
    }
  });

  it("escalates by the one-step look-ahead rule, and keeps escalating once it fires", () => {
    const at = (ratio: number) =>
      escalateAfter(live, { p: 0.8, t: 0.99, costRetry: 1, costEscalate: ratio, maxHolds: 60 });
    expect([3, 10, 30, 100, 300].map(at)).toEqual([3, 9, 29, undefined, undefined]);
    // By hand: escalate at the first k with pi_k <= 1/3; pi_2 = 40.2% > 33.3% >= pi_3 = 27.9%.
    expect(afterHolds(live, { p: 0.8, t: 0.99 }, 2).commit).toBeGreaterThan(1 / 3);
    expect(afterHolds(live, { p: 0.8, t: 0.99 }, 3).commit).toBeLessThanOrEqual(1 / 3);
    // The precision rule: q_1 = 99.64% >= 99.6% > q_2 = 99.50%; at 99%, q_4 = 99.03 > q_5 = 98.78.
    const precise = (minPrecision: number) =>
      escalateAfter(live, { p: 0.8, t: 0.99, costRetry: 0, costEscalate: 1, minPrecision });
    expect(precise(0.996)).toBe(2);
    expect(precise(0.99)).toBe(5);
    // Whichever rule fires first.
    expect(
      escalateAfter(live, {
        p: 0.8,
        t: 0.99,
        costRetry: 1,
        costEscalate: 30,
        minPrecision: 0.99,
      }),
    ).toBe(5);
    // Once a rule fires at k, it fires at every later k (the monotone case).
    for (let k = 3; k <= 30; k++) {
      expect(afterHolds(live, { p: 0.8, t: 0.99 }, k).commit).toBeLessThanOrEqual(1 / 3);
    }
    // A retry as dear as escalation never pays.
    expect(escalateAfter(live, { p: 0.8, t: 0.99, costRetry: 5, costEscalate: 5 })).toBe(0);
  });
});

describe("the likelihood estimator", () => {
  const rep = (held: number, passed: number, n: number): StepCounts[] =>
    Array.from({ length: n }, () => ({ held, passed }));

  it("matches an independent Nelder-Mead fit of the held-out instances", () => {
    // Held-out split, three correct candidates per instance, every one judged. At bar 0.48:
    // instances with 0/1/2/3 held 42/4/1/7, research fit a 0.050, b 0.239, ICC 0.776, mean 0.172.
    const low = fitFrailty([...rep(0, 3, 42), ...rep(1, 2, 4), ...rep(2, 1, 1), ...rep(3, 0, 7)]);
    near(low.a, 0.05, 0.0005);
    near(low.b, 0.239, 0.0005);
    near(low.rho, 0.776, 0.0005);
    near(low.mean, 0.172, 0.0005);
    expect(low).toMatchObject({ instances: 54, informative: 54 });
    // At bar 0.9: 18/13/8/15, research fit a 0.506, b 0.591.
    const high = fitFrailty([
      ...rep(0, 3, 18),
      ...rep(1, 2, 13),
      ...rep(2, 1, 8),
      ...rep(3, 0, 15),
    ]);
    near(high.a, 0.506, 0.0005);
    near(high.b, 0.591, 0.0005);
    for (const fit of [low, high]) {
      expect(fit.interval.lower).toBeLessThan(fit.rho);
      expect(fit.interval.upper).toBeGreaterThan(fit.rho);
    }
  });

  it("recovers a and b from chain-shaped data, where the naive rate is biased", () => {
    // Steps stop at the first pass, as runChain does: retries exist only after holds. 20,000
    // instances at the live fit, p 0.8, t 1, up to six fresh attempts. Seed fixed in advance.
    const truth = live;
    const rand = rng(20261112);
    const counts: StepCounts[] = [];
    for (let i = 0; i < 20000; i++) {
      const theta = randBeta(truth.a, truth.b, rand);
      let held = 0;
      let passed = 0;
      for (let a = 0; a < 6 && passed === 0; a++) {
        if (rand() >= 0.8) continue; // a wrong candidate, always caught: no evidence on theta
        if (rand() < theta) held++;
        else passed++;
      }
      counts.push({ held, passed });
    }
    const fit = fitFrailty(counts);
    // The 95% profile interval covers the truth, and is narrow enough for that to mean something:
    // about 3,000 informative instances pin rho to a few hundredths.
    expect(fit.interval.lower).toBeLessThanOrEqual(truth.rho);
    expect(fit.interval.upper).toBeGreaterThanOrEqual(truth.rho);
    expect(fit.interval.upper - fit.interval.lower).toBeLessThan(0.05);
    // The mean's standard error here is about 0.003 (about 20,000 first correct candidates at
    // 15%, inflated by the frailty); four of them.
    near(fit.mean, truth.mean, 0.012);
    // The shapes follow from (mu, rho): rho's half-width (about 0.015) moves a + b = 1/rho - 1 by
    // about 6%, and four standard errors of the mean move a by about 8% more; 15% covers both.
    expect(Math.abs(fit.a / truth.a - 1)).toBeLessThan(0.15);
    expect(Math.abs(fit.b / truth.b - 1)).toBeLessThan(0.15);
    // The naive realised false alarm over every judged correct candidate reads well above mu:
    // retries over-represent the instances the verifier dislikes (live: 21% to 23% against 15%).
    const held = counts.reduce((s, c) => s + c.held, 0);
    const judged = counts.reduce((s, c) => s + c.held + c.passed, 0);
    expect(held / judged).toBeGreaterThan(truth.mean + 0.05);
  });

  it("says when rho is not identified", () => {
    // One candidate per instance carries no information about rho: the interval is all of it.
    const single = fitFrailty([...rep(1, 0, 15), ...rep(0, 1, 85)]);
    expect(single.mean).toBeCloseTo(0.15, 6);
    expect(single.informative).toBe(0);
    expect(single.interval.lower).toBe(0);
    expect(single.interval.upper).toBe(1);
    // No holds at all: the point mass at 0.
    expect(fitFrailty(rep(0, 2, 10))).toMatchObject({
      mean: 0,
      rho: 0,
      interval: { lower: 0, upper: 1 },
    });
    expect(fitFrailty(rep(2, 0, 10))).toMatchObject({ mean: 1, rho: 0 });
    // Independent holds fit rho at or near 0, and the interval reaches 0.
    const rand = rng(7);
    const flat: StepCounts[] = Array.from({ length: 5000 }, () => {
      let held = 0;
      for (let j = 0; j < 3; j++) if (rand() < 0.2) held++;
      return { held, passed: 3 - held };
    });
    const ind = fitFrailty(flat);
    expect(ind.interval.lower).toBe(0);
    expect(ind.rho).toBeLessThan(ind.interval.upper);
  });
});

describe("counts from a ledger", () => {
  const verified = judge("Did the step succeed?", { id: "step.ok" });
  /** Passes a candidate that says so; holds the rest. */
  const scripted: Oracle = {
    id: "scripted",
    decide: async (state, qs) =>
      qs.map((q) => ({
        verdict: judgeVerdictFrom(q as JudgeQuestion, state.includes("pass") ? 0.95 : 0.05),
        oracle: "scripted",
        latencyMs: 0,
        cost: 0,
        at: "2026-11-12T00:00:00.000Z",
      })),
  };

  it("reads per-instance counts and the two rates from a chain run through a gate", async () => {
    const engine = new Engine({
      oracle: scripted,
      ledger: new MemoryLedger(),
      seed: 1,
      mode: "enforce",
    });
    const gate = engine.gate({ id: "v", question: verified, policy: { actAbove: 0.5 } });
    const plan: Record<string, string[]> = {
      a: ["a1 ok", "a1 ok", "a2 ok pass"],
      b: ["b1 bad", "b2 ok", "b3 ok", "b4 ok"],
    };
    const step = (name: string): Step<string> => ({
      name,
      maxAttempts: plan[name]?.length ?? 1,
      propose: async (_s, attempt) => plan[name]?.[attempt - 1] ?? "",
      verify: async (_b, after, _n, tags) => gate.ask(after, { tags }),
    });
    const res = await runChain(
      "start",
      [step("a"), step("b")],
      { actAbove: 0.5 },
      {
        keyOf: (s) => s.replace(/ /g, "_"),
        runId: "run-1",
      },
    );
    expect(res.stopReason).toBe("exhausted");
    expect(res.trace[0]?.duplicates).toEqual([{ attempt: 2, key: "a1_ok", repeats: 1 }]);
    const rows = await engine.ledger.all();
    // Label every row by the candidate's truth: "ok" candidates achieved the step. The ledger
    // keeps no state by default; the candidate tag names it.
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      const truth = (readChainTags(r.tags)?.candidate ?? "").includes("ok");
      await engine.label(r.id, {
        correct: (r.verdict.kind === "judge" && r.verdict.pYes >= 0.5) === truth,
        truth,
      });
    }
    const labelled = await engine.ledger.all();
    expect(labelled.every((r) => r.outcome !== undefined)).toBe(true);
    const counts = frailtyCounts(labelled);
    expect(counts.instances).toEqual([
      { step: "a", instance: "a@start", held: 1, passed: 1 },
      { step: "b", instance: "b@a2_ok_pass", held: 3, passed: 0 },
    ]);
    expect(counts.rates).toEqual({
      first: 2,
      firstHeld: 2,
      second: 2,
      secondHeld: 1,
      third: 1,
      thirdHeld: 1,
    });
    expect(counts.skipped.wrong).toBe(1);
    expect(holdRates(counts.rates)).toEqual({ first: 1, again: 0.5, third: 1 });
    const fit = fitFrailty(counts.instances);
    expect(fit.instances).toBe(2);
  });

  /** A hand-built chain row; only the fields the reader reads matter. */
  function row(over: Partial<DecisionRecord> & { tags: readonly string[] }): DecisionRecord {
    return {
      id: `r${Math.random()}`,
      at: "2026-11-12T00:00:00.000Z",
      gateId: "v",
      requestId: `q${Math.random()}`,
      questionId: "step.ok",
      kind: "judge",
      prompt: "Did the step succeed?",
      questionHash: "h",
      stateHash: "s",
      trustedHash: "s",
      untrusted: [],
      oracle: "o",
      strategy: "single",
      verdict: { kind: "judge", questionId: "step.ok", pYes: 0.1, confidence: 0.9 },
      go: 0.1,
      confidence: 0.9,
      agreement: 1,
      soft: "review",
      action: "review",
      mode: "enforce",
      cost: 0,
      latencyMs: 0,
      failedOpen: false,
      outcome: { at: "2026-11-12T00:00:00.000Z", correct: false, truth: true },
      ...over,
    };
  }
  const unlabelled = (r: DecisionRecord): DecisionRecord => {
    const { outcome: _label, ...rest } = r;
    return rest;
  };
  const tags = (attempt: number, candidate: string, extra: string[] = []) => [
    "chain",
    "chain:step:s",
    `chain:attempt:${attempt}`,
    "chain:run:r",
    "chain:instance:s@x",
    `chain:candidate:${candidate}`,
    ...extra,
  ];

  it("skips what is not evidence on theta, and counts each candidate once", () => {
    const pass = {
      verdict: { kind: "judge", questionId: "step.ok", pYes: 0.9, confidence: 0.9 },
      go: 0.9,
      soft: "act",
      action: "act",
    } as const;
    const rows = [
      row({ tags: tags(1, "c1") }),
      row({ tags: tags(1, "c1", ["chain:tier:second"]), ...pass }), // second opinion
      row({ tags: tags(2, "c1") }), // the same candidate again (a replay)
      row({ tags: tags(3, "c2"), failedOpen: true }),
      row({ tags: tags(4, "w1"), outcome: { at: "t", correct: true, truth: false } }), // wrong
      row({
        tags: tags(5, "c3"),
        outcome: { at: "t", correct: false, truth: true, source: "desk:assisted" },
      }),
      row({ tags: ["chain", "chain:step:s", "chain:attempt:6"] }), // no keyOf
      unlabelled(row({ tags: tags(7, "c5") })),
      row({ tags: tags(8, "c4"), ...pass }), // the last attempt of its run: its own row decides
    ];
    const counts = frailtyCounts(rows);
    expect(counts.instances).toEqual([{ step: "s", instance: "s@x", held: 1, passed: 1 }]);
    expect(counts.skipped).toEqual({
      untagged: 1,
      secondOpinion: 1,
      member: 0,
      failedOpen: 1,
      unlabelled: 2,
      wrong: 1,
      repeated: 1,
    });
    // A label given in the moment (desk:assisted) is not read by default; asked for, it is.
    const wide = frailtyCounts(rows, { sources: ["blind", "census", "unknown", "moment"] });
    expect(wide.instances[0]).toMatchObject({ held: 2, passed: 1 });
  });

  it("counts a row followed by a later attempt of its run as held, whatever the row says", () => {
    // A shadow gate asked with baseline act: the row says act; the chain's stricter bar held it.
    const shadow = { mode: "shadow", go: 0.7, soft: "act", action: "act" } as const;
    const rows = [row({ tags: tags(1, "c1"), ...shadow }), row({ tags: tags(2, "c2"), ...shadow })];
    expect(frailtyCounts(rows).instances[0]).toMatchObject({ held: 1, passed: 1 });
    // The caller can say how its chain ruled.
    expect(frailtyCounts(rows, { held: (r) => r.go < 0.8 }).instances[0]).toMatchObject({
      held: 2,
      passed: 0,
    });
    // A floor's hold reads as a hold in shadow too: soft act under a review floor.
    const floored = [
      row({ tags: tags(1, "c1"), mode: "shadow", soft: "act", action: "act", floor: "review" }),
    ];
    expect(frailtyCounts(floored).instances[0]).toMatchObject({ held: 1, passed: 0 });
  });

  it("filters by gate and step, and gives no rates before a second correct candidate", () => {
    const rows = [row({ tags: tags(1, "c1") }), row({ tags: tags(1, "c9"), gateId: "other" })];
    expect(frailtyCounts(rows, { gateId: "v" }).instances[0]).toMatchObject({ held: 1 });
    expect(frailtyCounts(rows, { step: "nope" }).instances).toEqual([]);
    expect(holdRates(frailtyCounts(rows, { gateId: "v" }).rates)).toBeUndefined();
  });
});

describe("validation", () => {
  const model = { p: 0.8, t: 1, attempts: 3, steps: 8 };
  it("refuses what is not a probability, a count or a shape", () => {
    expect(() => frailtyFromRates(Number.NaN, 0.5)).toThrow(/first must be a probability/);
    expect(() => frailtyFromRates(0.1, 1.5)).toThrow(/again must be a probability/);
    expect(() => independentFrailty(-0.1)).toThrow(/probability/);
    expect(() => betaFrailty(0, 1)).toThrow(/beta shape a/);
    expect(() => betaFrailty(1, Number.POSITIVE_INFINITY)).toThrow(/beta shape b/);
    for (const bad of [
      { p: 1.2 },
      { t: Number.NaN },
      { attempts: 0 },
      { attempts: 1.5 },
      { attempts: Number.POSITIVE_INFINITY },
      { steps: 0 },
      { distinctCorrect: 0 },
      { distinctCorrect: 2.5 },
    ]) {
      expect(() => predictChain(live, { ...model, ...bad }), JSON.stringify(bad)).toThrow(
        RangeError,
      );
      expect(() => completionInterval(LIVE, { ...model, ...bad })).toThrow(RangeError);
    }
    expect(() => afterHolds(live, { p: 0.8, t: 1 }, -1)).toThrow(/holds/);
    expect(() => frailtyMoment(live, 1.5)).toThrow(/k must be an integer/);
    expect(() => fitFrailty([])).toThrow(/at least one step instance/);
    expect(() => fitFrailty([{ held: 0, passed: 0 }])).toThrow(/at least one step instance/);
    expect(() => fitFrailty([{ held: -1, passed: 1 }])).toThrow(/held must be an integer/);
    expect(() => fitFrailty([{ held: 1, passed: 0.5 }])).toThrow(/passed must be an integer/);
    expect(() => fitFrailty([{ held: 1, passed: 1 }], { confidence: 1 })).toThrow(/confidence/);
    const esc = { p: 0.8, t: 0.99, costRetry: 1, costEscalate: 3 };
    expect(() => escalateAfter(live, { ...esc, costEscalate: 0 })).toThrow(/costEscalate/);
    expect(() => escalateAfter(live, { ...esc, costRetry: -1 })).toThrow(/costRetry/);
    expect(() => escalateAfter(live, { ...esc, minPrecision: 2 })).toThrow(/minPrecision/);
  });
});
