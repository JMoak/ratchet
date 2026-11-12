/**
 * Attack 3: budgets. A priced fake oracle (fixed cost and latency per request, with its own
 * tally of what a provider would bill) drives the instance cap (`budgetUsd`) and the daily cap
 * (`dailyBudgetUsd`) under concurrency, restarts, two engines on one ledger, the UTC day
 * boundary, corrupt cost fields, and timeouts. Nothing here calls a real model.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DailySpend,
  Engine,
  type GatePolicy,
  JsonlLedger,
  judge,
  MemoryLedger,
  type Oracle,
  type Question,
} from "../../../src/index.ts";
import type { DecisionRecord } from "../../../src/ledger/ledger.ts";
import type { Decision } from "../../../src/types.ts";
import { type Findings, scratch, table } from "./common.ts";

/** A provider that bills `price` per request whether or not anyone waits for the answer. */
export class PricedOracle implements Oracle {
  billed = 0;
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    readonly id: string,
    private readonly price: number,
    private readonly latencyMs: number,
    private readonly reportedCost: (price: number) => number = (p) => p,
  ) {}
  async decide(_state: string, questions: readonly Question[]): Promise<Decision[]> {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, this.latencyMs));
    this.inFlight--;
    this.billed += this.price;
    const at = new Date().toISOString();
    return questions.map((q) => ({
      verdict: { kind: "judge", questionId: q.id, pYes: 0.3, confidence: 0.7 },
      oracle: this.id,
      latencyMs: this.latencyMs,
      cost: this.reportedCost(this.price) / questions.length,
      at,
    }));
  }
}

