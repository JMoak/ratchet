/**
 * Integration fixes the coordinator made after wave 2's packages landed, where a fix spanned
 * files whose owners had finished: `forQuestion` records its scope so a gate refuses a floor
 * scoped to a battery member (e2e T4-08), and reports count and name labels from unregistered
 * sources so a typo in a source cannot make labels vanish silently (e2e T4-09).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { report } from "../src/cli/report.ts";
import { Engine } from "../src/engine.ts";
import { forQuestion, refuseIf } from "../src/floors.ts";
import { questionScope } from "../src/gate.ts";
import { JsonlLedger } from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

const fixed = (pYes: number): Oracle => ({
  id: "fixed",
  decide: async (_state, questions) =>
    questions.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, pYes),
      oracle: "fixed",
      model: "fixed-v1",
      cost: 0,
      latencyMs: 1,
      at: new Date().toISOString(),
    })),
});

describe("forQuestion scopes are visible to gate registration (e2e T4-08)", () => {
  const safe = judge("Safe?", { id: "bash.safe" });
  const scope = judge("In scope?", { id: "bash.scope" });

  it("records the scope it was built with", () => {
    expect(questionScope(forQuestion("bash.safe", refuseIf(/x/)))).toBe("bash.safe");
    const pattern = /^bash\./;
    expect(questionScope(forQuestion(pattern, refuseIf(/x/)))).toBe(pattern);
  });

  it("refuses a real forQuestion floor that names a battery member", () => {
    const engine = new Engine({
      oracle: fixed(0.99),
      floors: [forQuestion("bash.safe", refuseIf(/push --force/))],
    });
    // The single gate asking bash.safe is exactly what the floor is for.
    engine.gate({ id: "single", question: safe, policy: { actAbove: 0.9 } });
    expect(() =>
      engine.gate({
        id: "bash",
        question: [safe, scope],
        combine: "min",
        policy: { actAbove: 0.9 },
      }),
    ).toThrow(/names battery member "bash.safe"/);
  });

  it("leaves a gate's own rule scoped to questions it may be asked as an Asker", () => {
    const engine = new Engine({ oracle: fixed(0.99) });
    expect(() =>
      engine.gate({
        id: "context.keep",
        question: judge("Keep?", { id: "keep" }),
        policy: { actAbove: 0.9 },
        floors: [forQuestion(/^item-/, refuseIf(/secret/))],
      }),
    ).not.toThrow();
  });
});

describe("labels from unregistered sources are counted and named (e2e T4-09)", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("appear in the engine report and the CLI report instead of vanishing", async () => {
    dir = await mkdtemp(join(tmpdir(), "ratchet-coord-"));
    const path = join(dir, "ledger.jsonl");
    const engine = new Engine({ oracle: fixed(0.9), ledger: new JsonlLedger(path) });
    const q = judge("Safe?", { id: "safe" });
    const gate = engine.gate({ id: "safe", question: q, policy: { actAbove: 0.95 } });
    const sources = ["review:blind", "Reverted:git", "accepted:", "hook:inferred"];
    for (const source of sources) {
      const r = await gate.ask(`state ${source}`);
      await engine.label(r.recordId, { correct: true, truth: true, source });
    }
    const own = await gate.report();
    expect(own.labelled).toBe(1);
    expect(own.unregistered).toBe(3);
    const all = await engine.report();
    expect(all.unregistered).toBe(3);

    const md = (await report([path])).output;
    expect(md).toContain("## Unregistered label sources");
    expect(md).toContain('"Reverted:git"');
    expect(md).toContain('"accepted:"');
    expect(md).toContain('"hook:inferred"');
    expect(md).not.toMatch(/Unregistered label sources[\s\S]*"review:blind"/);
  });
});

describe("the CLI names what a damaged ledger read left out (e2e T4-02)", () => {
  it("describes skipped, duplicate and torn lines in one sentence, and nothing for a clean read", async () => {
    const { describeHealth } = await import("../src/cli/common.ts");
    expect(describeHealth({ skipped: 0, duplicates: 0, torn: false })).toBeUndefined();
    expect(describeHealth({ skipped: 1, duplicates: 0, torn: false })).toBe(
      "skipped 1 unreadable line.",
    );
    expect(describeHealth({ skipped: 2, duplicates: 3, torn: true })).toBe(
      "skipped 2 unreadable lines; kept the first record of 3 duplicate ids; " +
        "ignored a torn final line (an append cut short or still in progress).",
    );
  });
});
