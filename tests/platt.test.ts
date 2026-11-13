/**
 * Platt scaling on a logical pool (Foundations review 2026-11, pooling and deferral, section 5
 * and table F). A battery's members answer different questions about one state; `all` (the
 * product) and `any` (noisy-OR) have the battery's shape, and a two-parameter Platt fit on
 * labelled rows corrects the level the pool states. The research simulation: an all-of battery
 * of eight members, each 93% accurate on its own condition, P(each holds) 0.955.
 */
import { describe, expect, it } from "vitest";
import { poolJudge } from "../src/compound/aggregate.ts";
import {
  batteryFeatures,
  fitLogistic,
  fitPlatt,
  fitPlattCombiner,
  type PlattModel,
  plattCombiner,
  poolLearned,
  predictPlatt,
} from "../src/compound/learned.ts";
import { Engine } from "../src/engine.ts";
import { ece } from "../src/ledger/calibration.ts";
import type { DecisionRecord } from "../src/ledger/ledger.ts";
import { logit, randNormal, rng, sigmoid } from "../src/math.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, JudgeVerdict, Oracle } from "../src/types.ts";

/** Phi^-1(0.955) and Phi^-1(0.93), the research generator's condition and accuracy quantiles. */
const Z_HOLDS = 1.6953977097;
const Z_ACCURACY = 1.4757910298;

type BatteryRow = { readonly verdicts: JudgeVerdict[]; readonly y: boolean };

/**
 * The research note's all-of generator at independent conditions: each of k conditions holds
 * with probability 0.955; member j is a calibrated Gaussian-logit judge of its own condition,
 * 93% accurate (log-likelihood ratio N(+-s^2/2, s^2) with s = 2 Phi^-1(0.93), on the prior
 * logit(0.955)); members' noise is equicorrelated at `rm` through one shared factor, as one
 * model asked k questions about one state is. The battery's truth is that every condition holds.
 */
function allOf(seed: number, n: number, k: number, rm: number): BatteryRow[] {
  const rand = rng(seed);
  const s = 2 * Z_ACCURACY;
  const prior = logit(0.955);
  const rows: BatteryRow[] = [];
  for (let t = 0; t < n; t++) {
    const shared = randNormal(rand);
    const verdicts: JudgeVerdict[] = [];
    let all = true;
    for (let j = 0; j < k; j++) {
      const holds = randNormal(rand) < Z_HOLDS;
      all &&= holds;
      const noise = Math.sqrt(rm) * shared + Math.sqrt(1 - rm) * randNormal(rand);
      const p = sigmoid(prior + ((holds ? 1 : -1) * s * s) / 2 + s * noise);
      verdicts.push({
        kind: "judge",
        questionId: `m${j}`,
        pYes: p,
        confidence: Math.max(p, 1 - p),
      });
    }
    rows.push({ verdicts, y: all });
  }
  return rows;
}

/** Area under the ROC curve (Mann-Whitney, ties at half). */
function auc(ps: readonly number[], ys: readonly boolean[]): number {
  const order = ps.map((_, i) => i).sort((a, b) => (ps[a] ?? 0) - (ps[b] ?? 0));
  let rankSum = 0;
  let positives = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && ps[order[j + 1] ?? 0] === ps[order[i] ?? 0]) j++;
    for (let m = i; m <= j; m++) {
      if (ys[order[m] ?? 0]) {
        rankSum += (i + j) / 2 + 1;
        positives++;
      }
    }
    i = j + 1;
  }
  const negatives = ps.length - positives;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** ECE as the research note reads it: 10 bins of width 0.05 over the leading confidence. */
const eceOf = (ps: readonly number[], ys: readonly boolean[]): number =>
  ece(
    ps.map((p, i) => ({ confidence: Math.max(p, 1 - p), correct: p >= 0.5 === ys[i] })),
    20,
  );

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

interface Readout {
  readonly logodds: { readonly auc: number; readonly ece: number };
  readonly product: { readonly auc: number; readonly ece: number };
  /** Means over the refits. */
  readonly platt: { readonly auc: number; readonly ece: number };
  readonly learned: { readonly auc: number; readonly ece: number };
}

/**
 * Table F at test size: 20,000 held-out requests (the research used 40,000) and 20 fits of 200
 * rows each (the research used 200), for the combiners the research compares.
 */
