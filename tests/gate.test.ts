import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { poolJudge } from "../src/compound/aggregate.ts";
import {
  batteryFeatures,
  fitLogistic,
  type LogisticModel,
  poolLearned,
} from "../src/compound/learned.ts";
import { Engine } from "../src/engine.ts";
import { forQuestion, refuseIf } from "../src/floors.ts";
import { type DecisionRecord, decisionRows, hashState, JsonlLedger } from "../src/ledger/ledger.ts";
import { judgeIf, RuleOracle } from "../src/oracles/rules.ts";
import { SimOracle, type Truth } from "../src/oracles/sim.ts";
import { judge, pick } from "../src/questions.ts";
import type { JudgeVerdict, Oracle, Question } from "../src/types.ts";

const always = (judgeAnswer: boolean) => (): Truth => ({ judge: judgeAnswer });
const safe = judge("Is this command safe to run without asking?", { id: "safe" });

/** The four-question "done" battery from the Stop-hook verifier, every member phrased so yes means done. */
const doneBattery = [
  judge("Do the reported tests pass?", { id: "tests_pass" }),
  judge("Does the diff do what the agent claims?", { id: "claims_match" }),
  judge("Is the requested change complete?", { id: "complete" }),
  judge("Is the change free of unrelated edits?", { id: "scoped" }),
] as const;

/** A SimOracle that records which questions each call carried. */
function recording(sim: SimOracle): Oracle & { readonly seen: string[][] } {
  const seen: string[][] = [];
  return {
    id: sim.id,
    seen,
    decide: async (state, qs) => {
      seen.push(qs.map((q) => q.id));
      return sim.decide(state, qs);
    },
  };
}

describe("gate registration", () => {
  it("registers, lists, and refuses duplicate, reserved or malformed specs", () => {
    const engine = new Engine({ oracle: new SimOracle({ accuracy: 0.9 }, always(true)) });
    const g = engine.gate({ id: "bash.safe", question: safe, policy: { actAbove: 0.9 } });
    expect(engine.gates.get("bash.safe")).toBe(g);
    expect([...engine.gates.keys()]).toEqual(["bash.safe"]);
    expect(g.isBattery).toBe(false);
    expect(() =>
      engine.gate({ id: "bash.safe", question: safe, policy: { actAbove: 0.9 } }),
    ).toThrow(/already registered/);
    expect(() => engine.gate({ id: "adhoc:x", question: safe, policy: { actAbove: 0.9 } })).toThrow(
      /reserved/,
    );
    expect(() =>
      engine.gate({ id: "c", question: safe, combine: "max", policy: { actAbove: 0.9 } }),
    ).toThrow(/batteries only/);
    expect(() =>
      engine.gate({
        id: "d",
        question: [judge("a?", { id: "a" }), judge("b?", { id: "a" })],
        policy: { actAbove: 0.9 },
      }),
    ).toThrow(/distinct/);
    expect(() =>
      engine.gate({
        id: "e",
        question: [judge("a?", { id: "a" }), judge("b?", { id: "b" })],
        combine: { weights: [1], bias: 0 },
        policy: { actAbove: 0.9 },
      }),
    ).toThrow(/weights/);
    expect(() =>
      engine.gate({
        id: "f",
        question: [judge("a?", { id: "a" })],
        strategy: { ensemble: { k: 3 } },
        policy: { actAbove: 0.9 },
      }),
    ).toThrow(/one request/);
    expect(() => g.rollout).toThrow(/promisedAccuracy/);
  });

  it("records gate asks under the gate id and other asks under an anonymous gate", async () => {
    const sim = new SimOracle({ accuracy: 0.9, seed: 1 }, always(true));
    const engine = new Engine({ oracle: sim });
    const g = engine.gate({ id: "bash.safe", question: safe, policy: { actAbove: 0.9 } });
    const a = await g.ask("ls");
    const b = await engine.ask("ls", safe, { policy: { actAbove: 0.9 } });
    const other = judge("Is this read-only?", { id: "readonly" });
    const c = await engine.ask("ls", other, { policy: { actAbove: 0.9 } });
    expect(a.gateId).toBe("bash.safe");
    expect(b.gateId).toBe("bash.safe");
    expect(c.gateId).toBe("adhoc:readonly");
    const rows = await engine.ledger.all();
    expect(rows.map((r) => r.gateId)).toEqual(["bash.safe", "bash.safe", "adhoc:readonly"]);
    expect(new Set(rows.map((r) => r.requestId)).size).toBe(3);
    expect(engine.gates.has("adhoc:readonly")).toBe(false);
  });

  it("askAll maps each question to its gate and still makes one oracle call", async () => {
    const sim = new SimOracle({ accuracy: 0.9, seed: 2 }, always(true));
    const oracle = recording(sim);
    const engine = new Engine({ oracle });
    engine.gate({ id: "bash.safe", question: safe, policy: { actAbove: 0.9 } });
    const rev = pick("How reversible?", ["irreversible", "reversible"], { id: "rev" });
    const rs = await engine.askAll("rm -rf build", [safe, rev], { policy: { actAbove: 0.9 } });
    expect(oracle.seen).toEqual([["safe", "rev"]]);
    expect(rs.map((r) => r.gateId)).toEqual(["bash.safe", "adhoc:rev"]);
    expect(rs[0]?.requestId).toBe(rs[1]?.requestId);
  });
});

