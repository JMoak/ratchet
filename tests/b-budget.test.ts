import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import { type DecisionRecord, JsonlLedger, MemoryLedger } from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import { DailySpend } from "../src/spend.ts";
import type { Decision, JudgeQuestion, Oracle, Question } from "../src/types.ts";

/** A provider that bills `price` per call and reports `reported(price)` as the call's cost. */
class Priced implements Oracle {
  calls = 0;
  billed = 0;
  constructor(
    readonly id: string,
    private readonly price: number,
    private readonly reported: (price: number) => number = (p) => p,
    private readonly latencyMs = 0,
  ) {}
  async decide(_state: string, questions: readonly Question[]): Promise<Decision[]> {
    this.calls++;
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    this.billed += this.price;
    return questions.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, 0.3),
      oracle: this.id,
      latencyMs: this.latencyMs,
      cost: this.reported(this.price) / questions.length,
      at: new Date().toISOString(),
    }));
  }
}

/** Answers with `costUnknown` on the calls `unknown(i)` names, as a timed-out call records. */
class Unknowing implements Oracle {
  calls = 0;
  constructor(
    readonly id: string,
    private readonly unknown: (call: number) => boolean,
    private readonly price = 0.01,
  ) {}
  async decide(_state: string, questions: readonly Question[]): Promise<Decision[]> {
    const call = this.calls++;
    const blind = this.unknown(call);
    return questions.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, 0.3),
      oracle: this.id,
      latencyMs: 1,
      cost: blind ? 0 : this.price / questions.length,
      at: new Date().toISOString(),
      ...(blind ? { costUnknown: true as const, error: "oracle timed out after 10 ms" } : {}),
    }));
  }
}