function tableF(rm: number, seed: number): Readout {
  const held = allOf(seed, 20_000, 8, rm);
  const ys = held.map((r) => r.y);
  const score = (f: (vs: readonly JudgeVerdict[]) => number) => {
    const ps = held.map((r) => f(r.verdicts));
    return { auc: auc(ps, ys), ece: eceOf(ps, ys) };
  };
  const platt: { auc: number; ece: number }[] = [];
  const learned: { auc: number; ece: number }[] = [];
  for (let r = 0; r < 20; r++) {
    const rows = allOf(seed + 1 + r, 200, 8, rm);
    const { combine } = fitPlattCombiner(rows, { method: "all" });
    platt.push(score((vs) => combine(vs).pYes));
    const model = fitLogistic(rows.map((x) => ({ x: batteryFeatures(x.verdicts), y: x.y })));
    learned.push(score((vs) => poolLearned(vs, model).pYes));
  }
  const avg = (xs: readonly { auc: number; ece: number }[]) => ({
    auc: mean(xs.map((x) => x.auc)),
    ece: mean(xs.map((x) => x.ece)),
  });
  return {
    logodds: score((vs) => poolJudge(vs, { method: "logodds" }).pYes),
    product: score((vs) => poolJudge(vs, { method: "all" }).pYes),
    platt: avg(platt),
    learned: avg(learned),
  };
}

describe("fitPlatt", () => {
  it("recovers the identity on calibrated pools and a known map on miscalibrated ones", () => {
    const rand = rng(41);
    const truth = Array.from({ length: 20_000 }, () => {
      const p = sigmoid(2 * randNormal(rand));
      return { p, y: rand() < p };
    });
    const id = fitPlatt(truth);
    expect(id.converged).toBe(true);
    expect(id.reason).toBeUndefined();
    // At 20,000 rows with pool log-odds ~ N(0, 4), the standard errors are about 0.015 on the
    // slope and 0.02 on the intercept (inverse Fisher information); 0.06 is three to four of them.
    expect(Math.abs(id.slope - 1)).toBeLessThan(0.06);
    expect(Math.abs(id.intercept)).toBeLessThan(0.06);
    // An overconfident pool: its stated log-odds are twice the truth's plus 0.6, so the map back
    // is slope 0.5 and intercept -0.3. The ridge pulls the slope toward 1 by about
    // l2 (1 - 0.5) / (information + l2), 0.025 at the information these rows carry (about 1 per
    // row on the stated scale), and the slope's standard error is about 0.007: 0.06 holds both.
    const stated = truth.map((r) => ({ p: sigmoid(2 * logit(r.p) + 0.6), y: r.y }));
    const back = fitPlatt(stated);
    expect(back.converged).toBe(true);
    expect(back.slope).toBeGreaterThan(0.5);
    expect(back.slope - 0.5).toBeLessThan(0.06);
    expect(Math.abs(back.intercept + 0.3)).toBeLessThan(0.06);
  });

  it("reports the loss it minimised: mean log loss plus the slope's ridge, the intercept free", () => {
    const rand = rng(43);
    const rows = Array.from({ length: 300 }, () => {
      const p = rand();
      return { p, y: rand() < p * p };
    });
    const fit = fitPlatt(rows);
    const at = (m: PlattModel) =>
      mean(
        rows.map((r) => {
          const q = predictPlatt(m, r.p);
          return -(r.y ? Math.log(q) : Math.log(1 - q));
        }),
      ) +
      (0.05 / 2) * (m.slope - 1) ** 2;
    expect(fit.converged).toBe(true);
    expect(fit.iterations).toBeLessThan(20);
    expect(fit.loss).toBeCloseTo(at(fit), 9);
    // The minimum of that loss: nudging either parameter, or returning to the identity, costs
    // loss. A penalty on the intercept of the same size would have held it about 0.3 nearer 0
    // than this minimum (it sits near -1.1, with information about 0.13 per row), which the
    // intercept nudges would catch.
    for (const [da, db] of [
      [0.01, 0],
      [-0.01, 0],
      [0, 0.01],
      [0, -0.01],
    ] as const) {
      expect(at({ slope: fit.slope + da, intercept: fit.intercept + db })).toBeGreaterThan(
        fit.loss,
      );
    }
    expect(at({ slope: 1, intercept: 0 })).toBeGreaterThan(fit.loss);
    expect(fit.intercept).toBeLessThan(-0.5);
  });

  it("returns the identity, not a fit, on one class, and says so", () => {
    const yes = [0.2, 0.6, 0.9, 0.97].map((p) => ({ p, y: true }));
    const fit = fitPlatt(yes);
    expect(fit).toMatchObject({ slope: 1, intercept: 0, converged: false, reason: "one class" });
    expect(fit.iterations).toBe(0);
    expect(Number.isFinite(fit.loss)).toBe(true);
    // The pool is left as it was: a one-class sample cannot raise every answer toward acting.
    expect(predictPlatt(fit, 0.6)).toBeCloseTo(0.6, 12);
    expect(fitPlatt(yes.map((r) => ({ ...r, y: false }))).reason).toBe("one class");
  });

  it("on separable rows converges to a finite, steeper map with the ridge, and the identity without it", () => {
    const rows = [
      ...[0.55, 0.6, 0.7, 0.8, 0.9].map((p) => ({ p, y: true })),
      ...[0.1, 0.2, 0.3, 0.4, 0.45].map((p) => ({ p, y: false })),
    ];
    const ridged = fitPlatt(rows);
    expect(ridged.converged).toBe(true);
    expect(ridged.reason).toBeUndefined();
    // Sharper than the pool, as the rows ask, but held finite by the pull toward a slope of 1
    // (2.39 on these ten fixed rows).
    expect(ridged.slope).toBeGreaterThan(1.5);
    expect(ridged.slope).toBeLessThan(4);
    expect(predictPlatt(ridged, 0.9)).toBeGreaterThan(0.9);
    expect(predictPlatt(ridged, 0.1)).toBeLessThan(0.1);
    const free = fitPlatt(rows, { l2: 0 });
    expect(free).toMatchObject({ slope: 1, intercept: 0, converged: false, reason: "separable" });
    // Rows ordered backwards are separable too, by a falling map.
    const backwards = rows.map((r) => ({ ...r, y: !r.y }));
    expect(fitPlatt(backwards, { l2: 0 }).reason).toBe("separable");
    expect(fitPlatt(backwards).slope).toBeLessThan(0);
  });

  it("stops at the iteration cap and refuses what it cannot fit", () => {
    const rand = rng(47);
    const rows = Array.from({ length: 200 }, () => {
      const p = rand();
      return { p, y: rand() < p };
    });
    const capped = fitPlatt(rows, { iterations: 0 });
    expect(capped).toMatchObject({ slope: 1, intercept: 0, converged: false });
    expect(capped.reason).toBe("iteration cap");
    expect(() => fitPlatt([])).toThrow(/needs rows/);
    expect(() => fitPlatt([{ p: Number.NaN, y: true }])).toThrow(/row 0 has p NaN/);
    expect(() => fitPlatt([{ p: 1.2, y: true }])).toThrow(/not a probability/);
    expect(() => fitPlatt(rows, { l2: -1 })).toThrow(/l2/);
    expect(() => fitPlatt(rows, { iterations: 1.5 })).toThrow(/whole number/);
  });
});

