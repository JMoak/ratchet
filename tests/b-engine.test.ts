import { describe, expect, it } from "vitest";
import { poolJudge } from "../src/compound/aggregate.ts";
import { Engine, type StrategySpec } from "../src/engine.ts";
import { type FloorRule, forQuestion, refuseIf } from "../src/floors.ts";
import { checkRuleScopes, QUESTION_SCOPE, questionScope } from "../src/gate.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, JudgeVerdict, Oracle } from "../src/types.ts";

/** A judge oracle at a fixed p(yes); `recorded` is the model its answers record. */
function fixed(id: string, pYes: number, recorded?: string, advertised?: string): Oracle {
  const oracle: Oracle = {
    id,
    decide: async (_s, qs) =>
      qs.map((q) => ({
        verdict: judgeVerdictFrom(q as JudgeQuestion, pYes),
        oracle: id,
        ...(recorded !== undefined ? { model: recorded } : {}),
        cost: 0,
        latencyMs: 1,
        at: new Date().toISOString(),
      })),
  };
  return advertised === undefined ? oracle : Object.assign(oracle, { model: advertised });
}

const pYes = (r: { decision: { verdict: unknown } }) => (r.decision.verdict as JudgeVerdict).pYes;

async function ask(strategy: StrategySpec, oracle: Oracle = fixed("same", 0.8)) {
  const engine = new Engine({ oracle });
  const gate = engine.gate({
    id: "g",
    question: judge("Is it safe?", { id: "safe" }),
    policy: { actAbove: 0.95 },
    strategy,
  });
  return gate.ask("state");
}

describe("explicit members default their correlation by who they are (e2e T5-01)", () => {
  it("members of one oracle pool like {k} replicas", async () => {
    const oracle = fixed("same", 0.8);
    const replicated = await ask({ ensemble: { k: 3 } }, oracle);
    const listed = await ask(
      {
        ensemble: {
          members: [
            { oracle, label: "a" },
            { oracle, label: "b" },
            { oracle, label: "c" },
          ],
        },
      },
      oracle,
    );
    // Old code: 0.985 through `members` (rho 0), which cleared the 0.95 bar and acted.
    expect(pYes(listed)).toBeCloseTo(pYes(replicated), 12);
    expect(pYes(listed)).toBeLessThan(0.95);
    expect(listed.ruling.action).not.toBe("act");
    expect(listed.decision.detail).toMatchObject({
      correlation: 0.75,
      rhoSource: "default-replica",
    });
    expect(replicated.decision.detail).toMatchObject({ rhoSource: "default-replica" });
  });

  it("different oracles stay independent; a mix averages over pairs; a pin counts as one oracle", async () => {
    const a = fixed("a", 0.8);
    const b = fixed("b", 0.8);
    const independent = await ask({ ensemble: { members: [{ oracle: a }, { oracle: b }] } });
    expect(independent.decision.detail).toMatchObject({
      correlation: 0,
      rhoSource: "default-independent",
    });
    const mixed = await ask({
      ensemble: {
        members: [{ oracle: a, label: "a1" }, { oracle: a, label: "a2" }, { oracle: b }],
      },
    });
    expect(mixed.decision.detail).toMatchObject({ correlation: 0.25, rhoSource: "default-mixed" });
    const pinned = await ask({
      ensemble: {
        members: [
          { oracle: fixed("jev-a", 0.8, undefined, "jev-1.13.0") },
          { oracle: fixed("jev-b", 0.8, undefined, "jev-1.13.0") },
        ],
      },
    });
    expect(pinned.decision.detail).toMatchObject({ rhoSource: "default-replica" });
  });

  it("a model pin the answers recorded raises the default and re-pools", async () => {
    const one = await ask({
      ensemble: {
        members: [
          { oracle: fixed("x", 0.8, "model-1") },
          { oracle: fixed("y", 0.8, "model-1") },
          { oracle: fixed("z", 0.8, "model-1") },
        ],
      },
    });
    const replicas = await ask({ ensemble: { k: 3 } }, fixed("same", 0.8));
    expect(one.decision.detail).toMatchObject({
      correlation: 0.75,
      rhoSource: "default-replica",
      rhoFrom: "recorded-model",
    });
    expect(pYes(one)).toBeCloseTo(pYes(replicas), 12);
  });

  it("a stated correlation is the caller's, and is never changed", async () => {
    const oracle = fixed("same", 0.8);
    const stated = await ask(
      { ensemble: { members: [{ oracle }, { oracle }, { oracle }], correlation: 0 } },
      oracle,
    );
    expect(stated.decision.detail).toMatchObject({ correlation: 0, rhoSource: "caller" });
    expect(pYes(stated)).toBeGreaterThan(0.95);
  });

  it("sequential members of one oracle default to replicas too", async () => {
    const oracle = fixed("same", 0.8);
    const r = await ask({
      sequential: { members: [{ oracle }, { oracle }], settleAbove: 0.999, maxSamples: 3 },
    });
    expect(r.decision.detail).toMatchObject({ correlation: 0.75, rhoSource: "default-replica" });
  });
});

