import { beforeAll, describe, expect, it } from "vitest";
import { checkGate } from "../src/cli/check.ts";
import { groupGates } from "../src/cli/common.ts";
import { buildReport } from "../src/cli/report.ts";
import { Engine } from "../src/engine.ts";
import { allowIf, reviewIf } from "../src/floors.ts";
import {
  expectedAccuracy,
  scoredForYes,
  scoredFromLedger,
  scoredWithTruth,
} from "../src/ledger/calibration.ts";
import { type DecisionRecord, MemoryLedger } from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import { Rollout } from "../src/rollout.ts";
import type { Oracle } from "../src/types.ts";

const oracle: Oracle = {
  id: "always-yes-fixture",
  async decide(_state, questions) {
    return questions.map((question) => {
      if (question.kind !== "judge") throw new Error("Expected a judge fixture");
      return {
        verdict: judgeVerdictFrom(question, 0.9),
        oracle: "always-yes-fixture",
        model: "fixture-v1",
        at: new Date().toISOString(),
        cost: 0,
        latencyMs: 1,
      };
    });
  },
};
const gateId = "evidence-boundary";
let rows: readonly DecisionRecord[];
let engine: Engine;

beforeAll(async () => {
  engine = new Engine({ oracle, mode: "shadow" });
  const gate = engine.gate({
    id: gateId,
    evidenceVersion: "boundary-v1",
    question: judge("Is this action appropriate?", { id: "appropriate" }),
    policy: { actAbove: 0.8 },
    floors: [reviewIf(/^floor/)],
    bypass: [allowIf(/^known/)],
  });
  for (let i = 0; i < 20; i++) {
    const result = await gate.ask(`known-${i}`);
    await engine.label(result.recordId, { correct: true, truth: true });
  }
  for (let i = 0; i < 3; i++) {
    const result = await gate.ask(`floor-${i}`);
    await engine.label(result.recordId, { correct: true, truth: true });
  }
  const wrong = await gate.ask("a new action");
  await engine.label(wrong.recordId, { correct: false, truth: false });
  // A review floor with a refuse bar still buys an answer. Its calibration remains evidence.
  const [held] = await gate.askAll(
    "floor but answered",
    [judge("Appropriate?", { id: "appropriate" })],
    { policy: { actAbove: 0.8, refuseBelow: 0.1 }, evidenceVersion: "boundary-v1" },
  );
  if (!held) throw new Error("Missing answered floor fixture");
  await engine.label(held.recordId, { correct: false, truth: false });
  rows = await engine.ledger.all();
});

