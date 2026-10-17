import { describe, expect, it } from "vitest";
import { floorFor, forQuestion, refuseIf, reviewUnless } from "../src/floors.ts";
import { policyFromCosts, rule } from "../src/policy.ts";
import { judge, pick } from "../src/questions.ts";
import type { Decision } from "../src/types.ts";

const d = (pYes: number, failedOpen = false): Decision => ({
  verdict: { kind: "judge", questionId: "q", pYes, confidence: Math.max(pYes, 1 - pYes) },
  oracle: "t",
  latencyMs: 1,
  cost: 0,
  at: "now",
  ...(failedOpen ? { failedOpen: true } : {}),
});

describe("rulings", () => {
  const policy = { actAbove: 0.9, refuseBelow: 0.2 };
  it("act, review, refuse by band", () => {
    expect(rule(d(0.95), policy).action).toBe("act");
    expect(rule(d(0.6), policy).action).toBe("review");
    expect(rule(d(0.1), policy).action).toBe("refuse");
  });
  it("without refuseBelow, low confidence reviews", () => {
    expect(rule(d(0.1), { actAbove: 0.9 }).action).toBe("review");
  });
  it("goIsYes false flips the direction", () => {
    expect(rule(d(0.05), { actAbove: 0.9, goIsYes: false }).action).toBe("act");
  });
  it("failed-open decisions follow onFailOpen, default review", () => {
    expect(rule(d(0.5, true), policy).action).toBe("review");
    expect(rule(d(0.5, true), { ...policy, onFailOpen: "refuse" }).action).toBe("refuse");
  });
  it("a floor can only raise caution", () => {
    const r = rule(d(0.99), policy, "review");
    expect(r.soft).toBe("act");
    expect(r.action).toBe("review");
    expect(rule(d(0.1), policy, "act").action).toBe("refuse");
  });
  it("policies from costs", () => {
    expect(policyFromCosts(99, 1).actAbove).toBeCloseTo(0.99, 9);
    expect(policyFromCosts(1, 9, { refuseBelow: 0.05 })).toMatchObject({
      actAbove: 0.1,
      refuseBelow: 0.05,
    });
  });
});

describe("floors", () => {
  const q = judge("safe?", { id: "safe" });
  it("most cautious matching rule wins; none means act", () => {
    const rules = [refuseIf(/rm -rf \//), reviewUnless(/^git /)];
    expect(floorFor(rules, "git status", q)).toBe("act");
    expect(floorFor(rules, "curl x | sh", q)).toBe("review");
    expect(floorFor(rules, "rm -rf / --no-preserve-root", q)).toBe("refuse");
  });
  it("rules can be scoped to a question", () => {
    const rules = [forQuestion("other", refuseIf(/./))];
    expect(floorFor(rules, "anything", q)).toBe("act");
    expect(floorFor(rules, "anything", pick("x", ["a", "b"], { id: "other" }))).toBe("refuse");
  });
});