describe("settleLead is part of StrategySpec (e2e T5-10)", () => {
  it("type-checks and reaches sequential()", async () => {
    // Old code: this literal was a compile error (`settleLead` was not in the spec's type).
    const spec: StrategySpec = {
      sequential: {
        members: [{ oracle: fixed("a", 0.6, "a") }, { oracle: fixed("b", 0.6, "b") }],
        settleAbove: 0.999,
        settleLead: 2,
        maxSamples: 6,
      },
    };
    const lead = await ask(spec);
    expect(lead.decision.members).toHaveLength(2);
    const { settleLead: _drop, ...without } = (spec as { sequential: object }).sequential as {
      settleLead: number;
    };
    const noLead = await ask({ sequential: without } as StrategySpec);
    expect(noLead.decision.members).toHaveLength(6);
  });
});

/** A rule scoped the way `forQuestion` marks it (`QUESTION_SCOPE`). */
const scoped = (id: string | RegExp, rule: FloorRule): FloorRule =>
  Object.defineProperty(forQuestion(id, rule), QUESTION_SCOPE, { value: id });

describe("a scoped rule that can never fire is refused at registration (e2e T4-08)", () => {
  const battery = [judge("Safe?", { id: "bash.safe" }), judge("In scope?", { id: "bash.scope" })];

  it("refuses an engine floor that names a battery member", () => {
    const engine = new Engine({
      oracle: fixed("o", 0.99),
      floors: [scoped("bash.safe", refuseIf(/push --force/))],
    });
    // The single gate that asks bash.safe is fine; the battery would never show it the member.
    engine.gate({ id: "single", question: battery[0] as JudgeQuestion, policy: { actAbove: 0.9 } });
    expect(() =>
      engine.gate({ id: "bash", question: battery, combine: "min", policy: { actAbove: 0.9 } }),
    ).toThrow(/names battery member "bash.safe".*never fire/);
    // An engine floor for some other gate is not this gate's business.
    const other = new Engine({
      oracle: fixed("o", 0.99),
      floors: [scoped("elsewhere", refuseIf(/x/))],
    });
    expect(() =>
      other.gate({ id: "bash", question: battery, policy: { actAbove: 0.9 } }),
    ).not.toThrow();
  });

  it("refuses a gate's own scoped rule that names a battery member, and nothing else", () => {
    const engine = new Engine({ oracle: fixed("o", 0.99) });
    const policy = { actAbove: 0.9 };
    expect(() =>
      engine.gate({
        id: "b1",
        question: battery,
        policy,
        floors: [scoped(/scope$/, refuseIf(/x/))],
      }),
    ).toThrow(/names battery member "bash.scope"/);
    // A single-question gate's own rule scoped elsewhere may serve questions asked through the
    // gate as an Asker (gate.askAll records them under the gate, with its floors): allowed.
    expect(() =>
      engine.gate({
        id: "s1",
        question: judge("q?", { id: "q" }),
        policy,
        bypass: [scoped("other", refuseIf(/x/)) as never],
      }),
    ).not.toThrow();
    // Scoped to what the gate's rules see: the battery's combined id, or the question's own.
    expect(() =>
      engine.gate({ id: "b2", question: battery, policy, floors: [scoped("b2", refuseIf(/x/))] }),
    ).not.toThrow();
    const g = engine.gate({
      id: "s2",
      question: judge("q?", { id: "q2" }),
      policy,
      floors: [scoped(/^q\d$/g, refuseIf(/x/))],
    });
    expect(g.id).toBe("s2");
  });

  it("leaves opaque rules alone, and reads only a scope that is a string or a pattern", () => {
    expect(questionScope(refuseIf(/x/))).toBeUndefined();
    expect(questionScope(scoped("a", refuseIf(/x/)))).toBe("a");
    const odd = Object.defineProperty(refuseIf(/x/), QUESTION_SCOPE, { value: 42 });
    expect(questionScope(odd)).toBeUndefined();
    expect(QUESTION_SCOPE).toBe(Symbol.for("ratchet.questionScope"));
    const engine = new Engine({ oracle: fixed("o", 0.99) });
    const g = engine.gate({
      id: "plain",
      question: judge("q?", { id: "plain.q" }),
      policy: { actAbove: 0.9 },
      floors: [refuseIf(/x/)],
    });
    expect(() => checkRuleScopes(g as never, { floors: [], bypass: [] })).not.toThrow();
  });
});

