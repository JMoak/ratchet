import { describe, expect, it } from "vitest";
import {
  KEYWORK_FIT_FROM,
  KEYWORK_LABEL_SOURCE,
  keyworkGateSpec,
} from "../experiments/keywork/gate.ts";
import { callTag, ingestDecisions } from "../experiments/keywork/ingest.ts";
import { currentPhase, phaseSpec } from "../experiments/keywork/phase.ts";
import {
  KEYWORK_SCHEMA,
  parseToolDecisions,
  type ToolDecision,
} from "../experiments/keywork/record.ts";
import { keyworkAcceptance, keyworkReport, scopedRows } from "../experiments/keywork/report.ts";
import { toolCallState } from "../experiments/keywork/state.ts";
import { Engine } from "../src/engine.ts";
import { MemoryLedger } from "../src/ledger/ledger.ts";
import { judge } from "../src/questions.ts";
import type { Decision, Oracle, Question } from "../src/types.ts";

let sequence = 0;

/** A freeze before the fixture dates, so the fixtures are evidence under it. */
const frozen = { freeze: { at: "2026-10-25T00:00:00.000Z", actAbove: 0.95 } };
const evidence = { phase: "evidence", bounds: frozen } as const;

/** Fixture answers fall after KEYWORK_FIT_FROM and the test freeze unless a test says otherwise. */
function decision(overrides: Partial<ToolDecision> & { command?: string } = {}): ToolDecision {
  sequence++;
  const { command, ...rest } = overrides;
  return {
    session: "s1",
    rootSession: "s1",
    callId: `c${sequence}`,
    at: new Date(Date.UTC(2026, 10, 1, 0, sequence)).toISOString(),
    tool: "bash",
    subject: {
      kind: "command",
      command: command ?? `make test-${sequence}`,
      truncated: false,
      parts: 1,
      destructive: false,
      opaque: false,
    },
    ask: {
      at: new Date(Date.UTC(2026, 10, 1, 0, sequence)).toISOString(),
      rule: "default",
      grantable: true,
    },
    answer: {
      at: new Date(Date.UTC(2026, 10, 1, 0, sequence, 5)).toISOString(),
      verdict: "granted",
      gate: "user",
      scope: "once",
      by: "person",
    },
    ...rest,
  };
}

/** Says yes with the given probability and records every state it was shown. */
function fixedOracle(pYes: number, seen: string[] = []): Oracle {
  return {
    id: "fixed",
    decide: async (state: string, questions: readonly Question[]): Promise<Decision[]> => {
      seen.push(state);
      return questions.map((q) => ({
        verdict: { kind: "judge", questionId: q.id, pYes, confidence: Math.max(pYes, 1 - pYes) },
        oracle: "fixed",
        model: "fixed-1",
        latencyMs: 0,
        cost: 0.00001,
        // The daily cap reads this clock, so a fixed date would turn into yesterday at midnight UTC.
        at: new Date().toISOString(),
      }));
    },
  };
}

function setup(oracle: Oracle, budgetUsd?: number) {
  const engine = new Engine({
    oracle,
    ledger: new MemoryLedger(),
    keepState: true,
    seed: 1,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  });
  return { engine, gate: engine.gate(keyworkGateSpec()) };
}

describe("keywork decision export", () => {
  it("reads valid records and rejects malformed lines with their line numbers", () => {
    const good = JSON.stringify({ schema: KEYWORK_SCHEMA, ...decision() });
    const wrongSchema = JSON.stringify({ ...JSON.parse(good), schema: "keywork.tool-decision/9" });
    const badSubject = JSON.stringify({ ...JSON.parse(good), subject: { kind: "shell" } });
    const parsed = parseToolDecisions([good, "", "{not json", wrongSchema, badSubject].join("\n"));
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.rejected.map((r) => r.line)).toEqual([3, 4, 5]);
  });

  it("reads why a person denied and rejects a reason it does not know", () => {
    const base = JSON.parse(JSON.stringify({ schema: KEYWORK_SCHEMA, ...decision() }));
    const notNow = { ...base, answer: { ...base.answer, verdict: "denied", reason: "not-now" } };
    const bored = { ...base, answer: { ...base.answer, verdict: "denied", reason: "bored" } };
    const parsed = parseToolDecisions([notNow, bored].map((r) => JSON.stringify(r)).join("\n"));
    expect(parsed.decisions.map((d) => d.answer.reason)).toEqual(["not-now"]);
    expect(parsed.rejected).toEqual([
      { line: 2, reason: expect.stringContaining("answer.reason") },
    ]);
  });
});

