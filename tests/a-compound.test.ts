/**
 * Wave 2, package A: compound strategies.
 *
 * T4-03 / T5-04: `sequential` flips a negated member's answer back exactly as `ensemble` does,
 * and records the flipped answer. Before the fix a consistent oracle's 0.9 and its negation's 0.1
 * pooled to 0.5 in `sequential` (0.988 in `ensemble`), and a negated member's "dangerous 0.95"
 * pooled as "safe 0.95" and acted.
 * T5-05: `settleLead` counts one vote per distinct model, so replicas of one model agreeing do not
 * settle a lead-by-k run.
 * T4-04: an ensemble fails open when fewer than `minMembers` (default: all) members answer, so a
 * failed cautious member cannot turn review into act.
 */
import { describe, expect, it } from "vitest";
import { ensemble, type Member, replicate, untransform } from "../src/compound/ensemble.ts";
import {
  independentLead,
  sequential,
  voteLead,
  voterKey,
  voterModel,
} from "../src/compound/sequential.ts";
import { Engine } from "../src/engine.ts";
import { failOpen } from "../src/oracles/oracle.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { Decision, JudgeVerdict, Oracle, Question } from "../src/types.ts";

/** A judge oracle whose p(yes) depends on the question it was asked (so on its framing). */
function fixed(id: string, pYes: (q: Question) => number, model?: string): Oracle {
  return {
    id,
    decide: async (_s, qs) =>
      qs.map((q) => ({
        verdict: judgeVerdictFrom(q as never, pYes(q)),
        oracle: id,
        ...(model !== undefined ? { model } : {}),
        latencyMs: 1,
        cost: 0,
        at: "2026-11-12T00:00:00.000Z",
      })),
  };
}

const pOf = (d: { verdict: unknown }) => (d.verdict as JudgeVerdict).pYes;

describe("T4-03 / T5-04: sequential reads negated members as ensemble does", () => {
  const q = judge("Is the request compliant?", { id: "req.ok" });
  const neg = judge("Does the request violate the policy?", { id: "req.ok.neg" });
  // Consistent: 0.9 that the request is compliant, so 0.1 that it violates.
  const oracle = fixed("consistent", (asked) => (asked.id === "req.ok.neg" ? 0.1 : 0.9));
  const members: Member[] = [
    { oracle, label: "orig" },
    { oracle, label: "neg", transform: (state) => ({ state, question: neg }), negated: true },
  ];

  it("pools to the same verdict as ensemble on the same members", async () => {
    const e = await ensemble("s", q, { members });
    const s = await sequential("s", q, { members, settleAbove: 0.999, maxSamples: 2 });
    expect(pOf(s)).toBeCloseTo(pOf(e), 12);
    expect(pOf(s)).toBeGreaterThan(0.95);
  });

  it("records the flipped answer on the member, under the original question's id", async () => {
    const s = await sequential("s", q, { members, settleAbove: 0.999, maxSamples: 2 });
    expect(s.members.map((m) => [m.verdict.questionId, pOf(m)])).toEqual([
      ["req.ok", 0.9],
      ["req.ok", 0.9],
    ]);
  });

  it("through a gate, a negated 'dangerous 0.95' is a safe 0.05 and does not act", async () => {
    const qSafe = judge("Is it safe to run?", { id: "safe" });
    const dangerous = fixed("neg", () => 0.95);
    const negMembers: Member[] = [
      {
        oracle: dangerous,
        label: "negated",
        negated: true,
        transform: (st, qq) => ({ state: st, question: { ...qq, prompt: "Is it dangerous?" } }),
      },
    ];
    const engine = new Engine({ oracle: dangerous, mode: "enforce" });
    const r = await engine.ask("rm -rf /", qSafe, {
      policy: { actAbove: 0.9 },
      strategy: { sequential: { members: negMembers, settleAbove: 0.9, maxSamples: 1 } },
    });
    expect(pOf(r.decision)).toBeCloseTo(0.05, 12);
    expect(r.action).not.toBe("act");
    const [row] = await engine.ledger.all();
    const member = row?.members?.[0];
    expect((member?.verdict as JudgeVerdict | undefined)?.pYes).toBeCloseTo(0.05, 12);
  });

  it("untransform is the one mapping both strategies share", () => {
    const v = judgeVerdictFrom(neg, 0.1);
    expect(untransform(q, v, true)).toMatchObject({ questionId: "req.ok", pYes: 0.9 });
    expect(untransform(q, v)).toMatchObject({ questionId: "req.ok", pYes: 0.1 });
  });
});

