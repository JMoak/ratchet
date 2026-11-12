import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check, checkGate } from "../src/cli/check.ts";
import { groupGates } from "../src/cli/common.ts";
import { Engine } from "../src/engine.ts";
import { currentConfiguration, describeGrade, gradeOf } from "../src/ledger/evidence.ts";
import { JsonlLedger, MemoryLedger } from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import { relevance } from "../src/recipes/screen.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

const fixed = (p: number): Oracle => ({
  id: "fixed",
  async decide(_state, qs) {
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, p),
      oracle: "fixed",
      model: "m-1",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-c-config-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("an estimate, a fitted bar and check read only the newest configuration (e2e T4-20)", () => {
  it("fails check and grades none after a rubric, policy and evidence-version change", async () => {
    // The red-team repro: 40 labelled rows of an old rubric and policy, then a new rubric, a far
    // looser policy and a new evidence version with no label at all. Before, check passed and
    // the grade read estimated on the old configuration's labels.
    const path = join(dir, "rubric-change.jsonl");
    const ledger = new JsonlLedger(path);
    const e = new Engine({ oracle: fixed(0.97), ledger });
    const old = e.gate({
      id: "g",
      question: judge("Is this command safe to run without asking?", { id: "safe" }),
      policy: { actAbove: 0.9 },
      evidenceVersion: "v1",
    });
    for (let i = 0; i < 40; i++) {
      const r = await old.ask(`old ${i}`);
      await e.label(r.recordId, { correct: true, truth: true, source: "review:blind:t4" });
    }
    const e2 = new Engine({ oracle: fixed(0.15), ledger });
    const changed = e2.gate({
      id: "g",
      question: judge("Would the user probably not mind this?", { id: "safe" }),
      policy: { actAbove: 0.1 },
      evidenceVersion: "v2",
    });
    for (let i = 0; i < 10; i++) await changed.ask(`new ${i}`);

    const chk = await check([path, "--gate", "g", "--promise", "0.9"]);
    expect(chk.exitCode).toBe(1);
    expect(chk.output).toContain(
      "has none: 0 labelled unselected rows of the current configuration",
    );
    expect(chk.output).toContain(
      "40 labelled unselected rows under an older policy, rubric or evidence version were not read",
    );
    expect(chk.output).toContain(
      "window 50 of 50 rows, 40 of them under an older policy, rubric or evidence version and not read",
    );
    const rep = await changed.report({ targetAccuracy: 0.9 });
    expect(rep.grade).toMatchObject({ kind: "none", unselected: 0, older: 40 });
    expect(rep.fitted).toBeUndefined();
    expect(rep.fittedFrom).toBeUndefined();
  });

  it("reads each change of policy, rubric or evidence version as a new configuration", () => {
    const base = {
      gateId: "g",
      questionHash: "q1",
      policyHash: "p1",
      evidenceVersion: "v1",
    };
    const rows = [
      { ...base, id: "a" },
      { ...base, id: "b", policyHash: "p2" },
      { ...base, id: "c", questionHash: "q2" },
      { ...base, id: "d", evidenceVersion: "v2" },
      { ...base, id: "e" },
    ] as never[];
    expect(currentConfiguration(rows).current.map((r) => r.id)).toEqual(["a", "e"]);
    expect(currentConfiguration(rows).older.map((r) => r.id)).toEqual(["b", "c", "d"]);
    // Rows written before policies were hashed are one configuration, as they always were.
    const legacy = [
      { id: "x", questionHash: "q" },
      { id: "y", questionHash: "q" },
    ] as never[];
    expect(currentConfiguration(legacy).current).toHaveLength(2);
    expect(currentConfiguration([]).current).toEqual([]);
  });

  it("estimates on the current configuration alone and says how many it left unread", async () => {
    const engine = new Engine({ oracle: fixed(0.9), ledger: new MemoryLedger() });
    const q = judge("ok?", { id: "q" });
    const ask = async (policy: { actAbove: number }, n: number, right: boolean) => {
      for (let i = 0; i < n; i++) {
        const r = await engine.ask(`s ${policy.actAbove} ${i}`, q, { policy });
        await engine.label(r.recordId, { correct: right, truth: right });
      }
    };
    // Thirty wrong labels under one policy, then thirty right ones under the next.
    await ask({ actAbove: 0.95 }, 30, false);
    await ask({ actAbove: 0.8 }, 30, true);
    const rows = await engine.ledger.all();
    const grade = gradeOf(rows);
    expect(grade).toMatchObject({ kind: "estimated", accuracy: 1, n: 30, older: 30 });
    expect(describeGrade(grade)).toContain(
      "not a planned sample; 30 labelled unselected rows under an older policy, rubric or evidence version were not read",
    );
  });
});

describe("check reads the current policy and the gate's current mode (e2e T1-12)", () => {
  it("judges acted accuracy on the newest policy's rows only", async () => {
    const ledger = new MemoryLedger();
    const loose = new Engine({ oracle: fixed(0.85), ledger });
    const g1 = loose.gate({
      id: "g",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.8 },
    });
    // Under the loose policy: 40 acts, 10 of them wrong.
    for (let i = 0; i < 40; i++) {
      const r = await g1.ask(`loose ${i}`);
      await loose.label(r.recordId, { correct: i >= 10, truth: i >= 10 });
    }
    const strict = new Engine({ oracle: fixed(0.96), ledger });
    const g2 = strict.gate({
      id: "g",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.95 },
    });
    for (let i = 0; i < 40; i++) {
      const r = await g2.ask(`strict ${i}`);
      await strict.label(r.recordId, { correct: true, truth: true });
    }
    const r = checkGate(groupGates(await ledger.all()), {
      gate: "g",
      promise: 0.95,
      minRows: 30,
      window: 500,
    });
    expect(r.acted).toMatchObject({ n: 40, accuracy: 1, judged: true });
    expect(r.olderRows).toBe(40);
    expect(r.pass).toBe(true);
  });

  it("does not say a demoted gate enforces because enforce rows remain in the window", async () => {
    const ledger = new MemoryLedger();
    const engine = new Engine({ oracle: fixed(0.97), ledger });
    const gate = engine.gate({
      id: "g",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.9 },
    });
    gate.mode = "enforce";
    for (let i = 0; i < 20; i++) await gate.ask(`enforced ${i}`);
    gate.mode = "shadow";
    for (let i = 0; i < 40; i++) {
      const r = await gate.ask(`after ${i}`);
      await engine.label(r.recordId, { correct: true, truth: true });
    }
    const rows = await ledger.all();
    const r = checkGate(groupGates(rows), { gate: "g", promise: 0.9, minRows: 30, window: 500 });
    expect(r.requiredBy).toBe("shadow");
    expect(r.require).toBe("estimated");
    expect(r.line).not.toContain("this gate enforces");
    expect(r.line).toContain(
      "this gate is in shadow now (enforce rows in the window predate its newest row)",
    );
    // While it enforces, it still owes a measured grade.
    gate.mode = "enforce";
    await gate.ask("enforced again");
    const now = checkGate(groupGates(await ledger.all()), {
      gate: "g",
      promise: 0.9,
      minRows: 30,
      window: 500,
    });
    expect([now.requiredBy, now.require]).toEqual(["enforce", "measured"]);
  });
});

