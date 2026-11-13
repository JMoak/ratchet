import { describe, expect, it } from "vitest";
import {
  type PoolOptions,
  pool,
  poolJudge,
  poolPick,
  poolRate,
  poolWeights,
} from "../src/compound/aggregate.ts";
import { Engine } from "../src/engine.ts";
import { effectiveN, logit, rng, sigmoid } from "../src/math.ts";
import {
  judge,
  judgeVerdictFrom,
  pick,
  pickVerdictFrom,
  rate,
  rateVerdictFrom,
} from "../src/questions.ts";
import type { JudgeQuestion, JudgeVerdict, Oracle } from "../src/types.ts";

const q = judge("ok?", { id: "q" });
const v = (pYes: number): JudgeVerdict => judgeVerdictFrom(q, pYes);
const vs = (ps: readonly number[]) => ps.map(v);

describe("without priorYes every pool is the float it was", () => {
  it("matches the untouched formulas on seeded inputs, scalar and matrix paths", () => {
    const r = rng(20261112);
    for (let t = 0; t < 2000; t++) {
      const n = 1 + Math.floor(r() * 5);
      const ps = Array.from({ length: n }, () => r());
      const w = Array.from({ length: n }, () => 2 * r());
      const rho = r();
      // The scalar path as it was written: sum, then shrink, then sigmoid.
      const sum = ps.reduce((acc, p, i) => acc + (w[i] ?? 1) * logit(p), 0);
      const scalar = sigmoid(sum * (effectiveN(n, rho) / n));
      expect(poolJudge(vs(ps), { weights: w, correlation: rho }).pYes).toBe(scalar);
      // The matrix path as it was written: GLS weights, capped by the same answers at rho 0.
      const keys = Array.from({ length: n }, (_, i) => ["a", "b", "c"][i % 3] as string);
      const o: PoolOptions = {
        weights: w,
        correlations: { a: { b: r(), c: r() }, b: { c: r() } },
        memberKeys: keys,
      };
      const g = poolWeights(n, o).weights;
      const z = ps.reduce((acc, p, i) => acc + (g[i] ?? 0) * (w[i] ?? 1) * logit(p), 0);
      const independent = Math.abs(sum);
      const matrix = sigmoid(Math.sign(z) * Math.min(Math.abs(z), independent));
      expect(poolJudge(vs(ps), o).pYes).toBe(matrix);
    }
  });

  it("returns values recorded before the option existed", () => {
    // Recorded with aggregate.ts as it stood before priorYes, on these exact inputs.
    expect(poolJudge(vs([0.8, 0.8])).pYes).toBe(0.9411764705882353);
    expect(poolJudge(vs([0.8, 0.8, 0.8])).pYes).toBe(0.9846153846153847);
    expect(
      poolJudge(vs([0.8, 0.8, 0.8]), {
        correlations: { a: { b: 0.75 } },
        memberKeys: ["a", "b", "c"],
      }).pYes,
    ).toBe(0.9512295481246369);
  });
});

