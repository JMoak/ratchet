import { describe, expect, it } from "vitest";
import { fitIsotonic, type Scored } from "../src/ledger/calibration.ts";
import { fitBeta, fitVennAbers } from "../src/ledger/calibrators.ts";
import { type Rand, randNormal, rng } from "../src/math.ts";

/**
 * The research's model I: 60% of rows are ones where acting is right, binormal scores with AUC
 * 0.95 (separation 2.326), stated probability sigmoid(z - 0.5). The stated probability is
 * underconfident at the top, as Jev was on the T1 tool calls.
 */
function modelI(n: number, rand: Rand): Scored[] {
  return Array.from({ length: n }, () => {
    const right = rand() < 0.6;
    const z = (right ? 2.326 : 0) + randNormal(rand);
    return { confidence: 1 / (1 + Math.exp(-(z - 0.5))), correct: right };
  });
}

/** Mean log loss, with p clipped to [1e-6, 1 - 1e-6] so an exact 0 or 1 is finite. */
function logLoss(rows: readonly Scored[], map: (p: number) => number): number {
  let total = 0;
  for (const r of rows) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, map(r.confidence)));
    total -= r.correct ? Math.log(p) : Math.log(1 - p);
  }
  return total / rows.length;
}

const median = (xs: readonly number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] as number;
};

/** A separable sample: every right row above every wrong one. */
const separable: Scored[] = [
  ...[0.8, 0.85, 0.9, 0.95, 0.99].map((confidence) => ({ confidence, correct: true })),
  ...[0.01, 0.1, 0.2, 0.3, 0.35].map((confidence) => ({ confidence, correct: false })),
];

const grid = Array.from({ length: 101 }, (_, i) => i / 100);

describe("beta calibration", () => {
  it("is the identity when there is nothing to learn", () => {
    for (const [rows, reason] of [
      [[], "no rows"],
      [Array.from({ length: 20 }, (_, i) => ({ confidence: i / 20, correct: true })), "one class"],
      [[{ confidence: 0.3, correct: false }], "one class"],
    ] as const) {
      const fit = fitBeta(rows);
      expect(fit).toMatchObject({ a: 1, b: 1, c: 0, converged: false, reason, n: rows.length });
      for (const p of [0.01, 0.3, 0.5, 0.9, 0.99]) expect(fit.apply(p)).toBeCloseTo(p, 12);
    }
  });

  it("recovers the identity on calibrated rows", () => {
    // Labels drawn at their stated probability. Over 30 seeds of 4,000 rows the largest gap
    // between the map and the identity on this grid was 0.035 (median 0.014).
    const rand = rng(4101);
    const rows = Array.from({ length: 4000 }, () => {
      const p = 0.02 + 0.96 * rand();
      return { confidence: p, correct: rand() < p };
    });
    const fit = fitBeta(rows);
    expect(fit.converged).toBe(true);
    expect(fit.reason).toBeUndefined();
    expect(fit.n).toBe(4000);
    let gap = 0;
    for (let p = 0.05; p <= 0.951; p += 0.05) gap = Math.max(gap, Math.abs(fit.apply(p) - p));
    expect(gap).toBeLessThan(0.05);
  });

  it("converges in a few Newton steps and reports a cap that comes first", () => {
    const rows = modelI(180, rng(4102));
    const fit = fitBeta(rows);
    expect(fit.converged).toBe(true);
    expect(fit.iterations).toBeLessThan(20);
    expect(Number.isFinite(fit.loss)).toBe(true);
    const capped = fitBeta(rows, { iterations: 0 });
    expect(capped).toMatchObject({ a: 1, b: 1, c: 0, converged: false, reason: "iteration cap" });
  });

  it("stays finite and strictly inside (0, 1) on separable rows", () => {
    const fit = fitBeta(separable);
    expect(fit.converged).toBe(true);
    for (const v of [fit.a, fit.b, fit.c]) expect(Number.isFinite(v)).toBe(true);
    for (const p of grid) {
      const q = fit.apply(p);
      expect(q).toBeGreaterThan(0);
      expect(q).toBeLessThan(1);
    }
    // The isotonic map on the same rows returns exact 0 and 1.
    const iso = fitIsotonic(separable, 1);
    expect(iso?.apply(0.05)).toBe(0);
    expect(iso?.apply(0.95)).toBe(1);
  });

  it("never reverses the order of stated probabilities", () => {
    // Rows where a higher stated probability is more often wrong: an unconstrained fit would
    // slope down. Both slopes are held at 0, which leaves a flat map at about the base rate.
    const rand = rng(4103);
    const rows = Array.from({ length: 200 }, () => {
      const p = rand();
      return { confidence: p, correct: rand() < 1 - p };
    });
    const fit = fitBeta(rows);
    expect(fit.a).toBeGreaterThanOrEqual(0);
    expect(fit.b).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < grid.length; i++) {
      expect(fit.apply(grid[i] as number)).toBeGreaterThanOrEqual(fit.apply(grid[i - 1] as number));
    }
  });

  it("refuses rows, options and queries out of range", () => {
    expect(() => fitBeta([{ confidence: Number.NaN, correct: true }])).toThrow(/row 0: confidence/);
    expect(() => fitBeta([{ confidence: 1.5, correct: true }])).toThrow(/row 0: confidence/);
    const bad = [{ confidence: 0.5, correct: 1 }] as unknown as Scored[];
    expect(() => fitBeta(bad)).toThrow(/row 0: correct must be a boolean/);
    expect(() => fitBeta(separable, { ridge: 0 })).toThrow(/ridge must be a positive number/);
    expect(() => fitBeta(separable, { ridge: Number.NaN })).toThrow(/ridge/);
    expect(() => fitBeta(separable, { iterations: -1 })).toThrow(/iterations/);
    expect(() => fitBeta(separable, { tolerance: 0 })).toThrow(/tolerance/);
    const fit = fitBeta(separable);
    expect(() => fit.apply(Number.NaN)).toThrow(/must be in \[0, 1\]/);
    expect(() => fit.apply(1.01)).toThrow(/must be in \[0, 1\]/);
  });
});