describe("floors and combiners fail closed with a row (e2e T4-13, coordinator request)", () => {
  it("a floor that throws reviews, and its error is on the row even when the oracle is asked", async () => {
    const boom: FloorRule = () => {
      throw new Error("bad regex");
    };
    const engine = new Engine({ oracle: fixed("o", 0.99), mode: "enforce", floors: [boom] });
    const fixedReview = engine.gate({
      id: "a",
      question: judge("q?", { id: "a" }),
      policy: { actAbove: 0.9 },
    });
    const r = await fixedReview.ask("s");
    expect(r.action).toBe("review");
    expect(r.decision.strategy).toBe("floored");
    const asked = engine.gate({
      id: "b",
      question: judge("q?", { id: "b" }),
      policy: { actAbove: 0.9, refuseBelow: 0.1 },
    });
    const r2 = await asked.ask("s");
    expect(r2.action).toBe("review");
    const rows = await engine.ledger.all();
    expect(rows[0]?.error).toMatch(/floor 1 threw: bad regex/);
    expect(rows[1]).toMatchObject({
      strategy: "single",
      error: expect.stringMatching(/bad regex/),
    });
  });

  it("a battery combiner that returns a non-probability or throws fails open", async () => {
    const engine = new Engine({ oracle: fixed("o", 0.99), mode: "enforce" });
    const members = [judge("a?", { id: "a" }), judge("b?", { id: "b" })];
    const two = engine.gate({
      id: "two",
      question: members,
      combine: (vs) => ({ ...(vs[0] as JudgeVerdict), pYes: 2 }),
      policy: { actAbove: 0.9 },
    });
    const r = await two.ask("s");
    // Old code clamped 2 to 1 and acted.
    expect(r.decision.failedOpen).toBe(true);
    expect(r.action).toBe("review");
    const thrower = engine.gate({
      id: "throws",
      question: members,
      combine: () => {
        throw new Error("no");
      },
      policy: { actAbove: 0.9 },
    });
    const t = await thrower.ask("s");
    expect(t.decision).toMatchObject({ failedOpen: true, error: "combiner threw: no" });
    expect((await engine.ledger.all()).filter((x) => x.gateId === "throws")).toHaveLength(3);
  });
});