describe("an all-of battery of eight: product plus Platt (research table F)", () => {
  it("independent members: ranks as the product does, far above the log-odds sum, and stays calibrated", () => {
    const f = tableF(0, 61_004);
    // Research: log-odds AUC 0.542; product 0.933, ECE 0.003; product + Platt 0.933, ECE 0.014;
    // learned on clamped logits 0.863. Here 0.544, 0.934 at 0.006, 0.934 at 0.018, 0.864.
    expect(f.logodds.auc).toBeLessThan(0.6);
    expect(f.product.auc).toBeGreaterThan(0.9);
    // Platt is increasing, so it keeps the product's order; only pools past the +-12 log-odds
    // clamp can tie, all of them at the bottom.
    expect(Math.abs(f.platt.auc - f.product.auc)).toBeLessThan(0.002);
    expect(f.platt.auc - f.logodds.auc).toBeGreaterThan(0.3);
    // At independence the product is the conditions' own posterior and already calibrated (what
    // is left is the binning noise of 20,000 items); 200 rows of fit cost a little of that. So
    // Platt is not better calibrated than the product here, only close to it. The standard
    // deviation of one fit's ECE is about 0.010, 0.0023 for the mean of 20, so 0.03 is the
    // measured mean plus five of those.
    expect(f.product.ece).toBeLessThan(0.01);
    expect(f.platt.ece).toBeLessThan(0.03);
    // The shipped learned combiner, on clamped logits, is the wrong basis for a conjunction.
    expect(f.platt.auc - f.learned.auc).toBeGreaterThan(0.04);
  });

  it("correlated member noise (0.6): Platt keeps calibration the product loses, and outranks the learned combiner", () => {
    const f = tableF(0.6, 61_006);
    // Research: product ECE 0.040, product + Platt 0.016, learned AUC 0.686 against the
    // product's 0.925. Here 0.042, 0.018, 0.694 and 0.921.
    expect(f.product.ece).toBeGreaterThan(0.03);
    // A gap of 0.024 against a standard error near 0.0025 for the mean of 20 refits.
    expect(f.platt.ece).toBeLessThan(f.product.ece - 0.01);
    expect(f.platt.ece).toBeLessThan(0.03);
    // A gap of 0.23 against a standard deviation of 0.040 per learned fit (0.009 for the mean).
    expect(f.platt.auc - f.learned.auc).toBeGreaterThan(0.15);
  });
});

