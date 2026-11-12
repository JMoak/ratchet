/**
 * Wave 2, package A: review bands near certainty, hard rules that cannot be read, and scripted
 * rules with global patterns.
 *
 * T1-05 / T3-08: `policyWithBand` (and so `policyFromProfile`) added the half-width in
 * probability and capped at 1, so any bar of 1 - halfWidth or more became "act above 1", which
 * acts on nothing (a pooled battery's bars sit at 0.99999991). Below the knee every policy, and
 * its hash, is unchanged.
 * T4-13: a floor that returned a non-Action was ignored (the oracle's 0.99 acted on a dangerous
 * state), and one that threw aborted the ask with no ledger row.
 * T4-11: a `RuleOracle` rule with a `/g` pattern alternated between matching and not.
 */
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import { bypassFor, evaluateFloors, type FloorRule, floorFor, refuseIf } from "../src/floors.ts";
import type { DecisionRecord } from "../src/ledger/ledger.ts";
import { buildProfile, type CalibrationProfile } from "../src/ledger/profile.ts";
import { round } from "../src/math.ts";
import { judgeIf, RuleOracle } from "../src/oracles/rules.ts";
import { hashPolicy, policyFromProfile, policyWithBand } from "../src/policy.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

/** The formula every existing banded policy was built with. */
const oldBand = (bar: number, w: number, refuse = false) => ({
  actAbove: Math.min(1, round(bar + w, 6)),
  ...(refuse ? { refuseBelow: Math.max(0, round(bar - w, 6)) } : {}),
});

const grid = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => round(from + i * step, 9));

describe("T1-05 / T3-08: a high bar never becomes 'act above 1'", () => {
  it("keeps every policy below the knee exactly as it was, hash included", () => {
    for (const w of [0, 0.02, 0.05, 0.1, 0.2]) {
      for (const bar of grid(0, 1 - 2 * w, 0.005)) {
        const now = policyWithBand(bar, w, { refuse: bar >= 2 * w });
        const was = oldBand(bar, w, bar >= 2 * w);
        expect(now, `bar ${bar} w ${w}`).toEqual(was);
        expect(hashPolicy(now)).toBe(hashPolicy(was));
      }
    }
    expect(policyWithBand(0.9, 0.05)).toEqual({ actAbove: 0.95 });
    expect(policyWithBand(0.8, 0.1, { refuse: true, goIsYes: false })).toEqual({
      actAbove: 0.9,
      refuseBelow: 0.7,
      goIsYes: false,
    });
  });

  it("puts the act bar above the bar and below 1 for every bar short of 1", () => {
    for (const w of [0.05, 0.1]) {
      for (const bar of [...grid(0.9, 0.999, 0.001), 0.9999, 0.99999991, 1 - 1e-12]) {
        const { actAbove } = policyWithBand(bar, w);
        expect(actAbove, `bar ${bar} w ${w}`).toBeGreaterThan(bar);
        expect(actAbove, `bar ${bar} w ${w}`).toBeLessThan(1);
      }
    }
    expect(policyWithBand(1, 0.05).actAbove).toBe(1);
    expect(policyWithBand(0.95, 0.05).actAbove).toBe(0.9756757);
    expect(policyWithBand(0.95, 0.1).actAbove).toBe(0.9771429);
    expect(policyWithBand(0.9999, 0.05).actAbove).toBe(0.9999526291);
  });

  it("rises with the bar and meets bar + halfWidth at the knee", () => {
    for (const w of [0.01, 0.05, 0.1, 0.25]) {
      const bars = grid(0, 0.9999, 0.0001);
      const edges = bars.map((b) => policyWithBand(b, w).actAbove);
      for (let i = 1; i < edges.length; i++) {
        expect(edges[i] as number, `w ${w} at ${bars[i]}`).toBeGreaterThanOrEqual(
          edges[i - 1] as number,
        );
        // No jump anywhere: neighbouring bars give neighbouring edges.
        expect((edges[i] as number) - (edges[i - 1] as number)).toBeLessThan(2e-4);
      }
      const knee = 1 - 2 * w;
      expect(policyWithBand(knee + 1e-9, w).actAbove).toBeCloseTo(1 - w, 6);
    }
  });

  it("mirrors the refuse edge near 0: above 0, below the bar", () => {
    for (const bar of grid(0.001, 0.099, 0.001)) {
      const { refuseBelow } = policyWithBand(bar, 0.05, { refuse: true });
      expect(refuseBelow, `bar ${bar}`).toBeGreaterThan(0);
      expect(refuseBelow, `bar ${bar}`).toBeLessThan(bar);
    }
    expect(policyWithBand(0, 0.05, { refuse: true }).refuseBelow).toBe(0);
    expect(policyWithBand(0.1, 0.05, { refuse: true }).refuseBelow).toBe(0.05);
  });

  it("refuses a bar that is not a probability and a half-width outside [0, 0.5)", () => {
    for (const bar of [Number.NaN, -0.1, 1.1, Number.POSITIVE_INFINITY]) {
      expect(() => policyWithBand(bar, 0.05)).toThrow(/bar/);
    }
    for (const w of [Number.NaN, -0.01, 0.5, 1]) {
      expect(() => policyWithBand(0.5, w)).toThrow(/halfWidth/);
    }
  });

  it("policyFromProfile at a borrowed bar of 0.97 acts below 1", () => {
    let id = 0;
    const row = (confidence: number, right: boolean): DecisionRecord => {
      const rid = `r${id++}`;
      return {
        id: rid,
        at: "2026-10-20T00:00:00.000Z",
        gateId: "g",
        requestId: rid,
        questionId: "q",
        kind: "judge",
        prompt: "ok?",
        questionHash: "0123456789abcdef",
        stateHash: rid,
        trustedHash: rid,
        untrusted: [],
        oracle: "o",
        model: "m-1",
        strategy: "single",
        verdict: { kind: "judge", questionId: "q", pYes: confidence, confidence },
        go: confidence,
        confidence,
        agreement: 1,
        soft: "review",
        action: "review",
        mode: "shadow",
        cost: 0,
        latencyMs: 0,
        failedOpen: false,
        tags: [],
        outcome: { at: "2026-10-20T00:00:00.000Z", correct: right, truth: right },
      };
    };
    // 40 of 40 right at 0.97 keeps a 90% promise by a Wilson bound; 30 of 40 at 0.9 does not.
    const rows = [
      ...Array.from({ length: 40 }, () => row(0.97, true)),
      ...Array.from({ length: 40 }, (_, i) => row(0.9, i < 30)),
    ];
    const p = buildProfile(
      rows,
      { model: "m-1", kind: "judge" },
      {
        ledgers: ["l.jsonl"],
        targets: [0.9],
      },
    ) as CalibrationProfile;
    expect(p.bars).toEqual([{ target: 0.9, bar: 0.97, support: 40 }]);
    const policy = policyFromProfile(p, 0.9);
    expect(policy.actAbove).toBeGreaterThan(0.97);
    expect(policy.actAbove).toBeLessThan(1);
    expect(policy).toEqual(policyWithBand(0.97, 0.05));
  });
});