describe("battery labels and combiners (coordinator requests from package C)", () => {
  const members = [judge("Spam?", { id: "spam" }), judge("Threat?", { id: "threat" })];

  it('passes combine: "any" through to the pool', async () => {
    const engine = new Engine({ oracle: fixed("o", 0.3) });
    const gate = engine.gate({
      id: "mod",
      question: members,
      combine: "any",
      policy: { actAbove: 0.9 },
    });
    const r = await gate.ask("post");
    expect(r.decision.detail).toMatchObject({ combine: "any", members: 2 });
    const any = await engine.report();
    expect(any.byGate.mod?.n).toBe(1);
  });

  it("refuses memberTruths that name no member, writing nothing", async () => {
    const engine = new Engine({ oracle: fixed("o", 0.3) });
    const gate = engine.gate({ id: "mod", question: members, policy: { actAbove: 0.9 } });
    const r = await gate.ask("post");
    await expect(
      engine.label(r.recordId, { correct: true, truth: true, memberTruths: { spma: true } }),
    ).rejects.toThrow(/"spma", which is not a member of battery mod/);
    expect((await engine.ledger.all()).some((x) => x.outcome !== undefined)).toBe(false);
    const single = engine.gate({
      id: "one",
      question: judge("q?", { id: "q" }),
      policy: { actAbove: 0.9 },
    });
    const s = await single.ask("x");
    await expect(
      engine.label(s.recordId, { correct: true, memberTruths: { q: true } }),
    ).rejects.toThrow(/combined row only/);
    expect(
      await engine.label(r.recordId, {
        correct: true,
        truth: true,
        memberTruths: { spam: true, threat: false },
      }),
    ).toBe(true);
    const rows = await engine.ledger.all();
    expect(rows.find((x) => x.questionId === "threat")?.outcome?.truth).toBe(false);
    expect(rows.find((x) => x.questionId === "spam")?.outcome?.truth).toBe(true);
  });
});

