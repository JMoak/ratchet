/**
 * Two keys to act (Foundations review 2026-11): `concur` is the existing ensemble pooled by its
 * most cautious member, so either member can hold and acting needs every member. These tests
 * run it through a real engine and gate with deterministic members, to show the existing
 * ensemble path keeps the contract `concur`'s doc comment states.
 */
import { describe, expect, it } from "vitest";
import { pool } from "../src/compound/aggregate.ts";
import { concur } from "../src/compound/concur.ts";
import type { Member } from "../src/compound/ensemble.ts";
import { Engine, type StrategySpec } from "../src/engine.ts";
import type { DecisionRecord } from "../src/ledger/ledger.ts";
import type { GatePolicy } from "../src/policy.ts";
import { judge, judgeVerdictFrom, pick, pickVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, JudgeVerdict, Oracle } from "../src/types.ts";

/** A member that answers every judge question with one fixed p(yes). */
function fixed(id: string, pYes: number, model: string): Oracle {
  return {
    id,
    decide: async (_state, qs) =>
      qs.map((q) => ({
        verdict: judgeVerdictFrom(q as JudgeQuestion, pYes),
        oracle: id,
        model,
        latencyMs: 1,
        cost: 0.001,
        at: "2026-11-12T00:00:00.000Z",
      })),
  };
}

/** Two models of different families, as the second key should be. */
const keys = (first: number, second: number): Member[] => [
  { oracle: fixed("jev", first, "typesafe/jev-1.13"), label: "jev" },
  { oracle: fixed("haiku", second, "claude-haiku-5.5"), label: "haiku" },
];

const safe = judge("Is this deploy safe to run without asking?", { id: "deploy.safe" });
const risky = judge("Does this deploy need a human?", { id: "deploy.risky" });

async function askOnce(members: Member[], policy: GatePolicy, question = safe) {
  const engine = new Engine({ oracle: fixed("default", 0.5, "unused"), mode: "enforce" });
  const gate = engine.gate({
    id: "deploy.gate",
    question,
    policy,
    strategy: concur(members, policy),
  });
  const r = await gate.ask("deploy api@v2 to production");
  return { r, rows: await engine.ledger.all() };
}

describe("concur: either member can hold, acting needs every member", () => {
  const yesIsGo: GatePolicy = { actAbove: 0.9 };

  it("rules on the less sure member when yes means go", async () => {
    const { r } = await askOnce(keys(0.97, 0.6), yesIsGo);
    expect(r.decision.strategy).toBe("ensemble");
    expect(r.decision.verdict.pYes).toBe(0.6);
    expect(r.ruling.go).toBe(0.6);
    expect(r.ruling.action).toBe("review");
    expect(r.action).toBe("review");
    // Either order: the hold does not depend on which key is first.
    expect((await askOnce(keys(0.6, 0.97), yesIsGo)).r.ruling.go).toBe(0.6);
  });

  it("acts when both members clear the bar", async () => {
    const { r } = await askOnce(keys(0.97, 0.97), yesIsGo);
    expect(r.ruling.go).toBe(0.97);
    expect(r.action).toBe("act");
  });

  it("takes the largest p(yes) when no means go, read from the gate's own policy", async () => {
    const noIsGo: GatePolicy = { actAbove: 0.9, goIsYes: false };
    expect(concur(keys(0.03, 0.4), noIsGo).ensemble.method).toBe("max");
    expect(concur(keys(0.03, 0.4), yesIsGo).ensemble.method).toBe("min");
    const held = await askOnce(keys(0.03, 0.4), noIsGo, risky);
    expect(held.r.decision.verdict.pYes).toBe(0.4);
    expect(held.r.ruling.go).toBeCloseTo(0.6, 12);
    expect(held.r.action).toBe("review");
    const both = await askOnce(keys(0.03, 0.03), noIsGo, risky);
    expect(both.r.ruling.go).toBeCloseTo(0.97, 12);
    expect(both.r.action).toBe("act");
  });

  it("a member that fails open makes the request review, failed open, whatever the other said", async () => {
    const down: Oracle = { id: "haiku", decide: async () => Promise.reject(new Error("503")) };
    const members: Member[] = [
      { oracle: fixed("jev", 0.99, "typesafe/jev-1.13"), label: "jev" },
      { oracle: down, label: "haiku" },
    ];
    const { r, rows } = await askOnce(members, yesIsGo);
    expect(r.decision.failedOpen).toBe(true);
    expect(r.decision.error).toMatch(/1 of 2 members answered; minMembers is 2: .*503/);
    expect(r.decision.verdict.pYes).toBe(0.5);
    expect(r.action).toBe("review");
    expect(rows[0]?.failedOpen).toBe(true);
    expect(rows[0]?.action).toBe("review");
  });

  it("records both members' answers on the ledger row", async () => {
    const { r, rows } = await askOnce(keys(0.97, 0.6), yesIsGo);
    expect(rows).toHaveLength(1);
    const row = rows[0] as DecisionRecord;
    expect(row).toMatchObject({ id: r.recordId, strategy: "ensemble", gateId: "deploy.gate" });
    const members = row.members ?? [];
    expect(
      Object.fromEntries(members.map((m) => [m.key, (m.verdict as JudgeVerdict).pYes])),
    ).toEqual({ jev: 0.97, haiku: 0.6 });
    expect(members.map((m) => m.model)).toEqual(["typesafe/jev-1.13", "claude-haiku-5.5"]);
    expect(row.detail).toMatchObject({ pooled: 2, dropped: 0 });
    expect((row.verdict as JudgeVerdict).pYes).toBe(0.6);
    expect(row.cost).toBeCloseTo(0.002, 12);
  });
});

describe("concur's shape", () => {
  it("needs at least two members", () => {
    expect(() => concur([], { goIsYes: true })).toThrow(/at least two members, not 0/);
    expect(() => concur(keys(0.9, 0.9).slice(0, 1), { goIsYes: true })).toThrow(
      /at least two members, not 1/,
    );
  });

  it("is a StrategySpec, and later edits to the caller's array do not reach it", () => {
    const members = keys(0.97, 0.6);
    const strategy = concur(members, {});
    // Assignable to the engine's type, with no runtime import of the engine in concur.ts.
    const spec: StrategySpec = strategy;
    expect(spec).toEqual({ ensemble: { members, method: "min" } });
    expect(strategy.ensemble.members).not.toBe(members);
    members.pop();
    expect(strategy.ensemble.members).toHaveLength(2);
  });

  it("is offered for judge questions only: on a pick, min is not any member's hold", () => {
    // The doc comment's example: the elementwise minimum, renormalised, is a confident answer
    // for the option the first member leaned against.
    const route = pick("Which queue?", ["x", "y"], { id: "route" });
    const answers = [pickVerdictFrom(route, [0.6, 0.4]), pickVerdictFrom(route, [0.1, 0.9])];
    const pooled = pool(route, answers, { method: "min" });
    expect(pooled.kind === "pick" && pooled.choice).toBe("y");
    expect(pooled.confidence).toBeCloseTo(0.8, 12);
  });
});