describe("T5-05: settleLead counts one vote per distinct model", () => {
  const q = judge("q?", { id: "q" });
  const yes = (id: string, model?: string) => fixed(id, () => 0.9, model);

  it("replicas of one model agreeing never settle a lead of 2", async () => {
    const r = await sequential("s", q, {
      members: replicate(yes("jev"), 5, { shuffle: false }),
      settleAbove: 1.1,
      settleLead: 2,
      maxSamples: 5,
    });
    expect(r.detail.settled).toBe(false);
    expect(r.detail.samples).toBe(5);
    // Counted per verdict, five agreeing replicas read as a lead of 5.
    expect(voteLead(r.members.map((m) => m.verdict))).toBe(5);
    expect(independentLead(r.members)).toBe(1);
  });

  it("distinct models settle as soon as k of them agree", async () => {
    const r = await sequential("s", q, {
      members: [{ oracle: yes("a") }, { oracle: yes("b") }, { oracle: yes("c") }],
      settleAbove: 1.1,
      settleLead: 2,
      maxSamples: 6,
    });
    expect(r.detail.settled).toBe(true);
    expect(r.detail.samples).toBe(2);
  });

  it("keys a vote by the model family of the pin, else of the oracle id", () => {
    const d = (oracle: string, pYes: number, model?: string): Decision => ({
      verdict: judgeVerdictFrom(q, pYes),
      oracle,
      ...(model !== undefined ? { model } : {}),
      latencyMs: 0,
      cost: 0,
      at: "now",
    });
    expect(voterKey(d("openrouter:jev", 0.9, "jev-1.13"))).toBe("jev");
    expect(voterKey(d("custom", 0.9))).toBe("custom");
    // V1: two pins of one family (error phi 0.785) are one voter, not two.
    expect(independentLead([d("jev-1.13", 0.9, "jev-1.13"), d("jev-1.14", 0.8, "jev-1.14")])).toBe(
      1,
    );
    expect(
      independentLead([d("jev-1.13", 0.9, "jev-1.13"), d("haiku", 0.8, "claude-haiku-5-5")]),
    ).toBe(2);
    expect(
      independentLead([d("openrouter:jev", 0.9, "jev-1.13"), d("typesafe", 0.8, "jev-1.13")]),
    ).toBe(1);
    expect(independentLead([d("a", 0.9), d("b", 0.8), d("c", 0.2)])).toBe(1);
    expect(independentLead([d("a", 0.9), d("a", 0.2), d("b", 0.9)])).toBe(1);
    expect(independentLead([d("a", 0.9), { ...d("b", 0.9), failedOpen: true }, d("c", 0.9)])).toBe(
      2,
    );
  });
});

describe("T5-05 (V1): two pins of one family do not settle a lead of 2", () => {
  it("jev-1.13 + jev-1.14 + haiku samples all three before a lead of 2 can settle", async () => {
    const q = judge("Is it safe?", { id: "q" });
    const r = await sequential("s", q, {
      members: [
        { oracle: fixed("jev-1.13", () => 0.8, "jev-1.13") },
        { oracle: fixed("jev-1.14", () => 0.8, "jev-1.14") },
        { oracle: fixed("haiku-5.5", () => 0.2, "haiku-5.5") },
      ],
      settleAbove: 0.99,
      settleLead: 2,
      maxSamples: 3,
      correlation: 0.75,
    });
    expect(r.detail.samples).toBe(3);
    expect(r.detail.settled).toBe(false);
  });
});