describe("per-gate mode and audit", () => {
  it("a gate's mode overrides the engine's; an unset gate follows the engine", async () => {
    const sim = new SimOracle({ accuracy: 0.99, seed: 3 }, always(true));
    const engine = new Engine({ oracle: sim, mode: "shadow" });
    const pinned = engine.gate({
      id: "pinned",
      question: judge("ok?", { id: "p" }),
      policy: { actAbove: 0.5 },
      mode: "enforce",
    });
    const follows = engine.gate({
      id: "follows",
      question: judge("ok?", { id: "f" }),
      policy: { actAbove: 0.5 },
    });
    const a = await pinned.ask("s", { baseline: "review" });
    expect(a.mode).toBe("enforce");
    expect(a.action).toBe(a.ruling.action);
    const b = await follows.ask("s", { baseline: "refuse" });
    expect(b.mode).toBe("shadow");
    expect(b.action).toBe("refuse");
    engine.mode = "enforce";
    expect(follows.mode).toBe("enforce");
    pinned.mode = "shadow";
    expect(pinned.mode).toBe("shadow");
    expect(engine.mode).toBe("enforce");
    const c = await pinned.ask("s");
    expect(c.mode).toBe("shadow");
    const rows = await engine.ledger.all();
    expect(rows.map((r) => r.mode)).toEqual(["enforce", "shadow", "shadow"]);
  });

  it("a gate's audit rate overrides the engine's", async () => {
    const sim = new SimOracle({ accuracy: 0.99, seed: 4 }, always(true));
    const engine = new Engine({ oracle: sim, mode: "enforce", auditRate: 0, seed: 1 });
    const audited = engine.gate({
      id: "audited",
      question: judge("ok?", { id: "a" }),
      policy: { actAbove: 0.5 },
      auditRate: 1,
    });
    const plain = engine.gate({
      id: "plain",
      question: judge("ok?", { id: "b" }),
      policy: { actAbove: 0.5 },
    });
    expect(audited.auditRate).toBe(1);
    expect(plain.auditRate).toBe(0);
    for (let i = 0; i < 20; i++) {
      const a = await audited.ask(`s${i}`);
      const b = await plain.ask(`s${i}`);
      if (a.ruling.action === "act") {
        expect(a.audited).toBe(true);
        expect(a.action).toBe("review");
      }
      expect(b.audited).toBe(false);
    }
    const rows = await engine.ledger.all();
    const auditRows = rows.filter((r) => r.tags.includes("audit"));
    expect(auditRows.length).toBeGreaterThan(10);
    expect(auditRows.every((r) => r.gateId === "audited")).toBe(true);
  });

  it("gate floors bind that gate only; engine floors bind every gate", async () => {
    const sim = recording(new SimOracle({ accuracy: 0.99, seed: 5 }, always(true)));
    const engine = new Engine({ oracle: sim, mode: "enforce", floors: [refuseIf(/mkfs/)] });
    const strict = engine.gate({
      id: "strict",
      question: judge("ok?", { id: "s" }),
      policy: { actAbove: 0.5 },
      floors: [refuseIf(/--force/)],
    });
    const lax = engine.gate({
      id: "lax",
      question: judge("ok?", { id: "l" }),
      policy: { actAbove: 0.5 },
    });
    expect((await strict.ask("git push --force")).action).toBe("refuse");
    expect((await lax.ask("git push --force")).action).not.toBe("refuse");
    expect((await lax.ask("mkfs /dev/sda")).action).toBe("refuse");
    expect(sim.seen).toEqual([["l"]]);
  });
});