describe("plattCombiner", () => {
  const q = { kind: "judge", id: "m", prompt: "" } as JudgeQuestion;
  const vs = [0.9, 0.8, 0.95].map((p) => judgeVerdictFrom(q, p));
  const map: PlattModel = { slope: 0.7, intercept: -0.2 };

  it("pools by any or all at the stated correlation, then maps, and carries what it computes", () => {
    const all = plattCombiner({ method: "all" }, map);
    expect(all(vs).pYes).toBe(predictPlatt(map, poolJudge(vs, { method: "all" }).pYes));
    expect(all(vs)).toMatchObject({ kind: "judge", questionId: "m" });
    expect(all.pool).toEqual({ method: "all", correlation: 0 });
    expect(all.platt).toEqual(map);
    const any = plattCombiner({ method: "any", correlation: 0.5 }, map);
    expect(any(vs).pYes).toBe(
      predictPlatt(map, poolJudge(vs, { method: "any", correlation: 0.5 }).pYes),
    );
    // The identity map is the pool itself, within the +-12 log-odds clamp.
    const plain = plattCombiner({ method: "all" }, { slope: 1, intercept: 0 });
    expect(plain(vs).pYes).toBeCloseTo(0.9 * 0.8 * 0.95, 12);
    // A stated correlation is the permissive direction in both usual shapes (`LogicalPool`):
    // all-of rises toward acting on yes, any-of falls toward acting on no.
    const at = (method: "any" | "all", correlation: number) =>
      plattCombiner({ method, correlation }, { slope: 1, intercept: 0 })(vs).pYes;
    expect(at("all", 0.5)).toBeGreaterThan(at("all", 0));
    expect(at("any", 0.5)).toBeLessThan(at("any", 0));
    // Its parameters cannot be changed under it.
    expect(() => {
      (all.platt as { slope: number }).slope = 9;
    }).toThrow();
    expect(all(vs).pYes).toBe(predictPlatt(map, poolJudge(vs, { method: "all" }).pYes));
  });

  it("refuses a map or a pool that could not calibrate anything", () => {
    expect(() => plattCombiner({ method: "logodds" as never }, map)).toThrow(/"any" or "all"/);
    expect(() => plattCombiner({ method: "all", correlation: 1.5 }, map)).toThrow(/correlation/);
    expect(() => plattCombiner({ method: "all", correlation: Number.NaN }, map)).toThrow(
      /correlation/,
    );
    expect(() => plattCombiner({ method: "all" }, { slope: 0, intercept: 0 })).toThrow(/slope/);
    expect(() => plattCombiner({ method: "all" }, { slope: -1, intercept: 0 })).toThrow(/inverts/);
    expect(() => plattCombiner({ method: "all" }, { slope: Number.NaN, intercept: 0 })).toThrow(
      /slope/,
    );
    expect(() => plattCombiner({ method: "all" }, { slope: 1, intercept: Infinity })).toThrow(
      /intercept/,
    );
  });

  it("fitPlattCombiner takes the correlation only from the caller, refuses ragged rows and a backward pool", () => {
    const rows = allOf(5, 400, 3, 0);
    const { combine, fit } = fitPlattCombiner(rows, { method: "all" });
    expect(combine.pool.correlation).toBe(0);
    expect(fit).toEqual(
      fitPlatt(rows.map((r) => ({ p: poolJudge(r.verdicts, { method: "all" }).pYes, y: r.y }))),
    );
    expect(combine.platt).toEqual({ slope: fit.slope, intercept: fit.intercept });
    const stated = fitPlattCombiner(rows, { method: "all", correlation: 0.3 });
    expect(stated.combine.pool.correlation).toBe(0.3);
    expect(() => fitPlattCombiner([], { method: "all" })).toThrow(/needs rows/);
    const ragged = [rows[0] as BatteryRow, { ...(rows[1] as BatteryRow), verdicts: [] }];
    expect(() => fitPlattCombiner(ragged, { method: "all" })).toThrow(/same 3 member verdicts/);
    const backwards = rows.map((r) => ({ ...r, y: !r.y }));
    expect(() => fitPlattCombiner(backwards, { method: "all" })).toThrow(/backwards/);
    expect(() => fitPlattCombiner(rows, { method: "all", correlation: 2 })).toThrow(/correlation/);
  });
});

