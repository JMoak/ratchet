import { describe, expect, it } from "vitest";
import {
  acceptanceSample,
  evaluateAcceptance,
  exactLowerBound,
  requiredActs,
  resolvePlan,
} from "../src/acceptance.ts";
import type { DecisionRecord, Outcome } from "../src/ledger/ledger.ts";
import { binomialTail } from "../src/math.ts";
import type { Action } from "../src/types.ts";

interface RowOptions {
  readonly id: string;
  readonly state?: string;
  readonly soft?: Action;
  readonly truth?: boolean;
  readonly tags?: readonly string[];
  readonly failedOpen?: boolean;
  readonly strategy?: string;
}

function row(o: RowOptions): DecisionRecord {
  const outcome: Outcome | undefined =
    o.truth === undefined ? undefined : { at: "t", correct: o.truth, truth: o.truth };
  return {
    id: o.id,
    at: "2026-10-21T00:00:00.000Z",
    gateId: "g",
    requestId: o.id,
    questionId: "q",
    kind: "judge",
    prompt: "ok?",
    questionHash: "0123456789abcdef",
    stateHash: o.state ?? o.id,
    trustedHash: o.state ?? o.id,
    untrusted: [],
    oracle: "o",
    strategy: o.strategy ?? "single",
    verdict: { kind: "judge", questionId: "q", pYes: 0.97, confidence: 0.97 },
    go: 0.97,
    confidence: 0.97,
    agreement: 1,
    soft: o.soft ?? "act",
    action: "review",
    mode: "shadow",
    cost: 0,
    latencyMs: 0,
    failedOpen: o.failedOpen ?? false,
    tags: o.tags ?? [],
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

const acts = (n: number, truth: (i: number) => boolean | undefined = () => true) =>
  Array.from({ length: n }, (_, i) => {
    const t = truth(i);
    return row({ id: `a${i}`, ...(t !== undefined ? { truth: t } : {}) });
  });

describe("exactLowerBound", () => {
  it("is (1 - confidence)^(1/n) when every trial succeeded", () => {
    expect(exactLowerBound(149, 149)).toBeCloseTo(0.05 ** (1 / 149), 12);
    expect(exactLowerBound(149, 149)).toBeGreaterThanOrEqual(0.98);
    expect(exactLowerBound(148, 148)).toBeLessThan(0.98);
  });

  it("bounds 20 of 20 near 86%, which is why a 20-act point estimate cannot promise 98%", () => {
    expect(exactLowerBound(20, 20)).toBeCloseTo(0.8609, 3);
  });

  it("solves the defining tail equation when some trials failed", () => {
    for (const [s, n] of [
      [45, 50],
      [190, 200],
      [3, 10],
    ] as const) {
      const lower = exactLowerBound(s, n, 0.95);
      expect(binomialTail(n, s, lower)).toBeCloseTo(0.05, 6);
    }
  });

  it("is zero with no successes and rises with successes and with trials", () => {
    expect(exactLowerBound(0, 10)).toBe(0);
    expect(exactLowerBound(9, 10)).toBeLessThan(exactLowerBound(10, 10));
    expect(exactLowerBound(98, 100)).toBeLessThan(exactLowerBound(196, 200));
  });

  it("refuses impossible counts and confidences", () => {
    expect(() => exactLowerBound(5, 4)).toThrow();
    expect(() => exactLowerBound(-1, 4)).toThrow();
    expect(() => exactLowerBound(1, 4, 1)).toThrow();
  });
});

describe("requiredActs", () => {
  it("matches the zero-error sample sizes the roadmap quotes", () => {
    expect(requiredActs(0.98)).toBe(149);
    expect(requiredActs(0.95)).toBe(59);
    expect(requiredActs(0.99)).toBe(299);
  });

  it("grows the sample to pay for each error the plan allows", () => {
    const n = requiredActs(0.98, 0.95, 1);
    expect(n).toBeGreaterThan(149);
    expect(exactLowerBound(n - 1, n)).toBeGreaterThanOrEqual(0.98);
    expect(exactLowerBound(n - 2, n - 1)).toBeLessThan(0.98);
  });

  it("refuses a target of 1, which no finite sample can prove", () => {
    expect(() => requiredActs(1)).toThrow();
  });
});

describe("resolvePlan", () => {
  it("fills defaults, fixes the sample size and names the plan", () => {
    const plan = resolvePlan({ target: 0.98 });
    expect(plan).toMatchObject({ target: 0.98, confidence: 0.95, maxErrors: 0, sampleSize: 149 });
    expect(plan.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(resolvePlan({ target: 0.98, maxErrors: 1 }).hash).not.toBe(plan.hash);
  });

  it("refuses a malformed group", () => {
    expect(() => resolvePlan({ target: 0.9, group: { tagPrefix: "", maxPerGroup: 2 } })).toThrow();
    expect(() =>
      resolvePlan({ target: 0.9, group: { tagPrefix: "session:", maxPerGroup: 0 } }),
    ).toThrow();
  });
});

describe("acceptanceSample", () => {
  const plan = resolvePlan({ target: 0.5 });

  it("takes the first acts in ledger order and nothing else", () => {
    const rows = [
      row({ id: "review", soft: "review", truth: true }),
      row({ id: "failed", failedOpen: true, truth: true }),
      row({ id: "floored", strategy: "floored", truth: true }),
      row({ id: "first", truth: false }),
      row({ id: "second" }),
      row({ id: "third", truth: true }),
      row({ id: "fourth", truth: true }),
      row({ id: "fifth", truth: true }),
      row({ id: "sixth", truth: true }),
    ];
    expect(acceptanceSample(rows, plan).map((r) => r.id)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
    ]);
  });

  it("chooses the same acts whether or not their labels have arrived", () => {
    const labelled = acts(8, (i) => i % 3 !== 0);
    const unlabelled = acts(8, () => undefined);
    expect(acceptanceSample(labelled, plan).map((r) => r.id)).toEqual(
      acceptanceSample(unlabelled, plan).map((r) => r.id),
    );
  });

  it("counts a retried state once", () => {
    const rows = [
      row({ id: "x1", state: "same" }),
      row({ id: "x2", state: "same" }),
      row({ id: "y", state: "other" }),
    ];
    expect(acceptanceSample(rows, resolvePlan({ target: 0.2 })).map((r) => r.id)).toEqual([
      "x1",
      "y",
    ]);
  });

  it("caps how many acts one group contributes", () => {
    const grouped = resolvePlan({ target: 0.5, group: { tagPrefix: "session:", maxPerGroup: 2 } });
    const rows = [
      row({ id: "a1", tags: ["session:a"] }),
      row({ id: "a2", tags: ["session:a"] }),
      row({ id: "a3", tags: ["session:a"] }),
      row({ id: "b1", tags: ["session:b"] }),
      row({ id: "loose" }),
      row({ id: "b2", tags: ["session:b"] }),
      row({ id: "c1", tags: ["session:c"] }),
    ];
    expect(acceptanceSample(rows, grouped).map((r) => r.id)).toEqual([
      "a1",
      "a2",
      "b1",
      "loose",
      "b2",
    ]);
  });
});

describe("evaluateAcceptance", () => {
  const plan = { target: 0.98 } as const;

  it("reports only progress while collecting, never the labels so far", () => {
    const result = evaluateAcceptance(
      acts(100, (i) => i !== 3),
      plan,
    );
    expect(result).toEqual({ status: "collecting", plan: resolvePlan(plan), acts: 100 });
  });

  it("stays sealed until every act in the sample is labelled", () => {
    const result = evaluateAcceptance(
      acts(149, (i) => (i === 7 ? undefined : true)),
      plan,
    );
    expect(result.status).toBe("awaiting-labels");
    expect(result).not.toHaveProperty("errors");
    expect(result.status === "awaiting-labels" && result.unlabelled).toBe(1);
  });

  it("accepts 149 correct acts at 98% and rejects one wrong act", () => {
    const accepted = evaluateAcceptance(acts(149), plan);
    expect(accepted).toMatchObject({ status: "accepted", errors: 0 });
    expect(accepted.status === "accepted" && accepted.lowerBound).toBeGreaterThanOrEqual(0.98);
    expect(
      evaluateAcceptance(
        acts(149, (i) => i !== 100),
        plan,
      ),
    ).toMatchObject({
      status: "rejected",
      errors: 1,
    });
  });

  it("evaluates exactly the planned sample, ignoring acts after it", () => {
    const rows = [...acts(149), row({ id: "late", truth: false })];
    const result = evaluateAcceptance(rows, plan);
    expect(result.status).toBe("accepted");
    expect(result.status === "accepted" && result.sample).not.toContain("late");
  });

  it("lets a plan that allows an error pass with one, on its larger sample", () => {
    const allowing = resolvePlan({ target: 0.98, maxErrors: 1 });
    const result = evaluateAcceptance(
      acts(allowing.sampleSize, (i) => i !== 0),
      allowing,
    );
    expect(result).toMatchObject({ status: "accepted", errors: 1 });
  });

  it("counts an act whose label cannot be read as wrong", () => {
    const rows = acts(59);
    const unreadable: DecisionRecord = {
      ...(rows[0] as DecisionRecord),
      verdict: { kind: "judge", questionId: "q", pYes: 0.5, confidence: 0.5 },
      go: 0.5,
    };
    expect(evaluateAcceptance([unreadable, ...rows.slice(1)], { target: 0.95 })).toMatchObject({
      status: "rejected",
      errors: 1,
    });
  });
});
