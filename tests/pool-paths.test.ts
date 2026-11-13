import { describe, expect, it } from "vitest";
import { poolJudge } from "../src/compound/aggregate.ts";
import { cascade } from "../src/compound/cascade.ts";
import { sequential } from "../src/compound/sequential.ts";
import { Engine } from "../src/engine.ts";
import { judge, judgeVerdictFrom, pick, pickVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, JudgeVerdict, Oracle, PickQuestion } from "../src/types.ts";

/**
 * Pool options that name a value per member (weights, a correlation matrix) on the paths that
 * pool fewer verdicts than members were listed: a sequential run, which pools one verdict per
 * sample, and a cascade, which pools only the tiers it asked. Both used to pass the options
 * through as given, so a weight per member threw on a sequential run's first sample and a
 * matrix threw in a cascade for want of member keys.
 */

const q = judge("ok?", { id: "q" });
const v = (pYes: number): JudgeVerdict => judgeVerdictFrom(q, pYes);
const vs = (ps: readonly number[]) => ps.map(v);

/** An oracle that answers every judge question with a fixed p(yes) and records a model. */
const fixed = (id: string, p: number, model: string): Oracle => ({
  id,
  async decide(_s, qs) {
    return qs.map((x) => ({
      verdict: judgeVerdictFrom(x as JudgeQuestion, p),
      oracle: id,
      model,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
});

/** An oracle that fails open on every question. */
const down = (id: string): Oracle => ({
  id,
  async decide(_s, qs) {
    return qs.map((x) => ({
      verdict: judgeVerdictFrom(x as JudgeQuestion, 0.5),
      oracle: id,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
      failedOpen: true,
      error: "503",
    }));
  },
});

const pYesOf = (d: { readonly verdict: { readonly kind: string } }): number =>
  (d.verdict as JudgeVerdict).pYes;

describe("sequential: a weight belongs to a member", () => {
  const members = [
    { oracle: fixed("j", 0.85, "jev-1.13"), label: "jev" },
    { oracle: fixed("h", 0.9, "claude-haiku"), label: "haiku" },
  ];

  it("gives each sample its member's weight, and a member sampled again keeps it", async () => {
    const d = await sequential("s", q, {
      members,
      weights: [2, 0.5],
      settleAbove: 2,
      maxSamples: 3,
    });
    // Samples cycle jev, haiku, jev.
    expect(d.detail.samples).toBe(3);
    expect(pYesOf(d)).toBe(poolJudge(vs([0.85, 0.9, 0.85]), { weights: [2, 0.5, 2] }).pYes);
  });

  it("pools the first sample with its own weight instead of throwing", async () => {
    const d = await sequential("s", q, {
      members,
      weights: [2, 0.5],
      settleAbove: 0.5,
      maxSamples: 3,
    });
    expect(d.detail.samples).toBe(1);
    expect(pYesOf(d)).toBe(poolJudge(vs([0.85]), { weights: [2] }).pYes);
  });

  it("leaves a failed sample's weight out", async () => {
    const d = await sequential("s", q, {
      members: [{ oracle: down("x"), label: "down" }, ...members],
      weights: [9, 2, 0.5],
      settleAbove: 2,
      maxSamples: 3,
      maxFailedSamples: 1,
    });
    expect(d.failedOpen).toBeUndefined();
    expect(pYesOf(d)).toBe(poolJudge(vs([0.85, 0.9]), { weights: [2, 0.5] }).pYes);
  });

  it("refuses weights that are not one per member, before buying anything", async () => {
    let asked = 0;
    const counting: Oracle = {
      id: "c",
      async decide(s, qs) {
        asked++;
        return fixed("c", 0.9, "m").decide(s, qs);
      },
    };
    await expect(
      sequential("s", q, {
        members: [{ oracle: counting }],
        weights: [1, 1],
        settleAbove: 2,
        maxSamples: 2,
      }),
    ).rejects.toThrow(/one weight per member \(1\), not 2/);
    expect(asked).toBe(0);
  });

  it("through the engine, pools and re-pools with member weights", async () => {
    const engine = new Engine({ oracle: fixed("base", 0.5, "base-1") });
    const gate = engine.gate({
      id: "seq.weights",
      question: q,
      policy: { actAbove: 0.95 },
      strategy: { sequential: { members, weights: [2, 0.5], settleAbove: 2, maxSamples: 3 } },
    });
    const r = await gate.ask("s");
    expect(r.decision.failedOpen).toBeUndefined();
    const correlation = r.decision.detail.correlation as number;
    const expected = poolJudge(vs([0.85, 0.9, 0.85]), { weights: [2, 0.5, 2], correlation });
    expect(pYesOf(r.decision)).toBeCloseTo(expected.pYes, 12);
  });
});

describe("cascade: pool options follow the tiers that answered", () => {
  const tiers = [
    { oracle: fixed("j", 0.85, "jev-1.13"), settleAbove: 0.99, label: "jev" },
    { oracle: fixed("h", 0.9, "claude-haiku"), settleAbove: 0.5, label: "haiku" },
    { oracle: fixed("l", 0.95, "gpt-luna"), settleAbove: 0, label: "luna" },
  ];

  it("pools with a per-pair matrix keyed by tier, which used to throw for want of keys", async () => {
    const correlations = { jev: { haiku: 0.5 } };
    const d = await cascade("s", q, { tiers, pool: { correlations } });
    // The second tier settles, so two of the three tiers were asked.
    expect(d.detail.tier).toBe(1);
    expect(d.detail.pooled).toBe(true);
    const expected = poolJudge(vs([0.85, 0.9]), { correlations, memberKeys: ["jev", "haiku"] });
    expect(pYesOf(d)).toBe(expected.pYes);
    expect(pYesOf(d)).not.toBe(poolJudge(vs([0.85, 0.9])).pYes);
  });

  it("narrows a weight per tier to the tiers asked", async () => {
    const d = await cascade("s", q, { tiers, pool: { weights: [1, 2, 3] } });
    expect(d.detail.tier).toBe(1);
    expect(pYesOf(d)).toBe(poolJudge(vs([0.85, 0.9]), { weights: [1, 2] }).pYes);
  });

  it("leaves out a failed tier's weight and key", async () => {
    const d = await cascade("s", q, {
      tiers: [{ oracle: down("x"), settleAbove: 0.99, label: "down" }, ...tiers],
      pool: { weights: [9, 1, 2, 3], correlations: { jev: { haiku: 0.5 } } },
    });
    const expected = poolJudge(vs([0.85, 0.9]), {
      weights: [1, 2],
      correlations: { jev: { haiku: 0.5 } },
      memberKeys: ["jev", "haiku"],
    });
    expect(pYesOf(d)).toBe(expected.pYes);
  });

  it("is unchanged when every tier answers and the options name none of them", async () => {
    const all = tiers.map((t) => ({ ...t, settleAbove: 0.999 }));
    const d = await cascade("s", q, { tiers: all, pool: { correlation: 0.3 } });
    expect(pYesOf(d)).toBe(poolJudge(vs([0.85, 0.9, 0.95]), { correlation: 0.3 }).pYes);
  });
});

describe("a base rate of yes on a pick question is refused where it is declared", () => {
  const route = pick("Which queue?", ["billing", "support"], { id: "route" });
  const picker: Oracle = {
    id: "p",
    async decide(_s, qs) {
      return qs.map((x) => ({
        verdict: pickVerdictFrom(x as PickQuestion, [0.9, 0.1]),
        oracle: "p",
        latencyMs: 0,
        cost: 0,
        at: new Date().toISOString(),
      }));
    },
  };

  it("at registration, for an ensemble, a sequential run and a pooled cascade", () => {
    const engine = new Engine({ oracle: picker });
    const policy = { actAbove: 0.9 };
    const refused = /priorYes pools judge verdicts only, and this is a pick question/;
    expect(() =>
      engine.gate({
        id: "e",
        question: route,
        policy,
        strategy: { ensemble: { k: 2, priorYes: 0.8 } },
      }),
    ).toThrow(refused);
    expect(() =>
      engine.gate({
        id: "s",
        question: route,
        policy,
        strategy: { sequential: { k: 2, settleAbove: 0.9, maxSamples: 2, priorYes: 0.8 } },
      }),
    ).toThrow(refused);
    expect(() =>
      engine.gate({
        id: "c",
        question: route,
        policy,
        strategy: {
          cascade: {
            tiers: [
              { oracle: picker, settleAbove: 0.99 },
              { oracle: picker, settleAbove: 0 },
            ],
            pool: { priorYes: 0.8 },
          },
        },
      }),
    ).toThrow(refused);
    // The same strategies without the option register.
    expect(() =>
      engine.gate({ id: "ok", question: route, policy, strategy: { ensemble: { k: 2 } } }),
    ).not.toThrow();
  });

  it("on a single ask, fails that question open to review without buying an answer", async () => {
    let asked = 0;
    const counting: Oracle = {
      id: "p",
      async decide(s, qs) {
        asked++;
        return picker.decide(s, qs);
      },
    };
    const engine = new Engine({ oracle: counting, mode: "enforce" });
    const [r] = await engine.askAll("s", [route], {
      policy: { actAbove: 0.5 },
      strategy: { ensemble: { k: 2, priorYes: 0.8 } },
    });
    expect(asked).toBe(0);
    expect(r?.decision.failedOpen).toBe(true);
    expect(r?.decision.error).toMatch(/priorYes pools judge verdicts only/);
    expect(r?.action).toBe("review");
  });

  it("still allows it on a judge question", () => {
    const engine = new Engine({ oracle: fixed("base", 0.9, "jev-1.13") });
    expect(() =>
      engine.gate({
        id: "j",
        question: q,
        policy: { actAbove: 0.9 },
        strategy: { ensemble: { k: 2, priorYes: 0.8 } },
      }),
    ).not.toThrow();
  });
});