describe("gates as askers", () => {
  it("askAll through a gate records every question under the gate, its floors applied", async () => {
    const sim = recording(new SimOracle({ accuracy: 0.9, seed: 6 }, always(true)));
    const engine = new Engine({ oracle: sim });
    const keep = engine.gate({
      id: "context.keep",
      question: judge("Is this item still needed?", { id: "keep" }),
      policy: { actAbove: 0.5 },
      floors: [refuseIf(/secret/)],
      tags: ["compaction"],
    });
    const qs = [judge("a?", { id: "a" }), judge("b?", { id: "b" })];
    const open = await keep.askAll("items a and b", qs, { policy: { actAbove: 0.3 } });
    const shut = await keep.askAll("items with a secret", qs, { policy: { actAbove: 0.3 } });
    expect(sim.seen).toEqual([["a", "b"]]);
    expect([...open, ...shut].every((r) => r.gateId === "context.keep")).toBe(true);
    expect(shut.every((r) => r.decision.strategy === "floored")).toBe(true);
    const rows = await engine.ledger.all();
    expect(rows.every((r) => r.tags.includes("compaction"))).toBe(true);
  });

  it("askMany keeps input order, bounds concurrency, and fails open past the budget", async () => {
    const sim = new SimOracle({ accuracy: 0.9, seed: 7, costPerQuestion: 0.001 }, always(true));
    let inFlight = 0;
    let peak = 0;
    const slow: Oracle = {
      id: "slow-sim",
      decide: async (state, qs) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        try {
          return await sim.decide(state, qs);
        } finally {
          inFlight--;
        }
      },
    };
    const engine = new Engine({ oracle: slow, budgetUsd: 0.005 });
    const g = engine.gate({
      id: "many",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.9 },
    });
    const states = Array.from({ length: 12 }, (_, i) => `state-${i}`);
    const rs = await g.askMany(states, { concurrency: 3 });
    expect(rs.length).toBe(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    const rows = new Map((await engine.ledger.all()).map((r) => [r.id, r]));
    rs.forEach((r, i) => {
      expect(rows.get(r.recordId)?.stateHash).toBe(hashState(states[i] as string));
    });
    expect(new Set(rs.map((r) => r.requestId)).size).toBe(12);
    expect(sim.calls).toBeLessThan(12);
    expect(rs.filter((r) => r.decision.failedOpen).length).toBe(12 - sim.calls);
    expect(rs.filter((r) => r.decision.failedOpen).every((r) => r.action === "review")).toBe(true);
  });
});

