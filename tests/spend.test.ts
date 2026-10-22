import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import { type DecisionRecord, JsonlLedger, MemoryLedger } from "../src/ledger/ledger.ts";
import { judge } from "../src/questions.ts";
import { DailySpend } from "../src/spend.ts";
import type { Decision, Oracle, Question } from "../src/types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const q = judge("ok?", { id: "ok" });
const policy = { actAbove: 0.9 };

/** Costs `cost` per question; counts calls; optionally waits until released. */
function pricedOracle(cost: number, gate?: Promise<void>) {
  const oracle = {
    calls: 0,
    id: "priced",
    decide: async (_state: string, questions: readonly Question[]): Promise<Decision[]> => {
      oracle.calls++;
      if (gate) await gate;
      return questions.map((question) => ({
        verdict: { kind: "judge", questionId: question.id, pYes: 0.95, confidence: 0.95 },
        oracle: "priced",
        latencyMs: 0,
        cost,
        at: new Date().toISOString(),
      }));
    },
  } satisfies Oracle & { calls: number };
  return oracle;
}

async function ledgerFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ratchet-spend-"));
  dirs.push(dir);
  return join(dir, "ledger.jsonl");
}

function row(id: string, at: string, cost: number, requestId = id): DecisionRecord {
  return {
    id,
    at,
    gateId: "g",
    requestId,
    questionId: "ok",
    kind: "judge",
    prompt: "ok?",
    questionHash: "0000000000000000",
    stateHash: id,
    trustedHash: id,
    untrusted: [],
    oracle: "priced",
    strategy: "single",
    verdict: { kind: "judge", questionId: "ok", pYes: 0.95, confidence: 0.95 },
    go: 0.95,
    confidence: 0.95,
    agreement: 1,
    soft: "act",
    action: "review",
    mode: "shadow",
    cost,
    latencyMs: 0,
    failedOpen: false,
    tags: [],
  };
}

describe("the daily spend cap", () => {
  it("fails open once the day's recorded spend reaches the cap", async () => {
    const oracle = pricedOracle(0.0001);
    const engine = new Engine({ oracle, dailyBudgetUsd: 0.0003, ledger: new MemoryLedger() });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await engine.ask(`s${i}`, q, { policy }));

    expect(oracle.calls).toBe(3);
    expect(results.map((r) => r.decision.failedOpen === true)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(results[3]?.decision.detail).toMatchObject({ budgetExhausted: true, budget: "daily" });
    expect(results[3]?.action).toBe("review");
    const today = await engine.spentToday();
    expect(today?.spentUsd).toBeCloseTo(0.0003, 12);
    expect(today?.capUsd).toBe(0.0003);
  });

  it("survives a restart, because the spend is read back from the ledger", async () => {
    const path = await ledgerFile();
    const first = new Engine({
      oracle: pricedOracle(0.0001),
      dailyBudgetUsd: 0.0002,
      ledger: new JsonlLedger(path),
    });
    await first.ask("a", q, { policy });
    await first.ask("b", q, { policy });

    const oracle = pricedOracle(0.0001);
    const restarted = new Engine({ oracle, dailyBudgetUsd: 0.0002, ledger: new JsonlLedger(path) });
    const after = await restarted.ask("c", q, { policy });

    expect(oracle.calls).toBe(0);
    expect(after.decision.detail).toMatchObject({ budgetExhausted: true, budget: "daily" });
  });

  it("reserves room for requests in flight, so a burst cannot overshoot the cap", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oracle = pricedOracle(0.0001, held);
    const engine = new Engine({
      oracle,
      dailyBudgetUsd: 0.0003,
      reserveUsd: 0.0001,
      ledger: new MemoryLedger(),
    });
    const burst = Array.from({ length: 6 }, (_, i) => engine.ask(`burst-${i}`, q, { policy }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const results = await Promise.all(burst);

    expect(oracle.calls).toBe(3);
    expect(results.filter((r) => r.decision.failedOpen === true)).toHaveLength(3);
    const after = await engine.spentToday();
    expect(after?.spentUsd).toBeCloseTo(0.0003, 12);
    expect(after?.reservedUsd).toBeCloseTo(0, 12);
  });

  it("applies the same admission to a battery", async () => {
    const oracle = pricedOracle(0.0001);
    const engine = new Engine({ oracle, dailyBudgetUsd: 0.0002, ledger: new MemoryLedger() });
    const gate = engine.gate({
      id: "battery",
      question: [judge("a?", { id: "a" }), judge("b?", { id: "b" })],
      policy,
    });
    const first = await gate.ask("one");
    const second = await gate.ask("two");

    expect(oracle.calls).toBe(1);
    expect(first.decision.failedOpen).not.toBe(true);
    expect(second.decision.failedOpen).toBe(true);
  });
});

describe("DailySpend", () => {
  const today = new Date("2026-10-21T12:00:00.000Z");

  it("counts only today's rows, by their UTC day", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(row("old", "2026-10-20T23:59:59.000Z", 5));
    await ledger.append(row("new", "2026-10-21T00:00:01.000Z", 0.25));
    const spend = new DailySpend(ledger, { capUsd: 1, now: () => today });

    expect(await spend.snapshot()).toMatchObject({ day: "2026-10-21", spentUsd: 0.25 });
  });

  it("counts a row with an unreadable time toward today, so it stops sooner, not later", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(row("unknown", "not a time", 0.5));
    const spend = new DailySpend(ledger, { capUsd: 1, now: () => today });

    expect((await spend.snapshot()).spentUsd).toBe(0.5);
  });

  it("starts a new day from that day's rows", async () => {
    const ledger = new MemoryLedger();
    let now = today;
    const spend = new DailySpend(ledger, { capUsd: 1, now: () => now });
    const admitted = await spend.reserve();
    spend.record(1);
    spend.release(admitted as { usd: number }, 1);
    expect(await spend.reserve()).toBeUndefined();

    now = new Date("2026-10-22T00:00:01.000Z");
    expect(await spend.snapshot()).toMatchObject({ day: "2026-10-22", spentUsd: 0 });
    expect(await spend.reserve()).toEqual({ usd: 1 });
  });

  it("reserves the costliest request the ledger has seen unless told otherwise", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(row("m1", "2026-10-01T00:00:00.000Z", 0.2, "battery"));
    await ledger.append(row("m2", "2026-10-01T00:00:00.000Z", 0.2, "battery"));
    await ledger.append(row("x", "2026-10-01T00:00:00.000Z", 0.1));
    const learned = new DailySpend(ledger, { capUsd: 1, now: () => today });
    const fixed = new DailySpend(ledger, { capUsd: 1, reserveUsd: 0.05, now: () => today });

    expect(await learned.reserve()).toEqual({ usd: 0.4 });
    expect(await fixed.reserve()).toEqual({ usd: 0.05 });
  });

  it("refuses a request that would carry the day past its cap and frees the room afterwards", async () => {
    const spend = new DailySpend(new MemoryLedger(), {
      capUsd: 1,
      reserveUsd: 0.6,
      now: () => today,
    });
    const first = await spend.reserve();
    expect(first).toBeDefined();
    expect(await spend.reserve()).toBeUndefined();

    spend.record(0.3);
    spend.release(first as { usd: number }, 0.3);
    expect(await spend.reserve()).toBeDefined();
  });

  it("refuses nonsense limits", () => {
    expect(() => new DailySpend(new MemoryLedger(), { capUsd: 0 })).toThrow();
    expect(() => new DailySpend(new MemoryLedger(), { capUsd: 1, reserveUsd: -1 })).toThrow();
  });
});
