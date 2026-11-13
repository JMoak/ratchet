import { describe, expect, it } from "vitest";
import { requiredActs } from "../src/acceptance.ts";
import {
  anytimeLowerBound,
  DEMOTION_SHIFTS,
  type DetectorRule,
  type DetectorSpec,
  type DetectorState,
  demotionAlternatives,
  detectorStatistic,
  type ExactCrossing,
  exactCrossingProbability,
  FUTILITY_GRID,
  falseAlarmBound,
  fewestAlarmErrors,
  futile,
  futilityLogEValue,
  logEValue,
  outgoingQuality,
  outgoingQualityLimit,
  PROMOTION_GRID,
  promotes,
  startDetector,
  stepDetector,
  worstOutgoingQuality,
} from "../src/anytime.ts";
import { type Rand, rng, shuffled } from "../src/math.ts";

/** Standard error of a proportion estimated from n independent runs. */
const se = (p: number, n: number): number => Math.sqrt((p * (1 - p)) / n);

/** Mean and standard error of the mean. */
function summary(xs: readonly number[]): { mean: number; se: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { mean, se: Math.sqrt(variance / xs.length) };
}

/**
 * The promotion run computed directly: the probability of every (right, wrong) pair carried act
 * by act, asking the public predicates at every state. It shares no thresholds with
 * `exactCrossingProbability`, so agreement checks those thresholds.
 */
function directCrossing(
  p: number,
  promise: number,
  alpha: number,
  cap: number,
  futility?: { readonly worthKeeping: number; readonly beta: number },
): ExactCrossing {
  let mass = new Map<number, number>([[0, 1]]);
  let promote = 0;
  let retired = 0;
  let capped = 0;
  let meanActs = 0;
  for (let t = 1; t <= cap; t++) {
    const next = new Map<number, number>();
    for (const [f, m] of mass) {
      next.set(f, (next.get(f) ?? 0) + m * p);
      next.set(f + 1, (next.get(f + 1) ?? 0) + m * (1 - p));
    }
    mass = new Map();
    for (const [f, m] of next) {
      const s = t - f;
      if (promotes(s, f, promise, alpha)) promote += m;
      else if (futility && futile(s, f, futility.worthKeeping, futility.beta)) retired += m;
      else if (t === cap || !promotes(s + cap - t, f, promise, alpha)) capped += m;
      else {
        mass.set(f, m);
        continue;
      }
      meanActs += m * t;
    }
  }
  return { promote, futile: retired, capped, meanActs };
}