describe("keywork phases", () => {
  it("splits answers by the instant they were given and keeps a ledger per phase", () => {
    const freeze = { at: "2026-12-01T00:00:00.000Z", actAbove: 0.7 };
    expect(phaseSpec("smoke", { freeze: undefined }).window).toEqual({ before: KEYWORK_FIT_FROM });
    expect(phaseSpec("fit", { freeze: undefined }).window).toEqual({ since: KEYWORK_FIT_FROM });
    expect(phaseSpec("fit", { freeze }).window).toEqual({
      since: KEYWORK_FIT_FROM,
      before: freeze.at,
    });
    expect(phaseSpec("evidence", { freeze }).window).toEqual({ since: freeze.at });
    expect(() => phaseSpec("evidence", { freeze: undefined })).toThrow(/not frozen/);
    expect(currentPhase({ freeze: undefined })).toBe("fit");
    expect(currentPhase({ freeze })).toBe("evidence");
    const ledgers = (["smoke", "fit", "evidence"] as const).map(
      (p) => phaseSpec(p, { freeze }).ledger,
    );
    expect(new Set(ledgers).size).toBe(3);
  });
});

describe("keywork tool-call state", () => {
  it("keeps the agent's command untrusted and keywork's facts trusted, and never the answer", () => {
    const state = toolCallState(decision({ command: "git push origin main" }));
    expect(state.untrusted).toEqual(["command"]);
    expect(state.text).toContain("destructive: false");
    expect(state.text).not.toMatch(/granted|denied|scope|once|answer|afterMs/);
  });

  it("describes a file change by keywork's computed size, not its text", () => {
    const state = toolCallState(
      decision({
        tool: "edit",
        subject: {
          kind: "path",
          path: "src/a.ts",
          insideWorkspace: true,
          change: { kind: "edit", removedLines: 2, addedLines: 1, replaceAll: false },
        },
      }),
    );
    expect(state.text).toContain("inside_workspace: true");
    expect(state.text).toContain("lines_removed: 2");
    expect(state.untrusted).toEqual(["path"]);
  });
});