describe("the current configuration is matched per question (wave 2 follow-up)", () => {
  it("keeps every item of a gate asked through relevance() current", async () => {
    // A context.keep gate asks one question per item, each with its own id, so its slice holds
    // 40 question ids; matching all rows to the newest row's rubric graded the last item alone.
    const engine = new Engine({ oracle: fixed(0.9), ledger: new MemoryLedger() });
    const gate = engine.gate({
      id: "context.keep",
      question: judge("Is this item still needed?", { id: "keep" }),
      policy: { actAbove: 0.8 },
    });
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `item-${i}`, summary: `s ${i}` }));
    const rel = await relevance(gate, "Task: fix the failing test", items, {
      policy: { actAbove: 0.8 },
      perRequest: 10,
    });
    for (const r of rel.results) await engine.label(r.recordId, { correct: true, truth: true });
    const rows = (await engine.ledger.all()).filter((r) => r.gateId === "context.keep");
    expect(new Set(rows.map((r) => r.questionId)).size).toBe(40);
    const { current, older } = currentConfiguration(rows);
    expect([current.length, older.length]).toEqual([40, 0]);
    const rep = await gate.report({ targetAccuracy: 0.9 });
    expect(rep.grade).toMatchObject({ kind: "estimated", n: 40 });
    expect(rep.fitRows).toBe(40);
    const chk = checkGate(groupGates(rows), {
      gate: "context.keep",
      promise: 0.9,
      minRows: 30,
      window: 500,
    });
    expect([chk.olderRows, chk.acted.n, chk.pass]).toEqual([0, 40, true]);
  });

  it("still leaves a single-question gate's old rubric behind after an edit", async () => {
    const ledger = new MemoryLedger();
    const before = new Engine({ oracle: fixed(0.9), ledger });
    const g1 = before.gate({
      id: "g",
      question: judge("Safe?", { id: "safe" }),
      policy: { actAbove: 0.8 },
    });
    for (let i = 0; i < 30; i++) {
      const r = await g1.ask(`a ${i}`);
      await before.label(r.recordId, { correct: true, truth: true });
    }
    // Same question id, same policy, a reworded rubric.
    const after = new Engine({ oracle: fixed(0.9), ledger });
    const g2 = after.gate({
      id: "g",
      question: judge("Safe to run without asking?", { id: "safe" }),
      policy: { actAbove: 0.8 },
    });
    for (let i = 0; i < 5; i++) await g2.ask(`b ${i}`);
    const rows = await ledger.all();
    const { current, older } = currentConfiguration(rows);
    expect([current.length, older.length]).toEqual([5, 30]);
    expect(gradeOf(rows)).toMatchObject({ kind: "none", older: 30 });
  });
});

describe("check --min-support sets the support of the act bar on the line (wave 2 follow-up)", () => {
  it("prints the fitted act bar, and --min-support moves it", async () => {
    const path = join(dir, "support.jsonl");
    const engine = new Engine({ oracle: fixed(0.97), ledger: new JsonlLedger(path) });
    const gate = engine.gate({
      id: "g",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.9 },
    });
    for (let i = 0; i < 80; i++) {
      const r = await gate.ask(`s ${i}`);
      await engine.label(r.recordId, { correct: true, truth: true });
    }
    const run = (...extra: string[]) => check([path, "--gate", "g", "--promise", "0.95", ...extra]);
    const plain = await run();
    expect(plain.exitCode).toBe(0);
    expect(plain.output).toContain(
      "act bar 0.970: acting right 100.0% on the 80 rows at or above it, lower end of the 95% interval >= 95.0%",
    );
    const strict = await run("--min-support", "100");
    expect(strict.output).toContain(
      "no act bar: 80 labelled rows, and a bar needs 100 at or above it",
    );
    expect(strict.exitCode).toBe(0);
    const r = checkGate(groupGates(await engine.ledger.all()), {
      gate: "g",
      promise: 0.95,
      minRows: 30,
      window: 500,
      minSupport: 100,
    });
    // Fewer unselected rows than the support asked for: the fallback, marked biased.
    expect(r.bar).toMatchObject({ fittedFrom: "all", fitRows: 80 });
    expect(r.bar.fitted).toBeUndefined();
  });
});
