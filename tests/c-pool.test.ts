import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { report } from "../src/cli/report.ts";
import { pool, poolJudge, poolPick, poolWeights } from "../src/compound/aggregate.ts";
import { ensemble, type Member } from "../src/compound/ensemble.ts";
import { sequential } from "../src/compound/sequential.ts";
import { Engine } from "../src/engine.ts";
import { describeBattery, SATURATION_WARN } from "../src/ledger/bars.ts";
import { JsonlLedger } from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom, pick, pickVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, JudgeVerdict, Oracle } from "../src/types.ts";

const v = (pYes: number): JudgeVerdict => judgeVerdictFrom(judge("q?", { id: "q" }), pYes);

/** The triage repro's moderation answers: one clear risk per post, or none. */
const ANSWERS: Record<string, Record<string, number>> = {
  spam: { threat: 0.02, harass: 0.03, spam: 0.99, selfharm: 0.02 },
  threat: { threat: 0.98, harass: 0.06, spam: 0.01, selfharm: 0.01 },
  fishing: { threat: 0.01, harass: 0.02, spam: 0.02, selfharm: 0.01 },
};
const moderation: Oracle = {
  id: "fixed",
  async decide(state, qs) {
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, ANSWERS[state]?.[q.id] ?? 0.5),
      oracle: "fixed",
      model: "m-1",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
};
const risks = ["threat", "harass", "spam", "selfharm"].map((id) => judge(`${id}?`, { id }));

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-c-pool-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("any and all pool a battery of distinct questions (e2e T3-01, T2-05)", () => {
  it("holds a post any one risk flags, where log-odds published it", async () => {
    // "Needs moderator action?" with act = publish (goIsYes false), as the triage track ran it.
    const policy = { actAbove: 0.9, goIsYes: false };
    const soft = async (combine?: "any") => {
      const engine = new Engine({ oracle: moderation });
      const gate = engine.gate({
        id: "mod",
        question: risks,
        policy,
        ...(combine ? { combine } : {}),
      });
      const out: Record<string, string> = {};
      for (const s of Object.keys(ANSWERS)) out[s] = (await gate.ask(s)).ruling.action;
      return out;
    };
    // The default is unchanged: log-odds publishes the spam post and the threat.
    expect(await soft()).toEqual({ spam: "act", threat: "act", fishing: "act" });
    expect(await soft("any")).toEqual({ spam: "review", threat: "review", fishing: "act" });
  });

  it("is noisy-OR and noisy-AND at independence, max and min at full correlation", () => {
    const ps = [0.9, 0.5, 0.2];
    const any0 = poolJudge(ps.map(v), { method: "any" }).pYes;
    const all0 = poolJudge(ps.map(v), { method: "all" }).pYes;
    expect(any0).toBeCloseTo(1 - 0.1 * 0.5 * 0.8, 12);
    expect(all0).toBeCloseTo(0.9 * 0.5 * 0.2, 12);
    expect(poolJudge(ps.map(v), { method: "any", correlation: 1 }).pYes).toBeCloseTo(0.9, 12);
    expect(poolJudge(ps.map(v), { method: "all", correlation: 1 }).pYes).toBeCloseTo(0.2, 12);
    // Between, it slides monotonically from one to the other and never past either.
    let lastAny = any0;
    let lastAll = all0;
    for (const rho of [0.25, 0.5, 0.75]) {
      const a = poolJudge(ps.map(v), { method: "any", correlation: rho }).pYes;
      const b = poolJudge(ps.map(v), { method: "all", correlation: rho }).pYes;
      expect(a).toBeLessThan(lastAny);
      expect(a).toBeGreaterThan(0.9);
      expect(b).toBeGreaterThan(lastAll);
      expect(b).toBeLessThan(0.2);
      lastAny = a;
      lastAll = b;
    }
    // A weight of 0 drops a member; a negative weight is refused.
    expect(poolJudge(ps.map(v), { method: "all", weights: [1, 0, 1] }).pYes).toBeCloseTo(0.18, 12);
    expect(() => poolJudge(ps.map(v), { method: "any", weights: [1, -1, 1] })).toThrow(
      /non-negative/,
    );
  });

  it("refuses any and all on pick and rate questions", () => {
    const q = pick("route?", ["a", "b"], { id: "r" });
    const vs = [pickVerdictFrom(q, [0.6, 0.4]), pickVerdictFrom(q, [0.3, 0.7])];
    expect(() => poolPick(q, vs, { method: "any" })).toThrow(/judge verdicts only/);
    expect(() => pool(q, vs, { method: "all" })).toThrow(/judge verdicts only/);
  });

  it("reads out how often a battery's verdicts saturate, and says what to combine with", async () => {
    // Three agreeing conjuncts at 0.98 pool in log-odds to 0.99999+: every verdict saturates.
    const path = join(dir, "conjunct.jsonl");
    const sure: Oracle = {
      id: "sure",
      async decide(_s, qs) {
        return qs.map((q) => ({
          verdict: judgeVerdictFrom(q as JudgeQuestion, 0.999),
          oracle: "sure",
          latencyMs: 0,
          cost: 0,
          at: new Date().toISOString(),
        }));
      },
    };
    const members = ["tests", "claims", "scope"].map((id) => judge(`${id}?`, { id }));
    const engine = new Engine({ oracle: sure, ledger: new JsonlLedger(path) });
    const gate = engine.gate({ id: "stop.done", question: members, policy: { actAbove: 0.95 } });
    for (let i = 0; i < 10; i++) await gate.ask(`s ${i}`);
    const rep = await gate.report();
    expect(rep.battery).toEqual({ combine: "logodds", verdicts: 10, saturated: 10, share: 1 });
    const sentence = describeBattery(rep.battery ?? { verdicts: 0, saturated: 0, share: 0 });
    expect(sentence).toContain('a disjunction ("does any apply?") with "any"');
    expect(sentence).toContain('a conjunction ("do all hold?") with "all"');
    const md = (await report([path])).output;
    expect(md).toContain("## Batteries");
    expect(md).toContain("- stop.done: 100.0% of 10 combined verdicts saturated");
    // Under all, the same members are read without the warning.
    const all = new Engine({ oracle: sure });
    const g2 = all.gate({ id: "b", question: members, policy: { actAbove: 0.95 }, combine: "all" });
    for (let i = 0; i < 10; i++) await g2.ask(`s ${i}`);
    const b = (await g2.report()).battery;
    expect(b?.share).toBeLessThan(SATURATION_WARN);
    expect(describeBattery(b ?? { verdicts: 0, saturated: 0, share: 0 })).not.toContain("Combine");
  });
});