describe("keywork ingestion", () => {
  it("replays only fresh answers by a person, oldest first, labelled with the answer", async () => {
    const seen: string[] = [];
    const { engine, gate } = setup(fixedOracle(0.99, seen));
    const later = decision({ command: "make build" });
    const earlier = decision({
      command: "make lint",
      answer: { ...decision().answer, at: "2026-09-01T00:00:00.000Z", verdict: "denied" },
    });
    const grant = decision({ answer: { ...decision().answer, by: "grant" } });
    const rule = decision({ answer: { ...decision().answer, by: "rule", gate: "policy" } });

    const result = await ingestDecisions(engine, gate, [later, earlier, grant, rule]);

    expect(result).toMatchObject({ population: 2, asked: 2, already: 0 });
    expect(result.skipped).toMatchObject({ grant: 1, rule: 1 });
    expect(seen[0]).toContain("make lint");
    const rows = await engine.ledger.all();
    expect(rows.map((r) => r.outcome)).toEqual([
      expect.objectContaining({ truth: false, correct: false, source: KEYWORK_LABEL_SOURCE }),
      expect.objectContaining({ truth: true, correct: true, source: KEYWORK_LABEL_SOURCE }),
    ]);
    expect(rows[0]?.tags).toEqual(
      expect.arrayContaining([callTag(earlier), "session:s1", "keywork:tool:bash"]),
    );
    expect(rows.every((r) => r.mode === "shadow" && r.action === "review")).toBe(true);
  });

  it("keeps the smoke set and evidence apart by the instant the person answered", async () => {
    const smoke = decision({ answer: { ...decision().answer, at: "2026-08-15T00:00:00.000Z" } });
    const fresh = decision();

    const later = setup(fixedOracle(0.99));
    const since = { since: KEYWORK_FIT_FROM };
    const ingested = await ingestDecisions(later.engine, later.gate, [smoke, fresh], since);
    expect(ingested).toMatchObject({ population: 1, asked: 1, outsideWindow: 1 });
    expect((await later.engine.ledger.all()).map((r) => r.tags[0])).toEqual([callTag(fresh)]);

    const before = setup(fixedOracle(0.99));
    const window = { before: KEYWORK_FIT_FROM };
    const replayed = await ingestDecisions(before.engine, before.gate, [smoke, fresh], window);
    expect(replayed).toMatchObject({ population: 1, asked: 1, outsideWindow: 1 });
    expect((await before.engine.ledger.all()).map((r) => r.tags[0])).toEqual([callTag(smoke)]);
  });

  it("leaves out a denial that judged the moment and labels one that judged the call", async () => {
    const { engine, gate } = setup(fixedOracle(0.99));
    const notNow = decision({
      answer: { ...decision().answer, verdict: "denied", reason: "not-now" },
    });
    const unsafe = decision({
      answer: { ...decision().answer, verdict: "denied", reason: "unsafe" },
    });
    const legacy = decision({ answer: { ...decision().answer, verdict: "denied" } });

    const result = await ingestDecisions(engine, gate, [notNow, unsafe, legacy]);

    expect(result).toMatchObject({ population: 2, asked: 2, steering: 1 });
    const rows = await engine.ledger.all();
    expect(rows.map((r) => r.tags[0])).toEqual([callTag(unsafe), callTag(legacy)]);
    expect(rows.map((r) => r.outcome?.truth)).toEqual([false, false]);
  });

  it("asks again when the rubric changes, because that is a new question", async () => {
    const ledger = new MemoryLedger();
    const first = new Engine({ oracle: fixedOracle(0.99), ledger, seed: 1 });
    const d = decision();
    await ingestDecisions(first, first.gate(keyworkGateSpec()), [d]);

    const reworded = new Engine({ oracle: fixedOracle(0.99), ledger, seed: 1 });
    const gate = reworded.gate({
      ...keyworkGateSpec(),
      question: judge("Would you approve this call?", { id: "keywork.tool.approve" }),
    });

    expect((await ingestDecisions(reworded, gate, [d])).asked).toBe(1);
    expect(await ledger.all()).toHaveLength(2);
  });

  it("never asks twice about a call already in the ledger", async () => {
    const { engine, gate } = setup(fixedOracle(0.99));
    const decisions = [decision(), decision()];
    await ingestDecisions(engine, gate, decisions);

    const again = await ingestDecisions(engine, gate, decisions);

    expect(again).toMatchObject({ asked: 0, already: 2 });
    expect(await engine.ledger.all()).toHaveLength(2);
  });

  it("asks again about a call whose earlier answer failed open", async () => {
    const failing: Oracle = { id: "down", decide: () => Promise.reject(new Error("outage")) };
    const down = setup(failing);
    const d = decision();
    await ingestDecisions(down.engine, down.gate, [d]);
    const ledger = down.engine.ledger;
    const engine = new Engine({ oracle: fixedOracle(0.99), ledger, seed: 1 });
    const gate = engine.gate(keyworkGateSpec());

    const retried = await ingestDecisions(engine, gate, [d]);

    expect(retried.asked).toBe(1);
    expect((await ledger.all()).map((r) => r.failedOpen)).toEqual([true, false]);
  });

  it("lets keywork's floors decide destructive, opaque and outside calls without a model", async () => {
    const seen: string[] = [];
    const { engine, gate } = setup(fixedOracle(0.99, seen));
    const destructive = decision({
      subject: {
        ...(decision().subject as Extract<ToolDecision["subject"], { kind: "command" }>),
        destructive: true,
      },
    });
    const opaque = decision({
      subject: {
        ...(decision().subject as Extract<ToolDecision["subject"], { kind: "command" }>),
        opaque: true,
      },
    });
    const outside = decision({
      tool: "write",
      subject: { kind: "path", path: "~/notes.md", insideWorkspace: false },
    });

    await ingestDecisions(engine, gate, [destructive, opaque, outside]);

    expect(seen).toEqual([]);
    const rows = await engine.ledger.all();
    expect(rows.map((r) => [r.strategy, r.soft])).toEqual([
      ["floored", "review"],
      ["floored", "review"],
      ["floored", "review"],
    ]);
  });

  it("stops at the spend cap and leaves the rest for a later run", async () => {
    const { engine, gate } = setup(fixedOracle(0.99), 0.00002);
    const result = await ingestDecisions(engine, gate, [decision(), decision(), decision()]);
    expect(result).toMatchObject({ asked: 2, stoppedAtBudget: true });
  });

  it("stops at the day's cap, which a second run on the same ledger cannot reset", async () => {
    const ledger = new MemoryLedger();
    const run = async (decisions: readonly ToolDecision[]) => {
      const engine = new Engine({ oracle: fixedOracle(0.99), ledger, dailyBudgetUsd: 0.00002 });
      return ingestDecisions(engine, engine.gate(keyworkGateSpec()), decisions);
    };
    const decisions = [decision(), decision(), decision()];

    expect(await run(decisions)).toMatchObject({ asked: 2, stoppedAtBudget: true });
    expect(await run(decisions)).toMatchObject({ asked: 0, already: 2, stoppedAtBudget: true });
  });
});