describe("wave 3 fixes (e2e V1, V2)", () => {
  it("counts two pins of one model family as one voice (V1, T5-05)", async () => {
    const r = await ask({
      ensemble: {
        members: [
          { oracle: fixed("jev-a", 0.8, "jev-1.13"), label: "a" },
          { oracle: fixed("jev-b", 0.8, "jev-1.14"), label: "b" },
        ],
      },
    });
    // Old code: different pins were different voters, rho 0.
    expect(r.decision.detail).toMatchObject({
      correlation: 0.75,
      rhoSource: "default-replica",
      rhoFamily: true,
      rhoFrom: "recorded-model",
    });
    const pinned = await ask({
      ensemble: {
        members: [
          { oracle: fixed("x", 0.8, undefined, "typesafe/jev-1.13.0") },
          { oracle: fixed("y", 0.8, undefined, "typesafe/jev-1.14") },
          { oracle: fixed("z", 0.8, undefined, "haiku-5.5") },
        ],
      },
    });
    expect(pinned.decision.detail).toMatchObject({ rhoSource: "default-mixed", rhoFamily: true });
  });

  it("computes the default correlation in time linear in the members, not the samples (V1)", async () => {
    const a = fixed("a", 0.99, "a");
    const b = fixed("b", 0.99, "b");
    const t0 = performance.now();
    const r = await ask({
      sequential: { members: [{ oracle: a }, { oracle: b }], settleAbove: 0.5, maxSamples: 50_000 },
    });
    // Old code: pairwise over every possible draw, about 5 s at 50,000 samples.
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.decision.members).toHaveLength(1);
    // Two members cycled to 50,000 draws: pairs within each member's own draws are replicas.
    const half = 25_000;
    const expected = (0.75 * 2 * ((half * (half - 1)) / 2)) / ((50_000 * 49_999) / 2);
    expect(r.decision.detail.correlation).toBeCloseTo(expected, 12);
  });

  it("never replaces a caller's correlations matrix with a default (V2 E1, E2)", async () => {
    const member = (id: string, model: string): Oracle => fixed(id, 0.8, model);
    const correlations = { a: { b: 0.95, c: 0.9 }, b: { c: 0.9 } };
    const r = await ask({
      ensemble: {
        members: [
          { oracle: member("oa", "m-1"), label: "a" },
          { oracle: member("ob", "m-1"), label: "b" },
          { oracle: member("oc", "m-2"), label: "c" },
        ],
        correlations,
      },
    });
    const v = judgeVerdictFrom(judge("x", { id: "safe" }), 0.8);
    const expected = poolJudge([v, v, v], { correlations, memberKeys: ["a", "b", "c"] }).pYes;
    // Old code: re-pooled at the scalar default (0.941) and said `default-*`.
    expect(pYes(r)).toBeCloseTo(expected, 12);
    expect(r.decision.detail).toMatchObject({ rhoSource: "caller", rhoMatrix: true });
    expect(r.decision.detail.rhoFrom).toBeUndefined();
  });

  it("refuses a budgetUsd that could never trip (V1)", () => {
    for (const budgetUsd of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
      expect(() => new Engine({ oracle: fixed("o", 0.5), budgetUsd }), String(budgetUsd)).toThrow(
        /budgetUsd must be a positive number/,
      );
    }
    expect(() => new Engine({ oracle: fixed("o", 0.5), budgetUsd: 0.01 })).not.toThrow();
  });

  it("refuses at registration a strategy every ask would throw on (V1)", () => {
    const engine = new Engine({ oracle: fixed("o", 0.5) });
    const o = fixed("m", 0.5);
    const bad: [string, StrategySpec, RegExp][] = [
      ["minMembers 0", { ensemble: { members: [{ oracle: o }], minMembers: 0 } }, /minMembers/],
      ["minMembers 4 of 3", { ensemble: { k: 3, minMembers: 4 } }, /from 1 to 3/],
      [
        "minMembers 1.5",
        { ensemble: { members: [{ oracle: o }, { oracle: o }], minMembers: 1.5 } },
        /minMembers/,
      ],
      ["k 0", { ensemble: { k: 0 } }, /k must be a positive integer/],
      ["no members", { ensemble: { members: [] } }, /at least one member/],
      ["maxSamples 0", { sequential: { settleAbove: 0.9, maxSamples: 0 } }, /maxSamples/],
      [
        "maxFailedSamples -1",
        { sequential: { settleAbove: 0.9, maxSamples: 3, maxFailedSamples: -1 } },
        /maxFailedSamples/,
      ],
    ];
    for (const [name, strategy, why] of bad) {
      expect(
        () =>
          engine.gate({
            id: name,
            question: judge("q?", { id: name }),
            policy: { actAbove: 0.9 },
            strategy,
          }),
        name,
      ).toThrow(why);
    }
  });

  it("passes maxFailedSamples through to sequential (A's option)", async () => {
    const down: Oracle = {
      id: "down",
      decide: async () => {
        throw new Error("503");
      },
    };
    const spec = (maxFailedSamples?: number): StrategySpec => ({
      sequential: {
        members: [
          { oracle: down, label: "cautious" },
          { oracle: fixed("bold", 0.97, "bold"), label: "bold" },
        ],
        settleAbove: 0.95,
        maxSamples: 2,
        correlation: 0,
        ...(maxFailedSamples !== undefined ? { maxFailedSamples } : {}),
      },
    });
    expect((await ask(spec())).decision.failedOpen).toBe(true);
    const through = await ask(spec(1));
    expect(through.decision.failedOpen).not.toBe(true);
    expect(through.decision.members).toHaveLength(2);
  });

  it("accepts memberTruths on a floored battery request, checked against the gate's members (V2 M2)", async () => {
    const engine = new Engine({ oracle: fixed("o", 0.3), floors: [refuseIf(/HASH/)] });
    const members = [judge("Spam?", { id: "spam" }), judge("Threat?", { id: "threat" })];
    const gate = engine.gate({
      id: "mod",
      question: members,
      combine: "any",
      policy: { actAbove: 0.9 },
    });
    const floored = await gate.ask("HASH match");
    expect(floored.decision.strategy).toBe("floored");
    // Old code: no member rows, so every name was "not a member" and the label threw.
    expect(
      await engine.label(floored.recordId, {
        correct: true,
        truth: true,
        memberTruths: { spam: false },
      }),
    ).toBe(true);
    await expect(
      engine.label(floored.recordId, { correct: true, memberTruths: { spma: false } }),
    ).rejects.toThrow(/not a member of battery mod/);
  });
});