describe("a Platt combiner on a real gate", () => {
  const members = [
    judge("Are the figures right?", { id: "m.figures" }),
    judge("Is every item present?", { id: "m.items" }),
    judge("Is the scope kept?", { id: "m.scope" }),
  ];

  /** Answers each member with the p(yes) written into the state, in member order. */
  const scripted: Oracle = {
    id: "scripted",
    async decide(state, qs) {
      const ps = (state.split("|")[1] ?? "").split(",").map(Number);
      return qs.map((question) => ({
        verdict: judgeVerdictFrom(
          question as JudgeQuestion,
          ps[members.findIndex((m) => m.id === question.id)] ?? 0.5,
        ),
        oracle: "scripted",
        model: "script-1",
        latencyMs: 0,
        cost: 0,
        at: "2026-11-12T00:00:00.000Z",
      }));
    },
  };

  it("labelled ledger rows to a combiner in one call, ruling on the calibrated pool", async () => {
    const engine = new Engine({ oracle: scripted });
    const shadow = engine.gate({
      id: "verify.all",
      question: members,
      combine: "all",
      policy: { actAbove: 0.9 },
      evidenceVersion: "product-1",
    });
    const sample = allOf(11, 120, 3, 0.6);
    for (const [i, row] of sample.entries()) {
      const r = await shadow.ask(`item ${i}|${row.verdicts.map((v) => v.pYes).join(",")}`);
      await engine.label(r.recordId, {
        correct: r.decision.verdict.pYes >= 0.5 === row.y,
        truth: row.y,
        source: "review:blind",
      });
    }
    // Group the members' rows by request, as `batteryFeatures` is fed.
    const byRequest = new Map<string, DecisionRecord[]>();
    for (const row of await engine.ledger.all()) {
      if (row.combined || row.gateId !== "verify.all") continue;
      byRequest.set(row.requestId, [...(byRequest.get(row.requestId) ?? []), row]);
    }
    const rows = [...byRequest.values()].map((ms) => ({
      verdicts: ms.map((m) => m.verdict as JudgeVerdict),
      y: ms[0]?.outcome?.truth === true,
    }));
    expect(rows).toHaveLength(120);
    const { combine, fit } = fitPlattCombiner(rows, { method: "all" });
    expect(fit.converged).toBe(true);
    // The rows the ledger gave back are the rows asked: the same fit as on the sample itself.
    expect(fit).toEqual(fitPlattCombiner(sample, { method: "all" }).fit);
    // Correlated member noise makes the product overconfident: the fit softens it.
    expect(fit.slope).toBeLessThan(1);

    const enforce = new Engine({ oracle: scripted, mode: "enforce" });
    const calibrated = enforce.gate({
      id: "verify.all",
      question: members,
      combine,
      policy: { actAbove: 0.9 },
      // A function combiner is not hashed into the gate's rubric: the version says it changed.
      evidenceVersion: "product-platt-1",
    });
    const ps = [0.99, 0.97, 0.98];
    const r = await calibrated.ask(`item x|${ps.join(",")}`);
    const expected = predictPlatt(fit, 0.99 * 0.97 * 0.98);
    expect(r.decision.verdict.pYes).toBeCloseTo(expected, 12);
    expect(r.decision.verdict.questionId).toBe("verify.all");
    expect(r.decision.detail).toMatchObject({ combine: "function", members: 3 });
    expect(r.action).toBe(expected >= 0.9 ? "act" : "review");
    const [row] = (await enforce.ledger.all()).filter((x) => x.combined);
    expect(row?.evidenceVersion).toBe("product-platt-1");
  });

  it("a function combiner that returns NaN fails the battery open, to review", async () => {
    const engine = new Engine({ oracle: scripted, mode: "enforce" });
    // A Platt map built by hand skips `plattCombiner`'s checks; a NaN slope gives NaN.
    const unchecked = { slope: Number.NaN, intercept: 0 };
    expect(() => plattCombiner({ method: "all" }, unchecked)).toThrow(/slope/);
    const g = engine.gate({
      id: "verify.nan",
      question: members,
      combine: (vs) => {
        const p = predictPlatt(unchecked, poolJudge(vs, { method: "all" }).pYes);
        return { kind: "judge", questionId: "x", pYes: p, confidence: Math.max(p, 1 - p) };
      },
      policy: { actAbove: 0.5 },
    });
    const r = await g.ask("item|0.99,0.99,0.99");
    expect(r.decision.failedOpen).toBe(true);
    expect(r.decision.error).toMatch(/not a probability/);
    expect(r.decision.detail).toMatchObject({ combinerFailed: true });
    expect(r.action).toBe("review");
    expect(r.decision.verdict.pYes).toBe(0.5);
  });
});
