import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStateLike, Engine, type StrategySpec } from "../src/engine.ts";
import { forQuestion, refuseIf } from "../src/floors.ts";
import { hashState, JsonlLedger, MemoryLedger } from "../src/ledger/ledger.ts";
import { SimOracle, type Truth } from "../src/oracles/sim.ts";
import { judge } from "../src/questions.ts";
import type { Oracle, StateLike } from "../src/types.ts";

const items = Array.from({ length: 600 }, (_, i) => `cmd-${i}`);
const truths = new Map<string, Truth>(items.map((s, i) => [s, { judge: i % 5 !== 0 }]));
const truthOf = (s: string) => truths.get(s);
const safe = judge("Is this command safe to run without asking?", { id: "safe" });

describe("Engine", () => {
  it("shadow mode records the ruling but returns the baseline", async () => {
    const engine = new Engine({ oracle: new SimOracle({ accuracy: 0.8, seed: 1 }, truthOf) });
    const r = await engine.ask("cmd-1", safe, { policy: { actAbove: 0.9 }, baseline: "review" });
    expect(r.mode).toBe("shadow");
    expect(r.action).toBe("review");
    const [row] = await engine.ledger.all();
    expect(row?.soft).toBe(r.ruling.action);
    expect(row?.action).toBe("review");
    expect(row?.state).toBeUndefined();
    expect(row?.stateHash).toHaveLength(16);
  });

  it("enforce mode acts on the ruling, under the floors", async () => {
    const engine = new Engine({
      oracle: new SimOracle({ accuracy: 0.99, seed: 2 }, truthOf),
      mode: "enforce",
      floors: [refuseIf(/cmd-7$/)],
    });
    const ok = await engine.ask("cmd-1", safe, { policy: { actAbove: 0.6 } });
    expect(ok.action).toBe("act");
    const floored = await engine.ask("cmd-7", safe, { policy: { actAbove: 0.6 } });
    expect(floored.action).toBe("refuse");
    expect(floored.ruling.floor).toBe("refuse");
  });

  it("a dead oracle fails open into review, never into act", async () => {
    const dead: Oracle = {
      id: "dead",
      decide: async () => {
        throw new Error("boom");
      },
    };
    const engine = new Engine({ oracle: dead, mode: "enforce" });
    const r = await engine.ask("cmd-1", safe, { policy: { actAbove: 0.5 } });
    expect(r.action).toBe("review");
    expect(r.decision.failedOpen).toBe(true);
  });

  it("askAll batches single-strategy questions into one oracle call", async () => {
    const oracle = new SimOracle({ accuracy: 0.8, seed: 3 }, truthOf);
    const engine = new Engine({ oracle });
    const qs = [judge("a", { id: "a" }), judge("b", { id: "b" }), judge("c", { id: "c" })];
    await engine.askAll("cmd-1", qs, { policy: { actAbove: 0.9 } });
    expect(oracle.calls).toBe(1);
    expect((await engine.ledger.all()).length).toBe(3);
  });

  it("labels feed the report, which fits a threshold per question", async () => {
    const engine = new Engine({ oracle: new SimOracle({ accuracy: 0.8, seed: 4 }, truthOf) });
    for (const s of items) {
      const r = await engine.ask(s, safe, { policy: { actAbove: 0.9 }, baseline: "review" });
      const truth = truths.get(s)?.judge ?? false;
      await engine.label(r.recordId, {
        correct: r.decision.verdict.kind === "judge" && r.decision.verdict.pYes >= 0.5 === truth,
        truth,
      });
    }
    const report = await engine.report({ targetAccuracy: 0.9 });
    expect(report.records).toBe(items.length);
    expect(report.labelled).toBe(items.length);
    expect(report.ece ?? 1).toBeLessThan(0.05);
    const fitted = report.byQuestion.safe?.fitted;
    expect(fitted).toBeDefined();
    expect(fitted?.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(fitted?.coverage).toBeGreaterThan(0.05);
    expect(fitted?.coverage).toBeLessThan(1);
  });

  it("blind audits divert a random slice of acts to review and feed unselected fitting", async () => {
    const engine = new Engine({
      oracle: new SimOracle({ accuracy: 0.95, seed: 9 }, truthOf),
      mode: "enforce",
      auditRate: 0.5,
      seed: 1,
    });
    let acts = 0;
    let audits = 0;
    for (const s of items.slice(0, 400)) {
      const r = await engine.ask(s, safe, { policy: { actAbove: 0.6 } });
      if (r.ruling.action === "act") acts++;
      if (r.audited) {
        audits++;
        expect(r.action).toBe("review");
      }
      const truth = truths.get(s)?.judge ?? false;
      const lean = r.decision.verdict.kind === "judge" && r.decision.verdict.pYes >= 0.5;
      await engine.label(r.recordId, { correct: lean === truth, truth });
    }
    expect(audits / acts).toBeGreaterThan(0.35);
    expect(audits / acts).toBeLessThan(0.65);
    const rows = await engine.ledger.all();
    const audited = rows.filter((r) => r.tags.includes("audit"));
    expect(audited.length).toBe(audits);
    expect(audited.every((r) => r.soft === "act" && r.action === "review")).toBe(true);
    const rep = await engine.report({ targetAccuracy: 0.9 });
    expect(rep.byQuestion.safe?.fittedFrom).toBe("unselected");
    expect(rep.byQuestion.safe?.unselected).toBe(audits);
    expect(rep.byQuestion.safe?.expectedAccuracy ?? 0).toBeGreaterThan(0.85);
  });

  it("ensemble and sequential strategies run through the facade", async () => {
    const engine = new Engine({ oracle: new SimOracle({ accuracy: 0.8, seed: 5 }, truthOf) });
    const e = await engine.ask("cmd-1", safe, {
      policy: { actAbove: 0.9 },
      strategy: { ensemble: { k: 5 } },
    });
    expect(e.decision.strategy).toBe("ensemble");
    expect(e.decision.members.length).toBe(5);
    const s = await engine.ask("cmd-1", safe, {
      policy: { actAbove: 0.9 },
      strategy: { sequential: { settleAbove: 0.95, maxSamples: 7 } },
    });
    expect(s.decision.strategy).toBe("sequential");
    expect(s.decision.members.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Engine strategy safety", () => {
  const steady: Oracle = {
    id: "steady",
    decide: async (_state, questions) =>
      questions.map((q) => ({
        verdict: { kind: "judge", questionId: q.id, pYes: 0.8, confidence: 0.8 },
        oracle: "steady",
        cost: 0,
        latencyMs: 0,
        at: "2026-10-20T00:00:00Z",
      })),
  };
  const strategies: readonly {
    name: string;
    spec: (oracle: Oracle) => StrategySpec;
  }[] = [
    { name: "ensemble", spec: (oracle) => ({ ensemble: { members: [{ oracle }] } }) },
    {
      name: "sequential",
      spec: (oracle) => ({
        sequential: { members: [{ oracle }], settleAbove: 0.95, maxSamples: 2 },
      }),
    },
    {
      name: "cascade",
      spec: (oracle) => ({ cascade: { tiers: [{ oracle, settleAbove: 0.95 }] } }),
    },
  ];

  for (const strategy of strategies) {
    for (const failure of ["throw", "empty", "timeout"] as const) {
      it(`${strategy.name} records review when an explicit oracle has a ${failure} failure`, async () => {
        const oracle: Oracle = {
          id: "broken",
          decide: async () => {
            if (failure === "throw") throw new Error("backend unavailable");
            if (failure === "empty") return [];
            return new Promise(() => {});
          },
        };
        const engine = new Engine({ oracle: steady, mode: "enforce", timeoutMs: 5 });
        const result = await engine.ask("command", safe, {
          policy: { actAbove: 0.5 },
          strategy: strategy.spec(oracle),
        });
        expect(result.action).toBe("review");
        expect(result.decision.failedOpen).toBe(true);
        expect(result.decision.members.every((d) => d.failedOpen && d.error)).toBe(true);
        expect(await engine.ledger.all()).toMatchObject([
          { id: result.recordId, action: "review", failedOpen: true },
        ]);
      });
    }
  }

  it("a cascade can recover through a healthy tier after an explicit backend fails", async () => {
    const dead: Oracle = {
      id: "dead",
      decide: async () => {
        throw new Error("backend unavailable");
      },
    };
    const engine = new Engine({ oracle: steady, mode: "enforce" });
    const result = await engine.ask("command", safe, {
      policy: { actAbove: 0.7 },
      strategy: {
        cascade: {
          tiers: [
            { oracle: dead, settleAbove: 0.9 },
            { oracle: steady, settleAbove: 0.9 },
          ],
        },
      },
    });
    expect(result.action).toBe("act");
    expect(result.decision.failedOpen).not.toBe(true);
    expect(result.decision.members[0]?.failedOpen).toBe(true);
    expect(result.decision.members[1]?.oracle).toBe("steady");
    expect((await engine.ledger.all()).length).toBe(1);
  });

  it("sequential replicas use the same cautious correlation default as an ensemble", async () => {
    const engine = new Engine({ oracle: steady, mode: "enforce" });
    const ensemble = await engine.ask("command", safe, {
      policy: { actAbove: 0.98 },
      strategy: { ensemble: { k: 5 } },
    });
    const sequential = await engine.ask("command", safe, {
      policy: { actAbove: 0.98 },
      strategy: { sequential: { settleAbove: 0.98, maxSamples: 5 } },
    });
    expect(sequential.action).toBe("review");
    expect(sequential.decision.members).toHaveLength(5);
    expect(sequential.decision.verdict.confidence).toBeCloseTo(
      ensemble.decision.verdict.confidence,
      12,
    );
    const measuredIndependent = await engine.ask("command", safe, {
      policy: { actAbove: 0.98 },
      strategy: { sequential: { settleAbove: 0.98, maxSamples: 5, correlation: 0 } },
    });
    expect(measuredIndependent.action).toBe("act");
    expect(measuredIndependent.decision.members).toHaveLength(3);
  });
});

describe("JsonlLedger", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ratchet-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips decisions and outcomes through an append-only file", async () => {
    const ledger = new JsonlLedger(join(dir, "ledger.jsonl"));
    const engine = new Engine({
      oracle: new SimOracle({ accuracy: 0.8, seed: 6 }, truthOf),
      ledger,
    });
    const r = await engine.ask("cmd-2", safe, { policy: { actAbove: 0.9 } });
    expect(await engine.label(r.recordId, { correct: true })).toBe(true);
    expect(await engine.label("nope", { correct: true })).toBe(false);
    const rows = await new JsonlLedger(join(dir, "ledger.jsonl")).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome?.correct).toBe(true);
    expect(rows[0]?.gateId).toBe("adhoc:safe");
    expect(rows[0]?.requestId).toBe(r.requestId);
    expect(await new JsonlLedger(join(dir, "missing.jsonl")).all()).toEqual([]);
    expect(new MemoryLedger()).toBeDefined();
  });

  it("reads rows written before gates as their own anonymous requests", async () => {
    const path = join(dir, "legacy.jsonl");
    const legacy = {
      id: "r1",
      at: "2026-10-16T00:00:00.000Z",
      questionId: "safe",
      kind: "judge",
      prompt: "safe?",
      questionHash: "q",
      stateHash: "s",
      oracle: "sim",
      strategy: "single",
      verdict: { kind: "judge", questionId: "safe", pYes: 0.9, confidence: 0.9 },
      go: 0.9,
      confidence: 0.9,
      agreement: 1,
      soft: "review",
      action: "review",
      mode: "shadow",
      cost: 0,
      latencyMs: 1,
      failedOpen: false,
      tags: [],
    };
    await writeFile(path, `${JSON.stringify({ type: "decision", record: legacy })}\n`, "utf8");
    const [row] = await new JsonlLedger(path).all();
    expect(row).toMatchObject({
      gateId: "adhoc:safe",
      requestId: "r1",
      trustedHash: "s",
      untrusted: [],
    });
    const engine = new Engine({
      oracle: new SimOracle({ accuracy: 0.8 }, truthOf),
      ledger: new JsonlLedger(path),
    });
    expect(await engine.label("r1", { correct: true })).toBe(true);
    expect((await engine.report()).byGate["adhoc:safe"]?.labelled).toBe(1);
  });
});