describe("priorYes counts the gate's base rate once (Bordley's prior correction)", () => {
  it("pools members who learned nothing to the base rate, where log-odds overshoot it", () => {
    // A calibrated member that answers the base rate saw no evidence either way.
    expect(poolJudge(vs([0.8, 0.8]), { priorYes: 0.8 }).pYes).toBe(0.8);
    expect(poolJudge(vs([0.8, 0.8, 0.8]), { priorYes: 0.8 }).pYes).toBe(0.8);
    expect(poolJudge(vs([0.8, 0.8])).pYes).toBeCloseTo(0.941, 3);
    expect(poolJudge(vs([0.8, 0.8, 0.8])).pYes).toBeCloseTo(0.985, 3);
    // The engine's family default for two pins of one model and one other family: 0.951
    // without the offset, the base rate with it.
    const family: PoolOptions = { correlations: { a: { b: 0.75 } }, memberKeys: ["a", "b", "c"] };
    expect(poolJudge(vs([0.8, 0.8, 0.8]), family).pYes).toBeCloseTo(0.951, 3);
    expect(poolJudge(vs([0.8, 0.8, 0.8]), { ...family, priorYes: 0.8 }).pYes).toBeCloseTo(0.8, 14);
    // At a base rate of one half there is nothing to correct.
    expect(poolJudge(vs([0.7, 0.9]), { priorYes: 0.5 }).pYes).toBe(poolJudge(vs([0.7, 0.9])).pYes);
  });

  it("pools members above the base rate above it, and below it below", () => {
    const above = poolJudge(vs([0.9, 0.85]), { priorYes: 0.8 }).pYes;
    expect(above).toBeGreaterThan(0.9);
    const below = poolJudge(vs([0.7, 0.75]), { priorYes: 0.8 }).pYes;
    expect(below).toBeLessThan(0.7);
    // Without the offset two members who each moved toward "no" still pool to a confident yes.
    expect(poolJudge(vs([0.7, 0.75])).pYes).toBeGreaterThan(0.85);
    // The closed form: lambda0 + k sum_i w_i (z_i - lambda0).
    const l0 = logit(0.8);
    const k = effectiveN(2, 0.3) / 2;
    const expected = sigmoid(l0 + k * (2 * (logit(0.9) - l0) + 0.5 * (logit(0.6) - l0)));
    expect(
      poolJudge(vs([0.9, 0.6]), { priorYes: 0.8, correlation: 0.3, weights: [2, 0.5] }).pYes,
    ).toBeCloseTo(expected, 12);
  });

  it("keeps the matrix path's cap on the evidence part", () => {
    // Two near-duplicates lean yes by one unit each, an independent member leans no by two:
    // at rho 0 the evidence cancels; the GLS weights (0.633, 0.633, 1) would say no by 0.73.
    const prior = 0.7;
    const l0 = logit(prior);
    const ps = [l0 + 1, l0 + 1, l0 - 2].map(sigmoid);
    const o: PoolOptions = {
      correlations: { a: { b: 0.58 } },
      memberKeys: ["a", "b", "c"],
      priorYes: prior,
    };
    // Capped at the rho-0 evidence, which is zero up to rounding: the base rate.
    expect(poolJudge(vs(ps), o).pYes).toBeCloseTo(prior, 9);
    // Agreeing answers are never capped: the evidence is the GLS-weighted sum.
    const agree = [l0 + 1, l0 + 1, l0 + 2].map(sigmoid);
    const g = poolWeights(3, o).weights;
    const evidence = (g[0] ?? 0) + (g[1] ?? 0) + 2 * (g[2] ?? 0);
    expect(poolJudge(vs(agree), o).pYes).toBeCloseTo(sigmoid(l0 + evidence), 9);
  });

  it("refuses a base rate that is not one", () => {
    for (const bad of [0, 1, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => poolJudge(vs([0.8]), { priorYes: bad })).toThrow(/strictly between 0 and 1/);
    }
    const notNumber = { priorYes: "0.8" } as unknown as PoolOptions;
    expect(() => poolJudge(vs([0.8]), notNumber)).toThrow(/strictly between 0 and 1/);
    // Checked whatever the method, so a malformed base rate is never silently ignored.
    expect(() => poolJudge(vs([0.8]), { method: "mean", priorYes: 2 })).toThrow(/strictly between/);
  });

  it("is ignored by the methods that count the prior once already", () => {
    const ps = [0.9, 0.6, 0.75];
    for (const method of ["mean", "max", "min", "majority", "geomean", "any", "all"] as const) {
      expect(poolJudge(vs(ps), { method, priorYes: 0.8 }).pYes).toBe(
        poolJudge(vs(ps), { method }).pYes,
      );
    }
  });

  it("throws on a pick or rate question, which has no base rate of yes", () => {
    const qp = pick("route?", ["a", "b"], { id: "p" });
    const pv = [pickVerdictFrom(qp, [0.6, 0.4]), pickVerdictFrom(qp, [0.7, 0.3])];
    expect(() => poolPick(qp, pv, { priorYes: 0.8 })).toThrow(/judge verdicts only/);
    expect(() => pool(qp, pv, { method: "mean", priorYes: 0.8 })).toThrow(/judge verdicts only/);
    const qr = rate("how bad?", ["low", "high"], { id: "r" });
    const rv = [rateVerdictFrom(qr, [0.6, 0.4])];
    expect(() => poolRate(qr, rv, { priorYes: 0.8 })).toThrow(/judge verdicts only/);
  });
});