describe("T4-13: a floor that cannot be read fails closed to review", () => {
  const q = judge("Is it safe to run without asking?", { id: "safe" });
  const DANGER = "command: git push --force origin main";
  const sure: Oracle = {
    id: "sure",
    decide: async (_s, qs) =>
      qs.map((qq) => ({
        verdict: judgeVerdictFrom(qq as JudgeQuestion, 0.99),
        oracle: "sure",
        latencyMs: 0,
        cost: 0,
        at: "now",
      })),
  };
  const typo = ((s: string) =>
    /push --force/.test(s) ? "deny" : undefined) as unknown as FloorRule;
  const boom: FloorRule = (s) => {
    if (s.includes("{")) JSON.parse(s);
    return undefined;
  };

  it("evaluateFloors reads a non-Action or a throw as review, and says why", () => {
    const typoed = evaluateFloors([typo], DANGER, q);
    expect(typoed.floor).toBe("review");
    expect(typoed.errors).toEqual(['floor 1 returned "deny", not an action']);
    const thrown = evaluateFloors([refuseIf(/never/), boom], `${DANGER} {not json`, q);
    expect(thrown.floor).toBe("review");
    expect(thrown.errors[0]).toMatch(/^floor 2 threw: /);
    expect(floorFor([boom], "{", q)).toBe("review");
  });

  it("silence (undefined, null, false) imposes nothing, and a refuse still wins", () => {
    const silent = [() => undefined, () => null, () => false] as unknown as FloorRule[];
    expect(evaluateFloors(silent, DANGER, q)).toEqual({ floor: "act", errors: [] });
    const both = evaluateFloors([typo, refuseIf(/push/)], DANGER, q);
    expect(both.floor).toBe("refuse");
    expect(both.errors).toHaveLength(1);
  });

  it("through the engine: the typo'd floor holds the 0.99 at review", async () => {
    const e = new Engine({ oracle: sure, mode: "enforce", floors: [typo] });
    const r = await e.gate({ id: "g", question: q, policy: { actAbove: 0.9 } }).ask(DANGER);
    expect(r.action).toBe("review");
  });

  it("through the engine: a throwing floor neither throws nor skips the ledger", async () => {
    const e = new Engine({ oracle: sure, mode: "enforce", floors: [boom] });
    const r = await e.gate({ id: "g", question: q, policy: { actAbove: 0.9 } }).ask(`${DANGER}\n{`);
    expect(r.action).toBe("review");
    expect(await e.ledger.all()).toHaveLength(1);
  });

  it("a bypass that throws grants nothing", () => {
    const bad = () => {
      throw new Error("bad bypass");
    };
    expect(bypassFor([bad], DANGER, q)).toBe(false);
    expect(bypassFor([bad, () => true], DANGER, q)).toBe(true);
  });
});

describe("T4-11: scripted rules answer the same state the same way every time", () => {
  const q = judge("Is it safe?", { id: "safe" });
  it("a /g pattern does not alternate between a match and a miss", async () => {
    const pattern = /push --force/g;
    const o = new RuleOracle([judgeIf(pattern, 0.01), judgeIf(/./, 0.99)]);
    const answers: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [d] = await o.decide("git push --force", [q]);
      answers.push(d?.verdict.kind === "judge" ? d.verdict.pYes : Number.NaN);
    }
    expect(answers).toEqual([0.01, 0.01, 0.01, 0.01]);
    expect(pattern.lastIndex).toBe(0);
  });
  it("through the engine the dangerous state is never acted on", async () => {
    const o = new RuleOracle([judgeIf(/push --force/g, 0.01), judgeIf(/./, 0.99)]);
    const e = new Engine({ oracle: o, mode: "enforce" });
    const g = e.gate({ id: "g", question: q, policy: { actAbove: 0.9 } });
    const actions = [
      (await g.ask("git push --force")).action,
      (await g.ask("git push --force")).action,
    ];
    expect(actions).toEqual(["review", "review"]);
  });
  it("judgeIf refuses a pYes outside [0, 1] when the rule is built", () => {
    for (const p of [1.2, -0.1, Number.NaN]) expect(() => judgeIf(/x/, p)).toThrow(/pYes/);
    expect(() => judgeIf(/x/, 1)).not.toThrow();
  });
});
