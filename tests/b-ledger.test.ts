import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import {
  type DecisionRecord,
  JsonlLedger,
  MemoryLedger,
  parseJsonlLedger,
  scanJsonlLedger,
} from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

const fixed = (pYes: number): Oracle => ({
  id: "fixed",
  decide: async (_s, qs) =>
    qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, pYes),
      oracle: "fixed",
      cost: 0.001,
      latencyMs: 1,
      at: new Date().toISOString(),
    })),
});

const q = judge("Is this safe?", { id: "safe" });

function rec(id: string, pYes = 0.3): DecisionRecord {
  return {
    id,
    at: "2026-11-12T00:00:00.000Z",
    gateId: "g",
    requestId: `req-${id}`,
    questionId: "safe",
    kind: "judge",
    prompt: "Is this safe?",
    questionHash: "0000000000000000",
    stateHash: "0000000000000000",
    trustedHash: "0000000000000000",
    untrusted: [],
    oracle: "fake",
    strategy: "single",
    verdict: { kind: "judge", questionId: "safe", pYes, confidence: Math.max(pYes, 1 - pYes) },
    go: pYes,
    confidence: Math.max(pYes, 1 - pYes),
    agreement: 1,
    soft: "review",
    action: "review",
    mode: "shadow",
    cost: 0.001,
    latencyMs: 1,
    failedOpen: false,
    tags: [],
  };
}

const decision = (r: DecisionRecord) => `${JSON.stringify({ type: "decision", record: r })}\n`;
const outcome = (id: string, correct: boolean) =>
  `${JSON.stringify({ type: "outcome", id, outcome: { at: "2026-11-12T01:00:00.000Z", correct } })}\n`;

let dir = "";
let n = 0;
const file = async (text: string): Promise<string> => {
  const path = join(dir, `ledger-${n++}.jsonl`);
  await writeFile(path, text, "utf8");
  return path;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-b-ledger-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a damaged JSONL ledger still reads, and says what it skipped (e2e T4-02)", () => {
  const clean = decision(rec("a")) + decision(rec("b")) + outcome("a", true);

  it("strips a byte-order mark", async () => {
    const ledger = new JsonlLedger(await file(`\uFEFF${clean}`));
    // Old code: JSON.parse threw on the BOM, and with it every ask, label and report.
    expect((await ledger.all()).map((r) => r.id)).toEqual(["a", "b"]);
    expect(ledger.health).toEqual({ skipped: 0, duplicates: 0, torn: false });
    expect(parseJsonlLedger(`\uFEFF${clean}`)).toHaveLength(2);
  });

  it("ignores a torn last line, and reads it once it is completed", async () => {
    const whole = decision(rec("c"));
    const path = await file(clean + whole.slice(0, 40));
    const ledger = new JsonlLedger(path);
    expect((await ledger.all()).map((r) => r.id)).toEqual(["a", "b"]);
    expect(ledger.torn).toBe(true);
    expect(ledger.skipped).toBe(0);
    await appendFile(path, whole.slice(40), "utf8");
    expect((await ledger.all()).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(ledger.torn).toBe(false);
    expect(scanJsonlLedger(clean + whole.slice(0, 40))).toMatchObject({ torn: true, skipped: 0 });
  });

  it("skips and counts lines that are not decisions or outcomes", async () => {
    const junk = ["null", "42", "[1]", '"text"', '{"type":"decision"}', "{not json", '{"x":1}'];
    const ledger = new JsonlLedger(await file(`${clean}${junk.join("\n")}\n${decision(rec("d"))}`));
    expect((await ledger.all()).map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(ledger.skipped).toBe(junk.length);
    // The engine reads through it: ask, label and report no longer throw.
    const engine = new Engine({ oracle: fixed(0.3), ledger, dailyBudgetUsd: 1 });
    const g = engine.gate({ id: "g2", question: q, policy: { actAbove: 0.9 } });
    const r = await g.ask("new state");
    expect(await engine.label(r.recordId, { correct: true })).toBe(true);
    expect((await engine.report()).records).toBe(4);
  });

  it("keeps parseJsonlLedger strict for text from outside a ledger file", () => {
    expect(() => parseJsonlLedger(`${clean}{not json\n`)).toThrow(/line 4/);
    expect(() => parseJsonlLedger(clean + decision(rec("c")).slice(0, 40))).toThrow(/line 4/);
  });

  it("reads a recorded cost that is not a number as 0 with an estimate note", () => {
    const bad = { ...rec("s"), cost: "0.5" as unknown as number };
    const [row] = scanJsonlLedger(decision(bad)).rows;
    expect(row).toMatchObject({ cost: 0, costEstimate: { basis: "none" } });
  });
});

describe("a duplicate decision id keeps the first record and its labels (e2e T4-17)", () => {
  it("in a JSONL ledger", async () => {
    const text =
      decision(rec("a", 0.3)) + outcome("a", true) + decision(rec("a", 0.99)) + outcome("a", false);
    const ledger = new JsonlLedger(await file(text));
    const [row] = await ledger.all();
    // Old code: the second line replaced the row and dropped its label.
    expect(row?.verdict).toMatchObject({ pYes: 0.3 });
    expect(row?.outcome?.correct).toBe(false);
    expect(ledger.duplicates).toBe(1);
    expect(scanJsonlLedger(text).duplicates).toBe(1);
    expect(parseJsonlLedger(text)[0]?.verdict).toMatchObject({ pYes: 0.3 });
  });

  it("in a memory ledger", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(rec("a", 0.3));
    await ledger.label("a", { at: "x", correct: true });
    await ledger.append(rec("a", 0.99));
    expect(await ledger.all()).toHaveLength(1);
    expect(await ledger.get("a")).toMatchObject({
      verdict: { pYes: 0.3 },
      outcome: { correct: true },
    });
    expect(ledger.duplicates).toBe(1);
    expect(await ledger.request("req-a")).toHaveLength(1);
  });
});