describe("every engine path that pools carries priorYes to pool()", () => {
  /** An oracle that answers every question with a fixed p(yes) and records a model. */
  const fixed = (id: string, p: number, model: string): Oracle => ({
    id,
    async decide(_s, qs) {
      return qs.map((x) => ({
        verdict: judgeVerdictFrom(x as JudgeQuestion, p),
        oracle: id,
        model,
        latencyMs: 0,
        cost: 0,
        at: new Date().toISOString(),
      }));
    },
  });
  const policy = { actAbove: 0.95 };
  const prior = 0.8;
  const pYesOf = (d: { readonly verdict: { readonly kind: string } }): number =>
    (d.verdict as JudgeVerdict).pYes;

  it("ensemble, explicit members of different families (default rho 0)", async () => {
    const engine = new Engine({ oracle: fixed("base", 0.5, "base-1") });
    const members = [
      { oracle: fixed("j", 0.9, "jev-1.13"), label: "jev" },
      { oracle: fixed("h", 0.7, "claude-haiku"), label: "haiku" },
    ];
    const gate = engine.gate({
      id: "ens",
      question: q,
      policy,
      strategy: { ensemble: { members, priorYes: prior } },
    });
    const r = await gate.ask("s");
    expect(r.decision.detail.rhoSource).toBe("default-independent");
    expect(pYesOf(r.decision)).toBeCloseTo(poolJudge(vs([0.9, 0.7]), { priorYes: prior }).pYes, 12);
    expect(pYesOf(r.decision)).not.toBeCloseTo(poolJudge(vs([0.9, 0.7])).pYes, 3);
  });

  it("ensemble of replicas (default rho 0.75)", async () => {
    const engine = new Engine({ oracle: fixed("base", 0.9, "jev-1.13") });
    const gate = engine.gate({
      id: "rep",
      question: q,
      policy,
      strategy: { ensemble: { k: 3, priorYes: prior } },
    });
    const r = await gate.ask("s");
    expect(r.decision.detail.rhoSource).toBe("default-replica");
    const expected = poolJudge(vs([0.9, 0.9, 0.9]), { correlation: 0.75, priorYes: prior });
    expect(pYesOf(r.decision)).toBeCloseTo(expected.pYes, 12);
  });

  it("sequential", async () => {
    const engine = new Engine({ oracle: fixed("base", 0.5, "base-1") });
    const members = [
      { oracle: fixed("j", 0.85, "jev-1.13"), label: "jev" },
      { oracle: fixed("h", 0.9, "claude-haiku"), label: "haiku" },
    ];
    const gate = engine.gate({
      id: "seq",
      question: q,
      policy,
      strategy: { sequential: { members, settleAbove: 0.9999, maxSamples: 2, priorYes: prior } },
    });
    const r = await gate.ask("s");
    expect(r.decision.detail.samples).toBe(2);
    const expected = poolJudge(vs([0.85, 0.9]), { correlation: 0, priorYes: prior });
    expect(pYesOf(r.decision)).toBeCloseTo(expected.pYes, 12);
  });

  it("cascade with pool", async () => {
    const engine = new Engine({ oracle: fixed("base", 0.5, "base-1") });
    const gate = engine.gate({
      id: "cas",
      question: q,
      policy,
      strategy: {
        cascade: {
          tiers: [
            { oracle: fixed("j", 0.85, "jev-1.13"), settleAbove: 0.99, label: "jev" },
            { oracle: fixed("h", 0.9, "claude-haiku"), settleAbove: 0, label: "haiku" },
          ],
          pool: { priorYes: prior },
        },
      },
    });
    const r = await gate.ask("s");
    expect(r.decision.detail.pooled).toBe(true);
    const expected = poolJudge(vs([0.85, 0.9]), { priorYes: prior });
    expect(pYesOf(r.decision)).toBeCloseTo(expected.pYes, 12);
  });

  it("battery combine given as PoolOptions", async () => {
    const answers: Record<string, number> = { a: 0.9, b: 0.75 };
    const oracle: Oracle = {
      id: "battery",
      async decide(_s, qs) {
        return qs.map((x) => ({
          verdict: judgeVerdictFrom(x as JudgeQuestion, answers[x.id] ?? 0.5),
          oracle: "battery",
          model: "m-1",
          latencyMs: 0,
          cost: 0,
          at: new Date().toISOString(),
        }));
      },
    };
    const engine = new Engine({ oracle });
    const members = [judge("a?", { id: "a" }), judge("b?", { id: "b" })];
    const plain = engine.gate({ id: "bat", question: members, policy, combine: {} });
    const offset = engine.gate({
      id: "bat.p",
      question: members,
      policy,
      combine: { priorYes: prior },
    });
    const a = await plain.ask("s");
    const b = await offset.ask("s");
    expect(a.decision.verdict.pYes).toBeCloseTo(poolJudge(vs([0.9, 0.75])).pYes, 12);
    expect(b.decision.verdict.pYes).toBeCloseTo(
      poolJudge(vs([0.9, 0.75]), { priorYes: prior }).pYes,
      12,
    );
    // The combiner is part of the battery's rubric identity, so opting in starts new evidence.
    expect(offset.questionHash).not.toBe(plain.questionHash);
  });

  // Fails today. When the models the answers recorded reveal two voters of one family that
  // nothing advertised up front, `withRho` in src/engine.ts pools again at the risen default
  // correlation from `poolOf(live)`, which carries only `method` and `weights`: priorYes is
  // dropped on that path. Flip to `it` once the engine carries it.
  it("ensemble whose recorded models raise the default rho keeps priorYes", async () => {
    const engine = new Engine({ oracle: fixed("base", 0.5, "base-1") });
    const members = [
      { oracle: fixed("a", 0.9, "jev-1.13"), label: "a" },
      { oracle: fixed("b", 0.85, "jev-1.14"), label: "b" },
    ];
    const gate = engine.gate({
      id: "rise",
      question: q,
      policy,
      strategy: { ensemble: { members, priorYes: prior } },
    });
    const r = await gate.ask("s");
    expect(r.decision.detail.rhoFrom).toBe("recorded-model");
    const expected = poolJudge(vs([0.9, 0.85]), { correlation: 0.75, priorYes: prior });
    expect(pYesOf(r.decision)).toBeCloseTo(expected.pYes, 12);
  });
});
