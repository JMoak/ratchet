/**
 * Every act the engine may send to a blind audit records the chance that it would, drawn or
 * not: the inclusion probability a later reader weights audited acts by.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Engine, type EngineOptions } from "../src/engine.ts";
import { type DecisionRecord, JsonlLedger, MemoryLedger } from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

/** p(yes) by state, read from its first word: "act" 0.95, "hold" 0.6, "refuse" 0.05. */
const byState: Oracle = {
  id: "table",
  async decide(state, qs) {
    const word = state.split(" ")[0];
    const pYes = word === "act" ? 0.95 : word === "hold" ? 0.6 : 0.05;
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, pYes),
      oracle: "table",
      cost: 0,
      latencyMs: 0,
      at: "2026-11-12T00:00:00.000Z",
    }));
  },
};

const q = judge("Is this call safe to run?", { id: "safe" });
const policy = { actAbove: 0.9, refuseBelow: 0.1 };

function engine(opts: Partial<EngineOptions> = {}): Engine {
  return new Engine({ oracle: byState, ledger: new MemoryLedger(), seed: 11, ...opts });
}

const rowsOf = async (e: Engine): Promise<readonly DecisionRecord[]> => e.ledger.all();

describe("auditProbability on the row", () => {
  it("is the gate's rate on every enforce-mode act, drawn or not", async () => {
    const e = engine({ mode: "enforce", auditRate: 0.3 });
    const gate = e.gate({ id: "g", question: q, policy });
    for (let i = 0; i < 40; i++) await gate.ask(`act ${i}`);
    const rows = await rowsOf(e);
    const drawn = rows.filter((r) => r.tags.includes("audit"));
    // Both kinds exist, so the rate is on the rows the draw passed over as well.
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(rows.length);
    for (const r of rows) {
      expect(r).toMatchObject({ mode: "enforce", soft: "act", auditProbability: 0.3 });
    }
  });

  it("is absent on shadow rows, held rows and refusals", async () => {
    const shadow = engine({ auditRate: 0.3 });
    const g = shadow.gate({ id: "g", question: q, policy });
    await g.ask("act in shadow");
    const enforce = engine({ mode: "enforce", auditRate: 0.3 });
    const h = enforce.gate({ id: "h", question: q, policy });
    await h.ask("hold this");
    await h.ask("refuse that");
    const rows = [...(await rowsOf(shadow)), ...(await rowsOf(enforce))];
    expect(rows.map((r) => [r.mode, r.soft])).toEqual([
      ["shadow", "act"],
      ["enforce", "review"],
      ["enforce", "refuse"],
    ]);
    for (const r of rows) expect(r).not.toHaveProperty("auditProbability");
  });

  it("is absent where a floor held the act back", async () => {
    const e = engine({ mode: "enforce", auditRate: 0.3, floors: [() => "review"] });
    const gate = e.gate({ id: "g", question: q, policy });
    await gate.ask("act under a floor");
    const [row] = await rowsOf(e);
    expect(row?.soft).toBe("review");
    expect(row).not.toHaveProperty("auditProbability");
  });

  it("takes a gate's own rate over the engine's, including a rate of 0", async () => {
    const e = engine({ mode: "enforce", auditRate: 0.3 });
    const own = e.gate({ id: "own", question: q, policy, auditRate: 0.05 });
    const off = e.gate({ id: "off", question: q, policy, auditRate: 0 });
    await own.ask("act one");
    await off.ask("act two");
    await e.ask("act three", judge("Adhoc?", { id: "adhoc" }), { policy });
    const byGate = Object.fromEntries((await rowsOf(e)).map((r) => [r.gateId, r]));
    expect(byGate.own?.auditProbability).toBe(0.05);
    // Audits off: no act can be drawn, and the row says so rather than saying nothing.
    expect(byGate.off?.auditProbability).toBe(0);
    expect(byGate.off?.tags).not.toContain("audit");
    // An ask outside a gate takes the engine's rate.
    expect(byGate["adhoc:adhoc"]?.auditProbability).toBe(0.3);
  });

  it("is on a battery's combined row and its members, as the audit tag is", async () => {
    const e = engine({ mode: "enforce", auditRate: 0.25 });
    const gate = e.gate({
      id: "bat",
      question: [judge("Is it safe?", { id: "a" }), judge("Is it allowed?", { id: "b" })],
      policy,
    });
    await gate.ask("act on both");
    const rows = await rowsOf(e);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.auditProbability).toBe(0.25);
  });

  it("is written into the JSONL ledger with the row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ratchet-audit-probability-"));
    try {
      const path = join(dir, "ledger.jsonl");
      const e = new Engine({
        oracle: byState,
        ledger: new JsonlLedger(path),
        mode: "enforce",
        auditRate: 0.2,
        seed: 3,
      });
      await e.gate({ id: "g", question: q, policy }).ask("act now");
      const [row] = await new JsonlLedger(path).all();
      expect(row?.auditProbability).toBe(0.2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