describe("T5-05 (V1 round 2): merging voters into a family only ever delays a stop", () => {
  const q = judge("Is it safe?", { id: "q" });
  const d = (oracle: string, pYes: number, model?: string): Decision => ({
    verdict: judgeVerdictFrom(q, pYes),
    oracle,
    ...(model !== undefined ? { model } : {}),
    latencyMs: 0,
    cost: 0,
    at: "now",
  });
  /** Yes 0.8 from three families, no 0.3 from two minority members, then a confident no. */
  const run = (minority: [string, string]) =>
    sequential("s", q, {
      members: [
        { oracle: fixed("claude", () => 0.8, "claude-3-opus") },
        { oracle: fixed("n1", () => 0.3, minority[0]) },
        { oracle: fixed("gemini", () => 0.8, "gemini-2.5-pro") },
        { oracle: fixed("n2", () => 0.3, minority[1]) },
        { oracle: fixed("llama", () => 0.8, "llama-3.1-70b") },
        { oracle: fixed("n3", () => 0.001, "mistral-large-2") },
      ],
      settleAbove: 0.999,
      settleLead: 2,
      maxSamples: 6,
      correlation: 0,
    });

  it("two dissenters of one family still count as two against the leader", async () => {
    const merged = await run(["gpt-4o", "gpt-5"]);
    const apart = await run(["gpt-4o", "command-r"]);
    expect(merged.detail.samples).toBe(6);
    expect(merged.detail.settled).toBe(false);
    expect(merged.detail.samples).toBe(apart.detail.samples);
    expect(pOf(merged)).toBeCloseTo(pOf(apart), 12);
  });

  it("counts the leader by family and the runner-up by model", () => {
    const five = [
      d("claude", 0.8, "claude-3-opus"),
      d("n1", 0.3, "gpt-4o"),
      d("gemini", 0.8, "gemini-2.5-pro"),
      d("n2", 0.3, "gpt-5"),
      d("llama", 0.8, "llama-3.1-70b"),
    ];
    expect(independentLead(five)).toBe(1);
    // Two pins agreeing on the lead are still one vote for it.
    expect(
      independentLead([d("a", 0.9, "jev-1.13"), d("b", 0.9, "jev-1.14"), d("c", 0.9, "haiku")]),
    ).toBe(2);
  });

  it("a blank model pin falls back to the oracle id instead of merging every such oracle", () => {
    expect(voterModel(d("a", 0.9, ""))).toBe("a");
    expect(voterModel(d("b", 0.9, "  "))).toBe("b");
    expect(voterKey(d("b", 0.9, "  "))).toBe("b");
    expect(independentLead([d("a", 0.9, ""), d("b", 0.9, " ")])).toBe(2);
  });
});

describe("V1 round 2: sequential refuses unbounded or malformed counts before buying anything", () => {
  const q = judge("Is it safe?", { id: "q" });
  /** Counts its calls and stops a runaway loop on the old code, so the test fails instead of hanging. */
  const counted = () => {
    let calls = 0;
    const oracle: Oracle = {
      id: "unsure",
      decide: async (_s, qs) => {
        calls++;
        if (calls > 20) throw new Error("runaway: more than 20 calls");
        return qs.map((x) => ({
          verdict: judgeVerdictFrom(x as never, 0.6),
          oracle: "unsure",
          latencyMs: 0,
          cost: 0.001,
          at: "now",
        }));
      },
    };
    return { oracle, calls: () => calls };
  };
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["maxSamples Infinity", { maxSamples: Number.POSITIVE_INFINITY }, /maxSamples/],
    ["maxSamples NaN", { maxSamples: Number.NaN }, /maxSamples/],
    ["maxSamples 1.5", { maxSamples: 1.5 }, /maxSamples/],
    ["maxSamples 0", { maxSamples: 0 }, /maxSamples/],
    ["maxSamples '3'", { maxSamples: "3" }, /maxSamples/],
    ["settleLead 0", { settleLead: 0 }, /settleLead/],
    ["settleLead Infinity", { settleLead: Number.POSITIVE_INFINITY }, /settleLead/],
    ["settleLead 1.5", { settleLead: 1.5 }, /settleLead/],
    ["minSamples NaN", { minSamples: Number.NaN }, /minSamples/],
    ["minSamples 0", { minSamples: 0 }, /minSamples/],
    ["settleAbove NaN", { settleAbove: Number.NaN }, /settleAbove/],
  ];
  for (const [name, patch, message] of cases) {
    it(`refuses ${name}`, async () => {
      const { oracle, calls } = counted();
      const opts = { members: [{ oracle }], settleAbove: 0.99, maxSamples: 3, ...patch };
      await expect(sequential("s", q, opts as never)).rejects.toThrow(message);
      expect(calls()).toBe(0);
    });
  }
  it("a per-ask strategy with maxSamples Infinity buys nothing and never acts", async () => {
    // The engine checks a per-ask strategy itself and fails the lane open; sequential's own
    // check is the backstop. Either way: no call, no spend, no act.
    const { oracle, calls } = counted();
    const engine = new Engine({ oracle, budgetUsd: 0.01, mode: "enforce" });
    try {
      const r = await engine.ask("s", q, {
        policy: { actAbove: 0 },
        strategy: {
          sequential: {
            members: [{ oracle }],
            settleAbove: 0.99,
            maxSamples: Number.POSITIVE_INFINITY,
          },
        },
      });
      expect(r.action).not.toBe("act");
      expect(r.decision.error).toMatch(/maxSamples/);
    } catch (error) {
      expect(String(error)).toMatch(/maxSamples/);
    }
    expect(calls()).toBe(0);
    expect(engine.spent).toBe(0);
  });
});