/** Isotonic regression with ties pooled, by brute force: the fitted value at `x` after adding (x, y). */
function naiveFitAt(rows: readonly Scored[], x: number, y: number): number {
  const all = [...rows.map((r) => ({ x: r.confidence, y: r.correct ? 1 : 0 })), { x, y }];
  const xs = [...new Set(all.map((r) => r.x))].sort((a, b) => a - b);
  let blocks = xs.map((v) => {
    const at = all.filter((r) => r.x === v);
    return { xs: [v], sum: at.reduce((s, r) => s + r.y, 0), n: at.length };
  });
  // Pool the first adjacent violation until none is left.
  for (;;) {
    const i = blocks.findIndex(
      (b, j) =>
        j + 1 < blocks.length && b.sum / b.n > (blocks[j + 1]?.sum ?? 0) / (blocks[j + 1]?.n ?? 1),
    );
    if (i < 0) break;
    const a = blocks[i] as (typeof blocks)[number];
    const b = blocks[i + 1] as (typeof blocks)[number];
    blocks = [
      ...blocks.slice(0, i),
      { xs: [...a.xs, ...b.xs], sum: a.sum + b.sum, n: a.n + b.n },
      ...blocks.slice(i + 2),
    ];
  }
  const own = blocks.find((b) => b.xs.includes(x)) as (typeof blocks)[number];
  return own.sum / own.n;
}