const q = judge("Is this safe?", { id: "safe" });
const policy = { actAbove: 0.9 };
const states = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`);

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-b-budget-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("invalid reported costs never lower or freeze spend (e2e T4-06)", () => {
  for (const [name, reported] of [
    ["NaN", () => Number.NaN],
    ["negative", (p: number) => -p],
  ] as const) {
    it(`a ${name} cost with a reservation is charged at the reservation, and the cap trips`, async () => {
      const oracle = new Priced("p", 0.01, reported);
      const engine = new Engine({ oracle, budgetUsd: 0.05, reserveUsd: 0.01 });
      const gate = engine.gate({ id: "g", question: q, policy });
      await gate.askMany(states(100, name), { concurrency: 1 });
      // Old code: engine.spent went NaN (or negative) and all 100 asks reached the oracle.
      expect(oracle.calls).toBe(5);
      expect(Number.isFinite(engine.spent)).toBe(true);
      expect(engine.spent).toBeCloseTo(0.05, 9);
      const rows = await engine.ledger.all();
      const charged = rows.filter((r) => r.costEstimate !== undefined);
      expect(charged.length).toBe(5);
      expect(charged.every((r) => r.cost === 0.01 && r.costEstimate?.basis === "reserve")).toBe(
        true,
      );
    });

    it(`a ${name} cost with nothing to price it by stops the instance after one call`, async () => {
      const oracle = new Priced("p", 0.01, reported);
      const engine = new Engine({ oracle, budgetUsd: 0.05 });
      const gate = engine.gate({ id: "g", question: q, policy });
      const rs = await gate.askMany(states(20, name), { concurrency: 1 });
      expect(oracle.calls).toBe(1);
      expect(engine.overBudget).toBe(true);
      expect(rs[1]?.decision.detail).toMatchObject({ budgetExhausted: true, unpriced: 1 });
      expect((await engine.ledger.all())[0]?.costEstimate?.basis).toBe("none");
    });
  }

  it("DailySpend.record never subtracts or NaNs the day", async () => {
    const ds = new DailySpend(new MemoryLedger(), { capUsd: 1, reserveUsd: 0.02 });
    await ds.reserve();
    ds.record(0.1);
    ds.record(-5);
    ds.record(Number.NaN);
    ds.record("0.5" as unknown as number);
    // 0.1 plus three invalid costs charged at the 0.02 reservation.
    expect((await ds.snapshot()).spentUsd).toBeCloseTo(0.16, 12);
  });

  it("a negative cost in the ledger cannot reopen a spent day on restart", async () => {
    const path = join(dir, "negative.jsonl");
    const today = new Date().toISOString();
    const row = (id: string, cost: unknown) => ({
      type: "decision",
      record: {
        id,
        at: today,
        gateId: "g",
        requestId: id,
        questionId: "safe",
        kind: "judge",
        prompt: "Is this safe?",
        questionHash: "0000000000000000",
        stateHash: "0000000000000000",
        trustedHash: "0000000000000000",
        untrusted: [],
        oracle: "fake",
        strategy: "single",
        verdict: { kind: "judge", questionId: "safe", pYes: 0.3, confidence: 0.7 },
        go: 0.3,
        confidence: 0.7,
        agreement: 1,
        soft: "review",
        action: "review",
        mode: "shadow",
        cost,
        latencyMs: 1,
        failedOpen: false,
        tags: [],
      },
    });
    const lines = [...[0, 1, 2, 3, 4].map((i) => row(`ok${i}`, 0.01)), row("bad", -1)];
    await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const oracle = new Priced("p", 0.01);
    const engine = new Engine({
      oracle,
      ledger: new JsonlLedger(path),
      dailyBudgetUsd: 0.05,
      reserveUsd: 0.01,
    });
    await engine.gate({ id: "g", question: q, policy }).askMany(states(20, "x"));
    // Old code read the day as 0.05 - 1 = -0.95 spent and made every call.
    expect(oracle.calls).toBe(0);
    const bad = (await engine.ledger.all()).find((r) => r.id === "bad");
    expect(bad).toMatchObject({ cost: 0, costEstimate: { basis: "none" } });
  });
});

describe("an unknown cost is counted, never free (e2e T4-05)", () => {
  it("a timed-out call is charged at the costliest request on record", async () => {
    const oracle = new Unknowing("u", (call) => call >= 1);
    const engine = new Engine({ oracle, budgetUsd: 0.05 });
    const gate = engine.gate({ id: "g", question: q, policy });
    await gate.askMany(states(50, "t"), { concurrency: 1 });
    // One priced call at 0.01 teaches the price; every unknown is charged at it.
    expect(oracle.calls).toBe(5);
    const rows = await engine.ledger.all();
    expect(rows[1]).toMatchObject({
      cost: 0.01,
      costEstimate: { basis: "largest", reason: expect.stringContaining("timed out") },
    });
  });

  it("a real timeout through failOpen is counted against the instance cap", async () => {
    const oracle = new Priced("slow", 0.01, (p) => p, 40);
    const engine = new Engine({ oracle, budgetUsd: 0.05, reserveUsd: 0.01, timeoutMs: 5 });
    const gate = engine.gate({ id: "g", question: q, policy });
    const rs = await gate.askMany(states(50, "t"), { concurrency: 1 });
    await new Promise((r) => setTimeout(r, 80));
    expect(rs.filter((r) => r.decision.failedOpen).length).toBe(50);
    // Old code recorded every timeout at 0 and let all 50 calls through ($0.50 billed).
    expect(oracle.calls).toBe(5);
    expect(oracle.billed).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it("a battery's unknown cost is one request's estimate, split over its member rows", async () => {
    const oracle = new Unknowing("u", (call) => call === 1);
    const engine = new Engine({ oracle, reserveUsd: 0.03 });
    const members = [
      judge("a?", { id: "a" }),
      judge("b?", { id: "b" }),
      judge("c?", { id: "c" }),
    ] as const;
    const gate = engine.gate({ id: "bat", question: [...members], policy });
    await gate.ask("priced");
    await gate.ask("unknown");
    const rows = (await engine.ledger.all()).filter((r) => r.requestId !== undefined);
    const second = rows.slice(4);
    const memberRows = second.filter((r) => r.combined !== true);
    expect(memberRows.map((r) => r.cost)).toEqual([0.01, 0.01, 0.01]);
    expect(memberRows.every((r) => r.costEstimate?.basis === "reserve")).toBe(true);
    expect(second.find((r) => r.combined === true)?.cost).toBe(0);
    // The priced battery cost 0.01 in all; the unknown one is charged one 0.03 reservation.
    expect(engine.spent).toBeCloseTo(0.04, 12);
  });

  it("a daily cap on a fresh ledger shuts until a price is known, and a restart prices it", async () => {
    const path = join(dir, "unpriced.jsonl");
    const first = new Engine({
      oracle: new Unknowing("u", () => true),
      ledger: new JsonlLedger(path),
      dailyBudgetUsd: 1,
    });
    const g1 = first.gate({ id: "g", question: q, policy });
    const rs = await g1.askMany(states(5, "a"), { concurrency: 1 });
    expect(rs.filter((r) => r.decision.detail.budgetExhausted === true).length).toBe(4);
    expect((await first.spentToday())?.unpricedRequests).toBe(1);

    const oracle = new Priced("p", 0.01);
    const second = new Engine({
      oracle,
      ledger: new JsonlLedger(path),
      dailyBudgetUsd: 1,
      reserveUsd: 0.25,
    });
    await second.gate({ id: "g", question: q, policy }).askMany(states(10, "b"), {
      concurrency: 1,
    });
    // The unpriced row is priced at the 0.25 reservation, and the day opens again.
    const snap = await second.spentToday();
    expect(snap?.unpricedRequests).toBeUndefined();
    expect(oracle.calls).toBe(10);
    expect(snap?.spentUsd).toBeCloseTo(0.25 + 10 * 0.01, 9);
  });
});

describe("a cost recorded while a new day loads is not lost (e2e T4-12)", () => {
  it("counts toward the new day", async () => {
    const ledger = new MemoryLedger();
    let now = new Date("2026-11-12T23:59:59.900Z");
    const ds = new DailySpend(ledger, { capUsd: 0.05, reserveUsd: 0.01, now: () => now });
    const early = await ds.reserve();
    now = new Date("2026-11-13T00:00:00.100Z");
    const loading = ds.reserve(); // starts loading the new day
    ds.record(0.04, { id: "late", requestId: "late" }); // recorded while the load is pending
    if (early) ds.release(early, 0.04);
    await ledger.append(row("late", now.toISOString(), 0.04));
    const second = await loading;
    if (second) ds.release(second, 0);
    // Old code: the load overwrote the day's spend with what it had read, $0.00.
    expect((await ds.snapshot()).spentUsd).toBeCloseTo(0.04, 12);
  });

  it("does not count a row twice when the load already read it", async () => {
    const ledger = new MemoryLedger();
    let now = new Date("2026-11-12T23:59:59.900Z");
    const ds = new DailySpend(ledger, { capUsd: 1, reserveUsd: 0.01, now: () => now });
    await ds.reserve();
    now = new Date("2026-11-13T00:00:00.100Z");
    await ledger.append(row("seen", now.toISOString(), 0.04));
    ds.record(0.04, { id: "seen", requestId: "seen" }); // stale day: held for the next load
    expect((await ds.snapshot()).spentUsd).toBeCloseTo(0.04, 12);
  });
});

function row(id: string, at: string, cost: number): DecisionRecord {
  return {
    id,
    at,
    gateId: "g",
    requestId: id,
    questionId: "safe",
    kind: "judge",
    prompt: "Is this safe?",
    questionHash: "0000000000000000",
    stateHash: "0000000000000000",
    trustedHash: "0000000000000000",
    untrusted: [],
    oracle: "fake",
    strategy: "single",
    verdict: { kind: "judge", questionId: "safe", pYes: 0.3, confidence: 0.7 },
    go: 0.3,
    confidence: 0.7,
    agreement: 1,
    soft: "review",
    action: "review",
    mode: "shadow",
    cost,
    latencyMs: 1,
    failedOpen: false,
    tags: [],
  };
}

describe("a per-ask strategy is checked and metered (e2e V1 round 2)", () => {
  it("fails a question open, buying nothing, when its strategy could not run", async () => {
    const oracle = new Priced("p", 0.001);
    const engine = new Engine({ oracle, budgetUsd: 0.01 });
    const r = await engine.ask("s", q, {
      policy,
      strategy: {
        sequential: {
          members: [{ oracle }],
          settleAbove: 0.99,
          maxSamples: Number.POSITIVE_INFINITY,
        },
      },
    });
    // Old code: no check per ask; the run bought answers until something else stopped it.
    expect(oracle.calls).toBe(0);
    expect(r.decision).toMatchObject({ failedOpen: true, detail: { invalidStrategy: true } });
    expect(r.decision.error).toMatch(/maxSamples must be a positive integer/);
    expect(r.action).toBe("review");
    expect(await engine.ledger.all()).toHaveLength(1);
  });

  it("stops a sequential run buying once the instance cap is spent partway through it", async () => {
    const oracle = new Priced("p", 0.001);
    const engine = new Engine({ oracle, budgetUsd: 0.01 });
    const r = await engine.ask("s", q, {
      policy,
      strategy: { sequential: { members: [{ oracle }], settleAbove: 0.999, maxSamples: 1000 } },
    });
    // Old code: the cap was read once per request, so all 1,000 samples were bought.
    expect(oracle.calls).toBe(10);
    expect(r.decision.failedOpen).toBe(true);
    expect(r.action).toBe("review");
    expect(engine.spent).toBeCloseTo(0.01, 9);
    expect(engine.overBudget).toBe(true);
  });
});
