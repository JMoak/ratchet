import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import { memberCorrelation } from "../src/ledger/calibration.ts";
import { type DecisionRecord, inheritOutcome, MemoryLedger } from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom, pick, pickVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle, PickQuestion } from "../src/types.ts";

/** Answers each battery member from the state's own facts: right on its own question. */
const perfect: Oracle = {
  id: "perfect",
  async decide(state, qs) {
    return qs.map((q) => {
      const ok =
        q.id === "m.numbers" ? !state.includes("numbers:bad") : !state.includes("complete:bad");
      return {
        verdict: judgeVerdictFrom(q as JudgeQuestion, ok ? 0.98 : 0.02),
        oracle: "perfect",
        model: "m-1",
        latencyMs: 0,
        cost: 0,
        at: new Date().toISOString(),
      };
    });
  },
};

/** The verifier repro: a conjunctive battery, 10 good outputs, 5 wrong numbers, 5 incomplete. */
async function conjunctive(withMemberTruths: boolean) {
  const ledger = new MemoryLedger();
  const engine = new Engine({ oracle: perfect, ledger });
  const gate = engine.gate({
    id: "verify.battery",
    question: [
      judge("Do the numbers match the sources?", { id: "m.numbers" }),
      judge("Is every requested item present?", { id: "m.complete" }),
    ],
    combine: "all",
    policy: { actAbove: 0.9 },
  });
  const states = [
    ...Array.from({ length: 10 }, (_, i) => `item ${i} numbers:ok complete:ok`),
    ...Array.from({ length: 5 }, (_, i) => `item ${10 + i} numbers:bad complete:ok`),
    ...Array.from({ length: 5 }, (_, i) => `item ${15 + i} numbers:ok complete:bad`),
  ];
  for (const s of states) {
    const numbers = !s.includes("numbers:bad");
    const complete = !s.includes("complete:bad");
    const truth = numbers && complete;
    const r = await gate.ask(s);
    await engine.label(r.recordId, {
      correct: r.decision.verdict.pYes >= 0.5 === truth,
      truth,
      source: "review:blind",
      ...(withMemberTruths
        ? { memberTruths: { "m.numbers": numbers, "m.complete": complete } }
        : {}),
    });
  }
  return { engine, rows: await ledger.all() };
}

describe("a battery member carries its own truth when the label gives one (e2e T3-07, T2-06)", () => {
  it("scores each member on its own question, not on the composite", async () => {
    const { engine } = await conjunctive(true);
    const rep = await engine.report();
    expect(rep.byQuestion["m.numbers"]?.accuracy).toBe(1);
    expect(rep.byQuestion["m.complete"]?.accuracy).toBe(1);
    expect(rep.byGate["verify.battery"]?.accuracy).toBe(1);
  });

  it("without member truths, scores members against the battery's truth, as documented", async () => {
    // A member that rightly says "the numbers match" on an incomplete output is marked wrong.
    const { engine } = await conjunctive(false);
    const rep = await engine.report();
    expect(rep.byQuestion["m.numbers"]?.accuracy).toBe(0.75);
    expect(rep.byQuestion["m.complete"]?.accuracy).toBe(0.75);
  });

  it("recovers a member's truth even when the battery's own truth cannot be", () => {
    const row = (over: Partial<DecisionRecord>) =>
      ({
        id: "m",
        gateId: "g",
        requestId: "r",
        questionId: "m.numbers",
        verdict: { kind: "judge", questionId: "m.numbers", pYes: 0.9, confidence: 0.9 },
        ...over,
      }) as DecisionRecord;
    const combined = row({
      id: "c",
      combined: true,
      questionId: "g",
      failedOpen: true,
      verdict: { kind: "judge", questionId: "g", pYes: 0.5, confidence: 0.5 },
    });
    const at = "2026-11-12T00:00:00.000Z";
    expect(inheritOutcome(combined, row({}), { at, correct: false })).toBeUndefined();
    expect(
      inheritOutcome(combined, row({}), {
        at,
        correct: false,
        memberTruths: { "m.numbers": true },
      }),
    ).toEqual({ at, correct: true, truth: true, inheritedFrom: "c" });
    // A member a present map does not name stays unlabelled, never the composite's truth
    // (wave 3, M1); a prototype key is no name. Without a map it takes the battery's truth.
    const other = row({ id: "o", questionId: "constructor" });
    const live = { ...combined, failedOpen: false };
    expect(
      inheritOutcome(live, other, {
        at,
        correct: true,
        truth: false,
        memberTruths: { "m.numbers": true },
      }),
    ).toBeUndefined();
    expect(inheritOutcome(live, other, { at, correct: true, truth: false })).toMatchObject({
      truth: false,
      correct: false,
    });
  });
});