describe("state input and request ids", () => {
  it("a string state is one trusted field: both hashes are its hash, nothing untrusted", async () => {
    const engine = new Engine({ oracle: new SimOracle({ accuracy: 0.8, seed: 7 }, truthOf) });
    await engine.ask("cmd-3", safe, { policy: { actAbove: 0.9 } });
    const [row] = await engine.ledger.all();
    expect(row?.stateHash).toBe(hashState("cmd-3"));
    expect(row?.trustedHash).toBe(row?.stateHash);
    expect(row?.untrusted).toEqual([]);
    expect(asStateLike("cmd-3")).toEqual({
      text: "cmd-3",
      hash: hashState("cmd-3"),
      trustedHash: hashState("cmd-3"),
      untrusted: [],
    });
  });

  it("a built state: the oracle and floors see its text, the ledger its hashes and spans", async () => {
    const seen: string[] = [];
    const sim = new SimOracle({ accuracy: 0.9, seed: 8 }, () => ({ judge: true }));
    const oracle: Oracle = {
      id: "sim",
      decide: async (state, qs) => {
        seen.push(state);
        return sim.decide(state, qs);
      },
    };
    const engine = new Engine({
      oracle,
      keepState: true,
      mode: "enforce",
      floors: [refuseIf(/DROP TABLE/)],
    });
    const state: StateLike = {
      text: "command: psql -c 'select 1'\n\n[untrusted tool_output]\nok",
      hash: "whole-render",
      trustedHash: "trusted-only",
      untrusted: ["tool_output"],
    };
    await engine.ask(state, safe, { policy: { actAbove: 0.5 } });
    const refused = await engine.ask(
      { ...state, text: "command: psql -c 'DROP TABLE users'" },
      safe,
      { policy: { actAbove: 0.5 } },
    );
    expect(seen).toEqual([state.text]);
    expect(refused.action).toBe("refuse");
    const [row] = await engine.ledger.all();
    expect(row).toMatchObject({
      stateHash: "whole-render",
      trustedHash: "trusted-only",
      untrusted: ["tool_output"],
      state: state.text,
    });
  });

  it("the report grades only rows an answer was bought for", async () => {
    const engine = new Engine({
      oracle: new SimOracle({ accuracy: 0.9, seed: 10 }, () => ({ judge: true })),
      floors: [refuseIf(/^rm/)],
    });
    const asked = await engine.ask("ls", safe, { policy: { actAbove: 0.9 } });
    const floored = await engine.ask("rm -rf /", safe, { policy: { actAbove: 0.9 } });
    await engine.label(asked.recordId, { correct: true, truth: true });
    await engine.label(floored.recordId, { correct: false, truth: false });
    const report = await engine.report();
    const q = report.byQuestion.safe;
    expect(q?.n).toBe(2);
    expect(q?.labelled).toBe(1);
    expect(q?.expectedAccuracy).toBeCloseTo(asked.decision.verdict.confidence, 12);
    expect(report.labelled).toBe(1);
  });

  it("rows from one askAll share a request id; floored questions skip the call", async () => {
    const asked: string[][] = [];
    const sim = new SimOracle({ accuracy: 0.9, seed: 9 }, () => ({ judge: true }));
    const oracle: Oracle = {
      id: "sim",
      decide: async (state, qs) => {
        asked.push(qs.map((q) => q.id));
        return sim.decide(state, qs);
      },
    };
    const engine = new Engine({ oracle, floors: [forQuestion("b", refuseIf(/x/))] });
    const qs = [judge("a?", { id: "a" }), judge("b?", { id: "b" }), judge("c?", { id: "c" })];
    const first = await engine.askAll("x", qs, { policy: { actAbove: 0.9 } });
    const second = await engine.askAll("y", qs, { policy: { actAbove: 0.9 } });
    expect(asked).toEqual([
      ["a", "c"],
      ["a", "b", "c"],
    ]);
    expect(first[1]?.decision.strategy).toBe("floored");
    expect(new Set(first.map((r) => r.requestId)).size).toBe(1);
    expect(new Set(second.map((r) => r.requestId)).size).toBe(1);
    expect(first[0]?.requestId).not.toBe(second[0]?.requestId);
    const rows = await engine.ledger.all();
    expect(rows.map((r) => r.gateId)).toEqual([
      "adhoc:a",
      "adhoc:b",
      "adhoc:c",
      "adhoc:a",
      "adhoc:b",
      "adhoc:c",
    ]);
  });
});