describe("code-only decisions cannot become model evidence", () => {
  it("keeps answered rows with a floor but excludes floor and bypass placeholders from calibration", () => {
    expect(rows.filter((row) => row.strategy === "bypass")).toHaveLength(20);
    expect(rows.filter((row) => row.strategy === "floored")).toHaveLength(3);
    expect(scoredFromLedger(rows)).toEqual([
      { confidence: 0.9, correct: false },
      { confidence: 0.9, correct: false },
    ]);
    expect(scoredWithTruth(rows)).toHaveLength(2);
    expect(scoredForYes(rows)).toEqual([
      { confidence: 0.9, correct: false },
      { confidence: 0.9, correct: false },
    ]);
    expect(expectedAccuracy(rows)).toBeCloseTo(0.9);
    const fixed = rows.filter((row) => row.strategy === "bypass" || row.strategy === "floored");
    expect(scoredFromLedger(fixed)).toEqual([]);
    expect(scoredWithTruth(fixed)).toEqual([]);
    expect(scoredForYes(fixed)).toEqual([]);
    expect(expectedAccuracy(fixed)).toBeUndefined();
  });

  it("reports the same model evidence through the engine and CLI while retaining operational totals", async () => {
    const cli = buildReport("fixture", rows, { target: 0.9, minSupport: 1 }).gates.find(
      (group) => group.gate === gateId,
    );
    const api = (await engine.report({ targetAccuracy: 0.9, minSupport: 1 })).byGate[gateId];
    expect(cli?.rows).toBe(25);
    expect(cli?.fixed).toBe(23);
    expect(cli?.labelled).toBe(api?.labelled);
    expect(cli?.labelled).toBe(2);
    expect(cli?.accuracy).toBe(0);
    expect(cli?.expectedAccuracy).toBeCloseTo(0.9);
    expect(cli?.fitted).toBeUndefined();

    const check = checkGate(groupGates(rows), {
      gate: gateId,
      promise: 0.9,
      minRows: 1,
      maxEce: 0.1,
      window: 100,
    });
    expect(check.pass).toBe(false);
    expect(check.acted).toMatchObject({ n: 1, accuracy: 0 });
    expect(check.ece).toMatchObject({ n: 2, value: 0.9 });
  });

  it("cannot promote an unreliable oracle on a large correct allowlist", async () => {
    const ledger = new MemoryLedger();
    const engine = new Engine({ oracle, ledger });
    const answered = rows.find((r) => r.strategy === "single" && r.soft === "act");
    if (!answered?.policyHash) throw new Error("Missing evidence identity");
    const rollout = new Rollout({
      engine,
      evidence: {
        version: "boundary-v1",
        questionHash: answered.questionHash,
        policyHash: answered.policyHash,
      },
      // A one-act plan, so the first act the model answered decides on its own.
      promisedAccuracy: 0.5,
      confidence: 0.5,
    });
    await rollout.evaluate();
    for (const row of rows) await ledger.append(row);
    expect(await rollout.evaluate()).toMatchObject({
      mode: "shadow",
      changed: false,
      acceptance: { status: "rejected", errors: 1 },
    });
  });

  it("cannot hide failed model audits behind correct allowlist audits", async () => {
    const ledger = new MemoryLedger();
    const answered = rows.find((r) => r.strategy === "single" && r.soft === "act");
    if (!answered?.policyHash) throw new Error("Missing evidence identity");
    const live = new Engine({ oracle, ledger });
    const rollout = new Rollout({
      engine: live,
      evidence: {
        version: "boundary-v1",
        questionHash: answered.questionHash,
        policyHash: answered.policyHash,
      },
      // A one-act plan at 90%, weak by design, so one correct act promotes.
      promisedAccuracy: 0.9,
      confidence: 0.1,
      minAuditRows: 1,
    });
    await rollout.evaluate();
    // Establish an actual enforce phase before testing the contaminated audit window.
    await ledger.append({
      ...answered,
      id: "promotion-anchor",
      outcome: { at: answered.at, correct: true, truth: true },
    });
    expect((await rollout.evaluate()).mode).toBe("enforce");
    for (const row of rows)
      await ledger.append({ ...row, mode: "enforce", tags: [...row.tags, "audit"] });
    expect(await rollout.evaluate()).toMatchObject({
      mode: "shadow",
      changed: true,
      audits: { n: 1, acted: 1, accuracy: 0 },
    });
  });
});

describe("threshold fitting cannot discard sufficient negative shadow evidence", () => {
  async function mixedHistory(shadowRows: number) {
    const mixed = new Engine({ oracle, mode: "shadow" });
    const gate = mixed.gate({
      id: "mixed-labels",
      question: judge("Appropriate?", { id: "mixed" }),
      policy: { actAbove: 0.8 },
    });
    for (let i = 0; i < 100; i++) {
      mixed.mode = i < shadowRows ? "shadow" : "enforce";
      const result = await gate.ask(`item-${i}`);
      await mixed.label(result.recordId, { correct: i >= shadowRows, truth: i >= shadowRows });
    }
    return mixed;
  }

  it("does not fit on selected successes when enough shadow labels reject every bar", async () => {
    const mixed = await mixedHistory(10);
    const api = (await mixed.report({ targetAccuracy: 0.9, minSupport: 10 })).byGate[
      "mixed-labels"
    ];
    const cli = buildReport("fixture", await mixed.ledger.all(), { target: 0.9, minSupport: 10 })
      .gates[0];
    expect(api?.unselected).toBe(10);
    expect(api?.fitted).toBeUndefined();
    expect(cli?.fitted).toBeUndefined();
    expect(cli?.fittedFrom).toBe("unselected");
  });

  it("still labels the fallback when unselected evidence is below minimum support", async () => {
    const mixed = await mixedHistory(9);
    const api = (await mixed.report({ targetAccuracy: 0.9, minSupport: 10 })).byGate[
      "mixed-labels"
    ];
    expect(api?.fitted?.n).toBe(100);
    expect(api?.fittedFrom).toBe("all");
  });
});
