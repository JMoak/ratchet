import { describe, expect, it } from "vitest";
import { resolvePlan } from "../src/acceptance.ts";
import { Engine } from "../src/engine.ts";
import { type EvidenceGrade, gradeOf, type MeasuredGrade } from "../src/ledger/evidence.ts";
import { hashQuestion } from "../src/ledger/ledger.ts";
import { hashPolicy } from "../src/policy.ts";
import { judge } from "../src/questions.ts";
import { Rollout } from "../src/rollout.ts";
import type { Oracle } from "../src/types.ts";

const at = "2026-10-30T00:00:00.000Z";

/** Always right and sure of it: pYes 0.97 when the state's number is even, 0.03 when odd. */
const believer: Oracle = {
  id: "believer",
  decide: async (state, questions) =>
    questions.map((q) => ({
      verdict: {
        kind: "judge" as const,
        questionId: q.id,
        pYes: Number(state.slice(2)) % 2 === 0 ? 0.97 : 0.03,
        confidence: 0.97,
      },
      oracle: "believer",
      model: "believer-v1",
      cost: 0,
      latencyMs: 0,
      at: new Date().toISOString(),
    })),
};

describe("Rollout promotes on a measured grade and nothing else", () => {
  // The parameter of the controller's one way into enforce, read off the private method's type.
  type PromotesOn = Parameters<Rollout["promote"]>[0];

  it("is a compile error to promote on any other grade", () => {
    const sources = { blind: 0, census: 0, moment: 0, unknown: 29 };
    const measured: MeasuredGrade = {
      kind: "measured",
      plan: resolvePlan({ target: 0.9 }),
      lowerBound: 0.9019,
      errors: 0,
      sampleSize: 29,
      sources,
      at,
    };
    const estimated = {
      kind: "estimated",
      accuracy: 1,
      lower: 0.91,
      upper: 1,
      n: 40,
      confidence: 0.95,
      sources,
      at,
    } as const;
    const via = { type: "disagreement", rate: 0.25, pairs: 40, models: ["a", "b"] } as const;
    const borrowed = { kind: "borrowed", via, at } as const;
    const unnarrowed: EvidenceGrade = gradeOf([]);
    const accepted: PromotesOn = measured;
    // @ts-expect-error an estimated grade does not promote
    const fromEstimate: PromotesOn = estimated;
    // @ts-expect-error nor does borrowed evidence
    const fromBorrowed: PromotesOn = borrowed;
    // @ts-expect-error nor any grade not narrowed to measured
    const fromAny: PromotesOn = unnarrowed;
    expect([accepted, fromEstimate, fromBorrowed, fromAny].map((g) => g.kind)).toEqual([
      "measured",
      "estimated",
      "borrowed",
      "none",
    ]);
  });

  it("holds shadow on an estimated grade, however good, and promotes once measured", async () => {
    const engine = new Engine({ oracle: believer, mode: "shadow", seed: 1 });
    const q = judge("ok?", { id: "ok" });
    const policy = { actAbove: 0.9 };
    const rollout = new Rollout({
      engine,
      evidence: {
        version: "grade-v1",
        policyHash: hashPolicy(policy),
        questionHash: hashQuestion(q),
      },
      promisedAccuracy: 0.9,
    });
    expect((await rollout.evaluate()).grade).toMatchObject({ kind: "none", unselected: 0 });
    const planned: string[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await engine.ask(`s-${i}`, q, { policy, evidenceVersion: "grade-v1" });
      // Only the held rows are labelled: the planned acts wait, and the estimate is perfect.
      if (r.ruling.action === "act") planned.push(r.recordId);
      else await engine.label(r.recordId, { correct: true, truth: false, at });
    }
    const holding = await rollout.evaluate();
    expect(holding).toMatchObject({
      mode: "shadow",
      changed: false,
      acceptance: { status: "awaiting-labels", unlabelled: 29 },
      grade: { kind: "estimated", accuracy: 1, n: 30, at },
    });
    // A caller that casts its way past the type is refused at run time.
    const unchecked = rollout as unknown as { promote(grade: EvidenceGrade): unknown };
    expect(() => unchecked.promote(holding.grade)).toThrow(/only a measured grade promotes/);
    expect(engine.mode).toBe("shadow");

    // The planned acts are labelled later: that label, not the evaluation, dates the grade.
    const completed = "2026-11-02T00:00:00.000Z";
    for (const id of planned) await engine.label(id, { correct: true, truth: true, at: completed });
    const promoted = await rollout.evaluate();
    expect(promoted).toMatchObject({
      mode: "enforce",
      changed: true,
      grade: { kind: "measured", errors: 0, sampleSize: 29, at: completed },
    });
    expect(promoted.reason).toMatch(/^promoted: 0 wrong of 29 planned acts/);
    expect(Object.keys(rollout.checkpoint() ?? {}).sort()).toEqual([
      "afterId",
      "format",
      "mode",
      "rejected",
      "scopeHash",
    ]);
    // The enforce phase starts empty: its audits are what can grade it now.
    expect((await rollout.evaluate()).grade.kind).toBe("none");
  });
});
