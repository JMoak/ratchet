/**
 * A row keeps its labels: every outcome attached to it, oldest first, once there is more than
 * one, with `outcome` still the latest. A row labelled once, or never, is exactly the row it was.
 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import {
  type DecisionRecord,
  JsonlLedger,
  type Ledger,
  labelHistory,
  MemoryLedger,
  type Outcome,
  parseJsonlLedger,
  scanJsonlLedger,
} from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

function rec(id: string): DecisionRecord {
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
    verdict: { kind: "judge", questionId: "safe", pYes: 0.97, confidence: 0.97 },
    go: 0.97,
    confidence: 0.97,
    agreement: 1,
    soft: "act",
    action: "review",
    mode: "shadow",
    cost: 0,
    latencyMs: 1,
    failedOpen: false,
    tags: [],
  };
}

const first: Outcome = {
  at: "2026-11-12T01:00:00.000Z",
  correct: false,
  truth: false,
  source: "keywork:person",
};
const second: Outcome = {
  at: "2026-11-12T02:00:00.000Z",
  correct: true,
  truth: true,
  source: "review:blind:ana",
};
const third: Outcome = {
  at: "2026-11-12T03:00:00.000Z",
  correct: false,
  truth: false,
  source: "review:blind:ben",
};

const decisionLine = (r: DecisionRecord) => `${JSON.stringify({ type: "decision", record: r })}\n`;
const outcomeLine = (id: string, outcome: Outcome) =>
  `${JSON.stringify({ type: "outcome", id, outcome })}\n`;

let dir = "";
let n = 0;
const path = (): string => join(dir, `history-${n++}.jsonl`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-label-history-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Two rows, the first labelled `labels` in order; the second never labelled. */
async function labelled(ledger: Ledger, labels: readonly Outcome[]): Promise<void> {
  await ledger.append(rec("a"));
  await ledger.append(rec("b"));
  for (const o of labels) expect(await ledger.label("a", o)).toBe(true);
}

describe("a row keeps its labels", () => {
  it("one label gives today's row exactly, with no labels key; no label gives the row as appended", async () => {
    const ledger = new MemoryLedger();
    await labelled(ledger, [first]);
    const [a, b] = await ledger.all();
    expect(a).toStrictEqual({ ...rec("a"), outcome: first });
    expect(a).not.toHaveProperty("labels");
    expect(b).toStrictEqual(rec("b"));
    expect(labelHistory(a as DecisionRecord)).toEqual([first]);
    expect(labelHistory(b as DecisionRecord)).toEqual([]);
  });

  it("two or more give every label in order, and outcome stays the latest", async () => {
    const ledger = new MemoryLedger();
    await labelled(ledger, [first, second]);
    expect(await ledger.get("a")).toStrictEqual({
      ...rec("a"),
      outcome: second,
      labels: [first, second],
    });
    await ledger.label("a", third);
    const a = (await ledger.get("a")) as DecisionRecord;
    expect(a.outcome).toEqual(third);
    expect(a.labels).toEqual([first, second, third]);
    expect(labelHistory(a)).toEqual([first, second, third]);
    expect(await ledger.request("req-a")).toEqual([a]);
  });

  it("a memory ledger and a JSONL ledger agree, and a reopened JSONL ledger shows the same history", async () => {
    const memory = new MemoryLedger();
    const file = path();
    const jsonl = new JsonlLedger(file);
    await labelled(memory, [first, second, third]);
    await labelled(jsonl, [first, second, third]);
    const rows = await memory.all();
    expect(await jsonl.all()).toEqual(rows);
    expect(await new JsonlLedger(file).all()).toEqual(rows);
    const text = await readFile(file, "utf8");
    expect(scanJsonlLedger(text).rows).toEqual(rows);
    expect(parseJsonlLedger(text)).toEqual(rows);
    // Nothing about what is written changed: one decision line per row, one outcome line per label.
    expect(text).toBe(
      decisionLine(rec("a")) +
        decisionLine(rec("b")) +
        outcomeLine("a", first) +
        outcomeLine("a", second) +
        outcomeLine("a", third),
    );
  });

  it("two ledger objects writing one file see one history", async () => {
    const file = path();
    const one = new JsonlLedger(file);
    const two = new JsonlLedger(file);
    await one.append(rec("a"));
    await one.label("a", first);
    await two.label("a", second);
    await one.label("a", third);
    const expected = { ...rec("a"), outcome: third, labels: [first, second, third] };
    expect(await one.get("a")).toStrictEqual(expected);
    expect(await two.get("a")).toStrictEqual(expected);
    expect(await new JsonlLedger(file).all()).toStrictEqual([expected]);
  });

  it("a last outcome line still without its newline joins the history it will join once indexed", async () => {
    const file = path();
    const whole = decisionLine(rec("a")) + outcomeLine("a", first) + outcomeLine("a", second);
    await writeFile(file, whole.slice(0, -1), "utf8");
    const ledger = new JsonlLedger(file);
    const pending = { ...rec("a"), outcome: second, labels: [first, second] };
    expect(await ledger.all()).toStrictEqual([pending]);
    expect(await ledger.get("a")).toStrictEqual(pending);
    expect(ledger.torn).toBe(false);
    await appendFile(file, "\n", "utf8");
    expect(await ledger.all()).toStrictEqual([pending]);
  });

  it("leaves health exactly as before: duplicates keep the first record's history, unknown ids are skipped", async () => {
    const text =
      decisionLine(rec("a")) +
      outcomeLine("a", first) +
      decisionLine({ ...rec("a"), go: 0.5 }) +
      outcomeLine("a", second) +
      outcomeLine("nobody", third);
    const file = path();
    await writeFile(file, text, "utf8");
    const ledger = new JsonlLedger(file);
    const [a] = await ledger.all();
    expect(a).toStrictEqual({ ...rec("a"), outcome: second, labels: [first, second] });
    expect(ledger.health).toEqual({ skipped: 1, duplicates: 1, torn: false });
    expect(scanJsonlLedger(text)).toMatchObject({ skipped: 1, duplicates: 1, torn: false });

    const memory = new MemoryLedger();
    await labelled(memory, [first, second]);
    await memory.append({ ...rec("a"), go: 0.5 });
    expect(await memory.label("nobody", third)).toBe(false);
    expect(memory.health).toEqual({ skipped: 0, duplicates: 1, torn: false });
    expect((await memory.get("a"))?.labels).toEqual([first, second]);
  });
});