describe("a per-pair correlation matrix pools mixed members (e2e T5-02)", () => {
  const keys = ["jev113", "jev114", "haiku"];
  const ps = [0.8, 0.8, 0.3];

  it("equals the scalar shrink when every pair has one rho", () => {
    const rho = 0.4;
    const matrix = {
      jev113: { jev114: rho, haiku: rho },
      jev114: { haiku: rho },
    };
    const scalar = poolJudge(ps.map(v), { correlation: rho }).pYes;
    const gls = poolJudge(ps.map(v), { correlations: matrix, memberKeys: keys }).pYes;
    expect(gls).toBeCloseTo(scalar, 12);
    expect(poolWeights(3, { correlations: matrix, memberKeys: keys }).effectiveN).toBeCloseTo(
      3 / (1 + 2 * rho),
      12,
    );
  });

  it("discounts the near-duplicates and keeps the independent member whole", () => {
    // The track's phi matrix: two pins of one model at 0.58, each against haiku at -0.04.
    const matrix = { jev113: { jev114: 0.58, haiku: -0.04 }, jev114: { haiku: -0.04 } };
    const { weights, effectiveN } = poolWeights(3, { correlations: matrix, memberKeys: keys });
    // Negative phi is read as 0, as the scalar path reads rho: haiku keeps weight 1.
    expect(weights[0]).toBeCloseTo(1 / 1.58, 12);
    expect(weights[1]).toBeCloseTo(1 / 1.58, 12);
    expect(weights[2]).toBeCloseTo(1, 12);
    expect(effectiveN).toBeCloseTo(2 / 1.58 + 1, 12);
    // The mean rho (0.165) discounts all three alike; the matrix lets haiku's no count in full.
    const atMean = poolJudge(ps.map(v), { correlation: 0.1667 }).pYes;
    const gls = poolJudge(ps.map(v), { correlations: matrix, memberKeys: keys }).pYes;
    expect(gls).toBeLessThan(atMean);
  });

  it("survives a matrix that is not positive definite, and needs the keys", () => {
    const bad = { a: { b: 0.99, c: 0 }, b: { c: 0.99 } };
    const w = poolWeights(3, { correlations: bad, memberKeys: ["a", "b", "c"] });
    expect(w.weights.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    expect(() => poolJudge(ps.map(v), { correlations: bad })).toThrow(/memberKeys/);
    // A pair the matrix does not name takes the scalar correlation.
    const partial = poolWeights(2, {
      correlations: {},
      memberKeys: ["x", "y"],
      correlation: 0.5,
    });
    expect(partial.weights[0]).toBeCloseTo(1 / 1.5, 12);
  });

  it("pools a pick ensemble with the same weights", () => {
    const q = pick("route?", ["a", "b"], { id: "r" });
    const vs = [
      pickVerdictFrom(q, [0.8, 0.2]),
      pickVerdictFrom(q, [0.8, 0.2]),
      pickVerdictFrom(q, [0.3, 0.7]),
    ];
    const matrix = { jev113: { jev114: 0.58 } };
    const out = poolPick(q, vs, { correlations: matrix, memberKeys: keys });
    const flat = poolPick(q, vs);
    expect(out.probabilities.a).toBeLessThan(flat.probabilities.a ?? 1);
  });
});

describe("ensemble and sequential pool with the matrix by their members' keys (e2e T5-02)", () => {
  const answering = (id: string, p: number, model: string, fail = false): Oracle => ({
    id,
    async decide(_s, qs) {
      return qs.map((q) => ({
        verdict: judgeVerdictFrom(q as JudgeQuestion, p),
        oracle: id,
        model,
        latencyMs: 0,
        cost: 0,
        at: new Date().toISOString(),
        ...(fail ? { failedOpen: true, error: "down" } : {}),
      }));
    },
  });
  const q = judge("ok?", { id: "q" });
  const matrix = { jev113: { jev114: 0.58 } };
  const pYes = (d: { verdict: { kind: string } }) =>
    d.verdict.kind === "judge" ? (d.verdict as JudgeVerdict).pYes : Number.NaN;

  it("weighs each member by the matrix, and drops a failed member's key with its answer", async () => {
    const jev113: Member = { oracle: answering("a", 0.8, "jev-1.13"), label: "jev113" };
    const jev114: Member = { oracle: answering("b", 0.8, "jev-1.14"), label: "jev114" };
    const haiku: Member = { oracle: answering("c", 0.3, "haiku"), label: "haiku" };
    const out = await ensemble("s", q, { members: [jev113, jev114, haiku], correlations: matrix });
    const expected = poolJudge([v(0.8), v(0.8), v(0.3)], {
      correlations: matrix,
      memberKeys: ["jev113", "jev114", "haiku"],
    });
    expect(pYes(out)).toBeCloseTo(expected.pYes, 12);
    expect(expected.pYes).not.toBeCloseTo(poolJudge([v(0.8), v(0.8), v(0.3)]).pYes, 3);
    // Without the matrix the same members pool as they always did.
    const flat = await ensemble("s", q, { members: [jev113, jev114, haiku] });
    expect(pYes(flat)).toBeCloseTo(poolJudge([v(0.8), v(0.8), v(0.3)]).pYes, 12);
    // jev114 fails open: the pool reads jev113 and haiku under their own keys.
    const down: Member = { oracle: answering("b", 0.8, "jev-1.14", true), label: "jev114" };
    const dropped = await ensemble("s", q, {
      members: [jev113, down, haiku],
      correlations: matrix,
      minMembers: 2,
    });
    const two = poolJudge([v(0.8), v(0.3)], {
      correlations: matrix,
      memberKeys: ["jev113", "haiku"],
    });
    expect(pYes(dropped)).toBeCloseTo(two.pYes, 12);
  });

  it("reads a member sampled again as the same member", async () => {
    const members: Member[] = [
      { oracle: answering("a", 0.8, "jev-1.13"), label: "jev113" },
      { oracle: answering("c", 0.6, "haiku"), label: "haiku" },
    ];
    const out = await sequential("s", q, {
      members,
      correlations: {},
      settleAbove: 0.999,
      maxSamples: 3,
    });
    expect(out.memberKeys).toEqual(["jev113", "haiku", "jev113~2"]);
    const expected = poolJudge([v(0.8), v(0.6), v(0.8)], {
      correlations: {},
      memberKeys: ["jev113", "haiku", "jev113"],
    });
    expect(pYes(out)).toBeCloseTo(expected.pYes, 12);
    // The repeat adds almost nothing: less than pooling it as an independent third voice.
    expect(expected.pYes).toBeLessThan(poolJudge([v(0.8), v(0.6), v(0.8)]).pYes);
  });
});