describe("T4-04 (V1): a sequential run with a failed sample fails open", () => {
  const q = judge("Is it safe?", { id: "q" });
  const down: Oracle = { id: "cautious", decide: async () => Promise.reject(new Error("503")) };
  const ask = (first: Oracle, maxFailedSamples?: number) => {
    const engine = new Engine({ oracle: first, mode: "enforce" });
    return engine.ask("s", q, {
      policy: { actAbove: 0.95 },
      strategy: {
        sequential: {
          members: [
            { oracle: first, label: "cautious" },
            { oracle: fixed("bold", () => 0.97, "bold"), label: "bold" },
          ],
          settleAbove: 0.95,
          maxSamples: 2,
          correlation: 0,
          ...(maxFailedSamples !== undefined ? { maxFailedSamples } : {}),
        } as never,
      },
    });
  };
  it("a cautious member answering 0.30 keeps it at review", async () => {
    expect((await ask(fixed("cautious", () => 0.3, "cautious"))).action).toBe("review");
  });
  it("the cautious member down no longer leaves the bold one to act", async () => {
    const r = await ask(down);
    expect(r.action).toBe("review");
    expect(r.decision.failedOpen).toBe(true);
    expect(r.decision.error).toMatch(
      /^sample 1 \(cautious\) failed open: 503; maxFailedSamples is 0$/,
    );
    expect(r.decision.members).toHaveLength(1);
    expect(r.decision.detail).toMatchObject({ samples: 1, settled: false, failedSamples: 1 });
  });
  it("maxFailedSamples above 0 samples through the outage, as before", async () => {
    const r = await ask(down, 1);
    expect(r.action).toBe("act");
    expect(r.decision.failedOpen).toBeUndefined();
    expect(r.decision.detail).toMatchObject({ samples: 2, failedSamples: 1 });
  });
  it("refuses a maxFailedSamples that is not an integer of at least 0", async () => {
    for (const maxFailedSamples of [-1, 0.5, Number.NaN]) {
      await expect(
        sequential("s", q, {
          members: [{ oracle: fixed("a", () => 0.9) }],
          settleAbove: 0.9,
          maxSamples: 1,
          maxFailedSamples,
        }),
      ).rejects.toThrow(/maxFailedSamples/);
    }
  });
});

describe("T4-04: an ensemble missing members fails open", () => {
  const qSafe = judge("Is it safe?", { id: "safe" });
  const cautious = fixed("cautious", () => 0.3);
  const permissive = fixed("permissive", () => 0.97);
  const failing: Oracle = {
    id: "cautious",
    decide: async () => Promise.reject(new Error("413 state too large")),
  };
  const ask = (first: Oracle, minMembers?: number) => {
    const engine = new Engine({ oracle: permissive, mode: "enforce" });
    return engine.ask("git push --force", qSafe, {
      policy: { actAbove: 0.9 },
      strategy: {
        ensemble: {
          method: "mean",
          members: [
            { oracle: first, label: "cautious" },
            { oracle: permissive, label: "permissive" },
          ],
          ...(minMembers !== undefined ? { minMembers } : {}),
        } as never,
      },
    });
  };

  it("both members answering pool to review", async () => {
    expect((await ask(cautious)).action).toBe("review");
  });

  it("the cautious member failing no longer leaves the permissive one to act", async () => {
    const r = await ask(failing);
    expect(r.action).toBe("review");
    expect(r.decision.failedOpen).toBe(true);
    expect(r.decision.error).toMatch(/1 of 2 members answered; minMembers is 2: 413/);
    expect(r.decision.detail).toMatchObject({ pooled: 0, dropped: 1, minMembers: 2 });
  });

  it("minMembers below the member count restores pooling what answered", async () => {
    const r = await ask(failing, 1);
    expect(r.action).toBe("act");
    expect(r.decision.failedOpen).toBeUndefined();
    expect(r.decision.detail).toMatchObject({ pooled: 1, dropped: 1, minMembers: 1 });
  });

  it("refuses a minMembers that is not an integer from 1 to the member count", async () => {
    const members = [{ oracle: cautious }, { oracle: permissive }];
    for (const minMembers of [0, 3, 1.5, Number.NaN]) {
      await expect(ensemble("s", qSafe, { members, minMembers })).rejects.toThrow(/minMembers/);
    }
  });

  it("all members failing still fails open (as before)", async () => {
    const r = await ensemble("s", qSafe, { members: [{ oracle: failOpen(failing) }] });
    expect(r.failedOpen).toBe(true);
  });
});