describe("a battery labelled twice gives its members histories", () => {
  const fixed: Oracle = {
    id: "fixed",
    decide: async (_s, qs) =>
      qs.map((q) => ({
        verdict: judgeVerdictFrom(q as JudgeQuestion, 0.9),
        oracle: "fixed",
        cost: 0,
        latencyMs: 1,
        at: "2026-11-12T00:00:00.000Z",
      })),
  };
  const members = [judge("Is it spam?", { id: "spam" }), judge("Is it abuse?", { id: "abuse" })];

  for (const kind of ["memory", "jsonl"] as const) {
    it(`through the combined row's label, in a ${kind} ledger`, async () => {
      const ledger = kind === "memory" ? new MemoryLedger() : new JsonlLedger(path());
      const engine = new Engine({ oracle: fixed, ledger });
      const gate = engine.gate({ id: "bat", question: members, policy: { actAbove: 0.8 } });
      const r = await gate.ask("post: hello");
      const one = { correct: true, truth: true, source: "keywork:person", at: "t1" };
      const two = {
        correct: false,
        truth: false,
        source: "review:blind:ana",
        at: "t2",
        memberTruths: { spam: false, abuse: true },
      };
      await engine.label(r.recordId, one);
      await engine.label(r.recordId, two);
      const rows = await ledger.all();
      const combined = rows.find((x) => x.combined === true) as DecisionRecord;
      expect(combined.labels).toEqual([one, two]);
      expect(combined.outcome).toEqual(two);
      for (const m of rows.filter((x) => x.combined !== true)) {
        // Each member's history is what it inherited from each label, in order.
        expect(m.labels?.map((o) => [o.truth, o.inheritedFrom, o.source])).toEqual([
          [true, r.recordId, "keywork:person"],
          [m.questionId === "abuse", r.recordId, "review:blind:ana"],
        ]);
        expect(m.outcome).toEqual(m.labels?.[1]);
      }
      if (ledger instanceof JsonlLedger) {
        expect(await new JsonlLedger(ledger.path).all()).toEqual(rows);
      }
    });
  }
});