describe("memberCorrelation reads batteries, pick and rate, and no-variance pairs (e2e T2-06, T5-06, T5-07)", () => {
  it("pairs a battery's member rows by request", async () => {
    const { rows } = await conjunctive(true);
    const mc = memberCorrelation(rows);
    expect(mc.n).toBe(20);
    // Both members were right on every row of their own question: no variance, no phi.
    expect(mc.pairs).toEqual([{ keys: ["m.complete", "m.numbers"], n: 20 }]);
    expect(mc.mean).toBeUndefined();
    expect(mc.matrix).toBeUndefined();
  });

  it("measures battery members against the composite when the label names no member truth", async () => {
    // Each member is wrong on the five items only the other one's question fails: phi -1/3.
    const { rows } = await conjunctive(false);
    const mc = memberCorrelation(rows);
    // Against the composite, a perfect member reads 15 of 20, and the pair reads anti-correlated
    // though on their own questions neither was ever wrong.
    expect(mc.pairs).toHaveLength(1);
    expect(mc.pairs[0]?.correlation).toBeCloseTo(-1 / 3, 12);
    expect(mc.matrix?.["m.numbers"]?.["m.complete"]).toBeCloseTo(-1 / 3, 12);
    expect(mc.matrix?.["m.complete"]?.["m.numbers"]).toBeCloseTo(-1 / 3, 12);
  });

  it("reads no information as no information: identical replicas never wrong have no phi", async () => {
    const ledger = new MemoryLedger();
    const oracle: Oracle = {
      id: "replica",
      async decide(_s, qs) {
        return qs.map((q) => ({
          verdict: judgeVerdictFrom(q as JudgeQuestion, 0.8),
          oracle: "replica",
          latencyMs: 0,
          cost: 0,
          at: new Date().toISOString(),
        }));
      },
    };
    const engine = new Engine({ oracle, ledger });
    const gate = engine.gate({
      id: "easy.gate",
      question: judge("Is it safe?", { id: "easy" }),
      policy: { actAbove: 0.9 },
      strategy: { ensemble: { k: 3 } },
    });
    for (let i = 0; i < 40; i++) {
      const r = await gate.ask(`state ${i}`);
      await engine.label(r.recordId, { correct: true, truth: true, source: "review:blind" });
    }
    const mc = memberCorrelation(await ledger.all());
    expect(mc.n).toBe(40);
    expect(mc.pairs).toHaveLength(3);
    expect(mc.pairs.every((p) => p.correlation === undefined && p.n === 40)).toBe(true);
    // Before, every pair read 0 and the mean 0: three identical voters pooled as independent.
    expect(mc.mean).toBeUndefined();
  });

  it("scores pick members by name against a string truth", async () => {
    const ledger = new MemoryLedger();
    // Every replica is wrong on the same third of the items: perfectly correlated errors.
    const oracle: Oracle = {
      id: "picker",
      async decide(state, qs) {
        const choice = Number(state.split(" ")[1]) % 3 === 0 ? "b" : "a";
        return qs.map((q) => ({
          verdict: pickVerdictFrom(
            q as PickQuestion,
            (q as PickQuestion).options.map((o) => (o === choice ? 0.7 : 0.15)),
          ),
          oracle: "picker",
          latencyMs: 0,
          cost: 0,
          at: new Date().toISOString(),
        }));
      },
    };
    const engine = new Engine({ oracle, ledger });
    const gate = engine.gate({
      id: "route.gate",
      question: pick("Which queue?", ["a", "b", "c"], { id: "route" }),
      policy: { actAbove: 0.9 },
      strategy: { ensemble: { k: 3 } },
    });
    for (let i = 0; i < 30; i++) {
      const r = await gate.ask(`state ${i}`);
      const choice = r.decision.verdict.kind === "pick" ? r.decision.verdict.choice : "";
      await engine.label(r.recordId, { correct: choice === "a", truth: "a" });
    }
    const mc = memberCorrelation(await ledger.all());
    expect(mc.n).toBe(30);
    expect(mc.pairs).toHaveLength(3);
    for (const p of mc.pairs) expect(p.correlation).toBeCloseTo(1, 12);
    expect(mc.mean).toBeCloseTo(1, 12);
  });
});