describe("promotion e-value", () => {
  it("bets on the research's log grid of error rates", () => {
    expect(PROMOTION_GRID).toHaveLength(12);
    expect(PROMOTION_GRID[0]).toBeCloseTo(0.025, 15);
    expect(PROMOTION_GRID[11]).toBeCloseTo(0.8, 15);
    // The note lists the alternative error rates at a 98% promise to five decimals.
    const listed = [
      0.0005, 0.00069, 0.00094, 0.00129, 0.00176, 0.00242, 0.00331, 0.00454, 0.00622, 0.00852,
      0.01168, 0.016,
    ];
    PROMOTION_GRID.forEach((c, k) => {
      expect(c * (1 - 0.98)).toBeCloseTo(listed[k] as number, 5);
    });
  });

  it("is the mixture of likelihood ratios, whatever order the acts came in", () => {
    expect(logEValue(0, 0, 0.98)).toBeCloseTo(0, 14);
    const rand = rng(1);
    for (const [right, wrong, promise] of [
      [37, 2, 0.98],
      [5, 3, 0.9],
      [400, 4, 0.99],
    ] as const) {
      const acts = shuffled(
        [...Array<boolean>(right).fill(true), ...Array<boolean>(wrong).fill(false)],
        rand,
      );
      // Wealth of each bet, act by act, in a shuffled order; the e-value is their mean.
      const wealth = PROMOTION_GRID.map((c) => {
        const e = c * (1 - promise);
        return acts.reduce((w, x) => w * (x ? (1 - e) / promise : e / (1 - promise)), 1);
      });
      const mixture = wealth.reduce((a, b) => a + b, 0) / wealth.length;
      // Products of a few hundred factors agree with the log-space sum to rounding.
      expect(logEValue(right, wrong, promise)).toBeCloseTo(Math.log(mixture), 10);
    }
  });

  it("only bets that cannot win, on average, against a gate no better than its promise", () => {
    for (const p0 of [0.9, 0.98, 0.99]) {
      for (const c of PROMOTION_GRID) {
        const onRight = Math.exp(logEValue(1, 0, p0, [c]));
        const onWrong = Math.exp(logEValue(0, 1, p0, [c]));
        for (const p of [0, 0.5, p0 - 0.01, p0]) {
          // E_p[factor] = 1 + (p - p0)(q - p0)/(p0 (1 - p0)): at most 1, and exactly 1 at p0.
          expect(p * onRight + (1 - p) * onWrong).toBeLessThanOrEqual(1 + 1e-12);
        }
        expect(p0 * onRight + (1 - p0) * onWrong).toBeCloseTo(1, 12);
      }
    }
  });

  it("promotes after 179 clean acts at 98%, and a wrong act costs right acts instead of ending it", () => {
    const actsToPromote = [0, 1, 2, 3, 4].map((wrong) => {
      let right = 0;
      while (!promotes(right, wrong, 0.98, 0.05)) right++;
      return right + wrong;
    });
    // The research note's exact table.
    expect(actsToPromote).toEqual([179, 313, 430, 535, 632]);
  });

  it("contains the zero-error plan as the bet q = 1", () => {
    // q = 1 multiplies wealth by 1/p0 for each right act (and by 0 at a wrong one), so it
    // reaches 1/alpha exactly at the zero-error plan's sample size.
    for (const p0 of [0.8, 0.9, 0.95, 0.98, 0.99, 0.995, 0.999]) {
      for (const alpha of [0.01, 0.05, 0.1]) {
        const n = requiredActs(p0, 1 - alpha, 0);
        for (let k = Math.max(1, n - 3); k <= n + 3; k++) {
          expect((1 / p0) ** k >= 1 / alpha).toBe(k >= n);
        }
        // A single bet on a near-perfect gate (q = 1 - 1e-9) is the same test before any error.
        let clean = 0;
        while (!promotes(clean, 0, p0, alpha, [1e-9])) clean++;
        expect(clean).toBe(n);
      }
    }
    expect(requiredActs(0.98, 0.95, 0)).toBe(149);
  });

  it("refuses alternatives that are not better than the promise, and malformed counts", () => {
    for (const bad of [[0], [1], [1.5], [-0.1], [Number.NaN], []]) {
      expect(() => logEValue(10, 0, 0.98, bad)).toThrow();
    }
    for (const [right, wrong] of [
      [-1, 0],
      [1.5, 0],
      [0, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
    ] as const) {
      expect(() => logEValue(right, wrong, 0.98)).toThrow();
    }
    for (const promise of [0, 1, -0.5, Number.NaN, "0.98" as unknown as number]) {
      expect(() => logEValue(1, 0, promise)).toThrow();
    }
    for (const alpha of [0, 1, 2]) expect(() => promotes(200, 0, 0.98, alpha)).toThrow();
  });
});

describe("exactCrossingProbability", () => {
  it("holds false promotions at or below alpha at the promise, at every cap", () => {
    for (const p0 of [0.9, 0.95, 0.98, 0.99]) {
      for (const cap of [313, 1000]) {
        expect(exactCrossingProbability(p0, p0, 0.05, cap).promote).toBeLessThanOrEqual(0.05);
        expect(exactCrossingProbability(p0, p0, 0.01, cap).promote).toBeLessThanOrEqual(0.01);
      }
    }
    // The research note's exact type I errors at 98% (table 4.1b), in percent to three places.
    const at = (cap: number) => exactCrossingProbability(0.98, 0.98, 0.05, cap).promote;
    expect(at(149)).toBe(0);
    expect(at(313)).toBeCloseTo(0.03344, 5);
    expect(at(600)).toBeCloseTo(0.03785, 5);
    expect(at(1000)).toBeCloseTo(0.04129, 5);
    expect(at(5000)).toBeCloseTo(0.04629, 5);
  });

  it("agrees with a programme that asks the predicates at every state", () => {
    const futility = { worthKeeping: 0.99, beta: 0.1 } as const;
    for (const p of [0.97, 0.98, 0.995]) {
      for (const cap of [313, 600]) {
        for (const options of [{}, { futility }]) {
          const fast = exactCrossingProbability(p, 0.98, 0.05, cap, options);
          const direct = directCrossing(
            p,
            0.98,
            0.05,
            cap,
            "futility" in options ? futility : undefined,
          );
          expect(fast.promote).toBeCloseTo(direct.promote, 12);
          expect(fast.futile).toBeCloseTo(direct.futile, 12);
          expect(fast.capped).toBeCloseTo(direct.capped, 12);
          expect(fast.meanActs).toBeCloseTo(direct.meanActs, 9);
        }
      }
    }
  });

  it("reproduces the recommended test's exact figures: the mixture with the reverse test", () => {
    const futility = { worthKeeping: 0.99, beta: 0.1 } as const;
    // Research note table 4.1a, column (d), and 4.1c: cap 600, P(promote) in percent to two
    // places, P(retired) to one, mean acts rounded.
    const expected = [
      [0.97, 0.0048, 0.358, 122],
      [0.98, 0.0378, 0.16, 186],
      [0.985, 0.1149, 0.083, 236],
      [0.99, 0.3413, 0.031, 292],
      [0.995, 0.7919, 0.006, 297],
      [0.999, 0.9984, 0, 205],
    ] as const;
    for (const [p, promote, retired, acts] of expected) {
      const r = exactCrossingProbability(p, 0.98, 0.05, 600, { futility });
      expect(r.promote).toBeCloseTo(promote, 4);
      expect(r.futile).toBeCloseTo(retired, 3);
      expect(Math.round(r.meanActs)).toBe(acts);
      expect(r.promote + r.futile + r.capped).toBeCloseTo(1, 12);
    }
    // Without the reverse test, 4.1c: 34.18% at 0.99 and 96.31% at 0.995 with a cap of 1,000.
    expect(exactCrossingProbability(0.99, 0.98, 0.05, 600).promote).toBeCloseTo(0.3418, 4);
    expect(exactCrossingProbability(0.995, 0.98, 0.05, 1000).promote).toBeCloseTo(0.9631, 4);
  });

  it("promotes more often the better the gate", () => {
    const futility = { worthKeeping: 0.99, beta: 0.1 } as const;
    for (const options of [{}, { futility }]) {
      let previous = -1;
      for (let p = 0.95; p <= 0.9995; p += 0.0025) {
        const promote = exactCrossingProbability(p, 0.98, 0.05, 600, options).promote;
        expect(promote).toBeGreaterThan(previous);
        previous = promote;
      }
    }
  });

  it("lets a futility test remove promotions but never add one", () => {
    for (const p of [0.97, 0.98, 0.99, 0.995]) {
      for (const cap of [313, 1000]) {
        const plain = exactCrossingProbability(p, 0.98, 0.05, cap);
        const withFutility = exactCrossingProbability(p, 0.98, 0.05, cap, {
          futility: { worthKeeping: 0.99, beta: 0.1 },
        });
        expect(plain.futile).toBe(0);
        expect(withFutility.promote).toBeLessThanOrEqual(plain.promote);
        expect(withFutility.meanActs).toBeLessThanOrEqual(plain.meanActs);
      }
    }
  });

  it("stops at once when the cap cannot be reached, and at the threshold when it can", () => {
    expect(exactCrossingProbability(1, 0.98, 0.05, 178)).toEqual({
      promote: 0,
      futile: 0,
      capped: 1,
      meanActs: 0,
    });
    expect(exactCrossingProbability(1, 0.98, 0.05, 179)).toEqual({
      promote: 1,
      futile: 0,
      capped: 0,
      meanActs: 179,
    });
    const allWrong = exactCrossingProbability(0, 0.98, 0.05, 1000);
    expect(allWrong.promote).toBe(0);
    expect(allWrong.capped).toBe(1);
  });

  it("refuses out-of-range inputs", () => {
    expect(() => exactCrossingProbability(-0.1, 0.98, 0.05, 313)).toThrow();
    expect(() => exactCrossingProbability(1.1, 0.98, 0.05, 313)).toThrow();
    expect(() => exactCrossingProbability(0.99, 1, 0.05, 313)).toThrow();
    expect(() => exactCrossingProbability(0.99, 0.98, 0, 313)).toThrow();
    expect(() => exactCrossingProbability(0.99, 0.98, 0.05, 0)).toThrow();
    expect(() => exactCrossingProbability(0.99, 0.98, 0.05, 312.5)).toThrow();
    expect(() =>
      exactCrossingProbability(0.99, 0.98, 0.05, 313, {
        futility: { worthKeeping: 0.99, beta: 0 },
      }),
    ).toThrow();
    expect(() =>
      exactCrossingProbability(0.99, 0.98, 0.05, 313, {
        futility: { worthKeeping: 0.99, beta: 0.1, grid: [0.5] },
      }),
    ).toThrow();
  });
});

describe("anytimeLowerBound", () => {
  it("matches the research note's bounds", () => {
    for (const [right, wrong, bound] of [
      [149, 0, 0.9761],
      [179, 0, 0.9801],
      [300, 0, 0.9881],
      [312, 1, 0.98],
      [500, 2, 0.9829],
      [1000, 5, 0.9856],
    ] as const) {
      expect(anytimeLowerBound(right, wrong, 0.05)).toBeCloseTo(bound, 4);
    }
  });

  it("is 0 before any right act", () => {
    expect(anytimeLowerBound(0, 0, 0.05)).toBe(0);
    expect(anytimeLowerBound(0, 7, 0.05)).toBe(0);
  });

  it("rests on an e-value that falls as the accuracy tested rises", () => {
    // The bisection needs the rejected accuracies to form an interval from 0. Checked
    // exhaustively on a grid of accuracies for counts from the empty sample to a long one.
    const xs = Array.from({ length: 2000 }, (_, i) => (i + 0.5) / 2000);
    for (const right of [1, 5, 50, 179, 400, 1000]) {
      for (const wrong of [0, 1, 3, 10]) {
        let previous = Number.POSITIVE_INFINITY;
        for (const x of xs) {
          const value = logEValue(right, wrong, x);
          expect(value).toBeLessThanOrEqual(previous + 1e-12);
          previous = value;
        }
      }
    }
  });

  it("agrees with the promotion test: promoting is the bound reaching the promise", () => {
    for (let right = 0; right <= 700; right += 7) {
      for (let wrong = 0; wrong <= 6; wrong++) {
        const bound = anytimeLowerBound(right, wrong, 0.05);
        for (const p0 of [0.9, 0.95, 0.98, 0.99]) {
          // Within the bisection's tolerance of a tie either answer is right.
          if (Math.abs(bound - p0) < 1e-9) continue;
          expect(promotes(right, wrong, p0, 0.05)).toBe(bound >= p0);
        }
      }
    }
  });

  it("falls with a wrong act and rises with a right one", () => {
    for (const right of [1, 10, 179, 500]) {
      for (const wrong of [0, 2, 5]) {
        const bound = anytimeLowerBound(right, wrong, 0.05);
        expect(anytimeLowerBound(right, wrong + 1, 0.05)).toBeLessThan(bound);
        expect(anytimeLowerBound(right + 1, wrong, 0.05)).toBeGreaterThan(bound);
      }
    }
  });

  it("exceeds the true accuracy at most alpha of the time, even when the reader stops on it", () => {
    // An analyst who reads the bound after every act and stops the first time it clears the
    // gate's true accuracy: optional stopping at its most aggressive.
    const p = 0.98;
    const alpha = 0.05;
    const acts = 1000;
    const runs = 4000;
    const memo = new Map<number, number>();
    const bound = (right: number, wrong: number): number => {
      const key = right * 4096 + wrong;
      let value = memo.get(key);
      if (value === undefined) {
        value = anytimeLowerBound(right, wrong, alpha);
        memo.set(key, value);
      }
      return value;
    };
    const rand = rng(20261112);
    let exceeded = 0;
    for (let run = 0; run < runs; run++) {
      let right = 0;
      let wrong = 0;
      for (let t = 0; t < acts; t++) {
        if (rand() < p) right++;
        else wrong++;
        if (bound(right, wrong) > p) {
          exceeded++;
          break;
        }
      }
    }
    const rate = exceeded / runs;
    // Ville's inequality bounds the true rate by alpha; a seeded estimate above alpha by more
    // than three standard errors would have probability under 0.2% if the bound held.
    expect(rate).toBeLessThanOrEqual(alpha + 3 * se(alpha, runs));
    // The bound clears p exactly when the e-value at p crosses, so the rate is the exact
    // crossing probability (4.13%); four standard errors of sampling noise either way.
    const exact = exactCrossingProbability(p, p, alpha, acts).promote;
    expect(Math.abs(rate - exact)).toBeLessThanOrEqual(4 * se(exact, runs));
  });

  it("refuses malformed inputs", () => {
    expect(() => anytimeLowerBound(-1, 0, 0.05)).toThrow();
    expect(() => anytimeLowerBound(10, 0.5, 0.05)).toThrow();
    expect(() => anytimeLowerBound(10, 0, 1)).toThrow();
    expect(() => anytimeLowerBound(10, 0, 0.05, [1])).toThrow();
  });
});

describe("futility", () => {
  it("bets on the research's alternatives below the accuracy worth keeping", () => {
    expect(FUTILITY_GRID).toEqual([1.5, 2, 3, 4, 6, 8]);
    const accuracies = FUTILITY_GRID.map((g) => 1 - g * (1 - 0.99));
    [0.985, 0.98, 0.97, 0.96, 0.94, 0.92].forEach((r, j) => {
      expect(accuracies[j]).toBeCloseTo(r, 12);
    });
  });

  it("fires where the research note says, at q_f = 0.99 and beta = 0.1", () => {
    const retiringWrong = [0, 50, 100, 150, 200, 250, 300, 350, 400].map((right) => {
      let wrong = 0;
      while (!futile(right, wrong, 0.99, 0.1)) wrong++;
      return wrong;
    });
    expect(retiringWrong).toEqual([2, 3, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("only bets that cannot win, on average, against a gate worth keeping", () => {
    for (const qf of [0.9, 0.99]) {
      for (const g of FUTILITY_GRID) {
        const onRight = Math.exp(futilityLogEValue(1, 0, qf, [g]));
        const onWrong = Math.exp(futilityLogEValue(0, 1, qf, [g]));
        for (const p of [qf, (qf + 1) / 2, 1]) {
          expect(p * onRight + (1 - p) * onWrong).toBeLessThanOrEqual(1 + 1e-12);
        }
      }
    }
  });

  it("retires a gate at the accuracy worth keeping at most beta of the time", () => {
    // Exact: the probability of every (right, wrong) pair, act by act, at p = q_f, the least
    // favourable gate the guarantee covers, stopping where `futile` fires.
    const retiredWithin = (qf: number, beta: number, acts: number): number => {
      let mass = new Map<number, number>([[0, 1]]);
      let retired = 0;
      for (let t = 1; t <= acts; t++) {
        const next = new Map<number, number>();
        for (const [f, m] of mass) {
          next.set(f, (next.get(f) ?? 0) + m * qf);
          next.set(f + 1, (next.get(f + 1) ?? 0) + m * (1 - qf));
        }
        mass = new Map();
        for (const [f, m] of next) {
          if (futile(t - f, f, qf, beta)) retired += m;
          else mass.set(f, m);
        }
      }
      return retired;
    };
    for (const [qf, beta] of [
      [0.99, 0.1],
      [0.99, 0.05],
      [0.95, 0.1],
    ] as const) {
      const retired = retiredWithin(qf, beta, 1500);
      expect(retired).toBeLessThanOrEqual(beta);
      expect(retired).toBeGreaterThan(0);
    }
  });

  it("refuses multiples that are no alternative", () => {
    for (const bad of [[1], [0.5], [12], []]) {
      expect(() => futilityLogEValue(0, 1, 0.9, bad)).toThrow();
    }
    // The default grid needs q_f above 7/8: 8 x 0.15 leaves no accuracy to bet on.
    expect(() => futilityLogEValue(0, 1, 0.85)).toThrow();
    expect(() => futile(0, 1, 0.99, 1)).toThrow();
  });
});

describe("demotion detector", () => {
  const spec: DetectorSpec = { promise: 0.98, threshold: 1000 };
  const feed = (s: DetectorSpec, outcomes: readonly boolean[]): DetectorState =>
    outcomes.reduce((state, wrong) => stepDetector(s, state, wrong), startDetector(s));

  /** The audit that raised the alarm, each wrong with probability `errorRate`; Infinity if none by `cap`. */
  const alarmAt = (s: DetectorSpec, errorRate: number, rand: Rand, cap: number): number => {
    let state = startDetector(s);
    while (!state.alarmed && state.audits < cap) state = stepDetector(s, state, rand() < errorRate);
    return state.alarmed ? state.audits : Number.POSITIVE_INFINITY;
  };

  it("bets on doubled, quadrupled and octupled error rates, capped for low promises", () => {
    expect(DEMOTION_SHIFTS).toEqual([2, 4, 8]);
    demotionAlternatives(0.98).forEach((e, k) => {
      expect(e).toBeCloseTo([0.04, 0.08, 0.16][k] as number, 12);
    });
    // The research's cap at (1 + e0)/2 keeps every post-change rate below 1.
    demotionAlternatives(0.8).forEach((e, k) => {
      expect(e).toBeCloseTo([0.4, 0.6, 0.6][k] as number, 12);
    });
    expect(() => demotionAlternatives(0.8, [2, 4, 8])).toThrow();
    expect(() => startDetector({ promise: 0.3, threshold: 100 })).not.toThrow();
  });

  it("updates by the Shiryaev-Roberts and CUSUM recursions", () => {
    const right = [0.96, 0.92, 0.84].map((q) => q / 0.98);
    const shifts = [2, 4, 8];
    const sr = feed(spec, [true, false, true]);
    const cu = feed({ ...spec, rule: "cusum" }, [true, false, true]);
    shifts.forEach((s, k) => {
      const r = right[k] as number;
      // SR: m <- L (m + 1); CUSUM: m <- L max(m, 1), both from 0.
      expect(sr.statistics[k]).toBeCloseTo(s * (r * (s + 1) + 1), 12);
      expect(cu.statistics[k]).toBeCloseTo(s * Math.max(r * s, 1), 12);
    });
    expect(detectorStatistic(sr)).toBeCloseTo(sr.statistics.reduce((a, b) => a + b, 0) / 3, 12);
    expect(sr.audits).toBe(3);
  });

  it("never puts CUSUM above Shiryaev-Roberts on the same audits", () => {
    const rand = rng(41);
    const outcomes = Array.from({ length: 3000 }, () => rand() < 0.02);
    const wide = { promise: 0.98, threshold: 1e15 };
    let sr = startDetector(wide);
    let cu = startDetector({ ...wide, rule: "cusum" });
    for (const wrong of outcomes) {
      sr = stepDetector(wide, sr, wrong);
      cu = stepDetector({ ...wide, rule: "cusum" }, cu, wrong);
      expect(detectorStatistic(cu)).toBeLessThanOrEqual(detectorStatistic(sr) * (1 + 1e-12));
    }
  });

  it("alarms after 4 consecutive audited errors at A = 1000, against 30 audits for the window rule", () => {
    // Research note table 4.2d.
    expect(fewestAlarmErrors(spec)).toBe(4);
    expect(fewestAlarmErrors({ ...spec, threshold: 300 })).toBe(4);
    expect(fewestAlarmErrors({ ...spec, threshold: 100 })).toBe(3);
    expect(fewestAlarmErrors({ ...spec, rule: "cusum" })).toBe(4);
    expect(fewestAlarmErrors({ ...spec, threshold: 100, rule: "cusum" })).toBe(3);
    // CUSUM against e1 = 0.05 alone.
    expect(fewestAlarmErrors({ ...spec, rule: "cusum", shifts: [2.5] })).toBe(8);
    // An error multiplies by the shift whatever the promise, so the count does not move with it.
    expect(fewestAlarmErrors({ promise: 0.95, threshold: 1000 })).toBe(4);
  });

  it("keeps false alarms within n audits under n/A for a gate exactly at its promise", () => {
    const runs = 2000;
    for (const [threshold, audits, seed] of [
      [1000, 200, 3],
      [100, 30, 4],
    ] as const) {
      const rand = rng(seed);
      const s = { promise: 0.98, threshold };
      let alarms = 0;
      for (let run = 0; run < runs; run++) {
        if (alarmAt(s, 0.02, rand, audits) <= audits) alarms++;
      }
      const bound = falseAlarmBound(audits, threshold);
      // The true rate is at most the bound; three standard errors of sampling noise above it.
      expect(alarms / runs).toBeLessThanOrEqual(bound + 3 * se(bound, runs));
    }
  });

  it("averages at least A audits to a false alarm for a gate exactly at its promise", () => {
    const threshold = 100;
    const s = { promise: 0.98, threshold };
    const rand = rng(5);
    const cap = 100 * threshold;
    // A run that reaches the cap counts as the cap, which can only pull the mean down.
    const lengths = Array.from({ length: 1000 }, () => Math.min(cap, alarmAt(s, 0.02, rand, cap)));
    const { mean, se: error } = summary(lengths);
    // The average run length is at least A; three standard errors of sampling noise below it.
    expect(mean).toBeGreaterThanOrEqual(threshold - 3 * error);
  });

  it("detects faster the further accuracy falls", () => {
    const rand = rng(6);
    // Every run alarms long before the cap: a drop to 95% is caught in about 160 audits.
    const delays = [0.05, 0.1, 0.2].map((errorRate) =>
      summary(Array.from({ length: 1000 }, () => alarmAt(spec, errorRate, rand, 1_000_000))),
    );
    for (let k = 1; k < delays.length; k++) {
      const slower = delays[k - 1] as { mean: number; se: number };
      const faster = delays[k] as { mean: number; se: number };
      // Four standard errors of the difference: the order is not sampling noise.
      expect(slower.mean - faster.mean).toBeGreaterThan(4 * Math.hypot(slower.se, faster.se));
    }
  });

  it("keeps its state as plain data, steps purely, and holds an alarm", () => {
    const state = feed(spec, [false, true, false]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const copy = structuredClone(state);
    stepDetector(spec, state, true);
    expect(state).toEqual(copy);
    const alarmed = feed(spec, [true, true, true, true]);
    expect(alarmed.alarmed).toBe(true);
    expect(stepDetector(spec, alarmed, false)).toEqual(alarmed);
    expect(alarmed.audits).toBe(4);
  });

  it("states the false-alarm bound", () => {
    expect(falseAlarmBound(200, 1000)).toBeCloseTo(0.2, 15);
    expect(falseAlarmBound(5000, 1000)).toBe(1);
    expect(() => falseAlarmBound(-1, 1000)).toThrow();
    expect(() => falseAlarmBound(10, 1)).toThrow();
  });

  it("refuses malformed specs and states", () => {
    for (const threshold of [1, 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => startDetector({ promise: 0.98, threshold })).toThrow();
    }
    expect(() => startDetector({ promise: 1, threshold: 1000 })).toThrow();
    for (const shifts of [[1], [0.5], [60], []]) {
      expect(() => startDetector({ promise: 0.98, threshold: 1000, shifts })).toThrow();
    }
    expect(() =>
      startDetector({ promise: 0.98, threshold: 1000, rule: "page" as unknown as DetectorRule }),
    ).toThrow();
    const fresh = startDetector(spec);
    expect(() => stepDetector(spec, { ...fresh, statistics: [0, 0] }, true)).toThrow();
    expect(() => stepDetector(spec, { ...fresh, statistics: [0, -1, 0] }, true)).toThrow();
    expect(() => stepDetector(spec, { ...fresh, audits: 1.5 }, true)).toThrow();
    expect(() => stepDetector(spec, fresh, 1 as unknown as boolean)).toThrow();
  });
});

describe("continuous sampling plan", () => {
  /**
   * The plan, decision by decision: shadow until `clearance` consecutive right acts, then enforce
   * with each act audited with probability f, back to shadow at the first audited error. `wrong`
   * decides whether the next act is wrong, given the phase.
   */
  function runPlan(
    wrong: (shadow: boolean) => boolean,
    clearance: number,
    f: number,
    decisions: number,
    rand: Rand,
  ): { readonly outgoing: number; readonly precision: number } {
    let shadow = true;
    let run = 0;
    let executed = 0;
    let wrongExecuted = 0;
    for (let t = 0; t < decisions; t++) {
      const isWrong = wrong(shadow);
      if (shadow) {
        run = isWrong ? 0 : run + 1;
        if (run >= clearance) shadow = false;
      } else if (rand() < f) {
        if (isWrong) {
          shadow = true;
          run = 0;
        }
      } else {
        executed++;
        if (isWrong) wrongExecuted++;
      }
    }
    return { outgoing: wrongExecuted / decisions, precision: wrongExecuted / executed };
  }

  it("matches the research: limit 0.479% near a 1.14% error rate, worst case 2.60%", () => {
    const { limit, at } = outgoingQualityLimit(149, 0.2);
    expect(limit).toBeCloseTo(0.00479, 5);
    // The research scanned error rates in steps of 0.0001.
    expect(Math.abs(at - 0.0114)).toBeLessThan(1e-4);
    expect(worstOutgoingQuality(149, 0.2)).toBeCloseTo(4 / 154, 15);
    expect(worstOutgoingQuality(149, 0.2)).toBeCloseTo(0.026, 3);
  });

  it("finds the maximum over error rates, below the worst case", () => {
    for (const clearance of [59, 149, 313]) {
      for (const f of [0.05, 0.1, 0.2, 0.5]) {
        const { limit, at } = outgoingQualityLimit(clearance, f);
        let scanned = 0;
        for (let p = 1e-5; p < 0.5; p += 1e-5) {
          scanned = Math.max(scanned, outgoingQuality(p, clearance, f));
        }
        expect(scanned).toBeLessThanOrEqual(limit * (1 + 1e-12));
        // A scan in steps of 1e-5 near a smooth maximum misses it by far less than this.
        expect(scanned).toBeGreaterThan(limit * (1 - 1e-4));
        expect(outgoingQuality(at, clearance, f)).toBe(limit);
        expect(worstOutgoingQuality(clearance, f)).toBeGreaterThan(limit);
      }
    }
  });

  it("matches a seeded simulation of the plan, and is not the precision of executed acts", () => {
    const clearance = 149;
    const f = 0.2;
    const rand = rng(77);
    for (const p of [0.005, 0.0114, 0.03]) {
      const reps = Array.from({ length: 20 }, () =>
        runPlan(() => rand() < p, clearance, f, 200_000, rand),
      );
      const outgoing = summary(reps.map((r) => r.outgoing));
      // Twenty independent replications give the standard error; four of them either way.
      expect(Math.abs(outgoing.mean - outgoingQuality(p, clearance, f))).toBeLessThanOrEqual(
        4 * outgoing.se,
      );
      // Each executed act is still wrong with probability p: the plan limits volume, not quality.
      const precision = summary(reps.map((r) => r.precision));
      expect(Math.abs(precision.mean - p)).toBeLessThanOrEqual(4 * precision.se);
    }
  });

  it("is attained in the worst case by errors that come only in enforce", () => {
    const rand = rng(78);
    for (const [clearance, f] of [
      [149, 0.2],
      [59, 0.1],
    ] as const) {
      const reps = Array.from({ length: 20 }, () =>
        runPlan((shadow) => !shadow, clearance, f, 200_000, rand),
      );
      const outgoing = summary(reps.map((r) => r.outgoing));
      expect(Math.abs(outgoing.mean - worstOutgoingQuality(clearance, f))).toBeLessThanOrEqual(
        4 * outgoing.se,
      );
    }
  });

  it("handles the edges and refuses malformed plans", () => {
    expect(outgoingQuality(0, 149, 0.2)).toBe(0);
    expect(outgoingQuality(1, 149, 0.2)).toBe(0);
    expect(outgoingQuality(0.01, 149, 1)).toBe(0);
    expect(worstOutgoingQuality(149, 1)).toBe(0);
    expect(() => outgoingQuality(-0.1, 149, 0.2)).toThrow();
    expect(() => outgoingQuality(1.1, 149, 0.2)).toThrow();
    expect(() => outgoingQuality(0.01, 0, 0.2)).toThrow();
    expect(() => outgoingQuality(0.01, 1.5, 0.2)).toThrow();
    expect(() => outgoingQualityLimit(149, 0)).toThrow();
    expect(() => worstOutgoingQuality(149, 1.2)).toThrow();
  });
});