describe("batteries", () => {
  it("asks every member in one request and rules on the log-odds combination", async () => {
    const sim = new SimOracle({ accuracy: 0.85, seed: 8, costPerQuestion: 0.001 }, always(true));
    const engine = new Engine({ oracle: sim, mode: "enforce" });
    const done = engine.gate({ id: "stop.done", question: doneBattery, policy: { actAbove: 0.9 } });
    expect(done.isBattery).toBe(true);
    const r = await done.ask("diff summary; tests: 12 passed; claims: fixed the rounding bug");
    expect(sim.calls).toBe(1);
    expect(r.decision.strategy).toBe("battery");
    expect(r.decision.members.length).toBe(4);
    const memberVerdicts = r.decision.members.map((m) => m.verdict as JudgeVerdict);
    const expected = poolJudge(memberVerdicts, { method: "logodds" }).pYes;
    expect(r.decision.verdict.pYes).toBeCloseTo(expected, 10);
    expect(r.decision.verdict.questionId).toBe("stop.done");
    expect(r.ruling.go).toBeCloseTo(expected, 10);
    expect(r.action).toBe(expected >= 0.9 ? "act" : "review");
    expect(r.decision.cost).toBeCloseTo(0.004, 10);

    const rows = await engine.ledger.all();
    expect(rows.length).toBe(5);
    expect(rows.every((x) => x.gateId === "stop.done" && x.requestId === r.requestId)).toBe(true);
    const combined = rows.filter((x) => x.combined === true);
    expect(combined.length).toBe(1);
    expect(combined[0]).toMatchObject({
      id: r.recordId,
      questionId: "stop.done",
      strategy: "battery",
      cost: 0,
      soft: r.ruling.action,
    });
    const members = rows.filter((x) => x.combined === undefined);
    expect(members.map((x) => x.questionId)).toEqual(doneBattery.map((q) => q.id));
    expect(members.every((x) => x.action === r.action && x.mode === "enforce")).toBe(true);
    expect(members.reduce((s, x) => s + x.cost, 0)).toBeCloseTo(0.004, 10);
    expect(engine.spent).toBeCloseTo(0.004, 10);
    expect(decisionRows(rows).map((x) => x.id)).toEqual([r.recordId]);
  });

  it("combines with a pool method, pool options, a learned model, or a function", async () => {
    const sim = new SimOracle({ accuracy: 0.8, seed: 9 }, always(true));
    const engine = new Engine({ oracle: sim });
    const model: LogisticModel = { weights: [1.5, 0.2, 0.8, 0.4], bias: -0.3 };
    const any = engine.gate({
      id: "any",
      question: doneBattery,
      combine: "max",
      policy: { actAbove: 0.9 },
    });
    const shrunk = engine.gate({
      id: "shrunk",
      question: doneBattery,
      combine: { method: "logodds", correlation: 0.5 },
      policy: { actAbove: 0.9 },
    });
    const learned = engine.gate({
      id: "learned",
      question: doneBattery,
      combine: model,
      policy: { actAbove: 0.9 },
    });
    const fn = engine.gate({
      id: "fn",
      question: doneBattery,
      combine: (vs) => ({ kind: "judge", questionId: "x", pYes: 2, confidence: 1 - vs.length }),
      policy: { actAbove: 0.9 },
    });
    const vsOf = (r: { decision: { members: readonly { verdict: unknown }[] } }) =>
      r.decision.members.map((m) => m.verdict as JudgeVerdict);
    const a = await any.ask("s");
    expect(a.decision.verdict.pYes).toBeCloseTo(Math.max(...vsOf(a).map((v) => v.pYes)), 10);
    const b = await shrunk.ask("s");
    expect(b.decision.verdict.pYes).toBeCloseTo(
      poolJudge(vsOf(b), { method: "logodds", correlation: 0.5 }).pYes,
      10,
    );
    const c = await learned.ask("s");
    expect(c.decision.verdict.pYes).toBeCloseTo(poolLearned(vsOf(c), model).pYes, 10);
    expect(c.decision.detail).toMatchObject({ combine: "learned", members: 4 });
    const d = await fn.ask("s");
    // Whatever a custom combiner returns is normalised: clamped, re-scored, renamed.
    expect(d.decision.verdict).toEqual({ kind: "judge", questionId: "fn", pYes: 1, confidence: 1 });
    const hashes = (await engine.ledger.all()).filter((r) => r.combined).map((r) => r.questionHash);
    expect(new Set(hashes).size).toBe(4);
  });

  it("fails open when any member fails open, and floors settle a battery without a call", async () => {
    const partial = new RuleOracle([judgeIf(/./, 0.95)]);
    const half: Oracle = {
      id: "half",
      decide: async (state, qs) => {
        const ds = await partial.decide(state, qs);
        return ds.map((d, i) =>
          i === 1 ? { ...d, failedOpen: true, error: "member timed out" } : d,
        );
      },
    };
    const engine = new Engine({
      oracle: half,
      mode: "enforce",
      floors: [forQuestion("guarded", refuseIf(/rm -rf/))],
    });
    const g = engine.gate({ id: "battery", question: doneBattery, policy: { actAbove: 0.5 } });
    const r = await g.ask("s");
    expect(r.decision.failedOpen).toBe(true);
    expect(r.decision.error).toBe("member timed out");
    expect(r.action).toBe("review");
    const guarded = engine.gate({
      id: "guarded",
      question: doneBattery,
      policy: { actAbove: 0.5 },
    });
    const f = await guarded.ask("rm -rf /");
    expect(f.action).toBe("refuse");
    expect(f.decision.strategy).toBe("floored");
    const rows = (await engine.ledger.all()).filter((x) => x.gateId === "guarded");
    expect(rows.length).toBe(1);
    expect(rows[0]?.combined).toBe(true);
  });

  it("labels on the combined row reach the members in a memory ledger", async () => {
    const sim = new SimOracle({ accuracy: 0.8, seed: 10 }, always(true));
    const engine = new Engine({ oracle: sim });
    const g = engine.gate({ id: "stop.done", question: doneBattery, policy: { actAbove: 0.9 } });
    const r = await g.ask("s1");
    expect(await engine.label(r.recordId, { correct: true, truth: true, note: "reviewed" })).toBe(
      true,
    );
    const rows = await engine.ledger.all();
    const members = rows.filter((x) => !x.combined);
    expect(members.length).toBe(4);
    for (const m of members) {
      const lean = (m.verdict as JudgeVerdict).pYes >= 0.5;
      expect(m.outcome).toMatchObject({ truth: true, correct: lean, inheritedFrom: r.recordId });
      expect(m.outcome?.note).toBe("reviewed");
    }
    // Without a boolean truth, the battery's truth is recovered from its lean and `correct`.
    const s = await g.ask("s2");
    const leanYes = s.decision.verdict.pYes >= 0.5;
    await engine.label(s.recordId, { correct: false });
    const second = (await engine.ledger.all()).filter(
      (x) => x.requestId === s.requestId && !x.combined,
    );
    expect(second.every((m) => m.outcome?.truth === !leanYes)).toBe(true);
    // Labelling a member directly touches nothing else.
    const firstMember = second[0] as DecisionRecord;
    await engine.label(firstMember.id, { correct: true, truth: true });
    const combinedRow = (await engine.ledger.all()).find((x) => x.id === s.recordId);
    expect(combinedRow?.outcome?.correct).toBe(false);
  });

  it("member rows inherit enough to fit a learned combiner from the ledger", async () => {
    const battery = [
      judge("Signal one?", { id: "one" }),
      judge("Signal two?", { id: "two" }),
      judge("Unrelated?", { id: "noise" }),
    ] as const;
    const truthOf = (state: string, q: Question): Truth => {
      const i = Number(state.slice(1));
      return { judge: q.id === "noise" ? i % 3 === 0 : i % 2 === 0 };
    };
    const engine = new Engine({ oracle: new SimOracle({ accuracy: 0.8, seed: 11 }, truthOf) });
    const g = engine.gate({ id: "signals", question: battery, policy: { actAbove: 0.9 } });
    for (let i = 0; i < 300; i++) {
      const r = await g.ask(`s${i}`);
      const truth = i % 2 === 0;
      await engine.label(r.recordId, { correct: r.decision.verdict.pYes >= 0.5 === truth, truth });
    }
    const rows = await engine.ledger.all();
    const byRequest = new Map<string, DecisionRecord[]>();
    for (const r of rows.filter((x) => !x.combined && x.gateId === "signals")) {
      byRequest.set(r.requestId, [...(byRequest.get(r.requestId) ?? []), r]);
    }
    const training = [...byRequest.values()].map((ms) => ({
      x: batteryFeatures(ms.map((m) => m.verdict as JudgeVerdict)),
      y: ms[0]?.outcome?.truth === true,
    }));
    expect(training.length).toBe(300);
    const model = fitLogistic(training);
    const [w1, w2, wNoise] = model.weights.map(Math.abs) as [number, number, number];
    expect(wNoise).toBeLessThan(w1 / 2);
    expect(wNoise).toBeLessThan(w2 / 2);
    const report = await engine.report();
    expect(report.byGate.signals?.n).toBe(300);
    expect(report.byQuestion.noise?.labelled).toBe(300);
    expect(report.byQuestion.one?.accuracy ?? 0).toBeGreaterThan(
      report.byQuestion.noise?.accuracy ?? 1,
    );
  });
});

describe("battery labels in a JSONL ledger", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ratchet-gate-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one outcome line per row and joins them on read", async () => {
    const path = join(dir, "battery.jsonl");
    const engine = new Engine({
      oracle: new SimOracle({ accuracy: 0.8, seed: 12 }, always(true)),
      ledger: new JsonlLedger(path),
    });
    const g = engine.gate({ id: "stop.done", question: doneBattery, policy: { actAbove: 0.9 } });
    const r = await g.ask("s");
    await engine.label(r.recordId, { correct: true, truth: true });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual([
      "decision",
      "decision",
      "decision",
      "decision",
      "decision",
      "outcome",
      "outcome",
      "outcome",
      "outcome",
      "outcome",
    ]);
    const rows = await new JsonlLedger(path).all();
    expect(rows.every((x) => x.outcome?.truth === true)).toBe(true);
    expect(rows.filter((x) => x.outcome?.inheritedFrom === r.recordId).length).toBe(4);
    expect((await g.report()).labelled).toBe(1);
  });
});
