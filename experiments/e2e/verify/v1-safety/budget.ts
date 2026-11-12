/**
 * V1 attacks on T4-05 (timeouts abort; unknown cost never free), T4-06 (invalid costs never
 * lower or freeze spend) and T4-12 (a cost recorded while the day's spend loads is not lost).
 * Offline and deterministic (fixed clocks, in-memory or temp-dir ledgers).
 *
 *   bun experiments/e2e/verify/v1-safety/budget.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../../src/engine.ts";
import {
  type DecisionRecord,
  JsonlLedger,
  type Ledger,
  MemoryLedger,
} from "../../../../src/ledger/ledger.ts";
import { judge } from "../../../../src/questions.ts";
import { DailySpend } from "../../../../src/spend.ts";
import type { Oracle } from "../../../../src/types.ts";
import { attack, judged, report, scripted } from "./lib.ts";

const q = judge("Is it safe to run this command without asking?", { id: "q.safe" });
const policy = { actAbove: 0.9 };

/** An oracle that answers after `ms`, honouring the abort signal, billing `cost`. */
function slow(ms: number, cost: number, counter: { calls: number; aborted: number }): Oracle {
  return {
    id: "slow",
    decide: (_s, qs, opts) =>
      new Promise((resolve, reject) => {
        counter.calls++;
        const t = setTimeout(() => resolve(qs.map((x) => judged(x, 0.99, { cost }))), ms);
        opts?.signal?.addEventListener("abort", () => {
          counter.aborted++;
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      }),
  };
}

// --- T4-05: timeouts through the engine, at concurrency 32 under a daily cap ------------------
await attack(
  "budget",
  "T4-05",
  "32 concurrent asks that all time out under dailyBudgetUsd 0.01 / reserveUsd 0.001: admitted calls are all charged, none for free",
  async () => {
    const counter = { calls: 0, aborted: 0 };
    const ledger = new MemoryLedger();
    const engine = new Engine({
      oracle: slow(60, 0.001, counter),
      ledger,
      timeoutMs: 10,
      dailyBudgetUsd: 0.01,
      reserveUsd: 0.001,
    });
    const gate = engine.gate({ id: "g", question: q, policy });
    await Promise.all(Array.from({ length: 32 }, (_, i) => gate.ask(`s${i}`)));
    const snap = await engine.spentToday();
    const rows = await ledger.all();
    const charged = rows.reduce((s, r) => s + r.cost, 0);
    const held =
      counter.calls <= 10 &&
      counter.aborted === counter.calls &&
      charged >= counter.calls * 0.001 - 1e-12;
    return {
      held,
      observed: `calls ${counter.calls} (aborted ${counter.aborted}); rows ${rows.length}; charged ${charged.toFixed(4)}; spentToday ${snap?.spentUsd.toFixed(4)}; estimates ${rows.filter((r) => r.costEstimate).length}`,
    };
  },
);

await attack(
  "budget",
  "T4-05",
  "fresh ledger, no reserveUsd: one timeout shuts the day (nothing to price it by)",
  async () => {
    const counter = { calls: 0, aborted: 0 };
    const engine = new Engine({
      oracle: slow(60, 0.001, counter),
      ledger: new MemoryLedger(),
      timeoutMs: 10,
      dailyBudgetUsd: 1,
    });
    const gate = engine.gate({ id: "g", question: q, policy });
    await gate.ask("first");
    const second = await gate.ask("second");
    const snap = await engine.spentToday();
    return {
      held: counter.calls === 1 && second.decision.failedOpen === true,
      observed: `calls ${counter.calls}; second ask failedOpen ${second.decision.failedOpen}; unpriced ${snap?.unpricedRequests}`,
    };
  },
);

await attack("budget", "T4-05", "ensemble members' calls are aborted on timeout too", async () => {
  const counter = { calls: 0, aborted: 0 };
  const o = slow(60, 0.001, counter);
  const engine = new Engine({ oracle: o, ledger: new MemoryLedger(), timeoutMs: 10 });
  const gate = engine.gate({
    id: "g",
    question: q,
    policy,
    strategy: { ensemble: { members: [{ oracle: o }, { oracle: { ...o, id: "slow2" } }] } },
  });
  const r = await gate.ask("s");
  return {
    held:
      counter.aborted === counter.calls && counter.calls === 2 && r.decision.costUnknown === true,
    observed: `member calls ${counter.calls}, aborted ${counter.aborted}, costUnknown ${r.decision.costUnknown}`,
  };
});

// --- T4-06: invalid costs, in process --------------------------------------------------------
for (const cost of [Number.NaN, -5, Number.POSITIVE_INFINITY, -0, "0.5", null]) {
  await attack(
    "budget",
    "T4-06",
    `reported cost ${String(cost)}: spent stays finite and never drops`,
    async () => {
      let n = 0;
      const o = scripted("c", (qs) =>
        qs.map((x) => judged(x, 0.95, { cost: n++ === 0 ? 0.01 : (cost as number) })),
      );
      const engine = new Engine({ oracle: o, ledger: new MemoryLedger(), budgetUsd: 1 });
      const gate = engine.gate({ id: "g", question: q, policy });
      await gate.ask("priced");
      const before = engine.spent;
      await gate.ask("bad cost");
      const after = engine.spent;
      return {
        held: Number.isFinite(after) && after >= before && !engine.overBudget,
        observed: `spent ${before} -> ${after}`,
      };
    },
  );
}

await attack(
  "budget",
  "T4-06",
  "budgetUsd NaN (e.g. Number(process.env.UNSET)) is refused or caps",
  async () => {
    try {
      const engine = new Engine({
        oracle: scripted("c", (qs) => qs.map((x) => judged(x, 0.95, { cost: 1 }))),
        ledger: new MemoryLedger(),
        budgetUsd: Number.NaN,
      });
      const gate = engine.gate({ id: "g", question: q, policy });
      for (let i = 0; i < 5; i++) await gate.ask(`s${i}`);
      return {
        held: engine.overBudget,
        observed: `accepted; spent ${engine.spent} USD with overBudget ${engine.overBudget}`,
      };
    } catch (e) {
      return { held: true, observed: `refused: ${(e as Error).message}` };
    }
  },
);

// --- T4-06: invalid costs read back on restart -----------------------------------------------
await attack(
  "budget",
  "T4-06",
  "restart reads NaN-as-null, negative, string and costEstimate rows without undercounting",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "v1-budget-"));
    try {
      const path = join(dir, "l.jsonl");
      const day = "2026-11-12T08:00:00.000Z";
      const base = (id: string, cost: unknown, extra: Record<string, unknown> = {}) => ({
        type: "decision",
        record: {
          id,
          requestId: `req-${id}`,
          at: day,
          gateId: "g",
          questionId: q.id,
          kind: "judge",
          prompt: q.prompt,
          verdict: { kind: "judge", questionId: q.id, pYes: 0.9, confidence: 0.9 },
          confidence: 0.9,
          go: 0.9,
          soft: "act",
          action: "review",
          mode: "shadow",
          cost,
          latencyMs: 1,
          failedOpen: false,
          tags: [],
          ...extra,
        },
      });
      const lines = [
        base("a", 0.002),
        base("b", null), // NaN written by JSON.stringify
        base("c", -5),
        base("d", "0.5"),
        base("e", 0.001, { costEstimate: { reason: "timeout", basis: "reserve" } }),
        base("f", 0, { costEstimate: { reason: "timeout", basis: "none" } }),
      ];
      writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      const spend = new DailySpend(new JsonlLedger(path), {
        capUsd: 1,
        reserveUsd: 0.001,
        now: () => new Date("2026-11-12T12:00:00.000Z"),
      });
      const snap = await spend.snapshot();
      // valid: 0.002 + 0.001 (e) = 0.003; blind requests b, c, d, f priced at max(0.001, 0.002) = 0.002 each.
      const expected = 0.003 + 4 * 0.002;
      return {
        held: Math.abs(snap.spentUsd - expected) < 1e-9,
        observed: `spentUsd ${snap.spentUsd.toFixed(6)} (expected ${expected.toFixed(6)})`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// --- T4-12: the day-load race ----------------------------------------------------------------
/** A ledger whose all() waits for `gate` to open, so a load can be held in flight. */
class SlowLedger implements Ledger {
  readonly inner = new MemoryLedger();
  hold: Promise<void> = Promise.resolve();
  append(r: DecisionRecord) {
    return this.inner.append(r);
  }
  label(id: string, o: Parameters<Ledger["label"]>[1]) {
    return this.inner.label(id, o);
  }
  async all() {
    const rows = await this.inner.all();
    await this.hold;
    return rows;
  }
}

const row = (id: string, at: string, cost: number): DecisionRecord =>
  ({
    id,
    requestId: `req-${id}`,
    at,
    gateId: "g",
    questionId: q.id,
    kind: "judge",
    prompt: q.prompt,
    verdict: { kind: "judge", questionId: q.id, pYes: 0.9, confidence: 0.9 },
    confidence: 0.9,
    go: 0.9,
    soft: "act",
    action: "review",
    mode: "shadow",
    cost,
    latencyMs: 1,
    failedOpen: false,
    tags: [],
  }) as unknown as DecisionRecord;

for (const appendedBeforeRead of [false, true]) {
  await attack(
    "budget",
    "T4-12",
    `a cost recorded while the new day loads is counted exactly once (row ${appendedBeforeRead ? "in" : "not in"} the load's read)`,
    async () => {
      let now = new Date("2026-11-12T23:59:59.000Z");
      const ledger = new SlowLedger();
      const spend = new DailySpend(ledger, { capUsd: 10, reserveUsd: 0.01, now: () => now });
      await spend.reserve();
      now = new Date("2026-11-13T00:00:01.000Z");
      let open: () => void = () => {};
      ledger.hold = new Promise((r) => {
        open = r;
      });
      const rec = row("x", "2026-11-13T00:00:01.000Z", 0.5);
      if (appendedBeforeRead) await ledger.append(rec);
      const loading = spend.reserve();
      await new Promise((r) => setTimeout(r, 5));
      spend.record(rec.cost, rec);
      if (!appendedBeforeRead) await ledger.append(rec);
      open();
      await loading;
      const snap = await spend.snapshot();
      // 0.5 for the row; the reservation is separate.
      return {
        held: Math.abs(snap.spentUsd - 0.5) < 1e-12,
        observed: `day ${snap.day}, spentUsd ${snap.spentUsd}`,
      };
    },
  );
}

const broken = report("V1: budgets (T4-05, T4-06, T4-12)");
process.exitCode = broken > 0 ? 1 : 0;