describe("labelling reads only what was appended since the last read (e2e T2-11)", () => {
  it("labels many rows without rereading the file each time, and sees other writers", async () => {
    const path = await file("");
    const engine = new Engine({
      oracle: fixed(0.3),
      ledger: new JsonlLedger(path),
      keepState: true,
    });
    // The wave 1 shape: an 8-member battery, 200 requests, a kilobyte of state on every row.
    const battery = Array.from({ length: 8 }, (_, i) => judge(`member ${i}?`, { id: `m${i}` }));
    const g = engine.gate({ id: "bat", question: battery, policy: { actAbove: 0.9 } });
    const filler = "x".repeat(1000);
    const rs = await g.askMany(
      Array.from({ length: 200 }, (_, i) => `s${i} ${filler}`),
      { concurrency: 4 },
    );
    const t0 = performance.now();
    for (const r of rs) await engine.label(r.recordId, { correct: true, truth: false });
    const ms = performance.now() - t0;
    // Old code: 24 s for this (120 ms a label, growing with the file); now well under 1 ms a label.
    expect(ms).toBeLessThan(3000);
    const rows = await engine.ledger.all();
    expect(rows).toHaveLength(1800);
    expect(rows.every((r) => r.outcome !== undefined)).toBe(true);
    // A fresh reader of the same file agrees with the incrementally kept index.
    const fresh = await new JsonlLedger(path).all();
    expect(fresh).toEqual(rows);

    // Another process appends: the next read sees it.
    const other = new JsonlLedger(path);
    await other.append(rec("from-elsewhere"));
    expect(await engine.ledger.get?.("from-elsewhere")).toBeDefined();
    expect(await engine.label("from-elsewhere", { correct: true })).toBe(true);
    expect((await other.get("from-elsewhere"))?.outcome?.correct).toBe(true);
  });

  it("starts over when the file is rewritten rather than appended to", async () => {
    const path = await file(decision(rec("a")) + decision(rec("b")));
    const ledger = new JsonlLedger(path);
    expect(await ledger.all()).toHaveLength(2);
    await writeFile(path, decision(rec("z")), "utf8");
    expect((await ledger.all()).map((r) => r.id)).toEqual(["z"]);
    await rm(path);
    expect(await ledger.all()).toEqual([]);
  });
});

describe("a __proto__ id is reported like any other (e2e T4-18)", () => {
  it("keeps the gate and the question in report().byGate and byQuestion", async () => {
    const ledger = new MemoryLedger();
    await ledger.append({ ...rec("p"), gateId: "__proto__", questionId: "__proto__" });
    await ledger.append(rec("q"));
    const engine = new Engine({ oracle: fixed(0.3), ledger });
    const report = await engine.report();
    // Old code: the assignment set the object's prototype and the gate vanished.
    expect(Object.keys(report.byGate)).toEqual(["__proto__", "g"]);
    expect(Object.hasOwn(report.byGate, "__proto__")).toBe(true);
    const proto = "__proto__";
    expect(report.byGate[proto]?.n).toBe(1);
    expect(Object.keys(report.byQuestion)).toContain("__proto__");
    expect(JSON.parse(JSON.stringify(report)).byGate[proto].n).toBe(1);
  });
});

describe("an append after a torn last line keeps its row (e2e V1)", () => {
  it("ends the fragment's line first, so the new row is read, labelled and counted", async () => {
    const path = await file('{"type":"decision","record":{"id":"crashed-mid-wri');
    const engine = new Engine({ oracle: fixed(0.95), ledger: new JsonlLedger(path) });
    const g = engine.gate({ id: "g", question: q, policy: { actAbove: 0.9 } });
    const r = await g.ask("ls");
    // Old code: the row was written onto the fragment, so label() could not find it.
    expect(await engine.label(r.recordId, { correct: true, truth: true })).toBe(true);
    const restarted = new JsonlLedger(path);
    const rows = await restarted.all();
    expect(rows.map((x) => x.id)).toEqual([r.recordId]);
    expect(rows[0]?.outcome?.correct).toBe(true);
    expect(restarted.health).toEqual({ skipped: 1, duplicates: 0, torn: false });
    // The instance that wrote it agrees with a fresh reader.
    expect(await engine.ledger.all()).toEqual(rows);
  });
});