describe("the inductive Venn-Abers predictor", () => {
  it("equals pool-adjacent-violators refitted with the query added, ties included", () => {
    const rand = rng(4201);
    for (let trial = 0; trial < 60; trial++) {
      const n = Math.floor(rand() * 25);
      // Two decimals, so scores tie often, as an LLM's stated probabilities do.
      const rows = Array.from({ length: n }, () => ({
        confidence: Math.round(rand() * 20) / 20,
        correct: rand() < 0.6,
      }));
      const va = fitVennAbers(rows);
      expect(va.n).toBe(n);
      const queries = [0, 1, 0.025, 0.5, 0.975, ...rows.map((r) => r.confidence)];
      for (const s of queries) {
        const got = va.predict(s);
        expect(got.p0).toBeCloseTo(naiveFitAt(rows, s, 0), 12);
        expect(got.p1).toBeCloseTo(naiveFitAt(rows, s, 1), 12);
        expect(got.p0).toBeLessThanOrEqual(got.p1);
        expect(got.merged).toBeCloseTo(got.p1 / (1 - got.p0 + got.p1), 15);
      }
    }
  });

  it("knows nothing with no rows", () => {
    expect(fitVennAbers([]).predict(0.7)).toEqual({ p0: 0, p1: 1, merged: 0.5 });
  });

  it("never merges to exactly 0 or 1, even where p0 is 0 or p1 is 1", () => {
    const va = fitVennAbers(separable);
    const low = va.predict(0.05);
    const high = va.predict(0.97);
    expect(low.p0).toBe(0);
    expect(high.p1).toBe(1);
    for (const p of grid) {
      const { p0, p1, merged } = va.predict(p);
      expect(p0).toBeLessThanOrEqual(p1);
      expect(merged).toBeGreaterThan(0);
      expect(merged).toBeLessThan(1);
    }
  });

  it("narrows near the bars as rows accrue", () => {
    // Research (model I, 300 runs): median width p1 - p0 over test rows stated 0.70 to 0.86 was
    // 0.167 at 50 rows and 0.032 at 500; two reruns of 150 gave 0.150 and 0.148, 0.030 and 0.030.
    // The bands below are about twice those either way, and the ratio asks for a third of that.
    const rand = rng(4202);
    const near = modelI(1000, rand).filter((r) => r.confidence >= 0.7 && r.confidence <= 0.86);
    const width = (n: number, reps: number) => {
      const ws: number[] = [];
      for (let k = 0; k < reps; k++) {
        const va = fitVennAbers(modelI(n, rand));
        for (const r of near) {
          const { p0, p1 } = va.predict(r.confidence);
          ws.push(p1 - p0);
        }
      }
      return median(ws);
    };
    const at50 = width(50, 40);
    const at500 = width(500, 20);
    expect(at50).toBeGreaterThan(0.08);
    expect(at50).toBeLessThan(0.3);
    expect(at500).toBeGreaterThan(0.015);
    expect(at500).toBeLessThan(0.06);
    expect(at50 / at500).toBeGreaterThan(3);
  });

  it("refuses rows and queries out of range", () => {
    expect(() => fitVennAbers([{ confidence: -0.1, correct: true }])).toThrow(/row 0: confidence/);
    const bad = [{ confidence: 0.5, correct: "no" }] as unknown as Scored[];
    expect(() => fitVennAbers(bad)).toThrow(/row 0: correct must be a boolean/);
    const va = fitVennAbers(separable);
    expect(() => va.predict(Number.NaN)).toThrow(/must be in \[0, 1\]/);
    expect(() => va.predict(-0.01)).toThrow(/must be in \[0, 1\]/);
  });
});

describe("on a miscalibrated sample (simulation)", () => {
  // Every map is scored on one fixed set of 1,000 rows, averaged over fits on fresh samples. In
  // the research (300 runs) log loss at 50 rows was 0.369 raw, 0.352 beta (ridge 1e-3 toward 0),
  // 0.339 merged Venn-Abers and 0.693 isotonic; at 180: 0.369, 0.305, 0.312 and 0.430. With this
  // module's ridge toward the identity, 150 runs read 0.350, 0.290, 0.321 and 0.640 at 50 rows,
  // and 0.350, 0.276, 0.292 at 180. Run to run, one fit's log loss had a standard deviation of
  // 0.022 at 50 rows and 0.010 at 180, so a 40-run mean has a standard error of 0.0035 and
  // 0.0016. Each threshold below sits at least 3.5 standard errors inside the expected mean.
  const test = modelI(1000, rng(4301));
  const raw = logLoss(test, (p) => p);

  function meanLoss(n: number, reps: number, seed: number) {
    const rand = rng(seed);
    const sum = { beta: 0, venn: 0, isotonic: 0 };
    for (let k = 0; k < reps; k++) {
      const cal = modelI(n, rand);
      const beta = fitBeta(cal);
      const va = fitVennAbers(cal);
      const iso = fitIsotonic(cal, 1);
      sum.beta += logLoss(test, beta.apply);
      sum.venn += logLoss(test, (p) => va.predict(p).merged);
      sum.isotonic += logLoss(test, (p) => iso?.apply(p) ?? p);
    }
    return { beta: sum.beta / reps, venn: sum.venn / reps, isotonic: sum.isotonic / reps };
  }

  it("improves log loss at 50 rows, and is no worse than isotonic there", () => {
    const m = meanLoss(50, 40, 4302);
    expect(m.beta).toBeLessThan(raw - 0.02);
    expect(m.venn).toBeLessThan(raw - 0.01);
    expect(m.beta).toBeLessThan(m.isotonic);
    expect(m.venn).toBeLessThan(m.isotonic);
  });

  it("improves log loss at 180 rows", () => {
    const m = meanLoss(180, 40, 4303);
    expect(m.beta).toBeLessThan(raw - 0.04);
    expect(m.venn).toBeLessThan(raw - 0.03);
  });
});