const policy: GatePolicy = { actAbove: 0.9 };
const q = judge("Is this safe?", { id: "safe" });
const states = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`);

function row(id: string, at: string, cost: unknown): string {
  const rec = {
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
  return `${JSON.stringify({ type: "decision", record: rec })}\n`;
}

export async function runBudgetAttacks(findings: Findings): Promise<string> {
  const out: string[] = [];

  // B1: instance cap under concurrency.
  const rows1: string[][] = [];
  for (const concurrency of [1, 16, 32, 64]) {
    const oracle = new PricedOracle("priced", 0.01, 20);
    const engine = new Engine({ oracle, budgetUsd: 0.05 });
    const gate = engine.gate({ id: "g", question: q, policy });
    await gate.askMany(states(200, "s"), { concurrency });
    rows1.push([
      String(concurrency),
      "$0.05",
      String(oracle.calls),
      `$${oracle.billed.toFixed(2)}`,
      `${(oracle.billed / 0.05).toFixed(1)}x`,
    ]);
    if (concurrency === 64) {
      findings.check(
        "budget",
        "budgetUsd 0.05, askMany concurrency 64, $0.01 requests",
        oracle.billed <= 0.05 + 64 * 0.01 + 1e-9,
        `billed $${oracle.billed.toFixed(2)} (${(oracle.billed / 0.05).toFixed(1)}x the cap)`,
        "documented: in-flight requests may exceed the cap (bounded by concurrency x request cost)",
      );
    }
  }
  out.push(
    "### Instance cap under concurrency (`budgetUsd` 0.05, 200 states, $0.01 per request)",
    "",
    table(["concurrency", "cap", "oracle calls", "billed", "overshoot"], rows1),
    "",
  );

  // B2: daily cap with reservations, fresh ledger.
  const rows2: string[][] = [];
  for (const reserve of [undefined, 0.01]) {
    for (const concurrency of [16, 64]) {
      const oracle = new PricedOracle("priced", 0.01, 20);
      const engine = new Engine({
        oracle,
        dailyBudgetUsd: 0.05,
        ...(reserve !== undefined ? { reserveUsd: reserve } : {}),
      });
      const gate = engine.gate({ id: "g", question: q, policy });
      await gate.askMany(states(200, "d"), { concurrency });
      rows2.push([
        reserve === undefined ? "default (largest seen; 0 on a fresh ledger)" : `$${reserve}`,
        String(concurrency),
        String(oracle.calls),
        `$${oracle.billed.toFixed(2)}`,
        `${(oracle.billed / 0.05).toFixed(1)}x`,
      ]);
      if (reserve === 0.01 && concurrency === 64) {
        findings.check(
          "budget",
          "dailyBudgetUsd 0.05 with reserveUsd = request cost, concurrency 64",
          oracle.billed <= 0.05 + 1e-9,
          `billed $${oracle.billed.toFixed(2)}`,
          "reservations hold the cap when the reservation covers a request",
        );
      }
      if (reserve === undefined && concurrency === 64) {
        findings.check(
          "budget",
          "dailyBudgetUsd 0.05, default reservation, fresh ledger, concurrency 64",
          oracle.billed <= 0.05 + 64 * 0.01 + 1e-9,
          `billed $${oracle.billed.toFixed(2)} (${(oracle.billed / 0.05).toFixed(1)}x)`,
          "documented: a fresh ledger reserves 0, so the first burst is bounded only by concurrency",
        );
      }
    }
  }
  out.push(
    "### Daily cap with reservations (`dailyBudgetUsd` 0.05, $0.01 per request)",
    "",
    table(["reserveUsd", "concurrency", "oracle calls", "billed", "overshoot"], rows2),
    "",
  );

  // B3: restart on one ledger, and B4: two live engines on one ledger.
  {
    const dir = scratch("budget-restart");
    const path = join(dir, "ledger.jsonl");
    const a = new PricedOracle("a", 0.01, 5);
    const engineA = new Engine({ oracle: a, ledger: new JsonlLedger(path), dailyBudgetUsd: 0.05 });
    const gateA = engineA.gate({ id: "g", question: q, policy });
    await gateA.askMany(states(10, "a"), { concurrency: 1 });
    const b = new PricedOracle("b", 0.01, 5);
    const engineB = new Engine({ oracle: b, ledger: new JsonlLedger(path), dailyBudgetUsd: 0.05 });
    const gateB = engineB.gate({ id: "g", question: q, policy });
    await gateB.askMany(states(10, "b"), { concurrency: 1 });
    findings.check(
      "budget",
      "restart: engine B on engine A's ledger after A spent the daily cap",
      b.calls === 0,
      `A billed $${a.billed.toFixed(2)}, B made ${b.calls} calls`,
      "B sees A's spend and makes no calls",
    );
    out.push(
      `Restart on one ledger: A billed $${a.billed.toFixed(2)} of a $0.05 daily cap; a fresh engine B on the same ledger then made ${b.calls} calls.`,
      "",
    );

    const path2 = join(dir, "ledger2.jsonl");
    const c = new PricedOracle("c", 0.01, 5);
    const d = new PricedOracle("d", 0.01, 5);
    const ec = new Engine({ oracle: c, ledger: new JsonlLedger(path2), dailyBudgetUsd: 0.05 });
    const ed = new Engine({ oracle: d, ledger: new JsonlLedger(path2), dailyBudgetUsd: 0.05 });
    const gc = ec.gate({ id: "g", question: q, policy });
    const gd = ed.gate({ id: "g", question: q, policy });
    await Promise.all([
      gc.askMany(states(10, "c"), { concurrency: 1 }),
      gd.askMany(states(10, "d"), { concurrency: 1 }),
    ]);
    const total = c.billed + d.billed;
    findings.check(
      "budget",
      "two live engines on one ledger, each dailyBudgetUsd 0.05",
      total <= 0.1 + 1e-9,
      `together billed $${total.toFixed(2)} (${(total / 0.05).toFixed(1)}x one cap)`,
      "documented: another process is seen only at the first request of a day, so each live engine spends its own cap",
    );
    out.push(
      `Two live engines on one ledger, each capped at $0.05 a day: together billed $${total.toFixed(2)}.`,
      "",
    );
  }

  // B5: the UTC day boundary, through DailySpend with an injected clock.
  {
    const ledger = new MemoryLedger();
    let now = new Date("2026-11-12T23:59:59.000Z");
    const ds = new DailySpend(ledger, { capUsd: 0.05, reserveUsd: 0.01, now: () => now });
    const admitted: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await ds.reserve();
      if (r) {
        ds.record(0.01);
        ds.release(r, 0.01);
        await ledger.append(
          JSON.parse(row(`r${i}`, now.toISOString(), 0.01).trim()).record as DecisionRecord,
        );
        admitted.push(now.toISOString().slice(0, 10));
      }
      if (i === 5) now = new Date("2026-11-13T00:00:01.000Z");
    }
    const day1 = admitted.filter((d) => d === "2026-11-12").length;
    const day2 = admitted.filter((d) => d === "2026-11-13").length;
    findings.check(
      "budget",
      "UTC day boundary: cap 0.05, requests at 23:59:59 then 00:00:01",
      day1 === 5 && day2 === 2,
      `admitted ${day1} on day 1 and ${day2} after midnight`,
      "5 before midnight, a fresh cap after",
    );

    // An in-flight request admitted before midnight whose row lands after the new day loads.
    const ledger2 = new MemoryLedger();
    let now2 = new Date("2026-11-12T23:59:59.900Z");
    const ds2 = new DailySpend(ledger2, { capUsd: 0.05, reserveUsd: 0.01, now: () => now2 });
    const early = await ds2.reserve();
    now2 = new Date("2026-11-13T00:00:00.100Z");
    const loading = ds2.reserve(); // starts loading the new day
    ds2.record(0.04); // the in-flight request's row is recorded while the load is pending
    if (early) ds2.release(early, 0.04);
    await ledger2.append(
      JSON.parse(row("late", now2.toISOString(), 0.04).trim()).record as DecisionRecord,
    );
    const second = await loading;
    if (second) ds2.release(second, 0);
    const snap = await ds2.snapshot();
    findings.check(
      "budget",
      "a cost recorded while the new day's spend is loading",
      snap.spentUsd >= 0.04 - 1e-9,
      `new day's spend reads $${snap.spentUsd.toFixed(2)} after a $0.04 row stamped that day`,
      "the $0.04 counts toward the new day",
      "T4-12",
    );
  }

  // B6: corrupt cost fields in the ledger, read by a restarted engine.
  {
    const dir = scratch("budget-corrupt");
    const today = new Date().toISOString();
    const cases: [string, unknown][] = [
      ["string cost", "0.05"],
      ["null cost", null],
      ["negative cost", -1],
      ["huge cost", 1e308],
    ];
    const rows6: string[][] = [];
    for (const [name, bad] of cases) {
      const path = join(dir, `${name.replace(/ /g, "-")}.jsonl`);
      writeFileSync(path, "");
      for (let i = 0; i < 5; i++) appendFileSync(path, row(`ok${i}`, today, 0.01));
      appendFileSync(path, row("bad", today, bad));
      const o = new PricedOracle("p", 0.01, 1);
      const e = new Engine({
        oracle: o,
        ledger: new JsonlLedger(path),
        dailyBudgetUsd: 0.05,
        reserveUsd: 0.01,
      });
      const g = e.gate({ id: "g", question: q, policy });
      await g.askMany(states(20, "x"), { concurrency: 1 });
      rows6.push([name, JSON.stringify(bad), String(o.calls)]);
      if (name === "negative cost") {
        findings.check(
          "budget",
          "a ledger row with cost -1 on a day already at its $0.05 cap",
          o.calls === 0,
          `restarted engine made ${o.calls} more calls`,
          "no calls: the day is spent",
          "T4-06",
        );
      }
      if (name === "string cost") {
        findings.check(
          "budget",
          'a ledger row with cost "0.05" (a string) on a day already at its cap',
          o.calls === 0,
          `restarted engine made ${o.calls} more calls`,
          "no calls (the five numeric rows alone already reach the cap)",
        );
      }
    }
    out.push(
      "### Corrupt cost fields (five $0.01 rows today, cap $0.05, plus one corrupt row)",
      "",
      table(["corrupt row", "cost value", "calls a restarted engine made (of 20)"], rows6),
      "",
    );
  }

  // B7: an oracle that reports NaN or negative cost, against the instance cap.
  {
    const rows7: string[][] = [];
    for (const [name, fn] of [
      ["NaN reported cost", () => Number.NaN],
      ["negative reported cost", (p: number) => -p],
      ["honest reported cost", (p: number) => p],
    ] as const) {
      const o = new PricedOracle("p", 0.01, 1, fn);
      const e = new Engine({ oracle: o, budgetUsd: 0.05 });
      const g = e.gate({ id: "g", question: q, policy });
      await g.askMany(states(100, "n"), { concurrency: 1 });
      rows7.push([name, String(o.calls), `$${o.billed.toFixed(2)}`, String(e.spent)]);
      if (name !== "honest reported cost") {
        findings.check(
          "budget",
          `budgetUsd 0.05 with an oracle that reports ${name}`,
          o.calls <= 5,
          `${o.calls} of 100 requests reached the oracle; engine.spent = ${e.spent}`,
          "the cap trips after about 5 requests",
          "T4-06",
        );
      }
    }
    out.push(
      "### Reported cost garbage against `budgetUsd` 0.05 ($0.01 billed per request, 100 asks)",
      "",
      table(["oracle reports", "oracle calls", "billed", "engine.spent"], rows7),
      "",
    );
  }

  // B8: timeouts. failOpen stops waiting but never aborts the call, and records cost 0.
  {
    const o = new PricedOracle("slow", 0.01, 40);
    const e = new Engine({ oracle: o, budgetUsd: 0.05, timeoutMs: 10 });
    const g = e.gate({ id: "g", question: q, policy });
    const rs = await g.askMany(states(50, "t"), { concurrency: 1 });
    await new Promise((r) => setTimeout(r, 80));
    const failed = rs.filter((r) => r.decision.failedOpen).length;
    findings.check(
      "budget",
      "timeoutMs 10 against a 40 ms oracle that bills $0.01 per call, budgetUsd 0.05",
      o.billed <= 0.05 + 1e-9,
      `${failed}/50 failed open, engine.spent $${e.spent.toFixed(2)}, provider billed $${o.billed.toFixed(2)} (${(o.billed / 0.05).toFixed(0)}x)`,
      "timed-out calls are aborted or counted, so the cap still trips",
      "T4-05",
    );
    out.push(
      `Timeouts: with \`timeoutMs\` 10 against a 40 ms oracle, ${failed}/50 asks failed open, the engine recorded $${e.spent.toFixed(2)} and the provider billed $${o.billed.toFixed(2)} against a $0.05 cap: no timed-out call is aborted or counted.`,
      "",
    );
  }
  return out.join("\n");
}