describe("keywork report and acceptance", () => {
  it("keeps the verdict sealed while the planned sample is collecting", async () => {
    const { engine, gate } = setup(fixedOracle(0.99));
    await ingestDecisions(
      engine,
      gate,
      Array.from({ length: 12 }, () => decision()),
    );
    const rows = scopedRows(await engine.ledger.all(), gate);

    expect(keyworkAcceptance(rows)).toMatchObject({ status: "collecting", acts: 10 });
    const report = keyworkReport(await engine.ledger.all(), gate, evidence);
    expect(report).toContain("Collecting: 10 of 149 acts");
    expect(report).toContain(`${KEYWORK_LABEL_SOURCE} 12`);
    expect(report).toContain("sealed until the planned sample is evaluated (12 labelled");
    expect(report).not.toMatch(/approved|denied|ECE|Brier/);
  });

  it("opens accuracy and calibration once the planned sample has been evaluated", async () => {
    const { engine, gate } = setup(fixedOracle(0.99));
    const sessions = Array.from({ length: 150 }, (_, i) => `s${i % 15}`);
    await ingestDecisions(
      engine,
      gate,
      sessions.map((rootSession) => decision({ rootSession })),
    );

    const report = keyworkReport(await engine.ledger.all(), gate, evidence);

    expect(report).toContain("Accepted: 0 wrong of 149");
    expect(report).toContain("Suggested acts the person approved: 150; denied: 0");
    expect(report).toContain("Calibration on 150 labelled answers");
  });

  it("shows the smoke set in full and plans nothing on it, because it is not evidence", async () => {
    const { engine, gate } = setup(fixedOracle(0.99));
    await ingestDecisions(engine, gate, [decision(), decision()]);

    const report = keyworkReport(await engine.ledger.all(), gate, { phase: "smoke" });

    expect(report).toContain("smoke run");
    expect(report).toContain("Suggested acts the person approved: 2; denied: 0");
    expect(report).not.toContain("## Acceptance");
    expect(report).not.toContain("sealed");
  });

  it("paces the plan by answers inside the evidence window only", async () => {
    const { engine, gate } = setup(fixedOracle(0.99));
    const fresh = [decision(), decision()];
    const smoke = decision({ answer: { ...decision().answer, at: "2026-08-01T00:00:00.000Z" } });
    await ingestDecisions(engine, gate, fresh);

    const report = keyworkReport(await engine.ledger.all(), gate, {
      ...evidence,
      decisions: [...fresh, smoke],
    });

    expect(report).toContain("2 person answers over 1 days");
  });

  it("reports the fit on fit rows, reading their labels freely, and how to freeze", async () => {
    const probabilities = [0.55, 0.65, 0.75, 0.85, 0.92, 0.97];
    let calls = 0;
    const ramp: Oracle = {
      id: "ramp",
      decide: async (_state: string, questions: readonly Question[]): Promise<Decision[]> => {
        const pYes = probabilities[calls++ % probabilities.length] as number;
        return questions.map((q) => ({
          verdict: { kind: "judge", questionId: q.id, pYes, confidence: Math.max(pYes, 1 - pYes) },
          oracle: "ramp",
          model: "ramp-1",
          latencyMs: 0,
          cost: 0,
          at: new Date().toISOString(),
        }));
      },
    };
    const { engine, gate } = setup(ramp);
    const decisions = Array.from({ length: 24 }, (_, k) => {
      const d = decision();
      return k % 6 === 0 ? { ...d, answer: { ...d.answer, verdict: "denied" as const } } : d;
    });
    await ingestDecisions(engine, gate, decisions);

    const report = keyworkReport(await engine.ledger.all(), gate, {
      phase: "fit",
      bounds: { freeze: undefined },
      decisions,
    });

    expect(report).toContain("fit phase");
    expect(report).toContain("Fit rows: 24 labelled model answers of 50 wanted");
    expect(report).toContain("| 0.60 | 20 | 83% | 0 | 100% |");
    expect(report).toContain("| 0.50 | 24 | 100% | 4 | 83% |");
    expect(report).toContain("act above 0.65 (20 acts, 83% of answers, 0 wrong)");
    expect(report).toContain("To freeze: set KEYWORK_FREEZE");
    expect(report).not.toContain("## Acceptance");
  });

  it("refuses to judge evidence that spans two models", async () => {
    const { engine, gate } = setup(fixedOracle(0.99));
    await ingestDecisions(engine, gate, [decision()]);
    const rows = scopedRows(await engine.ledger.all(), gate);
    const mixed = [...rows, { ...(rows[0] as (typeof rows)[number]), id: "x", model: "other-2" }];

    expect(keyworkAcceptance(mixed)).toMatchObject({ status: "mixed-models" });
  });
});
